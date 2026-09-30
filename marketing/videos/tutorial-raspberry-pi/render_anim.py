import os, math
from playwright.sync_api import sync_playwright
OUT="scenes_anim"; os.makedirs(OUT,exist_ok=True)
FPS=30; ENTER=1.9  # seconds of entrance animation to render as frames
NFR=int(FPS*ENTER)

CSS="""
*{margin:0;box-sizing:border-box}
body{width:1920px;height:1080px;overflow:hidden;background:#0e1420;color:#e6ecf3;
 font-family:-apple-system,'Segoe UI',system-ui,sans-serif;position:relative}
.pad{position:absolute;inset:0;padding:110px 130px;display:flex;flex-direction:column;justify-content:center}
.eyebrow{position:absolute;top:70px;left:130px;font:700 24px ui-monospace,monospace;letter-spacing:.22em;
 text-transform:uppercase;color:#34d399;display:flex;align-items:center;gap:16px}
.eyebrow i{display:inline-block;width:0;height:4px;background:#34d399;border-radius:3px;animation:barGrow .7s .05s cubic-bezier(.2,.8,.2,1) both}
.logo{position:absolute;top:66px;right:130px;font:800 30px sans-serif;color:#8aa} .logo b{color:#34d399}
h1{font-size:86px;line-height:1.05;letter-spacing:-.03em;font-weight:820;max-width:1400px}
h1 .hl{color:#34d399}
.sub{font-size:34px;color:#9aa7b8;margin-top:26px;max-width:1200px;line-height:1.4}
ul{list-style:none;margin-top:54px;display:flex;flex-direction:column;gap:26px}
li{font-size:40px;color:#cfd8e3;padding-left:56px;position:relative;line-height:1.3}
li::before{content:"";position:absolute;left:0;top:16px;width:26px;height:26px;border-radius:7px;background:#34d39922;border:2px solid #34d399}
li b{color:#fff;font-weight:700} li .k{color:#34d399;font-weight:700}
.term{background:#0a1017;border:1px solid #24314a;border-radius:16px;overflow:hidden;box-shadow:0 40px 90px -30px #000;width:100%;max-width:1560px;margin:0 auto}
.tbar{background:#141d2b;padding:18px 24px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #24314a}
.dot{width:16px;height:16px;border-radius:50%} .r{background:#f2565b}.y{background:#f5b23c}.g{background:#34d399}
.ttl{margin-left:16px;color:#7b8aa0;font:600 22px ui-monospace,monospace}
.tbody{padding:30px 40px;font:400 30px ui-monospace,monospace;line-height:1.5}
.tl{white-space:pre-wrap;min-height:1.5em}
.pmt{color:#34d399}.cmd{color:#e6ecf3}.st{color:#34d399}.dim{color:#6b7889}.ok{color:#8ee6b8}.hdr{color:#5aa0ff}
.links{margin-top:46px;font:600 36px ui-monospace,monospace;color:#cfd8e3;line-height:1.7} .links .u{color:#5aa0ff}
@keyframes riseIn{from{opacity:0;transform:translateY(36px)}to{opacity:1;transform:translateY(0)}}
@keyframes barGrow{from{width:0;opacity:0}to{width:46px;opacity:1}}
@keyframes termIn{from{opacity:0;transform:translateY(28px) scale(.985)}to{opacity:1;transform:translateY(0) scale(1)}}
.a{animation:riseIn .62s both cubic-bezier(.2,.8,.2,1)}
.term.a{animation:termIn .7s .1s both cubic-bezier(.2,.8,.2,1)}
"""
def delay(el,d): return f'style="animation-delay:{d:.2f}s"'
def slate(eyebrow,title,sub="",bullets=None,extra=""):
    b=f'<div class="eyebrow"><i></i><span class="a" style="animation-delay:.12s">{eyebrow}</span></div><div class="logo">Screen<b>Tinker</b></div><div class="pad">'
    b+=f'<h1 class="a" style="animation-delay:.15s">{title}</h1>'
    if sub: b+=f'<div class="sub a" style="animation-delay:.3s">{sub}</div>'
    if bullets:
        b+='<ul>'+''.join(f'<li class="a" style="animation-delay:{.4+i*.14:.2f}s">{x}</li>' for i,x in enumerate(bullets))+'</ul>'
    b+=extra+'</div>'; return b
def terminal(eyebrow,title,lines):
    tl=''.join(f'<div class="tl a" style="animation-delay:{.35+i*.11:.2f}s">{ln or "&nbsp;"}</div>' for i,ln in enumerate(lines))
    return (f'<div class="eyebrow"><i></i><span class="a" style="animation-delay:.12s">{eyebrow}</span></div><div class="logo">Screen<b>Tinker</b></div>'
      f'<div class="pad"><div class="term a"><div class="tbar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>'
      f'<span class="ttl">{title}</span></div><div class="tbody">{tl}</div></div></div>')

