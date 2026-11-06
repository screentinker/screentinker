'use strict';
// Generates a separately inspectable candidate; publishing requires device validation.
const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');
const preset = require('@babel/preset-env');
const acorn = require('acorn');
const esbuild = require('esbuild');
const app = path.join(__dirname, 'app');
// The renderer is deliberately read from the server tree.  Keeping a copied HTML
// snapshot here made native builds silently miss player fixes until someone noticed
// in production.  Native-only behaviour is applied below through validated hooks.
const rendererSource = path.join(__dirname, '..', 'server', 'player', 'legacy.html');
/* Tests use a private output directory so parallel test workers cannot delete
 * one another's browser fixture. Production builds leave this unset. */
const output = process.env.ST_ORSAY_OUTPUT ? path.resolve(process.env.ST_ORSAY_OUTPUT) : path.join(__dirname, 'dist');
const release = JSON.parse(fs.readFileSync(path.join(__dirname, 'release.json'), 'utf8'));
if (!Number.isSafeInteger(release.version) || release.version < 1) throw Error('release.json must contain a positive integer version');
const build = String(release.version);
/*
 * The embedded renderer is also the generic web player, but that does not make
 * every browser feature an SSSP3 feature. Keep this contract to paths exercised
 * by the native wrapper or proven on the DB48E. In particular, the Orsay native
 * video object bypasses HTML media audio controls, and HLS/WebRTC/remote input,
 * streaming, and server migration have not been qualified.
 */
const sssp3Capabilities = [
  'playback.video',
  'playback.image',
  'playback.widget',
  'playback.zones',
  'playback.pip',
  'playback.sssp3_fit_renditions',
  'remote.screenshot',
  'system.restart_player',
  'sync.clock',
  'clock.tz_table',
  'offline.schedule_plan',
];
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
let html = fs.readFileSync(rendererSource, 'utf8');
function replaceDocumentOnce(needle, replacement, label) {
  const count = html.split(needle).length - 1;
  if (count !== 1) throw Error('Renderer document hook missing or ambiguous: ' + label);
  html = html.replace(needle, replacement);
}
const upstreamExternalScripts = [
  '<script src="/player/debug-overlay.js" defer></script>',
  '<script src="/player/st-bridge.js"></script>',
  '<script src="/player/st-sync.js"></script>',
  '<script src="/socket.io/socket.io.js"></script>',
  '<script src="/player/schedule-eval.js"></script>',
  '<script src="/player/play-order.js"></script>',
  '<script src="/player/kiosk-logic.js"></script>',
  '<script src="/player/kiosk-player.js"></script>',
  '<script src="/player/bundle-skip.js"></script>',
  '<script src="/player/unpair-gate.js"></script>',
  '<script src="/player/offline-play-queue.js"></script>',
  '<script src="/player/live-publish-legacy.js"></script>',
  '<script src="/player/talk-legacy.js"></script>',
  '<script src="/player/screen-share.js"></script>',
  '<script src="/player/trigger-resolve.js"></script>',
  '<script src="/player/media-mute.js"></script>',
  '<script src="/player/orientation-style.js"></script>',
  '<script src="/player/wall-geometry.js"></script>',
  '<script src="/player/player-media-health.js"></script>',
  '<script src="/player/transitions.js"></script>',
];
for (const tag of upstreamExternalScripts) replaceDocumentOnce(tag, '', 'upstream external script ' + tag);
const nativeScriptTags = [
  'polyfills.js', 'legacy-dom.js', 'legacy-web.js', 'native-prelude.js',
  'socket.io.js', 'schedule-eval.js', 'offline-schedule.js', 'offline-plan.js',
  'play-order.js', 'kiosk-logic.js', 'kiosk-player.js', 'bundle-skip.js',
  'unpair-gate.js', 'offline-play-queue.js', 'live-publish-legacy.js',
  'talk-legacy.js', 'screen-share.js', 'trigger-resolve.js', 'media-mute.js',
  'orientation-style.js', 'wall-geometry.js', 'player-media-health.js',
  'transitions-stub.js', 'native-diagnostics.js',
].map(name => '<script src="' + name + '"></script>').join('');
replaceDocumentOnce('<title>ScreenTinker Player</title>', nativeScriptTags + '<title>ScreenTinker SSSP3 Native Player</title>', 'native dependency prelude');
/* legacy.html deliberately stays platform-neutral.  The native bridge, however,
 * talks to these two Orsay plugin objects by id.  Keep them in the generator
 * rather than in a copied renderer snapshot, and make their insertion fail if
 * upstream changes the document body structure. */
replaceDocumentOnce('<body>', '<body><object id="NativeDownloader" classid="clsid:SAMSUNG-INFOLINK-DOWNLOAD"></object><object id="NativePlayer" classid="clsid:SAMSUNG-INFOLINK-PLAYER" style="position:absolute;left:0;top:0;width:1px;height:1px;visibility:hidden;z-index:900"></object>', 'Samsung native plugin objects');
replaceDocumentOnce('<div id="setupScreen">', '<div id="setupScreen"><p id="st-native-diagnostic" style="color:#ffcf63;font:24px Arial;position:absolute;top:30px;left:30px">BUILD ' + build + ' - LOADING</p>', 'native startup diagnostic');
function inlineScripts(document) {
  const scripts = [];
  let cursor = 0;
  while (cursor < document.length) {
    const open = document.toLowerCase().indexOf('<script', cursor);
    if (open < 0) break;
    const openEnd = document.indexOf('>', open + 7);
    if (openEnd < 0) throw Error('Unterminated script opening tag in renderer source');
    const close = document.toLowerCase().indexOf('</script>', openEnd + 1);
    if (close < 0) throw Error('Unterminated inline script in renderer source');
    const body = document.slice(openEnd + 1, close);
    if (body.trim()) scripts.push({ start: open, end: close + 9, body, raw: document.slice(open, close + 9) });
    cursor = close + 9;
  }
  return scripts;
}
const scripts = inlineScripts(html);
if (scripts.length !== 2) throw Error('Unexpected renderer script structure');
let main = scripts[1].body;
const capabilityStart = main.indexOf('function declaredCapabilities() {');
const capabilityEnd = main.indexOf('function hostPackageVersion()', capabilityStart);
if (capabilityStart < 0 || capabilityEnd < 0) throw Error('Renderer capability function missing');
main = main.slice(0, capabilityStart)
  + 'function declaredCapabilities() { return ' + JSON.stringify(sssp3Capabilities) + '.slice(); }\n    '
  + main.slice(capabilityEnd);
