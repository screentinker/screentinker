'use strict';

/*
 * The tool catalogue: what an AI agent can do with a ScreenTinker instance.
 *
 * ⚠️ EVERY TOOL IS A CALL TO OUR OWN PUBLIC REST API, and that is the whole security design. The MCP
 * server is a CLIENT of the API, not a second implementation of it — so `bearerAuth`,
 * `resolveTenancy`, `tokenScopeGate`, the replica proxy and the rate limiters all apply unchanged,
 * and config/api-surface.js remains the single description of what a token can reach. A second
 * front door that re-implemented any of that is exactly how a privilege leak gets built.
 *
 * ⚠️ THIS IS NOT THE WHOLE API. The spec has 133 operations; wrapping all of them would make the
 * tool list unusable — an agent's ability to pick the right tool degrades badly past a few dozen, so
 * a complete catalogue would be a worse product than a curated one. These are shaped around what
 * somebody actually asks for ("what's offline?", "put this video on the lobby screen"), not around
 * the endpoint list.
 *
 * `scope` mirrors the token scopes in middleware/apiToken.js. The catalogue is FILTERED by the
 * calling token's scope before it is ever sent, so a read-only token does not merely get refused
 * when it calls a write tool — it never sees one exists.
 */

const TOOLS = [
  /* ─────────────────────────────── read ─────────────────────────────── */
  {
    name: 'list_displays',
    scope: 'read',
    description: 'List the screens in this workspace with their online status, last heartbeat, platform and assigned playlist. Use this first to find a display id.',
    input: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['online', 'offline'], description: 'Only screens in this state.' },
        search: { type: 'string', description: 'Case-insensitive match on the display name.' },
      },
    },
    call: { method: 'GET', path: '/api/devices' },
    // Trim the row to what a model needs to answer a question. The full device row carries ~80
    // columns including secrets the API already strips; sending all of it wastes the context an
    // agent needs for the actual task.
    shape: (rows, args) => (Array.isArray(rows) ? rows : [])
      .filter((d) => !args.status || (args.status === 'online' ? d.status === 'online' : d.status !== 'online'))
      .filter((d) => !args.search || String(d.name || '').toLowerCase().includes(String(args.search).toLowerCase()))
      .map((d) => ({
        id: d.id, name: d.name, status: d.status, platform: d.platform || d.client_type || null,
        last_heartbeat: d.last_heartbeat ? new Date(d.last_heartbeat * 1000).toISOString() : null,
        playlist_id: d.playlist_id || null, ...groupsOf(d),
      })),
  },
  {
    name: 'get_display',
    scope: 'read',
    description: 'Full detail for one screen: telemetry, what it is playing, resolution, app version and schedule.',
    input: { type: 'object', required: ['display_id'], properties: { display_id: { type: 'string' } } },
    call: { method: 'GET', path: '/api/devices/{display_id}' },
    // The raw row is ~80 columns and the assignments carry filepaths and thumbnail paths. A model
    // reading that spends its context on storage detail instead of on the question it was asked.
    shape: (d) => {
      if (!d || typeof d !== 'object') return d;
      return {
        id: d.id, name: d.name, status: d.status,
        platform: d.platform || d.client_type || null,
        app_version: d.app_version || null,
        resolution: d.screen_width && d.screen_height ? `${d.screen_width}x${d.screen_height}` : null,
        orientation: d.orientation || null,
        last_heartbeat: d.last_heartbeat ? new Date(d.last_heartbeat * 1000).toISOString() : null,
        offline_reason: d.status === 'online' ? null : (d.offline_reason || null),
        playlist_id: d.playlist_id || null,
        ...groupsOf(d),
        now_playing: (d.assignments || []).map((a) => ({
          item_id: a.id,
          name: a.widget_name || a.filename || a.remote_url || '(unnamed item)',
          kind: a.widget_id ? 'widget' : 'content',
          duration_sec: a.duration_sec ?? a.content_duration ?? null,
          zone: a.zone_id || null,
          // An orphan is an assignment whose content is gone: the screen shows nothing for that slot
          // and the operator usually has no idea. Worth surfacing rather than hiding in a raw row.
          orphan: !!a.orphan,
        })),
      };
    },
  },
  {
    name: 'fleet_status',
    scope: 'read',
    description: 'One-line health answer for the whole workspace: how many screens are online, and which are not. Use this for "is everything OK".',
    input: { type: 'object', properties: {} },
    call: { method: 'GET', path: '/api/devices' },
    shape: (rows) => {
      const all = Array.isArray(rows) ? rows : [];
      const offline = all.filter((d) => d.status !== 'online');
      return {
        total: all.length,
        online: all.length - offline.length,
        offline: offline.length,
        // Named, because "3 offline" is not actionable and "3 offline: Lobby, Cafe, Window" is.
        offline_displays: offline.map((d) => ({
          id: d.id, name: d.name,
          last_heartbeat: d.last_heartbeat ? new Date(d.last_heartbeat * 1000).toISOString() : null,
          reason: d.offline_reason || null,
        })),
      };
    },
  },
  {
    name: 'list_playlists',
    scope: 'read',
    description: 'List the playlists in this workspace, with how many items each holds and whether it has unpublished changes. `corporate` marks a head office playlist (read-only unless you are a corporate author); `corporate_slot` marks this workspace\'s content for one of head office\'s local slots.',
    input: { type: 'object', properties: {} },
    call: { method: 'GET', path: '/api/playlists' },
    // The raw rows carry both published snapshots per playlist — see shapePlaylist for why that is
    // the one thing a playlist answer must not do.
    shape: (rows) => (Array.isArray(rows) ? rows : []).map(shapePlaylistRow),
  },
  {
    name: 'get_playlist',
    scope: 'read',
    description: 'A playlist with its items in order, including each item duration and any per-item schedule. On a head office (corporate) playlist every item is `locked`, and a `kind: "slot"` item is a local slot that stores fill with their own content.',
    input: { type: 'object', required: ['playlist_id'], properties: { playlist_id: { type: 'string' } } },
    call: { method: 'GET', path: '/api/playlists/{playlist_id}' },
    shape: shapePlaylist,
  },
  {
    name: 'list_content',
    scope: 'read',
    description: 'List the media library: images, video, web pages and YouTube items available to put on a screen.',
    input: {
      type: 'object',
      properties: { search: { type: 'string', description: 'Case-insensitive match on the file or item name.' } },
    },
    call: { method: 'GET', path: '/api/content' },
    /*
     * ⚠️ THE COLUMNS ARE filename / mime_type / duration_sec. There is no `name`, `type` or
     * `duration` on a content row and never has been. Projecting those three produced an item with
     * an id and nothing else, and `search` - which filtered on the same absent `name` - returned an
     * empty list for EVERY query. Both answers are well-formed and neither is an error, so an agent
     * concludes the library is empty or its items are unnamed, and says so convincingly. Same shape
     * of failure as the report date range: 200, plausible, wrong.
     *
     * `filename` is the label for every kind of content, not just uploads - a YouTube item is stored
     * as `YouTube: <videoId>` or its title, and a web page gets one derived from its URL.
     */
    shape: (rows, args) => (Array.isArray(rows) ? rows : [])
      .filter((c) => !args.search || String(c.filename || '').toLowerCase().includes(String(args.search).toLowerCase()))
      .map((c) => ({
        id: c.id, name: c.filename, type: c.mime_type,
        duration: c.duration_sec ?? null, folder: c.folder_id || null,
      })),
  },
  {
    name: 'list_groups',
    scope: 'read',
    description: 'List device groups. A group is how several screens are driven together: one playlist, one command, synchronised playback.',
    input: { type: 'object', properties: {} },
    call: { method: 'GET', path: '/api/groups' },
  },
  {
    name: 'list_schedules',
    scope: 'read',
    description: 'Scheduled playlist changes, for one screen or the whole workspace.',
    input: { type: 'object', properties: { display_id: { type: 'string', description: 'Restrict to one screen (its own schedules and its groups\'.)' } } },
    // ⚠️ display_id was declared and never sent, so "what is scheduled on the lobby screen" answered
    // with every schedule in the workspace. The endpoint's filter is device_id, and it already
    // includes schedules aimed at the screen's groups.
    call: { method: 'GET', path: '/api/schedules', query: ['device_id'] },
    mapArgs: (a) => ({ device_id: a.display_id }),
  },
  {
    name: 'play_report',
    scope: 'read',
    description: 'Proof-of-play: what actually played, how often and for how long. Answers "did the campaign run".',
    input: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO date, inclusive.' },
        to: { type: 'string', description: 'ISO date, inclusive.' },
        display_id: { type: 'string' },
      },
    },
    /*
     * ⚠️ THE ENDPOINT'S PARAMETERS ARE `start`/`end`, NOT `from`/`to`.
     *
     * The first version sent from/to. They are not parameters this endpoint has, so they were ignored
     * and it returned its DEFAULT 30-day window — which the tool then presented as the answer to
     * "what played in the first week of September". A wrong answer delivered confidently, with no
     * error anywhere. The argument names stay from/to because that is what a model reaches for; the
     * mapping is what has to be right.
     */
    call: { method: 'GET', path: '/api/reports/summary', query: ['start', 'end', 'device_id'] },
    mapArgs: (a) => ({ start: a.from, end: a.to, device_id: a.display_id }),
  },
  {
    name: 'uptime_report',
    scope: 'read',
    description: 'How much of the period each screen was online. Answers "which screen keeps dropping out".',
    input: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 365, description: 'Look back this many days from now. Ignored if from/to are given.' },
        from: { type: 'string', description: 'ISO date. Use instead of days for an exact window.' },
        to: { type: 'string', description: 'ISO date.' },
        display_id: { type: 'string' },
      },
    },
    // ⚠️ Same trap as play_report: this endpoint takes start/end/device_id and has no `days`
    // parameter at all, so the first version's `days` was dropped on the floor. `days` is kept as an
    // argument because it is how the question is actually asked, and converted here.
    call: { method: 'GET', path: '/api/reports/uptime', query: ['start', 'end', 'device_id'] },
    mapArgs: (a) => {
      if (a.from || a.to) return { start: a.from, end: a.to, device_id: a.display_id };
      const days = Math.min(365, Math.max(1, Number(a.days) || 7));
      const end = new Date();
      const start = new Date(end.getTime() - days * 86400000);
      return { start: start.toISOString(), end: end.toISOString(), device_id: a.display_id };
    },
  },

  /* ─────────────────────────────── write ─────────────────────────────── */
  {
    name: 'add_youtube_video',
    scope: 'write',
    description: 'Add a YouTube video to the media library so it can be put on a screen.',
    input: {
      type: 'object', required: ['url'],
      properties: { url: { type: 'string' }, name: { type: 'string', description: 'Defaults to the video title.' } },
    },
    call: { method: 'POST', path: '/api/content/youtube', body: ['url', 'name'] },
    shape: shapeContent,
  },
  {
    name: 'add_web_page',
    scope: 'write',
    /*
     * ⚠️ A WEB PAGE IS A `webpage` WIDGET, which is how the dashboard adds one. This used to post the
     * URL to /content/remote with no mime_type, and that route defaults to image/jpeg — so a page was
     * saved as a JPEG and every player tried to decode HTML as an image. Images and video by URL are
     * add_media_url.
     */
    description: 'Add a web page (any http/https URL) as a web page widget the screens render live. Returns a widget id: add it to a playlist with add_to_playlist and widget_id. For a direct link to an image or video file use add_media_url.',
    input: {
      type: 'object', required: ['url'],
      properties: {
        url: { type: 'string', pattern: '^https?://', description: 'http or https.' },
        name: { type: 'string', description: 'Defaults to the page\'s host and path.' },
      },
    },
    call: { method: 'POST', path: '/api/widgets', body: ['widget_type', 'name', 'config'] },
    // The config the dashboard's web page form saves: 100% zoom, no forced reload.
    mapArgs: (a) => ({
      widget_type: 'webpage',
      name: a.name || pageName(a.url),
      config: { url: a.url, zoom: 100, refresh_interval: 0 },
    }),
    shape: shapeWidget,
  },
  {
    name: 'add_media_url',
    scope: 'write',
    description: 'Add a remote image, video or audio file (a direct URL to the file, not a web page) to the media library. The kind is read from the file extension; pass `type` when the URL has none.',
    input: {
      type: 'object', required: ['url'],
      properties: {
        url: { type: 'string', pattern: '^https?://', description: 'http or https, ending in the file itself.' },
        name: { type: 'string' },
        type: { type: 'string', enum: ['image', 'video', 'audio'], description: 'Only needed when the extension does not say.' },
      },
    },
    // The route defaults a missing mime_type to image/jpeg, so the type is ALWAYS sent from here.
    call: { method: 'POST', path: '/api/content/remote', body: ['url', 'name', 'mime_type'] },
    check: (a) => (mediaMime(a.url, a.type) ? null
      : 'Cannot tell from the URL whether this is an image, a video or audio: pass `type`. For a web page use add_web_page.'),
    mapArgs: (a) => ({ url: a.url, name: a.name, mime_type: mediaMime(a.url, a.type) }),
    shape: shapeContent,
  },
  {
    name: 'create_playlist',
    scope: 'write',
    description: 'Create an empty playlist. Add items with add_to_playlist, then publish_playlist to push it to screens.',
    input: {
      type: 'object', required: ['name'],
      properties: { name: { type: 'string' }, description: { type: 'string' } },
    },
    call: { method: 'POST', path: '/api/playlists', body: ['name', 'description'] },
    shape: shapePlaylist,
  },
  {
    name: 'add_to_playlist',
    scope: 'write',
    description: 'Append a content item (content_id) or a web page widget (widget_id, from add_web_page) to a playlist — exactly one of the two. Changes are a DRAFT until publish_playlist is called. Corporate playlists are read-only; to add local content, add to the slot playlist named in the error.',
    input: {
      type: 'object', required: ['playlist_id'],
      properties: {
        playlist_id: { type: 'string' }, content_id: { type: 'string' },
        widget_id: { type: 'string', description: 'Instead of content_id: a widget, e.g. one add_web_page created.' },
        duration: { type: 'integer', minimum: 1, maximum: 86400, description: 'Seconds on screen. Defaults to the content’s own duration.' },
      },
    },
    check: (a) => (!!a.content_id === !!a.widget_id ? 'Pass exactly one of content_id or widget_id.' : null),
    /*
     * ⚠️ THE ROUTE READS duration_sec. The tool sent `duration`, which the route never looks at, so
     * every "show this for 20 seconds" silently got the content's default — a 200 with the wrong
     * value in it, the same failure as the report date range.
     */
    call: { method: 'POST', path: '/api/playlists/{playlist_id}/items', body: ['content_id', 'widget_id', 'duration_sec'] },
    mapArgs: (a) => ({ content_id: a.content_id, widget_id: a.widget_id, duration_sec: a.duration }),
    shape: (i) => ({ id: i.id, playlist_id: i.playlist_id, name: itemName(i), kind: itemKind(i),
      duration: i.content_duration ?? i.duration_sec ?? null }),
  },
  {
    name: 'remove_from_playlist',
    scope: 'full',
    description: 'Remove one item from a playlist. Still a draft until publish_playlist.',
    input: {
      type: 'object', required: ['playlist_id', 'item_id'],
      properties: { playlist_id: { type: 'string' }, item_id: { type: 'string' } },
    },
    call: { method: 'DELETE', path: '/api/playlists/{playlist_id}/items/{item_id}' },
  },
  {
    name: 'publish_playlist',
    scope: 'write',
    // ⚠️ The step people forget. Edits are a draft; screens keep playing the last published snapshot
    // until this runs, so an agent that adds items and stops has changed nothing anyone can see.
    description: 'Publish a playlist: snapshot the draft and push it to every screen using it. Nothing an agent changes appears on a screen until this is called. Corporate playlists are read-only; to add local content, add to the slot playlist named in the error.',
    input: { type: 'object', required: ['playlist_id'], properties: { playlist_id: { type: 'string' } } },
    call: { method: 'POST', path: '/api/playlists/{playlist_id}/publish' },
    shape: shapePlaylist,
  },
  {
    name: 'assign_playlist_to_display',
    scope: 'write',
    description: 'Put a playlist on one screen, replacing whatever it is showing now.',
    input: {
      type: 'object', required: ['playlist_id', 'display_id'],
      properties: { playlist_id: { type: 'string' }, display_id: { type: 'string' } },
    },
    call: { method: 'POST', path: '/api/playlists/{playlist_id}/assign', body: ['device_id'] },
    mapArgs: (a) => ({ device_id: a.display_id }),
  },
  {
    name: 'assign_playlist_to_group',
    scope: 'write',
    description: 'Put a playlist on every screen in a group, replacing what they are showing now.',
    input: {
      type: 'object', required: ['playlist_id', 'group_id'],
      properties: { playlist_id: { type: 'string' }, group_id: { type: 'string' } },
    },
    call: { method: 'POST', path: '/api/groups/{group_id}/assign-playlist', body: ['playlist_id'] },
  },
  {
    name: 'send_command',
    scope: 'write',
    description: 'Send an operational command to one screen: refresh it, blank or wake the panel, or set volume or brightness (value 0-100). What a given screen can honour depends on its platform.',
    input: {
      type: 'object', required: ['display_id', 'command'],
      properties: {
        display_id: { type: 'string' },
        // ⚠️ Exactly lib/device-command.js WRITE_SCOPE_COMMANDS — the set the route lets a `write`
        // token send. test/mcp.test.js holds the two together.
        command: { type: 'string', enum: ['refresh', 'screen_on', 'screen_off', 'set_volume', 'set_brightness'] },
        value: { type: 'integer', minimum: 0, maximum: 100, description: 'Percent, required for set_volume and set_brightness.' },
      },
    },
    check: commandValueCheck,
    call: { method: 'POST', path: '/api/devices/{display_id}/command', body: ['type', 'payload'] },
    mapArgs: commandArgs,
  },
  {
    name: 'send_group_command',
    scope: 'write',
    description: 'Send one operational command to every screen in a group: refresh, screen on/off, or volume or brightness (value 0-100).',
    input: {
      type: 'object', required: ['group_id', 'command'],
      properties: {
        group_id: { type: 'string' },
        command: { type: 'string', enum: ['refresh', 'screen_on', 'screen_off', 'set_volume', 'set_brightness'] },
        value: { type: 'integer', minimum: 0, maximum: 100, description: 'Percent, required for set_volume and set_brightness.' },
      },
    },
    check: commandValueCheck,
    call: { method: 'POST', path: '/api/groups/{group_id}/command', body: ['type', 'payload'] },
    mapArgs: commandArgs,
  },
  {
    name: 'rename_display',
    scope: 'write',
    description: 'Rename a screen. The name is what appears in the dashboard and in reports.',
    input: {
      type: 'object', required: ['display_id', 'name'],
      properties: { display_id: { type: 'string' }, name: { type: 'string' } },
    },
    call: { method: 'PUT', path: '/api/devices/{display_id}', body: ['name'] },
    // The answer is the whole device row; what the caller needs is that the rename took, and
    // whether the new name moved the screen into or out of a dynamic group.
    shape: (d) => (d && typeof d === 'object'
      ? { id: d.id, name: d.name, status: d.status, ...(d.groups_changed ? { groups_changed: d.groups_changed } : {}) }
      : d),
  },
];

