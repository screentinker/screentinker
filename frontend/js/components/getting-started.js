// "What do I do next?" — answered from what the account ACTUALLY contains.
//
// There was already an onboarding wizard, but it is a one-time modal gated on a localStorage
// flag: skip it once and it never returns, and it never knew whether you succeeded at anything.
// Someone who closed it and then wondered how to get content on a screen had nothing left to go
// on, which is exactly the confusion that got reported.
//
// A second tour would repeat that mistake. Tours are dismissed and forgotten, and they describe
// the product rather than the account. This reads real state instead, so it cannot claim you have
// done something you have not, it is still there tomorrow, and it disappears by itself once the
// first screen is actually live — no nagging anyone who already knows the product.
//
// The steps are the shortest true path to a screen showing something: get a screen connected,
// get media in, arrange it, put it on the screen.

import { t } from '../i18n.js';
import { api } from '../api.js';

// Pure: given what the account holds, which steps are done and which is next. Separated from the
// DOM so the logic that decides "you are finished" is testable — a checklist that congratulates
// you too early is worse than none.
export function computeSteps({ devices = [], content = [], playlists = [] } = {}) {
  const hasDevice = devices.length > 0;
  const hasContent = content.length > 0;
  /*
   * ⚠️ AN EMPTY PLAYLIST DOES NOT TICK "PUT CONTENT IN A PLAYLIST". This used to be
   * `playlists.length > 0`, so creating a playlist and stopping — which is exactly what the
   * checklist's own step 3 does, it opens the New Playlist dialog and lands you on an empty one —
   * marked the step done and moved the user on to "Send it to the screen". Sending an empty
   * playlist to a screen shows nothing, which is the same blank-screen-behind-a-success-message
   * failure the onboarding publish bug was.
   *
   * ⚠️ DEPENDS ON item_count, which every caller has: all of them read playlists from
   * api.getPlaylists(), and that endpoint selects COUNT(playlist_items) as item_count. Passing a
   * playlist shape without it counts as empty — which nags rather than lies, the right way round.
   */
  const hasPlaylist = playlists.some((p) => Number(p.item_count || 0) > 0);
  /*
   * "On screen" is the only step that cannot be faked by creating an object and walking away:
   * some screen has to actually be pointed at something that will actually play.
   *
   * default_content_id is deliberately NOT counted. No player reads it — grep the whole tree and
   * it appears only in this checklist, the device route, the settings snapshot and the schema —
   * so counting it ticked "content assigned" for a screen that goes on showing "waiting for
   * content". A checklist that lies about the one thing it is there to confirm is worse than no
   * checklist. The field itself is left alone; that is a separate decision.
   *
   * ⚠️ AND THE ASSIGNED PLAYLIST HAS TO BE PUBLISHED. A player's payload is built from
   * published_snapshot with no fallback to the live items, so assigning a playlist nobody has
   * published points the screen at an empty list. This step used to tick on the assignment alone:
   * "Get your first screen live" reported 4 of 4 while the display sat dark, and the one banner
   * that explains why ("Devices will show nothing until you publish") is on the screen's own page.
   * Third time this shape has bitten in this feature — see the empty-playlist rule above and the
   * onboarding publish fix.
   *
   * A layout with no playlist is still not "live", so layout_id alone no longer counts either.
   */
  const publishedIds = new Set(playlists.filter((p) => p.published_snapshot).map((p) => p.id));
  const isAssigned = devices.some((d) => d.playlist_id && publishedIds.has(d.playlist_id));

  const steps = [
    {
      key: 'device',
      done: hasDevice,
      title: t('gs.device.title'),
      desc: t('gs.device.desc'),
      cta: t('gs.device.cta'),
      href: '#/',
      action: 'add-device',
    },
    {
      key: 'content',
      done: hasContent,
      title: t('gs.content.title'),
      desc: t('gs.content.desc'),
      cta: t('gs.content.cta'),
      href: '#/content',
      action: 'add-content',
    },
    {
      key: 'playlist',
      done: hasPlaylist,
      title: t('gs.playlist.title'),
      desc: t('gs.playlist.desc'),
      cta: t('gs.playlist.cta'),
      href: '#/playlists',
      action: 'new-playlist',
    },
    {
      key: 'assign',
      done: isAssigned,
      title: t('gs.assign.title'),
      desc: t('gs.assign.desc'),
      cta: t('gs.assign.cta'),
      href: '#/',
      action: 'assign',
    },
  ];

  // The NEXT step is the first unfinished one — in order, because each genuinely depends on the
  // one before it. Highlighting anything else would send someone to a screen they cannot use yet.
  const nextIndex = steps.findIndex((s) => !s.done);
  return {
    steps,
    nextIndex,
    complete: nextIndex === -1,
    doneCount: steps.filter((s) => s.done).length,
  };
}

