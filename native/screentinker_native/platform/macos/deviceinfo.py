"""Hardware identity and heartbeat telemetry on macOS. Same function names and field spellings as
platform/linux/deviceinfo.py — the server columns do not care which OS filled them.

Sources: `ioreg` (IOPlatformUUID, serial number, EDID), `sysctl` (model identifier), `sw_vers` (OS),
`system_profiler` once per process for the marketing model name, psutil (CPU/RAM/disk/uptime/battery),
`ipconfig getsummary` for Wi-Fi. Everything is best-effort: a missing value is None, never an exception.

The parsers are separate pure functions so they are tested on Linux against captured output
(tests/test_macos_platform.py) — there is no Mac in CI for the unit tests to run on.
"""

import base64
import functools
import hashlib
import os
import re
import socket
import subprocess
import time


def _run(argv, timeout=10):
    try:
        p = subprocess.run(argv, capture_output=True, timeout=timeout)
        return p.stdout.decode(errors="replace") if p.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


# --- parsers (pure) --------------------------------------------------------------------------

def parse_ioreg_platform(out):
    """`ioreg -rd1 -c IOPlatformExpertDevice` -> {'uuid':…, 'serial':…}. Values are quoted strings."""
    res = {}
    for key, name in (("IOPlatformUUID", "uuid"), ("IOPlatformSerialNumber", "serial")):
        m = re.search(r'"%s"\s*=\s*"([^"]*)"' % key, out or "")
        if m and m.group(1).strip():
            res[name] = m.group(1).strip()
    return res


def parse_edid_hex(out):
    """The first EDID blob in `ioreg -l -w0` output, as bytes. Intel Macs publish IODisplayEDID on
    IODisplayConnect; Apple Silicon publishes "EDID" inside the display's attributes. Both are <hex>."""
    for key in ("IODisplayEDID", "EDID"):
        m = re.search(r'"%s"\s*=\s*<([0-9a-fA-F]+)>' % key, out or "")
        if m and len(m.group(1)) >= 256:          # an EDID base block is 128 bytes
            try:
                return bytes.fromhex(m.group(1))
            except ValueError:
                continue
    return None


def parse_sw_vers(out):
    """`sw_vers` -> ('macOS', '15.1', '24B83')."""
    def field(name):
        m = re.search(r"^%s:\s*(.+)$" % name, out or "", re.M)
        return m.group(1).strip() if m else ""
    return field("ProductName") or "macOS", field("ProductVersion"), field("BuildVersion")


def parse_model_name(out):
    """`system_profiler SPHardwareDataType` -> 'Mac mini'. The marketing name, or ''."""
    m = re.search(r"^\s*Model Name:\s*(.+)$", out or "", re.M)
    return m.group(1).strip() if m else ""


def parse_wifi_summary(out):
    """`ipconfig getsummary en0` -> (ssid, rssi_dbm). macOS 15 redacts the SSID for apps without Location
    permission and prints '<redacted>'; that is reported as None, never as a network called <redacted>."""
    ssid = rssi = None
    m = re.search(r"^\s*SSID\s*:\s*(.+)$", out or "", re.M)
    if m:
        v = m.group(1).strip()
        if v and "redacted" not in v.lower():
            ssid = v
    m = re.search(r"^\s*RSSI\s*:\s*(-?\d+)", out or "", re.M)
    if m:
        rssi = int(m.group(1))
    return ssid, rssi


# --- identity --------------------------------------------------------------------------------

