"""What the small SPI status screen says (system/status_display.py draws it).

A "why is the big screen sad" readout on a 2.4"-3.5" SPI panel next to the main output: connection,
what's playing, network, temperature, disk, the last error. Pure: a snapshot of the player and the
OS goes in, a view comes out, so every wording and threshold is tested without Qt or a panel.

snapshot keys (all optional):
  state         "no_server" | "pairing" | "unpaired" | "online" | "offline" | "starting"
  pairing_code  shown large while pairing
  name          the device name from the dashboard
  server        the server URL
  playing       what is on the main screen ("" when nothing)
  blanked       the main screen is off (power schedule or a command)
  version       the player version
  last_error    (unix seconds, message, level) of the most recent warning or error, or None
  ip, ssid, rssi, temp_c, disk_free_mb, disk_total_mb, ram_free_mb, ram_total_mb, uptime_s
"""

from urllib.parse import urlsplit

# Colours by tone: one place, so the renderer and the tests agree on what "bad" looks like.
TONES = {
    "ok": "#22c55e",
    "warn": "#f59e0b",
    "bad": "#ef4444",
    "info": "#38bdf8",
    "muted": "#94a3b8",
}

HOT_C = 80.0          # the Pi firmware starts throttling at 80 °C (soft limit 60 °C on some boards)
WARM_C = 70.0
LOW_DISK_MB = 500     # below this, content downloads start failing
WEAK_RSSI = -75       # dBm: video stalls on Wi-Fi below about this
ERROR_FRESH_S = 3600  # an error older than an hour is history, not a cause


def _host(url):
    if not url:
        return ""
    try:
        p = urlsplit(url)
        return p.netloc or url
    except ValueError:
        return url


def _mb(v):
    if v is None:
        return "?"
    return "%.1f GB" % (v / 1024.0) if v >= 1024 else "%d MB" % v


def _ago(seconds):
    s = max(0, int(seconds))
    if s < 60:
        return "%ds ago" % s
    if s < 3600:
        return "%dm ago" % (s // 60)
    if s < 86400:
        return "%dh ago" % (s // 3600)
    return "%dd ago" % (s // 86400)


def _uptime(s):
    if s is None:
        return "?"
    s = int(s)
    d, s = divmod(s, 86400)
    h, s = divmod(s, 3600)
    m = s // 60
    return "%dd %dh" % (d, h) if d else "%dh %dm" % (h, m) if h else "%dm" % m


def headline(snap):
    """(text, tone) for the banner: the one thing to read from across the room."""
    st = snap.get("state") or "starting"
    if st == "no_server":
        return "NO SERVER SET", "bad"
    if st == "pairing":
        return "PAIR THIS DISPLAY", "warn"
    if st == "unpaired":
        return "NEEDS PAIRING", "bad"
    if st == "offline":
        return "OFFLINE", "bad"
    if st == "online":
        if snap.get("blanked"):
            return "ONLINE · SCREEN OFF", "info"
        return ("ONLINE · PLAYING", "ok") if snap.get("playing") else ("ONLINE · NOTHING TO PLAY", "warn")
    return "STARTING", "muted"


def rows(snap, now):
    """[(label, value, tone)] in reading order. A tone other than "muted" flags a likely cause."""
    out = []
    if snap.get("name"):
        out.append(("Name", snap["name"], "muted"))
    st = snap.get("state")
    if st == "pairing" and snap.get("pairing_code"):
        out.append(("Code", str(snap["pairing_code"]), "warn"))
    playing = snap.get("playing") or ""
    if snap.get("blanked"):
        out.append(("Screen", "off" + (" (was: %s)" % playing if playing else ""), "info"))
    else:
        out.append(("Playing", playing or "nothing", "muted" if playing else "warn"))
    out.append(("Server", _host(snap.get("server")) or "not set", "muted" if snap.get("server") else "bad"))

    ip = snap.get("ip")
    out.append(("IP", ip or "no network", "muted" if ip else "bad"))
    ssid, rssi = snap.get("ssid"), snap.get("rssi")
    if ssid or rssi is not None:
        weak = rssi is not None and rssi <= WEAK_RSSI
        out.append(("Wi-Fi", "%s %s" % (ssid or "?", "%d dBm" % rssi if rssi is not None else ""),
                    "warn" if weak else "muted"))
    elif ip:
        out.append(("Link", "wired", "muted"))

    t = snap.get("temp_c")
    if t is not None:
        out.append(("Temp", "%.0f °C" % t, "bad" if t >= HOT_C else "warn" if t >= WARM_C else "muted"))
    free, total = snap.get("disk_free_mb"), snap.get("disk_total_mb")
    if free is not None:
        out.append(("Disk", "%s free of %s" % (_mb(free), _mb(total)), "bad" if free < LOW_DISK_MB else "muted"))
    rf, rt = snap.get("ram_free_mb"), snap.get("ram_total_mb")
    if rf is not None:
        out.append(("RAM", "%s free of %s" % (_mb(rf), _mb(rt)), "muted"))
    if snap.get("uptime_s") is not None:
        out.append(("Up", _uptime(snap["uptime_s"]), "muted"))

    err = snap.get("last_error")
    if err:
        at, msg, level = (tuple(err) + ("error",))[:3]
        age = now - at
        tone = "muted" if age >= ERROR_FRESH_S else "bad" if level == "error" else "warn"
        out.append(("Error" if level == "error" else "Warning", "%s · %s" % (_ago(age), msg), tone))
    return out


def view(snap, now):
    title, tone = headline(snap)
    return {"title": title, "tone": tone, "rows": rows(snap, now),
            "big": str(snap.get("pairing_code") or "") if snap.get("state") == "pairing" else "",
            "footer": "v%s" % snap["version"] if snap.get("version") else ""}