const DISMISS_KEY = 'rd_gs_dismissed';
export const isDismissed = () => localStorage.getItem(DISMISS_KEY) === '1';
export const dismiss = () => localStorage.setItem(DISMISS_KEY, '1');
export const undismiss = () => localStorage.removeItem(DISMISS_KEY);

// Show it while there is still something to do and the user has not put it away. Deliberately
// NOT gated on "is this a new account" — someone who has had the product a month and still has no
// content is exactly who needs it.
export function shouldShow(state) {
  return !state.complete && !isDismissed();
}

export function render(host, state, { onAction, ctaFor } = {}) {
  if (!host) return;
  if (!shouldShow(state)) { host.innerHTML = ''; host.style.display = 'none'; return; }
  host.style.display = '';

  const { steps, nextIndex, doneCount } = state;
  host.innerHTML = `
    <div style="border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--bg-secondary);padding:16px;margin-bottom:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px">
        <div>
          <div style="font-weight:600;font-size:15px">${t('gs.title')}</div>
          <div style="color:var(--text-muted);font-size:12px;margin-top:2px">${t('gs.progress').replace('{done}', doneCount).replace('{total}', steps.length)}</div>
        </div>
        <button class="btn btn-sm" id="gsDismiss" style="color:var(--text-muted)">${t('gs.dismiss')}</button>
      </div>
      <div style="height:4px;background:var(--bg-primary);border-radius:2px;overflow:hidden;margin-bottom:14px">
        <div style="height:100%;width:${(doneCount / steps.length) * 100}%;background:var(--accent,#3B82F6);transition:width .3s"></div>
      </div>
      <div style="display:grid;gap:8px">
        ${steps.map((s, i) => {
          const isNext = i === nextIndex;
          return `
          <div style="display:flex;align-items:flex-start;gap:10px;padding:10px;border-radius:8px;
            ${isNext ? 'background:var(--bg-primary);border:1px solid var(--accent,#3B82F6)' : 'border:1px solid transparent'}">
            <div style="flex:0 0 20px;height:20px;border-radius:50%;margin-top:1px;display:flex;align-items:center;justify-content:center;
              font-size:11px;font-weight:700;
              ${s.done ? 'background:#22c55e;color:#fff' : isNext ? 'background:var(--accent,#3B82F6);color:#fff' : 'background:var(--bg-primary);color:var(--text-muted);border:1px solid var(--border)'}">
              ${s.done ? '&#10003;' : i + 1}
            </div>
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:${isNext ? '600' : '500'};${s.done ? 'color:var(--text-muted);text-decoration:line-through' : ''}">${s.title}</div>
              ${!s.done ? `<div style="color:var(--text-muted);font-size:12px;margin-top:2px">${s.desc}</div>` : ''}
            </div>
            ${!s.done && isNext ? `<button class="btn btn-primary btn-sm" data-gs-step="${s.key}" style="flex:0 0 auto">${(ctaFor && ctaFor[s.key]) || s.cta}</button>` : ''}
          </div>`;
        }).join('')}
      </div>
    </div>`;

  host.querySelector('#gsDismiss')?.addEventListener('click', () => {
    dismiss();
    host.innerHTML = '';
    host.style.display = 'none';
  });
  host.querySelectorAll('[data-gs-step]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const step = steps.find((s) => s.key === btn.dataset.gsStep);
      if (!step) return;
      /*
       * ⚠️ THE ACTION FIRST, AND EVERY STEP HAS ONE. An in-page action (open the pairing dialog,
       * open the new-playlist modal) beats navigating somewhere and leaving the user to find the
       * real button again.
       *
       * ⚠️ AND IT IS WHY THE BUTTON IS NOT DEAD WHEN YOU ARE ALREADY THERE. The fallback below
       * sets location.hash — which does NOTHING when the hash is already that page. Reported
       * exactly that way: on Playlists, step 3's "New playlist" button "just sits there doing
       * nothing", while the page's own New Playlist button opens the dialog. So the view that a
       * step points at MUST handle that step's action; getting-started-checklist.test.js fails if
       * one does not. The navigate is only for reaching a page you are not on yet.
       */
      if (step.action && onAction && onAction(step.action)) return;
      if (window.location.hash === step.href || (step.href === '#/' && !window.location.hash)) {
        // Already here and nothing handled it — say so rather than looking broken.
        console.warn(`[getting-started] step "${step.key}" has no in-page handler on ${step.href}`);
        return;
      }
      window.location.hash = step.href;
    });
  });
}