/*
 * ⚠️ THE PLAYERS READ payload.level, A 0..1 FRACTION. The tools sent `value` at the top level, which
 * the route never forwards, so the panel received {"type":"set_volume","payload":{}} — and Android's
 * optDouble("level") on an empty payload is no change at best, while a player that read a missing
 * level as 0 muted the room. The tool takes a percentage because that is how people say it, and
 * converts here, exactly as the dashboard's slider does (device-detail.js bindLevel).
 */
const LEVEL_COMMANDS = ['set_volume', 'set_brightness'];
function commandArgs(a) {
  return { type: a.command, payload: LEVEL_COMMANDS.includes(a.command) ? { level: a.value / 100 } : undefined };
}
function commandValueCheck(a) {
  return LEVEL_COMMANDS.includes(a.command) && (a.value === undefined || a.value === null)
    ? `${a.command} needs a value: a percentage, 0-100.` : null;
}

/* Group membership, not devices.team_id (a team is a different thing): see routes/devices.js. */
function groupsOf(d) {
  const ids = Array.isArray(d.group_ids) ? d.group_ids : [];
  // group_id kept for clients written against the old field; it is the first group by name.
  return { group_ids: ids, group_id: ids[0] || null };
}

// A widget needs a name, and "https://intranet.example.com/menu" says more than "Web page".
function pageName(url) {
  try { const u = new URL(url); return (u.host + (u.pathname === '/' ? '' : u.pathname)).slice(0, 200); } catch (e) { return 'Web page'; }
}

