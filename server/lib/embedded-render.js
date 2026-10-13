'use strict';

/*
 * Embedded renderer — Pure Jimp (production) + Optional Headless Browser (dev/opt-in).
 *
 * Takes a resolved playlist item + content row + screen_profile and returns a raw PNG
 * buffer ready for embedded-postprocess.js.
 *
 * Zero-browser architecture:
 *   image / local file  — decoded, resized & cropped with Jimp (production dependency), return PNG.
 *   remote_url (images) — fetched & processed with Jimp, return PNG.
 *   widget / web page   — optionally rendered with Puppeteer if installed and Chrome is found;
 *                         otherwise degrades gracefully returning { unsupported: true, reason }.
 */

const fs = require('fs');
const path = require('path');
const { Jimp, cssColorToHex } = require('jimp');
const config = require('../config');
const { assertSafeUrl, guardedRequest, SsrfError } = require('./ssrf-guard');

// Server-side fetches of an operator-supplied remote_url must go through guardedRequest, which vets
// the URL, PINS the socket to the vetted IP (defeating DNS-rebinding) and re-vets every redirect hop.
// A plain fetch() only knows the URL, so a hostname that resolves to an internal address at connect
// time, or a public URL that 302s to one, would reach it. 20 MB is ample for a still image.
const REMOTE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

const VALID_FIT_MODES = new Set(['cover', 'contain', 'fill']);
function safeFitMode(m) {
  return (typeof m === 'string' && VALID_FIT_MODES.has(m.toLowerCase())) ? m.toLowerCase() : 'contain';
}
function safeHexColor(c, fallback = '#000000') {
  if (!c || typeof c !== 'string') return fallback;
  const s = c.trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(s) ? s : fallback;
}

/*
 * ⚠️ ASK config, DO NOT RE-DERIVE THIS.
 *
 * This used to read `process.env.UPLOAD_DIR` and fall back to `<server>/uploads`. Neither matches
 * how the rest of the server resolves uploads: config.js uses `UPLOADS_DIR` (plural) and falls back
 * to `DATA_DIR/uploads`. `UPLOAD_DIR` is not a variable this project sets anywhere.
 *
 * The consequence was invisible in a dev checkout and total in production. The Docker image runs
 * with DATA_DIR=/data, so content lands in /data/uploads/content while this looked in
 * /app/server/uploads/content — and the local-image path, the one native renderer that needs no
 * browser, answered 501 "No renderable items in playlist" for every image on the shipped image.
 * Reproduced end to end: 501 as written, 200 with exactly 48000 bytes (800x480 packed 1-bit) once
 * the directory matched.
 */
function contentDir() {
  return config.contentDir;
}

// Coerce an untrusted dimension (from a screen_profile row) to a positive integer.
// Returns `fallback` for anything non-numeric, non-finite, or out of range — so a
// malformed profile can never inject arbitrary values into CSS or viewport dimensions.
function safeDimension(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 10000) return fallback;
  return Math.floor(n);
}

// MIME types Jimp can decode natively
const IMAGE_MIMES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif',
  'image/webp', 'image/bmp', 'image/tiff',
]);

const EXT_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif',  '.webp': 'image/webp',  '.bmp': 'image/bmp',
};

function looksLikeImage(urlOrPath, contentType) {
  if (contentType && IMAGE_MIMES.has(contentType.toLowerCase().split(';')[0].trim())) {
    return true;
  }
  const ext = path.extname(String(urlOrPath || '').split('?')[0]).toLowerCase();
  return Boolean(EXT_MIME[ext]);
}

// ─── Browser Lifecycle ────────────────────────────────────────────────────────

let browserInstance = null;
let browserPromise = null;

function getPuppeteer() {
  try { return require('puppeteer-core'); } catch (_) {}
  try { return require('puppeteer'); } catch (_) {}
  return null;
}

/** The Chromium this server was pointed at: CHROME_PATH, or puppeteer's own variable. */
function chromePath() {
  return process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '';
}

/*
 * ⚠️ NEVER CALL puppeteer.executablePath() HERE. In puppeteer-core 25 it became ASYNC: it returns
 * a Promise, which `Boolean()` calls true, and which then REJECTS (no browser in puppeteer's cache)
 * with nobody listening. server.js treats an unhandled rejection as fatal, so on a host with no
 * CHROME_PATH (the Docker image ships no Chromium) the first render request took the server down.
 * In 24 the same call threw synchronously and the catch below it answered false.
 *
 * puppeteer-core never downloads a browser, so an explicit path is the only way one exists here.
 */
function isBrowserAvailable() {
  const p = getPuppeteer();
  if (!p) return false;
  const exe = chromePath();
  if (!exe) return false;
  try {
    return fs.existsSync(exe);
  } catch (_) {
    return false;
  }
}

