"""#234 follow-up: how often a device may ask the server to re-send its playlist.

Port of android service/RefreshThrottle.kt. "Refresh" is not cheap: it emits a full
`device:register`, which runs the whole identity path server-side and pushes a full playlist back.
Calling it on EVERY item advance re-registered a 10-second-image panel six times a minute, forever,
and each reply fed the restart loop behind #234. The heartbeat already pulls every 60s, so throttle
at the single chokepoint — recovery paths still refresh, they just cannot stack up.
"""

# Just under the heartbeat's own 60s pull, so the two interleave instead of cancelling out.
MIN_INTERVAL_MS = 55_000


def should_refresh(last_at_ms: int, now_ms: int) -> bool:
    if last_at_ms <= 0:
        return True  # never refreshed — always allow the first
    since = now_ms - last_at_ms
    if since < 0:
        return True  # clock corrected backwards; never wedge on it
    return since >= MIN_INTERVAL_MS
