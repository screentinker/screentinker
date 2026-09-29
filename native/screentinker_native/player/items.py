"""One playlist assignment, parsed exactly as Android's PlaylistController.updatePlaylist does.

The raw dict is kept (`raw`) because the shared schedule evaluator (logic/schedule_eval.py) reads the
server's own field names — schedules, play_from/until, play_when, _ds, tags, meta, enabled — and a
second translation layer is how two players end up disagreeing about the same item.
"""

import json
from dataclasses import dataclass, field

from . import transitions

BUNDLE_MIME = "application/vnd.screentinker.bundle+zip"
LIVE_MIMES = ("video/hls", "video/rtsp")


def _s(v):
    return None if v is None or v == "" else str(v)


def _i(v, d=0):
    try:
        return int(v)
    except (TypeError, ValueError):
        return d


@dataclass
class Item:
    raw: dict
    assignment_id: int = 0
    content_id: str = ""
    filename: str = "unknown"
    mime_type: str = "video/mp4"
    filepath: str = ""
    duration_sec: int = 10
    file_size: int = 0
    sort_order: int = 0
    enabled: bool = True
    remote_url: str = None
    muted: bool = False
    widget_id: str = None
    widget_rev: int = 0
    content_rev: int = 0
    widget_type: str = None
    fit_mode: str = None
    log_play: bool = True
    weight: int = 1
    zone_id: str = None
    transition: dict = None
    audio: dict = None
    tags: list = field(default_factory=list)

    @classmethod
    def parse(cls, o):
        o = o if isinstance(o, dict) else {}
        return cls(
            raw=o,
            assignment_id=_i(o.get("id")),
            # Tolerant: widget assignments have no content_id.
            content_id=str(o.get("content_id") or ""),
            filename=str(o.get("filename") or "unknown"),
            mime_type=str(o.get("mime_type") or "video/mp4"),
            filepath=str(o.get("filepath") or ""),
            duration_sec=_i(o.get("duration_sec"), 10) if o.get("duration_sec") is not None else 10,
            file_size=_i(o.get("file_size")),
            sort_order=_i(o.get("sort_order")),
            enabled=_i(o.get("enabled"), 1) == 1 if not isinstance(o.get("enabled"), bool) else o.get("enabled"),
            remote_url=_s(o.get("remote_url")),
            muted=_i(o.get("muted")) == 1 if not isinstance(o.get("muted"), bool) else o.get("muted"),
            widget_id=_s(o.get("widget_id")),
            widget_rev=_i(o.get("widget_rev")),
            content_rev=_i(o.get("content_rev")),
            widget_type=_s(o.get("widget_type")),
            fit_mode=_s(o.get("fit_mode")),
            log_play=_i(o.get("log_play"), 1) != 0,
            weight=max(1, _i(o.get("weight"), 1)),
            zone_id=_s(o.get("zone_id")),
            transition=transitions.parse(o.get("transition")),
            audio=o.get("audio") if isinstance(o.get("audio"), dict) else None,
            tags=[str(t).strip() for t in (o.get("tags") or []) if str(t).strip()],
        )

    # ⚠️ Continuity key — NOT content_id. Widget items carry content_id "" so keying on it alone made
    # every widget the same item and snapped all-widget playlists back to slide 1 on any edit (#234).
    @property
    def key(self):
        return self.content_id + "|" + (self.widget_id or "")

    @property
    def is_remote(self):
        return bool(self.remote_url)

    @property
    def is_widget(self):
        return bool(self.widget_id)

    @property
    def is_live(self):
        return self.mime_type in LIVE_MIMES

    @property
    def is_bundle(self):
        return self.mime_type == BUNDLE_MIME

    def sig(self):
        """STRUCTURAL signature (Android sig()): an edit to any of these re-renders; a duration-only
        or weight-only edit does not — those are patched in place so timing edits never restart."""
        r = self.raw
        blocks = []
        for b in r.get("schedules") or []:
            if isinstance(b, dict):
                days = ",".join(str(d) for d in sorted(b.get("days") or []))
                blocks.append("%s@%s-%s:%s~%s" % (days, b.get("start"), b.get("end"),
                                                  b.get("start_date") or "", b.get("end_date") or ""))
        pw = r.get("play_when")
        cond = ""
        if isinstance(pw, dict):
            cond = "%s%s%s%s" % (pw.get("type") or "", pw.get("path") or "", pw.get("op") or "",
                                 "" if pw.get("value") is None else pw.get("value"))
        meta = r.get("meta")
        return "|".join([
            self.content_id, self.widget_id or "", self.mime_type, self.remote_url or "",
            str(self.widget_rev), "m" if self.muted else "", ";".join(blocks),
            "%s~%s" % (r.get("play_from") or "", r.get("play_until") or ""),
            "1" if self.enabled else "0", self.fit_mode or "", transitions.sig(self.transition),
            cond, ",".join(self.tags), json.dumps(meta, sort_keys=True) if isinstance(meta, dict) else "",
            # ⚠️ content_rev is deliberately NOT here (Android's sig() omits it too). A replaced asset
            # reaches the screen through the READY check on the next mount of that item, and adding a
            # field to a structural fingerprint to fix a stale-content symptom restarts playback on
            # every rev bump — the fingerprint is structure, not freshness.
        ])


def slot_ms(item):
    """max(1, duration||10) — the canonical slot shared with web/Tizen/Android group sync."""
    return (item.duration_sec if item.duration_sec > 0 else 10) * 1000
