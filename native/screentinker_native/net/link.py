"""The device socket — a port of Android's WebSocketService connection discipline.

Runs on the network thread's asyncio loop. Everything the rest of the player needs from the server
arrives through the `handlers` object (see app.py); everything it sends goes through emit(), which is
safe to call from any thread.

What is carried over from Android, and why each piece exists (the Kotlin has the full history):
  * ONE socket, reopened by us rather than by Socket.IO's own reconnection, so the server's
    device:throttled can actually pause us (#314) instead of being reconnected straight into.
  * A stable 6-digit pairing code, reused across reconnects until device:paired consumes it.
  * Rejection (device:unpaired / auth-error) clears credentials ONCE, shows the pairing screen, honours
    a reclaim-settle window ("offline for N seconds") and schedules exactly one re-register — never an
    inline re-register, which stormed the server's reclaim guard (#150).
  * Heartbeat every 15s; every 4th one re-registers to pull a fresh playlist, gated at >= 55s so an
    advance-triggered refresh cannot turn into six full registers a minute (#234).
  * NTP-style clock offset from device:heartbeat-ack, persisted so group sync survives a WAN outage.
  * The half-open watchdog: armed only after the first ack (an old server that never acks must not
    trip it), fires when the socket claims to be connected but the server has been silent > ~45s.
  * The connectivity report (why were we offline?) and the offline proof-of-play flush, both only
    after device:registered, because the server requires an authenticated socket for them.
"""

import asyncio
import logging
import random
import re
import socket as pysocket
import time

import socketio

from ..platform import deviceinfo, ops
from ..version import VERSION

log = logging.getLogger("link")

NS = "/device"
HEARTBEAT_S = 15
REFRESH_MIN_S = 55
REOPEN_AFTER_EVICT_S = 3
BACKOFF_MIN_S, BACKOFF_MAX_S = 1.0, 60.0
REPAIR_BACKOFF_MIN_S, REPAIR_BACKOFF_MAX_S = 3.0, 60.0
HALF_OPEN_BASE_S, HALF_OPEN_JITTER_S = 45.0, 10.0
WATCHDOG_BACKOFF_MIN_S, WATCHDOG_BACKOFF_MAX_S = 1.0, 30.0
COLD_START_WINDOW_S = 120


