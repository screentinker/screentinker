import json, os, sqlite3, time
from playwright.sync_api import sync_playwright

SSDIR="/home/owner/Downloads/remote_display/server/uploads/screenshots"
DB="/home/owner/Downloads/remote_display/server/db/remote_display.db"
ids=json.load(open("fake_devices.json"))
# order matches fake_fleet seed: Lobby, Cafe, Reception, Warehouse, Conference Room A

CSS="*{margin:0;padding:0;box-sizing:border-box;font-family:-apple-system,'Segoe UI',Roboto,sans-serif}html,body{width:960px;height:540px;overflow:hidden}"

def wrap(body,extra=""):
    return f"<!doctype html><meta charset=utf-8><style>{CSS}{extra}</style><body>{body}</body>"

SCREENS=[
# Lobby — Main Entrance
wrap("""<div style="width:960px;height:540px;background:linear-gradient(135deg,#0b1f3a,#123a6b);color:#fff;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center">
<div style="font-size:22px;letter-spacing:6px;color:#8fb8ef;text-transform:uppercase;margin-bottom:20px">Welcome to</div>
<div style="font-size:76px;font-weight:800;letter-spacing:-2px">Northwind HQ</div>
<div style="width:120px;height:4px;background:#34d399;margin:28px 0;border-radius:2px"></div>
<div style="font-size:26px;color:#cfe0f5">Please check in at Reception</div>
<div style="position:absolute;bottom:34px;font-size:20px;color:#9fbce0">Thursday · July 14 · 9:41 AM</div>
</div>"""),
# Café Menu Board
wrap("""<div style="width:960px;height:540px;background:#2b1d16;color:#f4e9dd;padding:44px 60px;display:flex;flex-direction:column">
<div style="font-size:44px;font-weight:800;color:#e8b579;letter-spacing:1px;margin-bottom:6px">The Daily Grind ☕</div>
<div style="font-size:18px;color:#b79a80;margin-bottom:28px;text-transform:uppercase;letter-spacing:3px">Today's Menu</div>
<div style="display:flex;flex-direction:column;gap:20px;font-size:28px">
<div style="display:flex;justify-content:space-between"><span>Flat White</span><span style="color:#e8b579">$4.50</span></div>
<div style="display:flex;justify-content:space-between"><span>Cold Brew</span><span style="color:#e8b579">$5.00</span></div>
<div style="display:flex;justify-content:space-between"><span>Almond Croissant</span><span style="color:#e8b579">$3.75</span></div>
<div style="display:flex;justify-content:space-between"><span>Avocado Toast</span><span style="color:#e8b579">$8.25</span></div>
</div>
<div style="margin-top:auto;background:#e8b579;color:#2b1d16;font-weight:700;font-size:20px;padding:12px 20px;border-radius:8px;align-self:flex-start">Happy Hour · 2–4 PM · 20% off</div>
</div>"""),
# Reception Desk — today's meetings
wrap("""<div style="width:960px;height:540px;background:#f6f8fb;color:#1a2233;padding:44px 56px;display:flex;flex-direction:column">
<div style="display:flex;justify-content:space-between;align-items:baseline;border-bottom:3px solid #2563eb;padding-bottom:16px;margin-bottom:26px">
<div style="font-size:38px;font-weight:800">Today's Visitors</div><div style="font-size:24px;color:#64748b">9:41 AM</div></div>
<div style="display:flex;flex-direction:column;gap:16px;font-size:23px">
<div style="display:flex;justify-content:space-between;background:#fff;padding:16px 22px;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.08)"><span><b>10:00</b> &nbsp; Acme Corp — J. Rivera</span><span style="color:#2563eb">Suite 4</span></div>
<div style="display:flex;justify-content:space-between;background:#fff;padding:16px 22px;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.08)"><span><b>11:30</b> &nbsp; Delta Labs — M. Osei</span><span style="color:#2563eb">Board Rm</span></div>
<div style="display:flex;justify-content:space-between;background:#fff;padding:16px 22px;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.08)"><span><b>14:00</b> &nbsp; Interview — Candidate</span><span style="color:#2563eb">HR · 2F</span></div>
</div>
<div style="margin-top:auto;font-size:18px;color:#94a3b8">Northwind HQ · Reception</div>
</div>"""),
# Warehouse Ops Board
wrap("""<div style="width:960px;height:540px;background:#0f1115;color:#fff;padding:36px 48px;display:flex;flex-direction:column">
<div style="font-size:34px;font-weight:800;color:#facc15;letter-spacing:1px;margin-bottom:24px">⚠ WAREHOUSE OPS</div>
<div style="display:flex;gap:20px;margin-bottom:22px">
<div style="flex:1;background:#16a34a;border-radius:12px;padding:22px;text-align:center"><div style="font-size:62px;font-weight:800">247</div><div style="font-size:16px;text-transform:uppercase;letter-spacing:2px">Days No Injury</div></div>
<div style="flex:1;background:#1e293b;border-radius:12px;padding:22px;text-align:center"><div style="font-size:62px;font-weight:800;color:#38bdf8">1,842</div><div style="font-size:16px;text-transform:uppercase;letter-spacing:2px;color:#94a3b8">Units Shipped</div></div>
</div>
<div style="display:flex;gap:20px">
<div style="flex:1;background:#1e293b;border-radius:12px;padding:20px;text-align:center"><div style="font-size:44px;font-weight:800;color:#34d399">98.6%</div><div style="font-size:15px;color:#94a3b8;text-transform:uppercase;letter-spacing:2px">On-Time</div></div>
<div style="flex:1;background:#1e293b;border-radius:12px;padding:20px;text-align:center"><div style="font-size:44px;font-weight:800;color:#facc15">Dock 3</div><div style="font-size:15px;color:#94a3b8;text-transform:uppercase;letter-spacing:2px">Next Truck 10:15</div></div>
</div>
<div style="margin-top:auto;font-size:16px;color:#64748b">Shift A · Updated just now</div>
</div>"""),
# Conference Room A — booking status
wrap("""<div style="width:960px;height:540px;background:linear-gradient(160deg,#052e2b,#0b4f42);color:#fff;display:flex;flex-direction:column;justify-content:center;padding:60px">
<div style="font-size:24px;letter-spacing:4px;text-transform:uppercase;color:#7fe7cf">Conference Room A</div>
<div style="display:flex;align-items:center;gap:18px;margin:18px 0 30px"><div style="width:22px;height:22px;background:#34d399;border-radius:50%;box-shadow:0 0 20px #34d399"></div><div style="font-size:64px;font-weight:800">Available</div></div>
<div style="background:rgba(255,255,255,.08);border-radius:14px;padding:24px 28px;font-size:24px">
<div style="color:#9fe8d8;font-size:16px;text-transform:uppercase;letter-spacing:2px;margin-bottom:12px">Next Booking</div>
<div style="display:flex;justify-content:space-between"><span>Design Sync</span><span>11:00 – 11:30</span></div>
</div>
<div style="position:absolute;bottom:34px;right:60px;font-size:22px;color:#9fe8d8">Seats 12 · Display · VC</div>
</div>"""),
]

os.makedirs(SSDIR,exist_ok=True)
conn=sqlite3.connect(DB)
now=int(time.time())
with sync_playwright() as p:
    br=p.chromium.launch()
    pg=br.new_page(viewport={"width":960,"height":540},device_scale_factor=1)
    for i,(did,html) in enumerate(zip(ids,SCREENS)):
        pg.set_content(html, wait_until="networkidle")
        pg.wait_for_timeout(200)
        fn=f"{did}_latest.jpg"
        pg.screenshot(path=os.path.join(SSDIR,fn), type="jpeg", quality=82, clip={"x":0,"y":0,"width":960,"height":540})
        conn.execute("DELETE FROM screenshots WHERE device_id=?", (did,))
        conn.execute("INSERT INTO screenshots (device_id, filepath, captured_at) VALUES (?,?,?)",(did,fn,now))
        print("wrote", fn)
    br.close()
conn.commit(); conn.close()
print("DONE")
