'use strict';

/*
 * Every integration that can send something off this server, and how to tell — from the RUNNING
 * configuration, not from documentation — whether it is switched on. The data handling page
 * (lib/trust/report.js) is built from this list; docs/trust.md describes each entry for people.
 *
 * An entry:
 *   id            also the outbound ledger's feature id (lib/trust/features.js) and the i18n key
 *                 stem trust.int.<id> on the dashboard
 *   level         'instance' — configured by the operator for the whole server
 *                 'org'      — configured per organization or workspace (counted per org)
 *   customerData  true when what it sends includes the organization's or its people's data
 *                 (content, prompts, addresses, device names). false when it only fetches in, or
 *                 sends nothing beyond an anonymous request.
 *   status(ctx)   { enabled, count?, hosts?: [host], detail?: {} } — ctx = { db, orgId|null }.
 *                 hosts are what we can name from configuration; never a path or a credential.
 *
 * ⚠️ status() must never throw and never return a secret: a missing table or module is "off".
 */

const config = require('../../config');

function hostOf(u) {
  try { const x = new URL(String(u || '').trim()); return x.host.toLowerCase() || null; } catch (_) { return null; }
}
const uniq = (a) => [...new Set(a.filter(Boolean))];
function safe(fn, dflt) { try { return fn(); } catch (_) { return dflt; } }

