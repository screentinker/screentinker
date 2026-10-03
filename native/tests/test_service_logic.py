"""Ports of android CacheValidationTest, RefreshThrottleTest, ConnectionGuardTest,
LivenessWatchdogTest and OtaThrottleTest."""
import pytest

from screentinker_native.logic import cache_validation as cv
from screentinker_native.logic import connection_guard as cg
from screentinker_native.logic import liveness_watchdog as lw
from screentinker_native.logic import ota_throttle as ota
from screentinker_native.logic import refresh_throttle as rt
from screentinker_native.logic.ota_throttle import OtaState

# ================= CacheValidation =================

def test_cache_validation():
    assert cv.is_complete(100, 100)
    assert not cv.is_complete(40, 100)  # truncated
    assert not cv.is_complete(150, 100)  # over-read
    assert cv.is_complete(100, -1)  # unknown length
    assert not cv.is_complete(0, -1)
    assert not cv.is_complete(0, 100)


# ================= RefreshThrottle =================
NOW = 5_000_000
MIN = rt.MIN_INTERVAL_MS


def test_refresh_throttle_rules():
    assert rt.should_refresh(0, NOW)
    assert not rt.should_refresh(NOW - 3_000, NOW)
    assert not rt.should_refresh(NOW - 10_000, NOW)
    assert rt.should_refresh(NOW - MIN, NOW)
    assert rt.should_refresh(NOW - (MIN + 1), NOW)
    assert not rt.should_refresh(NOW - (MIN - 1), NOW)
    assert MIN < 60_000
    assert rt.should_refresh(NOW + 3_600_000, NOW)  # backwards clock never wedges


def test_a_ten_second_item_collapses_to_about_one_refresh_a_minute():
    last, allowed, t = 0, 0, NOW
    for _ in range(6):
        if rt.should_refresh(last, t):
            allowed += 1
            last = t
        t += 10_000
    assert allowed <= 2


# ================= ConnectionGuard =================

def test_connection_guard():
    assert cg.should_open_new_socket(False, False, False)
    assert cg.should_open_new_socket(False, True, False)
    assert not cg.should_open_new_socket(True, True, True)
    assert cg.should_open_new_socket(True, True, False)  # inert
    assert cg.should_open_new_socket(True, False, True)  # url changed
    assert cg.should_open_new_socket(True, False, False)
    for _ in range(8):  # the #148 8-in-9s bind storm
        assert not cg.should_open_new_socket(True, True, True)


# ================= LivenessWatchdog =================

def test_half_open_decision():
    assert not lw.is_half_open(False, True, 999_999, 45_000)  # unarmed: degrade-safe
    assert not lw.is_half_open(True, False, 999_999, 45_000)  # disconnected: Socket.IO's job
    assert lw.is_half_open(True, True, 46_000, 45_000)
    assert not lw.is_half_open(True, True, 30_000, 45_000)


def test_threshold_jitter():
    assert lw.threshold_ms(0.5) == 45_000
    assert lw.threshold_ms(0.0) == 35_000
    assert lw.threshold_ms(0.99995) == 54_999
    for i in range(101):
        assert 35_000 <= lw.threshold_ms(i / 100.0) <= 55_000
    assert lw.threshold_ms(0.1) != lw.threshold_ms(0.9)


def test_backoff_doubles_then_saturates():
    assert [lw.backoff_ms(a, 0.5) for a in (1, 2, 3, 4, 5, 6, 50)] == \
        [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]


def test_backoff_jitter_is_20_percent_and_present():
    assert lw.backoff_ms(5, 0.0) == 12_800
    assert lw.backoff_ms(5, 1.0) == 19_200
    assert lw.backoff_ms(5, 0.2) != lw.backoff_ms(5, 0.8)


def test_may_reconnect_now():
    assert lw.may_reconnect_now(2_000, 1_000)
    assert lw.may_reconnect_now(1_000, 1_000)
    assert not lw.may_reconnect_now(500, 1_000)


# ================= OtaThrottle (#139) =================
V = "1.9.1-beta6"
MAX = ota.MAX_INSTALL_ATTEMPTS
WINDOW = ota.BACKOFF_MS


def launch(start, n, now=1000):
    s = start
    for i in range(n):
        s = ota.on_install_launched(s, now + i)[0]
    return s


