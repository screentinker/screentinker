'use strict';

/*
 * "Generate captions": a video's speech, transcribed by a speech-to-text endpoint the WORKSPACE
 * ADMIN configured, attached as the video's subtitle track (the same content.subtitle_url the
 * subtitle upload writes, so every player that already shows uploaded subtitles shows these).
 *
 * The endpoint is OpenAI-compatible `POST {base}/audio/transcriptions` (multipart: file, model,
 * response_format=vtt): OpenAI itself, or a local server — faster-whisper-server / Speaches,
 * whisper.cpp's server, LocalAI — so a self-hoster can caption without anything leaving the building.
 *
 * ⚠️ WHERE THE AUDIO GOES, BECAUSE THAT IS THE QUESTION THAT MATTERS. Only the AUDIO track (mono,
 * 16 kHz, re-encoded by ffmpeg on this server; never the picture) and only to the base URL the
 * admin typed in Settings, and only when somebody presses Generate. Nothing is configured by default
 * and there is no instance-wide fallback, so a workspace that never set this up never sends anything
 * anywhere. Outbound requests go through lib/ai-fetch (on a hosted instance the address is vetted at
 * connect time, so a name that resolves to the host's private network is refused), under exactly
 * the Private AI rules: the organization's allowed private hosts and its "only private AI" policy.
 *
 * ⚠️ WHAT COMES BACK IS NOT TRUSTED. It is parsed into cues and rebuilt as WebVTT from the cue times
 * and the cue TEXT with every tag stripped, capped in size and count. A hostile endpoint can make the
 * captions wrong; it cannot make the stored file carry markup, a different header or megabytes.
 *
 * Jobs are in memory (one per video, at most two at a time on the server): a transcription is
 * minutes at most, and after a restart the person simply presses the button again.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const config = require('../../config');
const { encrypt, decrypt } = require('../secretbox');
const { stripTags } = require('../strip-tags');
const { trimTrailing } = require('../trim-trailing');

const MAX_AUDIO_SEC = 60 * 60;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;   // OpenAI's limit; local servers take it too
const MAX_VTT_BYTES = 2 * 1024 * 1024;       // the subtitle upload's own cap
const MAX_CUES = 5000;
const STT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RUNNING = 2;

/* ---------------------------------------------------------------- settings */

function getStt(db, workspaceId) {
  let r = null;
  try { r = db.prepare('SELECT stt_base_url, stt_model, stt_api_key_enc FROM ai_settings WHERE workspace_id = ?').get(workspaceId); } catch { r = null; }
  return {
    base_url: (r && r.stt_base_url) || '',
    model: (r && r.stt_model) || '',
    has_key: !!(r && r.stt_api_key_enc),
    configured: !!(r && r.stt_base_url),
  };
}

/*
 * The same rule every other AI feature follows (routes/ai.js endpointAllowed), WITH the workspace:
 * on a hosted instance a private address is refused unless a platform administrator allowed that
 * exact host for this workspace's organization (3.0 Private AI, ai_private_hosts). Without the
 * workspace the allow list was never consulted, so a local Whisper server the admin had allowed
 * for Private AI was still refused here.
 */
function endpointAllowed(url, workspaceId) {
  return require('../../routes/ai').endpointAllowed(url, workspaceId);
}

