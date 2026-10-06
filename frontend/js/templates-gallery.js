/*
 * /templates: category filters and the "Interactive web preview" modal. External file because the
 * page's CSP is script-src 'self' (no inline script).
 *
 * The preview frames /api/templates/demo/<sha>, which this server renders from the installed
 * package with the same sandboxing CSP as a real screen. The frame is ALSO sandboxed here
 * (allow-scripts only, never allow-same-origin), so the template is an opaque origin twice over.
 * It is rendered at a real screen size and scaled to fit, so what a visitor sees is the layout a
 * 1920x1080 / 1080x1920 / 1920x200 screen would get, not a squashed browser-width version.
 */
(function () {
  'use strict';

  const grid = document.getElementById('templateGrid');
  const filters = document.querySelectorAll('.tg-filter');
  const cards = () => Array.from(grid ? grid.querySelectorAll('.tg-card') : []);

  function applyFilter(id) {
    filters.forEach((b) => {
      const on = b.dataset.filter === id;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    let shown = 0;
    cards().forEach((c) => {
      const match = id === 'all' || (c.dataset.categories || '').split(' ').includes(id);
      c.hidden = !match;
      if (match) shown++;
    });
    let empty = grid && grid.querySelector('.tg-empty');
    if (!shown && grid) {
      if (!empty) { empty = document.createElement('p'); empty.className = 'tg-empty'; grid.appendChild(empty); }
      empty.textContent = 'No templates in this category yet. New ones are added to the catalog regularly.';
    } else if (empty) empty.remove();
  }
  filters.forEach((b) => b.addEventListener('click', () => {
    applyFilter(b.dataset.filter);
    try { history.replaceState(null, '', b.dataset.filter === 'all' ? location.pathname : `#${b.dataset.filter}`); } catch { /* ignore */ }
  }));
  const initial = location.hash.slice(1);
  if (initial && Array.from(filters).some((b) => b.dataset.filter === initial)) applyFilter(initial);

  /* ---------------------------------------------------------------- preview modal */
  const SHAPES = { landscape: [1920, 1080], portrait: [1080, 1920], strip: [1920, 200] };
  const modal = document.getElementById('tgModal');
  const stage = document.getElementById('tgStage');
  const screen = document.getElementById('tgScreen');
  const title = document.getElementById('tgModalTitle');
  const shapeBtns = document.querySelectorAll('.tg-shape');
  let shape = 'landscape';
  let lastFocus = null;

  function fit() {
    if (!modal || modal.hidden) return;
    const [w, h] = SHAPES[shape];
    const box = stage.getBoundingClientRect();
    if (window.innerWidth <= 768) stage.style.height = `${Math.min(window.innerHeight * 0.7, box.width * (h / w)) || 240}px`;
    const b = stage.getBoundingClientRect();
    const scale = Math.min((b.width - 24) / w, (b.height - 24) / h);
    screen.style.width = `${w}px`;
    screen.style.height = `${h}px`;
    screen.style.transform = `scale(${scale}) translate(-50%, -50%)`;
  }

  function setShape(next) {
    shape = SHAPES[next] ? next : 'landscape';
    shapeBtns.forEach((b) => {
      const on = b.dataset.shape === shape;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    fit();
  }

  function open(btn) {
    const url = btn.dataset.preview;
    if (!url || !/^\/api\/templates\/demo\/[0-9a-f]{64}$/.test(url)) return;
    lastFocus = btn;
    title.textContent = btn.dataset.name || 'Preview';
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('title', `${btn.dataset.name || 'Template'} preview`);
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.src = url;
    screen.replaceChildren(frame);
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    const orient = (btn.dataset.orientation || '').split(',');
    setShape(orient.includes('landscape') || !orient[0] ? 'landscape' : orient[0]);
    document.getElementById('tgClose').focus();
  }

  function close() {
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    screen.replaceChildren();          // stop the template (animations, game loop, audio) at once
    document.body.style.overflow = '';
    if (lastFocus) lastFocus.focus();
  }

  if (grid) grid.addEventListener('click', (e) => {
    const btn = e.target.closest('.tg-preview');
    if (btn) open(btn);
  });
  shapeBtns.forEach((b) => b.addEventListener('click', () => setShape(b.dataset.shape)));
  const closeBtn = document.getElementById('tgClose');
  if (closeBtn) closeBtn.addEventListener('click', close);
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  window.addEventListener('resize', fit);
})();
