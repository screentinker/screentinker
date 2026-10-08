"""Which display the kiosk window goes on (`--display N` or ST_DISPLAY=N; 0 = the first screen Qt lists).

A Mac mini or a signage PC often drives two outputs, and full screen on "the primary" is whichever one
the OS currently calls primary — which a monitor being power-cycled can change. An index that does not
exist falls back to the primary screen rather than failing to start: a sign that shows content on the
wrong output is recoverable remotely, one that never starts is not.
"""

import os


def wanted_index(arg=None, env=None):
    raw = arg if arg is not None else (env if env is not None else os.environ.get("ST_DISPLAY"))
    if raw is None or str(raw).strip() == "":
        return None
    try:
        n = int(str(raw).strip())
    except ValueError:
        return None
    return n if n >= 0 else None


def pick(screens, primary, index):
    """screens: Qt's list; returns the screen to use (primary when index is None or out of range)."""
    if index is not None and 0 <= index < len(screens):
        return screens[index]
    return primary
