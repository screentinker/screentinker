'use strict';

/*
 * Which feature caused an outbound request, for the outbound connections ledger
 * (lib/outbound-ledger.js). Three lookups, tried in the ledger's order:
 *
 *   featureForFile(rel)     the first server file on the caller's stack (server/-relative)
 *   featureForPackage(pkg)  the SDK on the stack, when no server file is (an SDK's own promise chain)
 *   featureForHost(host)    the destination, when nothing else says
 *
 * The ids are the ones lib/trust/integrations.js and the dashboard's i18n keys use
 * (trust.feature.<id>). A file not listed here is reported under its own path — honest, if less
 * friendly — and test/trust-ledger.test.js holds every file allowed to make a raw outbound call to
 * having an entry, so a new integration cannot appear on the Outbound connections page as a path.
 */

const FEATURES = {
  email:            { category: 'email' },
  stripe:           { category: 'billing' },
  ai:               { category: 'ai' },
  ai_hosted:        { category: 'ai' },
  stock_media:      { category: 'media' },
  remote_media:     { category: 'media' },
  data_sources:     { category: 'data' },
  pos_menus:        { category: 'data' },
  weather:          { category: 'data' },
  cap_feeds:        { category: 'data' },
  social:           { category: 'data' },
  news_feeds:       { category: 'data' },
  rooms:            { category: 'data' },
  plugins:          { category: 'data' },
  canva:            { category: 'integrations' },
  m365:             { category: 'integrations' },
  bi:               { category: 'integrations' },
  alert_channels:   { category: 'alerts' },
  automation:       { category: 'alerts' },
  sso:              { category: 'identity' },
  storage:          { category: 'infrastructure' },
  mesh:             { category: 'infrastructure' },
  site_cache:       { category: 'infrastructure' },
  captions:         { category: 'ai' },
  migrate:          { category: 'integrations' },
  scale_out:        { category: 'infrastructure' },
  live_video:       { category: 'infrastructure' },
  telemetry:        { category: 'platform' },
  updates:          { category: 'platform' },
  template_catalog: { category: 'platform' },
  mcp:              { category: 'local' },
  unattributed:     { category: 'other' },
};

// Exact files first, then directory prefixes (longest wins).
const FILES = {
  'services/email.js': 'email',
  'lib/stripe-client.js': 'stripe', 'routes/stripe.js': 'stripe', 'routes/subscription.js': 'stripe',
  'services/dunning.js': 'stripe', 'routes/billing.js': 'stripe',
  'lib/ai-hosted.js': 'ai_hosted', 'routes/ai-hosted.js': 'ai_hosted', 'lib/ai-credits.js': 'ai_hosted',
  'routes/ai.js': 'ai', 'lib/image-gen.js': 'ai', 'lib/ai-surface.js': 'ai',
  'lib/a11y/captions.js': 'captions', 'routes/accessibility.js': 'captions',
  'lib/private-ai.js': 'ai', 'routes/ai-private.js': 'ai', 'lib/sign-translate.js': 'ai', 'lib/ai-starter.js': 'ai',
  'lib/experiments/sales.js': 'pos_menus',
  'lib/stock-media.js': 'stock_media', 'routes/stock-media.js': 'stock_media',
  'routes/content.js': 'remote_media', 'routes/media.js': 'remote_media', 'server.js': 'remote_media',
  'lib/item-duration.js': 'remote_media', 'lib/freshness.js': 'remote_media', 'lib/embedded-render.js': 'remote_media',
  'lib/content-ingest.js': 'remote_media',
  'lib/data-sources/square-resolver.js': 'pos_menus', 'lib/data-sources/shopify-resolver.js': 'pos_menus',
  'lib/data-sources/pos-common.js': 'pos_menus', 'lib/menu-board.js': 'pos_menus',
  'lib/data-sources/weather-resolver.js': 'weather', 'lib/local-conditions.js': 'weather',
  'routes/data-sources.js': 'data_sources',
  'routes/cap-feeds.js': 'cap_feeds', 'routes/social.js': 'social', 'routes/rooms.js': 'rooms',
  'routes/news-feeds.js': 'news_feeds',
  'lib/canva.js': 'canva', 'routes/canva.js': 'canva', 'lib/user-deletion.js': 'canva',
  'lib/m365.js': 'm365', 'lib/cloud-folders.js': 'm365', 'routes/m365.js': 'm365', 'lib/cloud-docs.js': 'm365',
  'routes/bi-connections.js': 'bi',
  'lib/alert-channels.js': 'alert_channels', 'routes/alert-channels.js': 'alert_channels',
  'routes/zapier.js': 'automation', 'routes/automation.js': 'automation',
  'lib/oidc.js': 'sso', 'lib/oidc-providers.js': 'sso', 'routes/org-sso.js': 'sso',
  'lib/replica-proxy.js': 'scale_out',
  'lib/go2rtc.js': 'live_video', 'lib/live-publish.js': 'live_video', 'lib/live-publish-ws.js': 'live_video',
  'lib/telemetry.js': 'telemetry',
  'lib/ghcr-check.js': 'updates',
  'routes/templates.js': 'template_catalog', 'routes/templates-gallery.js': 'template_catalog',
  'routes/mcp.js': 'mcp',
  'services/mesh-uplink.js': 'mesh', 'routes/mesh-enroll.js': 'mesh', 'routes/mesh.js': 'mesh',
  'routes/storage-profiles.js': 'storage',
  plugins: 'plugins',
};
const PREFIXES = [
  ['lib/onvif/', 'live_video'], ['lib/data-sources/', 'data_sources'], ['lib/plugins/', 'plugins'], ['lib/social/', 'social'], ['lib/news-feed/', 'news_feeds'],
  ['lib/rooms/', 'rooms'], ['lib/cap/', 'cap_feeds'], ['lib/bi/', 'bi'], ['lib/alerts/', 'alert_channels'],
  ['lib/screen-verify/', 'alert_channels'], ['lib/automation/', 'automation'], ['lib/templates/', 'template_catalog'],
  ['lib/mesh/', 'mesh'], ['lib/site-cache/', 'site_cache'], ['lib/migrate/', 'migrate'], ['lib/storage/', 'storage'], ['lib/mcp/', 'mcp'],
];

