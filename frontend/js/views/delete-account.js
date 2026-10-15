/*
 * #/delete-account: the "Delete my account" card on a page of its own. The Simple view's account
 * menu and the Manager app link here (Settings opens in the phone's browser from the app, and a
 * Google Play reviewer has to find deletion INSIDE the app). Advanced view has the same card in
 * Settings (#/settings?section=delete-account). components/delete-account.js does the work.
 */
import { t } from '../i18n.js';
import { esc } from '../utils.js';
import { mountDeleteAccountCard } from '../components/delete-account.js';

export function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>${esc(t('account_delete.title'))}</h1>
        <div class="subtitle">${esc(t('account_delete.page_subtitle'))}</div>
      </div>
    </div>
    <div class="settings-section" id="deleteAccountCard">
      <div data-delete-account-body></div>
    </div>`;
  mountDeleteAccountCard(container.querySelector('[data-delete-account-body]'));
}

export function cleanup() {}
