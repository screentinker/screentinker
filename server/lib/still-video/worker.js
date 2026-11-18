'use strict';

/*
 * Child-process entry for one still-to-video conversion.
 *
 * It runs as its own process on purpose: decoding a large image and encoding 4K is the heaviest
 * thing the server ever does with an upload, and here it cannot hurt the server. A crash, an
 * out-of-memory kill or a hang ends this process only; the parent records a failed conversion and
 * the display keeps showing the original image. The parent also lowers this process's priority, so
 * the server always wins the CPU.
 *
 * Protocol: one JSON job on stdin ({ src, out, maxWidth, maxHeight, qp, seconds }); one JSON line on
 * stdout ({ ok, width, height, bytes, qp, frames } or { ok: false, error }). Exit code 0 either way;
 * any other exit means the process died.
 */

const fs = require('node:fs');

async function run(job) {
  const { readImage } = require('../image-ops-core');
  const { stillToMp4 } = require('./convert');
  const image = await readImage(job.src);
  const { data, width, height } = image.bitmap;
  const result = stillToMp4({ data, width, height }, job);
  fs.writeFileSync(job.out, result.mp4);
  return { width: result.width, height: result.height, bytes: result.mp4.length, qp: result.qp, frames: result.frames };
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  let reply;
  try {
    reply = { ok: true, ...(await run(JSON.parse(input))) };
  } catch (error) {
    reply = { ok: false, error: String((error && error.message) || error).slice(0, 300) };
  }
  process.stdout.write(`${JSON.stringify(reply)}\n`, () => process.exit(0));
});
