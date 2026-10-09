// What the Content Library says about one content row: its type, its status, its numbers, and how it
// can be previewed. Shared by the grid cards, the table rows and the inspector so the three never
// disagree.
//
// Status is only ever a real state of the row (server lib/content-library.js STATUS_SQL):
//   ready      green   live, nothing pending
//   review     amber   an unpublished draft waits for approval (replace or playback change)
//   attention  amber   a linked Canva design whose last sync failed — it needs reconnecting
//   expired    neutral past its expiry date, or deactivated by the expiry sweep
// "Uploading", "processing" and "failed" belong to the upload queue: a row exists only once ready.

import { t } from '../../i18n.js';

export const BUNDLE_MIME = 'application/vnd.screentinker.bundle+zip';
export const HOLD_MIME = 'application/x-st-hold';

export function typeOf(c) {
  const m = c.mime_type || '';
  if (m === HOLD_MIME) return { key: 'hold', label: t('content.type_hold') };
  if (m === 'video/hdmi-in') return { key: 'hdmi', label: t('library.type.hdmi') };
  if (m === 'video/hls' || m === 'video/rtsp') return { key: 'live', label: t('library.type.live') };
  if (m === 'video/youtube') return { key: 'youtube', label: t('content.type_youtube') };
  if (m === BUNDLE_MIME) return { key: 'bundle', label: t('content.type_bundle') };
  const base = m.startsWith('video/') ? 'video' : m.startsWith('audio/') ? 'audio' : 'image';
  const label = base === 'video' ? t('content.type_video') : base === 'audio' ? t('library.type.audio') : t('content.type_image');
  return { key: base, label, remote: !!c.remote_url };
}

/** A file whose bytes this server holds (as opposed to a link, a stream, an input or a hold). */
export const isStoredFile = (c) => !c.remote_url && !!c.filepath;

export function isExpired(c) {
  const exp = c.expires_at != null && c.expires_at !== '' ? Number(c.expires_at) * 1000 : null;
  return c.is_active === 0 || (exp != null && exp <= Date.now());
}

export function statusOf(c) {
  if (isExpired(c)) return { key: 'expired', tone: 'muted', label: t('library.status.expired') };
  if (c.sync_problem) return { key: 'attention', tone: 'warn', label: t('library.status.attention') };
  if (c.has_draft) return { key: 'review', tone: 'warn', label: t('library.status.review') };
  return { key: 'ready', tone: 'ok', label: t('library.status.ready') };
}

export function formatDuration(sec) {
  if (sec == null || !Number.isFinite(Number(sec)) || Number(sec) <= 0) return '';
  const s = Math.round(Number(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(r)}` : `${p(m)}:${p(r)}`;
}

/** Duration is meaningful for timed media only; a stream or a hold has none of its own. */
export function durationOf(c) {
  const ty = typeOf(c).key;
  return ty === 'video' || ty === 'audio' ? formatDuration(c.duration_sec) : '';
}

export function dimensionsOf(c) {
  return c.width && c.height ? `${c.width} × ${c.height}` : '';
}

export function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Where a no-bytes item comes from, for the line under its name. */
export function sourceOf(c) {
  const ty = typeOf(c).key;
  if (ty === 'hold') return c.remote_url === 'hold://freeze' ? t('content.hold_freeze') : t('content.hold_blank');
  if (ty === 'hdmi') {
    const port = /^hdmi:\/\/(\d+)/.exec(c.remote_url || '');
    return port ? `HDMI ${port[1]}` : t('content.hdmi_in_first');
  }
  if (ty === 'youtube') return 'YouTube';
  if (c.remote_url) { try { return new URL(c.remote_url).host; } catch { return t('content.type_remote'); } }
  return '';
}

/** The second line of a card or row: dimensions for media, the source for everything else. */
export function detailLine(c) {
  return dimensionsOf(c) || sourceOf(c);
}

/** The usage cell: a real playlist count, "Unused" only when nothing references it at all. */
export function usageText(c) {
  const u = c.usage;
  if (!u) return '';
  if (u.playlists > 0) return t(u.playlists === 1 ? 'library.usage.playlists_one' : 'library.usage.playlists_other', { count: u.playlists });
  return u.in_use ? t('library.usage.elsewhere') : t('library.usage.unused');
}

/** Thumbnail source for a card or row, or null for an icon. `auth` = needs the bearer token. */
export function thumbOf(c) {
  const ty = typeOf(c).key;
  if (ty === 'youtube') return c.thumbnail_path ? { src: c.thumbnail_path, auth: false } : null;
  if (['hold', 'hdmi', 'live', 'bundle'].includes(ty)) return null;
  if (c.remote_url) return ty === 'image' && /^https:/i.test(c.remote_url) ? { src: c.remote_url, auth: false } : null;
  if (c.thumbnail_path) return { src: `/api/content/${c.id}/thumbnail`, auth: true };
  if (ty === 'image') return { src: `/api/content/${c.id}/file`, auth: true };
  return null;
}

export const TYPE_ICONS = {
  video: '<polygon points="6 4 20 12 6 20 6 4"/>',
  audio: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  youtube: '<rect x="2" y="5" width="20" height="14" rx="3"/><polygon points="10 9 15 12 10 15 10 9"/>',
  live: '<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/>',
  hdmi: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  hold: '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
  bundle: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>',
};
export function typeIcon(key, size = 32) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${TYPE_ICONS[key] || TYPE_ICONS.image}</svg>`;
}
