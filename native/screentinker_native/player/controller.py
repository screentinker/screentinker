"""Solo-playback controller — a line-by-line port of Android's PlaylistController.kt.

Runs on the Qt thread (QTimer in place of Android's main-looper Handler). The decision rules are
NOT re-derived here: selection, resume, deferred swap, fault recovery and timing come from
logic/playlist_logic.py and logic/play_order.py, which are ported from the Kotlin with its tests,
and schedule eligibility from logic/schedule_eval.py, held to shared/schedule-vectors.json. The
comments that remain explain the traps each piece of state guards against; the Kotlin carries the
full incident history for each.
"""

import logging
import time

from PySide6.QtCore import QTimer

from ..logic import play_order, playlist_logic as PL, schedule_eval
from .items import Item, slot_ms

log = logging.getLogger("controller")

CONTENT_RECHECK_MS = 3000
MIN_ADVANCE_MS = 500
NOTHING_SCHEDULED_RECHECK_MS = 30_000


def _now_ms():
    return int(time.time() * 1000)


def _timer(cb):
    t = QTimer()
    t.setSingleShot(True)
    t.timeout.connect(cb)
    return t


class PlaylistController:
    def __init__(self, on_item_changed, on_playlist_empty, on_request_refresh=None,
                 on_nothing_scheduled=None, on_waiting_for_content=None, on_play_log=None,
                 load_resume=None, save_resume=None):
        self.on_item_changed = on_item_changed
        self.on_playlist_empty = on_playlist_empty
        self.on_request_refresh = on_request_refresh
        self.on_nothing_scheduled = on_nothing_scheduled
        self.on_waiting_for_content = on_waiting_for_content
        self.on_play_log = on_play_log
        self.load_resume = load_resume
        self.save_resume = save_resume

        self.items = []
        self.current_index = -1
        self.logged_item = None
        self.is_running = False
        self.timezone = None
        self.playback_order = "sequential"
        self.order_state = play_order.PlayOrderState()
        self.pending_items = None
        self.pending_successor = None
        self.has_content_on_screen = False
        self.default_content = None
        self.default_showing = False
        self.wall_follower = False
        self.item_started_at = 0
        self.fault = PL.PlaybackFault()
        # Injected by the engine, which owns the cache: READY = revision confirmed, USABLE = bytes present.
        self.content_ready = lambda item: True
        self.content_usable = lambda item: False

        self._advance = _timer(self.next)
        self._retry = _timer(self._on_retry)
        self._retry_mode = None
        self._pending_deadline = _timer(self._on_pending_deadline)
        # #473: a visitor is using an interactive web page. While HELD nothing moves the playlist on:
        # no advance timer, no deferred-swap deadline, and a playlist update is PARKED until release —
        # applying it mid-session would restart the item under someone filling in a form. release()
        # then applies whatever was parked and advances (Android PlaylistController.hold/release).
        self.held = False
        self.held_key = None
        self.parked_update = None
        self._releasing = False

    # ------------------------------------------------------------------ state
    @property
    def current_item(self):
        return self.items[self.current_index] if 0 <= self.current_index < len(self.items) else None

    @property
    def is_playing(self):
        return self.is_running and self.current_index >= 0

    def item_at(self, i):
        return self.items[i] if 0 <= i < len(self.items) else None

    def set_timezone(self, tz):
        self.timezone = tz

    def set_default_content(self, dc):
        if (dc or None) != (self.default_content or None):
            self.default_showing = False
        self.default_content = dc

    # ------------------------------------------------------------------ default / idle
    def _default_item(self):
        dc = self.default_content
        if not isinstance(dc, dict):
            return None
        mime = str(dc.get("mime_type") or "")
        if not mime.startswith("image/"):
            return None                     # only images are valid standby content
        remote = dc.get("remote_url") or None
        cid = dc.get("content_id") or ""
        if not remote and not cid:
            return None
        return Item.parse({"id": -1, "content_id": cid, "filename": dc.get("filename") or "default",
                           "mime_type": mime, "filepath": dc.get("filepath") or "", "duration_sec": 0,
                           "file_size": dc.get("file_size") or 0, "sort_order": -1,
                           "remote_url": remote, "content_rev": dc.get("content_rev") or 0})

    def _render_default(self):
        item = self._default_item()
        if item is None:
            return False
        if not item.is_remote and not self.content_ready(item) and not self.content_usable(item):
            return False
        if self.default_showing:
            return True
        log.info("rendering default/standby content: %s", item.filename)
        self.on_item_changed(item)
        self.default_showing = True
        return True

    def _emit_empty(self):
        if not self._render_default():
            self.on_playlist_empty()

    # ------------------------------------------------------------------ follower mode
    def set_wall_follower(self, b):
        was, self.wall_follower = self.wall_follower, b
        if was == b:
            return
        if b:
            self._advance.stop()
            return
        item = self.current_item
        if item is None or not self.is_running or not PL.ends_on_timer(item.mime_type, item.is_widget):
            return
        delay = max(0, slot_ms(item) - (_now_ms() - self.item_started_at))
        log.info("follower mode off: resuming self-advance in %dms", delay)
        self._schedule_advance(delay)

    def goto_index(self, idx):
        if not self.items:
            return
        n = len(self.items)
        target = ((idx % n) + n) % n
        if target == self.current_index:
            return
        self.current_index = target
        self._play_current()

    # ------------------------------------------------------------------ interactive hold (#473)
    def hold(self):
        if self.held:
            return
        self.held = True
        cur = self.current_item
        self.held_key = cur.key if cur else None
        self._advance.stop()
        log.info("held on current item (interactive session)")

    def drop_hold(self):
        """Clear a hold WITHOUT advancing (the caller is about to replace playback anyway)."""
        self.held, self.held_key, self.parked_update = False, None, None

    def release(self):
        if not self.held:
            return
        self.held = False
        log.info("released (interactive session over)")
        parked, self.parked_update = self.parked_update, None
        key, self.held_key = self.held_key, None
        if parked is not None:
            # ⚠️ Applied WITHOUT re-rendering the held item: if the parked edit bumped its widget_rev,
            # the same-item path would remount the page only for the next() below to leave it at once
            # (a double mount and a phantom play row). Leaving it is the point of the release.
            self._releasing = True
            try:
                self.update_playlist(parked[0], parked[1])
            finally:
                self._releasing = False
        # Advance off the page the visitor used — unless applying the parked update already moved
        # playback elsewhere (it restarted, or the item was removed), which would make this a skip.
        cur = self.current_item
        if cur is not None and cur.key == key:
            self.next()

    # ------------------------------------------------------------------ playlist updates
    def update_playlist(self, assignments, order="sequential"):
        if self.held:
            log.info("playlist update parked until the interactive session ends")
            self.parked_update = (assignments, order)
            return
        if order != self.playback_order:
            self.order_state = play_order.PlayOrderState()
        self.playback_order = order if order in ("shuffle", "weighted") else "sequential"
        new_items = [Item.parse(a) for a in (assignments or [])]

        old_sig = [i.sig() for i in self.items]
        new_sig = [i.sig() for i in new_items]
        if old_sig == new_sig and self.items:
            # Duration/weight-only edit: patch in place, no restart (a sync group re-anchors on it).
            changed = False
            for i, ni in enumerate(new_items):
                cur = self.items[i]
                if cur.duration_sec != ni.duration_sec or cur.weight != ni.weight:
                    cur.duration_sec, cur.weight = ni.duration_sec, ni.weight
                    cur.raw = ni.raw
                    changed = True
                elif cur.raw.get("_ds") != ni.raw.get("_ds"):
                    cur.raw = ni.raw        # fresh data-source values for play_when, no restart
            log.info("durations updated in place" if changed else "playlist unchanged (%d items)", len(self.items))
            return

        log.info("playlist changed: %d -> %d items", len(self.items), len(new_items))
        cur = self.current_item
        playing_key = cur.key if cur else None
        playing_rev = cur.widget_rev if cur else 0

        if PL.should_defer_swap(self.is_running, self.wall_follower, self.has_content_on_screen,
                                playing_key, [i.key for i in new_items]):
            succ = None
            n = len(self.items)
            for k in range(1, n + 1):
                cand = self.items[(self.current_index + k) % n].key
                if cand != playing_key and any(i.key == cand for i in new_items):
                    succ = cand
                    break
            self.pending_items, self.pending_successor = new_items, succ
            log.info("current item removed but live: deferring rotation-out (successor=%s)", succ)
            self._pending_deadline.start(PL.PENDING_SWAP_DEADLINE_MS)
            return
        self.pending_items = self.pending_successor = None
        self._pending_deadline.stop()

        self.items = new_items
        if not self.items:
            self.current_index = -1
            self._advance.stop()
            self._emit_empty()
        elif self.is_running:
            if playing_key is not None:
                ni = next((i for i, it in enumerate(self.items) if it.key == playing_key), -1)
                if ni >= 0 and self.has_content_on_screen:
                    self.current_index = ni
                    # Same item, new contents: a widget edited in place must re-render (rev is the
                    # only field that separates "same item" from "same thing on screen").
                    if self.items[ni].widget_rev != playing_rev and not self._releasing:
                        log.info("same item at %d, widget_rev %s -> %s: re-rendering", ni, playing_rev, self.items[ni].widget_rev)
                        self._play_current()
                    return
            fp = self._first_playable()
            if fp >= 0:
                self.current_index = fp
                self._play_current()
            elif self._first_active() < 0:
                self._show_nothing_scheduled()
            else:
                self._on_content_not_ready()
        else:
            self.current_index = 0

    def remove_content(self, content_id):
        was = self.current_item.content_id if self.current_item else None
        self.items = [i for i in self.items if i.content_id != content_id]
        if not self.items:
            self.current_index = -1
            self._advance.stop()
            self._emit_empty()
        elif was == content_id:
            if self.current_index >= len(self.items):
                self.current_index = 0
            self._play_current()

    # ------------------------------------------------------------------ lifecycle
    def start(self):
        self.is_running = True
        if not self.items:
            self._emit_empty()
            return
        if self._first_active() < 0:
            self._show_nothing_scheduled()
            return
        saved = None
        try:
            saved = self.load_resume() if self.load_resume else None
        except Exception:
            saved = None
        frm = PL.resume_index(saved[0] if saved else -1, saved[1] if saved else 0, _now_ms(), len(self.items))
        if frm > 0 and self._playable_now(frm):
            idx = frm
        elif frm > 0:
            idx = self._next_playable(frm - 1)
        else:
            idx = self._first_playable()
        if frm > 0:
            log.info("resuming at index %d (reload within resume window)", frm)
        if idx >= 0:
            self.current_index = idx
            self._play_current()
        else:
            self._on_content_not_ready()

    def start_if_needed(self):
        if not self.items:
            self._emit_empty()
            return
        if self.is_running and 0 <= self.current_index < len(self.items) and self.has_content_on_screen:
            return
        self.start()

    def stop(self):
        self.is_running = False
        self.held, self.held_key, self.parked_update = False, None, None   # a stop ends any hold
        self._advance.stop()
        self._retry.stop()
        self._pending_deadline.stop()
        self.has_content_on_screen = False
        self.pending_items = self.pending_successor = None
        if self.logged_item is not None and self.on_play_log:
            self.on_play_log("play_end", self.logged_item, True)
        self.logged_item = None

    def next(self):
        if self.held:
            return
        if self.pending_items is not None:
            p, self.pending_items = self.pending_items, None
            self._pending_deadline.stop()
            succ, self.pending_successor = self.pending_successor, None
            self.items = p
            if not self.items:
                self.current_index = -1
                self._advance.stop()
                self._emit_empty()
                return
            if self.on_request_refresh:
                self.on_request_refresh()
            if self._first_active() < 0:
                self._show_nothing_scheduled()
                return
            idx = next((i for i, it in enumerate(self.items) if it.key == succ), -1) if succ else -1
            if idx < 0 or not self._playable_now(idx):
                idx = self._first_playable()
            if idx >= 0:
                self.current_index = idx
                self._play_current()
            else:
                self._on_content_not_ready()
            return
        if not self.items:
            return
        if self.on_request_refresh:
            self.on_request_refresh()
        if self._first_active() < 0:
            self._show_nothing_scheduled()
            return
        idx = self._next_playable(self.current_index)
        if idx >= 0:
            self.current_index = idx
            self._play_current()
        else:
            self._on_content_not_ready()

    def on_video_complete(self):
        if self.wall_follower:
            return
        self.next()

    def on_video_fault(self):
        r = self.fault.recovery(self.wall_follower, self.current_index, _now_ms())
        if r == PL.Recovery.ADVANCE:
            self.next()
        elif r == PL.Recovery.REPLAY_CURRENT:
            if self.current_item:
                log.warning("video fault in follower/group mode: replaying index %d", self.current_index)
                self._play_current()
        else:
            log.warning("video fault in follower/group mode: just replayed %d, holding", self.current_index)

    def _on_pending_deadline(self):
        if self.pending_items is not None:
            log.warning("deferred playlist swap never got an advance: applying it now")
            self.next()

    # ------------------------------------------------------------------ playing
    def _play_current(self):
        self._advance.stop()
        self._retry.stop()
        item = self.current_item
        if item is None:
            return
        self.item_started_at = _now_ms()
        try:
            if self.save_resume:
                self.save_resume(self.current_index, self.item_started_at)
        except Exception:
            pass
        log.info("playing: %s (index %d)", item.filename, self.current_index)
        self.on_item_changed(item)
        self.has_content_on_screen = True
        self.default_showing = False
        if not self.wall_follower and self.on_play_log:
            prev = self.logged_item
            if prev is not None and prev is not item and prev.log_play:
                self.on_play_log("play_end", prev, True)
            if item.log_play:
                self.on_play_log("play_start", item, False)
            self.logged_item = item if item.log_play else None
        if not self.wall_follower and PL.ends_on_timer(item.mime_type, item.is_widget):
            self._schedule_advance(slot_ms(item))
        elif not self.wall_follower and item.is_live:
            if item.duration_sec > 0:
                self._schedule_advance(item.duration_sec * 1000)
            else:
                self._start_retry("live", CONTENT_RECHECK_MS)

    def close_play_log(self, completed):
        """The item on screen FAILED (not finished): close its row with completed=false before the
        advance, so proof-of-play does not claim a clip that never played (play_end completed fix)."""
        prev = self.logged_item
        if prev is not None and self.on_play_log and prev.log_play:
            self.on_play_log("play_end", prev, completed)
        self.logged_item = None

    def _schedule_advance(self, delay_ms):
        self._advance.stop()
        if self.held:
            return
        self._advance.start(int(max(delay_ms, MIN_ADVANCE_MS)))

    def _start_retry(self, mode, ms):
        self._retry_mode = mode
        self._retry.start(int(ms))

    def _on_retry(self):
        mode = self._retry_mode
        if mode == "content":
            if self.is_running and self.items:
                if self._first_active() < 0:
                    self._show_nothing_scheduled()
                    return
                idx = PL.recheck_index(len(self.items), self.current_index, self.has_content_on_screen,
                                       self._playable_now)
                if idx >= 0:
                    self.current_index = idx
                    self._play_current()
                else:
                    self._on_content_not_ready()
        elif mode == "live":
            item = self.current_item
            if self.is_running and not self.wall_follower and item is not None and item.is_live and item.duration_sec <= 0:
                if not self._allows(item):
                    self.next()
                else:
                    self._start_retry("live", CONTENT_RECHECK_MS)
        elif mode == "nothing":
            if self.is_running and self.items:
                idx = self._first_active()
                if idx >= 0:
                    self.current_index = idx
                    self._play_current()
                else:
                    self._show_nothing_scheduled()

    # ------------------------------------------------------------------ eligibility
    def _allows(self, item):
        return schedule_eval.item_should_play(item.raw, _now_ms(), self.timezone)

    def _playable_now(self, i):
        return 0 <= i < len(self.items) and self._allows(self.items[i]) and self.content_ready(self.items[i])

    def _playable_stale(self, i):
        return 0 <= i < len(self.items) and self._allows(self.items[i]) and self.content_usable(self.items[i])

    def _ordered_scan(self, frm):
        f = frm
        for _ in range(len(self.items)):
            cand = play_order.next_index([i.raw for i in self.items], f, lambda it, idx: self._allows(self.items[idx]),
                                         self.playback_order, self.order_state)
            if cand < 0:
                return -1
            if self._playable_now(cand) or self._playable_stale(cand):
                return cand
            f = cand
        return -1

    def _first_playable(self):
        if self.playback_order in ("shuffle", "weighted"):
            return self._ordered_scan(-1)
        return PL.first_playable_or_stale(len(self.items), self._playable_now, self._playable_stale)

    def _next_playable(self, frm):
        if self.playback_order in ("shuffle", "weighted"):
            return self._ordered_scan(frm)
        return PL.next_playable_or_stale(len(self.items), frm, self._playable_now, self._playable_stale)

    def _first_active(self):
        for i, it in enumerate(self.items):
            if self._allows(it):
                return i
        return -1

    def _on_content_not_ready(self):
        self._advance.stop()
        if PL.when_none_playable(self.has_content_on_screen) == PL.NonePlayable.SHOW_WAITING:
            self.has_content_on_screen = False
            (self.on_waiting_for_content or self.on_nothing_scheduled or self.on_playlist_empty)()
        self._start_retry("content", CONTENT_RECHECK_MS)

    def _show_nothing_scheduled(self):
        self._advance.stop()
        self.has_content_on_screen = False
        if not self._render_default():
            (self.on_nothing_scheduled or self.on_playlist_empty)()
        self._start_retry("nothing", NOTHING_SCHEDULED_RECHECK_MS)

    # ------------------------------------------------------------------ group sync
    def group_schedule_target(self, synced_now_ms):
        """Lay the playlist on the server-disciplined clock. The slot formula MUST equal the web and
        Tizen players' (max(1, duration||10)*1000) or a mixed-platform group diverges. Dwell-0 live
        streams are infinite and excluded."""
        if not self.items:
            return None
        acc = 0
        slots = []
        for i, it in enumerate(self.items):
            if not self._allows(it):
                continue
            if it.is_live and it.duration_sec <= 0:
                continue
            d = slot_ms(it)
            slots.append((i, acc, d))
            acc += d
        if not slots or acc <= 0:
            return None
        phase = ((synced_now_ms % acc) + acc) % acc
        k = len(slots) - 1
        for j, s in enumerate(slots):
            if s[1] <= phase < s[1] + s[2]:
                k = j
                break
        ch = slots[k]
        nx = slots[(k + 1) % len(slots)]
        return {"index": ch[0], "pos_sec": (phase - ch[1]) / 1000.0, "next_index": nx[0],
                "sec_to_boundary": (ch[1] + ch[2] - phase) / 1000.0}
