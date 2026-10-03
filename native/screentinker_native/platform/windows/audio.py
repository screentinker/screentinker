"""Media volume (set_volume 0..1) on Windows: the default render endpoint's master volume through Core
Audio (IAudioEndpointVolume, via pycaw) — the same control as the taskbar slider, so it also covers
audio the player does not render itself (a widget's WebEngine page).

COM is apartment-bound, so every call runs on ONE dedicated worker thread that initialised COM once;
calling IAudioEndpointVolume from arbitrary executor threads is how you get RPC_E_WRONG_THREAD.
"""

import asyncio
import concurrent.futures

_pool = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="coreaudio",
                                              initializer=lambda: __import__("comtypes").CoInitialize())


def _endpoint():
    from ctypes import POINTER, cast

    from comtypes import CLSCTX_ALL
    from pycaw.pycaw import AudioUtilities, IAudioEndpointVolume
    dev = AudioUtilities.GetSpeakers()
    ev = getattr(dev, "EndpointVolume", None)          # pycaw >= 2024
    if ev is not None:
        return ev
    iface = dev.Activate(IAudioEndpointVolume._iid_, CLSCTX_ALL, None)
    return cast(iface, POINTER(IAudioEndpointVolume))


def _set(level):
    ev = _endpoint()
    ev.SetMasterVolumeLevelScalar(float(level), None)
    ev.SetMute(0, None)
    return "coreaudio"


def _get():
    return round(float(_endpoint().GetMasterVolumeLevelScalar()), 2)


async def set_volume(level):
    level = max(0.0, min(1.0, float(level)))
    try:
        return await asyncio.get_running_loop().run_in_executor(_pool, _set, level)
    except Exception:
        return None     # no audio endpoint (a headless box): the caller falls back to player output


async def get_volume():
    try:
        return await asyncio.get_running_loop().run_in_executor(_pool, _get)
    except Exception:
        return None
