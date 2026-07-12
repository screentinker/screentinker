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

    // #139: report OTA status to the dashboard (device:log, tag "ota"). Wired by MainActivity
    // to WebSocketService.sendLog; null until then. Read lazily so binding order doesn't matter.
    // The throttle thresholds + decision rules live in OtaThrottle (pure, unit-tested); this
    // class is the imperative shell that persists state and does the download/install.
    var otaLogReporter: ((level: String, message: String) -> Unit)? = null

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

    fun checkForUpdate() {
        if (config.serverUrl.isEmpty()) return
        // #155/#161: if a foreign device owner (an MDM/DPC) manages this panel, IT owns updates.
        // Stand down — never self-install: on a managed device the self-install confirm dialog
        // can't be reliably auto-dismissed and ends up over customer content. The MDM pushes the
        // APK instead. Pure client-side safety net, independent of the server-side OTA switch.
        if (isManagedByForeignDeviceOwner()) {
            Log.i(TAG, "Managed by a foreign device owner (MDM) — self-OTA stands down; MDM owns updates")
            return
        }

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

                Log.i(TAG, "Current: $currentVersion, Latest: $latestVersion, Update: $updateAvailable")

                if (!updateAvailable) {
                    // #139: on the latest version now. If OTA state was pending, the install
                    // landed (the app relaunched as the new version) — clear state + caches once.
                    if (OtaThrottle.shouldClearOnUpToDate(otaState())) {
                        report("info", "OTA complete: now on $currentVersion — clearing update state")
                        config.clearOtaState()
                        cleanupApks(null)
                        announceOtaStatus() // transition -> emits 'none' so the badge clears promptly
                    }
                } else if (downloadUrl.isNotEmpty()) {
                    maybeUpdate(latestVersion, "${config.serverUrl}$downloadUrl")
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
    private fun maybeUpdate(latestVersion: String, downloadUrl: String) {
        val now = System.currentTimeMillis()
        val cur = otaState()
        if (OtaThrottle.isNewTarget(cur, latestVersion)) cleanupApks(latestVersion)

        val (afterCheck, action) = OtaThrottle.onUpdateAvailable(cur, latestVersion, now)
        persistOta(afterCheck)
        // Capped + still inside the window: do nothing AND stay silent. Fire OS restarts re-fire
        // this check constantly; reporting here would just move the flood onto the WS channel.
        // The enter-backoff line was already sent once on the crossing (below).
        if (action == OtaThrottle.Action.BACKOFF) return

        // download/verify failure → retry on the normal cadence; do NOT count it as an attempt.
        if (!downloadAndInstall(downloadUrl, latestVersion)) {
            Log.w(TAG, "Update $latestVersion: download/verify failed — retry next check (no attempt consumed)")
            return
        }

        val (afterLaunch, enteredBackoff) = OtaThrottle.onInstallLaunched(afterCheck, now)
        persistOta(afterLaunch)
        Log.i(TAG, "Install launched for $latestVersion (attempt ${afterLaunch.attempts}/${OtaThrottle.MAX_INSTALL_ATTEMPTS})")
        if (enteredBackoff) {
            report("warn", "Update $latestVersion available but not installing after ${afterLaunch.attempts} attempts — manual update required (backing off to one retry per ${OtaThrottle.BACKOFF_MS / 3_600_000L}h)")
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
    private fun downloadAndInstall(url: String, version: String): Boolean {
        try {
            val apkFile = File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS),
                "ScreenTinker-$version.apk")

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
                val apkFile = File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), fileName)
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
                Log.e(TAG, "Could not parse downloaded APK")
                return false
            }
            if (downloaded.packageName != context.packageName) {
                Log.e(TAG, "APK package mismatch: ${downloaded.packageName} != ${context.packageName}")
                return false
            }
            // INSTALLED-app read: signingInfo IS populated for installed packages on API 28+,
            // so keep the modern flag there (this side already worked).
            val installedUsesSigningInfo = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P // API 28
            val installedFlags = if (installedUsesSigningInfo)
                PackageManager.GET_SIGNING_CERTIFICATES else @Suppress("DEPRECATION") PackageManager.GET_SIGNATURES
            val installed = pm.getPackageInfo(context.packageName, installedFlags)
            val downloadedSigs = signingCertHashes(downloaded, archiveUsesSigningInfo)
            val installedSigs = signingCertHashes(installed, installedUsesSigningInfo)
            if (downloadedSigs.isEmpty() || installedSigs.isEmpty()) {
                Log.e(TAG, "Missing signing certificates (downloaded=${downloadedSigs.size}, installed=${installedSigs.size})")
                return false
            }
            // Require a non-empty overlap of signer certs (handles multi-signer / cert-rotation
            // the same way the API>=30 path does: compare the full current signer sets).
            val match = downloadedSigs.any { it in installedSigs }
            if (!match) Log.e(TAG, "APK signing certificate does not match installed app")
            match
        } catch (e: Exception) {
            Log.e(TAG, "Signature verification error: ${e.message}", e)
            false
        }
    }

    // Read the signer-cert SHA-256 set from a PackageInfo. `useSigningInfo` must match the flag
    // it was fetched with: GET_SIGNING_CERTIFICATES -> signingInfo.apkContentsSigners (modern;
    // multi-signer + rotation aware), GET_SIGNATURES -> legacy .signatures (the only field
    // populated for ARCHIVE reads on API 28/29). Both yield the same cert for a normally-signed
    // APK; the caller compares as sets so an overlapping signer still verifies.
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
}
