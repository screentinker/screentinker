# Live video (go2rtc)

ScreenTinker's built-in live view is a **screenshot stream**: the player captures its screen about
once a second and relays it over the dashboard socket. That is the right transport for a snapshot
and for input injection, and it is the wrong one for continuous video — it is a slideshow, not a
picture of what is playing.

This document describes the **optional** WebRTC path. With a [go2rtc](https://github.com/AlexxIT/go2rtc)
sidecar and a publishing player, the dashboard shows sub-second video (audio optional), and one
screen can be watched by many dashboards without asking the device to encode a separate stream for
each viewer. Without go2rtc, nothing changes: live view stays the screenshot stream, and the
Devices page works exactly as before.

## The shape of it

```
player ──publish──▶ go2rtc ──restream──▶ dashboard
                      ▲                      │
                      └── ScreenTinker ◀─────┘  (signaling proxied + workspace-authorised)
```

- **go2rtc** does the restreaming. ScreenTinker never becomes an SFU.
- **ScreenTinker's server** is the only thing that talks to go2rtc's admin API (register streams,
  proxy SDP). The browser never receives the go2rtc URL or a token.
- **The dashboard** plays WebRTC first, then falls back to MSE/HLS, then to the screenshot stream.
- Everything is **workspace-scoped**: a stream is named from its workspace *and* device, so one
  workspace can neither name nor subscribe to another's stream.

## Ports: 1984 vs 8555

| Port | What | Expose it? |
|------|------|-----------|
| **1984** | go2rtc HTTP API | **No.** Only the ScreenTinker container reaches it, over the compose network. The dashboard signals through ScreenTinker, which keeps this private. Never publish it to the host or the internet. |
| **8555/tcp** | WebRTC over TCP | Works behind a reverse proxy and on plain-HTTP LANs. The safe default. |
| **8555/udp** | WebRTC over UDP | Lower latency, but must be open end to end. |

## Enabling it

1. **Run the sidecar.** Uncomment the `go2rtc` service in `docker-compose.example.yml`, and the
   `LIVE_VIDEO_*` / `GO2RTC_*` environment on the `screentinker` service.

2. **Drop a `go2rtc.yaml`** beside your compose file. A minimal one:

   ```yaml
   api:
     listen: ":1984"
     # Protect the API and set the same value as GO2RTC_API_TOKEN on the ScreenTinker service.
     # token: "a-long-random-string"

   webrtc:
     listen: ":8555"
     candidates:
       # On a LAN with network_mode: host this is discovered automatically. If go2rtc runs on the
       # bridge network, or you are reaching it across the internet, list the reachable host here:
       # - "203.0.113.10:8555"
       # - "stun:8555"   # ask a STUN server what our public address is

   # Streams are created by ScreenTinker at runtime via the API; none need listing here.
   streams: {}
   ```

3. **Turn it on in three places.** Live video is off by default at every level, so enabling the
   sidecar never silently starts streaming:
   - server master gate: `LIVE_VIDEO_ENABLED=true`
   - per workspace: Settings → Live video
   - per device: the device's "Publish live video" toggle

## Why Cloudflare's orange cloud breaks UDP WebRTC

Cloudflare's proxy (the orange cloud) only forwards HTTP(S). WebRTC's media does not travel over
your HTTPS origin — it uses ICE to negotiate a direct UDP (or TCP) path on port 8555, which the
orange cloud does not proxy. So a dashboard loaded through an orange-clouded hostname will sign
successfully (that is HTTPS, proxied fine) and then fail to receive media.

Options, in order of preference:

- **LAN / same network:** nothing to do. ICE finds the host candidate; WebRTC/TCP on 8555 works
  even over plain HTTP.
- **Public, grey cloud (DNS only):** point a DNS record straight at the host and open 8555. ICE
  uses the host candidate.
- **Public, must stay orange:** run a **TURN** server on a reachable address and set
  `GO2RTC_TURN_URL` (and user/pass). Media relays through TURN. STUN alone is not enough here.

`GO2RTC_STUN_URLS` (default `stun:stun.l.google.com:19302`) helps a client discover its own public
address; it does not relay media, so it does not fix the orange-cloud case on its own.

## LAN vs public candidates

go2rtc advertises **ICE candidates** — the addresses a browser can try. On a LAN, the host's LAN IP
is the candidate and it just works. Across the internet you must advertise a **reachable** address:
either a public host IP in `webrtc.candidates`, or `stun:8555` to have go2rtc ask a STUN server for
its public address, or a TURN relay for the hardest cases. If live view connects on the LAN but not
remotely, this is almost always the cause.

## Publishing (players)

- **Web player** (`/player`, and the desktop/Electron shell): publishes the screen with
  `getDisplayMedia` when live video is enabled. This is the reference publisher. Opening a device's
  Now Playing tile asks the panel to publish (`dashboard:live-publish` -> relayed to the player as
  `device:live-publish`); the player offers sendonly WebRTC to the device-authenticated route
  `POST /api/devices/:id/live/publish` (auth = the same `device_token` the socket uses), which
  proxies to go2rtc's `dst=` endpoint. **Browsers only grant `getDisplayMedia` from a user
  gesture**, so the player starts capture on its next on-screen interaction (or immediately if one
  is already active). Unattended kiosks need Chromium's capture flag; that is a large part of why
  the Android publisher below, which needs neither gesture nor picker, is the real signage path.
- **Android** (`android/`): publishes via **MediaProjection + WebRTC** (`LiveVideoPublisher` driven
  by `LiveVideoService`, an FGS of type `mediaProjection`). This is the robust signage path: the OS
  captures the framebuffer, so there is no browser, no per-frame gesture, and none of the web
  player's `resistFingerprinting` fragility. Consent to MediaProjection is required once (the system
  dialog, or a device-owner auto-grant); the dashboard's publish request triggers it via
  `ScreenCapturePermissionActivity.requestForLive`, then the sender runs in `LiveVideoService`.
  Uses the `io.getstream:stream-webrtc-android` AAR.
  Unlike the web player's one-shot HTTP WHIP, the Android publisher signals over a **WebSocket with
  trickle ICE** — it connects to `…/api/devices/:id/live/publish/ws?token=<device_token>`
  (`lib/live-publish-ws.js`), which proxies to go2rtc's `/api/ws?dst=<stream>`. This is go2rtc's own
  client protocol and is required here: go2rtc's HTTP answer inlines its ICE candidates, and native
  libwebrtc drops candidates that arrive before its transport exists ("JsepTransport doesn't exist"),
  so it never connects. The WS answer carries no inline candidates and trickles them afterwards,
  which lands cleanly. Browsers tolerate the inline form, so the web player keeps the simpler HTTP
  route.
