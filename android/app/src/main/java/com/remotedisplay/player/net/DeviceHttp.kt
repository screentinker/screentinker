package com.remotedisplay.player.net

import android.util.Log
import okhttp3.Dns
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.InputStream
import java.net.InetAddress
import java.util.concurrent.TimeUnit

/**
 * Perform ONE HTTP request from this panel's own network and report a bounded answer.
 *
 * This is the half of the feature that only works here. The server is frequently in another
 * country and has no route to the shop's 192.168.x.x; the panel is already standing on that
 * network, next to the PLC, the sensor, the local Home Assistant.
 */
object DeviceHttp {

    private const val TAG = "DeviceHttp"

    /**
     * ⚠️ 64 KiB, AND IT IS A READ LIMIT, NOT A CONTENT-LENGTH CHECK.
     *
     * Trusting Content-Length would be trusting the thing we are pointed at: a hostile or simply
     * broken endpoint can declare 10 bytes and send gigabytes, or declare nothing at all with
     * chunked encoding. So the body is read through a hard cap and the stream is abandoned at it.
     * A panel has a few hundred MB of heap and a job to do; a 2 GB response must cost it 64 KiB and
     * a truncation flag, not an OOM in the middle of playback.
     */
    const val MAX_BODY_BYTES = 64 * 1024

    private const val DEFAULT_TIMEOUT_MS = 15_000L
    private const val MAX_TIMEOUT_MS = 120_000L

