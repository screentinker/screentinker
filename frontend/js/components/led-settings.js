/*
 * LED settings card on the device page (server/routes/device-led.js, server/lib/embedded-led-config.js):
 * brightness, power limit with brownout protection, colour order and matrix wiring of an
 * addressable-LED screen. Changes reach the screen on its next poll (X-ST-Led-Config); what the
 * firmware reports back (effective limit, learned limit, brownouts) is shown under the form.
 */
import { api } from '../api.js';
import { t } from '../i18n.js';
import { esc, canWrite } from '../utils.js';
import { showToast } from './toast.js';

/** Is this an addressable-LED screen? Mirrors lib/embedded-led-config.js isLedDevice. */
export function isLedScreen(device) {
  if (!device || device.client_type !== 'embedded') return false;
  const p = device.screen_profile;
  const raw = typeof p === 'string' ? p : JSON.stringify(p || '');
  return raw.includes('seeed-xiao-led');
}

const amps = (ma) => (ma > 0 ? `${(ma / 1000).toFixed(ma % 1000 === 0 ? 0 : 1)} A` : t('led.no_limit'));

function select(id, value, options, labelOf) {
  return `<select id="${id}" class="input" style="background:var(--bg-input)">${options.map((o) =>
    `<option value="${esc(o)}" ${o === value ? 'selected' : ''}>${esc(labelOf ? labelOf(o) : o)}</option>`).join('')}</select>`;
}

function stateHtml(s, config) {
  const st = s.state;
  if (!st) return `<div style="font-size:12px;color:var(--text-muted)">${t('led.state_none')}</div>`;
  const lines = [t('led.state_line', {
    limit: amps(st.effective_limit_ma || 0),
    est: st.frame_estimate_ma != null ? amps(st.frame_estimate_ma) : '?',
    brownouts: st.brownouts || 0,
  })];
  if (st.learned_limit_ma > 0) lines.push(t('led.state_learned', { limit: amps(st.learned_limit_ma) }));
  if (st.reset_reason) lines.push(t('led.last_reset', { reason: st.reset_reason }));
  return `<div style="font-size:12px;color:var(--text-muted);line-height:1.6">${lines.map(esc).join('<br>')}</div>
    ${st.learned_limit_ma > 0 && canWrite() ? `<button class="btn btn-secondary btn-sm" id="ledResetLearned" style="margin-top:6px">${t('led.reset_learned')}</button>` : ''}`;
}

export function mountLedSettings(host, device) {
  let s = null;
  const editable = canWrite();

  async function load() {
    try { s = await api.deviceLed(device.id); draw(); }
    catch (err) { host.textContent = err.message; }
  }

  function draw() {
    const c = s.config;
    const dis = editable ? '' : 'disabled';
    host.innerHTML = `
      <div style="display:grid;grid-template-columns:150px 1fr;gap:10px 14px;align-items:center;font-size:13px;max-width:520px">
        <label for="ledBrightness">${t('led.brightness')}</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="range" id="ledBrightness" min="0" max="255" value="${c.brightness}" ${dis} style="flex:1">
          <span id="ledBrightnessVal" style="min-width:3em;text-align:right">${c.brightness}</span>
        </div>
        <label for="ledPowerLimit">${t('led.power_limit')}</label>
        <div>
          <input type="number" id="ledPowerLimit" class="input" min="0" max="${s.options.power_limit_max_ma / 1000}" step="0.1"
            value="${c.power_limit_ma / 1000}" ${dis} style="width:8em;background:var(--bg-input)">
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">${t('led.power_limit_hint')}</div>
        </div>
        <label for="ledAutoProtect">${t('led.auto_protect')}</label>
        <div>
          <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="ledAutoProtect" ${c.auto_protect ? 'checked' : ''} ${dis}> ${t('led.auto_protect_on')}</label>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">${t('led.auto_protect_hint')}</div>
        </div>
        <label for="ledColorOrder">${t('led.color_order')}</label>
        ${select('ledColorOrder', c.color_order, s.options.color_order)}
        <label for="ledWiring">${t('led.wiring')}</label>
        ${select('ledWiring', c.wiring, s.options.wiring, (o) => t(`led.wiring_${o}`))}
        <label for="ledAxis">${t('led.axis')}</label>
        ${select('ledAxis', c.axis, s.options.axis, (o) => t(`led.axis_${o}`))}
        <label for="ledOrigin">${t('led.origin')}</label>
        ${select('ledOrigin', c.origin, s.options.origin, (o) => t(`led.origin_${o}`))}
      </div>
      ${editable ? `<button class="btn btn-primary btn-sm" id="ledSave" style="margin-top:12px">${t('led.save')}</button>` : ''}
      <div id="ledState" style="margin-top:12px">${stateHtml(s, c)}</div>`;
    if (!editable) host.querySelectorAll('select').forEach((el) => { el.disabled = true; });
    bind();
  }

  async function save(body) {
    try {
      s = await api.updateDeviceLed(device.id, body);
      draw();
      showToast(t('led.saved'));
    } catch (err) {
      showToast(t('led.save_failed', { error: err.message }), 'error');
    }
  }

  function bind() {
    const b = host.querySelector('#ledBrightness');
    b?.addEventListener('input', () => { host.querySelector('#ledBrightnessVal').textContent = b.value; });
    host.querySelector('#ledSave')?.addEventListener('click', () => {
      const limitA = Number(host.querySelector('#ledPowerLimit').value);
      save({
        brightness: Number(b.value),
        power_limit_ma: Number.isFinite(limitA) ? Math.round(limitA * 1000) : s.config.power_limit_ma,
        auto_protect: host.querySelector('#ledAutoProtect').checked,
        color_order: host.querySelector('#ledColorOrder').value,
        wiring: host.querySelector('#ledWiring').value,
        axis: host.querySelector('#ledAxis').value,
        origin: host.querySelector('#ledOrigin').value,
      });
    });
    host.querySelector('#ledResetLearned')?.addEventListener('click', () => save({ reset_learned: true }));
  }

  load();
  return () => { host.innerHTML = ''; };
}
