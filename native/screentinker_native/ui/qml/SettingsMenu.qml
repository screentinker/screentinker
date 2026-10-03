import QtQuick

// On-device settings, gated by the per-device PIN the server provisioned (device:paired /
// device:settings-pin) — Android's MainActivity rule: two BACK/ESC presses open the PIN pad, a
// correct PIN opens the menu. With kiosk lock on (kiosk_lock), "Exit to desktop" is hidden.
Item {
    id: menu
    property int stageNo: 0          // 0 hidden, 1 PIN pad, 2 menu
    property string entered: ""
    property int escCount: 0
    // ⚠️ The root stays VISIBLE: an invisible item receives no key events, so hiding it would make
    // the Esc-Esc opener unreachable. Only the panel below is hidden.
    focus: true

    Keys.onPressed: function(ev) {
        if (ev.key === Qt.Key_Escape || ev.key === Qt.Key_Back) {
            if (stageNo > 0) { close(); ev.accepted = true; return }
            escCount += 1
            escReset.restart()
            if (escCount >= 2) { escCount = 0; open() }
            ev.accepted = true
        } else if (stageNo === 1 && ev.key >= Qt.Key_0 && ev.key <= Qt.Key_9) {
            press(String(ev.key - Qt.Key_0)); ev.accepted = true
        } else if (stageNo === 1 && ev.key === Qt.Key_Backspace) {
            entered = entered.slice(0, -1); ev.accepted = true
        } else if (stageNo === 1 && (ev.key === Qt.Key_Return || ev.key === Qt.Key_Enter)) {
            submit(); ev.accepted = true
        }
    }
    Connections {
        target: stage
        // 1 = PIN pad (on-device request), 2 = straight to the menu (the dashboard's power_menu /
        // settings: the operator is already authenticated there).
        function onOpenMenu(which) { menu.entered = ""; menu.stageNo = (which === 1 && stage.hasPin) ? 1 : 2; autoClose.restart(); menu.forceActiveFocus() }
    }
    Connections {
        target: stage
        // 1 = PIN pad (on-device request), 2 = straight to the menu (the dashboard's power_menu /
        // settings: the operator is already authenticated there).
        function onOpenMenu(which) { menu.entered = ""; menu.stageNo = (which === 1 && stage.hasPin) ? 1 : 2; autoClose.restart(); menu.forceActiveFocus() }
    }
    Timer { id: escReset; interval: 1500; onTriggered: menu.escCount = 0 }
    Timer { id: autoClose; interval: 60000; onTriggered: menu.close() }

    function open() { entered = ""; stageNo = stage.hasPin ? 1 : 2; autoClose.restart(); forceActiveFocus() }
    function close() { stageNo = 0; entered = ""; autoClose.stop() }
    function press(d) { if (entered.length < 8) entered += d; autoClose.restart() }
    function submit() {
        if (stage.checkPin(entered)) { stageNo = 2 } else { entered = ""; stage.toast("Wrong PIN") }
        autoClose.restart()
    }

    Item {
    anchors.fill: parent
    visible: menu.stageNo > 0
    Rectangle { anchors.fill: parent; color: Qt.rgba(0, 0, 0, 0.8) }

    Column {
        visible: menu.stageNo === 1
        anchors.centerIn: parent
        spacing: 16
        Text { color: "white"; font.pixelSize: 30; text: "Enter settings PIN"; anchors.horizontalCenter: parent.horizontalCenter }
        Text { color: "white"; font.pixelSize: 44; font.family: "monospace"; text: menu.entered.replace(/./g, "●") || " "; anchors.horizontalCenter: parent.horizontalCenter }
        Grid {
            columns: 3; spacing: 10
            anchors.horizontalCenter: parent.horizontalCenter
            Repeater {
                model: ["1","2","3","4","5","6","7","8","9","⌫","0","OK"]
                delegate: Rectangle {
                    required property string modelData
                    width: 90; height: 70; radius: 8; color: "#243049"
                    Text { anchors.centerIn: parent; color: "white"; font.pixelSize: 28; text: parent.modelData }
                    MouseArea {
                        anchors.fill: parent
                        onClicked: {
                            if (parent.modelData === "OK") menu.submit()
                            else if (parent.modelData === "⌫") menu.entered = menu.entered.slice(0, -1)
                            else menu.press(parent.modelData)
                        }
                    }
                }
            }
        }
    }

    Column {
        visible: menu.stageNo === 2
        anchors.centerIn: parent
        spacing: 12
        Text { color: "white"; font.pixelSize: 30; text: "ScreenTinker settings"; anchors.horizontalCenter: parent.horizontalCenter }
        Text { color: "#c7cede"; font.pixelSize: 18; text: stage.footer; anchors.horizontalCenter: parent.horizontalCenter }
        Repeater {
            model: stage.menuActions
            delegate: Rectangle {
                required property var modelData
                width: 420; height: 60; radius: 8; color: "#243049"
                anchors.horizontalCenter: parent.horizontalCenter
                Text { anchors.centerIn: parent; color: "white"; font.pixelSize: 22; text: parent.modelData.label }
                MouseArea { anchors.fill: parent; onClicked: { stage.menuAction(parent.modelData.id); menu.close() } }
            }
        }
        Rectangle {
            width: 420; height: 60; radius: 8; color: "#3a3f4b"
            anchors.horizontalCenter: parent.horizontalCenter
            Text { anchors.centerIn: parent; color: "white"; font.pixelSize: 22; text: "Close" }
            MouseArea { anchors.fill: parent; onClicked: menu.close() }
        }
    }
    }
}
