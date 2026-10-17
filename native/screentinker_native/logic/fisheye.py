"""Fisheye cameras shown as a normal 16:9 view ("digital PTZ").

The same maths as server/lib/fisheye.js (the definition; read its header) and Android's Fisheye.kt,
held together by shared/fisheye-vectors.json. The player computes the view's three directions here
(basis) and hands them to the fragment shader (player/qml/fisheye.frag), which does per pixel what
project() does.

⚠️ The picture is always upright: "up" comes from the mount, never from the image, and tilt is
clamped so the view cannot swing over the top and flip.
"""

import math

MOUNTS = ("ceiling", "floor", "wall")
OUTPUT_ASPECT = 16 / 9
DEFAULTS = {"mount": "ceiling", "lens_fov": 180.0, "rotation": 0.0, "cx": 0.5, "cy": 0.5, "r": 0.5,
            "pan": 0.0, "tilt": 55.0, "zoom": 80.0, "touch": False}
ZOOM_MIN, ZOOM_MAX = 20.0, 120.0


def _num(v, d):
    if isinstance(v, bool):
        return d
    if isinstance(v, (int, float)) and math.isfinite(v):
        return float(v)
    if isinstance(v, str):
        try:
            f = float(v)
            return f if math.isfinite(f) else d
        except ValueError:
            return d
    return d


def _clamp(v, lo, hi):
    return min(hi, max(lo, v))


def _wrap180(a):
    x = ((a + 180) % 360 + 360) % 360 - 180
    return 180.0 if x == -180 else x


def tilt_range(mount, lens_fov):
    half = lens_fov / 2
    if mount == "wall":
        return -min(85.0, half), min(85.0, half)
    return 0.0, min(half, 120.0)


def view_of(o, f, fallback):
    """pan / tilt / zoom from `o`, clamped for the settings `f`, else `fallback`."""
    mount = f.get("mount", "ceiling")
    lens = f.get("lens_fov", 180.0)
    lo, hi = tilt_range(mount, lens)
    o = o or {}
    pan = _num(o.get("pan"), fallback["pan"])
    pan = _clamp(pan, -lens / 2, lens / 2) if mount == "wall" else _wrap180(pan)
    return {"pan": pan,
            "tilt": _clamp(_num(o.get("tilt"), fallback["tilt"]), lo, hi),
            "zoom": _clamp(_num(o.get("zoom"), fallback["zoom"]), ZOOM_MIN, ZOOM_MAX)}


def normalize(raw):
    """The item's settings with every field present and in range, or None (not a fisheye)."""
    if not isinstance(raw, dict):
        return None
    mount = raw.get("mount") if raw.get("mount") in MOUNTS else "ceiling"
    lens = _clamp(_num(raw.get("lens_fov"), 180.0), 90.0, 240.0)
    f = {"mount": mount, "lens_fov": lens,
         "rotation": _wrap180(_num(raw.get("rotation"), 0.0)),
         "cx": _clamp(_num(raw.get("cx"), 0.5), 0.0, 1.0),
         "cy": _clamp(_num(raw.get("cy"), 0.5), 0.0, 1.0),
         "r": _clamp(_num(raw.get("r"), 0.5), 0.05, 1.5),
         "touch": raw.get("touch") in (True, 1, "1", "true")}
    f.update(view_of(raw, f, {"pan": 0.0, "tilt": 0.0 if mount == "wall" else 55.0, "zoom": 80.0}))
    return f


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _norm(a):
    n = math.sqrt(a[0] ** 2 + a[1] ** 2 + a[2] ** 2) or 1.0
    return (a[0] / n, a[1] / n, a[2] / n)


def basis(f):
    """(d, right, up): the view's direction and its right / up, unit vectors in the camera frame."""
    p, t = math.radians(f["pan"]), math.radians(f["tilt"])
    if f["mount"] == "wall":
        d = (math.sin(p) * math.cos(t), -math.sin(t), math.cos(p) * math.cos(t))
        up = (-math.sin(p) * math.sin(t), -math.cos(t), -math.cos(p) * math.sin(t))
    else:
        d = (math.sin(t) * math.cos(p), math.sin(t) * math.sin(p), math.cos(t))
        up = (math.cos(t) * math.cos(p), math.cos(t) * math.sin(p), -math.sin(t))
        if f["mount"] == "floor":
            up = (-up[0], -up[1], -up[2])
    up = _norm(up)
    return d, _norm(_cross(d, up)), up


