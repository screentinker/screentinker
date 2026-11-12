import QtQuick

// 3.0 screen share: the meeting-room code in the bottom-right corner (docs/screen-share.md) — the same
// badge the web player draws (server/lib/screen-share-player.js): QR, "Share your screen here", the
// address, the code. Hidden while a share is on screen (the share's own "Shared by" badge is drawn by
// the WebRTC page, TalkVideo.qml). Drawn in QML rather than in that page because the page covers the
// content and would swallow touches on an interactive screen for as long as a code is up.
// #845: hidden while a trigger overlay is on screen (it draws above it), back when it clears.
Item {
    id: root
    visible: stage.shareCode !== "" && !stage.shareActive && !stage.triggerVisible
    readonly property real u: Math.max(width, 1) / 100          // 1vw
    readonly property real base: Math.max(12, u)

    Rectangle {
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        anchors.margins: root.u * 1.2
        width: row.implicitWidth + root.u * 2
        height: row.implicitHeight + root.u * 1.6
        radius: root.u * 0.8
        color: "#d10f172a"

        Row {
            id: row
            anchors.centerIn: parent
            spacing: root.u * 0.9

            Rectangle {
                visible: stage.shareCodeQr !== ""
                width: Math.max(84, root.u * 7); height: width
                radius: root.u * 0.3
                color: "white"
                Image {
                    anchors.fill: parent
                    source: stage.shareCodeQr
                    cache: false
                    smooth: false
                    fillMode: Image.PreserveAspectFit
                }
            }
            Column {
                anchors.verticalCenter: parent.verticalCenter
                Text { text: "Share your screen here"; color: "white"; font.pixelSize: root.base * 1.1; font.bold: true }
                Text { text: "Go to " + stage.shareCodeUrl + " and enter"; textFormat: Text.PlainText; color: "#d9ffffff"; font.pixelSize: root.base }
                // textFormat PlainText: the code and the address come from the server, never markup.
                Text { text: stage.shareCode; textFormat: Text.PlainText; color: "white"; font.pixelSize: root.base * 1.9; font.bold: true; font.family: "monospace"; font.letterSpacing: root.base * 0.15 }
            }
        }
    }
}
