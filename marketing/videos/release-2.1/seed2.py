#!/usr/bin/env python3
"""Stage 2: playlist items -> publish -> triggers. Runs after seed.py and register_devices.js."""
import json, urllib.request, urllib.error, os

BASE = "http://localhost:3011"
TOK = open(os.path.join(os.path.dirname(__file__), ".token")).read().strip()

def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + "/api" + path, data=data, method=method,
                                 headers={"Authorization": f"Bearer {TOK}",
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        print(f"  !! {method} {path} -> {e.code}: {e.read().decode()[:300]}")
        return None

content   = call("GET", "/content") or []
playlists = call("GET", "/playlists") or []
if isinstance(playlists, dict): playlists = playlists.get("playlists", playlists.get("items", []))
by_name = {p["name"]: p for p in playlists}
c_by_file = {c["filename"]: c for c in content}
print(f"content={[c['filename'] for c in content]}")
print(f"playlists={list(by_name)}")

# ---- items: local content only, so the trigger target is genuinely pinnable
plan = [("Emergency — evacuate", "evacuate.png", 20),
        ("Ward B — handover",    "handover.png", 15),
        ("Lobby — daytime",      "handover.png", 12)]
print("\n== items ==")
for pname, fname, dur in plan:
    p, c = by_name.get(pname), c_by_file.get(fname)
    if not (p and c): print(f"  skip {pname}: missing"); continue
    r = call("POST", f"/playlists/{p['id']}/items", {"content_id": c["id"], "duration_sec": dur})
    print(f"  {pname:24s} <- {fname} ({dur}s) {'ok' if r else 'FAILED'}")

# ---- publish (a trigger refuses an unpublished target)
print("\n== publish ==")
for pname in ["Emergency — evacuate", "Ward B — handover", "Lobby — daytime"]:
    p = by_name.get(pname)
    if not p: continue
    r = call("POST", f"/playlists/{p['id']}/publish", {})
    print(f"  {pname:24s} {'published' if r is not None else 'FAILED'}")

# ---- devices (registered separately over socket.io)
devices = call("GET", "/devices") or []
if isinstance(devices, dict): devices = devices.get("devices", [])
print(f"\ndevices online: {[(d.get('name'), d.get('status')) for d in devices]}")

# ---- triggers
print("\n== triggers ==")
evac = by_name.get("Emergency — evacuate")
hand = by_name.get("Ward B — handover")
dev_ids = [{"target_type": "device", "target_id": d["id"]} for d in devices]
specs = [
  {"name": "Fire panel — evacuate", "match_token": "FIRE_ALARM", "clear_token": "FIRE_CLEAR",
   "mode": "until_cleared", "target_kind": "playlist", "target_ref": evac and evac["id"],
   "source_http": 1, "source_udp": 1, "priority": 100, "enabled": 1,
   "assignments": dev_ids},
  {"name": "Handover button — Ward B", "match_token": "WARD_B_HANDOVER",
   "mode": "once", "target_kind": "playlist", "target_ref": hand and hand["id"],
   "source_http": 1, "source_udp": 0, "priority": 50, "enabled": 1,
   "max_duration_sec": 120,
   "assignments": dev_ids[:2]},
]
for s in specs:
    if not s["target_ref"]: print(f"  skip {s['name']}: no target"); continue
    r = call("POST", "/triggers", s)
    if r: print(f"  {s['name']:26s} token={s['match_token']:16s} mode={s['mode']:14s} assigned={len(s['assignments'])}")

print("\n== done ==")
