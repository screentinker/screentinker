'use strict';

/*
 * Can THIS Node load the better-sqlite3 binary at all?
 *
 * ⚠️ ASK BEFORE REQUIRING IT. better-sqlite3 13 is a Node-API build that needs Node-API 10 (Node
 * 22.14+). On an older Node it does not throw, it SEGFAULTS while opening a database — measured on
 * Node 20.20 and 22.12/22.13, exit 139. A segfault cannot be caught, so the try/catch fallbacks in
 * sqlite-driver.js and preflight-deps.js never run, and under systemd Restart=always that is a
 * crash loop with nothing in the log. Hence a version check first, never a load-and-see.
 *
 * Only Node builtins here: preflight-deps.js uses it before anything else is known to be installed.
 */

const MIN_NAPI = 10;
const MIN_NODE = '22.14.0';

/** Why the native driver must not be loaded on this Node, or null when it may be. */
function nativeUnsupported(napi = process.versions.napi, node = process.versions.node) {
  const have = parseInt(napi, 10);
  if (Number.isFinite(have) && have >= MIN_NAPI) return null;
  return `better-sqlite3 needs Node-API ${MIN_NAPI} (Node ${MIN_NODE} or newer); Node ${node} has Node-API ${napi || 'unknown'}`;
}

module.exports = { nativeUnsupported, MIN_NAPI, MIN_NODE };
