'use strict';

/*
 * The trigger DEFINITION validator, shared by /api/triggers (store and head office triggers) and
 * /api/corporate/emergency (head office emergency alerts, kind = 'emergency'). Extracted from
 * routes/triggers.js unchanged for normal triggers: every message a normal trigger can produce is the
 * same text it produced before.
 *
 * An EMERGENCY alert differs in three ways (spec §5.1):
 *   - priority 0..1000 (projected as 100000 + p, so it outranks every normal trigger);
 *   - until_cleared NEEDS a lease of 5..300 s (default 120): no player caps an until_cleared trigger
 *     by wall clock, so the lease is what ends a stuck sender's alert; once needs max_duration_sec
 *     60..3600 (default 600);
 *   - token uniqueness is checked ORG-wide by the caller (lib/corporate/emergency.js tokenClash),
 *     not per workspace.
 */

const MODES = ['once', 'until_cleared'];
// POSITIONS is gone: geometry is reserved (see validate). The `position` column is still written
// as 'center' so existing rows keep a consistent value, but nothing reads it.
const TARGET_KINDS = ['playlist'];   // 'url' is designed for and deliberately not built yet

/*
 * ⚠️ THE TOKEN CHARSET IS A WIRE-FORMAT CONSTRAINT, NOT A STYLE PREFERENCE.
 *
 * The UDP payload is `ST1 <secret> <token>` — space-separated, one line, because that is what a
 * Crestron SendString or a PLC socket block can actually emit. A token containing a space would be
 * unparseable on arrival, and one containing a newline would let a single datagram look like two
 * messages. Rejecting them here is the only place that can be enforced before the field is saved;
 * on the wire it is already too late to give anyone a useful error.
 */
const TOKEN_RE = /^[\x21-\x7E]{1,64}$/;      // printable ASCII, no space, 1-64
const TOKEN_HINT = 'tokens must be 1-64 printable ASCII characters with no spaces — they travel in a ' +
                   'space-separated single-line datagram';

function intInRange(v, def, lo, hi) {
  if (v === undefined || v === null || v === '') return { ok: true, val: def };
  const n = Number(v);
  if (!Number.isFinite(n)) return { ok: false };
  const r = Math.round(n);
  if (r < lo || r > hi) return { ok: false };
  return { ok: true, val: r };
}