/** Admin-only (the route checks). Absent fields keep their value; clear_key removes the key. */
function saveStt(db, workspaceId, body) {
  const b = body && typeof body === 'object' ? body : {};
  const cur = db.prepare('SELECT stt_base_url, stt_model, stt_api_key_enc FROM ai_settings WHERE workspace_id = ?').get(workspaceId) || {};
  let base = b.base_url !== undefined ? trimTrailing(String(b.base_url || '').trim(), '/') : (cur.stt_base_url || '');
  if (base.length > 500) return { ok: false, error: 'Base URL is too long' };
  if (base && !endpointAllowed(base, workspaceId)) return { ok: false, error: 'Endpoint URL not allowed (private/internal addresses are blocked on this instance).' };
  // No control characters: the model name is written into a multipart body as a field value.
  const model = b.model !== undefined ? String(b.model || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) : (cur.stt_model || '');
  let keyEnc = cur.stt_api_key_enc || null;
  if (typeof b.api_key === 'string' && b.api_key.length) keyEnc = encrypt(b.api_key.slice(0, 500));
  if (b.clear_key) keyEnc = null;
  db.prepare(`INSERT INTO ai_settings (workspace_id, stt_base_url, stt_model, stt_api_key_enc, updated_at)
              VALUES (?,?,?,?,strftime('%s','now'))
              ON CONFLICT(workspace_id) DO UPDATE SET stt_base_url = excluded.stt_base_url, stt_model = excluded.stt_model,
                stt_api_key_enc = excluded.stt_api_key_enc, updated_at = excluded.updated_at`)
    .run(workspaceId, base || null, model || null, keyEnc);
  return { ok: true, settings: getStt(db, workspaceId) };
}

/* ---------------------------------------------------------------- VTT */

const TS = /(\d{1,2}:)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
function parseTs(s) {
  const m = TS.exec(String(s || '').trim());
  if (!m) return null;
  const h = m[1] ? Number(m[1].slice(0, -1)) : 0;
  return h * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}
function fmtTs(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}.${p(ms % 1000, 3)}`;
}
/** Cue text as plain words: no tags, no entities beyond the three VTT needs, no stray arrows. */
function cleanText(t) {
  return stripTags(String(t || ''))
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/-->/g, '→')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .slice(0, 500);
}

/** WebVTT or SRT text → [{ start, end, text }]. */
function parseCues(src) {
  const cues = [];
  const blocks = String(src || '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const b of blocks) {
    const lines = b.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, z] = lines[i].split('-->');
    const start = parseTs(a), end = parseTs(z);
    if (start == null || end == null || end < start) continue;
    const text = cleanText(lines.slice(i + 1).join('\n'));
    if (!text) continue;
    cues.push({ start, end, text });
    if (cues.length >= MAX_CUES) break;
  }
  return cues;
}

/** JSON transcription (verbose_json `segments`, or just `text`) → cues. */
function cuesFromJson(j, durationSec) {
  if (j && Array.isArray(j.segments) && j.segments.length) {
    return j.segments.slice(0, MAX_CUES).map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: cleanText(s.text) }))
      .filter((c) => c.text && c.end >= c.start);
  }
  if (j && typeof j.text === 'string' && j.text.trim()) {
    return [{ start: 0, end: Math.max(1, Number(durationSec) || 5), text: cleanText(j.text) }];
  }
  return [];
}

function buildVtt(cues) {
  let out = 'WEBVTT\n\n';
  for (const c of cues) {
    const next = `${fmtTs(c.start)} --> ${fmtTs(Math.max(c.end, c.start + 0.2))}\n${c.text}\n\n`;
    if (Buffer.byteLength(out + next) > MAX_VTT_BYTES) break;
    out += next;
  }
  return out;
}

/** Whatever the endpoint sent → clean WebVTT, or null when it held no captions at all. */
function normalizeTranscript(body, contentType, durationSec) {
  const text = String(body || '');
  let cues;
  if (/json/i.test(contentType || '') || /^\s*\{/.test(text)) {
    let j = null;
    try { j = JSON.parse(text); } catch { j = null; }
    cues = cuesFromJson(j, durationSec);
  } else {
    cues = parseCues(text);
  }
  return cues.length ? buildVtt(cues) : null;
}

/* ---------------------------------------------------------------- audio */

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || '').slice(0, 300); reject(err); } else resolve(stdout);
    });
  });
}

/** The audio track as a small mono file, or throws. mp3 when the encoder exists, WAV otherwise. */
async function extractAudio(srcPath) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-captions-'));
  const base = ['-v', 'error', '-nostdin', '-y', '-i', srcPath, '-vn', '-sn', '-t', String(MAX_AUDIO_SEC), '-ac', '1', '-ar', '16000'];
  try {
    const mp3 = path.join(dir, 'audio.mp3');
    await run('ffmpeg', [...base, '-c:a', 'libmp3lame', '-b:a', '48k', mp3], 5 * 60 * 1000);
    return { dir, file: mp3, mime: 'audio/mpeg', name: 'audio.mp3' };
  } catch {
    const wav = path.join(dir, 'audio.wav');
    await run('ffmpeg', [...base, '-c:a', 'pcm_s16le', wav], 5 * 60 * 1000);
    return { dir, file: wav, mime: 'audio/wav', name: 'audio.wav' };
  }
}

function multipart(fields, file) {
  const boundary = '----st' + crypto.randomBytes(12).toString('hex');
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || v === '') continue;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`));
  parts.push(file.bytes, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}