@functools.lru_cache(maxsize=1)
def _platform_ids():
    return parse_ioreg_platform(_run(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"]))


@functools.lru_cache(maxsize=1)
def model():
    """'Mac mini (Mac14,3)'. The identifier alone ('Mac14,3') when the marketing name is unavailable."""
    ident = _run(["sysctl", "-n", "hw.model"]).strip()
    name = parse_model_name(_run(["system_profiler", "SPHardwareDataType"], timeout=20))
    if name and ident:
        return "%s (%s)" % (name, ident)
    return name or ident or "Mac"


def is_raspberry_pi():
    return False


def serial():
    ids = _platform_ids()
    return ids.get("serial") or ids.get("uuid") or ""


def platform_uuid():
    return _platform_ids().get("uuid", "")


@functools.lru_cache(maxsize=1)
def _os():
    return parse_sw_vers(_run(["sw_vers"]))


def os_short():
    name, ver, _build = _os()
    return ("%s %s" % ("" if name == "macOS" else name, ver)).strip() or "macOS"


def os_pretty():
    name, ver, build = _os()
    return "%s %s%s" % (name, ver, " (%s)" % build if build else "")


def platform_string():
    """⚠️ Must start with 'macOS/' — the server's platformFamily() keys the macos family on it (and on
    client_type 'mac'). Otherwise a non-empty field could land the Mac in another family."""
    return "macOS/%s (%s)" % (os_short(), model())


def fingerprint():
    """Serial + model + IOPlatformUUID: unique per Mac (the #device-identity lesson). ST_INSTANCE
    separates two players on one Mac (a second display driven by a second player)."""
    parts = [serial(), model(), platform_uuid()]
    inst = os.environ.get("ST_INSTANCE", "")
    if inst:
        parts.append("instance=" + inst)
    return hashlib.sha256("|".join(parts).encode()).hexdigest()


# --- displays --------------------------------------------------------------------------------

_EDID_TTL_S = 600
_edid_cache = [None, -_EDID_TTL_S - 1.0]     # (value, monotonic time read)


def primary_edid_b64():
    """Re-read at most every 10 minutes: device_info() runs at every register (each minute), and a full
    `ioreg -l` walk is not free. A swapped panel shows up within the TTL."""
    now = time.monotonic()
    if now - _edid_cache[1] < _EDID_TTL_S:
        return _edid_cache[0]
    edid = parse_edid_hex(_run(["ioreg", "-l", "-w0", "-d", "8", "-r", "-c", "IOMobileFramebuffer"], timeout=15)) \
        or parse_edid_hex(_run(["ioreg", "-l", "-w0", "-r", "-c", "IODisplayConnect"], timeout=15))
    _edid_cache[:] = [base64.b64encode(edid).decode() if edid else None, now]
    return _edid_cache[0]


def connectors():
    return []


# --- telemetry -------------------------------------------------------------------------------

def cpu_usage():
    try:
        import psutil
        return round(psutil.cpu_percent(interval=None), 1)
    except Exception:
        return None


def meminfo_mb():
    try:
        import psutil
        v = psutil.virtual_memory()
        return v.available // (1024 * 1024), v.total // (1024 * 1024)
    except Exception:
        return None, None


def storage_mb(path):
    try:
        import psutil
        u = psutil.disk_usage(path if os.path.exists(path) else "/")
        return u.free // (1024 * 1024), u.total // (1024 * 1024)
    except Exception:
        return None, None


def temperature_c():
    # Apple Silicon exposes no unprivileged temperature (powermetrics needs root). null hides the card.
    return None


def boot_time_s():
    try:
        import psutil
        return psutil.boot_time()
    except Exception:
        return None


def uptime_seconds():
    b = boot_time_s()
    return int(time.time() - b) if b else None


def local_ips():
    v4 = v6 = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("192.0.2.1", 9))
        v4 = s.getsockname()[0]
        s.close()
    except OSError:
        pass
    try:
        s = socket.socket(socket.AF_INET6, socket.SOCK_DGRAM)
        s.connect(("2001:db8::1", 9))
        a = s.getsockname()[0]
        s.close()
        if not a.startswith("fe80"):
            v6 = a
    except OSError:
        pass
    return v4, v6


_wifi_cache = (0.0, (None, None))


def wifi():
    """(ssid, rssi_dbm), cached 60 s — the heartbeat asks every 15 s."""
    global _wifi_cache
    if time.monotonic() - _wifi_cache[0] < 60:
        return _wifi_cache[1]
    res = parse_wifi_summary(_run(["ipconfig", "getsummary", "en0"], timeout=5))
    _wifi_cache = (time.monotonic(), res)
    return res


def timezone_name():
    tz = os.environ.get("TZ")
    if tz:
        return tz.lstrip(":")
    try:
        target = os.path.realpath("/etc/localtime")
        if "/zoneinfo/" in target:
            return target.split("/zoneinfo/", 1)[1]
    except OSError:
        pass
    return "UTC"


def telemetry(state_dir):
    ram_free, ram_total = meminfo_mb()
    sto_free, sto_total = storage_mb(state_dir)
    ip4, ip6 = local_ips()
    ssid, rssi = wifi()
    batt = None
    try:
        import psutil
        batt = psutil.sensors_battery()
    except Exception:
        pass
    return {
        "battery_level": round(batt.percent) if batt else None,
        "battery_charging": bool(batt.power_plugged) if batt else None,
        "storage_free_mb": sto_free,
        "storage_total_mb": sto_total,
        "ram_free_mb": ram_free,
        "ram_total_mb": ram_total,
        "cpu_usage": cpu_usage(),
        "wifi_ssid": ssid,
        "wifi_rssi": rssi,
        "local_ip": ip4,
        "local_ip6": ip6,
        "uptime_seconds": uptime_seconds(),
        "temperature_c": temperature_c(),
        "attached_display": None,
        "video_mode": None,
        "timezone": timezone_name(),
        "device_utc": int(time.time() * 1000),
    }
