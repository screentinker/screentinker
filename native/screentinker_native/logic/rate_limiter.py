"""Per-source token bucket with a global ceiling.

Python port of createRateLimiter in server/lib/trigger-resolve.js and TriggerResolve.RateLimiter in
android trigger/TriggerResolve.kt. Defaults are the trigger door's (5/s, burst 10, 50/s global);
the LocalApi door uses RateLimiter.local_api() (2/s, burst 5, 10/s global), as Android does.

⚠️ The point is not to stop a determined flood — UDP from the LAN cannot be stopped here — it is to
bound the WORK a flood causes, so a chatty or hostile sender cannot turn the screen into a strobe or
the log into a firehose. Keyed by source address, with a GLOBAL ceiling so a spoofed source per
packet cannot walk around the per-source limit.

⚠️ The bucket map is bounded two ways (Kotlin evicts the oldest-inserted key past max_keys; JS
exposes prune()). A spoofed-source flood would otherwise grow it without limit — a slow leak on
the one device nobody is watching.

`now` is caller-supplied milliseconds (use a monotonic clock in production). The "no observation
yet" state is None, not a 0 sentinel: the JS/Kotlin `if (!gLast)` treats a first call at t=0 as
unset forever, the same trap PlaybackStall documents.
"""
from __future__ import annotations

import threading
from collections import OrderedDict


class RateLimiter:
    def __init__(self, per_sec: float = 5.0, burst: float = 10.0, global_per_sec: float = 50.0,
                 max_keys: int = 512):
        self.per_sec = float(per_sec)
        self.burst = float(burst)
        self.global_per_sec = float(global_per_sec)
        self.max_keys = int(max_keys)
        self._buckets: "OrderedDict[str, list]" = OrderedDict()  # key -> [tokens, last_ms]
        self._g_tokens = self.global_per_sec
        self._g_last = None
        self._lock = threading.Lock()

    @classmethod
    def trigger(cls) -> "RateLimiter":
        """The trigger door (UDP + HTTP): 5/s per source, burst 10, 50/s global."""
        return cls(per_sec=5, burst=10, global_per_sec=50)

    @classmethod
    def local_api(cls) -> "RateLimiter":
        """The LocalApi door: 2/s per source, burst 5, 10/s global (android TriggerManager.apiLimiter)."""
        return cls(per_sec=2, burst=5, global_per_sec=10)

    def allow(self, key: str, now_ms: float) -> bool:
        with self._lock:
            t = float(now_ms)
            if self._g_last is None:
                self._g_last = t
            self._g_tokens = min(self.global_per_sec,
                                 self._g_tokens + ((t - self._g_last) / 1000.0) * self.global_per_sec)
            self._g_last = t
            if self._g_tokens < 1.0:
                return False

            b = self._buckets.get(key)
            if b is None:
                if len(self._buckets) >= self.max_keys:
                    self._buckets.popitem(last=False)  # evict the oldest-inserted key
                b = [self.burst, t]
                self._buckets[key] = b
            b[0] = min(self.burst, b[0] + ((t - b[1]) / 1000.0) * self.per_sec)
            b[1] = t
            if b[0] < 1.0:
                return False

            b[0] -= 1.0
            self._g_tokens -= 1.0
            return True

    def prune(self, now_ms: float, max_age_ms: float = 300_000) -> int:
        """Drop buckets idle longer than max_age_ms; returns the remaining size."""
        with self._lock:
            for k in [k for k, b in self._buckets.items() if now_ms - b[1] > max_age_ms]:
                del self._buckets[k]
            return len(self._buckets)

    @property
    def size(self) -> int:
        return len(self._buckets)
