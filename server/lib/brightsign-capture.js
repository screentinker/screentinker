'use strict';

/*
 * Framebuffer capture from the SERVER's own Node process, for a BrightSign running
 * server-on-a-player.
 *
 * ⚠️ WHY THE EXISTING PATHS DO NOT COVER THIS BOX.
 *
 * Every other player is told to capture over its device socket and the page captures itself. A
 * BrightSign page cannot: with hwz enabled the video decodes onto a hardware plane the DOM cannot
 * read, so drawImage() returns a frame with the content missing and throws nothing. st-bridge.js
 * therefore uses BrightSign's own `@brightsign/screenshot`, which composites both planes — and that
 * needs the Node `require` a widget only has when it was created with nodejs_enabled.
 *
 * The server-on-a-player build creates its widget WITHOUT nodejs_enabled (deliberately — see
 * brightsign/server/autorun.brs). So on that box the page-side capture cannot work, and the
 * host-collected fallback in lib/brightsign-snapshot-queue.js has nothing collecting it either:
 * brightsign/server/autorun.brs contains no snapshot code at all, unlike the player autorun which
 * has the full implementation. Measured: screenshots simply do not work on that shape, by either
 * route.
 *
 * ⚠️ BUT THE SERVER THERE IS REAL NODE. It runs under roNodeJs, so `@brightsign/screenshot` is an
 * ordinary import for it — no DWS, no digest auth, no credentials to discover, no page-to-host
 * messaging (which is dead after load on this platform anyway). The same module the widget uses,
 * required from the process that actually has a working `require`.
 *
 * Everything here degrades to null rather than throwing: this is loaded by a server that must keep
 * serving screens on hardware where none of it exists.
 */

/** Volumes to write the capture into, RAM first. */
/** How long to wait for the capture file to appear, and how often to look. */
const CAPTURE_TIMEOUT_MS = 8000;
const CAPTURE_POLL_MS = 120;

const CANDIDATE_DIRS = ['/storage/tmp', '/tmp', '/storage/ssd', '/storage/usb1', '/storage/sd', '/storage/flash'];

function tryRequire(name) {
  try { return require(name); } catch (e) { return null; }
}

/*
 * ⚠️ SAYS SO ONCE, OUT LOUD. The first version logged nothing when the module was absent, so a
 * capture that never happened was indistinguishable from one that failed — and working out which
 * cost a patch-and-reboot cycle on real hardware. One line at first use is the whole difference.
 */
let announced = false;

/** Is this process running somewhere the capture API actually exists? */
function available() {
  const ok = !!(tryRequire('@brightsign/screenshot') && tryRequire('fs'));
  if (!announced) {
    announced = true;
    console.log('[bs-capture] @brightsign/screenshot ' + (ok ? 'available in this process' : 'NOT available in this process'));
  }
  return ok;
}

/**
 * Is this address the same machine?
 *
 * ⚠️ THE ONLY HONEST TEST FOR "this device is on this board". We capture OUR framebuffer, so
 * sending it for a device elsewhere would be a picture of the wrong screen, convincingly labelled.
 * The device's self-reported platform cannot decide this — a BrightSign reports "Chrome 148",
 * because the player is a Chromium widget — and that mistake is exactly why the pre-existing
 * BrightSign screenshot branch never once ran on real hardware.
 */
function isLoopback(ip) {
  const v = String(ip || '').trim().toLowerCase();
  return v === '127.0.0.1' || v === '::1' || v === '::ffff:127.0.0.1' || v === 'localhost';
}

/**
 * Where to write. RAM first, deliberately: the remote-control view drives a capture roughly once a
 * second, and a screenshot per second written to boot flash is a wear-out mechanism with no upside —
 * the file is read back and deleted immediately, so it never needs to be durable. The directory
 * must already exist or the capture fails, so each candidate is checked rather than assumed.
 */
function pickDir(fs) {
  for (const d of CANDIDATE_DIRS) {
    try { if (fs.existsSync(d)) return d; } catch (e) { /* keep looking */ }
  }
  return null;
}

/*
 * ⚠️ A UNIQUE FILENAME PER CAPTURE, NOT A FIXED ONE.
 *
 * st-bridge.js writes to a fixed `st-capture.jpg`. Two captures in flight — trivially reachable
 * from the remote-control view at one per second, or from two operators watching the same screen —
 * have one unlinking and rewriting the file the other is about to read. The reader either gets
 * ENOENT or, worse, the OTHER request's frame, which is a picture of the right screen at the wrong
 * moment and looks entirely plausible. A per-call name removes the race rather than narrowing it.
 */
let seq = 0;
function captureName(nowMs) {
  seq = (seq + 1) % 100000;
  return `st-capture-${nowMs}-${seq}.jpg`;
}

/**
 * Capture the composited screen and return it as base64 JPEG, or null if this platform cannot.
 *
 * @param {object} opts { width, height, quality }
 * @returns {Promise<string|null>}
 */
