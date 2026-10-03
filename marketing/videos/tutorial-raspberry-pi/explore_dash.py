import json
from playwright.sync_api import sync_playwright
auth=json.load(open("auth.json"))
with sync_playwright() as p:
    br=p.chromium.launch()
    ctx=br.new_context(viewport={"width":1920,"height":1080}, ignore_https_errors=True)
    ctx.add_init_script(f"localStorage.setItem('token', {json.dumps(auth['token'])}); localStorage.setItem('user', {json.dumps(json.dumps(auth['user']))});")
    pg=ctx.new_page()
    pg.goto("https://localhost:3443/app", wait_until="networkidle")
    pg.wait_for_timeout(3000)
    pg.screenshot(path="dash-main.png")
    # dump nav routes + top-level buttons
    links=pg.eval_on_selector_all("a[href*='#']", "els=>[...new Set(els.map(e=>e.getAttribute('href')))].slice(0,25)")
    btns=pg.eval_on_selector_all("button", "els=>[...new Set(els.map(e=>e.innerText.trim()).filter(Boolean))].slice(0,30)")
    print("ROUTES:", links)
    print("BUTTONS:", btns)
    print("TITLE:", pg.title())
    br.close()
