#!/usr/bin/env python3
# Scene renderer for "Free Digital Signage on Android TV & Fire TV".
# Same brand system + Playwright frame technique as the Pi video, but rebuilt for CONTINUOUS MOTION:
# every scene animates its elements IN, and the assembler adds a gentle Ken-Burns zoom across the whole
# clip so no frame is ever frozen. Intrinsic motion (terminal stream, pairing digits, TV content cycle,
# install progress) runs continuously on top.
#
# Usage:
#   python3 scenes.py stills        -> caps/preview-sNN.png  (settled look, fast; for review)
#   python3 scenes.py frames SS EE  -> scenes_anim/sNN/f%04d.png entrance frames (for the final render)
import os, sys, math
from playwright.sync_api import sync_playwright

W, H, FPS = 1920, 1080, 30
ENTER = 2.0                      # seconds of entrance animation rendered as frames
OUT = "scenes_anim"; os.makedirs(OUT, exist_ok=True); os.makedirs("caps", exist_ok=True)

# ---- Brand system (extracted from the Pi video) ----------------------------------------------------
CSS = """
*{margin:0;box-sizing:border-box}
body{width:1920px;height:1080px;overflow:hidden;background:#0e1420;color:#e6ecf3;
 font-family:-apple-system,'Segoe UI',system-ui,sans-serif;position:relative}
/* very slow ambient background drift so even a 'still' brand bg is never frozen */
body::before{content:"";position:absolute;inset:-6%;z-index:0;opacity:.55;
 background:radial-gradient(60% 55% at 22% 18%,#16324a55,transparent 60%),radial-gradient(55% 55% at 82% 82%,#0f3b3155,transparent 60%);
 animation:drift 26s ease-in-out infinite alternate}
@keyframes drift{from{transform:translate(0,0) scale(1)}to{transform:translate(-3%,-2%) scale(1.06)}}
/* Ken Burns: a gentle continuous push-in across the WHOLE scene for its full duration (--sdur),
   so no frame is ever frozen. Baked into the rendered frames — no ffmpeg zoompan needed. */
.wrap{position:absolute;inset:0;z-index:1;transform-origin:center;animation:kburns var(--sdur,16s) linear both}
@keyframes kburns{from{transform:scale(1.0)}to{transform:scale(1.05)}}
.eyebrow{position:absolute;top:70px;left:130px;font:700 24px ui-monospace,monospace;letter-spacing:.22em;
 text-transform:uppercase;color:#34d399;display:flex;align-items:center;gap:16px}
.eyebrow i{display:inline-block;width:46px;height:4px;background:#34d399;border-radius:3px;transform-origin:left;animation:barGrow .7s .05s cubic-bezier(.2,.8,.2,1) both}
.logo{position:absolute;top:66px;right:130px;font:800 30px sans-serif;color:#8aa} .logo b{color:#34d399}
.pad{position:absolute;inset:0;padding:120px 130px;display:flex;flex-direction:column;justify-content:center}
h1{font-size:82px;line-height:1.05;letter-spacing:-.03em;font-weight:820;max-width:1450px}
h1 .hl{color:#34d399}
.sub{font-size:34px;color:#9aa7b8;margin-top:26px;max-width:1250px;line-height:1.4}
ul{list-style:none;margin-top:50px;display:flex;flex-direction:column;gap:24px}
li{font-size:40px;color:#cfd8e3;padding-left:56px;position:relative;line-height:1.3}
li::before{content:"";position:absolute;left:0;top:16px;width:26px;height:26px;border-radius:7px;background:#34d39922;border:2px solid #34d399}
li b{color:#fff;font-weight:700} li .k{color:#34d399;font-weight:700}
/* terminal */
.term{background:#0a1017;border:1px solid #24314a;border-radius:16px;overflow:hidden;box-shadow:0 40px 90px -30px #000;width:100%;max-width:1560px;margin:0 auto}
.tbar{background:#141d2b;padding:18px 24px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #24314a}
.dot{width:16px;height:16px;border-radius:50%} .r{background:#f2565b}.y{background:#f5b23c}.g{background:#34d399}
.ttl{margin-left:16px;color:#7b8aa0;font:600 22px ui-monospace,monospace}
.tbody{padding:30px 40px;font:400 30px ui-monospace,monospace;line-height:1.5;min-height:520px}
.tl{white-space:pre-wrap}
.pmt{color:#34d399}.cmd{color:#e6ecf3}.st{color:#34d399}.dim{color:#6b7889}.ok{color:#8ee6b8}.hdr{color:#5aa0ff}
.caret{display:inline-block;width:14px;height:30px;background:#34d399;vertical-align:-4px;margin-left:4px;animation:blink 1s step-end infinite}
/* TV bezel with the player content inside */
.tvwrap{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
.tv{position:relative;width:1180px;height:664px;background:#05070b;border:18px solid #1a2230;border-radius:26px;
 box-shadow:0 60px 120px -30px #000,inset 0 0 0 2px #0c121b;overflow:hidden}
.tv .stand{position:absolute;bottom:-38px;left:50%;transform:translateX(-50%);width:220px;height:24px;background:#141d2b;border-radius:0 0 14px 14px}
.screen{position:absolute;inset:0;overflow:hidden}
.slide{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;opacity:0;animation:cyc 12s infinite}
.slide:nth-child(1){animation-delay:0s}.slide:nth-child(2){animation-delay:4s}.slide:nth-child(3){animation-delay:8s}
.badge{position:absolute;top:22px;left:26px;font:700 22px ui-monospace,monospace;color:#0e1420;background:#34d399;padding:6px 14px;border-radius:8px}
.hooktext{position:absolute;left:130px;bottom:110px;z-index:3;max-width:1100px}
.hooktext h1{font-size:76px} .hooktext .sub{font-size:34px}
/* pairing digits */
.pair{display:flex;gap:22px;margin-top:30px} .digit{width:120px;height:150px;background:#0a1017;border:2px solid #24314a;border-radius:16px;
 display:flex;align-items:center;justify-content:center;font:800 92px ui-monospace,monospace;color:#34d399}
/* permission toggles */
.perm{display:flex;align-items:center;gap:24px;font-size:38px;color:#cfd8e3;margin-top:30px}
.tog{width:96px;height:52px;border-radius:30px;background:#24314a;position:relative;transition:.4s} .tog b{position:absolute;top:5px;left:5px;width:42px;height:42px;border-radius:50%;background:#e6ecf3;transition:.4s}
.tog.on{background:#34d399} .tog.on b{left:49px}
/* browser-chrome frame for real captures */
.frame{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:150px 130px 120px}
.win{width:100%;height:100%;border-radius:16px;overflow:hidden;border:1px solid #24314a;box-shadow:0 50px 120px -40px #000;background:#0a1017;display:flex;flex-direction:column}
.wbar{background:#141d2b;padding:14px 20px;display:flex;align-items:center;gap:10px;flex:0 0 auto}
.wurl{margin-left:14px;color:#7b8aa0;font:600 20px ui-monospace,monospace;background:#0a1017;padding:8px 18px;border-radius:8px;flex:1}
.wimg{flex:1;background-size:cover;background-position:top center}
.cap{position:absolute;left:130px;bottom:64px;font:600 34px system-ui;color:#cfd8e3}.cap b{color:#34d399}
/* CTA */
.cta{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:30px;text-align:center}
.cta .big{font:820 96px system-ui;letter-spacing:-.03em}.cta .big b{color:#34d399}
.links{font:600 40px ui-monospace,monospace;color:#cfd8e3;line-height:1.9} .links .u{color:#5aa0ff}
.pill{display:inline-block;margin:0 10px;padding:8px 22px;border:1px solid #24314a;border-radius:12px;background:#0a1017}
/* entrance anims */
@keyframes riseIn{from{opacity:0;transform:translateY(38px)}to{opacity:1;transform:translateY(0)}}
@keyframes barGrow{from{transform:scaleX(0);opacity:0}to{transform:scaleX(1);opacity:1}}
@keyframes termIn{from{opacity:0;transform:translateY(28px) scale(.985)}to{opacity:1;transform:translateY(0) scale(1)}}
@keyframes popIn{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:scale(1)}}
@keyframes blink{50%{opacity:0}}
@keyframes cyc{0%,28%{opacity:1}33%,100%{opacity:0}}
.a{animation:riseIn .62s both cubic-bezier(.2,.8,.2,1)}
.term.a{animation:termIn .7s .1s both cubic-bezier(.2,.8,.2,1)}
"""

