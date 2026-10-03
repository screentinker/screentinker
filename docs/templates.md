# Templates

Templates are ready-made screens — a lobby welcome, a weather forecast, a news ticker — that you
install once on your server and then use in any workspace by filling in a form: your logo, your
colours, your location, your text. Each use becomes an ordinary **widget**, so it goes into
playlists, layouts and schedules like anything else, and it keeps working offline on the player.

This page is for server administrators. Template authors: see the catalog repository's
`CONTRIBUTING.md`; catalog maintainers: its `SIGNING.md`.

- [Slide templates and code templates](#slide-templates-and-code-templates)
- [Trust levels](#trust-levels)
- [The community library (off by default)](#the-community-library-off-by-default)
- [Installing, using, updating, uninstalling](#installing-using-updating-uninstalling)
- [Revocation](#revocation)
- [Air-gapped servers](#air-gapped-servers)
- [Other catalogs](#other-catalogs)
- [Settings and environment variables](#settings-and-environment-variables)
- [Security model, and its limits](#security-model-and-its-limits)

## Slide templates and code templates

| | **Slide** template | **Code** (html) template |
| --- | --- | --- |
| What it is | A slide layout with placeholders | The author's HTML, CSS and JavaScript |
| What runs | Nothing of the author's — the server fills in your values and renders it with its own slide renderer, which clamps every position, size and colour | The author's JavaScript, on each screen, in a sandbox |
| Network | None | Only the hosts listed in its manifest (shown before you install) — often none |
| Works on | Every player that shows slides | Every player with a web engine (all current players) |
| Unsigned import | Allowed for platform admins (shown as *Unverified import*) | Refused unless you switch on *Allow unsigned code templates* |

The library and the install dialog always say which kind a template is and, for code templates,
which hosts it connects to ("Makes no network requests" for most).

## Trust levels

Every installed template shows one of two badges:

- **Verified · *catalog*** — the package is signed by a catalog key this server trusts (the built-in
  ScreenTinker catalog, or one you added), and its bytes match the sha256 pinned by that catalog's
  signed index. Catalog templates are reviewed by a second maintainer before they are signed.
- **Unverified import** — imported by hand from a file that is unsigned, or signed by a key this
  server does not trust. Nobody has reviewed it on your behalf.

A package's hash is checked at install and **again every time the server loads it from disk**; a
package file modified after install is refused and its widgets go black.

## The community library (off by default)

Out of the box your server **never contacts the template catalog** — the same "nothing phones home"
promise as plugins and update checks. The *Library* tab says so and, for a platform admin, offers
**Enable community library**. You can also switch it in **Templates → Settings → Community library**.

When it is on, the server downloads each enabled catalog's signed `index.json` five minutes after
start-up and then once a day, plus whenever an admin presses **Check now**. It downloads a package
only when you install it. Nothing is sent except the HTTP requests themselves (no identifiers, no
telemetry). The built-in catalog is `https://screentinker.github.io/templates/`.

Each fetched index is verified before it is used:

- signed by that catalog's key (Ed25519; the official key_id is `e800b0481ec538d0`);
- written for that catalog (an index for one catalog cannot be replayed as another's);
- **serial** not lower than the last one accepted — an older index is refused (**rollback**);
- **expiry**: an index past its `expires` date still works but the catalog is flagged **stale**
  ("you may be missing updates or withdrawals") — a frozen or blocked catalog is visible, not silent.

Library badges: **New** (not seen by you yet), **Updated**, **Update available: vA → vB**, and
"Needs server version X or later" when a template requires a newer ScreenTinker.

Turning the library off stops all fetching. Installed templates keep working.

## Installing, using, updating, uninstalling

All of these except *Use* are **platform admin** actions, because an installed template is
available to **every workspace** on the server.

- **Install** — *Library* → a template → **Install**. The dialog shows the version, the catalog, the
  kind, and for code templates the hosts it connects to and a warning that it runs third-party code
  in a sandbox. The package is downloaded, checked against the signed index, and stored under
  `$DATA_DIR/templates/packages/<sha256>.sttemplate`.
- **Use** — any workspace member who can edit: *Installed* → **Use…** → fill in the form with a live
  preview → **Create widget** → optionally **Add to playlist** straight away. Values are checked on
  save (a colour must be a hex colour, a data source must exist in the workspace, and so on). The
  widget can be edited later from the same form.
- **Update** — when a catalog lists a newer version, the library shows **Update available**.
  Updates are never applied automatically: a new version changes what is on your screens. Pressing
  **Update** installs the new version; every widget using the template re-renders with it, keeping
  its values (a value the new version no longer accepts falls back to the template's default).
- **Uninstall** — refused while any widget still uses the template (the dialog lists them, in every
  workspace). Delete or change those widgets first.

Data for templates comes from your own server. The weather templates, for example, read a
**Weather data source** (Data Sources → New → Weather; keyless, from Open-Meteo) that your server
fetches on its own schedule; the template itself never contacts a weather service.

## Revocation

A catalog can **withdraw** a template version — because it is broken, infringing, or harmful — by
listing it in the `revoked` section of its signed index. When your server next accepts an index
(daily, **Check now**, or an imported offline bundle):

- every install of a revoked version turns **Withdrawn by its catalog — no longer usable**, with the
  catalog's reason, **whatever your update settings** (the install nobody is watching is the one
  that most needs pulling);
- its widgets render a **black screen** — never the old code — until you install a version that is
  not revoked (or uninstall it);
- installing that version, or importing its package by hand, is refused;
- a revocation by package hash also covers **unsigned local copies** of the same bytes;
- if a later index removes the revocation, installs from that catalog are reinstated automatically.

With the community library switched off, revocations arrive only with the offline bundles you
import — keep them current (below).

## Air-gapped servers

Everything works without internet access, with the same verification as online.

**Offline bundle.** Each catalog release publishes `screentinker-templates-YYYYMMDD.zip` (a zip of
`index.json`, `index.json.sig` and `packages/`). Carry it in and use **Templates → Import…**, tick
**This is an offline catalog bundle**, and choose the file. (Through the API:
`POST /api/templates/import?kind=bundle` with the zip as the request body.) The index goes through
exactly the same signature, catalog, serial, expiry and revocation checks as a download; packages
whose hash the index pins are stored, and anything else in the zip is ignored. Then install from the
*Library* tab as usual — no network is needed. Import a newer bundle to get updates and
revocations.

**LAN mirror.** Unpack a bundle — or copy the published site with `wget -m` — onto any internal web
server, then point the built-in catalog at it:

```bash
TEMPLATE_CATALOG_URL=https://templates.intranet.example/   # replaces screentinker.github.io/templates/
TEMPLATE_CATALOG_ALLOW_PRIVATE=1                            # the mirror has a private address
```

and switch the community library on. The mirror does not need to be trusted: the index is still
verified with the official key, and package URLs are relative to the index, so nothing needs
rewriting. Without `TEMPLATE_CATALOG_ALLOW_PRIVATE=1` the server refuses catalog URLs that resolve to
private, loopback or link-local addresses (its SSRF guard); with it, it fetches them directly
(no redirects, 20 s timeout, size-capped).

**Single package.** A `.sttemplate` file can be imported on its own. Signed by a trusted catalog key
→ *Verified* under that catalog; otherwise → *Unverified import*.

## Other catalogs

Anyone can run a catalog — a company-internal one, or a vendor's — with the same tooling and their
own Ed25519 key. In **Templates → Settings → Catalogs → Add a catalog** enter an id, a name, the
index URL (optional — leave it empty for a catalog you only receive as offline bundles) and the
catalog's **public key** in PEM form. Only add a key you got from someone you trust through a channel
you trust: whoever holds the matching private key decides what code runs on your screens.

Templates are identified as `<catalog>/<id>`, so two catalogs can both have a `news-ticker` without
one replacing the other. A catalog can be disabled (its templates stay installed; its index is
ignored) or removed once none of its templates is installed. The built-in catalog can be disabled
but not removed.

**`TEMPLATE_CATALOG_PUBLIC_KEY`** replaces the built-in catalog's compiled-in public key (PEM; `\n`
escapes are accepted). Use it for a private fork of the official catalog, or if the official key is
ever rotated before you can upgrade. When the key changes, the server drops its cached index and
resets the serial floor, because the old index was verified under the old key.

## Settings and environment variables

| Setting | Where | Default |
| --- | --- | --- |
| Community library | Templates → Settings (platform admin) | **off** |
| Allow unsigned code templates | Templates → Settings (platform admin) | **off** |
| Catalogs | Templates → Settings → Catalogs | the built-in ScreenTinker catalog |

**Allow unsigned code templates.** Code templates that no trusted catalog signed have not been
reviewed by anyone. With this off (the default), importing one is refused and widgets of any that are
already installed render black. To switch it on you must type the sentence *"I understand unsigned
templates run unreviewed code on my screens"*; the change is audited, and widgets re-render
immediately either way. Turn it on only for templates you wrote yourself, ideally on a test server.
Unsigned **slide** templates do not need it — they contain no code.

| Variable | Effect |
| --- | --- |
| `TEMPLATE_CATALOG_URL` | URL of the built-in catalog's directory (a mirror). Default `https://screentinker.github.io/templates/` |
| `TEMPLATE_CATALOG_ALLOW_PRIVATE=1` | allow catalog URLs on private/LAN addresses (bypasses the SSRF guard for catalog fetches only) |
| `TEMPLATE_CATALOG_PUBLIC_KEY` | override the built-in catalog's public key (PEM) |
| `TEMPLATES_DIR` | where packages are stored. Default `$DATA_DIR/templates` — include it in backups |

## Security model, and its limits

What protects you:

- **Signature and hash chain.** Catalog key → signed index → sha256 per package version → the bytes,
  checked at install and on every load. CI never holds the catalog key; a maintainer signs offline
  only after rebuilding each package from the reviewed source and getting the same hash.
- **Human review.** Every template and every update is reviewed by a maintainer who is not its
  author, against published rules: permissive licences only, no CDN assets, no `eval`, no minified
  code, network only to declared hosts, nothing secret.
- **Slide templates run no author code at all.**
- **Code templates are sandboxed.** They are served with
  `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; …` (also repeated as a `<meta>`
  tag), which makes the document an **opaque origin** even when it is opened directly in a browser
  tab or loaded full screen by a panel. It cannot read the dashboard's session, cookies or storage,
  cannot call this server's API as you, cannot open frames, popups, forms or workers, and its
  `fetch`/XHR/WebSocket requests can reach only the `https://`/`wss://` hosts its manifest declared
  (usually none — all its own files are inlined). The manifest's host list is shown before install.
- **Revocation** reaches every install that fetches the index, even with updates off.
- **Off by default**, and verifiable offline.

What it does **not** do — read this before entering anything into a code template's form:

- ⚠️ **Everything you give a code template, its author can read.** CSP limits which hosts a page may
  *fetch from*; it cannot stop a page from **navigating** itself (or a top-level window) to
  `https://anywhere.example/?data=<your values>`, and browsers do not block that. So a malicious
  template could send out any value you typed into it and any data-source values it was given. That
  is why there is **no secret field type**, why the form warns "Everything you enter here is visible to
  this template's code", and why review — not the sandbox — is what keeps a catalog template honest.
  Never put passwords, API keys or private URLs into a template. Give it a **data source** instead:
  credentials stay encrypted on your server, and the template sees only the resulting data — which you
  should also treat as readable by the template's author.
- **WebRTC is not fenced.** WebRTC's STUN/TURN traffic is not governed by `connect-src`, and the
  `webrtc 'block'` directive that would cover it is not implemented by Chromium — which every
  ScreenTinker player engine is built on — so the server does not send it. A code template could
  therefore open a peer connection to an undeclared host. Review rejects any template that uses
  WebRTC, and the catalog's lint job fails on it — but for an unverified template, only you stand
  between it and your network.
- It is still code running on your players: a hostile or buggy template can show misleading content,
  use CPU, or fill its own zone with anything. It cannot escape the sandbox short of a browser bug;
  players that run an old, unpatched web engine are more exposed to those.
- A signature says *which catalog vouched for this*, not *this is safe*. Adding a third-party catalog
  delegates that judgement to whoever holds its key. An **unverified** code template has had no
  review at all.
- Revocation needs the server to see the next index: with the library off it arrives only with the
  offline bundles you import.
- If a catalog's private key were stolen, the thief could sign templates your server would accept
  until you upgrade to a release with a new key (or set `TEMPLATE_CATALOG_PUBLIC_KEY`). The official
  key is kept offline for that reason; watch release notes for security releases.