class DeviceLink:
    def __init__(self, config, handlers):
        self.config = config
        self.h = handlers
        self.loop = None
        self.sio = None
        self.connected = False
        self._stop = False
        self._wake = None                  # asyncio.Event: reopen now
        self._throttle_until = 0.0
        self._fail_count = 0
        # liveness
        self._last_server_msg = time.monotonic()
        self._armed = False
        self._threshold = self._jitter_threshold()
        self._watchdog_attempt = 0
        self._last_watchdog_at = 0.0
        # pairing / repair
        self.awaiting_repair = False
        self.pairing_code_live = False
        self._repair_pending = False
        self._repair_backoff = 0.0
        self._repair_hold_until = 0.0
        self._last_refresh = 0.0
        # clock
        self._clock_offset = int(config.get("clock_offset_ms", 0) or 0)
        self._clock_rtt = -1
        # connectivity report
        self._disconnected_at = None
        self._internet_ok_during_gap = None
        self._ip_at_disconnect = None
        self._pending_report = None
        self._first_connect = True
        self._hb_task = None

    # ------------------------------------------------------------------ public, any thread
    def emit(self, event, payload):
        """Fire-and-forget from any thread. Dropped (not queued) while disconnected, same as Android."""
        if not self.loop:
            return
        asyncio.run_coroutine_threadsafe(self.aemit(event, payload), self.loop)

    async def aemit(self, event, payload):
        if self.sio is None or not self.connected:
            return False
        try:
            await self.sio.emit(event, payload, namespace=NS)
            return True
        except Exception as e:  # socketio raises BadNamespaceError etc. mid-teardown
            log.debug("emit %s failed: %s", event, e)
            return False

    def synced_now_ms(self):
        return int(time.time() * 1000) + self._clock_offset

    def reconnect_soon(self):
        """set_server_url / refresh: tear down and reopen against config.server_url."""
        if self.loop:
            self.loop.call_soon_threadsafe(lambda: asyncio.ensure_future(self._force_reopen("requested")))

    def request_refresh(self):
        if self.loop:
            self.loop.call_soon_threadsafe(lambda: asyncio.ensure_future(self.refresh_register()))

    # ------------------------------------------------------------------ main loop
    async def run(self):
        self.loop = asyncio.get_running_loop()
        self._wake = asyncio.Event()
        asyncio.ensure_future(self._backstop())
        while not self._stop:
            url = self.config.server_url
            if not url:
                self.h.on_status("no_server", None)
                await self._sleep_or_wake(10)
                continue
            wait = self._throttle_until - time.monotonic()
            if wait > 0:
                log.warning("throttled: holding off %.1fs", wait)
                await self._sleep_or_wake(wait)
                self._throttle_until = 0.0
            await self._open(url)
            # Wait until this socket dies (disconnect handler sets _wake) or a reopen is requested.
            await self._wake.wait()
            self._wake.clear()
            await self._close()
            if self._stop:
                break
            if self._fail_count:
                delay = min(BACKOFF_MAX_S, BACKOFF_MIN_S * (2 ** min(self._fail_count - 1, 6)))
                delay *= 1 + random.uniform(-0.5, 0.5)
            else:
                delay = REOPEN_AFTER_EVICT_S
            await self._sleep_or_wake(max(0.5, delay))

    async def _sleep_or_wake(self, s):
        try:
            await asyncio.wait_for(self._wake.wait(), timeout=s)
            self._wake.clear()
        except asyncio.TimeoutError:
            pass

    async def _open(self, url):
        sio = socketio.AsyncClient(reconnection=False, logger=False, engineio_logger=False,
                                   ssl_verify=self.config.get("ssl_verify", True))
        self.sio = sio
        self._bind(sio)
        self.h.on_status("connecting", url)
        try:
            await sio.connect(url, namespaces=[NS], transports=["websocket", "polling"],
                              socketio_path="socket.io", wait_timeout=20)
        except Exception as e:
            self._fail_count += 1
            log.warning("connect to %s failed (%d): %s", url, self._fail_count, e)
            self.h.on_status("connect_failed", str(e))
            self._wake.set()

    async def _close(self):
        sio, self.sio = self.sio, None
        self.connected = False
        self._stop_heartbeat()
        if sio is not None:
            try:
                await sio.disconnect()
            except Exception:
                pass

    async def _force_reopen(self, why):
        log.info("reopening socket: %s", why)
        self._fail_count = 0
        self._wake.set()

    # ------------------------------------------------------------------ handlers
    def _on(self, sio, event, fn):
        async def wrapped(*args):
            self._last_server_msg = time.monotonic()   # ANY inbound message is proof of life
            try:
                r = fn(args[0] if args else None)
                if asyncio.iscoroutine(r):
                    await r
            except Exception:
                log.exception("handler %s failed", event)
        sio.on(event, wrapped, namespace=NS)

    def _bind(self, sio):
        on = lambda ev, fn: self._on(sio, ev, fn)
        sio.on("connect", self._on_connect, namespace=NS)
        sio.on("disconnect", self._on_disconnect, namespace=NS)
        on("device:registered", self._on_registered)
        on("device:heartbeat-ack", self._on_ack)
        on("device:unpaired", lambda d: self._rejected("device:unpaired (removed on server)"))
        on("device:auth-error", lambda d: self._rejected("auth-error: %s" % ((d or {}).get("error") or "Authentication failed")))
        on("device:throttled", self._on_throttled)
        on("device:paired", self._on_paired)
        on("device:settings-pin", self._on_settings_pin)
        on("device:play-offline-ack", lambda d: self.h.on_offline_ack(d))
        on("device:self-unpair-ok", lambda d: None)
        # Everything else is the application's business.
        for ev in ("device:playlist-update", "device:content-delete", "device:command",
                   "device:screenshot-request", "device:remote-start", "device:remote-stop",
                   "device:remote-touch", "device:remote-key", "device:live-publish",
                   "device:talk-start", "device:talk-stop", "device:pip-show", "device:pip-clear",
                   "device:mute-changed", "device:trigger-wire",
                   "wall:sync", "wall:sync-request", "group:sync", "group:sync-request", "group:resync",
                   "device:pty-open", "device:pty-input", "device:pty-resize", "device:pty-close",
                   "device:kiosk-sessions-ack"):
            on(ev, (lambda e: (lambda d: self.h.on_event(e, d)))(ev))

    async def _on_connect(self):
        self.connected = True
        self._last_server_msg = time.monotonic()
        self._fail_count = 0
        log.info("connected to %s", self.config.server_url)
        self.h.on_status("connected", None)
        self._arm_connectivity_report()
        if self.awaiting_repair and not self.config.is_paired:
            log.info("register suppressed: awaiting re-pair")
            return
        await self.register()

    async def _on_disconnect(self, *args):
        was = self.connected
        self.connected = False
        self._stop_heartbeat()
        self._armed = False
        if was:
            log.warning("disconnected")
            self._disconnected_at = time.monotonic()
            self._ip_at_disconnect = deviceinfo.local_ips()[0]
            self._internet_ok_during_gap = None
            asyncio.ensure_future(self._probe_internet())
            self.h.on_status("disconnected", None)
            self.h.on_disconnected()
        if self._wake:
            self._wake.set()

    # ------------------------------------------------------------------ register / pairing
    def _identity(self, d):
        d.update({
            "client_type": ops.CLIENT_TYPE,
            "client_version": VERSION,
            "platform": deviceinfo.platform_string(),
            "contract_version": "v4",
            # Recomputed every register, never cached: a CEC adapter, a backlight or DDC can appear
            # between boots on the same SD card.
            "capabilities": self.h.capabilities(),
        })
        return d

    async def register(self, from_repair_retry=False):
        if self.awaiting_repair and not self.config.is_paired and not from_repair_retry:
            return
        d = {}
        if self.config.is_paired:
            d["device_id"] = self.config.device_id
            if self.config.device_token:
                d["device_token"] = self.config.device_token
        else:
            code = self.config.get("pairing_code")
            if not code:
                code = str(random.randint(100000, 999999))
                self.config.set("pairing_code", code)
            d["pairing_code"] = code
            self.config.set("device_id", None)
            self.h.on_status("pairing", code)
        d["device_info"] = self.h.device_info()
        d["fingerprint"] = deviceinfo.fingerprint()
        self._identity(d)
        self._last_refresh = time.monotonic()
        await self.aemit("device:register", d)

    async def refresh_register(self):
        """Every 60s (4th heartbeat) and on network change: pull a fresh playlist."""
        if not self.connected or not self.config.device_id:
            return
        now = time.monotonic()
        if now - self._last_refresh < REFRESH_MIN_S:
            return
        self._last_refresh = now
        d = {"device_id": self.config.device_id, "device_info": self.h.device_info()}
        if self.config.device_token:
            d["device_token"] = self.config.device_token
        self._identity(d)
        await self.aemit("device:register", d)

    async def _on_registered(self, d):
        d = d or {}
        dev_id = d.get("device_id") or ""
        if not dev_id:
            return
        upd = {"device_id": dev_id}
        if "device_token" in d:
            upd["device_token"] = d.get("device_token") or None
        self.config.update(upd)
        self.pairing_code_live = True
        if self.config.is_paired:
            self._reset_repair()
        elif self.awaiting_repair:
            self._repair_pending = False
            self._repair_backoff = 0.0
            self._repair_hold_until = 0.0
        log.info("registered as %s (%s)", dev_id, d.get("status") or "active")
        self.h.on_registered(dev_id, self.config.is_paired)
        self._start_heartbeat()
        await self._flush_connectivity_report()
        await self.h.flush_offline_plays()

    async def _on_paired(self, d):
        d = d or {}
        was_paired = self.config.is_paired
        upd = {"paired": True, "pairing_code": None, "device_name": d.get("name") or "Display"}
        if d.get("device_id"):
            upd["device_id"] = d["device_id"]
        if d.get("settings_pin"):
            upd["settings_pin"] = str(d["settings_pin"])
        self.config.update(upd)
        self.pairing_code_live = False
        self._reset_repair()
        log.info("paired as %s", upd["device_name"])
        self.h.on_paired(self.config.device_id, upd["device_name"])
        # The pre-pairing register created a PROVISIONING row, which does not store identity or
        # capabilities; without this the dashboard shows baseline controls until the 60 s refresh.
        # ⚠️ ONLY on the unpaired -> paired transition. The server also sends device:paired on every
        # ordinary reconnect of a paired device, in reply to a register — re-registering on THAT is a
        # register/paired/register loop (it stormed the server in the first e2e run).
        if not was_paired:
            self._last_refresh = 0.0
            await self.refresh_register()

    def _on_settings_pin(self, d):
        pin = str((d or {}).get("settings_pin") or "")
        if pin:
            self.config.set("settings_pin", pin)
            log.info("settings PIN updated from dashboard")   # never log the PIN itself

    def _rejected(self, reason):
        m = re.search(r"offline for (\d+) seconds", reason or "")
        settle = int(m.group(1)) if m else 0
        log.warning("server rejected device (%s), settle=%ss", reason, settle)
        self.pairing_code_live = False
        self.config.clear_identity()
        if settle > 0:
            self._repair_hold_until = time.monotonic() + settle
        if not self.awaiting_repair:
            self.awaiting_repair = True
            self.h.on_unpaired(reason)
        self._schedule_repair_register()

    def _schedule_repair_register(self):
        if self._repair_pending:
            return
        self._repair_pending = True
        hold = self._repair_hold_until - time.monotonic()
        if hold > 0:
            delay = hold
        else:
            self._repair_backoff = REPAIR_BACKOFF_MIN_S if self._repair_backoff <= 0 else min(
                self._repair_backoff * 2, REPAIR_BACKOFF_MAX_S)
            delay = self._repair_backoff

        async def later():
            await asyncio.sleep(delay)
            self._repair_pending = False
            if self.connected and not self.config.is_paired:
                await self.register(from_repair_retry=True)
        asyncio.ensure_future(later())

    def _reset_repair(self):
        self._repair_pending = False
        self._repair_backoff = 0.0
        self.awaiting_repair = False
        self._repair_hold_until = 0.0

    def _on_throttled(self, d):
        d = d or {}
        try:
            asked = int(d.get("retry_after_ms") or 0)
        except (TypeError, ValueError):
            asked = 0
        wait_ms = max(1000, min(asked, 5 * 60 * 1000))
        log.warning("throttled by server: %dms (%s)", wait_ms, d.get("reason") or "")
        self._throttle_until = time.monotonic() + wait_ms / 1000.0
        self._wake.set()

    # ------------------------------------------------------------------ heartbeat / clock / watchdog
    def _start_heartbeat(self):
        self._stop_heartbeat()
        self._hb_task = asyncio.ensure_future(self._heartbeat_loop())

    def _stop_heartbeat(self):
        if self._hb_task:
            self._hb_task.cancel()
            self._hb_task = None

    async def _heartbeat_loop(self):
        n = 0
        while self.connected:
            await self.aemit("device:heartbeat", {
                "device_id": self.config.device_id,
                "client_ms": int(time.time() * 1000),
                "display_power": self.h.display_power_state(),
                "telemetry": await asyncio.get_running_loop().run_in_executor(
                    None, deviceinfo.telemetry, self.config.state_dir),
            })
            n += 1
            if n % 4 == 0:
                await self.refresh_register()
            if self._check_half_open():
                return
            await asyncio.sleep(HEARTBEAT_S)

    def _jitter_threshold(self):
        return HALF_OPEN_BASE_S + random.uniform(-HALF_OPEN_JITTER_S, HALF_OPEN_JITTER_S)

    def _check_half_open(self):
        silence = time.monotonic() - self._last_server_msg
        if not (self._armed and self.connected and silence > self._threshold):
            return False
        backoff = min(WATCHDOG_BACKOFF_MAX_S, WATCHDOG_BACKOFF_MIN_S * (2 ** self._watchdog_attempt))
        backoff *= 1 + random.uniform(-0.2, 0.2)
        if time.monotonic() - self._last_watchdog_at < backoff:
            return False
        self._watchdog_attempt += 1
        self._last_watchdog_at = time.monotonic()
        self._threshold = self._jitter_threshold()
        log.warning("watchdog: HALF-OPEN (silent %.0fs), reconnecting (attempt %d)", silence, self._watchdog_attempt)
        self._wake.set()
        return True

    async def _backstop(self):
        """Disconnected AND silent past the threshold: force a fresh socket. Covers a reconnect that
        wedged somewhere our own loop cannot see (DNS hang inside the client, a stuck handshake)."""
        while not self._stop:
            await asyncio.sleep(20)
            if self.sio is not None and not self.connected and \
                    time.monotonic() - self._last_server_msg > HALF_OPEN_BASE_S:
                self._last_server_msg = time.monotonic()
                log.warning("backstop: disconnected and silent; forcing a fresh socket")
                self._wake.set()

    def _on_ack(self, d):
        if not self._armed:
            log.info("watchdog armed (first heartbeat-ack)")
        self._armed = True
        self._watchdog_attempt = 0
        d = d or {}
        try:
            server_ms, client_ms = int(d.get("server_ms") or 0), int(d.get("client_ms") or 0)
        except (TypeError, ValueError):
            return
        if server_ms <= 0 or client_ms <= 0:
            return
        t4 = int(time.time() * 1000)
        rtt = max(0, t4 - client_ms)
        if rtt > 5000:
            return  # a stalled sample would poison the offset
        sample = server_ms - (client_ms + t4) // 2
        if self._clock_rtt < 0 or abs(sample - self._clock_offset) > 1000:
            self._clock_offset = sample
        else:
            self._clock_offset = round(self._clock_offset * 0.8 + sample * 0.2)
        self._clock_rtt = rtt
        self.config.set("clock_offset_ms", self._clock_offset)

    # ------------------------------------------------------------------ connectivity report
    async def _probe_internet(self):
        for host in ("1.1.1.1", "8.8.8.8"):
            try:
                fut = asyncio.open_connection(host, 443)
                r, w = await asyncio.wait_for(fut, timeout=5)
                w.close()
                self._internet_ok_during_gap = True
                return
            except (OSError, asyncio.TimeoutError):
                continue
        if self._internet_ok_during_gap is None:
            self._internet_ok_during_gap = False

    def _arm_connectivity_report(self):
        now = time.monotonic()
        cold = False
        if self._first_connect:
            self._first_connect = False
            boot = deviceinfo.boot_time_s()
            cold = boot is not None and (time.time() - boot) < COLD_START_WINDOW_S
            if not cold:
                return
        elif self._disconnected_at is None:
            return
        ssid, rssi = deviceinfo.wifi()
        ip_now = deviceinfo.local_ips()[0]
        rep = {
            "offline_ms": int((now - self._disconnected_at) * 1000) if self._disconnected_at else 0,
            "link_lost": ip_now is None,
            "ip_changed": bool(self._ip_at_disconnect and ip_now and ip_now != self._ip_at_disconnect),
            "cold_start": cold,
        }
        if ssid:
            rep["ssid"] = ssid
        if rssi is not None:
            rep["rssi"] = rssi
        if self._internet_ok_during_gap is not None:
            rep["internet_ok"] = self._internet_ok_during_gap
        self._pending_report = rep
        self._disconnected_at = None

    async def _flush_connectivity_report(self):
        rep, self._pending_report = self._pending_report, None
        if rep:
            rep["device_id"] = self.config.device_id
            await self.aemit("device:connectivity-report", rep)
