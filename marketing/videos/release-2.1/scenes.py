#!/usr/bin/env python3
# Scene renderer for "ScreenTinker 2.0".
#
# Same brand system and Playwright frame technique as the Pi / Android TV / alternative videos:
# every scene renders its FULL duration as frames with a CSS Ken Burns push-in baked in, so no
# frame is ever frozen. (The Pi video lost ~65% of viewers in 15s to static frames; that is the
# rule this pipeline exists to obey.)
#
# WHERE THE PICTURES COME FROM
#   Real UI, captured from a real 2.0 server  -> caps/cap-*.png   (see capture.py + rebuild.sh)
#   Branded diagram                           -> the *_diagram() builders below
# Four scenes are diagrams because they have no capturable surface: 03/04 (a slide's template and
# fields are a CONCEPT, not a screen), 11 (federation needs a second enrolled instance) and
# 12 (a BrightSign running the server is hardware). Everything else is the product itself.
#
# ⚠️ NO THIRD-PARTY MEDIA, EVER. An early Android TV capture picked up a Rick Astley thumbnail from
#    a real content library. Every capture here is of invented, generated demo data.
#
# Usage:
#   python3 scenes.py stills          -> caps/preview-sNN.png  (fast, for the contact sheet)
#   python3 scenes.py frames 1 17     -> scenes_anim/sNN/f%04d.jpg  (the real render)
import os, sys, subprocess
from playwright.sync_api import sync_playwright

W, H, FPS = 1920, 1080, 30
OUT = "scenes_anim"; os.makedirs(OUT, exist_ok=True); os.makedirs("caps", exist_ok=True)

