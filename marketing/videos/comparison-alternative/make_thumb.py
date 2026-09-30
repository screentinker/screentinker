from playwright.sync_api import sync_playwright
import os
BASE = os.path.dirname(os.path.abspath(__file__))

# Thumbnail for the "free alternative to Yodeck / ScreenCloud / OptiSigns" video.
# Money shot = a mini price-bar comparison (tall paid bars vs a short green one) — instantly readable
# at small size. Competitor names sit ON the bars (factual, nominative use; no logos).
def bar(name, amt, pct, cls, delay=0):
    return (f"<div class='brow'><div class='blab'>{name}</div>"
            f"<div class='btrack'><div class='bf {cls}' style='width:{pct}%'></div></div>"
            f"<div class='bamt {cls}'>{amt}</div></div>")

BARS = (bar("ScreenCloud","$300+",100,"paid")
      + bar("OptiSigns","$165",55,"paid")
      + bar("Yodeck","$120",40,"paid")
      + bar("ScreenTinker","$0*",14,"st"))

HTML = f"""<!doctype html><meta charset=utf-8><style>
*{{margin:0;box-sizing:border-box;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif}}
html,body{{width:1280px;height:720px;overflow:hidden}}
.wrap{{width:1280px;height:720px;position:relative;
 background:radial-gradient(900px 620px at 84% 55%, #143a55, transparent 62%),
            radial-gradient(700px 520px at 4% 108%, #34d39926, transparent 60%),
            linear-gradient(135deg,#0b1220,#0e1a2e 60%,#0a1626)}}
.text{{position:absolute;left:60px;top:70px;width:600px}}
.eyebrow{{font:800 25px sans-serif;letter-spacing:.2em;color:#34d399;text-transform:uppercase;margin-bottom:12px}}
.free{{font-weight:900;font-size:184px;line-height:.82;color:#ffd43b;letter-spacing:-6px;
 text-shadow:0 6px 0 #b8860020, 0 0 40px #ffd43b30;-webkit-text-stroke:3px #1a1200}}
.sig{{font-weight:900;font-size:80px;line-height:.95;color:#fff;letter-spacing:-2px;margin-top:6px;
 text-shadow:0 4px 22px #0008}}
.tag{{margin-top:26px;font:800 38px sans-serif;color:#cfe0f0}}
.tag b{{color:#34d399}}
.badge{{position:absolute;left:470px;top:20px;width:150px;height:150px;border-radius:50%;
 background:radial-gradient(circle at 40% 35%,#3ee89f,#1f9e6b);box-shadow:0 12px 40px #1f9e6b66,0 0 0 8px #ffffff14;
 display:flex;flex-direction:column;align-items:center;justify-content:center;transform:rotate(-11deg);color:#052018;z-index:5}}
.badge .z{{font:900 60px sans-serif;line-height:.8}}
.badge .m{{font:800 20px sans-serif;letter-spacing:.02em;margin-top:4px}}
.badge .t{{position:absolute;top:-15px;font:800 18px sans-serif;background:#0e1a2e;color:#ffd43b;
 padding:4px 12px;border-radius:20px;letter-spacing:.08em;transform:rotate(11deg)}}
/* price-bar comparison card */
.card{{position:absolute;right:48px;top:150px;width:560px;background:#0b1220dd;border:1px solid #23384a;
 border-radius:22px;padding:30px 34px 26px;box-shadow:0 40px 90px -30px #000;transform:rotate(-2deg)}}
.card h4{{font:800 24px sans-serif;color:#9fb3c8;letter-spacing:.03em;margin-bottom:22px}}
.card h4 b{{color:#fff}}
.brow{{display:flex;align-items:center;gap:16px;margin:16px 0}}
.blab{{width:186px;text-align:right;font:800 30px sans-serif;color:#e6ecf3;flex:0 0 auto}}
.btrack{{flex:1;height:34px;background:#0a1017;border:1px solid #1b2536;border-radius:9px;overflow:hidden}}
.bf{{height:100%;border-radius:8px}}
.bf.paid{{background:linear-gradient(90deg,#f5b23c,#f2565b)}}
.bf.st{{background:linear-gradient(90deg,#34d399,#2bb98a)}}
.bamt{{width:96px;flex:0 0 auto;font:900 30px ui-monospace,monospace}}
.bamt.paid{{color:#f5b23c}}.bamt.st{{color:#34d399}}
.foot{{margin-top:16px;font:700 19px sans-serif;color:#7b8aa0}}
.logo{{position:absolute;left:60px;bottom:36px;font:900 34px sans-serif;color:#8aa}}
.logo b{{color:#34d399}}
.sub{{position:absolute;left:60px;bottom:14px;font:700 18px sans-serif;color:#5f6f80}}
</style>
<div class=wrap>
 <div class=text>
   <div class=eyebrow>Open-Source Signage</div>
   <div class=free>FREE</div>
   <div class=sig>DIGITAL SIGNAGE</div>
   <div class=tag>no <b>per-screen</b> fees</div>
 </div>
 <div class=badge><span class=t>SELF-HOST</span><span class=z>$0</span><span class=m>per screen</span></div>
 <div class=card>
   <h4>15 screens · <b>$ / month</b></h4>
   {BARS}
   <div class=foot>vs Yodeck · ScreenCloud · OptiSigns</div>
 </div>
 <div class=logo>Screen<b>Tinker</b></div>
 <div class=sub>* self-hosted — server cost only</div>
</div>"""
open(f"{BASE}/thumb.html","w").write(HTML)
with sync_playwright() as p:
    br=p.chromium.launch()
    pg=br.new_page(viewport={"width":1280,"height":720},device_scale_factor=2)
    pg.goto("file://"+BASE+"/thumb.html",wait_until="networkidle"); pg.wait_for_timeout(300)
    pg.screenshot(path=f"{BASE}/thumbnail.png",clip={"x":0,"y":0,"width":1280,"height":720})
    br.close()
print("wrote thumbnail.png (2560x1440)")
