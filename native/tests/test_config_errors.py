"""A hand-edited config.json that doesn't parse must say where, not read as "no server" (#927).

Buster14 left out the comma between two "players" entries: the helper started nothing and the running
player showed "No server configured" with the Pi's sudo command, on Windows.
"""
import logging

from screentinker_native import config
from screentinker_native.platform.linux import ops as linux_ops
from screentinker_native.platform.macos import ops as macos_ops
from screentinker_native.platform.windows import ops as windows_ops
from screentinker_native.winhelper import service

MISSING_COMMA = b'{\n  "server_url": "http://x",\n  "players": [\n    { "display": "@0,0" }\n    { "instance": "2" }\n  ]\n}\n'


def test_a_missing_comma_names_the_line(tmp_path):
    p = tmp_path / "config.json"
    p.write_bytes(MISSING_COMMA)
    msg = config.json_problem(str(p))
    assert "line 5, column 5" in msg and str(p) in msg
    assert config._read_json(str(p)) == {}


def test_good_bom_or_missing_files_are_not_problems(tmp_path):
    p = tmp_path / "config.json"
    p.write_bytes(b"\xef\xbb\xbf{\"server_url\": \"http://x\"}")
    assert config.json_problem(str(p)) is None
    assert config.json_problem(str(tmp_path / "absent.json")) is None
    p.write_bytes(b"[1, 2]")
    assert "one { ... } object" in config.json_problem(str(p))


def test_the_player_carries_the_problem(tmp_path, monkeypatch):
    p = tmp_path / "config.json"
    p.write_bytes(MISSING_COMMA)
    monkeypatch.setattr(config, "SYSTEM_CONFIG", str(p))
    c = config.Config(str(tmp_path / "state"))
    assert c.server_url == "" and "line 5" in c.system_config_problem


def test_no_server_hint_matches_the_platform():
    assert "sudo" in linux_ops.no_server_hint()
    assert "sudo" not in windows_ops.no_server_hint() and "config.json" in windows_ops.no_server_hint()
    assert "sudo" not in macos_ops.no_server_hint()


def test_helper_logs_a_broken_config_once_and_recovers(tmp_path, monkeypatch, caplog):
    p = tmp_path / "config.json"
    p.write_bytes(MISSING_COMMA)
    monkeypatch.setattr(service, "CONFIG", str(p))
    monkeypatch.setattr(service, "_last_config_problem", None)
    with caplog.at_level(logging.INFO, logger="helper"):
        assert service.load_config() == {}
        assert service.load_config() == {}
        p.write_bytes(b'{"server_url": "http://x"}')
        assert service.load_config() == {"server_url": "http://x"}
    errors = [r for r in caplog.records if r.levelno == logging.ERROR]
    assert len(errors) == 1 and "line 5, column 5" in errors[0].getMessage()
    assert any("reads fine again" in r.getMessage() for r in caplog.records)