CSS = """
*{margin:0;box-sizing:border-box}
body{width:1920px;height:1080px;overflow:hidden;background:#0e1420;color:#e6ecf3;
 font-family:-apple-system,'Segoe UI',system-ui,sans-serif;position:relative}
body::before{content:"";position:absolute;inset:-6%;z-index:0;opacity:.55;
 background:radial-gradient(60% 55% at 22% 18%,#16324a55,transparent 60%),radial-gradient(55% 55% at 82% 82%,#0f3b3155,transparent 60%);
 animation:drift 26s ease-in-out infinite alternate}
@keyframes drift{from{transform:translate(0,0) scale(1)}to{transform:translate(-3%,-2%) scale(1.06)}}
.wrap{position:absolute;inset:0;z-index:1;transform-origin:center;animation:kburns var(--sdur,16s) linear both}
@keyframes kburns{from{transform:scale(1.0)}to{transform:scale(1.05)}}
.eyebrow{position:absolute;top:70px;left:130px;font:700 24px ui-monospace,monospace;letter-spacing:.22em;
 text-transform:uppercase;color:#34d399;display:flex;align-items:center;gap:16px;z-index:5}
.eyebrow i{display:inline-block;width:46px;height:4px;background:#34d399;border-radius:3px;transform-origin:left;animation:barGrow .7s .05s cubic-bezier(.2,.8,.2,1) both}
.logo{position:absolute;top:66px;right:130px;font:800 30px sans-serif;color:#8aa;z-index:5} .logo b{color:#34d399}
.ver{position:absolute;top:64px;right:130px;z-index:5;font:800 30px ui-monospace,monospace;color:#0e1420;background:#34d399;padding:6px 16px;border-radius:10px}
.pad{position:absolute;inset:0;padding:120px 130px;display:flex;flex-direction:column;justify-content:center}
h1{font-size:82px;line-height:1.05;letter-spacing:-.03em;font-weight:820;max-width:1450px}
h1 .hl{color:#34d399}
.sub{font-size:34px;color:#9aa7b8;margin-top:26px;max-width:1250px;line-height:1.4}
ul{list-style:none;margin-top:50px;display:flex;flex-direction:column;gap:24px}
li{font-size:38px;color:#cfd8e3;padding-left:56px;position:relative;line-height:1.3}
li::before{content:"";position:absolute;left:0;top:14px;width:26px;height:26px;border-radius:7px;background:#34d39922;border:2px solid #34d399}
li b{color:#fff;font-weight:700} li .k{color:#34d399;font-weight:700}
/* terminal */
.term{background:#0a1017;border:1px solid #24314a;border-radius:16px;overflow:hidden;box-shadow:0 40px 90px -30px #000;width:100%;max-width:1560px;margin:0 auto}
.tbar{background:#141d2b;padding:18px 24px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #24314a}
.dot{width:16px;height:16px;border-radius:50%} .r{background:#f2565b}.y{background:#f5b23c}.g{background:#34d399}
.ttl{margin-left:16px;color:#7b8aa0;font:600 22px ui-monospace,monospace}
.tbody{padding:30px 40px;font:400 29px ui-monospace,monospace;line-height:1.5;min-height:480px}
.tl{white-space:pre-wrap}
.pmt{color:#34d399}.cmd{color:#e6ecf3}.st{color:#34d399}.dim{color:#6b7889}.ok{color:#8ee6b8}.hdr{color:#5aa0ff}
.caret{display:inline-block;width:14px;height:29px;background:#34d399;vertical-align:-4px;margin-left:4px;animation:blink 1s step-end infinite}
/* framed real capture */
.frame{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:132px 130px 258px}
.win{width:100%;height:100%;border-radius:16px;overflow:hidden;border:1px solid #24314a;box-shadow:0 50px 120px -40px #000;background:#0a1017;display:flex;flex-direction:column}
.wbar{background:#141d2b;padding:14px 20px;display:flex;align-items:center;gap:10px;flex:0 0 auto}
.wurl{margin-left:14px;color:#7b8aa0;font:600 20px ui-monospace,monospace;background:#0a1017;padding:8px 18px;border-radius:8px;flex:1}
.wimg{flex:1;background-size:cover;background-position:top center;background-repeat:no-repeat;background-color:#070b11}
.cap{position:absolute;left:130px;bottom:176px;font:600 34px system-ui;color:#cfd8e3;z-index:5}.cap b{color:#34d399}
/* chips that fly in over a capture */
.chips{position:absolute;left:130px;right:130px;bottom:48px;height:112px;z-index:6;display:flex;flex-wrap:wrap;gap:12px;justify-content:flex-start;align-content:flex-end}
.chip{font:700 27px ui-monospace,monospace;color:#0e1420;background:#34d399;padding:10px 20px;border-radius:12px;box-shadow:0 20px 40px -14px #000}
.chip.alt{background:#5aa0ff}
/* ---------- template / fields split ---------- */
.split{position:absolute;inset:0;padding:262px 130px 150px;display:flex;align-items:stretch;gap:40px;z-index:2}
.panel{flex:1;background:#0a1017;border:1px solid #24314a;border-radius:20px;padding:36px 38px;box-shadow:0 40px 90px -30px #000;display:flex;flex-direction:column}
.panel .pt{font:800 40px system-ui;margin-bottom:6px}
.panel .pd{font:600 24px system-ui;color:#7b8aa0;margin-bottom:26px}
.panel.tmpl .pt{color:#5aa0ff} .panel.fld .pt{color:#34d399}
.kv{font:500 27px ui-monospace,monospace;color:#cfd8e3;line-height:1.75;white-space:pre}
.kv .k{color:#5aa0ff}.kv .v{color:#9aa7b8}.kv .s{color:#34d399}
.joiner{width:150px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;flex:0 0 auto}
.joiner .op{font:800 62px ui-monospace,monospace;color:#7b8aa0}
.joiner .lbl{font:700 20px ui-monospace,monospace;color:#6b7889;letter-spacing:.12em;text-align:center;line-height:1.4}
.renderout{position:absolute;left:50%;bottom:74px;transform:translateX(-50%);z-index:6;
 background:#111a28;border:1px solid #24314a;border-radius:14px;padding:16px 30px;font:700 28px system-ui;color:#cfd8e3}
.renderout b{color:#34d399}
/* ---------- s04: same layout, one field changed ---------- */
.cardrow{position:absolute;inset:0;padding:250px 130px 210px;display:flex;align-items:center;justify-content:center;gap:34px;z-index:2}
.slidecard{flex:1;max-width:700px;aspect-ratio:16/9;background:#0E1420;border:1px solid #24314a;border-radius:18px;
 padding:44px 46px;box-shadow:0 40px 90px -30px #000;display:flex;flex-direction:column;justify-content:center;position:relative}
.sc-when{position:absolute;top:-40px;left:2px;font:700 22px ui-monospace,monospace;color:#6b7889;letter-spacing:.14em;text-transform:uppercase}
.sc-eyebrow{font:700 22px ui-monospace,monospace;color:#34d399;letter-spacing:.2em}
.sc-h{font:800 52px system-ui;color:#F4F7FB;line-height:1.05;margin-top:16px;letter-spacing:-.02em}
.sc-b{font:400 25px system-ui;color:#A3AEC0;margin-top:18px}
.sc-rule{width:120px;height:5px;background:#34d399;border-radius:3px;margin-top:26px}
.arrowcol{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:10px;width:210px}
.arrow{font:800 76px system-ui;color:#34d399}
.arrowlbl{font:700 20px ui-monospace,monospace;color:#6b7889;letter-spacing:.1em;text-align:center}
.surveyed{position:absolute;left:50%;bottom:64px;transform:translateX(-50%);z-index:6;text-align:center;
 background:#111a28;border:1px solid #24314a;border-radius:14px;padding:16px 34px;font:700 27px system-ui;color:#cfd8e3}
.surveyed b{color:#34d399;font-size:32px}
.surveyed span{display:block;font:600 23px system-ui;color:#7b8aa0;margin-top:6px}
/* ---------- layered slide ---------- */
.stack{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;z-index:2}
.lay{position:absolute;width:820px;height:462px;left:50%;top:50%;margin-left:-410px;margin-top:-231px;border-radius:16px;border:1px solid #24314a;
 box-shadow:0 40px 90px -30px #000;display:flex;align-items:center;justify-content:center;
 font:800 44px system-ui;transform-origin:center}
.lay .tag{position:absolute;left:20px;top:16px;font:700 20px ui-monospace,monospace;letter-spacing:.1em;color:#9aa7b8}
/* ---------- mesh ---------- */
.mesh{position:absolute;inset:0;z-index:2}
.node{position:absolute;background:#0a1017;border:1px solid #24314a;border-radius:18px;padding:22px 28px;
 box-shadow:0 30px 70px -26px #000;text-align:center}
.node .nn{font:800 34px system-ui;color:#e6ecf3}
.node .nd{font:600 22px ui-monospace,monospace;color:#7b8aa0;margin-top:6px}
.node.hub{border-color:#34d39966}.node.hub .nn{color:#34d399}
.grant{position:absolute;font:700 20px ui-monospace,monospace;color:#5aa0ff;background:#0e1420cc;padding:5px 12px;border-radius:8px;border:1px solid #1b2536}
svg.wires{position:absolute;inset:0;width:1920px;height:1080px;z-index:1;overflow:visible}
svg.wires path{stroke:#24314a;stroke-width:3;fill:none;stroke-dasharray:10 10;animation:dash 3s linear infinite}
@keyframes dash{to{stroke-dashoffset:-40}}
/* ---------- before/after bars ---------- */
.ba{position:absolute;inset:0;padding:230px 150px 130px;display:flex;flex-direction:column;gap:34px;z-index:2}
.barow{display:flex;align-items:center;gap:26px}
.balab{width:340px;text-align:right;font:700 34px system-ui;color:#cfd8e3;flex:0 0 auto}
.balab small{display:block;font:600 21px system-ui;color:#7b8aa0}
.batrack{flex:1;height:60px;background:#0a1017;border:1px solid #1b2536;border-radius:12px;position:relative;overflow:hidden}
.bafill{position:absolute;inset:0 auto 0 0;border-radius:11px;transform-origin:left;animation:grow 1.8s .3s cubic-bezier(.3,.7,.2,1) both}
@keyframes grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
.bafill.bad{background:linear-gradient(90deg,#f5b23c,#f2565b)}
.bafill.good{background:linear-gradient(90deg,#34d399,#2bb98a)}
.baval{width:230px;flex:0 0 auto;font:800 34px ui-monospace,monospace}
.baval.bad{color:#f2565b}.baval.good{color:#34d399}
/* ---------- offline / WAN-down ---------- */
.wan{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:90px;z-index:2}
.box{background:#0a1017;border:1px solid #24314a;border-radius:20px;padding:34px 40px;text-align:center;box-shadow:0 40px 90px -30px #000;min-width:380px}
.box .bt{font:800 38px system-ui;color:#e6ecf3}.box .bs{font:600 23px ui-monospace,monospace;color:#7b8aa0;margin-top:8px}
.cut{position:relative;width:250px;height:8px;background:#24314a;border-radius:6px}
.cut::after{content:"✕";position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
 font:800 70px system-ui;color:#f2565b;text-shadow:0 0 30px #f2565b88;animation:popInC .5s 1.1s both}
.stillworks{position:absolute;left:50%;bottom:110px;transform:translateX(-50%);z-index:6;
 font:800 40px system-ui;color:#34d399;white-space:nowrap}
/* ---------- CTA ---------- */
.cta{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;text-align:center;z-index:2}
.cta .big{font:820 96px system-ui;letter-spacing:-.03em}.cta .big b{color:#34d399}
.links{font:600 38px ui-monospace,monospace;color:#cfd8e3;line-height:1.9} .links .u{color:#5aa0ff}
.pill{display:inline-block;margin:0 10px;padding:8px 22px;border:1px solid #24314a;border-radius:12px;background:#0a1017}
/* entrances */
@keyframes riseIn{from{opacity:0;transform:translateY(38px)}to{opacity:1;transform:translateY(0)}}
@keyframes barGrow{from{transform:scaleX(0);opacity:0}to{transform:scaleX(1);opacity:1}}
@keyframes termIn{from{opacity:0;transform:translateY(28px) scale(.985)}to{opacity:1;transform:translateY(0) scale(1)}}
@keyframes popIn{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:scale(1)}}
@keyframes popInC{from{opacity:0;transform:translate(-50%,-50%) scale(.6)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}
@keyframes blink{50%{opacity:0}}
@keyframes slideRight{from{opacity:0;transform:translateX(-40px)}to{opacity:1;transform:translateX(0)}}
.a{animation:riseIn .62s both cubic-bezier(.2,.8,.2,1)}
.p{animation:popIn .55s both cubic-bezier(.2,.8,.2,1)}
.term.a{animation:termIn .7s .1s both cubic-bezier(.2,.8,.2,1)}
.foot{position:absolute;left:130px;bottom:56px;font:600 26px system-ui;color:#6b7889;z-index:5}
.foot b{color:#9aa7b8}
"""

