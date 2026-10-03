'use strict';

const fs = require('fs');
const path = require('path');

/*
 * FETCH ONE FILE FROM A PARENT, AND SURVIVE THE LINK DROPPING HALFWAY.
 *
 * ⚠️ RESUMABLE, BECAUSE THE LINKS THIS RUNS OVER ARE THE BAD ONES. The sites that need content
 * pushed to them are the sites nobody wants to visit: a shop on 4G, a factory on a long copper run,
 * a coach with a rooftop modem. A 400 MB video over a link that drops every few minutes never
 * completes if every failure restarts from zero — that exact failure is why player downloads
 * learned Range/If-Range, and this is the same lesson on the server side.
 *
 * ⚠️ IF-RANGE IS NOT OPTIONAL. Resuming with a byte offset alone assumes the file did not change
 * between attempts. If it did, the two halves are stitched from different files and the result is a
 * plausible-looking corrupt asset that passes every length check. The digest would catch it at
 * commit — but only after moving the whole file twice — so this refuses to resume against a
 * changed representation and starts again instead.
 *
 * Nothing here decides whether the bytes may be accepted; that is settled before this is called.
 * This moves bytes into a `.part` and reports what it did.
 */

const CHUNK_TIMEOUT_MS = 120_000;

/** How many times a single asset is re-attempted before it is given up on for this round. */
const MAX_ATTEMPTS = 5;

/** Grows with each attempt so a node that is genuinely down is not hammered. */
const backoffMs = (attempt) => Math.min(30_000, 500 * (2 ** attempt));

/**
 * @param {object}   opts
 * @param {string}   opts.url        the parent's ticket URL — built from the edge's OWN peer_url
 * @param {string}   opts.stagedPath where to write; resumed if it already exists
 * @param {number}   opts.expectedBytes
 * @param {function} [opts.fetchImpl]
 * @param {function} [opts.sleep]
 */
async function downloadResumable({ url, stagedPath, expectedBytes, fetchImpl, sleep, signal }) {
  const doFetch = fetchImpl || global.fetch;
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  if (!doFetch) return { ok: false, reason: 'This server cannot fetch content.' };

  fs.mkdirSync(path.dirname(stagedPath), { recursive: true });

  let validator = null;          // ETag or Last-Modified of the representation we started on
  let lastError = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await wait(backoffMs(attempt));

    let have = 0;
    try { have = fs.statSync(stagedPath).size; } catch (e) { have = 0; }

    /*
     * ⚠️ More bytes than were promised means the staged file is not what we think it is — a stale
     * `.part` from an earlier, different asset under the same name. Start clean rather than trying
     * to reconcile it; the cost is one transfer and the alternative is a corrupt file.
     */
    if (have > expectedBytes) {
      try { fs.unlinkSync(stagedPath); } catch (e) { /* best effort */ }
      have = 0;
    }
    if (have === expectedBytes) return { ok: true, bytes: have, resumed: attempt > 0 };

    const headers = {};
    if (have > 0) {
      headers.Range = `bytes=${have}-`;
      // See the note above: resume only against the same representation.
      if (validator) headers['If-Range'] = validator;
    }

    let res;
    const timer = AbortSignal.timeout ? AbortSignal.timeout(CHUNK_TIMEOUT_MS) : undefined;
    try {
      res = await doFetch(url, { headers, redirect: 'error', signal: signal || timer });
    } catch (e) {
      lastError = (e && e.message) || 'the connection failed';
      continue;
    }

    if (res.status === 404 || res.status === 410) {
      return { ok: false, reason: 'That file is no longer available from the other server.' };
    }
    if (res.status === 403 || res.status === 401) {
      return { ok: false, reason: 'The other server refused to release that file.' };
    }
    if (!res.ok && res.status !== 206) {
      lastError = `the other server answered ${res.status}`;
      continue;
    }

    /*
     * ⚠️ A 200 IN ANSWER TO A RANGE REQUEST MEANS "HERE IS THE WHOLE THING AGAIN" — either the
     * server ignores ranges or If-Range failed. Truncating first is what makes that safe: appending
     * a full body to a partial file is precisely how two halves of different files get stitched
     * together into something that still has the right length.
     */
    const appending = have > 0 && res.status === 206;
    if (!appending) {
      have = 0;
      try { fs.truncateSync(stagedPath, 0); } catch (e) { /* file may not exist yet */ }
    }

    validator = res.headers.get('etag') || res.headers.get('last-modified') || validator;

    try {
      await streamToFile(res, stagedPath, appending);
    } catch (e) {
      lastError = (e && e.message) || 'the transfer was interrupted';
      continue;
    }

    let size = 0;
    try { size = fs.statSync(stagedPath).size; } catch (e) { size = 0; }
    if (size === expectedBytes) return { ok: true, bytes: size, resumed: attempt > 0 || appending };

    // Short: the link dropped mid-body. Keep what arrived and resume on the next attempt.
    lastError = `the transfer stopped at ${size} of ${expectedBytes} bytes`;
  }

  return { ok: false, reason: `That file could not be fetched — ${lastError}.`, partial: true };
}

/**
 * ⚠️ STREAMED, NEVER BUFFERED. A 500 MB asset read into memory on a Raspberry Pi is the whole
 * device, and this runs on the same box that is decoding video.
 */
function streamToFile(res, stagedPath, appending) {
  return new Promise((resolve, reject) => {
    if (!res.body) return reject(new Error('the response had no body'));
    const out = fs.createWriteStream(stagedPath, { flags: appending ? 'a' : 'w' });
    const reader = res.body.getReader();
    let failure = null;
    const pump = () => reader.read().then(({ done, value }) => {
      if (done) { out.end(); return; }
      if (!out.write(Buffer.from(value))) {
        out.once('drain', pump);
      } else {
        pump();
      }
    }).catch((e) => {
      /*
       * ⚠️ END THE STREAM, DO NOT DESTROY IT. destroy() discards whatever is still buffered, so a
       * link dropping mid-body left NOTHING on disk — and the next attempt found have === 0, sent
       * no Range, and restarted from zero. The whole resume feature was inert, and it looked like
       * it worked because the file did eventually arrive; only counting bytes on the wire showed
       * it. Flushing what arrived is precisely what makes the next attempt a resume.
       */
      failure = e;
      out.end();
    });
    out.on('error', reject);
    out.on('finish', () => (failure ? reject(failure) : resolve()));
    pump();
  });
}

module.exports = { downloadResumable, MAX_ATTEMPTS };
