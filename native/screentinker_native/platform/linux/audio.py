"""Media volume (set_volume, 0..1) — Android's STREAM_MUSIC equivalent.

The system mixer is the real control (it is what a person turning the TV's content down expects,
and it covers audio the player does not render itself, e.g. a widget's WebEngine page). PipeWire's
`wpctl` on current Pi OS desktop images, ALSA `amixer` on Lite. When neither works the caller falls
back to scaling the player's own output, so the command is never a silent no-op.
"""

import os
import re
import shutil

from .privileged import run_cmd

_ALSA_CONTROLS = ("Master", "PCM", "Headphone", "HDMI", "Digital")


def _host_audio_off():
    # Development/e2e runs on a workstation: never drive the HOST's mixer (a set_volume test turned a
    # developer's laptop down). The player's own output still follows the level.
    return bool(os.environ.get("ST_TEST_NO_SYSTEM_AUDIO"))


async def set_volume(level):
    level = max(0.0, min(1.0, float(level)))
    if _host_audio_off():
        return None
    if shutil.which("wpctl"):
        rc, _ = await run_cmd(["wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", "%.2f" % level])
        if rc == 0:
            await run_cmd(["wpctl", "set-mute", "@DEFAULT_AUDIO_SINK@", "0"])
            return "wpctl"
    if shutil.which("amixer"):
        for ctl in _ALSA_CONTROLS:
            rc, _ = await run_cmd(["amixer", "-q", "sset", ctl, "%d%%" % round(level * 100), "unmute"])
            if rc == 0:
                return "amixer:" + ctl
    return None


async def get_volume():
    if _host_audio_off():
        return None
    if shutil.which("wpctl"):
        rc, out = await run_cmd(["wpctl", "get-volume", "@DEFAULT_AUDIO_SINK@"])
        m = re.search(r"Volume:\s*([0-9.]+)", out or "")
        if rc == 0 and m:
            return round(min(1.0, float(m.group(1))), 2)
    if shutil.which("amixer"):
        for ctl in _ALSA_CONTROLS:
            rc, out = await run_cmd(["amixer", "sget", ctl])
            m = re.search(r"\[(\d+)%\]", out or "")
            if rc == 0 and m:
                return round(int(m.group(1)) / 100.0, 2)
    return None
