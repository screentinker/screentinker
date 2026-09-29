"""Hardware identity and heartbeat telemetry, read straight from /proc and /sys.

The Android equivalent is telemetry/DeviceInfo.kt. Field names are the server's columns, so every
key here must stay spelled exactly as deviceSocket.js reads it. Everything is best-effort: a missing
file reads as None, never an exception — a heartbeat must not die because /sys moved.
"""

import base64
import glob
import hashlib
import os
import re
import shutil
import socket
import subprocess
import time


def _read(path, binary=False):
    try:
        with open(path, "rb" if binary else "r") as f:
            return f.read()
    except OSError:
        return None


def _strip_nul(s):
    return s.replace("\x00", "").strip() if s else s


def model():
    """'Raspberry Pi 5 Model B Rev 1.0' on a Pi; DMI product name on anything else."""
    m = _strip_nul(_read("/proc/device-tree/model"))
    if m:
        return m
    for p in ("/sys/class/dmi/id/product_name", "/sys/class/dmi/id/board_name"):
        v = (_read(p) or "").strip()
        if v:
            return v
    return "Linux device"


def is_raspberry_pi():
    return "raspberry pi" in model().lower()


def serial():
    """The SoC serial. Stable across reinstalls, which is what the identity fingerprint needs."""
    s = _strip_nul(_read("/sys/firmware/devicetree/base/serial-number"))
    if s:
        return s.lstrip("0") or s
    cpu = _read("/proc/cpuinfo") or ""
    m = re.search(r"^Serial\s*:\s*([0-9a-fA-F]+)", cpu, re.M)
    if m:
        return m.group(1).lstrip("0") or m.group(1)
    return (_read("/etc/machine-id") or "").strip()


def os_pretty():
    rel = _read("/etc/os-release") or ""
    m = re.search(r'^PRETTY_NAME="?([^"\n]*)"?', rel, re.M)
    return m.group(1) if m else "Linux"


def os_short():
    """'Debian 12' — used in the platform string."""
    rel = _read("/etc/os-release") or ""
    name = re.search(r'^NAME="?([^"\n]*)"?', rel, re.M)
    ver = re.search(r'^VERSION_ID="?([^"\n]*)"?', rel, re.M)
    n = (name.group(1) if name else "Linux").replace(" GNU/Linux", "")
    return (n + " " + ver.group(1)) if ver else n


def platform_string():
    """⚠️ Must start with 'Linux/' — the server's platformFamily() keys the linux family on it (and on
    client_type 'pi'). Anything else and a non-empty field lands this panel in the android family."""
    return "Linux/%s (%s)" % (os_short(), model())


def fingerprint():
    """SHA-256 of the hardware identity. Same role as DeviceInfo.getFingerprint() on Android: lets the
    server recognise the same panel after its state was wiped. Serial + model + machine-id, so two
    Pis never collide (the #device-identity lesson: a hardware-only fingerprint must be UNIQUE)."""
    parts = [serial(), model(), (_read("/etc/machine-id") or "").strip()]
    # ST_INSTANCE separates two players on ONE host (a second HDMI output, or a test rig). Without it
    # both present the same hardware and the server refuses the second: "active on another connection".
    inst = os.environ.get("ST_INSTANCE", "")
    if inst:
        parts.append("instance=" + inst)
    return hashlib.sha256("|".join(parts).encode()).hexdigest()


# --- displays --------------------------------------------------------------------------------

def connectors():
    """DRM connectors: [{'name': 'HDMI-A-1', 'connected': bool, 'modes': [...], 'edid': bytes|None}]"""
    out = []
    for d in sorted(glob.glob("/sys/class/drm/card*-*")):
        status = (_read(os.path.join(d, "status")) or "").strip()
        if not status:
            continue
        name = os.path.basename(d).split("-", 1)[1]
        modes = [m for m in (_read(os.path.join(d, "modes")) or "").split("\n") if m]
        edid = _read(os.path.join(d, "edid"), binary=True) or None
        out.append({"name": name, "connected": status == "connected", "modes": modes, "edid": edid})
    return out


