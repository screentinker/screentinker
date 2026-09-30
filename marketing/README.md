# Marketing

Sources for ScreenTinker's marketing material: the YouTube videos, their thumbnails and upload
text. Only sources are tracked. Everything a pipeline generates (captures, frames, voice-over,
MP4s, the throwaway capture server's data) is ignored by `marketing/.gitignore`.

## Videos

| Folder | Video |
|---|---|
| `videos/release-2.3/` | **ScreenTinker 2.3 — Live Data, Templates & a Real Game** (16 scenes, 4:13) — the base for the next release video |
| `videos/release-2.2/` | ScreenTinker 2.2 — Point an AI at Your Screens (MCP-led, 3:02) |
| `videos/release-2.1/` | ScreenTinker 2.1 — Plugins, Live Video & Room Signs (3:04) |
| `videos/release-2.0/` | ScreenTinker 2.0 (17 scenes, 5:10) |
| `videos/tutorial-raspberry-pi/` | Raspberry Pi setup tutorial |
| `videos/tutorial-android-tv/` | Android TV / Fire TV tutorial (hook-first rebuild) |
| `videos/tutorial-samsung-tizen/` | Samsung Tizen tutorial |
| `videos/tutorial-self-host/` | Self-hosting tutorial |
| `videos/comparison-alternative/` | "An alternative to …" comparison video |

Each folder has its own README and a `youtube-upload.txt` (title, description, chapters, tags).

**Only `release-2.3` runs from inside this repository.** Its scripts find their own folder and use
this checkout's `server/`. The older folders are kept as a record: they still carry absolute paths
from the machine they were made on, and each was captured against the server version of its day.

## Making the next release video

Copy the newest release folder and edit it — do not design a new pipeline.

```bash
cp -r marketing/videos/release-2.3 marketing/videos/release-2.4
cd marketing/videos/release-2.4
# edit render_vo.py (narration), scenes.py (SCENES), capture23.py / seed23.py (what to show)
./rebuild.sh                           # throwaway server on :3014, DATA_DIR=./instance, seeded
python3 capture23.py                   # caps/  — the real UI, from that server
python3 render_vo.py                   # audio/ — edge-tts, en-US-AndrewNeural
python3 scenes.py stills 1 16          # caps/preview-sNN.png — REVIEW A CONTACT SHEET FIRST
python3 scenes.py frames 1 16          # scenes_anim/ — the slow part
python3 assemble.py final              # the MP4, music ducked under the voice
python3 chapters.py                    # chapters, computed from the voice-over (never typed)
python3 make_thumb.py                  # thumbnail.png
```

Tools: Node 20, Python with `playwright` and `edge-tts`, ffmpeg, ImageMagick. The music bed
(`Quiet Tech Pulse.mp3`) is not in the repository — put it in the folder before `assemble.py final`.

## Rules (each one learned the hard way)

- **Capture a real server with invented data.** Every screen is the product itself on a throwaway
  instance; every name, email and number is made up. **No third-party media, ever.**
- **The call to action leads with the hosted trial** ("Start your 14-day free trial"), with
  self-hosting offered second. Check the trial length against `TRIAL_DAYS` in
  `server/middleware/subscription.js`.
- **Continuous motion; hook first, no logo intro.**
- **Bulk database writes only with the capture server stopped** (WAL + checkpointer corrupted a seed).
- **TTS:** write "two point three", not "2.3"; spell out acronyms ("A P I"); numbers go on screen, not in the voice.
- **Chapters are computed** from the voice-over, and every chapter must be at least 10 s (YouTube's rule).
- **A before/after must be before/after everywhere in the frame** — a table shot taken after an edit next
  to a "before" render is a contradiction.
- **Never commit credentials.** The capture server's tokens (`.token`, `.apitoken*`) are ignored; a
  token for a real account must never be written into these folders at all.
