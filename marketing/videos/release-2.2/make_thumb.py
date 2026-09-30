from playwright.sync_api import sync_playwright
import os
BASE = os.path.dirname(os.path.abspath(__file__))

# Thumbnail for "ScreenTinker 2.2".
# Money shot = the version number, huge, with the REAL token list behind glass on the right: two
# scopes, side by side, which is the whole claim of the release. Readable at 210px wide, which is
# where most impressions are actually served.
SHOT = "file://" + os.path.join(BASE, "caps", "cap-tokens-card.png")

HTML = f"""<!doctype html><meta charset=utf-8><style>
*{{margin:0;box-sizing:border-box;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif}}
html,body{{width:1280px;height:720px;overflow:hidden}}
.wrap{{width:1280px;height:720px;position:relative;
 background:radial-gradient(900px 620px at 86% 52%, #143a55, transparent 62%),
            radial-gradient(700px 520px at 2% 106%, #34d39926, transparent 60%),
            linear-gradient(135deg,#0b1220,#0e1a2e 60%,#0a1626)}}
.text{{position:absolute;left:58px;top:96px;width:640px;z-index:4}}
.eyebrow{{font:800 26px sans-serif;letter-spacing:.2em;color:#34d399;text-transform:uppercase;margin-bottom:10px}}
.ver{{font-weight:900;font-size:210px;line-height:.8;color:#34d399;letter-spacing:-10px;
 text-shadow:0 0 60px #34d39944;-webkit-text-stroke:3px #04140e}}
.name{{font-weight:900;font-size:66px;line-height:.98;color:#fff;letter-spacing:-2px;margin-top:14px;
 text-shadow:0 4px 22px #0008}}
.tag{{margin-top:22px;font:800 34px sans-serif;color:#cfe0f0;line-height:1.25}}
.tag b{{color:#34d399}}
/* the editor, behind glass */
.shot{{position:absolute;right:-40px;top:104px;width:660px;height:412px;border-radius:20px;
 border:1px solid #23384a;box-shadow:0 50px 110px -30px #000;overflow:hidden;transform:rotate(-3deg);z-index:2;
 background-image:url('{SHOT}');background-size:contain;background-repeat:no-repeat;background-position:center;background-color:#0d1522}}
.shot::after{{content:"";position:absolute;inset:0;
 background:linear-gradient(105deg,#0b122055 0%,transparent 42%)}}
.pills{{position:absolute;right:40px;bottom:96px;z-index:5;display:flex;gap:12px;flex-wrap:wrap;
 width:640px;justify-content:flex-end}}
.pill{{font:900 27px ui-monospace,monospace;color:#04140e;background:#34d399;padding:9px 18px;border-radius:12px;
 box-shadow:0 16px 34px -12px #000}}
.pill.b{{background:#5aa0ff}}
.logo{{position:absolute;left:58px;bottom:34px;font:900 34px sans-serif;color:#8aa;z-index:5}}
.logo b{{color:#34d399}}
.sub{{position:absolute;left:58px;bottom:34px;font:700 22px sans-serif;color:#7b8aa0;z-index:5}}
</style>
<div class='wrap'>
  <div class='shot'></div>
  <div class='text'>
    <div class='eyebrow'>Open source · self-hosted</div>
    <div class='ver'>2.2</div>
    <div class='name'>ScreenTinker</div>
    <div class='tag'>Point an <b>AI assistant</b><br>at your own screens</div>
  </div>
  <div class='pills'>
    <span class='pill'>MCP</span>
    <span class='pill'>21 TOOLS</span>
    <span class='pill b'>SCOPED</span>
  </div>
  <div class='sub'>MIT licensed · no per-screen fees · runs on hardware you own</div>
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
