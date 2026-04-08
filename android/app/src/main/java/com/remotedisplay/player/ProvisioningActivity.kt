package com.remotedisplay.player

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
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

        // Pre-fill if previously entered
        if (config.serverUrl.isNotEmpty()) {
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

        wsService?.connect(url)
    }

    private fun setupServiceCallbacks() {
        wsService?.onRegistered = { deviceId ->
            runOnUiThread {
                progressBar.visibility = View.GONE
                pairingSection.visibility = View.VISIBLE
                pairingCodeText.text = wsService?.getPairingCode() ?: "------"
                statusText.text = "Enter this code in the dashboard to pair this display"
                connectBtn.isEnabled = false
            }
        }

        wsService?.onPaired = { deviceId, name ->
            runOnUiThread {
                statusText.text = "Paired as: $name"
                // Transition to main activity
                val intent = Intent(this, MainActivity::class.java)
                intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NEW_TASK)
                startActivity(intent)
                finish()
            }
        }
    }

    override fun onDestroy() {
        if (bound) {
            unbindService(connection)
            bound = false
        }
        super.onDestroy()
    }
}
