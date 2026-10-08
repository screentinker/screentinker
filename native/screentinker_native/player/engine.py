"""The playback engine — Android MainActivity's playlist half, on the Qt thread.

Inputs: device:playlist-update payloads (and the cached one on a cold start), slot events from QML,
wall/group sync messages. Outputs: showItem() calls on the Stage, and device:* events through the
app's emit(). It owns:

  * layout selection with Android's priority: wall > multi-zone (>1 zone) > single;
  * the solo PlaylistController, the per-zone rotators (ZoneRunner), wall + group sync;
  * the download queue for everything the payload references (playlist, default content, triggers);
  * turning an Item into what a Slot can render (cache file, stream, widget URL, YouTube embed,
    bundle document) — never a black frame: an unplayable item advances, it does not sit there.
"""

import hashlib
import json
import logging
import os
import pathlib
import re
import time
import urllib.parse

from PySide6.QtCore import QTimer

from ..logic import kiosk as kiosk_logic
from ..logic import schedule_eval
from ..logic import wall_zones as wz
from . import transitions
from .controller import PlaylistController
from .items import BUNDLE_MIME, Item, slot_ms

log = logging.getLogger("engine")

EMBED_BASE = "https://screentinker.com"
YT_BASE = "https://www.youtube.com"
PRELOAD_LEAD_SEC = 6.0
SEEK_COOLDOWN_MS = 1200
ZONE_MIN_SEC = 3
LIVE_RECHECK_MS = 3000
WALL_ZONE_TICK_MS = 250


def youtube_id(url):
    for p in (r"embed/([A-Za-z0-9_-]{6,})", r"[?&]v=([A-Za-z0-9_-]{6,})", r"youtu\.be/([A-Za-z0-9_-]{6,})",
              r"shorts/([A-Za-z0-9_-]{6,})"):
        m = re.search(p, url or "")
        if m:
            return m.group(1)
    return None


def youtube_html(url, muted):
    """Android WebViewSupport.youtubeEmbedHtml, byte-compatible. Loaded with a screentinker.com base so
    the iframe has a valid origin (a bare embed load gives YouTube's Error 153)."""
    vid = youtube_id(url)
    if not vid:
        return None
    vertical = "st_aspect=vertical" in (url or "")
    src = ("%s/embed/%s?autoplay=1&mute=%d&controls=0&rel=0&modestbranding=1&loop=1&playlist=%s"
           "&playsinline=1&enablejsapi=1") % (YT_BASE, vid, 1 if muted else 0, vid)
    if vertical:
        css = ("html,body{margin:0;padding:0;height:100%;background:#000;overflow:hidden;display:flex;"
               "align-items:center;justify-content:center}iframe{display:block;height:100%;aspect-ratio:9/16;"
               "max-width:100%;border:0}")
    else:
        css = ("html,body{margin:0;padding:0;height:100%;background:#000;overflow:hidden}"
               "iframe{display:block;width:100%;height:100%;border:0}")
    return ('<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">'
            '<style>%s</style></head><body><iframe src="%s" allow="autoplay; encrypted-media" allowfullscreen>'
            '</iframe></body></html>') % (css, src)


def orientation_rot(o, window_portrait):
    """Android TransitionGeometry.orientationRotSwap: rotation for an orientation string against the
    panel's own shape (a native-portrait panel needs a different turn for the same setting)."""
    want_portrait = o in ("portrait", "portrait-flipped")
    flipped = o in ("landscape-flipped", "portrait-flipped")
    swap = want_portrait != window_portrait
    if not swap:
        return 180 if flipped else 0
    return 270 if flipped else 90


class BundleCache:
    """Flattened HTML bundles (/api/content/:id/bundle?rev=), 24 MB budget, oldest evicted first."""
    MAX_BYTES = 24 * 1024 * 1024

    def __init__(self, root):
        self.root = root
        os.makedirs(root, exist_ok=True)

    def path(self, cid, rev):
        return os.path.join(self.root, "%s.%s.html" % (re.sub(r"[^A-Za-z0-9_-]", "_", cid), int(rev or 0)))

    def get(self, cid, rev):
        try:
            with open(self.path(cid, rev), encoding="utf-8") as f:
                return f.read()
        except OSError:
            return None

    def put(self, cid, rev, html):
        p = self.path(cid, rev)
        with open(p + ".tmp", "w", encoding="utf-8") as f:
            f.write(html)
        os.replace(p + ".tmp", p)
        files = sorted((os.path.join(self.root, n) for n in os.listdir(self.root) if n.endswith(".html")),
                       key=lambda q: os.path.getmtime(q))
        total = sum(os.path.getsize(q) for q in files)
        while files and total > self.MAX_BYTES:
            q = files.pop(0)
            total -= os.path.getsize(q)
            os.unlink(q)