def project(f, x, y, image_aspect=1.0):
    """Where output (x, y) (-1..1, y up) samples the image: (u, v) 0..1 (v down), or None."""
    d, right, up = basis(f)
    tx = math.tan(math.radians(f["zoom"]) / 2)
    ty = tx / OUTPUT_ASPECT
    ray = _norm(tuple(d[i] + x * tx * right[i] + y * ty * up[i] for i in range(3)))
    theta = math.acos(_clamp(ray[2], -1.0, 1.0))
    half = math.radians(f["lens_fov"]) / 2
    if theta > half:
        return None
    phi = math.atan2(ray[1], ray[0]) + math.radians(f["rotation"])
    rho = theta / half
    return (f["cx"] + f["r"] * rho * math.cos(phi) / image_aspect, f["cy"] + f["r"] * rho * math.sin(phi))


def uniforms(f, image_aspect=1.0):
    """What the shader needs, flat: the basis, the half-extents, the lens and the circle."""
    d, right, up = basis(f)
    tx = math.tan(math.radians(f["zoom"]) / 2)
    return {"dir": d, "right": right, "up": up, "tanX": tx, "tanY": tx / OUTPUT_ASPECT,
            "lensHalf": math.radians(f["lens_fov"]) / 2, "rot": math.radians(f["rotation"]),
            "center": (f["cx"], f["cy"]), "radius": (f["r"] / image_aspect, f["r"])}


class View:
    """The view a screen is showing right now: starts at the item's saved settings and is moved by
    the camera_view command or by touch (same rules as Android's Fisheye.View)."""

    def __init__(self, saved, content_id=None):
        self.saved = saved
        self.current = dict(saved)
        self.content_id = content_id

    def set(self, pan=None, tilt=None, zoom=None):
        c = self.current
        self.current = dict(c, **view_of({"pan": c["pan"] if pan is None else pan,
                                          "tilt": c["tilt"] if tilt is None else tilt,
                                          "zoom": c["zoom"] if zoom is None else zoom}, c, c))

    def reset(self):
        self.current = dict(self.saved)

    def drag(self, dx_frac, dy_frac, view_aspect=OUTPUT_ASPECT):
        """A drag of (dx, dy) of the view's width / height (y screen-down) moves the picture with the
        finger: right turns the view left, down looks up. The floor mount's frame is mirrored."""
        c = self.current
        h_fov = c["zoom"]
        v_fov = 2 * math.degrees(math.atan(math.tan(math.radians(c["zoom"]) / 2) / view_aspect))
        pan_sign = 1.0 if c["mount"] == "floor" else -1.0
        tilt_sign = -1.0 if c["mount"] == "floor" else 1.0
        self.set(c["pan"] + pan_sign * dx_frac * h_fov, c["tilt"] + tilt_sign * dy_frac * v_fov)

    def pinch(self, scale):
        if scale <= 0 or abs(scale - 1) < 1e-6:
            return
        self.set(zoom=self.current["zoom"] / max(0.2, min(5.0, scale)))

    def qml(self):
        """What Slot.qml's ShaderEffect needs: the basis and lens, flat. The QML side adds the view's
        own aspect (tan of the vertical half-angle) and the picture's (the circle's x radius), because
        only it knows the item's size and the video's resolution."""
        f = self.current
        d, right, up = basis(f)
        return {"dir": list(d), "right": list(right), "up": list(up),
                "tanX": math.tan(math.radians(f["zoom"]) / 2),
                "lensHalf": math.radians(f["lens_fov"]) / 2, "rot": math.radians(f["rotation"]),
                "cx": f["cx"], "cy": f["cy"], "r": f["r"], "touch": bool(self.saved.get("touch"))}


# Qt 6 ShaderEffect fragment shader (Vulkan-style GLSL 440, baked to .qsb by player/transitions.py's
# ShaderLibrary). project() per pixel; qt_TexCoord0 is top-left, so the output y is flipped to "up",
# and the picture is sampled with v downward as it comes.
FRAGMENT_440 = """#version 440
layout(location = 0) in vec2 qt_TexCoord0;
layout(location = 0) out vec4 fragColor;
layout(std140, binding = 0) uniform buf {
    mat4 qt_Matrix;
    float qt_Opacity;
    vec3 uDir;
    vec3 uRight;
    vec3 uUp;
    vec2 uTan;
    float uLensHalf;
    float uRot;
    vec2 uCenter;
    vec2 uRadius;
};
layout(binding = 1) uniform sampler2D src;
void main() {
    vec2 p = vec2(qt_TexCoord0.x * 2.0 - 1.0, 1.0 - qt_TexCoord0.y * 2.0);
    vec3 ray = normalize(uDir + p.x * uTan.x * uRight + p.y * uTan.y * uUp);
    float theta = acos(clamp(ray.z, -1.0, 1.0));
    if (theta > uLensHalf) {
        fragColor = vec4(0.0, 0.0, 0.0, qt_Opacity);
        return;
    }
    float phi = atan(ray.y, ray.x) + uRot;
    float rho = theta / uLensHalf;
    vec2 uv = uCenter + uRadius * rho * vec2(cos(phi), sin(phi));
    fragColor = texture(src, uv) * qt_Opacity;
}
"""
