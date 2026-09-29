"""The ONE door to root.

The player runs as an ordinary user (it owns the display and the audio session, and a remote shell
must not be root by default). The handful of things that need root — reboot, poweroff, the clock,
the timezone, installing an update, the backlight — go through /usr/lib/screentinker-pi/st-helper,
a root-owned script that accepts a FIXED verb list and validates every argument itself. The
installer grants exactly that path in /etc/sudoers.d/screentinker-pi.

⚠️ Never widen this into "run this command as root". The helper is the security boundary: a
dashboard compromise can reach `shell`, which runs as the player user, but it must not be able to
turn that into root through the helper. That is why arguments are passed as argv (no shell), why the
helper re-validates them, and why there is no generic verb.
"""

import asyncio
import os
import shutil

HELPER = os.environ.get("ST_HELPER", "/usr/lib/screentinker-pi/st-helper")


def available():
    return os.path.exists(HELPER) and (os.geteuid() == 0 or shutil.which("sudo") is not None)


async def run(verb, *args, timeout=120):
    """Run a helper verb. Returns (ok, output). Never raises."""
    if not os.path.exists(HELPER):
        return False, "privileged helper not installed (%s)" % HELPER
    argv = [HELPER, verb, *[str(a) for a in args]]
    if os.geteuid() != 0:
        argv = ["sudo", "-n", *argv]
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        text = out.decode(errors="replace").strip()
        return proc.returncode == 0, text
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except Exception:
            pass
        return False, "helper timed out"
    except OSError as e:
        return False, str(e)


async def run_cmd(argv, timeout=10):
    """Unprivileged command, argv form. Returns (returncode, stdout+stderr). Never raises."""
    if not shutil.which(argv[0]):
        return 127, "%s: not found" % argv[0]
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return proc.returncode, out.decode(errors="replace").strip()
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except Exception:
            pass
        return 124, "timed out"
    except OSError as e:
        return 126, str(e)
