const API_BASE = '/api';

function getAuthHeaders() {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/*
 * ⚠️ WHEN A REMOTE ORG IS SELECTED, READS GO TO THAT SERVER — transparently, so a view does not
 * have to know. That is what "a linked server behaves exactly like a local one" has to mean in
 * practice: the alternative is every view growing an `if (remote)` branch, and the branches that
 * get forgotten are the ones that quietly show local data under a remote heading.
 *
 * ⚠️ ONLY DATA PATHS ARE REDIRECTED. Anything about THIS server or THIS session — signing in, the
 * account, the workspace list, the mesh routes themselves — must stay local, or selecting a
 * customer would log you into their server. Those live in ALWAYS_LOCAL below, and that list is
 * exhaustive: anything not on it is either routed to the customer or refused, never quietly served
 * from here.
 *
 * ⚠️ WRITES ARE NEVER REDIRECTED, and are refused outright while a remote org is selected. Sending
 * them locally would be far worse than failing: an edit meant for a customer's screen would land
 * silently on one of your own.
 */
const REMOTE_READABLE = ['/devices', '/assignments/device/', '/groups', '/playlists'];

/*
 * ⚠️ WORKSPACE DATA WE CANNOT YET READ REMOTELY, AND MUST NOT SERVE LOCALLY.
 *
 * This is the failure mode the allowlist above would otherwise create: a path that is not routed
 * falls through to the local server, so viewing a customer's org would render YOUR content library
 * inside THEIR device page — with nothing on screen to say so. That is worse than an error, because
 * it looks right.
 *
 * Resolved as empty rather than thrown: these feed pickers and side panels, and a rejection there
 * takes the whole page down over a list nobody can act on in a read-only view anyway.
 */
const REMOTE_UNAVAILABLE = ['/content', '/walls', '/schedules', '/widgets', '/layouts'];

/*
 * ⚠️ PATHS ABOUT *THIS* SERVER AND *THIS* SESSION — always local, whatever is selected.
 *
 * Signing in, the account, the workspace list, billing, and the mesh routes themselves. Routing any
 * of these at a customer's server would try to log you into it; refusing them would lock you out of
 * your own session the moment you looked at a customer. They are neither remote data nor forbidden
 * — they are simply not about the org being viewed.
 *
 * ⚠️ THIS LIST IS THE ONLY WAY A WRITE STAYS LOCAL while a remote org is selected. Everything else
 * is refused (see remoteRoute), so adding a prefix here is granting it the right to be written on
 * your own server while your screen says you are looking at someone else's. Add only session and
 * server-scoped routes, never org data.
 */
const ALWAYS_LOCAL = ['/auth', '/admin', '/workspaces', '/tokens', '/subscription', '/provision', '/ai', '/mesh'];

/*
 * Segment-exact: '/devices' matches '/devices' and '/devices/x', never '/devices-archive'. The
 * original used a bare startsWith, so a route named as a superstring of an allowlisted one would
 * have been routed remotely by accident.
 */
function underPrefix(path, prefix) {
  return path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : prefix + '/');
}

/*
 * Mirrors server/lib/mesh/write-proxy.js WRITABLE. Segment-exact, method pinned per rule.
 * ⚠️ NOT a security boundary — see the note at its only call site.
 */
const MESH_WRITABLE = [
  { pattern: '/playlists',                     method: 'POST' },
  { pattern: '/playlists/:id',                 method: 'PUT' },
  { pattern: '/playlists/:id/items',           method: 'POST' },
  { pattern: '/playlists/:id/items/:itemId',   method: 'PUT' },
  { pattern: '/playlists/:id/items/:itemId',   method: 'DELETE' },
  { pattern: '/playlists/:id/publish',         method: 'POST' },
  { pattern: '/playlists/:id/assign',          method: 'POST' },
];

function meshWritable(path, verb) {
  const got = path.split('/');
  return MESH_WRITABLE.some((rule) => {
    if (rule.method !== verb) return false;
    const want = rule.pattern.split('/');
    if (want.length !== got.length) return false;
    return want.every((seg, i) => (seg.startsWith(':') ? !!got[i] : seg === got[i]));
  });
}

function remoteOrg() {
  try { return JSON.parse(localStorage.getItem('st_remote_org') || 'null'); } catch (e) { return null; }
}

/*
 * ⚠️ THE DEFAULT IS "NOT AVAILABLE", NOT "LOCAL". THIS INVERSION IS THE WHOLE POINT.
 *
 * It used to read: anything unlisted falls through to the local server. That is safe only for the
 * four prefixes somebody remembered to list, and every route added afterwards inherited the wrong
 * default — silently, because a local answer always looks like a real one. Three live consequences,
 * all found in review of shipped code:
 *
 *   - GET /folders was in neither list, so a customer's content library rendered YOUR folder tree.
 *   - POST/DELETE /folders created and DELETED folders on YOUR OWN server while the screen said
 *     you were looking at a customer. Destructive, silent, wrong server.
 *   - Writes to an UNAVAILABLE path returned {empty:true} BEFORE the method was examined, so
 *     deleting a customer's content resolved as [] — the UI reported success and nothing happened
 *     on any server at all.
 *
 * So: session routes stay local, every other write is refused, and every unrouted read is empty.
 * A route added later is now unavailable-until-routed instead of local-until-noticed, which fails
 * towards an empty panel rather than towards someone else's data.
 */