def head(extra=""):
    return f"<!doctype html><meta charset=utf-8><style>{CSS}{extra}</style><body><div class='wrap'>"

def brandchrome(eyebrow, version=False):
    right = "<div class='ver'>2.1</div>" if version else "<div class='logo'>Screen<b>Tinker</b></div>"
    return (f"<div class='eyebrow'><i></i><span class='a' style='animation-delay:.12s'>{eyebrow}</span></div>{right}")

def slate(eyebrow, title, sub="", bullets=None, extra="", version=False):
    b = head() + brandchrome(eyebrow, version) + "<div class='pad'>"
    b += f"<h1 class='a' style='animation-delay:.16s'>{title}</h1>"
    if sub: b += f"<div class='sub a' style='animation-delay:.32s'>{sub}</div>"
    if bullets:
        b += "<ul>" + "".join(f"<li class='a' style='animation-delay:{.44+i*.15:.2f}s'>{x}</li>" for i,x in enumerate(bullets)) + "</ul>"
    return b + extra + "</div></div>"

def terminal(eyebrow, title, lines, caret=True):
    tl = "".join(f"<div class='tl a' style='animation-delay:{.4+i*.16:.2f}s'>{ln or '&nbsp;'}</div>" for i,ln in enumerate(lines))
    if caret:
        tl += "<div class='tl a' style='animation-delay:{:.2f}s'><span class='pmt'>$</span> <span class='caret'></span></div>".format(.4+len(lines)*.16)
    return (head() + brandchrome(eyebrow) +
            "<div class='pad'><div class='term a'><div class='tbar'><span class='dot r'></span><span class='dot y'></span><span class='dot g'></span>"
            f"<span class='ttl'>{title}</span></div><div class='tbody'>{tl}</div></div></div></div>")

