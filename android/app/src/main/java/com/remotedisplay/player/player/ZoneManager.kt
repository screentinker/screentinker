package com.remotedisplay.player.player

import android.content.Context
import android.net.Uri
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ImageView
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

data class Zone(
    val id: String,
    val name: String,
    val xPercent: Float,
    val yPercent: Float,
    val widthPercent: Float,
    val heightPercent: Float,
    val zIndex: Int,
    val zoneType: String,
    val fitMode: String
)

class ZoneManager(
    private val context: Context,
    private val container: FrameLayout,
    private val onAllVideosComplete: () -> Unit
) {
    private val TAG = "ZoneManager"
    private val zoneViews = mutableMapOf<String, View>()
    private val zoneExoPlayers = mutableMapOf<String, ExoPlayer>()
    private var zones = listOf<Zone>()
    private var activeVideoCount = 0
    private var completedVideoCount = 0

    var currentLayoutId: String? = null
        private set
    var lastAssignmentSig: String? = null

    fun hasZones(): Boolean = zones.isNotEmpty()

    fun setupZones(zonesJson: JSONArray, layoutId: String? = null) {
        currentLayoutId = layoutId
        cleanup()
        zones = (0 until zonesJson.length()).map { i ->
            val z = zonesJson.getJSONObject(i)
            Zone(
                id = z.getString("id"),
                name = z.optString("name", "Zone"),
                xPercent = z.optDouble("x_percent", 0.0).toFloat(),
                yPercent = z.optDouble("y_percent", 0.0).toFloat(),
                widthPercent = z.optDouble("width_percent", 100.0).toFloat(),
                heightPercent = z.optDouble("height_percent", 100.0).toFloat(),
                zIndex = z.optInt("z_index", 0),
                zoneType = z.optString("zone_type", "content"),
                fitMode = z.optString("fit_mode", "cover")
            )
        }
        Log.i(TAG, "Setup ${zones.size} zones")
    }

    fun renderAssignments(assignments: JSONArray, serverUrl: String, contentCache: com.remotedisplay.player.data.ContentCache) {
        // Clear existing zone views
        container.removeAllViews()
        zoneViews.clear()
        releaseExoPlayers()
        activeVideoCount = 0
        completedVideoCount = 0

        val containerWidth = container.width
        val containerHeight = container.height

        if (containerWidth == 0 || containerHeight == 0) {
            // Container not laid out yet, post delayed
            container.post { renderAssignments(assignments, serverUrl, contentCache) }
            return
        }

        // Map assignments by zone_id
        val assignmentsByZone = mutableMapOf<String?, MutableList<JSONObject>>()
        for (i in 0 until assignments.length()) {
            val a = assignments.getJSONObject(i)
            val zoneId = if (a.isNull("zone_id")) null else a.optString("zone_id", null)
            assignmentsByZone.getOrPut(zoneId) { mutableListOf() }.add(a)
        }

        // Render each zone - only show content specifically assigned to this zone
        // Unassigned content (zone_id=null) goes to the FIRST zone only
        var unassignedUsed = false
        for (zone in zones.sortedBy { it.zIndex }) {
            val zoneAssignments: List<JSONObject> = assignmentsByZone[zone.id]
                ?: if (!unassignedUsed) { unassignedUsed = true; assignmentsByZone[null] ?: emptyList() } else emptyList()
            val firstAssignment = zoneAssignments.firstOrNull() ?: continue

            // Calculate pixel position
            val x = (zone.xPercent / 100f * containerWidth).toInt()
            val y = (zone.yPercent / 100f * containerHeight).toInt()
            val w = (zone.widthPercent / 100f * containerWidth).toInt()
            val h = (zone.heightPercent / 100f * containerHeight).toInt()

            val params = FrameLayout.LayoutParams(w, h).apply {
                leftMargin = x
                topMargin = y
            }

            val mimeType = firstAssignment.optString("mime_type", "")
            val remoteUrl = if (firstAssignment.isNull("remote_url")) null else firstAssignment.optString("remote_url", null)
            val widgetType = if (firstAssignment.isNull("widget_type")) null else firstAssignment.optString("widget_type", null)
            val widgetConfig = if (firstAssignment.isNull("widget_config")) null else firstAssignment.optString("widget_config", null)
            val contentId = if (firstAssignment.isNull("content_id")) null else firstAssignment.optString("content_id", null)
            val filepath = firstAssignment.optString("filepath", "")
            val isMuted = firstAssignment.optInt("muted", 0) == 1

            when {
                // Widget - render in WebView
                widgetType != null -> {
                    val widgetId = firstAssignment.optString("widget_id", "")
                    val webView = createWebView()
                    webView.loadUrl("$serverUrl/api/widgets/$widgetId/render")
                    webView.layoutParams = params
                    container.addView(webView)
                    zoneViews[zone.id] = webView
                    Log.i(TAG, "Zone ${zone.name}: widget $widgetType")
                }

                // YouTube - render in WebView
                mimeType == "video/youtube" && !remoteUrl.isNullOrEmpty() -> {
                    val webView = createWebView()
                    webView.loadUrl(remoteUrl)
                    webView.layoutParams = params
                    container.addView(webView)
                    zoneViews[zone.id] = webView
                    Log.i(TAG, "Zone ${zone.name}: youtube $remoteUrl")
                }

                // Video
                mimeType.startsWith("video/") -> {
                    val src = if (!remoteUrl.isNullOrEmpty()) remoteUrl
                             else if (contentId != null) contentCache.getCachedFile(contentId)?.let { Uri.fromFile(it).toString() }
                                  ?: "$serverUrl/uploads/content/$filepath"
                             else continue

                    val playerView = (android.view.LayoutInflater.from(context)
                        .inflate(com.remotedisplay.player.R.layout.zone_player, null) as PlayerView).apply {
                        useController = false
                        layoutParams = params
                    }
                    val exoPlayer = ExoPlayer.Builder(context).build().apply {
                        setMediaItem(MediaItem.fromUri(src))
                        repeatMode = Player.REPEAT_MODE_ALL
                        // Use muted flag from assignment, default unmuted for first video
                        volume = if (isMuted) 0f else 1f
                        prepare()
                        playWhenReady = true
                    }
                    playerView.player = exoPlayer
                    container.addView(playerView)
                    zoneViews[zone.id] = playerView
                    zoneExoPlayers[zone.id] = exoPlayer
                    activeVideoCount++
                    Log.i(TAG, "Zone ${zone.name}: video $src")
                }

                // Image
                mimeType.startsWith("image/") -> {
                    val imageView = ImageView(context).apply {
                        scaleType = when (zone.fitMode) {
                            "contain" -> ImageView.ScaleType.FIT_CENTER
                            "fill" -> ImageView.ScaleType.FIT_XY
                            else -> ImageView.ScaleType.CENTER_CROP
                        }
                        layoutParams = params
                    }

                    // Load image
                    val file = contentId?.let { contentCache.getCachedFile(it) }
                    if (file != null) {
                        val bitmap = android.graphics.BitmapFactory.decodeFile(file.absolutePath)
                        if (bitmap != null) imageView.setImageBitmap(bitmap)
                    } else if (!remoteUrl.isNullOrEmpty()) {
                        // Load from URL in background
                        Thread {
                            try {
                                val connection = java.net.URL(remoteUrl).openConnection()
                                val input = connection.getInputStream()
                                val bitmap = android.graphics.BitmapFactory.decodeStream(input)
                                input.close()
                                imageView.post { if (bitmap != null) imageView.setImageBitmap(bitmap) }
                            } catch (e: Exception) {
                                Log.e(TAG, "Image load failed: ${e.message}")
                            }
                        }.start()
                    }

                    container.addView(imageView)
                    zoneViews[zone.id] = imageView
                    Log.i(TAG, "Zone ${zone.name}: image")
                }
            }
        }

        Log.i(TAG, "Rendered ${zoneViews.size} zone views")
    }

    private fun createWebView(): WebView {
        return WebView(context).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            setBackgroundColor(android.graphics.Color.TRANSPARENT)
            webViewClient = WebViewClient()
        }
    }

    private fun releaseExoPlayers() {
        zoneExoPlayers.values.forEach { it.release() }
        zoneExoPlayers.clear()
    }

    fun cleanup() {
        releaseExoPlayers()
        container.removeAllViews()
        zoneViews.clear()
        zones = listOf()
    }
}
