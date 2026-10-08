"""The OS backend, chosen once at import.

The native player is one engine with three operating-system backends (Linux, Windows, macOS). Everything above this package —
the socket, playback, zones, transitions, sync, triggers, the QML scene — is OS-neutral and imports
the OS-specific pieces ONLY from here:

    from ..platform import audio, brightness, deviceinfo, display, ops, privileged, shell

Each backend provides the same seven modules with the same function names. Adding an OS means adding
a sibling package that satisfies that contract; nothing above it may test sys.platform itself.
"""

import sys

IS_WINDOWS = sys.platform == "win32"
IS_MACOS = sys.platform == "darwin"

if IS_WINDOWS:
    from .windows import audio, brightness, deviceinfo, display, ops, privileged, shell  # noqa: F401
elif IS_MACOS:
    from .macos import audio, brightness, deviceinfo, display, ops, privileged, shell  # noqa: F401
else:
    from .linux import audio, brightness, deviceinfo, display, ops, privileged, shell  # noqa: F401
