'use strict';

const path = require('path');
const config = require('../../config');
const locations = require('./locations');

/*
 * THE ORIGIN PROXY: stream a content row's bytes from whichever stored copy answers.
 *
 * This is the air-gap path. A screen on a LAN that cannot reach AWS, or a bucket whose endpoint is
 * an internal Docker name, is served from here — the player asks this server exactly as it always
 * has and never learns a bucket exists.
 *
 * ⚠️ RANGE IS FORWARDED, NOT EMULATED. Video seek and every Android/ExoPlayer resume asks for a
 * byte range; buffering the whole object to slice it would make a 400 MB seek cost 400 MB. The
 * Range header goes to the backend, the answer goes back as 206 with Content-Range, and
 * Accept-Ranges: bytes is always set so a player knows it may ask.
 *
 * ⚠️ RETRY BEFORE THE FIRST BYTE, NEVER AFTER. A copy that fails to open — or opens and errors
 * before producing anything — is skipped and the next ready copy is tried once. Once bytes have
 * reached the client a retry would splice two streams into one response, so a mid-stream failure
 * just ends the response; the player's own resume (a Range request) picks up from there.
 *
 * ETag is the byte_digest: identical bytes have an identical tag wherever they are stored.
 */

/** Parse one `bytes=` range. Returns null (whole file), {start,end} / {suffix}, or 'invalid'. */
function parseRange(header) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null;                         // multi-range or junk: serve the whole thing (RFC 7233 allows it)
  if (m[1] === '' && m[2] === '') return 'invalid';
  if (m[1] === '') return { start: null, end: null, suffix: Number(m[2]) };
  const start = Number(m[1]);
  const end = m[2] === '' ? null : Number(m[2]);
  if (end !== null && end < start) return 'invalid';
  return { start, end };
}

function firstChunk(stream) {
  return new Promise((resolve, reject) => {
    const onData = (c) => { cleanup(); stream.pause(); resolve(c); };
    const onEnd = () => { cleanup(); resolve(null); };
    const onErr = (e) => { cleanup(); reject(e); };
    const cleanup = () => { stream.off('data', onData); stream.off('end', onEnd); stream.off('error', onErr); };
    stream.on('data', onData); stream.once('end', onEnd); stream.once('error', onErr);
  });
}

function contentTypeOf(row, kind) {
  if (kind === 'thumb') return 'image/jpeg';
  if (kind === 'subtitle') return 'text/vtt; charset=utf-8';
  return row.mime_type || 'application/octet-stream';
}

/**
 * Serve `kind` of `row` from storage. Returns a promise that settles when the response is done.
 * `harden(res, name)` re-applies the caller's upload hardening (CSP sandbox / attachment), so this
 * proxy never serves a byte under weaker headers than the static route would have.
 */
async function serveFromStorage(req, res, row, kind = 'asset', { harden = null, cacheControl = null, locations: given = null } = {}) {
  const range = parseRange(req.headers.range);
  if (range === 'invalid') { res.status(416).setHeader('Content-Range', 'bytes */*'); return res.end(); }

  const digest = kind === 'asset' ? row.byte_digest : null;
  if (digest) {
    const etag = `"${digest}"`;
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) { res.status(304); return res.end(); }
  }

  let ordered = given || locations.orderForRead(locations.listLocations(row, kind));
  let attempts = 0;
  while (ordered.length && attempts < 2) {
    attempts++;
    let out;
    try { out = await locations.openForRead(row, kind, { range, locations: ordered }); }
    catch (e) { break; }
    let chunk;
    try { chunk = await firstChunk(out.stream); }
    catch (e) {
      try { out.stream.destroy(); } catch (_) {}
      // That copy failed before a byte was sent: try the copies after it, once.
      const idx = ordered.indexOf(out.loc);
      ordered = ordered.slice(idx + 1);
      continue;
    }
    if (out.partial && out.size != null && out.start >= out.size) {
      try { out.stream.destroy(); } catch (_) {}
      res.status(416).setHeader('Content-Range', `bytes */${out.size}`); return res.end();
    }
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', contentTypeOf(row, kind));
    if (cacheControl) res.setHeader('Cache-Control', cacheControl);
    if (harden) harden(res, path.basename(String(row[locations.KIND_COLUMN[locations.effectiveKind(row, kind)]] || '')));
    if (out.partial && out.end != null) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${out.start}-${out.end}/${out.size == null ? '*' : out.size}`);
      res.setHeader('Content-Length', String(out.end - out.start + 1));
    } else {
      res.status(200);
      if (out.size != null) res.setHeader('Content-Length', String(out.size));
    }
    res.setHeader('x-st-storage', out.loc && out.loc.storage_profile_id ? 'remote' : 'local');
    if (req.method === 'HEAD') { try { out.stream.destroy(); } catch (_) {} return res.end(); }
    /*
     * ⚠️ A short object can be read to its END inside firstChunk: the only chunk arrives, the
     * stream is paused, and 'end' has already been emitted before a listener below could hear it.
     * Waiting for it then hangs the response forever (with Content-Length satisfied, the client
     * sees the body but the socket never frees). So an already-ended stream is finished here.
     */
    if (!chunk || out.stream.readableEnded) { return res.end(chunk || undefined); }
    res.write(chunk);
    return new Promise((resolve) => {
      out.stream.on('error', () => { try { res.destroy(); } catch (_) {} resolve(); });
      out.stream.on('end', () => { res.end(); resolve(); });
      res.on('close', () => { try { out.stream.destroy(); } catch (_) {} resolve(); });
      out.stream.pipe(res, { end: false });
      out.stream.resume();
    });
  }
  res.removeHeader('ETag');
  res.removeHeader('Cache-Control');
  return res.status(404).json({ error: 'Not found' });
}

/** Does this row have any copy that is not a plain local file? (Cheap: one indexed lookup.) */
function storedElsewhere(row) {
  return !!row && locations.hasExplicitLocations(row.id);
}

/** The content row behind a /uploads/content/<name> miss, when it has stored copies. */
function rowForUploadName(db, name) {
  const base = path.basename(String(name || ''));
  if (!base || base.startsWith('.')) return null;
  const hit = (col, kind) => {
    const rows = db.prepare(`SELECT * FROM content WHERE ${col} = ? LIMIT 5`).all(base);
    for (const r of rows) if (locations.listLocations(r, kind).some((l) => l.storage_profile_id)) return { row: r, kind };
    return null;
  };
  return hit('filepath', 'asset') || hit('thumbnail_path', 'thumb') || hit('subtitle_url', 'subtitle');
}

module.exports = { serveFromStorage, parseRange, storedElsewhere, rowForUploadName, contentDir: () => config.contentDir };
