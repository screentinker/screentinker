# go2rtc-vp8 — VP8/VP9-capable go2rtc for ScreenTinker live video

Stock go2rtc accepts **only H264/H265** on WebRTC ingest (`RegisterDefaultCodecs` in
`pkg/webrtc/api.go`). A publisher that offers VP8/VP9 gets its video m-line rejected
(`answer m=video 0`) and no media flows.

This does not affect browsers or real phones — they all offer H264. It **only** bites publishers
with no H264 encoder, most notably the **Android emulator** (its lone H264 codec is a software OMX
encoder that libwebrtc's `DefaultVideoEncoderFactory` excludes, so it offers VP8/VP9/AV1 only).

This directory builds a go2rtc image that also registers VP8 and VP9 for receive, so those
publishers work. The change is a single patch to one function — see `vp8-vp9-codecs.patch`.

## Build

```sh
docker build -t screentinker/go2rtc-vp8:1.9.14 docker/go2rtc-vp8
```

Pin a different upstream tag with `--build-arg GO2RTC_VERSION=v1.9.14` (keep it in sync with the
`alexxit/go2rtc` tag the final stage pulls).

## Use

Replace `alexxit/go2rtc:latest` with `screentinker/go2rtc-vp8:1.9.14` in your compose file / live
video sidecar (see `docs/live-video.md`). No config change is needed; the extra codecs are additive.

## Caveat

A VP8/VP9 producer can be consumed only by go2rtc's **WebRTC** consumers — which is exactly what the
ScreenTinker dashboard live view uses. go2rtc's RTSP / MP4 / HLS / MSE outputs still require H264 and
will not see a VP8-only producer. If you depend on those, keep publishers on H264 instead.
