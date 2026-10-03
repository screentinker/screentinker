'use strict';

/*
 * Slide audio: a voiceover per slide, and one music bed under the whole deck.
 *
 * ⚠️ THE DESIGN THIS PINS, because it is not the obvious one. NEITHER TRACK IS RENDERED INTO THE
 * SLIDE DOCUMENT. The obvious implementation puts an <audio> tag next to the elements, and it is
 * wrong twice over:
 *
 *   - the player decides which ZONE owns the audio, and a widget making noise from inside an
 *     iframe fights that decision — the same reason the background video is unconditionally muted.
 *     It would also sit outside lib/media-mute, so the wall-follower rule, the operator's remote
 *     mute, the per-item flag and the autoplay gesture would all stop applying to it;
 *   - a deck publishes as one widget per slide plus a playlist, so every advance destroys the
 *     iframe. A looping bed inside it would restart on every slide, which is the one thing a bed
 *     must not do.
 *
 * So the config CARRIES both tracks and the player owns the elements. The bed is continuous because
 * publish stamps the same id onto every slide, and the player leaves an element alone when the id
 * has not changed. The whole feature rests on that: if publish ever emits different ids across a
 * deck's slides, the music restarts mid-deck and this file is what should fail.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-slideaudio-'));

const { normalizeSlide, renderSlideHtml } = require('../lib/slide-render');
const { normalizeDeck, deckWarnings } = require('../lib/slide-deck');

const slide = (audio, extra = {}) => ({ template: { elements: [], ...(audio ? { audio } : {}) }, fields: {}, ...extra });

test('a slide carries its voiceover, and clamps what it is given', () => {
  const s = normalizeSlide(slide({ vo: 'c-vo', vo_volume: 0.5 }));
  assert.equal(s.audio.vo, 'c-vo');
  assert.equal(s.audio.voVolume, 0.5);

  // Total, like the rest of normalizeSlide: nonsense becomes a default, never an exception.
  const junk = normalizeSlide(slide({ vo: { nope: 1 }, vo_volume: 99 }));
  assert.equal(junk.audio.vo, null);
  assert.equal(junk.audio.voVolume, 1);
  assert.equal(normalizeSlide(slide(null)).audio.vo, null, 'a slide with no audio block is fine');
});

test('the music bed defaults quieter than the voice', () => {
  // A bed at full volume buries the voice it is under; the default has to be usable without the
  // operator discovering the volume control first.
  assert.equal(normalizeSlide(slide({ music: 'c-bed' })).audio.musicVolume, 0.4);
  assert.equal(normalizeSlide(slide({ music: 'c-bed', music_volume: 0.9 })).audio.musicVolume, 0.9);
});

test('NEITHER track is rendered into the slide document', () => {
  const html = renderSlideHtml(slide({ vo: 'c-vo', music: 'c-bed' }), { resolveImage: (id) => `/media/${id}` });
  assert.ok(!/<audio/i.test(html), 'an <audio> element here would be outside the player\'s mute control');
  assert.ok(!html.includes('c-vo'), 'the voiceover id must not leak into the rendered document');
  assert.ok(!html.includes('c-bed'), 'nor the bed');
});

test('audio survives the save round trip', () => {
  // normalizeDeck rebuilds the document, so a field it does not name is deleted on every save —
  // the mechanism that once lost background_content_id.
  const deck = normalizeDeck({
    slides: [{ id: 's1', name: 'One', dwell_sec: 5, template: { elements: [], audio: { vo: 'c-vo', vo_volume: 0.8 } }, fields: {} }],
    music: 'c-bed',
    music_volume: 0.25,
  });
  assert.equal(deck.slides[0].template.audio.vo, 'c-vo');
  assert.equal(deck.slides[0].template.audio.vo_volume, 0.8);
  assert.equal(deck.music, 'c-bed', 'the deck-level bed must survive');
  assert.equal(deck.music_volume, 0.25);

  // And again, because "survives one save" and "survives every save" are different claims.
  const twice = normalizeDeck(deck);
  assert.equal(twice.slides[0].template.audio.vo, 'c-vo');
  assert.equal(twice.music, 'c-bed');
});

test('the bed is stored ONCE, on the deck — never per slide', () => {
  /*
   * ⚠️ THE FAILURE THIS CATCHES. If a slide can also store a bed, a deck has two places to
   * disagree about one setting: a stale id on one slide survives every save, publish emits it, and
   * the music restarts in the middle of the deck — the single failure the whole design exists to
   * avoid. So the per-slide field is not merely unused, it must not survive the round trip.
   */
  const deck = normalizeDeck({
    slides: [
      { id: 's1', name: 'One', template: { elements: [], audio: { vo: 'c-vo', music: 'wrong-1', music_volume: 0.9 } }, fields: {} },
      { id: 's2', name: 'Two', template: { elements: [], audio: { music: 'wrong-2' } }, fields: {} },
    ],
    music: 'c-bed',
  });

  assert.equal(deck.music, 'c-bed', 'the deck holds the bed');
  for (const s of deck.slides) {
    assert.equal(s.template.audio.music, undefined, 'a slide must not store a bed of its own');
    assert.equal(s.template.audio.music_volume, undefined);
  }
  // The voiceover, which genuinely is per slide, is untouched by that.
  assert.equal(deck.slides[0].template.audio.vo, 'c-vo');

  // And it stays gone across saves, rather than being dropped once and creeping back.
  const twice = normalizeDeck(deck);
  assert.equal(twice.slides[0].template.audio.music, undefined);
  assert.equal(twice.music, 'c-bed');
});

