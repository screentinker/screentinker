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
const { Jimp } = require('jimp');
const config = require('../config');

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
  if (!Number.isFinite(n) || n <= 0 || n > 100000) return fallback;
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

function looksLikeImage(url, contentType) {
  if (contentType) {
    const base = contentType.split(';')[0].trim().toLowerCase();
    if (IMAGE_MIMES.has(base)) return true;
  }
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return !!EXT_MIME[ext];
  } catch {
    return false;
  }
}

// ─── Optional Chrome / Chromium Path Detection ───────────────────────────────
function findChromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.CHROME_BIN,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {}
  }
  return null;
}

let browserInstance = null;

function getPuppeteer() {
  try {
    return require('puppeteer-core');
  } catch (_) {
    return null;
  }
}

async function getBrowser() {
  if (browserInstance && browserInstance.connected) {
    return browserInstance;
  }

  const puppeteer = getPuppeteer();
  if (!puppeteer) {
    const err = new Error('puppeteer-core is not installed. Browser rendering is unavailable.');
    err.code = 'BROWSER_UNAVAILABLE';
    throw err;
  }

  const chromePath = findChromePath();
  if (!chromePath) {
    const err = new Error('Chrome/Chromium executable not found. Set CHROME_PATH environment variable.');
    err.code = 'BROWSER_NOT_FOUND';
    throw err;
  }

  browserInstance = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--hide-scrollbars',
      '--ignore-certificate-errors',
    ],
  });

  browserInstance.on('disconnected', () => {
    browserInstance = null;
  });

  return browserInstance;
}

async function closeBrowser() {
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch (_) {}
    browserInstance = null;
  }
}

// Clean lifecycle hooks to prevent hanging processes
process.on('exit', () => {
  if (browserInstance) {
    try { browserInstance.process()?.kill(); } catch (_) {}
  }
});
process.on('SIGTERM', () => { closeBrowser(); });
process.on('SIGINT', () => { closeBrowser(); });

// ─── Native Image Renderers (Jimp) ───────────────────────────────────────────

async function renderLocalImage(content, profile) {
  // Guard against a `filepath` escaping the content directory (mirrors the
  // same path.basename() + startsWith() check used when rendering layout zones).
  const base = path.resolve(contentDir());
  const safe = path.resolve(base, path.basename(String(content.filepath || '')));
  if (!safe.startsWith(base + path.sep) && safe !== base) {
    throw Object.assign(new Error('Invalid content file path'), { code: 'INVALID_PATH' });
  }
  if (!fs.existsSync(safe)) {
    throw Object.assign(new Error('Content file not found on disk'), { code: 'NOT_FOUND' });
  }
  const img = await Jimp.fromBuffer(fs.readFileSync(safe));
  img.cover({ w: profile.width, h: profile.height });
  return img.getBuffer('image/png');
}

async function renderRemoteImage(content, profile) {
  const url = content.remote_url;
  if (!url) return null;

  let response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'ScreenTinker-EmbeddedRenderer/1.0' },
    });
  } catch (e) {
    throw Object.assign(
      new Error(`Failed to fetch remote content: ${e.message}`),
      { code: 'FETCH_ERROR' }
    );
  }

  if (!response.ok) {
    throw Object.assign(
      new Error(`Remote content returned HTTP ${response.status}`),
      { code: 'FETCH_ERROR' }
    );
  }

  const contentType = response.headers.get('content-type') || '';
  if (!looksLikeImage(url, contentType)) {
    return null;
  }

  const buf = Buffer.from(await response.arrayBuffer());
  const img = await Jimp.fromBuffer(buf);
  img.cover({ w: profile.width, h: profile.height });
  return img.getBuffer('image/png');
}

