/*
 * "My endpoint" vs "ScreenTinker credits" — the path and model picker for hosted AI images.
 *
 * ⚠️ THE USER CHOOSES THE MODEL AND SEES ITS PRICE FIRST. Every row shows its credits and dollars;
 * the cheap row is PRESELECTED (highlighted) the first time, never silently substituted, and the
 * last choice is remembered per workspace in this browser only — a convenience, not a lock. The
 * server has no default model at all, so nothing here can be upgraded behind the user's back.
 *
 * Renders nothing when the server has no hosted provider configured (self-hosted with no platform
 * keys): the BYO path is then the only path, exactly as before.
 */
import { api } from '../api.js';
import { esc } from '../utils.js';
import { showToast } from './toast.js';

const keyOf = (r) => [r.provider, r.model, r.resolution, r.quality].join('|');

function workspaceId() {
  try { return (JSON.parse(localStorage.getItem('user') || '{}').current_workspace_id) || 'none'; } catch { return 'none'; }
}
const PREF = () => `st_ai_hosted_pref_${workspaceId()}`;
function loadPref() { try { return JSON.parse(localStorage.getItem(PREF()) || 'null'); } catch { return null; } }
function savePref(p) { try { localStorage.setItem(PREF(), JSON.stringify(p)); } catch { /* private window */ } }

export const usd = (n) => `$${Number(n).toFixed(2)}`;

/** "grok-imagine-image · 1K · 4 credits · $0.04", "grok-imagine-image-2.0 · 1K low · 8 credits · $0.08" */
export function formatRow(r) {
  const tier = r.quality && r.quality !== 'standard' ? `${r.resolution} ${r.quality}` : r.resolution;
  return `${r.model} · ${tier} · ${r.credits} credits · ${usd(r.charge_usd)}`;
}

/** Turn a 402 / an unaffordable choice into the right next step for this user. */
export async function offerCredits(status, needed) {
  const short = needed != null ? ` This image needs ${needed} credits; you have ${status.balance}.` : '';
  if (!status.can_buy) { showToast(`Not enough AI credits.${short} Ask an organization admin to buy more.`, 'error'); return; }
  if (!status.checkout_available) { showToast(`Not enough AI credits.${short} Online purchase is not set up here — contact your administrator.`, 'error'); return; }
  const pack = status.packs[0];
  // eslint-disable-next-line no-alert
  if (!confirm(`Not enough AI credits.${short}\n\nBuy ${pack.credits.toLocaleString()} credits for ${usd(pack.usd)}? (Larger packs are in Settings → AI credits.)`)) return;
  await buyPack(pack.id);
}

export async function buyPack(packId) {
  try {
    const { url } = await api.aiHostedCheckout(packId);
    if (url) window.location.href = url;
  } catch (e) { showToast(e.message, 'error'); }
}

/**
 * Mount the picker into `el`. Resolves to a controller, or null when hosted AI is off.
 *   ctl.isHosted()   — the user picked "ScreenTinker credits"
 *   ctl.generate(prompt, dims) — confirm the cost, spend, and return {content_id, ...} (or null)
 */
export async function mountHostedPicker(el) {
  let status;
  try { status = await api.aiHostedStatus(); } catch { status = null; }
  if (!status || !status.enabled || !status.catalog.length) { el.style.display = 'none'; return null; }

  const pref = loadPref() || {};
  const byKey = new Map(status.catalog.map((r) => [keyOf(r), r]));
  const hi = status.highlight ? keyOf(status.highlight) : null;
  let path = pref.path === 'hosted' ? 'hosted' : 'byo';
  let choice = byKey.has(pref.key) ? pref.key : (byKey.has(hi) ? hi : keyOf(status.catalog[0]));

  function paint() {
    const sel = byKey.get(choice);
    const afford = sel && status.balance >= sel.credits;
    el.style.display = 'flex';
    el.innerHTML = `
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted)">
        Images from
        <select id="aiPathSel" class="input" style="margin:0;padding:3px 6px;font-size:12px">
          <option value="byo" ${path === 'byo' ? 'selected' : ''}>My endpoint</option>
          <option value="hosted" ${path === 'hosted' ? 'selected' : ''}>ScreenTinker credits</option>
        </select>
      </label>
      ${path === 'hosted' ? `
        <select id="aiModelSel" class="input" style="margin:0;padding:3px 6px;font-size:12px;max-width:380px" title="Model, resolution and quality — each row shows what it costs">
          ${status.catalog.map((r) => `<option value="${esc(keyOf(r))}" ${keyOf(r) === choice ? 'selected' : ''}>${esc(formatRow(r))}${keyOf(r) === hi ? ' (cheapest)' : ''}${status.balance < r.credits ? ' — not enough credits' : ''}</option>`).join('')}
        </select>
        <span style="font-size:12px;color:${afford ? 'var(--text-muted)' : 'var(--danger, #e05252)'}">
          ${esc(String(status.balance))} credits left${status.included_remaining ? ` (${esc(String(status.included_remaining))} included this month)` : ''}
        </span>
        ${!afford ? '<button class="btn btn-secondary btn-sm" id="aiBuyBtn">Buy credits</button>' : ''}
        ${status.rate_card && status.rate_card.stale ? `<span style="font-size:11px;color:var(--danger, #e05252)" >Rate card last verified ${esc(status.rate_card.verified_at)} — re-check provider prices</span>` : ''}
      ` : ''}`;
    el.querySelector('#aiPathSel').addEventListener('change', (e) => { path = e.target.value; savePref({ path, key: choice }); paint(); });
    const m = el.querySelector('#aiModelSel');
    if (m) m.addEventListener('change', (e) => { choice = e.target.value; savePref({ path, key: choice }); paint(); });
    const buy = el.querySelector('#aiBuyBtn');
    if (buy) buy.addEventListener('click', () => offerCredits(status, sel && sel.credits));
  }
  paint();

  return {
    isHosted: () => path === 'hosted',
    async generate(prompt, dims) {
      const sel = byKey.get(choice);
      if (!sel) throw new Error('Choose a model first.');
      if (status.balance < sel.credits) { await offerCredits(status, sel.credits); return null; }
      // eslint-disable-next-line no-alert
      if (!confirm(`Generate with ${formatRow(sel)}?\n\nThis spends ${sel.credits} credits (${usd(sel.charge_usd)}). You have ${status.balance}. Nothing is charged if generation fails.`)) return null;
      const idempotency_key = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');
      try {
        const out = await api.aiHostedGenerate({
          provider: sel.provider, model: sel.model, resolution: sel.resolution, quality: sel.quality,
          prompt, idempotency_key, ...(dims || {}),
        });
        Object.assign(status, { balance: out.balance, included_remaining: out.included_remaining, purchased_remaining: out.purchased_remaining });
        paint();
        return out;
      } catch (e) {
        if (e.status === 402 && e.body) {
          Object.assign(status, { balance: e.body.balance, included_remaining: e.body.included_remaining });
          paint();
          await offerCredits(status, e.body.needed);
          return null;
        }
        throw e;
      }
    },
  };
}
