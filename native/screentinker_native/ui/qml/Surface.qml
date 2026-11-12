import QtQuick

// A playback surface: fullscreen, one zone, or the trigger overlay. Python calls show(item); the
// surface loads it into the BACK slot, waits for ready, then swaps — with the item's transition if it
// has one (Transition.qml), a hard cut otherwise (Android's rule: no transition = hard cut).
//
// Web items whose URL matches what is already on screen are NOT reloaded: a widget re-shown every
// duration_sec would otherwise flash white each cycle (the solo-widget reload flash). rev is part of
// the URL, so an edited widget still reloads.
Item {
    id: surface
    property string surfaceId: ""
    property real volume: 1.0
    property bool forceMute: false
    // A WALL zone's background_color (a blank hold, or a zone between items, shows it). Layout zones
    // pass "" and stay see-through (#657, engine._enter_zones).
    property string fill: ""
    property var current: null
    property int frontIndex: 0
    readonly property var slots: [slotA, slotB]
    clip: true

    function frontSlot() { return slots[frontIndex] }
    // ⚠️ By TOKEN, not ===. The item arrives from Python as a QVariantMap, and a var property holding
    // it does not keep JS identity (PySide6 6.11: `current === item` was false for the very object
    // just assigned), so reveal() never ran: front stayed false — no position reports for the sync
    // engines, AudioOutput muted by !front, the old slot never unloaded, no transitions.
    function isCurrent(it) { return !!(it && current && it.token === current.token) }
    function backSlot() { return slots[1 - frontIndex] }

    function show(item) {
        var f = frontSlot()
        if (item && f.item && f.isReady && (item.kind === "web" || item.kind === "youtube")
                && f.item.kind === item.kind && f.item.source === item.source && !item.html && !f.item.html) {
            // Same page already up: adopt the new token, keep the view. A widget's chime bridge is
            // re-installed with the new mount's token (the page itself is not reloaded).
            f.item = item
            f.installChime()
            current = item
            stage.slotEvent(surfaceId, item.token, "ready", "")
            stage.slotEvent(surfaceId, item.token, "shown", "reused")
            return
        }
        var b = backSlot()
        b.front = false
        b.visible = true
        b.opacity = 1
        b.z = 0
        f.z = 1
        b.load(item)
        current = item
    }
    function clear() {
        deferredUnload.stop(); deferredUnload.slotRef = null
        slotA.unload(); slotB.unload()
        current = null
    }
    function slotFor(token) {
        if (slotA.item && slotA.item.token === token) return slotA
        if (slotB.item && slotB.item.token === token) return slotB
        return null
    }
    function control(cmd) {
        var s = frontSlot()
        if (!s || !s.item) return
        if (cmd.seek_ms !== undefined) s.seek(cmd.seek_ms)
        if (cmd.rate !== undefined) s.setRate(cmd.rate)
        if (cmd.loop !== undefined) s.setLoop(cmd.loop)
        if (cmd.pause !== undefined) s.pauseMedia(cmd.pause)
        if (cmd.js !== undefined) s.runJs(cmd.js)
        if (cmd.fisheye !== undefined) s.setFisheye(cmd.fisheye)
    }

    function reveal(slot) {
        var old = frontSlot()
        var tr = slot.item ? slot.item.transition : null
        frontIndex = (slot === slotA) ? 0 : 1
        slot.front = true
        if (old === slot) return
        old.front = false
        if (tr && tr.durationMs > 0 && old.item && old.isReady) {
            transition.run(old, slot, tr, function() { old.unload(); old.visible = false })
        } else {
            slot.z = 1
            old.z = 0
            if (slot.kind === "web" || slot.kind === "html" || slot.kind === "youtube") {
                /*
                 * #780 belt and braces: a web view's background is transparent, so keep the outgoing
                 * item UNDER it for a moment instead of unloading it in the same frame. If Chromium's
                 * first frame lands a little after the paint probe said it would, the old picture shows
                 * through instead of black. By token: if show() reloads this slot before the timer
                 * fires, the new item is never unloaded.
                 */
                deferredUnload.slotRef = old
                deferredUnload.token = old.item ? old.item.token : ""
                deferredUnload.restart()
            } else {
                old.unload()
                old.visible = false
            }
        }
        stage.slotEvent(surfaceId, slot.item ? slot.item.token : "", "shown", "")
    }

    Rectangle { anchors.fill: parent; z: -1; color: surface.fill; visible: surface.fill !== "" }

    Slot {
        id: slotA
        anchors.fill: parent
        volume: surface.volume
        forceMute: surface.forceMute
        steeringPaused: stage.menuOpen
        onReady: { stage.slotEvent(surface.surfaceId, item ? item.token : "", "ready", ""); if (surface.isCurrent(item)) surface.reveal(slotA) }
        onEnded: stage.slotEvent(surface.surfaceId, item ? item.token : "", "ended", "")
        onYtLength: function(sec) { stage.slotEvent(surface.surfaceId, item ? item.token : "", "yt_length", String(sec)) }
        onBundleSkip: function(detail) { stage.slotEvent(surface.surfaceId, item ? item.token : "", "bundle_skip", detail) }
        onQueueChime: function(detail) { stage.slotEvent(surface.surfaceId, item ? item.token : "", "queue_chime", detail) }
        onFailed: function(msg) { stage.slotEvent(surface.surfaceId, item ? item.token : "", "failed", msg) }
        onPosition: function(p, d) { if (front) stage.slotPosition(surface.surfaceId, item ? item.token : "", p, d) }
        onFisheyeTouch: function(detail) { stage.slotEvent(surface.surfaceId, item ? item.token : "", "fisheye_touch", detail) }
    }
    Slot {
        id: slotB
        anchors.fill: parent
        visible: false
        volume: surface.volume
        forceMute: surface.forceMute
        steeringPaused: stage.menuOpen
        onReady: { stage.slotEvent(surface.surfaceId, item ? item.token : "", "ready", ""); if (surface.isCurrent(item)) surface.reveal(slotB) }
        onEnded: stage.slotEvent(surface.surfaceId, item ? item.token : "", "ended", "")
        onYtLength: function(sec) { stage.slotEvent(surface.surfaceId, item ? item.token : "", "yt_length", String(sec)) }
        onBundleSkip: function(detail) { stage.slotEvent(surface.surfaceId, item ? item.token : "", "bundle_skip", detail) }
        onQueueChime: function(detail) { stage.slotEvent(surface.surfaceId, item ? item.token : "", "queue_chime", detail) }
        onFailed: function(msg) { stage.slotEvent(surface.surfaceId, item ? item.token : "", "failed", msg) }
        onPosition: function(p, d) { if (front) stage.slotPosition(surface.surfaceId, item ? item.token : "", p, d) }
        onFisheyeTouch: function(detail) { stage.slotEvent(surface.surfaceId, item ? item.token : "", "fisheye_touch", detail) }
    }

    Timer {
        id: deferredUnload
        interval: 250
        property var slotRef: null
        property string token: ""
        onTriggered: {
            var s = slotRef
            slotRef = null
            if (!s || s === surface.frontSlot()) return
            if (s.item && s.item.token !== token) return     // reloaded with a new item meanwhile
            s.unload()
            s.visible = false
        }
    }

    TransitionRunner { id: transition; anchors.fill: parent; z: 2 }
}
