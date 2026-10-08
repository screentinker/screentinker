"""The door to root on macOS — closed.

The Pi player reaches root through a fixed-verb helper granted in sudoers (platform/linux/privileged.py)
and the Windows player through the ScreenTinkerHelper service. The macOS player ships NEITHER: it runs
as the signed-in user from a LaunchAgent, and the .app is not allowed to install anything that runs as
root. So reboot, shutdown, the clock, the timezone and package installs are not offered — the player
declares none of those capabilities (ops.extra_capabilities), and the dashboard does not show their
buttons. docs/macos-player.md says how to manage a Mac fleet's power and updates with MDM instead.

run() exists so the shared contract holds; it always refuses. run_cmd() is the same unprivileged argv
runner as Linux.
"""

import asyncio
import shutil


def available():
    return False


async def run(verb, *args, timeout=120):
    """Returns (ok, output). Never raises. Always (False, ...) on macOS."""
    return False, "not available on macOS (%s): the player has no privileged helper" % verb


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