function capture(opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const ScreenshotClass = tryRequire('@brightsign/screenshot');
    const fs = tryRequire('fs');
    if (!ScreenshotClass || !fs) return resolve(null);

    const dir = pickDir(fs);
    if (!dir) return resolve(null);

    const file = `${dir}/${captureName(Date.now())}`;
    let shot0;
    try { shot0 = new ScreenshotClass(); } catch (e) { return resolve(null); }
    const params = {
      destinationFileName: file,
      fileName: file,                 // deprecated alias, still honoured on older firmware
      fileType: 'JPEG',
      width: o.width || 960,
      height: o.height || 540,
      quality: o.quality || 70,
      rotation: 0,
    };

    /*
     * ⚠️ ALWAYS CLEANS UP. A capture that fails part-way still leaves a file behind, and this path
     * runs once a second while somebody watches a screen. On a RAM volume that is a slow leak
     * toward a full /tmp, which breaks far more than screenshots.
     */
    const done = (value) => {
      try { fs.unlinkSync(file); } catch (e) { /* never written, or already gone */ }
      resolve(value);
    };

    /*
     * ⚠️ THE METHOD IS syncCapture / asyncCapture — THERE IS NO `capture`.
     *
     * Enumerated on a live XT245 (OS 10.0.16): the instance offers callback, syncCapture,
     * asyncCapture, addEventListener, removeEventListener and toJSON, while its prototype carries
     * only `constructor`. The first version of this file called `shot.capture(params)` and failed
     * on hardware with "shot.capture is not a function" — st-bridge.js had it right all along, and
     * this is simply the same resolution as its page-side path.
     *
     * asyncCapture first: it does not block the event loop of a server that is also feeding screens.
     * syncCapture next (it interrupts on-screen operations, which is why it is not the default),
     * and `capture` last in case a future firmware adds that name.
     */
    const method = typeof shot0.asyncCapture === 'function' ? 'asyncCapture'
      : typeof shot0.syncCapture === 'function' ? 'syncCapture'
      : typeof shot0.capture === 'function' ? 'capture'
      : null;
    if (!method) return done(null);

    /*
     * ⚠️ POLL FOR THE FILE; DO NOT TRUST THE RETURN VALUE. sync and async differ in what they hand
     * back, and the documented contract is "a file appears", not "a promise settles" — st-bridge.js
     * reached the same conclusion on the page side. Awaiting the return happened to work in a probe
     * here, which is exactly the kind of accident that turns into an intermittent empty screenshot
     * on somebody else's firmware.
     */
    try {
      shot0[method](params);
    } catch (e) {
      return done(null);
    }

    const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
    const tick = () => {
      let st = null;
      try { st = fs.statSync(file); } catch (e) { st = null; }
      if (st && st.size > 512) {
        try {
          const buf = fs.readFileSync(file);
          return done(buf && buf.length >= 100 ? buf.toString('base64') : null);
        } catch (e) { return done(null); }
      }
      if (Date.now() > deadline) return done(null);
      setTimeout(tick, CAPTURE_POLL_MS);
    };
    setTimeout(tick, CAPTURE_POLL_MS);
  });
}

/**
 * Diagnose the capture path stage by stage.
 *
 * ⚠️ WRITTEN BECAUSE A SILENT NULL COST TWO REBOOT CYCLES. capture() answers null for six different
 * reasons — no module, no fs, no writable volume, the API threw, no file appeared, the file was
 * empty — and on hardware they are indistinguishable from each other and from "the gate never let
 * it run". This reports which, and nothing here returns image bytes, so it is safe to read from a
 * diagnostic endpoint.
 */
async function probe(opts) {
  const out = { module: false, fs: false, dir: null, called: false, wrote: false, bytes: 0, error: null, api: null };
  const ScreenshotClass = tryRequire('@brightsign/screenshot');
  const fs = tryRequire('fs');
  out.module = !!ScreenshotClass;
  out.fs = !!fs;
  if (!ScreenshotClass || !fs) return out;
  try {
    // What shape is it? A class, a factory, or an object with a method — the docs 404 and the
    // page-side caller has never been proven to run, so the shape is genuinely unknown here.
    out.api = { type: typeof ScreenshotClass, keys: Object.keys(ScreenshotClass || {}).slice(0, 8),
                proto: Object.getOwnPropertyNames((ScreenshotClass && ScreenshotClass.prototype) || {}).slice(0, 12) };
  } catch (e) { /* introspection is best-effort */ }
  const dir = pickDir(fs);
  out.dir = dir;
  if (!dir) return out;
  const file = `${dir}/${captureName(Date.now())}`;
  try {
    const shot = new ScreenshotClass();
    out.method = typeof shot.asyncCapture === 'function' ? 'asyncCapture'
      : typeof shot.syncCapture === 'function' ? 'syncCapture'
      : typeof shot.capture === 'function' ? 'capture' : null;
    out.called = true;
    if (!out.method) return out;
    await Promise.resolve(shot[out.method]({
      destinationFileName: file, fileName: file, fileType: 'JPEG',
      width: (opts && opts.width) || 960, height: (opts && opts.height) || 540,
      quality: 70, rotation: 0,
    }));
    out.wrote = fs.existsSync(file);
    if (out.wrote) out.bytes = fs.statSync(file).size;
  } catch (e) {
    out.error = String((e && e.message) || e);
  } finally {
    try { fs.unlinkSync(file); } catch (e) { /* nothing to clean */ }
  }
  return out;
}

module.exports = { available, capture, probe, pickDir, captureName, isLoopback, CANDIDATE_DIRS };
