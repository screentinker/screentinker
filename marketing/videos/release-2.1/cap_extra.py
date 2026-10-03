import os,json,time,urllib.request
from playwright.sync_api import sync_playwright
BASE="http://localhost:3011"; TOK=open(".token").read().strip()
u=urllib.request.urlopen(urllib.request.Request(BASE+"/api/auth/me",headers={"Authorization":f"Bearer {TOK}"})).read().decode()
with sync_playwright() as p:
    br=p.chromium.launch(args=["--force-color-profile=srgb"])
    pg=br.new_page(viewport={"width":1600,"height":900},device_scale_factor=2)
    pg.add_init_script(f"localStorage.setItem('token',{json.dumps(TOK)});localStorage.setItem('user',{json.dumps(u)});localStorage.setItem('rd_onboarded','1');localStorage.setItem('rd_gs_dismissed','1');")
    for name,route,st in [("cap-reviews","/app#/reviews",2.5),("cap-certified","/certified-hardware",3.0)]:
        try:
            pg.goto(BASE+route,wait_until="networkidle"); time.sleep(st)
            pg.screenshot(path=f"caps/{name}.png"); print("wrote",name, os.path.getsize(f'caps/{name}.png')//1024,"KB")
        except Exception as e: print("FAIL",name,e)
    br.close()
