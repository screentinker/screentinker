import QtQuick

// Pairing / waiting / offline status. Shown only when there is nothing better on screen: the
// controller never covers playing content with it (Android's screen-resilience rule).
Rectangle {
    id: root
    color: "#0b0f19"

    Column {
        anchors.centerIn: parent
        spacing: root.height * 0.03
        width: root.width * 0.8

        Text {
            width: parent.width
            horizontalAlignment: Text.AlignHCenter
            color: "#8aa4ff"
            font.pixelSize: Math.max(18, root.height * 0.035)
            font.weight: Font.DemiBold
            text: "ScreenTinker"
        }
        Text {
            width: parent.width
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
            color: "white"
            font.pixelSize: Math.max(20, root.height * 0.045)
            text: stage.statusTitle
        }
        Text {
            visible: stage.pairingCode !== ""
            width: parent.width
            horizontalAlignment: Text.AlignHCenter
            color: "white"
            font.pixelSize: Math.max(48, root.height * 0.16)
            font.letterSpacing: root.height * 0.02
            font.family: "monospace"
            font.weight: Font.Bold
            text: stage.pairingCode
        }
        Text {
            width: parent.width
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
            color: "#c7cede"
            font.pixelSize: Math.max(14, root.height * 0.028)
            text: stage.statusDetail
        }
    }

    Text {
        anchors.bottom: parent.bottom
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.bottomMargin: root.height * 0.03
        color: "#6b7385"
        font.pixelSize: Math.max(12, root.height * 0.02)
        text: stage.footer
    }
}
