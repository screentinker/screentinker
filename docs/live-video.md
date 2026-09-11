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
  `getDisplayMedia` when live video is enabled. This is the reference publisher.
- **Android / Tizen / webOS / BrightSign:** no native publisher yet. These keep the screenshot
  stream. Android via MediaProjection is the obvious next one; it is **not** in this pass.
- **Any device that cannot publish** keeps the screenshot fallback, so nothing regresses.

## If go2rtc is down

Live view silently uses the screenshot stream and the tile shows a small "video unavailable" hint.
The Devices page, remote control, and input injection are unaffected — none of them depend on
go2rtc. `GET /api/devices/:id/live` always returns a usable descriptor (`mode: "snapshot"` with a
`reason`) rather than an error.

## Remote control on top of video

Touch and key injection stay on the dashboard/device Socket.IO path (`remote.input`) and are drawn
as an overlay on top of the `<video>`. WebRTC replaces only the *picture*; the control plane is
unchanged.
