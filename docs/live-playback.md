# Live TV, IPTV, camera feeds and HDMI input

Play a **live stream on a screen**: an IPTV/TV channel over HLS, or an `rtsp://` camera/NVR on an
Android player. A live stream is an ordinary playlist item, so it schedules, sits in a zone, and
takes a dwell time like any other content.

> **This is the opposite of live *view*.** [`live-video.md`](live-video.md) is the *dashboard
> watching a screen* (go2rtc + WebRTC). This page is a *screen playing a live source*. They share
> nothing but the word "live".

**The server never touches the stream.** ScreenTinker validates the URL's shape and hands it to the
player; the player opens it directly. So:

- The URL can be a **LAN address** (`http://10.0.0.9/live.m3u8`, `rtsp://192.168.1.20:554/stream`) that
  the server itself could never reach.
- A 5 Mbps channel on 40 screens is 40 screens pulling from your source, **not** 40 streams through
  ScreenTinker's WAN link.
- Nothing is uploaded, transcoded, or cached server-side. If the source is down, the item skips on the
  player; the rest of the playlist keeps going.

## Two transports

| | HLS (`video/hls`) | RTSP (`video/rtsp`) |
|---|---|---|
| **URL** | an `http(s)` `.m3u8` | an `rtsp://` URL (credentials in the URL allowed) |
| **Plays on** | web player, BrightSign / webOS, Tizen, native Android | **native Android only** (ExoPlayer, forced over TCP) |
| **e-ink** | skipped (single-zone e-ink cannot play video) | skipped |
| **Latency** | a few seconds (HLS segments) | sub-second |
| **Fan-out** | one source feeds many screens | a camera caps its own sessions; does **not** fan out |
| **Extra infra** | none | none |

