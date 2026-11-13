package com.remotedisplay.player.power

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import org.json.JSONObject

/**
 * Holds this panel's weekly backlight schedule and applies it — locally, offline, for ever.
 *
 * ⚠️ THIS MUST NOT BE ACTIVITY-SCOPED, AND THE REASON IS CIRCULAR.
 *
 * Going dark is `lockNow()`. That stops MainActivity and lets the system destroy it under memory
 * pressure. So an Activity-owned instance switches the panel off and then dies with the thing it
 * just switched off — the tick stops, the 06:00 edge never fires, and the schedule works exactly
 * once before the screen stays dark until somebody drives to it. The first version of this file had
 * that bug: constructed in MainActivity.onCreate and stopped in onDestroy.
 *
 * It is therefore owned by WebSocketService, which is foreground, START_STICKY, and holds a
 * PARTIAL_WAKE_LOCK — the same "only thing guaranteed to be alive" reasoning the service's own
 * screen_on branch already carries in writing. The Activity contributes one thing it alone can do,
 * FLAG_KEEP_SCREEN_ON, through a nullable callback; null is a normal state mid-window.
 *
 * Nothing here touches a Context beyond SharedPreferences, and [start] needs no Activity, no window
 * and no socket — see PowerScheduleServiceOwnershipTest.
 *
 * ⚠️ WHY A HANDLER TICK AND NOT AlarmManager.
 *
 * The obvious design is "compute the next edge, set an exact alarm". It is worse here for three
 * separate reasons, any one of which is enough:
 *
 *   1. An EXACT alarm needs SCHEDULE_EXACT_ALARM from Android 12, and on 13+ it is not granted to
 *      an ordinary app by default. Signage panels are frequently side-loaded onto locked-down OEM
 *      builds where nobody can grant it, so the alarm silently becomes inexact.
 *   2. An INEXACT alarm is deferred under Doze — by minutes, sometimes much longer. "The shop
 *      screens go dark somewhere around ten" is not a schedule.
 *   3. A computed edge has to be RE-computed across a DST transition, and getting that wrong is
 *      invisible until twice a year.
 *
 * Re-evaluating from scratch on a fixed tick has none of those properties: each evaluation is
 * independent, asks the timezone database fresh, and cannot drift. The player already runs a
 * foreground service with a heartbeat every 15s, so a 60s tick is free — and because the state is
 * re-asserted rather than edge-triggered, a missed tick self-heals on the next one instead of
 * leaving a panel in the wrong state until tomorrow.
 *
 * The manager DECIDES. [onApply] does the applying, and it is supplied by **WebSocketService** —
 * NOT by MainActivity, for the reason above. It routes to that service's blankPanel() / wakePanel(),
 * which are the very same methods the remote screen_off / screen_on commands use, so there is never
 * a second implementation of "make the panel dark" to drift from the one an operator's button hits.
 *
 * The Activity's only contribution is FLAG_KEEP_SCREEN_ON, which only a window can hold, and it
 * arrives through the service's nullable `onPowerWindow` callback. If you find yourself wanting to
 * construct this class from an Activity so that callback can be direct: that is the bug described
 * above, and PowerScheduleServiceOwnershipTest will stop you.
 */
