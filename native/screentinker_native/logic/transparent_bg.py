"""#660 "Transparent background" on a playlist item (server lib/backgrounds.js).

The player asks for the see-through page with `transparent=1` on the render URL. A bundle played
from the local cache has no request to carry it, so the same style is added here, byte for byte."""

TRANSPARENT_CSS = ('<style id="st-transparent">html,body,.stage{background:transparent!important;'
                   'background-color:transparent!important}</style>')


def param(on):
    """The query flag (before any #fragment), or ''."""
    return "&transparent=1" if on else ""


def force(html):
    """A document drawn see-through, as the server sends it with the flag."""
    low = html.lower()
    at = low.find("</head>")
    return html[:at] + TRANSPARENT_CSS + html[at:] if at >= 0 else TRANSPARENT_CSS + html
