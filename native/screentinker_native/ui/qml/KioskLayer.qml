import QtQuick
import QtWebEngine

// #473 walk-up interactive web page. ui/kiosk.py owns every decision; this file renders it and
// forwards what the page does. The view exists only while stage.kioskMounted, with the FRESH
// off-the-record profile Python made for this appearance (stage.kioskProfile) — unloading it is the
// wipe. Touches reach Python through Stage's window event filter, never through this file, so the
// page receives every event untouched.
//
// Zoom is Chromium's own page zoom: a LAYOUT zoom — the page lays out for a viewport of size/zoom
// (window.innerWidth shrinks at 150%) and reflows, like browser zoom; never a magnification past the edge.
Item {
    id: layer
    visible: stage.kioskShown

    Rectangle { anchors.fill: parent; color: "white"; visible: stage.kioskMounted }
    Rectangle { anchors.fill: parent; color: "black"; visible: !stage.kioskMounted }

    // ⚠️ The view is CREATED with its profile as an initial value, never bound to it. A binding
    // (`profile: stage.kioskProfile`) would re-point a view that is only scheduled for deletion at
    // whatever profile comes next — null (Qt then falls back to the shared default profile and
    // reloads the page there) or the NEXT visitor's fresh one. A dying view is stopped and marked
    // dead (seq -1) first, and every handler ignores a view that is not the current mount.
    property var view: null
    Item { id: viewHost; anchors.fill: parent }     // below the card, Home button and overlay
    function sync() {
        var want = stage.kioskMounted && stage.kioskProfile !== null
        if (view && (!want || view.seq !== stage.kioskSeq)) {
            var old = view
            view = null
            old.seq = -1
            old.visible = false
            old.stop()
            old.destroy()
        }
        if (want && !view)
            view = viewComp.createObject(viewHost, { profile: stage.kioskProfile, seq: stage.kioskSeq })
    }
    Connections {
        target: stage
        function onKioskMountedChanged() { layer.sync() }
        function onKioskProfileChanged() { layer.sync() }
        function onKioskSeqChanged() { layer.sync() }
    }

    Component {
        id: viewComp
        WebEngineView {
            id: web
            property int seq: -1
            readonly property bool live: seq >= 0 && seq === stage.kioskSeq
            anchors.fill: parent
            z: 0
            backgroundColor: "white"
            zoomFactor: stage.kioskZoom
            settings.playbackRequiresUserGesture: false
            settings.javascriptCanOpenWindows: false
            settings.javascriptCanAccessClipboard: false
            settings.localContentCanAccessFileUrls: false
            settings.localContentCanAccessRemoteUrls: false
            settings.allowRunningInsecureContent: false
            settings.focusOnNavigationEnabled: true
            settings.fullScreenSupportEnabled: false
            settings.pdfViewerEnabled: false

            Connections {
                target: stage
                function onKioskLoad(u) { if (web.live) web.url = u }
                function onKioskJs(js) { if (web.live) web.runJavaScript(js) }
            }

            // Top-level only: subframes and subresources are never filtered.
            onNavigationRequested: function(request) {
                if (web.live && stage.kioskNavAllowed(request.url.toString(), request.isMainFrame)) return
                // Qt >= 6.8 has reject(); older Qt 6 sets the action.
                if (typeof request.reject === "function") request.reject()
                else request.action = WebEngineNavigationRequest.IgnoreRequest
            }
            // window.open / target=_blank: never a new window — Python loads it HERE if allowed.
            onNewWindowRequested: function(request) { if (web.live) stage.kioskNewWindow(request.requestedUrl.toString()) }
            onFileDialogRequested: function(request) { request.accepted = true; request.dialogReject() }
            onContextMenuRequested: function(request) { request.accepted = true }
            onFeaturePermissionRequested: function(origin, feature) { grantFeaturePermission(origin, feature, false) }
            onUrlChanged: if (web.live) stage.kioskUrlChanged(url.toString())
            onLoadingChanged: function(info) {
                if (!web.live) return
                // Chromium resets the page zoom per navigation in some builds: re-assert it.
                if (zoomFactor !== stage.kioskZoom) zoomFactor = stage.kioskZoom
                if (info.status === WebEngineView.LoadSucceededStatus) {
                    stage.kioskLoadDone(info.url.toString(), true, 0, "")
                } else if (info.status === WebEngineView.LoadFailedStatus) {
                    var http = info.errorDomain === WebEngineLoadingInfo.HttpStatusCodeDomain
                    stage.kioskLoadDone(info.url.toString(), false, http ? info.errorCode : -1,
                                        info.errorCode + " " + info.errorString)
                }
            }
            onRenderProcessTerminated: function(status, code) {
                if (web.live && status !== WebEngineView.NormalTerminationStatus)
                    stage.kioskRendererGone("status=" + status + " code=" + code)
            }
            onJavaScriptConsoleMessage: function(level, message, line, source) { if (web.live) stage.kioskConsole(message) }
        }
    }

    // v1 card: the page needs a newer engine than this panel has.
    Rectangle {
        anchors.fill: parent
        visible: stage.kioskCard !== ""
        color: "#111827"
        Text {
            anchors.fill: parent
            anchors.margins: 40
            text: stage.kioskCard
            color: "white"
            font.pixelSize: 28
            wrapMode: Text.WordWrap
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
        }
    }

    // v2 Home button: bottom-left, only off the start page.
    Rectangle {
        id: home
        visible: stage.kioskHome && stage.kioskMounted
        anchors.left: parent.left
        anchors.bottom: parent.bottom
        anchors.margins: 16
        width: homeText.implicitWidth + 36
        height: homeText.implicitHeight + 20
        radius: height / 2
        color: Qt.rgba(17 / 255, 24 / 255, 39 / 255, 190 / 255)
        Text {
            id: homeText
            anchors.centerIn: parent
            text: "⌂  Home"
            color: "white"
            font.pixelSize: 22
        }
        MouseArea { anchors.fill: parent; onClicked: stage.kioskHomeTapped() }
    }

    // "Still there?" countdown: on top of everything, any tap resumes.
    Rectangle {
        anchors.fill: parent
        visible: stage.kioskOverlay !== ""
        color: Qt.rgba(0, 0, 0, 200 / 255)
        Text {
            anchors.fill: parent
            text: stage.kioskOverlay
            color: "white"
            font.pixelSize: 34
            wrapMode: Text.WordWrap
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
        }
        MouseArea { anchors.fill: parent; onClicked: stage.kioskOverlayTapped() }
    }
}
