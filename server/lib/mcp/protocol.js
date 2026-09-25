'use strict';

/*
 * Model Context Protocol, JSON-RPC 2.0 over HTTP.
 *
 * ⚠️ IMPLEMENTED DIRECTLY RATHER THAN WITH THE SDK, and the trade-off is worth stating. The official
 * SDK is ESM-first and this server is CommonJS, so taking it means either a dynamic-import dance in a
 * hot path or a build step this project does not otherwise have — against a protocol surface that is
 * four methods wide. We carry one fewer production dependency and keep the licence/SBOM story simple.
 * The cost is that a future protocol revision is our problem: PROTOCOL_VERSIONS below is the single
 * place that changes, and `initialize` echoes a version it recognises rather than asserting our own.
 *
 * Deliberately NOT implemented: resources, prompts, sampling, roots, and server-initiated streaming.
 * We have nothing to put in them. An empty capability advertised is a client feature that renders a
 * blank panel; a capability omitted is a client that never asks.
 */

// Newest first. `initialize` picks the client's version when we know it, so an older client keeps
// working and a newer one is told plainly what we speak.
const PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
const LATEST = PROTOCOL_VERSIONS[0];

const ERR = Object.freeze({
  PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602, INTERNAL: -32603,
});

const rpcError = (id, code, message, data) => ({
  jsonrpc: '2.0', id: id === undefined ? null : id,
  error: data === undefined ? { code, message } : { code, message, data },
});
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

function negotiateVersion(requested) {
  return PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST;
}

/*
 * Handle one JSON-RPC message.
 *
 * `ctx` supplies what the transport knows: the token's scope, and `callTool` to actually run one.
 * Returns the response object, or null for a NOTIFICATION — a message with no id, which by the
 * JSON-RPC spec must not be answered. Replying to one is the classic way a client hangs waiting for
 * a response it never asked for while a stray one arrives out of band.
 */
async function handleMessage(msg, ctx) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg && msg.id, ERR.INVALID_REQUEST, 'Invalid JSON-RPC request');
  }
  const isNotification = msg.id === undefined || msg.id === null;
  const { id, method, params = {} } = msg;

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: negotiateVersion(params.protocolVersion),
        // Only what we have. `listChanged` is false: the catalogue is static for a given token, so
        // promising change notifications we will never send would leave a client subscribed forever.
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'screentinker', version: ctx.version || '0.0.0' },
        instructions: ctx.instructions || undefined,
      });

    // Notifications: acknowledged by the transport with a 202 and no body.
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return isNotification ? null : rpcResult(id, {});

    case 'tools/list':
      return rpcResult(id, { tools: ctx.manifest() });

    case 'tools/call': {
      const name = params && params.name;
      if (!name || typeof name !== 'string') {
        return rpcError(id, ERR.INVALID_PARAMS, 'tools/call requires a tool name');
      }
      const out = await ctx.callTool(name, (params && params.arguments) || {});
      /*
       * ⚠️ A FAILED TOOL IS A RESULT, NOT A JSON-RPC ERROR. A protocol error means "this call was
       * malformed"; a 404 from the API means "that display does not exist", which is information the
       * model should see and act on. Returning the second as a protocol error hides it from the model
       * entirely and the agent just stops.
       */
      return rpcResult(id, {
        content: [{ type: 'text', text: out.text }],
        isError: !!out.isError,
      });
    }

    // Asked for by clients that assume every server has them. An empty list is a truthful answer and
    // cheaper than a method-not-found the client then logs as a failure.
    case 'resources/list': return isNotification ? null : rpcResult(id, { resources: [] });
    case 'prompts/list':   return isNotification ? null : rpcResult(id, { prompts: [] });

    default:
      return isNotification ? null : rpcError(id, ERR.METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }
}

module.exports = { handleMessage, negotiateVersion, PROTOCOL_VERSIONS, LATEST, ERR, rpcError, rpcResult };
