import subprocess, os
# Voiceover for "Self-Host Free Digital Signage on a $5 VPS (Docker, 5 minutes)".
# Same voice/pipeline as the other videos. Developer-focused; the documented Docker flow.
EDGE = os.path.expanduser("~/tts-venv/bin/edge-tts")
VOICE = "en-US-AndrewNeural"
SCENES = [
 ("01","Free, open-source digital signage — self-hosted on your own server. No per-screen fees, no vendor lock-in, and your content never leaves your infrastructure. With Docker, the whole platform is running in about five minutes. Let me show you."),
 ("02","You barely need anything: a small Linux server — even a five-dollar VPS is plenty — with Docker installed. Optionally a domain name, if you want a clean HTTPS address. That's it. A single container runs the dashboard, the web player, and the API."),
 ("03","Grab the example compose file from the repo. It points at the published ScreenTinker image, and keeps your database, your uploads, and your settings in one persistent data volume."),
 ("04","Then it's a single command: docker compose up. The container pulls the image, runs its database migrations on first boot, and starts serving on port thirty-oh-one. That's the entire install — no build step, no dependencies to chase."),
 ("05","Open your server in a browser and register the first account. In self-hosted mode, that first user becomes the admin, with every feature unlocked — no billing, no trial, no device caps."),
 ("06","Want a clean HTTPS address? Put it behind a reverse proxy like Caddy — two lines, and you get an automatic, free Let's Encrypt certificate. Or skip that and run it plain on your local network, fully air-gapped."),
 ("07","From here, it's the same as any ScreenTinker setup: install a player on a TV or a Raspberry Pi, pair it with a six-digit code, and it appears in your dashboard, online."),
 ("08","And you get the entire platform — playlists, scheduling, multi-zone layouts, video walls, widgets, proof-of-play analytics, multiple workspaces, and a scoped REST API. Nothing is behind a paywall."),
 ("09","Best of all, it's yours. The database and your media live on your own disk, a backup is a single file copy, and there are no per-screen fees, ever — run one screen, or a thousand."),
 ("10","That's free, self-hosted digital signage — open source, on hardware you control. The Docker image, the docs, and the GitHub repo are all linked below. Give it a star if this helped, and thanks for watching."),
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