Which to use: **HLS** for a TV/IPTV channel and for anything that must reach non-Android screens or
many screens at once; **RTSP** for a camera/NVR shown on an Android panel where you want the lowest
latency. If you have a camera but need it on many screens or on non-Android players, bridge it to HLS
(see [Fan-out](#fan-out-many-screens-off-one-camera) below).

## Adding a live stream

1. **Content library → Add content → Live stream.** Paste the URL:
   - HLS: `https://…/channel.m3u8`
   - RTSP: `rtsp://user:pass@10.0.0.5/stream`

   ScreenTinker classifies it automatically: an `http(s)` `.m3u8` becomes `video/hls`, an `rtsp://`
   URL becomes `video/rtsp`. Give it a channel name (optional) and add it. It appears in the library's
   **Live** filter.
2. **Add it to a playlist** like any other item.
3. **Set the dwell** (the item's duration):
   - **0** = stay on this stream until something else takes over (the next schedule window, a trigger,
     or a manual skip). Use this for a screen that is *just* the channel or camera.
   - **N seconds** = show the live stream for N seconds, then rotate to the next item. Use this to mix
     a channel into a rotation. (Default dwell for a live item is 300s.)
4. **Publish the playlist.** Like every playlist change, a live item does not reach devices until you
   Publish.

A live stream works **full screen or inside a single zone** of a multi-zone layout, so you can put a
channel in one quadrant and normal content in the others.

## What reaches which screen

Live items are **capability-gated**, so a player only ever receives a stream it can actually open:

- `video/hls` is sent only to a player that declares `playback.hls` (web, BrightSign / webOS, Tizen,
  native Android).
- `video/rtsp` is sent only to a player that declares `playback.rtsp` — **native Android only**.
- A player that declares neither (an old build, e-ink) simply never receives the item and shows the
  rest of the playlist. Nothing errors, nothing goes black.

This gating happens server-side in the device socket, per transport, so the same playlist can contain
an RTSP camera and still play correctly on a Tizen TV in the same workspace (that TV just skips the
RTSP item).

## Fan-out: many screens off one camera

An RTSP camera limits its own concurrent sessions, and RTSP only plays on Android. For **many screens
off one camera**, or for **non-Android screens**, run an on-site **RTSP-to-HLS bridge** and point a
`video/hls` item at its HLS output. ScreenTinker does not run this for you and still never fetches the
stream — the bridge is yours, on your LAN.

[go2rtc](https://github.com/AlexxIT/go2rtc) is a good fit (it is the same sidecar used for live
*view*, but here it is a standalone bridge you run yourself). A minimal bridge config:

```yaml
# go2rtc.yaml — pulls one RTSP camera, exposes it as HLS for any number of screens
streams:
  lobby_cam: rtsp://user:pass@192.168.1.20:554/Streaming/Channels/101

# go2rtc serves HLS at http://<bridge-host>:1984/api/stream.m3u8?src=lobby_cam
```

Then add a live stream in ScreenTinker pointed at
`http://<bridge-host>:1984/api/stream.m3u8?src=lobby_cam`. Now every player type can show the camera,
and the camera only ever sees the single pull from the bridge.

> HLS adds a few seconds of latency versus native RTSP. For a lobby/overview camera that is fine; for
> a low-latency spot on a single Android panel, prefer native `video/rtsp`.

## Live input: the screen's own HDMI IN

An Android TV box with an **HDMI input** — the Fire TV Cube (3rd gen) is the tested one — can show
whatever is plugged into it as an ordinary playlist item: a cable or satellite box, a games console, a
camera, another signage player.

- **Add it:** Content → **Live input (HDMI IN)**, pick the input (or "First HDMI input"), give it a
  name. It is stored as `video/hdmi-in` with `remote_url` `hdmi://<port>` (`hdmi://` = the first
  input). There is nothing to fetch and nothing leaves the box.
- **Duration is dwell**, like a live stream: 5 minutes by default, `0` = stay until skipped.
- **Zones:** it plays boxed into a zone, and other zones can sit **on top of it** — a channel logo, a
  lower-third, a score bug — when they have a higher `z_index` and transparent content (a PNG with
  alpha, or a web widget with a transparent background).
- **Who gets it:** only a player that **found an HDMI input on that device** declares
  `playback.hdmi_in`, and the server sends the item to nobody else. A Fire TV Stick, a phone, a web
  player, Tizen, BrightSign, the Pi and e-ink skip it, and the rest of the playlist plays as normal.
- **No picture:** a source that is off or unplugged shows nothing for 15 s after tuning (10 s if the
  picture drops mid-play), then the item is skipped like a dead stream. A zone that holds only the
  input re-tunes every 10 s instead, so plugging the cable back in brings the picture back on its own
  (verified on a Fire TV Cube by pulling the cable).

> ⚠️ **It can never be captured.** The picture is a hardware video layer. Fire OS refuses
> `screencap` while it is on screen, and an app reading its own window gets black where it sits. So
> the dashboard screenshot shows a **"Live HDMI input" card in the input's place**, with everything
> around and above it (other zones, overlays) captured normally, and the dashboard preview shows a
> card too. Recording or re-streaming the input is not possible.

**Size the zone to the source.** The box scales the input in hardware and always keeps its aspect
ratio, so a 16:9 source in a zone that is not 16:9 is letterboxed. On a 1080p screen a zone 75% wide
and 75% tall is exactly 1440 × 810. If there are still black bars inside the picture, check the
source's own output: a player sending 1920 × 1200 (16:10) is pillarboxed into any 16:9 space.

Untested so far: HDCP-protected sources (most cable boxes), and audio levels from the input.

## Security and privacy

- **Credentials in an RTSP URL are allowed** (`rtsp://user:pass@host/…`), because an IP camera is
  addressed that way and the server never opens the connection. They are stored with the content row
  like any other remote URL; treat the library accordingly. Prefer a dedicated view-only camera
  account.
- **LAN sources stay on the LAN.** Because the player opens the URL, a `rtsp://192.168.x.x` or
  `http://10.x.x.x` source never has to be exposed to the internet or to the ScreenTinker server.
- ScreenTinker validates only the **shape** of the URL (is it an `.m3u8` / an `rtsp://`), not its
  contents. A bad or offline stream fails to a skip on the player.

## Troubleshooting

- **The stream does not appear on a screen.** Check the player type against the table above: RTSP only
  plays on native Android; e-ink skips all live items. Confirm the item was **published**.
- **It plays on Android but not on a TV/BrightSign.** That item is `video/rtsp`, which only Android can
  open. Bridge it to HLS (above) for other players.
- **A zone with a live stream never rotates.** Give the item a non-zero dwell if you want it to hand
  off; a dwell of 0 intentionally stays until the window/schedule changes.
- **Black or frozen frame on Android.** Usually the source: too few HLS segments (a very short
  low-latency window can starve the decoder), or a camera refusing the session. RTSP is forced over
  TCP for NAT/firewall friendliness; a camera that only speaks UDP RTP will not connect.

## Under the hood

For maintainers: the transport helpers (`LIVE_MIME`, `RTSP_MIME`, `classifyLiveUrl`,
`looksLikeHlsUrl`, `looksLikeRtspUrl`, `validatePlayerOpenedUrl`, `validateRtspUrl`) live in
[`server/lib/remote-url.js`](../server/lib/remote-url.js); the add-live route is `POST /api/content/hls`
in [`server/routes/content.js`](../server/routes/content.js); per-transport gating is in
[`server/ws/deviceSocket.js`](../server/ws/deviceSocket.js) against the `playback.hls` / `playback.rtsp`
capabilities from [`server/lib/player-capabilities.js`](../server/lib/player-capabilities.js); dwell
defaults are in [`server/lib/item-duration.js`](../server/lib/item-duration.js). On Android, the
fullscreen and per-zone RTSP sources (`RtspMediaSource` with `setForceUseRtpTcp(true)`) are in
`MediaPlayerManager` and `ZoneManager`; the web zone renderer routes `video/hls` through an
element-scoped hls.js attach so several zone streams can run at once.