def cap_frame(eyebrow, img, url, caption, chips=None, pos="top center", size="cover", version=False):
    """A real screenshot in browser chrome. `chips` fly in over it to name what to look at."""
    fileurl = "file://" + os.path.abspath(os.path.join("caps", img))
    ch = ""
    if chips:
        ch = "<div class='chips'>" + "".join(
            f"<span class='chip {c[1] if len(c)>1 else ''} p' style='animation-delay:{.9+i*.22:.2f}s'>{c[0]}</span>"
            for i, c in enumerate(chips)) + "</div>"
    return (head() + brandchrome(eyebrow, version) +
      f"<div class='frame'><div class='win a' style='animation-delay:.12s'><div class='wbar'>"
      "<span class='dot r'></span><span class='dot y'></span><span class='dot g'></span>"
      f"<span class='wurl'>{url}</span></div>"
      f"<div class='wimg' style=\"background-image:url('{fileurl}');background-position:{pos};background-size:{size}\"></div>"
      f"</div></div>{ch}"
      f"<div class='cap a' style='animation-delay:.5s'>{caption}</div></div>")

# ---------------------------------------------------------------- diagrams
def split_diagram(eyebrow, title, highlight_field=None):
    """The 2.0 idea in one picture: template is the VIEW, fields are the RECORD."""
    hl = highlight_field or "Fairview Medical Center"
    tmpl = ("<span class='k'>slot</span>  <span class='s'>\"h\"</span>\n"
            "<span class='k'>kind</span>  head\n"
            "<span class='k'>box</span>   x 8  y 27  w 74\n"
            "<span class='k'>style</span> 8.5cqw · 800 · #F4F7FB\n"
            "<span class='k'>motion</span> slideU · 0.3s · soft\n\n"
            "<span class='v'>— geometry, style, motion —</span>\n"
            "<span class='v'>  and a slot name.</span>")
    flds = (f"<span class='s'>\"h\"</span>: \"{hl}\"\n"
            "<span class='s'>\"b\"</span>: \"Main reception · Level 1\"\n"
            "<span class='s'>\"eyebrow\"</span>: \"WELCOME\"\n\n\n"
            "<span class='v'>— just the words.</span>\n"
            "<span class='v'>  Edit one string, and the</span>\n"
            "<span class='v'>  layout does not move.</span>")
    return (head() + brandchrome(eyebrow) +
      f"<div class='pad' style='justify-content:flex-start;padding-top:118px'><h1 class='a' style='animation-delay:.16s;font-size:62px'>{title}</h1></div>"
      "<div class='split'>"
      "<div class='panel tmpl a' style='animation-delay:.35s'><div class='pt'>template</div>"
      f"<div class='pd'>the view</div><div class='kv'>{tmpl}</div></div>"
      "<div class='joiner'><div class='op a' style='animation-delay:.8s'>+</div>"
      "<div class='lbl a' style='animation-delay:.95s'>MEET AT<br>RENDER TIME<br>— AND NOWHERE<br>ELSE</div></div>"
      "<div class='panel fld a' style='animation-delay:.55s'><div class='pt'>fields</div>"
      f"<div class='pd'>the record</div><div class='kv'>{flds}</div></div>"
      "</div>"
      "<div class='renderout p' style='animation-delay:1.5s'>one slide, rendered — <b>edit the words without touching the layout</b></div>"
      "</div>")

