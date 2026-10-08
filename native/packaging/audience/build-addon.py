#!/usr/bin/env python3
"""Build the OPTIONAL audience-counting add-on for the native players.

    python3 native/packaging/audience/build-addon.py [--platform P ...]     (default: all)

Platforms (server/lib/audience-addon.js PLATFORMS — the Python is part of the name, because the
add-on holds compiled modules that load only into the Python they were built for):
    win-x64-cp312         the Windows player (PyInstaller bundles CPython 3.12, packaging/windows)
    linux-aarch64-cp313   Raspberry Pi OS Trixie, 64-bit (the .deb runs on the system python3)
    linux-x86_64-cp313    Debian 13 / Trixie on a PC

Output: native/dist/screentinker-audience_<ADDON_VERSION>_<platform>.zip — the directory the server's
/download/audience-addon/<platform> looks in (and DATA_DIR, which wins). Cross-builds from any OS:
pip fetches the target's binary wheels (--platform/--only-binary), nothing is compiled.

Contents: numpy and opencv-python-headless (pinned in requirements.txt), the YuNet face model
(pinned by URL AND sha256 below — a changed file fails the build), ADDON.json (what the player checks
before importing anything), and THIRD-PARTY-NOTICES.txt.

Licences, checked: OpenCV Apache-2.0; numpy BSD-3-Clause (bundled OpenBLAS BSD-3-Clause, gfortran
runtime GPL-3.0 WITH the GCC Runtime Library Exception); the FFmpeg inside the opencv wheel is the
project's LGPL build; YuNet MIT. No GPL/AGPL code without that exception.
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
NATIVE = os.path.abspath(os.path.join(HERE, "..", ".."))
DIST = os.path.join(NATIVE, "dist")

PLATFORMS = {
    # name: (pip --platform tags, python version)
    "win-x64-cp312": (["win_amd64"], "3.12"),
    "linux-aarch64-cp313": (["manylinux_2_28_aarch64", "manylinux2014_aarch64"], "3.13"),
    "linux-x86_64-cp313": (["manylinux_2_28_x86_64", "manylinux2014_x86_64"], "3.13"),
}

# opencv_zoo, pinned to a commit; the file is Git LFS, so the media host serves the bytes.
MODEL_NAME = "face_detection_yunet_2023mar.onnx"
MODEL_URL = ("https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/"
             "face_detection_yunet/face_detection_yunet_2023mar.onnx")
MODEL_SHA256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"
MODEL_LICENSE_URL = "https://raw.githubusercontent.com/opencv/opencv_zoo/main/models/face_detection_yunet/LICENSE"


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(url, dest):
    with urllib.request.urlopen(url, timeout=120) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)


def notices(target, version, platform):
    lines = ["ScreenTinker audience-counting add-on %s (%s)" % (version, platform), "",
             "Installed only when the operator chose audience counting. Removing this directory turns",
             "the capability off; the player never downloads it by itself.", "",
             "=" * 78, "Bundled third-party components", "=" * 78, ""]
    for d in sorted(os.listdir(target)):
        if d.endswith(".dist-info"):
            meta = os.path.join(target, d, "METADATA")
            name = ver = lic = ""
            with open(meta, encoding="utf-8", errors="replace") as f:
                for line in f:
                    if line.startswith("Name:"):
                        name = line.split(":", 1)[1].strip()
                    elif line.startswith("Version:"):
                        ver = line.split(":", 1)[1].strip()
                    elif line.startswith(("License-Expression:", "License:")) and not lic:
                        lic = line.split(":", 1)[1].strip()[:80]
                    elif not line.strip():
                        break
            lines.append("%s %s - %s" % (name, ver, lic or "see its dist-info directory"))
    lines += ["YuNet face detection model (%s) - MIT, Copyright (c) 2020 Shiqi Yu" % MODEL_NAME, "",
              "Each package's full licence texts are in its *.dist-info directory (OpenCV's",
              "LICENSE-3RD-PARTY.txt lists every library inside the OpenCV wheel, FFmpeg included);",
              "the model's licence is LICENSE-YUNET.txt."]
    return "\n".join(lines) + "\n"


def build(platform, version, requirements, model, model_license):
    tags, py = PLATFORMS[platform]
    out = os.path.join(DIST, "screentinker-audience_%s_%s.zip" % (version, platform))
    with tempfile.TemporaryDirectory(prefix="st-audience-") as tmp:
        target = os.path.join(tmp, "audience")
        cmd = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-warn-conflicts", "-q", "--no-compile",
               "--target", target, "--only-binary=:all:", "--implementation", "cp", "--python-version", py,
               "-r", requirements]
        for t in tags:
            cmd += ["--platform", t]
        subprocess.run(cmd, check=True)
        shutil.rmtree(os.path.join(target, "bin"), ignore_errors=True)   # console scripts: unused, and wrong-OS
        shutil.copy(model, os.path.join(target, MODEL_NAME))
        shutil.copy(model_license, os.path.join(target, "LICENSE-YUNET.txt"))
        with open(os.path.join(target, "ADDON.json"), "w", encoding="utf-8") as f:
            json.dump({"name": "screentinker-audience", "version": version, "platform": platform,
                       "python": py, "model": MODEL_NAME}, f, indent=1)
        with open(os.path.join(target, "THIRD-PARTY-NOTICES.txt"), "w", encoding="utf-8") as f:
            f.write(notices(target, version, platform))
        os.makedirs(DIST, exist_ok=True)
        tmp_zip = out + ".tmp"
        # Paths inside the zip are relative to the add-on directory: the installers extract into it.
        with zipfile.ZipFile(tmp_zip, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
            for root, _dirs, files in os.walk(target):
                for name in sorted(files):
                    p = os.path.join(root, name)
                    z.write(p, os.path.relpath(p, target).replace(os.sep, "/"))
        os.replace(tmp_zip, out)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--platform", action="append", choices=sorted(PLATFORMS))
    ap.add_argument("--version", help="default: native/packaging/audience/ADDON_VERSION")
    args = ap.parse_args()
    version = args.version or open(os.path.join(HERE, "ADDON_VERSION"), encoding="utf-8").read().strip()
    requirements = os.path.join(HERE, "requirements.txt")
    with tempfile.TemporaryDirectory(prefix="st-audience-model-") as tmp:
        model = os.path.join(tmp, MODEL_NAME)
        fetch(MODEL_URL, model)
        got = sha256(model)
        if got != MODEL_SHA256:
            sys.exit("face model sha256 %s != pinned %s — refusing to build" % (got, MODEL_SHA256))
        lic = os.path.join(tmp, "LICENSE")
        fetch(MODEL_LICENSE_URL, lic)
        for p in args.platform or sorted(PLATFORMS):
            out = build(p, version, requirements, model, lic)
            print("%s  %d bytes  sha256 %s" % (out, os.path.getsize(out), sha256(out)))


if __name__ == "__main__":
    main()
