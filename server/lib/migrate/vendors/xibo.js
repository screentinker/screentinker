'use strict';

/*
 * Xibo CMS (self-hosted or Xibo Cloud), API v3/v4. Written against:
 *   https://docs.xibosignage.com/developer/integrate/authentication   (client_credentials token)
 *   https://docs.xibosignage.com/developer/integrate/openapi.md        (start/length paging, X-Total-Count)
 *   https://raw.githubusercontent.com/xibosignage/xibo-cms/develop/web/swagger.json  (v4.5 schemas)
 *
 * The person creates an Application (Administration -> Applications -> Add Application, grant
 * "Client Credentials") and pastes the CMS address, client id and client secret. The address is
 * THEIRS, so it goes through lib/ssrf-guard like any user-supplied URL: public addresses only unless
 * the operator opened a private range (OUTBOUND_ALLOW_HOSTS / OUTBOUND_ALLOW_PRIVATE), never a
 * metadata address. The token is held only in this session object.
 *
 * Mapping:
 *   library (image/video/audio)  -> media, downloaded from GET /library/download/{id}
 *     ⚠️ NOT /{id}/{type}: swagger.json still documents that, but the CMS routes (lib/routes.php) have
 *     been /library/download/{id} since 3.x and answer the two-part path with a route 404. 2.x had
 *     /library/download/:id(/:type), so the one-part path works there too. (#900)
 *   other library types          -> listed as not imported (fonts, modules, HTML packages, PDFs...)
 *   playlists (not region ones)  -> playlists; widget order = displayOrder; non-media widgets dropped
 *   layouts (published) + regions -> layouts + zones (pixel geometry -> percent), region items
 *   display groups               -> groups; a display's own group targets that display
 *   displays                     -> placeholders (name, groups, default layout)
 *   schedule events (layout / campaign of one layout) -> schedules (see lib/migrate/map.js)
 *   overlays, commands, interrupts, actions, multi-layout campaigns, dayparts -> not imported, said
 *
 * ⚠️ TIMES. Xibo's event fromDt/toDt are Unix timestamps; they are converted to wall clock in the
 * display's time zone when the event targets one display that has one, else in the time zone the
 * person gave on the connect form (the CMS's own zone), else UTC — and the report says which.
 */

const { client, normalizeBaseUrl, MigrateHttpError } = require('../transport');
const { offsetPages, truncatedNote, userError, str } = require('./common');
const map = require('../map');

const MEDIA_TYPES = { image: 'image', video: 'video', audio: 'audio' };

/*
 * ⚠️ Xibo hands library downloads to the web server (Settings: SENDFILE_MODE, Apache X-Sendfile or
 * Nginx X-Accel-Redirect). When the web server is not set up for it, the API answers 200 with an
 * EMPTY body, or a page instead of the file. Without this check the library rejected those bytes
 * and the report said "not an image, video or audio file", which sent people looking in the wrong
 * place (reported on #900). Say what really happened and where the setting is.
 */