    data class Result(
        val id: String,
        val ok: Boolean,
        val status: Int,            // 0 when the request never completed
        val snippet: String,
        val truncated: Boolean,
        val durationMs: Long,
        val error: String?          // null on a completed request, even a 500
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("id", id)
            put("ok", ok)
            put("status", status)
            put("snippet", snippet)
            put("truncated", truncated)
            put("duration_ms", durationMs)
            if (error != null) put("error", error)
        }
    }

    private fun deny(id: String, reason: String, startedAt: Long) = Result(
        id = id, ok = false, status = 0, snippet = "", truncated = false,
        durationMs = System.currentTimeMillis() - startedAt,
        error = HttpTargetGuard.explain(reason)
    )

    /**
     * Run the request. BLOCKING — call it off the main thread.
     *
     * @param payload { url, method?, headers?, body?, timeout_ms?, id? }
     */
    fun perform(payload: JSONObject?): Result {
        val startedAt = System.currentTimeMillis()
        val id = payload?.optString("id", "")?.ifBlank { null } ?: java.util.UUID.randomUUID().toString()
        val url = payload?.optString("url", "") ?: ""

        // The static half of the guard: scheme allowlist + literal metadata addresses.
        when (val v = HttpTargetGuard.check(url)) {
            is HttpTargetGuard.Verdict.Deny -> {
                Log.w(TAG, "refused $url: ${v.reason}")
                return deny(id, v.reason, startedAt)
            }
            else -> { /* allowed so far */ }
        }

        val httpUrl = url.trim().toHttpUrlOrNull() ?: return deny(id, "malformed", startedAt)

        /*
         * ⚠️ RESOLVE, VET, THEN PIN. A hostname passes the string check and can still point at the
         * metadata service, so every resolved address is re-checked with the SAME predicate. Then
         * the vetted list is pinned into the connection through a custom Dns, so the address we
         * approved is the address we connect to — without that, a hostile resolver can answer
         * differently between the check and the socket (classic DNS rebinding) and the vetting
         * would be decorative.
         */
        val vetted: List<InetAddress> = HttpTargetGuard.resolveAndVet(httpUrl.host)
            ?: return Result(
                id = id, ok = false, status = 0, snippet = "", truncated = false,
                durationMs = System.currentTimeMillis() - startedAt,
                error = "host did not resolve, or resolves to a refused address"
            )

        val timeout = (payload?.optLong("timeout_ms", DEFAULT_TIMEOUT_MS) ?: DEFAULT_TIMEOUT_MS)
            .coerceIn(1L, MAX_TIMEOUT_MS)

        val client = OkHttpClient.Builder()
            .connectTimeout(timeout, TimeUnit.MILLISECONDS)
            .readTimeout(timeout, TimeUnit.MILLISECONDS)
            .writeTimeout(timeout, TimeUnit.MILLISECONDS)
            .callTimeout(timeout, TimeUnit.MILLISECONDS)
            /*
             * ⚠️ Redirects OFF. A 302 is a second target the guard never saw — the cheapest way
             * round a scheme allowlist is to be redirected somewhere else. The operator gets the
             * 302 and its Location header in the snippet and can decide for themselves.
             */
            .followRedirects(false)
            .followSslRedirects(false)
            .dns(object : Dns {
                override fun lookup(hostname: String): List<InetAddress> =
                    if (hostname.equals(httpUrl.host, ignoreCase = true)) vetted
                    else Dns.SYSTEM.lookup(hostname)
            })
            .build()

        val method = (payload?.optString("method", "GET") ?: "GET").uppercase().ifBlank { "GET" }
        val bodyText = payload?.optString("body", "") ?: ""
        val contentType = payload?.optJSONObject("headers")?.let { h ->
            h.keys().asSequence().firstOrNull { it.equals("content-type", true) }?.let { h.optString(it) }
        } ?: "application/json"

        val requestBody = when {
            method in setOf("GET", "HEAD", "DELETE") && bodyText.isEmpty() -> null
            else -> bodyText.toRequestBody(contentType.toMediaTypeOrNull())
        }

        val builder = Request.Builder().url(httpUrl).method(method, requestBody)
        payload?.optJSONObject("headers")?.let { h ->
            for (k in h.keys()) {
                val value = h.optString(k, "")
                // A header value with a newline in it can inject a second header. OkHttp throws on
                // those; refusing here keeps the error legible instead of a stack trace.
                if (k.isNotBlank() && value.isNotEmpty() && !value.contains('\n') && !value.contains('\r')) {
                    try { builder.header(k, value) } catch (e: Throwable) { Log.w(TAG, "header $k: ${e.message}") }
                }
            }
        }

        return try {
            client.newCall(builder.build()).execute().use { resp ->
                val (text, truncated) = readCapped(resp.body?.byteStream())
                Result(
                    id = id,
                    // `ok` is the HTTP verdict, not "did the call happen". A 500 is a completed
                    // request that failed, and an operator needs to tell that from a timeout.
                    ok = resp.isSuccessful,
                    status = resp.code,
                    snippet = text,
                    truncated = truncated,
                    durationMs = System.currentTimeMillis() - startedAt,
                    error = null
                )
            }
        } catch (e: Throwable) {
            Log.w(TAG, "request failed: ${e.message}")
            Result(
                id = id, ok = false, status = 0, snippet = "", truncated = false,
                durationMs = System.currentTimeMillis() - startedAt,
                // The message, not the class name: "connect timed out" tells an installer to check
                // the cable; "java.net.SocketTimeoutException" tells them nothing.
                error = e.message ?: e.javaClass.simpleName
            )
        }
    }

    /**
     * Read at most [MAX_BODY_BYTES], reporting whether there was more.
     *
     * Visible for testing: the cap is the property worth pinning, and it cannot be exercised
     * through [perform] without a network.
     */
    fun readCapped(stream: InputStream?, cap: Int = MAX_BODY_BYTES): Pair<String, Boolean> {
        if (stream == null) return "" to false
        val buf = ByteArray(cap)
        var read = 0
        try {
            while (read < cap) {
                val n = stream.read(buf, read, cap - read)
                if (n <= 0) break
                read += n
            }
            // One more byte decides "exactly at the cap" from "there was more", so the flag is
            // honest rather than a guess from read == cap.
            val more = read >= cap && stream.read() != -1
            return String(buf, 0, read, Charsets.UTF_8) to more
        } catch (e: Throwable) {
            return String(buf, 0, read, Charsets.UTF_8) to false
        }
    }
}
