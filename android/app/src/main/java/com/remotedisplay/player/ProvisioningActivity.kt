package com.remotedisplay.player

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.remotedisplay.player.data.ServerConfig
import com.remotedisplay.player.service.WebSocketService

class ProvisioningActivity : AppCompatActivity() {

    private lateinit var config: ServerConfig
    private var wsService: WebSocketService? = null
    private var bound = false

    private lateinit var serverUrlInput: EditText
    private lateinit var connectBtn: Button
    private lateinit var pairingCodeText: TextView
    private lateinit var statusText: TextView
    private lateinit var progressBar: ProgressBar
    private lateinit var pairingSection: View
    private lateinit var serverSection: View

    private val handler = Handler(Looper.getMainLooper())
    // Fix 1: revert to URL entry if a connect attempt hangs (almost always a wrong/unreachable URL).
    private var stuckRunnable: Runnable? = null
    private var registered = false
    // Fix 2: server-initiated re-pair (device removed / auth-error) — URL is known-good, so we show
    // a "waiting for re-pair" status + the pairing code instead of the URL entry, and never bounce
    // back to URL entry on a slow connect (that's an outage, not a bad address).
    private var repairMode = false
    // Fix 2 (settle window): ticks the "re-pairing available in Xs" countdown while the server's
    // #150 reclaim hold is in effect, so the screen is stable and honest instead of flickering.
    private var repairTicker: Runnable? = null

