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
    const [subData, plans] = await Promise.all([
      fetch('/api/subscription/me', { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }}).then(r => r.json()),
      fetch('/api/subscription/plans').then(r => r.json())
    ]);

    const content = document.getElementById('billingContent');

    content.innerHTML = `
      <div class="settings-section">
        <h3>${t('billing.current_plan')}</h3>
        <div style="display:flex;align-items:center;gap:16px;margin-bottom:16px">
          <div style="font-size:28px;font-weight:700;color:var(--accent)">${subData.plan.display_name}</div>
          ${subData.self_hosted ? `<span style="background:var(--success-dim);color:var(--success);padding:4px 10px;border-radius:12px;font-size:11px;font-weight:500">${t('billing.self_hosted')}</span>` : ''}
          ${subData.trial?.active ? `<span style="background:var(--warning-dim);color:var(--warning);padding:4px 10px;border-radius:12px;font-size:11px;font-weight:500">${t('billing.trial_days_left', { n: subData.trial.days_left })}</span>` : ''}
        </div>
        ${subData.trial?.active ? `
        <div style="background:var(--bg-secondary);border:1px solid var(--warning);border-radius:var(--radius);padding:12px 16px;margin-bottom:16px;display:flex;align-items:center;gap:12px">
          <span style="font-size:20px">&#9201;</span>
          <div>
            <div style="font-size:13px;font-weight:500">${t('billing.trial_ends', { plan: (subData.trial.plan?.charAt(0).toUpperCase() + subData.trial.plan?.slice(1)) || '', n: subData.trial.days_left })}</div>
            <div style="font-size:12px;color:var(--text-muted)">${t('billing.trial_after')}</div>
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
        <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(240px, 1fr));gap:16px">
          ${plans.map(p => `
            <div style="background:var(--bg-secondary);border:${p.id === subData.plan.id ? '2px solid var(--accent)' : '1px solid var(--border)'};border-radius:var(--radius-lg);padding:20px;position:relative">
              ${p.id === subData.plan.id ? `<div style="position:absolute;top:-10px;right:12px;background:var(--accent);color:white;padding:2px 10px;border-radius:10px;font-size:11px;font-weight:500">${t('billing.current')}</div>` : ''}
              <div style="font-size:18px;font-weight:700;margin-bottom:4px">${p.display_name}</div>
              <div style="font-size:24px;font-weight:700;color:var(--accent);margin-bottom:12px">
                ${p.price_monthly > 0 ? `€${p.price_monthly}<span style="font-size:13px;color:var(--text-secondary);font-weight:400">${t('billing.per_month')}</span>` : t('billing.free')}
              </div>
              <div style="font-size:13px;color:var(--text-secondary);line-height:2">
                <div>${p.max_devices === -1 ? t('billing.unlimited') : p.max_devices} ${t('billing.devices_lc')}</div>
                <div>${p.max_storage_mb === -1 ? t('billing.unlimited') : (p.max_storage_mb >= 1024 ? (p.max_storage_mb/1024) + ' GB' : p.max_storage_mb + ' MB')} ${t('billing.storage_lc')}</div>
                <div>${p.remote_control ? '&#10003;' : '&#10007;'} ${t('billing.feat.remote_control')}</div>
                <div>${p.remote_url ? '&#10003;' : '&#10007;'} ${t('billing.feat.remote_urls')}</div>
                <div>${p.priority_support ? '&#10003;' : '&#10007;'} ${t('billing.feat.priority_support')}</div>
              </div>
              ${p.price_yearly > 0 ? `<div style="font-size:11px;color:var(--text-muted);margin-top:8px">${t('billing.yearly_save', { price: p.price_yearly, pct: Math.round((1 - p.price_yearly / (p.price_monthly * 12)) * 100) })}</div>` : ''}
              ${!subData.self_hosted && p.price_monthly > 0 && p.id !== subData.plan.id ? `
                <div style="margin-top:12px;display:flex;gap:6px">
                  <button class="btn btn-primary btn-sm" style="flex:1" onclick="window._checkout('${p.id}','monthly')">${t('billing.monthly')}</button>
                  ${p.price_yearly > 0 ? `<button class="btn btn-secondary btn-sm" style="flex:1" onclick="window._checkout('${p.id}','yearly')">${t('billing.yearly')}</button>` : ''}
                </div>
              ` : ''}
              ${!subData.self_hosted && p.id === subData.plan.id && subData.subscription?.stripe_subscription_id ? `
                <button class="btn btn-secondary btn-sm" style="width:100%;margin-top:12px" onclick="window._manageSubscription()">${t('billing.manage_subscription')}</button>
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
          body: JSON.stringify({ plan_id: planId, interval })
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
    }

  } catch (err) {
    document.getElementById('billingContent').innerHTML = `<div class="empty-state"><h3>${t('billing.failed_to_load')}</h3><p>${esc(err.message)}</p></div>`;
  }
}

export function cleanup() {}
