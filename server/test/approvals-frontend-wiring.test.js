// The dashboard side of approvals and history is vanilla ES modules, so the cheapest guard against
// a half-wired feature is a static one: the route, the nav item, the API client methods and the
// per-view hooks all have to be there. frontend-parses.test.js proves the files load; this proves
// they are connected.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const FE = path.join(__dirname, '..', '..', 'frontend');
const read = (p) => fs.readFileSync(path.join(FE, p), 'utf8');

test('reviews view is routed and in the nav', () => {
  const app = read('js/app.js');
  assert.match(app, /import \* as reviews from '\.\/views\/reviews\.js'/);
  assert.match(app, /hash === '#\/reviews'/);
  assert.match(app, /reviews: 'nav\.reviews'/);
  assert.match(read('index.html'), /data-view="reviews"/);
});

test('api client exposes every approval and history call the views use', () => {
  const api = read('js/api.js');
  for (const fn of ['getApprovalSettings', 'updateApprovalSettings', 'getReviewQueue', 'getMySubmissions', 'getSubmission', 'submitForReview',
    'withdrawSubmission', 'approveSubmission', 'requestChanges', 'publishSubmission', 'getHistory', 'getRevision', 'diffRevision',
    'restoreRevision', 'publishDraft', 'discardDraft']) {
    assert.match(api, new RegExp(`^\\s+${fn}: `, 'm'), fn);
  }
  assert.match(api, /export async function fetchRevisionRender/);
  assert.match(api, /export async function fetchRevisionFileUrl/);
});

test('every authored resource view offers History and the approval actions', () => {
  assert.match(read('js/views/playlists.js'), /renderApprovalBar\(.*type: 'playlist'/s);
  assert.match(read('js/views/slides.js'), /renderApprovalBar\(.*type: 'slide_deck'/s);
  assert.match(read('js/views/layout-editor.js'), /renderApprovalBar\(.*type: 'layout'/s);
  assert.match(read('js/views/widgets.js'), /data-history-widget/);
  assert.match(read('js/views/content-library.js'), /data-history-content/);
  assert.match(read('js/views/workspace-members.js'), /renderApprovalSettings/);
});

test('the admin card explains the single-user case and the disable consequences', () => {
  const en = read('js/i18n/en.js');
  assert.match(en, /'approval\.blocked_single_user'/);
  assert.match(en, /'approval\.disable_confirm'.*cancelled.*auto-published/);
  assert.match(en, /'review\.self_approval_note'/);
});