// SDKs that make their own requests from their own promise chains.
const PACKAGES = {
  stripe: 'stripe',
  nodemailer: 'email', '@azure/msal-node': 'email', '@azure/msal-common': 'email',
  '@aws-sdk/client-s3': 'storage', '@smithy/node-http-handler': 'storage', '@smithy/smithy-client': 'storage',
  '@azure/storage-blob': 'storage', '@azure/core-rest-pipeline': 'storage', '@typespec/ts-http-runtime': 'storage',
  'socket.io-client': 'mesh', 'engine.io-client': 'mesh',
};

// Fixed destinations whose purpose is unambiguous.
const HOSTS = [
  [/^api\.stripe\.com$/, 'stripe'],
  [/^stats\.screentinker\.com$/, 'telemetry'],
  [/^ghcr\.io$/, 'updates'],
  [/^screentinker\.github\.io$/, 'template_catalog'],
  [/^(api|images|videos)\.pexels\.com$|^(cdn\.)?pixabay\.com$/, 'stock_media'],
  [/^connect\.squareup(sandbox)?\.com$|\.myshopify\.com$/, 'pos_menus'],
  [/(^|\.)open-meteo\.com$/, 'weather'],
  [/^api\.canva\.com$/, 'canva'],
  [/^api\.powerbi\.com$/, 'bi'],
  [/^events\.pagerduty\.com$|^hooks\.slack\.com$|^api\.telegram\.org$/, 'alert_channels'],
  [/^api\.x\.ai$/, 'ai_hosted'],
  [/^api\.openai\.com$/, 'ai'],
  [/^(graph\.instagram|graph\.facebook)\.com$|^api\.x\.com$|^public\.api\.bsky\.app$/, 'social'],
  [/\.blob\.core\.windows\.net$|(^|\.)amazonaws\.com$|\.r2\.cloudflarestorage\.com$/, 'storage'],
];

function featureForFile(rel) {
  if (!rel) return null;
  if (FILES[rel]) return FILES[rel];
  let best = null;
  for (const [p, f] of PREFIXES) if (rel.startsWith(p) && (!best || p.length > best[0].length)) best = [p, f];
  return best ? best[1] : rel;
}

function featureForPackage(pkg) {
  if (!pkg) return null;
  if (PACKAGES[pkg]) return PACKAGES[pkg];
  if (pkg.startsWith('@smithy/') || pkg.startsWith('@aws-sdk/')) return 'storage';
  return null;
}

function featureForHost(host) {
  const bare = String(host || '').replace(/:\d+$/, '');
  for (const [re, f] of HOSTS) if (re.test(bare)) return f;
  return null;
}

function categoryOf(feature) {
  return (FEATURES[feature] && FEATURES[feature].category) || 'other';
}

module.exports = { FEATURES, FILES, PREFIXES, PACKAGES, featureForFile, featureForPackage, featureForHost, categoryOf };
