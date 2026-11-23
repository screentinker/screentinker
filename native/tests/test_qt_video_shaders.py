"""#833: the OpenGL ES 2 video shaders Debian's Qt 6.8.1/6.8.2 lacks (Pi 3 white screen)."""
import os
import re

from screentinker_native.player import qt_video_shaders as q

SHADERS = ["y_a", "nv12_a", "nv21_a", "imc2_a", "imc4_a", "yuv_triplanar_a", "yvu_triplanar_a"]


def run(version, has_probe=False, register_ok=True, rcc=q.RCC):
    calls = []

    def register(path, root):
        calls.append((path, root))
        return register_ok

    return q.install(qt_version=version, exists=lambda p: has_probe and p == q.PROBE,
                     register=register, rcc=rcc), calls


def test_registers_on_affected_qt_without_the_shaders():
    for v in ("6.8.1", "6.8.2"):
        result, calls = run(v)
        assert result == "registered"
        assert calls == [(q.RCC, "/qt-project.org/multimedia/shaders")]


def test_leaves_other_qt_versions_alone():
    # 6.8.3+ replaced the alpha shaders with a uniform; 6.8.0 and older use another uniform buffer.
    for v in ("6.4.2", "6.7.3", "6.8.0", "6.8.3", "6.9.1", "6.10.0"):
        result, calls = run(v)
        assert result == "not-affected" and calls == [], v


def test_leaves_a_qt_that_has_them_alone():
    # A Qt built for OpenGL ES 2 already carries them; ours must not shadow its own.
    result, calls = run("6.8.2", has_probe=True)
    assert result == "present" and calls == []


def test_missing_file_and_failed_registration_never_raise():
    assert run("6.8.2", rcc="/nonexistent.rcc")[0] == "missing-file"
    assert run("6.8.2", register_ok=False)[0] == "failed"

    def boom(*_):
        raise RuntimeError("odd Qt")
    assert q.install(qt_version="6.8.2", exists=boom, register=boom) == "failed"


def test_the_probe_is_the_shader_the_pi3_asked_for():
    # From the #833 log: Failed to find shader ":/qt-project.org/multimedia/shaders/yuv_triplanar_a.frag.qsb"
    assert q.PROBE == ":/qt-project.org/multimedia/shaders/yuv_triplanar_a.frag.qsb"


def test_rcc_holds_every_alpha_shader_and_its_linear_twin():
    with open(q.RCC, "rb") as f:
        data = f.read()
    assert data[:4] == b"qres"
    # rcc stores names as UTF-16BE.
    for name in SHADERS:
        for suffix in (".frag.qsb", "_linear.frag.qsb"):
            assert (name + suffix).encode("utf-16-be") in data, name + suffix


def test_sources_ship_beside_the_compiled_shaders():
    # LGPL: Qt's sources go with the binaries, plus the script that rebuilds them.
    d = os.path.dirname(q.RCC)
    for name in SHADERS:
        with open(os.path.join(d, name + ".frag")) as f:
            assert re.search(r"LGPL-3\.0-only", f.read()), name
    for inc in ("uniformbuffer.glsl", "colortransfer.glsl", "build.sh"):
        assert os.path.isfile(os.path.join(d, inc)), inc


def test_app_installs_before_the_first_video_output():
    src = open(os.path.join(os.path.dirname(q.__file__), "..", "app.py")).read()
    i = src.index("qt_video_shaders.install()")
    assert i < src.index("engine.load(")