function replaceOnce(needle, replacement) {
  if (main.split(needle).length !== 2) throw Error('Renderer hook missing or ambiguous: ' + needle);
  /* A replacement function preserves literal $ characters in injected ES5. */
  main = main.replace(needle, function () { return replacement; });
}
function replacePatternOnce(pattern, replacement, label) {
  const matches = main.match(pattern);
  if (!matches || matches.length !== 1) throw Error('Renderer hook missing or ambiguous: ' + label);
  main = main.replace(pattern, replacement);
}
replaceOnce('let config = getConfig();', 'let config = getConfig();\nif (!config.serverUrl || config.serverUrl === "null") config.serverUrl = window.__STNative.base;');
replaceOnce('let socket = null;', 'let socket = null;\nfunction stSetWidgetOffline(offline) { var frames = document.querySelectorAll("iframe[data-st-widget-remote]"); var i, f, target; for (i = 0; i < frames.length; i++) { f = frames[i]; target = offline ? (f.getAttribute("data-st-widget-local") || f.getAttribute("data-st-widget-remote")) : f.getAttribute("data-st-widget-remote"); if (target && f.src !== target) f.src = target; } }');
replaceOnce('let defaultContent = null;', 'let defaultContent = (function () { try { var saved = JSON.parse(localStorage.getItem("st_default_content") || "null"); return saved && typeof saved === "object" ? saved : null; } catch (ignore) { return null; } })();');
replaceOnce('    app_version: hostPackageVersion() || PLAYER_VERSION,', '    app_version: String(window.__ST_NATIVE_BUILD || hostPackageVersion() || PLAYER_VERSION),');
replaceOnce('  data.client_version = PLAYER_VERSION;', '  data.client_version = String(window.__ST_NATIVE_BUILD || PLAYER_VERSION);');
replacePatternOnce(/data\.platform = ON_BRIGHTSIGN \?[^;]+browserPlatform\(\)[^;]*;/g, "data.platform = 'Samsung SSSP3/Orsay';", 'device platform');
replaceOnce('let playerTimezone = null;', 'let playerTimezone = localStorage.getItem("st_schedule_timezone") || null;\ntry { ScheduleEval.setTimezoneTable(JSON.parse(localStorage.getItem("st_schedule_timezone_table") || "null")); } catch (ignore) {}');
replaceOnce('  playerTimezone = data.timezone || null;', '  playerTimezone = data.timezone || null;\n  try { localStorage.setItem("st_schedule_timezone", playerTimezone || ""); localStorage.setItem("st_schedule_timezone_table", JSON.stringify(data.tz_table || null)); localStorage.setItem("st_active_schedule", JSON.stringify(data.offline_schedule || null)); ScheduleEval.setTimezoneTable(data.tz_table || null); if (window.__STNative.ready) window.__STNative.persistStorage(); } catch (ignore) {}');
replaceOnce('    startAutoContinue(5);', '    setTimeout(function () { connectBtnFunc(); }, 0);');
replaceOnce('  function enterRepairMode(message) {\n    clearShareForUnpaired();', '  function enterRepairMode(message) {\n    /* Server revocation/authentication rejection is an ownership boundary, not\n       a transient disconnect.  Clear the native journal before setup can run. */\n    try { if (window.__STNative && window.__STNative.clearOwnedState) window.__STNative.clearOwnedState(); } catch (ignoreNativeWipe) {}\n    clearShareForUnpaired();');
replaceOnce('    const cachedPlaylist = loadPlaylistCache();', '    document.getElementById("setupScreen").style.display = "none";\n    var nativeOfflineBoot = null; try { nativeOfflineBoot = window.STOfflinePlan && STOfflinePlan.select(localStorage.getItem("st_offline_plan"), syncedNow()); } catch (ignore) {}\n    var __stBootPlaylist = nativeOfflineBoot && nativeOfflineBoot.valid ? (nativeOfflineBoot.state ? nativeOfflineBoot.state.payload.assignments || [] : []) : loadPlaylistCache();\n    /* legacy v1 schedule state governs the CACHED REPLAY decision only (offline);\n     * the connected item gate never consults it — see the removed scheduleAllows gate below */\n    const cachedPlaylist = (function () { try { return (__stBootPlaylist.length && window.STOfflineSchedule && !STOfflineSchedule.active(JSON.parse(localStorage.getItem("st_active_schedule") || "null"), syncedNow())) ? [] : __stBootPlaylist; } catch (ignoreCacheGate) { return __stBootPlaylist; } })();');
replaceOnce('    const layoutKnown = localStorage.getItem(LAYOUT_CACHE_KEY) !== null;', '    const layoutKnown = !!(nativeOfflineBoot && nativeOfflineBoot.valid) || localStorage.getItem(LAYOUT_CACHE_KEY) !== null;');
replaceOnce('      layout = loadLayoutCache();', '      layout = nativeOfflineBoot && nativeOfflineBoot.state ? nativeOfflineBoot.state.payload.layout || null : loadLayoutCache();\n      window.__stCachedColdStart = true;');
replaceOnce('    {\n      const tapOverlay = document.createElement("div");', '    if (window.__STNative && window.__STNative.ready) {\n      setTimeout(function () { if (!cachedPlaylist.length || !layoutKnown) { var message = document.getElementById("statusText"); if (message) message.removeAttribute("data-i18n"); showStatus("No cached content is available. Waiting for the server."); } connect(config.serverUrl); }, 0);\n    } else {\n      const tapOverlay = document.createElement("div");');
replaceOnce('function mediaUrl(it) {\n  if (!it) return "";', 'function mediaUrl(it) {\n  if (!it) return "";\n  if (window.__STNative && window.__STNative.ready) { var local = window.__STNative.mediaUrl(it, null); if (local) return local; }');
/* The upstream widget URL acquired transparent-background and panel-fragment
 * parameters. Match the complete current construction (not just a short
 * substring) so upstream drift stops the build instead of silently dropping
 * native cache/offline wiring. */
