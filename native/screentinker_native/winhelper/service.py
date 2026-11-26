"""ScreenTinkerHelper — the Windows service (LocalSystem) that is the player's only door to privilege,
and its watchdog. The Windows twin of Linux's st-helper + `Restart=always`.

1. PRIVILEGED VERBS over \\\\.\\pipe\\screentinker-helper, one JSON request and one JSON reply per
   connection. A FIXED verb list; every argument re-validated here. Only the installed player binary
   may call it (_client_allowed: the caller's image path must be ScreenTinker.exe beside this helper,
   in admin-only Program Files) — tighter than the Linux sudoers grant to %screentinker.

   ⚠️ `install` is the dangerous one: running an installer as SYSTEM is the whole machine. The player
   user can write to its own OTA folder, so a path from it proves nothing. The helper therefore
   fetches the latest package's sha256 ITSELF from the server in the ADMIN-writable config
   (ProgramData\\ScreenTinker\\config.json — never the player's state, which set_server_url rewrites
   and the player user can edit), and runs the file only on a match. Any other package runs only when
   the operator opted in at install time (allow_package_install), exactly as on the Pi.

2. WATCHDOG: the player must run in the interactive user's session (a service lives in session 0 and
   cannot show anything), so the helper launches it with CreateProcessAsUser into the active console
   session and relaunches it if it dies, with backoff. Exit code 42 means an operator chose "Exit
   player" from the on-screen menu: the helper stands down until the next logon. config.json's
   "players" list runs one player per monitor (#927, player_specs); without it, one player as ever.
"""

import hashlib
import json
import logging
import logging.handlers
import os
import re
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
import urllib.request

PIPE = r"\\.\pipe\screentinker-helper"
PROGRAM_DATA = os.path.join(os.environ.get("ProgramData", r"C:\ProgramData"), "ScreenTinker")
CONFIG = os.path.join(PROGRAM_DATA, "config.json")
UNINSTALL_KEY = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{7C2B3E3A-5D0B-4B5E-9F7A-5C1D2E3F4A5B}_is1"
EXIT_BY_OPERATOR = 42
EXIT_ALREADY_RUNNING = 43     # app.py: another player of that instance already holds the session lock
ALREADY_RUNNING_RECHECK = 30  # seconds between tries while a hand-started player holds the lock
WATCHDOG_STALL = 120          # seconds without a finished watchdog pass before the helper restarts itself
CREATE_NO_WINDOW = 0x08000000
DETACHED_PROCESS = 0x00000008

log = logging.getLogger("helper")


def _setup_logging():
    os.makedirs(PROGRAM_DATA, exist_ok=True)
    h = logging.handlers.RotatingFileHandler(os.path.join(PROGRAM_DATA, "helper.log"), maxBytes=1_000_000,
                                             backupCount=2, encoding="utf-8")
    h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logging.getLogger().addHandler(h)
    logging.getLogger().setLevel(logging.INFO)


_last_config_problem = None


def load_config():
    # utf-8-sig: an admin editing config.json with PowerShell 5 (Set-Content -Encoding UTF8) or an editor
    # that writes a BOM must not leave the helper reading {} and silently starting no player (#927).
    # A file that doesn't parse (a missing comma) still reads as {}, but the log now says where, once
    # per change rather than every 3s pass.
    global _last_config_problem
    try:
        with open(CONFIG, encoding="utf-8-sig") as f:
            text = f.read()
        v = json.loads(text)
        problem = None if isinstance(v, dict) else "%s must hold one { ... } object" % CONFIG
    except FileNotFoundError:
        v, problem = {}, None
    except json.JSONDecodeError as e:
        v, problem = {}, "%s has an error on line %d, column %d: %s (no player starts until it is fixed)" % (
            CONFIG, e.lineno, e.colno, e.msg)
    except (OSError, ValueError) as e:
        v, problem = {}, "%s can't be read: %s" % (CONFIG, e)
    if problem != _last_config_problem:
        if problem:
            log.error(problem)
        elif _last_config_problem:
            log.info("%s reads fine again", CONFIG)
        _last_config_problem = problem
    return v if isinstance(v, dict) else {}


