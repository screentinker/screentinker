#!/usr/bin/env python3
"""
Capture the real 2.3.0 dashboard for the release video.

Talks ONLY to the throwaway instance on :3014 (DATA_DIR=<this folder>/instance). Every
screen it visits is seeded demo data — invented names, generated media, no third-party content.
Run with the fleet process alive so devices read online.

  ~/tts-venv/bin/python capture23.py            # everything
  ~/tts-venv/bin/python capture23.py ds home    # only shots whose name contains one of these
"""
import os, json, sys, time, urllib.request
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3014"
HERE = os.path.dirname(os.path.abspath(__file__))
TOK = open(os.path.join(HERE, ".token")).read().strip()
OUT = os.path.join(HERE, "caps"); os.makedirs(OUT, exist_ok=True)
VW, VH, SCALE = 1600, 900, 2
STILL = "*{animation:none!important;transition:none!important;caret-color:transparent!important}"
ONLY = sys.argv[1:]

def api(method, path, body=None):
    d = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + "/api" + path, data=d, method=method,
                               headers={"Authorization": f"Bearer {TOK}", "Content-Type": "application/json"})
    with urllib.request.urlopen(r) as x:
        s = x.read().decode(); return json.loads(s) if s else {}

def want(name): return not ONLY or any(o in name for o in ONLY)

def save(pg, name, clip=None, full=False):
    pg.add_style_tag(content=STILL)
    time.sleep(0.3)
    p = os.path.join(OUT, name + ".png")
    if clip: pg.screenshot(path=p, clip=clip)
    else: pg.screenshot(path=p, full_page=full)
    print(f"  {name:26s} -> {os.path.getsize(p)//1024:5d} KB")

def goto(pg, route, settle=2.5):
    # about:blank first: a hash change inside the SPA keeps an open modal on top of the next page.
    pg.goto("about:blank")
    pg.goto(BASE + "/app" + route, wait_until="networkidle"); time.sleep(settle)

def box_of(pg, js_selector_expr):
    return pg.evaluate(f"""() => {{ const el = {js_selector_expr}; if (!el) return null;
        const r = el.getBoundingClientRect(); return {{x:r.x, y:r.y, width:r.width, height:r.height}}; }}""")

def click_text(pg, sel, rx):
    return pg.evaluate(f"""() => {{ const b = [...document.querySelectorAll({json.dumps(sel)})]
        .find(x => {rx}.test((x.textContent||'').trim())); if (b) {{ b.click(); return true; }} return false; }}""")