function patchWidgetIframes(base, item, expected) {
  const basePattern = base === 'config.serverUrl' ? 'config\\.serverUrl' : 'serverUrl';
  const itemPattern = item === 'item' ? 'item' : 'a';
  const pattern = new RegExp(
    'iframe\\.src = ""\\.concat\\(' + basePattern + ', "/api/widgets/"\\)\\.concat\\(' + itemPattern + '\\.widget_id, "/render\\?device="\\)\\.concat\\(encodeURIComponent\\(config\\.deviceId \\|\\| ""\\), "&rev="\\)\\.concat\\(' + itemPattern + '\\.widget_rev \\|\\| 0\\)\\.concat\\(' + itemPattern + '\\.transparent_bg \\? "&transparent=1" : ""\\)\\.concat\\(' + itemPattern + '\\.widget_panel \\? "#panel=" \\+ encodeURIComponent\\(' + itemPattern + '\\.widget_panel\\) : ""\\);',
    'g'
  );
  const matches = main.match(pattern) || [];
  if (matches.length !== expected) throw Error('Widget iframe hooks missing or ambiguous: ' + base + '/' + item + ' (expected ' + expected + ', got ' + matches.length + ')');
  main = main.replace(pattern, function (statement) {
    return statement + '\n      if (window.__STNative && window.__STNative.ready) { var stRemoteWidgetUrl = iframe.src; var stWidgetHash = stRemoteWidgetUrl.indexOf("#"); var stCompatWidgetUrl = (stWidgetHash < 0 ? stRemoteWidgetUrl : stRemoteWidgetUrl.slice(0, stWidgetHash)) + (stRemoteWidgetUrl.indexOf("?") < 0 ? "?" : "&") + "compat=sssp1228" + (stWidgetHash < 0 ? "" : stRemoteWidgetUrl.slice(stWidgetHash)); var stLocalWidgetUrl = window.__STNative.widgetUrl(' + item + ', stCompatWidgetUrl); iframe.setAttribute("data-st-widget-remote", stCompatWidgetUrl); iframe.setAttribute("data-st-widget-local", stLocalWidgetUrl); if (stLocalWidgetUrl !== stCompatWidgetUrl) iframe.src = stLocalWidgetUrl; iframe.onload = function () { if (window.__STNative && window.__STNative.frameReady) window.__STNative.frameReady(); }; }';
  });
}
patchWidgetIframes('config.serverUrl', 'item', 1);
patchWidgetIframes('serverUrl', 'item', 1);
patchWidgetIframes('config.serverUrl', 'a', 3);
replaceOnce('function handlePlaylistUpdate(data) {\n  var _a;', 'function handlePlaylistUpdate(data) {\n  var _a;\n  if (window.__STNative && window.__STNative.ready && !data.__nativeReady) { window.__STNative.accept(data, function (next) { next.__nativeReady = true; handlePlaylistUpdate(next); }); return; }');
replaceOnce('function renderContent(item) {\n  var _a, _b;', 'function renderContent(item) {\n  var _a, _b;\n  if (window.__STNative && window.__STNative.ready && item && ((item.widget_id && !window.__STNative.canRender(item)) || (!item.widget_id && !item.remote_url && /^(?:image|video|audio)\\//.test(item.mime_type || "") && !window.__STNative.supports(item)))) { teardownCurrentMedia(); var unsupportedKind = item.widget_id ? ((item.widget_type || "unknown") + " widget") : (item.mime_type || "media"); showStatus("Unsupported on Samsung SSSP3 display: " + unsupportedKind); window.__STNative.report("unsupported-media", String(unsupportedKind), config.deviceId); isPlaying = false; if (playlist && playlist.length > 1) scheduleAdvance(nextItem, 1000); return; }');
replaceOnce('  socket.on("connect", () => {\n    console.log("Connected");', '  socket.on("connect", () => {\n    stSetWidgetOffline(false);\n    if (window.__STNative && window.__STNative.flushReports) window.__STNative.flushReports();\n    if (window.__STNative && window.__STNative.pollLauncherManifest) window.__STNative.pollLauncherManifest(function (err, info) { try { if (info && info.reachable && info.update) window.__STNative.report("launcher-update", JSON.stringify(info), config.deviceId); } catch (ignorePoll) {} });\n    console.log("Connected");');
replaceOnce('  socket.on("disconnect", (reason) => {\n    console.log("Disconnected", reason || "");', '  socket.on("disconnect", (reason) => {\n    stSetWidgetOffline(true);\n    console.log("Disconnected", reason || "");');
replaceOnce('  socket.on("connect_error", (err) => {\n    document.getElementById("setupStatus").textContent = "Connection failed: " + err.message;', '  socket.on("connect_error", (err) => {\n    stSetWidgetOffline(true);\n    document.getElementById("setupStatus").textContent = "Connection failed: " + err.message;');
replaceOnce('const fingerprint = (items) => items.map((a) => "".concat(a.content_id || "", "|").concat(a.widget_id || "", "|")', 'const fingerprint = (items) => items.map((a) => "".concat(a.content_id || "", "|").concat(a.content_rev || "", "|").concat(a.widget_id || "", "|")');
/* A replacement under the same content id is still a distinct native-cache
 * revision. Include it in per-zone identity so a changed zone actually
 * re-renders instead of retaining its old DOM/media surface forever. */
