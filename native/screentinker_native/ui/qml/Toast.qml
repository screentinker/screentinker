import QtQuick

// Short on-screen notices (set_server_url result, "update installing", debug). Fades after 4s.
Rectangle {
    id: toast
    visible: opacity > 0
    opacity: 0
    radius: 8
    color: Qt.rgba(0, 0, 0, 0.75)
    width: label.implicitWidth + 32
    height: label.implicitHeight + 20
    Text { id: label; anchors.centerIn: parent; color: "white"; font.pixelSize: 18 }
    Connections {
        target: stage
        function onToast(msg) { label.text = msg; toast.opacity = 1; hide.restart() }
    }
    Timer { id: hide; interval: 4000; onTriggered: fade.start() }
    NumberAnimation { id: fade; target: toast; property: "opacity"; to: 0; duration: 400 }
}
