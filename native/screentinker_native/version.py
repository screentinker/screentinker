"""The player's own version.

Stamped by pi/packaging/build-deb.sh from the repo's VERSION file. Reported as device_info.app_version
and client_version, and compared by the OTA check. A source checkout run in place reports the
checkout's VERSION with a "-dev" suffix so it can never look like a released build to the OTA check.
"""

import os

_STAMPED = "0.0.0-dev"


def _from_checkout():
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, "..", "..", "VERSION")
    try:
        with open(path, encoding="utf-8") as f:
            v = f.read().strip()
        return v + "-dev" if v else None
    except OSError:
        return None


VERSION = _STAMPED if not _STAMPED.endswith("-dev") else (_from_checkout() or _STAMPED)
