"""Pure playlist decision logic, ported from the Android player (no I/O, time injected).

Sources (android/app/src/main/java/com/remotedisplay/player/player/):
  PlaylistSelection.kt  -> playlist selection, PlaybackResume, PendingSwap, ItemTiming
  PlaybackStall.kt      -> PlaybackStall
  PlaybackFault.kt      -> PlaybackFault, PreloadSlot

The viewer-visible invariant these protect: a pending/failed/stalled content download must NEVER
blank or freeze a screen that is showing content — the player keeps showing what it already has
and only swaps to new content once it is fully + validly downloaded.
"""
from __future__ import annotations

from enum import Enum
from typing import Callable, Optional, Sequence

# ============================== PlaylistSelection ==============================


def first_playable_index(size: int, is_playable: Callable[[int], bool]) -> int:
    """First index for which is_playable holds, or -1."""
    for i in range(size):
        if is_playable(i):
            return i
    return -1


def next_playable_index(size: int, frm: int, is_playable: Callable[[int], bool]) -> int:
    """Next index after `frm` (wrapping) that is playable, or -1. With a single playable item it
    returns that item (loop), so a device keeps looping the content it HAS while other items are
    still downloading."""
    if size <= 0:
        return -1
    for i in range(1, size + 1):
        idx = (frm + i) % size  # Python % is already non-negative
        if is_playable(idx):
            return idx
    return -1


def playable_from_index(size: int, frm: int, is_playable: Callable[[int], bool]) -> int:
    """First playable index AT OR AFTER `frm` (wrapping), or -1. A negative `frm` means "no
    position yet" and starts at 0 rather than wrapping onto the last item."""
    if size <= 0:
        return -1
    start = 0 if frm < 0 else frm % size
    for i in range(size):
        idx = (start + i) % size
        if is_playable(idx):
            return idx
    return -1


def recheck_index(size: int, frm: int, has_content_on_screen: bool,
                  is_playable: Callable[[int], bool]) -> int:
    """Which item a content re-check should play once something finally becomes ready.

    has_content_on_screen is the entire distinction. When content IS up, `frm` is a real position
    that has had its turn, so move PAST it. When nothing is up, `frm` is only where playback
    INTENDED to begin (seeded to 0 before anything played) — advancing past it silently drops item
    1 from the first pass. That is the cold-start case on every fresh panel: the playlist arrives
    before its media, and the re-check is what actually begins playback.
    """
    if has_content_on_screen:
        return next_playable_index(size, frm, is_playable)
    return playable_from_index(size, frm, is_playable)


class NonePlayable(str, Enum):
    KEEP_CURRENT = "keep_current"
    SHOW_WAITING = "show_waiting"


def when_none_playable(has_content_on_screen: bool) -> NonePlayable:
    """When nothing is playable: NEVER blank a screen that is showing content. Only fall to the
    waiting/setup state when nothing has ever been displayed."""
    return NonePlayable.KEEP_CURRENT if has_content_on_screen else NonePlayable.SHOW_WAITING


# ⚠️ TWO PASSES, AND THE ORDER IS THE DESIGN. `strict` = scheduled AND the cached copy is the
# revision the playlist asked for; anything passing it must always win. `stale` = do we have bytes
# at all? — asked ONLY when strict finds nothing anywhere (an asset cached before content revisions
# existed can never satisfy strict, and a panel full of playable media sat on "Waiting for
# content"). A blank screen is worse than slightly stale content; it is not better than fresh
# content, which is why this runs second and never first.
def first_playable_or_stale(size, strict, stale) -> int:
    hit = first_playable_index(size, strict)
    return hit if hit >= 0 else first_playable_index(size, stale)


def next_playable_or_stale(size, frm, strict, stale) -> int:
    hit = next_playable_index(size, frm, strict)
    return hit if hit >= 0 else next_playable_index(size, frm, stale)


# ============================== PlaybackResume (#234) ==============================

# How recently we must have been playing for a reload to count as a continuation.
RESUME_WINDOW_MS = 90_000