test('a voiceover longer than its slide is warned about, exactly like motion that outlives its dwell', () => {
  const deck = normalizeDeck({
    slides: [{ id: 's1', name: 'Intro', dwell_sec: 5, template: { elements: [], audio: { vo: 'c-vo' } }, fields: {} }],
  });

  const warned = deckWarnings(deck, { 'c-vo': 12 });
  const w = warned.find((x) => x.kind === 'vo-outlives-dwell');
  assert.ok(w, 'a 12s voiceover on a 5s slide has to be flagged');
  assert.equal(w.slide_id, 's1');
  assert.match(w.message, /never heard/);
  assert.equal(w.vo_sec, 12);
  assert.equal(w.dwell_sec, 5);

  assert.equal(deckWarnings(deck, { 'c-vo': 4 }).some((x) => x.kind === 'vo-outlives-dwell'), false,
    'a voiceover that fits must not warn');
});

test('an unknown duration stays quiet rather than guessing', () => {
  // A warning that fires on missing data teaches people to ignore warnings.
  const deck = normalizeDeck({
    slides: [{ id: 's1', name: 'Intro', dwell_sec: 5, template: { elements: [], audio: { vo: 'c-vo' } }, fields: {} }],
  });
  assert.equal(deckWarnings(deck).some((x) => x.kind === 'vo-outlives-dwell'), false, 'no durations passed');
  assert.equal(deckWarnings(deck, {}).some((x) => x.kind === 'vo-outlives-dwell'), false, 'empty map');
  assert.equal(deckWarnings(deck, { 'c-vo': null }).some((x) => x.kind === 'vo-outlives-dwell'), false, 'never probed');
});

/*
 * ⚠️ THE BED SURVIVES AN ADVANCE; EVERYTHING ELSE ABOUT IT IS ORDINARY.
 *
 * These pin the player's half on the source, because the behaviour only exists across two items
 * and there is no way to observe it from a single render. The failure they guard is precise: if
 * the player ever compares URLs instead of ids, or re-assigns src on a matching track, the music
 * restarts — at every slide change, or the first time somebody replaces the audio file.
 */
test('the player keys the bed on the track id, never the URL', () => {
  const player = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  assert.match(player, /a\.music_id !== bedTrackId/,
    'the bed must restart only when the ID changes — /replace keeps the id and changes the filepath');
  assert.ok(!/a\.music_url !== bed/.test(player), 'comparing URLs would restart the bed on a file swap');
});