/*
 * The mime type for a remote media URL: from the extension when there is one, else the family the
 * caller named. Null means "cannot tell", which the tool refuses rather than guessing JPEG.
 */
const MEDIA_EXT = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', mkv: 'video/mp4', avi: 'video/mp4', webm: 'video/webm',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp3: 'audio/mpeg', wav: 'audio/wav',
};
const MEDIA_DEFAULT = { image: 'image/jpeg', video: 'video/mp4', audio: 'audio/mpeg' };
function mediaMime(url, type) {
  let ext = null;
  try { ext = (new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i) || [])[1]; } catch (e) { /* not a URL */ }
  const byExt = ext ? MEDIA_EXT[ext.toLowerCase()] : null;
  if (byExt && (!type || byExt.startsWith(type + '/'))) return byExt;
  return (type && MEDIA_DEFAULT[type]) || null;
}

/*
 * Every string argument gets a length cap, declared IN the published schema so a client can see it.
 * The QA run sent 100k-500k character names; the API stored them. Ids are 64 (a UUID is 36), URLs
 * 2048, a description 1000, anything else — names, search terms, dates — 200.
 */
function defaultMaxLength(key) {
  if (key === 'id' || key.endsWith('_id')) return 64;
  if (key === 'url') return 2048;
  if (key === 'description') return 1000;
  return 200;
}
for (const t of TOOLS) {
  for (const [key, prop] of Object.entries(t.input.properties || {})) {
    if (prop.type === 'string' && prop.maxLength === undefined) prop.maxLength = defaultMaxLength(key);
  }
}

