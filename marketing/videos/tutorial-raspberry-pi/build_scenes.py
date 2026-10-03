import subprocess, os, html, shutil
OUT="scenes"; os.makedirs(OUT, exist_ok=True)
CH = "chromium"
BRAND_CSS = """
*{margin:0;box-sizing:border-box}
body{width:1920px;height:1080px;overflow:hidden;background:#0e1420;color:#e6ecf3;
 font-family:-apple-system,'Segoe UI',system-ui,sans-serif;position:relative}
.pad{position:absolute;inset:0;padding:110px 130px;display:flex;flex-direction:column;justify-content:center}
.eyebrow{position:absolute;top:70px;left:130px;font:700 24px ui-monospace,monospace;letter-spacing:.22em;
 text-transform:uppercase;color:#34d399;display:flex;align-items:center;gap:16px}
.eyebrow::before{content:"";width:46px;height:4px;background:#34d399;border-radius:3px}
.logo{position:absolute;top:66px;right:130px;font:800 30px sans-serif;color:#8aa} .logo b{color:#34d399}
h1{font-size:86px;line-height:1.05;letter-spacing:-.03em;font-weight:820;max-width:1400px}
h1 .hl{color:#34d399}
.sub{font-size:34px;color:#9aa7b8;margin-top:26px;max-width:1200px;line-height:1.4}
ul{list-style:none;margin-top:54px;display:flex;flex-direction:column;gap:26px}
li{font-size:40px;color:#cfd8e3;padding-left:56px;position:relative;line-height:1.3}
li::before{content:"";position:absolute;left:0;top:16px;width:26px;height:26px;border-radius:7px;
 background:#34d39922;border:2px solid #34d399}
li b{color:#fff;font-weight:700}
li .k{color:#34d399;font-weight:700}
/* terminal */
.term{background:#0a1017;border:1px solid #24314a;border-radius:16px;overflow:hidden;
 box-shadow:0 40px 90px -30px #000;width:100%;max-width:1560px;margin:0 auto}
.tbar{background:#141d2b;padding:18px 24px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #24314a}
.dot{width:16px;height:16px;border-radius:50%} .r{background:#f2565b}.y{background:#f5b23c}.g{background:#34d399}
.ttl{margin-left:16px;color:#7b8aa0;font:600 22px ui-monospace,monospace}
.tbody{padding:34px 40px;font:400 30px ui-monospace,'SF Mono',monospace;line-height:1.5;white-space:pre-wrap}
.cmd{color:#e6ecf3}.pmt{color:#34d399}.st{color:#34d399}.dim{color:#6b7889}.ok{color:#8ee6b8}.hdr{color:#5aa0ff}
.cta-row{display:flex;gap:22px;margin-top:50px;flex-wrap:wrap}
.pill{font:700 34px ui-monospace,monospace;color:#34d399;border:2px solid #34d39955;border-radius:14px;padding:14px 30px;background:#34d3990d}
.links{margin-top:46px;font:600 36px ui-monospace,monospace;color:#cfd8e3;line-height:1.7}
.links .u{color:#5aa0ff}
"""
def render(name, body):
    doc=f"<html><head><meta charset=utf-8><style>{BRAND_CSS}</style></head><body>{body}</body></html>"
    p=os.path.abspath(f"{OUT}/{name}.html"); open(p,"w").write(doc)
    subprocess.run([CH,"--headless","--disable-gpu","--no-sandbox","--hide-scrollbars",
        "--force-device-scale-factor=1","--window-size=1920,1080",
        f"--screenshot={os.path.abspath(OUT+'/'+name+'.png')}", "file://"+p],
        stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    print("  built", name)

def slate(name, eyebrow, title_html, sub="", bullets=None, extra=""):
    b=f'<div class="eyebrow">{eyebrow}</div><div class="logo">Screen<b>Tinker</b></div><div class="pad"><h1>{title_html}</h1>'
    if sub: b+=f'<div class="sub">{sub}</div>'
    if bullets: b+='<ul>'+''.join(f'<li>{x}</li>' for x in bullets)+'</ul>'
    b+=extra+'</div>'; render(name,b)

def terminal(name, eyebrow, title, lines):
    body='\n'.join(lines)
    b=(f'<div class="eyebrow">{eyebrow}</div><div class="logo">Screen<b>Tinker</b></div>'
       f'<div class="pad"><div class="term"><div class="tbar"><span class="dot r"></span>'
       f'<span class="dot y"></span><span class="dot g"></span><span class="ttl">{title}</span></div>'
       f'<div class="tbody">{body}</div></div></div>')
    render(name,b)

# S02 what you need
slate("s02","01 · What you need",'What you <span class="hl">need</span>',
      bullets=['A <b>Raspberry Pi</b> <span class="k">— 4 or 5</span>','A <b>microSD card</b> <span class="k">— 8GB+</span>',
               'Any screen with <b>HDMI</b>','A <b>ScreenTinker</b> server <span class="k">— free plan or self-host</span>'])
# S03 flash
slate("s03","02 · Flash the card",'Flash <span class="hl">Raspberry Pi OS</span>',
      bullets=['Open <b>Raspberry Pi Imager</b>','Choose <b>Raspberry Pi OS Lite</b> <span class="k">(no desktop needed)</span>',
               'Select your <b>SD card</b>','Click <b>Write</b> <span class="k">— done in ~2 min</span>'])
# S04 boot terminal (clean, real Pi boot style)
terminal("s04","03 · First boot","Raspberry Pi 4 Model B — serial console",[
 '<span class="dim">[    0.000000]</span> Booting Linux on physical CPU 0x0',
 '<span class="dim">[    0.000000]</span> Linux version 6.6.31+rpt-rpi-v8',
 '<span class="dim">[    0.000000]</span> Machine model: <span class="hdr">Raspberry Pi 4 Model B</span>',
 '<span class="dim">[    1.990]</span> mmcblk0: SC32G 29.7 GiB',
 '<span class="dim">[    2.326]</span> EXT4-fs (mmcblk0p2): mounted filesystem',
 '<span class="dim">[    2.384]</span> Run /sbin/init as init process',
 '<span class="dim">[    6.95 ]</span> systemd[1]: systemd 252 running in system mode',
 '',
 'Raspberry Pi OS Lite',
 'raspberrypi login: <span class="pmt">pi</span>',
])
# S05 installer terminal (hero command)
terminal("s05","04 · One command","pi@raspberrypi: ~",[
 '<span class="pmt">pi@raspberrypi</span>:~ $ <span class="cmd">curl -sSL screentinker.com/scripts/\\</span>',
 '<span class="cmd">      raspberry-pi-setup.sh | sudo bash</span>',
 '',
 '<span class="st">[ScreenTinker]</span> Detected: Pi OS Lite (headless)',
 '<span class="st">[ScreenTinker]</span> Installing kiosk packages...',
 '<span class="st">[ScreenTinker]</span> Creating kiosk service...',
 '<span class="ok">Created symlink screentinker-kiosk.service</span>',
 '<span class="st">[ScreenTinker]</span> Configuring auto-login...',
 '<span class="st">[ScreenTinker]</span> <span class="ok">Setup Complete!</span>',
])
# S06 what it sets up
slate("s06","05 · Zero config",'The installer <span class="hl">does it all</span>',
      bullets=['<b>Chromium kiosk</b> — player launches full-screen','<b>Auto-login</b> on boot',
               '<b>Auto-restart</b> service — never goes down','<b>No screen blanking</b> — your sign stays lit'])
# S08 pair
slate("s08","07 · Pair it",'Enter the code, <span class="hl">claim the screen</span>',
      bullets=['Open your <b>ScreenTinker dashboard</b>','Click <b>Add Display</b>','Type the <b>pairing code</b>',
               'The Pi appears <span class="k">— Online</span>'])
# S09 content
slate("s09","08 · Push content",'Publish, and it\'s <span class="hl">live</span>',
      bullets=['Upload media, build a <b>playlist</b>, hit <b>Publish</b>','Updates on the Pi <span class="k">in seconds</span>',
               '<b>Schedule</b> by time of day','<b>Multi-zone</b> layouts &amp; <b>video walls</b>'])
# S10 CTA
slate("s10","","<span class='hl'>Free</span> digital signage,<br>on your own hardware.",
      sub="Open source · Self-hosted · No per-screen fees",
      extra='<div class="links">🌐 <span class="u">screentinker.com</span><br>⭐ <span class="u">github.com/screentinker/screentinker</span></div>')

# S01 / S07 use the real player screenshot
for s in ("s01","s07"):
    shutil.copy("/home/owner/pi-qemu-proto/kiosk-player-shot.png", f"{OUT}/{s}.png")
    print("  used player screenshot for", s)
print("scenes built")
