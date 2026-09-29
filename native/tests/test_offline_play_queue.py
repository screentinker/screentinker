"""Port of server/test/offline-play-queue.test.js + android OfflinePlayQueueTest.kt (#299)."""
import itertools
import json
import os

from screentinker_native.logic.offline_play_queue import (BATCH, MAX_ENTRIES, WIRE_KEYS, OfflinePlayQueue,
                                                      make_play, new_id)

_n = itertools.count()


def play(**over):
    kw = dict(client_event_id="evt-%d" % next(_n), content_id="c1", content_name="clip.mp4",
              started_at=1_800_000_000, ended_at=1_800_000_020, completed=True)
    kw.update(over)
    return make_play(**kw)


def test_constants_match_android():
    assert MAX_ENTRIES == 2000 and BATCH == 200


def test_THE_BUG_a_play_recorded_offline_is_kept():
    q = OfflinePlayQueue()
    q.add(play())
    assert q.size() == 1 and len(q.peek_batch()) == 1


def test_a_whole_outage_of_plays_survives():
    q = OfflinePlayQueue()
    for i in range(1040):
        q.add(play(started_at=1_800_000_000 + i * 20))
    assert q.size() == 1040 and q.dropped == 0


def test_a_panel_offline_for_weeks_cannot_fill_its_storage():
    q = OfflinePlayQueue(100)
    for i in range(1000):
        q.add(play(started_at=1_800_000_000 + i))
    assert q.size() == 100 and q.dropped == 900


def test_when_full_it_drops_the_oldest_and_counts_it():
    q = OfflinePlayQueue(3)
    for i in "abcd":
        q.add(play(client_event_id=i))
    assert [p["client_event_id"] for p in q.peek_batch()] == ["b", "c", "d"]
    assert q.dropped > 0


def test_entries_are_removed_only_by_ack_never_by_peeking():
    q = OfflinePlayQueue()
    q.add(play(client_event_id="x"))
    q.add(play(client_event_id="y"))
    q.peek_batch()
    assert q.size() == 2
    q.ack(["x"])
    assert q.size() == 1 and q.peek_batch()[0]["client_event_id"] == "y"


def test_ack_by_id_survives_a_queue_that_moved_under_the_flush():
    q = OfflinePlayQueue()
    q.add(play(client_event_id="old1"))
    q.add(play(client_event_id="old2"))
    batch = q.peek_batch()
    q.add(play(client_event_id="new1"))
    q.ack([p["client_event_id"] for p in batch])
    assert q.size() == 1 and q.peek_batch()[0]["client_event_id"] == "new1"


def test_a_flush_is_batched():
    q = OfflinePlayQueue()
    for _ in range(BATCH * 3):
        q.add(play())
    assert len(q.peek_batch()) == BATCH


def test_it_round_trips_through_serialize_restore():
    q = OfflinePlayQueue()
    q.add(play(client_event_id="keep-me", started_at=1_799_999_000, ended_at=1_799_999_020))
    q.add(play(client_event_id="me-too", started_at=1_799_999_100, ended_at=1_799_999_120))
    back = OfflinePlayQueue()
    back.restore(q.serialize())
    assert back.size() == 2
    first = back.peek_batch()[0]
    assert first == {"client_event_id": "keep-me", "content_id": "c1", "widget_id": None,
                     "content_name": "clip.mp4", "started_at": 1_799_999_000, "ended_at": 1_799_999_020,
                     "completed": True}


def test_a_corrupt_store_costs_the_backlog_never_the_boot():
    for junk in [None, "", "   ", "{", "not json", '[{"broken":', "[1,2,3]", "[{}]", '{"a":1}', 42]:
        q = OfflinePlayQueue()
        q.restore(junk)
        assert q.size() == 0, junk


def test_entries_without_the_fields_that_make_them_meaningful_are_refused():
    q = OfflinePlayQueue()
    q.add({"client_event_id": "no-start"})
    q.add({"started_at": 1_800_000_000})
    q.add(play(client_event_id="good"))
    assert q.size() == 1 and q.peek_batch()[0]["client_event_id"] == "good"
    q2 = OfflinePlayQueue()
    q2.restore('[{"client_event_id":"ok","started_at":1799999000},{"started_at":1799999000},'
               '{"client_event_id":"no-start"},{"client_event_id":"neg","started_at":-5},'
               '{"client_event_id":"str","started_at":"1799999000"}]')
    assert [p["client_event_id"] for p in q2.peek_batch()] == ["ok"]


def test_ids_are_unique_across_rapid_creation():
    assert len({new_id() for _ in range(2000)}) == 2000


def test_the_wire_shape_matches_server_and_android():
    p = play(client_event_id="e1", started_at=1_799_990_000, ended_at=1_799_990_020)
    assert sorted(p.keys()) == sorted(WIRE_KEYS) == ["client_event_id", "completed", "content_id",
                                                     "content_name", "ended_at", "started_at", "widget_id"]
    assert make_play("x", 1)["content_name"] == "Unknown"


def test_clear_empties_it():
    q = OfflinePlayQueue()
    q.add(play())
    q.clear()
    assert q.size() == 0


# ---- file persistence (Pi) ----

def test_save_and_load_through_a_file(tmp_path):
    path = str(tmp_path / "sub" / "offline-plays.json")
    q = OfflinePlayQueue(path=path)
    q.add(play(client_event_id="persisted"))
    assert q.save() is True
    assert json.loads(open(path).read())[0]["client_event_id"] == "persisted"
    assert not [f for f in os.listdir(os.path.dirname(path)) if f.startswith(".offline-plays.")]
    back = OfflinePlayQueue(path=path)
    back.load()
    assert back.peek_batch()[0]["client_event_id"] == "persisted"


def test_load_of_a_missing_or_truncated_file_is_an_empty_queue(tmp_path):
    q = OfflinePlayQueue(path=str(tmp_path / "nope.json"))
    q.load()
    assert q.size() == 0
    p = tmp_path / "trunc.json"
    p.write_text('[{"client_event_id":"a","started_at":1')
    q2 = OfflinePlayQueue(path=str(p))
    q2.load()
    assert q2.size() == 0


def test_save_without_a_path_or_to_an_unwritable_dir_reports_false(tmp_path):
    assert OfflinePlayQueue().save() is False
    blocker = tmp_path / "file"
    blocker.write_text("x")
    assert OfflinePlayQueue(path=str(blocker / "q.json")).save() is False