class PowerScheduleManager(
    private val context: Context,
    private val onApply: (off: Boolean) -> Unit,
    private val onStateChanged: ((state: String) -> Unit)? = null
) {

    private val handler = Handler(Looper.getMainLooper())
    private var tick: Runnable? = null

    @Volatile var schedule: PowerWindow.Schedule? = null
        private set

    /**
     * The operator pressed "screen on" while a scheduled-off window was running.
     *
     * The contract is: that wins until the NEXT EDGE, then the schedule resumes. Anything else is
     * wrong in one direction or the other — a permanent override means an operator who woke a
     * screen once silently loses the schedule for ever, and no override at all means the panel
     * fights them, going dark again within the minute while they are standing in front of it.
     */
    @Volatile private var manualOverride = false

    /**
     * elapsedRealtime until which a scheduled OFF is not applied, because the panel has not reached
     * the server yet. 0 = no hold. See [holdDarkUntilOnline].
     */
    @Volatile private var darkHoldUntilMs = 0L
    @Volatile private var darkHoldLogged = false

    /** Set by [holdDarkUntilOnline]: only a panel that waits for its server relights on a boot-time drop. */
    @Volatile private var bootGuardArmed = false

    /** Last state we actually applied, so a tick that changes nothing does nothing. */
    @Volatile private var appliedOff: Boolean? = null

    val state: String get() = if (appliedOff == true) "scheduled_off" else "on"

    /* ------------------------------------------------------------------ persistence */

    private fun prefs() = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /**
     * Load whatever we were last told, WITHOUT waiting for the server.
     *
     * ⚠️ This is the difference between a schedule and a remote command. A panel that reboots at
     * 02:00 with no WAN must come back up dark and stay dark until 06:00; if it waited for a
     * socket it would sit there lit in an empty shop all night, which is precisely the cost the
     * feature exists to avoid.
     */
    fun restore() {
        schedule = try {
            prefs().getString(KEY, null)?.let { PowerWindow.parse(JSONObject(it)) }
        } catch (e: Throwable) {
            Log.w(TAG, "restore: ${e.message}")
            null
        }
        Log.i(TAG, "restored schedule: ${describe()}")
        applyNow(force = true)
    }

    /**
     * Accept a schedule from the server — either the `power_schedule` field on a playlist payload
     * or a set_power_schedule command. null CLEARS it, deliberately: the payload always carries the
     * field, so an absent schedule means "you have none", not "no news". Treating null as no-news
     * would leave a deleted schedule running on the panel for ever.
     */
    fun update(o: JSONObject?) {
        val next = PowerWindow.parse(o)
        val before = PowerWindow.toJson(schedule)
        val after = PowerWindow.toJson(next)
        if (before == after) return                  // idempotent: every payload carries this field

        schedule = next
        try {
            prefs().edit().apply { if (after == null) remove(KEY) else putString(KEY, after) }.apply()
        } catch (e: Throwable) {
            Log.w(TAG, "persist: ${e.message}")
        }
        // A NEW schedule ends any manual override — the operator's exemption was from the old one.
        manualOverride = false
        Log.i(TAG, "schedule updated: ${describe()}")
        applyNow(force = true)
    }

    /**
     * The operator asked for the screen ON. If a window is currently running, exempt this panel
     * from it until the window ends.
     *
     * Returns true when the press actually meant something (i.e. we were scheduled off).
     */
    fun noteManualScreenOn(): Boolean {
        if (!PowerWindow.isOff(schedule, System.currentTimeMillis())) return false
        manualOverride = true
        appliedOff = false
        Log.i(TAG, "manual screen_on inside a scheduled-off window — schedule resumes at the next edge")
        onStateChanged?.invoke(state)
        return true
    }

    /** An operator screen_off is just a screen_off; it does not create a schedule or an override. */
    fun noteManualScreenOff() {
        manualOverride = false
    }

    /**
     * Keep the panel lit after a (re)start until the socket connects, or [maxMs] at most.
     *
     * ⚠️ GOING DARK BEFORE THE NETWORK IS UP STRANDS THE PANEL OFFLINE FOR HOURS.
     *
     * restore() runs seconds after boot, usually before Wi-Fi has associated. lockNow() then puts
     * the device to sleep, and with the screen off Android barely scans for Wi-Fi. Measured on a
     * Fanconn SC228 (SM6225, Android 14) rebooted at 22:19 inside its off window: 680 consecutive
     * connect errors, then the 08:00 edge woke the screen and the socket connected 19 s later. A
     * second panel rebooted nightly at 04:00 inside its window stayed offline 3 h 19 min every
     * day. Online on the dashboard is what tells the operator a dark panel is fine.
     *
     * The cap keeps the original promise — a panel that reboots with no WAN still goes dark, just a
     * few minutes later instead of at once.
     */
    fun holdDarkUntilOnline(maxMs: Long = BOOT_DARK_HOLD_MS) {
        darkHoldUntilMs = SystemClock.elapsedRealtime() + maxMs
        darkHoldLogged = false
        bootGuardArmed = true
    }

    /**
     * The socket is up. The caller re-asserts with applyNow(true).
     *
     * ⚠️ THE FIRST CONNECTION AFTER A BOOT IS NOT A STABLE ONE.
     *
     * Measured on the dev panel (AIC8800, Android 11), rebooted inside its off window with the hold
     * in place: socket up 1 s after the service started, dark at once, and Android dropped Wi-Fi
     * 3.5 s later (`disconnect reason:3`, station-initiated) and did not come back while dark. Lit,
     * it dropped and re-associated again 61 s after boot by itself (network 100 -> 101 -> 102). So
     * right after a boot the panel stays lit until [BOOT_SETTLE_MS] of uptime; later (an OTA or a
     * crash restarted only the service) the OFF applies at once, as before.
     */
    fun releaseDarkHold() {
        darkHoldUntilMs = holdAfterConnect(SystemClock.elapsedRealtime())
        darkHoldLogged = false
        scheduleHoldExpiry()
    }

    /**
     * The default network went away. Inside [BOOT_GRACE_MS] of a boot, while the schedule wants the
     * panel dark, light it again until the socket is back (at most [BOOT_DARK_HOLD_MS]): a panel
     * that loses Wi-Fi in the dark this early stays offline until the morning edge. Past the grace,
     * or with no window running, nothing happens — a dark shop is never lit all night.
     */
    fun onNetworkLost() {
        val now = SystemClock.elapsedRealtime()
        val want = decide(PowerWindow.isOff(schedule, System.currentTimeMillis()), manualOverride)
        val until = relightUntil(want.off, bootGuardArmed, now)
        if (until == 0L) return
        darkHoldUntilMs = until
        darkHoldLogged = false
        Log.i(TAG, "network lost ${now / 1000}s after boot inside an off window - lit until online (max ${(until - now) / 1000}s)")
        if (appliedOff != false) {
            appliedOff = false
            try { onApply(false) } catch (e: Throwable) { Log.w(TAG, "relight: ${e.message}") }
            onStateChanged?.invoke(state)
        }
        scheduleHoldExpiry()
    }

    /** The tick is a minute; the hold should end on time, not up to a minute late. */
    private fun scheduleHoldExpiry() {
        val wait = darkHoldUntilMs - SystemClock.elapsedRealtime()
        if (wait > 0) handler.postDelayed({
            try { applyNow(force = false) } catch (e: Throwable) { Log.w(TAG, "hold expiry: ${e.message}") }
        }, wait + 50)
    }

    /* ------------------------------------------------------------------ the tick */

    fun start() {
        stop()
        val r = object : Runnable {
            override fun run() {
                if (tick !== this) return            // a restart supersedes an in-flight tick
                try { applyNow(force = false) } catch (e: Throwable) { Log.w(TAG, "tick: ${e.message}") }
                handler.postDelayed(this, TICK_MS)
            }
        }
        tick = r
        handler.post(r)
    }

    fun stop() {
        tick?.let { handler.removeCallbacks(it) }
        tick = null
    }

    /**
     * Re-assert the correct state. Safe to call as often as you like.
     *
     * @param force apply even if it matches what we last applied — used on restore, on a schedule
     *   change, and on reconnect, where the panel's ACTUAL state may have drifted from ours
     *   (someone walked up and touched it, the OS slept it, an OTA restarted the activity).
     */
    fun applyNow(force: Boolean) {
        val want = decide(
            scheduledOff = PowerWindow.isOff(schedule, System.currentTimeMillis()),
            manualOverride = manualOverride
        )

        // Leaving the window clears the override, whichever way we are crossing.
        if (!PowerWindow.isOff(schedule, System.currentTimeMillis())) manualOverride = false

        // appliedOff stays untouched, so the first tick after the hold applies the OFF.
        if (deferDark(want.off, SystemClock.elapsedRealtime(), darkHoldUntilMs)) {
            if (!darkHoldLogged) Log.i(TAG, "scheduled off held for ${(darkHoldUntilMs - SystemClock.elapsedRealtime()) / 1000}s (until online / settled)")
            darkHoldLogged = true
            return
        }

        if (!force && appliedOff == want.off) return
        appliedOff = want.off
        if (want.clearOverride) manualOverride = false

        try {
            onApply(want.off)
        } catch (e: Throwable) {
            Log.w(TAG, "apply(${want.off}): ${e.message}")
        }
        onStateChanged?.invoke(state)
        Log.i(TAG, "power state -> $state${if (manualOverride) " (manual override)" else ""}")
    }

    private fun describe(): String {
        val s = schedule ?: return "none"
        return "enabled=${s.enabled} tz=${s.timezone ?: "device"} windows=${s.windows.size}"
    }

    data class Decision(val off: Boolean, val clearOverride: Boolean)

    companion object {
        private const val TAG = "PowerSchedule"
        private const val PREFS = "remote_display"
        private const val KEY = "power_schedule"
        private const val TICK_MS = 60_000L

        /** 3 min: boot to Wi-Fi to socket takes ~20-60 s on our panels; this leaves slack for a slow AP. */
        internal const val BOOT_DARK_HOLD_MS = 180_000L

        /** Uptime a boot needs before its Wi-Fi is trusted: Android re-associated by itself up to ~61 s in. */
        internal const val BOOT_SETTLE_MS = 120_000L

        /** After this much uptime a lost network no longer relights the panel. */
        internal const val BOOT_GRACE_MS = 600_000L

        /** Hold end once the socket is up: the end of the boot settle, or 0 (release) once past it. */
        @JvmStatic
        fun holdAfterConnect(nowElapsedMs: Long): Long =
            if (nowElapsedMs < BOOT_SETTLE_MS) BOOT_SETTLE_MS else 0L

        /** Hold end for a network lost in the dark, or 0 = leave the panel as it is. Never past the grace. */
        @JvmStatic
        fun relightUntil(wantOff: Boolean, armed: Boolean, nowElapsedMs: Long): Long =
            if (armed && wantOff && nowElapsedMs < BOOT_GRACE_MS) minOf(nowElapsedMs + BOOT_DARK_HOLD_MS, BOOT_GRACE_MS) else 0L

        /** True while a scheduled OFF must wait for the hold. An ON is never delayed. */
        @JvmStatic
        fun deferDark(wantOff: Boolean, nowElapsedMs: Long, holdUntilElapsedMs: Long): Boolean =
            wantOff && nowElapsedMs < holdUntilElapsedMs

        /**
         * The whole decision, as a pure function, so it can be tested without a Context, a Looper
         * or a clock. Three inputs, one answer:
         *
         *   - not in a window        -> on, and any override is spent
         *   - in a window, no override -> off
         *   - in a window, override    -> stay on (the operator asked, and the window has not ended)
         */
        @JvmStatic
        fun decide(scheduledOff: Boolean, manualOverride: Boolean): Decision {
            if (!scheduledOff) return Decision(off = false, clearOverride = true)
            if (manualOverride) return Decision(off = false, clearOverride = false)
            return Decision(off = true, clearOverride = false)
        }
    }
}
