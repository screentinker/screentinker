"""Qt-thread helpers that are not the playlist: slide audio, the trigger overlay, the WebRTC page."""

import logging
import secrets

from PySide6.QtCore import QTimer, QUrl
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer

# The WebRTC host page lives in its own Qt-free module (a test builds it without PySide6); re-exported
# here so existing imports keep working.
from .rtc_page import rtc_page  # noqa: F401
from ..logic import queue_chime as QC

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


class QueueChimePlayer:
    """Plays the "Now serving" chime (logic/queue_chime.py) once: PCM synthesised here, through a
    QAudioSink on the default output, so nothing is downloaded, no file is written, and it never
    loops. The engine has already decided that it may sound (engine.on_queue_chime); the volume is
    baked into the samples, and the system mixer (the device volume) applies on top as it does to
    every other item. Tests never construct this: it is the only thing that makes a noise."""

    def __init__(self):
        self._live = []            # (sink, buffer) until each has played out

    def _format(self, device):
        from PySide6.QtMultimedia import QAudioFormat
        want = QAudioFormat()
        want.setSampleRate(QC.SAMPLE_RATE)
        want.setChannelCount(1)
        want.setSampleFormat(QAudioFormat.SampleFormat.Int16)
        if device.isFormatSupported(want):
            return want
        pref = device.preferredFormat()
        alt = QAudioFormat()
        alt.setSampleRate(pref.sampleRate() or QC.SAMPLE_RATE)
        alt.setChannelCount(max(1, min(8, pref.channelCount() or 2)))
        alt.setSampleFormat(QAudioFormat.SampleFormat.Int16)
        return alt if device.isFormatSupported(alt) else None

    def play(self, volume):
        """True when the sound was started, False when there is no usable output."""
        from PySide6.QtCore import QBuffer, QByteArray, QIODevice
        from PySide6.QtMultimedia import QAudio, QAudioSink, QMediaDevices
        device = QMediaDevices.defaultAudioOutput()
        if device.isNull():
            return False
        fmt = self._format(device)
        if fmt is None:
            return False
        pcm = QC.pcm16(volume, fmt.sampleRate())
        ch = fmt.channelCount()
        if ch > 1:                 # the same mono samples on every channel
            frames = [pcm[i:i + 2] for i in range(0, len(pcm), 2)]
            pcm = b"".join(f * ch for f in frames)
        buf = QBuffer()
        buf.setData(QByteArray(pcm))
        buf.open(QIODevice.OpenModeFlag.ReadOnly)
        sink = QAudioSink(device, fmt)
        entry = (sink, buf)
        self._live.append(entry)
        done = {"v": False}

        def finish():
            if done["v"]:
                return
            done["v"] = True
            try:
                sink.stop()
                buf.close()
            except RuntimeError:
                pass
            if entry in self._live:
                self._live.remove(entry)
            sink.deleteLater()

        def on_state(state):
            # Idle = the buffer ran out (played to the end); Stopped = an error. Never restarted.
            if state in (QAudio.State.IdleState, QAudio.State.StoppedState):
                QTimer.singleShot(0, finish)

        sink.stateChanged.connect(on_state)
        sink.start(buf)
        ms = int(1000 * QC.total_samples(fmt.sampleRate()) / fmt.sampleRate())
        QTimer.singleShot(ms + 1500, finish)   # the floor under a backend that never reports Idle
        return sink.error() == QAudio.Error.NoError


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


def new_frame_key():
    return secrets.token_urlsafe(18)
