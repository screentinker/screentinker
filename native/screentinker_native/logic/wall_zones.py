"""Wall zones + hold items — the pure half (port of the web player's "Wall zones" section,
server/player/index.html: wallZonesActive, wallZoneBuckets, wallZoneTarget, wallZoneRect, the
visibility test in renderWallZones and the drift maths in wallZoneTick).

A video wall with a LAYOUT (server/lib/wall-layout.js) sends `wall_config.canvas_layout = true` and
the WALL's layout, its zones in percent of the wall's player rect. Every panel lays each zone's items
on the shared, server-disciplined clock by itself — no leader relay — so these rules MUST match the
web, Android and Tizen players exactly, or a mixed wall disagrees about where a zone is.

Qt-free on purpose: tests/test_wall_zones.py pins every rule here without a display.
"""

HOLD_MIME = "application/x-st-hold"
LIVE_MIMES = ("video/hls", "video/rtsp")

# The drift thresholds of the group-sync tick (engine._group_tick / the web's groupScheduleTick).
ALIGN_SEC = 0.05
HARD_SEEK_SEC = 0.3
SEEK_COOLDOWN_MS = 1200
LOOP_MARGIN_SEC = 0.3


def _get(it, name, default=None):
    if isinstance(it, dict):
        return it.get(name, default)
    return getattr(it, name, default)


def is_hold(it):
    return bool(it is not None and _get(it, "mime_type") == HOLD_MIME)


def hold_mode(it):
    """'freeze' for hold://freeze, 'blank' for anything else (hold://blank, or junk)."""
    return "freeze" if _get(it, "remote_url") == "hold://freeze" else "blank"


def _dur(it):
    try:
        d = float(_get(it, "duration_sec") or 0)
    except (TypeError, ValueError):
        d = 0.0
    return d


def slot_ms(it):
    """max(1, duration_sec || 10) * 1000 — the canonical slot shared by every player's group sync."""
    d = _dur(it)
    return max(1.0, d if d else 10.0) * 1000.0


def active(wall_config, zones):
    """Wall-zone mode: a wall whose payload carries a layout with two or more zones on its canvas."""
    return bool(isinstance(wall_config, dict) and wall_config.get("canvas_layout")
                and isinstance(zones, list) and len(zones) > 1)


def _area(z):
    return float(z.get("width_percent") or 0) * float(z.get("height_percent") or 0)


def buckets(zones, items, on_orphan=None):
    """Zone membership with renderZones' rules, in LAYOUT order (as the web does): an item on a zone
    this layout does not have goes to the largest zone; unassigned items fill the first zone that has
    none of its own. Each zone's list is sorted by sort_order. -> {zone_id: [items]}"""
    if not zones:
        return {}
    valid = {str(z.get("id")) for z in zones}
    largest = zones[0]
    for z in zones[1:]:
        if _area(z) > _area(largest):        # strictly greater: the first of equals wins (web reduce)
            largest = z
    by = {}
    for it in items:
        zid = _get(it, "zone_id")
        zid = str(zid) if zid not in (None, "") else None
        if zid is not None and zid not in valid:
            if on_orphan:
                on_orphan(it, largest)
            zid = str(largest.get("id"))
        by.setdefault(zid, []).append(it)
    for lst in by.values():
        lst.sort(key=lambda i: int(_get(i, "sort_order") or 0))
    out = {}
    unassigned_used = False
    for z in zones:
        zid = str(z.get("id"))
        lst = by.get(zid)
        if not lst and not unassigned_used and by.get(None):
            unassigned_used = True
            lst = by[None]
        out[zid] = lst or []
    return out


