/*
 * The feedback loop's card (server/lib/feedback.js decides WHEN; this only draws it).
 *
 * maybeShowFeedbackPrompt(user): once per page load, a few seconds after the dashboard settles, ask
 * the server whether there is a moment to ask about. If so, a small card in the corner: a 1-5
 * rating, the moment's reasons to tick (a lapsed trial, a cancellation, why they paid) and a
 * comment. "Not now" dismisses it for good; the server never asks the same moment twice.
 *
 * openFeedback(): the same card on demand, from the "Send feedback" link (moment 'general').
 *
 * Never blocks anything: every call is wrapped, and on a self-hosted server the prompt endpoint says
 * the loop is off, so neither the card nor the link appears.
 */
import { api } from '../api.js';
import { t } from '../i18n.js';
import { esc } from '../utils.js';
import { showToast } from './toast.js';

let checked = false;
let open = null;

const QUESTION = {
  first_pair: 'feedback.q.first_pair', trial_day7: 'feedback.q.trial_day7', trial_ended: 'feedback.q.trial_ended',
  cancelled: 'feedback.q.cancelled', paid: 'feedback.q.paid', general: 'feedback.q.general',
};
const GENERAL_REASONS = [];

function close(trigger, dismissed) {
  if (open) { open.remove(); open = null; }
  if (dismissed && trigger !== 'general') api.feedbackDismiss(trigger);
}

function render(trigger, reasons) {
  close();
  const el = document.createElement('div');
  el.className = 'feedback-card';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-labelledby', 'feedbackQ');
  el.innerHTML = `
    <button type="button" class="feedback-x" aria-label="${esc(t('feedback.not_now'))}">&times;</button>
    <div class="feedback-q" id="feedbackQ">${esc(t(QUESTION[trigger] || QUESTION.general))}</div>
    <div class="feedback-scale" role="radiogroup" aria-label="${esc(t('feedback.scale'))}">
      ${[1, 2, 3, 4, 5].map((n) => `<button type="button" role="radio" aria-checked="false" data-r="${n}">${n}</button>`).join('')}
    </div>
    <div class="feedback-ends"><span>${esc(t('feedback.scale_low'))}</span><span>${esc(t('feedback.scale_high'))}</span></div>
    ${reasons.length ? `<div class="feedback-reasons">${reasons.map((r) => `<label><input type="checkbox" value="${esc(r)}"> ${esc(t('feedback.reason.' + r))}</label>`).join('')}</div>` : ''}
    <textarea class="input feedback-comment" maxlength="2000" placeholder="${esc(t(trigger === 'trial_ended' || trigger === 'cancelled' ? 'feedback.comment_why' : 'feedback.comment'))}"></textarea>
    <div class="feedback-actions">
      <button type="button" class="btn btn-secondary btn-sm feedback-later">${esc(t('feedback.not_now'))}</button>
      <button type="button" class="btn btn-primary btn-sm feedback-send">${esc(t('feedback.send'))}</button>
    </div>`;
  document.body.appendChild(el);
  open = el;
  let rating = null;
  el.querySelectorAll('.feedback-scale button').forEach((b) => b.addEventListener('click', () => {
    rating = Number(b.dataset.r);
    el.querySelectorAll('.feedback-scale button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
  }));
  el.querySelector('.feedback-x').addEventListener('click', () => close(trigger, true));
  el.querySelector('.feedback-later').addEventListener('click', () => close(trigger, true));
  el.querySelector('.feedback-send').addEventListener('click', async () => {
    const comment = el.querySelector('.feedback-comment').value.trim();
    const picked = [...el.querySelectorAll('.feedback-reasons input:checked')].map((i) => i.value);
    if (rating == null && !picked.length && !comment) { showToast(t('feedback.empty'), 'info'); return; }
    try {
      await api.sendFeedback({ trigger, rating, reasons: picked, comment });
      close(trigger, false);
      showToast(t('feedback.thanks'), 'success');
    } catch (e) {
      showToast(e.message || t('feedback.failed'), 'error');
    }
  });
}

/** Ask the server once per page load whether there is a moment to ask about. */
export function maybeShowFeedbackPrompt(user) {
  if (checked || !user) return;
  checked = true;
  setTimeout(async () => {
    const r = await api.feedbackPrompt();
    const link = document.getElementById('sendFeedbackLink');
    if (link) { link.hidden = !(r && r.enabled); const s = link.querySelector('span'); if (s) s.textContent = t('feedback.link'); }
    if (!r || !r.enabled || !r.prompt || open) return;
    // Not over an open modal or the first-run guide: the next page load will ask instead.
    // ⚠️ VISIBLE ones only: index.html keeps the Add screen dialog in the page, hidden, so a bare
    // querySelector('.modal-overlay') matched it on every page and the card never appeared.
    const blocking = [...document.querySelectorAll('.modal-overlay, .modal.open, #onboarding')]
      .some((el) => el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden');
    if (blocking || /^#\/(onboarding|add-screen|login)/.test(location.hash)) {
      checked = false; return;
    }
    api.feedbackShown(r.prompt.trigger);
    render(r.prompt.trigger, r.prompt.reasons || []);
  }, 4000);
}

/** The "Send feedback" link. */
export function openFeedback() { render('general', GENERAL_REASONS); }