class ZoneRunner:
    """One zone's rotation (Android ZoneManager.showZoneItem): its own index, a duration timer for
    images/widgets (min 3s), video advancing on end, a lone clip looping, and a scheduled zone that
    keeps cycling even with one active item so its windows re-evaluate."""

    def __init__(self, engine, zone, items):
        self.e = engine
        self.zone = zone
        self.items = items
        self.sid = "zone:" + zone["id"]
        self.index = -1
        self.token = None
        self.timer = QTimer()
        self.timer.setSingleShot(True)
        self.timer.timeout.connect(self.advance)
        self.multi = len(items) > 1 or any(
            (i.raw.get("schedules") or i.raw.get("play_from") or i.raw.get("play_until")) for i in items)

    def stop(self):
        self.timer.stop()

    def _next_active(self, frm):
        n = len(self.items)
        for k in range(n):
            idx = (frm + k) % n
            if self.e.allows(self.items[idx]):
                return idx
        return -1

    def show(self, frm=0):
        self.timer.stop()
        idx = self._next_active(frm) if self.items else -1
        if idx < 0:
            self.e.stage.clearSurface.emit(self.sid)
            self.timer.start(30_000)       # a daypart may open
            self.index = -1
            return
        self.index = idx
        it = self.items[idx]
        if wz.is_hold(it):
            # A HOLD: nothing new for its duration — keep the zone's picture paused, or blank it.
            # Never "unknown type -> skip": that silently shortens the timeline the hold exists for.
            self.e.apply_hold(self.sid, it)
            self.token = None
            if self.multi:
                self.timer.start(int(slot_ms(it)))
            return
        rendered = self.e.render(it, surface=self.sid, loop=(not self.multi and not it.is_live),
                                 fit=it.fit_mode or self.zone.get("fit_mode") or "cover")
        if rendered is None:
            if self.multi:
                self.timer.start(1000)
            return
        self.token = rendered
        if not self.multi:
            return
        if it.mime_type.startswith("video/") and it.mime_type != "video/youtube":
            if it.is_live:
                if it.duration_sec > 0:
                    self.timer.start(it.duration_sec * 1000)
                else:
                    self.timer.start(LIVE_RECHECK_MS)
            # non-live video advances on "ended"; no timer
        else:
            self.timer.start(max(ZONE_MIN_SEC, it.duration_sec or 10) * 1000)

    def advance(self):
        if self.index >= 0 and self.items:
            it = self.items[self.index]
            # A dwell-0 live stream only moves when it stops being the active pick.
            if it.is_live and it.duration_sec <= 0 and self._next_active(self.index) == self.index and self.multi:
                self.timer.start(LIVE_RECHECK_MS)
                return
        self.show((self.index + 1) if self.index >= 0 else 0)

    def on_event(self, token, event):
        if token != self.token:
            return
        if event in ("ended", "failed") and self.multi:
            self.advance()


class WallZone:
    """One zone of a wall layout that this panel can see (see logic/wall_zones.py). No timer of its
    own: the engine's 4 Hz tick places every zone on the shared clock."""

    def __init__(self, zone, audio):
        self.zone = zone                   # the server's layout_zones row
        self.zid = str(zone.get("id"))
        self.sid = "zone:" + self.zid
        self.audio = audio
        self.reset()

    def reset(self):
        self.key = None                    # index|sig|cycle of what is mounted (None = mount next tick)
        self.index = -1
        self.token = None                  # token of what is on the surface (None = nothing)
        self.video = False                 # a clip the tick keeps on the clock
        self.align_pending = True
        self.last_seek = 0
        self.speed = 1.0
        self.loop = None                   # decided once the clip's duration is known
        self.want_dl = False


