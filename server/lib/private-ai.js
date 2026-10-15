'use strict';

/*
 * 3.0 Private AI: AI that runs on the customer's own hardware (docs/private-ai.md).
 *
 * A "local / private" provider is an OpenAI-compatible server the customer runs themselves —
 * Ollama, LM Studio, llama.cpp's server, vLLM, LocalAI — usually on their own network. It is stored
 * in the same per-workspace ai_settings row as the bring-your-own endpoint (provider_kind 'local'),
 * so every existing AI feature uses it with no second code path; this module adds what "private"
 * needs on top:
 *
 *   - reaching a PRIVATE address under the outbound rules, one host at a time (ai_private_hosts);
 *   - knowing whether an endpoint really is private, for the badge and for the org policy;
 *   - the organization policy "only allow private AI" (org_ai_policy), enforced on the server;
 *   - listing a server's models in both dialects (OpenAI /v1/models, Ollama /api/tags);
 *   - asking the configured model for JSON, robustly, for the starter-set and translation features.
 *
 * ⚠️ NOTHING HERE LOGS A PROMPT, A REPLY OR SIGN TEXT. Audit rows carry counts and ids; console
 * lines carry status codes. A school or hospital choosing private AI is choosing that its words do
 * not end up anywhere they did not send them — and a server log is somewhere.
 *
 * ⚠️ THE ALLOW LIST NEVER OPENS A RANGE. An entry is one exact host string (a name or one IP
 * literal), scoped to one organization, added by a platform administrator. OUTBOUND_ALLOW_PRIVATE is
 * never set or suggested by this feature: it would open the whole private network to every member
 * who can type a URL into any feature, which is exactly the silent opening the operator must not get.
 */

const dns = require('dns');
const net = require('net');
const { db } = require('../db/database');
const config = require('../config');
const { decrypt } = require('./secretbox');
const { aiFetch } = require('./ai-fetch');
const { isNeverAllowed, isPrivateOrLoopback } = require('./storage/endpoint-guard');
const { isBlockedFor, isBlockedIp } = require('./ssrf-guard');
const { trimTrailing } = require('./trim-trailing');

const MAX_HOSTS_PER_ORG = 20;
const LIST_TIMEOUT_MS = 15000;
const CHAT_TIMEOUT_MS = 180000;   // a CPU-only 8B model really does take this long on a long prompt

const nowSec = () => Math.floor(Date.now() / 1000);

/* ============================================================ hosts */