function remoteRoute(url, method) {
  const org = remoteOrg();
  if (!org) return null;
  const path = String(url).split('?')[0];
  const verb = (method || 'GET').toUpperCase();

  if (ALWAYS_LOCAL.some((p) => underPrefix(path, p))) return null;

  if (verb !== 'GET') {
    /*
     * ⚠️ THIS IS WHERE A COMMAND GOES TO THE CUSTOMER'S SERVER INSTEAD OF OURS.
     *
     * A write reaches the other node only if all three hold: the customer granted this hub write
     * access (org.writable, which comes from what the CHILD announced — never from anything we
     * decided), the path is one the child's own allowlist accepts, and the method matches. Anything
     * else is refused exactly as before.
     *
     * ⚠️ The allowlist here is a MIRROR of server/lib/mesh/write-proxy.js and is not the
     * enforcement. Its only job is to avoid sending a request that will certainly be refused; the
     * copy that matters is on the machine that owns the screens, it is checked live per request,
     * and it wins. If the two drift, the child simply refuses and the operator sees why — which is
     * the correct direction for a client-side list to be wrong in.
     */
    if (org.writable && meshWritable(path, verb)) {
      return { write: true, nodeId: org.nodeId, path: '/api' + path, method: verb };
    }
    return { refuse: 'This server is being viewed read-only. Switch back to make changes.' };
  }

  if (REMOTE_UNAVAILABLE.some((p) => underPrefix(path, p))) return { empty: true };
  if (!REMOTE_READABLE.some((p) => underPrefix(path, p))) return { empty: true };
  return { url: `/mesh/read/${encodeURIComponent(org.nodeId)}?path=${encodeURIComponent('/api' + url)}` };
}

/*
 * ⚠️ FOR CALLERS THAT DO NOT GO THROUGH request().
 *
 * Several views (designer, widgets, video-wall, schedule, layout-editor) define their own fetch
 * helper straight to /api, and the content library reaches for bare fetch in three places. Those
 * bypass every rule above, which is how they stayed pointed at the LOCAL server while the screen
 * said a customer's — reading your data under their heading and writing your data on their behalf.
 *
 * Throws rather than resolving empty: request() can return [] because it feeds pickers that cope
 * with an empty list, but a raw caller has no such contract and would treat a silent [] as a real
 * answer. A visible error is the honest outcome for a view that cannot work remotely yet.
 */
export function assertLocalCallAllowed(url, method) {
  const routed = remoteRoute(url, method);
  if (!routed) return;
  throw new Error(routed.refuse
    || 'That is not available while you are viewing a linked server. Switch back to your own.');
}

/*
 * Send one change to a customer's server and report honestly what happened to it.
 *
 * ⚠️ THE OPERATION ID MUST SURVIVE A RETRY, and that is the whole reason this is a function rather
 * than a fetch inline. The child records the outcome against the id and REPLAYS it rather than
 * applying twice, so re-issuing with a fresh id on a timeout is precisely how an operator ends up
 * with the same item in a playlist twice. The route mints an id per request body and echoes it
 * back; the retry below reuses the one it was given.
 *
 * Three answers matter and they need three different things from a person:
 *   503 not connected — nothing happened, try later
 *   504 no acknowledgement — it MAY have applied; retry with the same id to find out which
 *   403 refused — the customer has not granted this, and no retry will help
 */
