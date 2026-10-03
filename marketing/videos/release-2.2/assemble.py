#!/usr/bin/env python3
# Assemble the scene frame-sequences + VO into "ScreenTinker 2.0".
#
# Every scene is a FULL-DURATION frame sequence (motion baked in by scenes.py), so there is no
# STATIC/ANIM split like the Pi video — just per-scene clips, then one xfade/acrossfade chain.
#
#   python3 assemble.py         -> draft-nomusic.mp4        (for review)
#   python3 assemble.py final   -> screentinker-2p0.mp4     (music bed ducked under the VO)
#
# ⚠️ SCENE COUNT IS DERIVED, NOT HARDCODED. The version this was cloned from had `range(1,11)` and
#    `for k in range(1,10)` written out twice; bumping to 17 scenes by editing one of them would
#    silently drop the tail of the video.
import subprocess, os, sys, glob

V="audio"; SA="scenes_anim"; W="work"; os.makedirs(W, exist_ok=True)
OV=0.5; TAIL=0.6
OUTNAME="screentinker-2p2.mp4"

scenes=sorted(os.path.basename(d)[1:] for d in glob.glob(f"{SA}/s*") if os.path.isdir(d))
if not scenes: raise SystemExit(f"no frame directories in {SA}/ — run: python3 scenes.py frames 1 17")
FINAL = len(sys.argv)>1 and sys.argv[1]=="final"

def dur(f):
    return float(subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",f],
                                capture_output=True, text=True).stdout.strip())

durs={s: round(dur(f"{V}/vo-{s}.wav")+TAIL,3) for s in scenes}
for s in scenes:
    n=len(glob.glob(f"{SA}/s{s}/f*.jpg")); want=int(round(durs[s]*30))
    if abs(n-want) > 1:
        print(f"  !! s{s}: {n} frames but {want} expected for {durs[s]:.1f}s — re-render this scene")
print(f"{len(scenes)} scenes, {sum(durs.values()):.1f}s of clips before crossfades\n")

# ---- per-scene clips: JPEG sequence + its VO
for s in scenes:
    d=durs[s]
    subprocess.run(["ffmpeg","-y","-loglevel","error",
        "-framerate","30","-i",f"{SA}/s{s}/f%04d.jpg","-i",f"{V}/vo-{s}.wav",
        "-vf","scale=1920:1080,format=yuv420p","-af",f"apad=whole_dur={d}","-t",f"{d}","-r","30",
        "-c:v","libx264","-preset","medium","-crf","20","-pix_fmt","yuv420p",
        "-c:a","aac","-b:a","192k","-ar","48000","-ac","2","-shortest",f"{W}/clip-{s}.mp4"], check=True)
    print(f"clip-{s}: {d:.1f}s")

# ---- scene 13: overlay the live console recording onto the framed "screen" (rect 480,254,960,540)
LAST=scenes[-1]
if os.path.exists(f"{W}/console_screen.mp4"):
    base=f"{W}/clip-{LAST}.mp4"; tmp=f"{W}/clip-{LAST}-ov.mp4"
    subprocess.run(["ffmpeg","-y","-loglevel","error","-i",base,"-i",f"{W}/console_screen.mp4",
        "-filter_complex","[1:v]scale=960:540,setpts=PTS-STARTPTS[scr];[0:v][scr]overlay=480:254[v]",
        "-map","[v]","-map","0:a","-c:v","libx264","-preset","medium","-crf","20","-pix_fmt","yuv420p",
        "-c:a","copy",tmp],check=True)
    os.replace(tmp,base); print(f"overlaid console recording onto clip-{LAST}")

# ---- one crossfade chain across every scene
inputs=[]
for s in scenes: inputs+=["-i",f"{W}/clip-{s}.mp4"]
vf=[]; af=[]; pv="[0:v]"; pa="[0:a]"; L=durs[scenes[0]]
for k in range(1, len(scenes)):
    off=round(L-OV,3)
    vf.append(f"{pv}[{k}:v]xfade=transition=fade:duration={OV}:offset={off}[v{k}]")
    af.append(f"{pa}[{k}:a]acrossfade=d={OV}[a{k}]")
    pv=f"[v{k}]"; pa=f"[a{k}]"; L=round(L+durs[scenes[k]]-OV,3)
vf.append(f"{pv}fade=t=in:st=0:d=0.6,fade=t=out:st={round(L-0.9,3)}:d=0.9[vout]")

subprocess.run(["ffmpeg","-y","-loglevel","error", *inputs, "-filter_complex", ";".join(vf+af),
    "-map","[vout]","-map",pa,"-c:v","libx264","-preset","medium","-crf","20","-pix_fmt","yuv420p",
    "-c:a","aac","-b:a","192k","-movflags","+faststart","draft-nomusic.mp4"], check=True)
print(f"\nvideo done ~{L:.1f}s ({L/60:.2f} min) -> draft-nomusic.mp4")

if FINAL:
    # Music bed: loop the track, duck it under the VO via sidechaincompress, fade both ends.
    # Every video in this series lands at -20.2 LUFS with these numbers.
    subprocess.run(["ffmpeg","-y","-loglevel","error","-i","draft-nomusic.mp4",
        "-stream_loop","-1","-i","Quiet Tech Pulse.mp3",
        "-filter_complex",
        "[0:a]aformat=channel_layouts=stereo,asplit=2[voc][vsc];"
        "[1:a]aformat=channel_layouts=stereo,volume=0.32,"
        f"afade=t=in:st=0:d=2.5,afade=t=out:st={round(L-3.2,3)}:d=3.2[bed];"
        "[bed][vsc]sidechaincompress=threshold=0.03:ratio=8:attack=25:release=320[duck];"
        "[voc][duck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]",
        "-map","0:v","-map","[mix]","-t",f"{L}","-c:v","copy","-c:a","aac","-b:a","192k",
        "-movflags","+faststart",OUTNAME], check=True)
    print(f"FINAL with music -> {OUTNAME}")
