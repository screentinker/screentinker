"""Exec a shell as the session leader of the pseudo-terminal it was started on.

    <player> --st-pty-exec /bin/zsh -l          (frozen app)
    python …/screentinker_native/ptyexec.py /bin/zsh -l      (source checkout)

Linux gives an interactive shell its controlling terminal with `setsid -c` (platform/linux/shell.py).
macOS has no setsid(1), and a shell without a controlling terminal has no job control: ^C never
reaches the foreground job and zsh prints "can't set tty pgrp".

⚠️ This runs as a FRESH process (spawned by Popen, which execs immediately), never as Python code in
a forked child of the player. The player runs Qt and asyncio threads, and Python running after fork()
in a threaded process can deadlock on a lock another thread held — the reason the Linux backend
avoids pty.fork() as well. Here nothing has started yet, so setsid + TIOCSCTTY + exec is safe.

Kept free of every import the player needs: the frozen app dispatches here before Qt loads.
"""

import fcntl
import os
import sys
import termios

FLAG = "--st-pty-exec"


def exec_shell(argv):
    """argv = [shell, *args]. stdin must already be the pty slave. Does not return on success."""
    if not argv:
        sys.stderr.write("ptyexec: no shell given\n")
        return 2
    os.setsid()
    # The pty slave on fd 0 becomes this new session's controlling terminal. Linux would also take
    # one implicitly on open(); BSD/macOS never do, so the ioctl is the portable form.
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)
    os.execvp(argv[0], argv)
    return 127  # unreachable unless execvp itself returned, which it only does by raising


def command(shell_argv, frozen=None, executable=None):
    """The argv that starts `shell_argv` through this wrapper, for this build of the player."""
    frozen = bool(getattr(sys, "frozen", False)) if frozen is None else frozen
    exe = executable or sys.executable
    if frozen:
        return [exe, FLAG, *shell_argv]
    # By file path, not `-m`: the shell starts in the user's home, where the package is not importable,
    # and this file needs nothing but the standard library.
    return [exe, os.path.abspath(__file__), *shell_argv]


def dispatch(argv):
    """For an entry point: if argv asks for the wrapper, become the shell. Returns None otherwise."""
    if len(argv) >= 2 and argv[1] == FLAG:
        return exec_shell(argv[2:])
    return None


if __name__ == "__main__":
    sys.exit(exec_shell(sys.argv[1:]))