replaceOnce('return items.map((a) => [\n    a.content_id || "",\n    a.widget_id || "",', 'return items.map((a) => [\n    a.content_id || "",\n    a.content_rev || "",\n    a.widget_id || "",');
replaceOnce('  if (playlist.length > 0) savePlaylistCache(playlist);', '  savePlaylistCache(playlist);');
replaceOnce('ScheduleEval.itemShouldPlay(item, Date.now(), playerTimezone)', 'ScheduleEval.itemShouldPlay(item, syncedNow(), playerTimezone)');
/* Do not gate online playback on a cached plan: an uncovered interval is a valid
 * idle state and the server payload remains authoritative while connected.
 * Offline transitions are handled exclusively by the disconnect-gated tick. */
main += '\nfunction nativeOfflinePlanTick() { try { if (!config || !config.paired || !config.deviceId || !config.deviceToken) return; if (socket && socket.connected) { window.__stOfflinePlanInterval = null; return; } var result = window.STOfflinePlan && STOfflinePlan.select(localStorage.getItem("st_offline_plan"), syncedNow()); if (!result || !result.plan) { if (isPlaying && !STOfflineSchedule.active(JSON.parse(localStorage.getItem("st_active_schedule") || "null"), syncedNow())) showNothingScheduled(); return; } var sig = result.interval ? String(result.interval.start_utc_ms) + "|" + String(result.interval.schedule_id || "") : "none"; if (sig === window.__stOfflinePlanInterval) return; window.__stOfflinePlanInterval = sig; if (window.__STNative && window.__STNative.report) window.__STNative.report("offline-schedule", JSON.stringify({ event: "offline_schedule_selected", schedule_id: result.interval && result.interval.schedule_id || null, playlist_id: result.interval && result.interval.playlist_id || null, interval_start_utc_ms: result.interval && result.interval.start_utc_ms || null, interval_end_utc_ms: result.interval && result.interval.end_utc_ms || null, valid: !!result.valid, state_ready: !!result.state }), config.deviceId); if (!result.valid || !result.state) { playlist = []; isPlaying = false; teardownCurrentMedia(); showStatus(result.error || "No scheduled content is active."); return; } handlePlaylistUpdate(result.state.payload); } catch (ignore) {} }\nsetInterval(nativeOfflinePlanTick, 1000);\n';
main += '\nsetTimeout(function () { try { var setup = document.getElementById("setupScreen"), overlay = document.getElementById("statusOverlay"), text = document.getElementById("statusText"); var boot = { setup: setup.style.display, status: overlay.style.display, message: text && text.textContent, playing: isPlaying, items: playlist.length, cached: !!window.__stCachedColdStart, cold_start: true }; if (window.__STNative.recordBootEvent) boot = window.__STNative.recordBootEvent(boot); if (config.deviceId) window.__STNative.report("boot", JSON.stringify(boot), config.deviceId); } catch (ignore) {} }, 1000);\n';
replaceOnce('    localStorage.setItem("st_clock_offset", String(clockOffsetMs));', '    localStorage.setItem("st_clock_offset", String(clockOffsetMs));\n    if (window.__STNative && window.__STNative.ready && (window.__stSavedClockOffset == null || Math.abs(window.__stSavedClockOffset - clockOffsetMs) > 1000)) { window.__stSavedClockOffset = clockOffsetMs; window.__STNative.persistStorage(); }');
replaceOnce('  text.textContent = msg;', '  text.removeAttribute("data-i18n");\n  text.textContent = msg;');
replaceOnce('  overlay.style.display = "flex";\n  let text = document.getElementById("statusText");', '  overlay.style.display = "block";\n  overlay.style.textAlign = "center";\n  overlay.style.paddingTop = "20%";\n  let text = document.getElementById("statusText");');
replaceOnce('  const oldFp = fingerprint(playlist);', '  const oldFp = fingerprint(playlist);\n  const zoneItemsChanged = !!(data.layout && data.layout.zones && data.layout.zones.length > 1 && JSON.stringify(newItems) !== JSON.stringify(playlist));');
replaceOnce('  if (newFp === oldFp && playlist.length > 0 && !wallChanged && !layoutChanged) {', '  if (newFp === oldFp && playlist.length > 0 && !wallChanged && !layoutChanged && !zoneItemsChanged && !data.__nativeMediaChanged) {');
replaceOnce('      if (newItem && newItem.widget_id && oldItem && (oldItem.widget_rev || 0) !== (newItem.widget_rev || 0)) {', '      if (newItem && oldItem && (data.__nativeMediaChanged || zoneItemsChanged || layoutChanged || wallChanged || newItem.content_rev !== oldItem.content_rev || newItem.filepath !== oldItem.filepath || newItem.mime_type !== oldItem.mime_type)) {\n        renderContent(newItem);\n      } else if (newItem && newItem.widget_id && oldItem && (oldItem.widget_rev || 0) !== (newItem.widget_rev || 0)) {');
replaceOnce('  if (isPlaying && !scheduleDriven && !outgoingNeverAdvances && !interruptNow) {', '  if (isPlaying && !scheduleDriven && !outgoingNeverAdvances && !interruptNow && !(window.__STNative && window.__STNative.ready)) {');
replaceOnce('    config.enrolKey = null;\n    const next = UnpairGate.urlWithoutEnrolKey(location.href);', '    config.enrolKey = null;\n    /* A native panel restores state from common storage after reload, so clear\n       that journal before leaving the current tenant. */\n    try { if (window.__STNative && window.__STNative.clearOwnedState) window.__STNative.clearOwnedState(); } catch (ignoreNativeWipe) {}\n    const next = UnpairGate.urlWithoutEnrolKey(location.href);');
replaceOnce('  console.log("Playlist changed, updating");', '  const wasNativeGapless = !!(window.__STNative && window.__STNative.gaplessActive && window.__STNative.gaplessActive());\n  if (wasNativeGapless) { window.__STNative.stopVideo(); isPlaying = false; }\n  console.log("Playlist changed, updating");');
replaceOnce('  const oldAnchorId = identityOf(oldPlaylist[oldAnchorIdx]);', '  const oldAnchorId = wasNativeGapless ? null : identityOf(oldPlaylist[oldAnchorIdx]);');
replaceOnce('function isMediaReadable(el) {\n  const url = el.currentSrc || el.src || "";', 'function isMediaReadable(el) {\n  const url = el.currentSrc || el.src || "";\n  if (/^file:\\/\\/\\/mtd_down\\/common\\/screentinker_media\\//.test(url)) return true;');
const stLegacyVideoFitFn = [
  'function stLegacyVideoFit(video, fit) {',
  '  var parent = video.parentNode;',
  '  if (!parent) return;',
  '  if (parent.className === "st-legacy-video-fit") { var wrap = parent; parent = wrap.parentNode; if (!parent) return; parent.insertBefore(video, wrap); wrap.parentNode && wrap.parentNode.removeChild(wrap); }',
  '  if (video.__stFitStop) { try { video.__stFitStop(); } catch (ignoreStop) {} }',
  '  parent.style.overflow = "hidden";',
  '  var leftover = parent.querySelectorAll ? parent.querySelectorAll("canvas.st-legacy-video-canvas") : [];',
  '  var li; for (li = leftover.length - 1; li >= 0; li--) { if (leftover[li] && leftover[li].parentNode) leftover[li].parentNode.removeChild(leftover[li]); }',
  '  video.__stFitStop = function () {};',
  '  window.stLegacyVideoFit = stLegacyVideoFit;',
  '}'
].join('\n');
replaceOnce('function itemFit(item, zone) {\n  const m = item && item.fit_mode || zone && zone.fit_mode || "contain";\n  return m === "cover" || m === "fill" || m === "contain" ? m : "contain";\n}', 'function itemFit(item, zone) {\n  const m = item && item.fit_mode || zone && zone.fit_mode || "contain";\n  return m === "cover" || m === "fill" || m === "contain" ? m : "contain";\n}\n' + stLegacyVideoFitFn);
replaceOnce('  return canvas;\n}\nfunction captureAndSend() {', '  if (window.__STNative && window.__STNative.ready && cr) window.__STNative.markCapture(ctx, cr, W, H);\n  return canvas;\n}\nfunction captureAndSend() {');
replaceOnce('function captureAndSend() {\n', 'function captureAndSend() {\n  if (window.__STNative && window.__STNative.ready && window.__STNative.captureScreen) { window.__STNative.captureScreen(function (error, base64) { if (error) { console.error("[Samsung] Screenshot failed: " + error); window.__STNative.report("screenshot", String(error), config.deviceId); if (socket && socket.connected) socket.emit("device:log", { device_id: config.deviceId, tag: "samsung-screenshot", level: "error", message: String(error) }); return; } if (socket && socket.connected) socket.emit("device:screenshot", { device_id: config.deviceId, image_b64: base64 }); }); return; }\n');
replaceOnce('    console.log("Registered:", data.device_id);', '    console.log("Registered:", data.device_id);\n    if (window.__STNative && window.__STNative.flushReports) window.__STNative.flushReports();\n    if (window.__STNative && !window.__STNative.captureTestStarted) { window.__STNative.captureTestStarted = true; setTimeout(captureAndSend, 15000); }');
replaceOnce('          cold_start: false\n        });\n      } catch (e) {\n      }\n      disconnectedAt = 0;\n      linkLostDuringGap = false;\n    }', '          cold_start: false\n        });\n      } catch (e) {\n      }\n      disconnectedAt = 0;\n      linkLostDuringGap = false;\n    } else if (config.deviceId && !window.__stColdStartReported) {\n      window.__stColdStartReported = true;\n      try {\n        socket.emit("device:connectivity-report", {\n          device_id: config.deviceId,\n          offline_ms: 0,\n          link_lost: false,\n          cold_start: true,\n          cached_items: playlist.length,\n          playing: !!isPlaying\n        });\n      } catch (ignoreCold) {}\n    }');
replaceOnce('function mountImage(img, item) {', 'function mountImage(img, item) {\n  if (window.__STNative && img && img.complete && img.naturalWidth) window.__STNative.frameReady();');
replaceOnce('if (!(typeof kiosk !== "undefined" && kiosk && kiosk.isShowing()) && window.PlayerMediaHealth && typeof PlayerMediaHealth.needsReattach === "function" && pendingVideoSeq !== renderSeq && PlayerMediaHealth.needsReattach(state)) {', 'if (!(window.__STNative && window.__STNative.ready && item && /^video\\/(?!youtube|hls)/.test(item.mime_type || "")) && !(typeof kiosk !== "undefined" && kiosk && kiosk.isShowing()) && window.PlayerMediaHealth && typeof PlayerMediaHealth.needsReattach === "function" && pendingVideoSeq !== renderSeq && PlayerMediaHealth.needsReattach(state)) {');
replaceOnce('function teardownCurrentMedia(keep) {\n  renderSeq++;', 'function teardownCurrentMedia(keep) {\n  if (window.__STNative && window.__STNative.ready) window.__STNative.stopVideo();\n  renderSeq++;');
replaceOnce('function saveConfig(cfg) {\n  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));', 'function saveConfig(cfg) {\n  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));\n  if (window.__STNative && window.__STNative.ready) window.__STNative.persistStorage();');
replaceOnce('localStorage.setItem(PLAYLIST_CACHE_KEY, JSON.stringify(items));', 'localStorage.setItem(PLAYLIST_CACHE_KEY, JSON.stringify(items));\n    if (window.__STNative && window.__STNative.ready) window.__STNative.persistStorage();');
replaceOnce('localStorage.setItem(LAYOUT_CACHE_KEY, JSON.stringify(l || null));', 'localStorage.setItem(LAYOUT_CACHE_KEY, JSON.stringify(l || null));\n    if (window.__STNative && window.__STNative.ready) window.__STNative.persistStorage();');
replaceOnce('function renderVideoBuffered(item) {\n  const src = mediaUrl(item);', 'function renderVideoBuffered(item) {\n  if (window.__STNative && window.__STNative.ready) { teardownCurrentMedia(); document.getElementById("playerContainer").style.display = "block"; preloadNextImage(); var nativeRect = {left:0,top:0,width:1920,height:1080}; var sequence = playlist.slice(currentIndex).concat(playlist.slice(0,currentIndex)); var fullLayout = !layout || (layout.zones && layout.zones.length === 1 && Number(layout.zones[0].x_percent) === 0 && Number(layout.zones[0].y_percent) === 0 && Number(layout.zones[0].width_percent) === 100 && Number(layout.zones[0].height_percent) === 100); var normalNative = function () { if (!window.__STNative.playVideo(item, nativeRect, function () { nextItem(); })) scheduleAdvance(nextItem, 3000); }; if (window.__STNative.gaplessEnabled && window.__STNative.gaplessEnabled() && !wallConfig && !groupSync && fullLayout && playbackOrder === "sequential" && window.__STNative.playGapless(sequence, nativeRect, nativeGaplessAdvance, function (reason) { window.__STNative.report("gapless", "native playlist fallback: " + reason, config.deviceId); normalNative(); })) { window.__STNative.report("gapless", "native playlist start requested with " + sequence.length + " videos", config.deviceId); return; } normalNative(); return; }\n  const src = mediaUrl(item);');
main += '\nfunction nativeGaplessAdvance() { var old = playlist[currentIndex]; if (!old) return; if (!PREVIEW_MODE && !(socket && socket.connected) && offlinePlayOpen) { queueOfflinePlay(offlinePlayOpen, true); offlinePlayOpen = null; } if (socket && socket.connected && shouldLogPlay(old)) socket.emit("device:play-event", { device_id: config.deviceId, event: "play_end", content_id: old.content_id || null, content_name: old.filename || null, completed: true }); currentIndex = (currentIndex + 1) % playlist.length; var item = playlist[currentIndex]; currentItemStartedAt = Date.now(); if (!(socket && socket.connected) && shouldLogPlay(item)) offlinePlayOpen = { content_id: item.content_id || null, content_name: item.filename || null, started_at: Math.floor(Date.now()/1000) }; if (socket && socket.connected && shouldLogPlay(item)) socket.emit("device:play-event", { device_id: config.deviceId, event: "play_start", content_id: item.content_id || null, content_name: item.filename || null, duration_sec: item.duration_sec || null }); }\n';
/*
 * All multi-zone/PiP video stays in the HTML compositor. The native LFD plane is
 * a single always-on-top surface and covers sibling widgets (1249/1262 PiP).
 * Fullscreen single-zone playback above still uses the native player. Orsay
 * HTML video paints at encoded pixel size and ignores client scale, so
 * contain/cover/fill are same-asset renditions whose encoded width/height
 * already match the zone (native-bridge stampFit + {fit}-WxH URL). Images use
 * the same encoded-geometry path because object-fit is unproven on this
 * firmware. stLegacyVideoFit only clips the zone and strips the failed canvas
 * compositor. Closed failures: CSS object-fit,
 * CSS transform, CSS width/height, HTMLVideoElement width/height properties,
 * hiding-canvas drawImage, unclipped native playVideo, video-hole / chroma-key
 * overlay (no SSSP3/Orsay API). native-bridge SetDisplayArea can size the LFD
 * rectangle, but clipping to a 100% z-pip-1 background still covers z-pip-2
 * HTML because the plane is always-on-top; do not ship another unclipped native
 * PiP.
 */