def resume_index(saved_index: int, saved_at_ms: int, now_ms: int, item_count: int) -> int:
    """Index to begin scanning from when a playlist is (re)loaded.

    Starting from the top is only correct for a genuinely COLD start; a panel that relaunched
    itself at each item boundary never showed item 2 (#234). A negative/out-of-range index, an
    empty playlist, a zero/stale save, or a clock that jumped backwards all fall back to 0.
    """
    if item_count <= 0:
        return 0
    if saved_index < 0 or saved_index >= item_count:
        return 0
    if saved_at_ms <= 0:
        return 0
    age = now_ms - saved_at_ms
    if age < 0 or age > RESUME_WINDOW_MS:
        return 0
    return saved_index


# ============================== PendingSwap (#157) ==============================

# How long a deferred swap may wait for "the next natural advance" before it is applied anyway.
# The deferral assumes an advance is coming; YouTube proved it might not be.
PENDING_SWAP_DEADLINE_MS = 60_000


def should_defer_swap(is_running: bool, wall_follower: bool, has_content_on_screen: bool,
                      currently_playing_id: Optional[str], new_content_ids: Sequence[str]) -> bool:
    """Should a playlist update wait for the current item to finish? False = apply now.

    Guard 1: an EMPTY new list is an operator saying "stop showing that" — never deferred.
    Guard 2 is the caller's: pair a deferral with PENDING_SWAP_DEADLINE_MS, because an item that
    never advances (a YouTube embed) would otherwise strand the swap forever.
    """
    if not is_running or wall_follower or not has_content_on_screen:
        return False
    if currently_playing_id is None:
        return False
    if len(new_content_ids) == 0:  # guard 1: an explicit stop
        return False
    return currently_playing_id not in new_content_ids


# ============================== ItemTiming ==============================

# The mime the server stamps on an uploaded HTML bundle (lib/html-bundle.js).
BUNDLE_MIME = "application/vnd.screentinker.bundle+zip"


def ends_on_timer(mime_type: str, is_widget: bool) -> bool:
    """Which items end on a TIMER versus a completion callback.

    video/youtube and HTML bundles report no completion (a web embed), so without a timer they
    stop the playlist for good. Local/remote video deliberately stay OFF the timer — the player
    reports end-of-stream and a timer would cut a clip short. Unknown types are not timed either:
    the player skips them immediately, and a timer too would be two advances for one item.
    """
    mime_type = mime_type or ""
    return (mime_type.startswith("image/") or is_widget or mime_type == "video/youtube"
            or mime_type == BUNDLE_MIME)


# ============================== PlaybackStall (#297) ==============================


class PlaybackStall:
    """Has playback stopped moving while it believes it is playing?

    ⚠️ A decoder that WEDGES reports neither end-of-stream nor an error: it stays READY with
    play-when-ready true and the position stops moving. Nothing noticed, so the playlist stopped
    for good. A stall is not an error, which is why nothing caught it.
    """

    STATE_IDLE = 1
    STATE_BUFFERING = 2
    STATE_READY = 3
    STATE_ENDED = 4

    def __init__(self, ready_stall_ms: int = 10_000, buffering_stall_ms: int = 30_000):
        self.ready_stall_ms = ready_stall_ms
        # Buffering is allowed longer: a remote stream on a poor link legitimately buffers.
        self.buffering_stall_ms = buffering_stall_ms
        self._last_position_ms = -1
        # ⚠️ None, NOT a 0 sentinel: a caller whose first tick is at t=0 collided with the sentinel
        # and had its timer silently restarted every tick, so a wedge was never reported.
        self._stuck_since_ms: Optional[int] = None

    def reset(self) -> None:
        """Forget everything. Call whenever a new item is mounted or playback is stopped."""
        self._last_position_ms = -1
        self._stuck_since_ms = None

    def tick(self, now_ms: int, state: int, play_when_ready: bool, position_ms: int) -> bool:
        """Feed one observation. Returns True exactly once when the item first looks wedged; the
        caller is expected to advance, which resets this."""
        # ⚠️ ONLY WHEN THE PLAYER CLAIMS TO BE PLAYING. A paused item (held wall follower, a
        # group-sync member waiting for its slot) is not stalled; ENDED/IDLE belong to other paths.
        if not play_when_ready or state not in (self.STATE_READY, self.STATE_BUFFERING):
            self.reset()
            return False
        if position_ms != self._last_position_ms:
            # Progress. A looping single video resets to ~0, which is still a change.
            self._last_position_ms = position_ms
            self._stuck_since_ms = now_ms
            return False
        since = self._stuck_since_ms
        if since is None:  # first observation at this position
            self._stuck_since_ms = now_ms
            return False
        limit = self.buffering_stall_ms if state == self.STATE_BUFFERING else self.ready_stall_ms
        if now_ms - since < limit:
            return False
        # Report once, then forget — a second report on the same item would advance twice.
        self.reset()
        return True


