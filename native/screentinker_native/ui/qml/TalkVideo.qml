import QtQuick
import QtWebEngine

// The WebRTC host: one WebEngine page (ui/rtc.py builds it) that runs the SERVER'S OWN browser
// modules — /player/talk.js (STTalk: intercom + operator webcam) and /player/live-publish.js
// (STLivePublishCore: the screen to the dashboard). Chromium inside QtWebEngine is the WebRTC stack,
// so the Pi speaks exactly the protocol the web player does, byte for byte.
//
// The page is loaded only while a call or a live publish is active. It reports through its title:
// "rtc:video" when an operator webcam track is playing (then this layer becomes visible and covers
// the content, like Android's fullscreen webcam view), "rtc:share" when only a screen share is,
// "rtc:idle" otherwise.
//
// #845: a trigger (an emergency / automation alert) outranks a screen share. This layer sits above
// the trigger overlay (Main.qml), so while one is up a share-only page is hidden here, in the same
// frame the trigger appears; the page itself is told to silence the share (ST.shareSuppress, see
// logic/screen_share.Suppression) and the session stays connected for when the trigger clears.
Item {
    id: host
    readonly property string pageState: page.item !== null ? page.item.title : ""
    visible: pageState === "rtc:video" || (pageState === "rtc:share" && !stage.triggerVisible)

    Loader {
        id: page
        anchors.fill: parent
        active: stage.rtcActive
        sourceComponent: WebEngineView {
            backgroundColor: "black"
            settings.playbackRequiresUserGesture: false
            settings.localContentCanAccessRemoteUrls: true
            Component.onCompleted: loadHtml(stage.rtcHtml, stage.rtcBaseUrl)
            onFeaturePermissionRequested: function(origin, feature) {
                // The microphone for a duplex call. Nothing else is ever granted.
                grantFeaturePermission(origin, feature, feature === WebEngineView.MediaAudioCapture)
            }
            onJavaScriptConsoleMessage: function(level, message, line, source) {
                if (message.indexOf("[rtc]") === 0) stage.rtcLog(message)
            }
            Connections {
                target: stage
                function onRtcCommand(js) { runJavaScript(js) }
            }
        }
    }
}
