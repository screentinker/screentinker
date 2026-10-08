"""platform/windows/privileged.available(), tested on Linux: the WaitNamedPipe probe is replaced."""

from screentinker_native.platform.windows import privileged


def test_available_is_cached_so_the_menu_never_waits_on_the_pipe(monkeypatch):
    calls = []
    monkeypatch.setattr(privileged, "_probe", lambda: calls.append(1) or True)
    monkeypatch.setattr(privileged, "_available_cache", [None, 0.0])
    assert privileged.available() is True
    assert privileged.available() is True
    assert len(calls) == 1
    privileged._available_cache[1] -= privileged.AVAILABLE_TTL_S + 1
    monkeypatch.setattr(privileged, "_probe", lambda: calls.append(1) or False)
    assert privileged.available() is False, "asked again once the answer is stale"
    assert len(calls) == 2
