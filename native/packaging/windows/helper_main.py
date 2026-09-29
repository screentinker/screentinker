"""PyInstaller entry point: screentinker-helper.exe (the SYSTEM service + watchdog)."""
from screentinker_native.winhelper.service import main

if __name__ == "__main__":
    main()
