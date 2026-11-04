'use strict';

/*
 * The media a slide widget shows, so a screen can hold it for offline playback.
 *
 * A slide's page references its photos and clips by URL (routes/widgets.js imageResolverFor), never
 * inline. Until this existed the playlist payload said nothing about them: every player's offline
 * cache was built from playlist items, a widget item was skipped, and a slide's pictures and videos
 * streamed from the server each time. With the network gone the slide's words stayed up and every
 * picture on it went blank.
 *
 * slideContentIds() is what the RENDERER would resolve (lib/slide-render.js: photo, lettering and
 * video elements, the background photo and background video), read through normalizeSlide so the
 * two can never disagree about what a slide contains. slideMediaFor() turns those ids into the
 * fields every player already caches a playlist item by (content_id, filepath, content_rev,
 * mime_type), held to the same workspace rule the renderer is: a slide only ever shows media its
 * own workspace owns.
 */
const { normalizeSlide } = require('./slide-render');

// Element kinds whose content_id the renderer turns into a URL. 'video' is listed ahead of the kind
// itself landing: an element normalised as something else never carries a rendered reference.
const MEDIA_KINDS = new Set(['image', 'lettering', 'video']);
// A slide holds at most 40 elements (MAX_ELEMENTS); this bounds the payload whatever the config says.
const MAX_REFS = 48;

function slideContentIds(rawConfig) {
  let slide;
  try { slide = normalizeSlide(rawConfig); } catch (_) { return []; }
  const out = [];
  const add = (id) => { if (typeof id === 'string' && id && !out.includes(id) && out.length < MAX_REFS) out.push(id); };
  add(slide.backgroundContentId);
  add(slide.backgroundVideoContentId);
  for (const e of slide.elements || []) if (MEDIA_KINDS.has(e.kind)) add(e.contentId);
  return out;
}

/**
 * [{ content_id, filepath, content_rev, mime_type, remote_url? }] for a slide widget's config.
 * `workspaceId` null means a platform template: platform content only (imageResolverFor's rule).
 */
function slideMediaFor(db, rawConfig, workspaceId) {
  let cfg = rawConfig;
  if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg || '{}'); } catch (_) { return []; } }
  const ids = slideContentIds(cfg);
  if (!ids.length) return [];
  const sql = `SELECT id, filepath, remote_url, mime_type, COALESCE(NULLIF(updated_at, 0), created_at) AS rev
                 FROM content WHERE id IN (${ids.map(() => '?').join(',')}) AND `
    + (workspaceId ? 'workspace_id = ?' : 'workspace_id IS NULL');
  let rows;
  try { rows = db.prepare(sql).all(...ids, ...(workspaceId ? [workspaceId] : [])); } catch (_) { return []; }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) continue;
    const m = { content_id: r.id, filepath: r.filepath || null, content_rev: r.rev || 0, mime_type: r.mime_type || null };
    if (r.remote_url) m.remote_url = r.remote_url;   // the player fetches these itself; nothing to cache
    out.push(m);
  }
  return out;
}

module.exports = { slideContentIds, slideMediaFor, MEDIA_KINDS };
