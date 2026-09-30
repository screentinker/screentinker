import subprocess, os
# Voiceover for "Free Digital Signage on a Samsung TV — No Box, No App, Just a URL".
# Same voice/pipeline as the Pi & Android TV videos. Honest scope: Samsung signage displays (SSSP) and
# Samsung TVs with a URL Launcher / built-in browser. Never claims audio (Tizen player is muted).
EDGE = os.path.expanduser("~/tts-venv/bin/edge-tts")
VOICE = "en-US-AndrewNeural"
SCENES = [
 ("01","Free digital signage, on a Samsung TV — with no extra box, no app to install, and no monthly fees. It's open source, you host it yourself, and it runs straight from a web address. In a couple of minutes, I'll turn a Samsung screen into a live, managed sign."),
 ("02","Here's all you need: a Samsung signage display, or a Samsung TV with a URL Launcher or a built-in web browser. Plus a ScreenTinker server to point it at — the free hosted plan, or self-host your own. Both are linked below. No streaming stick, nothing to plug in."),
 ("03","The entire player is just a web page, served by your ScreenTinker server at slash player. So instead of installing anything, you hand your TV that one web address, and it does the rest."),
 ("04","On a Samsung signage display, open the URL Launcher and set the address to your server, slash player. On a regular Samsung TV, the built-in web browser works the same way. Save it as the boot source, and the screen opens straight into the player every time it powers on."),
 ("05","The player loads full-screen — no menus, no desktop. Within a few seconds you're looking at the ScreenTinker player, ready to be claimed."),
 ("06","It shows a six-digit pairing code. That code is how you take control of the screen. This is exactly what a freshly-deployed sign looks like — clean, and waiting for content."),
 ("07","Head to your ScreenTinker dashboard, click Add Display, and enter the code. The Samsung screen appears in your device list instantly — online, and under your control."),
 ("08","Now push content. Upload an image or a video, build a playlist, and hit publish. Within seconds, the TV updates — live. You can schedule by time of day, split the screen into zones, even build a video wall across several panels."),
 ("09","It renders the same rich layouts as the rest of ScreenTinker — multi-zone screens, widgets like clocks and menus, and it keeps displaying your content even if the network drops."),
 ("10","And that's it — free, open-source digital signage on a Samsung TV, with no box, no app, and no monthly fees. The player URL, the docs, and the GitHub repo are all linked below — give it a star if this helped. Thanks for watching."),
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
