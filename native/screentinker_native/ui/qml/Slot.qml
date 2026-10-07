import QtQuick
import QtMultimedia
import QtWebEngine

// One media slot. A Surface owns two and alternates between them so the NEXT item loads behind the
// current one and is only revealed once it can draw — never a black gap between items.
//
// item: {token, kind: image|video|web|html|youtube, source, html, baseUrl, fit, muted, loop, live,
//        volume}
// Emits ready() when there is a frame to show, ended() when a video finishes, failed(msg) on error.
Item {
    id: slot
    property var item: null
    property bool front: false
    property real volume: 1.0
    property bool forceMute: false
    property string kind: item ? item.kind : ""
    property bool isReady: false
    signal ready()
    signal ended()
    signal failed(string msg)
    signal position(real posMs, real durMs)

    function fillFor(fit, forVideo) {
        if (forVideo) {
            if (fit === "contain") return VideoOutput.PreserveAspectFit
            if (fit === "fill") return VideoOutput.Stretch
            return VideoOutput.PreserveAspectCrop
        }
        if (fit === "contain") return Image.PreserveAspectFit
        if (fit === "fill") return Image.Stretch
        return Image.PreserveAspectCrop
    }

    function load(it) {
        isReady = false
        item = it
        loader.sourceComponent = null
        if (!it) return
        if (it.kind === "image") loader.sourceComponent = imageComp
        else if (it.kind === "video") loader.sourceComponent = videoComp
        else loader.sourceComponent = webComp
    }
    function unload() {
        loader.sourceComponent = null
        item = null
        isReady = false
    }
    function markReady() {
        if (isReady) return
        isReady = true
        ready()
    }
    // Group/wall sync hooks: only meaningful for video.
    function seek(ms) { if (loader.item && loader.item.seekTo) loader.item.seekTo(ms) }
    function setRate(r) { if (loader.item && loader.item.setRate) loader.item.setRate(r) }
    function pauseMedia(p) { if (loader.item && loader.item.pauseMedia) loader.item.pauseMedia(p) }
    // Wall zones: loop only a clip shorter than its slot — decided once the duration is known.
    function setLoop(b) { if (loader.item && loader.item.setLoop) loader.item.setLoop(b) }
    function runJs(js) { if (loader.item && loader.item.runJs) loader.item.runJs(js) }

    Loader {
        id: loader
        anchors.fill: parent
        asynchronous: false
    }

    Component {
        id: imageComp
        Image {
            anchors.fill: parent
            asynchronous: true
            cache: false
            smooth: true
            mipmap: true
            fillMode: slot.fillFor(slot.item ? slot.item.fit : "", false)
            source: slot.item ? slot.item.source : ""
            // Decode at (at most) the surface size: a 6000px photo decoded at full size is ~100MB of
            // texture on a Pi with a 128MB CMA pool.
            sourceSize.width: Math.max(1, Math.min(3840, slot.width))
            sourceSize.height: Math.max(1, Math.min(3840, slot.height))
            onStatusChanged: {
                if (status === Image.Ready) slot.markReady()
                else if (status === Image.Error) slot.failed("image decode failed")
            }
            // An image that never resolves (a malformed URL stays in Loading with NO error — how every
            // image on the first Windows build sat black) must fail, so the playlist moves on.
            Timer {
                interval: 15000; running: !slot.isReady
                onTriggered: if (!slot.isReady) slot.failed("image did not load within 15s")
            }
        }
    }

    Component {
        id: videoComp
        Item {
            id: videoRoot
            anchors.fill: parent
            function seekTo(ms) { endHeld = false; player.position = Math.max(0, ms) }
            function setRate(r) { player.playbackRate = r }
            function pauseMedia(p) { if (p) player.pause(); else { endHeld = false; player.play() } }
            // ⚠️ Not player.loops: changing it mid-play does not take (Qt 6.11 FFmpeg backend), so a
            // wall zone that decides to loop once the duration is known wraps the clip itself.
            function setLoop(b) { wantLoop = b }
            property bool wantLoop: false
            // holdEnd: a clip that does not loop PAUSES on its last frame and reports ended there.
            // Left to reach EndOfMedia, the FFmpeg backend blanks the output and rewinds — a FREEZE
            // hold after it froze black or frame 0, and a slot that outlasts its clip went black.
            readonly property bool holdEnd: !!(slot.item && slot.item.holdEnd)
            property bool endHeld: false
            // frozenEnd (a wall zone joining mid-FREEZE): the clip's last frame, paused — what the
            // other panels froze on.
            readonly property bool frozenEnd: !!(slot.item && slot.item.frozenEnd)
            VideoOutput {
                id: vo
                anchors.fill: parent
                fillMode: slot.fillFor(slot.item ? slot.item.fit : "", true)
            }
            MediaPlayer {
                id: player
                source: slot.item ? slot.item.source : ""
                videoOutput: vo
                loops: (slot.item && slot.item.loop) ? MediaPlayer.Infinite : 1
                audioOutput: AudioOutput {
                    volume: slot.volume
                    muted: slot.forceMute || (slot.item ? !!slot.item.muted : false) || !slot.front
                }
                onPlaybackStateChanged: if (playbackState === MediaPlayer.PlayingState) readyTimer.start()
                // A paused seek does not repaint on the FFmpeg backend (it showed frame 0), and a seek
                // before playback starts is dropped, so a frozenEnd clip jumps on its first position
                // report, PLAYS its last moment, and holdEnd stops it on the final frame.
                property bool endSought: false
                // ⚠️ A function with no formal parameter, and player.* throughout: the old-style
                // handler injects a `position` PARAMETER, and `position = x` assigned to that.
                onPositionChanged: function() {
                    var d = player.duration, p = player.position
                    if (videoRoot.frozenEnd && !endSought && d > 0) {
                        endSought = true
                        player.position = Math.max(0, d - 300)
                        return
                    }
                    if (player.loops === MediaPlayer.Infinite || d <= 0 || d - p > 120) return
                    if (videoRoot.wantLoop) { player.position = 0; return }
                    if (videoRoot.holdEnd && !videoRoot.endHeld && player.playbackState === MediaPlayer.PlayingState) {
                        videoRoot.endHeld = true
                        player.pause()
                        slot.ended()
                    }
                }
                onMediaStatusChanged: {
                    if (mediaStatus === MediaPlayer.EndOfMedia && loops !== MediaPlayer.Infinite) {
                        if (videoRoot.wantLoop) { player.position = 0; player.play() }
                        else if (!videoRoot.endHeld) { videoRoot.endHeld = true; slot.ended() }
                    }
                    else if (mediaStatus === MediaPlayer.InvalidMedia) slot.failed("invalid media")
                }
                onErrorOccurred: function(error, errorString) { slot.failed(errorString || ("error " + error)) }
                Component.onCompleted: play()
            }
            // Qt 6.4 has no first-frame signal. A short hold after PlayingState is what keeps the
            // previous item on screen until the decoder has actually produced a picture.
            Timer { id: readyTimer; interval: 120; onTriggered: slot.markReady() }
            // Position for the sync engines and device:playback-state.
            Timer {
                interval: 250; repeat: true; running: player.playbackState === MediaPlayer.PlayingState
                onTriggered: slot.position(player.position, player.duration)
            }
            // A decoder that wedges raises NO event (the #297 lesson). If a video never starts,
            // report a fault instead of holding the previous item forever.
            Timer {
                interval: 15000; running: !slot.isReady
                onTriggered: if (!slot.isReady) slot.failed("video did not start within 15s")
            }
        }
    }

    Component {
        id: webComp
        WebEngineView {
            id: web
            anchors.fill: parent
            backgroundColor: "transparent"
            settings.playbackRequiresUserGesture: false
            settings.showScrollBars: false
            settings.localContentCanAccessRemoteUrls: true
            settings.javascriptCanAccessClipboard: false
            settings.focusOnNavigationEnabled: false
            audioMuted: slot.forceMute || (slot.item ? !!slot.item.muted : false) || !slot.front
            property int attempts: 0
            function runJs(js) { runJavaScript(js) }
            function start() {
                if (!slot.item) return
                if (slot.item.html !== undefined && slot.item.html !== null && slot.item.html !== "")
                    loadHtml(slot.item.html, slot.item.baseUrl || "about:blank")
                else
                    url = slot.item.source
            }
            Component.onCompleted: start()
            onLoadingChanged: function(req) {
                if (req.status === WebEngineView.LoadSucceededStatus) { attempts = 0; slot.markReady() }
                else if (req.status === WebEngineView.LoadFailedStatus) {
                    // ⚠️ A failed load must retry itself: a panel boots faster than DHCP, and the
                    // error page would otherwise stay up until someone power-cycles it (Android's
                    // WebViewRetryPolicy). Backoff 2s, 4s ... 60s; the item still advances on its timer.
                    attempts += 1
                    retry.interval = Math.min(60000, 2000 * Math.pow(2, Math.min(attempts - 1, 5)))
                    retry.start()
                    slot.markReady()
                }
            }
            Timer { id: retry; onTriggered: web.start() }
            // A page that never finishes (a long-poll, a stalled font) must still be shown.
            Timer { interval: 5000; running: !slot.isReady; onTriggered: slot.markReady() }
            onRenderProcessTerminated: function(status, code) { retry.interval = 1000; retry.start() }
            // ⚠️ NOTHING IS GRANTED HERE. This view shows playlist content — widgets, bundles,
            // community templates, arbitrary web pages — and a microphone granted to one of those
            // is a room bug. It used to grant MediaAudioCapture to any origin (copied from
            // TalkVideo.qml, whose own view is the only one that needs it); Android's widget
            // WebViews have no onPermissionRequest override, so they deny, and this now matches.
            onFeaturePermissionRequested: function(origin, feature) {
                grantFeaturePermission(origin, feature, false)
            }
        }
    }
}