/*
 * Check a call's arguments against the tool's OWN published schema, before any request is made.
 *
 * ⚠️ THE SCHEMA WAS DECORATION. Nothing enforced it, so `command: "shell"` reached the API although
 * the enum lists five values (the API's scope gate refused it, but that is the wrong layer to be the
 * only one); a numeric `search` crashed the shape with "toLowerCase is not a function"; an array
 * `name` made create_playlist answer 500. A model reads the schema as a promise and so should we.
 *
 * Returns null when the arguments are acceptable, else one sentence naming the first problem —
 * which the transport answers as JSON-RPC -32602, invalid params. Optional arguments sent as null
 * are treated as absent: models do that constantly, and refusing it helps nobody.
 */
function validate(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be a JSON object';
  const props = tool.input.properties || {};
  for (const r of tool.input.required || []) {
    if (args[r] === undefined || args[r] === null || args[r] === '') return `missing required argument: ${r}`;
  }
  for (const [key, prop] of Object.entries(props)) {
    const v = args[key];
    if (v === undefined || v === null) continue;
    if (prop.type === 'string') {
      if (typeof v !== 'string') return `${key} must be a string`;
      if (prop.maxLength !== undefined && v.length > prop.maxLength) return `${key} is longer than ${prop.maxLength} characters`;
      if (prop.pattern && !new RegExp(prop.pattern).test(v)) return `${key} must match ${prop.pattern}`;
    } else if (prop.type === 'integer') {
      if (!Number.isInteger(v)) return `${key} must be an integer`;
    } else if (prop.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) return `${key} must be a number`;
    } else if (prop.type === 'boolean') {
      if (typeof v !== 'boolean') return `${key} must be true or false`;
    }
    if (prop.enum && !prop.enum.includes(v)) return `${key} must be one of: ${prop.enum.join(', ')}`;
    if (prop.minimum !== undefined && v < prop.minimum) return `${key} must be at least ${prop.minimum}`;
    if (prop.maximum !== undefined && v > prop.maximum) return `${key} must be at most ${prop.maximum}`;
  }
  return tool.check ? tool.check(args) : null;
}

