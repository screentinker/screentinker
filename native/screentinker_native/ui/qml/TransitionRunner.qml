import QtQuick

// Runs one transition between two slots. With a baked shader (transitions.py -> .qsb) it drives the
// GL Transitions shader over live snapshots of both slots; without one it crossfades. Either way the
// incoming slot is left on top and fully opaque when done, and done() unloads the outgoing slot.
Item {
    id: runner
    visible: false
    property var fromSlot: null
    property var toSlot: null
    property var doneCb: null

    function run(from, to, tr, cb) {
        finish(true)   // a new transition supersedes one in flight
        fromSlot = from; toSlot = to; doneCb = cb
        to.z = 1; from.z = 0
        to.visible = true
        if (tr.qsb && tr.qsb !== "" && stage.shadersSupported) {
            fromSrc.sourceItem = from
            toSrc.sourceItem = to
            fx.fragmentShader = tr.qsb
            var p = tr.params || []
            fx.p0 = p.length > 0 ? p[0] : 0; fx.p1 = p.length > 1 ? p[1] : 0
            fx.p2 = p.length > 2 ? p[2] : 0; fx.p3 = p.length > 3 ? p[3] : 0
            fx.p4 = p.length > 4 ? p[4] : 0; fx.p5 = p.length > 5 ? p[5] : 0
            fx.p6 = p.length > 6 ? p[6] : 0; fx.p7 = p.length > 7 ? p[7] : 0
            fx.progress = 0
            // ⚠️ A shader that loaded but is not COMPILED for this backend (a .qsb without the HLSL
            // variant on Direct3D) reports no error and draws nothing while hideSource hides both
            // slots: black for the whole transition. Only run the shader when Qt says it compiled;
            // otherwise crossfade, which every backend can draw.
            if (fx.status !== ShaderEffect.Compiled) {
                console.warn("transition shader not compiled (status " + fx.status + "): crossfading")
                fromSrc.sourceItem = null
                toSrc.sourceItem = null
                to.opacity = 0
                fadeAnim.target = to
                fadeAnim.duration = tr.durationMs
                fadeAnim.restart()
                return
            }
            runner.visible = true
            shaderAnim.duration = tr.durationMs
            shaderAnim.restart()
        } else {
            to.opacity = 0
            fadeAnim.target = to
            fadeAnim.duration = tr.durationMs
            fadeAnim.restart()
        }
    }

    function finish(superseded) {
        shaderAnim.stop(); fadeAnim.stop()
        runner.visible = false
        fromSrc.sourceItem = null
        toSrc.sourceItem = null
        if (toSlot) toSlot.opacity = 1
        var cb = doneCb
        doneCb = null; fromSlot = null; toSlot = null
        if (cb) cb()
    }

    ShaderEffectSource { id: fromSrc; live: true; hideSource: true; visible: false }
    ShaderEffectSource { id: toSrc; live: true; hideSource: true; visible: false }
    ShaderEffect {
        id: fx
        anchors.fill: parent
        property variant uFrom: fromSrc
        property variant uTo: toSrc
        property variant source: fromSrc   // Qt 6.8 default shader samples `source` until ours is set
        property real progress: 0
        property real ratio: height > 0 ? width / height : 1
        property real p0: 0; property real p1: 0; property real p2: 0; property real p3: 0
        property real p4: 0; property real p5: 0; property real p6: 0; property real p7: 0
        // A shader that fails to link must not leave a black frame: drop to the plain cut.
        onStatusChanged: if (status === ShaderEffect.Error) { console.warn("transition shader error: " + log); runner.finish(false) }
    }
    NumberAnimation { id: shaderAnim; target: fx; property: "progress"; from: 0; to: 1; onFinished: runner.finish(false) }
    NumberAnimation { id: fadeAnim; property: "opacity"; from: 0; to: 1; onFinished: runner.finish(false) }
}
