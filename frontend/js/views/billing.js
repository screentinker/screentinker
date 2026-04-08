import { api } from '../api.js';
import { showToast } from '../components/toast.js';

export async function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Subscription</h1>
        <div class="subtitle">Manage your plan and billing</div>
      </div>
    </div>
    <div id="billingContent"><div class="empty-state"><h3>Loading...</h3></div></div>
  `;

  try {
    const [subData, plans] = await Promise.all([
      fetch('/api/subscription/me', { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }}).then(r => r.json()),
      fetch('/api/subscription/plans').then(r => r.json())
    ]);

    const content = document.getElementById('billingContent');

    content.innerHTML = `
      <!-- Current Plan -->
      <div class="settings-section">
        <h3>Current Plan</h3>
        <div style="display:flex;align-items:center;gap:16px;margin-bottom:16px">
          <div style="font-size:28px;font-weight:700;color:var(--accent)">${subData.plan.display_name}</div>
          ${subData.self_hosted ? '<span style="background:var(--success-dim);color:var(--success);padding:4px 10px;border-radius:12px;font-size:11px;font-weight:500">Self-Hosted</span>' : ''}
          ${subData.trial?.active ? `<span style="background:var(--warning-dim);color:var(--warning);padding:4px 10px;border-radius:12px;font-size:11px;font-weight:500">Trial - ${subData.trial.days_left} days left</span>` : ''}
        </div>
        ${subData.trial?.active ? `
        <div style="background:var(--bg-secondary);border:1px solid var(--warning);border-radius:var(--radius);padding:12px 16px;margin-bottom:16px;display:flex;align-items:center;gap:12px">
          <span style="font-size:20px">&#9201;</span>
          <div>
            <div style="font-size:13px;font-weight:500">Your ${subData.trial.plan?.charAt(0).toUpperCase() + subData.trial.plan?.slice(1)} trial ends in ${subData.trial.days_left} days</div>
            <div style="font-size:12px;color:var(--text-muted)">After the trial, you'll be moved to the Free plan (1 device). Upgrade now to keep all your devices and features.</div>
          </div>
        </div>
        ` : ''}
        <div class="info-grid" style="margin-bottom:0">
          <div class="info-card">
            <div class="info-card-label">Devices</div>
            <div class="info-card-value">${subData.usage.devices} <span style="font-size:14px;color:var(--text-secondary)">/ ${subData.plan.max_devices === -1 ? 'Unlimited' : subData.plan.max_devices}</span></div>
            ${subData.plan.max_devices > 0 ? `
            <div class="progress-bar">
              <div class="progress-bar-fill ${subData.usage.devices / subData.plan.max_devices > 0.8 ? 'warning' : 'success'}"
                   style="width:${Math.min(100, (subData.usage.devices / subData.plan.max_devices) * 100)}%"></div>
            </div>` : ''}
          </div>
          <div class="info-card">
            <div class="info-card-label">Storage</div>
            <div class="info-card-value small">${subData.usage.storage_mb} MB <span style="color:var(--text-secondary)">/ ${subData.plan.max_storage_mb === -1 ? 'Unlimited' : subData.plan.max_storage_mb + ' MB'}</span></div>
            ${subData.plan.max_storage_mb > 0 ? `
            <div class="progress-bar">
              <div class="progress-bar-fill ${subData.usage.storage_mb / subData.plan.max_storage_mb > 0.8 ? 'warning' : 'success'}"
                   style="width:${Math.min(100, (subData.usage.storage_mb / subData.plan.max_storage_mb) * 100)}%"></div>
            </div>` : ''}
          </div>
          <div class="info-card">
            <div class="info-card-label">Features</div>
            <div style="font-size:13px;margin-top:4px">
              ${subData.plan.remote_control ? '<div style="color:var(--success)">&#10003; Remote Control</div>' : '<div style="color:var(--text-muted)">&#10007; Remote Control</div>'}
              ${subData.plan.remote_url ? '<div style="color:var(--success)">&#10003; Remote URLs</div>' : '<div style="color:var(--text-muted)">&#10007; Remote URLs</div>'}
              ${subData.plan.priority_support ? '<div style="color:var(--success)">&#10003; Priority Support</div>' : '<div style="color:var(--text-muted)">&#10007; Priority Support</div>'}
            </div>
          </div>
        </div>
      </div>

      <!-- Plans -->
      <div class="settings-section">
        <h3>Available Plans</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(240px, 1fr));gap:16px">
          ${plans.map(p => `
            <div style="background:var(--bg-secondary);border:${p.id === subData.plan.id ? '2px solid var(--accent)' : '1px solid var(--border)'};border-radius:var(--radius-lg);padding:20px;position:relative">
              ${p.id === subData.plan.id ? '<div style="position:absolute;top:-10px;right:12px;background:var(--accent);color:white;padding:2px 10px;border-radius:10px;font-size:11px;font-weight:500">Current</div>' : ''}
              <div style="font-size:18px;font-weight:700;margin-bottom:4px">${p.display_name}</div>
              <div style="font-size:24px;font-weight:700;color:var(--accent);margin-bottom:12px">
                ${p.price_monthly > 0 ? `$${p.price_monthly}<span style="font-size:13px;color:var(--text-secondary);font-weight:400">/mo</span>` : 'Free'}
              </div>
              <div style="font-size:13px;color:var(--text-secondary);line-height:2">
                <div>${p.max_devices === -1 ? 'Unlimited' : p.max_devices} devices</div>
                <div>${p.max_storage_mb === -1 ? 'Unlimited' : (p.max_storage_mb >= 1024 ? (p.max_storage_mb/1024) + ' GB' : p.max_storage_mb + ' MB')} storage</div>
                <div>${p.remote_control ? '&#10003;' : '&#10007;'} Remote Control</div>
                <div>${p.remote_url ? '&#10003;' : '&#10007;'} Remote URLs</div>
                <div>${p.priority_support ? '&#10003;' : '&#10007;'} Priority Support</div>
              </div>
              ${p.price_yearly > 0 ? `<div style="font-size:11px;color:var(--text-muted);margin-top:8px">or $${p.price_yearly}/year (save ${Math.round((1 - p.price_yearly / (p.price_monthly * 12)) * 100)}%)</div>` : ''}
              ${!subData.self_hosted && p.price_monthly > 0 && p.id !== subData.plan.id ? `
                <div style="margin-top:12px;display:flex;gap:6px">
                  <button class="btn btn-primary btn-sm" style="flex:1" onclick="window._checkout('${p.id}','monthly')">Monthly</button>
                  ${p.price_yearly > 0 ? `<button class="btn btn-secondary btn-sm" style="flex:1" onclick="window._checkout('${p.id}','yearly')">Yearly</button>` : ''}
                </div>
              ` : ''}
              ${!subData.self_hosted && p.id === subData.plan.id && subData.subscription?.stripe_subscription_id ? `
                <button class="btn btn-secondary btn-sm" style="width:100%;margin-top:12px" onclick="window._manageSubscription()">Manage Subscription</button>
              ` : ''}
            </div>
          `).join('')}
        </div>
        ${subData.self_hosted ? '<p style="color:var(--text-muted);font-size:12px;margin-top:12px">Self-hosted mode: plans can be assigned by admins without billing.</p>' : ''}
      </div>
    `;
    // Checkout handler
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
        showToast('Failed to start checkout: ' + err.message, 'error');
      }
    };

    // Manage subscription handler (Stripe Customer Portal)
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
        showToast('Failed to open billing portal: ' + err.message, 'error');
      }
    };

    // Check for payment success/cancel in URL
    if (window.location.hash.includes('payment=success')) {
      showToast('Payment successful! Your plan has been upgraded.', 'success');
      window.location.hash = '#/billing';
    }

  } catch (err) {
    document.getElementById('billingContent').innerHTML = `<div class="empty-state"><h3>Failed to load</h3><p>${err.message}</p></div>`;
  }
}

export function cleanup() {}
