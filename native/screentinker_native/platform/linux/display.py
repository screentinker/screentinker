"""Screen on/off, the Pi way. There is no single switch, so it is layered, most-real first.

  1. DSI panel backlight (the official touch display): bl_power 4/0 — a genuine power-down.
  2. HDMI-CEC: `cec-ctl` standby / image-view-on — the TV itself turns off. Only if a CEC adapter
     exists and something answers on the bus.
  3. Compositor DPMS: `wlopm` under Wayland (labwc/wayfire), `xset dpms force` under X11. On KMS/eglfs
     (Lite, no compositor) Qt holds DRM master and nothing else may blank the output.
  4. ALWAYS: the player's own black overlay, which also pauses/mutes playback. Every path above can
     silently fail on some monitor (a TV that ignores CEC, a DVI adapter), and a "screen_off" that
     leaves content visible is worse than one that shows black with the backlight on.

Android reports the result as device:event display_on / display_off; so does this.
"""

import glob
import os
import shutil

from . import privileged


def session_type():
    t = (os.environ.get("XDG_SESSION_TYPE") or "").lower()
    if t in ("wayland", "x11"):
        return t
    if os.environ.get("WAYLAND_DISPLAY"):
        return "wayland"
    if os.environ.get("DISPLAY"):
        return "x11"
    return "kms"


def backlights():
    return sorted(os.path.basename(p) for p in glob.glob("/sys/class/backlight/*"))


def has_cec():
    return bool(glob.glob("/dev/cec*")) and shutil.which("cec-ctl") is not None


async def _cec(on):
    dev = sorted(glob.glob("/dev/cec*"))[0]
    # Register as a playback device first — cec-ctl refuses to transmit from an unconfigured adapter.
    await privileged.run_cmd(["cec-ctl", "-d", dev, "--playback", "-S"], timeout=8)
    if on:
        rc, out = await privileged.run_cmd(["cec-ctl", "-d", dev, "--to", "0", "--image-view-on"], timeout=8)
        await privileged.run_cmd(["cec-ctl", "-d", dev, "--to", "0", "--active-source", "phys-addr=1.0.0.0"], timeout=8)
    else:
        rc, out = await privileged.run_cmd(["cec-ctl", "-d", dev, "--to", "0", "--standby"], timeout=8)
    return rc == 0, "cec:" + ("ok" if rc == 0 else out[-120:])


async def set_power(on):
    """Apply every hardware layer that exists. Returns a short detail string for device:event.
    The overlay (layer 4) is the caller's job — it lives in the UI thread."""
    notes = []
    for bl in backlights():
        ok, out = await privileged.run("set-bl-power", bl, 0 if on else 4)
        notes.append("bl:%s:%s" % (bl, "ok" if ok else "fail"))
    if has_cec():
        ok, detail = await _cec(on)
        notes.append(detail)
    st = session_type()
    if st == "wayland" and shutil.which("wlopm"):
        rc, _ = await privileged.run_cmd(["wlopm", "--on" if on else "--off", "*"])
        notes.append("wlopm:%s" % ("ok" if rc == 0 else rc))
    elif st == "x11" and shutil.which("xset"):
        rc, _ = await privileged.run_cmd(["xset", "dpms", "force", "on" if on else "off"])
        if on:
            await privileged.run_cmd(["xset", "s", "reset"])
        notes.append("xset:%s" % ("ok" if rc == 0 else rc))
    notes.append("overlay")
    return ",".join(notes)


async def keep_awake():
    """Called at startup and on screen_on: stop the compositor/X from blanking a signage screen."""
    st = session_type()
    if st == "x11" and shutil.which("xset"):
        await privileged.run_cmd(["xset", "s", "off"])
        await privileged.run_cmd(["xset", "-dpms"])
        await privileged.run_cmd(["xset", "s", "noblank"])
    elif st == "wayland" and shutil.which("wlopm"):
        await privileged.run_cmd(["wlopm", "--on", "*"])
