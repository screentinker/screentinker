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
      .filter((d) => !args.search || String(d.name || '').toLowerCase().includes(args.search.toLowerCase()))
      .map((d) => ({
        id: d.id, name: d.name, status: d.status, platform: d.platform || d.client_type || null,
        last_heartbeat: d.last_heartbeat ? new Date(d.last_heartbeat * 1000).toISOString() : null,
        playlist_id: d.playlist_id || null, group_id: d.team_id || null,
      })),
  },
  {
    name: 'get_display',
    scope: 'read',
    description: 'Full detail for one screen: telemetry, what it is playing, resolution, app version and schedule.',
    input: { type: 'object', required: ['display_id'], properties: { display_id: { type: 'string' } } },
    call: { method: 'GET', path: '/api/devices/{display_id}' },
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
    description: 'List the playlists in this workspace, with how many items each holds and whether it has unpublished changes.',
    input: { type: 'object', properties: {} },
    call: { method: 'GET', path: '/api/playlists' },
  },
  {
    name: 'get_playlist',
    scope: 'read',
    description: 'A playlist with its items in order, including each item duration and any per-item schedule.',
    input: { type: 'object', required: ['playlist_id'], properties: { playlist_id: { type: 'string' } } },
    call: { method: 'GET', path: '/api/playlists/{playlist_id}' },
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
    shape: (rows, args) => (Array.isArray(rows) ? rows : [])
      .filter((c) => !args.search || String(c.name || '').toLowerCase().includes(args.search.toLowerCase()))
      .map((c) => ({ id: c.id, name: c.name, type: c.type, duration: c.duration ?? null, folder: c.folder_id || null })),
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
    input: { type: 'object', properties: { display_id: { type: 'string', description: 'Restrict to one screen.' } } },
    call: { method: 'GET', path: '/api/schedules' },
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
    call: { method: 'GET', path: '/api/reports/summary', query: ['from', 'to', 'device_id'] },
    mapArgs: (a) => ({ from: a.from, to: a.to, device_id: a.display_id }),
  },
  {
    name: 'uptime_report',
    scope: 'read',
    description: 'How much of the period each screen was online. Answers "which screen keeps dropping out".',
    input: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 90 } } },
    call: { method: 'GET', path: '/api/reports/uptime', query: ['days'] },
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
  },
  {
    name: 'add_web_page',
    scope: 'write',
    description: 'Add a web page or remote image/video URL to the media library.',
    input: {
      type: 'object', required: ['url'],
      properties: { url: { type: 'string' }, name: { type: 'string' } },
    },
    call: { method: 'POST', path: '/api/content/remote', body: ['url', 'name'] },
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
  },
  {
    name: 'add_to_playlist',
    scope: 'write',
    description: 'Append a content item to a playlist. Changes are a DRAFT until publish_playlist is called.',
    input: {
      type: 'object', required: ['playlist_id', 'content_id'],
      properties: {
        playlist_id: { type: 'string' }, content_id: { type: 'string' },
        duration: { type: 'integer', description: 'Seconds on screen. Defaults to the content’s own duration.' },
      },
    },
    call: { method: 'POST', path: '/api/playlists/{playlist_id}/items', body: ['content_id', 'duration'] },
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
    description: 'Publish a playlist: snapshot the draft and push it to every screen using it. Nothing an agent changes appears on a screen until this is called.',
    input: { type: 'object', required: ['playlist_id'], properties: { playlist_id: { type: 'string' } } },
    call: { method: 'POST', path: '/api/playlists/{playlist_id}/publish' },
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
    description: 'Send an operational command to one screen: refresh it, blank or wake the panel, or set volume. What a given screen can honour depends on its platform.',
    input: {
      type: 'object', required: ['display_id', 'command'],
      properties: {
        display_id: { type: 'string' },
        command: { type: 'string', enum: ['refresh', 'screen_on', 'screen_off', 'set_volume', 'set_brightness'] },
        value: { type: 'integer', description: '0-100, for set_volume and set_brightness.' },
      },
    },
    call: { method: 'POST', path: '/api/devices/{display_id}/command', body: ['type', 'value'] },
    mapArgs: (a) => ({ type: a.command, value: a.value }),
  },
  {
    name: 'send_group_command',
    scope: 'write',
    description: 'Send one operational command to every screen in a group.',
    input: {
      type: 'object', required: ['group_id', 'command'],
      properties: {
        group_id: { type: 'string' },
        command: { type: 'string', enum: ['refresh', 'screen_on', 'screen_off', 'set_volume', 'set_brightness'] },
        value: { type: 'integer' },
      },
    },
    call: { method: 'POST', path: '/api/groups/{group_id}/command', body: ['type', 'value'] },
    mapArgs: (a) => ({ type: a.command, value: a.value }),
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
  },
];

const SCOPE_RANK = { read: 1, write: 2, full: 3 };

/* Which tools a token may see. ⚠️ FILTERED, not refused: a read-only token is never shown a write
 * tool, so an agent holding one does not spend its turns discovering what it is not allowed to do. */
function toolsForScope(scope) {
  const have = SCOPE_RANK[scope] || 0;
  return TOOLS.filter((t) => (SCOPE_RANK[t.scope] || 99) <= have);
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

module.exports = { TOOLS, toolsForScope, manifest, byName, toRequest, SCOPE_RANK };
