"""The per-source token bucket (JS createRateLimiter tests + Kotlin TriggerRateLimiterTest)."""
from screentinker_native.logic.rate_limiter import RateLimiter

# ---- JS trigger-resolve.test.js ----

def test_a_burst_is_allowed_then_throttled_then_recovers():
    rl = RateLimiter(per_sec=5, burst=3, global_per_sec=1000)
    now = 0
    assert [rl.allow("10.0.0.1", now) for _ in range(3)] == [True, True, True]
    assert rl.allow("10.0.0.1", now) is False, "burst exhausted"
    now += 1000
    assert rl.allow("10.0.0.1", now) is True


def test_one_noisy_source_cannot_starve_another():
    rl = RateLimiter(per_sec=1, burst=2, global_per_sec=1000)
    rl.allow("10.0.0.1", 0)
    rl.allow("10.0.0.1", 0)
    assert rl.allow("10.0.0.1", 0) is False
    assert rl.allow("10.0.0.2", 0) is True


def test_a_global_ceiling_stops_a_spoofed_source_flood():
    rl = RateLimiter(per_sec=100, burst=100, global_per_sec=3)
    allowed = sum(1 for i in range(50) if rl.allow("10.0.0.%d" % i, 0))
    assert allowed == 3


def test_the_bucket_map_is_pruned():
    rl = RateLimiter(global_per_sec=1000)
    for i in range(20):
        rl.allow("10.0.0.%d" % i, 0)
    assert rl.size == 20
    assert rl.prune(400_000) == 0
    assert rl.size == 0


# ---- Kotlin TriggerRateLimiterTest (defaults 5/s, burst 10, 50/s global) ----

def test_burst_is_allowed_then_refused():
    rl = RateLimiter.trigger()
    t = 1_000_000
    for _ in range(10):
        assert rl.allow("1.2.3.4", t)
    assert rl.allow("1.2.3.4", t) is False


def test_tokens_refill_over_time():
    rl = RateLimiter()
    t = 1_000_000
    for _ in range(10):
        rl.allow("1.2.3.4", t)
    assert rl.allow("1.2.3.4", t) is False
    assert rl.allow("1.2.3.4", t + 1000) is True


def test_sources_are_metered_independently():
    rl = RateLimiter()
    t = 1_000_000
    for _ in range(10):
        rl.allow("1.2.3.4", t)
    assert rl.allow("1.2.3.4", t) is False
    assert rl.allow("5.6.7.8", t) is True


def test_the_global_ceiling_bounds_spoofed_sources():
    rl = RateLimiter()
    allowed = sum(1 for i in range(200) if rl.allow("10.0.0.%d" % i, 1_000_000))
    assert allowed <= 50


def test_the_bucket_map_is_bounded():
    rl = RateLimiter(max_keys=8)
    t = 1_000_000
    for i in range(100):
        rl.allow("src-%d" % i, t)
        t += 1000
    assert rl.size <= 8
    assert rl.allow("src-final", t) is True


# ---- Pi-specific ----

def test_local_api_limits():
    rl = RateLimiter.local_api()
    t = 5_000
    assert sum(1 for _ in range(20) if rl.allow("192.168.1.9", t)) == 5  # burst 5
    assert rl.allow("192.168.1.9", t + 500) is True  # 2/s -> one token after 500ms
    rl2 = RateLimiter.local_api()
    assert sum(1 for i in range(100) if rl2.allow("h%d" % i, t)) == 10  # 10/s global


def test_a_first_call_at_t0_is_a_real_observation():
    # JS/Kotlin use `!gLast` / `gLast == 0L` as "unset", so a first call at t=0 never anchors the
    # global clock and the first real refill is lost. None-sentinel: a second at t=1000 refills.
    rl = RateLimiter(per_sec=100, burst=100, global_per_sec=2)
    assert rl.allow("a", 0) and rl.allow("b", 0)
    assert rl.allow("c", 0) is False
    assert rl.allow("d", 1000) is True