class PlaybackEngine:
    def __init__(self, app):
        self.app = app
        self.config = app.config
        self.stage = app.stage
        self.cache = app.cache
        self.bundles = BundleCache(os.path.join(app.config.state_dir, "bundles"))
        self.shaders = transitions.ShaderLibrary(app.transitions_dir, os.path.join(app.config.state_dir, "shaders"))
        self.controller = PlaylistController(
            on_item_changed=self._on_item_changed,
            on_playlist_empty=lambda: self._idle("No content assigned", "Assign a playlist to this display from the dashboard."),
            on_request_refresh=app.request_refresh,
            on_nothing_scheduled=lambda: self._idle("Nothing scheduled right now", ""),
            on_waiting_for_content=lambda: self._idle("Waiting for content", "Downloading…"),
            on_play_log=self._on_play_log,
            load_resume=self._load_resume, save_resume=self._save_resume)
        self.controller.content_ready = self._ready
        self.controller.content_usable = self._usable
        self.timezone = None
        self.mode = "single"
        self.zones = []
        self.zone_runners = {}
        self.main_token = None
        self.main_item = None
        self.token_seq = 0
        self.tokens = {}                   # token -> (surface, Item)
        self.acked = set()
        self.orientation = None
        self.wall = None                   # {'id','leader','group':bool}
        self.group_id = None
        self.video_pos = {}                # surface -> (pos_ms, dur_ms, at)
        self.speed = 1.0
        self.last_seek = 0
        self.align_pending = True
        self.last_aligned = -1
        self.preloaded_for = -1
        self.sync_timer = QTimer()
        self.sync_timer.setInterval(250)
        self.sync_timer.timeout.connect(self._sync_tick)
        self.trigger_items = []
        self.payload = None
        self.playing = False
        # Wall zones (a wall with a layout): the visible zones, their items, the shared-clock tick.
        self.wz_zones = []
        self.wz_buckets = {}
        self.wz_key = None
        self.wz_config = None
        self.wz_timer = QTimer()
        self.wz_timer.setInterval(WALL_ZONE_TICK_MS)
        self.wz_timer.timeout.connect(self._wz_tick)

    # ------------------------------------------------------------------ helpers
    def allows(self, item):
        return schedule_eval.item_should_play(item.raw, int(time.time() * 1000), self.timezone)

    def _ready(self, it):
        if it.is_widget or it.is_remote or it.is_bundle:
            return True
        return bool(it.content_id) and self.cache.is_ready(it.content_id, it.content_rev)

    def _usable(self, it):
        return bool(it.content_id) and self.cache.is_usable(it.content_id)

    def _load_resume(self):
        r = self.config.get("resume")
        return (int(r[0]), int(r[1])) if isinstance(r, list) and len(r) == 2 else None

    def _save_resume(self, idx, at):
        self.config.set("resume", [idx, at])

    def _kiosk(self):
        return getattr(self.app, "kiosk", None)

    def _hide_kiosk(self):
        k = self._kiosk()
        if k is not None:
            k.hide()

    def kiosk_config(self, it):
        """#473: the interactive config for this item when it may play interactively HERE, else None.
        Fullscreen only: in zones, on a video wall, in a synced group or as a follower one screen
        cannot hold the shared timeline, so there the item renders passively as today."""
        if not it.is_widget or self._kiosk() is None:
            return None
        cfg = kiosk_logic.parse(it.widget_type, it.raw.get("widget_config"))
        if cfg is None:
            return None
        if self.mode != "single" or self.wall or self.group_id or self.controller.wall_follower:
            return None
        return cfg

    def _idle(self, title, detail):
        self._hide_kiosk()
        aud = getattr(self.app, "audience", None)
        if aud is not None:
            aud.set_item("none", None)
        if self.mode == "single":
            self.stage.clearSurface.emit("main")
        self.app.show_status(title, detail)

    # ------------------------------------------------------------------ payload
    def on_payload(self, p, from_cache=False):
        if not isinstance(p, dict):
            return
        self.payload = p
        if p.get("suspended"):
            self.stop_all()
            self.app.show_status(p.get("message") or "This display is suspended", p.get("detail") or "")
            return
        self.timezone = p.get("timezone") or None
        self.controller.set_timezone(self.timezone)
        self.stage.set("background", p.get("background_color") or "black")
        self.controller.set_default_content(p.get("default_content"))
        self.shaders.set_custom(p.get("custom_shaders"))
        self._apply_orientation(p.get("orientation"))
        assignments = [a for a in (p.get("assignments") or []) if isinstance(a, dict)]
        self._queue_downloads(p, assignments)
        if assignments and not from_cache:
            self.config.set("cached_payload", p)

        wall = p.get("wall_config") if isinstance(p.get("wall_config"), dict) else None
        layout = p.get("layout") if isinstance(p.get("layout"), dict) else None
        zones = [z for z in (layout or {}).get("zones") or [] if isinstance(z, dict)]
        group = (p.get("group_sync") or {}).get("group_id") if isinstance(p.get("group_sync"), dict) else None

        if group and not wall and self.group_id is None:
            # ⚠️ BEFORE update_playlist: a held controller would PARK this payload, and joining the
            # group drops the hold — and the parked list with it — leaving the follower ticking over
            # the old items until the next push. End the visitor's session (wiped) first.
            self._hide_kiosk()
            self.controller.drop_hold()
        if wall:
            on_canvas = wz.active(wall, zones)
            self._apply_wall(wall, relay=not on_canvas)
            if on_canvas:
                # The WALL's layout: every zone on the shared clock, drawn on the wall canvas.
                self._enter_wall_zones(wall, zones, assignments)
                return
            self._enter_single()
        else:
            self._exit_wall()
            if len(zones) > 1:
                self._enter_zones(zones, assignments)
                self._exit_group()
                return
            self._enter_single()
        if self.controller.held and self.controller.interrupts_changed(assignments):
            # An emergency alert raised or cleared is never parked behind a visitor's session: end the
            # session (wiped) and drop the hold, as joining a group does, so it applies now.
            log.info("emergency alert changed: ending the interactive session")
            self._hide_kiosk()
            self.controller.drop_hold()
        self.controller.update_playlist(assignments, p.get("playback_order") or "sequential")
        if group and not wall:
            if not self.playing:
                # ⚠️ The SCHEDULE picks the first item in a sync group, not the solo start(): running
                # both mounted the item twice at boot (seen on the arm64 VM — a video would restart).
                # current_index -1 so the first tick's goto_index always mounts, even for index 0.
                self.playing = True
                self.controller.is_running = True
                self.controller.current_index = -1
            self._enter_group(group)
            if not self.controller.has_content_on_screen and self.controller.current_index < 0:
                # Nothing schedulable on the group clock (every item dayparted out): the solo rules
                # own the idle states (standby image, "nothing scheduled").
                self.controller.start()
            return
        if not wall:
            self._exit_group()
        if not self.playing:
            self.playing = True
            self.controller.start()
        else:
            self.controller.start_if_needed()

    def _apply_orientation(self, o):
        if self.wall:
            return
        win = self.stage.window
        portrait = bool(win and win.height() > win.width())
        self.stage.set("rotation", orientation_rot(o or "landscape", portrait))
        self.orientation = o

    def screenshot_upright_deg(self):
        win = self.stage.window
        portrait = bool(win and win.height() > win.width())
        exp = orientation_rot(self.orientation or "landscape", False)
        app = orientation_rot(self.orientation or "landscape", portrait)
        return ((exp - app) % 360 + 360) % 360

    def _queue_downloads(self, p, assignments):
        want = []
        for a in assignments:
            it = Item.parse(a)
            if it.content_id and not it.is_remote and not it.is_widget and not it.is_bundle \
                    and it.mime_type != "video/youtube" and not wz.is_hold(it):
                want.append((it.content_id, it.filename, it.mime_type, it.content_rev))
        dc = p.get("default_content")
        if isinstance(dc, dict) and dc.get("content_id") and not dc.get("remote_url"):
            want.append((dc["content_id"], dc.get("filename") or "", dc.get("mime_type") or "", dc.get("content_rev") or 0))
        self.trigger_items = []
        for t in p.get("triggers") or []:
            for a in (t or {}).get("items") or []:
                if isinstance(a, dict) and a.get("content_id") and a.get("mime_type") != "video/youtube" \
                        and a.get("mime_type") != wz.HOLD_MIME:
                    want.append((a["content_id"], a.get("filename") or "", a.get("mime_type") or "", a.get("content_rev") or 0))
        self.app.ensure_downloads(want, prune=bool(assignments))

    def on_download_result(self, cid, ok):
        if cid not in self.acked:
            self.acked.add(cid)
            self.app.emit("device:content-ack", {"device_id": self.config.device_id, "content_id": cid,
                                                 "status": "ready" if ok else "failed"})
        if ok and self.playing and self.mode == "single":
            self.controller.start_if_needed()
        if ok and self.mode == "zones":
            for r in self.zone_runners.values():
                if r.index < 0 or any(i.content_id == cid for i in r.items):
                    if r.index < 0:
                        r.show(0)

    def on_registered(self):
        self.acked.clear()      # a fresh session re-acks (Android clears the dedupe on register)

    # ------------------------------------------------------------------ modes
    def _enter_single(self):
        if self.mode == "wallzones":
            self._stop_wall_zones()
        if self.mode == "zones":
            for r in self.zone_runners.values():
                r.stop()
            self.zone_runners.clear()
            self.stage.set("zones", [])
        self.mode = "single"
        self.stage.set("layoutMode", "single")

    def _enter_zones(self, zones, assignments):
        spec = [{"id": str(z.get("id")), "name": z.get("name") or "",
                 "x": float(z.get("x_percent") or 0), "y": float(z.get("y_percent") or 0),
                 "w": float(z.get("width_percent") or 100), "h": float(z.get("height_percent") or 100),
                 "z": int(z.get("z_index") or 0), "fit_mode": z.get("fit_mode") or "cover",
                 "bg": z.get("background_color") or ""} for z in zones]
        items = [Item.parse(a) for a in assignments]
        sig = json.dumps([spec, [i.sig() for i in items]], sort_keys=True)
        if self.mode == "zones" and getattr(self, "_zone_sig", None) == sig:
            return
        if self.mode == "wallzones":
            self._stop_wall_zones()
        if self.mode == "single":
            self._hide_kiosk()               # interactive pages render passively in a zone
            self.controller.stop()
            self.playing = False
            self.stage.clearSurface.emit("main")
        for r in self.zone_runners.values():
            r.stop()
        self.zone_runners.clear()
        self._zone_sig = sig
        self.mode = "zones"
        self.stage.set("zones", spec)
        self.stage.set("layoutMode", "zones")
        self.app.hide_status()
        valid = {z["id"] for z in spec}
        largest = max(spec, key=lambda z: z["w"] * z["h"])
        by_zone = {}
        for it in items:
            zid = it.zone_id
            if zid is not None and zid not in valid:
                self.app.log_remote("warn", "Zone", "orphan zone_id=%s item=%s -> fallback zone '%s'" % (
                    zid, it.filename, largest["name"]))
                zid = largest["id"]
            by_zone.setdefault(zid, []).append(it)
        for lst in by_zone.values():
            lst.sort(key=lambda i: i.sort_order)
        unassigned_used = False
        # Zone surfaces are created by the QML Repeater on the next frame; start rotation after it.
        runners = []
        for z in sorted(spec, key=lambda z: z["z"]):
            zi = by_zone.get(z["id"])
            if zi is None and not unassigned_used:
                unassigned_used = True
                zi = by_zone.get(None) or []
            if not zi:
                continue
            r = ZoneRunner(self, z, zi)
            self.zone_runners[z["id"]] = r
            runners.append(r)
        QTimer.singleShot(0, lambda: [r.show(0) for r in runners])

    # ------------------------------------------------------------------ rendering
    def _new_token(self, surface, item):
        self.token_seq += 1
        tok = "t%d" % self.token_seq
        self.tokens[tok] = (surface, item)
        if len(self.tokens) > 64:
            for k in list(self.tokens)[:32]:
                self.tokens.pop(k, None)
        return tok

    def item_dict(self, it, fit=None, loop=False, muted=None):
        """Item -> the dict a Slot renders, or None when there is nothing renderable. `muted` overrides
        the wall rule (wall zones decide sound per zone)."""
        server = self.config.server_url
        if muted is None:
            muted = bool(it.muted) or bool(self.wall and not self.wall["leader"] and not self.wall["group"])
        # A plain wall stretches the one item over the canvas; wall ZONES keep their own fit.
        stretch = bool(self.wall and not self.wall["group"] and self.mode != "wallzones")
        d = {"fit": "fill" if stretch else (fit or it.fit_mode or "cover"),
             "muted": muted, "loop": loop, "live": it.is_live}
        if it.is_widget:
            q = ("?device=" + urllib.parse.quote(self.config.device_id)) if self.config.device_id else "?d="
            src = "%s/api/widgets/%s/render%s&rev=%d" % (server, it.widget_id, q, it.widget_rev)
            # A meeting-room display's panel capability (server/lib/rooms/service.js panelToken) rides in
            # the FRAGMENT: it lets the page book the room, and a fragment never reaches a server log.
            panel = (it.raw or {}).get("widget_panel")
            if isinstance(panel, str) and panel:
                src += "#panel=" + urllib.parse.quote(panel, safe="")
            d.update(kind="web", source=src)
            return d
        if it.is_bundle:
            html = self.bundles.get(it.content_id, it.content_rev)
            if html is None:
                self.app.fetch_bundle(it.content_id, it.content_rev)
                d.update(kind="web", source="%s/api/content/%s/bundle?rev=%d" % (server, it.content_id, it.content_rev))
            else:
                d.update(kind="html", html=html, baseUrl=server + "/")
            return d
        if it.mime_type == "video/youtube" and it.remote_url:
            html = youtube_html(it.remote_url, muted)
            if html:
                d.update(kind="youtube", html=html, baseUrl=EMBED_BASE, source=it.remote_url)
            else:
                d.update(kind="web", source=it.remote_url)
            return d
        if it.is_remote:
            if it.mime_type.startswith("video/"):
                d.update(kind="video", source=it.remote_url, holdEnd=not loop and not it.is_live)
            elif it.mime_type.startswith("image/"):
                d.update(kind="image", source=it.remote_url)
            else:
                return None
            return d
        path = self.cache.cached_file(it.content_id) if it.content_id else None
        if not path:
            return None
        src = pathlib.Path(path).as_uri()   # file:///C:/... on Windows; "file://"+path is not a URL there
        if it.mime_type.startswith("video/"):
            d.update(kind="video", source=src, holdEnd=not loop)
        elif it.mime_type.startswith("image/"):
            d.update(kind="image", source=src)
        else:
            return None
        return d

    def render(self, it, surface="main", loop=False, fit=None):
        d = self.item_dict(it, fit=fit, loop=loop)
        if d is None:
            return None
        tok = self._new_token(surface, it)
        d["token"] = tok
        tr = self.shaders.resolve(it.transition) if surface == "main" else None
        if tr:
            d["transition"] = tr
        self.stage.showItem.emit(surface, d)
        return tok

    def _on_item_changed(self, it):
        self.app.hide_status()
        self.app.slide_audio(it)
        # #473: an interactive webpage item plays in its own fresh view (ui/kiosk.py), loading the
        # site TOP-LEVEL so its forms, cookies and navigation work and the allowlist can see them.
        cfg = self.kiosk_config(it)
        if cfg is not None:
            self.stage.clearSurface.emit("main")      # nothing keeps playing underneath it
            self.main_token, self.main_item = None, it
            self._kiosk().show("%s|%d" % (it.key, it.widget_rev), cfg, it.widget_id)
            self.app.emit("device:playback-state", {"device_id": self.config.device_id,
                                                     "current_content_id": it.widget_id or "",
                                                     "position_sec": 0})
            return
        self._hide_kiosk()
        if wz.is_hold(it):
            # FREEZE keeps the outgoing frame, paused — and main_token None, so neither the group tick
            # nor the wall relay seeks it; BLANK clears to the background. The controller times it
            # (playlist_logic.ends_on_timer), or a schedule-driven follower's tick moves it on.
            self.apply_hold("main", it)
            self.main_token, self.main_item = None, it
            self.app.emit("device:playback-state", {"device_id": self.config.device_id,
                                                     "current_content_id": it.content_id or "",
                                                     "position_sec": 0})
            return
        # Group/wall followers loop video so they never freeze between leader updates.
        loop = bool(self.controller.wall_follower and it.mime_type.startswith("video/"))
        tok = self.render(it, "main", loop=loop)
        if tok is None:
            if it.content_id and not it.is_remote:
                self.app.ensure_downloads([(it.content_id, it.filename, it.mime_type, it.content_rev)], prune=False)
            log.info("not renderable now (%s %s): advancing", it.filename, it.mime_type)
            QTimer.singleShot(0, self.controller.next)
            return
        self.main_token, self.main_item = tok, it
        self.align_pending = True
        self.app.emit("device:playback-state", {"device_id": self.config.device_id,
                                                 "current_content_id": it.content_id or it.widget_id or "",
                                                 "position_sec": 0})

    def apply_hold(self, sid, it):
        """Show a hold item on a surface: freeze = pause what is there and keep it; blank = clear."""
        if wz.hold_mode(it) == "freeze":
            self.stage.control.emit(sid, {"pause": True})
        else:
            self.stage.clearSurface.emit(sid)

    def on_slot_event(self, surface, token, event, detail):
        if surface.startswith("zone:") and self.mode == "wallzones":
            self._wz_event(surface, token, event, detail)
            return
        if surface.startswith("zone:"):
            r = self.zone_runners.get(surface[5:])
            if r:
                r.on_event(token, event)
            if event == "failed":
                self.app.log_remote("warn", "Zone", "%s: %s" % (surface, detail))
            return
        if surface == "trigger":
            self.app.triggers_ui.on_slot_event(token, event, detail)
            return
        if token != self.main_token:
            return
        it = self.main_item
        if event == "ended":
            self.controller.on_video_complete()
        elif event == "failed":
            self.app.log_remote("warn", "Player", "playback failed: %s (%s)" % (it.filename if it else "?", detail))
            if it and it.mime_type.startswith("video/"):
                self.controller.close_play_log(False)
                self.controller.on_video_fault()
            else:
                self.controller.close_play_log(False)
                self.controller.next()

    def on_slot_position(self, surface, token, pos_ms, dur_ms):
        self.video_pos[surface] = (pos_ms, dur_ms, time.monotonic(), token)

    def _video_state(self):
        v = self.video_pos.get("main")
        if not v or v[3] != self.main_token or time.monotonic() - v[2] > 1.0:
            return None
        pos = v[0] + (time.monotonic() - v[2]) * 1000 * self.speed
        return pos, v[1]

    def _set_speed(self, s):
        if abs(s - self.speed) > 1e-3:
            self.speed = s
            self.stage.control.emit("main", {"rate": s})

    def _seek(self, ms):
        self.stage.control.emit("main", {"seek_ms": int(ms)})

    def set_muted_for(self, content_id, muted):
        if self.mode == "wallzones":
            return                         # the zone audio rule owns sound on a wall layout
        it = self.main_item
        if not it or it.content_id != content_id or self.main_token is None:
            return
        it.muted = muted
        if it.mime_type == "video/youtube":
            self.stage.control.emit("main", {"js": "(function(){try{var f=document.querySelector('iframe');"
                                             "f.contentWindow.postMessage(JSON.stringify({event:'command',func:'%s',args:[]}),'*')}catch(e){}})()"
                                             % ("mute" if muted else "unMute")})
        else:
            self.render(it, "main", loop=self.controller.wall_follower)

    # ------------------------------------------------------------------ proof of play
    def _on_play_log(self, event, it, completed):
        self.app.play_event(event, it, completed)

    # ------------------------------------------------------------------ wall + group sync
    def _apply_wall(self, wc, relay=True):
        def rect(k):
            r = wc.get(k) or {}
            return tuple(float(r.get(x) or 0) for x in ("x", "y", "w", "h"))
        s, p = rect("screen_rect"), rect("player_rect")
        leader = bool(wc.get("is_leader"))
        rot = int(wc.get("rotation") or 0)
        self.wall = {"id": str(wc.get("wall_id") or ""), "leader": leader, "group": False}
        self._hide_kiosk()                   # interactive pages render passively on a wall
        self.controller.drop_hold()          # a wall never holds; clear any interactive hold
        if s[2] > 0 and s[3] > 0:
            self.stage.set("wall", {"cw": p[2] / s[2], "ch": p[3] / s[3],
                                    "ox": (p[0] - s[0]) / s[2], "oy": (p[1] - s[1]) / s[3]})
        self.stage.set("rotation", rot if rot in (0, 90, 180, 270) else 0)
        self.controller.set_wall_follower(not leader)
        self.sync_timer.start()
        if not leader and relay:
            self.app.emit("wall:sync-request", {"wall_id": self.wall["id"]})

    def _exit_wall(self):
        if not self.wall:
            return
        if self.mode == "wallzones":
            self._stop_wall_zones()
            self.mode = "single"
            self.stage.set("layoutMode", "single")
        self.wall = None
        self.stage.set("wall", None)
        self.sync_timer.stop()
        self.controller.set_wall_follower(False)
        self._apply_orientation(self.orientation)

    def _enter_group(self, gid):
        first = self.group_id is None
        self.group_id = gid
        if first:
            self._hide_kiosk()               # ... and in a synced group (the hold was dropped in on_payload)
        self.controller.set_wall_follower(True)
        self.align_pending, self.last_aligned = True, -1
        self.sync_timer.start()
        self._sync_tick()
        self.app.log_remote("info", "sync", "group-sync %s group=%s" % ("entered" if first else "refresh", gid[:8]))

    def _exit_group(self):
        if self.group_id is None:
            return
        self.group_id = None
        if not self.wall:
            self.sync_timer.stop()
        self.controller.set_wall_follower(False)
        self._set_speed(1.0)
        self.app.log_remote("info", "sync", "group-sync exited")

    def group_resync(self):
        if self.group_id:
            self.align_pending = True
            self._sync_tick()

    def _sync_tick(self):
        if self.mode == "wallzones":
            return            # zones run on the shared clock; there is no one index to relay
        if self.wall and self.wall["leader"]:
            self._wall_emit()
            return
        if self.group_id:
            self._group_tick()

    def _wall_emit(self):
        it = self.controller.current_item
        if not it or not self.wall:
            return
        vs = self._video_state()
        pos = vs[0] / 1000.0 if vs else max(0.0, (time.time() * 1000 - self.controller.item_started_at) / 1000.0)
        self.app.emit("wall:sync", {"wall_id": self.wall["id"], "device_id": self.config.device_id,
                                    "current_index": self.controller.current_index,
                                    "content_id": it.content_id or None, "position_sec": pos,
                                    "sent_at": int(time.time() * 1000)})

    def on_wall_sync(self, d):
        if self.mode == "wallzones":
            return            # each zone keeps its own place on the shared clock
        if not self.wall or self.wall["leader"] or (d or {}).get("wall_id") != self.wall["id"]:
            return
        idx = d.get("current_index", -1)
        if isinstance(idx, int) and idx >= 0 and idx != self.controller.current_index:
            self.controller.goto_index(idx)
        vs = self._video_state()
        if not vs:
            return
        sent = d.get("sent_at") or 0
        latency = max(0.0, (time.time() * 1000 - sent) / 1000.0) if sent else 0.0
        target = float(d.get("position_sec") or 0) + latency
        cur, dur = vs[0] / 1000.0, (vs[1] / 1000.0 if vs[1] and vs[1] > 0 else None)
        drift = cur - target
        if abs(drift) > 0.3 and dur is not None and target < dur:
            self._seek(target * 1000)
            self._set_speed(1.0)
        elif abs(drift) > 0.05:
            self._set_speed(0.97 if drift > 0 else 1.03)
        else:
            self._set_speed(1.0)

    def on_wall_sync_request(self, d):
        if self.wall and self.wall["leader"] and self.mode != "wallzones":
            wid = (d or {}).get("wall_id")
            if wid is None or wid == self.wall["id"]:
                self._wall_emit()

    def _group_tick(self):
        t = self.controller.group_schedule_target(self.app.synced_now_ms())
        if not t:
            return
        if t["next_index"] != t["index"] and 0 <= t["sec_to_boundary"] <= PRELOAD_LEAD_SEC \
                and self.preloaded_for != t["next_index"]:
            self.preloaded_for = t["next_index"]   # QML preloads in the back slot on show; nothing to warm here
        if t["index"] != self.controller.current_index:
            self.controller.goto_index(t["index"])
            self.preloaded_for = -1
            self.align_pending = True
            return
        vs = self._video_state()
        if not vs or not vs[1] or vs[1] <= 0:
            return
        dur = vs[1] / 1000.0
        target = t["pos_sec"] % dur
        drift = vs[0] / 1000.0 - target
        now = time.time() * 1000
        if self.controller.current_index != self.last_aligned:
            self.align_pending = True
        if self.align_pending:
            if abs(drift) > 0.05:
                self._seek(target * 1000)
                self.last_seek = now
            self._set_speed(1.0)
            self.align_pending = False
            self.last_aligned = self.controller.current_index
        elif abs(drift) > 0.3 and now - self.last_seek > SEEK_COOLDOWN_MS:
            self._seek(target * 1000)
            self._set_speed(1.0)
            self.last_seek = now
        elif abs(drift) > 0.05:
            self._set_speed(0.97 if drift > 0 else 1.03)
        else:
            self._set_speed(1.0)

    # ------------------------------------------------------------------ wall zones
    # A video wall with a LAYOUT (server/lib/wall-layout.js; web reference: server/player/index.html
    # "Wall zones"). The zones are percent of the wall's player rect and live in the zone Repeater
    # INSIDE stageRoot, which the wall transform already sizes to the canvas — so the wall crop shows
    # this panel its slice of every zone, including one that straddles a seam.
    #
    # ⚠️ PACED BY THE SHARED CLOCK, NOT THE LEADER. The wall relay carries ONE index and ONE position;
    # a layout has a timeline per zone. Each zone lays its own items on synced_now_ms() with the
    # group-sync slot rule, so every panel that can see a zone computes the same item and position
    # for it on its own. Zones whose items add up to the same period stay locked to each other —
    # which, with HOLD items, is how a timeline across screens is written.
    def _enter_wall_zones(self, wall, zones, assignments):
        items = [Item.parse(a) for a in assignments]
        key = wz.config_key(wall, zones)
        if self.mode == "wallzones" and self.wz_key == key:
            # Same wall and zones: only the items may differ. The tick re-places every zone (an edit
            # remounts through the sig in its key, a duration edit moves the slots on the clock).
            self.wz_buckets = self._wz_bucket(zones, items)
            self.wz_config = wall
            self._wz_tick()
            return
        if self.mode == "single":
            self._hide_kiosk()
            self.controller.stop()
            self.playing = False
            self.stage.clearSurface.emit("main")
        elif self.mode == "zones":
            for r in self.zone_runners.values():
                r.stop()
            self.zone_runners.clear()
            self._zone_sig = None
        elif self.mode == "wallzones":
            self._stop_wall_zones()
        self.wz_key, self.wz_config = key, wall
        self.wz_buckets = self._wz_bucket(zones, items)
        # Only the zones this panel can see get a surface: never decode what is cropped away.
        self.wz_zones = [WallZone(z, wz.zone_has_audio(z.get("id"), wall)) for z in zones
                         if wz.zone_visible(z, wall)]
        spec = [{"id": zs.zid, "name": zs.zone.get("name") or "",
                 "x": float(zs.zone.get("x_percent") or 0), "y": float(zs.zone.get("y_percent") or 0),
                 "w": float(zs.zone.get("width_percent") or 100), "h": float(zs.zone.get("height_percent") or 100),
                 "z": int(zs.zone.get("z_index") or 0), "fit_mode": zs.zone.get("fit_mode") or "cover",
                 "bg": zs.zone.get("background_color") or ""} for zs in self.wz_zones]
        self.mode = "wallzones"
        self.stage.set("zones", spec)
        self.stage.set("layoutMode", "zones")
        self.app.hide_status()
        self.app.log_remote("info", "Zone", "wall zones: %d/%d visible on this panel, audio for %d" % (
            len(self.wz_zones), len(zones), sum(1 for zs in self.wz_zones if zs.audio)))
        # The Repeater creates the zone surfaces on the next frame; the first tick follows it.
        QTimer.singleShot(0, self._wz_tick)
        self.wz_timer.start()

    def _wz_bucket(self, zones, items):
        def orphan(it, largest):
            self.app.log_remote("warn", "Zone", "orphan zone_id=%s item=%s -> fallback zone '%s'" % (
                it.zone_id, it.filename, largest.get("name") or largest.get("id")))
        return wz.buckets(zones, items, on_orphan=orphan)

    def _stop_wall_zones(self):
        self.wz_timer.stop()
        for zs in self.wz_zones:
            self.stage.clearSurface.emit(zs.sid)
            self.video_pos.pop(zs.sid, None)
        self.wz_zones, self.wz_buckets, self.wz_key, self.wz_config = [], {}, None, None
        self.stage.set("zones", [])

    def _wz_release(self, zs):
        self.stage.clearSurface.emit(zs.sid)
        self.video_pos.pop(zs.sid, None)
        zs.token = None
        zs.video = False

    def _wz_tick(self):
        if self.mode != "wallzones":
            return
        now = self.app.synced_now_ms()
        for zs in self.wz_zones:
            items = self.wz_buckets.get(zs.zid) or []
            t = wz.target(items, now, self.allows)
            if not t:
                if zs.token is not None or zs.key is not None:
                    self._wz_release(zs)
                    zs.key, zs.index = None, -1
                continue
            it = items[t["index"]]
            # The cycle is in the key so a zone with ONE slot restarts at each period, instead of a
            # clip that ended on the first pass sitting on its last frame for good.
            key = "%d|%s|%d" % (t["index"], it.sig(), t["cycle"])
            if key != zs.key:
                self._wz_mount(zs, it, t, items[t["prev_index"]], key)
                continue
            self._wz_correct(zs, t)

    def _wz_render(self, zs, it, extra=None):
        fit = it.fit_mode or zs.zone.get("fit_mode") or "cover"
        d = self.item_dict(it, fit=fit, loop=False, muted=wz.zone_muted(zs.zid, self.wz_config, it.muted))
        if d is None:
            return None
        if extra:
            d.update(extra)
        tok = self._new_token(zs.sid, it)
        d["token"] = tok
        # Surface.show loads into the back slot and reveals once it has a frame: a buffered swap.
        self.stage.showItem.emit(zs.sid, d)
        zs.token = tok
        return tok

    def _wz_mount(self, zs, it, t, prev, key):
        zs.key, zs.index = key, t["index"]
        zs.align_pending, zs.loop, zs.speed, zs.video = True, None, 1.0, False
        if wz.is_hold(it):
            if wz.hold_mode(it) == "freeze":
                if zs.token is not None:
                    # Keep the outgoing picture up, paused; nothing will seek it (video False).
                    self.stage.control.emit(zs.sid, {"pause": True})
                    return
                # Nothing on this zone (the panel joined mid-hold): build what the others are
                # showing — the previous slot's item at its last frame.
                if prev is not None and not wz.is_hold(prev):
                    self._wz_render(zs, prev, {"frozenEnd": True, "loop": False, "holdEnd": True, "muted": True})
                return
            self._wz_release(zs)
            return
        if not it.is_remote and not it.is_widget and not it.is_bundle and it.content_id \
                and it.mime_type != "video/youtube" and not self.cache.cached_file(it.content_id):
            # Not downloaded yet: keep whatever the zone shows and try again next tick.
            if not zs.want_dl:
                zs.want_dl = True
                self.app.ensure_downloads([(it.content_id, it.filename, it.mime_type, it.content_rev)], prune=False)
            zs.key = None
            return
        zs.want_dl = False
        if self._wz_render(zs, it) is None:
            self._wz_release(zs)           # nothing this player can draw: the zone's background
            return
        zs.video = it.mime_type.startswith("video/") and it.mime_type != "video/youtube" and not it.is_live

    def _wz_correct(self, zs, t):
        if not zs.video:
            return
        v = self.video_pos.get(zs.sid)
        if not v or v[3] != zs.token or time.monotonic() - v[2] > 1.0 or not v[1] or v[1] <= 0:
            return
        clip = v[1] / 1000.0
        cur = (v[0] + (time.monotonic() - v[2]) * 1000 * zs.speed) / 1000.0
        cmd = {}
        if zs.loop is None:
            zs.loop = wz.should_loop(clip, t["slot_sec"])
            if zs.loop:
                cmd["loop"] = True
        tgt = wz.video_target_sec(t["pos_sec"], clip, zs.loop)
        if tgt is None:
            # Not looping and the clock is past its end: it stays on its last frame. On a mount that
            # landed there (a panel joining late) put it on that frame now.
            if zs.align_pending:
                cmd.update(seek_ms=int(max(0.0, clip - 0.05) * 1000), pause=True)
                zs.align_pending = False
                zs.video = False
            if cmd:
                self.stage.control.emit(zs.sid, cmd)
            return
        now = time.time() * 1000
        seek, rate = wz.drift_action(cur, tgt, zs.align_pending, now, zs.last_seek)
        zs.align_pending = False
        if seek is not None:
            cmd["seek_ms"] = int(seek * 1000)
            zs.last_seek = now
        if abs(rate - zs.speed) > 1e-3 or seek is not None:
            cmd["rate"] = rate
            zs.speed = rate
        if cmd:
            self.stage.control.emit(zs.sid, cmd)

    def _wz_event(self, surface, token, event, detail):
        zs = next((z for z in self.wz_zones if z.sid == surface), None)
        if zs is None or token != zs.token:
            return
        if event == "failed":
            self.app.log_remote("warn", "Zone", "%s: %s" % (surface, detail))
            if str(detail or "").startswith("no surface"):
                zs.key, zs.token = None, None     # the Repeater was not there yet: mount again
            else:
                zs.video = False                  # leave it; the next slot moves the zone on
        # "ended": a clip as long as its slot stops on its last frame until the clock moves on.

    # ------------------------------------------------------------------ lifecycle
    def stop_all(self):
        self._hide_kiosk()
        self.controller.stop()
        self.playing = False
        if self.mode == "wallzones":
            self._stop_wall_zones()
            self.mode = "single"
            self.stage.set("layoutMode", "single")
        for r in self.zone_runners.values():
            r.stop()
        self.sync_timer.stop()
        self.stage.clearSurface.emit("main")

    def remove_content(self, cid):
        self.cache.delete(cid)
        self.controller.remove_content(cid)

    def restore_cached(self):
        p = self.config.get("cached_payload")
        if isinstance(p, dict) and p.get("assignments"):
            log.info("restoring cached playlist (%d items)", len(p["assignments"]))
            self.on_payload(p, from_cache=True)
            return True
        return False