def primary_edid_b64():
    for c in connectors():
        if c["connected"] and c["edid"]:
            return base64.b64encode(c["edid"]).decode()
    return None


# --- telemetry -------------------------------------------------------------------------------

_cpu_prev = None


def cpu_usage():
    """Percent busy since the previous call (first call: since boot). /proc/stat jiffies."""
    global _cpu_prev
    line = (_read("/proc/stat") or "").split("\n", 1)[0]
    f = [int(x) for x in line.split()[1:]] if line.startswith("cpu ") else None
    if not f:
        return None
    idle = f[3] + (f[4] if len(f) > 4 else 0)
    total = sum(f)
    prev = _cpu_prev
    _cpu_prev = (idle, total)
    if prev is None:
        return round(100.0 * (1 - idle / total), 1) if total else None
    di, dt = idle - prev[0], total - prev[1]
    return round(100.0 * (1 - di / dt), 1) if dt > 0 else None


def meminfo_mb():
    info = {}
    for line in (_read("/proc/meminfo") or "").splitlines():
        k, _, v = line.partition(":")
        try:
            info[k] = int(v.strip().split()[0]) // 1024
        except (ValueError, IndexError):
            pass
    return info.get("MemAvailable"), info.get("MemTotal")


def storage_mb(path):
    try:
        u = shutil.disk_usage(path)
        return u.free // (1024 * 1024), u.total // (1024 * 1024)
    except OSError:
        return None, None


def temperature_c():
    v = _read("/sys/class/thermal/thermal_zone0/temp")
    try:
        return round(int(v.strip()) / 1000.0, 1)
    except (ValueError, AttributeError):
        return None


def uptime_seconds():
    v = _read("/proc/uptime")
    try:
        return int(float(v.split()[0]))
    except (ValueError, AttributeError, IndexError):
        return None


def local_ips():
    v4 = v6 = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("192.0.2.1", 9))  # TEST-NET, nothing is sent: just asks the kernel for a route
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


def wifi():
    """(ssid, rssi_dbm) of the first wireless interface, or (None, None) when wired."""
    rssi = None
    iface = None
    for line in (_read("/proc/net/wireless") or "").splitlines()[2:]:
        parts = line.split()
        if len(parts) >= 4:
            iface = parts[0].rstrip(":")
            try:
                rssi = int(float(parts[3].rstrip(".")))
            except ValueError:
                pass
            break
    if not iface:
        return None, None
    ssid = None
    for cmd in (["iwgetid", iface, "-r"], ["nmcli", "-t", "-f", "active,ssid", "dev", "wifi"]):
        if not shutil.which(cmd[0]):
            continue
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=3).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            continue
        if cmd[0] == "nmcli":
            out = next((l.split(":", 1)[1] for l in out.splitlines() if l.startswith("yes:")), "")
        if out:
            ssid = out
            break
    return ssid, rssi


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
    v = (_read("/etc/timezone") or "").strip()
    return v or "UTC"


def telemetry(state_dir):
    ram_free, ram_total = meminfo_mb()
    sto_free, sto_total = storage_mb(state_dir)
    ip4, ip6 = local_ips()
    ssid, rssi = wifi()
    conns = [c for c in connectors() if c["connected"]]
    return {
        # No battery on a Pi. null, not 0 — the dashboard hides the card on null.
        "battery_level": None,
        "battery_charging": None,
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
        "attached_display": conns[0]["name"] if conns else None,
        "video_mode": (conns[0]["modes"][0] if conns and conns[0]["modes"] else None),
        "timezone": timezone_name(),
        "device_utc": int(time.time() * 1000),
    }


def boot_time_s():
    up = uptime_seconds()
    return time.time() - up if up is not None else None
