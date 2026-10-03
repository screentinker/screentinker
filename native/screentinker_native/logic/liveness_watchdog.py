"""v4 canonical liveness contract — the client-side half-open watchdog decisions.

Port of android service/LivenessWatchdog.kt. The shell tracks last_server_message_at (ANY inbound
refreshes it), arms only after a device:heartbeat-ack (degrade-safe), and on each heartbeat tick asks
this module whether a connected-but-silent socket is half-open and whether backoff allows a
reconnect now.

ANTI-THUNDERING-HERD (must not become the flood #143/#149 fixed): the THRESHOLD is jittered (45s ±
up to 10s) so a fleet doesn't all declare half-open at once under a shared cause, and the reconnect
BACKOFF is exponential-with-jitter (1,2,4,8,16… capped, ±20%). There is deliberately NO
status/health poll — that is itself a second herd. Defaults match the .wgt and /player.
"""

THRESHOLD_BASE_MS = 45_000  # v4 canonical: 45s …
THRESHOLD_JITTER_MS = 10_000  # … ± up to 10s
BACKOFF_BASE_MS = 1_000  # 1s, 2s, 4s, 8s, 16s …
BACKOFF_CAP_MS = 30_000  # … capped
BACKOFF_JITTER_FRACTION = 0.2  # … each ± ~20%


def threshold_ms(rand: float) -> int:
    """45s ± up to 10s; `rand` uniform in [0, 1) -> result in [35s, 55s). int() truncates toward
    zero, matching Kotlin's Double.toLong()."""
    return THRESHOLD_BASE_MS + int((rand - 0.5) * 2 * THRESHOLD_JITTER_MS)


def backoff_ms(attempt: int, rand: float) -> int:
    """Exponential reconnect backoff with ±20% jitter. `attempt` is 1-based. The shift is clamped
    so a large attempt count cannot blow up."""
    steps = min(max(attempt - 1, 0), 20)
    base = min(BACKOFF_BASE_MS << steps, BACKOFF_CAP_MS)
    jitter = int((rand - 0.5) * 2 * BACKOFF_JITTER_FRACTION * base)
    return base + jitter


def is_half_open(armed: bool, connected: bool, silence_ms: int, threshold: int) -> bool:
    """Reconnect only when a socket that is connected (the state its own auto-reconnect can't see)
    and armed (seen >=1 heartbeat-ack — an ack-less/old server never arms us) has been silent longer
    than the threshold."""
    return armed and connected and silence_ms > threshold


def may_reconnect_now(ms_since_last_attempt: int, backoff: int) -> bool:
    """Backoff gate: spaces repeated failures fleet-wide."""
    return ms_since_last_attempt >= backoff
