package com.remotedisplay.player.service

import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.content.FileProvider
import com.remotedisplay.player.data.ServerConfig
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

class UpdateChecker(private val context: Context) {

    private val TAG = "UpdateChecker"
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()
    private val handler = Handler(Looper.getMainLooper())
    private val config = ServerConfig(context)
    private var checkTimer: Runnable? = null

    // Check every 30 minutes
    private val CHECK_INTERVAL = 30 * 60 * 1000L

    private var installReceiverRegistered = false
    // Held so shutdown() can unregister it; without a handle the receiver outlives the Activity.
    private var installReceiver: BroadcastReceiver? = null

    // #139: report OTA status to the dashboard (device:log, tag "ota"). Wired by MainActivity
    // to WebSocketService.sendLog; null until then. Read lazily so binding order doesn't matter.
    // The throttle thresholds + decision rules live in OtaThrottle (pure, unit-tested); this
    // class is the imperative shell that persists state and does the download/install.
    var otaLogReporter: ((level: String, message: String) -> Unit)? = null

    /*
     * Why the last download/verify attempt failed, in specific terms.
     *
     * The caller could only ever say "failed to download or failed signature verification", which
     * covers SEVEN distinct branches — three of them download failures where verification never
     * runs at all. Every specific reason went to logcat, which an unprivileged app UID cannot read
     * on Android 9, so in the field the message was unactionable: it named a symptom shared by
     * unrelated causes and pointed at the wrong half of the code as often as the right one.
     * Diagnosing one occurrence took an evening. This makes the next one a sentence.
     */
    private var lastFailure: String? = null

    private fun report(level: String, message: String) {
        when (level) { "error" -> Log.e(TAG, message); "warn" -> Log.w(TAG, message); else -> Log.i(TAG, message) }
        try { otaLogReporter?.invoke(level, message) } catch (_: Throwable) {}
    }

    // #139 Phase 2 (Option B): announce an OTA status TRANSITION to the server (wired by
    // MainActivity to WebSocketService.sendOtaStatus, which reads the just-persisted state).
    // Fired ONLY at the two transitions — clear and enter-backoff — so the dashboard badge
    // updates promptly without waiting for a reconnect, with no per-poll/heartbeat chatter.
    // Lazy/null-safe so binding order doesn't matter, same as otaLogReporter.
    var otaStatusReporter: (() -> Unit)? = null
    private fun announceOtaStatus() { try { otaStatusReporter?.invoke() } catch (_: Throwable) {} }