SCENES={
"s02":slate("01 · What you need",'What you <span class="hl">need</span>',bullets=[
  'A <b>Raspberry Pi</b> <span class="k">— 4 or 5</span>','A <b>microSD card</b> <span class="k">— 8GB+</span>',
  'Any screen with <b>HDMI</b>','A <b>ScreenTinker</b> server <span class="k">— free or self-host</span>']),
"s03":slate("02 · Flash the card",'Flash <span class="hl">Raspberry Pi OS</span>',bullets=[
  'Open <b>Raspberry Pi Imager</b>','Choose <b>Pi OS Lite</b> <span class="k">(no desktop)</span>','Select your <b>SD card</b>','Click <b>Write</b> <span class="k">— ~2 min</span>']),
"s04":terminal("03 · First boot","Raspberry Pi 4 Model B — console",[
  '<span class="dim">[ 0.00]</span> Booting Linux on physical CPU 0x0','<span class="dim">[ 0.00]</span> Linux version 6.6.31+rpt-rpi-v8',
  '<span class="dim">[ 0.00]</span> Machine model: <span class="hdr">Raspberry Pi 4 Model B</span>','<span class="dim">[ 2.32]</span> EXT4-fs (mmcblk0p2): mounted',
  '<span class="dim">[ 2.38]</span> Run /sbin/init as init process','<span class="dim">[ 6.95]</span> systemd[1]: systemd running','',
  'Raspberry Pi OS Lite','raspberrypi login: <span class="pmt">pi</span>']),
"s05":terminal("04 · One command","pi@raspberrypi: ~",[
  '<span class="pmt">pi@raspberrypi</span>:~ $ <span class="cmd">curl -sSL screentinker.com/scripts/\\</span>','<span class="cmd">    raspberry-pi-setup.sh | sudo bash</span>','',
  '<span class="st">[ScreenTinker]</span> Detected: Pi OS Lite (headless)','<span class="st">[ScreenTinker]</span> Installing kiosk packages...',
  '<span class="st">[ScreenTinker]</span> Creating kiosk service...','<span class="ok">Created symlink screentinker-kiosk.service</span>',
  '<span class="st">[ScreenTinker]</span> Configuring auto-login...','<span class="st">[ScreenTinker]</span> <span class="ok">Setup Complete!</span>']),
"s06":slate("05 · Zero config",'The installer <span class="hl">does it all</span>',bullets=[
  '<b>Chromium kiosk</b> — full-screen player','<b>Auto-login</b> on boot','<b>Auto-restart</b> service','<b>No screen blanking</b>']),
"s08":slate("07 · Pair it",'Enter the code, <span class="hl">claim the screen</span>',bullets=[
  'Open your <b>dashboard</b>','Click <b>Add Display</b>','Type the <b>pairing code</b>','The Pi appears <span class="k">— Online</span>']),
"s09":slate("08 · Push content",'Publish, and it\'s <span class="hl">live</span>',bullets=[
  'Upload media, build a <b>playlist</b>, <b>Publish</b>','Updates on the Pi <span class="k">in seconds</span>','<b>Schedule</b> by time of day','<b>Multi-zone</b> &amp; <b>video walls</b>']),
"s10":slate("",'<span class="hl">Free</span> digital signage,<br>on your own hardware.',sub="Open source · Self-hosted · No per-screen fees",
  extra='<div class="links a" style="animation-delay:.5s">🌐 <span class="u">screentinker.com</span><br>⭐ <span class="u">github.com/screentinker/screentinker</span></div>'),
}
with sync_playwright() as p:
    br=p.chromium.launch(args=["--force-color-profile=srgb"])
    pg=br.new_page(viewport={"width":1920,"height":1080})
    for name,body in SCENES.items():
        d=f"{OUT}/{name}"; os.makedirs(d,exist_ok=True)
        doc=f"<html><head><meta charset=utf-8><style>{CSS}</style></head><body>{body}</body></html>"
        path=os.path.abspath(f"{OUT}/{name}.html"); open(path,"w").write(doc)
        pg.goto("file://"+path); pg.wait_for_timeout(120)
        pg.evaluate("document.getAnimations().forEach(a=>a.pause())")
        for f in range(NFR):
            ms=f/FPS*1000
            pg.evaluate("(t)=>document.getAnimations().forEach(a=>{a.currentTime=t})", ms)
            pg.screenshot(path=f"{d}/f{f:04d}.png")
        print(f"{name}: {NFR} frames")
    br.close()
print("frames rendered")
