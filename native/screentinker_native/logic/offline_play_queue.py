"""Plays that happened while the socket was down (#299).

Python port of server/lib/offline-play-queue.js (Kotlin: data/OfflinePlayQueue.kt).

⚠️ THE BUG THIS EXISTS FOR: playback is offline-native, reporting was online-only. Every player
guarded its proof-of-play emit on a live socket and returned, so a play occurring with the link down
was discarded where it happened. A measured 5h49m server outage lost ~1,040 plays.

⚠️ IT STORES COMPLETE PLAYS, NOT start/end EVENTS. The server closes a play by finding "the most
recent open row for this device+content", so replaying a start/end pair alongside live playback
could close the row the player has open RIGHT NOW rather than the historical one. A finished play
carrying both its timestamps inserts in one shot and cannot race anything.

⚠️ AND IT IS BOUNDED. A panel can sit offline for weeks; an unbounded queue grows until the device
runs out of storage, turning a reporting gap into a dead screen. Past the cap the OLDEST play goes,
and `dropped` counts it, so the loss is reportable rather than silent.

Wire shape (must match the server's lib/play-backfill and the Android queue): client_event_id,
content_id, widget_id, content_name, started_at (epoch SECONDS), ended_at, completed.

The logic is storage-free (serialize()/restore()); load()/save() add JSON-file persistence at a
caller-supplied path, written atomically because losing power mid-write is the ORDINARY case for
signage.
"""
from __future__ import annotations

import json
import os
import tempfile
import threading
import uuid
from collections import deque

MAX_ENTRIES = 2000  # ~11 hours of 20-second items: past a typical outage, still small on disk.
BATCH = 200  # one flush sends at most this many; the server bounds its own side independently.

WIRE_KEYS = ("client_event_id", "content_id", "widget_id", "content_name", "started_at",
             "ended_at", "completed")


def _positive_number(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and x > 0


def make_play(client_event_id, started_at, content_id=None, widget_id=None, content_name=None,
              ended_at=None, completed=False) -> dict:
    """Build one completed play, ready to queue (the exact wire shape)."""
    return {
        "client_event_id": client_event_id,
        "content_id": content_id or None,
        "widget_id": widget_id or None,
        "content_name": content_name or "Unknown",
        "started_at": started_at,
        "ended_at": ended_at or None,
        "completed": bool(completed),
    }


def new_id() -> str:
    """Unique per play: it is what makes a re-flush idempotent server-side."""
    return str(uuid.uuid4())


class OfflinePlayQueue:
    def __init__(self, max_entries: int = MAX_ENTRIES, path: str | None = None):
        self.max_entries = max_entries or MAX_ENTRIES
        self.path = path
        self._entries: deque = deque()
        self.dropped = 0
        self._lock = threading.RLock()

    def size(self) -> int:
        return len(self._entries)

    __len__ = size

    def add(self, play) -> None:
        # No start time cannot be reported honestly; no id cannot be de-duplicated on replay.
        if not isinstance(play, dict) or not play.get("client_event_id") \
                or not _positive_number(play.get("started_at")):
            return
        with self._lock:
            self._entries.append(play)
            while len(self._entries) > self.max_entries:
                self._entries.popleft()
                self.dropped += 1

    def peek_batch(self, limit: int | None = None) -> list:
        """The next flush, oldest first. Left in place until the server acks."""
        with self._lock:
            n = limit or BATCH
            return [e for _, e in zip(range(n), self._entries)]

    def ack(self, ids) -> None:
        """⚠️ ACK BY ID, NOT BY COUNT. "Remove the first N" assumes the queue has not moved since the
        batch was taken — but live plays keep arriving during a flush, and a full-queue eviction can
        shift it underneath. The count version silently deletes entries the server never received."""
        if not ids:
            return
        s = set(ids)
        with self._lock:
            self._entries = deque(e for e in self._entries if e.get("client_event_id") not in s)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()

    def serialize(self) -> str:
        with self._lock:
            try:
                return json.dumps(list(self._entries), separators=(",", ":"))
            except (TypeError, ValueError):
                return "[]"

    def restore(self, text) -> None:
        """⚠️ TOTAL, NEVER RAISES. This runs on the boot path; anything unreadable costs the backlog,
        never the boot. Entries are re-normalised to the wire shape (as Android does)."""
        with self._lock:
            self._entries = deque()
            if not text or not isinstance(text, str):
                return
            try:
                arr = json.loads(text)
                if not isinstance(arr, list):
                    return
                for e in arr:
                    if not isinstance(e, dict):
                        continue
                    if not e.get("client_event_id") or not _positive_number(e.get("started_at")):
                        continue
                    self.add(make_play(
                        e["client_event_id"], e["started_at"], e.get("content_id"),
                        e.get("widget_id"), e.get("content_name"),
                        e.get("ended_at") if _positive_number(e.get("ended_at")) else None,
                        e.get("completed") is True))
            except Exception:
                self._entries = deque()

    # ---- file persistence -------------------------------------------------------------------

    def load(self, path: str | None = None) -> None:
        """Restore from the JSON file. A missing/corrupt/unreadable file = an empty queue."""
        p = path or self.path
        text = None
        if p:
            try:
                with open(p, "r", encoding="utf-8") as f:
                    text = f.read()
            except (OSError, UnicodeDecodeError):
                text = None
        self.restore(text)

    def save(self, path: str | None = None) -> bool:
        """Atomically write the queue (temp file + fsync + rename). Returns False on I/O failure —
        a full disk must not take playback down with it."""
        p = path or self.path
        if not p:
            return False
        data = self.serialize()
        d = os.path.dirname(os.path.abspath(p))
        tmp = None
        try:
            os.makedirs(d, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix=".offline-plays.", dir=d)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, p)
            tmp = None
            try:
                dfd = os.open(d, os.O_RDONLY)
                try:
                    os.fsync(dfd)
                finally:
                    os.close(dfd)
            except OSError:
                pass
            return True
        except OSError:
            return False
        finally:
            if tmp:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