def run(argv, timeout=60):
    p = subprocess.run(argv, capture_output=True, timeout=timeout, creationflags=CREATE_NO_WINDOW)
    return p.returncode == 0, (p.stdout + p.stderr).decode(errors="replace").strip()


# --------------------------------------------------------------------------- verbs

def v_reboot(args):
    return run(["shutdown", "/r", "/t", "5", "/c", "ScreenTinker: remote reboot"])


def v_poweroff(args):
    return run(["shutdown", "/s", "/t", "5", "/c", "ScreenTinker: remote shutdown"])


def v_set_time(args):
    ms = args[0] if args else ""
    if not re.fullmatch(r"\d{10,14}", ms):
        return False, "set-time: epoch milliseconds expected"
    # Android's owner setTime refuses while automatic time is on; here the equivalent is that the
    # time service would undo the change, so sync is switched off and the caller is told so.
    run(["reg", "add", r"HKLM\SYSTEM\CurrentControlSet\Services\W32Time\Parameters", "/v", "Type",
         "/t", "REG_SZ", "/d", "NoSync", "/f"])
    run(["net", "stop", "w32time"])
    import datetime
    t = datetime.datetime.fromtimestamp(int(ms) / 1000, datetime.timezone.utc).astimezone()
    ok, out = run(["powershell", "-NoProfile", "-Command", "Set-Date -Date '%s'" % t.strftime("%Y-%m-%dT%H:%M:%S%z")])
    return ok, "clock set; automatic time sync disabled (re-enable: set-ntp on)" if ok else out


def v_set_ntp(args):
    on = (args[0] if args else "") == "on"
    if (args[0] if args else "") not in ("on", "off"):
        return False, "set-ntp: on|off"
    run(["reg", "add", r"HKLM\SYSTEM\CurrentControlSet\Services\W32Time\Parameters", "/v", "Type",
         "/t", "REG_SZ", "/d", "NTP" if on else "NoSync", "/f"])
    if on:
        run(["net", "start", "w32time"])
        return run(["w32tm", "/resync", "/force"])
    return run(["net", "stop", "w32time"])


def v_set_timezone(args):
    tz = args[0] if args else ""
    if not re.fullmatch(r"[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+){0,2}", tz):
        return False, "set-timezone: bad zone name"
    # The payload speaks IANA; tzutil speaks Windows zone ids. tzlocal carries the CLDR mapping.
    from tzlocal.windows_tz import tz_win
    win = tz_win.get(tz)
    if not win:
        return False, "set-timezone: no Windows zone for %s" % tz
    return run(["tzutil", "/s", win])


def v_set_screen_timeout(args):
    ms = args[0] if args else ""
    if not re.fullmatch(r"\d{1,10}", ms):
        return False, "set-screen-timeout: milliseconds expected"
    minutes = str((int(ms) + 59999) // 60000) if int(ms) > 0 else "0"
    ok1, o1 = run(["powercfg", "/change", "monitor-timeout-ac", minutes])
    ok2, o2 = run(["powercfg", "/change", "monitor-timeout-dc", minutes])
    return ok1 and ok2, "monitor timeout %s min" % minutes if ok1 else o1


def _uninstall_flag(value):
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, UNINSTALL_KEY, 0, winreg.KEY_SET_VALUE | winreg.KEY_WOW64_64KEY) as k:
            winreg.SetValueEx(k, "NoRemove", 0, winreg.REG_DWORD, value)
            winreg.SetValueEx(k, "NoModify", 0, winreg.REG_DWORD, value)
        return True, "uninstall %s" % ("blocked" if value else "allowed")
    except OSError as e:
        return False, "uninstall key not found: %s" % e


def v_hold(args):
    return _uninstall_flag(1)


