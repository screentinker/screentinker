"""System brightness on macOS — not offered.

macOS has no supported, unprivileged command for display brightness: the built-in panel is driven by
the private DisplayServices framework and external monitors need DDC/CI, which Apple Silicon only
exposes through private IOKit calls. Both change between releases. So `system.brightness` is not
declared; the player's own per-window dim layer (set_brightness) still works on every Mac.
"""


async def supported():
    return False


async def set_level(level):
    return []


async def get_level():
    return None