    // The PackageInstaller session reports its status (incl. STATUS_PENDING_USER_ACTION,
    // which Android 13+ returns for non-device-owner installers) via this broadcast.
    // Without handling it the committed session just stalls and the update never
    // installs. On the action prompt we launch the confirm dialog; the accessibility
    // service auto-confirms it on kiosks.
    private fun ensureInstallReceiver() {
        if (installReceiverRegistered) return
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                when (intent.getIntExtra(android.content.pm.PackageInstaller.EXTRA_STATUS, -999)) {
                    android.content.pm.PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                        val confirm = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
                            intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                        else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_INTENT)
                        if (confirm != null) {
                            confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            try { context.startActivity(confirm); Log.i(TAG, "Launched install confirmation") }
                            catch (e: Exception) { Log.e(TAG, "Confirm launch failed: ${e.message}") }
                        }
                    }
                    // Logcat only — NOT report(): these fire per attempt, and #139 keeps the
                    // device:log/dashboard channel to state transitions (enter-backoff, clear).
                    android.content.pm.PackageInstaller.STATUS_SUCCESS -> Log.i(TAG, "Update installed successfully")
                    else -> Log.w(TAG, "Install status: ${intent.getStringExtra(android.content.pm.PackageInstaller.EXTRA_STATUS_MESSAGE)}")
                }
            }
        }
        val filter = IntentFilter("com.remotedisplay.player.INSTALL_COMPLETE")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag") context.registerReceiver(receiver, filter)
        }
        installReceiverRegistered = true
        installReceiver = receiver
    }

    fun startPeriodicCheck() {
        stopPeriodicCheck()
        ensureInstallReceiver()
        checkTimer = object : Runnable {
            override fun run() {
                checkForUpdate()
                handler.postDelayed(this, CHECK_INTERVAL)
            }
        }
        // First check after 60 seconds (let the app settle)
        handler.postDelayed(checkTimer!!, 60000)
        Log.i(TAG, "Periodic update check started (every ${CHECK_INTERVAL / 60000}m)")
    }

    fun stopPeriodicCheck() {
        checkTimer?.let { handler.removeCallbacks(it) }
        checkTimer = null
    }

    /**
     * Full teardown for an Activity that is going away.
     *
     * stopPeriodicCheck alone leaves the install receiver registered against a dead Context, and
     * installReceiverRegistered is per-instance — so each Activity recreate produced another
     * checker polling /api/update/check and another receiver for INSTALL_COMPLETE. N of those means
     * one STATUS_PENDING_USER_ACTION fires N confirm dialogs over customer content, and concurrent
     * checkers race in tryPackageInstaller, which begins by abandoning ALL of this app's installer
     * sessions — so one can abandon another's staged session mid-flight and the update never lands.
     */
    fun shutdown() {
        stopPeriodicCheck()
        if (installReceiverRegistered) {
            installReceiver?.let { r -> try { context.unregisterReceiver(r) } catch (_: Throwable) { /* already gone */ } }
            installReceiver = null
            installReceiverRegistered = false
        }
    }

    /**
     * [forced] = an operator pressed "force update" on this specific device, rather than the
     * 30-minute timer firing. A forced run differs in three ways, all because a human aimed it at
     * one panel and is watching:
     *   - it ignores the backoff cap (the budget is handed back, so a parked device retries NOW),
     *   - it overrides the MDM stand-down (a targeted human action outranks a blanket default),
     *   - it REPORTS what happened, including the nothing-to-do cases.
     * That last one is the point. The dashboard toast only ever confirmed the command reached the
     * socket; every reason the device might then do nothing returned silently, so a capped or
     * managed panel looked identical to a working one.
     */
    fun checkForUpdate(forced: Boolean = false) {
        if (config.serverUrl.isEmpty()) return

        Thread {
            try {
                val currentVersion = getAppVersion()
                // #144: send our stable registered device_id so the server OTA breaker can throttle
                // per-device (not per-NAT-IP). Reuses the same id we register/socket with; omitted
                // until provisioned (server then falls back to version-keyed).
                val deviceParam = if (config.deviceId.isNotEmpty()) "&device_id=${config.deviceId}" else ""
                val url = "${config.serverUrl}/api/update/check?version=$currentVersion$deviceParam"
                Log.i(TAG, "Checking for updates: $url")

                val request = Request.Builder().url(url).build()
                val response = client.newCall(request).execute()

                if (!response.isSuccessful) {
                    Log.w(TAG, "Update check failed: ${response.code}")
                    return@Thread
                }

                val json = JSONObject(response.body?.string() ?: "{}")
                val updateAvailable = json.optBoolean("update_available", false)
                val latestVersion = json.optString("latest_version", currentVersion)
                val downloadUrl = json.optString("download_url", "")
                // #166 escape hatch: the operator set OTA_ALLOW_MANAGED_DEVICES, so self-update is
                // permitted even under a foreign DPC. Defaults FALSE, which is also what an older
                // server (that never sends the field) yields — absence must never read as consent.
                val allowManaged = json.optBoolean("allow_managed", false)

                Log.i(TAG, "Current: $currentVersion, Latest: $latestVersion, Update: $updateAvailable")

                if (!updateAvailable) {
                    // A forced check that finds nothing must SAY nothing-to-do. Silence here is
                    // what made the button look broken when it was working correctly.
                    if (forced) report("info", "Force update: already on the latest version ($currentVersion)")
                    // #139: on the latest version now. If OTA state was pending, the install
                    // landed (the app relaunched as the new version) — clear state + caches once.
                    if (OtaThrottle.shouldClearOnUpToDate(otaState())) {
                        report("info", "OTA complete: now on $currentVersion — clearing update state")
                        config.clearOtaState()
                        cleanupApks(null)
                        announceOtaStatus() // transition -> emits 'none' so the badge clears promptly
                    }
                } else if (downloadUrl.isNotEmpty()) {
                    // #155/#161: if a foreign DPC genuinely OWNS this panel, IT owns updates. Stand
                    // down — never self-install: on a managed device the confirm dialog can't be
                    // reliably auto-dismissed and ends up over customer content. The MDM pushes the
                    // APK instead. Client-side safety net, independent of the server OTA switch.
                    //
                    // Checked HERE rather than before the request: standing down early meant a
                    // stood-down panel never learned an update existed, so it reported ota_status
                    // 'none' — indistinguishable from up to date — and no dashboard ever flagged it.
                    //
                    // A forced run overrides it: the operator is aiming at ONE device and can see
                    // the screen, which is a stronger and better-targeted signal than the global
                    // OTA_ALLOW_MANAGED_DEVICES switch.
                    val managedNow = isManagedByForeignDeviceOwner()
                    if (com.remotedisplay.player.admin.ManagedLogic.standDownFromSelfOta(
                            managedNow, allowManaged || forced)) {
                        val (managed, first) = OtaThrottle.onManagedStandDown(
                            otaState(), latestVersion, System.currentTimeMillis())
                        persistOta(managed)
                        Log.i(TAG, "Managed by a foreign DPC — self-OTA stands down; $latestVersion needs the MDM (or a human)")
                        if (first) {
                            report("warn", "Update $latestVersion available but this panel is managed by another device owner — self-install is disabled; push it from your MDM or update manually")
                            announceOtaStatus() // transition -> 'manual_update_required' so the badge shows
                        }
                        return@Thread
                    }
                    if (managedNow) {
                        // Loud on purpose: a safety default was overridden, and the confirm dialog
                        // this may raise over customer content is the cost of that choice.
                        val why = if (forced) "operator forced it" else "server allows managed self-update"
                        Log.i(TAG, "Managed by a foreign DPC, but $why — proceeding")
                        if (forced) report("warn", "Force update: this panel is managed by another device owner — installing anyway at your request; a confirm dialog may appear on screen")
                    }
                    if (forced) {
                        // Hand the attempt budget back so a device parked in backoff acts NOW
                        // instead of waiting out the window.
                        persistOta(OtaThrottle.onForcedCheck(otaState()))
                    }
                    maybeUpdate(latestVersion, "${config.serverUrl}$downloadUrl", forced)
                }
            } catch (e: Exception) {
                Log.e(TAG, "Update check error: ${e.message}")
            }
        }.start()
    }

    private fun otaState() = OtaThrottle.State(
        config.otaTargetVersion, config.otaAttempts, config.otaLastAttemptAt, config.otaBackoffReported)

    private fun persistOta(s: OtaThrottle.State) {
        config.otaTargetVersion = s.targetVersion
        config.otaAttempts = s.attempts
        config.otaLastAttemptAt = s.lastAttemptAt
        config.otaBackoffReported = s.backoffReported
    }

    // #139 imperative shell over OtaThrottle (the pure, unit-tested decision logic). A device
    // that can't silently install (Fire TV: no device-owner) stops re-pulling the full APK every
    // cycle. Only a COMMITTED install consumes the attempt budget — a transient download/verify
    // failure on a HEALTHY device must never park it in backoff.
    private fun maybeUpdate(latestVersion: String, downloadUrl: String, forced: Boolean = false) {
        val now = System.currentTimeMillis()
        val cur = otaState()
        if (OtaThrottle.isNewTarget(cur, latestVersion)) cleanupApks(latestVersion)

        val (afterCheck, action) = OtaThrottle.onUpdateAvailable(cur, latestVersion, now)
        persistOta(afterCheck)
        // Capped + still inside the window: do nothing AND stay silent. Fire OS restarts re-fire
        // this check constantly; reporting here would just move the flood onto the WS channel.
        // The enter-backoff line was already sent once on the crossing (below).
        if (action == OtaThrottle.Action.BACKOFF) {
            // Can only be reached unforced: a forced run hands the budget back before calling in.
            if (forced) report("warn", "Force update: still backing off on $latestVersion — this should not happen, please report it")
            return
        }

        // download/verify failure → retry on the normal cadence; do NOT count it as an attempt.
        if (!downloadAndInstall(downloadUrl, latestVersion)) {
            Log.w(TAG, "Update $latestVersion: download/verify failed — retry next check (no attempt consumed)")
            // Unforced this is deliberately quiet (transient network blips are not news). Forced,
            // somebody is waiting on an answer, and "the APK would not download or did not match
            // our signing key" is the single most useful thing we can tell them.
            if (forced) report("error", "Force update: $latestVersion not installed — ${lastFailure ?: "reason unavailable"}")
            return
        }

        val (afterLaunch, enteredBackoff) = OtaThrottle.onInstallLaunched(afterCheck, now)
        persistOta(afterLaunch)
        Log.i(TAG, "Install launched for $latestVersion (attempt ${afterLaunch.attempts}/${OtaThrottle.MAX_INSTALL_ATTEMPTS})")
        if (forced) {
            // The APK is verified and the installer is launched — but off device-owner Android
            // raises a confirm dialog, and "launched" is NOT "installed". Say which one happened,
            // because the gap between them is exactly where force-update appears to do nothing.
            report("info", if (canInstallSilently())
                "Force update: installing $latestVersion silently"
            else
                "Force update: $latestVersion downloaded and verified, install launched — a confirm dialog must be accepted on the device unless an accessibility service does it")
        }
        if (enteredBackoff) {
            report("warn", "Update $latestVersion downloaded and verified, but ${afterLaunch.attempts} install attempts have not completed — a human needs to accept the install prompt on this device (or the MDM needs to delegate install permission). Still retrying.")
            announceOtaStatus() // transition -> emits 'manual_update_required'
        }
    }

    // #139: remove cached OTA APKs other than `keep` (null = remove all). Keeps the external
    // files dir from accumulating one stale APK per superseded version.
    private fun cleanupApks(keep: String?) {
        try {
            val dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: return
            val keepName = keep?.let { "ScreenTinker-$it.apk" }
            dir.listFiles { f ->
                f.name.startsWith("ScreenTinker-") && f.name.endsWith(".apk") && f.name != keepName
            }?.forEach { it.delete() }
        } catch (e: Exception) {
            Log.w(TAG, "APK cleanup failed: ${e.message}")
        }
    }

    // Returns TRUE only when a verified APK is in hand and an install has been launched (the
    // caller may then count an attempt); FALSE on any download/verify failure — the caller must
    // NOT count those, so a transient network problem can't burn a healthy device's budget. #139
    /*
     * Where a downloaded APK is staged.
     *
     * getExternalFilesDir() returns NULL whenever external storage is not mounted/available — and
     * on a signage panel that is not exotic: no emulated volume, a vendor ROM that never mounts one,
     * an SD card ejected, storage still unmounted early in boot.
     *
     * The bug this replaces: `File(context.getExternalFilesDir(...), name)`. Java's File(File,String)
     * treats a NULL parent as "no parent" and silently produces a RELATIVE path, so the download
     * targeted `ScreenTinker-x.y.z.apk` in the process working directory — `/` — which is not
     * writable. The write threw, the generic catch swallowed it, and the caller reported only
     * "failed to download or failed signature verification". Nothing was ever written, so there was
     * no partial file to find and nothing in the message pointed at storage. It fails on EVERY
     * attempt, forever, on an affected panel — and identically for the pushed-APK path, which had
     * the same line.
     *
     * Internal storage always exists, so fall back to it. It costs nothing when external is present.
     * NOTE: the intent-based install fallback resolves this file through FileProvider, so
     * res/xml/file_paths.xml must expose this directory too — see the <files-path> entry there.
     */
    /*
     * Where to stage a downloaded APK — the FIRST location that actually accepts bytes.
     *
     * Internal app storage is tried first and is effectively guaranteed: /data/data/<pkg>/files is
     * this app's own private directory, always mounted, always writable. If it is not, the app is
     * not running. External storage is only a convenience (it survives uninstall and is visible for
     * a manual install), and it is the one that fails — it can be absent, unmounted, present but
     * unwritable, or report canWrite() = true and then refuse the write anyway.
     *
     * ⚠️ Each candidate is PROVEN with a real write, not asked. The previous version asked
     * canWrite(), believed the answer, and then died at outputStream() — before a single byte — so
     * the update failed instantly and reported it as a download problem. Every fallback in the world
     * is useless if the first choice is trusted rather than tested.
     *
     * Returns the directory, or null with every reason it could not find one, so the operator gets
     * the full picture instead of the first excuse.
     */
    private fun apkStagingDir(needBytes: Long): Pair<File?, String> {
        val candidates = LinkedHashMap<String, File>()
        candidates["internal"] = File(context.filesDir, "Download")
        context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)?.let { candidates["external"] = it }
        candidates["cache"] = File(context.cacheDir, "Download")
        candidates["files"] = context.filesDir          // last resort: no subdirectory to create

        val reasons = StringBuilder()
        for ((name, dir) in candidates) {
            val problem = apkDirProblem(dir, needBytes)
            if (problem == null) {
                if (name != "internal") Log.w(TAG, "Staging APK in $name (${dir.absolutePath})")
                return dir to name
            }
            if (reasons.isNotEmpty()) reasons.append("; ")
            reasons.append("$name ${problem}")
        }
        return null to reasons.toString()
    }

    private fun apkDirProblem(dir: File, needBytes: Long): String? {
        if (!dir.exists() && !dir.mkdirs()) return "cannot create ${dir.absolutePath}"
        if (!dir.isDirectory) return "${dir.absolutePath} is not a directory"
        if (!dir.canWrite()) return "no write permission on ${dir.absolutePath}"
        val free = try { dir.usableSpace } catch (_: Throwable) { -1L }
        // Headroom, not an exact fit: the installer stages its own copy of the APK as well, so a
        // volume with barely the download's worth free still fails at install time.
        if (needBytes > 0 && free in 0 until (needBytes * 2)) {
            return "only ${free / 1024 / 1024}MB free on ${dir.absolutePath}, need ~${needBytes * 2 / 1024 / 1024}MB"
        }
        // Prove it rather than infer it: canWrite() can be true on a volume that refuses the write.
        return try {
            val probe = File(dir, ".st-write-probe")
            probe.writeBytes(byteArrayOf(1))
            probe.delete()
            null
        } catch (e: Throwable) {
            "write test failed in ${dir.absolutePath}: ${e.javaClass.simpleName} ${e.message}"
        }
    }

    private fun downloadAndInstall(url: String, version: String): Boolean {
        try {
            // Find somewhere that will actually take the file, before asking the network for it.
            val (dir, whereOrWhy) = apkStagingDir(9L * 1024 * 1024)
            if (dir == null) {
                lastFailure = "nowhere to stage the update — $whereOrWhy"
                Log.e(TAG, "APK staging unavailable: $whereOrWhy")
                return false
            }
            val apkFile = File(dir, "ScreenTinker-$version.apk")

            // #139: reuse a previously-downloaded, verified APK for this version instead of
            // re-pulling ~8.7 MB every cycle. The file also stays on disk as the artifact for a
            // manual install when silent install isn't possible.
            if (apkFile.exists() && verifyApkSignature(apkFile)) {
                Log.i(TAG, "Reusing cached verified APK: ${apkFile.absolutePath} (${apkFile.length()} bytes)")
                handler.post { installApk(apkFile) }
                return true
            }
            // A leftover but invalid file (partial/corrupt/tampered) must never be reused.
            if (apkFile.exists()) apkFile.delete()

            // Download to a temp file
            val request = Request.Builder().url(url).build()
            val response = client.newCall(request).execute()

            if (!response.isSuccessful) {
                lastFailure = "server returned HTTP ${response.code} for the APK"
                Log.e(TAG, "Download failed: ${response.code}")
                return false
            }

            response.body?.byteStream()?.use { input ->
                apkFile.outputStream().use { output ->
                    input.copyTo(output)
                }
            }

            Log.i(TAG, "APK downloaded: ${apkFile.absolutePath} (${apkFile.length()} bytes)")

            // SECURITY (#5 review): never install an APK we didn't sign. The update
            // is fetched from a server-supplied URL, often over cleartext with no
            // pinning - a MITM or compromised server could otherwise return a
            // malicious APK and get it silently installed (REQUEST_INSTALL_PACKAGES).
            // Verify the downloaded APK is our package AND signed by the same key as
            // the currently-installed app before installing. An attacker can't forge
            // our signature, so this holds even over an untrusted transport.
            if (!verifyApkSignature(apkFile)) {
                // lastFailure was set precisely inside verifyApkSignature; keep it, and add the
                // size so a truncated download is distinguishable from a genuine cert mismatch.
                lastFailure = "${lastFailure ?: "signature verification failed"} (downloaded ${apkFile.length()} bytes)"
                Log.e(TAG, "Refusing update: APK signature/package verification failed (tampered or MITM'd APK)")
                apkFile.delete()
                return false
            }
            Log.i(TAG, "APK signature verified against installed app - proceeding to install")

            // Install the APK
            handler.post {
                installApk(apkFile)
            }
            return true
        } catch (e: Exception) {
            lastFailure = "download/install threw ${e.javaClass.simpleName}: ${e.message}"
            Log.e(TAG, "Download/install error: ${e.message}")
            return false
        }
    }

    // #161 device-owner tooling: push + install an ARBITRARY APK from an operator-supplied URL. Unlike
    // the self-update path this does NOT require our signing key — a device owner can install any
    // package, silently (installApk → tryPackageInstaller → USER_ACTION_NOT_REQUIRED on an owner). Off
    // owner it degrades to the normal confirm-dialog install. Gated to admins server-side.
    fun installFromUrl(url: String) {
        Thread {
            try {
                val base = url.substringAfterLast('/').substringBefore('?').ifBlank { "app.apk" }
                val fileName = "pushed-" + (if (base.endsWith(".apk")) base else "$base.apk")
                val (dir, whyNot) = apkStagingDir(9L * 1024 * 1024)
                if (dir == null) { Log.e(TAG, "installFromUrl: nowhere to stage — $whyNot"); return@Thread }
                val apkFile = File(dir, fileName)
                if (apkFile.exists()) apkFile.delete()
                val response = client.newCall(Request.Builder().url(url).build()).execute()
                if (!response.isSuccessful) { Log.e(TAG, "installFromUrl: download failed ${response.code}"); return@Thread }
                response.body?.byteStream()?.use { input -> apkFile.outputStream().use { input.copyTo(it) } }
                Log.i(TAG, "Pushed APK downloaded: ${apkFile.name} (${apkFile.length()} bytes)")
                handler.post { installApk(apkFile) }
            } catch (e: Throwable) { Log.e(TAG, "installFromUrl: ${e.message}") }
        }.start()
    }

    private fun installApk(apkFile: File) {
        // Try silent session install first (no Play Protect dialog)
        try {
            tryPackageInstaller(apkFile)
            return
        } catch (e: Exception) {
            Log.w(TAG, "Session install failed: ${e.message}, falling back to intent")
        }

        // Fallback: intent-based install (shows dialog)
        try {
            val intent = Intent(Intent.ACTION_VIEW)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                val uri = FileProvider.getUriForFile(
                    context,
                    "${context.packageName}.fileprovider",
                    apkFile
                )
                intent.setDataAndType(uri, "application/vnd.android.package-archive")
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            } else {
                intent.setDataAndType(Uri.fromFile(apkFile), "application/vnd.android.package-archive")
            }

            context.startActivity(intent)
            Log.i(TAG, "Install intent launched")
        } catch (e: Exception) {
            Log.e(TAG, "Install failed: ${e.message}")
        }
    }

    private fun tryPackageInstaller(apkFile: File) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                val installer = context.packageManager.packageInstaller
                // Abandon our own leftover sessions first. Every attempt stages a FULL copy of the
                // APK (~8.7MB) via openWrite, and a session whose confirm dialog is never accepted
                // just sits there holding it. At three attempts that was a rounding error; at forty
                // it would be ~350MB of staged installs on a panel nobody walks up to, on hardware
                // that does not have it spare. Also keeps us clear of the per-app session limit,
                // which would start throwing once enough accumulated.
                try {
                    for (s in installer.mySessions) {
                        try { installer.abandonSession(s.sessionId) } catch (_: Throwable) { /* already gone */ }
                    }
                } catch (e: Throwable) { Log.w(TAG, "Session cleanup skipped: ${e.message}") }
                val params = android.content.pm.PackageInstaller.SessionParams(
                    android.content.pm.PackageInstaller.SessionParams.MODE_FULL_INSTALL
                )
                // #161/#155: on a device owner (or delegated install scope) declare no user action so
                // the install is truly silent — no STATUS_PENDING_USER_ACTION, no confirm dialog, no
                // accessibility race. Below API 31 a device-owner install is silent by default, and off
                // tier this is skipped so the existing dialog + accessibility-auto-confirm fallback runs.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                    com.remotedisplay.player.admin.STPolicy(context).canInstallSilently()) {
                    params.setRequireUserAction(
                        android.content.pm.PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED
                    )
                    Log.i(TAG, "Silent install (device owner / delegated scope): USER_ACTION_NOT_REQUIRED")
                }
                val sessionId = installer.createSession(params)
                val session = installer.openSession(sessionId)

                apkFile.inputStream().use { input ->
                    session.openWrite("ScreenTinker", 0, apkFile.length()).use { output ->
                        input.copyTo(output)
                        session.fsync(output)
                    }
                }

                // #96 (install bug): the status PendingIntent must stay FLAG_MUTABLE so
                // PackageInstaller can write EXTRA_STATUS back into it - but on Android 14+
                // (target SDK 34+) a FLAG_MUTABLE PendingIntent with an *implicit* intent is
                // disallowed and getBroadcast() throws, silently aborting every OTA on 14+.
                // Make the intent explicit (setPackage) so mutable is allowed; it also keeps
                // the broadcast to our own RECEIVER_NOT_EXPORTED receiver.
                val pendingIntent = android.app.PendingIntent.getBroadcast(
                    context, sessionId,
                    Intent("com.remotedisplay.player.INSTALL_COMPLETE").setPackage(context.packageName),
                    android.app.PendingIntent.FLAG_MUTABLE
                )
                session.commit(pendingIntent.intentSender)
                Log.i(TAG, "Package installer session committed")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Package installer failed: ${e.message}")
        }
    }

    // True only if the downloaded APK is this same package and shares a signing
    // certificate with the installed app. Fail-closed on any error.
    private fun verifyApkSignature(apkFile: File): Boolean {
        return try {
            val pm = context.packageManager
            // #139: getPackageArchiveInfo(GET_SIGNING_CERTIFICATES).signingInfo is NULL for
            // ARCHIVE files on API 28/29 (it's only populated from API 30) — so the modern flag
            // reads 0 certs from a downloaded APK and we'd wrongly REFUSE a legitimate update,
            // which is the real Fire OS 8 / Android 9 OTA-loop cause. Below API 30, read the
            // archive's signer via the legacy GET_SIGNATURES + .signatures (its v1/JAR cert,
            // which IS populated on 28/29). This reads the cert CORRECTLY — it does not weaken
            // verification: the archive's signer is still extracted and compared to the installed
            // app's signer below, and a mismatch / zero-cert APK is still rejected.
            val archiveUsesSigningInfo = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R // API 30
            val archiveFlags = if (archiveUsesSigningInfo)
                PackageManager.GET_SIGNING_CERTIFICATES else @Suppress("DEPRECATION") PackageManager.GET_SIGNATURES
            val downloaded = pm.getPackageArchiveInfo(apkFile.absolutePath, archiveFlags)
            if (downloaded == null) {
                lastFailure = "the downloaded file could not be parsed as an APK (truncated or not an APK)"
                Log.e(TAG, "Could not parse downloaded APK")
                return false
            }
            if (downloaded.packageName != context.packageName) {
                lastFailure = "APK is package ${downloaded.packageName}, expected ${context.packageName}"
                Log.e(TAG, "APK package mismatch: ${downloaded.packageName} != ${context.packageName}")
                return false
            }
            // INSTALLED-app read: signingInfo IS populated for installed packages on API 28+,
            // so keep the modern flag there (this side already worked).
            val installedUsesSigningInfo = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P // API 28
            val installedFlags = if (installedUsesSigningInfo)
                PackageManager.GET_SIGNING_CERTIFICATES else @Suppress("DEPRECATION") PackageManager.GET_SIGNATURES
            val installed = pm.getPackageInfo(context.packageName, installedFlags)
            var downloadedSigs = signingCertHashes(downloaded, archiveUsesSigningInfo)
            // #139 follow-up: on API 28/29 the archive read goes through the legacy GET_SIGNATURES
            // path, and if PackageManager hands back nothing we previously refused a perfectly good
            // APK with no way to tell that apart from a real mismatch. Read the v1 signature
            // ourselves before giving up — JarFile is random-access, which is how the JAR signature
            // is meant to be read, and it verifies the same bytes PackageManager would have.
            // This does NOT weaken the check: the cert extracted here is still compared against the
            // installed app's below, and an unsigned or differently-signed APK still fails.
            if (downloadedSigs.isEmpty()) {
                val viaJar = archiveCertsViaJar(apkFile)
                if (viaJar.isNotEmpty()) {
                    Log.w(TAG, "Archive certs unreadable via PackageManager on API ${Build.VERSION.SDK_INT}; used JarFile (${viaJar.size})")
                    downloadedSigs = viaJar
                }
            }
            val installedSigs = signingCertHashes(installed, installedUsesSigningInfo)
            if (downloadedSigs.isEmpty() || installedSigs.isEmpty()) {
                lastFailure = "could not read signing certificates (archive=${downloadedSigs.size}, installed=${installedSigs.size}) on API ${Build.VERSION.SDK_INT}"
                Log.e(TAG, "Missing signing certificates (downloaded=${downloadedSigs.size}, installed=${installedSigs.size})")
                return false
            }
            // Require a non-empty overlap of signer certs (handles multi-signer / cert-rotation
            // the same way the API>=30 path does: compare the full current signer sets).
            val match = downloadedSigs.any { it in installedSigs }
            if (!match) {
                lastFailure = "APK is signed by a different key than the installed app"
                Log.e(TAG, "APK signing certificate does not match installed app")
            }
            match
        } catch (e: Exception) {
            lastFailure = "signature check threw ${e.javaClass.simpleName}: ${e.message}"
            Log.e(TAG, "Signature verification error: ${e.message}", e)
            false
        }
    }

    // Read the signer-cert SHA-256 set from a PackageInfo. `useSigningInfo` must match the flag
    // it was fetched with: GET_SIGNING_CERTIFICATES -> signingInfo.apkContentsSigners (modern;
    // multi-signer + rotation aware), GET_SIGNATURES -> legacy .signatures (the only field
    // populated for ARCHIVE reads on API 28/29). Both yield the same cert for a normally-signed
    // APK; the caller compares as sets so an overlapping signer still verifies.
    /*
     * Read the APK's v1 (JAR) signer certificates directly, as a fallback for the API 28/29 archive
     * read. Opening JarFile with verify=true and reading an entry to completion is what populates
     * JarEntry.certificates — the certificate is only known once the bytes it covers have been
     * checked, so the read is the verification, not a step before it.
     *
     * Returns an empty set on any problem, which leaves the caller refusing the install: this is a
     * fallback for "PackageManager told us nothing", never a way to skip the comparison.
     */
    private fun archiveCertsViaJar(apkFile: File): Set<String> {
        return try {
            java.util.jar.JarFile(apkFile, true).use { jar ->
                val entry = jar.getJarEntry("AndroidManifest.xml") ?: return emptySet()
                jar.getInputStream(entry).use { input ->
                    val buf = ByteArray(8192)
                    while (input.read(buf) != -1) { /* must read fully before certificates populate */ }
                }
                entry.certificates?.mapNotNull { sha256(it.encoded) }?.toSet() ?: emptySet()
            }
        } catch (e: Throwable) {
            Log.w(TAG, "JarFile cert read failed: ${e.message}")
            emptySet()
        }
    }

    private fun signingCertHashes(info: PackageInfo, useSigningInfo: Boolean): Set<String> {
        val sigs: Array<Signature>? = if (useSigningInfo) {
            info.signingInfo?.apkContentsSigners
        } else {
            @Suppress("DEPRECATION") info.signatures
        }
        return sigs?.mapNotNull { sha256(it.toByteArray()) }?.toSet() ?: emptySet()
    }

    private fun sha256(bytes: ByteArray): String? {
        return try {
            MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        } catch (e: Exception) {
            null
        }
    }

    private fun getAppVersion(): String {
        return try {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "1.0.0"
        } catch (e: Exception) {
            "1.0.0"
        }
    }

    // #155/#161: true when an MDM / foreign device owner manages this device. Single source of truth
    // now lives in STPolicy.hasForeignDeviceOwner() (same public getActiveAdmins() signal, errs safe).
    private fun isManagedByForeignDeviceOwner(): Boolean =
        com.remotedisplay.player.admin.STPolicy(context).hasForeignDeviceOwner()

    /** Device owner, or an MDM delegated install scope to us — i.e. no confirm dialog. */
    private fun canInstallSilently(): Boolean =
        try { com.remotedisplay.player.admin.STPolicy(context).canInstallSilently() } catch (_: Throwable) { false }
}