replaceOnce('    div.appendChild(video);\n    try {\n      const p = video.play();', '    div.appendChild(video);\n    if (window.__STNative && window.__STNative.ready) stLegacyVideoFit(video, itemFit(a, zone));\n    try {\n      const p = video.play();');
// legacy.html now owns offlinePlayOpen and queueOfflinePlay.  Do not prepend the
// old native copy: duplicate lexical declarations make the generated renderer
// unparseable and bypass the upstream queue's acknowledgement safeguards.
const generated = babel.transformSync(main, { presets: [[preset, { targets: { ie: '11' }, modules: false }]], comments: false, sourceType: 'script' }).code;
acorn.parse(generated, { ecmaVersion: 5 });
fs.writeFileSync(path.join(output, 'renderer-main.js'), generated);
replaceDocumentOnce(scripts[1].raw, '<script src="native-bridge.js"></script><script>window.__ST_NATIVE_BUILD = "' + build + '"; try { if (window.Common && Common.API && Common.API.Widget) new Common.API.Widget().sendReadyEvent(); } catch (e) { window.__STNative.launcherError = String(e); } try { window.__STNative.init(); window.__STNative.restoreStorage(); window.__STNative.ready = true; } catch (e) { window.__STNative.error = String(e); }</script><script src="renderer-main.js"></script>', 'main renderer replacement');
fs.writeFileSync(path.join(output, 'index.html'), html);
function compileBrowserCode(code, dest) {
  code = code.split('__ST_BUILD__').join(build);
  const compiled = babel.transformSync(code, { presets: [[preset, { targets: { ie: '11' }, modules: false }]], comments: false, sourceType: 'script' }).code;
  acorn.parse(compiled, { ecmaVersion: 5 });
  fs.writeFileSync(dest, compiled);
}
function compileBrowserScript(src, dest) { compileBrowserCode(fs.readFileSync(src, 'utf8'), dest); }
function replaceCodeOnce(code, needle, replacement, label) {
  const count = code.split(needle).length - 1;
  if (count !== 1) throw Error('Schedule evaluator adapter hook missing or ambiguous: ' + label);
  return code.replace(needle, replacement);
}
function compileScheduleEvalForOrsay(src, dest) {
  /* The evaluator is canonical server source.  This small, validated adapter
   * supplies the persisted timezone table only because legacy Orsay lacks a
   * reliable Intl timezone database while offline. */
  let code = fs.readFileSync(src, 'utf8');
  code = replaceCodeOnce(code,
    "var STAMP_RE = /^\\d{4}-\\d{2}-\\d{2}T([01]\\d|2[0-3]):[0-5]\\d$/;",
    "var STAMP_RE = /^\\d{4}-\\d{2}-\\d{2}T([01]\\d|2[0-3]):[0-5]\\d$/;\n  var timezoneTable = null;", 'timezone table declaration');
  code = replaceCodeOnce(code,
    "if (!ianaTz) {\n      return { y: d.getFullYear(), mo: d.getMonth() + 1, day: d.getDate(), dow: d.getDay(), min: d.getHours() * 60 + d.getMinutes() };\n    }",
    "if (!ianaTz) {\n      return { y: d.getFullYear(), mo: d.getMonth() + 1, day: d.getDate(), dow: d.getDay(), min: d.getHours() * 60 + d.getMinutes() };\n    }\n    if (ianaTz === 'UTC' || ianaTz === 'Etc/UTC' || ianaTz === 'Etc/GMT') return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, day: d.getUTCDate(), dow: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes() };\n    if (timezoneTable && timezoneTable.zone === ianaTz && timezoneTable.spans && timezoneTable.spans.length) {\n      var spans = timezoneTable.spans, offset = spans[0].offset_min, n;\n      for (n = 1; n < spans.length && d.getTime() >= spans[n].from_ms; n++) offset = spans[n].offset_min;\n      var local = new Date(d.getTime() + offset * 60000);\n      return { y: local.getUTCFullYear(), mo: local.getUTCMonth() + 1, day: local.getUTCDate(), dow: local.getUTCDay(), min: local.getUTCHours() * 60 + local.getUTCMinutes() };\n    }", 'timezone table local-parts adapter');
  code = replaceCodeOnce(code, 'return {\n    isItemActiveNow:', 'return {\n    setTimezoneTable: function (table) { timezoneTable = table; },\n    isItemActiveNow:', 'timezone table export');
  compileBrowserCode(code, dest);
}
/* These helpers execute in the native renderer too.  They must be compiled
 * from the canonical implementation, never copied snapshots: the package had
 * already drifted from UnpairGate.storageKeys(suffix, linkSuffix). */