/* ---------------------------------------------------------------- attaching */

/** Store `vtt` as this content's subtitle track, replacing any old one — what POST /:id/subtitle does. */
function attachVtt(db, contentId, vtt, lang) {
  const content = db.prepare('SELECT * FROM content WHERE id = ?').get(contentId);
  if (!content) throw Object.assign(new Error('Content not found'), { status: 404 });
  const name = `${uuidv4()}.vtt`;
  fs.writeFileSync(path.join(config.contentDir, name), vtt);
  require('../content-files').unlinkIfUnreferenced(content.subtitle_url, content.id, 'subtitle_url');
  const locations = require('../storage/locations');
  const stale = db.prepare("SELECT * FROM content_locations WHERE content_id = ? AND kind = 'subtitle'").all(content.id);
  db.transaction(() => {
    db.prepare("DELETE FROM content_locations WHERE content_id = ? AND kind = 'subtitle'").run(content.id);
    db.prepare('UPDATE content SET subtitle_url = ?, subtitle_lang = ? WHERE id = ?')
      .run(name, lang ? String(lang).slice(0, 10) : (content.subtitle_lang || null), content.id);
  })();
  locations.queueRelease(stale);
  locations.settleSoon(content.id, { kinds: ['subtitle'] });
  return db.prepare('SELECT * FROM content WHERE id = ?').get(content.id);
}

/** The current subtitle text of a content row (local file only), or null. */
function readVtt(content) {
  if (!content || !content.subtitle_url) return null;
  const base = path.resolve(config.contentDir);
  const p = path.resolve(base, path.basename(String(content.subtitle_url)));
  if (!p.startsWith(base + path.sep)) return null;
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_VTT_BYTES) return null;
    return fs.readFileSync(p, 'utf8');
  } catch { return null; }
}

/** An edited caption track from the dashboard: same normalisation as an endpoint's answer. */
function normalizeEdited(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_VTT_BYTES) return null;
  return normalizeTranscript(text, 'text/vtt', null);
}

/* ---------------------------------------------------------------- jobs */

const jobs = new Map(); // contentId → { status, error, workspace_id, started_at, finished_at }
let running = 0;
let transport = null;
/** Tests: replace the HTTP call with a fake (url, opts) → fetch-shaped response. */
function _setTransport(fn) { transport = fn || null; }

function jobState(contentId) { return jobs.get(contentId) || null; }

/**
 * Start transcribing. Refusals (not configured, busy, no audio file) come back as { error, status }
 * before anything is sent; the work itself continues after the response.
 */
