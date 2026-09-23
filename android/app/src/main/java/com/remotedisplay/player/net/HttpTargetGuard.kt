package com.remotedisplay.player.net

import java.net.InetAddress
import java.net.URI

/**
 * Which URLs this panel may be asked to fetch. Kotlin port of server/lib/http-target-guard.js.
 *
 * CONTRACT: shared/http-target-vectors.json — the same file the server is held to, so the door
 * cannot be stricter than the doorman. HttpTargetGuardTest reads it directly.
 *
 * ⚠️ THIS IS ALMOST THE INVERSE OF A SERVER-SIDE SSRF GUARD. The server's data-source fetcher
 * REFUSES private addresses, because making the SERVER reach a LAN host reaches somewhere the
 * caller could not. Here the private address IS the feature: this panel exists on the shop network
 * next to the PLC and the sensor, and that is the whole reason the request runs here rather than
 * there. Refusing RFC1918 would delete the feature.
 *
 * ⚠️ WHAT IT DOES STOP is a change of KIND. The request is operator-initiated by someone holding a
 * 'full' token who, on a device-owner panel, can already run `shell` — so reaching a LAN host is
 * not an escalation for them. Turning "fetch a URL and return 64KiB of the answer" into "read a
 * file off this device and return 64KiB of it" IS. On Android that means `file://` and, worse,
 * `content://`, which reads through content providers — the mechanism by which one app's private
 * data is exposed to another. The scheme allowlist is the whole defence.
 */
object HttpTargetGuard {

    sealed class Verdict {
        object Allow : Verdict()
        data class Deny(val reason: String) : Verdict()
    }

    private val ALLOWED_SCHEMES = setOf("http", "https")

    private val METADATA_HOSTS = setOf("metadata.google.internal", "metadata", "instance-data")
    private val METADATA_IPS = setOf("100.100.100.200")

    private val IPV4 = Regex("""^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$""")

    /**
     * A metadata / link-local address we refuse.
     *
     * ⚠️ Shared with the RESOLVED-address re-check in [DeviceHttp] rather than duplicated there. A
     * hostname that resolves to 169.254.169.254 is the obvious way around a string check, and two
     * lists would be two things to remember to update.
     */
    fun isBlockedAddress(host: String?): Boolean {
        if (host.isNullOrBlank()) return false
        val h = host.lowercase().trim('[', ']')     // strip IPv6 brackets

        if (h in METADATA_HOSTS) return true
        if (h in METADATA_IPS) return true

        val m = IPV4.matchEntire(h)
        if (m != null) {
            val p = m.groupValues.drop(1).map { it.toIntOrNull() ?: return false }
            if (p.any { it > 255 }) return false
            // 169.254.0.0/16 — link-local. Holds 169.254.169.254 (AWS/GCP/Azure/OpenStack) and on a
            // working network only ever appears when DHCP has FAILED, so nothing there is a real target.
            return p[0] == 169 && p[1] == 254
        }

        // IPv6: fe80::/10 link-local, and AWS's IPv6 metadata address.
        if (Regex("""^fe[89ab][0-9a-f]:""").containsMatchIn(h)) return true
        if (h == "fd00:ec2::254") return true

        return false
    }

    /** May this panel fetch [url]? Never throws. */
    fun check(url: String?): Verdict {
        if (url.isNullOrBlank()) return Verdict.Deny("malformed")

        val uri = try {
            URI(url.trim())
        } catch (e: Throwable) {
            return Verdict.Deny("malformed")
        }

        val scheme = uri.scheme?.lowercase()
            // A bare path or a scheme-relative "//host/x" has no scheme. Refused rather than
            // guessed at — guessing a scheme is how a file read gets in through the side door.
            ?: return Verdict.Deny("malformed")

        if (scheme !in ALLOWED_SCHEMES) return Verdict.Deny("bad_scheme")

        val host = uri.host
            // URI() accepts some shapes whose host is null (e.g. "http:///x" on some runtimes).
            // Defensive: the server documents this branch as not pinned by a vector because URL
            // parsers genuinely differ here.
            ?: return Verdict.Deny("no_host")

        if (isBlockedAddress(host)) return Verdict.Deny("metadata_address")

        return Verdict.Allow
    }

    /**
     * Re-check every address [host] actually RESOLVES to.
     *
     * ⚠️ This is the half [check] cannot do. `http://my-innocent-name.test/` passes a string check
     * and can still point at the metadata service. Called immediately before connecting.
     *
     * ⚠️ It is NOT airtight and does not claim to be: between this lookup and the socket connect,
     * a hostile DNS server can answer differently (classic TOCTOU rebinding). Closing that properly
     * means pinning the resolved address into the connection, which OkHttp supports via a custom
     * Dns — [DeviceHttp] does exactly that, so this function is the check and the pin is what makes
     * it stick.
     *
     * @return the resolved addresses when all are permitted, or null when any is refused.
     */
    fun resolveAndVet(host: String): List<InetAddress>? {
        val addrs = try {
            InetAddress.getAllByName(host).toList()
        } catch (e: Throwable) {
            return null      // unresolvable is refused, not "allowed by default"
        }
        if (addrs.isEmpty()) return null
        for (a in addrs) {
            if (isBlockedAddress(a.hostAddress)) return null
        }
        return addrs
    }

    /** A sentence an operator can act on. Matches the server's wording. */
    fun explain(reason: String): String = when (reason) {
        "bad_scheme" -> "only http:// and https:// can be fetched by a screen"
        "metadata_address" -> "that address is a cloud metadata endpoint and is refused"
        "no_host" -> "the URL has no host"
        else -> "that is not a valid URL"
    }
}