def layers_diagram(eyebrow, title):
    """Generated -> layered: a plate plus cut-out objects, each its own element."""
    L = [("#132033", "background plate",  190,  120, .45, "#7b8aa0"),
         ("#16324a", "object · cut out",    64,   40, .70, "#5aa0ff"),
         ("#0f3b31", "object · cut out",   -62,  -40, .95, "#34d399")]
    lays = ""
    for i,(bg,tag,dx,dy,delay,col) in enumerate(L):
        lays += (f"<div class='lay p' style='background:{bg};margin-left:{-410+dx}px;margin-top:{-231+dy}px;"
                 f"animation-delay:{delay}s;z-index:{i+1};color:{col}'>"
                 f"<span class='tag'>{tag}</span></div>")
    lays += ("<div class='lay p' style='background:linear-gradient(135deg,#2a1030,#12081c);"
             "margin-left:-598px;margin-top:-351px;"
             "animation-delay:1.2s;z-index:4;color:#f5b23c;border-color:#f5b23c55'>"
             "<span class='tag' style='color:#f5b23c'>headline · painted as artwork</span>Fairview</div>")
    return (head() + brandchrome(eyebrow) +
      f"<div class='pad' style='justify-content:flex-start;padding-top:118px'><h1 class='a' style='animation-delay:.16s;font-size:62px'>{title}</h1></div>"
      f"<div class='stack' style='padding-top:90px'>{lays}</div>"
      "<div class='renderout p' style='animation-delay:1.7s'>the words behind the artwork <b>stay a field</b> — editable, and read out to anything that cannot see it</div>"
      "</div>")

def edit_later_diagram(eyebrow, title):
    """s04: two renders of one template, months apart. Only the field changed."""
    def card(when, headline, sub, delay, mark=False):
        ring = "border-color:#34d39988;box-shadow:0 0 0 3px #34d39922,0 40px 90px -30px #000" if mark else ""
        hl = ("<span style='background:#34d39926;border-bottom:3px solid #34d399;padding:2px 8px'>"
              f"{headline}</span>") if mark else headline
        return (f"<div class='slidecard p' style='animation-delay:{delay}s;{ring}'>"
                f"<div class='sc-when'>{when}</div>"
                "<div class='sc-eyebrow'>WELCOME</div>"
                f"<div class='sc-h'>{hl}</div>"
                f"<div class='sc-b'>{sub}</div>"
                "<div class='sc-rule'></div></div>")
    return (head() + brandchrome(eyebrow) +
      f"<div class='pad' style='justify-content:flex-start;padding-top:112px'>"
      f"<h1 class='a' style='animation-delay:.16s;font-size:58px;max-width:1660px'>{title}</h1></div>"
      "<div class='cardrow'>"
      + card("today", "Fairview Medical Center", "Main reception · Level 1", .45)
      + "<div class='arrowcol'><div class='arrow a' style='animation-delay:.9s'>→</div>"
        "<div class='arrowlbl a' style='animation-delay:1.0s'>write ONE string</div></div>"
      + card("three months later", "Fairview Health Partners", "Main reception · Level 1", 1.15, mark=True) +
      "</div>"
      "<div class='surveyed p' style='animation-delay:1.7s'>"
      "<b>15</b> signage products surveyed before this was designed."
      "<span>Not one makes the changeable text part of the template.</span></div>"
      "</div>")

