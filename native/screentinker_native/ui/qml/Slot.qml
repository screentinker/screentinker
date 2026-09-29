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
            anchors.fill: parent
            function seekTo(ms) { player.position = Math.max(0, ms) }
            function setRate(r) { player.playbackRate = r }
            function pauseMedia(p) { if (p) player.pause(); else player.play() }
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
                onMediaStatusChanged: {
                    if (mediaStatus === MediaPlayer.EndOfMedia && !(slot.item && slot.item.loop)) slot.ended()
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
            onFeaturePermissionRequested: function(origin, feature) {
                grantFeaturePermission(origin, feature, feature === WebEngineView.MediaAudioCapture)
            }
        }
    }
}
