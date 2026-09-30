#!/usr/bin/env python3
"""
Give each screen a preview thumbnail, so the fleet reads as alive instead of
"No preview available".

⚠️ RUN WITH THE SERVER STOPPED — see rebuild.sh. This writes to the same SQLite file the
   server keeps in WAL mode.

Generated art only: invented signage for invented rooms, nothing third-party.
"""
import sqlite3, subprocess, os, uuid

ROOT = os.path.dirname(os.path.abspath(__file__))
DB   = os.path.join(ROOT, "instance", "db", "remote_display.db")
# ⚠️ config.screenshotsDir = uploads/screenshots — NOT uploads/. Written to the wrong
#    directory the files exist, the row is set, and the dashboard renders a broken <img>.
UP   = os.path.join(ROOT, "instance", "uploads", "screenshots")
os.makedirs(UP, exist_ok=True)

def esc(s):
    """drawtext treats ':' and '\\' as syntax and chokes on quotes."""
    return s.replace("\\", "\\\\").replace(":", "\\:").replace("'", "")

LOOK = {
  "Main Lobby":        ("0E1420", "Fairview Medical Center", "Main reception - Level 1"),
  "Ward B Day Room":   ("121A2A", "WARD B - SHIFT HANDOVER", "16:45 - Day room"),
  "Cafeteria Menu":    ("0E1420", "Todays Menu",             "Soup - Roast - Veg curry"),
  "Radiology Waiting": ("101826", "Radiology",               "Current wait: 14 min"),
  "Staff Room":        ("0E1420", "1,284",                   "Patients seen this week"),
}

con = sqlite3.connect(DB); cur = con.cursor()
for (fp,) in cur.execute("SELECT filepath FROM screenshots").fetchall():
    p = os.path.join(UP, fp)
    if os.path.exists(p): os.remove(p)
cur.execute("DELETE FROM screenshots")

for did, name in cur.execute("SELECT id, name FROM devices ORDER BY name").fetchall():
    bg, title, sub = LOOK.get(name, ("0E1420", name, ""))
    fn  = f"{uuid.uuid4()}.jpg"
    vf  = (f"drawtext=text='{esc(title)}':fontcolor=0xF4F7FB:fontsize=64:"
           f"x=(w-text_w)/2:y=(h-text_h)/2-30,"
           f"drawtext=text='{esc(sub)}':fontcolor=0x34D399:fontsize=30:"
           f"x=(w-text_w)/2:y=(h-text_h)/2+60")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
                    "-i", f"color=c=0x{bg}:s=1280x720:d=1", "-vf", vf,
                    "-frames:v", "1", os.path.join(UP, fn)], check=True)
    cur.execute("INSERT INTO screenshots (device_id, filepath, captured_at) "
                "VALUES (?,?,strftime('%s','now'))", (did, fn))
    print(f"preview: {name}")

con.commit()
print("screenshots rows:", cur.execute("SELECT COUNT(*) FROM screenshots").fetchone()[0])
con.close()