function localBaseUrl() {
  return global.__localApiOrigin || process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || config.port || 3001}`;
}

async function renderWidgetOrHtml(html, profile, widgetType = '') {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: profile.width, height: profile.height });

    const baseUrl = localBaseUrl();
    const staticStyle = '<style>*, *::before, *::after { animation: none !important; transition: none !important; }</style>';
    let finalHtml = html;
    if (/<head>/i.test(finalHtml)) {
      finalHtml = finalHtml.replace(/<head>/i, `<head><base href="${baseUrl}/">\n${staticStyle}`);
    } else {
      finalHtml = `<base href="${baseUrl}/">\n${staticStyle}\n` + finalHtml;
    }

    // Single-widget / slide / webpage items wait for 'load'.
    // Do NOT swallow timeouts: let TimeoutError propagate so callers advance without caching broken frames.
    await page.setContent(finalHtml, { waitUntil: 'load', timeout: 8000 });

    // Wait for any async network fetches (e.g. weather, RSS, remote data) to settle
    await page.waitForNetworkIdle({ idleTime: 200, timeout: 2500 }).catch(() => {});

    // Template-agnostic settlement: fonts, animations, and all images (including inside srcdoc iframes)
    await page.evaluate(async () => {
      try { if (document.fonts?.ready) await document.fonts.ready; } catch (_) {}
      try { document.getAnimations().forEach(a => { try { a.finish(); } catch (_) {} }); } catch (_) {}

      const getNestedImages = (root) => {
        let imgs = Array.from(root.querySelectorAll('img'));
        const iframes = Array.from(root.querySelectorAll('iframe'));
        for (const iframe of iframes) {
          try {
            const doc = iframe.contentDocument || iframe.contentWindow?.document;
            if (doc) {
              imgs = imgs.concat(Array.from(doc.querySelectorAll('img')));
              try { if (doc.fonts?.ready) doc.fonts.ready; } catch (_) {}
              try { doc.getAnimations().forEach(a => { try { a.finish(); } catch (_) {} }); } catch (_) {}
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
    }).catch(() => {});

    const snap = await page.screenshot({ type: 'png' });
    return Buffer.from(snap);
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Render the current playlist item to a PNG Buffer.
 *
 * @param {object} item     Playlist item row (joined by the route).
 * @param {object} content  Content row (joined by the route).
 * @param {object} profile  Validated screen_profile from embedded-profiles.js.
 * @returns {Promise<{ png: Buffer } | { unsupported: true, reason: string }>}
 */
async function render(item, content, profile) {
  // ── Widget / Slide Path ──────────────────────────────────────────────────
  if (item && (item.widget_id || item.widget_type)) {
    const type = item.widget_type || 'clock';
    let config = {};
    if (typeof item.widget_config === 'string') {
      try { config = JSON.parse(item.widget_config); } catch (_) {}
    } else if (typeof item.widget_config === 'object' && item.widget_config !== null) {
      config = item.widget_config;
    }

    try {
      const { renderWidgetHtml, imageResolverFor, dataResolverFor } = require('../routes/widgets');
      const { fontResolverFor } = require('../routes/fonts');
      const { db } = require('../db/database');

      let wsId = item.workspace_id || content?.workspace_id || profile?.workspace_id;
      if (!wsId && item.widget_id) {
        try {
          const w = db.prepare('SELECT workspace_id FROM widgets WHERE id = ?').get(item.widget_id);
          if (w) wsId = w.workspace_id;
        } catch (_) {}
      }

      const html = renderWidgetHtml(type, config, {
        resolveImage: imageResolverFor ? imageResolverFor({ workspace_id: wsId }) : undefined,
        resolveFont: fontResolverFor ? fontResolverFor({ workspace_id: wsId }) : undefined,
        resolveData: typeof dataResolverFor === 'function' ? dataResolverFor(wsId) : undefined,
      });
      const png = await renderWidgetOrHtml(html, profile, type);
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
    const png = await renderRemoteImage(content, profile);
    if (png) return { png };

    // Remote web page fallback via optional browser
    try {
      const browser = await getBrowser();
      const page = await browser.newPage();
      try {
        await page.setViewport({ width: profile.width, height: profile.height });
        await page.goto(content.remote_url, { waitUntil: 'load', timeout: 10000 });
        const snap = await page.screenshot({ type: 'png' });
        return { png: Buffer.from(snap) };
      } finally {
        await page.close().catch(() => {});
      }
    } catch (e) {
      if (e.code === 'BROWSER_UNAVAILABLE' || e.code === 'BROWSER_NOT_FOUND') {
        return {
          unsupported: true,
          reason: 'Web page rendering requires a browser (set CHROME_PATH). Direct images work natively.',
        };
      }
      throw e;
    }
  }

  // ── Local Image (Primary native path) ────────────────────────────────────
  if (content && content.filepath) {
    const png = await renderLocalImage(content, profile);
    return { png };
  }

  return { unsupported: true, reason: 'No renderable source found for this content item.' };
}

function escapeHtmlAttr(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isLayoutImageOnly(zoneEntries) {
  for (const entry of zoneEntries) {
    const { item, content } = entry;
    if (!item && !content) continue;
    if (item && (item.widget_id || item.widget_type)) return false;
    if (content) {
      if (content.remote_url) {
        if (!looksLikeImage(content.remote_url, content.mime_type)) return false;
      } else if (content.filepath) {
        if (!looksLikeImage(content.filepath, content.mime_type)) return false;
      }
    }
  }
  return true;
}

/**
 * Pure Jimp native composite for multi-zone layouts containing only images.
 * Zero browser dependency — runs anywhere in production.
 */
async function renderLayoutNative(layout, zoneEntries, profile) {
  const canvas = new Jimp({ width: profile.width, height: profile.height, color: 0x000000FF });

  const sorted = [...zoneEntries].sort((a, b) => {
    const za = Number.isFinite(Number(a.zone?.z_index)) ? Number(a.zone.z_index) : 0;
    const zb = Number.isFinite(Number(b.zone?.z_index)) ? Number(b.zone.z_index) : 0;
    return za - zb;
  });

  for (const entry of sorted) {
    const { zone, content } = entry;
    if (!content) continue;

    const x = Number.isFinite(Number(zone.x_percent)) ? Math.max(0, Math.min(100, Number(zone.x_percent))) : 0;
    const y = Number.isFinite(Number(zone.y_percent)) ? Math.max(0, Math.min(100, Number(zone.y_percent))) : 0;
    const w = Number.isFinite(Number(zone.width_percent)) ? Math.max(0, Math.min(100, Number(zone.width_percent))) : 100;
    const h = Number.isFinite(Number(zone.height_percent)) ? Math.max(0, Math.min(100, Number(zone.height_percent))) : 100;

    const pixelX = Math.round((x / 100) * profile.width);
    const pixelY = Math.round((y / 100) * profile.height);
    const pixelW = Math.max(1, Math.round((w / 100) * profile.width));
    const pixelH = Math.max(1, Math.round((h / 100) * profile.height));

    let img = null;
    const fileToLoad = content.filepath || content.thumbnail_path;
    if (fileToLoad) {
      const base = path.resolve(contentDir());
      const safe = path.resolve(base, path.basename(String(fileToLoad)));
      if (safe.startsWith(base + path.sep) && fs.existsSync(safe)) {
        try {
          img = await Jimp.fromBuffer(fs.readFileSync(safe));
        } catch (_) {}
      }
    } else if (content.remote_url) {
      try {
        const res = await fetch(content.remote_url, { signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          img = await Jimp.fromBuffer(buf);
        }
      } catch (_) {}
    }

    if (img) {
      img.cover({ w: pixelW, h: pixelH });
      canvas.composite(img, pixelX, pixelY);
    }
  }

  const png = await canvas.getBuffer('image/png');
  return { png };
}

/**
 * Render a multi-zone layout composition into a composite PNG Buffer.
 *
 * @param {object} layout - Layout record
 * @param {Array<{ zone: object, item: object|null, content: object|null }>} zoneEntries
 * @param {object} profile - screen_profile
 * @returns {Promise<{ png: Buffer } | { unsupported: true, reason: string }>}
 */
async function renderLayout(layout, zoneEntries, profile) {
  // Safely coerce numeric dimensions we later interpolate into CSS/viewport
  // (width/height come from the screen_profile row). Default on unparseable input
  // so a malformed profile cannot inject into the composite HTML.
  const width = safeDimension(profile.width, 800);
  const height = safeDimension(profile.height, 480);
  profile = { ...profile, width, height };

  // If the layout consists entirely of images, composite natively via Jimp
  // with zero browser dependency.
  if (isLayoutImageOnly(zoneEntries)) {
    return renderLayoutNative(layout, zoneEntries, profile);
  }

  const { renderWidgetHtml, imageResolverFor, dataResolverFor } = require('../routes/widgets');
  const { fontResolverFor } = require('../routes/fonts');
  const { db } = require('../db/database');

  const zoneHtmls = [];

  for (const entry of zoneEntries) {
    const { zone, item, content } = entry;
    const x = Number.isFinite(Number(zone.x_percent)) ? Math.max(0, Math.min(100, Number(zone.x_percent))) : 0;
    const y = Number.isFinite(Number(zone.y_percent)) ? Math.max(0, Math.min(100, Number(zone.y_percent))) : 0;
    const w = Number.isFinite(Number(zone.width_percent)) ? Math.max(0, Math.min(100, Number(zone.width_percent))) : 100;
    const h = Number.isFinite(Number(zone.height_percent)) ? Math.max(0, Math.min(100, Number(zone.height_percent))) : 100;
    const zIndex = Number.isFinite(Number(zone.z_index)) ? Math.floor(Number(zone.z_index)) : 0;

    let innerHtml = '<div style="width:100%;height:100%;background:transparent;"></div>';

    if (item && (item.widget_id || item.widget_type)) {
      const type = item.widget_type || 'clock';
      let config = {};
      if (typeof item.widget_config === 'string') {
        try { config = JSON.parse(item.widget_config); } catch (_) {}
      } else if (typeof item.widget_config === 'object' && item.widget_config !== null) {
        config = item.widget_config;
      }

      let wsId = item.workspace_id || layout?.workspace_id || profile?.workspace_id;
      if (!wsId && item.widget_id) {
        try {
          const row = db.prepare('SELECT workspace_id FROM widgets WHERE id = ?').get(item.widget_id);
          if (row) wsId = row.workspace_id;
        } catch (_) {}
      }

      const widgetHtml = renderWidgetHtml(type, config, {
        resolveImage: imageResolverFor ? imageResolverFor({ workspace_id: wsId }) : undefined,
        resolveFont: fontResolverFor ? fontResolverFor({ workspace_id: wsId }) : undefined,
        resolveData: typeof dataResolverFor === 'function' ? dataResolverFor(wsId) : undefined,
      });

      innerHtml = `<iframe srcdoc="${escapeHtmlAttr(widgetHtml)}" style="width:100%;height:100%;border:none;overflow:hidden;display:block;" scrolling="no"></iframe>`;
    } else if (content && content.remote_url) {
      if (looksLikeImage(content.remote_url, content.mime_type)) {
        innerHtml = `<img src="${escapeHtmlAttr(content.remote_url)}" style="width:100%;height:100%;object-fit:cover;display:block;" />`;
      } else {
        innerHtml = `<iframe src="${escapeHtmlAttr(content.remote_url)}" style="width:100%;height:100%;border:none;overflow:hidden;display:block;" scrolling="no"></iframe>`;
      }
    } else if (content && content.filepath) {
      if (looksLikeImage(content.filepath, content.mime_type)) {
        const safeFilename = path.basename(content.filepath);
        innerHtml = `<img src="/uploads/content/${encodeURIComponent(safeFilename)}" style="width:100%;height:100%;object-fit:cover;display:block;" />`;
      } else if (content.thumbnail_path) {
        const safeThumb = path.basename(content.thumbnail_path);
        innerHtml = `<img src="/uploads/content/${encodeURIComponent(safeThumb)}" style="width:100%;height:100%;object-fit:cover;display:block;" />`;
      } else {
        const safeFilename = path.basename(content.filepath);
        innerHtml = `<video src="/uploads/content/${encodeURIComponent(safeFilename)}" style="width:100%;height:100%;object-fit:cover;display:block;" muted playsinline></video>`;
      }
    }

    zoneHtmls.push(`
      <div class="zone-slot" style="position:absolute;left:${x}%;top:${y}%;width:${w}%;height:${h}%;z-index:${zIndex};overflow:hidden;">
        ${innerHtml}
      </div>
    `);
  }

  const baseUrl = localBaseUrl();
  const compositeHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<base href="${baseUrl}/">
<style>
  html, body {
    margin: 0; padding: 0;
    width: ${profile.width}px; height: ${profile.height}px;
    background: #000000; overflow: hidden; position: relative;
    box-sizing: border-box;
  }
  *, *:before, *:after { box-sizing: inherit; }
  .zone-slot { position: absolute; overflow: hidden; }
  .zone-slot iframe, .zone-slot img { width: 100%; height: 100%; display: block; border: 0; }
</style>
</head>
<body>
  ${zoneHtmls.join('\n')}
</body>
</html>`;

  try {
    const png = await renderWidgetOrHtml(compositeHtml, profile, 'layout');
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

module.exports = { render, renderLayout, renderLayoutNative, closeBrowser, getBrowser };

