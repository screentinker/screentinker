import subprocess, os
# Voiceover for "ScreenTinker 2.2 — Point an AI at Your Screens".
# MCP-weighted per the user: 2.2 is the MCP release, so six of eleven scenes are the agent surface.
# Device REST / saved endpoints / the LAN control door are presented AS API-ONLY, because that is
# what they are - neither has a line of dashboard UI (triggers do, and are a different feature). Same voice/pipeline as the series.
# Every claim traced to CHANGELOG.md (## 2.2.0) in ~/Downloads/remote_display.
#
# TTS rules (inherited, each one learned the hard way):
#   "two point two", never "2.2"          — digits get read unpredictably
#   never speak "self-hostable"           — TTS mangles it; written copy keeps the keyword
#   spell acronyms: "M C P", "A P I", "P L C", "A M X", "E D I D", "P I N", "E S P thirty-two"
#   say "the Model Context Protocol" the first time, "M C P" after
#   no issue numbers, no resolutions spoken aloud — numbers go ON SCREEN, not in the voice
#   MCP-led per the user's call: the hook and scenes 03/04 are the agent, 12 calls back to it
EDGE = os.path.expanduser("~/tts-venv/bin/edge-tts")
VOICE = "en-US-AndrewNeural"
SCENES = [
 ("01","Which of my screens are offline? In ScreenTinker two point two, that's a question you can just ask, in plain English, and your own signage answers. It speaks the Model Context Protocol."),
 ("02","ScreenTinker is open-source digital signage. Host it yourself, or let us run it for you. And two point two is, more than anything else, the release that opens it up to A I assistants. Here's how that works."),
 ("03","Every instance now serves an M C P endpoint. Point an assistant at it with the token your A P I already takes. Twenty-one tools, chosen rather than generated, because a model gets worse at picking the right one as the list grows."),
 ("04","And the list is filtered by your token's scope. A token marked read-only is shown ten tools. A full one is shown twenty-one. An assistant holding the read-only token is never even told that a write tool exists, so it doesn't spend its turns discovering what it may not do."),
 ("05","So you can ask for work, not just answers. Put the autumn campaign on the lobby screen. Tell me which screens missed their playlist last week. The screens change while you watch."),
 ("06","Underneath, it's a client of your own public A P I. Every tool call is an H T T P request carrying your token, through the same workspace isolation and the same limits a script would hit. There's no second way into the database to drift out of step with the first. And an assistant cannot issue itself a token. A person makes one in the dashboard, and hands it over."),
 ("07","The rest of the site learned to talk to machines too. Every published page has a plain-text version: ask for markdown, or just add dot M D to the address. There's a catalogue of the A P I at a standard address, and an authentication guide written for something that reads rather than clicks."),
 ("08","Two more things arrived as A P I only, for integrators. A screen can make an H T T P request on its own network, because your server is usually in another country with no route to a controller on the customer's LAN. And it can answer one, so a control system in the same rack can bring the sign up with the projector. Both are documented; neither has a dashboard page yet."),
 ("09","Battery-powered signs are documented at last. The server dithers the playlist item to the colours the panel actually has, packs it for the controller, and tells the board how long to deep sleep. Ten panel presets, and no browser on the device."),
 ("10","That's eleven platforms, each with a guide, and a downloads page built from the players your instance actually has. Apple T V is in there too, documented as not supported, with the reasoning, because people keep asking."),
 ("11","And if you already run it: the escape key on the web player used to unpair a screen after a yes-no question, and now wants that screen's settings P I N. The dashboard finally notices its own updates. And reports quietly returned nothing for a perfectly valid date range, which was found by asking the new assistant for a week of uptime and being told, convincingly, that every screen had been dark. That's ScreenTinker two point two. Links below."),
]
if __name__=="__main__":
    os.makedirs("audio",exist_ok=True)
    for sid,text in SCENES:
        out=f"audio/vo-{sid}.wav"
        subprocess.run([EDGE,"--voice",VOICE,"--text",text,"--write-media",out],check=True)
        print("wrote",out)