/** The host part of a URL in the one form the allow list stores and compares. */
function hostKey(h) {
  return String(h || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function hostOfUrl(rawUrl) {
  try { return hostKey(new URL(String(rawUrl)).hostname); } catch { return ''; }
}

/*
 * A host an operator may allow: a DNS name or one IP literal. Never a pattern, a range, a URL, or a
 * cloud-metadata address — the last is refused here too, so it cannot even be stored.
 */
function validAllowHost(raw) {
  const h = hostKey(raw);
  if (!h || h.length > 253) return null;
  if (net.isIP(h)) return isNeverAllowed(h) ? null : h;
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(h)) return null;
  if (/^(metadata|metadata\.google\.internal|instance-data)$/.test(h)) return null;
  return h;
}

function orgOfWorkspace(workspaceId) {
  if (!workspaceId) return null;
  const r = db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(workspaceId);
  return r ? r.organization_id || null : null;
}

/** The hosts allowed for an organization's AI requests. */
function allowedHosts(orgId) {
  if (!orgId) return [];
  return db.prepare('SELECT host FROM ai_private_hosts WHERE org_id = ? ORDER BY host').all(orgId).map((r) => r.host);
}

/** What aiFetch takes as `privateHosts` for a workspace's requests. */
function privateHostsFor(workspaceId) {
  return allowedHosts(orgOfWorkspace(workspaceId));
}

function isHostAllowed(workspaceId, rawUrl) {
  const h = hostOfUrl(rawUrl);
  return !!h && privateHostsFor(workspaceId).includes(h);
}

function addAllowedHost(orgId, rawHost, userId) {
  const host = validAllowHost(rawHost);
  if (!host) { const e = new Error('That is not a host name or a single IP address.'); e.status = 400; throw e; }
  const n = db.prepare('SELECT COUNT(*) AS n FROM ai_private_hosts WHERE org_id = ?').get(orgId).n;
  if (n >= MAX_HOSTS_PER_ORG && !allowedHosts(orgId).includes(host)) {
    const e = new Error(`At most ${MAX_HOSTS_PER_ORG} private AI hosts per organization.`); e.status = 400; throw e;
  }
  db.prepare('INSERT OR IGNORE INTO ai_private_hosts (org_id, host, created_by) VALUES (?, ?, ?)').run(orgId, host, userId || null);
  return host;
}

function removeAllowedHost(orgId, rawHost) {
  return db.prepare('DELETE FROM ai_private_hosts WHERE org_id = ? AND host = ?').run(orgId, hostKey(rawHost)).changes > 0;
}

/* ============================================================ is it private, and may we go there */

let _lookup = (host) => dns.promises.lookup(host, { all: true, verbatim: true });
/** Tests answer DNS themselves (no real network); null restores the resolver. */
function _setLookup(fn) { _lookup = fn || ((host) => dns.promises.lookup(host, { all: true, verbatim: true })); }

/**
 * Where a URL's host lives. `private` is true only when EVERY address is loopback or private-LAN:
 * one public address means a request could leave the network, and the badge must not say otherwise.
 */
async function classify(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl)); } catch { return { ok: false, reason: 'bad_url' }; }
  if (!/^https?:$/.test(url.protocol)) return { ok: false, reason: 'bad_url' };
  if (url.username || url.password) return { ok: false, reason: 'bad_url' };
  const host = hostKey(url.hostname);
  let addrs;
  if (net.isIP(host)) addrs = [host];
  else {
    if (/^(metadata|metadata\.google\.internal|instance-data)$/.test(host)) return { ok: false, host, reason: 'never' };
    try { addrs = (await _lookup(host)).map((a) => a.address); } catch { return { ok: false, host, reason: 'dns' }; }
  }
  if (!addrs.length) return { ok: false, host, reason: 'dns' };
  if (addrs.some((a) => isNeverAllowed(a))) return { ok: false, host, reason: 'never' };
  const priv = addrs.every((a) => isPrivateOrLoopback(a));
  const anyBlocked = addrs.some((a) => isBlockedIp(a));
  return { ok: true, host, addresses: addrs, private: priv, needs_allow: anyBlocked,
    // OUTBOUND_ALLOW_HOSTS / OUTBOUND_ALLOW_PRIVATE already open every address this host has.
    env_allowed: anyBlocked && addrs.every((a) => !isBlockedFor(a, host)) };
}

/**
 * May this workspace's AI requests reach this URL, and if not, exactly what would allow it.
 * `via` names the rule that allowed it, so the settings screen can say which one.
 */
async function reachability(workspaceId, rawUrl) {
  const c = await classify(rawUrl);
  if (!c.ok) return { ...c, allowed: false };
  const out = { host: c.host, private: c.private, addresses: c.addresses };
  if (!c.needs_allow) return { ...out, allowed: true, via: 'public' };
  // Self-hosted mode trusts the operator with its own network, as it always has for AI (local-ai-setup.md).
  if (config.selfHosted) return { ...out, allowed: true, via: 'self_hosted' };
  if (c.env_allowed) return { ...out, allowed: true, via: 'env' };
  if (privateHostsFor(workspaceId).includes(c.host)) return { ...out, allowed: true, via: 'org_allowlist' };
  return { ...out, allowed: false, via: null, how_to_allow: { env: `OUTBOUND_ALLOW_HOSTS=${c.host}`, host: c.host } };
}

/* ============================================================ org policy */

function onlyPrivate(orgId) {
  if (!orgId) return false;
  const r = db.prepare('SELECT only_private FROM org_ai_policy WHERE org_id = ?').get(orgId);
  return !!(r && r.only_private);
}

function onlyPrivateForWorkspace(workspaceId) {
  return onlyPrivate(orgOfWorkspace(workspaceId));
}

