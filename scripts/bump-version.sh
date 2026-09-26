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

# 4b) webOS app version. Same numeric-only rule as Tizen (appinfo.json version is x.y.z), and
#     build-ipk.sh stamps js/app.js from it, so this is the one place it is written.
sed -i -E "s/(\"version\": *\")[0-9][^\"]*(\")/\1${NUMERIC}\2/" webos/appinfo.json

# 4c) Vega app version. package.json "version" is the first such key; manifest.toml's
#     `version = "..."` is the package version (schema-version is unquoted and untouched).
#     vega/src/deviceInfo.ts carries the same string as a fallback for when the turbo module
#     cannot answer getVersion(). All three have to move together or a stick reports a version
#     the dashboard cannot match to a release.
sed -i -E "0,/\"version\":/s/(\"version\": *\")[0-9][^\"]*/\1${NUMERIC}/" vega/package.json
sed -i -E "s/^(version = \")[0-9][^\"]*/\1${NUMERIC}/" vega/manifest.toml
sed -i -E "s/(export const APP_VERSION = ')[0-9][^']*/\1${NUMERIC}/" vega/src/deviceInfo.ts

# 4d) Vega BUILD NUMBER, stamped into the build scripts themselves.
#
# ⚠️ THE APPSTORE REFUSES build_number 0. The valid range is 1..2^63-1, and `react-native
# build-vega` defaults to 0 when the flag is absent — which every build before this one was, so
# every .vpkg ever produced here was unsubmittable. Worse, the Appstore requires BOTH the version
# AND the build number to be greater than the previous submission, so an unset build number also
# means there is no way to upload a second version later.
#
# ⚠️ STAMPED AS A LITERAL, not computed in the npm script. `--build-number $(...)` would be shell
# interpolation inside package.json, which breaks on Windows (there is a windows-setup.bat in this
# repo) and makes the built artifact depend on the shell that launched it. A literal is
# reproducible and greppable, and it matches how every other version in this script is written.
#
# Derived from the version so it cannot go backwards while the version goes forwards:
# major*10000 + minor*100 + patch, i.e. 2.1.6 -> 20106. Two digits each for minor and patch is
# plenty for this project and keeps the number readable at a glance.
#
# ⚠️ A RE-SUBMISSION OF THE SAME VERSION NEEDS A HIGHER NUMBER BY HAND. If Amazon rejects a build
# and you fix it without bumping the version, pass a larger --build-number on the command line for
# that upload. This derivation deliberately does not track re-submissions: guessing at them would
# make the number unpredictable, and an unpredictable build number is how you lose track of which
# binary is live.
VEGA_BUILD_NUMBER="$(printf '%d' "$(( $(echo "$NUMERIC" | cut -d. -f1) * 10000 \
                                   + $(echo "$NUMERIC" | cut -d. -f2) * 100 \
                                   + $(echo "$NUMERIC" | cut -d. -f3) ))")"
# Replace an existing --build-number, or append one if the scripts predate this step.
if grep -q -- "--build-number" vega/package.json; then
  sed -i -E "s/(--build-number )[0-9]+/\1${VEGA_BUILD_NUMBER}/g" vega/package.json
else
  sed -i -E "s/(react-native build-vega[^\"]*)\"/\1 --build-number ${VEGA_BUILD_NUMBER}\"/g" vega/package.json
fi
echo "  vega build number: ${VEGA_BUILD_NUMBER}"