const sourceDerivedHelpers = {
  'schedule-eval.js': path.join(__dirname, '..', 'server', 'lib', 'schedule-eval.js'),
  'unpair-gate.js': path.join(__dirname, '..', 'server', 'lib', 'unpair-gate.js'),
  'play-order.js': path.join(__dirname, '..', 'server', 'lib', 'play-order.js'),
  'offline-play-queue.js': path.join(__dirname, '..', 'server', 'lib', 'offline-play-queue.js'),
  'trigger-resolve.js': path.join(__dirname, '..', 'server', 'lib', 'trigger-resolve.js'),
  'media-mute.js': path.join(__dirname, '..', 'server', 'lib', 'media-mute.js'),
  'orientation-style.js': path.join(__dirname, '..', 'server', 'lib', 'orientation-style.js'),
  'wall-geometry.js': path.join(__dirname, '..', 'server', 'lib', 'wall-geometry.js'),
  'player-media-health.js': path.join(__dirname, '..', 'server', 'lib', 'player-media-health.js'),
};
for (const name of fs.readdirSync(app)) {
  if (name === 'index.html' || name === 'renderer.html' || name === 'config.xml') continue;
  const src = path.join(app, name), dest = path.join(output, name);
  if (!fs.statSync(src).isFile() || sourceDerivedHelpers[name]) continue;
  if (!name.endsWith('.js')) { fs.copyFileSync(src, dest); continue; }
  compileBrowserScript(src, dest);
}
for (const [name, src] of Object.entries(sourceDerivedHelpers)) {
  if (!fs.statSync(src).isFile()) throw Error('Required upstream native helper missing: ' + src);
  if (name === 'schedule-eval.js') compileScheduleEvalForOrsay(src, path.join(output, name));
  else compileBrowserScript(src, path.join(output, name));
}
/* These are the same browser dependencies referenced by the current upstream
 * legacy renderer.  Keep their source locations explicit: a missing or renamed
 * dependency fails this build instead of degrading an offline package at runtime. */
