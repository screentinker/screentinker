import subprocess, os
# Voiceover for "ScreenTinker 2.1 — What's New Since 2.0". Same voice/pipeline as the series.
# Every claim traced to CHANGELOG.md (2.0.1 .. 2.1.0) in ~/Downloads/remote_display.
# TTS rules (from prior videos): say "two point one" not "2.1"; never speak "self-hostable"
# ("you host it yourself"); spell acronyms (WebRTC -> "web R T C") BUT JSON -> "Jason" (say jay-son),
# PDF -> "P D F", iCal -> "calendar feed"); no issue numbers; a new visual every scene.
EDGE = os.path.expanduser("~/tts-venv/bin/edge-tts")
VOICE = "en-US-AndrewNeural"
SCENES = [
 ("01","Since ScreenTinker two point oh, the open-source signage platform has picked up live video, voice, live data on your slides, and a plugin system. Here's everything that shipped on the way to two point one."),
 ("02","You can now watch what a screen is actually showing. Live view streams a display's real output, sub-second, over web R T C — not a thumbnail from a minute ago. It's optional, and off until you turn it on."),
 ("03","And you can talk back. Talk is a voice intercom and public-address channel to your screens over that same connection. Page a single lobby, or make an announcement across a building. Off by default, enabled per organization, with your own relay."),
 ("04","Slides can now show live data. Register an external source — a calendar, or any Jason feed over H T T P — and bind its values straight into a slide or a widget with a simple tag. The screen refreshes the data on its own schedule."),
 ("05","The clearest example is a meeting-room sign. Point it at a room's calendar and it shows Busy or Available, what's on now, and when the room frees up. In two point one, that sign speaks every language the dashboard does, and it defaults to English."),
 ("06","Two point one adds a plugin system. On a server you host, you can add new widget types, new data connectors, and event hooks, without forking the code. It's off by default — and a plugin never runs until an administrator approves that exact copy."),
 ("07","Plugins live in one place. An administrator sees each one, what it's allowed to do, and the exact bytes that were approved, before enabling it. No marketplace, no phone-home. Just code you chose to trust."),
 ("08","Have a P D F? Drop it in, and every page becomes a full-screen slide, rendered right in your browser. A deck exported to P D F comes out ready to play, in order, with no conversion step and no extra tools."),
 ("09","For teams, there's approval and version history. A workspace can require a review before a change goes live, and every content item, playlist and slide keeps its past versions — so you can see what changed, and roll back."),
 ("10","The player reaches more screens. L G webOS panels, e-paper and microcontroller displays, and a published list of certified hardware that tells you which devices are tested, what resolution each really runs at, and which to avoid."),
 ("11","The player itself got quieter and sharper. Bring your own transition shader, or use the built-in crossfade. Video no longer flashes black between clips. And a portrait panel driven in landscape now fills the screen, instead of sitting in bars."),
 ("12","All of it is open source. Don't want to run a server yourself? There's a hosted option. We'll run ScreenTinker for you, fully managed. Or host it yourself. Upgrading is just a pull and a restart, and your screens keep playing straight through it. That's ScreenTinker two point one. Links below."),
 ("13","One more thing. This whole video was built and tested in ScreenTinker. Every slide you just watched is a ScreenTinker slide, playing on a real ScreenTinker screen."),
]
if __name__=="__main__":
    os.makedirs("audio",exist_ok=True)
    for sid,text in SCENES:
        out=f"audio/vo-{sid}.wav"
        subprocess.run([EDGE,"--voice",VOICE,"--text",text,"--write-media",out],check=True)
        print("wrote",out)
