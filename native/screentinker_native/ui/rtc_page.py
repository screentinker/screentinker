"""The WebRTC host page (ui/qml/TalkVideo.qml loads it). Kept free of Qt imports so a test can build
it without PySide6: server/test/screen-share-native-e2e.test.js runs this exact page in Chromium —
the engine QtWebEngine embeds — and has it receive a real share."""

import json


def rtc_page(frames_url):
    """Loaded with the SERVER as its base URL, so /player/talk.js, /player/live-publish.js and
    /player/screen-share.js are the server's own modules and every WebSocket/HTTP call is same-origin,
    exactly as for the web player. frames_url is the local frame feed for the live publisher.

    The page title is the only channel back to QML: "rtc:video" while an operator webcam track must
    be SEEN, "rtc:share" while only a screen share is (including its "Connecting to …" before the
    first frame), "rtc:idle" otherwise. A share is a separate state so TalkVideo.qml can hide it under
    a trigger in the same frame (#845). Everything else goes back as "[rtc] …" console lines
    (app.on_rtc_log). ST.shareSuppress(true/false) hides and silences every share while a trigger is
    up; the sessions stay connected.
    """
    return """<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%%;background:#000;overflow:hidden}
video{position:fixed;inset:0;width:100%%;height:100%%;object-fit:contain;background:#000}</style>
<script src="/player/talk.js"></script>
<script src="/player/live-publish.js"></script>
<script src="/player/screen-share.js"></script>
</head><body>
<canvas id="c" width="1280" height="720" style="display:none"></canvas>
<script>
(function(){
  var FRAMES = %s;
  var ws = null, live = null;
  function log(){ try { console.log('[rtc] ' + Array.prototype.join.call(arguments, ' ')); } catch(e){} }
  // #845: a trigger is on screen (app.py, logic/screen_share.Suppression). Every share is hidden and
  // silent and stays connected. STScreenShare.suppress does it on a server that has it; on an older
  // server the page does it here: the overlay hidden, its media held muted.
  var suppressed = false;
  function shareOverlay(){ return document.getElementById('st-share-overlay'); }
  function inShare(el){ var o = shareOverlay(); return !!(o && el && o.contains(el)); }
  function hasSuppress(){ return !!(window.STScreenShare && typeof STScreenShare.suppress === 'function'); }
  function hush(){
    if (!suppressed || hasSuppress()) return;
    var o = shareOverlay();
    if (!o) return;
    if (o.style.visibility !== 'hidden') o.style.visibility = 'hidden';
    Array.prototype.forEach.call(o.querySelectorAll('audio,video'), function(m){ if (!m.muted) m.muted = true; });
  }
  // The older receiver unmutes its presenter on every relayout: mute it straight back.
  document.addEventListener('volumechange', function(ev){
    if (suppressed && !hasSuppress() && inShare(ev.target) && !ev.target.muted) { try { ev.target.muted = true; } catch(e){} }
  }, true);
  function setSuppressed(on){
    on = !!on;
    var was = suppressed;
    suppressed = on;
    if (hasSuppress()) { try { STScreenShare.suppress(on); } catch(e){} return; }
    if (on) { hush(); return; }
    if (was) {
      var o = shareOverlay();
      if (o) o.style.visibility = '';
      // The receiver's own relayout (it listens for resize) puts back whose sound plays.
      try { window.dispatchEvent(new Event('resize')); } catch(e){}
    }
  }
  // Title is the only channel back to QML: rtc:video while an operator webcam track is on screen,
  // rtc:share while only a screen share is (QML hides that one under a trigger), rtc:idle otherwise.
  setInterval(function(){
    var cam = Array.prototype.some.call(document.querySelectorAll('video'), function(el){
      return !inShare(el) && el.srcObject && el.style.display !== 'none' && el.srcObject.getVideoTracks().length; });
    var t = cam ? 'rtc:video' : shareOverlay() ? 'rtc:share' : 'rtc:idle';
    if (document.title !== t) document.title = t;
    hush();
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
    liveStop: function(){ try { STLivePublish.stop(); } catch(e){} if (ws) { try { ws.close(); } catch(e){} ws = null; } },
    // 3.0 screen share: the web player's own receiver (fullscreen overlay + "Shared by" badge).
    shareStart: function(o){
      // The session id rides every line: a replaced share reports "stopped" AFTER its successor began.
      var sid = String(o.sessionId || '');
      if (!window.STScreenShare || !STScreenShare.isSupported()) { log('share', 'unsupported', sid, 'unsupported'); return; }
      o.onState = function(st, reason){ log('share', st, sid, reason || ''); };
      // A share that starts under a trigger starts hidden and silent.
      if ('suppress' in o) setSuppressed(o.suppress);
      delete o.suppress;
      STScreenShare.start(o);
      hush();
    },
    shareStop: function(id, reason){ try { STScreenShare.stop(id || null, reason || 'stopped'); } catch(e){} },
    shareSuppress: function(on){ setSuppressed(on); },
    shareSuppressed: function(){ return suppressed; }
  };
  log('ready');
})();
</script></body></html>""" % json.dumps(frames_url)
