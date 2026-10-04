import QtQuick
import QtQuick.Window

// Root of the native player. Python (ui/stage.py, context property `stage`) owns all decisions;
// this file only lays out surfaces and forwards events. Layer order, bottom to top:
//   content stage (rotated / wall-cropped)  ->  trigger overlay  ->  PiP  ->  talk video
//   ->  window-brightness dim  ->  screen-off blank  ->  status / pairing screen  ->  PIN / exit menu
Window {
    id: win
    visible: true
    // Windowed/development size; production runs showFullScreen() and takes the display's size.
    width: 1280
    height: 720
    color: "black"
    title: "ScreenTinker"
    flags: Qt.Window | Qt.FramelessWindowHint

    property var surfaces: ({})
    function registerSurface(sid, s) { surfaces[sid] = s }
    function unregisterSurface(sid, s) { if (surfaces[sid] === s) delete surfaces[sid] }

    Connections {
        target: stage
        function onShowItem(sid, item) { var s = win.surfaces[sid]; if (s) s.show(item); else stage.slotEvent(sid, item.token, "failed", "no surface " + sid) }
        function onClearSurface(sid) { var s = win.surfaces[sid]; if (s) s.clear() }
        function onControl(sid, cmd) { var s = win.surfaces[sid]; if (s) s.control(cmd) }
    }

    // ---- content stage --------------------------------------------------------------------
    Item {
        id: viewport
        anchors.fill: parent
        clip: true

        // Rotation: portrait content on a landscape panel is laid out in a swapped box, then turned
        // about its centre. Everything inside is in content coordinates.
        Item {
            id: rotor
            readonly property bool swapped: stage.rotation === 90 || stage.rotation === 270
            width: swapped ? viewport.height : viewport.width
            height: swapped ? viewport.width : viewport.height
            anchors.centerIn: parent
            rotation: stage.rotation
            clip: true

        Item {
            id: stageRoot
            // Video wall (Android applyWallTransform parity): the content box is the WHOLE wall
            // (player_rect), sized and offset so this panel's own rectangle (screen_rect) fills the
            // rotor; the rotor's clip shows only that tile. stage.wall carries the fractions
            // cw = p.w/s.w, ch = p.h/s.h, ox = (p.x-s.x)/s.w, oy = (p.y-s.y)/s.h. The per-panel mount
            // rotation arrives as stage.rotation, which the rotor applies.
            readonly property var wall: stage.wall
            width: wall ? rotor.width * wall.cw : rotor.width
            height: wall ? rotor.height * wall.ch : rotor.height
            x: wall ? rotor.width * wall.ox : 0
            y: wall ? rotor.height * wall.oy : 0

            Rectangle { anchors.fill: parent; color: stage.background }

            Surface {
                id: mainSurface
                surfaceId: "main"
                anchors.fill: parent
                visible: stage.layoutMode !== "zones"
                volume: stage.volume
                forceMute: stage.muted
                Component.onCompleted: win.registerSurface("main", mainSurface)
            }

            Repeater {
                model: stage.layoutMode === "zones" ? stage.zones : []
                delegate: Surface {
                    required property var modelData
                    surfaceId: "zone:" + modelData.id
                    x: stageRoot.width * modelData.x / 100
                    y: stageRoot.height * modelData.y / 100
                    width: stageRoot.width * modelData.w / 100
                    height: stageRoot.height * modelData.h / 100
                    z: modelData.z
                    volume: stage.volume
                    forceMute: stage.muted
                    Component.onCompleted: win.registerSurface(surfaceId, this)
                    Component.onDestruction: win.unregisterSurface(surfaceId, this)
                }
            }

            // #473 interactive web page: above the playback surface, inside the rotor so the
            // orientation applies. Fullscreen single-layout only (ui/kiosk.py + the engine decide).
            KioskLayer { anchors.fill: parent }
        }
        }
    }

    // ---- trigger overlay (a LAN-fired interrupt covers the whole screen) --------------------
    Surface {
        id: triggerSurface
        surfaceId: "trigger"
        anchors.fill: parent
        visible: stage.triggerVisible
        volume: stage.volume
        forceMute: stage.blank
        Component.onCompleted: win.registerSurface("trigger", triggerSurface)
    }

    PipLayer { anchors.fill: parent }

    TalkVideo { anchors.fill: parent }

    // ---- window brightness (set_brightness): Android dims the window; we dim with black ----
    Rectangle {
        anchors.fill: parent
        color: "black"
        opacity: stage.dim
        visible: opacity > 0
    }

    // ---- screen off: whatever the hardware did, nothing may stay visible ------------------
    Rectangle {
        anchors.fill: parent
        color: "black"
        visible: stage.blank
    }

    StatusScreen { anchors.fill: parent; visible: stage.statusVisible }

    SettingsMenu { anchors.fill: parent }

    Toast { anchors.left: parent.left; anchors.bottom: parent.bottom; anchors.margins: 24 }
}
