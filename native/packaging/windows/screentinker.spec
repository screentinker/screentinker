# PyInstaller spec — builds BOTH executables into one folder (shared runtime, one copy of Qt):
#   dist/ScreenTinker/ScreenTinker.exe          the player (windowed)
#   dist/ScreenTinker/screentinker-helper.exe   the SYSTEM service + watchdog (console-less)
# Run from native/packaging/windows via build.ps1, which stamps the version first.
import os

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules

HERE = os.path.abspath(SPECPATH)
NATIVE = os.path.abspath(os.path.join(HERE, "..", ".."))
REPO = os.path.abspath(os.path.join(NATIVE, ".."))
PKG = os.path.join(NATIVE, "screentinker_native")

import PySide6
PYSIDE = os.path.dirname(PySide6.__file__)

datas = [
    (os.path.join(PKG, "ui", "qml"), os.path.join("screentinker_native", "ui", "qml")),
    # The transition library travels with the player so a panel never needs the server for it.
    (os.path.join(REPO, "shared", "Transitions", "*.glsl"), os.path.join("screentinker_native", "transitions")),
]
datas += collect_data_files("tzdata")          # Windows has no system tz database for zoneinfo
datas += collect_data_files("tzlocal")
binaries = collect_dynamic_libs("winpty")      # ConPTY / winpty DLLs
# ⚠️ ...and its helper EXECUTABLES, which collect_dynamic_libs does not take: without OpenConsole.exe
# (the pseudoconsole host pywinpty 3 uses) every remote-terminal shell was killed ~5 s after spawn with
# STATUS_CONTROL_C_EXIT — it works from a source checkout, where the .exe sits in site-packages.
import winpty as _winpty
for _exe in ("OpenConsole.exe", "winpty-agent.exe"):
    _p = os.path.join(os.path.dirname(_winpty.__file__), _exe)
    if os.path.exists(_p):
        binaries.append((_p, "winpty"))
qsb = os.path.join(PYSIDE, "qsb.exe")
if os.path.exists(qsb):
    binaries.append((qsb, "PySide6"))          # bakes uploaded (custom) transition shaders at runtime

hidden = (collect_submodules("screentinker_native") + collect_submodules("engineio") +
          collect_submodules("socketio") + ["aiohttp", "pycaw.pycaw", "comtypes.stream", "win32timezone",
                                            "PySide6.QtWebEngineQuick", "PySide6.QtMultimedia"])

player = Analysis([os.path.join(HERE, "player_main.py")], pathex=[NATIVE], binaries=binaries, datas=datas,
                  hiddenimports=hidden, excludes=["PyQt6", "PyQt5", "tkinter"], noarchive=False)
helper = Analysis([os.path.join(HERE, "helper_main.py")], pathex=[NATIVE], binaries=[],
                  datas=collect_data_files("tzlocal"),
                  hiddenimports=["win32timezone", "win32serviceutil", "servicemanager", "win32ts", "win32profile",
                                 "tzlocal.windows_tz"],
                  excludes=["PySide6", "PyQt6", "tkinter"], noarchive=False)

player_pyz = PYZ(player.pure)
helper_pyz = PYZ(helper.pure)

# disable_windowed_traceback: an unhandled exception in a windowed build otherwise opens a MODAL error
# dialog and the process stays alive behind it — the helper's watchdog then never relaunches it, and
# an unattended panel sits on that dialog forever (found in the Win11 VM). main() logs and exits.
player_exe = EXE(player_pyz, player.scripts, [], exclude_binaries=True, name="ScreenTinker",
                 console=False, disable_windowed_traceback=True, icon=os.path.join(HERE, "screentinker.ico") if os.path.exists(os.path.join(HERE, "screentinker.ico")) else None,
                 version=os.path.join(HERE, "version_info.txt") if os.path.exists(os.path.join(HERE, "version_info.txt")) else None)
helper_exe = EXE(helper_pyz, helper.scripts, [], exclude_binaries=True, name="screentinker-helper", console=True)

coll = COLLECT(player_exe, player.binaries, player.datas, helper_exe, helper.binaries, helper.datas,
               name="ScreenTinker")
