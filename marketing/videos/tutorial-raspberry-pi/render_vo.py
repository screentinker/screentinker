import subprocess, os
EDGE = os.path.expanduser("~/tts-venv/bin/edge-tts")
VOICE = "en-US-AndrewNeural"
SCENES = [
 ("01","Free digital signage, running on a Raspberry Pi. No monthly fees, no per-screen charges. It's open source, you host it yourself, and in just a few minutes I'll turn a bare Pi into a live signage player — from a blank SD card to a screen showing exactly what you want."),
 ("02","Here's everything you need: a Raspberry Pi — a 4 or 5 — a microSD card, and any screen with an HDMI port. On the software side, you'll point the Pi at a ScreenTinker server. You can use the free hosted plan, or self-host your own. Both are linked below."),
 ("03","Start by flashing Raspberry Pi OS onto the card. Open the Raspberry Pi Imager, choose Raspberry Pi OS Lite — we don't need a desktop — pick your SD card, and write. A couple of minutes later, you've got a bootable card."),
 ("04","Pop the card into the Pi, plug in your screen, and power it on. It boots straight into Raspberry Pi OS and drops you at a login prompt. So far, so normal."),
 ("05","Now the good part. Log in, and run this single command. It downloads the ScreenTinker installer and does everything for you: it installs Chromium, sets up a kiosk service that launches the player full-screen, and points it at your server. No config files, no fiddling."),
 ("06","Under the hood, the installer handles the tedious parts: auto-login on boot, a service that keeps the player running and restarts it if it ever crashes, and it disables screen blanking so your sign never goes dark."),
 ("07","Reboot, and the Pi comes straight up into the ScreenTinker player, full-screen, showing a pairing code. That code is how you claim the screen. This is exactly what a freshly-deployed sign looks like."),
 ("08","Head to your ScreenTinker dashboard, click Add Display, and enter the code. The screen shows up instantly in your device list — online, and under your control."),
 ("09","Now push some content. Upload an image or a video, build a playlist, and hit publish. Within seconds, the Pi updates — live. You can schedule it by time of day, split the screen into zones, even sync a video wall across several screens."),
 ("10","And that's it: a free, open-source digital sign on a Raspberry Pi, with no monthly fees and your data on your own hardware. The install command, the docs, and the GitHub repo are all linked below — give it a star if this helped. Thanks for watching."),
]
for sid, text in SCENES:
    mp3 = f"audio/vo-{sid}.mp3"; wav = f"audio/vo-{sid}.wav"
    subprocess.run([EDGE,"--voice",VOICE,"--text",text,"--write-media",mp3], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["ffmpeg","-y","-loglevel","error","-i",mp3,"-ar","24000","-ac","1",wav], check=True)
    dur = subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",wav],
                         capture_output=True,text=True).stdout.strip()
    print(f"vo-{sid}: {float(dur):.1f}s")
tot = sum(float(subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",f"audio/vo-{s}.wav"],capture_output=True,text=True).stdout.strip()) for s,_ in SCENES)
print(f"\nTOTAL narration: {tot:.0f}s ({tot/60:.1f} min)")
