"""#833: supply the video shaders Qt 6.8.1/6.8.2 needs on OpenGL ES 2.0 GPUs but Debian leaves out.

On a GPU that cannot make single-channel RED textures (OpenGL ES 2.0: the Raspberry Pi 3's VC4),
Qt Multimedia 6.8.1 and 6.8.2 upload each video plane as an ALPHA texture and draw it with an
"alpha" variant of the fragment shader (yuv_triplanar_a.frag.qsb and friends). Qt bakes those into
the library only when Qt itself is built for OpenGL ES 2.0, and Debian's arm64 Qt is built for
desktop OpenGL. So on a Pi 3 the decoder works and Qt has nothing to draw the frame with:
"Failed to find shader ...yuv_triplanar_a.frag.qsb" and a white screen. A Pi 4 never asks for them.

Qt looks the shader up by resource path, and resource trees registered later are merged with the
library's, so registering our own .rcc that holds exactly those files under the same prefix fills
the gap. qt68_gles2_shaders/ has Qt's unmodified sources (v6.8.2, LGPL-3.0-only) and build.sh.

Only when it can help and cannot hurt: the running Qt is 6.8.1 or 6.8.2 (6.8.3 replaced the alpha
shaders with a uniform; 6.8.0 used a different uniform buffer, which these would not match) and
Qt's own resources do not already have the shader (a Qt built for GLES 2 does).
"""

import logging
import os

log = logging.getLogger("video-shaders")

HERE = os.path.dirname(os.path.abspath(__file__))
RCC = os.path.join(HERE, "qt68_gles2_shaders", "qt68_gles2_video_shaders.rcc")
PREFIX = "/qt-project.org/multimedia/shaders"
PROBE = ":" + PREFIX + "/yuv_triplanar_a.frag.qsb"
AFFECTED_QT = ("6.8.1", "6.8.2")


def needed(qt_version, has_probe):
    """Whether to register: the affected Qt, and its own resources lack the alpha shaders."""
    return qt_version in AFFECTED_QT and not has_probe


def install(qt_version=None, exists=None, register=None, rcc=RCC):
    """Register the alpha shaders if this Qt needs them. Returns what happened, for the log:
    'not-affected' | 'present' | 'registered' | 'missing-file' | 'failed'. Never raises."""
    try:
        if qt_version is None or exists is None or register is None:
            # Load Qt Multimedia first: its resources register when the library loads, and the
            # probe must see them, or a Qt that has the shaders would get ours on top.
            import PySide6.QtMultimedia  # noqa: F401
            from PySide6.QtCore import QFile, QResource, qVersion
            qt_version = qt_version or qVersion()
            exists = exists or QFile.exists
            register = register or (lambda path, root: QResource.registerResource(path, root))
        if qt_version not in AFFECTED_QT:
            return "not-affected"
        if exists(PROBE):
            return "present"
        if not os.path.isfile(rcc):
            log.warning("Qt %s lacks the OpenGL ES 2 video shaders and %s is missing: video may not draw", qt_version, rcc)
            return "missing-file"
        if not register(rcc, PREFIX):
            log.warning("could not register %s: video may not draw on an OpenGL ES 2 GPU", rcc)
            return "failed"
        log.info("Qt %s lacks the OpenGL ES 2 video shaders; registered our copy (#833)", qt_version)
        return "registered"
    except Exception as e:  # a missing module or an odd Qt must never stop the player starting
        log.warning("video shader check failed: %s", e)
        return "failed"