def wan_diagram(eyebrow, title):
    """A trigger resolves ON THE SCREEN, so it fires with the link down."""
    return (head() + brandchrome(eyebrow) +
      f"<div class='pad' style='justify-content:flex-start;padding-top:118px'><h1 class='a' style='animation-delay:.16s;font-size:62px'>{title}</h1></div>"
      "<div class='wan'>"
      "<div class='box a' style='animation-delay:.4s'><div class='bt'>Fire panel</div><div class='bs'>UDP · FIRE_ALARM</div></div>"
      "<div class='box a' style='animation-delay:.55s;min-width:300px'><div class='bt'>The screen</div>"
      "<div class='bs' style='color:#34d399'>resolves it here</div></div>"
      "<div class='cut a' style='animation-delay:.85s'></div>"
      "<div class='box a' style='animation-delay:1.0s;opacity:.45'><div class='bt'>Server</div><div class='bs'>unreachable</div></div>"
      "</div>"
      "<div class='stillworks p' style='animation-delay:1.6s'>The evacuation message still goes up.</div>"
      "<div class='foot a' style='animation-delay:1.9s'>A trigger that needs the server is a trigger that fails in the situation it exists for.</div>"
      "</div>")

def mesh_diagram(eyebrow, title):
    """Federation: a hub, two customers, per-grant, customer consents."""
    return (head() + brandchrome(eyebrow) +
      f"<div class='pad' style='justify-content:flex-start;padding-top:118px'><h1 class='a' style='animation-delay:.16s;font-size:62px'>{title}</h1></div>"
      "<div class='mesh'>"
      "<svg class='wires'><path d='M960 430 C 960 520, 560 520, 560 630'/><path d='M960 430 C 960 520, 1360 520, 1360 630'/></svg>"
      "<div class='node hub p' style='left:760px;top:330px;width:400px;animation-delay:.4s'>"
      "<div class='nn'>Integrator hub</div><div class='nd'>sees · sends · reboots · reads</div></div>"
      "<div class='node p' style='left:360px;top:630px;width:400px;animation-delay:.75s'>"
      "<div class='nn'>Customer A</div><div class='nd'>accepted: content, reboot</div></div>"
      "<div class='node p' style='left:1160px;top:630px;width:400px;animation-delay:.95s'>"
      "<div class='nn'>Customer B</div><div class='nd'>accepted: diagnostics only</div></div>"
      "<div class='grant a' style='left:640px;top:520px;animation-delay:1.3s'>per-grant</div>"
      "<div class='grant a' style='left:1180px;top:520px;animation-delay:1.45s'>per-grant</div>"
      "</div>"
      "<div class='renderout p' style='animation-delay:1.7s'>the <b>customer</b> decides what it accepts — and can see what was done to it</div>"
      "<div class='foot a' style='animation-delay:1.95s'>Conservative for a first release: <b>opt-in</b>, capped at <b>two tiers</b>, content and schedules not mirrored yet.</div>"
      "</div>")

def player_server_diagram(eyebrow, title):
    """A BrightSign running the server AND the player, side by side, on one box."""
    return (head() + brandchrome(eyebrow) +
      f"<div class='pad' style='justify-content:flex-start;padding-top:118px'><h1 class='a' style='animation-delay:.16s;font-size:62px'>{title}</h1></div>"
      "<div class='wan' style='gap:0'>"
      "<div class='box a' style='animation-delay:.4s;min-width:820px;padding:44px 50px;border-color:#34d39955'>"
      "<div class='bt' style='margin-bottom:26px'>One BrightSign player</div>"
      "<div style='display:flex;gap:26px;justify-content:center'>"
      "<div class='box p' style='animation-delay:.8s;min-width:340px;background:#111a28'>"
      "<div class='bt' style='font-size:30px;color:#34d399'>ScreenTinker server</div><div class='bs'>a real Node process</div></div>"
      "<div class='box p' style='animation-delay:1.0s;min-width:340px;background:#111a28'>"
      "<div class='bt' style='font-size:30px;color:#5aa0ff'>the player</div><div class='bs'>in the widget beside it</div></div>"
      "</div></div></div>"
      "<div class='chips' style='right:50%;transform:translateX(50%);bottom:150px;justify-content:center;max-width:1400px'>"
      "<span class='chip p' style='animation-delay:1.35s'>screenshots</span>"
      "<span class='chip p' style='animation-delay:1.5s'>audio-plane muting</span>"
      "<span class='chip p' style='animation-delay:1.65s'>LAN trigger ingress</span>"
      "<span class='chip alt p' style='animation-delay:1.8s'>video backgrounds composite</span>"
      "</div>"
      "<div class='foot a' style='animation-delay:2.0s'>That last one took a session on real hardware to prove.</div>"
      "</div>")

