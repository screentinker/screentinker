import subprocess, os
# Voiceover for "ScreenTinker 2.0". Same voice/pipeline as the other videos.
# Every claim traced to CHANGELOG.md 2.0.0 — nothing here is aspirational.
#
# TTS RULES LEARNED THE HARD WAY (see the Pi + alternative videos):
#   - never speak "self-hostable"  -> "you host it yourself"   (written copy keeps the keyword)
#   - never speak "several Pis"    -> sounds like "several PCs"
#   - write "two point oh", not "2.0" — don't leave the reading to the engine
#   - spell out acronyms: OIDC -> "single sign-on", SBOM -> "software bill of materials"
#   - no issue numbers read aloud ("#307"), no "p99" — say what it did instead
#
# PACING: no scene over ~26s. The Pi video lost ~65% of viewers in 15s to static frames;
# the fix is a new visual every scene, so long ideas get SPLIT rather than padded.
# Slides carries 6 of the 16 scenes on purpose — it is the story of this release.
EDGE = os.path.expanduser("~/tts-venv/bin/edge-tts")
VOICE = "en-US-AndrewNeural"
SCENES = [
 # ---------------------------------------------------------------- hook (no logo intro)
 ("01","ScreenTinker two point oh is here. It's the biggest release the project has had — and most of it is one thing: you can finally design a slide, properly, inside the product. Let me show you what shipped."),

 # ---------------------------------------------------------------- SLIDES (6 scenes — the story)
 ("02","Slides is a real authoring surface. Headlines, body text, big numbers, photos, rules and panels — plus clock, date, countdown and Q R elements moved over from the designer. Q R codes are drawn on the server, so a code needs no network at the panel and no third-party service to render it."),

 ("03","But here's the part that matters, and it's why this was built. A slide is two separate things. The template is the view — geometry, style, motion, a slot name for each element. The fields are the record — just the words. They meet when the slide renders, and nowhere else."),

 ("04","Which means when you edit that headline three months from now, you write one string, and the layout doesn't move. Fifteen signage products were surveyed before this was designed. Not one of them makes the changeable text part of the template."),

 ("05","Backgrounds can be a picture or a video, with a scrim so white text stays readable over both. A video background keeps its still as the poster — so a slow or undecodable clip shows the picture, instead of a black rectangle."),

 ("06","Slides can also be generated. And then layered: a background plate plus individual objects cut out with real transparency, each landing as its own element, with its own entrance. The words behind that artwork stay a field, so they're still editable — and still readable to anything that can't see the picture."),

 ("07","Fonts are bundled and served with the slide, so a deck renders the same on Android, Tizen, BrightSign or a browser, instead of falling back to whatever the panel had. Motion is per element, and the editor shows you when the last element settles against the slide's own dwell — because an animation that outlives its slide reads as a broken player. You can author in portrait too."),

 ("08","One honest note: the old designer is now marked deprecating. Widgets you made with it still play, and you can still edit them there. It isn't removed. But new work belongs in Slides."),

 # ---------------------------------------------------------------- TRIGGERS (2 scenes)
 ("09","Second: triggers. An external system — a Crestron or Extron panel, a building controller, a single button on a wall — can put a playlist over whatever a screen is showing. Fired over H T T P or U D P, in four different wire formats, because an integrator shouldn't have to know what kind of box is on the other end."),

 ("10","And triggers resolve on the screen itself, not on the server. That's the whole point — an emergency message still goes up with the internet down, because a trigger that needs the server fails in exactly the situation it exists for. One thing to know: assigning a trigger is what makes that screen pin the target playlist's media. An unassigned trigger will never fire."),

 # ---------------------------------------------------------------- MESH
 ("11","Third: servers can federate. A hub can see a customer's screens, send them content, ask them to reboot, and read diagnostics — each under its own separate grant. The customer decides what they accept, and sees everything done to them. It's deliberately conservative for a first release: nothing joins by default, depth is capped at two tiers, and content and schedules aren't mirrored yet."),

 # ---------------------------------------------------------------- BRIGHTSIGN
 ("12","A BrightSign player can now run ScreenTinker itself — the server as a real process, with the player in the widget right beside it. Screenshots, audio muting and local trigger input all work on that shape, and video backgrounds composite behind slide content there too. That last one took a session on real hardware to prove."),

 # ---------------------------------------------------------------- PROOF OF PLAY
 ("13","Proof of play now survives an outage. Players queue what they played while they were offline, and flush it when they reconnect — de-duplicated by an id the player mints itself, so a re-flush can't double count a play. What prompted this was a twenty thousand second hole in somebody's record."),

 # ---------------------------------------------------------------- PERF
 ("14","And it got faster on big fleets. A seventy screen deployment reported stalling, and it was three problems at once. Closing a play searched a screen's entire history — a hundred and fifty milliseconds every time it advanced an item. Plays were also started and never closed: thirty-six thousand left open. Both fixed, and the health indicator that should have warned you now reports honestly."),

 # ---------------------------------------------------------------- THE REST
 ("15","There's more. A second workspace per account. Single sign-on per organisation with domain verification. H T M L bundles as a playlist item. Bulk selection and group actions. Playlist inheritance that forks instead of overwriting. Japanese, and translations no longer have to be finished to ship. Plus a software bill of materials with every release."),

 # ---------------------------------------------------------------- UPGRADE
 ("16","If you're already running one point nine, there is nothing to do by hand. Migrations run on first boot. Your content, playlists, schedules and pairings all keep their meaning. The mesh stays off until you turn it on. And the designer still works. Two point oh is a normal upgrade, not a migration project."),

 # ---------------------------------------------------------------- CTA
 ("17","That's ScreenTinker two point oh. It's open source, it's M I T licensed, and you can run the whole thing on your own hardware — links are below. If this was useful, a star on the repository genuinely helps. Thanks for watching."),
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
print(f"\nTOTAL narration: {tot:.0f}s ({tot/60:.2f} min)  scenes={len(SCENES)}")
