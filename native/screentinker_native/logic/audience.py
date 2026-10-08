"""Audience counting: the pure half (server/lib/audience.js, docs/audience-counting.md).

A port of Android's AudienceAggregator.kt — same rules, same wire format — so a Pi and a phone
counting the same room report the same numbers. Tested in tests/test_audience.py.

⚠️ THIS MODULE NEVER SEES AN IMAGE. The camera half (system/audience.py) turns each frame into a list
of face BOXES and drops the frame; this turns boxes into per-minute COUNTS. A track is a local object
that lives only while a face stays in view — it is not a person, is never stored, and is gone the
moment the face leaves. There is no appearance, no embedding, no identifier: only where a box was in
the last frame.

Counting rules (the server validates the same shape):
  - present: confirmed faces in a frame; per minute the max and the average (x100)
  - a face is CONFIRMED once seen in `confirm_frames` frames, so a one-frame false detection counts
    as nobody
  - when a confirmed face leaves (unseen for `lost_after_ms`) it is counted once, in the minute it
    left: one arrival; an impression if it was in view for at least min_dwell_ms; and its dwell in
    the histogram. Counted at the END because only then is the dwell known — which also keeps
    impressions <= arrivals in every bucket by construction.
  - it is attributed to the item that was on screen when it was confirmed.
"""

import json
import os
import threading
from collections import OrderedDict, namedtuple

# A face box in frame coordinates normalised by the frame WIDTH (so boxes are square in both axes).
FaceBox = namedtuple("FaceBox", "cx cy size")


class ScreenItem(namedtuple("ScreenItem", "kind id")):
    """What was on screen. kind is content | widget | none."""
    __slots__ = ()


NONE_ITEM = ScreenItem("none", None)

# <2s, 2-5s, 5-15s, 15-30s, 30-60s, 60s+ — server/lib/audience.js DWELL_LABELS.
_DWELL_EDGES_MS = (2_000, 5_000, 15_000, 30_000, 60_000)


def dwell_index(ms):
    for i, edge in enumerate(_DWELL_EDGES_MS):
        if ms < edge:
            return i
    return 5


def iou(a, b):
    ax0, ax1, ay0, ay1 = a.cx - a.size / 2, a.cx + a.size / 2, a.cy - a.size / 2, a.cy + a.size / 2
    bx0, bx1, by0, by1 = b.cx - b.size / 2, b.cx + b.size / 2, b.cy - b.size / 2, b.cy + b.size / 2
    iw = max(0.0, min(ax1, bx1) - max(ax0, bx0))
    ih = max(0.0, min(ay1, by1) - max(ay0, by0))
    inter = iw * ih
    union = a.size * a.size + b.size * b.size - inter
    return 0.0 if union <= 0 else inter / union


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


