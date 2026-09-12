package com.remotedisplay.player.telemetry

import android.content.Context
import android.os.Build
import android.provider.Settings
import android.util.Log
import com.remotedisplay.player.admin.STPolicy
import org.json.JSONArray

/**
 * What THIS panel can actually do, right now.
 *
 * The dashboard used to offer every control to every display, so buttons that could never work on
 * a given panel sat there and did nothing when pressed. The server-side vocabulary lives in
 * `server/lib/player-capabilities.js`; these strings must match it exactly, because an unknown
 * name is dropped on arrival and a renamed one silently removes a control from every panel still
 * reporting the old spelling.
 *
 * ⚠️ Computed at REGISTRATION, not build time. Almost everything interesting here is runtime state
 * an APK cannot know about itself: accessibility gets switched on months after install, device
 * owner is granted by a provisioning flow, WRITE_SETTINGS is a per-device grant an operator may
 * revoke. A static list would be wrong on the same hardware from one boot to the next.
 *
 * The rule when uncertain is to UNDER-claim. A missing control is a support question; a control
 * that appears to work and does nothing is a bug report, and on a panel nobody can reach it is an
 * expensive one.
 */
object PlayerCapabilities {

    /**
     * The capability set for this device, as a JSON array ready to attach to the register payload.
     * Never throws: a failure here must not cost the panel its registration, so the worst case is
     * an empty declaration, which the server reads as "declares nothing meaningful".
     */
    fun declare(context: Context): JSONArray {
        val caps = mutableListOf<String>()
        try {
            val policy = STPolicy(context)
            val isOwner = policy.isDeviceOwner()
            val canInstall = policy.canInstallSilently()
            val canWriteSettings = try { Settings.System.canWrite(context) } catch (_: Throwable) { false }
            val accessibility = DeviceInfo(context).isAccessibilityEnabled()

            // ---- always true on the Android player -------------------------------------------------
            // Every content type the playlist engine renders, plus the layout features built on it.
            caps += listOf(
                "playback.video", "playback.image", "playback.widget", "playback.youtube",
                "playback.zones", "playback.transitions", "playback.pip",
                // Mounting a server-flattened HTML bundle is the widget WebView with a different
                // URL, so this build can always do it. It says nothing about offline: nothing here
                // unpacks an archive, so a bundle needs the server even on a panel that caches media.
                "playback.bundle",
                // Slide decks with a voiceover / music bed. SlideAudioPlayer owns two ExoPlayers of
                // its own, outside the widget WebView that draws the slide — so this build really
                // does make the sound. Note the android BASELINE in player-capabilities.js does NOT
                // grant it: a fielded panel on an older APK renders the slide silently, and would be
                // lying if the server claimed it on the panel's behalf. This line is how an updated
                // panel earns it.
                "playback.slide_audio",
                // Mute reaches the YouTube embed through the IFrame API bridge, not just <video>,
                // so this is a real claim rather than the half-truth the browser players carried.
                "audio.mute", "audio.volume",
                // Native view rotation: the ExoPlayer surface sits inside the rotated view, so video
                // turns with the graphics. No hardware-plane problem here.
                "display.rotation",
                // Per-window overlay dim (WindowManager.LayoutParams.screenBrightness) — Tier 0, no
                // permission, works at any privilege level. Distinct from "system.brightness" below,
                // which writes the system-wide setting and DOES need WRITE_SETTINGS or owner.
                // Declared here because the android BASELINE already grants it: without this line an
                // updated panel replaces the baseline with a declared set that lacks it, and LOSES
                // the dim slider it had before it updated.
                "display.brightness",
                // Capture, at ANY privilege level. captureScreen() is a three-rung fallback —
                // MediaProjection (system-wide, needs consent), then the accessibility screenshot
                // API, then ScreenshotCapture.captureView, which is a plain view draw with no
                // permission check of any kind. The last rung is narrower than the others (the
                // player's own window, foreground only) but on a kiosk panel that window IS the
                // content, so the operator gets a picture rather than a refusal.
                //
                // Declared unconditionally for the same reason display.brightness is: the android
                // BASELINE grants both, and a declared set replaces the baseline rather than
                // merging with it. Gating on accessibility meant a panel LOST live view and
                // screenshots by updating, while the fallback that still served them kept working.
                // It also made granting MediaProjection invisible — consent was given, capture
                // genuinely started, and the server went on refusing because nothing re-declared.
                "remote.screenshot", "remote.stream",
                // Input is plain view dispatch and works regardless of privilege.
                "remote.input",
                // #talk: voice intercom (TalkService + AudioTalker). WebRTC audio over the same
                // go2rtc path as remote.stream; needs only RECORD_AUDIO, no MediaProjection.
                // remote.talk = can play the operator's audio/webcam (one-way / PA); remote.mic =
                // also has a microphone to send back (unlocks 2-way). Android has both.
                "remote.talk", "remote.mic",
                // #312 follow-up: accept a server-URL rewrite from the dashboard, VERIFYING the new
                // address is reachable before committing and rolling back if not (see
                // WebSocketService's set_server_url handler). Declared because we do that
                // verify-then-commit, which is the whole reason the command is gated.
                "remote.set_server_url",
                // The player restarts itself; the OTA checker updates the APK.
                "system.restart_player", "system.self_update",
                // Clock-derived group sync is platform-independent.
                "sync.clock",
                // Content is cached to local storage and survives a server outage.
                "offline.cache",
                // App-UID `sh -c`. Deliberately NOT gated on device owner: it runs at any tier and
                // is the diagnostic path the dashboard already relies on. Gated server-side instead.
                "system.shell"
            )

            // ---- conditional on runtime state -------------------------------------------------------

            // Display power is asymmetric and only honest when BOTH halves exist. screen_off needs
            // owner, device-admin FORCE_LOCK, or accessibility; screen_on now works anywhere via a
            // wake lock (WAKE_LOCK is a normal permission). So the binding constraint is the OFF
            // path — offering a control that sleeps a panel it cannot wake would be the worst
            // possible version of this feature.
            if (isOwner || policy.isAdminActive() || accessibility) caps += "display.power"

            // Owner-only reboot. Off-owner it degrades to an accessibility power DIALOG, which needs
            // someone standing at the screen — not a remote capability.
            if (isOwner) caps += "system.reboot"

            // Silent lock-task. Off-owner startLockTask() gives screen pinning, which prompts for
            // confirmation — unusable on a panel with no input, so not claimed.
            if (isOwner) caps += "system.kiosk"

            // The privilege itself, declared as a capability. Every #161 Tier-2 command
            // (lock_now / power_menu / status_bar / block_uninstall / unblock_uninstall) gates on
            // this name. No player declared it, so the server accepts "system.kiosk" as a stand-in —
            // exact, because kiosk is itself owner-only, but a stand-in nonetheless. Declaring the
            // canonical name makes those refusals say what they mean and lets the stand-in retire.
            if (isOwner) caps += "system.device_owner"

            // Owner-only clock control.
            if (isOwner) caps += "system.time"

            // Silent install: device owner, or a foreign DPC that delegated the install scope.
            if (canInstall) caps += "system.install_apk"

            // System-wide brightness and screen-off timeout: WRITE_SETTINGS, or an owner writing the
            // setting directly. Per-window dimming works at any tier but is not what the operator
            // means by "brightness", so it does not earn the claim on its own.
            if (canWriteSettings || isOwner) caps += listOf("system.brightness", "system.screen_timeout")

            Log.i(TAG, "Capabilities: ${caps.size} declared (owner=$isOwner install=$canInstall " +
                "writeSettings=$canWriteSettings a11y=$accessibility)")
        } catch (e: Throwable) {
            // An empty array is honest here. Falling back to "everything" would put us straight back
            // to buttons that do nothing, which is the failure this whole model exists to remove.
            Log.w(TAG, "Capability detection failed: ${e.message}")
        }
        return JSONArray(caps)
    }

    private const val TAG = "PlayerCapabilities"
}

/*
 * Deliberately NOT declared on Android, so the dashboard stops offering them:
 *
 *   display.resolution  Setting the output mode needs system/root. The panel runs at whatever the
 *                       display negotiated and an app cannot change it.
 *   sync.native         Frame-accurate hardware sync is a BrightSign SyncManager feature. Android's
 *                       clock-derived group sync is declared instead, which is what it actually has.
 */
