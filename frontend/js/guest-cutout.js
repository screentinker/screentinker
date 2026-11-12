/*
 * "Remove my background" on the guest's page: only the person is sent, on pure green.
 *
 * The camera's picture goes through a person-segmentation network in this browser (seg-net.js,
 * on the graphics card), which says for every point whether it is the person. Everything else is
 * painted green, and that picture is what the studio receives; the studio keys the green out, so
 * the guest stands in the programme without their room. Nothing of the room leaves this device.
 *
 * The network and its maths (about 1 MB) are fetched only when the switch is first turned on.
 */
import { loadNet } from './seg-net.js';

const GREEN = '#00ff00';
let tfReady = null;
const script = (src) => new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Could not load ' + src)); document.head.appendChild(s); });
function maths() {
  tfReady = tfReady || (async () => {
    await script('/vendor/tfjs/tf-core.es2017.min.js'); await script('/vendor/tfjs/tf-backend-webgl.es2017.min.js');
    const tf = window.tf; await tf.setBackend('webgl'); await tf.ready();
    return tf;
  })();
  tfReady.catch(() => { tfReady = null; });
  return tfReady;
}
const nets = new Map();      // 'general' | 'landscape' -> promise of a loaded network
function net(tf, kind) {
  if (!nets.has(kind)) nets.set(kind, (async () => {
    const [graph, weights] = await Promise.all([fetch(`/vendor/segmenter/${kind}.json`).then((r) => r.json()), fetch(`/vendor/segmenter/${kind}.bin`).then((r) => r.arrayBuffer())]);
    return loadNet(tf, graph, weights);
  })());
  return nets.get(kind);
}

/**
 * Starts cutting the person out of a camera track. Resolves with
 * { track, stop(), rate() }: `track` is the picture to send (the person on green), `rate()` the
 * pictures a second it is managing. `source` is the camera's video track.
 */
export async function startCutout(source) {
  const tf = await maths();
  const video = document.createElement('video'); video.muted = true; video.playsInline = true; video.srcObject = new MediaStream([source]);
  await video.play();
  if (!video.videoWidth) await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }));
  const out = document.createElement('canvas'), person = document.createElement('canvas'), small = document.createElement('canvas'), maskC = document.createElement('canvas');
  const octx = out.getContext('2d'), pctx = person.getContext('2d'), sctx = small.getContext('2d', { willReadFrequently: true }), mctx = maskC.getContext('2d');
  let alive = true, prev = null, frames = 0, since = performance.now(), fps = 0, busy = false;
  async function frame() {
    if (!alive || busy || video.readyState < 2 || !video.videoWidth) return;
    busy = true;
    try {
      const W = video.videoWidth, H = video.videoHeight;
      if (out.width !== W || out.height !== H) { out.width = person.width = W; out.height = person.height = H; prev = null; }
      // A wide picture goes through the wide network; an upright or square one through the square one.
      const kind = W / H > 1.3 ? 'landscape' : 'general';
      const n = await net(tf, kind), [, h, w] = n.inputShape;
      if (small.width !== w || small.height !== h) { small.width = maskC.width = w; small.height = maskC.height = h; prev = null; }
      sctx.drawImage(video, 0, 0, w, h);
      pctx.globalCompositeOperation = 'source-over'; pctx.drawImage(video, 0, 0, W, H);      // the same instant the mask is made from
      const m = tf.tidy(() => n.run(tf.expandDims(tf.div(tf.cast(tf.browser.fromPixels(small), 'float32'), 255), 0)));
      const mask = await m.data(); m.dispose();
      if (!alive) return;
      // Steadied against the picture before (a mask that flickers shows as a shimmering edge), then made firm at the edge.
      const img = mctx.createImageData(w, h), px = img.data;
      if (!prev || prev.length !== mask.length) prev = Float32Array.from(mask);
      for (let i = 0; i < mask.length; i++) {
        const v = prev[i] = 0.65 * mask[i] + 0.35 * prev[i];
        const a = v <= 0.35 ? 0 : v >= 0.65 ? 1 : (v - 0.35) / 0.3;
        px[i * 4 + 3] = a * 255;
      }
      mctx.putImageData(img, 0, 0);
      pctx.globalCompositeOperation = 'destination-in'; pctx.imageSmoothingEnabled = true; pctx.drawImage(maskC, 0, 0, W, H);
      octx.fillStyle = GREEN; octx.fillRect(0, 0, W, H); octx.drawImage(person, 0, 0);
      frames += 1; const now = performance.now(); if (now - since >= 1000) { fps = frames * 1000 / (now - since); frames = 0; since = now; }
    } catch (e) { console.warn('[cutout]', e && e.message); }
    finally { busy = false; }
  }
  // One picture out for each picture in, as fast as this device manages; a slow one sends fewer, not later ones.
  const tick = () => { if (!alive) return; frame(); if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick); };
  let timer = null;
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick); else timer = setInterval(frame, 40);
  await frame();
  const stream = out.captureStream(30), track = stream.getVideoTracks()[0];
  return {
    track,
    rate: () => fps,
    stop() { alive = false; clearInterval(timer); try { track.stop(); } catch { /* gone */ } video.srcObject = null; },
  };
}
