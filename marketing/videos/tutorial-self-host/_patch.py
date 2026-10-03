import re
p = "scenes.py"; s = open(p).read()

NEW = '''SCENES = {
 "01": (head() +
        "<div class='logo'>Screen<b>Tinker</b></div>"
        "<div class='pad' style='justify-content:center'>"
        "<h1 class='a' style='animation-delay:.15s'>Free signage. Self-hosted.<br><span class='hl'>$0 forever.</span></h1>"
        "<div class='sub a' style='animation-delay:.35s;margin-bottom:40px'>Your server, your data — running in one command.</div>"
        "<div class='term a' style='animation-delay:.55s;margin:0'>"
        "<div class='tbar'><span class='dot r'></span><span class='dot y'></span><span class='dot g'></span><span class='ttl'>your-server: ~/screentinker</span></div>"
        "<div class='tbody' style='min-height:auto;padding:26px 40px'>"
        "<div class='tl'><span class='pmt'>$</span> <span class='cmd'>docker compose up -d</span></div>"
        "<div class='tl'><span class='st'>[+] Pulling screentinker</span> <span class='ok'>done ✓</span></div>"
        "<div class='tl'><span class='ok'>✔ ScreenTinker listening on :3001</span></div>"
        "</div></div></div></div>"),
 "02": slate("01 · What you need", "What you <span class='hl'>need</span>", bullets=[
        "A small <b>Linux server</b> <span class='k'>— even a $5 VPS</span>",
        "<b>Docker</b> installed <span class='k'>— the only dependency</span>",
        "A <b>domain</b> <span class='k'>— optional, for clean HTTPS</span>",
        "<b>One container</b> <span class='k'>— dashboard + player + API</span>"]),
 "03": terminal("02 · Get the compose", "your-server: ~/screentinker", [
        "<span class='dim'># clone the repo (or just grab the compose file)</span>",
        "<span class='pmt'>$</span> <span class='cmd'>git clone https://github.com/screentinker/screentinker.git</span>",
        "<span class='pmt'>$</span> <span class='cmd'>cp docker-compose.example.yml docker-compose.yml</span>",
        "",
        "<span class='dim'>#  image:  </span><span class='hdr'>ghcr.io/screentinker/screentinker:latest</span>",
        "<span class='dim'>#  SELF_HOSTED=true   ·   volume  st-data:/data  (db + uploads)</span>"], caret=False),
 "04": terminal("03 · One command", "your-server: docker compose up", [
        "<span class='pmt'>$</span> <span class='cmd'>docker compose up -d</span>",
        "<span class='st'>[+] Pulling screentinker</span> <span class='ok'>… done ✓</span>",
        "<span class='st'>[+] Running database migrations</span> <span class='ok'>done ✓</span>",
        "<span class='ok'>✔ ScreenTinker listening on :3001</span>",
        "",
        "<span class='dim'># no build step, no dependencies to chase</span>"], caret=False),
 "05": slate("04 · First run", "Register the <span class='hl'>first admin</span>",
        sub="In self-hosted mode the first account unlocks everything — no billing, no trial, no caps.",
        extra="<div class='a' style='animation-delay:.7s;margin-top:44px;display:inline-flex;align-items:center;gap:18px;background:#0a1017;border:1px solid #24314a;border-radius:14px;padding:20px 32px;font:600 42px ui-monospace,monospace;color:#cfd8e3;width:fit-content'>"
              "<span style='width:16px;height:16px;border-radius:50%;background:#34d399'></span>http://<b style='color:#fff'>your-server</b>:<span class='hl'>3001</span></div>"),
 "06": terminal("05 · Clean HTTPS (optional)", "Caddyfile — automatic TLS", [
        "<span class='hdr'>signage.example.com</span> {",
        "    <span class='cmd'>reverse_proxy</span> localhost:3001",
        "}",
        "",
        "<span class='pmt'>$</span> <span class='cmd'>caddy run</span>",
        "<span class='ok'>✔ Let's Encrypt certificate issued</span>",
        "<span class='dim'># …or skip it and run plain on your LAN, air-gapped</span>"], caret=False),
 "07": cap_frame("06 · Pair a display", "caps/cap-displays.png", "your-server:3001  ·  Displays",
        "Install a player &gt; <b>pair</b> with a code &gt; it shows up <b>online</b>"),
 "08": slate("07 · The whole platform", "Nothing behind a <span class='hl'>paywall</span>", bullets=[
        "<b>Playlists &amp; scheduling</b> <span class='k'>— dayparting, multi-zone, video walls</span>",
        "<b>Widgets</b> <span class='k'>— clocks, weather, RSS, menus, directories</span>",
        "<b>Proof-of-play</b> <span class='k'>+ multi-workspace + a scoped REST API</span>"]),
 "09": slate("08 · It's yours", "Your data. Your <span class='hl'>disk</span>.", bullets=[
        "<b>Database + media</b> <span class='k'>— on your own server</span>",
        "<b>Backups</b> <span class='k'>— a single file copy</span>",
        "<b>No per-screen fees</b> <span class='k'>— ever. 1 screen or 1,000</span>"]),
 "10": (head() +
        "<div class='cta'>"
        "<div class='logo' style='position:static;font:800 40px sans-serif;color:#8aa'>Screen<b>Tinker</b></div>"
        "<div class='big a' style='animation-delay:.15s'>Free digital signage.<br><b>On hardware you control.</b></div>"
        "<div class='links a' style='animation-delay:.5s'>"
        "<span class='pill'><span class='u'>github.com/screentinker</span></span>"
        "<span class='pill'>Docs</span>"
        "<span class='pill'>Discord</span></div>"
        "<div class='sub a' style='animation-delay:.8s;color:#7b8aa0;text-align:center'>Open source · Self-hostable · No per-screen fees</div>"
        "</div></div>"),
}
'''
s2 = re.sub(r'SCENES = \{.*?\n\}\n', NEW + "\n", s, count=1, flags=re.S)
assert s2 != s, "SCENES block not replaced"
open(p, "w").write(s2)
print("SCENES replaced for self-host")
