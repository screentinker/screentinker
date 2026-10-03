"""DDC/CI monitor control through Windows' own dxva2.dll (Monitor Configuration API) — no driver, no
third-party tool. Talks to the monitor over the video cable: VCP 0x10 = brightness, 0xD6 = power mode
(1 on, 4 off/standby, 5 off hard). Many TVs ignore DDC/CI entirely, and some monitors have it off in
their OSD; every call is best-effort and reports what it actually managed.
"""

import ctypes
from ctypes import wintypes

VCP_BRIGHTNESS = 0x10
VCP_POWER_MODE = 0xD6

_user32 = ctypes.windll.user32
_dxva2 = ctypes.windll.dxva2


class PHYSICAL_MONITOR(ctypes.Structure):
    _fields_ = [("hPhysicalMonitor", wintypes.HANDLE), ("szPhysicalMonitorDescription", wintypes.WCHAR * 128)]


_MonitorEnumProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HMONITOR, wintypes.HDC,
                                      ctypes.POINTER(wintypes.RECT), wintypes.LPARAM)


def _hmonitors():
    out = []

    def cb(hmon, hdc, rect, lparam):
        out.append(hmon)
        return True
    _user32.EnumDisplayMonitors(None, None, _MonitorEnumProc(cb), 0)
    return out


def physical_monitors():
    """[(handle, description)] for every monitor. Caller must close() them."""
    mons = []
    for hmon in _hmonitors():
        n = wintypes.DWORD()
        if not _dxva2.GetNumberOfPhysicalMonitorsFromHMONITOR(hmon, ctypes.byref(n)) or not n.value:
            continue
        arr = (PHYSICAL_MONITOR * n.value)()
        if _dxva2.GetPhysicalMonitorsFromHMONITOR(hmon, n.value, arr):
            mons += [(arr[i].hPhysicalMonitor, arr[i].szPhysicalMonitorDescription) for i in range(n.value)]
    return mons


def close(mons):
    for h, _ in mons:
        try:
            _dxva2.DestroyPhysicalMonitor(h)
        except OSError:
            pass


def get_vcp(handle, code):
    cur, mx = wintypes.DWORD(), wintypes.DWORD()
    ok = _dxva2.GetVCPFeatureAndVCPFeatureReply(handle, ctypes.c_byte(code), None, ctypes.byref(cur), ctypes.byref(mx))
    return (cur.value, mx.value) if ok else None


def set_vcp(handle, code, value):
    return bool(_dxva2.SetVCPFeature(handle, ctypes.c_byte(code), wintypes.DWORD(int(value))))


def set_all(code, value_fn):
    """Apply to every monitor that answers; returns how many accepted it."""
    mons = physical_monitors()
    n = 0
    try:
        for h, _ in mons:
            cur = get_vcp(h, code)
            v = value_fn(cur)
            if v is not None and set_vcp(h, code, v):
                n += 1
    finally:
        close(mons)
    return n


def read_first(code):
    mons = physical_monitors()
    try:
        for h, _ in mons:
            r = get_vcp(h, code)
            if r:
                return r
    finally:
        close(mons)
    return None
