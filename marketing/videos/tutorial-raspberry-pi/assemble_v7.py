import subprocess, os
V="audio"; S="scenes"; SA="scenes_anim"; W="work3"; os.makedirs(W,exist_ok=True)
scenes=[f"{i:02d}" for i in range(1,11)]
ANIM={"02","04","05","06","10"}   # HTML animated slates
STATIC={"01","03","07","08","09"}                # player shot + framed captures
OV=0.5; TAIL=0.6; ENTER=1.9
def dur(f): return float(subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",f],capture_output=True,text=True).stdout.strip())
durs={s: round(dur(f"{V}/vo-{s}.wav")+TAIL,3) for s in scenes}

for s in scenes:
    d=durs[s]
    if s in ANIM:
        hold=round(max(0.1,d-ENTER),3)
        vf=f"tpad=stop_mode=clone:stop_duration={hold},format=yuv420p"
        vin=["-framerate","30","-i",f"{SA}/s{s}/f%04d.png"]
    else:
        vf="scale=1920:1080,format=yuv420p"
        vin=["-loop","1","-t",f"{d}","-i",f"{S}/s{s}.png"]
    subprocess.run(["ffmpeg","-y","-loglevel","error", *vin, "-i",f"{V}/vo-{s}.wav",
        "-vf",vf,"-af",f"apad=whole_dur={d}","-t",f"{d}","-r","30",
        "-c:v","libx264","-preset","medium","-crf","20","-pix_fmt","yuv420p",
        "-c:a","aac","-b:a","192k","-ar","48000","-ac","2","-shortest",f"{W}/clip-{s}.mp4"],check=True)
    print(f"clip-{s} ({'anim' if s in ANIM else 'static'}): {d:.1f}s")

# crossfade chain (video xfade + audio acrossfade)
inputs=[]
for s in scenes: inputs+=["-i",f"{W}/clip-{s}.mp4"]
vf=[]; af=[]; pv="[0:v]"; pa="[0:a]"; L=durs["01"]
for k in range(1,10):
    off=round(L-OV,3)
    vf.append(f"{pv}[{k}:v]xfade=transition=fade:duration={OV}:offset={off}[v{k}]")
    af.append(f"{pa}[{k}:a]acrossfade=d={OV}[a{k}]")
    pv=f"[v{k}]"; pa=f"[a{k}]"; L=round(L+durs[scenes[k]]-OV,3)
vf.append(f"{pv}fade=t=in:st=0:d=0.6,fade=t=out:st={round(L-0.9,3)}:d=0.9[vout]")
subprocess.run(["ffmpeg","-y","-loglevel","error", *inputs,"-filter_complex",";".join(vf+af),
    "-map","[vout]","-map",pa,"-c:v","libx264","-preset","medium","-crf","20","-pix_fmt","yuv420p",
    "-c:a","aac","-b:a","192k","-movflags","+faststart","screentinker-pi-tutorial-v7.mp4"],check=True)
print(f"\nDONE ~{L:.1f}s")