def perf_diagram(eyebrow, title):
    rows = [("Health band<small>before — one 20ms bucket decided it</small>", 88.6, "88.6% elevated", "bad"),
            ("Health band<small>after — median of 15 windows</small>",        99.9, "99.9% normal",   "good"),
            ("Closing a play<small>before — searched the whole history</small>", 76, "150 ms",       "bad"),
            ("Closing a play<small>after — closed by primary key</small>",     3,  "indexed",        "good")]
    b = ""
    for i,(lab,pct,txt,cls) in enumerate(rows):
        b += (f"<div class='barow a' style='animation-delay:{.45+i*.18:.2f}s'>"
              f"<div class='balab'>{lab}</div>"
              f"<div class='batrack'><div class='bafill {cls}' style='width:{pct}%;animation-delay:{.6+i*.18:.2f}s'></div></div>"
              f"<div class='baval {cls}'>{txt}</div></div>")
    return (head() + brandchrome(eyebrow) +
      f"<div class='pad' style='justify-content:flex-start;padding-top:118px'><h1 class='a' style='animation-delay:.16s;font-size:62px'>{title}</h1></div>"
      f"<div class='ba'>{b}</div>"
      "<div class='foot a' style='animation-delay:1.7s'>Also fixed: <b>36,096</b> plays started and never closed — the oldest three months old.</div>"
      "</div>")

def cta_scene():
    return (head("body{background:#080b11}") +
      "<div class='ver'>2.1</div>"
      "<div class='cta'>"
      "<div class='big a' style='animation-delay:.2s'>Screen<b>Tinker</b> <b>2.1</b></div>"
      "<div class='sub a' style='animation-delay:.45s;text-align:center;max-width:1200px'>"
      "Open source · MIT licensed · run the whole thing on your own hardware</div>"
      "<div class='links a' style='animation-delay:.7s'>"
      "<span class='pill'>github.com/screentinker/<span class='u'>screentinker</span></span><br>"
      "<span class='pill'><span class='u'>screentinker.com</span></span></div>"
      "<div class='sub a' style='animation-delay:1.0s;font-size:30px'>A star on the repository genuinely helps.</div>"
      "</div></div>")

# ---------------------------------------------------------------- scenes

def room_sign_diagram(eyebrow, title):
    langs=[("English","AVAILABLE","Free all day"),("Nederlands","BESCHIKBAAR","De hele dag vrij"),
           ("Espanol","DISPONIBLE","Libre todo el dia"),("Deutsch","FREI","Ganztaegig frei")]
    cards="".join(
      f"<div class='rs a' style='animation-delay:{.5+i*.18:.2f}s'>"
      f"<div class='rslang'>{l}</div><div class='rsname'>Green Meeting Room</div>"
      f"<div class='rsbig'>{st}</div><div class='rssub'>{sub}</div></div>"
      for i,(l,st,sub) in enumerate(langs))
    extra="""
    .rsrow{position:absolute;inset:0;display:flex;gap:34px;align-items:center;justify-content:center;padding:0 130px}
    .rs{flex:1;max-width:360px;background:#0a1017;border:1px solid #24314a;border-radius:20px;padding:34px 30px;box-shadow:0 40px 90px -30px #000}
    .rslang{font:700 20px ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:#5aa0ff;margin-bottom:22px}
    .rsname{font-size:26px;color:#9aa7b8;margin-bottom:18px}
    .rsbig{font-size:46px;font-weight:820;color:#34d399;letter-spacing:-.01em}
    .rssub{font-size:24px;color:#cfd8e3;margin-top:12px}
    """
    return (head(extra)+brandchrome(eyebrow)+"<div class='pad' style='justify-content:flex-start'>"
      f"<h1 class='a' style='animation-delay:.16s'>{title}</h1>"
      "<div class='sub a' style='animation-delay:.3s'>The same sign, in every language the dashboard speaks. Defaults to English.</div>"
      f"<div class='rsrow' style='top:auto;bottom:120px;height:360px'>{cards}</div></div></div>")

