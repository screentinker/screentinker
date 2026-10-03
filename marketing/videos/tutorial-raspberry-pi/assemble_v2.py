import subprocess, os
V="audio"; S="scenes"; W="work2"; os.makedirs(W,exist_ok=True)
scenes=[f"{i:02d}" for i in range(1,11)]
OV=0.5   # crossfade duration
TAIL=0.6 # silence tail so the crossfade lands on quiet
def dur(f): return float(subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",f],capture_output=True,text=True).stdout.strip())
durs={s: round(dur(f"{V}/vo-{s}.wav")+TAIL,3) for s in scenes}

# 1) static per-scene clips (NO zoompan -> no jitter), image + VO(+silence tail)
for s in scenes:
    d=durs[s]
    subprocess.run(["ffmpeg","-y","-loglevel","error","-loop","1","-t",f"{d}","-i",f"{S}/s{s}.png",
        "-i",f"{V}/vo-{s}.wav","-vf","scale=1920:1080,format=yuv420p","-af",f"apad=whole_dur={d}",
        "-r","30","-c:v","libx264","-preset","medium","-crf","20","-pix_fmt","yuv420p",
        "-c:a","aac","-b:a","192k","-ar","48000","-ac","2","-shortest",f"{W}/clip-{s}.mp4"],check=True)
print("clips built")

# 2) xfade (video) + acrossfade (audio) chain
inputs=[]
for s in scenes: inputs += ["-i", f"{W}/clip-{s}.mp4"]
vf=[]; af=[]; prev_v="[0:v]"; prev_a="[0:a]"; length=durs["01"]
for k in range(1,10):
    off=round(length-OV,3)
    vf.append(f"{prev_v}[{k}:v]xfade=transition=fade:duration={OV}:offset={off}[v{k}]")
    af.append(f"{prev_a}[{k}:a]acrossfade=d={OV}[a{k}]")
    prev_v=f"[v{k}]"; prev_a=f"[a{k}]"; length=round(length+durs[scenes[k]]-OV,3)
# global fade in/out on final video
vf.append(f"{prev_v}fade=t=in:st=0:d=0.6,fade=t=out:st={round(length-0.9,3)}:d=0.9[vout]")
fc=";".join(vf+af)
subprocess.run(["ffmpeg","-y","-loglevel","error", *inputs,"-filter_complex",fc,
    "-map","[vout]","-map",prev_a,"-c:v","libx264","-preset","medium","-crf","20","-pix_fmt","yuv420p",
    "-c:a","aac","-b:a","192k","-movflags","+faststart","screentinker-pi-tutorial-v2.mp4"],check=True)
print(f"DONE total ~{length:.1f}s")
