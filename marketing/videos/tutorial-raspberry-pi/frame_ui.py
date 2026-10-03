import os
from playwright.sync_api import sync_playwright
BASE="/home/owner/screentinker-video"

# ---- shared brand frame (1920x1080) ----
FRAME_CSS = """
*{margin:0;padding:0;box-sizing:border-box;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,sans-serif}
html,body{width:1920px;height:1080px;overflow:hidden;background:#0e1420;color:#e6ecf3}
.bg{position:absolute;inset:0;background:
  radial-gradient(1200px 700px at 50% -8%, #17324a55, transparent 60%),
  radial-gradient(900px 600px at 88% 110%, #34d39914, transparent 60%),#0e1420}
.eyebrow{position:absolute;top:60px;left:120px;font:800 26px sans-serif;letter-spacing:5px;
  text-transform:uppercase;color:#34d399;display:flex;align-items:center;gap:16px}
.eyebrow::before{content:"";width:46px;height:4px;background:#34d399;border-radius:3px}
.logo{position:absolute;top:58px;right:120px;font:800 30px sans-serif;color:#8aa}.logo b{color:#34d399}
.win{position:absolute;left:50%;top:150px;transform:translateX(-50%);width:1560px;
  border-radius:16px;overflow:hidden;background:#0d1117;
  box-shadow:0 40px 90px -20px #000c,0 0 0 1px #232c38}
.bar{height:52px;background:linear-gradient(#1b232e,#141b24);display:flex;align-items:center;
  padding:0 20px;gap:9px;border-bottom:1px solid #232c38}
.dot{width:14px;height:14px;border-radius:50%}
.d1{background:#ff5f56}.d2{background:#ffbd2e}.d3{background:#27c93f}
.url{margin:0 auto;background:#0e141b;border:1px solid #2a3441;color:#9fb0c0;font-size:22px;
  padding:8px 30px;border-radius:9px;display:flex;align-items:center;gap:12px}
.shot{display:block;width:1560px;height:877px;object-fit:cover;object-position:top center}
.cap{position:absolute;bottom:44px;left:50%;transform:translateX(-50%);font-size:30px;color:#9aa7b8;
  text-align:center;letter-spacing:.3px}
.cap b{color:#e6ecf3;font-weight:700}
"""

def browser_scene(sid, eyebrow, url, shot, caption):
    html=f"""<!doctype html><meta charset=utf-8><style>{FRAME_CSS}</style><div class=bg></div>
<div class=eyebrow>{eyebrow}</div><div class=logo>Screen<b>Tinker</b></div>
<div class=win><div class=bar><span class="dot d1"></span><span class="dot d2"></span><span class="dot d3"></span>
<span class=url>🔒 {url}</span></div><img class=shot src="file://{BASE}/{shot}"></div>
<div class=cap>{caption}</div>"""
    p=f"{BASE}/frame-{sid}.html"; open(p,"w").write(html); return p

