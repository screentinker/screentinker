#!/usr/bin/env python3
"""
Capture the real 2.0 dashboard for the video.

Talks ONLY to the throwaway instance on :3014. Every screen it visits is seeded
demo data — invented names, generated media, no third-party content.

Writes 4K-ish PNGs to caps/. Run with the fleet process alive so devices read online.
"""
import os, json, sys, time
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3014"
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
    ("cap-data-sources","#/data-sources",2.5),
    ("cap-admin",      "#/admin",     3.0),
]

# Not SPA routes: these are pages the server renders itself, so they take a full path and no hash.
PAGES = [
    ("cap-download",  "/download", 2.0),
    ("cap-certified", "/certified-hardware.html", 2.0),
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

        for name, route, settle in PAGES:
            pg.goto(BASE + route, wait_until="networkidle")
            time.sleep(settle)
            pg.add_style_tag(content="*{animation:none!important;transition:none!important}")
            path = os.path.join(OUT, name + ".png")
            pg.screenshot(path=path, full_page=False)
            print(f"  {name:20s} {route:24s} -> {os.path.getsize(path)//1024:5d} KB   [{pg.title()[:40]}]")

        # ---- the device page for Main Lobby: saved endpoints and the LAN control door live here,
        #      and there is no route of their own to visit.
        import urllib.request
        rq = urllib.request.Request(BASE + "/api/devices", headers={"Authorization": f"Bearer {TOK}"})
        with urllib.request.urlopen(rq) as r:
            ds = json.loads(r.read().decode())
        ds = ds if isinstance(ds, list) else ds.get("devices", [])
        lobby = next((d for d in ds if d["name"] == "Main Lobby"), None)
        if lobby:
            pg.goto(BASE + "/app#/device/" + lobby["id"], wait_until="networkidle")
            time.sleep(3.0)
            pg.add_style_tag(content="*{animation:none!important;transition:none!important}")
            pg.screenshot(path=os.path.join(OUT, "cap-device.png"))
            print(f"  {'cap-device':20s} {'(Main Lobby)':24s} -> "
                  f"{os.path.getsize(os.path.join(OUT,'cap-device.png'))//1024:5d} KB")

            # ⚠️ The trigger LISTENER SETTINGS are under the Info tab (device-detail.js renders
            # renderTriggerConfig inside tab-info), not on the default Now Playing tab. Shooting the
            # default tab is why the first pass looked like the feature had no UI at all.
            hit = pg.evaluate("""() => {
              const b = document.querySelector('.tab[data-tab="info"]');
              if (b) { b.click(); return true; } return false;
            }""")
            if hit:
                time.sleep(1.5)
                pg.evaluate("""() => {
                  const h = [...document.querySelectorAll('div')].find(
                    (d) => d.textContent.trim().startsWith('Triggers —'));
                  if (h) h.scrollIntoView({block: 'center'});
                }""")
                time.sleep(1.0)
                pg.add_style_tag(content="*{animation:none!important;transition:none!important}")
                pg.screenshot(path=os.path.join(OUT, "cap-device-triggers.png"))
                print(f"  {'cap-device-triggers':20s} {'(info tab)':24s} -> "
                      f"{os.path.getsize(os.path.join(OUT,'cap-device-triggers.png'))//1024:5d} KB")

        # ---- API tokens: the MCP scene needs the token list, which is well down the settings page.
        pg.goto(BASE + "/app#/settings", wait_until="networkidle"); time.sleep(2.5)
        moved = pg.evaluate("""() => {
          const el = document.querySelector('#tokName');
          if (el) { el.closest('div.card, section, div')?.scrollIntoView({block:'center'}); return true; }
          return false;
        }""")
        time.sleep(1.2)
        pg.add_style_tag(content="*{animation:none!important;transition:none!important;caret-color:transparent!important}")
        pg.screenshot(path=os.path.join(OUT, "cap-tokens.png"))
        # ⚠️ And the CARD on its own. The scene that has to prove "read-only sees ten" shows this
        # table, and inside a full 1600x900 page shrunk into a 1080p frame the scopes are illegible.
        # An element shot keeps the rows at a size a viewer can actually read.
        try:
            card = pg.query_selector("#tokName")
            if card:
                box = pg.evaluate("""() => {
                  let el = document.querySelector('#tokName');
                  while (el && !(el.className || '').toString().includes('settings-section')) el = el.parentElement;
                  if (!el) return null;
                  const r = el.getBoundingClientRect();
                  return {x:r.x, y:r.y, width:r.width, height:r.height};
                }""")
                if box and box["height"] > 80:
                    pg.screenshot(path=os.path.join(OUT, "cap-tokens-card.png"), clip=box)
                    print(f"  {'cap-tokens-card':20s} {'(element)':24s} -> "
                          f"{os.path.getsize(os.path.join(OUT,'cap-tokens-card.png'))//1024:5d} KB")
        except Exception as e:
            print("  cap-tokens-card: could not isolate the card:", e)
        print(f"  {'cap-tokens':20s} {'(settings, tokens)' if moved else '(tokens NOT FOUND)':24s} -> "
              f"{os.path.getsize(os.path.join(OUT,'cap-tokens.png'))//1024:5d} KB")

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
