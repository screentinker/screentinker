# Licensing

ScreenTinker is MIT. This page records how we know what our dependencies are licensed under,
so the answer to "do you track licences?" is something you can check rather than something you
have to take on trust.

## The short answer

**No GPL or AGPL anywhere in the product.** Neither the server nor the Android player links,
bundles, or ships anything under strong or network copyleft.

## Where the answer comes from

Two gates run in CI on every push, and both fail closed — a dependency whose licence nobody has
recorded fails the build rather than shipping unnoticed.

| Gate | Covers | Script |
|---|---|---|
| Licence gate + SBOM (production deps) | the server's npm tree | `scripts/license-check.js` |
| Licence gate (APK runtime classpath) | everything that can enter the APK | `scripts/android-license-check.js` |

Run either locally:

```sh
cd server && npm ci --omit=dev && cd ..
node scripts/license-check.js                       # server
node scripts/android-license-check.js               # APK
node scripts/license-check.js --sbom sbom/x.json    # also write an SBOM
```

Neither script has dependencies of its own. A gate that needs its own supply chain audited is
worth less than one that doesn't.

## ⚠️ Audit the production install, not the checkout

**A licence scanner pointed at a developer checkout will report LGPL, and it will be wrong about
what we ship.**

`sharp` is a `devDependency` — a fixture generator for the image tests — and one of its platform
binaries, `@img/sharp-wasm32`, declares `Apache-2.0 AND LGPL-3.0-or-later AND MIT`. It is never
installed on a server: production installs with `npm ci --omit=dev`, which both the CI gate and
`scripts/upgrade.sh` use.

If someone challenges the answer with a scan of the repo, this is the discrepancy they have found.

`sharp` is kept deliberately: it is the *independent* implementation used to generate fixtures for
the pure-JavaScript image path that replaced it. Generating those fixtures with the library under
test would mean a decode bug could produce a fixture that hides the same bug.

## Policy

**Allowed** — MIT, MIT-0, ISC, 0BSD, BSD-2-Clause, BSD-3-Clause, Apache-2.0, BlueOak-1.0.0,
Unlicense, CC0-1.0, Python-2.0, WTFPL, Zlib, CC-BY-4.0.

**Denied** — AGPL, GPL, SSPL, Commons Clause, BUSL, and the JSON Licence.

**Reported but not failed** — LGPL, MPL, EPL, CDDL, OSL, EUPL. Weak copyleft is file- or
library-scoped and usually fine when merely linked, but it is a judgement, and the judgement should
be made by someone who knows they are making it.

**Unrecognised — fails.** A package with no licence we can identify is not a package we ship. Where
a dependency ships a real licence *file* but declares no `license` field, it is recorded as an
exception in the script with the evidence that was read off disk (currently `exif-parser` and
`thirty-two`, both MIT).

### Why the JSON Licence is denied

`org.json:json:20090211` arrived transitively through `socket.io-client` and was **packaged into the
APK in full** — 19 classes, including ones nothing referenced. Its licence carries the clause *"The
Software shall be used for Good, not Evil"*: not OSI-approved, treated as non-free by Debian and
Fedora, and Category X at Apache. Not copyleft, but not a term to accept in a binary distributed
commercially.

It is now excluded in `android/app/build.gradle.kts`. Nothing is lost — Android has provided
`org.json` in the platform since API 1 and `minSdk` is 24 — and `android/licenses.json` denies it by
name so it cannot return quietly.

## SBOM

Every release publishes `screentinker-sbom-<version>.cdx.json`: **CycloneDX 1.5**, listing every
production dependency with its version, package URL, and licence. Generated from a production
install, so it describes what actually runs.

CI also uploads one as a build artifact on every run.

## Vendored code

Anything committed under `frontend/vendor/` **ships in the release tarball** and must carry its
licence notice as a separate file — minifiers strip headers, which is exactly when the notice has to
be kept alongside. See `frontend/vendor/README.md`.

## The GLSL transitions

The 14 shaders in `shared/Transitions/` are original work. Each carries its author and licence in
the file header, and none derives from Shadertoy, gl-transitions, glslsandbox or similar. "GL
Transitions v1" in those headers refers to the *interface convention* — the function signature the
renderer calls — not to borrowed code.

## Limits

These gates identify licences from declared metadata and recorded evidence. They are not a
clean-room provenance review, and they do not detect code copied into the repository without
attribution.