const upstreamBrowserDependencies = {
  'kiosk-logic.js': path.join(__dirname, '..', 'server', 'lib', 'kiosk-logic.js'),
  'kiosk-player.js': path.join(__dirname, '..', 'server', 'player', 'kiosk-player.js'),
  'bundle-skip.js': path.join(__dirname, '..', 'server', 'lib', 'bundle-skip.js'),
  'screen-share.js': path.join(__dirname, '..', 'server', 'lib', 'screen-share-player.js'),
};
for (const [name, src] of Object.entries(upstreamBrowserDependencies)) {
  if (!fs.statSync(src).isFile()) throw Error('Required upstream browser dependency missing: ' + src);
  compileBrowserScript(src, path.join(output, name));
}
// Socket.IO is already a pinned build dependency of the server. Keep the exact
// browser version used by this legacy package pinned here as well, then produce
// the ES5 file during the release build instead of reviewing a 3,000-line
// generated vendor artifact as if it were player source.
const socketSource = require.resolve('socket.io-client/dist/socket.io.js');
const socketCode = fs.readFileSync(socketSource, 'utf8');
const socketCompiled = babel.transformSync(socketCode, {
  presets: [[preset, { targets: { ie: '11' }, modules: false }]],
  comments: false,
  sourceType: 'script',
}).code;
acorn.parse(socketCompiled, { ecmaVersion: 5 });
fs.writeFileSync(path.join(output, 'socket.io.js'), socketCompiled);
const configXml = fs.readFileSync(path.join(app, 'config.xml'), 'utf8')
  .replace(/<ver>\d+<\/ver>/, '<ver>' + build + '</ver>');
