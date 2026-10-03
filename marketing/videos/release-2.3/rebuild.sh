#!/usr/bin/env bash
# Rebuild the throwaway capture instance from nothing, in an order that cannot corrupt it.
#
# ⚠️ THE ORDER IS THE WHOLE POINT. Bulk-writing play_logs into the SQLite file while the server
#    holds it in WAL mode — with its off-thread checkpointer running TRUNCATE — corrupted the
#    database ("disk image is malformed") and lost every seeded row. Big offline writes happen
#    with the server STOPPED; only API calls happen while it is up.
#
# 2.3: CLOUD mode (no SELF_HOSTED) with a DUMMY Stripe key so sales are shown; the key is fake and
# nothing in the capture path calls Stripe (the sale row is inserted offline with a fake coupon id).
# Only ever touches :3014 and DATA_DIR=<this folder>/instance.
set -e
cd "$(dirname "$0")"
ROOT="$(cd "$(dirname "$0")" && pwd)"          # this folder
SRV="${SRV:-$(cd "$ROOT/../../../server" && pwd)}"   # this checkout's server; override with SRV=
export ROOT SRV
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm use 20 >/dev/null 2>&1

stop_mine() {
  # Kill ONLY the server whose DATA_DIR is ours — other sessions run servers on :3012/:3013.
  for p in $(pgrep -x node); do
    if tr '\0' '\n' < /proc/$p/environ 2>/dev/null | grep -q "^DATA_DIR=$ROOT/instance$"; then
      kill "$p" 2>/dev/null && echo "  stopped server pid $p"
    fi
  done
  pkill -f "node register_devices.js" 2>/dev/null && echo "  stopped fleet" || true
  sleep 1
  for i in $(seq 1 15); do ss -ltn 2>/dev/null | grep -q ':3014' || break; sleep 1; done
}

start_server() {
  ( cd "$SRV" && setsid env -i PATH="$PATH" HOME="$HOME" \
      DATA_DIR=$ROOT/instance PORT=3014 NODE_ENV=development PLUGINS_ENABLED=true \
      STRIPE_SECRET_KEY=sk_test_video_capture_dummy STRIPE_WEBHOOK_SECRET= SMTP_USER= SMTP_PASS= RESEND_API_KEY= \
      MESH_ACCEPT_ENROLLMENT=1 MESH_ALLOW_UPLINK=1 TRIGGER_INGRESS=1 \
      EMAIL_TRANSPORT=smtp SMTP_HOST=127.0.0.1 SMTP_PORT=2526 SMTP_FROM=noreply@screentinker.test GRAPH_TENANT_ID= GRAPH_CLIENT_ID= GRAPH_CLIENT_SECRET= \
      JWT_SECRET=video-capture-only-not-a-secret \
      node server.js < /dev/null > $ROOT/instance/server.log 2>&1 & disown ) 2>/dev/null
  for i in $(seq 1 30); do ss -ltn 2>/dev/null | grep -q ':3014' && { echo "  server up (${i}s)"; return; }; sleep 1; done
  echo "  !! server did not start"; tail -20 $ROOT/instance/server.log; exit 1
}

start_sink() {
  # Loopback SMTP that DISCARDS everything (smtp_sink.py): email "works" for the notice flow, nothing leaves.
  ss -ltn 2>/dev/null | grep -q '127.0.0.1:2526' || { setsid python3 smtp_sink.py < /dev/null > /dev/null 2>&1 & disown; sleep 1; }
  ss -ltn 2>/dev/null | grep -q '127.0.0.1:2526' && echo "  smtp sink up (127.0.0.1:2526, discards)"
}
[ "$1" = "--restart" ] && { echo "== restart only (no wipe) =="; stop_mine; start_sink; start_server
  OFFLINE='Staff Room' setsid node register_devices.js < /dev/null > devices.log 2>&1 & disown
  for i in $(seq 1 25); do grep -q "devices online" devices.log 2>/dev/null && break; sleep 1; done; sed 's/^/  /' devices.log; exit 0; }
echo "== 1. stop anything of ours =="; stop_mine; start_sink
echo "== 2. wipe instance =="; rm -rf "$ROOT/instance" "$ROOT/fleet.json"; mkdir -p "$ROOT/instance"
cp pkgs/ScreenTinker.* "$ROOT/instance/" 2>/dev/null && echo "  staged release APK/ipk/wgt (from pkgs/)"
echo "== 3. boot (creates schema) =="; start_server