const SENDFILE_HINT = 'In Xibo, check the CMS setting for how library files are sent (SENDFILE_MODE: Apache, Nginx or Off). If it names a web server feature that is not set up, the CMS sends empty files; setting it to Off fixes that.';
function checkXiboFile(dest, got) {
  const fs = require('fs');
  const size = Number(got && got.size) || 0;
  if (size === 0) {
    try { fs.rmSync(dest, { force: true }); } catch { /* gone */ }
    throw new MigrateHttpError(`Xibo sent an empty file. ${SENDFILE_HINT}`, 'empty_file');
  }
  let head = '';
  try { const fd = fs.openSync(dest, 'r'); const b = Buffer.alloc(256); const n = fs.readSync(fd, b, 0, 256, 0); fs.closeSync(fd); head = b.subarray(0, n).toString('utf8'); } catch { /* checked by the library */ }
  if (/^\s*(<!doctype html|<html|\{\s*"(error|message)")/i.test(head)) {
    try { fs.rmSync(dest, { force: true }); } catch { /* gone */ }
    throw new MigrateHttpError(`Xibo sent a page or an error message instead of the file. ${SENDFILE_HINT}`, 'not_a_file');
  }
}

function apiBase(url) { return normalizeBaseUrl(url).replace(/\/api$/i, '') + '/api'; }

module.exports = {
  id: 'xibo',
  name: 'Xibo',
  mode: 'api',
  selfHosted: true,
  docs: [
    'https://docs.xibosignage.com/developer/integrate/authentication',
    'https://docs.xibosignage.com/developer/integrate/openapi',
  ],
  fields: [
    { key: 'url', type: 'url', required: true },
    { key: 'client_id', type: 'text', required: true },
    { key: 'client_secret', type: 'secret', required: true },
    { key: 'timezone', type: 'timezone', required: false },
  ],

  checkCredentials(cred) {
    const base = apiBase(cred.url);   // throws a MigrateHttpError the route shows as-is
    const id = str(cred.client_id).trim(), secret = str(cred.client_secret, 500).trim();
    if (!id || !secret) throw userError('Enter the client id and client secret of a Xibo Application.');
    const tz = str(cred.timezone, 64).trim();
    return { cred: { base, client_id: id, client_secret: secret, timezone: map.isZone(tz) ? tz : '' }, label: new URL(base).host };
  },

  async open(cred) {
    if (!cred) throw userError('Enter the Xibo credentials again.');
    const c = client(cred.base);
    const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: cred.client_id, client_secret: cred.client_secret }).toString();
    const res = await c.raw('/authorize/access_token', { method: 'POST', body: form, extraHeaders: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    if (res.status === 400 || res.status === 401) throw new MigrateHttpError('Xibo refused the client id or secret. Check the Application and that it allows Client Credentials.', 'unauthorized', 401);
    if (res.status === 404) throw new MigrateHttpError('No Xibo API at that address. Enter the CMS address you sign in at.', 'not_found', 404);
    let token = null;
    try { token = JSON.parse(res.text || '{}').access_token; } catch { token = null; }
    if (res.status < 200 || res.status >= 300 || !token) throw new MigrateHttpError('Xibo did not issue a token. Check the address and the Application.', 'unauthorized', res.status || 401);
    c.setAuth({ Authorization: `Bearer ${token}` });

    const list = (path, embed) => offsetPages(async (start, length) => {
      const { body, headers } = await c.api(path, { query: { start, length, ...(embed ? { embed } : {}) } });
      const total = Number(headers['x-total-count']);
      return { rows: Array.isArray(body) ? body : (body && Array.isArray(body.data) ? body.data : []), total: Number.isFinite(total) ? total : undefined };
    });

    return {
      async scan() {
        const unmapped = [];
        const [lib, pls, lays, groupsR, displaysR, campaignsR, eventsR] = [
          await list('/library'), await list('/playlist', 'widgets'), await list('/layout', 'regions,playlists,widgets'),
          await list('/displaygroup'), await list('/display', 'displaygroups'), await list('/campaign'), await list('/schedule'),
        ];
        for (const [k, r] of [['media', lib], ['playlists', pls], ['layouts', lays], ['groups', groupsR], ['screens', displaysR], ['schedules', eventsR]]) truncatedNote(unmapped, k, r.truncated);

        /* media */
        const media = [];
        const mediaIds = new Set();
        for (const m of lib.rows) {
          if (m.retired) continue;
          const kind = MEDIA_TYPES[m.mediaType];
          if (!kind) { unmapped.push({ kind: 'media', name: str(m.name), reason: `Xibo "${str(m.mediaType, 40)}" files are not media ScreenTinker plays.` }); continue; }
          media.push({ id: String(m.mediaId), name: str(m.fileName || m.name), kind, size: Number(m.fileSize) || 0, ref: { id: m.mediaId, type: m.mediaType } });
          mediaIds.add(String(m.mediaId));
        }

        const widgetItems = (widgets, notes) => {
          const items = [];
          for (const w of [...(widgets || [])].sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0))) {
            const mid = (w.mediaIds || [])[0];
            if (MEDIA_TYPES[w.type] && mid != null && mediaIds.has(String(mid))) {
              // useDuration 0 on a video means "play to its natural length".
              items.push({ media_id: String(mid), duration: w.useDuration ? map.seconds(w.duration) : (w.type === 'video' ? null : map.seconds(w.calculatedDuration || w.duration)) });
            } else if (notes) notes.add(str(w.type, 40));
          }
          return items;
        };

        /* playlists (library playlists; region playlists come with their layout) */
        const playlists = [];
        for (const p of pls.rows) {
          if (p.regionId) continue;
          const dropped = new Set();
          const pl = { id: String(p.playlistId), name: str(p.name), items: widgetItems(p.widgets, dropped), notes: [] };
          if (p.isDynamic) pl.notes.push('It was a dynamic playlist; its current items were imported as a fixed list.');
          if (dropped.size) pl.notes.push(`Widgets that are not media (${[...dropped].slice(0, 5).join(', ')}) were left out.`);
          playlists.push(pl);
        }

        /* layouts: the published ones (a draft has a parentId) */
        const layouts = [];
        const layoutByCampaign = new Map();
        for (const l of lays.rows) {
          if (l.parentId) continue;
          const dropped = new Set();
          const zones = (l.regions || []).filter((r) => !r.isDrawer).map((r) => ({
            id: String(r.regionId), name: str(r.name), left: r.left, top: r.top, width: r.width, height: r.height, z: r.zIndex,
            items: widgetItems(r.regionPlaylist && r.regionPlaylist.widgets, dropped),
          }));
          const notes = dropped.size ? [`Widgets that are not media (${[...dropped].slice(0, 5).join(', ')}) were left out.`] : [];
          if (l.backgroundImageId) notes.push('The background image was not applied; add it as a zone if you need it.');
          layouts.push({ id: String(l.layoutId), name: str(l.layout || l.name), width: l.width, height: l.height, zones, notes });
          if (l.campaignId != null) layoutByCampaign.set(String(l.campaignId), String(l.layoutId));
        }
        const campaignName = new Map(campaignsR.rows.map((c) => [String(c.campaignId), str(c.campaign)]));

        /* groups and displays */
        const groups = [];
        const ownGroupToDisplay = new Map();
        for (const g of groupsR.rows) {
          if (g.isDisplaySpecific) continue;
          groups.push({ id: String(g.displayGroupId), name: str(g.displayGroup) });
        }
        const groupIds = new Set(groups.map((g) => g.id));
        const screens = [];
        const tzByDisplay = new Map();
        for (const d of displaysR.rows) {
          const sid = String(d.displayId);
          ownGroupToDisplay.set(String(d.displayGroupId), sid);
          if (d.timeZone && map.isZone(d.timeZone)) tzByDisplay.set(sid, d.timeZone);
          screens.push({
            id: sid, name: str(d.display), layout_id: d.defaultLayoutId != null ? String(d.defaultLayoutId) : null,
            group_ids: (d.displayGroups || []).map((g) => String(g.displayGroupId)).filter((x) => groupIds.has(x)),
          });
        }

        /* schedules */
        const schedules = [];
        const RTYPE = { Minute: 'MINUTELY', Hour: 'HOURLY', Day: 'DAILY', Week: 'WEEKLY', Month: 'MONTHLY', Year: 'YEARLY' };
        const EVTYPE = { 2: 'Command', 3: 'Overlay', 4: 'Interrupt', 6: 'Action', 7: 'Media', 8: 'Playlist' };
        for (const e of eventsR.rows) {
          const nm = str(e.name) || campaignName.get(String(e.campaignId)) || `Event ${e.eventId}`;
          if (EVTYPE[e.eventTypeId]) { unmapped.push({ kind: 'schedule', name: nm, reason: `${EVTYPE[e.eventTypeId]} events are not imported.` }); continue; }
          const layoutId = layoutByCampaign.get(String(e.campaignId));
          if (!layoutId) { unmapped.push({ kind: 'schedule', name: nm, reason: 'It plays a campaign of several layouts; schedule the matching layouts by hand.' }); continue; }
          const notes = [];
          if (e.dayPartId && !e.isAlways && !e.isCustom) notes.push('It used a Xibo daypart; its times were taken from the event as stored.');
          if (e.isGeoAware) notes.push('Geo-fencing is not imported.');
          for (const g of e.displayGroups || []) {
            const gid = String(g.displayGroupId);
            const screen = ownGroupToDisplay.get(gid);
            const target = screen ? { type: 'screen', id: screen } : groupIds.has(gid) ? { type: 'group', id: gid } : null;
            if (!target) continue;
            const tz = (screen && tzByDisplay.get(screen)) || cred.timezone || 'UTC';
            const rec = e.recurrenceType && RTYPE[e.recurrenceType] ? {
              freq: RTYPE[e.recurrenceType],
              interval: Number(e.recurrenceDetail) || 1,
              // Xibo stores weekdays ISO-style (1 = Monday ... 7 = Sunday); 0 is treated as Monday too.
              byDay: String(e.recurrenceRepeatsOn || '').split(',').map((x) => parseInt(x, 10)).filter((n) => n >= 0 && n <= 7).map((n) => (n === 0 ? 1 : n % 7)),
              until: e.recurrenceRange ? map.wallClock(Number(e.recurrenceRange) * 1000, tz).slice(0, 10) : null,
              byMonthDayOrdinal: Number(e.recurrenceMonthlyRepeatsOn) === 1,
            } : null;
            const always = !!e.isAlways;
            schedules.push({
              id: `${e.eventId}:${gid}`, name: nm, target, layout_id: layoutId,
              start: always ? '2000-01-01T00:00' : map.wallClock(Number(e.fromDt) * 1000, tz),
              end: always ? '2099-12-31T23:59' : map.wallClock(Number(e.toDt) * 1000, tz),
              timezone: tz, recurrence: always ? null : rec, priority: e.isPriority ? 10 : Number(e.displayOrder) || 0,
              notes: tz === 'UTC' && !cred.timezone ? notes.concat('No time zone was known; the times were read as UTC. Check them.') : notes,
            });
          }
        }
        return { account: cred.base.toLowerCase(), label: new URL(cred.base).host, media, playlists, layouts, schedules, screens, groups, unmapped };
      },
      async fetchMedia(m, dest, maxBytes) {
        const id = encodeURIComponent(String(m.ref.id));
        const got = await c.download(`${cred.base}/library/download/${id}`, dest, maxBytes);
        checkXiboFile(dest, got);
        return got;
      },
      close() { c.setAuth({}); },
    };
  },
};
