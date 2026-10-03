package com.remotedisplay.player.trigger

import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import com.remotedisplay.player.data.ContentCache
import com.remotedisplay.player.util.ImageLoader
import org.json.JSONObject

/**
 * Renders a TRIGGER's playlist as a fullscreen opaque overlay.
 *
 * ⚠️ WHY THIS IS NOT PipOverlay. A PiP shows ONE item from a `uri`; a trigger targets a PLAYLIST,
 * and that difference is the whole point of the feature — the target is a playlist precisely so
 * every item is library content that can be held on disk, which an arbitrary URL cannot be. So this
 * rotates a list, resolves each item from the OFFLINE CACHE, and never fetches from the network on
 * the fire path. If it cannot resolve an item locally it says so loudly rather than reaching out:
 * the one moment a trigger matters is the moment the WAN is down.
 *
 * ⚠️ WHY IT OWNS ITS OWN ExoPlayer. The base playlist's MediaPlayerManager holds the content
 * surface. Reusing it would tear down what the trigger is supposed to be covering, and a clear
 * would have nothing to return to. The mirrored lesson from the web player is sharper still: there,
 * a YouTube item inside a trigger destroyed the BASE playlist's singleton player with no rebuild
 * path, and its error branch advanced the base playlist underneath the alarm.
 *
 * Behaviour is held to the web player (server/player/index.html triggerFire/showZoneItem):
 *  - the overlay is fullscreen and opaque; geometry is reserved and the API refuses it
 *  - the overlay has audio, and the base is silenced while it covers the screen
 *  - a restored trigger restarts at item 1
 *  - a video advances on `ended`, WITH an error handler and a slack timer — a zone video that
 *    advanced only on `ended` left a region black for days when a clip was undecodable
 *  - YouTube items are dropped: unpinnable, so they break the offline guarantee
 */
