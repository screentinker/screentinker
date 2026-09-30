from playwright.sync_api import sync_playwright
import os
BASE = os.path.dirname(os.path.abspath(__file__))
# 2.1 thumbnail: big version number + the release's most distinctive new slide (multilingual
# room signs) behind glass. Readable at 210px wide.
SHOT = "file://" + os.path.join(BASE, "work", "thumb_shot.jpg")

HTML = f"""<!doctype html><meta charset=utf-8><style>
*{{margin:0;box-sizing:border-box;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif}}
html,body{{width:1280px;height:720px;overflow:hidden}}
.wrap{{width:1280px;height:720px;position:relative;
 background:radial-gradient(900px 620px at 86% 50%, #143a55, transparent 62%),
            radial-gradient(760px 560px at 0% 108%, #34d39926, transparent 60%),
            linear-gradient(135deg,#0b1220,#0e1a2e 60%,#0a1626)}}
.text{{position:absolute;left:58px;top:74px;width:640px;z-index:4}}
.eyebrow{{font:800 25px sans-serif;letter-spacing:.18em;color:#34d399;text-transform:uppercase;margin-bottom:6px}}
.ver{{font-weight:900;font-size:212px;line-height:.82;color:#34d399;letter-spacing:-10px;
 text-shadow:0 0 60px #34d39944;-webkit-text-stroke:3px #04140e}}
.name{{font-weight:900;font-size:70px;line-height:.98;color:#fff;letter-spacing:-2px;margin-top:10px;
 text-shadow:0 4px 22px #0008}}
.tag{{margin-top:20px;font:800 33px sans-serif;color:#cfe0f0;line-height:1.25;width:560px}}
.tag b{{color:#34d399}}
.shot{{position:absolute;right:-46px;top:120px;width:690px;height:388px;border-radius:20px;
 border:1px solid #23384a;box-shadow:0 50px 110px -30px #000;overflow:hidden;transform:rotate(-3deg);z-index:2;
 background-image:url('{SHOT}');background-size:cover;background-position:center}}
.shot::after{{content:"";position:absolute;inset:0;background:linear-gradient(105deg,#0b122066 0%,transparent 42%)}}
.pills{{position:absolute;right:40px;bottom:92px;z-index:5;display:flex;gap:12px;flex-wrap:wrap;
 width:700px;justify-content:flex-end}}
.pill{{font:900 26px ui-monospace,monospace;color:#04140e;background:#34d399;padding:9px 18px;border-radius:12px;
 box-shadow:0 16px 34px -12px #000}}
.pill.b{{background:#5aa0ff}}
.sub{{position:absolute;left:58px;bottom:32px;font:700 23px sans-serif;color:#7b8aa0;z-index:5}}
.sub b{{color:#9fb3c8}}
</style>
<div class=wrap>
  <div class=shot></div>
  <div class=text>
    <div class=eyebrow>Open source &middot; What's new</div>
    <div class=ver>2.1</div>
    <div class=name>ScreenTinker</div>
    <div class=tag>Live video, <b>plugins</b>, live data &amp; <b>room signs</b> in every language</div>
  </div>
  <div class=pills>
    <span class=pill>LIVE VIDEO</span>
    <span class=pill>PLUGINS</span>
    <span class="pill b">ROOM SIGNS</span>
  </div>
  <div class=sub>MIT licensed &middot; <b>self-hosted or hosted</b> &middot; no per-screen fees</div>
</div>"""

open(os.path.join(BASE,"thumb.html"),"w").write(HTML)
with sync_playwright() as p:
    br=p.chromium.launch(args=["--force-color-profile=srgb"])
    pg=br.new_page(viewport={"width":1280,"height":720}, device_scale_factor=2)
    pg.goto("file://"+os.path.join(BASE,"thumb.html"), wait_until="load")
    pg.wait_for_timeout(400)
    pg.screenshot(path=os.path.join(BASE,"thumbnail.png"))
    br.close()
print("wrote thumbnail.png (2560x1440)")
