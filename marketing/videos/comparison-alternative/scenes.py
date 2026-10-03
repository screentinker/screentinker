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
/* competitor "meter" cards (hook) */
.cards{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:46px}
.card{width:400px;background:#0a1017;border:1px solid #24314a;border-radius:20px;padding:40px 38px;box-shadow:0 40px 90px -30px #000}
.card .cn{font:800 46px system-ui;color:#e6ecf3}
.card .cd{font:600 24px system-ui;color:#7b8aa0;margin-top:6px}
.card .cp{margin-top:30px;font:800 60px ui-monospace,monospace;color:#f5b23c}
.card .cp small{font:600 24px ui-monospace,monospace;color:#7b8aa0}
.card .meter{margin-top:22px;height:12px;border-radius:8px;background:#141d2b;overflow:hidden}
.card .meter i{display:block;height:100%;background:linear-gradient(90deg,#f5b23c,#f2565b);transform-origin:left;animation:fill 2.4s .3s cubic-bezier(.3,.7,.2,1) both}
@keyframes fill{from{transform:scaleX(.05)}to{transform:scaleX(1)}}
.tagbad{position:absolute;left:50%;bottom:96px;transform:translateX(-50%);font:700 30px ui-monospace,monospace;color:#f2565b;letter-spacing:.04em;white-space:nowrap}
/* feature-parity table */
.tbl{width:100%;max-width:1500px;margin:30px auto 0;border-collapse:collapse;font-size:33px}
.tbl th,.tbl td{padding:18px 26px;text-align:left;border-bottom:1px solid #1b2536}
.tbl thead th{font:800 30px system-ui;color:#9aa7b8;text-transform:uppercase;letter-spacing:.08em;font-size:22px}
.tbl thead th.st{color:#34d399}
.tbl td.feat{color:#cfd8e3;font-weight:600}
.tbl td.c{text-align:center;width:230px;font-weight:800}
.tbl .yes{color:#34d399}.tbl .no{color:#5b6675}.tbl .mut{color:#7b8aa0;font-weight:600;font-size:27px}
.tbl tbody tr{animation:riseIn .5s both}
.foot{position:absolute;left:130px;bottom:56px;font:600 26px system-ui;color:#6b7889}
.foot b{color:#9aa7b8}
/* pricing bars */
.bars{position:absolute;inset:0;padding:150px 150px 120px;display:flex;flex-direction:column;justify-content:center;gap:28px}
.brow{display:flex;align-items:center;gap:26px}
.blab{width:290px;text-align:right;font:700 36px system-ui;color:#cfd8e3;flex:0 0 auto}
.blab small{display:block;font:600 22px system-ui;color:#7b8aa0}
.btrack{flex:1;height:64px;background:#0a1017;border:1px solid #1b2536;border-radius:12px;position:relative;overflow:hidden}
.bfill{position:absolute;inset:0 auto 0 0;border-radius:11px;transform-origin:left;animation:grow 1.8s .2s cubic-bezier(.3,.7,.2,1) both}
@keyframes grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
.bfill.paid{background:linear-gradient(90deg,#f5b23c,#f2565b)}
.bfill.st{background:linear-gradient(90deg,#34d399,#2bb98a)}
.bval{width:200px;flex:0 0 auto;font:800 36px ui-monospace,monospace}
.bval.paid{color:#f5b23c}.bval.st{color:#34d399}
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

def versus_cards():
    def card(n, name, desc, price, unit, delay):
        return (f"<div class='card a' style='animation-delay:{delay}s'>"
                f"<div class='cn'>{name}</div><div class='cd'>{desc}</div>"
                f"<div class='cp'>{price}<small>{unit}</small></div>"
                f"<div class='meter'><i style='animation-delay:{delay+.2}s'></i></div></div>")
    return (head("body{background:#080b11}") +
      "<div class='logo'>Screen<b>Tinker</b></div>"
      "<div class='cards'>"
      + card(1,"Yodeck","Cloud signage","~$8","/screen/mo",.35)
      + card(2,"ScreenCloud","Enterprise cloud","$$$","/screen/mo",.5)
      + card(3,"OptiSigns","Cloud signage","~$11","/screen/mo",.65)
      + "</div>"
      "<div class='tagbad a' style='animation-delay:1.0s'>Great tools — but you pay per screen, every month.</div>"
      "</div>")

def cmp_table(eyebrow, title, rows, foot):
    head_row = "<thead><tr><th>Feature</th><th class='st'>ScreenTinker</th><th>Yodeck</th><th>ScreenCloud</th><th>OptiSigns</th></tr></thead>"
    def cell(v):
        if v == 1:   return "<td class='c yes'>✓</td>"
        if v == 0:   return "<td class='c no'>—</td>"
        return f"<td class='c mut'>{v}</td>"
    body = "<tbody>" + "".join(
        f"<tr style='animation-delay:{.5+i*.14:.2f}s'><td class='feat'>{r[0]}</td>"
        + cell(r[1])+cell(r[2])+cell(r[3])+cell(r[4]) + "</tr>" for i,r in enumerate(rows)) + "</tbody>"
    return (head() + brandchrome(eyebrow) + "<div class='pad' style='padding-top:150px'>"
            f"<h1 class='a' style='animation-delay:.16s;font-size:64px'>{title}</h1>"
            f"<table class='tbl'>{head_row}{body}</table></div>"
            f"<div class='foot a' style='animation-delay:1.4s'>{foot}</div></div>")

def price_bars(eyebrow, title, rows, foot):
    # rows: (label, sublabel, value_pct(0-100), text, css)
    b = ""
    for i,(lab,sub,pct,txt,cls) in enumerate(rows):
        b += (f"<div class='brow a' style='animation-delay:{.4+i*.18:.2f}s'>"
              f"<div class='blab'>{lab}<small>{sub}</small></div>"
              f"<div class='btrack'><div class='bfill {cls}' style='width:{pct}%;animation-delay:{.5+i*.18:.2f}s'></div></div>"
              f"<div class='bval {cls}'>{txt}</div></div>")
    return (head() + brandchrome(eyebrow) +
            f"<div class='pad' style='justify-content:flex-start;padding-top:150px'><h1 class='a' style='animation-delay:.16s;font-size:60px'>{title}</h1></div>"
            f"<div class='bars' style='padding-top:250px'>{b}</div>"
            f"<div class='foot a' style='animation-delay:1.6s'>{foot}</div></div>")

# ---- Scene definitions -----------------------------------------------------------------------------
SCENES = {
 # 01 HOOK — three competitor cards with per-screen price meters filling; motion from the fills + drift + KB
 "01": versus_cards(),
 # 02 the pattern — fair: they're good, but cloud-only + per-screen
 "02": slate("01 · The pattern", "Polished — but <span class='hl'>cloud-only</span>", bullets=[
        "<b>Mature &amp; easy</b> <span class='k'>— big template libraries, good support</span>",
        "<b>Cloud-only</b> <span class='k'>— your content lives on their servers</span>",
        "<b>Priced per screen</b> <span class='k'>— the bill grows with every display</span>"]),
 # 03 meet the alternative
 "03": slate("02 · The alternative", "The <span class='hl'>open-source</span> option",
        sub="ScreenTinker is MIT licensed, you host it yourself, and it runs on hardware you already own.",
        extra="<div style='display:flex;gap:18px;flex-wrap:wrap;margin-top:48px'>"
              + "".join(f"<div class='a' style='animation-delay:{.6+i*.12:.2f}s;font:700 34px system-ui;color:#cfd8e3;background:#0a1017;border:1px solid #24314a;border-radius:14px;padding:18px 30px'>{t}</div>"
                        for i,t in enumerate(["Android&nbsp;TV","Fire&nbsp;Stick","Raspberry&nbsp;Pi","Any&nbsp;browser","Windows&nbsp;/&nbsp;ChromeOS"]))
              + "</div><div class='a' style='animation-delay:1.3s;margin-top:34px;font:700 32px ui-monospace,monospace;color:#34d399'>No proprietary player to buy.</div>"),
 # 04 feature parity table
 "04": cmp_table("03 · Feature parity", "Not a stripped-down clone", [
        ("Open source (MIT)",   1,0,0,0),
        ("Self hosted option",  1,0,0,0),
        ("Android TV / Fire TV",1,1,1,1),
        ("Raspberry Pi",        1,1,1,1),
        ("Video walls (sync)",  1,1,1,1),
        ("Multi-zone layouts",  1,1,1,1),
        ("Proof-of-play",       1,1,1,1),
       ], "✓ = included · — = not available &nbsp;|&nbsp; <b>Feature-for-feature, the switch-worthy pieces are all here.</b>"),
 # 05 the per-screen curve
 "05": slate("04 · The cost curve", "It's <span class='hl'>per screen</span>", bullets=[
        "<b>Yodeck</b> <span class='k'>— ~$8 / screen / month</span>",
        "<b>OptiSigns</b> <span class='k'>— ~$11 / screen / month</span>",
        "<b>ScreenCloud</b> <span class='k'>— enterprise; climbs faster still</span>",
        "<b>Linear</b> <span class='k'>— the meter never stops running</span>"]),
 # 06 pricing bars @ 15 screens
 "06": price_bars("05 · 15 screens / month", "What 15 screens costs",[
        ("ScreenCloud","enterprise plan", 100, "$300+/mo", "paid"),
        ("OptiSigns","~$11/screen",        55, "~$165/mo", "paid"),
        ("Yodeck","~$8/screen",            40, "~$120/mo", "paid"),
        ("ScreenTinker hosted","flat rate — 15 devices", 33, "$99/mo", "st"),
        ("ScreenTinker self hosted","free — your server only", 4, "$0", "st"),
       ], "Publicly listed pricing, mid-2026 &nbsp;·&nbsp; <b>self hosted is free for any number of screens — you just pay for the server (~$5/mo)</b>"),
 # 07 data sovereignty
 "07": slate("06 · Your data", "It stays on <span class='hl'>your</span> infrastructure", bullets=[
        "<b>Nothing leaves your server</b> <span class='k'>— no third-party cloud</span>",
        "<b>Healthcare · government · finance</b> <span class='k'>— compliance-friendly</span>",
        "<b>Air-gapped LAN works</b> <span class='k'>— fully offline if you need it</span>"]),
 # 08 be fair — where the paid tools win
 "08": slate("07 · Being fair", "Where the paid tools <span class='hl'>win</span>", bullets=[
        "<b>Yodeck</b> <span class='k'>— ships pre-configured Pi players</span>",
        "<b>ScreenCloud</b> <span class='k'>— best-in-class Slack / Power BI apps</span>",
        "<b>OptiSigns</b> <span class='k'>— a huge ready-made template library</span>"]),
 # 09 who should switch
 "09": slate("08 · Who should switch", "Switch if <span class='hl'>you…</span>", bullets=[
        "<b>Have a little technical capacity</b> <span class='k'>— Docker or a Pi</span>",
        "<b>Want to own your data</b> <span class='k'>— self hosted, on-prem</span>",
        "<b>Feel the per-screen squeeze</b> <span class='k'>— same platform, no meter</span>"]),
 # 10 CTA
 "10": (head() +
        "<div class='cta'>"
        "<div class='logo' style='position:static;font:800 40px sans-serif;color:#8aa'>Screen<b>Tinker</b></div>"
        "<div class='big a' style='animation-delay:.15s'>The honest, open-source<br><b>alternative.</b></div>"
        "<div class='links a' style='animation-delay:.5s'>"
        "<span class='pill'><span class='u'>github.com/screentinker</span></span>"
        "<span class='pill'>Compare</span>"
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
