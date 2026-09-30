from playwright.sync_api import sync_playwright
import os
BASE = os.path.dirname(os.path.abspath(__file__))

# CSS-drawn streaming stick (Fire TV style) — no Amazon branding: black stick body + HDMI plug + green LED.
STICK = """<svg width="132" height="58" viewBox="0 0 132 58">
<rect x="26" y="14" width="92" height="30" rx="15" fill="#15171c" stroke="#2a2f38" stroke-width="2"/>
<rect x="6" y="22" width="22" height="14" rx="2.5" fill="#8792a3"/>
<rect x="1" y="25" width="6" height="8" rx="1.5" fill="#6b7480"/>
<circle cx="96" cy="29" r="6" fill="#34d399"/></svg>"""

HTML = f"""<!doctype html><meta charset=utf-8><style>
*{{margin:0;box-sizing:border-box;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif}}
html,body{{width:1280px;height:720px;overflow:hidden}}
.wrap{{width:1280px;height:720px;position:relative;
 background:radial-gradient(900px 620px at 82% 60%, #143a55, transparent 62%),
            radial-gradient(700px 520px at 6% 108%, #34d39926, transparent 60%),
            linear-gradient(135deg,#0b1220,#0e1a2e 60%,#0a1626)}}
.text{{position:absolute;left:64px;top:96px;width:660px}}
.eyebrow{{font:800 26px sans-serif;letter-spacing:.24em;color:#34d399;text-transform:uppercase;margin-bottom:10px}}
.free{{font-weight:900;font-size:200px;line-height:.82;color:#ffd43b;letter-spacing:-6px;
 text-shadow:0 6px 0 #b8860020, 0 0 40px #ffd43b30;-webkit-text-stroke:3px #1a1200}}
.sig{{font-weight:900;font-size:92px;line-height:.95;color:#fff;letter-spacing:-2px;margin-top:4px;
 text-shadow:0 4px 22px #0008}}
.pi{{display:flex;align-items:center;gap:16px;margin-top:26px;font:800 40px sans-serif;color:#cfe0f0}}
.pi b{{color:#fff}}
.badge{{position:absolute;left:812px;top:6px;width:168px;height:168px;border-radius:50%;
 background:radial-gradient(circle at 40% 35%,#ff5b6e,#d61f3c);box-shadow:0 12px 40px #d61f3c66,0 0 0 8px #ffffff14;
 display:flex;flex-direction:column;align-items:center;justify-content:center;transform:rotate(-12deg);color:#fff;z-index:5}}
.badge .z{{font:900 66px sans-serif;line-height:.8}}
.badge .m{{font:800 23px sans-serif;letter-spacing:.05em;margin-top:2px}}
.badge .t{{position:absolute;top:-16px;font:800 20px sans-serif;background:#0e1a2e;color:#ffd43b;
 padding:4px 12px;border-radius:20px;letter-spacing:.1em;transform:rotate(12deg)}}
.mon{{position:absolute;right:56px;top:150px;width:520px;transform:rotate(-3deg)}}
.screen{{width:520px;height:300px;border-radius:14px;border:14px solid #10151d;
 box-shadow:0 30px 70px -14px #000c, 0 0 0 2px #2a3543;overflow:hidden;position:relative;
 background:linear-gradient(150deg,#2b1d16,#3a2a1e)}}
.sc-in{{position:absolute;inset:0;padding:26px 30px;color:#f4e9dd;display:flex;flex-direction:column}}
.sc-h{{font:900 40px sans-serif;color:#e8b579;letter-spacing:.5px}}
.sc-t{{font:700 17px sans-serif;color:#b79a80;text-transform:uppercase;letter-spacing:.2em;margin:2px 0 16px}}
.row{{display:flex;justify-content:space-between;font:700 26px sans-serif;margin:7px 0}}
.row span:last-child{{color:#e8b579}}
.hh{{margin-top:auto;background:#e8b579;color:#2b1d16;font:800 19px sans-serif;padding:8px 14px;border-radius:8px;align-self:flex-start}}
.stand{{width:120px;height:20px;background:#10151d;border-radius:0 0 8px 8px;margin:0 auto}}
.neck{{width:26px;height:34px;background:#10151d;margin:0 auto}}
.live{{position:absolute;top:16px;right:16px;background:#e5484d;color:#fff;font:800 15px sans-serif;
 padding:5px 12px;border-radius:20px;letter-spacing:.08em;display:flex;align-items:center;gap:7px}}
.live::before{{content:"";width:9px;height:9px;background:#fff;border-radius:50%}}
.chip{{position:absolute;right:104px;bottom:36px;display:flex;align-items:center;gap:16px;
 background:#0c1420cc;border:1px solid #24343f;border-radius:16px;padding:14px 24px 14px 18px;backdrop-filter:blur(2px)}}
.chip .lbl{{font:800 30px sans-serif;color:#fff;line-height:1}}
.chip .lbl small{{display:block;font:700 17px sans-serif;color:#8fb8ef;letter-spacing:.05em;margin-top:5px}}
.logo{{position:absolute;left:64px;bottom:42px;font:900 34px sans-serif;color:#8aa}}
.logo b{{color:#34d399}}
</style>
<div class=wrap>
 <div class=text>
   <div class=eyebrow>Open Source · Self-Hosted</div>
   <div class=free>FREE</div>
   <div class=sig>DIGITAL<br>SIGNAGE</div>
   <div class=pi>{STICK}<span>on <b>Fire&nbsp;TV</b> &amp; <b>Android&nbsp;TV</b></span></div>
 </div>
 <div class=badge><span class=z>$0</span><span class=m>/month</span></div>
 <div class=mon>
   <div class=screen>
     <div class=live>LIVE</div>
     <div class=sc-in>
       <div class=sc-h>The Daily Grind ☕</div>
       <div class=sc-t>Today's Menu</div>
       <div class=row><span>Flat White</span><span>$4.50</span></div>
       <div class=row><span>Cold Brew</span><span>$5.00</span></div>
       <div class=row><span>Avocado Toast</span><span>$8.25</span></div>
       <div class=hh>Happy Hour · 20% off</div>
     </div>
   </div>
   <div class=neck></div><div class=stand></div>
 </div>
 <div class=chip>{STICK}<div class=lbl>Sideload &amp; pair<small>≈ 3 minutes</small></div></div>
 <div class=logo>Screen<b>Tinker</b></div>
</div>"""
open(f"{BASE}/thumb.html","w").write(HTML)
with sync_playwright() as p:
    br=p.chromium.launch()
    pg=br.new_page(viewport={"width":1280,"height":720},device_scale_factor=2)
    pg.goto("file://"+BASE+"/thumb.html",wait_until="networkidle"); pg.wait_for_timeout(300)
    pg.screenshot(path=f"{BASE}/thumbnail.png",clip={"x":0,"y":0,"width":1280,"height":720})
    br.close()
print("wrote thumbnail.png (2560x1440)")
