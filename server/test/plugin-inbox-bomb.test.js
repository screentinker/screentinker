'use strict';

// A plugin zip whose headers LIE about sizes must be refused while it inflates, not after.
// Before the fix a 300 KB archive claiming a 10-byte entry grew the process by ~600 MB before
// inspectZip said no (entry.buffer() inflated it all first) — and any editor can submit one.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-inbox-bomb-'));
process.env.DATA_DIR = TMP;
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const archiver = require('archiver');
const inbox = require('../lib/plugins/inbox');

async function lyingZip(bigBytes) {
  const a = archiver('zip', { zlib: { level: 9 } });
  const chunks = [];
  a.on('data', (c) => chunks.push(c));
  const done = new Promise((r) => a.on('end', r));
  a.append(JSON.stringify({ id: 'bomb', name: 'b', version: '1.0.0', capabilities: ['hooks'] }), { name: 'plugin.json' });
  a.append('module.exports={activate(){}}', { name: 'index.js' });
  a.append(Buffer.alloc(bigBytes, 0), { name: 'public/x.txt' });
  a.finalize();
  await done;
  const buf = Buffer.concat(chunks);
  for (const [sig, nameLenAt, nameAt, sizeAt] of [[[0x50, 0x4b, 0x01, 0x02], 28, 46, 24], [[0x50, 0x4b, 0x03, 0x04], 26, 30, 22]]) {
    let i = -1;
    while ((i = buf.indexOf(Buffer.from(sig), i + 1)) >= 0) {
      const n = buf.readUInt16LE(i + nameLenAt);
      if (buf.slice(i + nameAt, i + nameAt + n).toString() === 'public/x.txt') buf.writeUInt32LE(10, i + sizeAt);
    }
  }
  const f = path.join(TMP, `bomb-${bigBytes}.zip`);
  fs.writeFileSync(f, buf);
  return f;
}

test('a zip that lies about an entry size is refused while inflating, without ballooning memory', async () => {
  const f = await lyingZip(200 * 1024 * 1024);
  global.gc && global.gc();
  const before = process.memoryUsage().rss;
  await assert.rejects(inbox.inspectZip(f), /inflated past the per-file cap/);
  const grewMb = (process.memoryUsage().rss - before) / 1048576;
  assert.ok(grewMb < 64, `inspecting a lying 200 MB entry grew RSS by ${grewMb.toFixed(0)} MB`);
});
