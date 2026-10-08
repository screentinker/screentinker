# PyInstaller spec — the macOS player as ScreenTinker.app (one bundle, Qt inside it).
# Run from native/packaging/macos via build.sh, which stamps the version and sets ST_BUNDLE_VERSION.
import os

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

HERE = os.path.abspath(SPECPATH)
NATIVE = os.path.abspath(os.path.join(HERE, "..", ".."))
REPO = os.path.abspath(os.path.join(NATIVE, ".."))
PKG = os.path.join(NATIVE, "screentinker_native")
VERSION = os.environ.get("ST_BUNDLE_VERSION", "0.0.0")
NUMERIC = VERSION.split("~")[0]

import PySide6
PYSIDE = os.path.dirname(PySide6.__file__)

datas = [
    (os.path.join(PKG, "ui", "qml"), os.path.join("screentinker_native", "ui", "qml")),
    # The transition library travels with the player so a panel never needs the server for it.
    (os.path.join(REPO, "shared", "Transitions", "*.glsl"), os.path.join("screentinker_native", "transitions")),
]
datas += collect_data_files("tzlocal")
binaries = []
for cand in (os.path.join(PYSIDE, "qsb"), os.path.join(PYSIDE, "Qt", "libexec", "qsb")):
    if os.path.exists(cand):
        binaries.append((cand, "PySide6"))      # bakes uploaded (custom) transition shaders at runtime
        break

hidden = (collect_submodules("screentinker_native") + collect_submodules("engineio") +
          collect_submodules("socketio") + ["aiohttp", "PySide6.QtWebEngineQuick", "PySide6.QtMultimedia",
                                            "PySide6.QtNetwork"])

a = Analysis([os.path.join(HERE, "player_main.py")], pathex=[NATIVE], binaries=binaries, datas=datas,
             hiddenimports=hidden, excludes=["PyQt6", "PyQt5", "tkinter"], noarchive=False)
pyz = PYZ(a.pure)
# target_arch None = the architecture of the Python running the build (arm64 on Apple Silicon). A
# universal2 build needs a universal2 Python AND universal2 wheels for every dependency; build.sh
# takes ST_TARGET_ARCH=universal2 for whoever has both.
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="ScreenTinker", console=False,
          disable_windowed_traceback=True, target_arch=os.environ.get("ST_TARGET_ARCH") or None,
          codesign_identity=None, entitlements_file=None)
coll = COLLECT(exe, a.binaries, a.datas, name="ScreenTinker")
app = BUNDLE(coll, name="ScreenTinker.app", bundle_identifier="com.screentinker.player",
             icon=os.path.join(HERE, "ScreenTinker.icns") if os.path.exists(os.path.join(HERE, "ScreenTinker.icns")) else None,
             info_plist={
                 "CFBundleName": "ScreenTinker",
                 "CFBundleDisplayName": "ScreenTinker",
                 "CFBundleShortVersionString": NUMERIC,
                 "CFBundleVersion": NUMERIC,
                 "LSMinimumSystemVersion": "12.0",
                 "NSHighResolutionCapable": True,
                 # App Nap throttles timers of an app it judges idle; a sign is always "idle".
                 "NSAppSleepDisabled": True,
                 "LSApplicationCategoryType": "public.app-category.business",
                 "NSMicrophoneUsageDescription": "The ScreenTinker dashboard can open a two-way intercom with this screen.",
                 # macOS 15: reaching a ScreenTinker server or a trigger sender on the LAN needs this prompt.
                 "NSLocalNetworkUsageDescription": "ScreenTinker connects to your signage server and listens for triggers on your local network.",
                 "NSBonjourServices": [],
             })
