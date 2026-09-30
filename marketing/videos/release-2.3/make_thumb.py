from playwright.sync_api import sync_playwright
import os
BASE = os.path.dirname(os.path.abspath(__file__))

# Thumbnail for "ScreenTinker 2.3".
# Money shot = the version number, huge, with two REAL renders on the right: the menu board that the
# live-data hook changes, and UPTIME 3036 overlapping it (the game is the surprise of the release).
# The bottom line leads with the hosted TRIAL — "we want people to buy it" — self-hosting second.
# Readable at 210px wide, which is where most impressions are actually served.
MENU = "file://" + os.path.join(BASE, "caps", "cap-menu-after.png")
GAME = "file://" + os.path.join(BASE, "caps", "game-still.png")

HTML = f"""<!doctype html><meta charset=utf-8><style>
*{{margin:0;box-sizing:border-box;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif}}
html,body{{width:1280px;height:720px;overflow:hidden}}
.wrap{{width:1280px;height:720px;position:relative;
 background:radial-gradient(900px 620px at 86% 52%, #143a55, transparent 62%),
            radial-gradient(700px 520px at 2% 106%, #34d39926, transparent 60%),
            linear-gradient(135deg,#0b1220,#0e1a2e 60%,#0a1626)}}
.text{{position:absolute;left:58px;top:78px;width:600px;z-index:4}}
.eyebrow{{font:800 26px sans-serif;letter-spacing:.2em;color:#34d399;text-transform:uppercase;margin-bottom:10px}}
.ver{{font-weight:900;font-size:220px;line-height:.8;color:#34d399;letter-spacing:-10px;
 text-shadow:0 0 60px #34d39944;-webkit-text-stroke:3px #04140e}}
.name{{font-weight:900;font-size:66px;line-height:.98;color:#fff;letter-spacing:-2px;margin-top:14px;
 text-shadow:0 4px 22px #0008}}
.tag{{margin-top:20px;font:800 38px sans-serif;color:#cfe0f0;line-height:1.2}}
.tag b{{color:#34d399}}
.card{{position:absolute;border-radius:18px;border:2px solid #23384a;box-shadow:0 50px 110px -30px #000;overflow:hidden;
 background-size:cover;background-position:center;background-color:#0d1522}}
.menu{{right:-30px;top:70px;width:640px;height:360px;transform:rotate(-3deg);z-index:2;background-image:url('{MENU}')}}
.game{{right:250px;top:330px;width:440px;height:248px;transform:rotate(4deg);z-index:3;background-image:url('{GAME}');
 border-color:#ff3fae88;box-shadow:0 40px 90px -20px #000,0 0 50px -8px #ff3fae66}}
.gtag{{position:absolute;right:262px;top:560px;z-index:6;transform:rotate(4deg);font:900 26px ui-monospace,monospace;
 color:#fff;background:#ff3fae;padding:7px 16px;border-radius:10px;box-shadow:0 14px 30px -10px #000}}
.ltag{{position:absolute;right:36px;top:52px;z-index:6;transform:rotate(-3deg);font:900 26px ui-monospace,monospace;
 color:#04140e;background:#34d399;padding:7px 16px;border-radius:10px;box-shadow:0 14px 30px -10px #000}}
.sub{{position:absolute;left:58px;bottom:34px;font:800 26px sans-serif;color:#cfe0f0;z-index:5}}
.sub b{{color:#04140e;background:#34d399;padding:4px 12px;border-radius:8px;margin-right:10px}}
.sub span{{color:#7b8aa0;font-weight:700}}
</style>
<div class='wrap'>
  <div class='card menu'></div><div class='ltag'>LIVE DATA</div>
  <div class='card game'></div><div class='gtag'>A REAL GAME</div>
  <div class='text'>
    <div class='eyebrow'>Open-source digital signage</div>
    <div class='ver'>2.3</div>
    <div class='name'>ScreenTinker</div>
    <div class='tag'>Live data, <b>templates</b><br>&amp; a real game</div>
  </div>
  <div class='sub'><b>14-day free trial</b><span>or self-host free</span></div>
</div>"""

open(os.path.join(BASE, "thumb.html"), "w").write(HTML)
with sync_playwright() as p:
    br = p.chromium.launch(args=["--force-color-profile=srgb"])
    pg = br.new_page(viewport={"width": 1280, "height": 720}, device_scale_factor=2)
    pg.goto("file://" + os.path.join(BASE, "thumb.html"), wait_until="load")
    pg.wait_for_timeout(700)
    pg.screenshot(path=os.path.join(BASE, "thumbnail.png"))
    br.close()
sz = os.path.getsize(os.path.join(BASE, "thumbnail.png"))
print(f"thumbnail.png  {sz//1024} KB  (2560x1440 @2x)")
if sz > 2 * 1024 * 1024:
    print("  !! over YouTube's 2MB limit — re-encode before uploading")