# ============================== PlaybackFault (#333) ==============================


class Recovery(str, Enum):
    ADVANCE = "advance"  # solo playback: skip the broken item
    REPLAY_CURRENT = "replay_current"  # follower/group: keep the index, re-mount, let sync re-align
    HOLD = "hold"  # follower/group, same item just replayed: leave it, retry later


class PlaybackFault:
    """What to do when a video FAILS, as opposed to finishing.

    ⚠️ A FAULT IS NOT A COMPLETION. The follower gate ("wall followers don't self-advance") is right
    for a natural end and wrong for a fault: routing the #297 wedge through the completion path let
    the gate swallow it, switching off every self-heal in exactly the mode the report came from.
    A solo playlist ADVANCES past a broken item; a follower REPLAYS it (a cold re-mount resets the
    decoder), at most once per cooldown per item so a corrupt file cannot replay in a tight loop.
    """

    def __init__(self, replay_cooldown_ms: int = 5_000):
        self.replay_cooldown_ms = replay_cooldown_ms
        self._last_replay_index = -1
        self._last_replay_at_ms: Optional[int] = None  # None, not a 0 sentinel — see PlaybackStall

    def recovery(self, follower: bool, index: int, now_ms: int) -> Recovery:
        if not follower:
            return Recovery.ADVANCE
        at = self._last_replay_at_ms
        if at is not None and self._last_replay_index == index and now_ms - at < self.replay_cooldown_ms:
            return Recovery.HOLD
        self._last_replay_index = index
        self._last_replay_at_ms = now_ms
        return Recovery.REPLAY_CURRENT


class Claim(str, Enum):
    COLD = "cold"  # nothing usable parked for this file: cold prepare on the active player
    WARM = "warm"  # a prepared player is parked with this file: promote it as-is
    WARM_NEEDS_PREPARE = "warm_needs_prepare"  # parked with this file but IDLE: prepare, then promote


class PreloadSlot:
    """The group-sync double buffer's parking slot (#333).

    ⚠️ THE 0:00 FREEZE: a preload that died while parked (decoder reclaimed) was promoted anyway —
    play on an IDLE player does nothing, and the screen sat on a freeze-frame with no error to
    recover from. fail() forgets the file; claim() reports IDLE so the caller prepares first.
    """

    def __init__(self):
        self._parked_path: Optional[str] = None

    def is_parked(self, path: str) -> bool:
        return self._parked_path == path

    def park(self, path: str) -> None:
        self._parked_path = path

    def fail(self) -> None:
        self._parked_path = None

    def clear(self) -> None:
        self._parked_path = None

    def claim(self, path: str, player_is_idle: bool) -> Claim:
        """A claim consumes the slot on WARM / WARM_NEEDS_PREPARE; COLD leaves whatever is parked
        in place (it may be the clip after this one)."""
        if self._parked_path != path:
            return Claim.COLD
        self._parked_path = None
        return Claim.WARM_NEEDS_PREPARE if player_is_idle else Claim.WARM
