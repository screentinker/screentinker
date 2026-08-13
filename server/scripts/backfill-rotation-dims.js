'use strict';

// #170 backfill: correct stored width/height for already-uploaded portrait media that was
// ingested before the rotation-aware fix (coded dims, rotation ignored -> stored landscape).
// Re-probes each content file on disk, recomputes DISPLAY dims via lib/media-orientation, and
// (with --apply) updates the row + regenerates mis-oriented IMAGE thumbnails (old image thumbs
// were written without EXIF auto-orient; old video thumbs were already auto-rotated by ffmpeg).
//
// Idempotent: a second run finds nothing to change. Dry-run by default.
//   node scripts/backfill-rotation-dims.js            # report only
//   node scripts/backfill-rotation-dims.js --apply    # write corrections
//   node scripts/backfill-rotation-dims.js --apply --limit 50
//
// In Docker:  docker exec <container> node scripts/backfill-rotation-dims.js --apply

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { db } = require('../db/database');
const config = require('../config');
const { videoDisplayDims, imageDisplayDims } = require('../lib/media-orientation');

const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg >= 0 ? parseInt(process.argv[limitArg + 1], 10) || 0 : 0;

function probeVideoDims(filePath) {
  const out = execFileSync('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_streams', filePath], { timeout: 15000 }).toString();
  const stream = (JSON.parse(out).streams || []).find(s => s.codec_type === 'video');
  return videoDisplayDims(stream);
}

async function probeImageDims(filePath) {
  const imageOps = require('../lib/image-ops');
  return imageDisplayDims(await imageOps.metadata(filePath));
}

async function regenImageThumb(filePath, thumbName) {
  const imageOps = require('../lib/image-ops');
  // Rotation is implicit: the decoder auto-orients per EXIF, which is what .rotate() bought here.
  await imageOps.writeThumbnail(filePath, path.join(config.contentDir, thumbName), config.thumbnailWidth, 70);
}

(async () => {
  const rows = db.prepare(
    `SELECT id, filepath, thumbnail_path, mime_type, width, height FROM content
     WHERE filepath IS NOT NULL AND (mime_type LIKE 'image/%' OR mime_type LIKE 'video/%')
     ${LIMIT ? 'LIMIT ' + LIMIT : ''}`
  ).all();

  let checked = 0, corrected = 0, missing = 0, probeErr = 0, thumbRegen = 0;
  const changes = [];

  for (const row of rows) {
    const filePath = path.join(config.contentDir, row.filepath);
    if (!fs.existsSync(filePath)) { missing++; continue; }
    checked++;
    let dims;
    try {
      dims = row.mime_type.startsWith('image/') ? await probeImageDims(filePath) : probeVideoDims(filePath);
    } catch (e) { probeErr++; continue; }
    if (dims.width == null || dims.height == null) continue;
    if (dims.width === row.width && dims.height === row.height) continue; // already correct

    corrected++;
    changes.push({ id: row.id, from: `${row.width}x${row.height}`, to: `${dims.width}x${dims.height}`, mime: row.mime_type });
    if (APPLY) {
      db.prepare('UPDATE content SET width = ?, height = ? WHERE id = ?').run(dims.width, dims.height, row.id);
      // Regenerate the image thumbnail (video thumbs were already auto-rotated at ingest).
      if (row.mime_type.startsWith('image/') && row.thumbnail_path) {
        try { await regenImageThumb(filePath, row.thumbnail_path); thumbRegen++; } catch (e) { /* best-effort */ }
      }
    }
  }

  console.log(`${APPLY ? 'APPLIED' : 'DRY-RUN'} — content rows: ${rows.length} | on-disk checked: ${checked} | missing file: ${missing} | probe errors: ${probeErr}`);
  console.log(`dimension corrections ${APPLY ? 'written' : 'needed'}: ${corrected}${APPLY ? ` | image thumbnails regenerated: ${thumbRegen}` : ''}`);
  for (const c of changes.slice(0, 40)) console.log(`  ${c.id.slice(0, 8)} ${c.mime}  ${c.from} -> ${c.to}`);
  if (changes.length > 40) console.log(`  … and ${changes.length - 40} more`);
  if (!APPLY && corrected) console.log('\nRe-run with --apply to write these corrections.');
})();