fs.writeFileSync(path.join(output, 'config.xml'), configXml);
// A packaged Orsay app runs from file://, so it cannot derive the CMS origin.
// Site-specific builds may stamp one here; portable builds leave first-run
// setup responsible for persisting it. No server address lives in app source.
const orsayBase = (process.env.ST_ORSAY_BASE_URL || '').trim().replace(/\/+$/, '');
const orsayChannel = (process.env.ST_ORSAY_CHANNEL || '/sssp3/').trim();
if (orsayChannel[0] !== '/' || orsayChannel.includes('\\') || orsayChannel.includes('..')) {
  throw new Error('ST_ORSAY_CHANNEL must be an absolute server path without traversal');
}
if (orsayBase) {
  let parsedBase;
  try { parsedBase = new URL(orsayBase); } catch (_) { throw new Error('ST_ORSAY_BASE_URL must be an absolute HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(parsedBase.protocol)) throw new Error('ST_ORSAY_BASE_URL must use HTTP or HTTPS');
  if (parsedBase.protocol === 'http:') console.warn('ST_ORSAY_BASE_URL uses plaintext HTTP; device tokens traverse the network without transport encryption. Use HTTPS where the panel firmware supports it.');
  const baseLiteral = JSON.stringify(orsayBase);
  const launcherLiteral = JSON.stringify(orsayBase + orsayChannel);
  /* Matches the shape the 1288 package used: seed serverUrl for a wiped panel,
   * then define __STNative with the absolute base + launcher fallback. */
  const preludeDest = path.join(output, 'native-prelude.js');
  const prelude = `(function () {
  try {
    var config = JSON.parse(localStorage.getItem('rd_web_player') || '{}');
    if (!config.serverUrl) {
      config.serverUrl = ${baseLiteral};
      localStorage.setItem('rd_web_player', JSON.stringify(config));
    }
  } catch (ignore) {}
  window.__STNative = {
    base: ${baseLiteral},
    launcherUrl: ${launcherLiteral},
    enabled: true
  };
})();
`;
  acorn.parse(prelude, { ecmaVersion: 5 });
  const stampNote = '/* scaffold-stamped prelude: server base injected at build time (ST_ORSAY_BASE_URL); player source stays clean */\n';
  fs.writeFileSync(preludeDest, stampNote + prelude);
}
// Keep esbuild's source comments independent of the shell's current directory.
// They are part of the generated bytes, so without absWorkingDir an identical
// source tree could produce a different immutable SSSP package when built from
// the repository root instead of this directory.
const bundle = esbuild.buildSync({ stdin: { contents: "import 'core-js/stable'; import 'regenerator-runtime/runtime';", resolveDir: __dirname }, absWorkingDir: __dirname, bundle: true, write: false, format: 'iife', target: 'es5', logLevel: 'silent' }).outputFiles[0].text;
const polyfills = bundle;
acorn.parse(polyfills, { ecmaVersion: 5 });
fs.writeFileSync(path.join(output, 'polyfills.js'), polyfills);
console.log('Generated ES5 renderer candidate and local dependencies.');
