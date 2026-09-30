import json
from playwright.sync_api import sync_playwright
auth=json.load(open("auth.json"))
with sync_playwright() as p:
    br=p.chromium.launch()
    ctx=br.new_context(viewport={"width":1920,"height":1080}, ignore_https_errors=True, device_scale_factor=2)
    ctx.add_init_script(f"localStorage.setItem('token', {json.dumps(auth['token'])}); localStorage.setItem('user', {json.dumps(json.dumps(auth['user']))});")
    pg=ctx.new_page()

    # 1) Displays view (live devices w/ signage previews)
    pg.goto("https://localhost:3443/app#/", wait_until="networkidle")
    pg.wait_for_timeout(4000)
    pg.screenshot(path="cap-displays.png")

    # 2) Add Display modal (scene 08)
    try:
        pg.click("text=Add Display", timeout=5000)
        pg.wait_for_timeout(2000)
        pg.screenshot(path="cap-add-display.png")
        # dump modal text
        print("MODAL:", pg.inner_text(".modal, [class*='modal']")[:400])
    except Exception as e:
        print("add-display err:", e)
    # close modal
    try:
        pg.keyboard.press("Escape"); pg.wait_for_timeout(500)
    except: pass

    # 3) Content library
    pg.goto("https://localhost:3443/app#/content", wait_until="networkidle")
    pg.wait_for_timeout(3000)
    pg.screenshot(path="cap-content.png")

    # 4) Playlists
    pg.goto("https://localhost:3443/app#/playlists", wait_until="networkidle")
    pg.wait_for_timeout(3000)
    pg.screenshot(path="cap-playlists.png")

    br.close()
print("done")
