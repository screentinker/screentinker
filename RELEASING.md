# Releasing ScreenTinker

`VERSION` (repo root) is the single source of truth the server reports at runtime.
Cutting a release is three steps.

## 1. Bump + tag

First, write the user-facing notes. Add an entry for the new version at the TOP of
`release-notes.json`: 3-5 plain-language bullets aimed at an operator, no issue
numbers, no internals. These are what the app shows in the "What's new" panel and
under Settings → About — they are NOT the changelog, which is written for whoever
touches the code next. `test/release-notes.test.js` fails the build if the version
in `VERSION` has no entry, so this cannot be skipped by accident.

```bash
scripts/bump-version.sh X.Y.Z        # or: major | minor | patch
```

Syncs `VERSION`, `server/package.json` (+lockfile), the android `versionName` /
`versionCode`, and the tizen widget version in one commit, then creates an
annotated tag `vX.Y.Z`. It does NOT push - it prints the push command. Requires a
clean working tree.

## 2. Push (this publishes the release)

```bash
git push origin main && git push origin vX.Y.Z
```

Pushing the tag fires `.github/workflows/release.yml`:

- **verify** - refuses to publish if the tag does not match `VERSION`.
- **test** - the unit suite.
- **artifacts** - builds the source tarball (bundling the unsigned Tizen `.wgt`)
  and creates the GitHub Release with generated notes.
- **docker** - builds a multi-arch (amd64 + arm64) image and pushes
  `ghcr.io/screentinker/screentinker:X.Y.Z` and `:latest`.

`artifacts` and `docker` are independent jobs: a docker (arm64/QEMU) failure does
not block the GitHub Release and can be re-run on its own. Nothing here deploys to
production.

## 3. Finalize (adds the signed APK)

The Android signing keystore stays off CI, so the signed apk and the complete
(apk + wgt) tarball are assembled locally, then uploaded to the release:

```bash
KEYSTORE_PASSWORD=... KEY_PASSWORD=... scripts/finalize-release.sh
```

It builds the signed APK, pulls the CI-built unsigned `.wgt` back from the
release, assembles a complete tarball (source + `ScreenTinker.apk` +
`ScreenTinker.wgt` at the root, where `/download/apk` resolves the apk after
extraction), and uploads the apk + complete tarball.

## What a release contains

Each release carries these as standalone assets AND bundled in the tarball:

- `screentinker-X.Y.Z.tar.gz` - server + frontend source + apk + wgt at the root
- `ScreenTinker.apk` - signed Android player
- `ScreenTinker.wgt` - Tizen TV web app (unsigned; see [tizen/README.md](tizen/README.md))
- `ghcr.io/screentinker/screentinker:X.Y.Z` + `:latest` - Docker image

## One-time / occasional

- **ghcr visibility:** new packages default to private. Set the package Public
  once (Repo -> Packages -> `screentinker` -> Package settings -> Change
  visibility -> Public) so anonymous `docker pull` works.
- **Self-hosters upgrade** with `scripts/upgrade.sh [vX.Y.Z]` (see the README).
