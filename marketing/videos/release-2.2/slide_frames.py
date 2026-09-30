#!/usr/bin/env python3
# Frame-step the 12 scenes, which are REAL ScreenTinker slides rendered by ALPHA.
#
# Each scene is GET https://alpha.screentinker.com/api/widgets/vid21-sNN/render — alpha's own
# lib/slide-render.js output, with the screenshots and fonts served from alpha over HTTPS. The
# slide's per-element entrance animations (fade/slideL/slideU/zoom/wipe) are what "flies in"; we
# add only a gentle Ken Burns push on the .stage so no frame is ever frozen (the retention rule
# the whole pipeline exists to obey). Same currentTime-stepping technique as scenes.py.
#
#   python3 slide_frames.py stills        -> caps/preview-sNN.png   (contact sheet)
#   python3 slide_frames.py frames 1 12   -> scenes_anim/sNN/f%04d.jpg  (the render)
import os, sys, subprocess, json
from playwright.sync_api import sync_playwright

W, H, FPS = 1920, 1080, 30
# Render straight from the DECK's own published slide widgets (ordered), so the mp4 comes from the
# real alpha slide deck. deck_widgets.json = ordered list of widget ids (scene 1..N).
WIDGETS = json.load(open("deck_widgets.json"))
BASE = "https://alpha.screentinker.com/api/widgets/{wid}/render"
OUT = "scenes_anim"; os.makedirs(OUT, exist_ok=True); os.makedirs("caps", exist_ok=True)
TAIL = 0.6

# Injected on top of alpha's slide: a slow camera push (Ken Burns) spanning the whole scene, so a
# real slide — static after its entrances land — never shows a frozen frame. transform only; it
# does not fight FIT_SCRIPT (which centres via margins) or the cqw->px it already baked in.
KB = """
:root{--sdur:%.3fs}
.stage{animation:st_kb var(--sdur) linear both;transform-origin:50%% 50%%;will-change:transform}
@keyframes st_kb{from{transform:scale(1.006)}to{transform:scale(1.045)}}
"""

def vo_dur(sid):
    try:
        return float(subprocess.run(
            ["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",f"audio/vo-{sid}.wav"],
            capture_output=True, text=True).stdout.strip())
    except Exception:
        return 12.0

def render(mode, s0=1, s1=12):
    with sync_playwright() as p:
        br = p.chromium.launch(args=["--force-color-profile=srgb"])
        pg = br.new_page(viewport={"width":W,"height":H}, device_scale_factor=1)
        for i in range(s0, s1+1):
            sid = f"{i:02d}"
            url = BASE.format(wid=WIDGETS[i-1])
            sdur = round(vo_dur(sid) + TAIL, 3)
            pg.goto(url, wait_until="networkidle")
            # Let the real fonts + screenshots finish loading before we grade a frame.
            try:
                pg.wait_for_function("document.fonts && document.fonts.status==='loaded'", timeout=8000)
            except Exception:
                pass
            pg.wait_for_function(
                "Array.from(document.images).every(im=>im.complete && im.naturalWidth>0)",
                timeout=8000)
            # Add the Ken Burns camera (after load, so .stage exists).
            pg.add_style_tag(content=(KB % sdur))
            if mode == "stills":
                pg.wait_for_timeout(3200)   # after the last entrance has landed
                pg.screenshot(path=f"caps/preview-s{sid}.png")
                print(f"still s{sid} ({sdur:.1f}s)")
            else:
                d = os.path.join(OUT, f"s{sid}"); os.makedirs(d, exist_ok=True)
                pg.add_style_tag(content="*{animation-play-state:paused!important}")
                nfr = int(round(sdur*FPS))
                for f in range(nfr):
                    pg.evaluate("(t)=>{document.getAnimations().forEach(a=>{a.currentTime=t*1000;});}", f/FPS)
                    pg.screenshot(path=os.path.join(d, f"f{f:04d}.jpg"), type="jpeg", quality=92)
                print(f"frames s{sid} -> {nfr} ({sdur:.1f}s)")
        br.close()

if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv)>1 else "stills"
    a = int(sys.argv[2]) if len(sys.argv)>2 else 1
    b = int(sys.argv[3]) if len(sys.argv)>3 else 12
    render(mode, a, b)
