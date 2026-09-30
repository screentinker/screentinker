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
      "<h1 class='a' style='animation-delay:.5s'>Turn any <span class='hl'>Fire TV Stick</span><br>into managed digital signage</h1>"
      "<div class='sub a' style='animation-delay:.8s'>Free. Open source. No monthly fees.</div>"
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
 "01": (head() +
        "<div class='logo'>Screen<b>Tinker</b></div>"
        "<div class='pad' style='justify-content:center'>"
        "<h1 class='a' style='animation-delay:.15s'>Free signage. Self-hosted.<br><span class='hl'>$0 forever.</span></h1>"
        "<div class='sub a' style='animation-delay:.35s;margin-bottom:40px'>Your server, your data — running in one command.</div>"
        "<div class='term a' style='animation-delay:.55s;margin:0'>"
        "<div class='tbar'><span class='dot r'></span><span class='dot y'></span><span class='dot g'></span><span class='ttl'>your-server: ~/screentinker</span></div>"
        "<div class='tbody' style='min-height:auto;padding:26px 40px'>"
        "<div class='tl'><span class='pmt'>$</span> <span class='cmd'>docker compose up -d</span></div>"
        "<div class='tl'><span class='st'>[+] Pulling screentinker</span> <span class='ok'>done ✓</span></div>"
        "<div class='tl'><span class='ok'>✔ ScreenTinker listening on :3001</span></div>"
        "</div></div></div></div>"),
 "02": slate("01 · What you need", "What you <span class='hl'>need</span>", bullets=[
        "A small <b>Linux server</b> <span class='k'>— even a $5 VPS</span>",
        "<b>Docker</b> installed <span class='k'>— the only dependency</span>",
        "A <b>domain</b> <span class='k'>— optional, for clean HTTPS</span>",
        "<b>One container</b> <span class='k'>— dashboard + player + API</span>"]),
 "03": terminal("02 · Get the compose", "your-server: ~/screentinker", [
        "<span class='dim'># clone the repo (or just grab the compose file)</span>",
        "<span class='pmt'>$</span> <span class='cmd'>git clone https://github.com/screentinker/screentinker.git</span>",
        "<span class='pmt'>$</span> <span class='cmd'>cp docker-compose.example.yml docker-compose.yml</span>",
        "",
        "<span class='dim'>#  image:  </span><span class='hdr'>ghcr.io/screentinker/screentinker:latest</span>",
        "<span class='dim'>#  SELF_HOSTED=true   ·   volume  st-data:/data  (db + uploads)</span>"], caret=False),
 "04": terminal("03 · One command", "your-server: docker compose up", [
        "<span class='pmt'>$</span> <span class='cmd'>docker compose up -d</span>",
        "<span class='st'>[+] Pulling screentinker</span> <span class='ok'>… done ✓</span>",
        "<span class='st'>[+] Running database migrations</span> <span class='ok'>done ✓</span>",
        "<span class='ok'>✔ ScreenTinker listening on :3001</span>",
        "",
        "<span class='dim'># no build step, no dependencies to chase</span>"], caret=False),
 "05": slate("04 · First run", "Register the <span class='hl'>first admin</span>",
        sub="In self-hosted mode the first account unlocks everything — no billing, no trial, no caps.",
        extra="<div class='a' style='animation-delay:.7s;margin-top:44px;display:inline-flex;align-items:center;gap:18px;background:#0a1017;border:1px solid #24314a;border-radius:14px;padding:20px 32px;font:600 42px ui-monospace,monospace;color:#cfd8e3;width:fit-content'>"
              "<span style='width:16px;height:16px;border-radius:50%;background:#34d399'></span>http://<b style='color:#fff'>your-server</b>:<span class='hl'>3001</span></div>"),
 "06": terminal("05 · Clean HTTPS (optional)", "Caddyfile — automatic TLS", [
        "<span class='hdr'>signage.example.com</span> {",
        "    <span class='cmd'>reverse_proxy</span> localhost:3001",
        "}",
        "",
        "<span class='pmt'>$</span> <span class='cmd'>caddy run</span>",
        "<span class='ok'>✔ Let's Encrypt certificate issued</span>",
        "<span class='dim'># …or skip it and run plain on your LAN, air-gapped</span>"], caret=False),
 "07": cap_frame("06 · Pair a display", "caps/cap-displays.png", "your-server:3001  ·  Displays",
        "Install a player &gt; <b>pair</b> with a code &gt; it shows up <b>online</b>"),
 "08": slate("07 · The whole platform", "Nothing behind a <span class='hl'>paywall</span>", bullets=[
        "<b>Playlists &amp; scheduling</b> <span class='k'>— dayparting, multi-zone, video walls</span>",
        "<b>Widgets</b> <span class='k'>— clocks, weather, RSS, menus, directories</span>",
        "<b>Proof-of-play</b> <span class='k'>+ multi-workspace + a scoped REST API</span>"]),
 "09": slate("08 · It's yours", "Your data. Your <span class='hl'>disk</span>.", bullets=[
        "<b>Database + media</b> <span class='k'>— on your own server</span>",
        "<b>Backups</b> <span class='k'>— a single file copy</span>",
        "<b>No per-screen fees</b> <span class='k'>— ever. 1 screen or 1,000</span>"]),
 "10": (head() +
        "<div class='cta'>"
        "<div class='logo' style='position:static;font:800 40px sans-serif;color:#8aa'>Screen<b>Tinker</b></div>"
        "<div class='big a' style='animation-delay:.15s'>Free digital signage.<br><b>On hardware you control.</b></div>"
        "<div class='links a' style='animation-delay:.5s'>"
        "<span class='pill'><span class='u'>github.com/screentinker</span></span>"
        "<span class='pill'>Docs</span>"
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
