// Host shim for jacobenget/doom.wasm.
//
// Attract mode: nobody touching it, DOOM sits on its title loop, which plays the shareware demos by
// itself. Play mode: click the screen (that gives this frame keyboard focus — the player never
// forwards keys into a widget) and the keyboard drives the game. After `idle_sec` with no input the
// page reloads itself back into attract mode, the way an arcade cabinet resets between players.
ST.ready(function () {
  var v = ST.values;
  if (v.crt) document.body.classList.add('crt');
  if (v.smooth) document.body.classList.add('smooth');
  var attractSpeed = parseFloat(v.speed) || 1;
  var playable = v.playable !== false;
  var idleMs = Math.max(15, Number(v.idle_sec) || 60) * 1000;

  var canvas = document.getElementById('doom');
  var status = document.getElementById('status');
  var hint = document.getElementById('hint');
  var ctx = canvas.getContext('2d');
  var image = null;
  var memory = null;
  var game = null;
  var playing = false;
  var lastInput = 0;

  // The game clock. Attract mode may run fast or slow; the moment someone plays it runs at real
  // speed, continuing from where it was so DOOM never sees time jump backwards.
  var clockBase = 0, wallBase = performance.now(), rate = attractSpeed;
  function now() { return clockBase + (performance.now() - wallBase) * rate; }
  function setRate(r) { clockBase = now(); wallBase = performance.now(); rate = r; }

  function fail(msg) { status.textContent = msg; status.classList.remove('hidden'); }
  function showHint(html) { if (!playable) return; hint.innerHTML = html; hint.classList.remove('hidden'); }

  var imports = {
    loading: {
      onGameInit: function (w, h) { canvas.width = w; canvas.height = h; image = ctx.createImageData(w, h); },
      wadSizes: function () {},   // no WAD supplied: the module uses the shareware WAD it carries
      readWads: function () {},
    },
    ui: {
      drawFrame: function (ptr) {
        // DOOM's pixels are ARGB stored little-endian (BGRA in memory); canvas wants RGBA.
        var src = new Uint8Array(memory.buffer, ptr, canvas.width * canvas.height * 4);
        var dst = image.data;
        for (var i = 0; i < dst.length; i += 4) { dst[i] = src[i + 2]; dst[i + 1] = src[i + 1]; dst[i + 2] = src[i]; dst[i + 3] = 255; }
        ctx.putImageData(image, 0, 0);
      },
    },
    runtimeControl: { timeInMilliseconds: function () { return BigInt(Math.trunc(now())); } },
    console: {
      onInfoMessage: function () {},
      onErrorMessage: function (p, n) { try { console.error('[doom] ' + new TextDecoder().decode(new Uint8Array(memory.buffer, p, n))); } catch (e) {} },
    },
    gameSaving: {
      sizeOfSaveGame: function () { return 0; },
      readSaveGame: function () { return 0; },
      writeSaveGame: function () { return 0; },
    },
  };

  function keyFor(e) {
    var x = game;
    switch (e.key) {
      case 'ArrowUp': case 'w': case 'W': return x.KEY_UPARROW.value;
      case 'ArrowDown': case 's': case 'S': return x.KEY_DOWNARROW.value;
      case 'ArrowLeft': return x.KEY_LEFTARROW.value;
      case 'ArrowRight': return x.KEY_RIGHTARROW.value;
      case 'a': case 'A': case ',': return x.KEY_STRAFE_L.value;
      case 'd': case 'D': case '.': return x.KEY_STRAFE_R.value;
      case 'Control': case 'f': case 'F': return x.KEY_FIRE.value;
      case ' ': case 'e': case 'E': return x.KEY_USE.value;
      case 'Shift': return x.KEY_SHIFT.value;
      case 'Tab': return x.KEY_TAB.value;
      case 'Escape': return x.KEY_ESCAPE.value;
      case 'Enter': return x.KEY_ENTER.value;
      case 'Backspace': return x.KEY_BACKSPACE.value;
      case 'Alt': return x.KEY_ALT.value;
      case 'y': case 'Y': case 'n': case 'N': return e.key.toLowerCase().charCodeAt(0);   // "quit? y/n"
    }
    return /^[0-9]$/.test(e.key) ? e.key.charCodeAt(0) : null;   // weapon numbers
  }

  function startPlaying() {
    if (playing) return;
    playing = true;
    setRate(1);
    hint.classList.add('hidden');
  }

  function wireInput() {
    if (!playable) return;
    showHint('CLICK TO PLAY<small>arrows / WASD move · CTRL or F fire · SPACE or E open · ENTER / ESC menu</small>');
    document.addEventListener('pointerdown', function () { try { document.body.focus(); window.focus(); } catch (e) {} showHint('PRESS ENTER TO PLAY<small>ESC for the menu</small>'); lastInput = performance.now(); });
    window.addEventListener('blur', function () { if (!playing) showHint('CLICK TO PLAY<small>arrows / WASD move · CTRL or F fire · SPACE or E open · ENTER / ESC menu</small>'); });
    /*
     * ⚠️ ONE DOWN AND ONE UP PER PHYSICAL PRESS. The engine queues only 16 key events between tics;
     * the browser's auto-repeat fires ~30 keydowns a second per held key, so holding two keys
     * overflowed the queue, dropped key-ups, and keys stuck on or stopped answering. Auto-repeat
     * is ignored (DOOM knows a key is held until it hears the key-up), and `held` makes a second
     * keydown for an already-down key a no-op even where e.repeat is unreliable.
     */
    var held = new Map();   // e.code -> doom key
    function releaseAll() {
      held.forEach(function (k) { try { game.reportKeyUp(k); } catch (e) {} });
      held.clear();
    }
    window.addEventListener('keydown', function (e) {
      var k = keyFor(e);
      if (k === null) return;
      e.preventDefault(); e.stopPropagation();
      lastInput = performance.now();
      if (e.repeat || held.has(e.code)) return;
      held.set(e.code, k);
      startPlaying();
      game.reportKeyDown(k);
    }, true);
    window.addEventListener('keyup', function (e) {
      if (!held.has(e.code)) return;
      e.preventDefault(); e.stopPropagation();
      lastInput = performance.now();
      var k = held.get(e.code);
      held.delete(e.code);
      game.reportKeyUp(k);
    }, true);
    // Focus leaving mid-press means the key-up goes to someone else: let go of everything, or
    // the marine keeps running into a wall until the page reloads.
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', function () { if (document.hidden) releaseAll(); });
    // Back to attract mode once the player walks away. A reload is the only clean reset this
    // engine has — and it is the same document, from the player's cache.
    setInterval(function () {
      if (playing && performance.now() - lastInput > idleMs) location.reload();
    }, 5000);
  }

  var url = ST.asset('doom.wasm');
  if (!url) { fail('ENGINE NOT AVAILABLE'); return; }
  fetch(url)
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
    .then(function (buf) { return WebAssembly.instantiate(buf, imports); })
    .then(function (res) {
      game = res.instance.exports;
      memory = game.memory;
      game.initGame();
      status.classList.add('hidden');
      setInterval(game.tickGame, 1000 / 35);   // DOOM's native 35 Hz
      wireInput();
    })
    .catch(function (e) { fail('DOOM FAILED: ' + (e && e.message ? e.message : e)); });
});