- **Tizen / webOS / BrightSign:** no native publisher yet. These keep the screenshot stream.
- **Any device that cannot publish** keeps the screenshot fallback, so nothing regresses.

## How publishing into go2rtc works (verified)

go2rtc's WHIP publish endpoint is `POST /api/webrtc?dst=<stream>`, and it **404s on a stream that
does not exist yet**. The streams API cannot create a truly empty stream (PUT requires a source),
so ScreenTinker creates the stream with go2rtc's inert `webrtc:` source (an "expects an inbound
WebRTC producer" placeholder) the moment a player publishes, then runs the `dst=` exchange. This is
`ensureStream()` in `lib/go2rtc.js`, called by `POST /api/devices/:id/live/publish`.

Because ScreenTinker creates streams at runtime, mounting `go2rtc.yaml` read-only (`:ro`, as in the
compose sample) is fine and slightly preferable: go2rtc still creates the stream in memory (it just
logs that it could not persist the definition), so per-device `st_<hash>` entries stay ephemeral and
never accumulate in the config. They vanish on a go2rtc restart and are recreated on the next
publish. A writable config also works if you want the definitions to survive restarts.

## Codecs (H264 vs VP8)

go2rtc's WebRTC MediaEngine registers **only H264/H265** for video, for both send and receive
(`RegisterDefaultCodecs` in `pkg/webrtc/api.go`). A publisher that offers no H264 gets its video
m-line rejected in the answer (`m=video 0`), the transport is never built, and no media flows.

In practice this is invisible: every browser and virtually every real Android phone has a hardware
H264 encoder and offers it. The one environment that does not is the **Android emulator** — its only
H264 codec is a software OMX encoder that libwebrtc's `DefaultVideoEncoderFactory` excludes, so it
offers VP8/VP9/AV1 only and stock go2rtc rejects it.

If you need to publish from a device without an H264 encoder (emulator testing, or unusual hardware),
build the **VP8/VP9-capable go2rtc** in [`docker/go2rtc-vp8/`](../docker/go2rtc-vp8/README.md) and
use that image in place of `alexxit/go2rtc`. It adds VP8/VP9 to the receive set with a one-function
patch. Caveat: a VP8/VP9 producer feeds only go2rtc's WebRTC consumers (which is what the dashboard
live view uses); its RTSP/MP4/HLS/MSE outputs still require H264.

`GET /api/devices/:id/live` reports `mode: "webrtc"` only when a publisher is **actually connected**
(a go2rtc producer with a real `remote_addr`), not merely when the placeholder stream exists — so a
tile shows the live feed only when there is one, and the snapshot otherwise. On a clean stop the
player's `device:live-publish` stop tears the stream down immediately; a hard tab close lingers for
go2rtc's ICE-consent timeout (~30s) before the producer drops.

Verified end to end against go2rtc 1.9.14 with a real headless Chromium: a WHEP viewer decodes
frames straight from go2rtc and through the ScreenTinker signaling proxy, and a browser publisher
pushes a track that a viewer then watches back through the proxy.

