"""What this panel can actually do — declared on EVERY register (Android PlayerCapabilities.kt).

The server gates each command on these names (server/lib/player-capabilities.js COMMAND_CAPABILITY)
and the dashboard hides controls a panel cannot honour, so a declaration is a promise: never declare
something that silently no-ops. Anything hardware-dependent is PROBED, never assumed — a Pi with no
DSI panel and a TV that ignores DDC has no system brightness, and saying otherwise gives the operator
a slider that does nothing.

server/test/player-parity-baselines.test.js reads CAPABILITIES_ALWAYS from this file; keep it a
plain list literal of strings.
"""

from .platform import ops

CAPABILITIES_ALWAYS = [
    "playback.video", "playback.image", "playback.widget", "playback.youtube", "playback.hls",
    "playback.rtsp", "playback.zones", "playback.transitions", "playback.pip", "playback.bundle",
    "playback.slide_audio", "playback.web_interactive",
    # Hold items (blank / freeze for their duration) and a video wall's own layout, zones on the
    # shared clock (player/engine.py "wall zones", logic/wall_zones.py).
    "playback.hold", "playback.wall_zones",
    "audio.mute", "audio.volume",
    "display.rotation", "display.brightness", "display.power", "display.power_schedule",
    "remote.screenshot", "remote.stream", "remote.input", "remote.talk", "remote.set_server_url",
    "system.restart_player", "system.self_update", "system.shell", "system.pty", "system.kiosk",
    "net.http_request", "sync.clock", "offline.cache",
]


def declared_capabilities(brightness_supported=False):
    # The OS backend adds what depends on privilege and hardware (platform/*/ops.extra_capabilities):
    # reboot/time/install need the privileged helper, system brightness needs a controllable panel.
    # And it can withdraw an "always" row its OS cannot honour (platform/macos: no self-update) — a
    # declaration is a promise, so a row the backend cannot keep is not declared at all.
    withdrawn = set(getattr(ops, "UNSUPPORTED_CAPABILITIES", ()))
    return [c for c in CAPABILITIES_ALWAYS if c not in withdrawn] + ops.extra_capabilities(brightness_supported)
