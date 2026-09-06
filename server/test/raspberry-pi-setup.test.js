'use strict';

/*
 * The Pi installer generates another script (the kiosk launcher) and writes it to disk. Nothing
 * ever executed either one in CI, so every defect in them was found by a user on real hardware —
 * which is how #245 arrived: a menu that ignored the operator, a keyring prompt, X11 tools
 * no-oping on a Wayland Pi, and a banner spelling the product's own name wrong.
 *
 * These tests check the two things a repo can check without a Pi: that the generated script is
 * syntactically valid bash, and that the flags/guards the bug reports turned on are actually
 * present. `bash -n` on the OUTER script would not have caught any of it — the kiosk script lives
 * inside a heredoc, where a syntax error is just text until it reaches a screen.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'raspberry-pi-setup.sh');
const SRC = fs.readFileSync(SCRIPT, 'utf8');

// The kiosk launcher as the installer will write it, with the install-time expansions applied.
function generatedKioskScript() {
  const m = SRC.match(/cat > "\$PI_HOME\/screentinker-kiosk\.sh" << KIOSKEOF\n([\s\S]*?)\nKIOSKEOF/);
  assert.ok(m, 'kiosk heredoc not found — did the installer restructure?');
  return m[1]
    .replace(/\$\{KIOSK_URL\}/g, 'http://localhost:3001/player')
    .replace(/\$\{SCREENTINKER_PORT\}/g, '3001')
    .replace(/\$\{CHROMIUM_BIN\}/g, '/usr/bin/chromium-browser')
    .replace(/\\\$/g, '$')
    .replace(/\\\\/g, '\\');
}

function bashSyntaxOk(text) {
  const p = path.join(os.tmpdir(), `st-kiosk-${process.pid}-${Math.abs(text.length)}.sh`);
  fs.writeFileSync(p, text);
  try {
    execFileSync('bash', ['-n', p], { stdio: 'pipe' });
    return true;
  } catch (e) {
    throw new Error(`generated script is not valid bash:\n${e.stderr?.toString() || e.message}`);
  } finally {
    try { fs.unlinkSync(p); } catch { /* best-effort */ }
  }
}

test('#245: the installer itself is valid bash', () => {
  assert.ok(bashSyntaxOk(SRC));
});

test('#245: the kiosk launcher it generates is valid bash', () => {
  assert.ok(bashSyntaxOk(generatedKioskScript()));
});

test('#245: prompts read the terminal, not the pipe', () => {
  // `curl … | sudo bash` makes stdin the SCRIPT. bash has consumed it by the time any read
  // runs, so a plain `read` gets EOF instantly and the menu "chooses" the default without the
  // operator touching anything — reported as the menu being skipped, because it was.
  assert.match(SRC, /exec 3<\/dev\/tty/, 'prompts must come from the controlling terminal');
  // Any prompting `read` that is not the one inside ask() itself (which is the tty read).
  const reads = SRC.match(/^\s*read (?!.*-u 3).*-p /gm) || [];
  assert.equal(reads.length, 0, `every prompt must go through ask(); found a raw read: ${reads[0]}`);
  assert.match(SRC, /read .*-u 3/, 'ask() must read from the tty fd');
  // And when there is genuinely no terminal, it must SAY which way it went rather than let an
  // empty answer look like a decision.
  assert.match(SRC, /No terminal available for the menu/);
});

test('#245: Chromium is told not to ask for a keyring', () => {
  // "Choose password for keyring" on every boot: Chromium reaching for gnome-keyring on a
  // desktop session. A kiosk has nobody to answer it.
  assert.match(generatedKioskScript(), /--password-store=basic/);
});

test('#245: X11-only tools are guarded by the session type', () => {
  // Pi 5 on Bookworm defaults to Wayland, where xset/unclutter/xrandr are no-ops that log an
  // error and silently do nothing — so the Pi got no blanking suppression and no cursor
  // hiding while looking configured.
  const kiosk = generatedKioskScript();
  assert.match(kiosk, /SESSION_TYPE/, 'the launcher must detect the display server');
  const x11Block = kiosk.slice(kiosk.indexOf('if [ "$SESSION_TYPE" = "wayland" ]'), kiosk.indexOf('# Clean Chromium crash flags'));
  assert.ok(x11Block.length > 0, 'session-type branch not found');
  for (const tool of ['xset', 'unclutter']) {
    assert.ok(x11Block.includes(tool), `${tool} must live inside the session-type branch`);
  }
  assert.match(kiosk, /--ozone-platform=wayland/, 'Wayland needs the ozone backend named');
});

test('#245: the crash-restore surface is cleared, not just flagged', () => {
  // The white page on every boot after the first: a kiosk is killed by shutdown, never exits
  // cleanly, and Chromium returns with a restore surface over the player. ALT+F4 "fixed" it
  // because it closed that surface, not the player. Rewriting the flags is not enough on its
  // own — Chromium also replays the previous window set from Sessions/.
  const kiosk = generatedKioskScript();
  assert.match(kiosk, /exited_cleanly/, 'the clean-exit flag must be rewritten');
  assert.match(kiosk, /rm -rf .*Sessions/, 'the stored session must be removed too');
  assert.match(kiosk, /--disable-session-crashed-bubble/);
});

