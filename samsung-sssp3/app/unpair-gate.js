// Unpairing a web player AT THE PANEL: who is allowed to, and what has to be cleared.
//
// ⚠️ WHY THIS IS A MODULE AND NOT TEN LINES IN THE KEYDOWN HANDLER. Esc used to call
// confirm('Reset player and return to setup?') and, on OK, wipe the identity — so anyone who could
// reach a keyboard on a kiosk could unpair the display, and the operator's first sign of it was a
// screen showing a pairing code. A confirm() dialog is not a permission check; it only establishes
// that somebody meant to press the button, which is exactly what was wrong.
//
// The replacement has two parts that can be wrong in ways nobody would see for months — who passes
// the gate, and which keys the wipe touches — and both are pure functions of their inputs. Left
// inline they would be reachable only through a real browser and a real PIN.
//
// FAILS CLOSED, unlike the schedule evaluator next door. schedule-eval fails OPEN because a blank
// screen is worse than a wrongly-played item. Here the safe direction is the opposite: an
// unexplained input must leave the screen paired and playing, because the cost of a wrong "allow"
// is a display that stops working in a shop and needs someone to drive to it.
//
// Dependency-free UMD: Node + browser (window.UnpairGate).

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.UnpairGate = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Length-checked compare. Not because timing is the threat — the person typing is standing at the
   * screen — but for the same reason the trigger and local-API secrets do it: comparing a 2-digit
   * guess against a 6-digit PIN should not cost measurably less than comparing two 6-digit ones.
   */
  function matches(given, known) {
    if (typeof given !== 'string' || typeof known !== 'string') return false;
    if (!given.length || given.length !== known.length) return false;
    var diff = 0;
    for (var i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ known.charCodeAt(i);
    return diff === 0;
  }

  /**
   * May this Esc + PIN unpair the screen?
   *
   * @param {string|null} given  what was typed.
   * @param {string|null} known  the settings PIN this player holds for this screen.
   * @returns {{allow: boolean, reason: string}} reason ∈ no_pin | empty | wrong | ok
   */
  /**
   * The PIN this system actually issues: six digits (lib/settings-pin.js), generated from a CSPRNG,
   * with sequences and repeats refused on explicit set.
   *
   * ⚠️ ANYTHING THAT IS NOT A NUMERIC CODE IS TREATED AS NO PIN AT ALL, and that is not pedantry.
   * A bare `String(known)` turns 0 into "0", false into "false" and a JSON null into "null" — each
   * of which is a non-empty string, and therefore a credential something could type. The same trap
   * has already cost this project twice: org.json's optString returning "null" on Android made a
   * panel with NO trigger secret accept `ST1 null <token>`, and it made the literal token "null"
   * clear every active trigger. Four is the floor rather than six so a future PIN length does not
   * silently lock every screen out of unpairing.
   */
  function looksLikePin(v) {
    if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
    if (typeof v !== 'string') return null;
    var t = v.trim();
    return /^[0-9]{4,}$/.test(t) ? t : null;
  }

  function decide(given, known) {
    var k = looksLikePin(known) || '';
    /*
     * ⚠️ NO PIN MEANS NO UNPAIRING — never "no PIN means just confirm". A screen this player has
     * never been told a PIN for stays paired. Any other answer restores the old public-reset
     * behaviour for precisely the screens least likely to have anyone watching them, and it would do
     * it silently, because a display that unpairs looks the same as one that was never paired.
     *
     * It also covers "not known YET": a player that reloaded while the WAN was down has no PIN until
     * device:paired arrives. Refusing is right in both cases, and they are indistinguishable from
     * here — the alternative is guessing, and guessing wrong unpairs a working screen.
     */
    if (!k) return { allow: false, reason: 'no_pin' };
    var g = given == null ? '' : String(given).trim();
    if (!g) return { allow: false, reason: 'empty' };
    if (!matches(g, k)) return { allow: false, reason: 'wrong' };
    return { allow: true, reason: 'ok' };
  }

  /**
   * Everything that has to leave localStorage for the wipe to mean anything.
   *
   * ⚠️ st_install_id IS LOAD-BEARING, and it is the entry most likely to be dropped by someone
   * tidying this list. It salts the per-install fingerprint the server matches on: leave it and the
   * next register presents the SAME fingerprint, gets reclaimed onto the row that was just
   * unpaired, and the operator watches a screen come straight back as the display they just
   * removed. That is the failure mode the ?reset= path already carries a comment about, and the one
   * that made the old Esc look like it had worked while changing nothing.
   *
   * @param {string} suffix SCREEN_SUFFIX — '' everywhere except a dual-output BrightSign, whose two
   *   widgets share one origin and one localStorage. Clearing screen 1's keys from screen 2 would
   *   unpair the wrong output.
   */
  function storageKeys(suffix) {
    var sfx = suffix == null ? '' : String(suffix);
    return [
      'rd_web_player' + sfx,        // identity: deviceId, deviceToken, paired, settingsPin
      'rd_playlist_cache' + sfx,    // content, so the next pairing does not play the last tenant's
      'rd_layout_cache' + sfx,
      'rd_trigger_cfg' + sfx,       // a LAN listener config, including its secret
      'rd_triggers_cache' + sfx,
      'st_install_id' + sfx,        // see above — without this the whole wipe is theatre
      'st_group_sync',              // unsuffixed by design: one clock per player process
    ];
  }

  /**
   * The same URL without ?k=, keeping every other parameter. null when there was no key.
   *
   * ⚠️ The enrolment key is an identity too (#313) and it lives in the URL, which no amount of
   * clearing localStorage touches. It is re-read on every load and sets paired=true, so a player
   * reloaded with ?k= still in place pairs straight back as the same display and never shows a
   * pairing code — the unpair would appear to do nothing at all. Other parameters are preserved
   * because they are not identity: ?screen=2 decides WHICH output this widget paints, and dropping
   * it would collapse a dual-output BrightSign onto one screen.
   */
  function urlWithoutEnrolKey(href) {
    try {
      var u = new URL(String(href));
      if (!u.searchParams.has('k')) return null;
      u.searchParams.delete('k');
      return u.toString();
    } catch (e) {
      return null;
    }
  }

  return { decide: decide, matches: matches, storageKeys: storageKeys, urlWithoutEnrolKey: urlWithoutEnrolKey };
});