test('the player leaves a matching bed alone rather than restarting it', () => {
  const player = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  const fn = player.slice(player.indexOf('function applySlideAudio'), player.indexOf('function applyMute(item)'));

  // src is assigned only inside the "different track" branch.
  const srcAssignments = (fn.match(/bedEl\.src\s*=/g) || []).length;
  assert.equal(srcAssignments, 1, 'assigning src on a matching track is an audible stutter every slide');
  assert.match(fn, /stopSlideVo\(\);/, 'the voiceover is replaced on every item');
  assert.match(fn, /bedEl\.muted = applyMuteWanted\(item\)/,
    'the bed goes through the same mute decision as every other element');
});

test('the audio elements are in the document, where applyMute can reach them', () => {
  // The whole reason they are not in the slide iframe: applyMute sweeps `video, audio` across this
  // document, and that sweep is what applies the wall-follower rule, the remote mute, the per-item
  // flag and the autoplay gesture.
  const player = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  assert.match(player, /document\.body\.appendChild\(voEl\)/);
  assert.match(player, /document\.body\.appendChild\(bedEl\)/);
  assert.match(player, /document\.querySelectorAll\('video, audio'\)/, 'the sweep that governs them');
});

test('an empty playlist stops the bed', () => {
  // It survives an advance, not the playlist going away — music to an empty stage is a support call.
  const player = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  const gate = player.slice(player.indexOf('if (!playlist.length || !Number.isFinite(currentIndex))'));
  assert.match(gate.slice(0, 600), /stopSlideBed\(\)/);
});

test('the snapshot hands the player URLs plus the music id', () => {
  // A player cannot resolve a content id: /api/content/:id/file is authenticated and a player is
  // not a dashboard user. It gets paths, like every other media item in a snapshot — and the id
  // as well, purely so the sameness check above can be done on something stable.
  const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'playlists.js'), 'utf8');
  const fn = routes.slice(routes.indexOf('function attachSlideAudio'), routes.indexOf('// Build the snapshot item list'));
  assert.match(fn, /vo_url/);
  assert.match(fn, /music_id/);
  assert.match(fn, /music_url/);
  assert.match(fn, /widget_type !== 'slide'/, 'it must not touch items that are not slides');
});

/*
 * ⚠️ THE GESTURE CANNOT REACH THE PLAYER THROUGH A SLIDE, and everything about audio depends on it.
 *
 * Autoplay policy refuses unmuted playback without a user gesture, and the player listens for one
 * on `document`. A slide fills the screen with an iframe, so a click lands INSIDE it and never
 * reaches the parent — clicking the picture did nothing at all, with no indication why. The
 * YouTube embed has carried a click-to-unmute overlay for this exact reason for far longer.
 */
test('a slide with audio offers a way to actually start it', () => {
  const player = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  const fn = player.slice(player.indexOf('function offerSlideUnmute'), player.indexOf('function applySlideAudio'));

  assert.match(fn, /if \(!PREVIEW_MODE\) return;/,
    'preview only — on a wall nobody clicks, so this would be a caption burnt into a signage screen');
  assert.match(fn, /shouldOfferUnmute/,
    'offered only when a gesture is the ONLY thing in the way, never over a deliberate mute');
  assert.match(fn, /document\.body\.appendChild\(ov\)/,
    'on body, not #playerContainer — renderContent rebuilds that immediately after applySlideAudio');
  assert.match(fn, /position:fixed/, 'and fixed, to match being outside the container');
});

test('a gesture retries playback, not just the mute flag', () => {
  // Unmuting a PAUSED element makes no sound. play() is called once at item start, and if the
  // policy refused it nothing came back to try again — tryUnmuteLeader only revisits <video>.
  const player = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  const fn = player.slice(player.indexOf('function resumeSlideAudio'), player.indexOf('function offerSlideUnmute'));
  assert.match(fn, /el\.muted = applyMuteWanted\(item\)/, 're-apply the mute decision');
  assert.match(fn, /if \(el\.paused\) el\.play\(\)/, 'and restart what the policy refused');

  // Wired into the existing gesture handler, below its wall-follower guard.
  const gesture = player.slice(player.indexOf("['click', 'touchstart', 'keydown']"));
  assert.match(gesture.slice(0, 1200), /resumeSlideAudio\(\)/);
});

