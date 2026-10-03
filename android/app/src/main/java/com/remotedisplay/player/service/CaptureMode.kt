package com.remotedisplay.player.service

import android.os.Build

/**
 * Which screen-capture tier a panel can currently use — ONE definition, consumed by both the
 * capture path (WebSocketService.captureScreen) and the telemetry the dashboard renders.
 *
 * ⚠️ WHY THIS EXISTS. The capture path silently degrades. MediaProjection consent does not survive
 * the app restarting, and an OTA restarts the app — so a panel that was showing its whole screen
 * drops to drawing only the player's own window, with no error anywhere. A customer reported it as
 * "the live view used to show Settings and now shows blank", and the only way to tell from the
 * outside was to notice that screenshots had quietly stopped including anything but the playlist.
 * Reporting the tier turns that into a visible state instead of a mystery.
 *
 * The order here MUST match WebSocketService.captureScreen's fallback order, or the dashboard will
 * describe a panel differently from how it actually captures.
 */
enum class CaptureMode(val wire: String) {
    /** MediaProjection: whole screen, survives backgrounding. Needs consent, LOST on every restart. */
    PROJECTION("projection"),

    /** AccessibilityService screenshot API: whole screen, no consent dialog, SURVIVES restarts.
     *  API 30+ and the service must be enabled by hand — no DPM API can enable it, not even for a
     *  device owner. This is the durable one, which is why the dashboard nudges toward it. */
    ACCESSIBILITY("accessibility"),

    /** The player's own window only. Anything outside the app — Settings, another app — is blank. */
    VIEW("view"),

    /** Nothing available (no foreground activity to draw, and neither privileged path granted). */
    NONE("none");

    companion object {
        /**
         * The tier that WOULD serve the next capture. Read-only and cheap: it inspects the same
         * state captureScreen() checks, and takes no screenshot.
         *
         * @param hasActivityCapture whether an Activity has registered its view-capture callback.
         */
        fun current(hasActivityCapture: Boolean): CaptureMode = when {
            ScreenCaptureService.isReady -> PROJECTION
            accessibilityCaptureAvailable() -> ACCESSIBILITY
            hasActivityCapture -> VIEW
            else -> NONE
        }

        /** Mirrors captureFullScreen's own preconditions: service bound AND API 30+. */
        fun accessibilityCaptureAvailable(): Boolean =
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && PowerAccessibilityService.instance != null
    }
}
