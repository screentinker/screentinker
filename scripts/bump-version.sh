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
#    dependency entries are "name": "^x.y.z" and won't match "version": "x.y.z")
sed -i -E "s/(\"version\"[[:space:]]*:[[:space:]]*)\"[0-9]+\.[0-9]+\.[0-9]+\"/\1\"$NEW\"/" server/package.json
( cd server && npm install --package-lock-only >/dev/null )

# 3) android versionName + versionCode (+1)
sed -i -E "s/(versionName[[:space:]]*=[[:space:]]*)\"[0-9.]+\"/\1\"$NEW\"/" android/app/build.gradle.kts
CODE="$(grep -oE 'versionCode[[:space:]]*=[[:space:]]*[0-9]+' android/app/build.gradle.kts | grep -oE '[0-9]+$')"
sed -i -E "s/(versionCode[[:space:]]*=[[:space:]]*)[0-9]+/\1$((CODE + 1))/" android/app/build.gradle.kts

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

# 5) commit + annotated tag (no push)
git add VERSION server/package.json server/package-lock.json android/app/build.gradle.kts tizen/config.xml
git commit -q -m "chore(release): v$NEW"
git tag -a "v$NEW" -m "ScreenTinker v$NEW"

echo
echo "Committed + tagged v$NEW (nothing pushed). To release:"
echo "    git push origin main && git push origin v$NEW"
