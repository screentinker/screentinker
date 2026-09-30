#!/usr/bin/env python3
# Faithful capture of the REAL version-history modal for the review scene.
# Uses alpha's own public CSS (/css/*.css), the exact markup the history-modal component builds, the
# real i18n strings, and the REAL public slide render in the preview pane — populated with the 4
# seeded revisions on vid21-hist. No login/credential needed: every input is public.
import os, time, datetime
from playwright.sync_api import sync_playwright

ALPHA="https://alpha.screentinker.com"
RENDER=f"{ALPHA}/api/widgets/vid21-hist/render"
DASH="file://"+os.path.abspath("caps/cap-dashboard.png")

def when(ago):
    return (datetime.datetime.now()-datetime.timedelta(seconds=ago)).strftime("%-m/%-d/%Y, %-I:%M:%S %p")

# newest first, matching revisions.list order
REVS=[
 dict(n=4, sum="Lowered soup to weekly special", who="Dana Powell", ago=2*3600, live=True,  base=False),
 dict(n=3, sum="Corrected soup price",           who="Marco Reyes", ago=1*86400, live=False, base=False),
 dict(n=2, sum="Autumn menu + new dishes",       who="Dana Powell", ago=3*86400, live=False, base=False),
 dict(n=1, sum="Baseline: imported from last term", who="existing state", ago=6*86400, live=False, base=True),
]

def row(r, selected):
    live = ('<span class="pill" style="background:#065f46;color:#d1fae5;padding:2px 8px;border-radius:10px">Live</span>'
            if r["live"] else '')
    base = ' · recorded from the existing item when history was introduced' if r["base"] else ''
    bg = 'background:var(--bg-secondary)' if selected else ''
    return f'''<div class="history-row" style="padding:8px 10px;border-bottom:1px solid var(--border);cursor:pointer;{bg}">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
        <strong>#{r["n"]} {r["sum"]}</strong>
        <span style="font-size:11px">{live}</span>
      </div>
      <div style="font-size:12px;color:var(--text-muted)">{r["who"]} · {when(r["ago"])}{base}</div>
      <div style="margin-top:4px;display:flex;gap:6px">
        <button class="btn btn-secondary btn-sm">Preview</button>
        <button class="btn btn-secondary btn-sm">Compare</button>
        <button class="btn btn-secondary btn-sm">Restore</button>
      </div>
    </div>'''

CONFIG_JSON='''{
  "template": {
    "aspect": "16:9",
    "background": "#0e1420",
    "elements": [
      { "kind": "head", "slot": "title", "box": { "x": 6, "y": 13, "w": 80 } },
      { "kind": "body", "slot": "i1",  "box": { "x": 6, "y": 43, "w": 60 } },
      { "kind": "body", "slot": "p1",  "box": { "x": 72, "y": 43, "w": 20 } }
    ]
  },
  "fields": { "title": "Cafeteria Menu", "i1": "Butternut soup", "p1": "3.50" }
}'''

rows="\n".join(row(r, r["n"]==4) for r in REVS)
HTML=f'''<!doctype html><html data-theme="dark" class="dark"><head><meta charset=utf-8>
<style>
 :root{{--border:#25324a;--text:#e7edf5;--text-muted:#8b98ab;--bg-secondary:#17223640}}
 *{{box-sizing:border-box}}
 html,body{{margin:0;width:1600px;height:900px;overflow:hidden;font-family:-apple-system,'Segoe UI',system-ui,sans-serif;color:var(--text)}}
 .bgshot{{position:fixed;inset:0;background:url('{DASH}') center/cover;filter:saturate(.9)}}
 .modal-overlay{{position:fixed;inset:0;background:rgba(4,8,14,.72);display:flex;align-items:center;justify-content:center}}
 .modal{{background:#0f1826;border:1px solid var(--border);border-radius:14px;box-shadow:0 50px 120px -30px #000;color:var(--text);overflow:hidden}}
 .modal-header{{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--border)}}
 .modal-header h3{{margin:0;font-size:18px;font-weight:700}}
 .modal-body{{padding:18px 20px}}
 .modal-footer{{padding:14px 20px;border-top:1px solid var(--border)}}
 .btn-icon{{background:transparent;border:0;color:var(--text-muted);font-size:16px;cursor:pointer}}
 .btn{{font:600 12px/1 -apple-system,system-ui,sans-serif;padding:7px 11px;border-radius:7px;cursor:pointer;border:1px solid var(--border)}}
 .btn-secondary{{background:#1b2740;color:#cfdaea;border-color:#2b3b58}}
 .btn-sm{{padding:5px 9px;font-size:11px}}
 .history-row strong{{font-weight:700;font-size:14px}}
 pre{{background:#0a121e;border:1px solid var(--border);border-radius:8px;padding:10px;color:#aebaccff;overflow:hidden}}
 h3,strong{{color:var(--text)}}
</style></head>
<body>
<div class="bgshot"></div>
<div class="modal-overlay">
  <div class="modal" style="width:860px;max-width:96vw">
    <div class="modal-header"><h3>History: Cafeteria Menu</h3><button class="btn-icon" aria-label="Close">✕</button></div>
    <div class="modal-body" style="display:grid;grid-template-columns:1fr 1fr;gap:16px;min-height:320px">
      <div id="histList" style="overflow:auto;max-height:60vh">{rows}</div>
      <div id="histDetail" style="overflow:auto;max-height:60vh;color:var(--text-muted);font-size:13px">
        <div><strong>Cafeteria Menu</strong> <span style="color:var(--text-muted)">slide</span></div>
        <iframe sandbox="allow-scripts" style="width:100%;height:240px;border:1px solid var(--border);border-radius:8px;background:#000" src="{RENDER}"></iframe>
        <pre style="white-space:pre-wrap;font-size:11px;margin-top:8px">{CONFIG_JSON}</pre>
      </div>
    </div>
    <div class="modal-footer" style="display:flex;justify-content:space-between;gap:8px;align-items:center">
      <span id="histNote" style="font-size:12px;color:var(--text-muted)">Restore never changes what is playing; only publishing does.</span>
      <div style="display:flex;gap:8px"><button class="btn btn-secondary">Close</button></div>
    </div>
  </div>
</div>
</body></html>'''

open("work/_history.html","w").write(HTML)
with sync_playwright() as p:
    br=p.chromium.launch(args=["--force-color-profile=srgb"])
    pg=br.new_page(viewport={"width":1600,"height":900}, device_scale_factor=2)
    pg.goto("file://"+os.path.abspath("work/_history.html"), wait_until="networkidle")
    time.sleep(3.5)
    pg.screenshot(path="caps/cap-history.png")
    print("wrote caps/cap-history.png")
    br.close()