def test_new_target_resets_budget():
    stale = OtaState("1.9.1-beta5", 2, 1000, True)
    assert ota.is_new_target(stale, V)
    s, action = ota.on_update_available(stale, V, 5000)
    assert s == OtaState(V, 0, 0, False) and action == ota.ATTEMPT


def test_a_check_never_consumes_budget():
    s = OtaState(V, 0)
    for _ in range(5):
        s, action = ota.on_update_available(s, V, 100)
        assert action == ota.ATTEMPT and s.attempts == 0
    assert ota.on_install_launched(s, 200)[0].attempts == 1


def test_cap_then_backoff_within_window():
    s = launch(OtaState(V), MAX, 1000)
    assert s.attempts == MAX and s.backoff_reported
    ns, action = ota.on_update_available(s, V, 1000 + WINDOW - 1)
    assert action == ota.BACKOFF and ns.attempts == MAX


def test_enter_backoff_signals_exactly_once():
    s, crossings = OtaState(V), 0
    for i in range(MAX + 3):
        s, entered = ota.on_install_launched(s, i)
        crossings += entered
    assert crossings == 1


def test_retry_after_window_does_not_re_report():
    capped = OtaState(V, MAX, 0, True)
    after, action = ota.on_update_available(capped, V, WINDOW + 1)
    assert action == ota.ATTEMPT
    assert ota.on_install_launched(after, WINDOW + 2)[1] is False


def test_clears_on_success_only_when_pending():
    assert ota.should_clear_on_up_to_date(OtaState(V, 2))
    assert not ota.should_clear_on_up_to_date(OtaState())


def test_status_flags_early_and_stays_flagged():
    now, FLAG = 10_000, ota.ATTEMPTS_BEFORE_FLAGGING
    assert ota.status_for(OtaState(), now) == "none"
    assert ota.status_for(OtaState(V, FLAG - 1, now), now) == "pending"
    assert ota.status_for(OtaState(V, FLAG, now), now) == "manual_update_required"
    assert ota.status_for(OtaState(V, FLAG, now), now + WINDOW + 1) == "manual_update_required"
    assert ota.status_for(OtaState(V, MAX, now), now + WINDOW * 5) == "manual_update_required"
    assert ota.ATTEMPTS_BEFORE_FLAGGING < ota.MAX_INSTALL_ATTEMPTS


def test_managed_stand_down():
    now = 1_000_000
    s1, first = ota.on_managed_stand_down(OtaState(), V, now)
    assert first
    s2, again = ota.on_managed_stand_down(s1, V, now + 60_000)
    assert not again
    assert not ota.on_managed_stand_down(s2, V, now + 120_000)[1]
    assert ota.status_for(s1, now) == "manual_update_required" and s1.target_version == V
    later = now + WINDOW + 1
    assert ota.status_for(ota.on_managed_stand_down(s1, V, later)[0], later) == "manual_update_required"
    s3, fresh = ota.on_managed_stand_down(s1, "1.9.24", now + 5_000)
    assert fresh and s3.target_version == "1.9.24"
    assert s1.attempts == MAX and s1.backoff_reported


def test_a_forced_check_un_parks_a_capped_device():
    now = 1_000_000
    capped = OtaState(V, MAX, now, True)
    assert ota.on_update_available(capped, V, now + 60_000)[1] == ota.BACKOFF
    forced = ota.on_forced_check(capped)
    assert ota.on_update_available(forced, V, now + 60_000)[1] == ota.ATTEMPT
    assert forced.target_version == V and forced.attempts == 0 and not forced.backoff_reported


def test_forcing_re_arms_the_report():
    s = ota.on_forced_check(OtaState(V, MAX, 5, True))
    assert launch(s, MAX, 10).attempts == MAX
    assert ota.on_install_launched(OtaState(V, MAX - 1, 5, False), 10)[1] is True


def test_forcing_gives_a_full_budget():
    s = ota.on_forced_check(OtaState(V, MAX, 0, True))
    t, launched = 1_000, 0
    for _ in range(MAX + 2):
        s, action = ota.on_update_available(s, V, t)
        if action == ota.ATTEMPT:
            s = ota.on_install_launched(s, t)[0]
            launched += 1
        t += 60_000
    assert launched == MAX
