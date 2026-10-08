package com.remotedisplay.player.data

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Deletes everything this screen downloaded once an operator has deleted it on the server.
 *
 * The server sends `device:unpaired {reason: "deleted"}` from the device DELETE route. That row is
 * gone, so nothing in the media cache belongs to a screen any more: it is another workspace's
 * content sitting on a panel that may be re-paired somewhere else, and keeping it only uses up the
 * disk the next owner's downloads will need.
 *
 * ⚠️ ONLY THE EXPLICIT DELETE, NEVER `reason: "not_found"`. The server sends not_found for any
 * device id it does not recognise, which is also what a database restored from an older backup or
 * a mesh edge that has not replicated yet says. Wiping on that would empty a fleet's caches at once
 * and re-download all of it over the links least able to afford it. A screen deleted while it was
 * offline only ever gets not_found, so it keeps its files; once re-paired, CacheJanitor reclaims
 * whatever the new playlist does not use.
 *
 * device:auth-error and the on-screen "Re-pair this screen" are not deletions either: the screen
 * comes back as itself, with the same content.
 *
 * ⚠️ TRIGGER MEDIA IS KEPT. Trigger items live in the payload's own `triggers` array, not in a
 * playlist, and a trigger has to fire from local disk the instant it arrives (often with the WAN
 * down). Their files survive the wipe; CacheJanitor reclaims them later if a re-paired screen's
 * payload no longer references them.
 */
object DeletedDeviceWipe {
    const val REASON_DELETED = "deleted"

    /** True only for the payload the delete route sends. */
    fun isDeletion(payload: Any?): Boolean =
        (payload as? JSONObject)?.optString("reason", "") == REASON_DELETED

    /** Every directory that holds downloaded content (ContentCache and BundleCache). */
    fun dirsUnder(filesDir: File): List<File> =
        listOf(File(filesDir, "content_cache"), File(filesDir, "bundle_render"))

    /** Every content id a payload's `triggers` array references. */
    fun triggerContentIds(triggers: JSONArray?): Set<String> = try {
        if (triggers == null) emptySet() else CacheJanitor.referencedIds(JSONObject().put("triggers", triggers))
    } catch (_: Exception) { emptySet() }

    /** The same, from the stored offline payload (ServerConfig.cachedPlaylist). */
    fun triggerContentIds(cachedPayload: String): Set<String> = try {
        if (cachedPayload.isBlank()) emptySet() else triggerContentIds(JSONObject(cachedPayload).optJSONArray("triggers"))
    } catch (_: Exception) { emptySet() }

    /**
     * Delete every file in [dirs] except those belonging to a content id in [keep] (trigger media),
     * including partials and the janitor's state file, but keep the directories themselves: the
     * caches create them only at construction. Returns files deleted.
     */
    fun wipe(dirs: List<File>, keep: Set<String> = emptySet()): Int {
        var n = 0
        for (d in dirs) {
            try {
                d.listFiles()?.forEach { f ->
                    if (CacheJanitor.idOf(f.name).let { it.isNotEmpty() && it in keep }) return@forEach
                    if (if (f.isDirectory) f.deleteRecursively() else f.delete()) n++
                }
            } catch (e: Exception) { /* best effort: a file we could not delete is only disk */ }
        }
        if (n > 0) Log.i("DeletedDeviceWipe", "device deleted on server: removed $n downloaded file(s)")
        return n
    }
}
