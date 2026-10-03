"""Playlist play-order: sequential (default) | shuffle (no-repeat bag) | weighted.

Python port of server/lib/play-order.js (Kotlin: player/PlayOrder.kt).

CONTRACT: players call next_index() at every advance. Sequential is the historical "from+1, skip
ineligible" walk. Shuffle draws from a bag of currently-eligible indices and only refills once the
bag is empty (no immediate repeats while >1 eligible). Weighted picks among eligible by
playlist_items.weight (default 1), avoiding the item just played when another eligible item exists.

FAILS OPEN to sequential: unknown mode, missing state, empty list -> sequential walk. A blank
screen is worse than playing in order.

⚠️ Wall/group followers MUST NOT call this — the leader's index is the source of truth. Shuffle on
a follower would desync the wall.
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from typing import Callable, List, Optional


@dataclass
class PlayOrderState:
    """Caller-owned shuffle state; one per playlist/zone."""
    bag: Optional[List[int]] = None
    bag_key: Optional[str] = None


def weight_of(item) -> int:
    w = item.get("weight") if isinstance(item, dict) else None
    if isinstance(w, bool) or not isinstance(w, (int, float)) or math.isnan(w) or math.isinf(w) or w < 1:
        return 1
    return min(1000, int(math.floor(w)))


def _draw(rnd, n: int) -> int:
    # floor(rnd() * n), clamped as the Kotlin port does, so an rnd() returning exactly 1.0 cannot
    # index past the end.
    return min(n - 1, max(0, int(math.floor(rnd() * n))))


def _shuffle_in_place(arr, rnd):
    for i in range(len(arr) - 1, 0, -1):
        j = _draw(rnd, i + 1)
        arr[i], arr[j] = arr[j], arr[i]
    return arr


def _sequential_next(items, frm, allows) -> int:
    if not items:
        return -1
    start = frm if isinstance(frm, int) and not isinstance(frm, bool) and frm >= 0 else -1
    n = len(items)
    for k in range(1, n + 1):
        idx = (start + k) % n
        if allows(items[idx], idx):
            return idx
    return -1


def _eligible(items, allows):
    return [i for i, it in enumerate(items) if allows(it, i)]


def _make_bag(eligible, frm, rnd):
    # A full bag holds EVERY eligible index once (so nothing is under-played over a cycle),
    # shuffled. To avoid an immediate repeat across the bag boundary, if the first draw would be
    # the item just played and another can lead, swap it deeper.
    bag = _shuffle_in_place(list(eligible), rnd)
    if len(bag) > 1 and bag[0] == frm:
        j = 1 + _draw(rnd, len(bag) - 1)
        bag[0], bag[j] = bag[j], bag[0]
    return bag


def _next_shuffle(items, frm, allows, state, rnd) -> int:
    eligible = _eligible(items, allows)
    if not eligible:
        return -1
    key = ",".join(str(i) for i in sorted(eligible))
    if state.bag is None or state.bag_key != key:
        state.bag = _make_bag(eligible, frm, rnd)
        state.bag_key = key
    # Drop anything that has since become ineligible (daypart closed mid-bag).
    while state.bag and state.bag[0] not in eligible:
        state.bag.pop(0)
    if not state.bag:
        state.bag = _make_bag(eligible, frm, rnd)
        state.bag_key = key
    return state.bag.pop(0)


def _next_weighted(items, frm, allows, rnd) -> int:
    eligible = _eligible(items, allows)
    if not eligible:
        return -1
    pool = [i for i in eligible if i != frm] if len(eligible) > 1 else eligible
    weights = [weight_of(items[i]) for i in pool]
    total = sum(weights)
    if total <= 0:
        return pool[0]
    r = rnd() * total
    acc = 0
    for idx, w in zip(pool, weights):
        acc += w
        if r < acc:  # JS band semantics: [acc_prev, acc)
            return idx
    return pool[-1]


def next_index(items, frm, allows_fn=None, mode=None, state=None,
               rnd: Optional[Callable[[], float]] = None) -> int:
    """items: playlist list; frm: index just played (-1 on first pick);
    allows_fn(item, index) -> bool (schedule/window/condition); mode: 'sequential'|'shuffle'|
    'weighted'; state: PlayOrderState owned by the caller; rnd: () -> [0,1) for tests."""
    allows = allows_fn if callable(allows_fn) else (lambda _it, _i: True)
    try:
        rand = rnd if callable(rnd) else random.random
        st = state if isinstance(state, PlayOrderState) else PlayOrderState()
        m = mode or "sequential"
        if m == "shuffle":
            return _next_shuffle(items, frm, allows, st, rand)
        if m == "weighted":
            return _next_weighted(items, frm, allows, rand)
        return _sequential_next(items, frm, allows)
    except Exception:
        return _sequential_next(items, frm, allows)


def first_index(items, allows_fn=None, mode=None, state=None, rnd=None) -> int:
    return next_index(items, -1, allows_fn, mode, state, rnd)