echo "== 4. bootstrap admin =="
TOK=$(curl -s -X POST http://localhost:3014/api/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"demo@screentinker.test","password":"VideoCapture2026!","name":"Demo","createOrg":true}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))")
[ -n "$TOK" ] || { echo "  !! register failed"; exit 1; }
echo "$TOK" > "$ROOT/.token"; echo "  token ok"

echo "== 5. deck + playlists =="; python3 seed.py | sed 's/^/  /'
echo "== 6. content upload =="
for f in evacuate handover; do
  curl -s -X POST http://localhost:3014/api/content -H "Authorization: Bearer $TOK" \
    -F "files=@seedmedia/$f.png" > /dev/null && echo "  uploaded $f.png"
done

echo "== 7. fleet online =="
setsid node register_devices.js < /dev/null > devices.log 2>&1 & disown
for i in $(seq 1 20); do grep -q "devices online" devices.log 2>/dev/null && break; sleep 1; done
sed 's/^/  /' devices.log

echo "== 8. pair the fleet =="
python3 - <<'PY' | sed 's/^/  /'
import json,urllib.request,urllib.error
BASE="http://localhost:3014"; import os; TOK=open(os.environ["ROOT"]+"/.token").read().strip()
def call(m,p,b=None):
    d=json.dumps(b).encode() if b is not None else None
    r=urllib.request.Request(BASE+"/api"+p,data=d,method=m,
        headers={"Authorization":f"Bearer {TOK}","Content-Type":"application/json"})
    try:
        with urllib.request.urlopen(r) as x:
            s=x.read().decode(); return json.loads(s) if s else {}
    except urllib.error.HTTPError as e:
        print(f"!! {m} {p} {e.code}: {e.read().decode()[:160]}"); return None
names=["Main Lobby","Ward B Day Room","Cafeteria Menu","Radiology Waiting","Staff Room"]
un=call("GET","/devices/unassigned") or []
for dev,name in zip(un,names):
    call("POST","/provision/pair",{"pairing_code":dev["pairing_code"],"name":name})
print(f"paired {min(len(un),len(names))}")
PY

echo "== 9. items, publish, triggers =="; python3 seed2.py | sed 's/^/  /'
echo "== 9b. 2.3: data sources, signed template library, template widgets =="; python3 seed23.py | sed 's/^/  /'
echo "== 10. answer the telemetry prompt =="
curl -s -X PUT http://localhost:3014/api/admin/telemetry -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' -d '{"enabled":false}' > /dev/null && echo "  telemetry: off"

echo "== 11. STOP the server before any bulk write =="; stop_mine
echo "== 12. offline bulk seed (plays + screenshots) =="
python3 seed_plays.py   | sed 's/^/  /'
python3 seed_previews.py | sed 's/^/  /'
python3 seed_platform.py | sed 's/^/  /'
echo "== 13. integrity check =="
python3 - <<'PY' | sed 's/^/  /'
import sqlite3
import os; c=sqlite3.connect(os.environ["ROOT"]+"/instance/db/remote_display.db")
print("integrity:", c.execute("PRAGMA integrity_check").fetchone()[0])
for t in ["play_logs","screenshots","devices","triggers","slide_decks","playlists","content","users","organizations","promotions","data_sources","widgets","templates_installed"]:
    print(f"{t:12s} {c.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]}")
PY
echo "== 14. restart for capture =="; start_server
echo "== 15. fleet back online (reusing fleet.json credentials) =="
OFFLINE='Staff Room' setsid node register_devices.js < /dev/null > devices.log 2>&1 & disown
for i in $(seq 1 25); do grep -q "devices online" devices.log 2>/dev/null && break; sleep 1; done
sed 's/^/  /' devices.log
echo "== 16. final state =="
curl -s http://localhost:3014/api/devices -H "Authorization: Bearer $(cat $ROOT/.token)" \
 | python3 -c "
import sys,json
d=json.load(sys.stdin); d=d if isinstance(d,list) else d.get('devices',[])
print(f'  devices: {len(d)}')
for x in d: print(f\"    {x.get('name','?'):20s} {x.get('status','?'):8s} preview={'yes' if x.get('screenshot_path') else 'NO'}\")"
echo
echo "READY for capture.py"