/*
 * ⚠️ EVERY PLAYER, OR THE PRODUCT HAS TO SAY WHICH ONES. Slide audio is metadata on the ITEM, not
 * something inside the slide document — so a player that just renders the widget iframe makes no
 * sound at all. That is a per-player implementation, and where it is missing the capability must be
 * missing too, or the dashboard offers a deck with a voiceover to a screen that cannot say it.
 */
test('every player that implements slide audio declares it — including android, which earns it', () => {
  const caps = fs.readFileSync(path.join(__dirname, '..', 'lib', 'player-capabilities.js'), 'utf8');
  assert.match(caps, /'playback\.slide_audio'/, 'the capability has to exist in the vocabulary');

  // The web player (which BrightSign also runs) and Tizen own the audio elements themselves.
  const web = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  assert.match(web, /'playback\.slide_audio'/, 'the web player declares it');
  const tizenCaps = fs.readFileSync(path.join(__dirname, '..', '..', 'tizen', 'js', 'capabilities.js'), 'utf8');
  assert.match(tizenCaps, /'playback\.slide_audio'/, 'tizen declares it');

  // Android implements it in SlideAudioPlayer, so the APK declares it for itself...
  const kt = fs.readFileSync(path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main',
    'java', 'com', 'remotedisplay', 'player', 'telemetry', 'PlayerCapabilities.kt'), 'utf8');
  assert.match(kt, /"playback\.slide_audio"/, 'the android player declares it');

  // ...but the server-side android BASELINE must NOT, and this is the assertion that keeps it out.
  // The baseline describes the panels that have NOT updated: an older APK renders a slide widget
  // with no audio element anywhere near it, so a deck with a voiceover plays silently there. The
  // baseline is what the server assumes on the panel's behalf when the panel declares nothing, and
  // assuming this one would offer a voiceover to a screen that cannot say it. A panel that HAS the
  // feature replaces the baseline with its own declaration — which is the line asserted above.
  const androidBlock = caps.slice(caps.indexOf('  android: ['), caps.indexOf('  tizen: ['));
  assert.ok(!/slide_audio/.test(androidBlock),
    'the android baseline covers un-updated panels, which are silent — it must not advertise it');
});

test('tizen mirrors the web player\'s bed rule, id-compared and left alone when it matches', () => {
  const tz = fs.readFileSync(path.join(__dirname, '..', '..', 'tizen', 'js', 'player.js'), 'utf8');
  const fn = tz.slice(tz.indexOf('PlaylistPlayer.prototype.applySlideAudio'),
                      tz.indexOf('PlaylistPlayer.prototype.stopSlideBed'));
  assert.match(fn, /a\.music_id !== this\._bedTrackId/, 'restart only when the ID changes');
  assert.equal((fn.match(/bed\.src\s*=/g) || []).length, 1, 'src assigned only on a genuine change');
  assert.match(fn, /document\.body\.appendChild/, 'not in the stage — clearStage() runs on every advance');

  // And the bed is torn down by stop(), never by an advance.
  const stop = tz.slice(tz.indexOf('PlaylistPlayer.prototype.stop = function'));
  assert.match(stop.slice(0, 400), /stopSlideAudio\(\)/);
  const clear = tz.slice(tz.indexOf('PlaylistPlayer.prototype.clearStage = function'));
  assert.ok(!/stopSlideBed|stopSlideAudio/.test(clear.slice(0, 400)),
    'clearStage must NOT stop the bed — it runs between every slide');
});

test('tizen resolves audio against the server, not the widget package', () => {
  // A .wgt document origin is the package; a server-relative /uploads path would 404 there.
  const tz = fs.readFileSync(path.join(__dirname, '..', '..', 'tizen', 'js', 'player.js'), 'utf8');
  const fn = tz.slice(tz.indexOf('PlaylistPlayer.prototype.absUrl'), tz.indexOf('PlaylistPlayer.prototype.playCurrent'));
  assert.match(fn, /this\.getBase\(\)/, 'same resolver contentUrl uses');
  assert.match(fn, /\^https\?:/, 'an already-absolute URL is left alone');
});
