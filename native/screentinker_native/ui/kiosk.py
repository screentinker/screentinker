"""Walk-up interactive web page (#473) — the native twin of Android's KioskSession.kt.

One instance per player, on the Qt thread. show() mounts a FRESH full-screen WebEngineView
(ui/qml/KioskLayer.qml) for every appearance of an interactive item, with its OWN off-the-record
QQuickWebEngineProfile, and hide() destroys both. That is the wipe, and a stronger one than
Android's: cookies, local/session storage, IndexedDB, the HTTP cache, service workers, form data,
history and HTTP auth all live in that profile's memory and nowhere else, so they are gone when it
is, and a power cut mid-session leaves nothing on disk to recover. (Android's web storage is
process-wide and has to be deleted item by item.) The pure rules live in logic/kiosk.py.

keepConsent (v2): the profile's QWebEngineCookieStore reports every cookie with its real domain
(cookieAdded/cookieRemoved). Before the profile goes, the cookies whose NAMES match keep_patterns
and whose domain is an allowed site are kept — by name only, never "every cookie of the allowed
domain", which would keep the visitor's login — written to <state>/kiosk-consent.json, and set into
the next appearance's fresh profile before its first load.

Hooks back into the player (engine/app):
  hold()     first touch: hold the playlist on this item
  release()  session over (reset, failure during a session): advance the playlist
  skip()     the page could not be shown and nobody was using it: advance now
  error(reason, detail)   a failure worth a dashboard incident (already throttled)
  session_end(record)     one usage record per visitor session
"""

import json
import logging
import os
import time
import uuid

from PySide6.QtCore import QByteArray, QDateTime, QObject, QTimer, QUrl
from PySide6.QtNetwork import QNetworkCookie

from ..logic import kiosk as K

log = logging.getLogger("Kiosk")

TICK_MS = 500
PERSIST_EVERY_MS = 10_000
FAIL_BACKOFF_MIN_S, FAIL_BACKOFF_MAX_S = 5.0, 60.0
MEDIA_PROBE = "__stkiosk:media"

# Text selection and the long-press callout off (inputs stay selectable), and a light media probe:
# a video playing in the page is activity, so the idle timer does not cut it off mid-clip. Same CSS
# and cadence as Android's INJECT; the probe reports through the console (KioskLayer.qml forwards
# exactly this message), which needs no bridge object in the page.
INJECT = """(function(){
  try {
    var s = document.createElement('style');
    s.textContent = '*{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}input,textarea,[contenteditable]{-webkit-user-select:text;user-select:text}';
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {}
  if (window.__stKioskProbe) return;
  window.__stKioskProbe = setInterval(function(){
    try {
      var m = document.querySelectorAll('video,audio');
      for (var i = 0; i < m.length; i++) { if (!m[i].paused && !m[i].ended) { console.log('%s'); return; } }
    } catch (e) {}
  }, 5000);
})();""" % MEDIA_PROBE


def _now_ms():
    return int(time.time() * 1000)


