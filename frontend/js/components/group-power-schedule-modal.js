import { t } from '../i18n.js';
import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc } from '../utils.js';
import { renderPowerScheduleEditor, readPowerScheduleEditor, presetWindows } from './power-schedule-editor.js';

/*
 * The weekly backlight schedule for a GROUP.
 *
 * ⚠️ Uses the SAME editor component as the device page. Two copies is how "off 22:00–06:00" comes
 * to mean one thing on a screen and another on a group — the exact divergence
 * lib/device-power-schedule.js exists to prevent on the server, and it would be worse here because
 * the operator can see both and would have no way to tell which was right.
 *
 * ⚠️ The capability check is deliberately DIFFERENT from the device page's. There, an unsupported
 * panel disables the editor, because that page is one screen and saving would produce a row that
 * nothing ever acts on. A group is a mixed bag by nature: some members can honour a schedule and
 * some cannot, and refusing the write because of the weakest member would be worse than saying
 * which ones will ignore it. So this counts them and warns, and always lets you save.
 */
export function openGroupPowerScheduleModal(group, devices = []) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>${esc(t('power.section_title'))} — ${esc(group.name)}</h3>
        <button class="btn-icon" type="button" data-power-close aria-label="${esc(t('common.close'))}">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <div id="groupPowerHost" style="font-size:13px;color:var(--text-muted)">…</div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => { try { overlay.remove(); } catch { /* already gone */ } };
  overlay.querySelectorAll('[data-power-close]').forEach((b) => b.addEventListener('click', close));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const host = overlay.querySelector('#groupPowerHost');
  let current = null;

  /*
   * How many members will actually obey this, and how many have their own schedule that overrides
   * it. Both are things the operator cannot see from a group row and will otherwise discover as
   * "some of the screens didn't go off".
   */
  async function memberFacts() {
    const facts = { unsupported: 0, overridden: 0, total: devices.length };
    await Promise.all(devices.map(async (d) => {
      try {
        const eff = await api.effectivePowerSchedule(d.id);
        if (eff.supported === false) facts.unsupported += 1;
        if (eff.schedule && eff.schedule.source === 'device') facts.overridden += 1;
      } catch { /* a member we cannot ask is simply not counted */ }
    }));
    return facts;
  }

  function notes(facts) {
    const out = [];
    if (facts.unsupported > 0) {
      out.push(`<div class="power-warning">${esc(
        t('power.group_unsupported_members').replace('{n}', String(facts.unsupported)).replace('{total}', String(facts.total))
      )}</div>`);
    }
    if (facts.overridden > 0) {
      out.push(`<div class="power-hint">${esc(
        t('power.group_overridden_members').replace('{n}', String(facts.overridden))
      )}</div>`);
    }
    return out.join('');
  }

  async function load() {
    try {
      const list = await api.listPowerSchedules();
      current = (list.schedules || []).find((s) => s.group_id === group.id) || null;
      const facts = await memberFacts();
      host.innerHTML = notes(facts)
        + renderPowerScheduleEditor(current || { windows: [], enabled: true }, { supported: true });
      bind(facts);
    } catch (err) {
      host.textContent = err.message;
    }
  }

  function redraw(windows, enabled, facts) {
    host.innerHTML = notes(facts)
      + renderPowerScheduleEditor({ ...(current || {}), windows, enabled }, { supported: true });
    bind(facts);
  }

  function bind(facts) {
    host.querySelector('#powerAddWindow')?.addEventListener('click', () => {
      const s = readPowerScheduleEditor(host);
      redraw([...(s?.windows || []), { days: [1, 2, 3, 4, 5], start: '22:00', end: '06:00' }], s?.enabled !== false, facts);
    });
    host.querySelectorAll('.power-preset').forEach((b) => b.addEventListener('click', () => {
      redraw(presetWindows(b.getAttribute('data-preset')), true, facts);
    }));
    host.querySelectorAll('.power-remove').forEach((b) => b.addEventListener('click', () => {
      const i = Number(b.getAttribute('data-win'));
      const s = readPowerScheduleEditor(host);
      redraw((s?.windows || []).filter((_, n) => n !== i), s?.enabled !== false, facts);
    }));
    host.querySelectorAll('.power-start, .power-end').forEach((el) => el.addEventListener('change', () => {
      const s = readPowerScheduleEditor(host);
      redraw(s?.windows || [], s?.enabled !== false, facts);
    }));

    host.querySelector('#powerSave')?.addEventListener('click', async () => {
      const s = readPowerScheduleEditor(host);
      if (!s) return;
      try {
        if (current?.id) await api.updatePowerSchedule(current.id, s);
        else await api.createPowerSchedule({ group_id: group.id, ...s });
        showToast(t('power.saved'), 'success');
        close();
      } catch (err) {
        showToast(`${t('power.save_failed')}: ${err.message}`, 'error');
      }
    });

    host.querySelector('#powerDelete')?.addEventListener('click', async () => {
      if (!current?.id) return;
      try {
        await api.deletePowerSchedule(current.id);
        showToast(t('power.saved'), 'success');
        close();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  load();
}
