# TV-safe video copies (3.0)

## The problem

Samsung Tizen signage TVs decode video on a hardware decoder sized for 1920x1080. A portrait-shaped
("tall") clip encoded as 1080x1920 is taller than that decoder will open:

- on a TV mounted **landscape**, the HTML5 `<video>` stays black;
- on a TV mounted **portrait**, AVPlay (which the player uses to turn the hardware video plane)
  fails to prepare the stream, and the player showed "Portrait video isn't supported on this TV".

Wide videos are not affected: on a portrait screen they keep playing through AVPlay with hardware
rotation, as before. Portrait **images** are not affected either: they are cropped on a landscape
screen only because the default fit is *Crop* (cover). Set the playlist item's fit to **Fit** to
show the whole picture with bars.

## What ScreenTinker does

The server makes a copy of a tall video that the TV can decode, and the TV plays the copy that
matches how it is mounted:

| Screen orientation | Copy | What it is |
|---|---|---|
| Portrait | `rot_cw` | the video turned 90° clockwise into a landscape frame (at most 1920x1080). The TV plays it full-screen with **no** rotation: the file already is the picture the panel shows. |
| Portrait (flipped) | `rot_ccw` | the same, turned 90° counter-clockwise. |
| Landscape / on a video wall | `fit` | the video, upright, scaled to fit inside 1920x1080. The playlist item's fit setting (Fit / Fill / Crop) still applies. |

Copies are H.264 (yuv420p) + AAC, `+faststart`, with no rotation metadata.

While a copy is being made, a Tizen TV says so on screen ("preparing a TV-friendly copy — it will play
automatically once ready") and switches to the copy by itself when it is ready. If the server cannot
make one (no ffmpeg, switched off, failed, monthly allowance used up) the TV says that instead.

## "Already rotated for portrait screens"

If you prefer to rotate the video yourself (for example, export it from your editor as a landscape
1920x1080 file with the picture turned sideways), open the video in the **Content library**, edit its
details and tick **Already rotated for portrait screens**. The same switch is on the video's row in
the playlist editor ("Pre-rotated"); it is the file's own setting, so it applies in every playlist.

Portrait screens then play that file exactly as it is, without rotating it again:

- **Samsung Tizen**: plays the file full-screen, unrotated (no AVPlay rotation).
- **Web player** (browser, Raspberry Pi / Windows / macOS kiosks that run it): the video is turned
  back inside the rotated page, so the net turn is zero.
- **Android**: the video view is turned back inside the rotated stage.
- **BrightSign** rotates its whole output in hardware rather than in the page, so the switch has no
  effect there yet. Other native players (Roku, webOS, tvOS, Vega) do not read the switch yet.

Landscape screens play such a file normally. A file marked this way never gets a server copy.

## CPU: copies are only made when they are needed

Re-encoding video is the expensive part, so the server is careful about it:

- **Only when a screen needs it.** A copy is only made for a tall uploaded video, in a workspace that
  has at least one screen whose player declares the `playback.video_variants` capability (the Tizen
  player today), and only the kind that screen's orientation needs (`rot_cw` only if there is a
  portrait screen, `fit` only if there is a landscape one). Copies are queued at upload when such a
  screen already exists, or later, when such a screen is sent a video whose copy is missing.
- **One at a time, at low priority.** By default one encode runs at a time, under `nice -n 19`, with
  `-threads 2` and the x264 `veryfast` preset.
- **Paused while the server is busy.** A job waits while the host CPU was above the threshold (70%
  by default) over the last minute, and starts once it calms down.
- **Optional time window**, e.g. `22-6` to only encode overnight (server local time).
- **Monthly allowance per organization** (hosted): minutes of source video encoded per month. When it
  is used up the copy is refused politely (the TV and the content details say so) and is tried again
  next month, or when someone presses *Try again*.
- **Hardware encoding** is used when the server has a working `h264_nvenc`, `h264_qsv` or
  `h264_vaapi` encoder (checked with a one-frame test encode at first use); otherwise libx264.

## Where to see it

- **Content library → edit a tall video**: "TV-friendly copy: Preparing… / Ready / Couldn't be made",
  with *Try again* after a failure.
- **Platform → Overview**: a "TV copies" card next to the CPU card shows the queue length, the job
  running now, why the queue is waiting (server busy, outside the time window, ffmpeg missing) and
  the encoder in use.
- **Platform → System → TV-friendly video copies**: on/off, time window, copies at the same time,
  CPU threshold and the monthly allowance.

## Settings and environment variables

Each Platform setting has an environment default; a value saved in Platform → System wins.

| Variable | Default | Meaning |
|---|---|---|
| `VIDEO_VARIANTS_ENABLED` | `true` | Make copies at all. |
| `VIDEO_VARIANTS_WINDOW` | empty (any time) | Hours to encode in, e.g. `22-6`. |
| `VIDEO_VARIANTS_CONCURRENCY` | `1` | Encodes at the same time (1–4). |
| `VIDEO_VARIANTS_MAX_CPU` | `70` | Pause while host CPU over the last minute is above this %. |
| `VIDEO_VARIANTS_ORG_MONTHLY_MINUTES` | `600` hosted, `0` self-hosted | Per-organization monthly allowance in minutes of encoded source duration: video duration plus 1 second per generated image-as-video variant (0 = no limit). |
| `VIDEO_VARIANTS_HWACCEL` | `auto` | `off` for libx264 only, or `nvenc` / `qsv` / `vaapi` to try just that one. |

Self-hosting: the copies need `ffmpeg` and `ffprobe` on the server's `PATH` (the Docker images
already include them). Without them, tall videos keep the old behaviour and the TV says that ffmpeg
is missing.

## Storage, export and deletion

Copies are stored next to the original (`stv_<content>_<kind>_<random>.mp4` in the content folder),
served by `GET /api/content/:id/variant/:kind` with the same access rule as the original file.
Like thumbnails, they do not count towards the storage allowance. They are a cache: they are not part
of an organization export (the new server makes its own when its screens need them), and they are
removed when the video is deleted or replaced (a replaced file gets new copies). A periodic sweep
removes any copy whose video is gone.

## For developers

- Server: `server/lib/video-variants.js` (queue, gates, ffmpeg), `content_video_variants` and
  `video_variant_usage` tables, payload fields stamped in `server/ws/deviceSocket.js`.
- Payload, per video item: `width` / `height` (display size), `video_prerotated: 1` when marked,
  `video_variants: { kind: rev }` for ready copies, and for a screen that uses copies but whose copy
  is missing, `video_variant_state` (`preparing` | `unavailable`) and `video_variant_reason`
  (`no_ffmpeg` | `disabled` | `failed` | `allowance`).
- Tizen: `tizen/js/video-plan.js` decides the file and the path; `player.js renderVideoFlat` plays a
  turned copy in the unrotated `#flatVideo` layer.
- A player opts in by declaring `playback.video_variants` and building
  `/api/content/:id/variant/:kind?rev=…` from `video_variants`.
