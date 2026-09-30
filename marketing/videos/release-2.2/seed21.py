import json, urllib.request, urllib.error, sqlite3, os, time
BASE="http://localhost:3011"; TOK=open(".token").read().strip()
def call(m,p,b=None,raw=False):
    d=json.dumps(b).encode() if (b is not None and not raw) else b
    h={"Authorization":f"Bearer {TOK}"}
    if not raw: h["Content-Type"]="application/json"
    r=urllib.request.Request(BASE+"/api"+p,data=d,method=m,headers=h)
    try:
        with urllib.request.urlopen(r) as x:
            s=x.read().decode(); return json.loads(s) if s else {}
    except urllib.error.HTTPError as e:
        print(f"  !! {m} {p} {e.code}: {e.read().decode()[:200]}"); return None

# --- 1. iCal room data source (for Data Sources + Room-sign scenes) ---
ics="""BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:e1\r\nSUMMARY:Design Review\r\nDTSTART:20260916T090000Z\r\nDTEND:20260916T100000Z\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:e2\r\nSUMMARY:1:1 with Maya\r\nDTSTART:20260916T140000Z\r\nDTEND:20260916T143000Z\r\nEND:VEVENT\r\nEND:VCALENDAR"""
ds=call("POST","/data-sources",{"name":"Green Meeting Room","type":"ical",
    "config":{"raw_data":ics,"timezone":"UTC","locale":"en","hide_private":False}})
print("data source:", (ds or {}).get("slug") or (ds or {}).get("id") or "FAILED")

# --- 2. enable the bundled 'countdown' plugin (for Plugins scenes) ---
pl=call("GET","/admin/plugins")
if pl and pl.get("plugins"):
    print("plugins discovered:", [p["id"] for p in pl["plugins"]])
    for pid in ["countdown","json-api","webhook"]:
        r=call("POST",f"/admin/plugins/{pid}/enable",{})
        print(f"  enable {pid}:", "ok" if r is not None else "skip")
else:
    print("plugins list:", pl)
print("done (server-side items). PDF playlist seeded offline separately.")
