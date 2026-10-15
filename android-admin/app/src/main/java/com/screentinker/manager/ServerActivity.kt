package com.screentinker.manager

import android.app.AlertDialog
import android.content.Intent
import android.graphics.Typeface
import android.os.Bundle
import android.view.Gravity
import android.widget.LinearLayout
import androidx.core.content.ContextCompat
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * "Your servers": every ScreenTinker this phone manages, which one is in use, and adding another
 * (screentinker.com or the user's own). On first run the list is empty and only the add form shows.
 * A new server is checked before it is saved: it must answer /api/status like a ScreenTinker and run
 * 3.0 or newer (the Simple view this app shows arrived in 3.0).
 */
class ServerActivity : ComponentActivity() {

    private lateinit var status: TextView
    private lateinit var connect: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_server)
        val root = findViewById<View>(R.id.root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }

        val choice = findViewById<RadioGroup>(R.id.choice)
        val url = findViewById<EditText>(R.id.url)
        status = findViewById(R.id.status)
        connect = findViewById(R.id.connect)

        renderSaved()
        // With screentinker.com already saved, adding another server is almost certainly one's own.
        if (ServerStore.HOSTED in ServerStore.list(this)) {
            findViewById<RadioButton>(R.id.choiceOwn).isChecked = true
            url.visibility = View.VISIBLE
        }
        choice.setOnCheckedChangeListener { _, id ->
            url.visibility = if (id == R.id.choiceOwn) View.VISIBLE else View.GONE
            if (id == R.id.choiceOwn) url.requestFocus()
            status.text = ""
        }

        // Present on a meeting-room screen: no account, no saved server needed.
        findViewById<Button>(R.id.shareScreen).setOnClickListener {
            startActivity(Intent(this, com.screentinker.manager.share.GuestShareActivity::class.java))
        }

        connect.setOnClickListener {
            val origin = if (choice.checkedRadioButtonId == R.id.choiceOwn) ServerStore.normalize(url.text.toString()) else ServerStore.HOSTED
            if (origin == null) { status.text = getString(R.string.server_bad_url); return@setOnClickListener }
            if (origin in ServerStore.list(this)) {
                if (origin == ServerStore.get(this)) { status.text = getString(R.string.server_already_added, ServerStore.label(origin)); return@setOnClickListener }
                switchTo(origin); return@setOnClickListener
            }
            check(origin)
        }
    }

    private fun check(origin: String) {
        connect.isEnabled = false
        status.text = getString(R.string.server_checking, origin)
        thread {
            val error: String? = try {
                val conn = URL("$origin/api/status").openConnection() as HttpURLConnection
                conn.connectTimeout = 8000
                conn.readTimeout = 8000
                conn.setRequestProperty("Accept", "application/json")
                val body = conn.inputStream.bufferedReader().use { it.readText() }
                val json = JSONObject(body)
                val version = json.optString("version", "")
                val major = version.substringBefore('.').toIntOrNull()
                when {
                    json.optString("status") != "ok" || major == null -> getString(R.string.server_not_screentinker, origin)
                    major < 3 -> getString(R.string.server_too_old, origin, version)
                    else -> null
                }
            } catch (e: org.json.JSONException) {
                getString(R.string.server_not_screentinker, origin)
            } catch (e: Exception) {
                getString(R.string.server_unreachable, origin)
            }
            runOnUiThread {
                connect.isEnabled = true
                if (error != null) { status.text = error; return@runOnUiThread }
                switchTo(origin)
            }
        }
    }

    /** Use this server (saving it if new) and open it, at [route] when one is given. */
    private fun switchTo(origin: String, route: String? = null) {
        ServerStore.set(this, origin)
        // Carry a pending "share" from the Gallery through first-run setup.
        val forward = androidx.core.content.IntentCompat.getParcelableExtra(intent, EXTRA_FORWARD, Intent::class.java)
        val next = (forward ?: Intent()).setClass(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(MainActivity.EXTRA_RELOAD, true)
        if (route != null) next.putExtra(MainActivity.EXTRA_ROUTE, route)
        startActivity(next)
        finish()
    }

    /** The saved servers: tap to switch, Remove to forget. Hidden on first run. */
    private fun renderSaved() {
        val list = findViewById<LinearLayout>(R.id.savedList)
        val title = findViewById<TextView>(R.id.savedTitle)
        val addTitle = findViewById<TextView>(R.id.addTitle)
        list.removeAllViews()
        val saved = ServerStore.list(this)
        val current = ServerStore.get(this)
        title.visibility = if (saved.isEmpty()) View.GONE else View.VISIBLE
        addTitle.setText(if (saved.isEmpty()) R.string.server_question else R.string.servers_add)
        val dp = resources.displayMetrics.density
        for (origin in saved) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                background = ContextCompat.getDrawable(context, R.drawable.input_bg)
                setPadding((14 * dp).toInt(), (10 * dp).toInt(), (6 * dp).toInt(), (10 * dp).toInt())
                isClickable = true
                isFocusable = true
                if (origin != current) setOnClickListener { switchTo(origin) }
            }
            val texts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            texts.addView(TextView(this).apply {
                text = ServerStore.label(origin)
                setTextColor(ContextCompat.getColor(context, R.color.text))
                textSize = 16f
                setTypeface(typeface, Typeface.BOLD)
            })
            texts.addView(TextView(this).apply {
                text = if (origin == current) "✓ " + getString(R.string.servers_in_use) else origin
                setTextColor(ContextCompat.getColor(context, if (origin == current) R.color.accent else R.color.text_secondary))
                textSize = 13f
            })
            // Google Play: deleting the account has to be startable from inside the app. The steps
            // themselves are the server's (#/delete-account, in this app's web view), so the
            // password / two-factor / single sign-on checks are exactly the dashboard's.
            texts.addView(TextView(this).apply {
                text = getString(R.string.servers_delete_account)
                setTextColor(ContextCompat.getColor(context, R.color.text_secondary))
                textSize = 13f
                paintFlags = paintFlags or android.graphics.Paint.UNDERLINE_TEXT_FLAG
                setPadding(0, (6 * dp).toInt(), 0, 0)
                isClickable = true
                isFocusable = true
                setOnClickListener { confirmDeleteAccount(origin) }
            })
            row.addView(texts, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            row.addView(Button(this).apply {
                text = getString(R.string.servers_remove)
                isAllCaps = false
                setTextColor(ContextCompat.getColor(context, R.color.text_secondary))
                setBackgroundColor(0)
                setOnClickListener { confirmRemove(origin) }
            })
            list.addView(row, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = (8 * dp).toInt()
            })
        }
    }

    private fun confirmRemove(origin: String) {
        AlertDialog.Builder(this)
            .setMessage(getString(R.string.servers_remove_confirm, ServerStore.label(origin)))
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.servers_remove) { _, _ ->
                val wasCurrent = origin == ServerStore.get(this)
                ServerStore.remove(this, origin)
                if (wasCurrent && ServerStore.get(this) != null) switchTo(ServerStore.get(this)!!)
                else renderSaved()
            }
            .show()
    }

    /** Open the server's own "Delete my account" steps; nothing is deleted until they are finished. */
    private fun confirmDeleteAccount(origin: String) {
        AlertDialog.Builder(this)
            .setTitle(R.string.servers_delete_account)
            .setMessage(getString(R.string.servers_delete_account_confirm, ServerStore.label(origin)))
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.servers_delete_account_continue) { _, _ ->
                switchTo(origin, MainActivity.ROUTE_DELETE_ACCOUNT)
            }
            .show()
    }

    companion object {
        const val EXTRA_FORWARD = "forward"
    }
}