function start(db, { content, workspaceId, lang, actorReq }) {
  const stt = getStt(db, workspaceId);
  if (!stt.configured) return { status: 409, code: 'stt_not_configured', error: 'Speech-to-text is not set up for this workspace. A workspace admin can add an endpoint under AI settings.' };
  const cur = jobs.get(content.id);
  if (cur && cur.status === 'running') return { status: 409, code: 'captions_running', error: 'Captions are already being made for this video.' };
  if (running >= MAX_RUNNING) return { status: 429, code: 'captions_busy', error: 'The server is already making captions for other videos. Try again in a few minutes.' };
  const file = require('./media').localFile(content);
  if (!file || !/^video\//i.test(content.mime_type || '')) return { status: 400, code: 'captions_no_file', error: 'Captions can be made only for a video stored on this server.' };

  const job = { status: 'running', error: null, workspace_id: workspaceId, started_at: Math.floor(Date.now() / 1000), finished_at: null };
  jobs.set(content.id, job);
  running++;
  (async () => {
    let audio = null;
    try {
      audio = await extractAudio(file);
      const bytes = await fs.promises.readFile(audio.file);
      if (bytes.length > MAX_UPLOAD_BYTES) throw Object.assign(new Error('The audio is too long to send in one piece (over 25 MB).'), { code: 'too_long' });
      const row = db.prepare('SELECT stt_base_url, stt_model, stt_api_key_enc FROM ai_settings WHERE workspace_id = ?').get(workspaceId) || {};
      const base = String(row.stt_base_url || '').replace(/\/+$/, '');
      if (!base) throw new Error('Speech-to-text is not set up any more.');
      // Vetted again now, as the chat features do: the allow list or the org policy may have changed
      // since the endpoint was saved.
      const privateAi = require('../private-ai');
      if (!endpointAllowed(base, workspaceId)) throw new Error('The speech-to-text endpoint is not allowed on this instance.');
      const pol = await privateAi.policyCheck(workspaceId, [base]);
      if (pol) throw new Error(pol.error);
      const key = row.stt_api_key_enc ? decrypt(row.stt_api_key_enc) : null;
      const url = /\/audio\/transcriptions$/.test(base) ? base : `${base}/audio/transcriptions`;
      const mp = multipart({ model: row.stt_model || 'whisper-1', response_format: 'vtt', language: lang && /^[a-z]{2,3}$/i.test(lang) ? lang.toLowerCase() : '' },
        { name: audio.name, mime: audio.mime, bytes });
      const headers = { 'content-type': mp.type };
      if (key) headers.authorization = `Bearer ${key}`;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), STT_TIMEOUT_MS);
      let r;
      try {
        const doFetch = transport || require('../ai-fetch').aiFetch;
        r = await doFetch(url, { method: 'POST', headers, body: mp.body, signal: ac.signal, maxBytes: 8 * 1024 * 1024,
          privateHosts: privateAi.privateHostsFor(workspaceId) });
      } finally { clearTimeout(timer); }
      const text = await r.text();
      if (!r.ok) throw new Error(`The speech-to-text endpoint answered ${r.status}: ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
      const vtt = normalizeTranscript(text, r.headers && r.headers.get ? r.headers.get('content-type') : '', content.duration_sec);
      if (!vtt) throw new Error('The endpoint returned no captions (is there speech in this video?).');
      // The row may have been replaced or deleted while we waited.
      const still = db.prepare('SELECT id, workspace_id FROM content WHERE id = ?').get(content.id);
      if (!still || still.workspace_id !== workspaceId) throw new Error('The video was removed while captions were being made.');
      attachVtt(db, content.id, vtt, lang);
      job.status = 'done';
      try {
        require('../audit').auditFromReq(actorReq, 'captions_generated', { workspace_id: workspaceId, content_id: content.id, endpoint_host: safeHost(base), cues: (vtt.match(/-->/g) || []).length });
      } catch { /* audit is best-effort here; the job already succeeded */ }
      require('./index').invalidate(workspaceId);
    } catch (e) {
      job.status = 'failed';
      job.error = e && e.name === 'AbortError' ? 'The speech-to-text endpoint took too long.' : String((e && e.message) || e).slice(0, 300);
    } finally {
      job.finished_at = Math.floor(Date.now() / 1000);
      running--;
      if (audio) fs.promises.rm(audio.dir, { recursive: true, force: true }).catch(() => {});
    }
  })();
  return { status: 202, job };
}

function safeHost(u) { try { return new URL(u).host; } catch { return null; } }

module.exports = {
  getStt, saveStt, start, jobState, attachVtt, readVtt, normalizeEdited,
  normalizeTranscript, parseCues, buildVtt, _setTransport,
  MAX_VTT_BYTES,
};
