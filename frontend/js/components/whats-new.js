// "What changed?" — answered once, when the answer is new.
//
// Until now an upgrade was invisible from inside the product. The admin page could tell you a
// newer version existed and offer to install it, the nav grew a badge, and Settings showed a
// number — and then nothing ever said what you got. Someone found out by noticing.
//
// ⚠️ ONCE PER VERSION, NOT ONCE EVER. getting-started.js next door stores a boolean, which is
// right for a checklist you finish. A release note is finished only until the next release, so the
// stored value is the VERSION that was seen: 2.0.1 read and put away says nothing about 2.0.2. The
// same key therefore cannot be "dismissed forever", which is deliberate — an upgrade the operator
// never heard about is the problem being fixed.
//
// ⚠️ AND IT IS NEVER A MODAL. It sits in the page above the dashboard and can be ignored. A person
// signing in at 8am to find out why a screen is black must be able to get past it without reading
// it, which is exactly what a release-notes dialog in the way of the product does not allow.

import { t } from '../i18n.js';

const SEEN_KEY = 'rd_whatsnew_seen';

/** The version whose notes this browser has already put away, or null. */
export function seenVersion() {
  try { return localStorage.getItem(SEEN_KEY); } catch { return null; }
}

/**
 * Has this version's panel been dismissed here?
 *
 * A private window, cleared site data or a second browser all answer "no", and that is fine: the
 * cost of showing it twice is a box someone closes again, and there is no server state worth
 * adding a column for.
 */
export function isSeen(version) {
  return !!version && seenVersion() === version;
}

export function markSeen(version) {
  try { if (version) localStorage.setItem(SEEN_KEY, version); } catch { /* private mode: show again */ }
}

/**
 * Is there anything to fetch? app.js publishes the running version on window.__ST_VERSION from the
 * poll it already makes, so a browser that has put away the notes for the build it is looking at
 * costs one localStorage read and no request — which is every dashboard load until the next
 * upgrade. When the version is not known yet (first paint beat the version poll) we fetch and let
 * render() decide, because guessing wrong here means never announcing a release.
 */
export function shouldFetch() {
  let known = null;
  try { known = (typeof window !== 'undefined' && window.__ST_VERSION) || null; } catch { /* */ }
  return !known || !isSeen(known);
}

/** Fetch the running version's notes plus the history. Never throws — the panel is optional. */
export async function fetchNotes() {
  try {
    const res = await fetch('/api/release-notes');
    if (!res.ok) return null;
    const data = await res.json();
    return data && typeof data.version === 'string' ? data : null;
  } catch { return null; }
}

/*
 * Notes are authored by us in release-notes.json, not entered by a user — but they still go through
 * the DOM as text rather than markup. A release note has no reason to carry HTML, and an escaping
 * habit that has exceptions is not a habit.
 */
function li(text) {
  const el = document.createElement('li');
  el.style.cssText = 'margin-bottom:6px;line-height:1.5';
  el.textContent = text;
  return el;
}

/**
 * The dashboard panel. Renders nothing at all unless there are notes for the running version and
 * this browser has not already seen them.
 *
 * @returns {boolean} whether anything was shown
 */
export function render(host, data) {
  if (!host || !data || !data.current || isSeen(data.version)) return false;

  host.style.display = '';
  host.innerHTML = `
    <div style="border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--bg-secondary);padding:16px;margin-bottom:16px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px">
        <div style="font-weight:600;font-size:15px">${t('whatsnew.title', { version: data.version })}</div>
        <button class="btn btn-sm" id="wnDismiss" aria-label="${t('whatsnew.dismiss')}"
          style="color:var(--text-muted);flex:0 0 auto">&#10005;</button>
      </div>
      <ul id="wnList" style="color:var(--text-secondary);font-size:13px;padding-left:20px;margin:0"></ul>
      <div style="margin-top:12px">
        <a href="#/settings" id="wnFull" style="color:var(--accent);font-size:12px">${t('whatsnew.full_notes')} &rarr;</a>
      </div>
    </div>`;

  const list = host.querySelector('#wnList');
  for (const note of data.current.notes) list.appendChild(li(note));

  const putAway = () => { markSeen(data.version); host.innerHTML = ''; host.style.display = 'none'; };
  host.querySelector('#wnDismiss')?.addEventListener('click', putAway);
  // Following the link counts as having read it — coming back to a panel you just clicked through
  // would read as the dismissal having failed.
  host.querySelector('#wnFull')?.addEventListener('click', () => markSeen(data.version));
  return true;
}

/**
 * The permanent list, for Settings -> About. Always rendered in full: this is where someone goes
 * ON PURPOSE, so nothing here is hidden behind a "seen" flag, and older versions stay readable for
 * anyone catching up across several upgrades at once.
 */
export function renderHistory(host, data) {
  if (!host || !data || !Array.isArray(data.history) || data.history.length === 0) return false;

  host.innerHTML = `<div style="margin-top:16px"><div style="font-weight:600;font-size:13px;color:var(--text-primary);margin-bottom:8px">${t('whatsnew.history_title')}</div><div id="wnHistoryBody"></div></div>`;
  const body = host.querySelector('#wnHistoryBody');

  data.history.forEach((rel, i) => {
    const block = document.createElement('div');
    block.style.cssText = 'margin-bottom:14px';

    const head = document.createElement('div');
    head.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px';
    // The running build is marked, because "which of these am I on?" is the first question the
    // list raises and the version number alone above it is easy to miss.
    head.textContent = rel.version === data.version
      ? t('whatsnew.version_current', { version: rel.version, date: rel.date || '' })
      : t('whatsnew.version_line', { version: rel.version, date: rel.date || '' });
    block.appendChild(head);

    const ul = document.createElement('ul');
    ul.style.cssText = 'color:var(--text-muted);font-size:12px;padding-left:18px;margin:0';
    for (const note of rel.notes) ul.appendChild(li(note));
    block.appendChild(ul);

    body.appendChild(block);
    if (i < data.history.length - 1) {
      const hr = document.createElement('div');
      hr.style.cssText = 'border-top:1px solid var(--border);margin-top:12px';
      body.appendChild(hr);
    }
  });
  return true;
}
