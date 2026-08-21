#!/bin/bash
# Bump the ScreenTinker version across every source of truth in one commit + tag.
#
#   scripts/bump-version.sh major|minor|patch|X.Y.Z
#
# Updates (and commits together): VERSION (root, the value the server reads at
# runtime), server/package.json + package-lock.json, android versionName
# (+versionCode by 1), tizen/config.xml widget version. Then creates an annotated
# tag vX.Y.Z. Does NOT push - prints the push command, so a release fires
# deliberately (pushing the tag is what triggers the release workflow).
set -euo pipefail
cd "$(dirname "$0")/.."

# Require a clean tree so the version commit can't sweep up unrelated changes.
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: working tree is dirty - commit or stash before bumping." >&2
  exit 1
fi

# Pre-push fast-forward guard. This script creates an annotated tag locally; if the branch's
# remote counterpart has advanced past the commit we're bumping from, the push is rejected as a
# non-fast-forward - and if the tag gets pushed anyway it fires the release workflow from a commit
# that isn't even on the branch (the beta9 divergence incident). Catch the divergence HERE, before
# the tag exists, so nothing can fire.
#
# ⚠️ CHECKED AGAINST THE BRANCH YOU ARE ON, not against main. This used to hardcode origin/main,
# which was right while main was the only release line and became wrong the moment 1.9.x existed
# as a maintenance branch: releasing 1.9.40 from 1.9.x compared it against a main that had moved
# to 2.0.0, found it "behind", and refused a release that was perfectly fast-forward. The question
# is always "will pushing THIS branch fast-forward", so ask it about this branch.
#
# Best-effort: when the fetch can't run (offline), warn and proceed rather than block a local bump
# - the push itself is still the backstop.
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" = "HEAD" ]; then
  echo "ERROR: detached HEAD - check out the release branch before bumping." >&2
  exit 1
fi
if git fetch --quiet origin "$BRANCH" 2>/dev/null; then
  if ! git merge-base --is-ancestor FETCH_HEAD HEAD; then
    echo "ERROR: origin/$BRANCH ($(git rev-parse --short FETCH_HEAD)) has commits not in your" >&2
    echo "       HEAD ($(git rev-parse --short HEAD)) - 'git push origin $BRANCH' would be rejected." >&2
    echo "       Merge origin/$BRANCH into your branch first, then re-run the bump." >&2
    exit 1
  fi
else
  echo "WARNING: could not fetch origin/$BRANCH - skipping the fast-forward check (new branch, or offline?)." >&2
  echo "         Confirm 'git push origin $BRANCH' will fast-forward before pushing the tag." >&2
fi

CURRENT="$(cat VERSION)"
IFS=. read -r MAJ MIN PAT <<< "$CURRENT"

case "${1:-}" in
  major) NEW="$((MAJ + 1)).0.0" ;;
  minor) NEW="${MAJ}.$((MIN + 1)).0" ;;
  patch) NEW="${MAJ}.${MIN}.$((PAT + 1))" ;;
  [0-9]*.[0-9]*.[0-9]*) NEW="$1" ;;
  *) echo "usage: $0 major|minor|patch|X.Y.Z   (current: $CURRENT)" >&2; exit 1 ;;
esac
echo "Bumping $CURRENT -> $NEW"

# 1) VERSION (source of truth)
printf '%s\n' "$NEW" > VERSION

# 2) server/package.json version + lockfile (only the top-level "version" key;
#    dependency entries are "name": "^x.y.z" and won't match "version": "x.y.z").
#    The [^"]* tail also matches a pre-release CURRENT value (e.g. 1.9.1-beta1) so a
#    beta1->beta2 bump replaces it instead of silently no-op'ing (issue: stale package.json).
sed -i -E "s/(\"version\"[[:space:]]*:[[:space:]]*)\"[0-9]+\.[0-9]+\.[0-9]+[^\"]*\"/\1\"$NEW\"/" server/package.json
( cd server && npm install --package-lock-only >/dev/null )

