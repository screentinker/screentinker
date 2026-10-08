"""The solo controller's deferred playlist swap (#157) against emergency alerts.

A swap that removes the item on screen waits for its natural end. Two rules ride on top: a playlist
that comes back to what is already playing cancels that wait (a cleared alert used to be shown anyway,
minutes later), and an alert raised or cleared — the set of `interrupt: true` items changing — is
never deferred at all."""
import logging

import pytest

QtCore = pytest.importorskip("PySide6.QtCore")

from screentinker_native.logic import playlist_logic as pl  # noqa: E402
from screentinker_native.player.items import Item  # noqa: E402


@pytest.fixture(scope="module")
def qapp():
    app = QtCore.QCoreApplication.instance() or QtCore.QCoreApplication([])
    yield app


def _w(i, dur=5):
    return {"id": i, "widget_id": "w%d" % i, "mime_type": "text/html", "filename": "W%d" % i, "duration_sec": dur}


def _alert(i=9):
    return {"id": i, "widget_id": "cap%d" % i, "widget_type": "cap_alert", "mime_type": "text/html",
            "filename": "Alert", "duration_sec": 30, "interrupt": True}


def _controller(played):
    from screentinker_native.player.controller import PlaylistController
    return PlaylistController(on_item_changed=lambda it: played.append(it.widget_id),
                              on_playlist_empty=lambda: played.append("EMPTY"))


def _ids(c):
    return [i.widget_id for i in c.items]


def test_an_ordinary_edit_that_removes_the_live_item_is_still_deferred(qapp):
    played = []
    c = _controller(played)
    c.update_playlist([_w(1), _w(2)])
    c.start()
    c.update_playlist([_w(3)])
    assert _ids(c) == ["w1", "w2"] and c.pending_items is not None
    assert c._pending_deadline.isActive()
    assert played == ["w1"]
    c.next()
    assert _ids(c) == ["w3"] and played == ["w1", "w3"]


def test_THE_BUG_back_to_the_current_playlist_cancels_the_deferred_swap(qapp):
    played = []
    c = _controller(played)
    c.update_playlist([_w(1), _w(2)])
    c.start()
    c.update_playlist([_w(3)])                    # A -> B: deferred
    assert c.pending_items is not None
    c.update_playlist([_w(1), _w(2)])             # B -> A: "unchanged", the stale B must go
    assert c.pending_items is None and c.pending_successor is None
    assert not c._pending_deadline.isActive()
    c.next()
    assert _ids(c) == ["w1", "w2"] and played == ["w1", "w2"]


def test_raising_an_alert_interrupts_mid_item(qapp):
    played = []
    c = _controller(played)
    c.update_playlist([_w(1), _w(2)])
    c.start()
    c.update_playlist([_alert()])                 # 2 -> 1: the live item is removed
    assert c.pending_items is None and not c._pending_deadline.isActive()
    assert _ids(c) == ["cap9"] and played == ["w1", "cap9"]


def test_an_alert_added_alongside_the_live_item_is_shown_at_once(qapp):
    played = []
    c = _controller(played)
    c.update_playlist([_w(1), _w(2)])
    c.start()
    c.update_playlist([_w(1), _w(2), _alert()])   # w1 is still in the list: would otherwise keep playing
    assert played == ["w1", "cap9"] and c.current_item.widget_id == "cap9"


def test_clearing_an_alert_restores_the_playlist_immediately(qapp):
    played = []
    c = _controller(played)
    c.update_playlist([_w(1), _w(2)])
    c.start()
    c.update_playlist([_alert()])
    c.update_playlist([_w(1), _w(2)])             # cleared while the alert card is on screen
    assert c.pending_items is None and not c._pending_deadline.isActive()
    assert _ids(c) == ["w1", "w2"] and played == ["w1", "cap9", "w1"]


def test_raise_then_clear_before_an_advance_never_shows_the_alert_late(qapp):
    """The QA repro on a pre-interrupt payload shape: the alert swap was deferred, then cleared."""
    played = []
    c = _controller(played)
    c.update_playlist([_w(1), _w(2)])
    c.start()
    c.update_playlist([dict(_alert(), interrupt=False)])   # an old server: deferred like any edit
    assert c.pending_items is not None
    c.update_playlist([_w(1), _w(2)])
    c._on_pending_deadline()
    c.next()
    assert "cap9" not in played


def test_interrupts_changed_is_what_the_engine_breaks_an_interactive_hold_on(qapp):
    played = []
    c = _controller(played)
    c.update_playlist([_w(1), _w(2)])
    c.start()
    c.hold()
    assert c.interrupts_changed([_w(1), _w(2), _alert()])
    assert not c.interrupts_changed([_w(1), _w(3)])
    assert not c.interrupts_changed([_w(1), _w(2)])


def test_a_duration_edit_logs_without_a_logging_error(qapp, caplog, capsys):
    c = _controller([])
    c.update_playlist([_w(1), _w(2)])
    with caplog.at_level(logging.INFO, logger="controller"):
        c.update_playlist([_w(1, dur=9), _w(2)])
    assert c.items[0].duration_sec == 9
    assert "durations updated in place (2 items)" in caplog.text
    assert "Logging error" not in capsys.readouterr().err


def test_interrupt_is_parsed_and_structural():
    assert Item.parse(_alert()).interrupt is True
    assert Item.parse(dict(_alert(), interrupt=1)).interrupt is True
    assert Item.parse(_w(1)).interrupt is False
    assert Item.parse(dict(_alert(), interrupt="yes")).interrupt is False
    assert Item.parse(_alert()).sig() != Item.parse(dict(_alert(), interrupt=False)).sig()
    assert Item.parse(_w(1)).sig() == Item.parse(dict(_w(1), interrupt=False)).sig()


def test_should_defer_swap_never_defers_an_interrupt_change():
    assert pl.should_defer_swap(True, False, True, "a", ["b"]) is True
    assert pl.should_defer_swap(True, False, True, "a", ["b"], interrupt_changed=True) is False