class Bucket:
    """One minute of counts for one item. Integers only; to_json() is the whole wire format."""

    __slots__ = ("start", "seconds", "item", "present_max", "present_sum", "frames",
                 "arrivals", "impressions", "dwell")

    def __init__(self, start, seconds, item):
        self.start = int(start)            # epoch seconds, a multiple of `seconds`
        self.seconds = int(seconds)
        self.item = item
        self.present_max = 0
        self.present_sum = 0               # sum of per-frame counts (for the average)
        self.frames = 0
        self.arrivals = 0
        self.impressions = 0
        self.dwell = [0] * 6

    @property
    def id(self):
        """The ack key. Unique per screen: one bucket per minute per item."""
        return ("m%d-%s-%s" % (self.start, self.item.kind, self.item.id or "x"))[:80]

    def present_avg_x100(self):
        if self.frames == 0:
            return 0
        return _clamp((self.present_sum * 100 + self.frames // 2) // self.frames, 0, self.present_max * 100)

    def to_json(self):
        arrivals = _clamp(self.arrivals, 0, 5000)
        o = {
            "id": self.id,
            "start": self.start,
            "seconds": self.seconds,
            "item_kind": self.item.kind,
            "present_max": _clamp(self.present_max, 0, 100),
            "present_avg_x100": self.present_avg_x100(),
            "arrivals": arrivals,
            "impressions": _clamp(self.impressions, 0, arrivals),
            "dwell": [_clamp(d, 0, 5000) for d in self.dwell],
        }
        if self.item.kind != "none" and self.item.id is not None:
            o["item_id"] = self.item.id
        return o

    @classmethod
    def from_json(cls, o):
        try:
            kind = str(o["item_kind"])
            b = cls(int(o["start"]), int(o["seconds"]),
                    ScreenItem(kind, str(o["item_id"]) if o.get("item_id") is not None else None))
            b.present_max = int(o["present_max"])
            # The average is carried as avg x100 over one pseudo-frame of 100, which round-trips exactly.
            b.present_sum = int(o["present_avg_x100"])
            b.frames = 100
            b.arrivals = int(o["arrivals"])
            b.impressions = int(o["impressions"])
            d = list(o["dwell"])
            b.dwell = [int(d[i]) if i < len(d) else 0 for i in range(6)]
            return b
        except (KeyError, TypeError, ValueError):
            return None


class _Track:
    __slots__ = ("box", "first_seen_ms", "last_seen_ms", "hits", "item")

    def __init__(self, box, now_ms, item):
        self.box = box
        self.first_seen_ms = now_ms
        self.last_seen_ms = now_ms
        self.hits = 1
        self.item = item


class Aggregator:
    def __init__(self, min_dwell_ms=1000, bucket_sec=60, confirm_frames=2, lost_after_ms=1500,
                 match_iou=0.25, max_tracks=100):
        self.min_dwell_ms = min_dwell_ms
        self.bucket_sec = bucket_sec
        self.confirm_frames = confirm_frames
        self.lost_after_ms = lost_after_ms
        self.match_iou = match_iou
        self.max_tracks = max_tracks
        self._tracks = []
        self._open = OrderedDict()
        self.item = NONE_ITEM

    def _minute_of(self, ms):
        s = int(ms // 1000)
        return s - (s % self.bucket_sec)

    def _bucket(self, minute, item):
        key = (minute, item.kind, item.id)
        b = self._open.get(key)
        if b is None:
            b = self._open[key] = Bucket(minute, self.bucket_sec, item)
        return b

    def on_frame(self, faces, now_ms):
        """One frame's detections at now_ms. Returns the buckets that are now complete (their minute
        has passed), for the caller to queue."""
        unmatched = list(faces)
        # Greedy best-IoU matching: few faces per frame, so O(n*m) is nothing.
        for t in sorted(self._tracks, key=lambda t: -t.hits):
            best, best_iou = None, self.match_iou
            for f in unmatched:
                v = iou(t.box, f)
                if v >= best_iou:
                    best_iou, best = v, f
            if best is not None:
                unmatched.remove(best)
                t.box, t.last_seen_ms = best, now_ms
                t.hits += 1
                if t.hits == self.confirm_frames:
                    t.item = self.item          # attributed to what was on screen when confirmed
        for f in unmatched:
            if len(self._tracks) >= self.max_tracks:
                break
            self._tracks.append(_Track(f, now_ms, self.item))
        self._end_lost(now_ms)

        present = sum(1 for t in self._tracks if t.hits >= self.confirm_frames and t.last_seen_ms == now_ms)
        b = self._bucket(self._minute_of(now_ms), self.item)
        b.frames += 1
        b.present_sum += present
        b.present_max = max(b.present_max, present)
        return self._close_before(self._minute_of(now_ms))

    def _end_lost(self, now_ms):
        keep = []
        for t in self._tracks:
            if now_ms - t.last_seen_ms > self.lost_after_ms:
                self._finish(t, now_ms)
            else:
                keep.append(t)
        self._tracks = keep

    def _finish(self, t, now_ms):
        if t.hits < self.confirm_frames:
            return                              # never confirmed: a flicker, not a person
        dwell_ms = max(0, t.last_seen_ms - t.first_seen_ms)
        b = self._bucket(self._minute_of(now_ms), t.item)
        b.arrivals += 1
        if dwell_ms >= self.min_dwell_ms:
            b.impressions += 1
        b.dwell[dwell_index(dwell_ms)] += 1

    def _close_before(self, minute):
        done = [b for b in self._open.values() if b.start < minute]
        if done:
            for k in [k for k, b in self._open.items() if b.start < minute]:
                del self._open[k]
        return done

    def flush_all(self, now_ms):
        """Stop counting (camera off, player stopping, switched off): every face still in view is
        counted as leaving now, and every bucket — including the current partial minute — returned."""
        for t in self._tracks:
            self._finish(t, now_ms)
        self._tracks = []
        out = list(self._open.values())
        self._open.clear()
        return out

    @property
    def active_tracks(self):
        return len(self._tracks)


class AudienceQueue:
    """Bounded (oldest dropped), ordered, deduplicated by id, removed only on the server's ack — the
    contract of the kiosk-session queue. load()/save() persist it atomically at `path`."""

    MAX = 3000          # ~2 days of one-item minutes offline
    BATCH = 100

    def __init__(self, cap=MAX, path=None):
        self.cap = cap
        self.path = path
        self._items = []
        self._lock = threading.RLock()

    def size(self):
        return len(self._items)

    __len__ = size

    def add_all(self, buckets):
        with self._lock:
            have = {b.id for b in self._items}
            for b in buckets:
                if b.id in have:
                    continue
                have.add(b.id)
                self._items.append(b)
            while len(self._items) > self.cap:
                self._items.pop(0)

    def peek(self, n=BATCH):
        with self._lock:
            return [b.to_json() for b in self._items[:n]]

    def ack(self, ids):
        ids = {i for i in (ids or []) if isinstance(i, str)}
        if ids:
            with self._lock:
                self._items = [b for b in self._items if b.id not in ids]

    def to_json(self):
        with self._lock:
            return json.dumps([b.to_json() for b in self._items])

    @classmethod
    def from_json(cls, raw, cap=MAX, path=None):
        q = cls(cap, path)
        try:
            q.add_all([b for b in (Bucket.from_json(o) for o in (json.loads(raw) if raw else [])) if b])
        except (ValueError, TypeError):
            pass        # unreadable: start empty rather than wedge
        return q

    def load(self):
        if not self.path:
            return
        try:
            with open(self.path, encoding="utf-8") as f:
                raw = f.read()
        except OSError:
            return
        loaded = AudienceQueue.from_json(raw, self.cap)
        with self._lock:
            self._items = loaded._items

    def save(self):
        if not self.path:
            return
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(self.to_json())
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.path)


# ---------------------------------------------------------------------- detector output -> boxes

def frontal(row):
    """Is a YuNet detection a face LOOKING AT the screen? (x, y, w, h, right eye x/y, left eye x/y,
    nose x/y, mouth corners, score.) Android's platform detector only finds frontal faces; YuNet also
    finds profiles, which are people walking past, not impressions. Frontal = both eyes clearly apart
    and the nose between them."""
    w = float(row[2])
    ex0, ex1 = sorted((float(row[4]), float(row[6])))
    nose = float(row[8])
    eye_dx = ex1 - ex0
    if w <= 0 or eye_dx < 0.25 * w:
        return False
    rel = (nose - ex0) / eye_dx
    return 0.2 <= rel <= 0.8


def boxes_from_detections(rows, frame_width):
    """YuNet rows -> FaceBox list (frontal only), normalised by the frame width."""
    out = []
    if rows is None or frame_width <= 0:
        return out
    for r in rows:
        if not frontal(r):
            continue
        x, y, w, h = (float(v) for v in r[:4])
        size = max(w, h)
        out.append(FaceBox((x + w / 2) / frame_width, (y + h / 2) / frame_width, size / frame_width))
    return out
