"""Qt-thread helpers that are not the playlist: slide audio, the trigger overlay, the WebRTC page."""

import json
import logging
import secrets

from PySide6.QtCore import QTimer, QUrl
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer

log = logging.getLogger("extras")


class SlideAudio:
    """Android SlideAudioPlayer: a voiceover plays ONCE per item; the music bed loops and carries
    over an advance when music_id is unchanged; only a real stop ends the bed. URLs are made absolute
    against the server (the payload sends /uploads/...)."""

    def __init__(self, server_fn):
        self.server_fn = server_fn
        self.vo = QMediaPlayer()
        self.vo_out = QAudioOutput()
        self.vo.setAudioOutput(self.vo_out)
        self.music = QMediaPlayer()
        self.music_out = QAudioOutput()
        self.music.setAudioOutput(self.music_out)
        self.music.setLoops(QMediaPlayer.Loops.Infinite)
        self.music_id = None
        self.master = 1.0
        self.muted = False

    def _abs(self, u):
        if not u:
            return None
        if u.startswith(("http://", "https://")):
            return u
        base = (self.server_fn() or "").rstrip("/")
        return base + u if base else None

    def apply(self, audio, muted):
        self.muted = bool(muted)
        a = audio if isinstance(audio, dict) else {}
        vo = self._abs(a.get("vo_url"))
        self.vo.stop()
        if vo:
            self.vo.setSource(QUrl(vo))
            self.vo_out.setVolume(float(a.get("vo_volume", 1.0)) * self.master)
            self.vo_out.setMuted(self.muted)
            self.vo.play()
        mid = a.get("music_id") or None
        murl = self._abs(a.get("music_url"))
        if not murl:
            # A slide with no bed ends the bed; a non-slide item (no audio block) too.
            self.music.stop()
            self.music_id = None
        elif mid != self.music_id or self.music.playbackState() != QMediaPlayer.PlaybackState.PlayingState:
            self.music.stop()
            self.music.setSource(QUrl(murl))
            self.music_id = mid
            self.music.play()
        self.music_out.setVolume(float(a.get("music_volume", 0.4)) * self.master)
        self.music_out.setMuted(self.muted)

    def set_master(self, v, muted=None):
        self.master = v
        if muted is not None:
            self.vo_out.setMuted(muted or self.muted)
            self.music_out.setMuted(muted or self.muted)

    def stop(self):
        self.vo.stop()
        self.music.stop()
        self.music_id = None


class TriggerOverlay:
    """What a fired trigger shows (Android TriggerOverlay): its items, CACHED ONLY (a trigger is for
    when the network may be down), no YouTube, rotating; the overlay HAS audio while the base
    playlist is muted underneath. A bad clip skips instead of stopping the rotation."""

    def __init__(self, app):
        self.app = app
        self.items = []
        self.index = 0
        self.token = None
        self.timer = QTimer()
        self.timer.setSingleShot(True)
        self.timer.timeout.connect(self.next)
        self.once_timer = QTimer()
        self.once_timer.setSingleShot(True)
        self.once_timer.timeout.connect(self._once_done)

    def _once_done(self):
        self.app.log_remote("info", "trigger", "trigger played once: clearing")
        self.app.triggers_once_finished()

    def show(self, trigger):
        from ..player.items import Item
        items = []
        for a in trigger.get("items") or []:
            it = Item.parse(a)
            if it.mime_type == "video/youtube" or not it.content_id:
                continue
            if self.app.cache.is_usable(it.content_id):
                items.append(it)
        if not items:
            self.app.log_remote("warn", "trigger", 'trigger "%s" has no cached media: nothing to show' % trigger.get("name"))
            return
        self.items = items
        self.app.stage.set("triggerVisible", True)
        self.app.stage.set("muted", True)
        self.render(0)
        # `once` = play the items through once (web player parity; Android parses max_duration_sec
        # but never enforced it). max_duration_sec is an UPPER BOUND, 0 = no cap; the cap wins over a
        # longer playlist. The natural length is estimated from duration_sec, as on the web player.
        self.once_timer.stop()
        if trigger.get("mode") == "once":
            try:
                cap = int(trigger.get("max_duration_sec") or 0)
            except (TypeError, ValueError):
                cap = 0
            natural = sum(max(1, i.duration_sec or 10) for i in items)
            stop_after = min(cap, natural) if cap > 0 else natural
            self.once_timer.start(stop_after * 1000)

    def render(self, i):
        self.timer.stop()
        self.index = i % len(self.items)
        it = self.items[self.index]
        multi = len(self.items) > 1
        d = self.app.engine.item_dict(it, fit="contain", loop=not multi)
        if d is None:
            if multi:
                self.timer.start(1000)
            return
        d["muted"] = False
        tok = self.app.engine._new_token("trigger", it)
        d["token"] = tok
        self.token = tok
        self.app.stage.showItem.emit("trigger", d)
        dur = max(1, it.duration_sec or 10) * 1000
        if multi:
            # video: `ended` advances; the timer is the floor under a clip that never reports it
            self.timer.start(dur + 5000 if it.mime_type.startswith("video/") else dur)

    def next(self):
        if self.items:
            self.render(self.index + 1)

    def on_slot_event(self, token, event, detail):
        if token != self.token:
            return
        if event == "ended" and len(self.items) > 1:
            self.next()
        elif event == "failed":
            self.app.log_remote("warn", "trigger", "trigger item failed (%s): skipping" % detail)
            if len(self.items) > 1:
                self.next()
            else:
                self.app.triggers_hide_now()

    def hide(self):
        self.timer.stop()
        self.once_timer.stop()
        self.items = []
        self.token = None
        self.app.stage.set("triggerVisible", False)
        self.app.stage.clearSurface.emit("trigger")
        self.app.restore_mute()


