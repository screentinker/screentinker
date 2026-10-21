'use strict';

/*
 * An over-limit web player showed "Nothing scheduled right now" instead of "Device Limit Reached".
 * Found filming the troubleshooting guide: the café moved to Free (2 screens) with 3 screens, all
 * three reloaded, and the third went dark with the wrong message.
 *
 * The server's suspended payload was right. The player put the card up, but a reload had already
 * started the cached playlist, and the suspended branch only emptied `playlist`: the item's advance
 * timer stayed armed, fired a few seconds later, found nothing to play and ran showNothingScheduled(),
 * which replaced the card (and then re-armed itself every 30 s).
 *
 * The real handlePlaylistUpdate, showNothingScheduled and showStatus run here against a fake DOM and
 * a fake clock; only the media teardown is a stand-in.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLAYER = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');

function extract(name) {
  const at = PLAYER.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found`);
  let i = PLAYER.indexOf('{', at), depth = 0, end = i;
  for (; end < PLAYER.length; end++) {
    if (PLAYER[end] === '{') depth++;
    else if (PLAYER[end] === '}' && --depth === 0) { end++; break; }
  }
  return PLAYER.slice(at, end);
}

function harness() {
  // A fake clock: timers run only when the test says so.
  const timers = new Map(); let nextId = 1;
  const setT = (fn) => { const id = nextId++; timers.set(id, fn); return id; };
  const clearT = (id) => { timers.delete(id); };
  const runAll = () => { for (let n = 0; n < 10 && timers.size; n++) { const fns = [...timers.values()]; timers.clear(); fns.forEach((f) => f()); } };

  const overlay = { style: { display: 'none' }, _html: '', set innerHTML(v) { this._html = v; this.text = null; }, get innerHTML() { return this._html; },
    appendChild(el) { this.text = el; } };
  const container = { style: { display: 'block' } };
  const document = {
    getElementById: (id) => id === 'playerContainer' ? container : id === 'statusOverlay' ? overlay : id === 'statusText' ? overlay.text || null : null,
    createElement: () => ({ style: {}, textContent: '' }),
  };
  const src = ['handlePlaylistUpdate', 'showNothingScheduled', 'showStatus', 'clearLookahead'].map(extract).join('\n');
  const api = new Function('document', 'setTimeout', 'clearTimeout', '_t', `
    let playlist = [{ content_id: 'menu', filepath: 'menu.png', mime_type: 'image/png' }];
    let currentIndex = 0, isPlaying = true, advanceTimer = null, scheduleRetryTimer = null;
    let lookaheadFrom = null, lookaheadIdx = -1, deferredRotation = false, deferredRotationDeadline = null;
    let campaign = null, campaignStopped = 0, slideStops = 0;
    function stopCampaign() { campaignStopped++; campaign = null; }
    function stopSlideVo() { slideStops++; } function stopSlideBed() { slideStops++; }
    function renderDefaultContent() { return false; }
    function nextActiveIndex() { return playlist.length ? 0 : -1; }
    function commitNextIndex(from) { return nextActiveIndex(from); }
    // Stand-in for the real teardown: the part that matters here is that it cancels the item's advance.
    function teardownCurrentMedia() { if (advanceTimer) { clearTimeout(advanceTimer); advanceTimer = null; } }
    function nextItem() { const idx = commitNextIndex(currentIndex); if (idx === -1) { showNothingScheduled(); return; } }
    ${src}
    // The cached item is on screen with its advance armed, as after a reload.
    advanceTimer = setTimeout(nextItem, 10000);
    return {
      handlePlaylistUpdate,
      armIdleRecheck() { scheduleRetryTimer = setTimeout(() => showNothingScheduled(), 30000); },
      startCampaign() { campaign = { steps: [1] }; },
      state: () => ({ isPlaying, playlist, campaignStopped, slideStops }),
    };`)(document, setT, clearT, (k) => (k === 'nothing_scheduled' ? 'Nothing scheduled right now' : k));
  return { api, overlay, container, runAll, timers };
}

const LIMIT = { assignments: [], suspended: true, reason: 'device_limit', message: 'Device Limit Reached', detail: 'Upgrade your plan to activate this display.' };

test('the limit card stays up after the interrupted item\'s advance timer would have fired', () => {
  const h = harness();
  h.api.handlePlaylistUpdate(LIMIT);
  assert.match(h.overlay.innerHTML, /Device Limit Reached/);
  assert.equal(h.container.style.display, 'none');
  h.runAll();
  assert.match(h.overlay.innerHTML, /Device Limit Reached/, 'nothing painted "Nothing scheduled right now" over the card');
  assert.equal(h.overlay.text, null, 'showStatus never ran');
  assert.equal(h.timers.size, 0, 'and nothing is left re-arming itself');
  assert.equal(h.api.state().isPlaying, false);
});

test('...also when the screen was on the 30 s idle re-check, or playing a campaign', () => {
  const h = harness();
  h.api.armIdleRecheck();
  h.api.startCampaign();
  h.api.handlePlaylistUpdate({ ...LIMIT, reason: 'trial_expired', message: 'Trial Expired' });
  h.runAll();
  assert.match(h.overlay.innerHTML, /Trial Expired/);
  assert.equal(h.api.state().campaignStopped, 1, 'the campaign engine let go of the stage');
  assert.equal(h.api.state().slideStops, 2, 'slide voiceover and music bed stopped');
});