## Talk (voice intercom + group PA)

Voice rides the same go2rtc path as live video, in **Opus** (which go2rtc registers by
default, so no patched sidecar is needed for talk — only VP8 video needs the patch). Talk is
**off by default** and turned on per organization: it is gated on the `TALK_ENABLED` master switch
(`config.talkEnabled`) **and** the org's own `talk_enabled` flag (see
[Per-organization settings](#per-organization-settings-talk-flag--ice-override) below), plus the
`remote.talk` capability, which a device declares only if it runs the WebRTC audio
publisher/subscriber. Two-way additionally needs `remote.mic` (the device has a microphone).

- **Per-device:** the **🎙️ Talk** button in a device's top action bar. It is **one-way by default**
  (operator mic → device speaker), so it works on a mic-less screen. A device that declares
  `remote.mic` also gets a **🎙️ 2-way audio** button, which additionally plays the device's mic
  back to the operator. Each direction is a one-directional stream (`tk_dn_<hash>` operator→device,
  `tk_up_<hash>` device→operator), because a go2rtc stream has a single producer. The device runs a
  `microphone` foreground service ([`TalkService`] → [`AudioTalker`]); the operator runs the browser
  peer connections ([`talk-client.js`]). Hardware echo-cancellation on the device stops the operator
  hearing themselves. Each side publishes first and its subscribe leg RETRIES until the far producer
  exists (an SFU intercom is a mutual-subscribe race). The operator can optionally share a **webcam**
  on the downlink; the device renders it fullscreen over the content (Android [`TalkVideoBus`] →
  a `SurfaceViewRenderer`, web player a fullscreen `<video>`). Content audio and video are ducked
  while talk is active, and restored on stop.
- **Group / workspace (one-way PA):** the **🎙️ Talk** button on a group header, and **🎙️ Talk to
  all** in the dashboard header. The operator publishes their mic ONCE to a shared broadcast stream
  (`tk_cast_g_<hash>` / `tk_cast_w_<hash>`); every device in scope SUBSCRIBES and plays it
  (listen-only — no device mic, so a whole group's mics never mix into noise, and listening needs no
  RECORD_AUDIO). The server fans a `device:talk-start{mode:"listen"}` out to each in-scope device,
  filtered by the same per-device gates (write access + `remote.talk` + the org's talk flag), so
  a broadcast never makes a device play audio it is not individually cleared for. The device's
  listen leg resolves its channel through the device-authenticated proxy, which validates the device
  belongs to that group/workspace before subscribing.

Signaling for the device legs uses the WebSocket + trickle proxy (`lib/live-publish-ws.js`, routes
`talk/publish`, `talk/subscribe`, `talk/listen`) for the same reason live video does; the operator's
browser legs use the plain HTTP WHIP/WHEP routes (`/talk/publish`, `/talk/view`, and the group /
workspace `/talk/publish`). Talk is fail-soft: any failure just leaves no audio, never touching
playback or live video.

## Per-organization settings (talk flag + ICE override)

Two org-level knobs live on the `organizations` row and are resolved from a device or workspace up
to its org by [`lib/org-webrtc.js`](../server/lib/org-webrtc.js):

- **`talk_enabled`** (INTEGER, default `0`) — turns Talk on for that org, **on top of** the global
  `TALK_ENABLED` master switch. Both must be true. Off by default for every org, so enabling the
  master alone changes nothing until an org is opted in.
- **`ice_servers`** (TEXT, JSON, default NULL) — an **optional per-org ICE (STUN/TURN) override**, a
  JSON array of `[{urls, username?, credential?}]`. NULL falls back to the sidecar's global
  `GO2RTC_*` ICE servers, so an org can bring its own TURN without touching the sidecar. It applies
  to **live video and talk** alike.

A **platform admin** sets both in the dashboard under **Admin → Organizations** (the Talk toggle and
ICE box appear once `TALK_ENABLED` is on), or over the API with `PUT /api/admin/orgs/:id/talk`
(`{ talk_enabled, ice_servers }`; the ICE JSON shape is validated server-side). The master switch is
reported to the frontend at `GET /api/status` as `features.talk`, which gates whether the Talk
controls render at all; the per-org flag is then enforced server-side on every talk exchange.

## If go2rtc is down

Live view silently uses the screenshot stream and the tile shows a small "video unavailable" hint.
The Devices page, remote control, and input injection are unaffected — none of them depend on
go2rtc. `GET /api/devices/:id/live` always returns a usable descriptor (`mode: "snapshot"` with a
`reason`) rather than an error.

## Remote control on top of video

Touch and key injection stay on the dashboard/device Socket.IO path (`remote.input`) and are drawn
as an overlay on top of the `<video>`. WebRTC replaces only the *picture*; the control plane is
unchanged.