def rtc_page(frames_url):
    """The WebRTC host page. Loaded with the SERVER as its base URL, so /player/talk.js and
    /player/live-publish.js are the server's own modules and every WebSocket/HTTP call is same-origin,
    exactly as for the web player. frames_url is the local frame feed for the live publisher."""
    return """<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%%;background:#000;overflow:hidden}
video{position:fixed;inset:0;width:100%%;height:100%%;object-fit:contain;background:#000}</style>
<script src="/player/talk.js"></script>
<script src="/player/live-publish.js"></script>
</head><body>
<canvas id="c" width="1280" height="720" style="display:none"></canvas>
<script>
(function(){
  var FRAMES = %s;
  var ws = null, live = null;
  function log(){ try { console.log('[rtc] ' + Array.prototype.join.call(arguments, ' ')); } catch(e){} }
  // Title is the only channel back to QML: rtc:video while an operator webcam track is showing.
  setInterval(function(){
    var v = Array.prototype.some.call(document.querySelectorAll('video'), function(el){
      return el.srcObject && el.style.display !== 'none' && el.srcObject.getVideoTracks().length; });
    var t = v ? 'rtc:video' : 'rtc:idle';
    if (document.title !== t) document.title = t;
  }, 400);
  function frames(){
    var c = document.getElementById('c'), ctx = c.getContext('2d');
    ws = new WebSocket(FRAMES); ws.binaryType = 'blob';
    ws.onmessage = function(ev){
      createImageBitmap(ev.data).then(function(bm){
        if (c.width !== bm.width || c.height !== bm.height) { c.width = bm.width; c.height = bm.height; }
        ctx.drawImage(bm, 0, 0); bm.close && bm.close();
      }).catch(function(){});
    };
    ws.onclose = function(){ ws = null; };
    return c.captureStream(15);
  }
  window.ST = {
    talkStart: function(o){
      if (!window.STTalk || !STTalk.isSupported()) { log('talk-state', 'stopped', 'unsupported'); return; }
      o.onState = function(st, reason){ log('talk-state', st, reason || ''); };
      STTalk.start(o);
    },
    talkStop: function(){ try { STTalk.stop(); } catch(e){} },
    liveStart: function(o){
      if (!window.STLivePublish) { log('live', 'stopped', 'unsupported'); return; }
      o.getStream = function(){ return frames(); };
      o.onState = function(st, reason){ log('live', st, reason || ''); if (st === 'stopped' && ws) { try { ws.close(); } catch(e){} } };
      STLivePublish.start(o);
    },
    liveStop: function(){ try { STLivePublish.stop(); } catch(e){} if (ws) { try { ws.close(); } catch(e){} ws = null; } }
  };
  log('ready');
})();
</script></body></html>""" % json.dumps(frames_url)


def new_frame_key():
    return secrets.token_urlsafe(18)