def v_unhold(args):
    return _uninstall_flag(0)


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def v_install(args):
    path = os.path.abspath(args[0]) if args else ""
    if not os.path.isfile(path) or not path.lower().endswith((".exe", ".msi")):
        return False, "install: an existing .exe or .msi path is required"
    cfg = load_config()
    server = (cfg.get("server_url") or "").rstrip("/")
    digest = _sha256(path)
    trusted = False
    if server:
        try:
            with urllib.request.urlopen(server + "/api/win/update/check?" + urllib.parse.urlencode(
                    {"version": "0.0.0", "forced": "1"}), timeout=30) as r:
                info = json.load(r)
            trusted = bool(info.get("sha256")) and info["sha256"].lower() == digest
        except Exception as e:
            log.warning("install: could not reach %s to verify: %s", server, e)
    if not trusted and not cfg.get("allow_package_install"):
        return False, ("install refused: this file is not the ScreenTinker release %s announces, and "
                       "allow_package_install is off" % (server or "(no server configured)"))
    if path.lower().endswith(".msi"):
        argv = ["msiexec", "/i", path, "/qn", "/norestart"]
    elif trusted:
        # Our own Inno Setup package: silent, no reboot, and it restarts the player itself.
        argv = [path, "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"]
    else:
        argv = [path, "/S", "/quiet"]
    # Detached: upgrading ScreenTinker stops THIS service, which must not take the installer down.
    subprocess.Popen(argv, creationflags=DETACHED_PROCESS | CREATE_NO_WINDOW, close_fds=True)
    log.info("install started: %s (%s)", os.path.basename(path), "release" if trusted else "operator-allowed")
    return True, "install of %s started" % os.path.basename(path)


VERBS = {
    "reboot": v_reboot, "poweroff": v_poweroff, "set-time": v_set_time, "set-ntp": v_set_ntp,
    "set-timezone": v_set_timezone, "set-screen-timeout": v_set_screen_timeout,
    "hold": v_hold, "unhold": v_unhold, "install": v_install,
}


def handle(request):
    try:
        req = json.loads(request.decode("utf-8"))
        verb = str(req.get("verb") or "")
        args = [str(a) for a in (req.get("args") or [])][:4]
    except (ValueError, AttributeError):
        return {"ok": False, "out": "bad request"}
    fn = VERBS.get(verb)
    if fn is None:
        return {"ok": False, "out": "unknown verb '%s'" % verb[:40]}
    try:
        ok, out = fn(args)
    except Exception as e:
        log.exception("verb %s", verb)
        ok, out = False, "%s failed: %s" % (verb, e)
    log.info("verb %s -> %s", verb, "ok" if ok else "fail")
    return {"ok": bool(ok), "out": str(out)[:2000]}


# --------------------------------------------------------------------------- pipe server

def _pipe_security():
    """Who may OPEN the pipe: SYSTEM, Administrators, INTERACTIVE users. Well-known SIDs, not names —
    "Administrators" is translated on non-English Windows and a name lookup would silently fail there.

    ⚠️ Not the "ScreenTinker Players" group alone: a logon token never gains a group added after logon,
    and the installer runs while the kiosk user is already logged on — the player was refused with
    "Permission denied" until the next logon (found in the Win11 VM). Opening is therefore broad, and
    the real check is per connection: _client_allowed()."""
    import ntsecuritycon
    import win32security
    sa = win32security.SECURITY_ATTRIBUTES()
    sd = win32security.SECURITY_DESCRIPTOR()
    dacl = win32security.ACL()
    rw = ntsecuritycon.GENERIC_READ | ntsecuritycon.GENERIC_WRITE
    for sid in ("S-1-5-18", "S-1-5-32-544", "S-1-5-4"):
        dacl.AddAccessAllowedAce(win32security.ACL_REVISION, rw, win32security.ConvertStringSidToSid(sid))
    sd.SetSecurityDescriptorDacl(1, dacl, 0)
    sa.SECURITY_DESCRIPTOR = sd
    return sa