def main():
    me = json.dumps(api("GET", "/auth/me"))
    with sync_playwright() as p:
        br = p.chromium.launch(args=["--force-color-profile=srgb"])
        ctx = br.new_context(viewport={"width": VW, "height": VH}, device_scale_factor=SCALE)
        ctx.add_init_script(f"""
          localStorage.setItem('token', {json.dumps(TOK)});
          localStorage.setItem('user', {json.dumps(me)});
          localStorage.setItem('rd_onboarded', '1');
          localStorage.setItem('rd_gs_dismissed', '1');
        """)
        pg = ctx.new_page()
        pg.goto(BASE + "/app", wait_until="networkidle"); time.sleep(2)

        simple = [("cap-dashboard", "#/dashboard", 3.0), ("cap-ds-list", "#/data-sources", 2.5),
                  ("cap-templates-installed", "#/templates", 3.5),
                  ("cap-platform-overview", "#/platform/overview", 3.0),
                  ("cap-platform-users", "#/platform/users", 2.5),
                  ("cap-platform-cleanup-rules", "#/platform/cleanup", 3.0),
                  ("cap-platform-sales", "#/platform/billing", 3.0),
                  ("cap-billing-sale", "#/billing", 3.0)]
        for name, route, settle in simple:
            if want(name): goto(pg, route, settle); save(pg, name)

        for name, path in [("cap-download", "/download"), ("cap-home-sale-top", "/")]:
            if want(name):
                pg.goto(BASE + path, wait_until="networkidle"); time.sleep(2.5)
                if name == "cap-download":
                    # The native players are further down: bring the Pi card to the top of the frame.
                    pg.evaluate("""() => { const h = [...document.querySelectorAll('h2,h3,strong,div')]
                        .find(x => /raspberry pi/i.test(x.textContent||'') && x.children.length < 3);
                        if (h) { const c = h.closest('section,div'); (c||h).scrollIntoView({block:'start'}); window.scrollBy(0,-40); } }""")
                    time.sleep(0.8)
                save(pg, name)

        if want("cap-home-pricing"):
            pg.goto(BASE + "/#pricing", wait_until="networkidle"); time.sleep(2.5)
            pg.evaluate("document.getElementById('pricing').scrollIntoView({block:'start'})"); time.sleep(1.2)
            save(pg, "cap-home-pricing")

        if want("cap-sidebar"):
            # Tall viewport so every group fits: the sidebar scrolls inside a 900px window.
            pg.set_viewport_size({"width": VW, "height": 2000})
            goto(pg, "#/dashboard", 2.5)
            b = box_of(pg, "document.getElementById('sidebar')")
            save(pg, "cap-sidebar", clip=b)
            pg.set_viewport_size({"width": VW, "height": VH})

        if want("cap-ds-add"):
            goto(pg, "#/data-sources", 2.5)
            click_text(pg, "button", "/connect data/i"); time.sleep(1.5)
            save(pg, "cap-ds-add")

        if want("cap-ds-table"):
            goto(pg, "#/data-sources", 2.5)
            # Edit on the Café menu card.
            pg.evaluate("""() => { const card = [...document.querySelectorAll('.ds-card, .content-item, div')]
                .find(c => /Café menu/.test(c.textContent||'') && c.querySelector('button') && c.textContent.length < 800);
                const b = card && [...card.querySelectorAll('button')].find(x => /edit/i.test(x.textContent||''));
                if (b) b.click(); }""")
            time.sleep(1.8)
            save(pg, "cap-ds-table")
            b = box_of(pg, "document.querySelector('.ds-modal')")
            if b and b["height"] > 120: save(pg, "cap-ds-table-card", clip=b)

        if want("cap-templates-library"):
            goto(pg, "#/templates", 2.5)
            pg.evaluate("document.querySelector('[data-tab=library]').click()"); time.sleep(3.0)
            save(pg, "cap-templates-library")

        if want("cap-template-detail"):
            goto(pg, "#/templates", 2.5)
            pg.evaluate("""() => { const b = document.querySelector('[data-use="official/menu-board"]'); if (b) b.click(); }""")
            time.sleep(4.0)
            save(pg, "cap-template-detail")

        if want("cap-platform-attention"):
            goto(pg, "#/platform/overview", 3.0)
            pg.evaluate("""() => { document.querySelectorAll('details.att').forEach(d => d.open = true); }""")
            time.sleep(2.5)
            pg.evaluate("""() => { const sec = document.querySelector('.platform-attention').closest('.settings-section');
                let sc = sec.parentElement; while (sc && !(sc.scrollHeight > sc.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
                const top = sec.getBoundingClientRect().top - 20;
                if (sc) sc.scrollTop += top; else window.scrollBy(0, top); }""")
            time.sleep(0.6)
            save(pg, "cap-platform-attention")
            b = box_of(pg, "document.querySelector('.platform-attention').closest('.settings-section')")
            if b: save(pg, "cap-platform-attention-card", clip=b)

        if want("cap-platform-cleanup"):
            # Notice first: tick two accounts that were never warned, so "Send notice" is live.
            goto(pg, "#/platform/cleanup", 3.0)
            pg.evaluate("""() => { const picks = [...document.querySelectorAll('.cleanup-pick')]
                .filter(c => c.dataset.notice !== 'notice' && c.dataset.notice !== 'ready').slice(0, 2);
                picks.forEach(c => { c.checked = true; c.dispatchEvent(new Event('change', {bubbles:true})); }); }""")
            time.sleep(0.8)
            pg.evaluate("""() => { const b = document.getElementById('cleanupWarn'); const sec = b && b.closest('.settings-section');
                let sc = sec && sec.parentElement; while (sc && !(sc.scrollHeight > sc.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
                const top = sec ? sec.getBoundingClientRect().top - 20 : 0; if (sc) sc.scrollTop += top; else window.scrollBy(0, top); }""")
            time.sleep(0.8)
            save(pg, "cap-platform-cleanup")

        if want("cap-platform-orgs"):
            goto(pg, "#/platform/orgs", 2.5)
            pg.fill("#orgSearch", ""); pg.type("#orgSearch", "Fair", delay=60); time.sleep(1.5)
            save(pg, "cap-platform-orgs")

        if want("cap-org-members"):
            goto(pg, "#/members", 3.0)
            pg.evaluate("""() => { const b = document.querySelector('.members-tab[data-pane="org"]'); if (b) b.click(); }""")
            time.sleep(2.0)
            save(pg, "cap-org-members")

        # ---- the HOOK: the menu board as a screen renders it, before and after a real price change.
        if want("cap-menu"):
            ids = json.load(open(os.path.join(HERE, "seed23.json")))
            scr = br.new_page(viewport={"width": 1920, "height": 1080}, device_scale_factor=1)
            def shoot_menu(name):
                scr.goto(f"{BASE}/api/widgets/{ids['menu_widget']}/render", wait_until="networkidle"); time.sleep(3.0)
                p_ = os.path.join(OUT, name + ".png"); scr.screenshot(path=p_)
                print(f"  {name:26s} -> {os.path.getsize(p_)//1024:5d} KB")
            sys.path.insert(0, HERE); import seed23
            ds = ids["menu_ds"]
            api("PUT", f"/data-sources/{ds}", {"config": {"columns": seed23.MENU_COLS, "rows": seed23.menu_rows("4.20"), "key_column": "Item"}})
            api("POST", f"/data-sources/{ds}/refresh", {}); time.sleep(1.0)
            shoot_menu("cap-menu-before")
            api("PUT", f"/data-sources/{ds}", {"config": {"columns": seed23.MENU_COLS, "rows": seed23.menu_rows("4.50"), "key_column": "Item"}})
            api("POST", f"/data-sources/{ds}/refresh", {}); time.sleep(1.0)
            shoot_menu("cap-menu-after")
            got = api("GET", f"/data-sources/{ds}")
            print("   menu data latte_price =", json.dumps((got.get("data") or {}).get("latte_price")))
            scr.close()
        br.close()

    # ---- the game: record the real UPTIME 3036 autopilot through the player's render path.
    if want("game"):
        record_game()

