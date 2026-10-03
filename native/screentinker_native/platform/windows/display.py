"""Screen on/off on Windows — layered like Linux (platform/linux/display.py), most-real first:

  1. DDC/CI VCP 0xD6 power mode on every monitor that answers — the monitor itself sleeps.
  2. SC_MONITORPOWER broadcast — the OS asks the display pipeline to power down (DPMS). It is undone by
     ANY input, and some GPUs ignore it on HDMI TVs, which is why it is not the only layer.
  3. ALWAYS the player's black overlay (done by the app), so a panel that ignored both still shows black.

keep_awake() is SetThreadExecutionState: without it Windows' own display timeout would blank a
signage screen after 10 minutes of "no user activity", which on signage is always.
"""

import asyncio
import ctypes

from . import ddc

HWND_BROADCAST = 0xFFFF
WM_SYSCOMMAND = 0x0112
SC_MONITORPOWER = 0xF170
SMTO_ABORTIFHUNG = 0x0002
ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001
ES_DISPLAY_REQUIRED = 0x00000002
MOUSEEVENTF_MOVE = 0x0001

_user32 = ctypes.windll.user32
_kernel32 = ctypes.windll.kernel32


def session_type():
    return "windows"


def _monitor_power(state):
    # -1 on, 2 off. SendMessageTimeout, not SendMessage: one hung top-level window would otherwise
    # hang the broadcast (and this thread) forever.
    res = ctypes.c_ulong()
    _user32.SendMessageTimeoutW(HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER, state,
                                SMTO_ABORTIFHUNG, 2000, ctypes.byref(res))


def _nudge_mouse():
    # SC_MONITORPOWER -1 alone does not wake every GPU/monitor combination; a zero-distance input
    # event is what Windows itself treats as "user present".
    _user32.mouse_event(MOUSEEVENTF_MOVE, 0, 0, 0, 0)


def _set_power_sync(on):
    notes = []
    n = ddc.set_all(ddc.VCP_POWER_MODE, lambda cur: 1 if on else 4)
    notes.append("ddc:%d" % n)
    if on:
        _monitor_power(-1)
        _nudge_mouse()
    else:
        _monitor_power(2)
    notes.append("scmonitorpower")
    notes.append("overlay")
    return ",".join(notes)


async def set_power(on):
    return await asyncio.get_running_loop().run_in_executor(None, _set_power_sync, on)


_awake_set = False


async def keep_awake():
    """Call from a thread that lives as long as the process (the execution state is per-thread and
    ES_CONTINUOUS keeps it until that thread changes it or exits) — the network thread qualifies."""
    global _awake_set
    _kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED)
    _awake_set = True
