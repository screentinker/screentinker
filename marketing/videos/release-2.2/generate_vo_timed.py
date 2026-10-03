#!/usr/bin/env python3
# Regenerate the VO AND capture per-word timings in the SAME stream, so element reveals can be
# synced to exactly when each word is spoken ("show up as it's being said"). Writes:
#   audio/vo-NN.wav        (same bytes edge-tts --write-media produced before)
#   timings.json           { "01": [["Since",0.05],["ScreenTinker",0.38], ...], ... }
import asyncio, json, os
import edge_tts

VOICE = "en-US-AndrewNeural"
# Text is identical to render_vo.py — the single source of truth for what is spoken.
import importlib.util
spec = importlib.util.spec_from_file_location("rv", os.path.join(os.path.dirname(__file__), "render_vo.py"))
rv = importlib.util.module_from_spec(spec); spec.loader.exec_module(rv)
SCENES = rv.SCENES

async def one(text):
    # Andrew emits SentenceBoundary (start + duration per sentence), not word events. Interpolate a
    # per-word start by the word's character position within its sentence — aligned to real audio.
    c = edge_tts.Communicate(text, VOICE)
    audio = b""; sents = []
    async for chunk in c.stream():
        if chunk["type"] == "audio":
            audio += chunk["data"]
        elif chunk["type"] == "SentenceBoundary":
            sents.append((chunk["offset"] / 1e7, chunk["duration"] / 1e7, chunk["text"]))
    words = []
    for (start, dur, stext) in sents:
        total = max(1, len(stext))
        pos = 0
        for tok in stext.split():
            ci = stext.find(tok, pos); pos = ci + len(tok)
            words.append([tok, round(start + (ci / total) * dur, 3)])
    return audio, words

async def main():
    os.makedirs("audio", exist_ok=True)
    timings = {}
    for sid, text in SCENES:
        audio, words = await one(text)
        open(f"audio/vo-{sid}.wav", "wb").write(audio)
        timings[sid] = words
        print(f"vo-{sid}: {len(audio)//1024}KB, {len(words)} words, last@{words[-1][1] if words else 0:.1f}s")
    json.dump(timings, open("timings.json", "w"), indent=0)
    print("wrote timings.json")

asyncio.run(main())
