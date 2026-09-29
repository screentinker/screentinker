"""GL Transitions on Qt 6: turn the shared shader library into .qsb files QML can run.

The library (shared/Transitions/*.glsl) is GLSL ES 1.0 written against a tiny preamble
(getFromColor/getToColor, progress, ratio, `uniform float x; // = default [min..max]`). Web, Tizen and
Android run it unmodified. Qt 6's ShaderEffect cannot take GLSL at all — only a .qsb baked by `qsb`
(package qt6-shader-baker) — so each shader is WRAPPED into a Vulkan-style GLSL 440 fragment shader:

  * the shader's own `uniform float NAME;` lines move into the std140 block as generic p0..p7, with a
    `#define NAME pN` so the body compiles untouched. QML then drives p0..p7 by position, which is what
    lets one ShaderEffect run any shader without per-shader QML properties;
  * texture2D -> texture, and main() calls transition(uv) with uv flipped to GL's bottom-left origin:
    the library's shaders are written in that convention (vUv = aPos*0.5+0.5 on the other players), so
    a top-left uv would run every directional wipe upside down relative to web and Android;
  * uploaded shaders (custom_shaders on the payload) go through the same wrapper, checked BEFORE the
    bundled library, never instead of it (Android TransitionCompositor.loadSource).

Baking is cached by source hash under <state>/shaders, so it happens once per shader per device. Any
failure returns None and the runner falls back to a crossfade — never a black frame (the server's
"unknown shader -> no transition" contract).

A transition may carry several effects; one is picked at random per advance (Android parity).
"""

import hashlib
import logging
import os
import pathlib
import random
import re
import shutil
import subprocess

log = logging.getLogger("transitions")

MAX_PARAMS = 8
MIN_MS, MAX_MS, DEFAULT_MS = 150, 3000, 800
_PARAM_RE = re.compile(r"^\s*uniform\s+float\s+(\w+)\s*;.*$", re.M)
# Legal identifiers in GLSL ES 1.0 (what the library is written in) that GLSL 4.40 — the dialect qsb
# compiles — reserves. ReelChange and PixelSort both use `active`; without this rename they fail to
# bake on every Qt 6 player and silently degrade to a crossfade.
_GLSL440_RESERVED = ("active", "input", "output", "sample", "filter", "common", "partition", "superp",
                     "resource", "subroutine", "patch", "buffer", "shared", "coherent", "volatile",
                     "restrict", "readonly", "writeonly", "precise", "centroid", "smooth",
                     "noperspective", "layout", "uint", "atomic_uint", "flat", "varying", "attribute")
_RESERVED_RE = re.compile(r"\b(%s)\b" % "|".join(_GLSL440_RESERVED))
_QSB_CANDIDATES = ("qsb", "/usr/lib/qt6/bin/qsb", "/usr/lib/aarch64-linux-gnu/qt6/bin/qsb",
                   "/usr/lib/x86_64-linux-gnu/qt6/bin/qsb", "/usr/lib/arm-linux-gnueabihf/qt6/bin/qsb")


def parse(obj):
    """The item's `transition` object -> {'effects': [{'shader','params'}], 'durationMs'} or None."""
    if not isinstance(obj, dict):
        return None
    effects = []
    for e in obj.get("effects") or []:
        if not isinstance(e, dict) or not e.get("shader"):
            continue
        params = {}
        for k, v in (e.get("params") or {}).items():
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                params[str(k)] = float(v)
        effects.append({"shader": str(e["shader"]), "params": params})
    if not effects:
        return None
    try:
        dur = int(obj.get("durationMs", DEFAULT_MS))
    except (TypeError, ValueError):
        dur = DEFAULT_MS
    return {"effects": effects, "durationMs": max(MIN_MS, min(MAX_MS, dur))}


def sig(spec):
    """Structural signature for the playlist fingerprint (Android TransitionSpec.sig)."""
    if not spec:
        return ""
    parts = []
    for e in spec["effects"]:
        ps = ";".join("%s=%s" % (k, _kt_float(v)) for k, v in sorted(e["params"].items()))
        parts.append("%s(%s)" % (e["shader"], ps))
    return ",".join(parts) + "@" + str(spec["durationMs"])


def _kt_float(v):
    # Kotlin prints Float 1 as "1.0"; only used inside our own signature, but keep it stable.
    return repr(float(v))


def find_qsb():
    # PySide6 wheels ship the tool inside the package (Windows bundles it); prefer that one, it is
    # built for exactly the Qt the player runs.
    try:
        import PySide6
        for n in ("qsb.exe", "qsb", os.path.join("Qt", "libexec", "qsb")):
            p = os.path.join(os.path.dirname(PySide6.__file__), n)
            if os.path.isfile(p) and os.access(p, os.X_OK):
                return p
    except ImportError:
        pass
    for c in _QSB_CANDIDATES:
        p = shutil.which(c) if "/" not in c else (c if os.access(c, os.X_OK) else None)
        if p:
            return p
    return None


