"""The ScreenTinker native Raspberry Pi player — process wiring.

Two threads, one rule each:
  * the Qt (main) thread owns the scene and every playback decision: Stage, PlaybackEngine, the
    PlaylistController timers, the power schedule, the trigger overlay;
  * the network thread runs one asyncio loop: the device socket, downloads, LAN listeners, the
    remote shell, OTA, http_request.
Crossing is explicit: on_ui(fn) queues onto Qt, on_net(coro) schedules onto the loop. Nothing else
may touch the other side's objects.

Every command — from the dashboard (device:command), the local LAN API, or a remote key — goes through
dispatch_command(), the single definition, as on Android (WebSocketService's one dispatch).
"""

import argparse
import asyncio
import base64
import logging
import logging.handlers
import os
import re
import signal
import sys
import threading
import time

from PySide6.QtCore import QObject, QTimer, QUrl, Signal
from PySide6.QtGui import QGuiApplication
from PySide6.QtQuick import QQuickWindow  # noqa: F401 — makes rootObjects() come back as QQuickWindow (grabWindow)

from . import capabilities
from .config import Config
from .logic.offline_play_queue import OfflinePlayQueue, make_play, new_id
from .net import device_http
from .net.link import DeviceLink
from .net.triggers import TriggerManager
from .player.cache import ContentCache, DownloadCoordinator
from .player.engine import PlaybackEngine
from .platform import audio, brightness, deviceinfo, display, ops, privileged, shell
from .system.power_schedule import PowerSchedule
from .system.updater import Updater
from .ui.extras import SlideAudio, TriggerOverlay, new_frame_key, rtc_page
from .ui.stage import Stage
from .version import VERSION

log = logging.getLogger("app")

HERE = os.path.dirname(os.path.abspath(__file__))
EXIT_BY_OPERATOR = 42


class _UiPost(QObject):
    call = Signal(object)

    def __init__(self):
        super().__init__()
        self.call.connect(self._run)

    def _run(self, fn):
        try:
            fn()
        except Exception:
            log.exception("ui call failed")


class RemoteLogHandler(logging.Handler):
    """set_debug: mirror the player's own log to the dashboard's device log (Android DebugLog)."""

    def __init__(self, app):
        super().__init__(logging.INFO)
        self.app = app

    def emit(self, record):
        if self.app.debug_mirror and record.name not in ("link",):
            try:
                self.app.log_remote(record.levelname.lower(), record.name, record.getMessage(), mirror=True)
            except Exception:
                pass


