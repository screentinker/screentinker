/*
 * Collapsible sidebar groups (index.html: <li class="nav-group"> around the nav <li>s).
 *
 * The sidebar grew to two dozen flat links. Grouping them only helps if the groups never hide
 * something the operator needs, so four rules:
 *
 *   1. NAVIGATING INTO a collapsed group opens it, so the page you land on is never hidden. A click
 *      on a header always wins, though — collapsing the group you are in is allowed, and its header
 *      is then marked so you can still see where you are.
 *   2. A group whose every link is hidden (a server with no mesh, a user who is not an admin) is
 *      hidden too — an empty header reads as a broken menu.
 *   3. A collapsed group still SAYS when something inside it needs attention: the badges of its
 *      hidden links (Reviews' pending count) are summed onto the header.
 *   4. Which groups you collapsed is remembered per browser. Storage can be unavailable (private
 *      windows, blocked site data), and then every group simply starts open.
 *
 * app.js keeps showing, hiding and relabelling the individual <li>s exactly as before; this
 * watches for those changes rather than being told about them, so no caller has to remember to.
 */

const STORE_KEY = 'st.nav.collapsed';
const SEEN_KEY = 'st.nav.seen';
/*
 * First visit: the least-visited group (workspace admin — members, billing, settings) starts
 * collapsed, so a new operator meets the jobs they came to do rather than twenty links. Once
 * anything is toggled, the stored choice is used instead.
 */
const DEFAULT_COLLAPSED = ['workspace'];

function readCollapsed() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw === null) return new Set(DEFAULT_COLLAPSED);
    const v = JSON.parse(raw);
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  } catch (e) {
    return new Set(DEFAULT_COLLAPSED);
  }
}

/*
 * "New" pills (index.html: <span class="nav-new-pill" data-new-key="…">). A permanent "New" goes
 * stale and then lies, so each pill shows until its page has been opened once in this browser.
 */
function readSeen() {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); } catch (e) { return new Set(); }
}
function markSeen(seen, key) {
  seen.add(key);
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen])); } catch (e) { /* fine */ }
}

function writeCollapsed(set) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify([...set])); } catch (e) { /* not persisted: fine */ }
}

function isShown(li) {
  return li.style.display !== 'none' && !li.hidden;
}

export function initNavGroups(root = document) {
  const groups = [...root.querySelectorAll('.nav-links .nav-group')];
  if (!groups.length) return;
  const collapsed = readCollapsed();
  const seen = readSeen();
  let scheduled = false;
  let lastActive = null;

  function refresh() {
    scheduled = false;
    // Rule 1: the active link changed, and it sits in a collapsed group -> open that group.
    const activeLink = root.querySelector('.nav-links .nav-link.active');
    const activeView = activeLink ? activeLink.dataset.view : null;
    if (activeView !== lastActive) {
      lastActive = activeView;
      if (activeView && root.querySelector(`.nav-new-pill[data-new-key="${activeView}"]`)) markSeen(seen, activeView);
      const g = activeLink && activeLink.closest('.nav-group');
      if (g && collapsed.has(g.dataset.group)) {
        collapsed.delete(g.dataset.group);
        writeCollapsed(collapsed);
      }
    }
    root.querySelectorAll('.nav-links .nav-new-pill').forEach((pill) => { pill.hidden = seen.has(pill.dataset.newKey); });
    for (const g of groups) {
      const id = g.dataset.group;
      const items = [...g.querySelectorAll(':scope > .nav-group-items > li')];
      const visible = items.filter(isShown);
      g.hidden = visible.length === 0;

      const hasActive = visible.some((li) => li.querySelector('.nav-link.active'));
      const open = !collapsed.has(id);
      g.classList.toggle('collapsed', !open);
      g.classList.toggle('has-active', hasActive);
      const btn = g.querySelector(':scope > .nav-group-toggle');
      if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');

      // Rule 3: sum the numeric badges of links hidden by the collapse.
      const badge = g.querySelector(':scope > .nav-group-toggle .nav-group-badge');
      if (badge) {
        let n = 0;
        if (!open) {
          for (const li of visible) {
            for (const b of li.querySelectorAll('.member-badge')) {
              if (b.style.display === 'none' || b.hidden) continue;
              const v = parseInt(b.textContent, 10);
              if (v > 0) n += v;
            }
          }
        }
        badge.hidden = n === 0;
        badge.textContent = n > 99 ? '99+' : String(n);
      }
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    (window.requestAnimationFrame || setTimeout)(refresh);
  }

  for (const g of groups) {
    const btn = g.querySelector(':scope > .nav-group-toggle');
    if (!btn) continue;
    btn.addEventListener('click', () => {
      const id = g.dataset.group;
      if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
      writeCollapsed(collapsed);
      refresh();
    });
  }

  // Links are shown/hidden (style), activated (class) and badged (text) by app.js at any time.
  const nav = root.querySelector('.nav-links');
  if (nav && typeof MutationObserver === 'function') {
    new MutationObserver(schedule).observe(nav, {
      subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'],
      childList: true, characterData: true,
    });
  }
  window.addEventListener('hashchange', schedule);
  refresh();
}
