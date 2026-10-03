"""System brightness (set_system_brightness, 0..1) — Android's Settings.System.SCREEN_BRIGHTNESS.

Two real controls exist on a Pi:
  * a sysfs backlight (the DSI touch display, some HATs) — through the helper, since the node is root-owned;
  * DDC/CI over HDMI (`ddcutil setvcp 10`) — most desktop monitors, few TVs. Needs /dev/i2c-* access
    (the installer adds the user to the i2c group and loads i2c-dev).
Per-window brightness (set_brightness) is NOT here: that is the player's own dim layer, in the UI.

Detection is cached: ddcutil probes the bus and takes seconds, far too slow for every register.
"""

import os
import re
import shutil

from . import privileged
from .display import backlights

_ddc_cache = None


async def ddc_available():
    global _ddc_cache
    if _ddc_cache is None:
        if not shutil.which("ddcutil"):
            _ddc_cache = False
        else:
            rc, out = await privileged.run_cmd(["ddcutil", "detect", "--brief"], timeout=20)
            _ddc_cache = rc == 0 and "Display " in (out or "")
    return _ddc_cache


async def supported():
    return bool(backlights()) or await ddc_available()


async def set_level(level):
    level = max(0.0, min(1.0, float(level)))
    done = []
    for bl in backlights():
        try:
            with open("/sys/class/backlight/%s/max_brightness" % bl) as f:
                mx = int(f.read().strip())
        except (OSError, ValueError):
            continue
        ok, _ = await privileged.run("set-backlight", bl, max(1, round(level * mx)) if level > 0 else 0)
        if ok:
            done.append("bl:" + bl)
    if await ddc_available():
        rc, _ = await privileged.run_cmd(["ddcutil", "setvcp", "10", str(round(level * 100))], timeout=20)
        if rc == 0:
            done.append("ddc")
    return done


async def get_level():
    for bl in backlights():
        try:
            with open("/sys/class/backlight/%s/brightness" % bl) as f:
                cur = int(f.read().strip())
            with open("/sys/class/backlight/%s/max_brightness" % bl) as f:
                mx = int(f.read().strip())
            if mx > 0:
                return round(cur / mx, 2)
        except (OSError, ValueError):
            continue
    if await ddc_available():
        rc, out = await privileged.run_cmd(["ddcutil", "getvcp", "10", "--brief"], timeout=20)
        m = re.search(r"VCP 10 C (\d+) (\d+)", out or "")
        if rc == 0 and m and int(m.group(2)) > 0:
            return round(int(m.group(1)) / int(m.group(2)), 2)
    return None
