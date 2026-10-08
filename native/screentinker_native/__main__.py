import sys

# Before anything heavy: `--st-pty-exec` is the remote terminal's shell starter (ptyexec.py), not a player.
from .ptyexec import dispatch

_pty = dispatch(sys.argv)
if _pty is not None:
    sys.exit(_pty)

from .app import main  # noqa: E402

sys.exit(main())