test('#245: the login banner spells the product name', () => {
  // It read "Scree Tinker" — the n was missing from the ASCII art, and it is the first thing
  // anyone sees over SSH.
  const motd = SRC.slice(SRC.indexOf("cat > /etc/motd << 'MOTDEOF'"), SRC.indexOf('MOTDEOF\n', SRC.indexOf("cat > /etc/motd") + 30));
  const lines = motd.split('\n').filter((l) => /[_\\\/|()]/.test(l) && l.trim().length > 20);
  assert.ok(lines.length >= 5, 'expected the 5-row banner');
  // Row 4 of figlet "standard" carries the distinguishing strokes: 'n' contributes "| | | |".
  const banner = lines.join('\n');
  assert.ok(banner.includes('| | | |'), 'the n glyph is missing from the banner — it reads "Scree Tinker"');
});

// ---------------------------------------------------------------------------------------------
// #245 round two: the installer advertised what it had not installed.
//
// The MOTD is written unconditionally and listed three commands, but section 11 creates them only
// on an All-in-One install. So a Player-Only Pi greeted its operator at every SSH login with three
// commands that were not on it. Same failure shape as the first round — the script describing a
// state it never reached — and the same reporter found both.

// The generated MOTD for a given mode: the base heredoc plus whichever command block that mode
// appends. Extracted rather than re-typed, so a future edit to either half shows up here.
function motdFor(playerOnly) {
  const base = SRC.match(/cat > \/etc\/motd << 'MOTDEOF'\n([\s\S]*?)\nMOTDEOF/);
  assert.ok(base, 'MOTD heredoc not found — did the installer restructure?');
  const blocks = [...SRC.matchAll(/cat >> \/etc\/motd << 'MOTDCMDEOF'\n([\s\S]*?)\nMOTDCMDEOF/g)];
  assert.equal(blocks.length, 2, 'expected exactly two per-mode MOTD command blocks');
  // The all-in-one block is written in the `if [ "$PLAYER_ONLY" = false ]` arm, which comes first.
  return base[1] + (playerOnly ? blocks[1][1] : blocks[0][1]);
}

// Which management commands the installer actually creates in a given mode.
function commandsCreated(playerOnly) {
  const all = [...SRC.matchAll(/cat > \/usr\/local\/bin\/(screentinker-[a-z]+)/g)].map((m) => m[1]);
  // Section 11 is an if/else: the all-in-one arm creates update, the player arm does not.
  return playerOnly ? all.filter((c) => c !== 'screentinker-update') : all;
}

test('#245: the MOTD never advertises a command that mode did not install', () => {
  for (const playerOnly of [false, true]) {
    const motd = motdFor(playerOnly);
    const created = commandsCreated(playerOnly);
    const advertised = [...motd.matchAll(/(screentinker-[a-z]+)/g)].map((m) => m[1]);
    assert.ok(advertised.length > 0, `${playerOnly ? 'player' : 'all-in-one'} MOTD lists no commands at all`);
    for (const cmd of advertised) {
      assert.ok(created.includes(cmd),
        `the ${playerOnly ? 'Player-Only' : 'All-in-One'} MOTD advertises ${cmd}, which that mode does not install`);
    }
  }
});

test('#245: a Player-Only Pi is not left with no diagnostics at all', () => {
  // The cheap fix would have been to print nothing on a player. That trades a wrong banner for a
  // machine an operator cannot inspect over SSH, which is the harder support call.
  const motd = motdFor(true);
  assert.match(motd, /screentinker-status/, 'a player still needs to answer "is it running?"');
  assert.match(motd, /screentinker-logs/, 'and "why did it stop?"');
  assert.doesNotMatch(motd, /screentinker-update/,
    'there is no local server to update on a player-only install, so it must not be offered');
});

test('#245: the Wayland cursor claim is backed by something that runs', () => {
  // The launcher used to state that the installer wrote the compositor cursor config "below". It
  // did not: wayfire.ini and hide_cursor each appeared exactly once, both inside that comment.
  const code = SRC.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.match(code, /wayfire\.ini/, 'no wayfire.ini handling outside comments');
  assert.match(code, /\[hide-cursor\]/, 'the hide-cursor section is never written');
  assert.match(code, /hide_delay/, 'the plugin is configured without a delay');
  // Non-destructive: a Pi whose owner already tuned wayfire must not silently lose it.
  assert.match(code, /screentinker-bak/, 'wayfire.ini is edited without a backup');
});