function setOnlyPrivate(orgId, on, userId) {
  db.prepare(`INSERT INTO org_ai_policy (org_id, only_private, updated_by, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(org_id) DO UPDATE SET only_private = excluded.only_private, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(orgId, on ? 1 : 0, userId || null, nowSec());
}

const POLICY_ERROR = 'Your organization allows private AI only. Use an AI server on your own network.';

/**
 * Under "only private AI", refuse any endpoint that is not on a private network. Resolved NOW, not
 * read from the saved flag: a name that pointed at the LAN when it was saved can point anywhere today.
 * Returns null when allowed, or {error, status, code}.
 */
async function policyCheck(workspaceId, urls) {
  if (!onlyPrivateForWorkspace(workspaceId)) return null;
  for (const u of urls.filter(Boolean)) {
    const c = await classify(u);
    if (!c.ok || !c.private) return { error: POLICY_ERROR, status: 403, code: 'private_only' };
  }
  return null;
}

/* ============================================================ the workspace's provider */

function settingsRow(workspaceId) {
  return db.prepare(`SELECT base_url, api_key_enc, model, image_base_url, image_model, image_provider, image_api_key_enc,
    provider_kind, endpoint_private FROM ai_settings WHERE workspace_id = ?`).get(workspaceId) || null;
}

/** What the dashboard needs to know about AI here. Never a key, never an address. */
function status(workspaceId) {
  const row = workspaceId ? settingsRow(workspaceId) : null;
  const configured = !!(row && row.base_url && row.model);
  const local = !!(row && row.provider_kind === 'local');
  return {
    configured,
    kind: configured ? (local ? 'local' : 'custom') : null,
    model: configured ? row.model : '',
    image_configured: !!(row && row.image_base_url && row.image_provider),
    // The badge claim: a local provider whose host resolved only to private addresses when saved.
    private: configured && local && row.endpoint_private === 1,
    only_private: onlyPrivateForWorkspace(workspaceId),
    self_hosted: !!config.selfHosted,
  };
}

/* ============================================================ model listing */

/** A model name that is an image generator, by the names those servers actually use. */
const IMAGE_MODEL = /(stable-?diffusion|\bsd[-_ ]?(xl|1\.5|2|3|turbo)|sdxl|flux|dall-?e|gpt-image|imagen|kandinsky|playground-v|pixart|image-gen|txt2img)/i;
/** Not a chat model: embeddings and speech, which a text dropdown should not offer first. */
const NOT_TEXT = /(embed|embedding|whisper|tts|rerank|bge-|nomic-embed|clip)/i;

/**
 * GET {base}/models (OpenAI shape: {data:[{id}]}); if that fails, Ollama's own /api/tags at the
 * server root ({models:[{name}]}). Returns {models, text_models, image_models, dialect} or throws
 * with a message a person can act on.
 */
async function listModels({ baseUrl, apiKey, privateHosts }) {
  const base = trimTrailing(String(baseUrl || '').trim(), '/');
  const headers = { Authorization: `Bearer ${apiKey || 'none'}` };
  const get = async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS);
    try { return await aiFetch(url, { headers, signal: controller.signal, privateHosts }); }
    finally { clearTimeout(timer); }
  };
  let names = null;
  let dialect = null;
  let firstErr = null;
  try {
    const r = await get(base + '/models');
    if (r.ok) {
      const j = await r.json().catch(() => null);
      if (j && Array.isArray(j.data)) { names = j.data.map((m) => m && m.id).filter((x) => typeof x === 'string'); dialect = 'openai'; }
      else if (j && Array.isArray(j.models)) { names = j.models.map((m) => m && (m.name || m.model || m.id)).filter((x) => typeof x === 'string'); dialect = 'ollama'; }
    } else firstErr = `the server answered ${r.status}`;
  } catch (e) { firstErr = e && e.name === 'AbortError' ? 'timed out' : String(e && e.message || e).slice(0, 160); }

  if (!names) {
    // Ollama's native listing lives at the server root, not under /v1.
    let root;
    try { const u = new URL(base); root = `${u.protocol}//${u.host}`; } catch { root = null; }
    if (root) {
      try {
        const r = await get(root + '/api/tags');
        if (r.ok) {
          const j = await r.json().catch(() => null);
          if (j && Array.isArray(j.models)) { names = j.models.map((m) => m && (m.name || m.model)).filter((x) => typeof x === 'string'); dialect = 'ollama'; }
        }
      } catch { /* report the first failure, which is the informative one */ }
    }
  }
  if (!names) {
    const e = new Error(firstErr ? `Could not list models: ${firstErr}.` : 'The server did not answer with a model list.');
    e.status = 400;
    throw e;
  }
  const models = [...new Set(names.map((n) => n.slice(0, 200)))].slice(0, 300);
  return {
    models,
    text_models: models.filter((m) => !IMAGE_MODEL.test(m) && !NOT_TEXT.test(m)),
    image_models: models.filter((m) => IMAGE_MODEL.test(m)),
    dialect,
  };
}

/* ============================================================ asking for JSON */

/*
 * `[1, 2,]` and `{"a": 1,}`: a comma with only whitespace before the closing bracket, the commonest
 * way a local model's JSON is "almost" JSON. String-aware, so a ", }" inside a
 * value is left alone. Nothing else is repaired: a reply that needs guessing is not used.
 */
