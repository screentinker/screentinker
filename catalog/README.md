# ScreenTinker community templates

This repository is the **official template catalog** for [ScreenTinker](https://github.com/screentinker/screentinker)
digital signage. Every folder under `templates/` is a template that any ScreenTinker server can
install from its **Content → Templates → Library** tab: a welcome screen, a weather forecast, a news
ticker, a menu board. You pick one, fill in its settings (logo, colours, location, text) with a live
preview, and put it on a screen or in a playlist like any other item.

Templates come in two kinds:

| Kind | What it is | What runs |
| --- | --- | --- |
| **slide** | A declarative slide layout (`template.json`) with `{{param:…}}` placeholders | Nothing. The server fills in the values and renders it with its own slide renderer. |
| **html** | HTML, CSS and JavaScript written by the template's author | The author's code, in a sandboxed, opaque-origin document on each screen, fenced by a strict Content-Security-Policy |

Want to write one? Read [CONTRIBUTING.md](CONTRIBUTING.md). Maintainers publishing a release:
[SIGNING.md](SIGNING.md). Server operators: the server's `docs/templates.md`.

## How a server uses this catalog

**Off by default.** A ScreenTinker server never contacts this catalog on its own. A platform admin
has to switch on *Settings → Templates → Community library* first — the same "no phone home"
promise the server makes for plugins. With it off, everything below still works by importing files
by hand.

**Signed index.** Merging to `main` builds the catalog; a maintainer then signs it **offline** with
the catalog key (never a CI secret — see [SIGNING.md](SIGNING.md)) and publishes it to GitHub Pages
at `https://screentinker.github.io/templates/`. What a server downloads is:

```
index.json            the list of templates and versions, each pinned by sha256
index.json.sig        Ed25519 signature of index.json ("<key_id>:<base64>")
packages/<id>-<version>.sttemplate    one signed package per version
thumbs/<id>-<version>.png             the catalog preview picture (not signed — only a picture)
```

The server's copy of the catalog public key is compiled in (`server/lib/templates/signing.js`,
key_id `e800b0481ec538d0`). It refuses an index that is not signed by it, an index for another
catalog, and an index whose `serial` is lower than one it has already accepted (**rollback**). An
`expires` date in the past is shown to the admin as **stale** (a frozen mirror is visible, not
silent). Every package must hash to the sha256 the signed index pins, at download and again every
time the server loads it from disk.

**Updates are offered, not applied.** A server checks once a day (plus a *Check now* button) and
marks templates **New** or **Update available**. Installing a new version is an explicit admin
action, because a new version changes what is on screens.

**Revocation.** `revoked.json` in this repository becomes the index's `revoked` list. A revoked
template version stops rendering on every server that fetches the index — including servers that
never auto-update — and shows a black screen with the reason in the admin UI until an admin
installs a version that is not revoked. Revocations can match by id + version or by package sha256
(which also catches unsigned copies of the same bytes).

**Offline bundle.** Each release also produces `screentinker-templates-YYYYMMDD.zip`: `index.json`,
`index.json.sig` and every package, attached to the GitHub release. An air-gapped server imports it
with *Import → Offline bundle*; it goes through exactly the same signature, hash, serial and
revocation checks as the online path. (Thumbnails are not in the bundle; the server reads them out
of the packages.)

**Mirrors.** A mirror is just a copy of the published directory: unpack the bundle, or `wget -m`
the Pages site, onto any web server, and point `TEMPLATE_CATALOG_URL` at it (with
`TEMPLATE_CATALOG_ALLOW_PRIVATE=1` for a LAN address). Package URLs in the index are relative, so
nothing needs rewriting — and because the index is signed, the mirror does not need to be trusted.

**Third-party catalogs.** Anyone can run their own catalog with the same tooling and their own key;
admins add it by URL and public key. Templates are identified as `<catalog>/<id>`, so ids cannot be
squatted across catalogs.

## Repository layout

```
templates/
  <id>/                  one folder per template; the folder name IS the template id
    manifest.json        name, version, kind, licence, params … (CONTRIBUTING.md has every field)
    template.json        slide templates: the slide document
    index.html, *.css, *.js   html templates: the entry and its files
    thumbnail.png        catalog preview, 16:9, ≤ 200 KB
    LICENSE              the template's licence text
    NOTICE               attribution for bundled fonts/images (when there are any)
    README.md            what it is and what each setting does
revoked.json             revocations, published in the signed index
screenshots/             1920×1080 renders of every template, made by tools/render-previews.js
tools/render-previews.js renders every template through the real server code (used by CI)
tools/lint-templates.js  the machine-checkable review rules (used by CI)
.github/
  workflows/validate.yml pull requests: build/validate, lint, headless render for the reviewer
  workflows/build.yml    main: build an UNSIGNED dist artifact for a maintainer to sign offline
  CODEOWNERS             who must review what
  pull_request_template.md   the review checklist
```

## Reproducible

A package is canonical JSON (sorted keys, no whitespace) of its manifest and files, and its identity
is the sha256 of those bytes — not of the signed envelope. So anyone can rebuild a published
package from this repository at the published commit and get the **same sha256** the signed index
pins. The signing tool enforces it: `sign --source <reviewed checkout>` rebuilds every new package
from the reviewed source and refuses to sign bytes that differ (SIGNING.md).

## Licence

Each template carries its own licence (MIT, Apache-2.0, BSD, ISC, 0BSD, CC0 or Unlicense only).
The repository tooling is MIT.
