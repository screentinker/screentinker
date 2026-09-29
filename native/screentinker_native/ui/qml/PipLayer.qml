import QtQuick
import QtWebEngine

// Picture-in-picture overlays (device:pip-show / pip-clear). Geometry and styling follow Android's
// PipOverlay.kt: fixed pixel size, one of five anchor positions with a 4% inset, optional title bar
// and close button, auto-dismiss after `duration` seconds (0 = until cleared).
Item {
    id: layer
    Repeater {
        model: stage.pips
        delegate: Rectangle {
            id: pip
            required property var modelData
            readonly property real inset: Math.min(layer.width, layer.height) * 0.04
            readonly property string pos: modelData.position || "bottom-right"
            width: Math.min(modelData.width || 480, layer.width - 2 * inset)
            height: Math.min((modelData.height || 360) + (modelData.title ? titleBar.height : 0), layer.height - 2 * inset)
            x: pos.indexOf("left") >= 0 ? inset : (pos === "center" ? (layer.width - width) / 2 : layer.width - width - inset)
            y: pos.indexOf("top") >= 0 ? inset : (pos === "center" ? (layer.height - height) / 2 : layer.height - height - inset)
            radius: modelData.border_radius || 0
            color: modelData.background_color || "black"
            opacity: modelData.opacity === undefined ? 1 : modelData.opacity
            clip: true

            Rectangle {
                id: titleBar
                visible: !!pip.modelData.title
                width: parent.width
                height: visible ? Math.max(28, pip.height * 0.1) : 0
                color: Qt.rgba(0, 0, 0, 0.55)
                Text {
                    anchors.fill: parent
                    anchors.leftMargin: 10
                    verticalAlignment: Text.AlignVCenter
                    elide: Text.ElideRight
                    color: pip.modelData.title_color || "white"
                    font.pixelSize: parent.height * 0.55
                    text: pip.modelData.title || ""
                }
            }
            Loader {
                anchors.top: titleBar.bottom
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.bottom: parent.bottom
                sourceComponent: pip.modelData.type === "web" ? webComp : imgComp
            }
            Component {
                id: imgComp
                Image { source: pip.modelData.uri; fillMode: Image.PreserveAspectFit; asynchronous: true; cache: false }
            }
            Component {
                id: webComp
                WebEngineView { url: pip.modelData.uri; backgroundColor: "transparent"; settings.playbackRequiresUserGesture: false }
            }
            Rectangle {
                visible: pip.modelData.close_button === true
                anchors.top: parent.top
                anchors.right: parent.right
                anchors.margins: 6
                width: 32; height: 32; radius: 16
                color: Qt.rgba(0, 0, 0, 0.6)
                Text { anchors.centerIn: parent; color: "white"; text: "✕"; font.pixelSize: 18 }
                MouseArea { anchors.fill: parent; onClicked: stage.pipClosed(pip.modelData.pip_id) }
            }
            Timer {
                running: (pip.modelData.duration || 0) > 0
                interval: (pip.modelData.duration || 0) * 1000
                onTriggered: stage.pipClosed(pip.modelData.pip_id)
            }
        }
    }
}