async function getBrowser() {
  if (browserInstance && browserInstance.connected) {
    return browserInstance;
  }
  if (browserPromise) return browserPromise;

  browserPromise = (async () => {
    const puppeteer = getPuppeteer();
    if (!puppeteer || !isBrowserAvailable()) {
      const err = new Error('Headless browser is not available. Install puppeteer-core and set CHROME_PATH.');
      err.code = 'BROWSER_UNAVAILABLE';
      throw err;
    }
    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--mute-audio',
    ];
    // isBrowserAvailable() guarantees a path; puppeteer-core 25 refuses to launch without one.
    browserInstance = await puppeteer.launch({
      executablePath: chromePath(),
      headless: 'new',
      args: launchArgs,
    });
    browserInstance.on('disconnected', () => {
      browserInstance = null;
      browserPromise = null;
    });
    return browserInstance;
  })();

  try {
    return await browserPromise;
  } finally {
    browserPromise = null;
  }
}

async function closeBrowser() {
  if (browserInstance) {
    try { await browserInstance.close(); } catch (_) {}
    browserInstance = null;
    browserPromise = null;
  }
}

process.on('exit', () => {
  if (browserInstance) {
    try { browserInstance.process()?.kill(); } catch (_) {}
  }
});
process.on('SIGTERM', () => { closeBrowser(); });
process.on('SIGINT', () => { closeBrowser(); });

// ─── Native Image Renderers (Jimp) ───────────────────────────────────────────

function safeLocalImagePath(filepath) {
  if (!filepath) return null;
  const base = path.resolve(contentDir());
  const safe = path.resolve(base, path.basename(String(filepath)));
  if (!safe.startsWith(base + path.sep) && safe !== base) {
    throw Object.assign(new Error('Invalid content file path'), { code: 'INVALID_PATH' });
  }
  if (!fs.existsSync(safe)) {
    throw Object.assign(new Error('Content file not found on disk'), { code: 'NOT_FOUND' });
  }
  return safe;
}

/*
 * safeLocalImagePath, plus items whose bytes are in a storage backend (lib/storage): those are
 * fetched once into the storage cache (never into contentDir) and that file is read instead.
 */
async function localImageFile(content, fileToLoad) {
  try { return safeLocalImagePath(fileToLoad); }
  catch (e) {
    if (e.code !== 'NOT_FOUND' || !content || !content.id) throw e;
    const { db } = require('../db/database');
    const row = db.prepare('SELECT * FROM content WHERE id = ?').get(content.id);
    const loc = require('./storage/locations');
    if (!row || !loc.hasExplicitLocations(row.id)) throw e;
    const kind = fileToLoad === row.thumbnail_path && fileToLoad !== row.filepath ? 'thumb' : 'asset';
    const p = await loc.ensureLocalFile(row, kind);
    if (!p) throw e;
    return p;
  }
}

function parseColorToRgba(hexOrInt, fallback = 0x000000FF) {
  if (typeof hexOrInt === 'number' && Number.isFinite(hexOrInt)) return hexOrInt >>> 0;
  if (typeof hexOrInt === 'string' && hexOrInt.trim()) {
    try {
      const parsed = cssColorToHex(hexOrInt.trim());
      if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed >>> 0;
    } catch (_) {}
  }
  return fallback;
}

function withTimeout(promise, ms = 15000, timeoutErrorMsg = 'Render timed out') {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(timeoutErrorMsg);
      err.code = 'RENDER_TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

const MAX_CONCURRENT_PAGES = 3;
let activePages = 0;
const pageWaiters = [];

function acquirePageSlot(signal) {
  if (signal?.aborted) {
    const err = new Error('Render request aborted');
    err.code = 'ABORTED';
    return Promise.reject(err);
  }
  if (activePages < MAX_CONCURRENT_PAGES) {
    activePages++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject };
    pageWaiters.push(waiter);
    if (signal) {
      signal.addEventListener('abort', () => {
        const idx = pageWaiters.indexOf(waiter);
        if (idx !== -1) {
          pageWaiters.splice(idx, 1);
          const err = new Error('Render request aborted');
          err.code = 'ABORTED';
          reject(err);
        }
      }, { once: true });
    }
  });
}

function releasePageSlot() {
  activePages--;
  if (pageWaiters.length > 0) {
    activePages++;
    const next = pageWaiters.shift();
    next.resolve();
  }
}

async function renderRemoteImage(content, profile) {
  const url = content.remote_url;
  if (!url) return null;

  // This fetch runs on the server against a URL a workspace editor typed, so it must go through
  // guardedRequest: it vets the URL, pins the socket to the vetted IP (no DNS-rebinding) and re-vets
  // every redirect hop. A plain fetch(), even after a one-shot assertSafeUrl, is bypassable by both.
  let response;
  try {
    response = await guardedRequest(url, {
      responseType: 'buffer',
      maxBytes: REMOTE_IMAGE_MAX_BYTES,
      timeoutMs: 15000,
      headers: { 'user-agent': 'ScreenTinker-EmbeddedRenderer/1.0' },
    });
  } catch (e) {
    if (e instanceof SsrfError) {
      throw Object.assign(new Error(`Remote content refused: ${e.message}`), { code: 'BLOCKED_URL' });
    }
    throw Object.assign(new Error(`Failed to fetch remote content: ${e.message}`), { code: 'FETCH_ERROR' });
  }

  const contentType = (response.headers && response.headers['content-type']) || '';
  if (!looksLikeImage(url, contentType)) {
    return null;
  }

  const buf = response.buffer;
  const img = await Jimp.fromBuffer(buf);
  img.cover({ w: profile.width, h: profile.height });
  return img.getBuffer('image/png');
}