class App:
    def __init__(self, args):
        self.args = args
        self.config = Config(args.state_dir)
        if args.server:
            self.config.server_url = args.server
        self.qt = QGuiApplication.instance()
        self._post = _UiPost()
        self.stage = Stage(self)
        self.cache = ContentCache(os.path.join(self.config.state_dir, "content"))
        self.transitions_dir = self._find_transitions()
        self.engine = PlaybackEngine(self)
        self.slide_audio_player = SlideAudio(lambda: self.config.server_url)
        self.triggers_ui = TriggerOverlay(self)
        self.power = PowerSchedule(self.config, self._apply_power_schedule, lambda st: None)
        self.loop = None
        self.link = DeviceLink(self.config, self)
        self.downloads = None
        self.triggers = None
        self.updater = None
        self.pty = None
        self.poller = None
        self.play_queue = OfflinePlayQueue(path=os.path.join(self.config.state_dir, "offline-plays.json"))
        try:
            self.play_queue.load()
        except Exception:
            pass
        self._offline_open = None
        self._flush_in_flight = False
        self.debug_mirror = False
        self.remote_streaming = False
        self._stream_timer = QTimer()
        self._stream_timer.setSingleShot(True)
        self._stream_timer.timeout.connect(self._stream_frame)
        self._brightness_supported = False
        self.blanked = False
        self.talk_active = False
        self.live_active = False
        self.frame_key = new_frame_key()
        self.frames_port = None
        self.media_volume = self.config.get("media_volume", 1.0)
        self.window_brightness = self.config.get("window_brightness", -1.0)
        self.system_brightness = None
        self.screen_off_timeout_ms = self.config.get("screen_off_timeout_ms", 0)
        self.started_at = time.monotonic()
        logging.getLogger().addHandler(RemoteLogHandler(self))

    # ------------------------------------------------------------------ threads
    def on_ui(self, fn):
        self._post.call.emit(fn)

    def on_net(self, coro):
        if self.loop:
            return asyncio.run_coroutine_threadsafe(coro, self.loop)
        coro.close()
        return None

    def emit(self, event, payload):
        self.link.emit(event, payload)

    def _net_main(self):
        # ⚠️ Windows: the default ProactorEventLoop cannot create datagram endpoints, which the UDP
        # trigger listener needs. The selector loop can do everything this thread does (sockets, the
        # socket.io client, aiohttp, TCP servers); the Windows backend never uses asyncio subprocesses.
        loop = asyncio.SelectorEventLoop() if sys.platform == "win32" else asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self.loop = asyncio.get_event_loop()
        self.downloads = DownloadCoordinator(self.cache, lambda: self.config.server_url,
                                             lambda cid, ok: self.on_ui(lambda: self.engine.on_download_result(cid, ok)))
        self.triggers = TriggerManager(self)
        self.updater = Updater(self.config, self.emit, self.log_remote)
        self.pty = shell.PtyManager(self.link.aemit)
        self.poller = device_http.EndpointPoller(self.emit, lambda: not self.blanked, lambda: self.config.device_id)
        self.loop.create_task(self._net_startup())
        self.loop.run_until_complete(self.link.run())

    async def _net_startup(self):
        self._brightness_supported = await brightness.supported()
        await display.keep_awake()
        self.system_brightness = await brightness.get_level()
        v = await audio.get_volume()
        if v is not None:
            self.media_volume = v
        await self._start_frame_server()
        self.updater.start()
        cached = self.config.get("cached_payload")
        if isinstance(cached, dict):
            await self._adopt_net_payload(cached)

    # ------------------------------------------------------------------ link handlers (net thread)
    def capabilities(self):
        return capabilities.declared_capabilities(self._brightness_supported)

    def device_info(self):
        w = self.stage.window
        scr = QGuiApplication.primaryScreen()
        size = scr.size() if scr else None
        dpr = scr.devicePixelRatio() if scr else 1.0
        info = {
            # ⚠️ EMPTY on purpose: a non-empty android_version is how the server's platformFamily()
            # recognises Android. The OS goes in hardware_os_version.
            "android_version": "",
            "app_version": VERSION,
            "screen_width": int(size.width() * dpr) if size else 0,
            "screen_height": int(size.height() * dpr) if size else 0,
            "render_width": w.width() if w else 0,
            "render_height": w.height() if w else 0,
            "tier": 0,
            "device_owner": False,
            "foreign_device_owner": False,
            "can_install_silently": privileged.available(),
            "can_write_settings": self._brightness_supported,
            "overlay_granted": True,
            "accessibility_enabled": False,
            "media_volume": self.media_volume,
            "system_brightness": self.system_brightness,
            "window_brightness": self.window_brightness,
            "screen_off_timeout_ms": self.screen_off_timeout_ms,
            "capture_mode": "view",
            "hardware_model": deviceinfo.model(),
            "hardware_serial": deviceinfo.serial(),
            "hardware_os_version": deviceinfo.os_pretty(),
        }
        edid = deviceinfo.primary_edid_b64()
        if edid:
            info["hardware_edid"] = edid
        if self.updater:
            info.update(self.updater.info_fields())
        return info

    def display_power_state(self):
        return self.power.state

    def on_status(self, what, detail):
        self.on_ui(lambda: self._status_changed(what, detail))

    def on_disconnected(self):
        self.on_ui(lambda: self._set_streaming(False))
        if self.pty:
            asyncio.ensure_future(self.pty.close_all("device_offline"))

    def on_registered(self, device_id, paired):
        self.on_ui(self.engine.on_registered)
        self.on_ui(lambda: self._status_changed("registered", paired))

    def on_paired(self, device_id, name):
        self.on_ui(lambda: self._status_changed("paired", name))

    def on_unpaired(self, reason):
        self.on_ui(lambda: self._status_changed("unpaired", reason))

    def on_offline_ack(self, d):
        pass   # handled by the grace timer in flush_offline_plays (the ack carries counts, not ids)

    def request_refresh(self):
        self.link.request_refresh()

    def synced_now_ms(self):
        return self.link.synced_now_ms()

    def on_event(self, event, d):
        """Every app-level server event, on the net thread."""
        d = d if isinstance(d, dict) else {}
        if event == "device:playlist-update":
            asyncio.ensure_future(self._adopt_net_payload(d))
            self.on_ui(lambda: self._adopt_ui_payload(d))
        elif event == "device:command":
            typ = str(d.get("type") or "")
            payload = d.get("payload") if isinstance(d.get("payload"), dict) else {}
            self.on_ui(lambda: self.dispatch_command(typ, payload, source="dashboard"))
        elif event == "device:content-delete":
            cid = str(d.get("content_id") or "")
            if cid:
                self.downloads.forget(cid)
                self.on_ui(lambda: self.engine.remove_content(cid))
        elif event == "device:screenshot-request":
            self.on_ui(self._send_screenshot)
        elif event == "device:remote-start":
            self.on_ui(lambda: self._set_streaming(True))
        elif event == "device:remote-stop":
            self.on_ui(lambda: self._set_streaming(False))
        elif event == "device:remote-touch":
            self.on_ui(lambda: self._remote_touch(d))
        elif event == "device:remote-key":
            self.on_ui(lambda: self._remote_key(str(d.get("keycode") or "")))
        elif event == "device:mute-changed":
            self.on_ui(lambda: self.engine.set_muted_for(str(d.get("content_id") or ""), bool(d.get("muted"))))
        elif event == "device:pip-show":
            self.on_ui(lambda: self._pip_show(d))
        elif event == "device:pip-clear":
            self.on_ui(lambda: self._pip_clear(d.get("pip_id")))
        elif event == "device:trigger-wire":
            if isinstance(d.get("text"), str):
                self.triggers.handle(d["text"].strip(), d.get("source") or "server", d.get("sourceIp") or "server")
        elif event in ("wall:sync",):
            self.on_ui(lambda: self.engine.on_wall_sync(d))
        elif event in ("wall:sync-request",):
            self.on_ui(lambda: self.engine.on_wall_sync_request(d))
        elif event == "group:resync":
            self.on_ui(self.engine.group_resync)
        elif event == "device:live-publish":
            self.on_ui(lambda: self._live_publish(d))
        elif event == "device:talk-start":
            self.on_ui(lambda: self._talk_start(d))
        elif event == "device:talk-stop":
            self.on_ui(self._talk_stop)
        elif event == "device:pty-open":
            asyncio.ensure_future(self.pty.open(d))
        elif event == "device:pty-input":
            self.pty.input(d)
        elif event == "device:pty-resize":
            self.pty.resize(d)
        elif event == "device:pty-close":
            asyncio.ensure_future(self.pty.close(d))

    async def _adopt_net_payload(self, d):
        """The parts of a payload that live on the network thread."""
        await self.triggers.on_payload(d)
        self.poller.update(d.get("endpoints"))

    def _adopt_ui_payload(self, d):
        self.power.update(d.get("power_schedule"))
        self.engine.on_payload(d)

    # ------------------------------------------------------------------ downloads (any thread)
    def ensure_downloads(self, want, prune):
        def go():
            keep = set()
            for cid, filename, mime, rev in want:
                keep.add(cid)
                self.downloads.ensure(cid, filename, mime, rev)
            if prune and keep:
                keep |= {c for c in self.downloads.in_flight}
                self.cache.prune(keep)
        if self.loop:
            self.loop.call_soon_threadsafe(go)

    def fetch_bundle(self, cid, rev):
        async def go():
            import aiohttp
            url = "%s/api/content/%s/bundle?rev=%d" % (self.config.server_url, cid, int(rev or 0))
            try:
                async with aiohttp.ClientSession() as s:
                    async with s.get(url, timeout=aiohttp.ClientTimeout(total=60)) as r:
                        if r.status == 200:
                            html = await r.text()
                            self.engine.bundles.put(cid, rev, html)
            except Exception as e:
                log.info("bundle %s fetch failed: %s", cid, e)
        self.on_net(go())

    # ------------------------------------------------------------------ proof of play
    def play_event(self, event, item, completed):
        cid = item.content_id or item.widget_id or ""
        if self.link.connected:
            self._offline_open = None
            p = {"device_id": self.config.device_id, "event": event, "content_id": cid or None,
                 "content_name": item.filename}
            if event == "play_start":
                p["duration_sec"] = item.duration_sec if item.duration_sec > 0 else None
            else:
                p["completed"] = bool(completed)
            self.emit("device:play-event", p)
            return
        # Offline: remember the start; on leaving, queue the whole play. An end with no matching start
        # is DISCARDED — a fabricated start time in a customer report is worse than a missing row.
        now = int(time.time())
        if event == "play_start":
            self._offline_open = (cid, item.filename, now)
        else:
            o, self._offline_open = self._offline_open, None
            if o and o[0] == cid:
                self.play_queue.add(make_play(new_id(), o[2], content_id=cid or None, content_name=o[1],
                                              ended_at=now, completed=bool(completed)))
                self.play_queue.save()

    async def flush_offline_plays(self):
        if self._flush_in_flight or self.play_queue.size() == 0:
            return
        batch = self.play_queue.peek_batch()
        if not batch:
            return
        self._flush_in_flight = True
        await self.link.aemit("device:play-event", {"device_id": self.config.device_id, "event": "play_offline",
                                                     "plays": batch})
        await asyncio.sleep(4)          # the server acks counts, not ids: clear after a grace
        self.play_queue.ack([p["client_event_id"] for p in batch])
        self.play_queue.save()
        self._flush_in_flight = False
        if self.play_queue.size() and self.link.connected:
            await self.flush_offline_plays()

    # ------------------------------------------------------------------ remote log
    def log_remote(self, level, tag, message, mirror=False):
        if not mirror:
            getattr(log, "warning" if level == "warn" else level if level in ("info", "error", "debug") else "info")(
                "[%s] %s", tag, message)
        if self.config.device_id and (mirror or self.debug_mirror or level in ("warn", "error")):
            self.emit("device:log", {"device_id": self.config.device_id, "tag": tag, "level": level,
                                     "message": str(message)[:2000]})

    # ------------------------------------------------------------------ status screen
    def _status_changed(self, what, detail):
        self._last_status = (what, detail)
        ip = deviceinfo.local_ips()[0] or "no network"
        self.stage.set("footer", "%s · %s · v%s" % (self.config.server_url or "no server", ip, VERSION))
        self.stage.set("hasPin", bool(self.config.settings_pin))
        self._refresh_menu()
        if what == "no_server":
            self.show_status("No server configured",
                             "Run:  sudo screentinker-pi setup https://your-server")
        elif what == "pairing":
            self.stage.set("pairingCode", str(detail or ""))
            if not self.engine.playing or not self.engine.controller.has_content_on_screen:
                self.show_status("Enter this code in the dashboard to pair this display",
                                 "Dashboard → Displays → Add display")
        elif what == "paired":
            self.stage.set("pairingCode", "")
            # ⚠️ The server sends device:paired on EVERY reconnect of a paired panel, not just the
            # first pairing. Showing this unconditionally put "Waiting for content…" over a playlist
            # that was playing fine, until its next item change (found in the Pi e2e run).
            if not self._content_on_screen():
                self.show_status("Paired as %s" % detail, "Waiting for content…")
        elif what == "unpaired":
            self.engine.stop_all()
            self.stage.set("pairingCode", self.config.get("pairing_code") or "")
            self.show_status("This display needs to be paired again", "")
        elif what == "registered" and detail:
            if not self.engine.controller.has_content_on_screen and self.engine.mode == "single" \
                    and not self.engine.controller.items:
                self.show_status("Connected", "Waiting for content…")
        elif what in ("connect_failed", "disconnected") and not self.engine.controller.has_content_on_screen \
                and self.engine.mode == "single":
            self.show_status("Offline — reconnecting", str(detail or ""))

    def _content_on_screen(self):
        return self.engine.mode == "zones" or self.engine.controller.has_content_on_screen

    def show_status(self, title, detail=""):
        self.stage.set("statusTitle", title)
        self.stage.set("statusDetail", detail)
        self.stage.set("statusVisible", True)

    def hide_status(self):
        self.stage.set("statusVisible", False)

    # ------------------------------------------------------------------ commands (Qt thread)
    def dispatch_command(self, typ, p, source="dashboard"):
        log.info("command %s from %s", typ, source)
        p = p if isinstance(p, dict) else {}
        h = getattr(self, "_cmd_" + typ, None)
        if h is None:
            self.log_remote("info", "command", "%s is not supported on this player" % typ)
            return
        try:
            h(p)
        except Exception as e:
            log.exception("command %s", typ)
            self.log_remote("warn", "command", "%s failed: %s" % (typ, e))

    def _report_info(self):
        if self.config.device_id:
            self.emit("device:info", {"device_id": self.config.device_id, "device_info": self.device_info()})

    def _cmd_refresh(self, p):
        self.link.reconnect_soon()

    def _cmd_launch(self, p):
        self.set_blank(False, reason="launch")
        w = self.stage.window
        if w:
            w.showFullScreen()
            w.raise_()
            w.requestActivate()

    def _cmd_screen_on(self, p):
        self.power.note_manual_screen_on()
        self.set_blank(False, reason="manual")

    def _cmd_screen_off(self, p):
        self.power.note_manual_screen_off()
        self.set_blank(True, reason="manual")

    _cmd_lock_now = _cmd_screen_off

    def _cmd_reboot(self, p):
        self.log_remote("info", "command", "rebooting")
        self.emit("device:exit", {"device_id": self.config.device_id, "reason": "clean_exit", "detail": "reboot"})
        self.on_net(ops.reboot())

    def _cmd_shutdown(self, p):
        self.log_remote("info", "command", "shutting down")
        self.emit("device:exit", {"device_id": self.config.device_id, "reason": "clean_exit", "detail": "shutdown"})
        self.on_net(ops.poweroff())

    def _cmd_power_menu(self, p):
        self.stage.openMenu.emit(2)

    def _cmd_settings(self, p):
        self.stage.openMenu.emit(2)

    def _cmd_kiosk_lock(self, p):
        self.config.set("kiosk_locked", True)
        self._refresh_menu()

    def _cmd_kiosk_unlock(self, p):
        self.config.set("kiosk_locked", False)
        self._refresh_menu()

    def _cmd_status_bar(self, p):
        self.log_remote("info", "command", "status_bar: the Pi player is always fullscreen; nothing to hide")

    def _cmd_block_uninstall(self, p):
        self.on_net(self._op_log("block_uninstall", ops.block_uninstall(True)))

    def _cmd_unblock_uninstall(self, p):
        self.on_net(self._op_log("unblock_uninstall", ops.block_uninstall(False)))

    async def _op_log(self, label, coro):
        ok, out = await coro
        self.log_remote("info" if ok else "warn", "command", "%s: %s" % (label, out or ("ok" if ok else "failed")))
        return ok

    def _cmd_set_time(self, p):
        ms = p.get("millis") or p.get("time_ms") or p.get("time")
        if ms is None:
            return
        self.on_net(self._op_log("set_time", ops.set_time(int(ms))))

    def _cmd_set_timezone(self, p):
        tz = str(p.get("timezone") or "")
        if tz:
            self.on_net(self._op_log("set_timezone", ops.set_timezone(tz)))

    def _cmd_update(self, p):
        self.on_net(self.updater.check(forced=True))

    def _cmd_clear_update_cache(self, p):
        self.loop.call_soon_threadsafe(self.updater.clear_cache)

    def _cmd_install_apk(self, p):
        url = str(p.get("url") or "")
        self.on_net(self.updater.install_url(url))

    def _cmd_shell(self, p):
        cmd = str(p.get("cmd") or "")
        if not cmd:
            return

        async def go():
            out, code = await shell.run_one_shot(cmd)
            await self.link.aemit("device:shell-result", {"device_id": self.config.device_id, "cmd": cmd,
                                                          "output": out, "exit": code})
        self.on_net(go())

    def _cmd_set_volume(self, p):
        try:
            level = max(0.0, min(1.0, float(p.get("level"))))
        except (TypeError, ValueError):
            return

        async def go():
            how = await audio.set_volume(level)
            # With no system mixer the player's own output carries it, so the command never no-ops.
            self.on_ui(lambda: self.stage.set("volume", 1.0 if how else level))
            self.media_volume = level
            self.config.set("media_volume", level)
            self._report_info()
        self.on_net(go())

    def _cmd_set_brightness(self, p):
        try:
            level = float(p.get("level"))
        except (TypeError, ValueError):
            return
        self.window_brightness = level
        self.config.set("window_brightness", level)
        # -1 = follow the system: no dimming. Otherwise dim with black; never fully black (that is
        # screen_off's job, and a panel an operator cannot see is a panel they cannot fix).
        self.stage.set("dim", 0.0 if level < 0 else max(0.0, min(0.9, 1.0 - level)))
        self._report_info()

    def _cmd_set_system_brightness(self, p):
        try:
            level = max(0.0, min(1.0, float(p.get("level"))))
        except (TypeError, ValueError):
            return

        async def go():
            done = await brightness.set_level(level)
            if not done:
                self.log_remote("warn", "command", "set_system_brightness: no backlight or DDC/CI monitor found")
            self.system_brightness = level
            self._report_info()
        self.on_net(go())

    def _cmd_set_screen_timeout(self, p):
        try:
            ms = int(p.get("ms", p.get("timeout_ms", 0)))
        except (TypeError, ValueError):
            return
        self.screen_off_timeout_ms = ms
        self.config.set("screen_off_timeout_ms", ms)

        async def go():
            ok, out = await ops.set_screen_timeout(ms)
            if not ok:
                self.log_remote("warn", "command", "set_screen_timeout: %s" % out)
            self._report_info()
        self.on_net(go())

    def _cmd_set_power_schedule(self, p):
        self.power.update(p.get("schedule"))

    def _cmd_http_request(self, p):
        async def go():
            res = await device_http.perform(p)
            res["device_id"] = self.config.device_id
            await self.link.aemit("device:http-result", res)
        self.on_net(go())

    def _cmd_set_debug(self, p):
        self.debug_mirror = bool(p.get("enabled"))
        self.log_remote("info", "Debug", "debug log mirroring %s" % ("on" if self.debug_mirror else "off"), mirror=True)

    _cmd_pip_debug = _cmd_set_debug

    def _cmd_enable_system_capture(self, p):
        self.log_remote("info", "command", "screen capture needs no consent on this player (capture_mode=view)")

    def _cmd_set_server_url(self, p):
        url = str(p.get("url") or "").strip().rstrip("/")
        if not url or not re.match(r"^https?://", url) or url == self.config.server_url:
            self.log_remote("warn", "set_server_url", "rejected: %r" % url)
            return

        async def go():
            import aiohttp
            ok = False
            for attempt in range(2):
                try:
                    async with aiohttp.ClientSession() as s:
                        async with s.get(url + "/api/status", allow_redirects=False,
                                         timeout=aiohttp.ClientTimeout(total=6)) as r:
                            body = await r.text()
                            if 200 <= r.status < 300 and any(k in body for k in ('"version"', '"features"', '"status"')):
                                ok = True
                                break
                except Exception:
                    pass
                await asyncio.sleep(1.2)
            if ok:
                self.config.server_url = url
                self.log_remote("info", "set_server_url", "verified %s — switching" % url)
                self.link.reconnect_soon()
                self.on_ui(lambda: self.stage.toast.emit("Server changed to %s" % url))
            else:
                self.log_remote("warn", "set_server_url", "%s did not answer as a ScreenTinker server — keeping %s"
                                % (url, self.config.server_url))
        self.on_net(go())

    # ------------------------------------------------------------------ screen power
    def set_blank(self, off, reason="manual"):
        if off == self.blanked:
            return
        self.blanked = off
        self.stage.set("blank", off)
        self.restore_mute()

        async def go():
            detail = await display.set_power(not off)
            if not off:
                await display.keep_awake()
            await self.link.aemit("device:event", {"device_id": self.config.device_id,
                                                   "type": "display_off" if off else "display_on",
                                                   "reason": reason, "detail": detail})
        self.on_net(go())

    def _apply_power_schedule(self, off):
        self.set_blank(off, reason="schedule")

    def restore_mute(self):
        muted = self.blanked or self.talk_active or bool(self.stage.triggerVisible)
        self.stage.set("muted", muted)
        self.slide_audio_player.set_master(1.0, muted)

    # ------------------------------------------------------------------ screenshots / remote
    def _capture(self):
        return self.stage.screenshot_jpeg_b64()

    def _send_screenshot(self):
        b64 = self._capture()
        if b64:
            self.emit("device:screenshot", {"device_id": self.config.device_id, "image_b64": b64})

    def _set_streaming(self, on):
        self.remote_streaming = on
        if on:
            self._stream_timer.start(0)
        else:
            self._stream_timer.stop()

    def _stream_frame(self):
        if not self.remote_streaming:
            return
        t0 = time.monotonic()
        self._send_screenshot()
        took = (time.monotonic() - t0) * 1000
        # Android CaptureThrottle: next = clamp(captureMs * 3, 350, 1200).
        self._stream_timer.start(int(max(350, min(1200, took * 3))))

    def _nudge_capture(self):
        if self.remote_streaming:
            self._stream_timer.start(350)

    def _remote_touch(self, d):
        steps = self.stage.inject_touch(d.get("x", 0), d.get("y", 0), str(d.get("action") or "tap"),
                                        d.get("x2"), d.get("y2"), d.get("duration"))
        delay = 0
        for etype, pos, wait in steps:
            delay += wait
            QTimer.singleShot(delay, lambda e=etype, q=pos: self.stage.send_mouse(e, q))
        QTimer.singleShot(delay + 50, self._nudge_capture)

    def _remote_key(self, keycode):
        if keycode == "KEYCODE_POWER":
            self.stage.openMenu.emit(2)
        elif keycode == "KEYCODE_HOME":
            self._cmd_launch({})
            self.engine.controller.start_if_needed()
        elif keycode in ("KEYCODE_VOLUME_UP", "KEYCODE_VOLUME_DOWN"):
            step = 0.1 if keycode.endswith("UP") else -0.1
            self._cmd_set_volume({"level": max(0.0, min(1.0, (self.media_volume or 0) + step))})
        elif keycode in ("KEYCODE_APP_SWITCH", "KEYCODE_MENU", "KEYCODE_SETTINGS"):
            self.stage.openMenu.emit(1)
        else:
            self.stage.inject_key(keycode)
        QTimer.singleShot(50, self._nudge_capture)

    # ------------------------------------------------------------------ PiP
    def _pip_show(self, d):
        pid = str(d.get("pip_id") or "pip")
        uri = str(d.get("uri") or "")
        if uri.startswith("/"):
            uri = self.config.server_url + uri
        pip = dict(d, pip_id=pid, uri=uri, type="web" if d.get("type") == "web" else "image")
        pips = [x for x in self.stage.pips if x.get("pip_id") != pid] + [pip]
        self.stage.set("pips", pips)

    def _pip_clear(self, pid):
        self.stage.set("pips", [] if not pid else [x for x in self.stage.pips if x.get("pip_id") != str(pid)])

    def on_pip_closed(self, pid):
        self._pip_clear(pid)

    # ------------------------------------------------------------------ triggers (Qt thread)
    def trigger_show(self, trigger):
        self.triggers_ui.show(trigger)

    def trigger_hide(self):
        self.triggers_ui.hide()

    def triggers_hide_now(self):
        self.triggers_ui.hide()

    def triggers_once_finished(self):
        c = self.triggers.controller
        c.stop("played once")
        c.promote()

    def local_status(self):
        return {"ok": True, "device_id": self.config.device_id, "name": self.config.get("device_name"),
                "app_version": VERSION, "connected": self.link.connected,
                "screen": "off" if self.blanked else "on",
                "uptime_ms": int((time.monotonic() - self.started_at) * 1000)}

    # ------------------------------------------------------------------ talk + live video
    def _ensure_rtc(self):
        if not self.stage.rtcActive:
            self.stage.set("rtcBaseUrl", self.config.server_url + "/")
            self.stage.set("rtcHtml", rtc_page("ws://127.0.0.1:%s/frames?k=%s" % (self.frames_port, self.frame_key)))
            self.stage.set("rtcActive", True)
            return 1500      # give the page time to load the server's modules
        return 0

    def _rtc_js(self, js, delay):
        QTimer.singleShot(delay, lambda: self.stage.rtcCommand.emit(js))

    def _creds_json(self, extra):
        import json
        base = {"deviceId": self.config.device_id, "deviceToken": self.config.device_token,
                "serverUrl": self.config.server_url}
        base.update(extra)
        return json.dumps(base)

    def _talk_start(self, d):
        if not self.config.device_token:
            return
        self.talk_active = True
        self.restore_mute()
        delay = self._ensure_rtc()
        opts = {"mode": "listen" if d.get("mode") == "listen" else "device", "duplex": bool(d.get("duplex")),
                "scope": d.get("scope")}
        if d.get("iceServers"):
            opts["iceServers"] = d["iceServers"]
        self._rtc_js("ST.talkStart(%s)" % self._creds_json(opts), delay)

    def _talk_stop(self):
        self.talk_active = False
        self.restore_mute()
        self.stage.rtcCommand.emit("ST.talkStop()")
        self._maybe_close_rtc()

    def _live_publish(self, d):
        if d.get("action") == "stop":
            self.live_active = False
            self.stage.rtcCommand.emit("ST.liveStop()")
            self._maybe_close_rtc()
            return
        if d.get("action") != "start" or not self.config.device_token or not self.frames_port:
            return
        self.live_active = True
        delay = self._ensure_rtc()
        opts = {}
        if d.get("iceServers"):
            opts["iceServers"] = d["iceServers"]
        self._rtc_js("ST.liveStart(%s)" % self._creds_json(opts), delay)

    def _maybe_close_rtc(self):
        if not self.talk_active and not self.live_active:
            QTimer.singleShot(1000, lambda: (not self.talk_active and not self.live_active) and self.stage.set("rtcActive", False))

    def on_rtc_log(self, msg):
        parts = msg.split(" ", 3)
        if len(parts) >= 3 and parts[1] == "talk-state":
            st, reason = parts[2], (parts[3] if len(parts) > 3 else "") or None
            self.emit("device:talk-state", {"device_id": self.config.device_id, "device_token": self.config.device_token,
                                            "state": st, "reason": reason})
            if st == "stopped":
                self.talk_active = False
                self.restore_mute()
        elif len(parts) >= 3 and parts[1] == "live" and parts[2] == "stopped":
            self.live_active = False
        if self.debug_mirror:
            self.log_remote("info", "rtc", msg, mirror=True)

    async def _start_frame_server(self):
        """ws://127.0.0.1:<port>/frames — JPEG frames of the scene for the live publisher. Loopback only
        and keyed: any local process could otherwise watch the screen."""
        from aiohttp import web

        async def frames(request):
            if request.query.get("k") != self.frame_key:
                return web.Response(status=403)
            ws = web.WebSocketResponse(max_msg_size=0)
            await ws.prepare(request)
            loop = asyncio.get_running_loop()
            while not ws.closed and self.live_active:
                fut = loop.create_future()
                self.on_ui(lambda: loop.call_soon_threadsafe(fut.set_result, self.stage.frame_jpeg()))
                try:
                    data = await asyncio.wait_for(fut, timeout=2)
                except asyncio.TimeoutError:
                    continue
                if data:
                    await ws.send_bytes(data)
                await asyncio.sleep(1 / 12)
            await ws.close()
            return ws

        wapp = web.Application()
        wapp.router.add_get("/frames", frames)
        runner = web.AppRunner(wapp, access_log=None)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        self.frames_port = site._server.sockets[0].getsockname()[1]

    # ------------------------------------------------------------------ on-device menu
    def _refresh_menu(self):
        acts = [{"id": "refresh", "label": "Reload content"},
                {"id": "repair", "label": "Forget pairing and re-pair"},
                {"id": "reboot", "label": "Reboot"},
                {"id": "shutdown", "label": "Shut down"}]
        if not self.config.get("kiosk_locked"):
            acts.append({"id": "exit", "label": "Exit player"})
        self.stage.set("menuActions", acts)

    def check_pin(self, pin):
        want = self.config.settings_pin
        return bool(want) and pin == want

    def on_menu_action(self, aid):
        if aid == "refresh":
            self._cmd_refresh({})
        elif aid == "repair":
            self.config.clear_identity()
            self.emit("device:self-unpair", {"device_id": self.config.device_id})
            self.link.reconnect_soon()
        elif aid == "reboot":
            self._cmd_reboot({})
        elif aid == "shutdown":
            self._cmd_shutdown({})
        elif aid == "exit" and not self.config.get("kiosk_locked"):
            self.emit("device:exit", {"device_id": self.config.device_id, "reason": "clean_exit", "detail": "menu"})
            # 42 = "an operator chose to exit": the Windows helper's watchdog stands down instead of
            # relaunching (winhelper/service.py EXIT_BY_OPERATOR).
            QTimer.singleShot(300, lambda: self.qt.exit(EXIT_BY_OPERATOR))

    # ------------------------------------------------------------------ Stage callbacks
    def on_slot_event(self, surface, token, event, detail):
        self.engine.on_slot_event(surface, token, event, detail)

    def on_slot_position(self, surface, token, pos, dur):
        self.engine.on_slot_position(surface, token, pos, dur)

    def slide_audio(self, item):
        self.slide_audio_player.apply(item.audio, item.muted or self.engine.controller.wall_follower)

    # ------------------------------------------------------------------ boot
    def _find_transitions(self):
        for p in (os.path.join(HERE, "transitions"), os.path.join(HERE, "..", "..", "shared", "Transitions"),
                  "/usr/share/screentinker-pi/transitions"):
            if os.path.isdir(p):
                return os.path.abspath(p)
        return os.path.join(HERE, "transitions")

    def run(self, engine):
        roots = engine.rootObjects()
        if not roots:
            log.error("QML failed to load")
            return 1
        win = roots[0]
        self.stage.window = win
        # ⚠️ Shader transitions need a GPU scene graph. Qt Quick silently falls back to its SOFTWARE
        # adaptation where no GL/Vulkan is available (a VM, a Pi with the KMS driver disabled, a broken
        # Mesa), and there ShaderEffect draws NOTHING while ShaderEffectSource.hideSource still hides
        # both slots — every transition became ~2 s of black (seen on the arm64 test VM). Detect it
        # once and let the runner crossfade instead, which the software renderer does support.
        try:
            from PySide6.QtQuick import QSGRendererInterface
            api = win.rendererInterface().graphicsApi()
            self.stage.set("shadersSupported", api != QSGRendererInterface.GraphicsApi.Software)
            log.info("scene graph: %s (shader transitions %s)", api.name,
                     "on" if self.stage.shadersSupported else "off: crossfade")
        except Exception as e:
            log.warning("could not read the scene-graph backend (%s); assuming GPU", e)
        if not self.args.windowed:
            if sys.platform == "win32":
                # Fullscreen alone sits UNDER the taskbar and Start menu on Windows (seen in the VM);
                # a kiosk surface must be topmost.
                from PySide6.QtCore import Qt
                win.setFlags(win.flags() | Qt.WindowType.WindowStaysOnTopHint)
            win.showFullScreen()
            win.raise_()
            win.requestActivate()
        self.show_status("Starting…", "")
        self._status_changed("starting", None)
        self.power.start()
        self.stage.set("dim", 0.0 if self.window_brightness < 0 else max(0.0, min(0.9, 1.0 - self.window_brightness)))
        # Cold start from the cached playlist BEFORE the network: a site with its WAN down comes up
        # showing what it had.
        self.engine.restore_cached()
        threading.Thread(target=self._net_main, name="net", daemon=True).start()
        return self.qt.exec()


