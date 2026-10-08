"""A display deleted on the dashboard drops its downloads; any other unpair keeps them.

The server's DELETE route sends `device:unpaired {reason: 'deleted'}`. The register path's
`not_found` is also what a restored backup or an unreplicated mesh edge says, so wiping on it would
empty a whole fleet. Same rule as Android's DeletedDeviceWipe and the Tizen handler.
"""
import os

from screentinker_native.net.link import DeviceLink
from screentinker_native.player.cache import ContentCache


class _Config:
    def get(self, key, default=None):
        return default


class _Handlers:
    def __init__(self):
        self.deleted = 0

    def on_deleted(self):
        self.deleted += 1


def _link():
    h = _Handlers()
    link = DeviceLink(_Config(), h)
    rejected = []
    link._rejected = rejected.append
    return link, h, rejected


def test_explicit_delete_wipes_then_rejects():
    link, h, rejected = _link()
    link._on_unpaired({"reason": "deleted"})
    assert h.deleted == 1
    assert rejected == ["device:unpaired (removed on server)"]


def test_not_found_and_bare_unpaired_keep_downloads():
    for payload in ({"reason": "not_found"}, {}, None, "deleted"):
        link, h, rejected = _link()
        link._on_unpaired(payload)
        assert h.deleted == 0, payload
        assert len(rejected) == 1


def test_a_failing_wipe_still_rejects():
    link, h, rejected = _link()

    def boom():
        raise OSError("disk")
    h.on_deleted = boom
    link._on_unpaired({"reason": "deleted"})
    assert len(rejected) == 1


def test_prune_with_nothing_kept_empties_the_cache(tmp_path):
    cache = ContentCache(str(tmp_path))
    for n in ("a1.mp4", "b2.jpg.part", "b2.jpg.part.tag", "c3.png.rev"):
        (tmp_path / n).write_text("x")
    assert cache.prune(set()) == 4
    assert os.listdir(tmp_path) == []


def test_trigger_ids_come_from_triggers_only():
    from screentinker_native.player.cache import trigger_content_ids
    p = {"assignments": [{"content_id": "play1"}],
         "triggers": [{"id": "t1", "items": [{"content_id": "trig1"}, {"content_id": "trig2"}, {}]}, None]}
    assert trigger_content_ids(p) == {"trig1", "trig2"}
    assert trigger_content_ids(None) == set()
    assert trigger_content_ids({"triggers": None}) == set()


def test_prune_keeps_trigger_media(tmp_path):
    cache = ContentCache(str(tmp_path))
    for n in ("play1.mp4", "trig1.mp4", "trig1.mp4.rev", "trig2.png.part"):
        (tmp_path / n).write_text("x")
    assert cache.prune({"trig1", "trig2"}) == 1
    assert sorted(os.listdir(tmp_path)) == ["trig1.mp4", "trig1.mp4.rev", "trig2.png.part"]