def head(extra=""):
    return f"<!doctype html><meta charset=utf-8><style>{CSS}{extra}</style><body><div class='wrap'>"
def brandchrome(eyebrow):
    return (f"<div class='eyebrow'><i></i><span class='a' style='animation-delay:.12s'>{eyebrow}</span></div>"
            f"<div class='logo'>Screen<b>Tinker</b></div>")

def slate(eyebrow, title, sub="", bullets=None, extra=""):
    b = head() + brandchrome(eyebrow) + "<div class='pad'>"
    b += f"<h1 class='a' style='animation-delay:.16s'>{title}</h1>"
    if sub: b += f"<div class='sub a' style='animation-delay:.32s'>{sub}</div>"
    if bullets:
        b += "<ul>" + "".join(f"<li class='a' style='animation-delay:{.44+i*.15:.2f}s'>{x}</li>" for i,x in enumerate(bullets)) + "</ul>"
    return b + extra + "</div></div>"

def terminal(eyebrow, title, lines, caret=True):
    tl = "".join(f"<div class='tl a' style='animation-delay:{.4+i*.16:.2f}s'>{ln or '&nbsp;'}</div>" for i,ln in enumerate(lines))
    if caret: tl += "<div class='tl a' style='animation-delay:{:.2f}s'><span class='pmt'>$</span> <span class='caret'></span></div>".format(.4+len(lines)*.16)
    return (head() + brandchrome(eyebrow) +
            "<div class='pad'><div class='term a'><div class='tbar'><span class='dot r'></span><span class='dot y'></span><span class='dot g'></span>"
            f"<span class='ttl'>{title}</span></div><div class='tbody'>{tl}</div></div></div></div>")

