"""#660 "Transparent background" on a playlist item, on the native player."""
from screentinker_native.logic import transparent_bg as TB
from screentinker_native.player.items import Item


def test_flag_parses_and_enters_the_signature_only_when_set():
    plain = Item.parse({"content_id": "", "widget_id": "w1", "widget_rev": 3})
    clear = Item.parse({"content_id": "", "widget_id": "w1", "widget_rev": 3, "transparent_bg": 1})
    assert plain.transparent_bg is False and clear.transparent_bg is True
    assert plain.sig() != clear.sig(), "ticking it re-renders the item"
    assert not plain.sig().endswith("|t"), "an unticked item keeps the signature it always had"


def test_url_flag_and_cached_bundle_style():
    assert TB.param(False) == "" and TB.param(True) == "&transparent=1"
    assert TB.force("<html><head></head><body></body></html>") == "<html><head>" + TB.TRANSPARENT_CSS + "</head><body></body></html>"
    assert TB.force("<HEAD></HEAD>") == "<HEAD>" + TB.TRANSPARENT_CSS + "</HEAD>"
    assert TB.force("<p>x</p>") == TB.TRANSPARENT_CSS + "<p>x</p>"