# 3) android versionName + versionCode (+1). Since #168 both are env-overridable, so the
#    build.gradle.kts values live as FALLBACK literals inside `?: "…"` at the end of each line
#    (versionName = getenv(...) ?: prop ?: "1.9.4"; versionCode = (getenv(...) ?: … ?: "44").toInt()).
#    Target that trailing `?: "literal"` (the LAST quoted token on the line) rather than the old
#    `versionName = "X"` / `versionCode = N` forms, which no longer exist. [0-9][^"]* matches a
#    pre-release current value too (e.g. 1.9.1-beta1) so beta1->beta2 replaces it.
sed -i -E "s/(versionName.*\?:[[:space:]]*)\"[0-9][^\"]*\"/\1\"$NEW\"/" android/app/build.gradle.kts
#    ⚠️ THE NEXT CODE IS ONE ABOVE THE HIGHEST EVER RELEASED, NOT ONE ABOVE THIS BRANCH'S.
#    versionCode is how Android identifies a build, globally — two APKs sharing one are the same
#    build as far as every device is concerned, so an OTA offering the other sees "already on it"
#    and silently does nothing. Counting from the current file is only correct while there is one
#    release line. The moment 1.9.x and 2.0.0 existed in parallel it broke: 1.9.39 was code 126, so
#    a 1.9.40 bump produced 127 — already published as the 2.0.0-alpha0 APK.
#    Scanning the tags makes the sequence global, which is the property that actually matters.
CODE="$(grep -E 'versionCode' android/app/build.gradle.kts | grep -oE '\?:[[:space:]]*\"[0-9]+\"' | grep -oE '[0-9]+' | tail -1)"
for _t in $(git tag --list 'v*'); do
  # `|| true` because tags older than #168 have no `?: "literal"` form at all: grep matches nothing,
  # pipefail fails the pipeline, and the assignment then kills the bump half-applied under `set -e`
  # — exactly the dirty half-state the gotcha in the release notes warns about.
  _c="$(git show "$_t:android/app/build.gradle.kts" 2>/dev/null \
        | grep -oE 'versionCode.*\?:[[:space:]]*"[0-9]+"' | grep -oE '[0-9]+' | tail -1 || true)"
  # An `a && b && c` chain here would be the last command of the loop body, so the first tag whose
  # code is NOT higher returns non-zero and `set -e` kills the bump half-applied. Use an if.
  if [ -n "$_c" ] && [ "$_c" -gt "$CODE" ]; then CODE="$_c"; fi
done
echo "  android versionCode: $CODE -> $((CODE + 1)) (highest across all tags was $CODE)"
sed -i -E "s/(versionCode.*\?:[[:space:]]*)\"[0-9]+\"/\1\"$((CODE + 1))\"/" android/app/build.gradle.kts

# 4) tizen widget version. Skip the <?xml ...?> declaration line - its
#    version="1.0" is the XML FORMAT version, not the app version, and it also
#    has a leading space before version= so the guard below would otherwise hit
#    it (issue #77). The leading-space guard still excludes tizen:application
#    required_version="..." (that's "...d_version", no preceding space).
#    #80: Tizen requires a strictly-numeric x.y.z widget version, so a pre-release
#    suffix (e.g. 1.9.0-rc1) is invalid and the .wgt fails to sign/install. Strip
#    the suffix for config.xml only - the full VERSION (with -rc1/-beta.N) still
#    drives the server/Android/package.json version.
NUMERIC="${NEW%%-*}"
sed -i -E "/^<\?xml/! s/([[:space:]]version=\")[0-9][^\"]*(\")/\1${NUMERIC}\2/" tizen/config.xml

# 5) public API spec version. This is the number Redoc prints at the top of the published
#    API reference (frontend/api-docs.html renders docs/openapi.yaml directly), so leaving it
#    behind means customers read a version that has not existed for months — it had drifted to
#    1.9.0 while shipping 1.9.25 precisely because this step did not exist. Anchored to the
#    two-space `  version:` under `info:`; operation-level and schema-level keys are indented
#    deeper and are not touched. As with Tizen, use the numeric form: the spec version is a
#    published API identity, not a build label.
sed -i -E "0,/^  version:/s/^(  version:[[:space:]]*).*/\1${NUMERIC}/" docs/openapi.yaml

# 6) CHANGELOG guard. Deliberately NOT auto-generated — a generated changelog reads like
#    documentation while saying nothing, and the entry has to come from whoever knows what
#    shipped. This only refuses to let a release be cut silently without one, which is how the
#    file fell 23 versions behind.
if ! grep -q "^## ${NEW}$" CHANGELOG.md 2>/dev/null; then
  echo
  echo "  WARNING: CHANGELOG.md has no '## $NEW' entry."
  echo "  Add one before pushing the tag — the release notes are read from it."
  echo
fi

# 7) commit + annotated tag (no push)
git add VERSION server/package.json server/package-lock.json android/app/build.gradle.kts tizen/config.xml docs/openapi.yaml
git commit -q -m "chore(release): v$NEW"
git tag -a "v$NEW" -m "ScreenTinker v$NEW"

echo
echo "Committed + tagged v$NEW (nothing pushed). To release:"
echo "    git push origin $BRANCH && git push origin v$NEW"