def tv_slides(slides, badge="LIVE"):
    inner = "".join(f"<div class='slide'>{s}</div>" for s in slides)
    return (f"<div class='screen'><span class='badge'>{badge}</span>{inner}</div>")

def scene_hook():
    slides = [
      "<div style='background:linear-gradient(135deg,#0b2a24,#0e1420);position:absolute;inset:0'></div><div style='z-index:1;text-align:center'><div style='font:800 74px system-ui;color:#34d399'>TODAY'S SPECIAL</div><div style='font:600 40px system-ui;color:#e6ecf3;margin-top:14px'>House Burger &nbsp;·&nbsp; $12</div></div>",
      "<div style='background:linear-gradient(135deg,#10233f,#0e1420);position:absolute;inset:0'></div><div style='z-index:1;text-align:center'><div style='font:800 68px system-ui;color:#5aa0ff'>WELCOME</div><div style='font:600 38px system-ui;color:#cfd8e3;margin-top:14px'>Reception · Building A</div></div>",
      "<div style='background:linear-gradient(135deg,#2a1330,#0e1420);position:absolute;inset:0'></div><div style='z-index:1;text-align:center'><div style='font:800 66px system-ui;color:#f5b23c'>NOW HIRING</div><div style='font:600 36px system-ui;color:#cfd8e3;margin-top:14px'>Scan to apply</div></div>",
    ]
    return (head("body{background:#080b11}") +
      "<div class='tvwrap'><div class='tv' style='animation:popIn .8s both cubic-bezier(.2,.8,.2,1)'>" +
      tv_slides(slides) + "<div class='stand'></div></div></div>" +
      "<div class='hooktext'>"
      "<h1 class='a' style='animation-delay:.5s'>No box. No app.<br><span class='hl'>Just a URL.</span></h1>"
      "<div class='sub a' style='animation-delay:.8s'>Free digital signage on a Samsung TV.</div>"
      "</div></div>")

