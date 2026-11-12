import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';

export async function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>${t('billing.title')}</h1>
        <div class="subtitle">${t('billing.subtitle')}</div>
      </div>
    </div>
    <div id="billingContent"><div class="empty-state"><h3>${t('common.loading')}</h3></div></div>
  `;

  try {
    const [subData, plans, promoRes] = await Promise.all([
      fetch('/api/subscription/me', { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }}).then(r => r.json()),
      fetch('/api/subscription/plans').then(r => r.json()),
      fetch('/api/subscription/promotion').then(r => (r.ok ? r.json() : {})).catch(() => ({}))
    ]);
    /*
     * A running sale (lib/promotions.js). Shown only where checkout will actually apply it: a
     * customer who already has a subscription is sent to Stripe's billing portal to change plan,
     * and the portal does not take the sale's coupon — so for them the sale price would be a lie.
     */
    const promo = (promoRes && promoRes.promotion) || null;
    const saleEligible = promo && !subData.self_hosted && !subData.subscription?.stripe_subscription_id;
    const saleFor = (p, cycle) => saleEligible && p.price_monthly > 0
      && (promo.cycles === 'both' || promo.cycles === cycle)
      && (!promo.plan_ids.length || promo.plan_ids.includes(p.id));
    const cut = (n) => Math.round(Number(n) * (100 - (promo ? promo.percent_off : 0))) / 100;


    const content = document.getElementById('billingContent');
    if (!content) return; // navigated away while the plans were loading

    /*
     * 3.0: which plan to point at. The plan a prompt sent them for (?plan=), else the cheapest paid
     * plan that fits what this account already runs — "you have 6 screens, Starter covers 8" is a
     * reason, "Upgrade" is not. Never on self-hosted, never for someone already paying.
     */
    const params = new URLSearchParams((window.location.hash.split('?')[1]) || '');
    const from = (params.get('from') || 'direct').slice(0, 40);
    const paying = !!subData.subscription?.stripe_subscription_id;
    // Set when limits and payment are the organization's (GET /api/subscription/me `billing`).
    // can_manage: its owner and organization admins; everyone in it may buy a plan.
    const orgBilling = subData.billing && subData.billing.scope === 'org' ? subData.billing : null;
    const mayManage = !orgBilling || orgBilling.can_manage;
    const freePlan = plans.find((p) => p.id === 'free' || p.name === 'free') || null;
    const fits = (p) => (p.max_devices === -1 || p.max_devices >= Math.max(1, subData.usage.devices))
      && (p.max_storage_mb === -1 || p.max_storage_mb > subData.usage.storage_mb);
    let recommendedId = null;
    if (!subData.self_hosted && !paying) {
      const asked = params.get('plan');
      if (asked && plans.some((p) => p.id === asked && p.price_monthly > 0)) recommendedId = asked;
      else {
        const pick = plans.filter((p) => p.price_monthly > 0 && fits(p)).sort((a, b) => a.price_monthly - b.price_monthly)[0];
        if (pick) recommendedId = pick.id;
      }
    }
    if (!subData.self_hosted) api.trackEvent('billing_view', { from, plan: recommendedId || '' });

    content.innerHTML = `
      <div class="settings-section">
        <h3>${t('billing.current_plan')}</h3>
        ${orgBilling ? `
        <!-- The plan belongs to the organization, not to the person looking at it. -->
        <p id="billingOrgNote" style="font-size:13px;color:var(--text-secondary);margin:0 0 12px">
          ${esc(t('billing.org.belongs', { org: orgBilling.organization_name || '' }))}
          ${orgBilling.can_manage ? '' : `<br>${esc(paying ? t('billing.org.ask_owner', { owner: orgBilling.owner_name || '' }) : t('billing.org.anyone_can_buy'))}`}
        </p>` : ''}
        <div style="display:flex;align-items:center;gap:16px;margin-bottom:16px">
          <div style="font-size:28px;font-weight:700;color:var(--accent)">${esc(subData.plan.display_name)}</div>
          ${subData.self_hosted ? `<span style="background:var(--success-dim);color:var(--success);padding:4px 10px;border-radius:12px;font-size:11px;font-weight:500">${t('billing.self_hosted')}</span>` : ''}
          ${subData.trial?.active ? `<span style="background:var(--warning-dim);color:var(--warning);padding:4px 10px;border-radius:12px;font-size:11px;font-weight:500">${t('billing.trial_days_left', { n: subData.trial.days_left })}</span>` : ''}
        </div>
        ${subData.trial?.active ? `
        <div style="background:var(--bg-secondary);border:1px solid var(--warning);border-radius:var(--radius);padding:12px 16px;margin-bottom:16px;display:flex;align-items:center;gap:12px">
          <span style="font-size:20px">&#9201;</span>
          <div>
            <div style="font-size:13px;font-weight:500">${t('billing.trial_ends', { plan: (subData.trial.plan?.charAt(0).toUpperCase() + subData.trial.plan?.slice(1)) || '', n: subData.trial.days_left })}</div>
            <div style="font-size:12px;color:var(--text-muted)">${t('billing.trial_after', { n: freePlan ? freePlan.max_devices : 1 })}</div>
          </div>
        </div>
        <!-- 3.0: what the end of a trial actually means, before it happens. -->
        <div class="billing-keep-lose">
          <div>
            <h4>${t('billing.keep.title')}</h4>
            <ul>
              <li>${t('billing.keep.content')}</li>
              <li>${t('billing.keep.screens', { n: freePlan ? freePlan.max_devices : 1 })}</li>
              <li>${t('billing.keep.account')}</li>
            </ul>
          </div>
          <div>
            <h4>${t('billing.lose.title')}</h4>
            <ul>
              <li>${t('billing.lose.screens', { n: freePlan ? freePlan.max_devices : 1 })}</li>
              ${freePlan && !freePlan.remote_url ? `<li>${t('billing.lose.remote_url')}</li>` : ''}
              ${freePlan && !freePlan.remote_control ? `<li>${t('billing.lose.remote_control')}</li>` : ''}
              ${freePlan && freePlan.max_storage_mb !== -1 ? `<li>${t('billing.lose.storage', { size: freePlan.max_storage_mb >= 1024 ? (freePlan.max_storage_mb / 1024) + ' GB' : freePlan.max_storage_mb + ' MB' })}</li>` : ''}
            </ul>
          </div>
        </div>
        ` : ''}
        ${(!subData.trial?.active && subData.trial?.expired_at && subData.plan.name === 'free') ? `
        <div style="background:var(--bg-secondary);border:1px solid var(--warning);border-radius:var(--radius);padding:12px 16px;margin-bottom:16px;display:flex;align-items:center;gap:12px">
          <span style="font-size:20px">&#9201;</span>
          <div>
            <div style="font-size:13px;font-weight:500">${t('billing.trial_ended', { plan: (subData.trial.plan?.charAt(0).toUpperCase() + subData.trial.plan?.slice(1)) || '', date: esc(new Date(subData.trial.expired_at).toLocaleDateString()) })}</div>
            <div style="font-size:12px;color:var(--text-muted)">${t('billing.trial_ended_after', { n: subData.plan.max_devices })}</div>
          </div>
        </div>
        ` : ''}
        <div class="info-grid" style="margin-bottom:0">
          <div class="info-card">
            <div class="info-card-label">${t('billing.devices')}</div>
            <div class="info-card-value">${subData.usage.devices} <span style="font-size:14px;color:var(--text-secondary)">/ ${subData.plan.max_devices === -1 ? t('billing.unlimited') : subData.plan.max_devices}</span></div>
            ${subData.plan.max_devices > 0 ? `
            <div class="progress-bar">
              <div class="progress-bar-fill ${subData.usage.devices / subData.plan.max_devices > 0.8 ? 'warning' : 'success'}"
                   style="width:${Math.min(100, (subData.usage.devices / subData.plan.max_devices) * 100)}%"></div>
            </div>` : ''}
          </div>
          <div class="info-card">
            <div class="info-card-label">${t('billing.storage')}</div>
            <div class="info-card-value small">${subData.usage.storage_mb} MB <span style="color:var(--text-secondary)">/ ${subData.plan.max_storage_mb === -1 ? t('billing.unlimited') : subData.plan.max_storage_mb + ' MB'}</span></div>
            ${subData.plan.max_storage_mb > 0 ? `
            <div class="progress-bar">
              <div class="progress-bar-fill ${subData.usage.storage_mb / subData.plan.max_storage_mb > 0.8 ? 'warning' : 'success'}"
                   style="width:${Math.min(100, (subData.usage.storage_mb / subData.plan.max_storage_mb) * 100)}%"></div>
            </div>` : ''}
          </div>
          <div class="info-card">
            <div class="info-card-label">${t('billing.features')}</div>
            <div style="font-size:13px;margin-top:4px">
              ${subData.plan.remote_control ? `<div style="color:var(--success)">&#10003; ${t('billing.feat.remote_control')}</div>` : `<div style="color:var(--text-muted)">&#10007; ${t('billing.feat.remote_control')}</div>`}
              ${subData.plan.remote_url ? `<div style="color:var(--success)">&#10003; ${t('billing.feat.remote_urls')}</div>` : `<div style="color:var(--text-muted)">&#10007; ${t('billing.feat.remote_urls')}</div>`}
              ${subData.plan.priority_support ? `<div style="color:var(--success)">&#10003; ${t('billing.feat.priority_support')}</div>` : `<div style="color:var(--text-muted)">&#10007; ${t('billing.feat.priority_support')}</div>`}
            </div>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h3>${t('billing.available_plans')}</h3>
        ${saleEligible ? `<div class="billing-sale"><span class="billing-sale-tag">${t('billing.sale_tag', { pct: promo.percent_off })}</span><strong>${esc(promo.headline)}</strong>${promo.ends_at ? `<span class="billing-sale-end">${t('billing.sale_ends', { when: new Date(promo.ends_at * 1000).toLocaleString() })}</span>` : ''}</div>` : ''}
        <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(240px, 1fr));gap:16px">
          ${plans.map(p => `
            <div id="plan-card-${esc(p.id)}" style="background:var(--bg-secondary);border:${p.id === subData.plan.id ? '2px solid var(--accent)' : p.id === recommendedId ? '2px solid var(--success)' : '1px solid var(--border)'};border-radius:var(--radius-lg);padding:20px;position:relative">
              ${p.id === subData.plan.id ? `<div style="position:absolute;top:-10px;right:12px;background:var(--accent);color:white;padding:2px 10px;border-radius:10px;font-size:11px;font-weight:500">${t('billing.current')}</div>` : ''}
              ${p.id === recommendedId && p.id !== subData.plan.id ? `<div style="position:absolute;top:-10px;right:12px;background:var(--success);color:#06210f;padding:2px 10px;border-radius:10px;font-size:11px;font-weight:600">${t('billing.recommended')}</div>` : ''}
              <div style="font-size:18px;font-weight:700;margin-bottom:4px">${esc(p.display_name)}</div>
              <div style="font-size:24px;font-weight:700;color:var(--accent);margin-bottom:12px">
                ${p.price_monthly > 0
                  ? (saleFor(p, 'monthly')
                    ? `<s class="billing-was">$${p.price_monthly}</s> $${cut(p.price_monthly)}<span style="font-size:13px;color:var(--text-secondary);font-weight:400">${t('billing.per_month')}</span>`
                    : `$${p.price_monthly}<span style="font-size:13px;color:var(--text-secondary);font-weight:400">${t('billing.per_month')}</span>`)
                  : t('billing.free')}
              </div>
              ${p.id === recommendedId && p.id !== subData.plan.id ? `<div style="font-size:12px;color:var(--success);margin:-6px 0 8px">${subData.usage.devices > 0 ? t('billing.recommended_why', { n: subData.usage.devices }) : t('billing.recommended_why_new')}</div>` : ''}
              <div style="font-size:13px;color:var(--text-secondary);line-height:2">
                <div>${p.max_devices === -1 ? t('billing.unlimited') : p.max_devices} ${t('billing.devices_lc')}</div>
                <div>${p.max_storage_mb === -1 ? t('billing.unlimited') : (p.max_storage_mb >= 1024 ? (p.max_storage_mb/1024) + ' GB' : p.max_storage_mb + ' MB')} ${t('billing.storage_lc')}</div>
                <div>${p.remote_control ? '&#10003;' : '&#10007;'} ${t('billing.feat.remote_control')}</div>
                <div>${p.remote_url ? '&#10003;' : '&#10007;'} ${t('billing.feat.remote_urls')}</div>
                <div>${p.priority_support ? '&#10003;' : '&#10007;'} ${t('billing.feat.priority_support')}</div>
              </div>
              ${p.price_yearly > 0 ? (saleFor(p, 'yearly')
                ? `<div style="font-size:12px;margin-top:8px">${t('billing.yearly_sale', { was: p.price_yearly, now: cut(p.price_yearly) })}</div>`
                : `<div style="font-size:11px;color:var(--text-muted);margin-top:8px">${t('billing.yearly_save', { price: p.price_yearly, pct: Math.round((1 - p.price_yearly / (p.price_monthly * 12)) * 100) })}</div>`) : ''}
              ${saleFor(p, 'monthly') || saleFor(p, 'yearly') ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px">${t(`billing.sale_dur_${promo.duration}`, { n: promo.duration_in_months })}</div>` : ''}
              ${!subData.self_hosted && p.price_monthly > 0 && p.id !== subData.plan.id && (mayManage || !paying) ? `
                <div style="margin-top:12px;display:flex;gap:6px">
                  <button class="btn btn-primary btn-sm" style="flex:1" onclick="window._checkout('${p.id}','monthly')">${t('billing.monthly')}</button>
                  ${p.price_yearly > 0 ? `<button class="btn btn-secondary btn-sm" style="flex:1" onclick="window._checkout('${p.id}','yearly')">${t('billing.yearly')}</button>` : ''}
                </div>
              ` : ''}
              ${!subData.self_hosted && p.id === subData.plan.id && subData.subscription?.stripe_subscription_id ? `
                ${mayManage ? `<button class="btn btn-secondary btn-sm" style="width:100%;margin-top:12px" onclick="window._manageSubscription()">${t('billing.manage_subscription')}</button>` : ''}
              ` : ''}
            </div>
          `).join('')}
        </div>
        ${subData.self_hosted ? `<p style="color:var(--text-muted);font-size:12px;margin-top:12px">${t('billing.self_hosted_note')}</p>` : ''}
      </div>
    `;

    window._checkout = async (planId, interval) => {
      try {
        const res = await fetch('/api/stripe/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
          body: JSON.stringify({ plan_id: planId, interval, from })
        });
        const data = await res.json();
        if (data.error) { showToast(data.error, 'error'); return; }
        if (data.url) window.location.href = data.url;
      } catch (err) {
        showToast(t('billing.toast.checkout_failed', { error: err.message }), 'error');
      }
    };

    window._manageSubscription = async () => {
      try {
        const res = await fetch('/api/stripe/portal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
        });
        const data = await res.json();
        if (data.error) { showToast(data.error, 'error'); return; }
        if (data.url) window.location.href = data.url;
      } catch (err) {
        showToast(t('billing.toast.portal_failed', { error: err.message }), 'error');
      }
    };

    if (window.location.hash.includes('payment=success')) {
      showToast(t('billing.toast.payment_success'), 'success');
      window.location.hash = '#/billing';
    } else if (window.location.hash.includes('payment=cancelled')) {
      // 3.0: Stripe sends people back here when they close checkout. Say plainly nothing happened.
      showToast(t('billing.toast.payment_cancelled'), 'info');
    }
    if (recommendedId && params.get('plan')) {
      document.getElementById(`plan-card-${recommendedId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

  } catch (err) {
    const host = document.getElementById('billingContent');
    if (host) host.innerHTML = `<div class="empty-state"><h3>${t('billing.failed_to_load')}</h3><p>${esc(err.message)}</p></div>`;
  }
}

export function cleanup() {}
