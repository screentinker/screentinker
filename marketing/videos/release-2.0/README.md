# ScreenTinker 2.0 — release video

17 scenes, ~5:10, 1080p30. Same pipeline as the Pi / Android TV / Samsung / self-host /
alternative videos, with one addition: **this one captures a real 2.0 server**, so there is a
live instance to stand up before anything can be rendered.

## Build order

```bash
./rebuild.sh                      # 1. throwaway 2.0 instance on :3011, seeded (see below)
~/tts-venv/bin/python capture.py  # 2. caps/cap-*.png   — real UI, 3200x1800
~/tts-venv/bin/python render_vo.py    # 3. audio/vo-NN.wav — edge-tts, en-US-AndrewNeural
~/tts-venv/bin/python scenes.py stills   # 4. review: montage caps/preview-s*.png FIRST
~/tts-venv/bin/python scenes.py frames 1 17   # 5. ~9,600 frames, several minutes
python3 assemble.py               # 6. draft-nomusic.mp4
python3 assemble.py final         # 7. screentinker-2p0.mp4  (music ducked under VO)
~/tts-venv/bin/python make_thumb.py   # 8. thumbnail.png
```

Always eyeball a contact sheet of the stills before step 5 — it is minutes of render either way,
and every layout bug found so far was visible in the stills.

## The capture instance

`rebuild.sh` builds it from nothing on `:3011` with `DATA_DIR=./instance`, `SELF_HOSTED=true`,
mesh and trigger ingress on, and mail credentials blanked so it cannot email anyone. It seeds a
fictional hospital: a 5-slide deck, 3 published playlists, 5 screens, 2 triggers, ~57k plays over
30 days, and a preview image per screen.

**The order in that script is load-bearing.** Two failures are baked into it as comments:

- **Bulk writes happen with the server STOPPED.** Inserting play rows into the SQLite file while
  the server held it in WAL mode — with its off-thread checkpointer running `TRUNCATE` — corrupted
  the database (`disk image is malformed`) and lost everything.
- **Device credentials are cached in `fleet.json` and reused.** Registering with a fresh
  `pairing_code` mints a *new* device row every time; a stale fleet process left the instance with
  15 devices instead of 5.

`register_devices.js` must be running during `capture.py` or the screens read offline.
Kill it and the server when done — `rebuild.sh` only ever kills the node process whose `DATA_DIR`
is this folder, because other sessions run their own servers on `:3012` and `:3013`.

## Rules inherited from the earlier videos

- **Continuous motion.** No frame is ever frozen: every scene renders its full duration with a CSS
  Ken Burns push-in (`--sdur`). The Pi video lost ~65% of viewers in 15s to static frames.
- **Hook-first**, no logo intro.
- **TTS traps.** Never speak "self-hostable" or "several Pis"; write "two point oh", not "2.0";
  spell out OIDC and SBOM. Written copy keeps the keywords — narration does not.
- **No third-party media, ever.** An early Android TV capture picked up a Rick Astley thumbnail
  from a real content library. Everything here is invented or generated.
- **Chapters are computed**, never typed — `work/chapters.txt`. Re-render a VO line and they move.

## Gotcha found in this build

`popIn` animates `transform`, so any element that positions itself with `transform: translate(...)`
gets thrown to the centre when the entrance runs. Position with `left`/`top`/`margin` instead, or
bake the translate into the keyframe (`popInC`). This silently flattened the layered-slide stack
and knocked the ✕ off the wire in the trigger scene.

## What is a diagram, not a capture

Scenes 03, 04 (template vs fields is a concept), 11 (mesh needs a second enrolled instance) and
12 (a BrightSign is hardware). Everything else is the real product.
