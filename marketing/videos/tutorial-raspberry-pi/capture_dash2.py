import json
from playwright.sync_api import sync_playwright
auth=json.load(open("auth.json"))
with sync_playwright() as p:
    br=p.chromium.launch()
    ctx=br.new_context(viewport={"width":1920,"height":1080}, ignore_https_errors=True, device_scale_factor=2)
    ctx.add_init_script(f"localStorage.setItem('token', {json.dumps(auth['token'])}); localStorage.setItem('user', {json.dumps(json.dumps(auth['user']))});")
    pg=ctx.new_page()

    # Content library (fresh load, no modal)
    pg.goto("https://localhost:3443/app#/content", wait_until="networkidle")
    pg.wait_for_timeout(3500)
    pg.screenshot(path="cap-content.png")

    # Playlists
    pg.goto("https://localhost:3443/app#/playlists", wait_until="networkidle")
    pg.wait_for_timeout(3500)
    pg.screenshot(path="cap-playlists.png")
    # list playlist names
    try:
        names=pg.eval_on_selector_all("h3,h4,.playlist-name,[class*='playlist'] strong", "els=>els.map(e=>e.innerText).filter(Boolean).slice(0,15)")
        print("PLAYLISTS:", names)
    except Exception as e: print("err",e)

    br.close()
print("done")
