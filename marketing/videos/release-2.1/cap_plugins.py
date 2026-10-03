import os,json,time,urllib.request
from playwright.sync_api import sync_playwright
BASE="http://localhost:3011"; TOK=open(".token").read().strip()
u=urllib.request.urlopen(urllib.request.Request(BASE+"/api/auth/me",headers={"Authorization":f"Bearer {TOK}"})).read().decode()
with sync_playwright() as p:
    br=p.chromium.launch(args=["--force-color-profile=srgb"])
    pg=br.new_page(viewport={"width":1600,"height":900},device_scale_factor=2)
    pg.add_init_script(f"localStorage.setItem('token',{json.dumps(TOK)});localStorage.setItem('user',{json.dumps(u)});localStorage.setItem('rd_onboarded','1');localStorage.setItem('rd_gs_dismissed','1');")
    pg.goto(BASE+"/app#/admin",wait_until="networkidle"); time.sleep(3)
    # find a Plugins heading and scroll it to the top
    el=pg.query_selector("xpath=//*[self::h2 or self::h3][contains(translate(text(),'PLUGIN','plugin'),'plugin')]")
    if el:
        pg.evaluate("(e)=>e.scrollIntoView({block:'start'})", el); time.sleep(1.2)
        print("scrolled to Plugins heading")
    else:
        pg.evaluate("window.scrollTo(0, document.body.scrollHeight)"); time.sleep(1.2)
        print("Plugins heading not found; scrolled to bottom")
    pg.screenshot(path="caps/cap-plugins.png")
    print("wrote caps/cap-plugins.png")
    br.close()