class KioskSession(QObject):
    def __init__(self, stage, state_dir, hold, release, skip, error=None, session_end=None, user_agent=None):
        super().__init__()
        self.stage = stage
        self.state_dir = state_dir
        self.on_hold, self.on_release, self.on_skip = hold, release, skip
        self.on_error = error or (lambda r, d: None)
        self.on_session_end = session_end or (lambda r: None)
        self.user_agent = user_agent          # override for tests; else the profile's own UA
        self.consent_path = os.path.join(state_dir, "kiosk-consent.json")
        self.open_path = os.path.join(state_dir, "kiosk-open-session.json")
        self.profile = None
        self.config = None
        self.idle = None
        self.item_key = None
        self.widget_id = None
        self.touched = False
        self.failing = False
        self.session_id = None
        self.session_start_ms = 0
        self.pages = 0
        self.last_persist_ms = 0
        self.visited_hosts = []
        self.cookies = {}                     # (name, domain, path) -> QNetworkCookie, live store mirror
        self.current_url = None
        self.mount_seq = 0
        self.errors = K.ErrorThrottle()
        self._fails = {}                      # item key -> (count, last_failed_monotonic)
        self._pending_injected = 0
        self._tick = QTimer()
        self._tick.setInterval(TICK_MS)
        self._tick.timeout.connect(self._on_tick)
        self._mount_later = QTimer()
        self._mount_later.setSingleShot(True)
        self._mount_later.timeout.connect(self._mount_deferred)
        self._first_load = QTimer()
        self._first_load.setSingleShot(True)
        self._first_load.timeout.connect(self._load_start)
        stage.kiosk = self

    # ------------------------------------------------------------------ state
    @property
    def session_active(self):
        """True while a visitor is using the page. Read by the capture path (blank frames) and the
        remote touch/key handlers (refused)."""
        return self.idle is not None and self.idle.in_session()

    @property
    def is_showing(self):
        return self.item_key is not None

    def is_showing_item(self, key):
        return self.is_showing and self.item_key == key

    # ------------------------------------------------------------------ app start
    def recover(self):
        """App start. A session cut off by a crash or power cut still counts: it becomes an
        `interrupted` record with the last activity we saved. Nothing else needs wiping — the
        visitor's web state lived only in an off-the-record profile's memory."""
        rec = None
        try:
            with open(self.open_path, encoding="utf-8") as f:
                rec = json.load(f)
        except (OSError, ValueError):
            rec = None
        if isinstance(rec, dict) and rec.get("id"):
            log.info("previous interactive session was not ended — recorded as interrupted "
                     "(its web storage was in memory only, nothing on disk to wipe)")
            rec["end_reason"] = "interrupted"
            try:
                self.on_session_end(rec)
            except Exception:
                log.exception("session_end")
        self._clear_open_session()

    # ------------------------------------------------------------------ show / hide
    def show(self, key, cfg, widget_id=None):
        if self.is_showing_item(key):
            return                            # same item re-issued (playlist refresh): keep the visitor's page
        self.hide()
        self.item_key = key
        self.config = cfg
        self.widget_id = widget_id
        self.visited_hosts = []
        self.idle = K.Idle(cfg.idle_timeout_sec * 1000, cfg.warn_sec * 1000)
        self.touched = False
        self.failing = False
        self.current_url = None
        self.stage.set("kioskOverlay", "")
        self.stage.set("kioskCard", "")
        self.stage.set("kioskHome", False)
        self.stage.set("kioskZoom", cfg.zoom_pct / 100.0)
        self.stage.set("kioskShown", True)
        # A page that just failed comes round again on a one-item playlist straight away: back off
        # instead of hammering a dead site (and the screen) in a tight loop.
        n, at = self._fails.get(key, (0, 0.0))
        if n:
            wait = min(FAIL_BACKOFF_MAX_S, FAIL_BACKOFF_MIN_S * (2 ** (n - 1))) - (time.monotonic() - at)
            if wait > 0:
                log.info("interactive page failed recently — retrying in %ds", int(wait + 0.5))
                self._mount_later.start(int(wait * 1000))
                return
        self._mount()

    def _mount_deferred(self):
        if self.config is not None and self.profile is None:
            self._mount()

    def _mount(self):
        cfg = self.config
        self.mount_seq += 1
        self.profile = self._new_profile()
        ua = self.user_agent or (self.profile.httpUserAgent() if self.profile else "")
        if K.too_old(ua, cfg.min_webview):
            log.warning("web engine too old for %s (ua=%s, need %s) — showing card", cfg.url, ua, cfg.min_webview)
            self._report("webview_too_old", cfg.url, "Chrome %s, page needs %s" % (K.chrome_major(ua) or "?", cfg.min_webview))
            self._drop_profile()
            self.stage.set("kioskCard", K.CARD_TOO_OLD)
            return
        injected = self._inject_kept()
        log.info("interactive page: %s (idle %ds, domains %s, zoom %d%%%s)", cfg.url, cfg.idle_timeout_sec,
                 cfg.allowed_domains, cfg.zoom_pct, ", keeps consent cookies" if cfg.keep_consent else "")
        # Order matters (KioskLayer.qml): the mount number, then the profile, then mount — the view
        # is created once, with this profile as an initial value.
        self.stage.set("kioskSeq", self.mount_seq)
        self.stage.set("kioskProfile", self.profile)
        self.stage.set("kioskMounted", True)
        # The kept consent cookies must be in the store before the first request goes out:
        # setCookie is asynchronous, so wait for the store to report them (or 1 s at most).
        self._pending_injected = injected
        self._first_load.start(1000 if injected else 0)
        self._tick.start()

    def _load_start(self):
        if self.config is not None and self.profile is not None:
            self.stage.kioskLoad.emit(self.config.url)

    def hide(self, wipe=None, reason="interrupted"):
        """Leave the item. The profile goes with the view, so nothing a visitor did survives except
        the consent cookies keepConsent names."""
        if wipe is None:
            wipe = self.touched
        self._tick.stop()
        self._mount_later.stop()
        self._first_load.stop()
        self._finish_session(reason)
        had_view = self.profile is not None
        if had_view:
            self._save_kept(wipe)
        self.stage.set("kioskMounted", False)
        self.stage.set("kioskShown", False)
        self.stage.set("kioskOverlay", "")
        self.stage.set("kioskCard", "")
        self.stage.set("kioskHome", False)
        self._drop_profile()
        if had_view and wipe:
            log.info("web storage wiped")
        if self.idle is not None:
            self.idle.end()
        self.idle = None
        self.item_key = None
        self.config = None
        self.widget_id = None
        self.touched = False                  # the next hide() must not wipe again for this visitor
        self.current_url = None

    # ------------------------------------------------------------------ profile + cookies
    def _new_profile(self):
        from PySide6.QtWebEngineQuick import QQuickWebEngineProfile
        p = QQuickWebEngineProfile()          # no storage name: OFF THE RECORD — memory only
        try:
            p.setOffTheRecord(True)
        except Exception:
            pass
        try:
            p.setHttpCacheType(QQuickWebEngineProfile.HttpCacheType.MemoryHttpCache)
            p.setPersistentCookiesPolicy(QQuickWebEngineProfile.PersistentCookiesPolicy.NoPersistentCookies)
        except Exception:
            pass
        self.cookies = {}
        store = p.cookieStore()
        seq = self.mount_seq
        store.cookieAdded.connect(lambda c, s=seq: self._cookie_added(s, c))
        store.cookieRemoved.connect(lambda c, s=seq: self._cookie_removed(s, c))
        p.downloadRequested.connect(self._download_requested)
        return p

    def _drop_profile(self):
        p, self.profile = self.profile, None
        self.stage.set("kioskProfile", None)
        self.cookies = {}
        if p is not None:
            # The view is being unloaded by the same property change; the profile must outlive the
            # page that uses it, so it goes a beat later.
            QTimer.singleShot(1500, p.deleteLater)

    @staticmethod
    def _ckey(c):
        name = bytes(c.name().data()).decode("utf-8", "replace")
        return (name, (c.domain() or "").lower(), c.path() or "/")

    def _cookie_added(self, seq, c):
        if seq != self.mount_seq:
            return
        self.cookies[self._ckey(c)] = QNetworkCookie(c)
        if self._pending_injected > 0:
            self._pending_injected -= 1
            if self._pending_injected == 0 and self._first_load.isActive():
                self._first_load.start(0)

    def _cookie_removed(self, seq, c):
        if seq != self.mount_seq:
            return
        self.cookies.pop(self._ckey(c), None)

    def _cookie_records(self):
        out = []
        for (name, dom, path), c in self.cookies.items():
            out.append({"name": name, "domain": dom, "path": path,
                        "raw": bytes(c.toRawForm(QNetworkCookie.RawForm.Full).data()).decode("utf-8", "replace")})
        return out

    def _save_kept(self, wiped):
        cfg = self.config
        if cfg is None:
            return
        if cfg.keep_consent:
            kept = K.kept_cookies(self._cookie_records(), cfg, self.visited_hosts)
        elif wiped:
            kept = []                         # a visitor used a page that keeps nothing: nothing survives
        else:
            return                            # untouched, keeps nothing: leave another page's consent alone
        try:
            if kept:
                K.atomic_write(self.consent_path, json.dumps(kept))
            elif os.path.exists(self.consent_path):
                os.unlink(self.consent_path)
        except OSError as e:
            log.warning("could not save the consent cookies: %s", e)
        if kept and wiped:
            log.info("kept %d consent cookie(s): %s", len(kept), sorted({k["name"] for k in kept}))

    def _inject_kept(self):
        cfg = self.config
        if not cfg.keep_consent or self.profile is None:
            return 0
        try:
            with open(self.consent_path, encoding="utf-8") as f:
                saved = json.load(f)
        except (OSError, ValueError):
            return 0
        # Re-filter against THIS config: a page that keeps nothing, or a changed allowlist, must not
        # inherit cookies kept under another one.
        recs = K.kept_cookies(saved if isinstance(saved, list) else [], cfg)
        store = self.profile.cookieStore()
        n = 0
        expiry = QDateTime.currentDateTimeUtc().addSecs(K.KEEP_MAX_AGE_SEC)
        for r in recs:
            try:
                parsed = QNetworkCookie.parseCookies(QByteArray(r["raw"].encode("utf-8")))
            except Exception:
                parsed = []
            if not parsed:
                continue
            c = parsed[0]
            c.setExpirationDate(expiry)
            host = r["domain"].lstrip(".")
            store.setCookie(c, QUrl("https://%s/" % host))
            n += 1
        return n

    def _download_requested(self, req):
        try:
            log.warning("download blocked: %s", req.url().toString())
            req.cancel()
        except Exception:
            pass

    # ------------------------------------------------------------------ from the view (KioskLayer.qml)
    def nav_allowed(self, url, main_frame):
        cfg = self.config
        if cfg is None:
            return False
        # Top-level only: subframes and subresources are not filtered, or most shops break.
        if not main_frame or K.is_allowed(url, cfg.allowed_domains):
            return True
        log.warning("navigation blocked: %s", url)
        return False

    def new_window(self, url):
        """window.open / target=_blank: load in THIS view (the allowlist then applies), never a window."""
        if self.config is None:
            return
        if K.is_allowed(url, self.config.allowed_domains):
            self.stage.kioskLoad.emit(url)
        else:
            log.warning("navigation blocked: %s", url)

    def user_input(self):
        """A press/touch/key anywhere on the window while the page is up (Stage's event filter)."""
        if self.profile is not None or self.stage.kioskOverlay:
            self._activity(touch=True)

    def media_playing(self):
        self._activity(touch=False)

    def url_changed(self, url, is_reload=False):
        cfg = self.config
        if cfg is None:
            return
        self.current_url = url
        host = K.host_of(url)
        if host and host not in self.visited_hosts and K.is_allowed(url, cfg.allowed_domains):
            self.visited_hosts.append(host)
        if self.session_active and not is_reload and url and url != "about:blank":
            self.pages += 1
        self._update_home()

    def load_finished(self, url, ok, status, detail):
        """status: 0 ok, else an HTTP status (>= 400) or -1 for a network-level failure."""
        if self.config is None:
            return
        if ok:
            log.info("page loaded: %s", url)
            self.stage.kioskJs.emit(INJECT)
            self._fails.pop(self.item_key, None)
            return
        if status >= 400:
            self._fail("http_error", url, "HTTP %d" % status)
        else:
            self._fail("load_error", url, "load error %s" % detail)

    def renderer_gone(self, detail):
        if self.config is None:
            return
        # The dead view is dropped by the (posted) hide in _fail — never from inside its own signal.
        self._fail("renderer_gone", self.config.url, "renderer gone (%s)" % detail)

    def home(self, touch=True):
        cfg = self.config
        if cfg is None:
            return
        if touch:
            self._activity(touch=True)
        log.info("home button — back to %s", cfg.url)
        self.stage.kioskLoad.emit(cfg.url)

    def overlay_tapped(self):
        self._activity(touch=True)

    # ------------------------------------------------------------------ the session clock
    def _activity(self, touch):
        k = self.idle
        if k is None:
            return
        now = _now_ms()
        self._apply(k.on_touch(now) if touch else k.keep_alive(now))
        # Keep the crash-recovery copy of the open session roughly current.
        if self.session_id and now - self.last_persist_ms >= PERSIST_EVERY_MS:
            self.last_persist_ms = now
            self._save_open_session()

    def _on_tick(self):
        k = self.idle
        if k is None:
            self._tick.stop()
            return
        self._apply(k.tick(_now_ms()))

    def _apply(self, a):
        if a == "started":
            self.touched = True
            self.session_id = str(uuid.uuid4())
            self.session_start_ms = _now_ms()
            self.pages = 1
            self.last_persist_ms = self.session_start_ms
            self._save_open_session()
            log.info("session started — playlist held")
            self.on_hold()
        elif isinstance(a, dict) and "warn" in a:
            if not self.stage.kioskOverlay:
                log.info("idle — \"Still there?\" countdown %ds", a["warn"])
            self.stage.set("kioskOverlay", "Still there?\nTap to keep browsing — resetting in %ds" % a["warn"])
        elif a == "resumed":
            self.stage.set("kioskOverlay", "")
        elif a == "reset":
            log.info("session idle — wiping and moving on")
            self.hide(wipe=True, reason="idle")
            self.on_release()

    def _finish_session(self, reason):
        sid = self.session_id
        if not sid:
            return
        start = self.session_start_ms
        last = max(self.idle.last_activity if self.idle else start, start)
        self.session_id = None
        self.session_start_ms = 0
        r = K.make_session(sid, self.widget_id, start // 1000, (last - start) // 1000, reason, self.pages)
        self._clear_open_session()
        log.info("session ended (%s) after %ds, %d page(s)", reason, r["duration_sec"], r["pages"])
        try:
            self.on_session_end(r)
        except Exception:
            log.exception("session_end")

    def _save_open_session(self):
        if not self.session_id:
            return
        last = self.idle.last_activity if self.idle else self.session_start_ms
        r = K.make_session(self.session_id, self.widget_id, self.session_start_ms // 1000,
                           (last - self.session_start_ms) // 1000, "interrupted", self.pages)
        try:
            K.atomic_write(self.open_path, json.dumps(r))
        except OSError:
            pass

    def _clear_open_session(self):
        try:
            os.unlink(self.open_path)
        except OSError:
            pass

    def _update_home(self):
        cfg = self.config
        if cfg is None or not cfg.home_button:
            self.stage.set("kioskHome", False)
            return
        self.stage.set("kioskHome", self.profile is not None and not K.is_start_page(self.current_url, cfg.url))

    # ------------------------------------------------------------------ failures
    def _report(self, reason, url, detail):
        if not self.errors.should_report(reason, url, _now_ms()):
            return
        where = K.host_of(url) or url or ""
        try:
            self.on_error(reason, ((where + ": ") if where else "") + detail)
        except Exception:
            log.exception("error report")

    def _fail(self, reason, url, why):
        """The page failed or crashed. Nobody using it: skip it. Someone using it: end their session."""
        if self.failing:
            return                            # one failure per page; errors arrive in bursts
        self.failing = True
        key = self.item_key
        n, _ = self._fails.get(key, (0, 0.0))
        self._fails[key] = (n + 1, time.monotonic())
        log.warning("interactive page unavailable (%s)", why)
        self._report(reason, url, why)

        def later():
            if self.item_key != key:
                return                        # already replaced by another item
            was = self.session_active
            self.hide(wipe=self.touched, reason="error")
            if was:
                self.on_release()
            else:
                self.on_skip()
        # Posted: tearing a view down from inside its own signal handler can crash it.
        QTimer.singleShot(0, later)
