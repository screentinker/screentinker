package com.remotedisplay.player.service

/**
 * GHSA-rvxj 3.2: the only time PowerAccessibilityService may click "Install" on a package-installer
 * window is shortly after UpdateChecker itself launched an install of OUR OWN signature-verified OTA.
 *
 * ⚠️ WHY. The service used to auto-confirm ANY package-installer window. That made it a confirm-bot
 * for whoever else on the panel could raise an install prompt (another app, a sideload, a pushed
 * foreign APK off device-owner), turning "an install dialog appeared" into "an app was installed".
 * The install dialog does not expose which package/session it is for in a way we can check reliably
 * across OEM installers, so the gate is time + intent: UpdateChecker arms the window right before
 * it commits the session (or launches the ACTION_VIEW fallback) for an APK that passed
 * verifyApkSignature, and the window closes on the install result or after [WINDOW_MS].
 *
 * Pushed APKs (install_apk / installFromUrl) never arm it, and DISARM it: on a device owner they
 * install silently anyway; off owner a person has to tap, which is the point.
 *
 * Same process as the accessibility service (no android:process split), so a volatile is enough.
 */
object OtaInstallWindow {
    /** Long enough for session commit -> STATUS_PENDING_USER_ACTION -> dialog -> Play Protect
     *  "install anyway" on a slow box; short enough that a later foreign prompt is not covered. */
    const val WINDOW_MS = 3 * 60 * 1000L

    @Volatile private var openUntilMs = 0L

    fun arm(nowMs: Long = System.currentTimeMillis()) { openUntilMs = nowMs + WINDOW_MS }

    fun disarm() { openUntilMs = 0L }

    fun isOpen(nowMs: Long = System.currentTimeMillis()): Boolean = isOpen(openUntilMs, nowMs)

    /** Pure decision, unit-tested. Unarmed (0) or expired -> closed. A clock that went backwards
     *  past the arm point by more than the window is treated as closed too (never "open forever"). */
    fun isOpen(openUntilMs: Long, nowMs: Long): Boolean =
        openUntilMs > 0L && nowMs < openUntilMs && openUntilMs - nowMs <= WINDOW_MS
}