def _single_instance():
    """One player per Windows session: the helper's watchdog and a manual start must not race two
    players onto one screen (and into one socket identity). A named mutex dies with the process."""
    import ctypes
    k32 = ctypes.windll.kernel32
    global _instance_mutex
    _instance_mutex = k32.CreateMutexW(None, False, "Local\\ScreenTinkerPlayer")
    return k32.GetLastError() != 183   # ERROR_ALREADY_EXISTS


_instance_mutex = None


def main(argv=None):
    """Entry point. ⚠️ A fatal error must EXIT, logged, never hang: the Windows watchdog relaunches a
    player that exits but cannot tell a crashed one sitting behind an error dialog from a healthy one."""
    try:
        return _main(argv)
    except SystemExit:
        raise
    except BaseException:
        logging.getLogger("app").exception("fatal error; exiting so the supervisor restarts the player")
        return 1


def _main(argv=None):
    ap = argparse.ArgumentParser(prog="screentinker-pi")
    ap.add_argument("--server", help="server URL (overrides the stored one)")
    ap.add_argument("--state-dir", help="where pairing/cache/state live")
    ap.add_argument("--windowed", action="store_true", help="do not go fullscreen (development)")
    ap.add_argument("--verbose", "-v", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if sys.stderr is None or getattr(sys, "frozen", False):
        # A windowed build (ScreenTinker.exe) has no console: without a file the log goes nowhere
        # and a field failure leaves no trace. <state>/player.log, 2 MB x 3.
        from .config import default_state_dir
        d = args.state_dir or default_state_dir()
        os.makedirs(d, exist_ok=True)
        fh = logging.handlers.RotatingFileHandler(os.path.join(d, "player.log"), maxBytes=2_000_000,
                                                  backupCount=3, encoding="utf-8")
        fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
        logging.getLogger().addHandler(fh)
        if sys.stderr is None:
            sys.stderr = open(os.devnull, "w")     # libraries that print must not crash on None
        if sys.stdout is None:
            sys.stdout = open(os.devnull, "w")
    for noisy in ("socketio", "engineio", "aiohttp.access"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    if sys.platform == "win32" and not _single_instance():
        log.info("another player is already running in this session; exiting")
        return 0

    # Qt's own warnings (QML errors, shader failures, multimedia) go to stderr by default — which a
    # windowed Windows build discards. Route them into the player log.
    from PySide6.QtCore import QtMsgType, qInstallMessageHandler
    qtlog = logging.getLogger("qt")
    _lvl = {QtMsgType.QtDebugMsg: logging.DEBUG, QtMsgType.QtInfoMsg: logging.INFO,
            QtMsgType.QtWarningMsg: logging.WARNING, QtMsgType.QtCriticalMsg: logging.ERROR,
            QtMsgType.QtFatalMsg: logging.CRITICAL}

    def _qt_msg(mode, ctx, msg):
        if "neither a QObject" in msg:          # PySide6 registration noise, one line per WebEngine type
            return
        qtlog.log(_lvl.get(mode, logging.INFO), "%s", msg)
    qInstallMessageHandler(_qt_msg)

    # WebEngine must be initialised before the application object exists.
    from PySide6.QtWebEngineQuick import QtWebEngineQuick
    os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--autoplay-policy=no-user-gesture-required")
    QtWebEngineQuick.initialize()
    qt = QGuiApplication(sys.argv)
    qt.setApplicationName("ScreenTinker")
    app = App(args)

    from PySide6.QtQml import QQmlApplicationEngine
    engine = QQmlApplicationEngine()
    engine.rootContext().setContextProperty("stage", app.stage)
    engine.load(QUrl.fromLocalFile(os.path.join(HERE, "ui", "qml", "Main.qml")))
    signal.signal(signal.SIGTERM, lambda *a: qt.exit(0))
    signal.signal(signal.SIGINT, lambda *a: qt.exit(0))
    # Let Python see SIGTERM while Qt's loop runs.
    tick = QTimer()
    tick.start(500)
    tick.timeout.connect(lambda: None)
    return app.run(engine)