class TriggerOverlay(
    private val context: Context,
    private val layer: FrameLayout,
    private val cache: ContentCache,
    /** Silence/restore the BASE playlist. See setBaseAudioSuppressed in the web player. */
    private val setBaseAudioSuppressed: (Boolean) -> Unit = {},
    private val log: (level: String, message: String) -> Unit = { _, _ -> }
) : TriggerRenderer {
    private val handler = Handler(Looper.getMainLooper())

    /*
     * ⚠️ EVERY VIEW TOUCH GOES THROUGH HERE, because a trigger arrives on a NETWORK thread.
     * TriggerListeners reads its datagram (or its HTTP request) on its own thread and calls
     * straight through to TriggerController.fire() -> show(). Building and attaching Views from
     * there is an Android violation, and the way it failed was the worst kind: no crash, no log.
     * The box WAS added to the layer — dumpsys showed it as a child — but it never got a layout
     * pass, so it measured 0x0 and nothing was ever visible. The trigger "fired", the controller
     * logged it, the lease ran, the state machine believed a screen was covered, and the panel
     * carried on playing its playlist. That is precisely the reported "triggers are inert".
     */
    private inline fun onMain(crossinline block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else handler.post { block() }
    }
    private var box: FrameLayout? = null
    private var player: ExoPlayer? = null
    private var advance: Runnable? = null
    private var items: List<JSONObject> = emptyList()
    private var index = 0

    /** True while an overlay is on screen — the Android half of `triggerActive != null`. */
    val isShowing: Boolean get() = box != null

    /**
     * @return false if nothing could be rendered, which the CONTROLLER must treat as "this trigger
     *   did not fire". The web player learned this the hard way: arbitration pushes the outgoing
     *   trigger onto the held list BEFORE firing, so a fire that bails out silently left the
     *   previous trigger both active and held — and clearing it fired it straight back.
     */
    override fun show(trigger: TriggerResolve.Trigger): Boolean {
        hide()   // single slot, last-show-wins

        val all = ArrayList<JSONObject>()
        var youtube = 0
        var uncached = 0
        for (raw in trigger.items) {
            val it = raw as? JSONObject ?: continue
            // Unpinnable by nature — see the server-side offline-playability guard. Dropped here
            // as well because definitions cached on devices in the field predate that guard.
            if (it.optString("mime_type") == "video/youtube" || it.has("youtube_id")) { youtube++; continue }
            val id = it.optString("content_id").takeIf { s -> s.isNotEmpty() } ?: continue
            if (cache.getCachedFile(id) == null) { uncached++; continue }
            all.add(it)
        }
        if (youtube > 0) log("warn", "\"${trigger.name}\": dropped $youtube YouTube item(s) — not playable offline")
        if (uncached > 0) log("warn", "\"${trigger.name}\": $uncached item(s) not in the local cache")

        if (all.isEmpty()) {
            // Loud, because this is the failure the whole pinning design exists to prevent.
            log("warn", "\"${trigger.name}\" fired but nothing is playable on this device")
            return false
        }

        /*
         * The filtering above is pure and stays on the calling thread — the caller needs the
         * boolean synchronously to decide whether the fire counts. Only the view work is marshalled.
         */
        onMain {
            val b = FrameLayout(context)
            b.setBackgroundColor(Color.BLACK)
            b.layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            layer.addView(b)
            layer.visibility = android.view.View.VISIBLE
            box = b
            items = all
            index = 0

            try {
                setBaseAudioSuppressed(true)
                renderAt(0)
                log("info", "fired \"${trigger.name}\" (${all.size} item(s))")
            } catch (e: Throwable) {
                // ⚠️ Everything above has already committed — the box is on screen and the base is
                // silenced. A throw that escaped here would leave an opaque black rectangle over the
                // playlist with nothing in it and no audio anywhere.
                log("warn", "\"${trigger.name}\" failed to render: ${e.message}")
                hide()
            }
        }
        return true
    }

    override fun hide() = onMain { hideOnMain() }

    private fun hideOnMain() {
        advance?.let { handler.removeCallbacks(it) }
        advance = null
        // Release, not pause: a paused ExoPlayer holds a decoder, and on a panel with one hardware
        // decoder that is the difference between the base playlist resuming and staying black.
        try { player?.stop(); player?.release() } catch (e: Throwable) { }
        player = null
        box?.let { b -> try { layer.removeView(b) } catch (e: Throwable) { } }
        box = null
        items = emptyList()
        layer.visibility = if (layer.childCount == 0) android.view.View.GONE else android.view.View.VISIBLE
        setBaseAudioSuppressed(false)
    }

    private fun renderAt(i: Int) {
        val b = box ?: return
        if (items.isEmpty()) return
        index = ((i % items.size) + items.size) % items.size
        val item = items[index]
        val multi = items.size > 1

        advance?.let { handler.removeCallbacks(it) }
        try { player?.stop(); player?.release() } catch (e: Throwable) { }
        player = null
        b.removeAllViews()

        val id = item.optString("content_id")
        val file = cache.getCachedFile(id)
        if (file == null) {
            // Should be unreachable — show() filtered these — but skipping beats a black frame.
            log("warn", "trigger item $id vanished from the cache mid-rotation")
            if (multi) scheduleAdvance(1000)
            return
        }

        val durMs = (item.optInt("duration_sec", 10).coerceAtLeast(1)) * 1000L
        val mime = item.optString("mime_type", "")
        if (mime.startsWith("video/") || file.name.endsWith(".mp4") || file.name.endsWith(".webm")) {
            val view = PlayerView(context)
            view.useController = false
            view.layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            b.addView(view)
            val p = ExoPlayer.Builder(context).build()
            // ⚠️ The overlay HAS audio — that is the point of an alarm — while the base is muted.
            p.volume = 1f
            view.player = p
            p.setMediaItem(MediaItem.fromUri(android.net.Uri.fromFile(file)))
            p.repeatMode = if (multi) Player.REPEAT_MODE_OFF else Player.REPEAT_MODE_ONE
            p.addListener(object : Player.Listener {
                override fun onPlaybackStateChanged(state: Int) {
                    if (state == Player.STATE_ENDED && multi) next()
                }
                override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                    // ⚠️ Without this a bad clip stops the rotation dead. The web player shipped a
                    // zone branch with no error handler and no timer, and a single undecodable file
                    // left that region black for days while every other zone kept rotating.
                    log("warn", "trigger video failed (${error.errorCodeName}) — skipping")
                    if (multi) next() else hide()
                }
            })
            p.prepare(); p.play()
            player = p
            // Slack backstop: `ended` does not always arrive (some WebViews and some encoders never
            // fire it), so the duration plus a margin is the floor under the rotation.
            if (multi) scheduleAdvance(durMs + 5000)
        } else {
            val iv = ImageView(context)
            iv.scaleType = ImageView.ScaleType.FIT_CENTER
            iv.layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            // #477: decode against the box the image is shown in. The overlay lives inside the
            // stage, so on a portrait mount it is portrait while displayMetrics stays landscape.
            val bw = if (b.width > 0) b.width else ImageLoader.screenWidth(context)
            val bh = if (b.height > 0) b.height else ImageLoader.screenHeight(context)
            val bmp = ImageLoader.decodeFile(file, bw, bh)
            if (bmp != null) iv.setImageBitmap(bmp) else log("warn", "trigger image $id failed to decode")
            b.addView(iv)
            if (multi) scheduleAdvance(durMs)
        }
    }

    private fun next() = renderAt(index + 1)

    private fun scheduleAdvance(ms: Long) {
        val r = Runnable { next() }
        advance = r
        handler.postDelayed(r, ms)
    }

    companion object { private const val TAG = "TriggerOverlay" }
}