SCENES = {
 "01": cap_frame("ScreenTinker 2.1", "cap-dashboard.png", "screentinker.com/app#/dashboard",
        "Since <b>2.0</b>: live video, voice, live data on your slides, and a plugin system.",
        chips=[("Live video",),("Talk",),("Data sources",),("Plugins","alt")], version=True),

 "02": cap_frame("What's new · Live view", "cap-dashboard.png", "screentinker.com/app#/displays",
        "Watch what a screen is <b>actually showing</b> — live, sub-second.",
        chips=[("WebRTC",),("real output, not a thumbnail",),("off until you enable it","alt")]),

 "03": slate("What's new · Talk", "Talk to your <span class='hl'>screens</span>",
        sub="A voice intercom and public-address channel over the same connection.",
        bullets=["<b>Page one lobby</b> <span class='k'>— or a whole building</span>",
                 "<b>Off by default</b> <span class='k'>— enabled per organization</span>",
                 "<b>Your own relay</b> <span class='k'>— per-org TURN / STUN</span>"]),

 "04": cap_frame("What's new · Data sources", "cap-data-sources.png", "screentinker.com/app#/data-sources",
        "Bind live data straight into a slide or widget with <b>{{ds:slug.field}}</b>.",
        chips=[("calendar feed",),("any JSON over HTTP",),("refreshes on schedule","alt")]),

 "05": room_sign_diagram("What's new · Meeting-room signs", "Busy or <span class='hl'>Available</span>, in every language"),

 "06": cap_frame("2.1 · Plugins", "cap-plugins.png", "screentinker.com/app#/admin",
        "Add widget types, data connectors and hooks — <b>without forking the code</b>.",
        chips=[("widgets",),("data sources",),("hooks",),("off by default","alt")]),

 "07": cap_frame("2.1 · Plugins", "cap-plugins.png", "screentinker.com/app#/admin",
        "A zip sits in quarantine until an admin approves <b>that exact tree</b>. No marketplace, no phone-home.",
        chips=[("approve the exact bytes",),("enable + restart to run","alt")], pos="center"),

 "08": slate("2.1 · PDF to playlist", "Drop a <span class='hl'>PDF</span> — get a playlist",
        sub="Every page becomes a full-screen slide, rendered right in your browser.",
        bullets=["<b>One slide per page</b> <span class='k'>— in order</span>",
                 "<b>No conversion step</b> <span class='k'>— and no server dependency</span>",
                 "<b>A deck exported to PDF</b> <span class='k'>— comes out ready to play</span>"]),

 "09": cap_frame("What's new · Teams", "cap-reviews.png", "screentinker.com/app#/reviews",
        "Require a <b>review</b> before a change goes live — and keep every past version.",
        chips=[("approval workflow",),("version history",),("roll back","alt")]),

 "10": cap_frame("What's new · More screens", "cap-certified.png", "screentinker.com/certified-hardware",
        "webOS, e-paper and microcontrollers — plus a <b>certified-hardware</b> list.",
        chips=[("LG webOS",),("e-paper",),("what's tested, what to avoid","alt")], pos="top center"),

 "11": slate("What's new · Player polish", "Quieter, <span class='hl'>sharper</span> playback",
        sub="The small things that make signage look professional.",
        bullets=["<b>Bring your own transition shader</b> <span class='k'>— or the built-in crossfade</span>",
                 "<b>No black flash</b> <span class='k'>— between clips on the web player</span>",
                 "<b>Portrait panels</b> <span class='k'>— driven in landscape now fill the screen</span>"]),

 "12": cta_scene(),
}

# ---------------------------------------------------------------- render
TAIL = 0.6   # hang 0.6s past the VO, as every video in this series does
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
            if sid not in SCENES: continue
            sdur = round(vo_dur(sid) + TAIL, 3)
            # Per-scene Ken Burns duration, so the push-in spans exactly this scene.
            html = SCENES[sid].replace("<body>", f"<body style='--sdur:{sdur}s'>", 1)
            open("_render.html","w").write(html)
            # goto(file://) not set_content: set_content blocks file:// images, and every
            # capture scene is a file:// background-image.
            pg.goto("file://" + os.path.abspath("_render.html"), wait_until="load")
            if mode == "stills":
                pg.wait_for_timeout(3800)  # late enough that the last chip entrance has landed
                pg.screenshot(path=f"caps/preview-s{sid}.png")
                print(f"still s{sid} -> caps/preview-s{sid}.png  ({sdur:.1f}s)")
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
