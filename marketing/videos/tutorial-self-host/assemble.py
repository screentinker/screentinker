#!/usr/bin/env python3
# Assemble the scene frame-sequences + VO into the video. Every scene is a full-duration frame sequence
# (continuous motion baked in), so there's no STATIC/ANIM split like the Pi video — just concat + xfade.
#   python3 assemble.py            -> draft-nomusic.mp4   (no music, for review)
#   python3 assemble.py final      -> screentinker-selfhost.mp4 (music bed mixed in)
import subprocess, os, sys
V="audio"; SA="scenes_anim"; W="work"; os.makedirs(W,exist_ok=True)
scenes=[f"{i:02d}" for i in range(1,11)]
OV=0.5; TAIL=0.6
FINAL = len(sys.argv)>1 and sys.argv[1]=="final"
def dur(f): return float(subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",f],capture_output=True,text=True).stdout.strip())
durs={s: round(dur(f"{V}/vo-{s}.wav")+TAIL,3) for s in scenes}

# per-scene clips from JPEG frame sequences + VO
for s in scenes:
    d=durs[s]
    subprocess.run(["ffmpeg","-y","-loglevel","error",
        "-framerate","30","-i",f"{SA}/s{s}/f%04d.jpg","-i",f"{V}/vo-{s}.wav",
        "-vf","scale=1920:1080,format=yuv420p","-af",f"apad=whole_dur={d}","-t",f"{d}","-r","30",
        "-c:v","libx264","-preset","medium","-crf","20","-pix_fmt","yuv420p",
        "-c:a","aac","-b:a","192k","-ar","48000","-ac","2","-shortest",f"{W}/clip-{s}.mp4"],check=True)
    print(f"clip-{s}: {d:.1f}s")

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
    "-c:a","aac","-b:a","192k","-movflags","+faststart","draft-nomusic.mp4"],check=True)
print(f"\nvideo done ~{L:.1f}s -> draft-nomusic.mp4")

if FINAL:
    # Music bed: loop the Suno track, duck it under the VO (sidechaincompress), fades, mux over the video.
    out="screentinker-selfhost.mp4"
    subprocess.run(["ffmpeg","-y","-loglevel","error","-i","draft-nomusic.mp4","-stream_loop","-1","-i","Quiet Tech Pulse.mp3",
        "-filter_complex",
        "[0:a]aformat=channel_layouts=stereo,asplit=2[voc][vsc];"
        "[1:a]aformat=channel_layouts=stereo,volume=0.32,"
        f"afade=t=in:st=0:d=2.5,afade=t=out:st={round(L-3.2,3)}:d=3.2[bed];"
        "[bed][vsc]sidechaincompress=threshold=0.03:ratio=8:attack=25:release=320[duck];"
        "[voc][duck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]",
        "-map","0:v","-map","[mix]","-t",f"{L}","-c:v","copy","-c:a","aac","-b:a","192k","-movflags","+faststart",out],check=True)
    print(f"FINAL with music -> {out}")
