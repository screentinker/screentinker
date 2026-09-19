# Samsung Apps TV — Seller Office submission notes

What to build, what to enter, and what the QA tester needs. Written after the 2026-09-18 pre-test
failure and a review of the app against Samsung's certification checklist. The checklist itself:

- Mandatory features: https://developer.samsung.com/smarttv/develop/development-checklist/mandatory-features.html
- Common test cases (CO-xx-nn): https://developer.samsung.com/smarttv/develop/development-checklist/common.html
- Launch checklist: https://developer.samsung.com/tv-seller-office/checklists-for-distribution/launch-checklist.html
- Application UI Description: https://developer.samsung.com/tv-seller-office/checklists-for-distribution/application-ui-description.html
- Certification Q&A: https://developer.samsung.com/tv-seller-office/faq/certification-process.html

## 1. The package

```bash
./build-wgt.sh --store          # -> ScreenTinker-store.wgt (consumer manifest, see README)
tizen package -t wgt -s <SamsungProfile> -- ScreenTinker-store.wgt   # re-sign with the Samsung cert
```

- Bump `version` in `config.xml` for every upload; Seller Office refuses a version it has seen.
- `<name>ScreenTinker</name>` must equal the store's default-language title character for character.
- The package is signed with the SDK test distributor until a Samsung author + distributor
  certificate exists (Tizen Studio → Certificate Manager → Samsung, seller account). The pre-test
  passes the manifest either way; the store will not accept the test signature.

## 2. The tester cannot pair without an account — solve it in Verification Info

Samsung's certification FAQ names missing test credentials as the leading cause of rejection. The
app's first screen is a pairing code that only a ScreenTinker dashboard can consume, so the tester
needs, per model group requested:

- A **test account on the hosted server** (`https://screentinker.com`): e-mail already verified
  (hosted sign-up hard-blocks otherwise), **not a trial** (the trial-expiry sweep would downgrade it
  mid-certification), device quota ≥ 5, no geo restriction.
- A playlist named **"Samsung QA"** already published in the account: 3 images + 1 MP4 with audio,
  10 s each. There is no "default playlist for new displays" — the tester assigns it once after
  pairing (step 3 below), which is one click on the display's page.

Created 2026-09-18 on the hosted server: `qa@screentinker.com` (Pro, no trial, e-mail verified),
playlist `6320764a-7358-4212-b702-3afa6e3cca7e`. The password is held by the owner, not in the repo.

Put in the *Verification Info* comment and the UI Description "Use Cases":

1. Launch the app. The Server URL screen is pre-filled with `https://screentinker.com`; press OK on
   **Connect** (or Enter in the field).
2. The pairing screen shows a 6-digit code. In a PC browser sign in at
   `https://screentinker.com` with the test account → **Devices → Pair a display** → enter the code.
   The TV leaves the pairing screen within about five seconds.
3. Open the new display's page in the dashboard and assign the **"Samsung QA"** playlist (or drag
   the playlist onto the display on the Devices page). Playback starts on the TV within seconds.
4. Playback is full-screen and loops indefinitely — this is a digital-signage player; the screen
   saver is disabled by design while content plays.
5. **Return** during playback opens "Exit ScreenTinker?" (Exit / Change server / Cancel).
   Return on the Server URL screen exits the app. The **Exit** key exits from anywhere.
6. Unplug the network: a status message appears; cached content keeps playing. Re-plug: the message
   clears and playback continues.

## 3. UI Description form

| Field | Enter |
|---|---|
| Remote keys used | Return, Exit only. No colour, number or media keys. No keyboard functions. |
| Language options | English only (setup/pairing UI is English; idle/error strings follow the TV language). |
| Ads / TIFA | None. |
| Samsung Checkout | None — Free. |
| Smart View / caption / TTS | N/A — no video controls, no on-screen text video. |
| Player information | HTML5 `<video>` (H.264/AAC MP4, HLS via `<video>`); AVPlay for rotated video; no DRM. |
| Multitasking | Supported: media pauses on hide and resumes on show (`js/player.js` suspend/resume). |
| Category | Information (or Lifestyle). Not Video — restricted for public sellers. |

## 4. Assets

- Logo 1920×1080 (32-bit PNG, transparent) + background 1920×1080 (24-bit PNG/JPG)
- Icon 512×423 PNG
- Four 1920×1080 JPG screenshots ≤ 500 kB: setup, pairing, image playback, video playback
- Privacy-policy URL; support e-mail `support@screentinker.com` (must match `config.xml`)

## 5. Known gaps still open after 2026-09-18

Fixed in the same change as this file: multitasking resume (CO-MT-01), Return-key exit popup
(CO-US-05), unused privileges removed from the store manifest, dead `tizen.power` call removed.

Still to do, both documented rejection reasons:

- **Network-loss message (CO-CN-01/02):** today the app toasts "Reconnecting…" on socket loss and
  never says "no network". Register `webapis.network.addNetworkStateChangeListener` (privilege
  `network.public`, already declared): on GATEWAY_DISCONNECTED show "No network connection — showing
  cached content" and stop cycling uncached items through errors; on GATEWAY_CONNECTED dismiss and
  reconnect.
- **D-pad focus on the setup/pairing screens (CO-UI-06):** only Enter and Return are handled; the
  Connect and Change-server buttons are reachable by pointer only, and `body { cursor: none }` may
  hide the pointer. Add Up/Down focus cycling, or set `pointing-device-support="disable"` and rely
  on the D-pad.
