'use strict';

/*
 * The server's requests to an AI endpoint a workspace admin typed (an OpenAI-compatible API, a
 * ComfyUI host) and to the image URL such an endpoint hands back.
 *
 * ⚠️ HOSTED MODE VETS THE ADDRESS IT CONNECTS TO, NOT THE STRING IT WAS GIVEN
 * The old check was a hostname regex, so a name that
 * resolves to 127.0.0.1 (localtest.me), an IPv6-mapped literal ([::ffff:7f00:1]), a redirect, or
 * the `data[0].url` an endpoint returns all reached the host's private network and the response
 * came back to the tenant. Now every resolved address is vetted (lib/storage/endpoint-guard), the
 * socket is pinned to it (no DNS rebinding), and redirects are not followed.
 *
 * Self-hosted instances keep plain fetch: pointing at Ollama on localhost or the LAN is the point.
 *
 * Returns a small fetch-shaped object (ok, status, headers.get, text, json, arrayBuffer) so the
 * call sites read the same as before. An aborted signal rejects with name 'AbortError', as fetch does.
 */

const net = require('net');
const http = require('http');
const https = require('https');
const config = require('../config');
const { guardedLookup, vetRequestHost } = require('./storage/endpoint-guard');

const MAX_BYTES = 40 * 1024 * 1024;   // a 2k PNG is a few MB; this only stops an endless body
// Vets the address the socket is handed (so a name cannot rebind between check and connect).
const lookup = guardedLookup({ allowPrivate: false });

function blocked() { return new Error('Endpoint URL not allowed (private/internal addresses are blocked on this instance)'); }
function abortError() { const e = new Error('The operation was aborted'); e.name = 'AbortError'; return e; }

async function guardedFetch(urlString, { method = 'GET', headers = {}, body = null, signal, maxBytes = MAX_BYTES } = {}) {
  const url = new URL(urlString);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Endpoint URL not allowed (scheme)');
  if (url.username || url.password) throw new Error('Endpoint URL not allowed (credentials in URL)');
  if (signal && signal.aborted) throw abortError();
  // Node never calls `lookup` for an IP literal, so literals (and metadata names) are vetted here.
  try { vetRequestHost(url.hostname); }
  catch { throw blocked(); }
  const bodyBuf = body == null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
  const hdrs = { ...headers };
  if (bodyBuf) hdrs['content-length'] = String(bodyBuf.length);

  const { status, resHeaders, buf } = await new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method, headers: hdrs, lookup, agent: false,
      servername: net.isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname,
    }, (res) => {
      const chunks = []; let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > maxBytes) { res.destroy(new Error('response too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, resHeaders: res.headers, buf: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    const onAbort = () => req.destroy(abortError());
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    req.on('close', () => { if (signal) signal.removeEventListener('abort', onAbort); });
    req.on('error', (e) => reject(signal && signal.aborted ? abortError() : (e && e.name === 'SsrfError' ? blocked() : e)));
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });

  // A redirect is answered as what it is: not followed, so it cannot walk to a private address.
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => { const v = resHeaders[String(n).toLowerCase()]; return v == null ? null : String(v); } },
    text: async () => buf.toString('utf8'),
    json: async () => JSON.parse(buf.toString('utf8')),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

function aiFetch(url, opts) {
  if (config.selfHosted) return fetch(url, opts);
  return guardedFetch(url, opts);
}

module.exports = { aiFetch, guardedFetch };
