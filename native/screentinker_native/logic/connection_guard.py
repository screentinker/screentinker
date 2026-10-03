"""#148 root-cause guard: the SINGLE-SOCKET-PER-DEVICE invariant.

Port of android service/ConnectionGuard.kt. Every entry point (boot, service bind, foreground
re-bind, reconnect) used to call an UNCONDITIONAL connect() that tore down a healthy socket and
opened a new one — a ROM that re-binds on foreground produced a burst of sockets for one device_id
(the 8-in-9s storm). Guarding the SOCKET, not the caller count, closes every duplication vector.
"""


def should_open_new_socket(has_socket: bool, same_url: bool, socket_active: bool) -> bool:
    """Reuse (False) iff we already hold a socket to the SAME url that is live or self-healing
    (`socket_active` = connected OR auto-reconnecting). Open a new one only when there is none
    usable: no socket, a different url (a genuine re-provision), or the socket went inert (e.g.
    after `io server disconnect`, which Socket.IO does not auto-reconnect)."""
    return not (has_socket and same_url and socket_active)
