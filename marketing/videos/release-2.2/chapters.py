#!/usr/bin/env python3
"""
Compute YouTube chapter timings from the VO durations and the crossfade overlap.

⚠️ CHAPTERS ARE COMPUTED, NEVER TYPED. Re-render one VO line and every chapter after it moves;
the 2.1 video shipped a description whose timings were all wrong for exactly that reason. This
reads audio/vo-NN.wav, so it cannot disagree with the video unless the video was not rebuilt.

YouTube requires the first chapter to start at 00:00 and each to be at least 10s long.
"""
import glob, os, subprocess, sys

OV, TAIL = 0.5, 0.6   # must match assemble.py
TITLES = {
 "01": "Just ask it",
 "02": "What ScreenTinker 2.2 is",
 "03": "The MCP endpoint, and 21 tools",
 "04": "Scoped: read-only sees ten",
 "05": "Asking for work, not just answers",
 "06": "It's your own API (and tokens are human-issued)",
 "07": "A site machines can read",
 "08": "Device REST and the LAN door (API only)",
 "09": "E-paper and ESP32 signs",
 "10": "Eleven platforms, and a downloads page",
 "11": "Also in 2.2, and where to get it",
}

def dur(f):
    return float(subprocess.run(
        ["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",f],
        capture_output=True, text=True).stdout.strip())

def main():
    ids = sorted(os.path.basename(f)[3:5] for f in glob.glob("audio/vo-*.wav"))
    if not ids:
        raise SystemExit("no audio/vo-*.wav — run generate_vo_timed.py first")
    durs = [dur(f"audio/vo-{i}.wav") + TAIL for i in ids]
    t, lines, prev = 0.0, [], None
    for n, (i, d) in enumerate(zip(ids, durs)):
        start = max(0.0, t - OV * n)
        if n == 0:
            start = 0.0
        mm, ss = divmod(int(start), 60)
        if prev is not None and start - prev < 10:
            print(f"  !! chapter {i} is {start-prev:.1f}s after the previous one — "
                  "YouTube needs 10s minimum, merge or lengthen it", file=sys.stderr)
        lines.append(f"{mm}:{ss:02d} {TITLES.get(i, i)}")
        prev = start
        t += d
    total = t - OV * (len(ids) - 1)
    mm, ss = divmod(int(round(total)), 60)
    print("\n".join(lines))
    print(f"\n# total {mm}:{ss:02d}")

if __name__ == "__main__":
    main()
