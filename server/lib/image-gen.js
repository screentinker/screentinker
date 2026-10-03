'use strict';

// #41 Phase 2: text-to-image for AI signage. Two backends, both BYO/self-hostable:
//  - 'comfyui'  -> local ComfyUI (SDXL) via its prompt/history/view API
//  - 'openai'   -> any OpenAI-compatible /images/generations endpoint
// Returns a data: URL (base64 PNG) the Designer can drop straight onto a layer.
// The caller is responsible for the SSRF check on the base URL.

const NEGATIVE = 'text, words, letters, watermark, signature, logo, blurry, low quality, deformed';

function buildComfyWorkflow(prompt, ckpt, width, height, seed) {
  return {
    '3': { class_type: 'KSampler', inputs: { seed, steps: 25, cfg: 7, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: NEGATIVE, clip: ['4', 1] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'signage', images: ['8', 0] } },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function comfyGenerate(baseUrl, prompt, model, width, height, signal) {
  const ckpt = model || 'sd_xl_base_1.0.safetensors';
  const seed = Math.floor(Math.random() * 1e15);
  const wf = buildComfyWorkflow(prompt, ckpt, width, height, seed);
  const sub = await fetch(baseUrl + '/prompt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: wf }), signal,
  });
  if (!sub.ok) throw new Error(`ComfyUI rejected the job (${sub.status}): ${(await sub.text().catch(() => '')).slice(0, 150)}`);
  const { prompt_id } = await sub.json();
  if (!prompt_id) throw new Error('ComfyUI did not return a prompt id');

  // poll history until this prompt produces an output
  for (let i = 0; i < 120; i++) {
    if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    await sleep(1000);
    const h = await fetch(`${baseUrl}/history/${prompt_id}`, { signal }).then((r) => r.json()).catch(() => null);
    const entry = h && h[prompt_id];
    if (!entry) continue;
    const outputs = entry.outputs || {};
    for (const nodeId of Object.keys(outputs)) {
      const imgs = outputs[nodeId].images;
      if (imgs && imgs.length) {
        const im = imgs[0];
        const q = new URLSearchParams({ filename: im.filename, subfolder: im.subfolder || '', type: im.type || 'output' });
        const buf = Buffer.from(await (await fetch(`${baseUrl}/view?${q}`, { signal })).arrayBuffer());
        return 'data:image/png;base64,' + buf.toString('base64');
      }
    }
    if (entry.status && entry.status.status_str === 'error') throw new Error('ComfyUI reported a generation error');
  }
  throw new Error('ComfyUI image timed out');
}

// 'openai' (real cloud) only accepts a fixed set of sizes; 'sdcpp' (local) takes
// exact dimensions and is VRAM-bound, so we keep those small. Both speak the same
// /v1/images/generations API.
function sizeFor(provider, width, height) {
  if (provider === 'sdcpp') return `${width}x${height}`;
  return width > height ? '1792x1024' : (height > width ? '1024x1792' : '1024x1024');
}

/*
 * ⚠️ "OpenAI-COMPATIBLE" IS A SPECTRUM, AND `size` IS WHERE IT BREAKS FIRST.
 *
 * xAI answers `400 {"error":"Argument not supported: size"}` — it rejects the ARGUMENT, not the
 * value, because the model decides its own dimensions. Sending it is fatal, and the failure text is
 * clear enough to act on, so a single retry without the offending argument turns a hard failure
 * into a working request rather than making every operator discover this per provider.
 *
 * Bounded deliberately: ONE retry, only for a 400 that names the argument. A general
 * "retry without whatever it complained about" loop would paper over real prompt errors.
 */
/*
 * xAI's supported aspect ratios (docs.x.ai, /v1/images/generations). It has no `size` at all — it
 * takes `aspect_ratio` plus `resolution`, which is why simply dropping `size` produced a correct
 * image in the WRONG SHAPE: a 16:9 request came back 832x1248 portrait, and on a 16:9 slide that
 * crops to a middle band.
 */
const XAI_ASPECTS = [
  ['21:9', 21 / 9], ['2:1', 2], ['20:9', 20 / 9], ['19.5:9', 19.5 / 9], ['16:9', 16 / 9],
  ['5:2', 2.5], ['3:2', 1.5], ['4:3', 4 / 3], ['1:1', 1], ['3:4', 0.75], ['2:3', 2 / 3],
  ['9:16', 9 / 16], ['9:19.5', 9 / 19.5], ['9:20', 9 / 20], ['1:2', 0.5],
];

/** Nearest supported ratio to what the caller asked for, by log distance so 2:1 and 1:2 are equally far. */
function nearestAspect(width, height) {
  const want = (width || 1) / (height || 1);
  let best = '1:1';
  let bestErr = Infinity;
  for (const [name, value] of XAI_ASPECTS) {
    const err = Math.abs(Math.log(value) - Math.log(want));
    if (err < bestErr) { bestErr = err; best = name; }
  }
  return best;
}

async function openaiCompatGenerate(baseUrl, key, prompt, model, size, signal, dims) {
  const attempt = async (withSize) => {
    /*
     * ⚠️ THE RETRY IS NOT "SEND LESS", IT IS "SPEAK THE OTHER DIALECT". Dropping `size` alone got a
     * picture but surrendered all control of its shape, which for a slide background is most of
     * the point. xAI's equivalent is aspect_ratio + resolution, so the retry states the shape in
     * the vocabulary that endpoint actually has.
     *
     * resolution '2k' because this fills a screen — on a 1080p panel the 1k variant is visibly
     * soft, and the difference is about two cents an image.
     */
    const body = withSize
      ? { prompt, n: 1, size, response_format: 'b64_json' }
      : {
        prompt,
        n: 1,
        response_format: 'b64_json',
        aspect_ratio: nearestAspect(dims && dims.width, dims && dims.height),
        resolution: '2k',
      };
    if (model) body.model = model;   // omit for sd.cpp (uses its loaded checkpoint)
    const res = await fetch(baseUrl + '/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal,
    });
    const text = res.ok ? null : (await res.text().catch(() => '')).slice(0, 200);
    if (!res.ok) return { ok: false, status: res.status, text };
    return { ok: true, json: await res.json() };
  };

  let r = await attempt(true);
  /*
   * The one retry. xAI says `Argument not supported: size`; other shims word it differently, so
   * this matches on the argument name plus a "not supported / unknown / unexpected" phrasing rather
   * than an exact string, and only ever for a 400.
   */
  if (!r.ok && r.status === 400 && /size/i.test(r.text || '') && /not supported|unsupported|unknown|unexpected|invalid/i.test(r.text || '')) {
    r = await attempt(false);
  }
  if (!r.ok) throw new Error(`Image endpoint error ${r.status}: ${r.text}`);

  const j = r.json;
  const b64 = j && j.data && j.data[0] && j.data[0].b64_json;
  if (b64) return 'data:image/png;base64,' + b64;
  const url = j && j.data && j.data[0] && j.data[0].url;
  if (url) {
    const buf = Buffer.from(await (await fetch(url, { signal })).arrayBuffer());
    return 'data:image/png;base64,' + buf.toString('base64');
  }
  throw new Error('Image endpoint returned no image');
}

async function generateImage(opts) {
  const { provider, baseUrl, apiKey, model, prompt } = opts;
  const width = opts.width || 1024;
  const height = opts.height || 1024;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 180000);
  try {
    if (provider === 'openai' || provider === 'sdcpp') {
      return await openaiCompatGenerate(baseUrl, apiKey || 'none', prompt, model, sizeFor(provider, width, height), controller.signal, { width, height });
    }
    return await comfyGenerate(baseUrl, prompt, model, width, height, controller.signal);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('image generation timed out');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { generateImage, nearestAspect };
