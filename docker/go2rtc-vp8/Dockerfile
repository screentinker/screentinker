# syntax=docker/dockerfile:1
#
# go2rtc, patched to accept VP8/VP9 on WebRTC ingest (publish).
#
# Upstream go2rtc registers ONLY H264/H265 for WebRTC (pkg/webrtc/api.go, RegisterDefaultCodecs),
# so a device that publishes VP8/VP9 gets its m-line rejected (answer `m=video 0`) and no media
# flows. Every browser and virtually every real phone has a hardware H264 encoder, so they are
# unaffected — but a publisher without one (notably the Android EMULATOR, whose only H264 codec is
# a software OMX encoder that libwebrtc excludes) cannot publish to stock go2rtc. This image adds
# VP8/VP9 to the receive codec set so those publishers work too. See ./vp8-vp9-codecs.patch.
#
# Build:  docker build -t screentinker/go2rtc-vp8:1.9.14 docker/go2rtc-vp8
# Use it in place of `alexxit/go2rtc:latest` in your compose/live-video setup.
#
# NOTE: a VP8/VP9 producer can only be consumed by go2rtc's WebRTC consumers (which is exactly what
# ScreenTinker's dashboard live view uses). go2rtc's RTSP/MP4/HLS/MSE outputs still require H264, so
# they will not see a VP8-only producer. If you rely on those, keep publishers on H264.

# ⚠️ Both base images are pinned by digest (OpenSSF Scorecard: Pinned-Dependencies) and spelled
# out rather than built from ARGs, so Dependabot can move tag and digest together. GO2RTC_VERSION
# below (the source tag cloned and patched) must match the runtime image tag in the final FROM.
ARG GO2RTC_VERSION=v1.9.14

FROM golang:1.25-alpine@sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59 AS build
ARG GO2RTC_VERSION
RUN apk add --no-cache git
WORKDIR /src
RUN git clone --depth 1 --branch ${GO2RTC_VERSION} https://github.com/AlexxIT/go2rtc.git .
COPY vp8-vp9-codecs.patch /tmp/vp8-vp9-codecs.patch
RUN git apply --verbose /tmp/vp8-vp9-codecs.patch
RUN CGO_ENABLED=0 go build -ldflags "-s -w" -trimpath -o /go2rtc .

# Final image: reuse upstream's runtime (ffmpeg, tini, etc.), swap in the patched binary.
FROM alexxit/go2rtc:1.9.14@sha256:675c318b23c06fd862a61d262240c9a63436b4050d177ffc68a32710d9e05bae
COPY --from=build /go2rtc /usr/local/bin/go2rtc
