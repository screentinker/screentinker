"""#139: OTA throttle decision logic (pure; the updater is the imperative shell).

Port of android service/OtaThrottle.kt. Rules:
 - a new target version resets the attempt budget,
 - a check NEVER consumes the budget — only a launched install does (so a transient download/network
   failure can't park a healthy device in backoff),
 - after MAX_INSTALL_ATTEMPTS launched installs, back off to one retry per BACKOFF_MS,
 - "a human is needed" is flagged ONCE, at ATTEMPTS_BEFORE_FLAGGING — long before giving up.
"""
from dataclasses import dataclass, replace
from typing import Tuple

# Why 40 and not 3: an attempt is nearly free (the verified package is cached and reused), and what
# actually blocks installs is often a human-in-the-loop who may walk past at any hour. ~40 keeps
# trying across a working day (30-minute cadence ≈ 20h) before falling back to the daily retry.
MAX_INSTALL_ATTEMPTS = 40
# Telling the operator is a SEPARATE decision from giving up, and it has to stay early: flagging
# only at the cap would push "this panel needs attention" from ~1 hour out to ~20.
ATTEMPTS_BEFORE_FLAGGING = 3
BACKOFF_MS = 24 * 60 * 60 * 1000

ATTEMPT = "attempt"
BACKOFF = "backoff"


@dataclass(frozen=True)
class OtaState:
    """Persisted OTA state for the version we are currently trying to install."""
    target_version: str = ""
    attempts: int = 0
    last_attempt_at: int = 0
    backoff_reported: bool = False


def is_new_target(state: OtaState, latest_version: str) -> bool:
    """True when latest_version differs from the persisted target — caller drops stale packages."""
    return state.target_version != latest_version


def on_update_available(state: OtaState, latest_version: str, now: int) -> Tuple[OtaState, str]:
    """A check found latest_version. Returns (state to persist, ATTEMPT|BACKOFF). Does NOT count an
    attempt: the budget is consumed only by on_install_launched()."""
    s = OtaState(target_version=latest_version) if is_new_target(state, latest_version) else state
    if s.attempts >= MAX_INSTALL_ATTEMPTS and now - s.last_attempt_at < BACKOFF_MS:
        return s, BACKOFF
    return s, ATTEMPT


def on_install_launched(state: OtaState, now: int) -> Tuple[OtaState, bool]:
    """An install was actually launched. Consumes one attempt; the bool is True only on the FIRST
    launch to reach the flagging threshold (report "manual update required" once). The latch is
    re-armed by a new target or a forced check."""
    attempts = state.attempts + 1
    s = replace(state, attempts=attempts, last_attempt_at=now)
    should_flag = attempts >= ATTEMPTS_BEFORE_FLAGGING and not s.backoff_reported
    if should_flag:
        s = replace(s, backoff_reported=True)
    return s, should_flag


def on_managed_stand_down(state: OtaState, latest_version: str, now: int) -> Tuple[OtaState, bool]:
    """Installs on this panel belong to someone else (a foreign device manager): do not self-install,
    but do not go quiet either — "no update pending" forever is how a panel stayed 12 versions
    behind unnoticed. Park in manual_update_required and report ONCE per target version."""
    s = OtaState(target_version=latest_version) if is_new_target(state, latest_version) else state
    report = not s.backoff_reported
    return replace(s, attempts=MAX_INSTALL_ATTEMPTS, last_attempt_at=now, backoff_reported=True), report


def on_forced_check(state: OtaState) -> OtaState:
    """An operator pressed "force update" on THIS device: hand the budget back (keep the target —
    "try again now", not "forget") and re-arm the report so a second cap is announced again."""
    return replace(state, attempts=0, backoff_reported=False)


def should_clear_on_up_to_date(state: OtaState) -> bool:
    """A check found us already on the latest. True if there was pending OTA state to clear."""
    return state.target_version != ""


def status_for(state: OtaState, now: int) -> str:
    """Operator-facing status: 'none' | 'pending' | 'manual_update_required'. Keyed on the FLAGGING
    threshold, not the cap, and NOT on the backoff window — a device still retrying that needs a
    human must not read as plain 'pending' between retries."""
    if state.target_version == "":
        return "none"
    if state.attempts >= ATTEMPTS_BEFORE_FLAGGING:
        return "manual_update_required"
    return "pending"
