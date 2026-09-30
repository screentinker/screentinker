#!/usr/bin/env python3
"""
Seed the 2.2-only surfaces the video has to photograph: API tokens (the MCP scene needs a real
one), saved device endpoints, and the LAN control door on exactly one screen.

⚠️ Addresses here are RFC 1918 and invented. Nothing in this file may name a real customer host:
these captures go on YouTube at 1080p where every character is legible.
"""
import json, os, urllib.request, urllib.error

BASE = "http://localhost:3011"
HERE = os.path.dirname(os.path.abspath(__file__))
TOK  = open(os.path.join(HERE, ".token")).read().strip()

def call(method, path, body=None, tok=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + "/api" + path, data=data, method=method,
        headers={"Authorization": f"Bearer {tok or TOK}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            s = r.read().decode()
            return json.loads(s) if s else {}
    except urllib.error.HTTPError as e:
        print(f"  !! {method} {path} -> {e.code}: {e.read().decode()[:200]}")
        return None

devs = call("GET", "/devices") or []
devs = devs if isinstance(devs, list) else devs.get("devices", [])
by_name = {d["name"]: d for d in devs}
print(f"  devices: {', '.join(sorted(by_name))}")

# 1. Tokens. TWO scopes on purpose: the scene claims a read-only token is never shown the write
#    tools, and a screenshot of one token cannot show that.
tokens = {}
for name, scope in [("Claude (assistant)", "full"), ("Reporting dashboard", "read")]:
    r = call("POST", "/tokens", {"name": name, "scope": scope})
    if r and r.get("token"):
        tokens[scope] = r["token"]
        print(f"  token {scope:5s} {name!r} -> {r['token'][:11]}...")
with open(os.path.join(HERE, ".apitoken"), "w") as f:
    f.write(tokens.get("full", "") + "\n")
with open(os.path.join(HERE, ".apitoken-read"), "w") as f:
    f.write(tokens.get("read", "") + "\n")

# 2. Saved endpoints. A mix of intervals and run_on triggers, so the capture shows both columns
#    populated rather than one repeated five times.
EPS = [
    ("PLC line state",   "Main Lobby",        "GET",  "http://192.168.10.40/api/v1/state",      120, None),
    ("Door sensor",      "Main Lobby",        "GET",  "http://192.168.10.41/status",             60, None),
    ("Ward occupancy",   "Ward B Day Room",   "GET",  "http://192.168.10.52/occupancy",          30, None),
    ("Kitchen ticket queue", "Cafeteria Menu","GET",  "http://192.168.10.60/api/queue",         300, None),
    ("Check in on power-on", "Radiology Waiting", "POST", "http://192.168.10.70/hooks/screen-on", None, "screen_on"),
]
for name, dev, method, url, interval, run_on in EPS:
    d = by_name.get(dev)
    if not d:
        print(f"  !! no device {dev!r}")
        continue
    body = {"name": name, "device_id": d["id"], "method": method, "url": url,
            "timeout_ms": 5000, "enabled": True}
    if interval: body["interval_sec"] = interval
    if run_on:   body["run_on"] = run_on
    r = call("POST", "/device-endpoints", body)
    print(f"  endpoint {'ok ' if r else 'FAIL'} {name:22s} {dev}")

# 3. The LAN control door, on ONE screen. The route refuses to enable without a secret first,
#    which is the whole point of the two-step.
lobby = by_name.get("Main Lobby")
if lobby:
    s = call("POST", f"/devices/{lobby['id']}/local-api-secret", {})
    print(f"  local api secret: {'set' if s else 'FAILED'}")
    e = call("POST", f"/devices/{lobby['id']}/local-api", {"enabled": True})
    print(f"  local api on Main Lobby: {'enabled' if e else 'FAILED'}")

print("  seed22 done")