def cap_frame(eyebrow, img, url, caption):
    fileurl = "file://" + os.path.abspath(img)   # Playwright set_content needs absolute image URLs
    return (head() + brandchrome(eyebrow) +
      f"<div class='frame'><div class='win a' style='animation-delay:.12s'><div class='wbar'>"
      "<span class='dot r'></span><span class='dot y'></span><span class='dot g'></span>"
      f"<span class='wurl'>{url}</span></div><div class='wimg' style=\"background-image:url('{fileurl}')\"></div></div></div>"
      f"<div class='cap a' style='animation-delay:.5s'>{caption}</div></div>")

# ---- Scene definitions -----------------------------------------------------------------------------
SCENES = {
 "01": scene_hook(),
 "02": slate("01 · What you need", "What you <span class='hl'>need</span>", bullets=[
        "A <b>Samsung signage display</b> <span class='k'>— SSSP / URL Launcher</span>",
        "…or a <b>Samsung TV</b> <span class='k'>with a URL Launcher or web browser</span>",
        "A <b>ScreenTinker</b> server <span class='k'>— free hosted or self-host</span>",
        "<b>No streaming stick.</b> <span class='k'>Nothing to plug in.</span>"]),
 "03": (head() + brandchrome("02 · It's just a web page") +
        "<div class='pad'><h1 class='a' style='animation-delay:.16s'>The player is one <span class='hl'>web page</span></h1>"
        "<div class='sub a' style='animation-delay:.32s'>Served by your ScreenTinker server — nothing to install.</div>"
        "<div class='a' style='animation-delay:.6s;margin-top:56px;display:inline-flex;align-items:center;gap:20px;background:#0a1017;border:1px solid #24314a;border-radius:16px;padding:24px 36px;font:600 48px ui-monospace,monospace;color:#cfd8e3;width:fit-content'>"
        "<span style='width:18px;height:18px;border-radius:50%;background:#34d399'></span>https://<b style='color:#fff'>your-server</b>/<span class='hl'>player</span></div>"
        "</div></div>"),
 "04": (head() + brandchrome("03 · Point the TV at it") +
        "<div class='pad'><h1 class='a' style='animation-delay:.16s'>Open the <span class='hl'>URL Launcher</span></h1>"
        "<div class='sub a' style='animation-delay:.3s'>…or the TV's built-in web browser. Set it as the boot source.</div>"
        "<div class='a' style='animation-delay:.55s;margin-top:44px;background:#0a1017;border:1px solid #24314a;border-radius:18px;overflow:hidden;max-width:1440px;box-shadow:0 40px 90px -30px #000'>"
        "<div class='tbar'><span style='color:#e6ecf3;font:700 26px system-ui;margin-left:4px'>Samsung · URL Launcher Settings</span></div>"
        "<div style='padding:40px 46px'>"
        "<div style='font:600 26px system-ui;color:#7b8aa0;margin-bottom:14px'>Source URL</div>"
        "<div style='background:#0e1420;border:1px solid #24314a;border-radius:12px;padding:24px 30px;font:600 42px ui-monospace,monospace;color:#e6ecf3'>https://<span class='hl'>your-server</span>/player</div>"
        "<div style='margin-top:34px;display:flex;align-items:center;gap:22px'><div class='tog on'><b></b></div><span style='font:600 34px system-ui;color:#cfd8e3'>Launch on boot</span>"
        "<span style='margin-left:auto;background:#34d399;color:#08110b;font:800 30px system-ui;padding:14px 34px;border-radius:12px'>Save</span></div>"
        "</div></div></div></div>"),
 "05": (head("body{background:#080b11}") +
        "<div class='tvwrap'><div class='tv' style='animation:popIn .8s both cubic-bezier(.2,.8,.2,1)'>"
        "<div class='screen' style='display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0e1420'>"
        "<div style='font:800 34px sans-serif;color:#8aa' class='a'>Screen<b style='color:#34d399'>Tinker</b></div>"
        "<div style='font:600 30px system-ui;color:#9aa7b8;margin-top:22px' class='a' style='animation-delay:.4s'>Player ready</div>"
        "<div style='margin-top:28px;width:300px;height:8px;border-radius:4px;background:#1a2230;overflow:hidden'><div style='height:100%;width:70%;background:#34d399;transform-origin:left;animation:barGrow 1.3s .3s both'></div></div>"
        "</div><div class='stand'></div></div></div>"
        "<div class='cap a' style='animation-delay:1s'>Loads <b>full-screen</b> on boot — no menus, no desktop</div></div>"),
 "06": (head("body{background:#080b11}") +
        "<div class='tvwrap'><div class='tv' style='animation:popIn .8s both cubic-bezier(.2,.8,.2,1)'>"
        "<div class='screen' style='display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0e1420'>"
        "<div style='font:700 26px ui-monospace,monospace;color:#34d399;letter-spacing:.2em' class='a'>SCREENTINKER PLAYER</div>"
        "<div style='font:600 34px system-ui;color:#9aa7b8;margin:22px 0 6px' class='a' style='animation-delay:.3s'>Pair this screen</div>"
        "<div class='pair'>" + "".join(f"<div class='digit' style='animation:popIn .5s {(.5+i*.12):.2f}s both cubic-bezier(.2,.8,.2,1)'>{d}</div>" for i,d in enumerate("4 8 3 1 9 2".split())) + "</div>"
        "</div><div class='stand'></div></div></div>"
        "<div class='cap a' style='animation-delay:1.4s'>A freshly-deployed sign — just the <b>pairing code</b></div></div>"),
 "07": cap_frame("05 · Add the display", "caps/cap-add-display.png", "screentinker.com/app  ·  Add Display",
        "Dashboard &gt; <b>Add Display</b> &gt; enter the code &gt; <b>online</b>"),
 "08": (head("body{background:#080b11}") + brandchrome("06 · Push content") +
        "<div class='tvwrap'><div class='tv' style='animation:popIn .8s both cubic-bezier(.2,.8,.2,1)'>" +
        tv_slides([
          "<div style='background:linear-gradient(135deg,#0b2a24,#0e1420);position:absolute;inset:0'></div><div style='z-index:1;text-align:center'><div style='font:800 66px system-ui;color:#34d399'>THE DAILY GRIND</div><div style='font:600 34px system-ui;color:#cfd8e3;margin-top:16px'>Flat White · $4&nbsp;&nbsp;·&nbsp;&nbsp;Cold Brew · $5</div></div>",
          "<div style='background:linear-gradient(135deg,#10233f,#0e1420);position:absolute;inset:0'></div><div style='z-index:1;text-align:center'><div style='font:800 62px system-ui;color:#5aa0ff'>TODAY'S EVENTS</div><div style='font:600 32px system-ui;color:#cfd8e3;margin-top:16px'>Standup 9:00 · Demo 2:00 · Social 5:00</div></div>",
          "<div style='background:linear-gradient(135deg,#0e2a1a,#0e1420);position:absolute;inset:0'></div><div style='z-index:1;text-align:center'><div style='font:800 60px system-ui;color:#8ee6b8'>WAREHOUSE OPS</div><div style='font:700 84px ui-monospace,monospace;color:#34d399;margin-top:10px'>247 <span style='color:#7b8aa0;font-size:40px'>units/hr</span></div></div>",
        ], badge="✓ PUBLISHED") +
        "<div class='stand'></div></div></div>"
        "<div class='cap a' style='animation-delay:1.2s'>Upload &gt; playlist &gt; <b>Publish</b> — the TV updates <b>live</b></div></div>"),
 "09": slate("07 · Same everywhere", "The same rich <span class='hl'>layouts</span>", bullets=[
        "<b>Multi-zone screens</b> <span class='k'>— split into regions</span>",
        "<b>Widgets</b> <span class='k'>— clocks, weather, menus</span>",
        "<b>Offline cache</b> <span class='k'>— keeps playing if the network drops</span>"]),
 "10": (head() +
        "<div class='cta'>"
        "<div class='logo' style='position:static;font:800 40px sans-serif;color:#8aa'>Screen<b>Tinker</b></div>"
        "<div class='big a' style='animation-delay:.15s'>Free digital signage.<br><b>On the TV you already own.</b></div>"
        "<div class='links a' style='animation-delay:.5s'>"
        "<span class='pill'><span class='u'>screentinker.com</span></span>"
        "<span class='pill'>GitHub · <span class='u'>MIT</span></span>"
        "<span class='pill'>Discord</span></div>"
        "<div class='sub a' style='animation-delay:.8s;color:#7b8aa0;text-align:center'>Open source · Self-hostable · No per-screen fees</div>"
        "</div></div>"),
}

