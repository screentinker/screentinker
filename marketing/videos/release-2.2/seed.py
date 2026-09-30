#!/usr/bin/env python3
"""
Seed the throwaway capture instance with clean demo data for the 2.0 video.

Nothing here touches a real database — the server this talks to runs with
DATA_DIR=~/screentinker-video-2p2/instance on :3011.

⚠️ EVERYTHING IS INVENTED. No customer names, no real URLs beyond screentinker.com,
   and no third-party media — the Rick Astley thumbnail that slipped into an early
   Android TV capture is exactly what this rule exists to prevent.
"""
import json, urllib.request, urllib.error, os, sys

BASE = "http://localhost:3011"
TOK = open(os.path.join(os.path.dirname(__file__), ".token")).read().strip()

def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + "/api" + path, data=data, method=method,
                                 headers={"Authorization": f"Bearer {TOK}",
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        print(f"  !! {method} {path} -> {e.code}: {e.read().decode()[:200]}")
        return None

# ---------------------------------------------------------------- style helpers
INK   = "#F4F7FB"
MUTED = "#A3AEC0"
GREEN = "#34D399"

def style(color=INK, size=6.0, weight=700, align="left", font="inter"):
    return {"color": color, "font": font, "size_cqw": size, "weight": weight,
            "align": align, "opacity": 1, "radius_cqw": 0}

def motion(anim="slideU", delay=0.2, dur=0.55, easing="soft"):
    return {"animation": anim, "delay": delay, "duration": dur, "easing": easing}

def el(slot, kind, x, y, w, st, mo, cfg=None):
    e = {"slot": slot, "kind": kind, "box": {"x": x, "y": y, "w": w},
         "style": st, "motion": mo}
    if cfg: e.update(cfg)
    return e

# ---------------------------------------------------------------- the deck
# Five slides that between them exercise head/body/stat/rule/qr/clock/date/countdown —
# the elements scene 02 names out loud.
slides = [
  {"id": "s1", "name": "Welcome", "dwell_sec": 9, "widget_id": None,
   "template": {"background": "#0E1420", "elements": [
      el("eyebrow", "body", 8, 20, 60, style(GREEN, 2.6, 700), motion("fade", 0.1, 0.5)),
      el("h",       "head", 8, 27, 74, style(INK, 8.5, 800),   motion("slideU", 0.3, 0.6)),
      el("rule",    "rule", 8, 47, 22, style(GREEN, 1, 400),   motion("wipe", 0.7, 0.5)),
      el("b",       "body", 8, 54, 52, style(MUTED, 3.0, 400), motion("fade", 0.9, 0.55)),
   ]},
   "fields": {"eyebrow": "WELCOME", "h": "Fairview Medical Center", "b": "Main reception · Level 1 · Visitor check-in to your right"}},

  {"id": "s2", "name": "Today at a glance", "dwell_sec": 8, "widget_id": None,
   "template": {"background": "#0E1420", "elements": [
      el("eyebrow", "body", 8, 18, 60, style(GREEN, 2.6, 700), motion("fade", 0.1, 0.5)),
      el("n",       "stat", 8, 26, 60, style(INK, 17.0, 800),  motion("zoom", 0.3, 0.6)),
      el("cap",     "body", 8, 55, 55, style(MUTED, 3.0, 400), motion("slideU", 0.7, 0.5)),
   ]},
   "fields": {"eyebrow": "TODAY", "n": "1,284", "cap": "Patients seen this week · up 6% on last"}},

  {"id": "s3", "name": "Scan to check in", "dwell_sec": 10, "widget_id": None,
   "template": {"background": "#0E1420", "elements": [
      el("h",  "head", 8, 28, 46, style(INK, 6.5, 800),   motion("slideU", 0.2, 0.55)),
      el("b",  "body", 8, 45, 42, style(MUTED, 2.8, 400), motion("fade", 0.6, 0.5)),
      el("qr", "qr",  62, 24, 26, style(INK, 4, 400),     motion("zoom", 0.5, 0.6),
         {"cfg": {"qr_ec": "M", "qr_fg": "#0E1420", "qr_bg": "#FFFFFF"}}),
   ]},
   "fields": {"h": "Check in from your phone", "b": "Scan the code — no app, no queue.", "qr": "https://screentinker.com"}},

  {"id": "s4", "name": "Clock & date", "dwell_sec": 8, "widget_id": None,
   "template": {"background": "#0E1420", "elements": [
      el("clock", "clock", 8, 24, 50, style(INK, 15.0, 800), motion("fade", 0.2, 0.6),
         {"cfg": {"clock_format": "HH:mm", "tz": "America/Chicago", "locale": "en-US"}}),
      el("date",  "date",  8, 52, 50, style(MUTED, 3.4, 400), motion("slideU", 0.5, 0.5),
         {"cfg": {"date_format": "EEEE d MMMM", "tz": "America/Chicago", "locale": "en-US"}}),
   ]},
   "fields": {}},

  {"id": "s5", "name": "Countdown", "dwell_sec": 9, "widget_id": None,
   "template": {"background": "#0E1420", "elements": [
      el("eyebrow", "body",      8, 20, 60, style(GREEN, 2.6, 700), motion("fade", 0.1, 0.5)),
      el("cd",      "countdown", 8, 28, 62, style(INK, 13.0, 800),  motion("slideU", 0.3, 0.6),
         {"cfg": {"target": "2026-12-24T17:00:00Z"}}),
      el("b",       "body",      8, 56, 52, style(MUTED, 3.0, 400), motion("fade", 0.8, 0.5)),
   ]},
   "fields": {"eyebrow": "NEXT SHIFT CHANGE", "cd": "Shift change now", "b": "Handover briefing · Ward B day room"}},
]

print("== slide deck ==")
deck = call("POST", "/slide-decks", {"name": "Reception — Main Lobby",
                                     "doc": {"aspect": "16:9", "slides": slides}})
if deck:
    print(f"  deck {deck['id']}  slides={len(slides)}")
    full = call("GET", f"/slide-decks/{deck['id']}")
    if full:
        got = full.get("doc", {}).get("slides", [])
        print(f"  round-trip: {len(got)} slides survived normalize")
        for s in got:
            kinds = [e.get("kind") for e in s.get("template", {}).get("elements", [])]
            print(f"    {s.get('name'):22s} dwell={s.get('dwell_sec')}s  {kinds}")
        if full.get("warnings"):
            print(f"  warnings: {full['warnings']}")

print("\n== playlists ==")
for name, desc in [
    ("Lobby — daytime",     "Reception deck on rotation, 07:00–19:00"),
    ("Emergency — evacuate", "Full-screen evacuation notice. Trigger target."),
    ("Ward B — handover",    "Shift-change briefing loop"),
]:
    p = call("POST", "/playlists", {"name": name, "description": desc})
    if p: print(f"  {p.get('id','?')[:8]}  {name}")

print("\n== done ==")