const SCOPE_RANK = { read: 1, write: 2, full: 3 };

/* Which tools a token may see. ⚠️ FILTERED, not refused: a read-only token is never shown a write
 * tool, so an agent holding one does not spend its turns discovering what it is not allowed to do. */
function toolsForScope(scope) {
  const have = SCOPE_RANK[scope] || 0;
  return TOOLS.filter((t) => (SCOPE_RANK[t.scope] || 99) <= have);
}

/*
 * ⚠️ A PLAYLIST ROW IS NOT AN ANSWER, AND IT CARRIES THE PLAYLIST TWICE.
 *
 * get_playlist and publish_playlist answered with the raw row: `items` with every storage column,
 * plus `published_snapshot` AND `published_structure`, which are serialised copies of the same
 * playlist. Measured on a ONE-item playlist: 2,397 bytes, of which 794 are the two duplicates and ~51
 * are the item detail a model asked for. Both duplicates grow with the item count, so the bigger the
 * playlist the worse the ratio — and a model that reads the snapshot instead of `items` is reading the
 * LAST PUBLISHED version while being asked about the draft, which is the one distinction the tool
 * instructions go out of their way to explain.
 */
const itemName = (i) => i.filename || i.child_playlist_name || i.widget_name || (i.slot_id && i.slot && i.slot.name) || null;
// A head office local slot is a placeholder the stores fill, not content of its own.
const itemKind = (i) => (i.slot_id ? 'slot' : i.child_playlist_id ? 'playlist' : (i.widget_id ? 'widget' : 'content'));