/*
 * Put the checklist on a page — the ONE place that knows how to do it.
 *
 * ⚠️ WHY THIS EXISTS RATHER THAN THREE COPIES. The checklist used to live only on the dashboard,
 * so following one of its own CTAs was a dead end: click "Add content", land on the Content
 * Library, and the thing that sent you there is gone — no step, no progress, nothing saying what
 * you were in the middle of. The fix is to render it on the pages the steps point at, and the
 * moment that is three call sites, "fetch the three lists, compute, hide when finished" is the
 * kind of logic that drifts apart. So the views own a host element and nothing else.
 *
 * ⚠️ PASS WHAT YOU ALREADY HAVE. Each caller hands over the lists it fetched for its own render;
 * only the genuinely missing ones are fetched here. The dashboard already had devices and
 * playlists in hand, and it still costs exactly the one content request it always did.
 *
 * Every failure path ends with the host hidden: guidance must never be the reason a page breaks.
 *
 * @returns {Promise<boolean>} whether the checklist was shown
 */
/*
 * The options the checklist was last mounted with, so it can re-read the account without every
 * caller having to hand them over a second time. See refresh() below.
 */
let lastOpts = null;

/**
 * Re-read the account and redraw.
 *
 * ⚠️ WHY THIS EXISTS. mount() runs when a VIEW renders, but the things that tick a step off happen
 * inside a view that is already on screen: uploading a file does not re-render the Content Library,
 * it just refreshes a grid. So the checklist sat there still saying "Add some content" after the
 * content had been added, and only a page reload fixed it — which is exactly the "it lies about
 * what you have done" failure the checklist exists to avoid.
 *
 * Callers hook this into the reload they already do after a mutation, rather than each mutation
 * site having to know about the checklist.
 */
export async function refresh() {
  if (!lastOpts) return false;
  // Re-resolved by id, never cached: a view that re-rendered has a different element by now, and
  // holding the old one would repaint a node that is no longer in the document.
  const host = document.getElementById('gettingStarted');
  if (!host) { lastOpts = null; return false; }
  return mount(host, lastOpts);
}

export async function mount(host, opts = {}) {
  const { devices, content, playlists, onAction, ctaFor } = opts;
  if (!host) return false;
  lastOpts = opts;
  const hide = () => { host.innerHTML = ''; host.style.display = 'none'; return false; };

  // Put away or finished: no request, on any page. This is the common case forever after the
  // first week of an account, and it must stay free.
  if (isDismissed()) return hide();

  try {
    const [d, c, p] = await Promise.all([
      devices || api.getDevices().catch(() => []),
      /*
       * ⚠️ A BARE getContent() ON PURPOSE, and the only one left in the app. Everywhere else this
       * shape was a bug (#417): the endpoint caps at 100, so a caller that wanted the whole library
       * silently got its newest slice. Here the ONLY question is "does this workspace have any
       * content yet", which computeSteps answers from length > 0 — so one page is not merely
       * enough, it is the cheaper right answer. Paging a 5,000-item library to decide whether it is
       * non-empty would be ten requests to learn something the first one already told us.
       */
      content || api.getContent().catch(() => []),
      playlists || api.getPlaylists().catch(() => []),
    ]);
    const state = computeSteps({ devices: d || [], content: c || [], playlists: p || [] });
    if (state.complete) { dismiss(); return hide(); }   // finished: never costs a fetch again
    /*
     * ctaFor lets a view relabel the button for where the user actually is. Step 3 reads "New
     * playlist" on the Playlists list, but on one empty playlist's own page the honest verb is
     * "Add content" — same step, same action, different thing to press.
     */
    render(host, state, { onAction, ctaFor });
    return true;
  } catch (_) {
    return hide();
  }
}
