/*
 * Settings > Appearance: choose how the dashboard looks. Each option is a small drawing of the
 * theme in its own colours and a line saying what it is; choosing one applies it at once
 * (js/lib/themes.js). It is a per-browser choice, like the language.
 */
import { t } from '../i18n.js';
import { esc } from '../utils.js';
import { THEMES, currentTheme, setTheme } from '../lib/themes.js';

export function mountThemePicker(el) {
  if (!el) return;
  const draw = () => {
    const now = currentTheme();
    el.innerHTML = `<div class="theme-picker" role="group" aria-label="${esc(t('appearance.title'))}">
      ${THEMES.map((th) => `
        <button type="button" class="theme-option" data-theme-id="${th.id}" aria-pressed="${th.id === now}">
          <span class="theme-swatch" aria-hidden="true">
            <span class="theme-swatch-side" style="background:${th.swatch.side}">
              <i style="background:${th.swatch.accent};opacity:1"></i><i style="background:${th.swatch.ink}"></i><i style="background:${th.swatch.ink}"></i>
            </span>
            <span class="theme-swatch-main" style="background:${th.swatch.page}">
              <b style="background:${th.swatch.card};box-shadow:0 0 0 1px ${th.swatch.ink}55"></b><b style="background:${th.swatch.card};box-shadow:0 0 0 1px ${th.swatch.ink}55"></b>
            </span>
          </span>
          <span>
            <span class="theme-option-name">${esc(t(`appearance.theme.${th.id}.name`))}</span><br>
            <span class="theme-option-desc">${esc(t(`appearance.theme.${th.id}.desc`))}</span>
          </span>
        </button>`).join('')}
    </div>`;
    el.querySelectorAll('[data-theme-id]').forEach((b) => b.addEventListener('click', () => { setTheme(b.dataset.themeId); draw(); }));
  };
  draw();
}