function localBaseUrl() {
  return global.__localApiOrigin || process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || config.port || 3001}`;
}

/*
 * Template-agnostic settlement before a screenshot: fonts, finished animations, images and videos,
 * including inside srcdoc iframes, each wait individually bounded so one hung asset cannot hold the
 * frame. Shared by every page render here (the e-ink widget path and the player raster path), so a
 * fix to what "settled" means reaches both.
 */
async function settlePage(page, isLayout) {
  await page.evaluate(async (isLayout) => {
    try { if (document.fonts?.ready) await document.fonts.ready; } catch (_) {}
    try { document.getAnimations().forEach(a => { try { a.finish(); } catch (_) {} }); } catch (_) {}

    // Settle iframes with individual bounded wait (so a hung remote iframe never blocks whole layout)
    const iframes = Array.from(document.querySelectorAll('iframe'));
    await Promise.all(iframes.map(iframe => {
      return new Promise((resolve) => {
        setTimeout(resolve, isLayout ? 3000 : 5000);
        iframe.addEventListener('load', resolve, { once: true });
        iframe.addEventListener('error', resolve, { once: true });
        try {
          const doc = iframe.contentDocument || iframe.contentWindow?.document;
          if (doc && (doc.readyState === 'complete' || doc.readyState === 'interactive')) {
            try { doc.getAnimations().forEach(a => { try { a.finish(); } catch (_) {} }); } catch (_) {}
            const fonts = doc.fonts && doc.fonts.ready;
            if (fonts && typeof fonts.then === 'function') fonts.then(resolve, resolve); else resolve();
          }
        } catch (_) { /* cross-origin: the load event or the timer settles it */ }
      });
    }));

    // Settle images across root and iframes
    const getNestedImages = (root) => {
      let imgs = Array.from(root.querySelectorAll('img'));
      const fList = Array.from(root.querySelectorAll('iframe'));
      for (const f of fList) {
        try {
          const doc = f.contentDocument || f.contentWindow?.document;
          if (doc) {
            imgs = imgs.concat(Array.from(doc.querySelectorAll('img')));
          }
        } catch (_) {}
      }
      return imgs;
    };

    const imgs = getNestedImages(document);
    await Promise.all(imgs.map(img => {
      if (img.complete && img.naturalHeight !== 0) return Promise.resolve();
      return new Promise(resolve => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 1500);
      });
    }));

    // Settle videos
    const videos = Array.from(document.querySelectorAll('video'));
    await Promise.all(videos.map(v => {
      if (v.readyState >= 2) return Promise.resolve();
      return new Promise(resolve => {
        v.addEventListener('loadeddata', resolve, { once: true });
        v.addEventListener('canplay', resolve, { once: true });
        v.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 2000);
      });
    }));
  }, Boolean(isLayout)).catch(() => {});
}

async function renderWidgetOrHtml(html, profile, widgetType = '', options = {}) {
  await acquirePageSlot(options.signal);
  let browser = null;
  let page = null;
  const onAbort = () => {
    if (page) {
      try { page.close(); } catch (_) {}
    }
  };
  if (options.signal) {
    options.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    return await withTimeout((async () => {
      const deadline = Date.now() + 15000;
      const remainingMs = () => Math.max(500, deadline - Date.now());

      browser = await getBrowser();
      page = await browser.newPage();
      await page.setViewport({ width: profile.width, height: profile.height });

      const baseUrl = localBaseUrl();
      const staticStyle = '<style>*, *::before, *::after { animation: none !important; transition: none !important; }</style>';
      let finalHtml = html;
      if (/<head[^>]*>/i.test(finalHtml)) {
        finalHtml = finalHtml.replace(/(<head[^>]*>)/i, `$1\n<base href="${baseUrl}/">\n${staticStyle}`);
      } else if (/<html[^>]*>/i.test(finalHtml)) {
        finalHtml = finalHtml.replace(/(<html[^>]*>)/i, `$1\n<head><base href="${baseUrl}/">\n${staticStyle}</head>`);
      } else {
        finalHtml = `<!DOCTYPE html><html><head><base href="${baseUrl}/">\n${staticStyle}</head><body>${finalHtml}</body></html>`;
      }

      // For layout compositions, wait for domcontentloaded so slow/hung zones don't abort whole layout.
      // Single-widget / slide / webpage items wait for 'load'.
      const waitUntil = widgetType === 'layout' ? 'domcontentloaded' : 'load';
      await page.setContent(finalHtml, { waitUntil, timeout: Math.min(8000, remainingMs()) });

      // Wait for any async network fetches to settle if present
      if (widgetType === 'weather' || widgetType === 'rss' || widgetType === 'layout') {
        await page.waitForNetworkIdle({ idleTime: 200, timeout: Math.min(2500, remainingMs()) }).catch(() => {});
      }

      // Template-agnostic settlement: fonts, animations, images, and videos (including inside srcdoc iframes)
      await settlePage(page, widgetType === 'layout');

      const snap = await page.screenshot({ type: 'png' });
      return Buffer.from(snap);
    })(), 15000, 'Page rendering exceeded 15s deadline');
  } finally {
    if (options.signal) {
      try { options.signal.removeEventListener('abort', onAbort); } catch (_) {}
    }
    if (page) {
      try { await page.close(); } catch (_) {}
    }
    releasePageSlot();
  }
}

/*
 * A remote WEB PAGE is navigated to, not pasted into a document. #331's last round folded the
 * remote-page branch into renderWidgetOrHtml(), whose only way of loading anything is
 * page.setContent(html) — so the URL string itself became the document, and a panel pointed at
 * https://example.com/board received a white frame with that address printed on it, cached for
 * five minutes. This is the page.goto() path main had before, behind the same slot and lifecycle
 * the HTML path uses.
 *
 * The URL is vetted first. Chromium is a full client running on the server: pointed at
 * 127.0.0.1, 169.254.169.254, or a LAN address it renders whatever is there into a frame any
 * device on that workspace can pull. The media proxy and the data-source fetcher already refuse
 * those through lib/ssrf-guard; this path never did.
 */
async function renderRemotePage(url, profile, options = {}) {
  try {
    await assertSafeUrl(url);
  } catch (e) {
    if (e instanceof SsrfError) {
      throw Object.assign(new Error(`Remote page refused: ${e.message}`), { code: 'BLOCKED_URL' });
    }
    throw Object.assign(new Error(`Invalid remote URL: ${e.message}`), { code: 'FETCH_ERROR' });
  }
  await acquirePageSlot(options.signal);
  let browser = null;
  let page = null;
  const onAbort = () => {
    if (page) {
      try { page.close(); } catch (_) {}
    }
  };
  if (options.signal) {
    options.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    return await withTimeout((async () => {
      const deadline = Date.now() + 15000;
      const remainingMs = () => Math.max(500, deadline - Date.now());

      browser = await getBrowser();
      page = await browser.newPage();
      // Chromium is a full network client: page.goto follows redirects and resolves DNS itself, so
      // the one-shot assertSafeUrl above does not bind it. Vet EVERY request the page makes (the
      // navigation, each redirect hop, and every subresource) and abort any that resolves to a
      // private/reserved address. This closes the reliable variants (a public URL that 302s to an
      // internal host, and a page that pulls a LAN/loopback image or iframe). A residual DNS-rebinding
      // TOCTOU between our resolve and Chromium's remains; fully closing it needs host-resolver-rules
      // pinning at browser launch. Non-http(s) requests (data:/blob:/about:) are not network fetches
      // to an IP and pass through.
      await page.setRequestInterception(true);
      page.on('request', async (r) => {
        try {
          const proto = new URL(r.url()).protocol;
          if (proto === 'http:' || proto === 'https:') await assertSafeUrl(r.url());
          await r.continue();
        } catch (_) {
          try { await r.abort('addressunreachable'); } catch (_2) {}
        }
      });
      await page.setViewport({ width: profile.width, height: profile.height });
      await page.goto(url, { waitUntil: 'load', timeout: Math.min(10000, remainingMs()) });
      // Dashboards and boards usually paint from a fetch after load; give that a bounded chance.
      await page.waitForNetworkIdle({ idleTime: 200, timeout: Math.min(2500, remainingMs()) }).catch(() => {});
      const snap = await page.screenshot({ type: 'png' });
      return Buffer.from(snap);
    })(), 15000, 'Remote page rendering exceeded 15s deadline');
  } finally {
    if (options.signal) {
      try { options.signal.removeEventListener('abort', onAbort); } catch (_) {}
    }
    if (page) {
      try { await page.close(); } catch (_) {}
    }
    releasePageSlot();
  }
}

// ─── Player raster (routes/player-raster.js — the Roku) ─────────────────────

/*
 * Every request a raster page makes is vetted, like renderRemotePage's, with ONE difference: the
 * page is usually one of THIS server's own (a widget's /api/widgets/:id/render, which is exactly
 * what a browser player frames), so this server's origin is allowed — but for GET/HEAD only.
 *
 * ⚠️ Why the method matters. The page runs operator-authored code (templates, bundles, widget
 * scripts) inside a browser on the server, and loopback is not quite "just another client" here:
 * it is where the mesh's internal API answers. Reads are what a widget legitimately needs (its
 * /uploads images, a room display's state, a directory board's data.json); nothing it renders
 * needs to WRITE, so a page cannot use the renderer to post to this server at all.
 */
function guardRasterRequests(page, localOrigin) {
  return page.setRequestInterception(true).then(() => {
    page.on('request', async (r) => {
      try {
        const u = new URL(r.url());
        if (u.protocol === 'http:' || u.protocol === 'https:') {
          if (u.origin === localOrigin) {
            const m = String(r.method ? r.method() : 'GET').toUpperCase();
            if (m !== 'GET' && m !== 'HEAD') throw new Error('raster pages may only read from this server');
          } else {
            await assertSafeUrl(r.url());
          }
        }
        await r.continue();
      } catch (_) {
        try { await r.abort('addressunreachable'); } catch (_2) {}
      }
    });
  });
}

/**
 * Render one frame for a player that cannot run HTML.
 *
 * @param {{ path?: string, url?: string, html?: string }} source
 *   path — a page on THIS server ('/api/widgets/<id>/render?rev=…'), loaded from localBaseUrl();
 *   url  — a remote web page, SSRF-vetted before the browser sees it (BLOCKED_URL otherwise);
 *   html — a self-contained document (a flattened HTML bundle).
 * @param {{ width: number, height: number }} profile
 * @param {{ signal?: AbortSignal, timezone?: string }} [options]
 *   timezone — the screen's IANA zone, emulated so a clock or a date in the page reads the screen's
 *   time rather than the server's.
 * @returns {Promise<Buffer>} PNG
 */
async function renderPlayerFrame(source, profile, options = {}) {
  if (!source || (!source.path && !source.url && typeof source.html !== 'string')) {
    throw Object.assign(new Error('Nothing to render'), { code: 'NOTHING_TO_RENDER' });
  }
  if (source.path && !String(source.path).startsWith('/')) {
    throw Object.assign(new Error('A local path must start with /'), { code: 'INVALID_PATH' });
  }
  if (source.url) {
    try {
      await assertSafeUrl(source.url);
    } catch (e) {
      if (e instanceof SsrfError) {
        throw Object.assign(new Error(`Remote page refused: ${e.message}`), { code: 'BLOCKED_URL' });
      }
      throw Object.assign(new Error(`Invalid remote URL: ${e.message}`), { code: 'FETCH_ERROR' });
    }
  }
  const width = safeDimension(profile && profile.width, 1920);
  const height = safeDimension(profile && profile.height, 1080);

  await acquirePageSlot(options.signal);
  let page = null;
  const onAbort = () => {
    if (page) {
      try { page.close(); } catch (_) {}
    }
  };
  if (options.signal) {
    options.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    return await withTimeout((async () => {
      const deadline = Date.now() + 15000;
      const remainingMs = () => Math.max(500, deadline - Date.now());
      const localOrigin = new URL(localBaseUrl()).origin;

      const browser = await getBrowser();
      page = await browser.newPage();
      // The browser is shared and long-lived: a rev-pinned page it cached for an earlier frame
      // must never stand in for the fresh one a time bucket asked for.
      if (typeof page.setCacheEnabled === 'function') await page.setCacheEnabled(false).catch(() => {});
      await guardRasterRequests(page, localOrigin);
      if (options.timezone && typeof page.emulateTimezone === 'function') {
        // An unknown zone throws here; the frame then shows server time, which beats no frame.
        await page.emulateTimezone(options.timezone).catch(() => {});
      }
      await page.setViewport({ width, height });
      // ⚠️ Paint the zone's colour under a transparent page. Widgets are drawn to overlay a player's
      // background, so their own <body> is transparent; captured as-is that is white, and a white
      // clock vanishes into it. This colours only what the page leaves transparent.
      if (/^[0-9a-f]{6}$/.test(options.background || '')) {
        const hex = options.background;
        const color = { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1 };
        try {
          const cdp = await page.createCDPSession();
          await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color });
        } catch { /* an older Chromium without the override still renders, just on white */ }
      }
      if (source.path) {
        await page.goto(localOrigin + source.path, { waitUntil: 'load', timeout: Math.min(10000, remainingMs()) });
      } else if (source.url) {
        await page.goto(source.url, { waitUntil: 'load', timeout: Math.min(10000, remainingMs()) });
      } else {
        await page.setContent(source.html, { waitUntil: 'load', timeout: Math.min(8000, remainingMs()) });
      }
      // Widgets and boards usually paint from a fetch after load; give that a bounded chance.
      await page.waitForNetworkIdle({ idleTime: 200, timeout: Math.min(2500, remainingMs()) }).catch(() => {});
      await settlePage(page, false);
      const snap = await page.screenshot({ type: 'png' });
      return Buffer.from(snap);
    })(), 15000, 'Player frame rendering exceeded 15s deadline');
  } finally {
    if (options.signal) {
      try { options.signal.removeEventListener('abort', onAbort); } catch (_) {}
    }
    if (page) {
      try { await page.close(); } catch (_) {}
    }
    releasePageSlot();
  }
}

async function render(item, content, screenProfile, options = {}) {
  const profile = {
    width: safeDimension(screenProfile?.width, 800),
    height: safeDimension(screenProfile?.height, 480),
    rotation: [0, 90, 180, 270].includes(Number(screenProfile?.rotation)) ? Number(screenProfile.rotation) : 0,
    colorDepth: screenProfile?.colorDepth || '1bit',
    dither: screenProfile?.dither || 'floyd-steinberg',
    outputFormat: screenProfile?.outputFormat || 'x-epd-packed',
  };

  // ── Widget rendering (Clock, Weather, Slide Deck, RSS, etc.) ─────────────
  if (item && (item.widget_id || item.widget_type)) {
    const type = item.widget_type || 'clock';
    let config = {};
    if (typeof item.widget_config === 'string') {
      try { config = JSON.parse(item.widget_config); } catch (_) {}
    } else if (typeof item.widget_config === 'object' && item.widget_config !== null) {
      config = item.widget_config;
    }

    try {
      const { renderWidgetHtml, imageResolverFor, dataResolverFor, widgetIframeSandboxForWorkspace } = require('../routes/widgets');
      const { fontResolverFor } = require('../routes/fonts');
      const { db } = require('../db/database');

      let wsId;
      if (item.widget_id) {
        wsId = item.widget_workspace_id !== undefined ? item.widget_workspace_id : null;
        if (wsId == null) {
          try {
            const w = db.prepare('SELECT workspace_id FROM widgets WHERE id = ?').get(item.widget_id);
            wsId = w ? w.workspace_id : null;
          } catch (_) {}
        }
      } else {
        wsId = item.workspace_id || content?.workspace_id || profile?.workspace_id;
      }

      const html = renderWidgetHtml(type, config, {
        iframeSandbox: widgetIframeSandboxForWorkspace ? widgetIframeSandboxForWorkspace(wsId) : 'allow-scripts',
        resolveImage: imageResolverFor ? imageResolverFor({ workspace_id: wsId }) : undefined,
        resolveFont: fontResolverFor ? fontResolverFor({ workspace_id: wsId }) : undefined,
        resolveData: typeof dataResolverFor === 'function' ? dataResolverFor(wsId) : undefined,
        workspaceId: wsId,
      });
      const png = await renderWidgetOrHtml(html, profile, type, options);
      return { png };
    } catch (e) {
      if (e.code === 'BROWSER_UNAVAILABLE' || e.code === 'BROWSER_NOT_FOUND') {
        return {
          unsupported: true,
          reason: 'Widget rendering requires a browser (set CHROME_PATH). Image content works natively without a browser.',
        };
      }
      throw e;
    }
  }

  // ── Remote Web Page or Remote Image ──────────────────────────────────────
  if (content && content.remote_url) {
    // Only probe as an image when the stored type is an image or unknown. A known non-image type
    // (a dashboard/web page) skips the guarded image GET and goes straight to the browser render —
    // both cheaper and cleaner than fetching an HTML page just to discover it is not an image.
    const maybeImage = !content.mime_type || looksLikeImage(content.remote_url, content.mime_type);
    const png = maybeImage ? await renderRemoteImage(content, profile) : null;
    if (png) return { png };

    try {
      const p = await renderRemotePage(content.remote_url, profile, options);
      return { png: p };
    } catch (e) {
      if (e.code === 'BROWSER_UNAVAILABLE' || e.code === 'BROWSER_NOT_FOUND') {
        return {
          unsupported: true,
          reason: 'Rendering remote web pages requires a browser (set CHROME_PATH).',
        };
      }
      throw e;
    }
  }

  // ── Local Image / File (Native Jimp Execution) ──────────────────────────
  if (content && (content.filepath || content.thumbnail_path)) {
    const fileToLoad = (content.filepath && looksLikeImage(content.filepath, content.mime_type))
      ? content.filepath
      : (content.thumbnail_path || content.filepath);

    if (fileToLoad) {
      const safe = await localImageFile(content, fileToLoad);
      try {
        const fileBuffer = fs.readFileSync(safe);
        const img = await Jimp.fromBuffer(fileBuffer);
        img.cover({ w: profile.width, h: profile.height });
        const png = await img.getBuffer('image/png');
        return { png };
      } catch (e) {
        if (e.code === 'INVALID_PATH' || e.code === 'NOT_FOUND') throw e;
        throw Object.assign(
          new Error(`Failed to decode image with Jimp: ${e.message}`),
          { code: 'DECODE_ERROR' }
        );
      }
    }
  }

  return { unsupported: true, reason: 'No renderable content' };
}

function escapeHtmlAttr(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isLayoutImageOnly(zoneEntries) {
  if (!Array.isArray(zoneEntries) || !zoneEntries.length) return false;
  for (const entry of zoneEntries) {
    if (!entry || !entry.item) continue;
    const c = entry.content;
    if (!c) {
      if (entry.item.widget_type || entry.item.widget_id) return false;
      continue;
    }
    if (c.remote_url) {
      if (!looksLikeImage(c.remote_url, c.mime_type)) return false;
    } else if (c.filepath) {
      if (!looksLikeImage(c.filepath, c.mime_type) && !c.thumbnail_path) return false;
    } else {
      return false;
    }
  }
  return true;
}

async function renderLayoutNative(layout, zoneEntries, screenProfile, options = {}) {
  const profile = {
    width: safeDimension(screenProfile?.width, 800),
    height: safeDimension(screenProfile?.height, 480),
  };

  const sorted = [...zoneEntries].sort((a, b) => {
    const za = Number.isFinite(Number(a.zone?.z_index)) ? Number(a.zone.z_index) : 0;
    const zb = Number.isFinite(Number(b.zone?.z_index)) ? Number(b.zone.z_index) : 0;
    return za - zb;
  });

  const bgColorHex = safeHexColor(options?.device?.background_color || options?.backgroundColor, '#000000');
  const layoutBg = parseColorToRgba(bgColorHex, 0x000000FF);
  const canvas = new Jimp({ width: profile.width, height: profile.height, color: layoutBg });

  for (const entry of sorted) {
    const { zone, content } = entry;
    if (!zone || !content) continue;

    const x = Number.isFinite(Number(zone.x_percent)) ? Math.max(0, Math.min(100, Number(zone.x_percent))) : 0;
    const y = Number.isFinite(Number(zone.y_percent)) ? Math.max(0, Math.min(100, Number(zone.y_percent))) : 0;
    const w = Number.isFinite(Number(zone.width_percent)) ? Math.max(0, Math.min(100, Number(zone.width_percent))) : 100;
    const h = Number.isFinite(Number(zone.height_percent)) ? Math.max(0, Math.min(100, Number(zone.height_percent))) : 100;

    const pixelX = Math.round((x / 100) * profile.width);
    const pixelY = Math.round((y / 100) * profile.height);
    const pixelW = Math.max(1, Math.round((w / 100) * profile.width));
    const pixelH = Math.max(1, Math.round((h / 100) * profile.height));

    if (zone.background_color) {
      const hex = safeHexColor(zone.background_color, null);
      if (hex) {
        const zoneBg = parseColorToRgba(hex, null);
        if (zoneBg !== null) {
          const bgImg = new Jimp({ width: pixelW, height: pixelH, color: zoneBg });
          canvas.composite(bgImg, pixelX, pixelY);
        }
      }
    }

    let img = null;
    if (content.remote_url) {
      let res;
      try {
        // guardedRequest (not a bare fetch): vet + socket-pin + redirect re-vet, so a zone's
        // remote_url cannot make the server fetch an internal/metadata address. This path had no
        // SSRF vetting at all before.
        res = await guardedRequest(content.remote_url, {
          responseType: 'buffer',
          maxBytes: REMOTE_IMAGE_MAX_BYTES,
          timeoutMs: 10000,
          headers: { 'user-agent': 'ScreenTinker-EmbeddedRenderer/1.0' },
        });
        const contentType = (res.headers && res.headers['content-type']) || '';
        if (!looksLikeImage(content.remote_url, contentType)) {
          throw Object.assign(new Error('Remote content is not an image'), { code: 'FETCH_ERROR' });
        }
      } catch (fetchErr) {
        console.warn(`[embedded] native layout remote fetch error for zone ${zone.id || 'unknown'}: ${fetchErr.message}`);
        continue;
      }
      const buf = res.buffer;
      img = await Jimp.fromBuffer(buf);
    } else {
      const fileToLoad = (content.filepath && looksLikeImage(content.filepath, content.mime_type))
        ? content.filepath
        : (content.thumbnail_path || content.filepath);
      if (fileToLoad) {
        let buf;
        try {
          const safe = await localImageFile(content, fileToLoad);
          buf = fs.readFileSync(safe);
        } catch (fileErr) {
          console.warn(`[embedded] native layout file read error for zone ${zone.id || 'unknown'}: ${fileErr.message}`);
          continue;
        }
        img = await Jimp.fromBuffer(buf);
      }
    }

    if (img) {
      const fitMode = safeFitMode((entry.item && entry.item.fit_mode) || zone.fit_mode);
      if (fitMode === 'cover') {
        img.cover({ w: pixelW, h: pixelH });
      } else if (fitMode === 'fill') {
        img.resize({ w: pixelW, h: pixelH });
      } else {
        img.contain({ w: pixelW, h: pixelH });
      }
      canvas.composite(img, pixelX, pixelY);
    }
  }

  const png = await canvas.getBuffer('image/png');
  return { png };
}

async function renderLayout(layout, zoneEntries, screenProfile, options = {}) {
  const profile = {
    width: safeDimension(screenProfile?.width, 800),
    height: safeDimension(screenProfile?.height, 480),
    rotation: [0, 90, 180, 270].includes(Number(screenProfile?.rotation)) ? Number(screenProfile.rotation) : 0,
    colorDepth: screenProfile?.colorDepth || '1bit',
    dither: screenProfile?.dither || 'floyd-steinberg',
    outputFormat: screenProfile?.outputFormat || 'x-epd-packed',
  };

  if (isLayoutImageOnly(zoneEntries)) {
    try {
      return await renderLayoutNative(layout, zoneEntries, profile, options);
    } catch (e) {
      console.warn(`[embedded] native image layout render failed, falling back to browser: ${e.message}`);
    }
  }

  const { renderWidgetHtml, imageResolverFor, dataResolverFor, widgetIframeSandboxForWorkspace } = require('../routes/widgets');
  const { fontResolverFor } = require('../routes/fonts');
  const { db } = require('../db/database');

  const zoneHtmls = [];
  for (const entry of zoneEntries) {
    const { zone, item, content } = entry;
    if (!zone) continue;

    const x = Number.isFinite(Number(zone.x_percent)) ? Math.max(0, Math.min(100, Number(zone.x_percent))) : 0;
    const y = Number.isFinite(Number(zone.y_percent)) ? Math.max(0, Math.min(100, Number(zone.y_percent))) : 0;
    const w = Number.isFinite(Number(zone.width_percent)) ? Math.max(0, Math.min(100, Number(zone.width_percent))) : 100;
    const h = Number.isFinite(Number(zone.height_percent)) ? Math.max(0, Math.min(100, Number(zone.height_percent))) : 100;
    const zIndex = Number.isFinite(Number(zone.z_index)) ? Math.floor(Number(zone.z_index)) : 0;
    const fitMode = safeFitMode((item && item.fit_mode) || zone.fit_mode);
    const safeZoneBg = safeHexColor(zone.background_color, null);
    const zoneBg = safeZoneBg ? `background-color: ${safeZoneBg};` : '';

    let innerHtml = '<div style="width:100%;height:100%;background:transparent;"></div>';

    if (item && (item.widget_id || item.widget_type)) {
      const type = item.widget_type || 'clock';
      let config = {};
      if (typeof item.widget_config === 'string') {
        try { config = JSON.parse(item.widget_config); } catch (_) {}
      } else if (typeof item.widget_config === 'object' && item.widget_config !== null) {
        config = item.widget_config;
      }

      let wsId;
      if (item.widget_id) {
        wsId = item.widget_workspace_id !== undefined ? item.widget_workspace_id : null;
        if (wsId == null) {
          try {
            const row = db.prepare('SELECT workspace_id FROM widgets WHERE id = ?').get(item.widget_id);
            wsId = row ? row.workspace_id : null;
          } catch (_) {}
        }
      } else {
        wsId = item.workspace_id || layout?.workspace_id || profile?.workspace_id;
      }

      try {
        const widgetHtml = renderWidgetHtml(type, config, {
          iframeSandbox: widgetIframeSandboxForWorkspace ? widgetIframeSandboxForWorkspace(wsId) : 'allow-scripts',
          resolveImage: imageResolverFor ? imageResolverFor({ workspace_id: wsId }) : undefined,
          resolveFont: fontResolverFor ? fontResolverFor({ workspace_id: wsId }) : undefined,
          resolveData: typeof dataResolverFor === 'function' ? dataResolverFor(wsId) : undefined,
          workspaceId: wsId,
        });

        innerHtml = `<iframe srcdoc="${escapeHtmlAttr(widgetHtml)}" style="width:100%;height:100%;border:none;overflow:hidden;display:block;" scrolling="no"></iframe>`;
      } catch (zoneErr) {
        console.warn(`[embedded] zone widget render error for ${type}:`, zoneErr.message);
        innerHtml = `<div style="width:100%;height:100%;background:transparent;"></div>`;
      }
    } else if (content && content.remote_url) {
      if (looksLikeImage(content.remote_url, content.mime_type)) {
        innerHtml = `<img src="${escapeHtmlAttr(content.remote_url)}" style="width:100%;height:100%;object-fit:${fitMode};display:block;" />`;
      } else {
        innerHtml = `<iframe src="${escapeHtmlAttr(content.remote_url)}" style="width:100%;height:100%;border:none;overflow:hidden;display:block;" scrolling="no"></iframe>`;
      }
    } else if (content && content.filepath) {
      if (looksLikeImage(content.filepath, content.mime_type)) {
        const safeFilename = path.basename(content.filepath);
        innerHtml = `<img src="/uploads/content/${encodeURIComponent(safeFilename)}" style="width:100%;height:100%;object-fit:${fitMode};display:block;" />`;
      } else if (content.thumbnail_path) {
        const safeThumb = path.basename(content.thumbnail_path);
        innerHtml = `<img src="/uploads/content/${encodeURIComponent(safeThumb)}" style="width:100%;height:100%;object-fit:${fitMode};display:block;" />`;
      } else {
        const safeFilename = path.basename(content.filepath);
        innerHtml = `<video src="/uploads/content/${encodeURIComponent(safeFilename)}" style="width:100%;height:100%;object-fit:${fitMode};display:block;" autoplay muted playsinline preload="auto"></video>`;
      }
    }

    zoneHtmls.push(`
      <div class="zone-slot" style="position:absolute;left:${x}%;top:${y}%;width:${w}%;height:${h}%;z-index:${zIndex};overflow:hidden;${zoneBg}">
        ${innerHtml}
      </div>
    `);
  }

  const baseUrl = localBaseUrl();
  const compositeBg = safeHexColor(options?.device?.background_color || options?.backgroundColor, '#000000');
  const compositeHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<base href="${baseUrl}/">
<style>
  html, body {
    margin: 0; padding: 0;
    width: ${profile.width}px; height: ${profile.height}px;
    background: ${compositeBg}; overflow: hidden; position: relative;
    box-sizing: border-box;
  }
  *, *:before, *:after { box-sizing: inherit; }
  .zone-slot { position: absolute; overflow: hidden; }
  .zone-slot iframe, .zone-slot img, .zone-slot video { width: 100%; height: 100%; display: block; border: 0; }
</style>
</head>
<body>
  ${zoneHtmls.join('\n')}
</body>
</html>`;

  try {
    const png = await renderWidgetOrHtml(compositeHtml, profile, 'layout', options);
    return { png };
  } catch (e) {
    if (e.code === 'BROWSER_UNAVAILABLE' || e.code === 'BROWSER_NOT_FOUND') {
      return {
        unsupported: true,
        reason: 'Multi-zone layout rendering with widgets or web pages requires a browser (set CHROME_PATH).',
      };
    }
    throw e;
  }
}

module.exports = {
  render,
  renderRemotePage,
  renderPlayerFrame,
  renderLayout,
  renderLayoutNative,
  closeBrowser,
  getBrowser,
  looksLikeImage,
  isLayoutImageOnly,
  isBrowserAvailable,
  safeDimension,
  safeLocalImagePath,
  parseColorToRgba,
  withTimeout,
};