def record_game(seconds=48):
    import subprocess, shutil, glob
    ids = json.load(open(os.path.join(HERE, "seed23.json")))
    vdir = os.path.join(HERE, "work", "gamevid"); shutil.rmtree(vdir, ignore_errors=True); os.makedirs(vdir)
    with sync_playwright() as p:
        br = p.chromium.launch(args=["--force-color-profile=srgb", "--mute-audio", "--autoplay-policy=user-gesture-required"])
        ctx = br.new_context(viewport={"width": 1920, "height": 1080}, record_video_dir=vdir,
                             record_video_size={"width": 1920, "height": 1080})
        pg = ctx.new_page()
        t0 = time.time()
        pg.goto(f"{BASE}/api/widgets/{ids['game_widget']}/render", wait_until="load")
        time.sleep(seconds)
        pg.screenshot(path=os.path.join(OUT, "game-still.png"))
        ctx.close(); br.close()
    webm = glob.glob(os.path.join(vdir, "*.webm"))[0]
    out = os.path.join(OUT, "game.mp4")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", webm, "-an", "-r", "30", "-c:v", "libx264",
                    "-pix_fmt", "yuv420p", "-crf", "16", "-preset", "slow", out], check=True)
    print(f"  game.mp4 -> {os.path.getsize(out)//1024} KB ({seconds}s, silent)")

if __name__ == "__main__":
    main()
