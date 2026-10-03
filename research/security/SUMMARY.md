# Templates library — security testing summary (2026-09-29)

Three independent adversarial passes plus review during the build. Details, repros and evidence are in
`api-authz.md`, `crypto-and-packages.md` and `sandbox-browser.md` beside this file. All findings below
marked FIXED have a regression test in `server/test/templates*.test.js` or `plugin-inbox-bomb.test.js`.

| # | Finding | Sev | Where | Status |
|---|---|---|---|---|
| 1 | Workspace **viewer** could run `POST /api/status/import` (write devices/playlists/widgets) and set `custom_css`/`custom_domain` (login-page CSS) | High, pre-existing | routes/status.js | FIXED: read-only refused; css/domain platform-admin only; template widget configs rebuilt |
| 2 | ReDoS in CSS `url()` rewrite: 1 MB stylesheet ≈ 5 min event-loop stall | High | templates/render.js | FIXED: linear, length-bounded regex |
| 3 | Render memory amplification: N references to one image → N base64 copies; 20k refs = process OOM crash-loop | High | templates/render.js | FIXED: per-render memo + running byte budget + try/catch → black page; trial render at install |
| 4 | Preview store held rendered HTML (≤6 MB × 200, all tenants): one editor → +914 MB, evicting other tenants | High (hosted) | routes/templates.js | FIXED: token stores key+values only, render on GET, 5/user |
| 5 | Rate limiter bypass by %-encoding path segments (affects every limiter) | Medium | lib/limit-paths.js | FIXED: per-segment decode; template shapes added |
| 6 | Plugin zip inbox inflated entries fully before size checks: 300 KB upload → +608 MB | Medium, pre-existing | lib/plugins/inbox.js | FIXED: capped streaming inflate |
| 7 | Native player granted the **microphone** to any playlist web page | Medium, pre-existing (mine, #453) | native …/Slot.qml | FIXED: deny all |
| 8 | Small-order Ed25519 public key accepted → forged signatures verify | Medium | templates/signing.js | FIXED: libsodium blocklist |
| 9 | Disabling a catalog / rotating its key left its installs "verified" and running | Medium | templates/widget.js | FIXED: trust re-checked at use (enabled + key_id) |
| 10 | Malformed revocation entries silently ignored (fail-open) | Medium | templates/catalog.js + CLI | FIXED: index refused; CLI validates revoked.json |
| 11 | Index kind/network/min_server never checked against the package (consent dialog could lie) | Medium | catalog.js + CLI sign | FIXED: cross-checked both places |
| 12 | CLI `sign` only compared the dist with itself (tampered CI artifact signable) | Process | scripts/template-catalog.js | FIXED: `sign --source` rebuilds from reviewed source |
| 13 | Import endpoint buffered up to 300 MB for any upload kind; JSON body parser ate `.sttemplate` | Low | routes/templates.js, server.js | FIXED: size by kind before buffering; JSON parser skips path |
| 14 | Canonical check compared strings (invalid UTF-8 → 2 hashes), base64 regex RangeError at 8 MB | Low | templates/package.js | FIXED |
| 15 | Zip entries capped at per-file limit, not their claimed size; `__MACOSX` defeated wrapper strip | Low | templates/zip.js | FIXED |
| 16 | CLI path escapes: `../` index url in sign/verify/bundle; `build --previous` unsigned + escaping copies; verify OK on entries servers drop | Low | CLI | FIXED |
| 17 | Signed import ignored other catalogs' sha256 revocations; cross-catalog revocation never lifted | Low | catalog.js | FIXED |
| 18 | Uninstall deleted the offline-bundle copy (air-gapped reinstall impossible) | Low/func | store.js | FIXED |
| 19 | Public preview/thumb limiter per token; audit rows under a tenant workspace; refresh unaudited; CDN could keep a revoked template's old rev | Low | various | FIXED |
| 20 | Cached package not re-checked after on-disk swap | Low | store.js | FIXED: stat stamp |
| 21 | `server.js` ignores `HOST` (always 0.0.0.0) | Info, pre-existing | server.js | NOT FIXED — noted; research script corrected |

## Inherent limits (documented, not fixable by CSP)

- **Self-navigation exfiltration:** a template can navigate its own frame to any URL, carrying whatever it
  was given. Therefore nothing secret is ever given to a template (no secret param type; data sources
  arrive as already-rendered public values). Review is the control.
- **WebRTC:** `connect-src` does not govern ICE, and Chromium does not implement `webrtc 'block'`
  (tried; Chrome 149 logs it as unrecognised). The catalog lint refuses `RTCPeerConnection`.

## Verified to hold (real Chromium, live server)

Opaque origin even top-level (`self.origin === "null"`; storage/cookies/parent throw), 0/20 exfil channels
reached an attacker origin, eval/new Function blocked, CSP present on every template response, a second
injected `<meta>` CSP cannot loosen the policy, `st-values` JSON cannot be broken out of, player message
handlers ignore template frames. Admin endpoints 403 for everyone but platform admin (incl. support
sessions), API tokens cannot reach /api/templates, cross-tenant image/data references refused and never
rendered, SSRF guard blocks private/loopback/metadata catalog URLs, rollback / replay / cross-catalog index
refused.