function withoutTrailingCommas(text) {
  let out = '';
  let inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += c;
  }
  return out;
}

/** Every balanced, parseable JSON object or array in `s`, in order; an inner one is not repeated. */
function jsonValuesIn(s) {
  const out = [];
  for (let start = 0; start < s.length; start++) {
    const ch = s[start];
    if (ch !== '{' && ch !== '[') continue;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) {
          const slice = s.slice(start, i + 1);
          let v;
          try { v = JSON.parse(slice); } catch {
            try { v = JSON.parse(withoutTrailingCommas(slice)); } catch { break; }
          }
          out.push(v);
          start = i;   // carry on AFTER this value, not inside it
          break;
        }
      }
    }
  }
  return out;
}

/**
 * The JSON value in a model's reply.
 *
 * Local models wrap JSON in prose, code fences, or a reasoning block (<think>…</think> from
 * qwen3 / deepseek-r1) however firmly the prompt says not to. This takes the first balanced object
 * or array — string-aware, so a "}" inside a value does not end it — and parses that, allowing
 * trailing commas. A fenced block is looked in first, and a value that carries objects wins over a
 * stray one in the prose before it ("Here are [3] signs: {...}" is the object, not [3]).
 */
function extractJson(content) {
  let s = String(content == null ? '' : content);
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const structured = (v) => (v && typeof v === 'object' && !Array.isArray(v))
    || (Array.isArray(v) && v.some((x) => x && typeof x === 'object'));
  const fence = /```[a-z]*\s*([\s\S]*?)```/i.exec(s);
  const pools = [];
  if (fence) pools.push(jsonValuesIn(fence[1]));
  pools.push(jsonValuesIn(s.replace(/```(?:json)?/gi, '')));
  for (const vals of pools) {
    const hit = vals.find(structured);
    if (hit !== undefined) return hit;
  }
  for (const vals of pools) if (vals.length) return vals[0];
  return undefined;
}

/**
 * One chat turn with the workspace's configured model, answered as parsed JSON.
 *
 * Errors come back as {error, status, code?}, never thrown, and never carry the prompt. Enforces
 * the organization policy and the outbound rules for private hosts before anything is sent.
 */
async function chatJson({ workspaceId, system, user, temperature = 0.2, timeoutMs = CHAT_TIMEOUT_MS }) {
  const row = settingsRow(workspaceId);
  if (!row || !row.base_url || !row.model) {
    return { error: 'AI is not set up for this workspace.', status: 400, code: 'not_configured' };
  }
  const reach = await reachability(workspaceId, row.base_url);
  if (!reach.allowed) return { error: 'The AI server address is not allowed on this instance.', status: 400, code: 'not_allowed' };
  const policy = await policyCheck(workspaceId, [row.base_url]);
  if (policy) return policy;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await aiFetch(trimTrailing(row.base_url, '/') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${decrypt(row.api_key_enc) || 'none'}` },
      body: JSON.stringify({
        model: row.model, temperature, stream: false,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: controller.signal,
      privateHosts: privateHostsFor(workspaceId),
    });
  } catch (e) {
    return { error: 'Could not reach the AI server: ' + (e && e.name === 'AbortError' ? 'it took too long to answer' : 'connection failed') + '.', status: 400, code: 'unreachable' };
  } finally { clearTimeout(timer); }
  if (!res.ok) {
    // The status only: an upstream error body can echo the request, and the request is the content.
    return { error: `The AI server answered with an error (${res.status}). Check the model name in AI settings.`, status: 400, code: 'upstream' };
  }
  let json;
  try { json = await res.json(); } catch { return { error: 'The AI server did not answer in the expected format.', status: 400, code: 'bad_reply' }; }
  const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  const parsed = extractJson(content);
  if (parsed === undefined) return { error: 'The AI did not answer with usable JSON.', status: 400, code: 'bad_json' };
  return { parsed, local: row.provider_kind === 'local' };
}

module.exports = {
  hostKey, hostOfUrl, validAllowHost, orgOfWorkspace,
  allowedHosts, privateHostsFor, isHostAllowed, addAllowedHost, removeAllowedHost,
  classify, reachability,
  onlyPrivate, onlyPrivateForWorkspace, setOnlyPrivate, policyCheck, POLICY_ERROR,
  settingsRow, status, listModels, extractJson, chatJson,
  IMAGE_MODEL,
  _setLookup,
};
