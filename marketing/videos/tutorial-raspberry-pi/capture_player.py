from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    br=p.chromium.launch()
    pg=br.new_page(viewport={"width":1920,"height":1080})
    pg.goto("https://alpha.screentinker.com/player", wait_until="networkidle")
    # wait for the pairing code to appear
    try: pg.wait_for_selector("text=Pairing Code", timeout=20000)
    except: pass
    pg.wait_for_timeout(3500)
    pg.screenshot(path="player-clean.png")
    # grab the code shown, so we can clean it up on alpha after
    import re
    body=pg.inner_text("body")
    m=re.search(r"\b(\d{6})\b", body)
    print("code:", m.group(1) if m else "?")
    br.close()
