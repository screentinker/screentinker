# SSSP3/Orsay limitations and closed avenues

Field notes from the DB48E (SSSP3, WebKit-2012-era engine) generations of
this port, stated as platform limits rather than build history. Treat them as
the current contract: do not re-enable a listed-closed approach without new
hardware evidence.

## Video plane and PiP

- The native LFD video plane is always on top of the HTML compositor, and
  only one video surface exists. Zoned (split/n-column/PiP) layouts
  therefore keep video in the HTML video element; only single-fullscreen-zone
  playback uses the native plane.
- The plugin video object paints at the encoded pixel size and ignores all
  client scaling. Closed client-scale attempts (do not retry): CSS
  `object-fit`, CSS transforms, CSS width/height, `HTMLVideoElement`
  width/height properties, hidden-canvas `drawImage`, unclipped native
  zoned `playVideo`, and video-hole/chroma-key overlays (no
  `SetVideoHole`/`bUseVideoHole` API exists on this platform).
  `SetDisplayArea` clips the *rectangle*, not the layer, so a full-bleed
  PiP background still covers a foreground HTML widget.
- Working resolution for PiP-of-video: serve the same asset as an intrinsic
  1920×1080 `fill` rendition (equiv-eSAR 1:1) and let the HTML compositor
  place it — that's what the fit-rendition route exists for.

## Gapless playback

- Seamless transitions between distinct native videos are unsolved. A native
  LFD playlist built from media with identical h.264/AAC/resolution/fps
  characteristics produced an invalid solid-blue LFD surface, so the
  experimental gapless path is disabled; the player falls back to sequential
  playback (a visible decoder/black transition gap remains between distinct
  clips). Same-continuous-mode videos only.

## Offline

- Native local storage reliability is on; `FileSystem`-journaled persistence
  restores images, local MP4s and externally-independent clock/text widgets.
- Dynamic webpages/cloud widgets and remote resources are NOT offline
  -complete by design (nothing but the SSR snapshot ships to the panel).
- **Cold boot from a total outage is unresolved.** The firmware launcher
  gates the installed ZIP behind a reachable `sssp_config.xml`. One observed
  panel did boot after ~2 minutes without network, contradicting the short
  (100–164 s) probe windows that reported a hard fail. No air-gap or
  auto-recovery claim may be made until a controlled multi-minute outage
  test confirms it.

## Time and audio

- The panel has no trustworthy hardware timezone. Devices must set an IANA
  timezone for local-time schedules; the native clock engine ignores time
  formatting options, which is why the widget renderer ships a tz-table
  fallback.
- Native MP4 playback bypasses the generic HTML media pipeline: no mute,
  volume, HLS, YouTube, WebRTC or slide-audio guarantees on native playback.

## Package updates

- `<ver>` is compared numerically and panels only ever install a strictly
  higher version. Never lower `<ver>`; there is no automatic rollback if a
  new package cannot boot.
