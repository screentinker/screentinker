"""Media volume (set_volume 0..1) on macOS: the system output volume through AppleScript's
`set volume output volume` — the same control as the menu-bar slider, so it also covers audio the
player does not render itself (a widget's WebEngine page). 0..100 on the AppleScript side.

ST_TEST_NO_SYSTEM_AUDIO keeps development runs off the host's mixer, exactly as on Linux.
"""

import os
import re

from .privileged import run_cmd


def _host_audio_off():
    return bool(os.environ.get("ST_TEST_NO_SYSTEM_AUDIO"))


def set_script(level):
    return "set volume output volume %d without output muted" % round(max(0.0, min(1.0, float(level))) * 100)


GET_SCRIPT = "output volume of (get volume settings)"


def parse_volume(out):
    m = re.search(r"(\d+)", out or "")
    if not m:
        return None   # "missing value": no output device that has a volume (HDMI on some Macs)
    return round(min(100, int(m.group(1))) / 100.0, 2)


async def set_volume(level):
    if _host_audio_off():
        return None
    rc, _ = await run_cmd(["osascript", "-e", set_script(level)])
    return "osascript" if rc == 0 else None


async def get_volume():
    if _host_audio_off():
        return None
    rc, out = await run_cmd(["osascript", "-e", GET_SCRIPT])
    return parse_volume(out) if rc == 0 else None
