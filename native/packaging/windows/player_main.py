"""PyInstaller entry point: ScreenTinker.exe (the player)."""
import sys

from screentinker_native.app import main

if __name__ == "__main__":
    sys.exit(main())