import subprocess
TAIL = 0.6   # video hangs on each scene 0.6s past the VO (matches the Pi video)
def vo_dur(sid):
    try:
        return float(subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",f"audio/vo-{sid}.wav"],
                     capture_output=True,text=True).stdout.strip())
    except Exception:
        return 12.0

def render(mode, s0=1, s1=10):
    with sync_playwright() as p:
        br = p.chromium.launch(args=["--force-color-profile=srgb"])
        pg = br.new_page(viewport={"width":W,"height":H}, device_scale_factor=1)
        for i in range(s0, s1+1):
            sid = f"{i:02d}"
            sdur = round(vo_dur(sid) + TAIL, 3)               # full scene duration
            # Inject the per-scene Ken Burns duration so the whole-scene push-in spans exactly this scene.
            html = SCENES[sid].replace("<body>", f"<body style='--sdur:{sdur}s'>", 1)
            open("_render.html","w").write(html)
            pg.goto("file://" + os.path.abspath("_render.html"), wait_until="load")
            if mode == "stills":
                pg.wait_for_timeout(2200)   # let entrances settle
                pg.screenshot(path=f"caps/preview-s{sid}.png")
                print(f"still s{sid} -> caps/preview-s{sid}.png")
            else:
                d = os.path.join(OUT, f"s{sid}"); os.makedirs(d, exist_ok=True)
                # Deterministic: pause all CSS anims, step currentTime per frame, screenshot the FULL duration
                # (entrances + drift + TV cycling + Ken Burns all render continuously — nothing ever freezes).
                pg.add_style_tag(content="*{animation-play-state:paused!important}")
                nfr = int(round(sdur*FPS))
                for f in range(nfr):
                    t = f/FPS
                    pg.evaluate("(t)=>{document.getAnimations().forEach(a=>{a.currentTime=t*1000;});}", t)
                    pg.screenshot(path=os.path.join(d, f"f{f:04d}.jpg"), type="jpeg", quality=92)
                print(f"frames s{sid} -> {nfr} ({sdur:.1f}s)")
        br.close()

if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv)>1 else "stills"
    a = int(sys.argv[2]) if len(sys.argv)>2 else 1
    b = int(sys.argv[3]) if len(sys.argv)>3 else 10
    render(mode, a, b)
