import subprocess, os
# Voiceover for "Free Alternative to Yodeck, ScreenCloud & OptiSigns".
# Same voice/pipeline as the other videos. FAIR, factual framing — numbers come straight from
# ScreenTinker's own published compare pages (publicly listed vendor pricing, mid-2026).
EDGE = os.path.expanduser("~/tts-venv/bin/edge-tts")
VOICE = "en-US-AndrewNeural"
SCENES = [
 ("01","Yodeck. ScreenCloud. OptiSigns. They're all polished digital signage products — and they all charge you per screen, every month, for as long as you run them. There's a free, open-source alternative that does the same job. Let me show you the honest comparison."),
 ("02","These are good tools. They're mature, they're easy to onboard, and they have big template libraries. But they share two things: they're cloud-only, so your content lives on someone else's servers — and they price per screen, so your bill grows every time you add a display."),
 ("03","ScreenTinker is the open-source alternative. It's MIT licensed, you can host it yourself, and it runs on hardware you already own — Android TVs, Fire Sticks, a Raspberry Pi, or any web browser. No proprietary player to buy."),
 ("04","And it's not a stripped-down clone. Feature for feature, it matches them: playlists and scheduling, multi-zone layouts, synchronized video walls, widgets, and proof-of-play analytics. The things you'd actually switch for are all here."),
 ("05","Here's where it adds up. Yodeck runs about eight dollars per screen a month. OptiSigns, around eleven. ScreenCloud targets enterprise and climbs faster than either. That's a linear cost curve — it never stops growing."),
 ("06","Take fifteen screens. At published rates, that's roughly a hundred and twenty a month on Yodeck, one-sixty-five on OptiSigns, and three hundred or more on ScreenCloud. ScreenTinker's hosted plan is a flat ninety-nine for the same fifteen. Or you host it yourself — and that is completely free, for any number of screens. You just pay for the server, and that starts around five dollars a month."),
 ("07","Hosting it yourself also means your data never leaves your infrastructure. For healthcare, government, or anyone under a compliance rule that won't allow a third-party cloud, that isn't a nice-to-have — it's the whole reason to switch."),
 ("08","To be fair — the paid tools still win in places. Yodeck ships pre-configured Pi players. ScreenCloud has best-in-class Slack and Power BI integrations. OptiSigns has a huge template library. If those matter most to you, they're worth the money."),
 ("09","But if you have a bit of technical capacity, care about owning your data, or you're feeling the per-screen squeeze — the open-source option gives you the same platform, without the meter running."),
 ("10","That's the honest alternative to Yodeck, ScreenCloud, and OptiSigns. Hosting it yourself is completely free, it's open source, and it's on GitHub — links are below. Give it a star if this helped, and thanks for watching."),
]
os.makedirs("audio", exist_ok=True)
for sid, text in SCENES:
    mp3 = f"audio/vo-{sid}.mp3"; wav = f"audio/vo-{sid}.wav"
    subprocess.run([EDGE,"--voice",VOICE,"--text",text,"--write-media",mp3], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["ffmpeg","-y","-loglevel","error","-i",mp3,"-ar","24000","-ac","1",wav], check=True)
    dur = subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",wav],
                         capture_output=True,text=True).stdout.strip()
    print(f"vo-{sid}: {float(dur):.1f}s")
tot = sum(float(subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",f"audio/vo-{s}.wav"],capture_output=True,text=True).stdout.strip()) for s,_ in SCENES)
print(f"\nTOTAL narration: {tot:.0f}s ({tot/60:.2f} min)")
