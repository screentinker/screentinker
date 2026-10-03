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
   player" from the on-screen menu: the helper stands down until the next logon.
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
import urllib.parse
import urllib.request

PIPE = r"\\.\pipe\screentinker-helper"
PROGRAM_DATA = os.path.join(os.environ.get("ProgramData", r"C:\ProgramData"), "ScreenTinker")
CONFIG = os.path.join(PROGRAM_DATA, "config.json")
UNINSTALL_KEY = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{7C2B3E3A-5D0B-4B5E-9F7A-5C1D2E3F4A5B}_is1"
EXIT_BY_OPERATOR = 42
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


def load_config():
    try:
        with open(CONFIG, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


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


def watchdog(stop):
    import win32con
    import win32event
    import win32process
    import win32profile
    import win32ts
    proc = None
    launched_at = 0.0
    session_seen = None
    backoff = 3
    suppressed_session = None
    while not stop.wait(3):
        cfg = load_config()
        if cfg.get("autostart", True) is False or not cfg.get("server_url"):
            continue
        sess = win32ts.WTSGetActiveConsoleSessionId()
        if sess == 0xFFFFFFFF:
            continue
        if sess != session_seen:
            session_seen = sess
            suppressed_session = None
            backoff = 3
        if proc is not None:
            if win32event.WaitForSingleObject(proc, 0) == win32con.WAIT_TIMEOUT:
                continue                                       # still running
            code = win32process.GetExitCodeProcess(proc)
            proc = None
            if time.monotonic() - launched_at > 120:
                backoff = 3          # it ran a good while: this is a fresh failure, not a crash loop
            if code == EXIT_BY_OPERATOR:
                log.info("player exited by operator: not relaunching until the next logon")
                suppressed_session = sess
                continue
            log.warning("player exited (%s): relaunching in %ss", code, backoff)
            if stop.wait(backoff):
                break
            backoff = min(backoff * 2, 60)
        if suppressed_session == sess:
            continue
        try:
            token = win32ts.WTSQueryUserToken(sess)             # no one logged on -> error, try later
        except Exception:
            continue
        try:
            env = win32profile.CreateEnvironmentBlock(token, False)
            si = win32process.STARTUPINFO()
            si.lpDesktop = "winsta0\\default"
            exe = player_exe()
            hp, ht, pid, tid = win32process.CreateProcessAsUser(
                token, exe, '"%s"' % exe, None, None, False,
                win32con.CREATE_UNICODE_ENVIRONMENT | win32con.NORMAL_PRIORITY_CLASS,
                env, os.path.dirname(exe), si)
            proc = hp
            launched_at = time.monotonic()
            log.info("launched player pid %s in session %s", pid, sess)
        except Exception as e:
            log.warning("launch failed: %s", e)
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
