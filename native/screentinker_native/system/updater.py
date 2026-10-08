"""Self-update (the `update` command and a 30-minute poll) and package install (`install_apk`).

Android UpdateChecker parity, with a .deb instead of an APK:
  GET <server>/api/pi/update/check?version=&device_id=[&forced=1]
    -> {update_available, latest_version, download_url, sha256, size}
  download to <state>/ota/<name>.part, verify size AND sha256 against what the check announced,
  promote, then the privileged helper installs it detached from this service (it restarts us).
The attempt budget is logic/ota_throttle.py (Android OtaThrottle): a check never consumes it, a
launched install does, "manual update required" is flagged once at 3, daily retry after 40.

Only a PACKAGED install updates itself. A source checkout (version ends in -dev, or no
/usr/lib/screentinker-pi) reports and never installs — a dev box must not overwrite itself with
whatever the server calls latest.
"""

import asyncio
import dataclasses
import hashlib
import logging
import os
import re
import time
import urllib.parse

import aiohttp

from ..logic import ota_throttle as T
from ..version import VERSION
from ..platform import ops

log = logging.getLogger("ota")

CHECK_EVERY_S = 30 * 60
FIRST_CHECK_S = 60
def packaged():
    # SELF_UPDATE False (platform/macos) means this OS never installs itself: like a source checkout it
    # reports a newer version and stops there, so it never downloads a package it cannot install.
    return getattr(ops, "SELF_UPDATE", True) and ops.packaged() and not VERSION.endswith("-dev")


class Updater:
    def __init__(self, config, emit, log_remote):
        self.config = config
        self.emit = emit
        self.log_remote = log_remote
        self.ota_dir = os.path.join(config.state_dir, "ota")
        os.makedirs(self.ota_dir, exist_ok=True)
        s = config.get("ota_state") or {}
        self.state = T.OtaState(**{k: s[k] for k in ("target_version", "attempts", "last_attempt_at",
                                                     "backoff_reported") if k in s})
        self.status = config.get("ota_status") or "none"
        self._lock = asyncio.Lock()
        self._task = None

    # --- reporting ---------------------------------------------------------------------------
    def info_fields(self):
        return {"ota_status": self.status, "ota_target_version": self.state.target_version or None,
                "ota_attempts": self.state.attempts}

    def _save(self, status=None):
        if status:
            self.status = status
        self.config.update({"ota_state": dataclasses.asdict(self.state), "ota_status": self.status})
        self.emit("device:ota-status", dict(self.info_fields(), device_id=self.config.device_id))

    # --- scheduling ----------------------------------------------------------------------------
    def start(self):
        if self._task is None:
            self._task = asyncio.ensure_future(self._loop())

    async def _loop(self):
        await asyncio.sleep(FIRST_CHECK_S)
        while True:
            try:
                await self.check(forced=False)
            except Exception:
                log.exception("update check")
            await asyncio.sleep(CHECK_EVERY_S)

    # --- check / install ---------------------------------------------------------------------
    async def check(self, forced):
        async with self._lock:
            server = self.config.server_url
            if not server or not ops.UPDATE_CHECK_PATH:
                return          # no check at all where the OS updates the player itself (macOS)
            if forced:
                self.state = T.on_forced_check(self.state)
            q = {"version": VERSION, "device_id": self.config.device_id or ""}
            if forced:
                q["forced"] = "1"
            url = "%s%s?%s" % (server, ops.UPDATE_CHECK_PATH, urllib.parse.urlencode(q))
            try:
                async with aiohttp.ClientSession() as s:
                    async with s.get(url, timeout=aiohttp.ClientTimeout(total=30)) as r:
                        if r.status != 200:
                            log.info("update check: HTTP %s", r.status)
                            return
                        info = await r.json(content_type=None)
            except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as e:
                log.info("update check failed: %s", e)
                return
            if not info.get("update_available"):
                if T.should_clear_on_up_to_date(self.state):
                    self.state = T.OtaState()
                    self._save("none")
                return
            latest = str(info.get("latest_version") or "")
            if not packaged():
                why = getattr(ops, "NO_SELF_UPDATE_REASON", "this is a source checkout")
                self.log_remote("info", "ota", "update %s available, but %s — not installing" % (latest, why))
                return
            if T.is_new_target(self.state, latest):
                self._purge()
            self.state, verdict = T.on_update_available(self.state, latest, int(time.time() * 1000))
            if verdict == T.BACKOFF:
                self._save("manual_update_required")
                return
            self._save("pending")
            path = await self._download(server + str(info.get("download_url") or ops.DOWNLOAD_PATH),
                                        ops.PACKAGE_NAME.format(version=re.sub(r"[^0-9A-Za-z.~+-]", "_", latest)),
                                        info.get("sha256"), info.get("size"))
            if not path:
                return
            await self._install(path, latest)

    async def install_url(self, url):
        """install_apk {url}: a .deb from anywhere the operator points. The helper decides whether a
        package that is not screentinker-pi may be installed at all (allow_package_install)."""
        if not re.match(r"^https?://", url or ""):
            self.log_remote("warn", "ota", "install_apk: not an http(s) URL")
            return
        name = os.path.basename(urllib.parse.urlsplit(url).path) or "package.deb"
        name = re.sub(r"[^0-9A-Za-z._~+-]", "_", name)
        if not name.lower().endswith(ops.PACKAGE_EXT) and not name.lower().endswith((".msi", ".deb", ".exe")):
            name += ops.PACKAGE_EXT
        path = await self._download(url, name, None, None)
        if path:
            ok, out = await ops.install_package(path)
            self.log_remote("info" if ok else "warn", "ota", "install_apk %s: %s" % (name, out[-300:]))

    async def _download(self, url, name, sha256, size):
        final = os.path.join(self.ota_dir, name)
        part = final + ".part"
        h = hashlib.sha256()
        n = 0
        try:
            async with aiohttp.ClientSession() as s:
                async with s.get(url, timeout=aiohttp.ClientTimeout(total=None, sock_read=60)) as r:
                    if r.status != 200:
                        self.log_remote("warn", "ota", "download %s: HTTP %s" % (name, r.status))
                        return None
                    with open(part, "wb") as f:
                        async for chunk in r.content.iter_chunked(256 * 1024):
                            f.write(chunk)
                            h.update(chunk)
                            n += len(chunk)
                        f.flush()
                        os.fsync(f.fileno())
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as e:
            self.log_remote("warn", "ota", "download %s failed: %s" % (name, e))
            return None
        if size and int(size) != n:
            self.log_remote("warn", "ota", "download %s: size %d != announced %s" % (name, n, size))
            os.unlink(part)
            return None
        if sha256 and h.hexdigest() != str(sha256).lower():
            self.log_remote("warn", "ota", "download %s: sha256 mismatch — refusing to install" % name)
            os.unlink(part)
            return None
        os.replace(part, final)
        return final

    async def _install(self, path, version):
        self.state, flag = T.on_install_launched(self.state, int(time.time() * 1000))
        self._save("manual_update_required" if flag else "pending")
        self.log_remote("info", "ota", "installing %s" % os.path.basename(path))
        ok, out = await ops.install_package(path)
        if not ok:
            self.log_remote("warn", "ota", "install failed to start: %s" % out[-300:])

    def _purge(self):
        for n in os.listdir(self.ota_dir):
            try:
                os.unlink(os.path.join(self.ota_dir, n))
            except OSError:
                pass

    def clear_cache(self):
        self._purge()
        self.state = T.OtaState()
        self._save("none")
