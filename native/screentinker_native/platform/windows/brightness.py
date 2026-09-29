"""System brightness (set_system_brightness 0..1) on Windows. Two real controls:
  * DDC/CI VCP 0x10 through dxva2 — external monitors (ddc.py);
  * WMI WmiMonitorBrightnessMethods — built-in panels (laptops, all-in-ones, many signage PCs with an
    eDP panel), which is what the Settings app's own slider drives.
Detection is cached: a DDC round-trip is ~50 ms per monitor, far too slow for every register.
Per-window brightness (set_brightness) is the player's dim layer, not here.
"""

import asyncio

from . import ddc
from .privileged import powershell

_cache = None


def _probe():
    ddc_ok = ddc.read_first(ddc.VCP_BRIGHTNESS) is not None
    wmi_ok = powershell("(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness "
                        "-ErrorAction SilentlyContinue | Measure-Object).Count").strip() not in ("", "0")
    return ddc_ok, wmi_ok


async def _methods():
    global _cache
    if _cache is None:
        _cache = await asyncio.get_running_loop().run_in_executor(None, _probe)
    return _cache


async def supported():
    ddc_ok, wmi_ok = await _methods()
    return ddc_ok or wmi_ok


async def set_level(level):
    level = max(0.0, min(1.0, float(level)))
    ddc_ok, wmi_ok = await _methods()
    loop = asyncio.get_running_loop()
    done = []
    if ddc_ok:
        n = await loop.run_in_executor(None, ddc.set_all, ddc.VCP_BRIGHTNESS,
                                       lambda cur: round(level * (cur[1] if cur and cur[1] else 100)))
        if n:
            done.append("ddc:%d" % n)
    if wmi_ok:
        out = await loop.run_in_executor(None, powershell,
                                         "(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods)"
                                         " | Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{Timeout=0;Brightness=%d}"
                                         " | Out-Null; 'ok'" % round(level * 100))
        if out.endswith("ok"):
            done.append("wmi")
    return done


async def get_level():
    ddc_ok, wmi_ok = await _methods()
    loop = asyncio.get_running_loop()
    if ddc_ok:
        r = await loop.run_in_executor(None, ddc.read_first, ddc.VCP_BRIGHTNESS)
        if r and r[1]:
            return round(r[0] / r[1], 2)
    if wmi_ok:
        out = await loop.run_in_executor(None, powershell,
                                         "(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness).CurrentBrightness")
        try:
            return round(int(out.split()[0]) / 100.0, 2)
        except (ValueError, IndexError):
            pass
    return None