// ---------------------------------------------------------------------------------------------
// One launcher per install: the desktop "fallback" unit was the renderer leak.
//
// A Pi OS Desktop install used to get two launchers for the same Chromium profile: the desktop
// autostart entry AND a systemd unit written "as fallback". The unit ran outside the Wayland
// session, so its Chromium could not reach the compositor and exited; systemd restarted it every
// ~10s; each retry found the autostart's browser holding SingletonLock, forwarded its URL into it
// as a NEW TAB, and exited again. One more tab and one more renderer per cycle, forever. A six-Pi
// headless deployment reported it as "a major memory leak in the renderers", and fixed it in the
// field with `systemctl disable --now screentinker-kiosk.service` -- which also removed the only
// crash recovery those Pis had. So: Desktop gets the autostart only, the launcher supervises
// Chromium itself, and it refuses to start against a profile another instance already holds.

// The two arms of section 8, so a test can say which launcher each Pi OS variant gets.
function kioskLaunchArms() {
  const start = SRC.indexOf('# 8. Kiosk launcher supervision');
  const end = SRC.indexOf('# 9. Auto-login on tty1');
  assert.ok(start > 0 && end > start, 'section 8 not found -- did the installer restructure?');
  const sec = SRC.slice(start, end);
  const split = sec.indexOf('\nelse\n');
  assert.ok(split > 0, 'section 8 is expected to be one if/else on HAS_DESKTOP');
  return { lite: sec.slice(0, split), desktop: sec.slice(split) };
}

test('one launcher: a Desktop install writes the autostart entry and NO systemd unit', () => {
  const { lite, desktop } = kioskLaunchArms();
  assert.match(lite, /cat > \/etc\/systemd\/system\/screentinker-kiosk\.service/,
    'Lite has no session to autostart from; it still needs the unit that starts X');
  assert.doesNotMatch(desktop, /cat > \/etc\/systemd\/system\/screentinker-kiosk\.service/,
    'Desktop must not get a second launcher racing the autostart for the profile lock');
  assert.match(desktop, /\.config\/autostart"\n[\s\S]*?screentinker\.desktop/, 'the autostart entry is THE launcher on Desktop');
  assert.doesNotMatch(lite, /screentinker\.desktop/);
});

test('one launcher: re-running the installer removes the unit an earlier install left on a Desktop Pi', () => {
  const { desktop } = kioskLaunchArms();
  assert.match(desktop, /systemctl disable --now screentinker-kiosk\.service/);
  assert.match(desktop, /rm -f \/etc\/systemd\/system\/screentinker-kiosk\.service/);
});

test('one launcher: the launcher refuses to start against a profile another Chromium already holds', () => {
  const kiosk = generatedKioskScript();
  const guard = kiosk.slice(kiosk.indexOf('SingletonLock'), kiosk.indexOf('while :; do'));
  assert.ok(guard.length > 0, 'the lock guard must come before the restart loop');
  assert.match(guard, /kill -0 "\$LOCK_PID"/, 'a stale lock (dead pid) must not block a start');
  assert.match(guard, /exit 0/, 'a live lock is a clean no-op, not a failure to be retried');
});

test('one launcher: the launcher supervises Chromium itself instead of exec-ing it', () => {
  // The unit's Restart=always was the only crash recovery Desktop had. With the unit gone the
  // loop is it, so Chromium must NOT be exec'd (exec hands the process over and nothing restarts).
  const kiosk = generatedKioskScript();
  assert.doesNotMatch(kiosk, /\bexec \/usr\/bin\/chromium-browser/);
  const loop = kiosk.slice(kiosk.indexOf('while :; do'), kiosk.lastIndexOf('\ndone'));
  assert.match(loop, /\/usr\/bin\/chromium-browser \\\n\s+--kiosk/, 'Chromium runs inside the loop');
  assert.match(loop, /sleep 5/, 'a crashed browser comes back after a pause, not in a busy loop');
  assert.match(loop, /clean_crash_flags/,
    'the crash flags must be cleaned before EVERY start, or the restart restores the "crashed" session');
});

test('one launcher: the management scripts no longer assume the kiosk unit exists', () => {
  // screentinker-status / -logs / -update used to query the unit unconditionally; on a Desktop
  // Pi that now reads "STOPPED" forever and follows an empty journal.
  // Each use must be guarded somewhere between the start of ITS management script and the use.
  const guarded = (idx) => {
    const scriptStart = SRC.lastIndexOf('cat > /usr/local/bin/', idx);
    assert.ok(scriptStart > 0, `kiosk-unit use at offset ${idx} is outside any management script`);
    return /list-unit-files[^\n]*screentinker-kiosk\.service|KIOSK_UNIT/.test(SRC.slice(scriptStart, idx));
  };
  for (const m of SRC.matchAll(/systemctl (?:is-active|start|stop) screentinker-kiosk\.service/g)) {
    // Section 8 itself may reference the unit; only the generated management scripts are in scope.
    if (m.index < SRC.indexOf('# 11. Management scripts')) continue;
    assert.ok(guarded(m.index), `'${m[0]}' at offset ${m.index} assumes the unit exists`);
  }
  for (const m of SRC.matchAll(/journalctl -u screentinker-kiosk\.service/g)) {
    assert.ok(guarded(m.index), `journalctl on the kiosk unit at offset ${m.index} assumes the unit exists`);
  }
});
