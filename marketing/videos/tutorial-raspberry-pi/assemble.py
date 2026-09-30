import subprocess, os, re
V="audio"; S="scenes"; W="work"; os.makedirs(W,exist_ok=True)
scenes=[f"{i:02d}" for i in range(1,11)]
TEXT={
"01":"Free digital signage, running on a Raspberry Pi. No monthly fees, no per-screen charges. It's open source, you host it yourself.",
"02":"Everything you need: a Raspberry Pi, a microSD card, and any HDMI screen. Then point it at a ScreenTinker server — free plan or self-hosted.",
"03":"Flash Raspberry Pi OS onto the card with the Raspberry Pi Imager. Choose Pi OS Lite, pick your card, and write.",
"04":"Boot the Pi. It comes straight up into Raspberry Pi OS, ready to go.",
"05":"Log in and run one command. It installs Chromium, sets up a kiosk service, and points it at your server.",
"06":"The installer handles the tedious parts: auto-login, an auto-restarting player service, and no screen blanking.",
"07":"Reboot, and the Pi comes up into the player — full-screen, showing a pairing code.",
"08":"In your dashboard, click Add Display and enter the code. The screen shows up instantly — online.",
"09":"Push content: upload media, build a playlist, publish. The Pi updates live. Schedule it, zone it, video-wall it.",
"10":"Free, open-source digital signage on your own hardware. Links are below — and give the repo a star.",
}
def dur(f): return float(subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",f],capture_output=True,text=True).stdout.strip())
def secs(t):
    h=int(t//3600);m=int((t%3600)//60);s=t%60; return f"{h:02d}:{m:02d}:{s:06.3f}".replace('.',',')
durs={s:dur(f"{V}/vo-{s}.wav")+0.5 for s in scenes}  # +0.5s tail per scene

# 1) per-scene clips: loop image, subtle zoom, VO audio padded to clip length
for s in scenes:
    d=durs[s]; frames=int(d*30)
    vf=(f"scale=1920:1080,zoompan=z='min(zoom+0.00035,1.06)':x='iw/2-(iw/zoom/2)':"
        f"y='ih/2-(ih/zoom/2)':d={frames}:s=1920x1080:fps=30,format=yuv420p")
    subprocess.run(["ffmpeg","-y","-loglevel","error","-loop","1","-i",f"{S}/s{s}.png",
        "-i",f"{V}/vo-{s}.wav","-t",f"{d:.3f}","-vf",vf,
        "-af","apad,atrim=0:{:.3f},afade=t=out:st={:.2f}:d=0.4".format(d,d-0.4),
        "-r","30","-c:v","libx264","-preset","medium","-crf","20","-pix_fmt","yuv420p",
        "-c:a","aac","-b:a","192k","-ar","48000", f"{W}/clip-{s}.mp4"],check=True)
    print(f"clip-{s}: {d:.1f}s")

# 2) SRT captions (chunk each scene's text, distribute across its span)
srt=[]; idx=1; t=0.0
for s in scenes:
    d=durs[s]; text=TEXT[s]
    chunks=re.findall(r'[^.]+\.?', text); chunks=[c.strip() for c in chunks if c.strip()]
    # merge tiny chunks
    merged=[]; 
    for c in chunks:
        if merged and len(merged[-1])+len(c)<48: merged[-1]+=" "+c
        else: merged.append(c)
    total=sum(len(c) for c in merged) or 1; ct=t
    for c in merged:
        seg=(len(c)/total)*(d-0.3)
        srt.append(f"{idx}\n{secs(ct)} --> {secs(ct+seg)}\n{c}\n"); idx+=1; ct+=seg
    t+=d
open(f"{W}/caps.srt","w").write("\n".join(srt))

# 3) concat clips
open(f"{W}/list.txt","w").write("\n".join(f"file 'clip-{s}.mp4'" for s in scenes))
subprocess.run(["ffmpeg","-y","-loglevel","error","-f","concat","-safe","0","-i",f"{W}/list.txt",
    "-c","copy",f"{W}/joined.mp4"],check=True)

# 4) burn captions + global fade in/out
style="Fontname=DejaVu Sans,Fontsize=15,PrimaryColour=&H00FFFFFF,OutlineColour=&HC0000000,BorderStyle=3,Outline=6,Shadow=0,MarginV=60,Bold=1"
total=sum(durs.values())
subprocess.run(["ffmpeg","-y","-loglevel","error","-i",f"{W}/joined.mp4",
    "-vf",f"subtitles={W}/caps.srt:force_style='{style}',fade=t=in:st=0:d=0.6,fade=t=out:st={total-0.8:.2f}:d=0.8",
    "-c:v","libx264","-preset","medium","-crf","20","-pix_fmt","yuv420p","-c:a","copy",
    "screentinker-pi-tutorial-v1.mp4"],check=True)
print(f"\nDONE: screentinker-pi-tutorial-v1.mp4  ({total:.0f}s / {total/60:.1f} min)")
