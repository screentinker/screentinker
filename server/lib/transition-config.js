'use strict';
// Normalize transition-widget config -> the opaque per-item `transition` object on published_snapshot.
//
// A transition is a WIDGET (widget_type='transition'), not a schema column. Its config lives in the
// widget's `config` JSON. Here we resolve it against the shader manifest + params.js (the single source
// of truth) and NEVER trust the stored blob: an unknown/removed shader yields no transition (the player
// hard-cuts), params are clamped to each shader's declared range, and duration is bounded. The result
// is attached to the visible item the transition plays INTO, and the transition widget itself is
// dropped from the snapshot so it never renders as content.
const path = require('path');
const MANIFEST = require(path.join(__dirname, '../../shared/Transitions/manifest.json'));
const { resolveParams } = require(path.join(__dirname, '../../shared/Transitions/params.js'));

const BY_ID = new Map(MANIFEST.map((m) => [m.id, m]));
const MIN_MS = 150, MAX_MS = 3000, DEFAULT_MS = 800;

// Parse + validate + clamp a transition config. A transition holds one OR MORE effects; the player
// picks one at random per advance (variety). Returns { effects:[{shader,params}], durationMs, scope }
// or null (unknown/empty -> no transition -> the player hard-cuts). Params live in a by-shader-id map;
// a single flat params object is also accepted (single-effect shape).
function resolveTransitionConfig(configJsonOrObj) {
  let cfg;
  if (typeof configJsonOrObj === 'string') { try { cfg = JSON.parse(configJsonOrObj); } catch (e) { return null; } }
  else cfg = configJsonOrObj || {};
  const ids = Array.isArray(cfg.shaders) ? cfg.shaders : (cfg.shader ? [cfg.shader] : []);
  const paramsMap = (cfg.params && typeof cfg.params === 'object') ? cfg.params : {};
  const effects = [];
  const seen = new Set();
  for (const id of ids) {
    const entry = BY_ID.get(String(id));
    if (!entry || seen.has(entry.id)) continue; // unknown/removed or dup -> skip
    seen.add(entry.id);
    // per-shader params from the map, else (single-effect shape) a flat params object, else defaults
    const stored = paramsMap[entry.id] || (ids.length === 1 ? paramsMap : {});
    effects.push({
      shader: entry.id,
      params: resolveParams(entry.params.map((p) => ({ name: p.name, default: p.default, min: p.min, max: p.max })), stored),
    });
  }
  if (!effects.length) return null; // no valid effect -> hard cut, never a black frame
  let durationMs = Number(cfg.durationMs);
  if (!Number.isFinite(durationMs)) durationMs = DEFAULT_MS;
  durationMs = Math.max(MIN_MS, Math.min(MAX_MS, Math.round(durationMs)));
  const scope = cfg.scope === 'next' ? 'next' : 'all'; // default: one widget covers the whole playlist
  return { effects, durationMs, scope };
}

// Walk snapshot items: drop transition-widget items, attach a resolved `transition` to the visible
// item each applies to (the one you transition INTO). scope:'all' sets a playlist-wide default;
// scope:'next' overrides the immediately-following visible item. A trailing scope:'next' with no
// following item wraps onto the first item (playlists loop, so last->first is a real advance).
function normalizeTransitions(items) {
  const visible = [];
  let pendingNext = null, playlistDefault = null;
  for (const it of items) {
    if (it && it.widget_type === 'transition') {
      const cfg = resolveTransitionConfig(it.widget_config);
      if (cfg) { if (cfg.scope === 'all') playlistDefault = cfg; else pendingNext = cfg; }
      continue; // normalized out — never a visible item
    }
    visible.push(it);
    it.__override = pendingNext;
    pendingNext = null;
  }
  if (pendingNext && visible.length) visible[0].__override = visible[0].__override || pendingNext;
  for (const it of visible) {
    const t = it.__override || playlistDefault;
    delete it.__override;
    if (t) it.transition = { effects: t.effects, durationMs: t.durationMs };
  }
  return visible;
}

module.exports = { resolveTransitionConfig, normalizeTransitions, MANIFEST };