def _client_allowed(h):
    """The caller must BE the installed player: its image path equals ScreenTinker.exe next to this
    helper, in Program Files, which only administrators can write. Tighter than a group — another
    program running as the same kiosk user (the remote shell, say) cannot use the helper at all."""
    import win32api
    import win32con
    import win32pipe
    import win32process
    try:
        pid = win32pipe.GetNamedPipeClientProcessId(h)
        ph = win32api.OpenProcess(win32con.PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        try:
            path = win32process.GetModuleFileNameEx(ph, 0)
        finally:
            win32api.CloseHandle(ph)
    except Exception as e:
        log.warning("pipe: could not identify the client: %s", e)
        return False
    ok = os.path.normcase(os.path.abspath(path)) == os.path.normcase(os.path.abspath(player_exe()))
    if not ok:
        log.warning("pipe: refused client pid %s (%s)", pid, path)
    return ok


def pipe_server(stop):
    import pywintypes
    import win32file
    import win32pipe
    sa = _pipe_security()
    while not stop.is_set():
        h = win32pipe.CreateNamedPipe(
            PIPE, win32pipe.PIPE_ACCESS_DUPLEX,
            win32pipe.PIPE_TYPE_BYTE | win32pipe.PIPE_READMODE_BYTE | win32pipe.PIPE_WAIT |
            win32pipe.PIPE_REJECT_REMOTE_CLIENTS,
            win32pipe.PIPE_UNLIMITED_INSTANCES, 65536, 65536, 0, sa)
        try:
            win32pipe.ConnectNamedPipe(h, None)
            if stop.is_set():
                continue                        # SvcStop's own unblocking pokes, not clients
            if not _client_allowed(h):
                win32file.WriteFile(h, (json.dumps({"ok": False, "out": "not the ScreenTinker player"}) + "\n").encode())
                continue
            buf = b""
            while not buf.endswith(b"\n") and len(buf) < 65536:
                _, chunk = win32file.ReadFile(h, 65536)
                if not chunk:
                    break
                buf += chunk
            reply = handle(buf)
            win32file.WriteFile(h, (json.dumps(reply) + "\n").encode())
            win32file.FlushFileBuffers(h)
        except pywintypes.error as e:
            if not stop.is_set():
                log.info("pipe client error: %s", e)
        finally:
            try:
                win32pipe.DisconnectNamedPipe(h)
            except pywintypes.error:
                pass
            win32file.CloseHandle(h)


# --------------------------------------------------------------------------- watchdog

def player_exe():
    base = os.path.dirname(sys.executable) if getattr(sys, "frozen", False) else os.path.dirname(__file__)
    return os.path.join(base, "ScreenTinker.exe")


_INSTANCE_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
_DISPLAY_RE = re.compile(r"^[A-Za-z0-9@,._ -]{1,64}$")
MAX_PLAYERS = 4


def player_specs(cfg):
    """The players this PC runs, as [(key, [extra args])], from config.json's "players" (#927).

    No "players" (every install so far): ONE player with no arguments, exactly as before. With it, one
    entry per screen, for example
        "players": [{"display": "@0,0"}, {"instance": "2", "display": "@1920,0"}]
    "instance" ('' or absent = the machine's first player, which keeps its existing pairing) gives an
    extra player its own pairing and state; "display" is N, @X,Y or part of a monitor's name/serial
    (ui/screen_pick.py). Anything malformed is skipped and logged, never passed to a command line:
    the values are interpolated into CreateProcessAsUser's command line, so only plain characters pass.
    """
    raw = cfg.get("players")
    if not isinstance(raw, list) or not raw:
        return [("", [])]
    out, seen = [], set()
    for p in raw[:MAX_PLAYERS]:
        if not isinstance(p, dict):
            log.warning("players: skipping %r (not an object)", p)
            continue
        inst = str(p.get("instance") or "").strip()
        disp = str(p.get("display") if p.get("display") is not None else "").strip()
        if inst and not _INSTANCE_RE.match(inst):
            log.warning("players: skipping instance %r (letters, digits, - and _ only)", inst)
            continue
        if disp and not _DISPLAY_RE.match(disp):
            log.warning("players: skipping display %r", disp)
            continue
        if inst in seen:
            log.warning("players: instance %r listed twice; using the first", inst or "(first)")
            continue
        seen.add(inst)
        args = []
        if inst:
            args += ["--instance", inst]
        if disp:
            args += ["--display", disp]
        out.append((inst, args))
    return out or [("", [])]


def command_line(exe, args):
    """CreateProcessAsUser's command line. Every arg passed player_specs' character check, so quoting
    the exe path and any arg with a space is enough."""
    return " ".join(['"%s"' % exe] + [('"%s"' % a) if " " in a else a for a in args])


def describe_specs(specs):
    """One line for the log: which players the helper is running, and on which screen (#927)."""
    if specs == [("", [])]:
        return 'no "players" list in %s: one player on the main screen' % CONFIG
    parts = []
    for key, args in specs:
        disp = args[args.index("--display") + 1] if "--display" in args else "the main screen"
        parts.append("%s on %s" % (key or "first", disp))
    return "players from %s: %s" % (CONFIG, "; ".join(parts))


_last_specs = None


def log_specs_if_changed(specs):
    """Log the player list at start and whenever an edit to config.json changes it, never every pass."""
    global _last_specs
    if specs != _last_specs:
        log.info("%s", describe_specs(specs))
        _last_specs = specs


class _Slot:
    """One supervised player: its process, backoff, and whether an operator exited it this logon."""
    def __init__(self, key, args):
        self.key, self.args = key, args
        self.proc = None
        self.launched_at = 0.0
        self.backoff = 3
        self.retry_at = 0.0
        self.suppressed_session = None
        self.blocked = False      # a player started outside the helper holds this instance's lock

    @property
    def name(self):
        return self.key or "first"

    def exited(self, code, now, sess):
        """Book-keeping when the supervised process has exited with `code`; schedules any relaunch."""
        self.proc = None
        if now - self.launched_at > 120:
            self.backoff = 3       # it ran a good while: this is a fresh failure, not a crash loop
        if code == EXIT_BY_OPERATOR:
            log.info("player %s exited by operator: not relaunching until the next logon", self.name)
            self.suppressed_session = sess
            return
        if code == EXIT_ALREADY_RUNNING:
            # Not a crash: a copy started from the Start menu or a Startup shortcut holds the lock. Say so
            # once, then keep checking at a steady pace so the helper takes over as soon as it closes.
            if not self.blocked:
                log.warning("player %s: another ScreenTinker player%s is already running in this session, "
                            "started outside the ScreenTinker service (the Start menu, a Startup-folder "
                            "shortcut?). The service can't supervise it; close it, or sign out and back in, "
                            "and the service starts its own. Checking every %ss.",
                            self.name, (" (instance %s)" % self.key) if self.key else "",
                            ALREADY_RUNNING_RECHECK)
                self.blocked = True
            self.backoff = 3
            self.retry_at = now + ALREADY_RUNNING_RECHECK
            return
        log.warning("player %s exited (%s): relaunching in %ss", self.name, code, self.backoff)
        self.retry_at = now + self.backoff
        self.backoff = min(self.backoff * 2, 60)

    def still_running(self, now):
        """Called each pass while the process runs: clears the stand-down note once ours has the lock."""
        if self.blocked and now - self.launched_at > 10:
            log.info("player %s is running under the service now", self.name)
            self.blocked = False


_noted = {}


def note_once(topic, value, level, msg, *args, **kw):
    """Log `msg` only when `topic` moves to a new `value`, so a state the watchdog sees every 3 s pass
    ("no one signed in yet") is one line, not thousands. value None clears the topic without a line."""
    if _noted.get(topic) == value:
        return
    _noted[topic] = value
    if value is not None:
        log.log(level, msg, *args, **kw)


# The watchdog's last finished pass and its thread id, for stall_guard. #927: a field helper went
# silent after a sign-out (no launch, no error, for 50 minutes) while a hand-started player worked.
_beat = {"at": time.monotonic(), "thread": None}


def watchdog(stop):
    import win32con
    import win32event
    import win32process
    import win32profile
    import win32ts
    w = {"slots": {}, "session_seen": None,
         "api": (win32con, win32event, win32process, win32profile, win32ts)}
    _beat["thread"] = threading.get_ident()
    while not stop.wait(3):
        # One pass must never end the thread: an exception escaping here used to stop every relaunch
        # until the service restarted, with nothing in the log.
        try:
            _watchdog_pass(w)
            note_once("pass-error", None, 0, "")
        except Exception as e:
            note_once("pass-error", repr(e), logging.ERROR, "watchdog pass failed, retrying every 3s",
                      exc_info=True)
        _beat["at"] = time.monotonic()


def stall_problem(now, frames=None):
    """Why the watchdog needs a restart, or None. A pass blocked inside a Windows call (seen around a
    sign-out) cannot be interrupted from Python, so the only cure is a new helper process."""
    idle = now - _beat["at"]
    if idle <= WATCHDOG_STALL:
        return None
    frames = sys._current_frames() if frames is None else frames
    frame = frames.get(_beat["thread"])
    where = "".join(traceback.format_stack(frame)) if frame is not None else "  (the thread is gone)\n"
    return "watchdog has not finished a pass in %ds, so no player can be relaunched. It is at:\n%s" % (
        idle, where)


def stall_guard(stop, exit=os._exit):
    """Exit with an error when the watchdog is stuck: the service's failure actions (the installer's
    `sc failure ... restart/5000`) start a fresh helper, and the log keeps where it hung."""
    while not stop.wait(30):
        problem = stall_problem(time.monotonic())
        if problem:
            log.error("%sRestarting the helper.", problem)
            logging.shutdown()
            exit(1)


def _watchdog_pass(w):
    win32con, win32event, win32process, win32profile, win32ts = w["api"]
    slots = w["slots"]
    cfg = load_config()
    if cfg.get("autostart", True) is False:
        note_once("idle", "autostart", logging.INFO, '"autostart" is false in %s: not starting players', CONFIG)
        return
    if not cfg.get("server_url"):
        note_once("idle", "server_url", logging.INFO, 'no "server_url" in %s: not starting players', CONFIG)
        return
    note_once("idle", None, 0, "")
    sess = win32ts.WTSGetActiveConsoleSessionId()
    if sess == 0xFFFFFFFF:
        note_once("session", "none", logging.INFO, "no console session right now (switching users?)")
        return
    note_once("session", sess, logging.INFO, "console session is %s", sess)
    if sess != w["session_seen"]:
        w["session_seen"] = sess
        for sl in slots.values():
            sl.suppressed_session = None
            sl.backoff = 3
            sl.retry_at = 0.0
    # The wanted set is re-read every pass, so editing "players" needs no service restart: a new
    # entry starts within seconds; a removed one is left running until it exits, then not relaunched.
    wanted = player_specs(cfg)
    log_specs_if_changed(wanted)
    wanted_keys = {k for k, _ in wanted}
    for key, args in wanted:
        sl = slots.get(key)
        if sl is None:
            sl = slots[key] = _Slot(key, args)
        elif sl.args != args and sl.proc is None:
            sl.args = args
    for key in list(slots):
        if key not in wanted_keys and slots[key].proc is None:
            del slots[key]
    now = time.monotonic()
    for key, _ in wanted:
        sl = slots[key]
        name = key or "first"
        if sl.proc is not None:
            if win32event.WaitForSingleObject(sl.proc, 0) == win32con.WAIT_TIMEOUT:
                sl.still_running(now)
                continue
            sl.exited(win32process.GetExitCodeProcess(sl.proc), now, sess)
            continue
        if sl.suppressed_session == sess or now < sl.retry_at:
            continue
        try:
            token = win32ts.WTSQueryUserToken(sess)         # no one logged on -> error, try later
        except Exception as e:
            note_once("signin", sess, logging.INFO, "console session %s: no one is signed in yet (%s); "
                      "players start when someone signs in", sess, e)
            continue
        note_once("signin", None, 0, "")
        try:
            env = win32profile.CreateEnvironmentBlock(token, False)
            si = win32process.STARTUPINFO()
            si.lpDesktop = "winsta0\\default"
            exe = player_exe()
            hp, ht, pid, tid = win32process.CreateProcessAsUser(
                token, exe, command_line(exe, sl.args), None, None, False,
                win32con.CREATE_UNICODE_ENVIRONMENT | win32con.NORMAL_PRIORITY_CLASS,
                env, os.path.dirname(exe), si)
            sl.proc = hp
            sl.launched_at = time.monotonic()
            # While a hand-started copy holds the lock, each 30 s retry would add a line: keep it quiet.
            (log.debug if sl.blocked else log.info)("launched player %s pid %s in session %s %s",
                                                    name, pid, sess, sl.args)
        except Exception as e:
            log.warning("launch of player %s failed: %s", name, e)
        finally:
            token.Close()


# --------------------------------------------------------------------------- service shell

def _service_class():
    import servicemanager
    import win32event
    import win32service
    import win32serviceutil

    class ScreenTinkerHelper(win32serviceutil.ServiceFramework):
        _svc_name_ = "ScreenTinkerHelper"
        _svc_display_name_ = "ScreenTinker Helper"
        _svc_description_ = ("Privileged actions and watchdog for the ScreenTinker signage player "
                             "(reboot, clock, display timeout, updates). Fixed verb list only.")

        def __init__(self, args):
            super().__init__(args)
            self.stop_event = threading.Event()
            self.hWaitStop = win32event.CreateEvent(None, 0, 0, None)

        def SvcStop(self):
            self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
            self.stop_event.set()
            # Unblock each listener's ConnectNamedPipe with a throwaway client.
            for _ in range(2):
                try:
                    open(PIPE, "r+b").close()
                except OSError:
                    pass
            win32event.SetEvent(self.hWaitStop)

        def SvcDoRun(self):
            _setup_logging()
            log.info("helper starting")
            servicemanager.LogMsg(servicemanager.EVENTLOG_INFORMATION_TYPE, servicemanager.PYS_SERVICE_STARTED,
                                  (self._svc_name_, ""))
            # TWO listeners: each creates its next instance only after closing the last, so a single
            # one leaves moments with no instance at all, and a client probing then (WaitNamedPipe)
            # is told the helper does not exist. With two, one is always there.
            for _ in range(2):
                threading.Thread(target=pipe_server, args=(self.stop_event,), daemon=True).start()
            threading.Thread(target=watchdog, args=(self.stop_event,), daemon=True).start()
            threading.Thread(target=stall_guard, args=(self.stop_event,), daemon=True).start()
            win32event.WaitForSingleObject(self.hWaitStop, win32event.INFINITE)
            log.info("helper stopped")
    return ScreenTinkerHelper


def main():
    import servicemanager
    import win32serviceutil
    cls = _service_class()
    if len(sys.argv) == 1:
        # Started by the Service Control Manager.
        servicemanager.Initialize()
        servicemanager.PrepareToHostSingle(cls)
        servicemanager.StartServiceCtrlDispatcher()
    elif sys.argv[1] == "debug-foreground":
        _setup_logging()
        logging.getLogger().addHandler(logging.StreamHandler())
        stop = threading.Event()
        threading.Thread(target=watchdog, args=(stop,), daemon=True).start()
        pipe_server(stop)
    else:
        win32serviceutil.HandleCommandLine(cls)     # install / remove / start / stop


if __name__ == "__main__":
    main()