def wrap(src):
    """GL Transitions GLSL ES 1.0 -> (Qt GLSL 440 source, [param names in pN order])."""
    names = []
    for m in _PARAM_RE.finditer(src):
        if m.group(1) not in names:
            names.append(m.group(1))
    names = names[:MAX_PARAMS]
    body = _PARAM_RE.sub("", src)
    body = re.sub(r"\btexture2D\b", "texture", body)
    body = _RESERVED_RE.sub(lambda m: "st_" + m.group(1), body)
    defines = "\n".join("#define %s p%d" % (_RESERVED_RE.sub(lambda m: "st_" + m.group(1), n), i)
                         for i, n in enumerate(names))
    block = "\n".join("    float p%d;" % i for i in range(MAX_PARAMS))
    out = """#version 440
layout(location = 0) in vec2 qt_TexCoord0;
layout(location = 0) out vec4 fragColor;
layout(std140, binding = 0) uniform buf {
    mat4 qt_Matrix;
    float qt_Opacity;
    float progress;
    float ratio;
%s
};
layout(binding = 1) uniform sampler2D uFrom;
layout(binding = 2) uniform sampler2D uTo;
%s
vec4 getFromColor(vec2 uv) { return texture(uFrom, vec2(uv.x, 1.0 - uv.y)); }
vec4 getToColor(vec2 uv) { return texture(uTo, vec2(uv.x, 1.0 - uv.y)); }
#line 1
%s
void main() {
    fragColor = transition(vec2(qt_TexCoord0.x, 1.0 - qt_TexCoord0.y)) * qt_Opacity;
}
""" % (block, defines, body)
    return out, names


class ShaderLibrary:
    def __init__(self, library_dir, cache_dir):
        self.library_dir = library_dir
        self.cache_dir = cache_dir
        os.makedirs(cache_dir, exist_ok=True)
        self.custom = {}           # id -> glsl source (custom_shaders on the payload)
        self._baked = {}           # source hash -> (qsb path, names) | None
        self.qsb = find_qsb()
        if not self.qsb:
            log.warning("qsb not found (install qt6-shader-baker): transitions fall back to crossfade")

    def set_custom(self, mapping):
        self.custom = {str(k): str(v) for k, v in (mapping or {}).items() if isinstance(v, str)}

    def source(self, shader_id):
        if shader_id in self.custom:
            return self.custom[shader_id]
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", shader_id or ""):
            return None
        try:
            with open(os.path.join(self.library_dir, shader_id + ".glsl"), encoding="utf-8") as f:
                return f.read()
        except OSError:
            return None

    def bake(self, shader_id):
        src = self.source(shader_id)
        if src is None:
            return None
        h = hashlib.sha256(src.encode()).hexdigest()[:24]
        if h in self._baked:
            return self._baked[h]
        wrapped, names = wrap(src)
        frag = os.path.join(self.cache_dir, h + ".frag")
        # ".v2": bakes before this carried GLSL only; they must not be reused (see the qsb call).
        out = os.path.join(self.cache_dir, h + ".v2.frag.qsb")
        result = None
        # A shader already baked (by an earlier run, or shipped pre-baked) needs no qsb at all.
        if not os.path.exists(out) and self.qsb:
            with open(frag, "w", encoding="utf-8") as f:
                f.write(wrapped)
            try:
                # ⚠️ EVERY backend, not just GL: Windows renders through Direct3D 11 (HLSL) and a Mac
                # through Metal. A GLSL-only .qsb loads fine there and draws NOTHING — every transition
                # on the Windows build was ~2.5 s of black. HLSL/MSL are emitted as source (SPIRV-Cross)
                # and compiled by the driver at load, so this bakes the same on any build machine.
                p = subprocess.run([self.qsb, "--glsl", "100 es,120,150,300 es", "--hlsl", "50", "--msl", "12",
                                    "-o", out, frag],
                                   capture_output=True, text=True, timeout=60)
                if p.returncode != 0:
                    log.warning("qsb failed for %s: %s", shader_id, (p.stderr or p.stdout)[-400:])
                    try:
                        os.unlink(out)
                    except OSError:
                        pass
            except (OSError, subprocess.SubprocessError) as e:
                log.warning("qsb failed for %s: %s", shader_id, e)
        if os.path.exists(out):
            result = (out, names)
        self._baked[h] = result
        return result

    def resolve(self, spec):
        """Pick one effect and return what QML needs, or a crossfade fallback. None = hard cut."""
        if not spec:
            return None
        eff = random.choice(spec["effects"])
        baked = self.bake(eff["shader"])
        out = {"durationMs": spec["durationMs"], "shader": eff["shader"], "qsb": "", "params": []}
        if baked:
            path, names = baked
            out["qsb"] = pathlib.Path(path).as_uri()
            out["params"] = [float(eff["params"].get(n, _default_of(self.source(eff["shader"]), n))) for n in names]
        return out


def _default_of(src, name):
    m = re.search(r"uniform\s+float\s+%s\s*;\s*//\s*=\s*(-?[\d.]+)" % re.escape(name), src or "")
    return float(m.group(1)) if m else 0.0
