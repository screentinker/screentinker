"""PyInstaller entry point: ScreenTinker.app/Contents/MacOS/ScreenTinker (the player).

`--st-pty-exec` is checked BEFORE the player is imported: it is the remote terminal's shell starter
(screentinker_native/ptyexec.py), a fresh process that must exec the shell without loading Qt.
"""
import sys

from screentinker_native.ptyexec import dispatch

if __name__ == "__main__":
    _pty = dispatch(sys.argv)
    if _pty is not None:
        sys.exit(_pty)
    from screentinker_native.app import main
    sys.exit(main())