# ---- Raspberry Pi Imager recreation (scene 03) ----
IMAGER_CSS = FRAME_CSS + """
.iwin{position:absolute;left:50%;top:170px;transform:translateX(-50%);width:1180px;height:720px;
  border-radius:16px;overflow:hidden;box-shadow:0 40px 90px -20px #000c,0 0 0 1px #232c38}
.ibar{height:46px;background:linear-gradient(#efefef,#e4e4e4);display:flex;align-items:center;
  padding:0 18px;gap:9px;border-bottom:1px solid #cfcfcf}
.ibar .t{margin-left:14px;color:#555;font-size:20px;font-weight:600}
.ibody{height:674px;background:radial-gradient(120% 120% at 50% 0%,#fbfbfb,#e9e9ea 70%,#dcdcde);
  display:flex;flex-direction:column;align-items:center;padding-top:34px;position:relative}
.rasp{width:96px;height:104px;margin-bottom:26px}
.cols{display:flex;gap:40px;margin-top:6px}
.col{display:flex;flex-direction:column;align-items:center;gap:14px;width:320px}
.lbl{color:#6a6a6a;font-size:22px;font-weight:600;letter-spacing:.3px}
.btn{width:320px;height:96px;background:#fff;border:1px solid #d0d0d0;border-radius:10px;
  box-shadow:0 2px 5px #0000000f;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:6px;cursor:default}
.btn .big{font-size:26px;font-weight:700;color:#c51a4a}
.btn .sel{font-size:24px;font-weight:700;color:#20222a}
.btn .sub2{font-size:17px;color:#7a7f88}
.next{position:absolute;right:56px;bottom:44px;background:#c51a4a;color:#fff;font-size:26px;
  font-weight:700;letter-spacing:1px;padding:16px 54px;border-radius:10px;box-shadow:0 6px 16px #c51a4a55}
.gear{position:absolute;left:44px;bottom:46px;font-size:30px;color:#8a8a8a}
.ver{position:absolute;left:88px;bottom:50px;font-size:19px;color:#9a9a9a}
"""
RASP_SVG = """<svg class=rasp viewBox="0 0 100 108">
<g fill="#6cbb3c"><ellipse cx="38" cy="16" rx="15" ry="9" transform="rotate(-35 38 16)"/>
<ellipse cx="62" cy="16" rx="15" ry="9" transform="rotate(35 62 16)"/></g>
<g fill="#c51a4a">
<circle cx="50" cy="40" r="12"/><circle cx="36" cy="50" r="12"/><circle cx="64" cy="50" r="12"/>
<circle cx="28" cy="66" r="12"/><circle cx="50" cy="60" r="12"/><circle cx="72" cy="66" r="12"/>
<circle cx="38" cy="80" r="12"/><circle cx="62" cy="80" r="12"/><circle cx="50" cy="92" r="12"/>
</g></svg>"""

def imager_scene():
    html=f"""<!doctype html><meta charset=utf-8><style>{IMAGER_CSS}</style><div class=bg></div>
<div class=eyebrow>02 · Flash the card</div><div class=logo>Screen<b>Tinker</b></div>
<div class=iwin>
 <div class=ibar><span class="dot d1"></span><span class="dot d2"></span><span class="dot d3"></span>
   <span class=t>Raspberry Pi Imager v1.8.5</span></div>
 <div class=ibody>
   {RASP_SVG}
   <div class=cols>
     <div class=col><div class=lbl>Raspberry Pi Device</div>
       <div class=btn><span class=sel>RASPBERRY PI 4</span></div></div>
     <div class=col><div class=lbl>Operating System</div>
       <div class=btn><span class=sel>Raspberry Pi OS Lite</span><span class=sub2>64-bit · no desktop</span></div></div>
     <div class=col><div class=lbl>Storage</div>
       <div class=btn><span class=sel>SDHC Card</span><span class=sub2>31.9 GB</span></div></div>
   </div>
   <div class=ver>v1.8.5</div>
   <div class=next>WRITE</div>
 </div>
</div>
<div class=cap>Raspberry Pi OS <b>Lite</b> — no desktop needed. Pick your card and write.</div>"""
    p=f"{BASE}/frame-03.html"; open(p,"w").write(html); return p

jobs=[
  ("03", imager_scene()),
  ("08", browser_scene("08","07 · Pair it","app.screentinker.com/app","cap-add-display.png",
        "Click <b>Add Display</b>, enter the pairing code — it's yours.")),
  ("09", browser_scene("09","08 · It's live","app.screentinker.com/app","cap-displays.png",
        "Your fleet, online and under control — content live in seconds.")),
]
os.makedirs(f"{BASE}/scenes",exist_ok=True)
with sync_playwright() as p:
    br=p.chromium.launch(args=["--allow-file-access-from-files"])
    pg=br.new_page(viewport={"width":1920,"height":1080},device_scale_factor=2)
    for sid,path in jobs:
        pg.goto("file://"+path, wait_until="networkidle")
        pg.wait_for_timeout(400)
        pg.screenshot(path=f"{BASE}/scenes/s{sid}.png", clip={"x":0,"y":0,"width":1920,"height":1080})
        print("rendered scenes/s"+sid+".png")
    br.close()
print("DONE")
