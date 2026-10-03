"""Hardware identity and heartbeat telemetry on Windows. Same function names and field spellings as
platform/linux/deviceinfo.py — the server columns do not care which OS filled them.

Sources: the registry (model, OS edition/build, MachineGuid, EDID), one CIM query cached for the
process (BIOS serial — not in the registry), psutil (CPU/RAM/disk/uptime), `netsh wlan` (SSID/signal).
Everything is best-effort: a missing value is None, never an exception.
"""

import base64
import functools
import hashlib
import os
import re
import socket
import subprocess
import time
import winreg

import psutil

from .privileged import CREATE_NO_WINDOW, powershell


def _reg(path, name, hive=winreg.HKEY_LOCAL_MACHINE):
    try:
        with winreg.OpenKey(hive, path) as k:
            return winreg.QueryValueEx(k, name)[0]
    except OSError:
        return None


@functools.lru_cache(maxsize=1)
def model():
    bios = r"HARDWARE\DESCRIPTION\System\BIOS"
    m = (_reg(bios, "SystemProductName") or "").strip()
    v = (_reg(bios, "SystemManufacturer") or "").strip()
    if m and v and not m.lower().startswith(v.lower().split()[0]):
        return "%s %s" % (v, m)
    return m or v or "Windows PC"


def is_raspberry_pi():
    return False


@functools.lru_cache(maxsize=1)
def serial():
    s = powershell("(Get-CimInstance Win32_BIOS).SerialNumber")
    # OEM placeholders are not identities; fall back to the install's MachineGuid.
    if s and s.lower() not in ("default string", "to be filled by o.e.m.", "system serial number", "0", "none"):
        return s
    return machine_guid()


def machine_guid():
    return (_reg(r"SOFTWARE\Microsoft\Cryptography", "MachineGuid") or "").strip()


def _build():
    try:
        return int(_reg(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "CurrentBuildNumber") or 0)
    except ValueError:
        return 0


@functools.lru_cache(maxsize=1)
def os_short():
    """'11 Pro 25H2'. ⚠️ ProductName still says "Windows 10" on Windows 11 (Microsoft never changed the
    key); the build number is the truth: 22000 and later is 11."""
    name = _reg(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "ProductName") or "Windows"
    if _build() >= 22000:
        name = name.replace("Windows 10", "Windows 11")
    disp = _reg(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "DisplayVersion") or ""
    return (name.replace("Windows ", "", 1) + (" " + disp if disp else "")).strip()


def os_pretty():
    return "Windows %s (build %d)" % (os_short(), _build())


def platform_string():
    """⚠️ Must start with 'Windows/' — the server's platformFamily() keys the windows family on it (and
    on client_type 'win'). Otherwise a non-empty field lands the panel in the android family."""
    return "Windows/%s (%s)" % (os_short(), model())


def fingerprint():
    parts = [serial(), model(), machine_guid()]
    inst = os.environ.get("ST_INSTANCE", "")
    if inst:
        parts.append("instance=" + inst)
    return hashlib.sha256("|".join(parts).encode()).hexdigest()


# --- displays --------------------------------------------------------------------------------

def primary_edid_b64():
    """The first active monitor's EDID from the registry (Enum\\DISPLAY\\<id>\\<inst>\\Device Parameters)."""
    base = r"SYSTEM\CurrentControlSet\Enum\DISPLAY"
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, base) as k:
            for i in range(winreg.QueryInfoKey(k)[0]):
                mon = winreg.EnumKey(k, i)
                with winreg.OpenKey(k, mon) as mk:
                    for j in range(winreg.QueryInfoKey(mk)[0]):
                        inst = winreg.EnumKey(mk, j)
                        edid = _reg(base + "\\" + mon + "\\" + inst + r"\Device Parameters", "EDID")
                        if edid:
                            return base64.b64encode(bytes(edid)).decode()
    except OSError:
        pass
    return None


def connectors():
    return []


# --- telemetry -------------------------------------------------------------------------------

def cpu_usage():
    try:
        return round(psutil.cpu_percent(interval=None), 1)
    except Exception:
        return None


def meminfo_mb():
    try:
        v = psutil.virtual_memory()
        return v.available // (1024 * 1024), v.total // (1024 * 1024)
    except Exception:
        return None, None


def storage_mb(path):
    try:
        u = psutil.disk_usage(os.path.splitdrive(os.path.abspath(path))[0] + "\\")
        return u.free // (1024 * 1024), u.total // (1024 * 1024)
    except Exception:
        return None, None


def temperature_c():
    # Windows exposes no unprivileged, reliable CPU temperature (MSAcpi_ThermalZoneTemperature needs
    # admin and is absent on most desktops). null hides the card rather than showing a wrong number.
    return None


def boot_time_s():
    try:
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
    """(ssid, rssi_dbm). netsh reports signal as a PERCENT; dBm ≈ pct/2 - 100 (Microsoft's own mapping).
    Cached 60 s — netsh is slow, and the heartbeat asks every 15 s."""
    global _wifi_cache
    if time.monotonic() - _wifi_cache[0] < 60:
        return _wifi_cache[1]
    ssid = rssi = None
    try:
        out = subprocess.run(["netsh", "wlan", "show", "interfaces"], capture_output=True, timeout=5,
                             creationflags=CREATE_NO_WINDOW).stdout.decode(errors="replace")
        if re.search(r"^\s*State\s*:\s*connected", out, re.M | re.I):
            m = re.search(r"^\s*SSID\s*:\s*(.+)$", out, re.M)
            ssid = m.group(1).strip() if m else None
            m = re.search(r"^\s*Signal\s*:\s*(\d+)%", out, re.M)
            rssi = int(int(m.group(1)) / 2 - 100) if m else None
    except (OSError, subprocess.SubprocessError):
        pass
    _wifi_cache = (time.monotonic(), (ssid, rssi))
    return ssid, rssi


def timezone_name():
    """IANA name (the server's schedules speak IANA; Windows' own ids like 'Eastern Standard Time' do not)."""
    try:
        from tzlocal import get_localzone_name
        return get_localzone_name() or "UTC"
    except Exception:
        return "UTC"


def telemetry(state_dir):
    ram_free, ram_total = meminfo_mb()
    sto_free, sto_total = storage_mb(state_dir)
    ip4, ip6 = local_ips()
    ssid, rssi = wifi()
    batt = None
    try:
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