function shapePlaylist(p) {
  if (!p || typeof p !== 'object') return p;
  const items = Array.isArray(p.items) ? p.items : [];
  return {
    id: p.id,
    name: p.name,
    description: p.description || null,
    // draft vs published is the distinction that decides whether anybody can SEE the change.
    status: p.status,
    playback_order: p.playback_order,
    // Head office: a corporate playlist is read-only to anyone but its authors (the server refuses
    // with a sentence naming why); a store's slot content says which slot it fills.
    ...(p.corporate ? { corporate: true } : {}),
    ...(p.corporate_slot ? { corporate_slot: { slot_name: p.corporate_slot.slot_name, corporate_playlist: p.corporate_slot.playlist_name } } : {}),
    item_count: items.length,
    items: items.map((i) => ({
      id: i.id,
      name: itemName(i),
      kind: itemKind(i),
      ...(i.slot_id ? { slot_id: i.slot_id } : {}),
      ...(p.corporate ? { locked: true } : {}),
      duration: i.content_duration ?? i.duration_sec ?? null,
      ...(i.enabled === 0 ? { enabled: false } : {}),
      ...(i.play_from || i.play_until ? { play_from: i.play_from || null, play_until: i.play_until || null } : {}),
      ...(i.orphan ? { orphan: true } : {}),
    })),
  };
}