async function meshWrite(routed, options) {
  const body = options.body ? JSON.parse(options.body) : undefined;
  const send = (opId) => fetch(`${API_BASE}/mesh/write/${encodeURIComponent(routed.nodeId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ path: routed.path, method: routed.method, body, ...(opId ? { opId } : {}) }),
  });

  let res = await send();
  let payload = await res.json().catch(() => ({}));

  /*
   * ⚠️ ONE automatic retry, and ONLY on 504, and ONLY with the id we were given. A 504 means the
   * answer is unknown rather than no — and because the child replays a recorded outcome, asking
   * again with the same id is safe and is the only way to learn which it was. Retrying anything
   * else, or retrying twice, turns an unknown into a second write.
   */
  if (res.status === 504 && payload.retryWithSameOpId && payload.opId) {
    res = await send(payload.opId);
    payload = await res.json().catch(() => ({}));
  }

  if (!res.ok) {
    const err = new Error(payload.error || 'That server did not accept the change.');
    err.status = res.status;
    err.opId = payload.opId;
    // Surfaced so a caller can say "may have applied" rather than "failed", which are different
    // things to tell somebody standing in front of a screen.
    err.indeterminate = res.status === 504;
    throw err;
  }
  return payload.result ?? payload;
}

async function request(url, options = {}) {
  const routed = remoteRoute(url, options.method);
  if (routed && routed.refuse) throw new Error(routed.refuse);
  if (routed && routed.empty) return [];
  if (routed && routed.write) return meshWrite(routed, options);
  if (routed) {
    const r = await fetch(API_BASE + routed.url, {
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || 'That server did not answer');
    }
    const body = await r.json();
    /*
     * ⚠️ Unwrapped to the shape the caller expects. The proxy envelope is a transport detail; a view
     * asking for devices should get devices, not { ok, rows }, or every caller learns about the
     * mesh and the transparency is lost.
     */
    return body.rows !== undefined ? body.rows : (body.row !== undefined ? body.row : body);
  }

  const res = await fetch(API_BASE + url, {
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders(), ...options.headers },
    ...options,
  });
  if (res.status === 401) {
    // Token expired or invalid - redirect to login
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.hash = '#/login';
    window.location.reload();
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

/*
 * #329: is a mesh route worth calling at all?
 *
 * The mesh routers are mounted CONDITIONALLY, and the dashboard used to discover that by calling
 * them and reading the 404 — on every sidebar render and every /me refresh. /me now states it
 * outright (server/routes/auth.js), and this reads the cached answer.
 *
 * `undefined` is NOT `false`: a cached user from before this shipped, or a server that predates it,
 * says nothing either way. Those fall through to `null`, and callers keep the old probe-and-catch
 * path, so an older server still lights up its Servers nav correctly.
 */
export function meshCapability(which) {
  let u;
  try { u = JSON.parse(localStorage.getItem('user') || 'null'); } catch (_) { return null; }
  if (!u || !u.mesh || typeof u.mesh[which] !== 'boolean') return null;
  return u.mesh[which];
}

export const api = {
  /*
   * ⚠️ GENERIC VERBS. Everything else here is a named helper, which is the right shape for a
   * long-lived endpoint — but the mesh routes are mounted CONDITIONALLY, and a named helper per
   * route would imply a surface that is usually not there.
   *
   * These were missing while views/servers.js already called api.get(), so the whole Servers
   * section threw "api.get is not a function" on first render and had never worked in a browser.
   * The tests around it assert on the view's SOURCE, so they confirmed it said the right things
   * without ever executing it — see test/frontend-api-contract.test.js, which now checks that every
   * api.X() a view calls actually exists here.
   */
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),

  // Triggers: the listener settings, and the secret. Separate calls because they are separate
  // decisions — rotating the credential that lets a LAN datagram change a screen must not be a
  // side effect of editing a port number.
  setTriggerConfig: (deviceId, body) => request(`/devices/${deviceId}/trigger-config`,
    { method: 'POST', body: JSON.stringify(body ?? {}) }),
  setTriggerSecret: (deviceId, body) => request(`/devices/${deviceId}/trigger-secret`,
    { method: 'POST', body: JSON.stringify(body ?? {}) }),
  put: (path, body) => request(path, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
  patch: (path, body) => request(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
  delete: (path) => request(path, { method: 'DELETE' }),

  /*
   * Multipart POST for anything that is not content.
   *
   * ⚠️ CHECKS remoteRoute FIRST, which is the duty the uploadContent comment above names: a helper
   * that reaches for fetch or XHR directly bypasses the routing layer, and every upload made while
   * viewing a customer's server would land silently in YOUR OWN workspace under a heading that said
   * theirs. It happened once with content; this is the same shape.
   *
   * ⚠️ No Content-Type header is set, deliberately. FormData must set its own, including the
   * multipart boundary — supplying one produces a request the server cannot parse and an error that
   * points nowhere near the cause.
   */
  postForm: async (path, formData) => {
    const routed = remoteRoute(path, 'POST');
    if (routed && routed.refuse) throw new Error(routed.refuse);
    const token = localStorage.getItem('token');
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
    if (!res.ok) throw new Error((body && body.error) || `Upload failed (${res.status})`);
    return body;
  },

  // Devices
  getDevices: () => request('/devices'),
  reorderDevices: (order) => request('/devices/reorder', { method: 'POST', body: JSON.stringify({ order }) }),
  getDevice: (id) => request(`/devices/${id}`),
  getDeviceOwnerQR: () => request('/provision/device-owner-qr'),   // #161: device-owner provisioning
  updateDevice: (id, data) => request(`/devices/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteDevice: (id) => request(`/devices/${id}`, { method: 'DELETE' }),
  // #146 Item D: operator block/unblock — refuses the device at its next register with
  // no restart. Server enforces via the SNAT-safe identity chain (deviceSocket).
  blockDevice: (id) => request(`/devices/${id}/block`, { method: 'POST' }),
  unblockDevice: (id) => request(`/devices/${id}/unblock`, { method: 'POST' }),
  // #150: fingerprint-keyed settings snapshots of previously-removed devices (this workspace),
  // and the re-adopt action that applies a snapshot onto a newly-paired device.
  getRemovedDevices: () => request('/devices/removed'),
  reAdoptDevice: (id, fingerprint) => request(`/devices/${id}/re-adopt`, { method: 'POST', body: JSON.stringify({ fingerprint }) }),
  setDevicePin: (id, body) => request(`/devices/${id}/settings-pin`, { method: 'POST', body: JSON.stringify(body) }),

  // #109 PiP overlay: push/clear a floating overlay on a device or group. `id` may be a
  // device id OR a group id (the server resolves + expands). Needs full scope (no-op for JWT).
  sendPip: (id, opts) => request('/pip', { method: 'POST', body: JSON.stringify({ device_id: id, ...opts }) }),
  clearPip: (id, pipId) => request('/pip/clear', { method: 'POST', body: JSON.stringify({ device_id: id, pip_id: pipId || undefined }) }),

  // Provisioning
  pairDevice: (pairing_code, name) => request('/provision/pair', {
    method: 'POST',
    body: JSON.stringify({ pairing_code, name })
  }),

  // Content
  getContent: (folderId, includeExpired = false, opts = {}) => {
    const p = new URLSearchParams();
    // #214: a text search spans the whole workspace, so folder_id is only sent when
    // NOT searching (the server also ignores folder_id when q is present, but keeping
    // the client in sync avoids a misleading URL).
    const searching = opts.q && opts.q.trim();
    if (!searching && folderId !== undefined) p.set('folder_id', folderId === null ? 'root' : folderId);
    if (includeExpired) p.set('include_expired', '1');
    if (searching) p.set('q', opts.q.trim());
    if (opts.type && opts.type !== 'all') p.set('type', opts.type);
    if (opts.sort) p.set('sort', opts.sort);
    const qs = p.toString();
    return request(`/content${qs ? '?' + qs : ''}`);
  },
  getContentItem: (id) => request(`/content/${id}`),
  deleteContent: (id) => request(`/content/${id}`, { method: 'DELETE' }),
  updateContent: (id, data) => request(`/content/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  moveContent: (id, folderId) => request(`/content/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ folder_id: folderId })
  }),
  // #213: batch operations — the whole batch succeeds or fails atomically server-side.
  batchDeleteContent: (ids) => request('/content/batch/delete', {
    method: 'POST',
    body: JSON.stringify({ ids })
  }),
  batchMoveContent: (ids, folderId) => request('/content/batch/move', {
    method: 'POST',
    body: JSON.stringify({ ids, folder_id: folderId || null })
  }),

  // Folders
  getFolders: () => request('/folders'),
  createFolder: (name, parentId) => request('/folders', {
    method: 'POST',
    body: JSON.stringify({ name, parent_id: parentId || null })
  }),
  renameFolder: (id, name) => request(`/folders/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ name })
  }),
  moveFolder: (id, parentId) => request(`/folders/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ parent_id: parentId || null })
  }),
  deleteFolder: (id) => request(`/folders/${id}`, { method: 'DELETE' }),
  // #212: accepts a single File or an array/FileList of Files. All go up in one request
  // under the `files` field (the server also still accepts the legacy `file` field).
  // onProgress reports aggregate percent across the whole batch. Resolves to the content
  // object for a single file, or an array of them for a batch.
  uploadContent: async (file, onProgress, folderId) => {
    /*
     * ⚠️ THIS ONE DOES NOT GO THROUGH request(), SO IT NEEDS ITS OWN GUARD.
     *
     * It is a raw XHR because it needs upload progress events, which fetch cannot give. That also
     * means it bypasses remoteRoute entirely — so before this check, every upload made while
     * viewing a customer landed silently in YOUR OWN library, under a heading that said theirs.
     * Any other helper that reaches for XHR or bare fetch inherits the same duty.
     */
    const routed = remoteRoute('/content', 'POST');
    if (routed && routed.refuse) throw new Error(routed.refuse);

    const wasBatch = (file instanceof FileList || Array.isArray(file));
    const files = wasBatch ? Array.from(file) : [file];

    /*
     * #317: send them in batches rather than all in one request.
     *
     * Somebody tried to upload 160 photos from a company party, got an error with no number in it,
     * and ended up dragging them in sixteen at a time. The server capped one request's file count,
     * and the whole selection went up as a single multipart body — so the cap was also a wall the
     * dashboard walked straight into. Chunking here means the person never meets it: the number
     * below only has to stay under the server's own limit, and a batch that is small enough to
     * report progress in more than one step is friendlier anyway. Sequential on purpose — parallel
     * requests would race the storage-limit check and make progress meaningless.
     */
    const CHUNK = 20;
    const chunks = [];
    for (let i = 0; i < files.length; i += CHUNK) chunks.push(files.slice(i, i + CHUNK));

    const totalBytes = files.reduce((n, f) => n + (f && f.size ? f.size : 0), 0) || 1;
    let doneBytes = 0;

    const sendChunk = (batch) => new Promise((resolve, reject) => {
      const formData = new FormData();
      for (const f of batch) formData.append('files', f);
      if (folderId) formData.append('folder_id', folderId);

      const batchBytes = batch.reduce((n, f) => n + (f && f.size ? f.size : 0), 0);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}/content`);
      const token = localStorage.getItem('token');
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      if (onProgress) {
        // Progress spans the WHOLE selection, not the current request, or a 160-file upload would
        // run 0->100% eight times over.
        xhr.upload.onprogress = (e) => {
          if (!e.lengthComputable) return;
          const sent = doneBytes + (e.loaded / e.total) * batchBytes;
          onProgress(Math.min(99, Math.round((sent / totalBytes) * 100)));
        };
      }
      xhr.onload = () => {
        /*
         * ⚠️ THE SERVER'S OWN WORDS, OR THE CALLER LEARNS NOTHING.
         *
         * This used to reject with a flat "Upload failed" for every non-2xx, throwing away the one
         * thing the person needs: WHY. The server is specific — "Unsupported file type — only image
         * and video files are accepted", a storage-limit refusal, "Switch to a workspace before
         * uploading" — and all of it was replaced with a shrug, which is how a refused upload
         * becomes "it just doesn't work".
         */
        if (xhr.status >= 200 && xhr.status < 300) {
          try { return resolve(JSON.parse(xhr.responseText)); }
          catch (e) { return reject(new Error('Upload succeeded but the response could not be read')); }
        }
        let msg = '';
        try { msg = (JSON.parse(xhr.responseText) || {}).error || ''; } catch (e) { msg = ''; }
        reject(new Error(msg || `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('Upload failed'));
      xhr.send(formData);
    });

    const out = [];
    for (let i = 0; i < chunks.length; i++) {
      let res;
      try {
        res = await sendChunk(chunks[i]);
      } catch (err) {
        // Say what already landed. Silently discarding that is how someone re-uploads 140 photos
        // they already have, or assumes none of them arrived.
        if (out.length) {
          throw new Error(`${err.message} (${out.length} of ${files.length} file${files.length === 1 ? '' : 's'} were uploaded before this failed)`);
        }
        throw err;
      }
      if (Array.isArray(res)) out.push(...res); else out.push(res);
      doneBytes += chunks[i].reduce((n, f) => n + (f && f.size ? f.size : 0), 0);
      if (onProgress) onProgress(Math.min(99, Math.round((doneBytes / totalBytes) * 100)));
    }
    if (onProgress) onProgress(100);

    // Unchanged contract: one content object for a single file, an array for a batch.
    return wasBatch ? out : out[0];
  },

  addRemoteContent: (url, name, mime_type) => request('/content/remote', {
    method: 'POST',
    body: JSON.stringify({ url, name, mime_type })
  }),

  addYoutubeContent: (url, name) => request('/content/youtube', {
    method: 'POST',
    body: JSON.stringify({ url, name })
  }),

  // Assignments
  getAssignments: (deviceId) => request(`/assignments/device/${deviceId}`),
  addAssignment: (deviceId, data) => request(`/assignments/device/${deviceId}`, {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  // deviceId says WHICH screen is being edited. These endpoints are addressed by item, and a shared
  // playlist has many screens, so without it an edit on a screen that inherits its playlist changes
  // that item for every screen in the group. With it, the server forks first (see
  // server/lib/fork-device-playlist.js). Optional: the playlist page edits items where they live.
  updateAssignment: (id, data, deviceId) => request(`/assignments/${id}`, {
    method: 'PUT',
    body: JSON.stringify(deviceId ? { ...data, device_id: deviceId } : data),
  }),
  // DELETE carries no body here, so the device goes in the query string.
  deleteAssignment: (id, deviceId) => request(
    `/assignments/${id}${deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : ''}`,
    { method: 'DELETE' },
  ),
  reorderAssignments: (deviceId, order) => request(`/assignments/device/${deviceId}/reorder`, {
    method: 'POST',
    body: JSON.stringify({ order })
  }),

  // Widgets
  getWidgets: () => request('/widgets'),
  getWidget: (id) => request('/widgets/' + id),

  // Device Groups
  getGroups: () => request('/groups'),
  createGroup: (name, color) => request('/groups', { method: 'POST', body: JSON.stringify({ name, color }) }),
  updateGroup: (id, data) => request(`/groups/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  resyncGroup: (id) => request(`/groups/${id}/resync`, { method: 'POST' }),
  deleteGroup: (id) => request(`/groups/${id}`, { method: 'DELETE' }),
  getGroupDevices: (id) => request(`/groups/${id}/devices`),
  addDeviceToGroup: (groupId, device_id) => request(`/groups/${groupId}/devices`, { method: 'POST', body: JSON.stringify({ device_id }) }),
  removeDeviceFromGroup: (groupId, deviceId) => request(`/groups/${groupId}/devices/${deviceId}`, { method: 'DELETE' }),
  sendGroupCommand: (groupId, type, payload) => request(`/groups/${groupId}/command`, { method: 'POST', body: JSON.stringify({ type, payload }) }),

  // Video walls
  getWalls: () => request('/walls'),
  createWall: (data) => request('/walls', { method: 'POST', body: JSON.stringify(data) }),
  setWallDevices: (id, devices) => request(`/walls/${id}/devices`, { method: 'PUT', body: JSON.stringify({ devices }) }),
  updateWall: (id, data) => request(`/walls/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteWall: (id) => request(`/walls/${id}`, { method: 'DELETE' }),

  // Playlists
  getPlaylists: () => request('/playlists'),
  createPlaylist: (name, description) => request('/playlists', { method: 'POST', body: JSON.stringify({ name, description }) }),
  getPlaylist: (id) => request(`/playlists/${id}`),
  updatePlaylist: (id, data) => request(`/playlists/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deletePlaylist: (id) => request(`/playlists/${id}`, { method: 'DELETE' }),
  getPlaylistItems: (id) => request(`/playlists/${id}/items`),
  addPlaylistItem: (id, data) => request(`/playlists/${id}/items`, { method: 'POST', body: JSON.stringify(data) }),
  updatePlaylistItem: (id, itemId, data) => request(`/playlists/${id}/items/${itemId}`, { method: 'PUT', body: JSON.stringify(data) }),
  deletePlaylistItem: (id, itemId) => request(`/playlists/${id}/items/${itemId}`, { method: 'DELETE' }),
  duplicatePlaylistItem: (id, itemId) => request(`/playlists/${id}/items/${itemId}/duplicate`, { method: 'POST' }),
  // #318: many content items in one request. Returns { added: [...], skipped: [{content_id, reason}] } —
  // a batch can partially succeed, and the caller is expected to say so.
  addPlaylistItemsBulk: (id, content_ids, zone_id) => request(`/playlists/${id}/items/bulk`, {
    method: 'POST', body: JSON.stringify(zone_id ? { content_ids, zone_id } : { content_ids }),
  }),
  reorderPlaylistItems: (id, order) => request(`/playlists/${id}/items/reorder`, { method: 'POST', body: JSON.stringify({ order }) }),
  // #74/#75 per-item schedule blocks
  getItemSchedules: (id, itemId) => request(`/playlists/${id}/items/${itemId}/schedules`),
  setItemSchedules: (id, itemId, blocks) => request(`/playlists/${id}/items/${itemId}/schedules`, { method: 'PUT', body: JSON.stringify({ blocks }) }),
  // #313: create a display that has no player yet, and get the URL that will become one.
  createWebPlayerDisplay: (name) => request('/devices/web-player', { method: 'POST', body: JSON.stringify({ name }) }),
  // #313: mint or roll the enrolment key that lets a storage-less web player identify itself.
  createEnrolKey: (id) => request(`/devices/${id}/enrol-key`, { method: 'POST' }),
  revokeEnrolKey: (id) => request(`/devices/${id}/enrol-key`, { method: 'DELETE' }),
  assignPlaylistToDevice: (playlistId, device_id) => request(`/playlists/${playlistId}/assign`, { method: 'POST', body: JSON.stringify({ device_id }) }),
  clearDevicePlaylist: (device_id) => request(`/devices/${device_id}/playlist`, { method: 'DELETE' }),
  publishPlaylist: (id) => request(`/playlists/${id}/publish`, { method: 'POST' }),
  discardPlaylistDraft: (id) => request(`/playlists/${id}/discard`, { method: 'POST' }),

  // Device Groups - Playlist
  groupAssignPlaylist: (groupId, playlist_id) => request(`/groups/${groupId}/assign-playlist`, { method: 'POST', body: JSON.stringify({ playlist_id }) }),

  // API Tokens (personal access tokens, workspace-scoped)
  getTokens: () => request('/tokens'),
  createToken: (data) => request('/tokens', { method: 'POST', body: JSON.stringify(data) }),
  revokeToken: (id) => request('/tokens/' + id, { method: 'DELETE' }),
  setTokenTargets: (id, target_playlist_ids) => request('/tokens/' + id + '/targets', { method: 'PUT', body: JSON.stringify({ target_playlist_ids }) }), // #73: re-designate agency token playlists
  setTokenUploadFolder: (id, upload_folder_id) => request('/tokens/' + id + '/upload-folder', { method: 'PUT', body: JSON.stringify({ upload_folder_id }) }), // #158: rebind agency token upload folder (null = root)

  // TOTP 2FA (#100) — opt-in per-user, local accounts only. See routes/auth.js.
  totpStatus: () => request('/auth/totp/status'),
  // Unlink an instance-wide SSO provider. The new password is required in the same call:
  // the account must never sit between credentials.
  ssoUnlink: (password) => request('/auth/oidc/unlink', { method: 'POST', body: JSON.stringify({ password }) }),
  // Returns { url } to navigate to. Fetched rather than navigated to, because the session is
  // a bearer token and a top-level navigation cannot carry one.
  ssoLinkStart: (slug) => request(`/auth/oidc/${encodeURIComponent(slug)}/link/start`),
  totpSetup: () => request('/auth/totp/setup', { method: 'POST' }),
  totpEnable: (code) => request('/auth/totp/enable', { method: 'POST', body: JSON.stringify({ code }) }),
  totpDisable: (code) => request('/auth/totp/disable', { method: 'POST', body: JSON.stringify({ code }) }),
  totpRegenRecovery: (code) => request('/auth/totp/recovery-codes/regenerate', { method: 'POST', body: JSON.stringify({ code }) }),

  // Email verification (signup). Resend is generic (never reveals whether the address exists).
  resendVerification: (email) => request('/auth/resend-verification', { method: 'POST', body: JSON.stringify({ email }) }),

  // Current user
  getMe: () => request('/auth/me'),
  updateMe: (data) => request('/auth/me', { method: 'PUT', body: JSON.stringify(data) }),
  switchWorkspace: (workspaceId) => request('/auth/switch-workspace', { method: 'POST', body: JSON.stringify({ workspace_id: workspaceId }) }),
  /*
   * ⚠️ THE ORG IS NOT SENT. The server resolves it from the caller's own membership — a body-supplied
   * organization_id is honoured only after it verifies the caller administers that org, so passing
   * one from here would buy nothing and invite the mistake. See routes/workspaces.js.
   */
  createWorkspace: (data) => request('/workspaces', { method: 'POST', body: JSON.stringify(data ?? {}) }),
  renameWorkspace: (id, data) => request(`/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  updateWorkspaceSecuritySettings: (workspaceId, data) => request(`/workspaces/${workspaceId}/security-settings`, { method: 'PUT', body: JSON.stringify(data) }),

  // Workspace members + invites (slice 2A read-only)
  getWorkspaceMembers: (id) => request(`/workspaces/${id}/members`),
  getWorkspaceInvites: (id) => request(`/workspaces/${id}/invites`),

  // Workspace member/invite mutations (slice 2B). All admin-only server-side
  // (canAdminWorkspace gate). Server returns translated English error messages
  // mapped to i18n keys via mapMutationError() in workspace-members.js.
  inviteWorkspaceMember: (workspaceId, data) => request(`/workspaces/${workspaceId}/invites`, { method: 'POST', body: JSON.stringify(data) }),
  cancelWorkspaceInvite: (workspaceId, inviteId) => request(`/workspaces/${workspaceId}/invites/${inviteId}`, { method: 'DELETE' }),
  updateWorkspaceMemberRole: (workspaceId, userId, role) => request(`/workspaces/${workspaceId}/members/${userId}`, { method: 'PUT', body: JSON.stringify({ role }) }),
  removeWorkspaceMember: (workspaceId, userId) => request(`/workspaces/${workspaceId}/members/${userId}`, { method: 'DELETE' }),

  // Slice 2C - accept a workspace invite by id (post-auth flow)
  acceptInvite: (inviteId) => request(`/auth/accept-invite/${inviteId}`, { method: 'POST' }),

  // Admin-provisioned user creation (#10). data: { email, name, password,
  // workspaceId, role, mustChangePassword }
  adminCreateUser: (data) => request('/admin/users', { method: 'POST', body: JSON.stringify(data) }),
  adminCreateOrg: (name) => request('/admin/orgs', { method: 'POST', body: JSON.stringify({ name }) }),
  adminListOrgs: () => request('/admin/orgs'),
  // Platform-admin view: EVERY plan incl. hidden ones, with subscriber counts.
  adminListPlans: () => request('/admin/plans'),
  adminDeleteOrg: (id) => request(`/admin/orgs/${id}`, { method: 'DELETE' }),
  adminDeleteWorkspace: (id) => request(`/admin/workspaces/${id}`, { method: 'DELETE' }),
  aiGetSettings: () => request('/ai/settings'),
  aiSaveSettings: (data) => request('/ai/settings', { method: 'PUT', body: JSON.stringify(data) }),
  aiGenerateDesign: (prompt) => request('/ai/generate-design', { method: 'POST', body: JSON.stringify({ prompt }) }),
  /* A whole SLIDE from a sentence: {template, fields}, ready to drop onto the editor's canvas.
   * Shaped differently from generate-design because a slide keeps layout and words apart. */
  aiGenerateSlide: (prompt) => request('/ai/generate-slide', { method: 'POST', body: JSON.stringify({ prompt }) }),
  // Generates a picture AND ingests it into the content library, returning a real content_id — a
  // slide references its background by id because the file has to reach a screen and be playable
  // with the WAN down, which an inline data: URL never could.
  aiGenerateBackground: (prompt, dims) => request('/ai/generate-background', { method: 'POST', body: JSON.stringify({ prompt, ...(dims || {}) }) }),
  /*
   * A background PLUS cut-out objects, each its own animatable element. One press is up to five
   * paid generations upstream, so the caller must be single-flight about it.
   */
  aiGenerateLayered: (prompt, dims, objects) => request('/ai/generate-layered', {
    method: 'POST', body: JSON.stringify({ prompt, ...(dims || {}), objects }),
  }),
  aiListModels: (base_url, api_key) => request('/ai/models', { method: 'POST', body: JSON.stringify({ base_url, api_key }) }),

  // Instance-level default branding (#15, platform admin).
  /*
   * Server diagnostics (platform admin). The profile call is deliberately given a long timeout at
   * the call site rather than here — it is a request that is SUPPOSED to take 30-60 seconds, and a
   * default timeout would abort the one thing it exists to do.
   */
  // #320: operator-uploaded GLSL transitions, workspace-scoped like fonts.
  listCustomShaders: () => request('/transitions/custom'),
  uploadCustomShader: (source, name, licence_note) =>
    request('/transitions/custom', { method: 'POST', body: JSON.stringify({ source, name, licence_note }) }),
  deleteCustomShader: (id) => request(`/transitions/custom/${id}`, { method: 'DELETE' }),
  adminDiagShape: () => request('/admin/diagnostics/shape'),
  adminDiagLag: (days = 14) => request(`/admin/diagnostics/lag?days=${encodeURIComponent(days)}`),
  adminDiagProfile: (seconds = 30) => request('/admin/diagnostics/cpu-profile', {
    method: 'POST', body: JSON.stringify({ seconds }),
  }),

  adminGetBranding: () => request('/admin/branding'),
  adminSetBranding: (data) => request('/admin/branding', { method: 'PUT', body: JSON.stringify(data) }),
  // #146: toggle the /api/status debug block exposure (platform-admin only).
  adminGetStatusDebug: () => request('/admin/status-debug'),
  adminSetStatusDebug: (enabled) => request('/admin/status-debug', { method: 'PUT', body: JSON.stringify({ enabled }) }),
  // Opt-in install statistics. GET returns { state, payload, last_report } — payload is the exact
  // body that would be sent, so the UI can show it rather than describe it.
  adminGetTelemetry: () => request('/admin/telemetry'),
  adminSetTelemetry: (enabled) => request('/admin/telemetry', { method: 'PUT', body: JSON.stringify({ enabled }) }),

  // Per-user workspace membership management (platform Users page modal).
  adminGetUserWorkspaces: (id) => request(`/admin/users/${id}/workspaces`),
  adminAddUserWorkspace: (id, workspaceId, role) => request(`/admin/users/${id}/workspaces`, { method: 'POST', body: JSON.stringify({ workspaceId, role }) }),
  adminSetUserWorkspaceRole: (id, workspaceId, role) => request(`/admin/users/${id}/workspaces/${workspaceId}`, { method: 'PUT', body: JSON.stringify({ role }) }),
  adminRemoveUserWorkspace: (id, workspaceId) => request(`/admin/users/${id}/workspaces/${workspaceId}`, { method: 'DELETE' }),

  // Admin - Users
  getUsers: () => request('/auth/users'),
  deleteUser: (id) => request(`/auth/users/${id}`, { method: 'DELETE' }),
  resetUserPassword: (id, password) => request(`/auth/users/${id}/password`, {
    method: 'PUT',
    body: JSON.stringify({ password }),
  }),
  assignPlan: (user_id, plan_id) => request('/subscription/assign', {
    method: 'POST',
    body: JSON.stringify({ user_id, plan_id })
  }),

  // Data Sources (iCal, APIs, etc.)
  getDataSources: () => request('/data-sources'),
  getDataSource: (id) => request(`/data-sources/${id}`),
  testDataSource: (type, config) => request('/data-sources/test', {
    method: 'POST',
    body: JSON.stringify({ type, config })
  }),
  createDataSource: (data) => request('/data-sources', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  updateDataSource: (id, data) => request(`/data-sources/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  }),
  refreshDataSource: (id) => request(`/data-sources/${id}/refresh`, {
    method: 'POST'
  }),
  deleteDataSource: (id) => request(`/data-sources/${id}`, {
    method: 'DELETE'
  }),
};