/** SQL fragment + args scoping a workspace_id column to an org (or to everything). */
function wsScope(ctx, col = 'workspace_id') {
  if (!ctx.orgId) return { sql: '1=1', args: [] };
  return { sql: `${col} IN (SELECT id FROM workspaces WHERE organization_id = ?)`, args: [ctx.orgId] };
}
function orgScope(ctx, col = 'organization_id') {
  if (!ctx.orgId) return { sql: '1=1', args: [] };
  return { sql: `${col} = ?`, args: [ctx.orgId] };
}
function count(ctx, table, where, scope) {
  return safe(() => ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE (${where}) AND ${scope.sql}`).get(...scope.args).n, 0);
}
function hostsFrom(ctx, sql, scope) {
  return safe(() => uniq(ctx.db.prepare(`${sql} AND ${scope.sql}`).all(...scope.args).map((r) => hostOf(r.u))), []);
}

const INTEGRATIONS = [
  /* ───────── instance level: the operator's configuration ───────── */
  {
    id: 'email', level: 'instance', customerData: true,
    status() {
      const email = safe(() => require('../../services/email'), null);
      const on = !!(email && safe(() => email.isConfigured(), false));
      const smtp = String(config.emailTransport || 'graph') === 'smtp';
      return {
        enabled: on,
        hosts: on ? (smtp ? uniq([config.smtpHost && `${config.smtpHost}`]) : ['login.microsoftonline.com', 'graph.microsoft.com']) : [],
        detail: { transport: smtp ? 'smtp' : 'graph' },
      };
    },
  },
  {
    id: 'stripe', level: 'instance', customerData: true,
    status: () => ({ enabled: !!config.stripeSecretKey, hosts: config.stripeSecretKey ? ['api.stripe.com'] : [] }),
  },
  {
    id: 'ai_hosted', level: 'instance', customerData: true,
    status() {
      const on = safe(() => require('../ai-hosted').enabled(), false);
      const hosts = [];
      if (on) {
        if (process.env.XAI_API_KEY) hosts.push(hostOf(config.aiHosted.xaiBaseUrl));
        if (process.env.OPENAI_API_KEY) hosts.push(hostOf(config.aiHosted.openaiBaseUrl));
        if (process.env.AI_HOSTED_COMPAT_API_KEY && config.aiHosted.compatBaseUrl) hosts.push(hostOf(config.aiHosted.compatBaseUrl));
      }
      return { enabled: on, hosts: uniq(hosts) };
    },
  },
  {
    id: 'stock_media', level: 'instance', customerData: false,
    status() {
      const p = safe(() => require('../stock-media').enabledProviders(), []);
      const hosts = [];
      if (p.includes('pexels')) hosts.push('api.pexels.com', 'images.pexels.com', 'videos.pexels.com');
      if (p.includes('pixabay')) hosts.push('pixabay.com', 'cdn.pixabay.com');
      return { enabled: p.length > 0, hosts, detail: { providers: p } };
    },
  },
  {
    id: 'telemetry', level: 'instance', customerData: false,
    status() {
      const t = safe(() => require('../telemetry'), null);
      const dest = t ? safe(() => t.destinations(), []) : [];
      return { enabled: dest.length > 0, hosts: uniq(dest.map((d) => hostOf(d.url))), detail: { state: t ? safe(() => t.state(), 'unasked') : 'unasked', fields: ['instance_id', 'version', 'screen_count'] } };
    },
  },
  {
    // Always on: the "a new version is available" check. Anonymous; sends no instance data.
    id: 'updates', level: 'instance', customerData: false,
    status: () => ({ enabled: true, hosts: ['ghcr.io'] }),
  },
  {
    id: 'template_catalog', level: 'instance', customerData: false,
    status(ctx) {
      const on = safe(() => require('../app-settings').getBool('templates_catalog_enabled', false), false);
      const hosts = on ? safe(() => uniq(ctx.db.prepare('SELECT url FROM template_catalogs WHERE enabled = 1').all().map((r) => hostOf(r.url))), []) : [];
      if (on && !hosts.length) hosts.push(hostOf(process.env.TEMPLATE_CATALOG_URL || 'https://screentinker.github.io/templates/'));
      return { enabled: on, hosts };
    },
  },
  {
    id: 'sso', level: 'instance', customerData: true,
    status(ctx) {
      const inst = safe(() => require('../oidc-providers').list(), []);
      const orgN = count(ctx, 'org_sso_providers', "enabled = 1 AND COALESCE(kind,'oidc') = 'oidc'", orgScope(ctx));
      const hosts = uniq([
        ...(ctx.orgId ? [] : inst.map((p) => hostOf(p.issuer) || (p.slug === 'google' ? 'accounts.google.com' : p.slug === 'microsoft' ? 'login.microsoftonline.com' : null))),
        ...hostsFrom(ctx, "SELECT issuer AS u FROM org_sso_providers WHERE enabled = 1 AND COALESCE(kind,'oidc') = 'oidc'", orgScope(ctx)),
      ]);
      return { enabled: (ctx.orgId ? 0 : inst.length) + orgN > 0, count: (ctx.orgId ? 0 : inst.length) + orgN, hosts };
    },
  },
  {
    id: 'storage', level: 'instance', customerData: true,
    status(ctx) {
      const s = safe(() => require('../storage'), null);
      const def = s ? safe(() => (ctx.orgId ? s.orgDefaultProfile(ctx.orgId) : s.instanceDefault()), null) : null;
      const rows = safe(() => ctx.db.prepare(`SELECT provider, endpoint, bucket, region FROM storage_profiles WHERE provider <> 'local' AND ${ctx.orgId ? '(org_id = ? OR org_id IS NULL)' : '1=1'}`).all(...(ctx.orgId ? [ctx.orgId] : [])), []);
      const external = (def && def.provider !== 'local') || rows.length > 0;
      const hostOfProfile = (p) => (p.endpoint ? hostOf(p.endpoint) : p.provider === 's3' ? 's3.amazonaws.com' : p.provider === 'azure' ? 'blob.core.windows.net' : null);
      const hosts = uniq([def && def.provider !== 'local' ? hostOfProfile(def) : null, ...rows.map(hostOfProfile)]);
      return { enabled: external, count: rows.length + (def && def.from_env && def.provider !== 'local' ? 1 : 0), hosts };
    },
  },
  {
    id: 'mesh', level: 'instance', customerData: true,
    status(ctx) {
      if (ctx.orgId) return { enabled: false };
      const hosts = hostsFrom(ctx, "SELECT peer_url AS u FROM mesh_edges WHERE revoked_at IS NULL AND direction = 'up'", { sql: '1=1', args: [] });
      return { enabled: hosts.length > 0, count: hosts.length, hosts };
    },
  },
  {
    id: 'scale_out', level: 'instance', customerData: true,
    status: () => ({ enabled: !!config.primaryUrl, hosts: config.primaryUrl ? [hostOf(config.primaryUrl)] : [] }),
  },
  {
    id: 'live_video', level: 'instance', customerData: true,
    status: () => ({ enabled: !!config.go2rtcUrl, hosts: config.go2rtcUrl ? [hostOf(config.go2rtcUrl)] : [] }),
  },
  {
    id: 'plugins', level: 'instance', customerData: true,
    status: () => ({ enabled: !!config.pluginsEnabled, hosts: [] }),
  },

  /* ───────── organization level: what an organization set up for itself ───────── */
  {
    id: 'ai', level: 'org', customerData: true,
    status(ctx) {
      const sc = wsScope(ctx);
      const n = count(ctx, 'ai_settings', "COALESCE(base_url,'') <> '' OR COALESCE(image_base_url,'') <> ''", sc);
      const hosts = uniq([
        ...hostsFrom(ctx, "SELECT base_url AS u FROM ai_settings WHERE COALESCE(base_url,'') <> ''", sc),
        ...hostsFrom(ctx, "SELECT image_base_url AS u FROM ai_settings WHERE COALESCE(image_base_url,'') <> ''", sc),
      ]);
      return { enabled: n > 0, count: n, hosts };
    },
  },
  {
    // 3.0 accessibility: "Generate captions" sends a video's audio to the speech-to-text endpoint set here.
    id: 'captions', level: 'org', customerData: true,
    status(ctx) {
      const sc = wsScope(ctx);
      const n = count(ctx, 'ai_settings', "COALESCE(stt_base_url,'') <> ''", sc);
      return { enabled: n > 0, count: n, hosts: hostsFrom(ctx, "SELECT stt_base_url AS u FROM ai_settings WHERE COALESCE(stt_base_url,'') <> ''", sc) };
    },
  },
  {
    id: 'data_sources', level: 'org', customerData: false,
    status(ctx) {
      const n = count(ctx, 'data_sources', "type IN ('rest','csv','rss','sheets','ical')", wsScope(ctx));
      return { enabled: n > 0, count: n };
    },
  },
  {
    id: 'pos_menus', level: 'org', customerData: false,
    status(ctx) {
      const sq = count(ctx, 'data_sources', "type = 'square'", wsScope(ctx));
      const sh = count(ctx, 'data_sources', "type = 'shopify'", wsScope(ctx));
      const hosts = [];
      if (sq) hosts.push('connect.squareup.com');
      if (sh) hosts.push('*.myshopify.com');
      return { enabled: sq + sh > 0, count: sq + sh, hosts, detail: { square: sq, shopify: sh } };
    },
  },
  {
    // 3.0 site cache: a box on the customer's own network holds copies of their media.
    id: 'site_cache', level: 'org', customerData: true,
    status(ctx) {
      const sc = wsScope(ctx);
      const n = count(ctx, 'site_caches', 'enabled = 1', sc);
      return { enabled: n > 0, count: n, hosts: hostsFrom(ctx, 'SELECT lan_url AS u FROM site_caches WHERE enabled = 1', sc) };
    },
  },
  {
    // 3.0 switch to ScreenTinker: an import pulls from the other vendor with the key the person pasted.
    id: 'migrate', level: 'org', customerData: false,
    status(ctx) {
      const n = count(ctx, 'migration_jobs', "status NOT IN ('done','failed','cancelled')", wsScope(ctx));
      return { enabled: n > 0, count: n, hosts: [] };
    },
  },
  {
    id: 'weather', level: 'org', customerData: false,
    status(ctx) {
      const n = count(ctx, 'data_sources', "type = 'weather'", wsScope(ctx));
      return { enabled: n > 0, count: n, hosts: n ? ['api.open-meteo.com', 'geocoding-api.open-meteo.com'] : [] };
    },
  },
  {
    id: 'cap_feeds', level: 'org', customerData: false,
    status(ctx) {
      const sc = wsScope(ctx);
      const n = count(ctx, 'cap_feeds', "enabled = 1 AND COALESCE(source,'') <> 'hook'", sc);
      return { enabled: n > 0, count: n, hosts: hostsFrom(ctx, "SELECT url AS u FROM cap_feeds WHERE enabled = 1 AND COALESCE(source,'') <> 'hook'", sc) };
    },
  },
  {
    // 3.0 news feeds (lib/news-feed): this server reads each feed a news widget names, so screens
    // never contact the publisher. The hosts are the feeds' own, from the widgets' configuration.
    id: 'news_feeds', level: 'org', customerData: false,
    status(ctx) {
      const sc = wsScope(ctx);
      // json_valid first: one malformed config row must not make json_extract fail the whole count.
      const where = "widget_type = 'rss' AND json_valid(config) AND COALESCE(json_extract(config, '$.feed_url'), '') <> ''";
      const n = count(ctx, 'widgets', where, sc);
      return {
        enabled: n > 0, count: n,
        hosts: n ? hostsFrom(ctx, `SELECT json_extract(config, '$.feed_url') AS u FROM widgets WHERE ${where}`, sc) : [],
      };
    },
  },
  {
    id: 'social', level: 'org', customerData: false,
    status(ctx) {
      const feeds = count(ctx, 'social_feeds', 'enabled = 1', wsScope(ctx));
      const kinds = safe(() => ctx.db.prepare(`SELECT DISTINCT kind FROM social_connections WHERE ${orgScope(ctx).sql}`).all(...orgScope(ctx).args).map((r) => r.kind), []);
      return { enabled: feeds > 0, count: feeds, detail: { networks: kinds } };
    },
  },
  {
    id: 'rooms', level: 'org', customerData: true,
    status(ctx) {
      const n = count(ctx, 'rooms', '1=1', wsScope(ctx));
      const kinds = safe(() => ctx.db.prepare(`SELECT DISTINCT kind FROM room_connections WHERE ${orgScope(ctx).sql}`).all(...orgScope(ctx).args).map((r) => r.kind), []);
      const hosts = [];
      if (kinds.includes('graph')) hosts.push('login.microsoftonline.com', 'graph.microsoft.com');
      if (kinds.includes('google')) hosts.push('oauth2.googleapis.com', 'www.googleapis.com');
      return { enabled: n > 0, count: n, hosts, detail: { calendars: kinds } };
    },
  },
  {
    id: 'canva', level: 'org', customerData: false,
    status(ctx) {
      const own = count(ctx, 'canva_integrations', "COALESCE(client_id,'') <> ''", orgScope(ctx));
      const inst = !!(process.env.CANVA_CLIENT_ID && process.env.CANVA_CLIENT_SECRET);
      const links = count(ctx, 'canva_links', '1=1', wsScope(ctx));
      return { enabled: own > 0 || inst, count: links, hosts: own > 0 || inst ? ['api.canva.com'] : [] };
    },
  },
  {
    id: 'm365', level: 'org', customerData: false,
    status(ctx) {
      const apps = count(ctx, 'org_m365_apps', "COALESCE(client_id,'') <> ''", orgScope(ctx));
      const folders = count(ctx, 'cloud_folders', 'enabled = 1', wsScope(ctx));
      return { enabled: apps > 0, count: folders, hosts: apps ? ['login.microsoftonline.com', 'graph.microsoft.com'] : [] };
    },
  },
  {
    id: 'bi', level: 'org', customerData: false,
    status(ctx) {
      const sc = orgScope(ctx);
      const n = count(ctx, 'bi_connections', '1=1', sc);
      const kinds = safe(() => ctx.db.prepare(`SELECT DISTINCT kind FROM bi_connections WHERE ${sc.sql}`).all(...sc.args).map((r) => r.kind), []);
      return { enabled: n > 0, count: n, hosts: kinds.includes('powerbi') ? ['login.microsoftonline.com', 'api.powerbi.com'] : [], detail: { kinds } };
    },
  },
  {
    id: 'alert_channels', level: 'org', customerData: true,
    status(ctx) {
      const sc = wsScope(ctx);
      const kinds = safe(() => ctx.db.prepare(`SELECT kind, COUNT(*) AS n FROM alert_channels WHERE enabled = 1 AND ${sc.sql} GROUP BY kind`).all(...sc.args), []);
      const n = kinds.reduce((a, k) => a + k.n, 0);
      const hosts = [];
      for (const k of kinds) {
        if (k.kind === 'slack') hosts.push('hooks.slack.com');
        if (k.kind === 'pagerduty') hosts.push('events.pagerduty.com');
        if (k.kind === 'telegram') hosts.push('api.telegram.org');
      }
      if (ctx.orgId) hosts.push(...safe(() => ctx.db.prepare(`SELECT config FROM alert_channels WHERE enabled = 1 AND kind IN ('teams','webhook') AND ${sc.sql}`).all(...sc.args)
        .map((r) => { try { return hostOf(JSON.parse(r.config || '{}').url); } catch (_) { return null; } }), []));
      return { enabled: n > 0, count: n, hosts: uniq(hosts), detail: { kinds: Object.fromEntries(kinds.map((k) => [k.kind, k.n])) } };
    },
  },
  {
    id: 'automation', level: 'org', customerData: true,
    status(ctx) {
      const sc = wsScope(ctx);
      const n = count(ctx, 'automation_subscriptions', '1=1', sc);
      return { enabled: n > 0, count: n, hosts: ctx.orgId ? hostsFrom(ctx, 'SELECT target_url AS u FROM automation_subscriptions WHERE 1=1', sc) : [] };
    },
  },
];

/** Evaluate every integration for ctx = { db, orgId|null }. Never throws. */
function evaluate(ctx) {
  return INTEGRATIONS.map((i) => {
    const s = safe(() => i.status(ctx), { enabled: false }) || { enabled: false };
    return {
      id: i.id, level: i.level, customer_data: i.customerData, enabled: !!s.enabled,
      count: s.count == null ? null : s.count, hosts: uniq(s.hosts || []), detail: s.detail || {},
    };
  });
}

module.exports = { INTEGRATIONS, evaluate, hostOf };
