import QtQuick
import QtMultimedia
import QtWebEngine

// One media slot. A Surface owns two and alternates between them so the NEXT item loads behind the
// current one and is only revealed once it can draw — never a black gap between items.
//
// item: {token, kind: image|video|audio|web|html|youtube, source, html, baseUrl, fit, muted, loop, live,
//        volume}
// Emits ready() when there is a frame to show, ended() when a video finishes, failed(msg) on error.
Item {
    id: slot
    property var item: null
    property bool front: false
    property real volume: 1.0
    property bool forceMute: false
    // True while something is drawn over the content that must get the clicks (the settings menu):
    // Qt Quick offers a press to pointer handlers under the point BEFORE the items above, so a
    // fisheye camera's DragHandler took every click meant for the menu's buttons.
    property bool steeringPaused: false
    property string kind: item ? item.kind : ""
    property bool isReady: false
    signal ready()
    signal ended()
    signal failed(string msg)
    // #624: a play-to-end YouTube page reported the video's length (ended() reports its end).
    signal ytLength(real sec)
    // #649: a bundle page asked to be skipped: "<token> <reason>" (the engine checks the token).
    signal bundleSkip(string detail)
    signal position(real posMs, real durMs)
    // A fisheye camera steered by touch (only when its item allows it): "drag dx dy aspect",
    // "pinch scale" or "reset" (player/engine.py on_fisheye_touch).
    signal fisheyeTouch(string detail)

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
        else if (it.kind === "audio") loader.sourceComponent = audioComp
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
    function setFisheye(u) { if (loader.item && loader.item.setFisheye) loader.item.setFisheye(u) }

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
            /*
             * A FISHEYE CAMERA (logic/fisheye.py): the picture is captured whole (Stretch, so image
             * coordinates are the texture's) and re-projected to a normal view by the ShaderEffect
             * below, which fills the slot. `fish` holds the shader and the view; a camera_view or a
             * touch replaces the view part (setFisheye), the shader stays.
             */
            property var fish: (slot.item && slot.item.fisheye) ? slot.item.fisheye : null
            function setFisheye(u) {
                if (!fish) return
                var f = {}
                for (var k in fish) f[k] = fish[k]
                for (var j in u) f[j] = u[j]
                fish = f
            }
            VideoOutput {
                id: vo
                anchors.fill: parent
                fillMode: videoRoot.fish ? VideoOutput.Stretch : slot.fillFor(slot.item ? slot.item.fit : "", true)
            }
            ShaderEffectSource {
                id: fishSrc
                sourceItem: videoRoot.fish ? vo : null
                hideSource: true
                visible: false
                live: true
                // The camera's own resolution (capped), not the slot's: the view zooms into it.
                textureSize: Qt.size(Math.min(2048, vo.sourceRect.width > 0 ? vo.sourceRect.width : 1024),
                                     Math.min(2048, vo.sourceRect.height > 0 ? vo.sourceRect.height : 1024))
            }
            ShaderEffect {
                id: fishFx
                anchors.fill: parent
                visible: !!videoRoot.fish
                fragmentShader: videoRoot.fish ? videoRoot.fish.qsb : ""
                property variant src: fishSrc
                readonly property var f: videoRoot.fish
                property vector3d uDir: f ? Qt.vector3d(f.dir[0], f.dir[1], f.dir[2]) : Qt.vector3d(0, 0, 1)
                property vector3d uRight: f ? Qt.vector3d(f.right[0], f.right[1], f.right[2]) : Qt.vector3d(1, 0, 0)
                property vector3d uUp: f ? Qt.vector3d(f.up[0], f.up[1], f.up[2]) : Qt.vector3d(0, -1, 0)
                property vector2d uTan: f ? Qt.vector2d(f.tanX, f.tanX * height / Math.max(1, width)) : Qt.vector2d(1, 1)
                property real uLensHalf: f ? f.lensHalf : 1.5708
                property real uRot: f ? f.rot : 0
                property vector2d uCenter: f ? Qt.vector2d(f.cx, f.cy) : Qt.vector2d(0.5, 0.5)
                property vector2d uRadius: {
                    if (!f) return Qt.vector2d(0.5, 0.5)
                    var w = vo.sourceRect.width, h = vo.sourceRect.height
                    return Qt.vector2d(f.r * (w > 0 && h > 0 ? h / w : 1), f.r)
                }
                onStatusChanged: if (status === ShaderEffect.Error) console.warn("fisheye shader error: " + log)
            }
            // Touch steering, only when the item allows it: drag moves the picture with the finger,
            // pinch zooms, double-tap goes back to the saved view. Off while steeringPaused.
            DragHandler {
                target: null
                enabled: !!(videoRoot.fish && videoRoot.fish.touch) && !slot.steeringPaused
                property point last: Qt.point(0, 0)
                onActiveChanged: last = Qt.point(0, 0)
                onTranslationChanged: {
                    var dx = translation.x - last.x, dy = translation.y - last.y
                    last = Qt.point(translation.x, translation.y)
                    slot.fisheyeTouch("drag " + (dx / Math.max(1, videoRoot.width)) + " " + (dy / Math.max(1, videoRoot.height))
                                      + " " + (videoRoot.width / Math.max(1, videoRoot.height)))
                }
            }
            PinchHandler {
                target: null
                enabled: !!(videoRoot.fish && videoRoot.fish.touch) && !slot.steeringPaused
                property real last: 1
                onActiveChanged: last = 1
                onActiveScaleChanged: {
                    if (activeScale > 0) { slot.fisheyeTouch("pinch " + (activeScale / last)); last = activeScale }
                }
            }
            TapHandler {
                enabled: !!(videoRoot.fish && videoRoot.fish.touch) && !slot.steeringPaused
                onDoubleTapped: slot.fisheyeTouch("reset")
            }
            // A mouse gets the same steering: DragHandler and TapHandler already take it, and the
            // wheel zooms like a pinch (one notch = 15%, up = in).
            WheelHandler {
                target: null
                enabled: !!(videoRoot.fish && videoRoot.fish.touch) && !slot.steeringPaused
                onWheel: (event) => {
                    if (event.angleDelta.y !== 0) slot.fisheyeTouch("pinch " + Math.pow(1.15, event.angleDelta.y / 120))
                }
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
            // ⚠️ Revealed on the FIRST DECODED FRAME, not a guess. This used to be a fixed 120 ms after
            // PlayingState. On a Pi 4's hardware decoder the first picture arrives 91-115 ms after it
            // (measured), so the old timer won by a frame or two at best, and a black frame showed at
            // video starts (seen on HDMI between two bright cards; gone with this). The sink's frame
            // signal fires once there is a picture, so the previous item stays up until then.
            Connections {
                target: vo.videoSink
                function onVideoFrameChanged() { slot.markReady() }
            }
            // Fallback only, for a backend that never reports frames to the sink: a clip must not sit
            // hidden behind the previous item for ever. Long enough that a slow decoder wins first.
            // ⚠️ Later for a LIVE stream: an HEVC camera joined mid-GOP decodes nothing until its next
            // keyframe (seconds; "Could not find ref with POC" in the log), and revealing it at 1.5 s
            // swapped a black slot in over the previous picture. A live slot waits up to 8 s for a real
            // frame, which covers ordinary GOPs. It is still revealed after that, before the 15 s fault
            // timer below: a long-GOP camera (Smart Codec, 20 s) would otherwise fault, reconnect,
            // join mid-GOP again and never show at all.
            Timer { id: readyTimer; interval: (slot.item && slot.item.live) ? 8000 : 1500; onTriggered: slot.markReady() }
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

    /*
     * An uploaded audio file: the same MediaPlayer, mute and end/error handling as a clip, with no
     * VideoOutput. ⚠️ Audio never paints a frame, so nothing here waits on the video sink: it is
     * ready once it is PLAYING (else it would sit hidden behind the previous item until the 15 s
     * fault timer). item.card (full screen and the trigger overlay) draws a dark "now playing" card;
     * a zone passes card false and the slot is see-through, sound only.
     */
    Component {
        id: audioComp
        Item {
            id: audioRoot
            anchors.fill: parent
            function seekTo(ms) { endSent = false; player.position = Math.max(0, ms) }
            function setRate(r) { player.playbackRate = r }
            function pauseMedia(p) { if (p) player.pause(); else { endSent = false; player.play() } }
            function setLoop(b) { wantLoop = b }
            property bool wantLoop: false
            property bool endSent: false
            // A wall zone joining mid-FREEZE: there is no frame to freeze on, so stay silent and still.
            readonly property bool frozenEnd: !!(slot.item && slot.item.frozenEnd)

            Rectangle {
                objectName: "audioCard"
                anchors.fill: parent
                visible: !!(slot.item && slot.item.card)
                color: "#111111"
                Column {
                    anchors.centerIn: parent
                    width: parent.width * 0.8
                    spacing: Math.min(parent.width, parent.height) * 0.03
                    Text {
                        anchors.horizontalCenter: parent.horizontalCenter
                        text: "\u266A"
                        color: "#dddddd"
                        opacity: 0.85
                        font.pixelSize: Math.max(12, Math.min(audioRoot.width, audioRoot.height) * 0.14)
                    }
                    Text {
                        objectName: "audioTitle"
                        width: parent.width
                        horizontalAlignment: Text.AlignHCenter
                        elide: Text.ElideRight
                        text: (slot.item && slot.item.title) ? slot.item.title : ""
                        color: "#dddddd"
                        font.weight: Font.DemiBold
                        font.pixelSize: Math.max(10, Math.min(audioRoot.width, audioRoot.height) * 0.04)
                    }
                }
            }
            MediaPlayer {
                id: player
                source: slot.item ? slot.item.source : ""
                loops: (slot.item && slot.item.loop) ? MediaPlayer.Infinite : 1
                audioOutput: AudioOutput {
                    volume: slot.volume
                    muted: slot.forceMute || (slot.item ? !!slot.item.muted : false) || !slot.front
                }
                onPlaybackStateChanged: if (playbackState === MediaPlayer.PlayingState) slot.markReady()
                onMediaStatusChanged: {
                    if (mediaStatus === MediaPlayer.EndOfMedia && loops !== MediaPlayer.Infinite) {
                        if (audioRoot.wantLoop) { player.position = 0; player.play() }
                        else if (!audioRoot.endSent) { audioRoot.endSent = true; slot.ended() }
                    }
                    else if (mediaStatus === MediaPlayer.InvalidMedia) slot.failed("invalid media")
                }
                onErrorOccurred: function(error, errorString) { slot.failed(errorString || ("error " + error)) }
                Component.onCompleted: {
                    if (audioRoot.frozenEnd) slot.markReady()
                    else play()
                }
            }
            // Position for the sync engines and device:playback-state.
            Timer {
                interval: 250; repeat: true; running: player.playbackState === MediaPlayer.PlayingState
                onTriggered: slot.position(player.position, player.duration)
            }
            // A decoder that wedges raises NO event (the #297 lesson): fault instead of holding.
            Timer {
                interval: 15000; running: !slot.isReady
                onTriggered: if (!slot.isReady) slot.failed("audio did not start within 15s")
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
            /*
             * ⚠️ #780: REVEALED ON ITS FIRST PAINT, not on "load succeeded". LoadSucceeded means the
             * document finished loading, not that Chromium has composited a frame into the scene:
             * revealing then (and unloading the previous item in the same frame) showed the zone's
             * see-through background, black, for a few frames on every switch between web items. A
             * published slide lays itself out after load (fonts, then a measured fit), which widened
             * the gap on a Pi 4. Images never flashed: Image.Ready already means a decoded texture.
             * So after load the page is asked to wait for its fonts and late images, then two
             * animation frames (one laid out, one painted), and say so; a short Qt-side delay lets
             * that frame reach the scene graph. Capped twice over (in the page and here) so a page
             * whose script never answers is still shown.
             */
            readonly property string paintProbe:
                "(function(){var d=false;function f(){if(d)return;d=true;" +
                "requestAnimationFrame(function(){requestAnimationFrame(function(){console.log('ST_PAINTED')})})}" +
                "var w=[];try{if(document.fonts&&document.fonts.ready)w.push(document.fonts.ready)}catch(e){}" +
                "try{[].slice.call(document.images||[]).forEach(function(i){if(!i.complete)w.push(new Promise(function(r){" +
                "i.addEventListener('load',r,{once:true});i.addEventListener('error',r,{once:true})}))})}catch(e){}" +
                "Promise.all(w).then(f,f);setTimeout(f,1200)})()"
            Timer { id: paintSettle; interval: 50; onTriggered: slot.markReady() }
            Timer { id: paintCap; interval: 1500; onTriggered: slot.markReady() }
            onLoadingChanged: function(req) {
                if (req.status === WebEngineView.LoadSucceededStatus) {
                    attempts = 0
                    if (slot.isReady) return          // a reload of a page already on screen
                    paintCap.restart()
                    runJavaScript(paintProbe)
                }
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
            // #624: a play-to-end YouTube page (engine.youtube_html) reports through the console:
            // "ST_YT duration <sec>" and "ST_YT ended". Nothing else logs with that prefix.
            onJavaScriptConsoleMessage: function(level, message, lineNumber, sourceID) {
                // #780: the paint probe above (any web kind).
                if (message === "ST_PAINTED") { if (!slot.isReady) paintSettle.restart(); return }
                // #649: a bundle page (engine.item_dict, logic/bundle_skip.inject) asking to be skipped.
                if (slot.item && slot.item.kind === "html" && typeof message === "string"
                        && message.indexOf("ST_BUNDLE_SKIP ") === 0) { slot.bundleSkip(message.substring(15)); return }
                if (!slot.item || slot.item.kind !== "youtube" || typeof message !== "string") return
                if (message === "ST_YT ended") slot.ended()
                else if (message.indexOf("ST_YT duration ") === 0) {
                    var d = parseFloat(message.substring(15))
                    if (d > 0) slot.ytLength(d)
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