# 4e) ⚠️ BUILD THE VEGA PACKAGE BEFORE TAGGING, so a release cannot be cut from a stamped tree
#     that does not compile. This is not belt-and-braces: the Vega app has broken at the BUILD
#     step twice in one day — once on a dependency pinned to a version that does not exist
#     (kepler-file-system ~2.0.0), once on a Babel transformer that silently produced a 4.5 KB
#     .vpkg with no JavaScript in it and exited 0. Neither was visible from the source, and the
#     server test suite cannot see either.
#
#     SKIPPED, LOUDLY, when the Vega SDK is absent — most machines that cut a release do not have
#     it, and refusing to release without it would be worse than the risk. `vega` reaches the PATH
#     via `source ~/vega/env`.
if [ -f "$HOME/vega/env" ]; then
  # shellcheck disable=SC1091
  ( set +u; . "$HOME/vega/env" >/dev/null 2>&1
    cd vega
    echo "  building the Vega package (SDK found)..."
    if [ ! -d node_modules ]; then npm install --no-audit --no-fund >/dev/null 2>&1; fi
    npm run build:release >/tmp/vega-build-$$.log 2>&1 || {
      echo "ERROR: the Vega package failed to build at v$NEW - refusing to tag." >&2
      echo "       see /tmp/vega-build-$$.log" >&2
      exit 1
    }
    VPKG=build/armv7-release/screentinker-vega_armv7.vpkg
    # ⚠️ A .vpkg with no JS bundle still "builds" and still exits 0. Check for the bundle, not the
    # exit code — that empty 4.5 KB package is what installs and then does nothing on a stick.
    #
    # ⚠️ THE LISTING GOES INTO A VARIABLE, AND grep -q IS NOT USED. This guard's first version piped
    # into `grep -q`, which stops reading the moment it matches — that closes the pipe, the upstream
    # `tar` and `zstd` die on SIGPIPE, and under `set -o pipefail` (line 1 of this script) the whole
    # pipeline reports failure. So it refused to tag a PERFECTLY GOOD package, every time, and the
    # error it printed said the package had no JavaScript in it. A check that cannot tell "the thing
    # is broken" from "I could not finish looking" is worse than no check: it blocks every release
    # and points at the wrong thing while doing it.
    VPKG_LIST="$(zstd -d -c "$VPKG" 2>/dev/null | tar tf - 2>/dev/null || true)"
    case "$VPKG_LIST" in
      *bundle/index.bundle*) : ;;
      *)
        echo "ERROR: $VPKG has no JS bundle - refusing to tag." >&2
        echo "       (it listed ${VPKG_LIST:+$(printf '%s' "$VPKG_LIST" | wc -l) entries}${VPKG_LIST:-nothing at all - is zstd installed?})" >&2
        exit 1
        ;;
    esac
    echo "  vega .vpkg OK: $(du -h "$VPKG" | cut -f1), build_number ${VEGA_BUILD_NUMBER}"
  ) || exit 1
else
  echo "  NOTE: Vega SDK not found at ~/vega/env - the .vpkg was NOT built or verified."
  echo "        Before submitting to the Appstore, run on a machine with the SDK:"
  echo "            source ~/vega/env && cd vega && npm run build:release"
fi

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
# ⚠️ NOT anchored at end-of-line. Every heading in this changelog carries its date
#    ("## 2.1.5 (2026-09-22)"), so `^## ${NEW}$` matched NOTHING and this warned on every
#    correctly-written release — which made it noise, which made it ignored, which is the exact
#    opposite of a guard. Match the version followed by end-of-line OR a space.
if ! grep -qE "^## ${NEW}( |$)" CHANGELOG.md 2>/dev/null; then
  echo
  echo "  WARNING: CHANGELOG.md has no '## $NEW' entry."
  echo "  Add one before pushing the tag — the release notes are read from it."
  echo
fi

# 7) commit + annotated tag (no push)
# ⚠️ EVERY FILE STAMPED ABOVE MUST BE LISTED HERE. webos/appinfo.json was stamped at step 4b and
#    left out of this line, so v2.0.8 was tagged with appinfo.json still on the previous version.
#    webos-player.test.js asserts that parity, which means the tagged commit failed its own test
#    suite and the release job never ran. A stamp that is not staged is worse than no stamp: the
#    working tree looks correct and only CI sees the truth.
#    js/app.js is stamped from appinfo.json by webos/build-ipk.sh, which the test suite runs, so it
#    is listed too and the tree stays clean after a test run.
git add VERSION server/package.json server/package-lock.json android/app/build.gradle.kts tizen/config.xml docs/openapi.yaml webos/appinfo.json webos/js/app.js vega/package.json vega/manifest.toml vega/src/deviceInfo.ts
git commit -q -m "chore(release): v$NEW"
git tag -a "v$NEW" -m "ScreenTinker v$NEW"

echo
echo "Committed + tagged v$NEW (nothing pushed). To release:"
echo "    git push origin $BRANCH && git push origin v$NEW"