/* A content row the same way: what it is called and what it is, not where its bytes live. */
function shapeContent(c) {
  if (!c || typeof c !== 'object') return c;
  return {
    id: c.id,
    name: c.filename,
    type: c.mime_type,
    duration: c.duration_sec ?? null,
    folder: c.folder_id || null,
    ...(c.remote_url ? { url: c.remote_url } : {}),
  };
}

/* A playlist LIST row: the counts the list query computes, none of the snapshots. */
function shapePlaylistRow(p) {
  if (!p || typeof p !== 'object') return p;
  return {
    id: p.id,
    name: p.name,
    description: p.description || null,
    status: p.status,
    item_count: p.item_count ?? 0,
    display_count: p.display_count ?? 0,
    ...(p.smart_rules ? { smart: true } : {}),
    ...(p.corporate ? { corporate: true } : {}),
    ...(p.corporate_slot ? { corporate_slot: { slot_name: p.corporate_slot.slot_name, corporate_playlist: p.corporate_slot.playlist_name } } : {}),
  };
}

/* A widget row (add_web_page): what it is and where it points. config arrives as a JSON string. */
function shapeWidget(w) {
  if (!w || typeof w !== 'object') return w;
  let config = w.config;
  if (typeof config === 'string') { try { config = JSON.parse(config); } catch (e) { config = {}; } }
  return {
    widget_id: w.id,
    name: w.name,
    kind: 'widget',
    type: w.widget_type,
    ...(config && config.url ? { url: config.url } : {}),
  };
}

