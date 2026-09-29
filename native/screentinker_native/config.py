"""Persistent player state: server URL, pairing identity, and everything the Android app keeps in
SharedPreferences.

One JSON file, written atomically (temp + fsync + rename). Two locations matter:

  * /etc/screentinker-pi/config.json — what the INSTALLER wrote (server URL, optional name). Read
    only. It seeds state on first run and is never written by the player, so a reinstall with a new
    URL is the operator's lever and cannot be silently overwritten by the device.
  * <state dir>/state.json — what the PLAYER owns: device_id, device_token, pairing code, the
    server URL once changed from the dashboard (set_server_url), clock offset, power schedule,
    volume/brightness, kiosk flag, OTA counters, the resume position.

⚠️ OVERLAY FS: on a Pi with the read-only overlay enabled the state dir is discarded every boot,
which unpairs the panel. Same trap as the web player (docs say: pair BEFORE enabling the overlay) —
except here the fix is to point ST_STATE_DIR at a persistent partition, which the installer's
--state-dir option does.
"""

import json
import os
import tempfile
import threading

from .platform import ops

SYSTEM_CONFIG = ops.system_config_path()


def default_state_dir():
    return ops.default_state_dir()


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            v = json.load(f)
        return v if isinstance(v, dict) else {}
    except (OSError, ValueError):
        return {}


def atomic_write_json(path, data):
    d = os.path.dirname(path) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=1, sort_keys=True)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


class Config:
    """Thread-safe key/value state. The network thread and the Qt thread both read and write it."""

    def __init__(self, state_dir=None):
        self.state_dir = state_dir or default_state_dir()
        os.makedirs(self.state_dir, exist_ok=True)
        self.path = os.path.join(self.state_dir, "state.json")
        self._lock = threading.RLock()
        self._data = _read_json(self.path)
        self._system = _read_json(SYSTEM_CONFIG)

    # --- generic ---------------------------------------------------------------------------
    def get(self, key, default=None):
        with self._lock:
            return self._data.get(key, default)

    def set(self, key, value):
        self.update({key: value})

    def update(self, values):
        with self._lock:
            changed = False
            for k, v in values.items():
                if v is None:
                    if k in self._data:
                        del self._data[k]
                        changed = True
                elif self._data.get(k) != v:
                    self._data[k] = v
                    changed = True
            if changed:
                atomic_write_json(self.path, self._data)

    def path_in_state(self, *parts):
        p = os.path.join(self.state_dir, *parts)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        return p

    # --- server ------------------------------------------------------------------------------
    @property
    def server_url(self):
        """The dashboard's set_server_url wins over the installer's value once it has been used."""
        v = self.get("server_url") or self._system.get("server_url") or os.environ.get("ST_SERVER_URL") or ""
        return v.rstrip("/")

    @server_url.setter
    def server_url(self, url):
        self.set("server_url", (url or "").rstrip("/"))

    @property
    def device_name_hint(self):
        return self._system.get("device_name") or ""

    # --- identity ----------------------------------------------------------------------------
    @property
    def device_id(self):
        return self.get("device_id", "") or ""

    @property
    def device_token(self):
        return self.get("device_token", "") or ""

    @property
    def is_paired(self):
        return bool(self.get("paired")) and bool(self.device_id)

    def clear_identity(self):
        """Server rejected us (unpaired / auth-error): forget the credentials, keep everything else."""
        self.update({"device_id": None, "device_token": None, "paired": None, "device_name": None})

    @property
    def settings_pin(self):
        return self.get("settings_pin", "") or ""
