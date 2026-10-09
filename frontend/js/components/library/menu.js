// An overflow ("…") menu: a menu button and a list of actions, operable from the keyboard.
//
// The button carries aria-haspopup/aria-expanded; the list is role="menu" with role="menuitem"
// entries. Arrow keys move, Home/End jump, Enter/Space choose, Escape closes and returns focus to the
// button, Tab closes, a click anywhere else closes. One menu is open at a time.
//
// items: [{ label, onSelect, danger?, disabled?, separatorBefore?, hint? }]

import { esc } from '../../utils.js';

let current = null;

export function closeMenu({ restoreFocus = false } = {}) {
  if (!current) return;
  const { menu, anchor, cleanup } = current;
  current = null;
  cleanup();
  menu.remove();
  anchor.setAttribute('aria-expanded', 'false');
  if (restoreFocus && document.contains(anchor)) anchor.focus();
}

export function openMenu(anchor, items, { label = '' } = {}) {
  if (current && current.anchor === anchor) { closeMenu({ restoreFocus: true }); return; }
  closeMenu();
  const menu = document.createElement('ul');
  menu.className = 'lib-menu';
  menu.setAttribute('role', 'menu');
  if (label) menu.setAttribute('aria-label', label);
  menu.innerHTML = items.filter(Boolean).map((it, i) => `
    ${it.separatorBefore ? '<li role="separator" class="lib-menu-sep"></li>' : ''}
    <li role="none"><button type="button" role="menuitem" class="lib-menu-item${it.danger ? ' is-danger' : ''}" data-i="${i}" tabindex="-1" ${it.disabled ? 'aria-disabled="true"' : ''}>
      <span>${esc(it.label)}</span>${it.hint ? `<span class="lib-menu-hint">${esc(it.hint)}</span>` : ''}
    </button></li>`).join('');
  const list = items.filter(Boolean);
  // Inside the dialog or drawer the anchor lives in, so `inert` and focus traps treat it as theirs.
  (anchor.closest('.lib-dialog, .lib-inspector') || document.body).appendChild(menu);

  // Position: below the button, flipped up or left when it would leave the viewport.
  const r = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let top = r.bottom + 4, left = r.right - mw;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  if (left < 8) left = Math.min(r.left, window.innerWidth - mw - 8);
  menu.style.top = `${top}px`;
  menu.style.left = `${Math.max(8, left)}px`;

  const buttons = [...menu.querySelectorAll('[role="menuitem"]')];
  const move = (i) => { const n = buttons.length; buttons[((i % n) + n) % n].focus(); };
  const choose = (btn) => {
    const it = list[Number(btn.dataset.i)];
    if (!it || it.disabled) return;
    closeMenu({ restoreFocus: true });
    it.onSelect();
  };
  menu.addEventListener('click', (e) => { const b = e.target.closest('[role="menuitem"]'); if (b) choose(b); });
  menu.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); move(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); move(0); }
    else if (e.key === 'End') { e.preventDefault(); move(buttons.length - 1); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu({ restoreFocus: true }); }
    else if (e.key === 'Tab') { closeMenu(); }
  });
  const onDown = (e) => { if (!menu.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) closeMenu(); };
  const onScroll = (e) => { if (!menu.contains(e.target)) closeMenu(); };
  document.addEventListener('mousedown', onDown, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', closeMenu);
  anchor.setAttribute('aria-expanded', 'true');
  current = {
    menu, anchor,
    cleanup() {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', closeMenu);
    },
  };
  move(0);
}
