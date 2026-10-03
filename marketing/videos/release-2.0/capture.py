#!/usr/bin/env python3
"""
Capture the real 2.0 dashboard for the video.

Talks ONLY to the throwaway instance on :3011. Every screen it visits is seeded
demo data — invented names, generated media, no third-party content.

Writes 4K-ish PNGs to caps/. Run with the fleet process alive so devices read online.
"""
import os, json, sys, time
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3011"
TOK  = open(os.path.join(os.path.dirname(__file__), ".token")).read().strip()
OUT  = os.path.join(os.path.dirname(__file__), "caps")
os.makedirs(OUT, exist_ok=True)

# 2x scale on a 1600x900 CSS viewport -> 3200x1800 source, plenty for a 1080p Ken Burns push.
VW, VH, SCALE = 1600, 900, 2

# (filename, hash route, settle seconds, optional prep callback name)
SHOTS = [
    ("cap-dashboard",  "#/dashboard", 3.0),
    ("cap-slides-list","#/slides",    2.5),
    ("cap-triggers",   "#/triggers",  2.5),
    ("cap-playlists",  "#/playlists", 2.5),
    ("cap-content",    "#/content",   2.5),
    ("cap-reports",    "#/reports",   3.0),
    ("cap-settings",   "#/settings",  2.5),
    ("cap-servers",    "#/servers",   2.5),
]

def user_json():
    import urllib.request
    r = urllib.request.Request(BASE + "/api/auth/me", headers={"Authorization": f"Bearer {TOK}"})
    with urllib.request.urlopen(r) as x:
        return x.read().decode()

def main():
    u = user_json()
    with sync_playwright() as p:
        br = p.chromium.launch(args=["--force-color-profile=srgb"])
        pg = br.new_page(viewport={"width": VW, "height": VH}, device_scale_factor=SCALE)
        # Seat the session before any app JS runs.
        pg.add_init_script(f"""
          localStorage.setItem('token', {json.dumps(TOK)});
          localStorage.setItem('user', {json.dumps(u)});
          localStorage.setItem('rd_onboarded', '1');
          localStorage.setItem('rd_gs_dismissed', '1');
        """)
        pg.goto(BASE + "/app", wait_until="networkidle")
        time.sleep(2.0)

        for name, route, settle in SHOTS:
            try:
                pg.goto(BASE + "/app" + route, wait_until="networkidle")
            except Exception:
                pg.evaluate(f"location.hash = {json.dumps(route.lstrip('#'))}")
            time.sleep(settle)
            # Kill anything that blinks, so a frame grab is deterministic.
            pg.add_style_tag(content="*{animation:none!important;transition:none!important;caret-color:transparent!important}")
            path = os.path.join(OUT, name + ".png")
            pg.screenshot(path=path)
            title = pg.title()
            print(f"  {name:20s} {route:14s} -> {os.path.getsize(path)//1024:5d} KB   [{title[:40]}]")

        # ---- the slides EDITOR, which is the whole point: open the seeded deck.
        pg.goto(BASE + "/app#/slides", wait_until="networkidle"); time.sleep(2.5)
        opened = pg.evaluate("""() => {
          const b = document.querySelector('[data-open]');
          if (b) { b.click(); return true; }
          return false;
        }""")
        if opened:
            time.sleep(3.0)
            pg.add_style_tag(content="*{animation:none!important;transition:none!important;caret-color:transparent!important}")
            pg.screenshot(path=os.path.join(OUT, "cap-slides-editor.png"))
            print(f"  {'cap-slides-editor':20s} {'(deck open)':14s} -> "
                  f"{os.path.getsize(os.path.join(OUT,'cap-slides-editor.png'))//1024:5d} KB")
            # style tab + motion tab, for scenes 03/07
            for tab, fn in [("style", "cap-slides-style"), ("motion", "cap-slides-motion"), ("slide", "cap-slides-slide")]:
                hit = pg.evaluate(f"""() => {{
                  const b = document.querySelector('.tabBtn[data-tab="{tab}"]');
                  if (b) {{ b.click(); return true; }} return false;
                }}""")
                if hit:
                    time.sleep(1.2)
                    pg.screenshot(path=os.path.join(OUT, fn + ".png"))
                    print(f"  {fn:20s} {'(tab '+tab+')':14s} -> {os.path.getsize(os.path.join(OUT,fn+'.png'))//1024:5d} KB")
                else:
                    print(f"  {fn:20s} -- tab '{tab}' not found")
        else:
            print("  !! could not open the deck — no [data-open] on the slides list")

        # ---- Reports only queries on demand: press Load Report, then shoot.
        pg.goto(BASE + "/app#/reports", wait_until="networkidle"); time.sleep(2.0)
        ran = pg.evaluate("""() => {
          const b = [...document.querySelectorAll('button')]
            .find(x => /load report/i.test(x.textContent||''));
          if (b) { b.click(); return true; } return false;
        }""")
        if ran:
            time.sleep(4.5)
            pg.add_style_tag(content="*{animation:none!important;transition:none!important;caret-color:transparent!important}")
            pg.screenshot(path=os.path.join(OUT, "cap-reports.png"))
            print(f"  {'cap-reports':20s} {'(loaded)':14s} -> {os.path.getsize(os.path.join(OUT,'cap-reports.png'))//1024:5d} KB")
        else:
            print("  !! no 'Load Report' button")

        # ---- the trigger dialog (rebuilt in 2.0; it used to render as a bare stack of labels)
        pg.goto(BASE + "/app#/triggers", wait_until="networkidle"); time.sleep(2.0)
        hit = pg.evaluate("""() => {
          const b = [...document.querySelectorAll('button')]
            .find(x => /new trigger/i.test(x.textContent||''));
          if (b) { b.click(); return true; } return false;
        }""")
        if hit:
            time.sleep(1.8)
            pg.add_style_tag(content="*{animation:none!important;transition:none!important;caret-color:transparent!important}")
            pg.screenshot(path=os.path.join(OUT, "cap-trigger-dialog.png"))
            print(f"  {'cap-trigger-dialog':20s} {'(new trigger)':14s} -> "
                  f"{os.path.getsize(os.path.join(OUT,'cap-trigger-dialog.png'))//1024:5d} KB")
        else:
            print("  !! no 'New trigger' button found")

        br.close()

if __name__ == "__main__":
    main()