    companion object {
        // How long to sit on "Connecting to server…" before assuming the URL is wrong.
        private const val CONNECT_TIMEOUT_MS = 60_000L
    }

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            val binder = service as WebSocketService.LocalBinder
            wsService = binder.getService()
            bound = true
            setupServiceCallbacks()
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            wsService = null
            bound = false
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_provisioning)

        // Fullscreen immersive
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
            View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        )
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        config = ServerConfig(this)

        serverUrlInput = findViewById(R.id.serverUrlInput)
        connectBtn = findViewById(R.id.connectBtn)
        pairingCodeText = findViewById(R.id.pairingCodeText)
        statusText = findViewById(R.id.statusText)
        progressBar = findViewById(R.id.progressBar)
        pairingSection = findViewById(R.id.pairingSection)
        serverSection = findViewById(R.id.serverSection)

        // Pre-fill if previously entered, OR if an external caller passed a URL
        // (e.g. MainActivity settings → "Change server").
        val passedUrl = intent.getStringExtra("EXTRA_SERVER_URL")?.trimEnd('/')
        if (!passedUrl.isNullOrEmpty()) {
            serverUrlInput.setText(passedUrl)
        } else if (config.serverUrl.isNotEmpty()) {
            serverUrlInput.setText(config.serverUrl)
        }

        connectBtn.setOnClickListener {
            val url = serverUrlInput.text.toString().trim().trimEnd('/')
            if (url.isEmpty()) {
                statusText.text = "Please enter the server URL"
                return@setOnClickListener
            }
            config.serverUrl = url
            connectToServer(url)
        }

        // Fix 2: arrived here because the server unpaired/rejected this device. The URL is known-good,
        // so skip the URL entry — show a re-pair status and wait for the (fresh) pairing code. The
        // service (still running) re-registers on the live socket, so a code is typically already
        // available; showPairingIfReady() on bind renders it race-free.
        repairMode = intent.getBooleanExtra("EXTRA_REPAIR", false)
        if (repairMode) {
            serverSection.visibility = View.GONE
            connectBtn.visibility = View.GONE
            progressBar.visibility = View.VISIBLE
            statusText.text = "This device was unpaired by the server.\nWaiting for re-pair…"
            startRepairTicker()
        }

        // #device-owner: when the server URL was seeded by device-owner provisioning, skip the manual
        // "Connect" tap and go straight to registering + showing the pairing code. One-shot flag; only
        // when not re-pairing and a URL is actually present. Normal installs never set it -> unchanged.
        if (!repairMode && config.serverUrl.isNotEmpty() && config.consumePendingAutoConnect()) {
            connectToServer(config.serverUrl)
        }

        // Request notification permission on Android 13+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 100)
            } else {
                startWebSocketService()
            }
        } else {
            startWebSocketService()
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        // Start service regardless of permission result - it just won't show notification on 13+
        startWebSocketService()
    }

    private fun startWebSocketService() {
        try {
            val serviceIntent = Intent(this, WebSocketService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(serviceIntent)
            } else {
                startService(serviceIntent)
            }
            bindService(serviceIntent, connection, Context.BIND_AUTO_CREATE)
        } catch (e: Exception) {
            Log.e("ProvisioningActivity", "Failed to start service: ${e.message}")
            statusText.text = "Service error: ${e.message}"
        }
    }

    private fun connectToServer(url: String) {
        connectBtn.isEnabled = false
        progressBar.visibility = View.VISIBLE
        statusText.text = "Connecting to server..."

        registered = false
        armStuckTimer()
        wsService?.connect(url)
    }

    // Fix 1: if we can't register within CONNECT_TIMEOUT_MS the URL is almost certainly wrong or
    // unreachable — stop hammering it and drop back to the URL entry so the operator can fix it,
    // instead of sitting on "Connecting to server…" forever. Skipped in repairMode (known-good URL).
    private fun armStuckTimer() {
        cancelStuckTimer()
        if (repairMode) return
        stuckRunnable = Runnable {
            if (isFinishing || registered) return@Runnable
            try { wsService?.disconnect() } catch (_: Exception) {}
            progressBar.visibility = View.GONE
            serverSection.visibility = View.VISIBLE
            connectBtn.visibility = View.VISIBLE
            connectBtn.isEnabled = true
            pairingSection.visibility = View.GONE
            statusText.text = "Couldn't reach the server after 60s.\nCheck the URL and try again."
        }
        handler.postDelayed(stuckRunnable!!, CONNECT_TIMEOUT_MS)
    }

    private fun cancelStuckTimer() {
        stuckRunnable?.let { handler.removeCallbacks(it) }
        stuckRunnable = null
    }

    // Render the pairing code if the service already has one (unpaired + code present). Covers the
    // re-pair race where the service re-registered before this (freshly recreated) activity bound.
    private fun showPairingIfReady() {
        // Only show the code once the SERVER has accepted it (pairable) — not a rejected/stale local
        // code sitting in prefs during the reclaim-settle hold.
        val code = wsService?.getPairingCode() ?: ""
        if (wsService?.isPairingCodeLive() == true && code.isNotEmpty()) {
            registered = true
            cancelStuckTimer()
            stopRepairTicker()
            progressBar.visibility = View.GONE
            serverSection.visibility = View.GONE
            connectBtn.visibility = View.GONE
            pairingSection.visibility = View.VISIBLE
            pairingCodeText.text = code
            statusText.text = if (repairMode) "This device was unpaired.\nEnter this code on the dashboard to re-pair." else ""
        }
    }

    // Fix 2: while the server's reclaim-settle hold is active (nothing to show yet), tick a live
    // "re-pairing available in Xs" countdown so the screen is stable and explains the wait, instead
    // of flickering. Stops as soon as a pairing code is available (showPairingIfReady).
    private fun startRepairTicker() {
        stopRepairTicker()
        repairTicker = object : Runnable {
            override fun run() {
                if (isFinishing) return
                // A server-ACCEPTED code takes over the screen; a stale rejected one does not.
                if (wsService?.isPairingCodeLive() == true) { showPairingIfReady(); return }
                // Still waiting: keep the code section hidden and show the settle countdown.
                serverSection.visibility = View.GONE
                connectBtn.visibility = View.GONE
                pairingSection.visibility = View.GONE
                progressBar.visibility = View.VISIBLE
                val remainingMs = wsService?.repairHoldRemainingMs() ?: 0L
                statusText.text = if (remainingMs > 0)
                    "This display was recently active.\nRe-pairing available in ${(remainingMs + 999) / 1000}s…"
                else
                    "This device was unpaired.\nWaiting for re-pair…"
                handler.postDelayed(this, 1000L)
            }
        }
        handler.post(repairTicker!!)
    }

    private fun stopRepairTicker() {
        repairTicker?.let { handler.removeCallbacks(it) }
        repairTicker = null
    }

    private fun setupServiceCallbacks() {
        wsService?.onRegistered = { deviceId ->
            runOnUiThread {
                registered = true
                cancelStuckTimer()
                stopRepairTicker()
                progressBar.visibility = View.GONE
                // Hide the server/connect controls so the pairing code has the
                // whole screen and stays visible on short/landscape phones.
                serverSection.visibility = View.GONE
                connectBtn.visibility = View.GONE
                pairingSection.visibility = View.VISIBLE
                pairingCodeText.text = wsService?.getPairingCode() ?: "------"
                // The instruction is shown once, inside the pairing section; a re-pair adds a short
                // note in statusText, a fresh setup leaves it blank.
                statusText.text = if (repairMode) "This device was unpaired.\nEnter this code on the dashboard to re-pair." else ""
                connectBtn.isEnabled = false
            }
        }

        // Fix 2: a REPEAT rejection while we're already on the re-pair screen must NOT re-navigate
        // (that caused the flicker). Stay put and keep the countdown ticking (the service extended
        // the hold). Overriding MainActivity's stale onUnpaired also stops it firing a new Activity.
        wsService?.onUnpaired = {
            runOnUiThread {
                repairMode = true
                serverSection.visibility = View.GONE
                connectBtn.visibility = View.GONE
                pairingSection.visibility = View.GONE
                progressBar.visibility = View.VISIBLE
                startRepairTicker()
            }
        }

        wsService?.onPaired = { deviceId, name ->
            runOnUiThread {
                cancelStuckTimer()
                stopRepairTicker()
                statusText.text = "Paired as: $name"
                // Transition to main activity
                val intent = Intent(this, MainActivity::class.java)
                intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NEW_TASK)
                startActivity(intent)
                finish()
            }
        }

        // Re-pair path: the socket is usually already up (service kept running). Make sure it's
        // connecting, then render any pairing code the service already issued (race-free). If we're
        // still inside the reclaim-settle hold (no code yet), the ticker shows the countdown.
        if (repairMode || wsService?.isAwaitingRepair() == true) {
            repairMode = true
            if (wsService?.isConnected() != true) {
                try { wsService?.connect(config.serverUrl) } catch (_: Exception) {}
            }
            showPairingIfReady()
            if (wsService?.isPairingCodeLive() != true) startRepairTicker()
        }
    }

    override fun onDestroy() {
        cancelStuckTimer()
        stopRepairTicker()
        if (bound) {
            unbindService(connection)
            bound = false
        }
        super.onDestroy()
    }
}