/*
 * ⚠️ NOTHING CREDENTIAL-SHAPED REACHES A MODEL, and this is enforced HERE rather than in each tool.
 *
 * `rename_display` had no shape, so it answered with the raw device row — eighty columns including a
 * live `settings_pin`, which is the number 2.2.0 made load-bearing for the Esc-unpair gate on the web
 * player. An agent that renamed a screen was handed the PIN that unpairs it, in its context, its
 * transcript, and whatever logs either. `get_display` strips secrets and has a test saying so, but
 * that guard only ever covered one tool out of twenty-one.
 *
 * A per-tool shape cannot be the security boundary: the next tool added without one reopens it. This
 * runs over every result, and the name pattern is the same one mesh replication uses to decide what
 * never leaves for a replica — one definition, in lib/secret-names.js.
 */
const { isSecretName } = require('../secret-names');

function redact(value, depth = 0) {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (isSecretName(k)) continue;
    out[k] = redact(v, depth + 1);
  }
  return out;
}

/* The MCP wire shape. Names and descriptions are the entire basis on which a model picks a tool, so
 * they say what the thing is FOR, not which endpoint it calls. */
function manifest(scope) {
  return toolsForScope(scope).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input,
    annotations: {
      readOnlyHint: t.scope === 'read',
      destructiveHint: t.scope === 'full',
    },
  }));
}

function byName(name) {
  return TOOLS.find((t) => t.name === name) || null;
}

/*
 * Turn a tool call into an HTTP request against our own API.
 *
 * ⚠️ Path parameters are URL-ENCODED. An id arrives from a model, which means it can be anything at
 * all — and an unencoded one containing a slash would silently address a different endpoint than the
 * catalogue says this tool calls.
 */
function toRequest(tool, args = {}) {
  const mapped = tool.mapArgs ? tool.mapArgs(args) : args;
  const path = tool.call.path.replace(/\{(\w+)\}/g, (_m, key) => {
    const v = args[key];
    if (v === undefined || v === null || v === '') throw new Error(`missing required argument: ${key}`);
    return encodeURIComponent(String(v));
  });
  const query = {};
  for (const k of tool.call.query || []) {
    if (mapped[k] !== undefined && mapped[k] !== null && mapped[k] !== '') query[k] = String(mapped[k]);
  }
  let body;
  if (tool.call.body) {
    body = {};
    for (const k of tool.call.body) if (mapped[k] !== undefined) body[k] = mapped[k];
  }
  return { method: tool.call.method, path, query, body };
}

module.exports = { TOOLS, toolsForScope, manifest, byName, toRequest, validate, redact, SCOPE_RANK };