function validateTriggerBody(db, workspaceId, b, { id = null, kind = 'normal' } = {}) {
  const emergency = kind === 'emergency';
  if (!b.name || !String(b.name).trim()) return 'name required';

  if (!TOKEN_RE.test(String(b.match_token || ''))) return `invalid match_token — ${TOKEN_HINT}`;
  if (b.clear_token != null && b.clear_token !== '' && !TOKEN_RE.test(String(b.clear_token))) {
    return `invalid clear_token — ${TOKEN_HINT}`;
  }
  if (b.clear_token && String(b.clear_token) === String(b.match_token)) {
    return 'clear_token and match_token must differ, or a fire and a clear are the same message';
  }

  if (!MODES.includes(b.mode)) return `invalid mode, use one of: ${MODES.join(', ')}`;

  const targetKind = b.target_kind == null || b.target_kind === '' ? 'playlist' : String(b.target_kind);
  if (!TARGET_KINDS.includes(targetKind)) {
    return `invalid target_kind — v1 supports ${TARGET_KINDS.join(', ')} ('url' is designed but not built)`;
  }
  /*
   * ⚠️ The playlist must exist IN THIS WORKSPACE. Accepting a bare id would let a caller point a
   * trigger at another tenant's playlist and have the device pin and display it — the assignment
   * check on the device would never catch it, because by then it is just a playlist id.
   */
  const pl = db.prepare('SELECT id, published_snapshot FROM playlists WHERE id = ? AND workspace_id = ?')
    .get(String(b.target_ref || ''), workspaceId);
  if (!pl) return 'target_ref must be a playlist in this workspace';

  /*
   * ⚠️ THE TARGET MUST BE PLAYABLE OFFLINE, which is a stronger claim than "the target is a
   * playlist" and is the one that actually matters.
   *
   * The reason this feature targets a playlist rather than a URL (§1) is that playlist items are
   * library content and therefore PINNABLE. That reasoning has a hole: requestOfflineCache pins
   * `it.filepath && !it.remote_url`, so a playlist item carrying a remote_url is never pinned, and
   * a YouTube item cannot be pinned at all. Such a trigger passes every structural check and still
   * fires against nothing on exactly the day the WAN is down — the failure the playlist rule was
   * written to prevent, arriving through the front door.
   *
   * Caught at SAVE time, because the alternative is catching it during an alarm. YouTube is doubly
   * disqualified: createYoutubeEmbed is a singleton shared with the base playlist, so a YouTube
   * item in a trigger destroys the base player outright (the player drops them defensively for
   * definitions already cached in the field).
   */
  /*
   * ⚠️ FAIL CLOSED. This used to be `if (pl.published_snapshot) { … }`, so a playlist that had
   * never been published skipped the whole check and saved with a 200 — and deviceSocket.js uses
   * the same guard, so such a trigger syncs with `items: []` and renders nothing, forever,
   * silently. A green save on a trigger that can never fire is the worst outcome available here.
   */
  if (!pl.published_snapshot) {
    return 'that playlist has never been published — publish it first, or the trigger has nothing to render';
  }
  {
    let items;
    try { items = JSON.parse(pl.published_snapshot); } catch (e) { items = null; }
    // A non-array parses fine and then throws on for..of — which, with no error middleware, is a
    // 500 rather than a 400. Checked rather than caught.
    if (!Array.isArray(items)) return "that playlist's published snapshot is unreadable — republish it";
    if (!items.length) return 'that playlist is empty — the trigger would fire against nothing';
    const unpinnable = [];
    for (const it of items) {
      if (!it) continue;
      const label = it.filename || it.title || it.content_id || 'an item';
      /*
       * ⚠️ THE RULE IS "EXACTLY WHAT requestOfflineCache PINS", not a denylist of known-bad types.
       * That function keeps `it.filepath && !it.remote_url` (server/player/index.html), so the
       * inverse is the honest test — and it catches the two shapes a hand-written denylist missed:
       *
       *   • WIDGETS. A widget snapshot item has widget_id set and filepath/remote_url/mime_type
       *     all NULL, so it matched neither branch. It is fetched LIVE from serverUrl at render
       *     time, and sw.js documents that it cannot be service-worker cached at all — the
       *     sandboxed iframe is an opaque origin, so the worker never sees its request. When that
       *     fetch fails the worker serves a BLACK PAGE. An "Evacuation — proceed to Exit B" HTML
       *     widget is the most natural thing an operator would build, and it would have produced a
       *     fullscreen black box during a fire alarm with the WAN down.
       *   • DANGLING CONTENT. A content row deleted after publish leaves the item in the snapshot
       *     with every joined column NULL — no filepath, not pinnable, previously accepted.
       */
      if (it.mime_type === 'video/youtube' || it.youtube_id) unpinnable.push(`${label} (YouTube)`);
      else if (it.remote_url) unpinnable.push(`${label} (remote URL)`);
      else if (it.widget_id) unpinnable.push(`${label} (widget — re-rendered from the server on every play)`);
      else if (!it.filepath) unpinnable.push(`${label} (no local file — deleted from the library?)`);
    }
    if (unpinnable.length) {
      return `that playlist cannot be held on the device for offline playback: `
        + `${unpinnable.slice(0, 3).join(', ')}${unpinnable.length > 3 ? `, +${unpinnable.length - 3} more` : ''}. `
        + 'A trigger must fire with the network down, so its playlist may only contain uploaded '
        + 'media. See docs/triggers-design.md §1.';
    }
  }

  /*
   * ⚠️ GEOMETRY IS RESERVED, and saying so is the point.
   *
   * These five were copied from the PiP contract and never wired to anything: the renderer
   * discards them (a trigger is always fullscreen and opaque), the shared cross-platform contract
   * omits them, and they are no longer projected to devices. Accepting them with a 200 tells an
   * API client the overlay was positioned when it was not — a lie that only surfaces during an
   * emergency. A 400 naming the reason is worth more than a 200 that is wrong.
   *
   * The columns remain (SQLite drops need a table rebuild, and this schema treats unused columns
   * as the no-migration hook). If a non-fullscreen mode is wanted, add ONE semantic field
   * (takeover | banner) rather than resurrecting five raw CSS primitives.
   */
  const geo = ['width', 'height', 'opacity', 'border_radius']
    .filter((k) => b[k] != null && b[k] !== '');
  if (b.position != null && b.position !== '' && b.position !== 'center') geo.unshift('position');
  if (geo.length) {
    return `${geo.join(', ')} ${geo.length > 1 ? 'are' : 'is'} reserved — a trigger renders `
      + 'fullscreen; see docs/triggers-design.md §4';
  }

  if (emergency) {
    if (!intInRange(b.priority, 0, 0, 1000).ok) return 'priority must be 0..1000 for an emergency alert';
    if (b.mode === 'until_cleared') {
      if (!intInRange(b.lease_sec, 120, 5, 300).ok) {
        return 'lease_sec must be 5-300 seconds for an until_cleared emergency alert — it ends the alert '
          + 'that long after the alarm stops sending, and no screen ends it any other way';
      }
      if (b.max_duration_sec != null && b.max_duration_sec !== '' && Number(b.max_duration_sec) !== 0) {
        return 'max_duration_sec applies to "once" emergency alerts only — an until_cleared one ends by its lease';
      }
    } else {
      if (b.lease_sec != null && b.lease_sec !== '') return 'lease_sec applies to until_cleared triggers only';
      if (!intInRange(b.max_duration_sec, 600, 60, 3600).ok || Number(b.max_duration_sec) === 0) {
        return 'max_duration_sec must be 60-3600 seconds for a "once" emergency alert';
      }
    }
    return null;   // tokens: checked org-wide by the caller
  }

  if (!intInRange(b.max_duration_sec, 0, 0, 86400).ok) return 'max_duration_sec must be 0-86400 (0 = no cap)';
  if (!intInRange(b.priority, 0, -1000, 1000).ok) return 'priority must be -1000..1000';

  // lease_sec is until_cleared-only: on a `once` trigger there is nothing to renew, and accepting it
  // would silently store a field that never applies.
  if (b.lease_sec != null && b.lease_sec !== '') {
    if (b.mode !== 'until_cleared') return 'lease_sec applies to until_cleared triggers only';
    if (!intInRange(b.lease_sec, 0, 5, 86400).ok) return 'lease_sec must be 5-86400 seconds';
  }

  /*
   * ⚠️ FIRE AND CLEAR TOKENS SHARE ONE NAMESPACE, so uniqueness has to span both columns.
   *
   * evaluate() walks the device's triggers in query order and, per trigger, tests match_token and
   * then clear_token. So if trigger A's clear_token equals trigger B's match_token, the token
   * resolves to whichever row the SELECT happened to return first — and the losing case is the bad
   * one: an emergency trigger becomes silently UNFIRABLE because an unrelated trigger's clear
   * shadows it. Nothing logs, because from the resolver's point of view the token matched.
   *
   * The unique index only covers (workspace_id, match_token), and an index error would surface as
   * a 500 rather than something an operator can act on, so this is checked here and named.
   */
  const tokens = [String(b.match_token)];
  if (b.clear_token) tokens.push(String(b.clear_token));
  const rows = id
    ? db.prepare('SELECT match_token, clear_token FROM triggers WHERE workspace_id = ? AND id != ?')
      .all(workspaceId, id)
    : db.prepare('SELECT match_token, clear_token FROM triggers WHERE workspace_id = ?')
      .all(workspaceId);
  const taken = new Set();
  for (const r of rows) {
    if (r.match_token) taken.add(r.match_token);
    if (r.clear_token) taken.add(r.clear_token);
  }
  for (const tok of tokens) {
    if (taken.has(tok)) {
      return `"${tok}" is already used as a fire or clear token by another trigger in this `
        + 'workspace — fire and clear tokens share one namespace, and a duplicate would resolve '
        + 'to whichever trigger the database returned first';
    }
  }

  return null;
}

