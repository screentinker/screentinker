"""Screen on/off and keep-awake on macOS, layered like the other backends, most-real first.

  1. `pmset displaysleepnow` sleeps every display (no root needed); `caffeinate -u` declares user
     activity, which is what wakes them again. A TV on HDMI usually follows the Mac's display sleep into
     standby; some only blank.
  2. ALWAYS the player's own black overlay (done by the app), so a panel that ignored (1) still shows
     black rather than content.

keep_awake() is a `caffeinate -dimsu -w <our pid>` child: without it macOS would blank a signage screen
after its display-sleep timeout and eventually sleep the Mac, which on signage is always "idle". `-w`
ties the assertion to this process, so it ends when the player does — no stale assertion survives a
crash. One child for the life of the process; a second call is a no-op while the first is alive.
"""

import asyncio
import os
import shutil
import subprocess

from .privileged import run_cmd

_caffeinate = None


def session_type():
    return "macos"


async def set_power(on):
    notes = []
    if on:
        rc, _ = await run_cmd(["caffeinate", "-u", "-t", "2"])
        notes.append("caffeinate-u:%s" % ("ok" if rc == 0 else rc))
    else:
        rc, _ = await run_cmd(["pmset", "displaysleepnow"])
        notes.append("pmset:%s" % ("ok" if rc == 0 else rc))
    notes.append("overlay")
    return ",".join(notes)


def caffeinate_argv(pid=None):
    """-d display, -i idle system sleep, -m disk, -s system sleep on AC, -u user activity (wakes it now)."""
    return ["caffeinate", "-dimsu", "-w", str(pid or os.getpid())]


async def keep_awake():
    global _caffeinate
    if _caffeinate is not None and _caffeinate.poll() is None:
        return
    if not shutil.which("caffeinate"):
        return
    try:
        _caffeinate = subprocess.Popen(caffeinate_argv(), stdin=subprocess.DEVNULL,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        _caffeinate = None