def target(items, now_ms, allows):
    """The zone's place on the shared clock, or None when nothing is schedulable.
    Slots in item order — skipping what `allows` (daypart/schedule) excludes and dwell-0 live streams
    (infinite, no slot) — each max(1, duration||10) s long; phase = now mod period.
    -> {index, pos_sec, slot_sec, prev_index, cycle}. `cycle` (which pass of the period this is)
    lets a caller restart a zone that has a single slot — its index never changes."""
    slots = []
    acc = 0.0
    for i, it in enumerate(items):
        if not allows(it):
            continue
        if _get(it, "mime_type") in LIVE_MIMES and not (_dur(it) > 0):
            continue
        d = slot_ms(it)
        slots.append((i, acc, d))
        acc += d
    if not slots or acc <= 0:
        return None
    phase = ((now_ms % acc) + acc) % acc
    k = len(slots) - 1
    for j, s in enumerate(slots):
        if s[1] <= phase < s[1] + s[2]:
            k = j
            break
    s = slots[k]
    prev = slots[(k - 1) % len(slots)]
    return {"index": s[0], "pos_sec": (phase - s[1]) / 1000.0, "slot_sec": s[2] / 1000.0,
            "prev_index": prev[0], "cycle": int(now_ms // acc)}


def _rect(r):
    r = r if isinstance(r, dict) else {}
    return tuple(float(r.get(k) or 0) for k in ("x", "y", "w", "h"))


def zone_rect(zone, player_rect):
    """The zone in wall-canvas coordinates: player_rect.x + x% * player_rect.w, etc."""
    px, py, pw, ph = _rect(player_rect)
    return (px + float(zone.get("x_percent") or 0) / 100.0 * pw,
            py + float(zone.get("y_percent") or 0) / 100.0 * ph,
            float(zone.get("width_percent") or 0) / 100.0 * pw,
            float(zone.get("height_percent") or 0) / 100.0 * ph)


def zone_visible(zone, wall_config):
    """Does the zone's canvas rect overlap this panel's screen_rect? A zone nobody here can see is
    never mounted — every panel would otherwise decode every zone just to crop it away."""
    x, y, w, h = zone_rect(zone, wall_config.get("player_rect"))
    sx, sy, sw, sh = _rect(wall_config.get("screen_rect"))
    return x < sx + sw and sx < x + w and y < sy + sh and sy < y + h


def zone_has_audio(zone_id, wall_config):
    """One panel voices each zone (the server's audio_zones); everyone else plays it muted."""
    az = wall_config.get("audio_zones") if isinstance(wall_config, dict) else None
    return isinstance(az, list) and str(zone_id) in {str(z) for z in az}


def zone_muted(zone_id, wall_config, item_muted):
    """A zone's video is muted unless this panel voices the zone; a per-item mute still wins."""
    return bool(item_muted) or not zone_has_audio(zone_id, wall_config)


def should_loop(clip_sec, slot_sec):
    """⚠️ Loop ONLY a clip shorter than its slot. One as long as its slot (the usual case) must END
    and stay on its last frame — looped, it wrapped to frame 0 just before the boundary and a
    following FREEZE hold froze the first frame (found on the web player)."""
    return clip_sec is not None and clip_sec > 0 and clip_sec < slot_sec - LOOP_MARGIN_SEC


def video_target_sec(pos_sec, clip_sec, looping):
    """Where the clip should be for slot position pos_sec. A looping clip wraps; a non-looping one
    that is past its end returns None: it has ended and stays on its last frame — correcting it
    would seek it back to near frame 0 (pos % clip) for the rest of the slot."""
    if not clip_sec or clip_sec <= 0:
        return None
    if looping:
        return pos_sec % clip_sec
    if pos_sec >= clip_sec - ALIGN_SEC:
        return None
    return pos_sec


def drift_action(cur_sec, target_sec, align_pending, now_ms, last_seek_ms):
    """The group-sync correction, per zone: first tick after a mount aligns (seek if > 0.05 s, rate
    1.0); then a hard seek if > 0.3 s (at most once per 1.2 s), else a 0.97/1.03 nudge if > 0.05 s,
    else rate 1.0. -> (seek_sec or None, rate)"""
    drift = cur_sec - target_sec
    ad = abs(drift)
    if align_pending:
        return (target_sec if ad > ALIGN_SEC else None), 1.0
    if ad > HARD_SEEK_SEC and now_ms - last_seek_ms > SEEK_COOLDOWN_MS:
        return target_sec, 1.0
    if ad > ALIGN_SEC:
        return None, (0.97 if drift > 0 else 1.03)
    return None, 1.0


def config_key(wall_config, zones):
    """'Did the wall-zone setup change' — geometry, leadership, rotation AND canvas_layout +
    audio_zones (set or clear a wall's layout and nothing else in wall_config changes)."""
    wc = wall_config if isinstance(wall_config, dict) else {}
    return repr((wc.get("wall_id"), bool(wc.get("is_leader")), wc.get("rotation") or 0,
                 _rect(wc.get("screen_rect")), _rect(wc.get("player_rect")),
                 bool(wc.get("canvas_layout")), tuple(str(z) for z in (wc.get("audio_zones") or [])),
                 tuple((str(z.get("id")), z.get("x_percent"), z.get("y_percent"), z.get("width_percent"),
                        z.get("height_percent"), z.get("z_index"), z.get("fit_mode"),
                        z.get("background_color")) for z in (zones or []))))
