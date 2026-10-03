import subprocess, os
# Voiceover for "ScreenTinker 2.3 — Live Data, Templates & a Real Game".
# Lead (user's call): live data + templates. Admin features get FULL coverage (user's call):
# Platform overview, attention items, users/orgs/members, cleanup, sales. The user also asked
# that the game (UPTIME 3036 — proof that code templates can be real custom games) be covered.
# Every claim traced to CHANGELOG.md (## 2.3.0) in ~/Downloads/st-admin-rework.
#
# TTS rules (inherited, each one learned the hard way):
#   "two point three", never "2.3"        — digits get read unpredictably
#   never speak "self-hostable"           — TTS mangles it; written copy keeps the keyword
#   spell acronyms: "A P I", "C S V", "R S S", "Q R", "H T M L"
#   no issue numbers, no resolutions spoken aloud — numbers go ON SCREEN, not in the voice
EDGE = os.path.expanduser("~/tts-venv/bin/edge-tts")
VOICE = "en-US-AndrewNeural"
SCENES = [
 # 01 hook — the price change is real (cap-menu-before/after, same instance, one API edit)
 ("01","Change one number in a table, and the menu board on the wall changes with it. No re-publish, no new slide. In ScreenTinker two point three, your screens can finally read live data."),
 # 02 intro
 ("02","ScreenTinker is open-source digital signage. Host it yourself, or let us run it for you. Two point three brings live data sources, a signed template library, native players for Raspberry Pi and Windows, and a whole new area for the people who run the server."),
 # 03 data source types
 ("03","Five new data sources join calendar and weather: a REST A P I, Google Sheets, C S V, R S S, and a plain table you type into. They're built in, on every workspace, with no plugin to install and no switch to find."),
 # 04 key column
 ("04","One table engine turns any of them into slide variables. And the one to use is the key column. Instead of pointing at row one, you point at the latte's price by name, so when somebody sorts the sheet, the menu still shows the right number."),
 # 05 safety
 ("05","It's careful by default. A P I credentials are encrypted at rest and never read back. An unshared Google Sheet answers with a sign-in page instead of an error, so any page that isn't data is explained, never cached. And every source stays inside its own workspace."),
 # 06 library
 ("06","Then there's the template library. Menu boards, leaderboards, K P I dashboards, meeting room signs, world clocks, a guest Wi-Fi code. Pick one, fill in your fields or bind it to a data source, and it's on screen."),
 # 07 signed
 ("07","Every template comes from a signed catalog. The index and every package carry a signature from a dedicated key, with a serial number so an old catalog can't be replayed, and a revocation list. Templates that run code are sandboxed, and unsigned ones stay off until an administrator allows them."),
 # 08 wall of templates
 ("08","Here they are, rendered by a real server, straight from the signed catalog. Each one adapts to a full screen, a portrait panel, or a thin strip along the bottom of the display."),
 # 09 the game
 ("09","And because a code template can be anything, we shipped a game. UPTIME thirty thirty-six is a first-person arcade shooter about the worst on-call shift of the year: every server is down, and the datacenter is crawling with bugs. Nobody playing? It plays itself, as an attract-mode demo. Pick up the keyboard and it's yours. Everything in it is generated in code, and it's M I T licensed, so it's a starting point for your own."),
 # 10 native players
 ("10","The players grew too. Raspberry Pi and Windows now have native players built on one engine: a package for Pi OS, and a Windows installer with a helper service. They download from your own server, and only update themselves when the checksum matches what that server announced."),
 # 11 platform overview
 ("11","If you run a server for other people, there's a new Platform area. The overview shows the whole instance at a glance: users, organizations, screens online, paying accounts and trials, and the quiet problems, like accounts that never paired a screen."),
 # 12 attention + search + members
 ("12","Needs your attention now expands into the specifics, with a link to the page that fixes each one. Users and organizations are searchable. And organization owners can finally see everyone in the organization, across all of its workspaces."),
 # 13 cleanup
 ("13","Stale accounts get a cleanup that asks before it deletes. An account qualifies only if it isn't paying, has no screens, shares nothing, and hasn't done anything for a long time. It gets an email notice first. Signing in cancels it. And only accounts whose notice ran out can be removed."),
 # 14 sales
 ("14","And you can run a limited-time sale. Set the discount, the plans, and the dates. The homepage gets a banner and a countdown, the billing page shows the struck-through price, and checkout charges exactly that price, because every sale is a real Stripe coupon."),
 # 15 look + fixes + security
 ("15","The dashboard got a new look, with the sidebar grouped by job. Uploads now move in small chunks, so a slow link can finish. Folders work again when adding content. A screen that fails no longer reports a perfect run of plays. And four security issues found while testing the template library are closed."),
 # 16 close
 # 16 close — the HOSTED trial is the primary ask (user: "we want people to buy it"); self-hosting is the alternative
 ("16","That's ScreenTinker two point three. Start your free fourteen-day trial today. Or, if you'd rather, host it yourself for free. Links are below."),
]
if __name__=="__main__":
    import sys
    only = set(sys.argv[1:])
    os.makedirs("audio",exist_ok=True)
    for sid,text in SCENES:
        if only and sid not in only: continue
        out=f"audio/vo-{sid}.wav"
        import time
        for attempt in range(5):   # edge-tts intermittently returns NoAudioReceived
            if subprocess.run([EDGE,"--voice",VOICE,"--text",text,"--write-media",out]).returncode == 0: break
            time.sleep(3 + attempt * 3)
        else:
            raise SystemExit(f"edge-tts failed 5x on {sid}")
        print("wrote",out)
