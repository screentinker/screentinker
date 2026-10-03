#!/usr/bin/env python3
"""
Give Reports something true to show (scene 13: proof of play).

Writes a plausible 30-day history straight into the throwaway capture DB. Some rows carry a
client_event_id — those are the plays a player recorded while OFFLINE and flushed on reconnect,
which is the 2.0 feature the scene is about. One device gets a deliberate outage gap that is
then backfilled from its queue, so the chart shows the hole being filled rather than a hole.
"""
import sqlite3, random, time, os

DB = os.path.join(os.path.dirname(__file__), "instance", "db", "remote_display.db")
random.seed(20)                      # deterministic — a re-run must not reshuffle the charts

con = sqlite3.connect(DB)
cur = con.cursor()
devices = cur.execute("SELECT id, name FROM devices ORDER BY name").fetchall()
content = cur.execute("SELECT id, filename FROM content").fetchall()
if not devices or not content:
    raise SystemExit("seed.py / register_devices.js must run first")

now = int(time.time())
DAYS = 30
rows = []

# Opening hours 07:00-19:00; each item runs its duration then the next starts.
for d_idx, (did, dname) in enumerate(devices):
    for day in range(DAYS, 0, -1):
        day_start = now - day * 86400
        # The outage: Cafeteria Menu loses the network for ~6h on day 9, keeps playing,
        # and flushes the backlog when it comes back.
        outage = (dname == "Cafeteria Menu" and day == 9)
        t = day_start + 7 * 3600
        end_of_day = day_start + 19 * 3600
        while t < end_of_day:
            cid, cname = random.choice(content)
            dur = random.choice([60, 90, 120, 120, 180])
            offline = outage and (day_start + 10 * 3600) <= t < (day_start + 16 * 3600)
            rows.append((
                did, cid, cname, t, t + dur, dur,
                1,                                   # completed
                "playlist",
                # a player-minted id ONLY for the plays recorded offline and flushed later
                f"{did[:8]}-{t}-{random.randint(1000,9999)}" if offline else None,
            ))
            t += dur + random.choice([0, 0, 1])   # back-to-back, as a loop plays

cur.executemany("""
    INSERT INTO play_logs
      (device_id, content_id, content_name, started_at, ended_at, duration_sec,
       completed, trigger_type, client_event_id)
    VALUES (?,?,?,?,?,?,?,?,?)""", rows)
con.commit()

total = cur.execute("SELECT COUNT(*) FROM play_logs").fetchone()[0]
offl  = cur.execute("SELECT COUNT(*) FROM play_logs WHERE client_event_id IS NOT NULL").fetchone()[0]
hours = cur.execute("SELECT ROUND(SUM(duration_sec)/3600.0,1) FROM play_logs").fetchone()[0]
print(f"  inserted {len(rows)} plays")
print(f"  total in table : {total}")
print(f"  offline-flushed: {offl}  (carry a client_event_id)")
print(f"  total playtime : {hours} hours")
for did, dname in devices:
    n = cur.execute("SELECT COUNT(*) FROM play_logs WHERE device_id=?", (did,)).fetchone()[0]
    print(f"    {dname:20s} {n}")
con.close()
