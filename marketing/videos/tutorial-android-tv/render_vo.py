import subprocess, os
# Voiceover for "Free Digital Signage on Android TV & Fire TV" — same voice/pipeline as the Pi video.
EDGE = os.path.expanduser("~/tts-venv/bin/edge-tts")
VOICE = "en-US-AndrewNeural"
# Hook-first arc. Platform claims kept honest: Android TV + Fire TV (4K/Max/Cube) only — no Tizen/Vega.
SCENES = [
 ("01","Free digital signage — running on a Fire TV Stick, or any Android TV box. No monthly fees, no per-screen charges. It's open source, you host it yourself, and in just a few minutes I'll turn a streaming stick you already own into a live, managed signage player."),
 ("02","Here's what you need: an Amazon Fire TV — a 4K, 4K Max, or Cube — or an Android TV box like an Onn or an NVIDIA Shield, and any screen with an HDMI port. On the software side, you'll point it at a ScreenTinker server: use the free hosted plan, or self-host your own. Both are linked below."),
 ("03","First, grab the ScreenTinker app. It's a single Android package — an APK — downloaded straight from your server. There's nothing to buy and no account gate, just the installer file."),
 ("04","Now sideload it. On a Fire TV, turn on apps from unknown sources, open the Downloader app, and enter the link to the APK. On Android TV it's the same idea — Downloader, or a quick ADB install. A few seconds later, it's on the device."),
 ("05","Launch the app. The first time it runs, it asks for a couple of permissions so it can stay full-screen and draw over everything else. Grant those, and it's ready to pair."),
 ("06","The player comes up full-screen and shows a six-digit pairing code. That code is how you claim the screen. This is exactly what a freshly-deployed sign looks like — no desktop, no clutter, just the code."),
 ("07","Head to your ScreenTinker dashboard, click Add Display, and type in the code. The screen shows up instantly in your device list — online, and under your control."),
 ("08","Now push some content. Upload an image or a video, build a playlist, and hit publish. Within seconds, the stick updates — live. You can schedule it by time of day, split the screen into zones, even sync a video wall across several screens."),
 ("09","And because it's the full Android player, everything comes with it: it keeps itself running if the app restarts, caches content so your sign survives an internet drop, and reports telemetry right back to your dashboard."),
 ("10","That's it — free, open-source digital signage on hardware you already own, with no monthly fees and your data on your own server. The app, the docs, and the GitHub repo are all linked below — give it a star if this helped. Thanks for watching."),
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
