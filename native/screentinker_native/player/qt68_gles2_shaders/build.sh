#!/usr/bin/env bash
# Rebuild qt68_gles2_video_shaders.rcc from the Qt Multimedia shader sources in this directory (#833).
#
# WHY THIS EXISTS. Qt Multimedia 6.8.1 and 6.8.2 draw video through "alpha" fragment shaders
# (y_a, nv12_a, yuv_triplanar_a, ...) whenever the GPU cannot make single-channel RED textures, which
# is every OpenGL ES 2.0 GPU, the Raspberry Pi 3's VC4 among them. Qt compiles those shaders into the
# library only when Qt itself is built for OpenGL ES 2.0. Debian's arm64 Qt (Raspberry Pi OS trixie,
# 6.8.2) is built for desktop OpenGL, so they are missing: the video decodes and nothing is drawn
# ("Failed to find shader .../yuv_triplanar_a.frag.qsb", a white screen). Qt 6.8.3 replaced the
# alpha shaders with a uniform, so only 6.8.1 and 6.8.2 are affected (6.8.0 had a different
# uniform buffer and is not covered).
#
# The sources are Qt's own, unmodified, from the v6.8.2 tag of qtmultimedia
# (src/multimedia/shaders), under Qt's licence (LGPL-3.0-only for us). They MUST be baked by the
# qsb of the same Qt minor version: the .qsb format and the uniform buffer layout both track Qt.
#
# Usage: QSB=/path/to/qsb-6.8.x RCC=/path/to/rcc-6.8.x ./build.sh
#   e.g. a throwaway venv with PySide6-Essentials==6.8.2.1 and PySide6-Addons==6.8.2.1 gives
#   pyside6-qsb and pyside6-rcc. The flags match Qt's own build (qt_internal_add_shaders defaults:
#   batchable, optimised, GLSL 100 es/120/150, HLSL 50, MSL 12; the _linear set adds the define).
set -euo pipefail
cd "$(dirname "$0")"
QSB=${QSB:-qsb}
RCC=${RCC:-rcc}
"$QSB" --version | grep -q ' 6\.8\.' || { echo "need qsb 6.8.x, got: $("$QSB" --version)" >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
flags=(-b -O --glsl "100 es,120,150" --hlsl 50 --msl 12)
files=()
for src in *_a.frag; do
  name=${src%.frag}
  "$QSB" "${flags[@]}" -o "$work/$name.frag.qsb" "$src"
  "$QSB" "${flags[@]}" -DQMM_OUTPUTSURFACE_LINEAR -o "$work/${name}_linear.frag.qsb" "$src"
  files+=("$name.frag.qsb" "${name}_linear.frag.qsb")
done
{
  echo '<!DOCTYPE RCC><RCC version="1.0"><qresource>'
  for f in "${files[@]}"; do echo "  <file>$f</file>"; done
  echo '</qresource></RCC>'
} > "$work/shaders.qrc"
(cd "$work" && "$RCC" --binary -o shaders.rcc shaders.qrc)
cp "$work/shaders.rcc" qt68_gles2_video_shaders.rcc
echo "wrote qt68_gles2_video_shaders.rcc (${#files[@]} shaders)"