function columnsFrom(b, { kind = 'normal' } = {}) {
  const emergency = kind === 'emergency';
  return {
    name: String(b.name).trim().slice(0, 200),
    match_token: String(b.match_token),
    clear_token: b.clear_token ? String(b.clear_token) : null,
    source_http: b.source_http === false || b.source_http === 0 ? 0 : 1,
    source_udp: b.source_udp === true || b.source_udp === 1 ? 1 : 0,
    target_kind: b.target_kind || 'playlist',
    target_ref: String(b.target_ref),
    position: b.position || 'center',
    width: intInRange(b.width, null, 40, 3840).val,
    height: intInRange(b.height, null, 40, 3840).val,
    opacity: b.opacity == null || b.opacity === '' ? null : Math.max(0, Math.min(1, Number(b.opacity))),
    border_radius: intInRange(b.border_radius, null, 0, 512).val,
    mode: b.mode,
    max_duration_sec: emergency
      ? (b.mode === 'until_cleared' ? 0 : intInRange(b.max_duration_sec, 600, 60, 3600).val)
      : intInRange(b.max_duration_sec, 0, 0, 86400).val,
    lease_sec: emergency
      ? (b.mode === 'until_cleared' ? intInRange(b.lease_sec, 120, 5, 300).val : null)
      : (b.mode === 'until_cleared' && b.lease_sec != null && b.lease_sec !== ''
        ? intInRange(b.lease_sec, null, 5, 86400).val : null),
    priority: emergency ? intInRange(b.priority, 0, 0, 1000).val : intInRange(b.priority, 0, -1000, 1000).val,
    enabled: b.enabled === false || b.enabled === 0 ? 0 : 1,
  };
}


module.exports = { validateTriggerBody, columnsFrom, intInRange, MODES, TARGET_KINDS, TOKEN_RE, TOKEN_HINT };
