// UPTIME 3036 — an original raycasting shooter for ScreenTinker. MIT licence (see LICENSE).
//
// Everything here is generated in code: wall textures, drones, pickups and the station itself.
// The world is rendered into a small pixel buffer (#view) and scaled up; the HUD is drawn crisp on
// a full-resolution canvas (#hud) on top.
//
// Two modes share one game loop:
//   attract — a bot plays (hunts drones, picks up cells, takes the exit) and a title card shows;
//   play    — a person has the keyboard. After `idle_sec` without input it hands back to the bot.
'use strict';

ST.ready(function () {
  var V = ST.values || {};

  /* ============================================================== settings */

  function hexRgb(h, dflt) {
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(h || ''));
    if (!m) return dflt;
    var s = m[1].length === 3 ? m[1].replace(/(.)/g, '$1$1') : m[1];
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  }
  var ACC = hexRgb(V.accent, [0, 229, 255]);
  var ACC2 = hexRgb(V.accent2, [255, 43, 214]);
  var TITLE = String(V.title || 'UPTIME 3036').slice(0, 24);
  var TAGLINE = String(V.tagline || '').slice(0, 60);
  var PLAYABLE = V.playable !== false;
  var IDLE_MS = Math.max(10, Number(V.idle_sec) || 45) * 1000;
  var RES = Math.min(640, Math.max(240, parseInt(V.resolution, 10) || 400));
  var DIFF = { easy: 0.6, normal: 1, hard: 1.5 }[V.difficulty] || 1;
  if (V.crt !== false) document.body.classList.add('crt');

  /* ============================================================== rng */

  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash2(x, y) {
    var h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  /* ============================================================== pixels */

  // ImageData is RGBA in memory; a Uint32 view on a little-endian machine reads it as ABGR.
  function px(r, g, b) {
    return ((255 << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0;
  }
  function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }
  function mixc(c, t, k) { return [c[0] + (t[0] - c[0]) * k, c[1] + (t[1] - c[1]) * k, c[2] + (t[2] - c[2]) * k]; }

  var TS = 64;   // texture size

  function makeTex(fn) {
    var out = new Uint32Array(TS * TS);
    for (var y = 0; y < TS; y++) {
      for (var x = 0; x < TS; x++) {
        var c = fn(x, y);
        out[y * TS + x] = c ? px(clamp255(c[0]), clamp255(c[1]), clamp255(c[2])) : 0;
      }
    }
    return out;
  }

  /* ============================================================== textures */

  var noise = rng(3036);
  var grain = new Float32Array(TS * TS);
  for (var gi = 0; gi < grain.length; gi++) grain[gi] = noise() * 10 - 5;

  // 1: server rack — rails, 1U/2U units, vent grilles and status LEDs. Two frames, so the LEDs
  // blink; a few are amber or failing red, because this is the night the servers went down.
  function makeRack(phase) {
    return makeTex(function (x, y) {
      var g = grain[y * TS + x];
      if (x < 4 || x > 59) return ((y % 6) === 2 && (x === 2 || x === 61)) ? [8, 9, 12] : [58, 62, 74];
      var unit = y >> 3, uy = y & 7;
      if (uy === 0) return [14, 15, 20];
      if (uy === 7) return [24, 26, 34];
      var face = [44 + g, 48 + g, 60 + g];
      if (x >= 7 && x <= 16 && uy >= 3 && uy <= 4) {
        var led = (x - 7) >> 1;
        if ((x - 7) & 1) return face;
        var h = hash2(unit * 7 + led, 11);
        var on = hash2(unit * 13 + led, phase + 3) > 0.35;
        if (h > 0.93) return on ? [255, 40, 50] : [70, 12, 14];
        if (h > 0.8) return on ? [255, 180, 30] : [70, 50, 10];
        return on ? [60, 255, 120] : [14, 60, 30];
      }
      if (x >= 22 && x <= 56 && uy >= 2 && uy <= 5) return ((x + uy) & 1) ? [20, 22, 30] : [36, 40, 52];
      return face;
    });
  }
  var TEX_RACK = [makeRack(0), makeRack(1)];

  // 2: patch panel — two rows of ports, cables drooping in every colour a tech ever grabbed.
  var cableRng = rng(8080);
  var cables = [];
  for (var cb = 0; cb < 12; cb++) {
    var cols = [ACC, ACC2, [255, 214, 40], [60, 220, 90], [80, 120, 255], [240, 240, 240]];
    cables.push({ x: 6 + cb * 4.6 + cableRng() * 1.5, sag: 8 + cableRng() * 14, col: cols[(cableRng() * cols.length) | 0], row: cb & 1 });
  }
  var TEX_PATCH = makeTex(function (x, y) {
    var g = grain[y * TS + x];
    if (x < 3 || x > 60) return [58, 62, 74];
    var c = [30 + g, 32 + g, 42 + g];
    if ((y >= 6 && y <= 10) || (y >= 14 && y <= 18)) {
      var px2 = (x - 4) % 5;
      if (px2 >= 1 && px2 <= 3) c = (y === 6 || y === 14) ? [120, 126, 140] : [6, 6, 10];
    }
    for (var i = 0; i < cables.length; i++) {
      var cbl = cables[i];
      var y0 = cbl.row ? 17 : 9;
      if (y < y0) continue;
      var t = (y - y0) / (64 - y0);
      var cx = cbl.x + Math.sin(t * Math.PI) * cbl.sag * 0.35 * (i & 2 ? 1 : -1);
      if (Math.abs(x - cx) < 1.1) c = mixc(cbl.col, [0, 0, 0], Math.abs(x - cx) * 0.5);
    }
    return c;
  });

  // 3: error monitor — a warning triangle and garbled red log lines.
  var TEX_ERROR = makeTex(function (x, y) {
    if (x < 4 || x > 59 || y < 6 || y > 50) {
      if (y > 50 && y < 60 && x > 26 && x < 38) return [40, 42, 52];
      return (x < 2 || x > 61 || y < 4 || y > 60) ? [18, 19, 26] : [30, 32, 40];
    }
    var c = [10, 4, 8];
    var tx = x - 32, ty = y - 11;
    if (ty >= 0 && ty < 14 && Math.abs(tx) <= ty * 0.62) {
      c = (Math.abs(tx) < 1.3 && (ty > 3 && ty < 10 || ty === 12)) ? [20, 10, 0] : [255, 190, 40];
    }
    if (y >= 29 && y <= 46 && (y % 3) !== 2 && x >= 8 && x <= 55) {
      var word = hash2((x / 4) | 0, y) > 0.3;
      if (word) c = hash2(y, 3) > 0.7 ? [255, 190, 40] : [255, 60, 70];
    }
    return c;
  });

  // 4: the service lift to the next floor — steel doors, a green UP arrow.
  var TEX_EXIT = makeTex(function (x, y) {
    if (x < 3 || x > 60 || y < 3) return [36, 40, 52];
    if (y < 14) {
      var ax = Math.abs(x - 32), ay = y - 4;
      if (ay >= 0 && ay < 8 && ax <= ay * 0.9) return [60, 255, 120];
      return [14, 16, 20];
    }
    if (x === 31 || x === 32) return [10, 10, 14];
    var brush = 120 + grain[y * TS + x] * 2 + ((x * 7) % 5);
    if (x === 4 || x === 59) return [60, 255, 120];
    return [brush, brush + 6, brush + 16];
  });

  var WALL_TEX = [null, TEX_RACK[0], TEX_PATCH, TEX_ERROR, TEX_EXIT];

  /* ============================================================== sprites */

  // A bug: a glitchy beetle — shell, legs, antennae, two small eyes. Frame 1 is a glitch frame
  // (rows slip sideways), because these are software bugs made visible.
  function makeBug(glitch, flash) {
    return makeTex(function (x, y) {
      var sx = x;
      if (glitch && (y % 9 === 3 || y % 9 === 4)) sx = x + ((y % 2) ? 3 : -3);
      var dx = sx - 32, dy = y - 38;
      var c = null;
      var body = (dx * dx) / 290 + (dy * dy) / 170;
      if (body < 1) {
        var light = Math.max(0, 1 - ((dx + 6) * (dx + 6) + (dy + 6) * (dy + 6)) / 300);
        c = mixc(mixc(ACC2, [0, 0, 0], 0.55), mixc(ACC2, [255, 255, 255], 0.35), light);
        if (Math.abs(dx) < 1 && dy > -9) c = [20, 6, 18];
        if (dy > 2 && (dx * 3 + y) % 11 === 0) c = mixc(c, [0, 0, 0], 0.4);
      }
      var hx = sx - 32, hy = y - 24;
      if (hx * hx / 90 + hy * hy / 40 < 1) {
        c = [34, 20, 40];
        if (Math.abs(hy + 1) < 1.5 && (Math.abs(hx - 4) < 1.5 || Math.abs(hx + 4) < 1.5)) c = [240, 250, 255];
      }
      for (var l = 0; l < 3; l++) {
        var ly = 32 + l * 6;
        if (Math.abs(y - (ly + Math.abs(dx) * 0.25)) < 1 && Math.abs(dx) > 14 && Math.abs(dx) < 23) c = [60, 30, 70];
      }
      if (y < 20 && y > 10 && (Math.abs(sx - (28 - (20 - y) * 0.5)) < 0.9 || Math.abs(sx - (36 + (20 - y) * 0.5)) < 0.9)) c = [120, 80, 140];
      if (glitch && c && hash2(x, y) > 0.9) c = hash2(y, x) > 0.5 ? ACC : [255, 255, 255];
      return c && flash ? mixc(c, [255, 255, 255], 0.7) : c;
    });
  }
  var SPR_BUG = [makeBug(false, false), makeBug(true, false)];
  var SPR_BUG_HIT = makeBug(false, true);

  // Coffee: the only thing keeping uptime up.
  var SPR_COFFEE = makeTex(function (x, y) {
    var dx = x - 30;
    if (y >= 34 && y <= 60 && Math.abs(dx) <= 11) {
      if (y < 37) return [60, 36, 20];
      return (y > 44 && y < 50) ? mixc(ACC, [255, 255, 255], 0.3) : [238, 236, 230];
    }
    var hx = x - 43, hy = y - 46;
    if (Math.abs(Math.sqrt(hx * hx + hy * hy) - 5) < 1.4 && hx > 0) return [238, 236, 230];
    if (y > 18 && y < 32 && (Math.abs(x - (26 + Math.sin(y / 3) * 2)) < 0.8 || Math.abs(x - (34 + Math.sin(y / 3 + 2) * 2)) < 0.8)) return [200, 205, 215];
    return null;
  });
  // A patch drive (refills the patch gun).
  var SPR_PATCH = makeTex(function (x, y) {
    var dx = Math.abs(x - 32);
    if (y >= 22 && y < 30 && dx <= 5) return (y > 24 && y < 27 && dx >= 2 && dx <= 3) ? [30, 30, 36] : [200, 206, 220];
    if (y >= 30 && y <= 60 && dx <= 8) {
      if (y > 36 && y < 50 && dx <= 5) return mixc(ACC, [255, 255, 255], 0.15);
      if (y === 55 && dx <= 1) return [60, 255, 120];
      return [40, 44, 58];
    }
    return null;
  });
  // A corrupted packet, thrown by bugs.
  var SPR_PACKET = makeTex(function (x, y) {
    var dx = Math.abs(x - 32), dy = Math.abs(y - 32);
    if (dx > 8 || dy > 8) return null;
    var h = hash2(x >> 1, y >> 1);
    return h > 0.66 ? ACC2 : h > 0.33 ? [255, 60, 70] : [255, 255, 255];
  });

  /* ============================================================== canvases */

  var view = document.getElementById('view');
  var hud = document.getElementById('hud');
  var vctx = view.getContext('2d');
  var hctx = hud.getContext('2d');
  var W = 0, H = 0, img = null, buf = null, zbuf = null, HW = 0, HH = 0, dpr = 1;

  function resize() {
    var cw = Math.max(1, view.clientWidth), ch = Math.max(1, view.clientHeight);
    W = RES;
    H = Math.max(120, Math.min(480, Math.round(RES * ch / cw)));
    view.width = W; view.height = H;
    img = vctx.createImageData(W, H);
    buf = new Uint32Array(img.data.buffer);
    zbuf = new Float32Array(W);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    HW = Math.round(cw * dpr); HH = Math.round(ch * dpr);
    hud.width = HW; hud.height = HH;
  }
  window.addEventListener('resize', resize);
  resize();

  /* ============================================================== the station */

  var MAP = 28;
  var map, rooms, exitCell, level, levelSeed;
  var player, enemies, pickups, bolts, particles, score, message, messageSub, messageUntil, deadUntil;

  function generate(seed, lvl) {
    var r = rng(seed * 31 + lvl * 7919);
    map = new Uint8Array(MAP * MAP);
    for (var i = 0; i < map.length; i++) map[i] = 1;
    rooms = [];
    for (var a = 0; a < 120 && rooms.length < 9; a++) {
      var w = 4 + (r() * 5 | 0), h = 4 + (r() * 5 | 0);
      var x = 1 + (r() * (MAP - w - 2) | 0), y = 1 + (r() * (MAP - h - 2) | 0);
      var ok = true;
      for (var j = 0; j < rooms.length && ok; j++) {
        var o = rooms[j];
        if (x < o.x + o.w + 1 && x + w + 1 > o.x && y < o.y + o.h + 1 && y + h + 1 > o.y) ok = false;
      }
      if (!ok) continue;
      rooms.push({ x: x, y: y, w: w, h: h, cx: x + (w >> 1), cy: y + (h >> 1) });
      for (var yy = y; yy < y + h; yy++) for (var xx = x; xx < x + w; xx++) map[yy * MAP + xx] = 0;
    }
    // Corridors: each room to the next, an L at a time.
    for (var k = 1; k < rooms.length; k++) {
      var A = rooms[k - 1], B = rooms[k];
      var hx = A.cx, hy = A.cy;
      while (hx !== B.cx) { map[hy * MAP + hx] = 0; hx += hx < B.cx ? 1 : -1; }
      while (hy !== B.cy) { map[hy * MAP + hx] = 0; hy += hy < B.cy ? 1 : -1; }
      map[hy * MAP + hx] = 0;
    }
    // Dress the walls: circuit rooms and windows onto the city.
    for (var q = 0; q < rooms.length; q++) {
      var R = rooms[q];
      var style = r() < 0.4 ? 2 : 1;
      for (var yy2 = R.y - 1; yy2 <= R.y + R.h; yy2++) {
        for (var xx2 = R.x - 1; xx2 <= R.x + R.w; xx2++) {
          var idx = yy2 * MAP + xx2;
          if (map[idx] === 0) continue;
          map[idx] = style;
          if (r() < 0.12) map[idx] = 3;
        }
      }
    }
    // The exit: a wall of the room farthest (by walking distance) from the start.
    var dist = bfs(rooms[0].cx, rooms[0].cy);
    var far = rooms[0], fd = -1;
    for (var f = 1; f < rooms.length; f++) {
      var dd = dist[rooms[f].cy * MAP + rooms[f].cx];
      if (dd > fd) { fd = dd; far = rooms[f]; }
    }
    exitCell = null;
    var cands = [];
    for (var ex = far.x; ex < far.x + far.w; ex++) { cands.push([ex, far.y - 1]); cands.push([ex, far.y + far.h]); }
    for (var ey = far.y; ey < far.y + far.h; ey++) { cands.push([far.x - 1, ey]); cands.push([far.x + far.w, ey]); }
    for (var c = 0; c < cands.length && !exitCell; c++) {
      var cc = cands[(c + (r() * cands.length | 0)) % cands.length];
      if (cc[0] > 0 && cc[1] > 0 && cc[0] < MAP - 1 && cc[1] < MAP - 1 && map[cc[1] * MAP + cc[0]] !== 0) exitCell = cc;
    }
    if (exitCell) map[exitCell[1] * MAP + exitCell[0]] = 4;

    // Drones and supplies, never in the starting room.
    enemies = []; pickups = []; bolts = []; particles = [];
    var count = Math.min(18, Math.round((4 + lvl * 2) * (0.7 + 0.3 * DIFF)));
    for (var n = 0, tries = 0; n < count && tries < 500; tries++) {
      var room = rooms[1 + (r() * (rooms.length - 1) | 0)];
      var sx = room.x + 0.5 + r() * (room.w - 1), sy = room.y + 0.5 + r() * (room.h - 1);
      if (Math.hypot(sx - rooms[0].cx, sy - rooms[0].cy) < 6) continue;
      enemies.push({ x: sx, y: sy, hp: lvl > 3 ? 4 : 3, aware: false, cool: 1 + r() * 2, hit: 0, dead: 0, bob: r() * 6 });
      n++;
    }
    for (var p = 0; p < 3 + (lvl > 2 ? 1 : 0); p++) {
      var pr = rooms[1 + (r() * (rooms.length - 1) | 0)];
      pickups.push({ x: pr.x + 0.5 + r() * (pr.w - 1), y: pr.y + 0.5 + r() * (pr.h - 1), kind: p % 2 ? 'energy' : 'health' });
    }
    var s = rooms[0];
    player.x = s.cx + 0.5; player.y = s.cy + 0.5;
    player.a = r() * Math.PI * 2;
  }

  function solid(x, y) {
    if (x < 0 || y < 0 || x >= MAP || y >= MAP) return true;
    return map[(y | 0) * MAP + (x | 0)] !== 0;
  }

  function bfs(sx, sy) {
    var d = new Int16Array(MAP * MAP).fill(-1);
    var qx = [sx], qy = [sy];
    d[sy * MAP + sx] = 0;
    for (var h = 0; h < qx.length; h++) {
      var x = qx[h], y = qy[h], nd = d[y * MAP + x] + 1;
      var nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (var i = 0; i < 4; i++) {
        var nx = x + nb[i][0], ny = y + nb[i][1];
        if (nx < 0 || ny < 0 || nx >= MAP || ny >= MAP) continue;
        var id = ny * MAP + nx;
        if (d[id] !== -1 || map[id] !== 0) continue;
        d[id] = nd; qx.push(nx); qy.push(ny);
      }
    }
    return d;
  }

  function lineOfSight(x0, y0, x1, y1) {
    var dx = x1 - x0, dy = y1 - y0;
    var steps = Math.ceil(Math.hypot(dx, dy) * 6);
    for (var i = 1; i < steps; i++) {
      if (solid(x0 + dx * i / steps, y0 + dy * i / steps)) return false;
    }
    return true;
  }

  function tryMove(o, nx, ny, rad) {
    if (!solid(nx + (nx > o.x ? rad : -rad), o.y + rad) && !solid(nx + (nx > o.x ? rad : -rad), o.y - rad)) o.x = nx;
    if (!solid(o.x + rad, ny + (ny > o.y ? rad : -rad)) && !solid(o.x - rad, ny + (ny > o.y ? rad : -rad))) o.y = ny;
  }

  /* ============================================================== game state */

  var mode = 'attract';
  player = { x: 2, y: 2, a: 0, hp: 100, energy: 100, cool: 0, flash: 0, hurt: 0, bob: 0 };

  function newGame(seed) {
    level = 1; levelSeed = seed; score = 0;
    player.hp = 100; player.energy = 100;
    generate(levelSeed, level);
    say('FLOOR 1', 2200, 'THE SERVERS ARE DOWN');
  }
  function nextLevel() {
    level++; score += 500;
    player.hp = Math.min(100, player.hp + 25); player.energy = 100;
    generate(levelSeed, level);
    say('FLOOR ' + level, 2600, 'SERVERS RESTORED — NEXT FLOOR');
  }
  function say(text, ms, sub) { message = text; messageSub = sub || ''; messageUntil = performance.now() + ms; }

  /* ============================================================== input */

  var keys = {};           // action -> true while held
  var held = new Map();    // e.code -> action
  var lastInput = 0;
  var ACTIONS = {
    ArrowUp: 'fwd', KeyW: 'fwd', ArrowDown: 'back', KeyS: 'back',
    ArrowLeft: 'left', ArrowRight: 'right', KeyQ: 'left', KeyE: 'right',
    KeyA: 'sl', KeyD: 'sr', Space: 'fire', ControlLeft: 'fire', ControlRight: 'fire', KeyF: 'fire',
    Escape: 'esc', Enter: 'start',
  };

  function takeOver() {
    if (mode === 'play') return;
    mode = 'play';
    newGame((Math.random() * 1e9) | 0);
  }
  function releaseAll() { held.clear(); keys = {}; }

  if (PLAYABLE) {
    // One action per physical press: auto-repeat is ignored, and focus leaving lets go of all.
    window.addEventListener('keydown', function (e) {
      var act = ACTIONS[e.code];
      lastInput = performance.now();
      if (act || mode !== 'play') e.preventDefault();
      if (mode !== 'play') { if (!e.repeat) takeOver(); return; }
      if (!act || e.repeat || held.has(e.code)) return;
      if (act === 'esc') { newGame((Math.random() * 1e9) | 0); startIntro(); return; }
      held.set(e.code, act);
      keys[act] = true;
    }, true);
    window.addEventListener('keyup', function (e) {
      var act = held.get(e.code);
      if (!act) return;
      e.preventDefault();
      held.delete(e.code);
      keys[act] = false;
      held.forEach(function (a) { if (a === act) keys[act] = true; });
    }, true);
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', function () { if (document.hidden) releaseAll(); });
    document.addEventListener('pointerdown', function () {
      try { document.body.focus(); window.focus(); } catch (err) { /* best effort */ }
      lastInput = performance.now();
      if (mode !== 'play') takeOver();
    });
  }

  /* ============================================================== the bot */

  var botPath = null, botRepath = 0, botStuck = { x: 0, y: 0, t: 0 }, botJink = 0;

  function botControl(dt) {
    var k = { fwd: false, back: false, left: false, right: false, sl: false, sr: false, fire: false };
    var target = null, td = 1e9;
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      if (e.dead) continue;
      var d = Math.hypot(e.x - player.x, e.y - player.y);
      if (d < 11 && d < td && lineOfSight(player.x, player.y, e.x, e.y)) { target = e; td = d; }
    }
    var goal = null;
    if (target) {
      var diff = angleTo(target.x, target.y);
      if (diff > 0.04) k.right = true; else if (diff < -0.04) k.left = true;
      if (Math.abs(diff) < 0.09) k.fire = player.energy > 10;
      botJink += dt;
      if (td > 4) k.fwd = Math.abs(diff) < 0.5;
      if (Math.sin(botJink * 1.3) > 0.3) k.sl = true; else if (Math.sin(botJink * 1.3) < -0.3) k.sr = true;
      return k;
    }
    // Nothing in sight: walk towards the nearest supply when low, else a drone, else the exit.
    var want = null;
    if (player.hp < 45 || player.energy < 25) want = nearest(pickups.filter(function (p) { return !p.taken; }));
    if (!want) want = nearest(enemies.filter(function (e) { return !e.dead; }));
    if (!want && exitCell) goal = [exitCell[0], exitCell[1]];
    else if (want) goal = [want.x | 0, want.y | 0];
    botRepath -= dt;
    if (goal && (!botPath || botRepath <= 0)) { botPath = pathTo(goal[0], goal[1]); botRepath = 0.6; }
    if (botPath && botPath.length > 1) {
      if (Math.hypot(botPath[1][0] + 0.5 - player.x, botPath[1][1] + 0.5 - player.y) < 0.45) botPath.shift();
      // Aim at the farthest waypoint in plain sight, not the next cell: smooth lines through
      // doorways instead of zig-zagging cell to cell and grinding along walls.
      var aim = Math.min(1, botPath.length - 1);
      for (var j = Math.min(botPath.length - 1, 8); j > 1; j--) {
        if (lineOfSight(player.x, player.y, botPath[j][0] + 0.5, botPath[j][1] + 0.5)
          && clearance(player.x, player.y, botPath[j][0] + 0.5, botPath[j][1] + 0.5)) { aim = j; break; }
      }
      var nx = botPath[aim][0] + 0.5, ny = botPath[aim][1] + 0.5;
      var dd = angleTo(nx, ny);
      if (dd > 0.08) k.right = true; else if (dd < -0.08) k.left = true;
      k.fwd = Math.abs(dd) < 0.7;
    } else {
      k.right = true;
    }
    // Stuck on a corner for a second and a half? Back off and turn.
    botStuck.t += dt;
    if (botStuck.t > 1.5) {
      if (Math.hypot(player.x - botStuck.x, player.y - botStuck.y) < 0.15) { k.back = true; k.left = true; botPath = null; }
      botStuck = { x: player.x, y: player.y, t: 0 };
    }
    return k;
  }
  // A body is 0.5 wide: the straight line must be clear to either side as well.
  function clearance(x0, y0, x1, y1) {
    var dx = x1 - x0, dy = y1 - y0, d = Math.hypot(dx, dy) || 1;
    var ox = -dy / d * 0.28, oy = dx / d * 0.28;
    return lineOfSight(x0 + ox, y0 + oy, x1 + ox, y1 + oy) && lineOfSight(x0 - ox, y0 - oy, x1 - ox, y1 - oy);
  }
  function nearest(list) {
    var best = null, bd = 1e9;
    for (var i = 0; i < list.length; i++) {
      var d = Math.hypot(list[i].x - player.x, list[i].y - player.y);
      if (d < bd) { bd = d; best = list[i]; }
    }
    return best;
  }
  function angleTo(x, y) {
    var d = Math.atan2(y - player.y, x - player.x) - player.a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }
  // Path to a cell, or to a floor cell beside it (the exit is a wall).
  function pathTo(gx, gy) {
    var d = bfs(player.x | 0, player.y | 0);
    var end = null, best = 1e9;
    var cand = [[gx, gy], [gx + 1, gy], [gx - 1, gy], [gx, gy + 1], [gx, gy - 1]];
    for (var i = 0; i < cand.length; i++) {
      var c = cand[i];
      if (c[0] < 0 || c[1] < 0 || c[0] >= MAP || c[1] >= MAP) continue;
      var v = d[c[1] * MAP + c[0]];
      if (v >= 0 && v < best) { best = v; end = c; }
    }
    if (!end) return null;
    var path = [end];
    var cur = end;
    while (d[cur[1] * MAP + cur[0]] > 0) {
      var nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (var j = 0; j < 4; j++) {
        var nx = cur[0] + nb[j][0], ny = cur[1] + nb[j][1];
        if (nx < 0 || ny < 0 || nx >= MAP || ny >= MAP) continue;
        if (d[ny * MAP + nx] === d[cur[1] * MAP + cur[0]] - 1) { cur = [nx, ny]; break; }
      }
      path.unshift(cur);
      if (path.length > 400) break;
    }
    if (gx === end[0] && gy === end[1]) return path;
    path.push([gx, gy]);
    return path;
  }

  /* ============================================================== update */

  function update(dt, now) {
    var k = mode === 'play' ? keys : botControl(dt);
    var bot = mode !== 'play';

    if (deadUntil) {
      if (now > deadUntil) { deadUntil = 0; newGame((Math.random() * 1e9) | 0); if (!bot) startIntro(); }
      return;
    }

    // Player movement.
    var turn = 2.6 * dt;
    if (k.left) player.a -= turn;
    if (k.right) player.a += turn;
    var sp = 3.2 * dt, mx = 0, my = 0;
    var ca = Math.cos(player.a), sa = Math.sin(player.a);
    if (k.fwd) { mx += ca * sp; my += sa * sp; }
    if (k.back) { mx -= ca * sp * 0.7; my -= sa * sp * 0.7; }
    if (k.sl) { mx += sa * sp * 0.8; my -= ca * sp * 0.8; }
    if (k.sr) { mx -= sa * sp * 0.8; my += ca * sp * 0.8; }
    if (mx || my) {
      tryMove(player, player.x + mx, player.y + my, 0.25);
      player.bob += dt * 9;
    }
    // Touching the exit door.
    if (exitCell && Math.abs(player.x - (exitCell[0] + 0.5)) < 0.95 && Math.abs(player.y - (exitCell[1] + 0.5)) < 0.95) {
      nextLevel();
      return;
    }

    // Weapon.
    player.cool -= dt;
    player.flash = Math.max(0, player.flash - dt * 6);
    player.energy = Math.min(100, player.energy + dt * (bot ? 6 : 3));
    if (k.fire && player.cool <= 0 && player.energy >= 4) {
      player.cool = 0.28; player.energy -= 4; player.flash = 1;
      fireHitscan();
    }

    // Drones.
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      if (e.dead) { e.dead += dt; continue; }
      e.hit = Math.max(0, e.hit - dt * 5);
      e.bob += dt * 3;
      var dx = player.x - e.x, dy = player.y - e.y, d = Math.hypot(dx, dy);
      if (!e.aware && d < 12 && lineOfSight(e.x, e.y, player.x, player.y)) e.aware = true;
      if (!e.aware) continue;
      if (d > 2.2) tryMove(e, e.x + dx / d * 1.3 * DIFF * dt, e.y + dy / d * 1.3 * DIFF * dt, 0.3);
      e.cool -= dt;
      if (e.cool <= 0 && d < 14 && lineOfSight(e.x, e.y, player.x, player.y)) {
        e.cool = (1.8 + Math.random()) / DIFF;
        bolts.push({ x: e.x, y: e.y, vx: dx / d * 5.5, vy: dy / d * 5.5 });
      }
    }
    // Bolts.
    for (var b = bolts.length - 1; b >= 0; b--) {
      var bo = bolts[b];
      bo.x += bo.vx * dt; bo.y += bo.vy * dt;
      if (solid(bo.x, bo.y)) { burst(bo.x - bo.vx * dt, bo.y - bo.vy * dt, ACC2, 5); bolts.splice(b, 1); continue; }
      if (Math.hypot(bo.x - player.x, bo.y - player.y) < 0.35) {
        player.hp -= (bot ? 5 : 9) * DIFF;
        player.hurt = 1;
        bolts.splice(b, 1);
      }
    }
    player.hurt = Math.max(0, player.hurt - dt * 2);
    if (bot) player.hp = Math.min(100, player.hp + dt * 2);
    if (player.hp <= 0) { player.hp = 0; deadUntil = now + 2600; say('KERNEL PANIC', 2600, 'UPTIME HIT ZERO'); }

    // Supplies.
    for (var p = 0; p < pickups.length; p++) {
      var pk = pickups[p];
      if (pk.taken || Math.hypot(pk.x - player.x, pk.y - player.y) > 0.55) continue;
      if (pk.kind === 'health' && player.hp >= 100) continue;
      pk.taken = true;
      if (pk.kind === 'health') player.hp = Math.min(100, player.hp + 30);
      else player.energy = 100;
      score += 25;
    }
    // Sparks.
    for (var q = particles.length - 1; q >= 0; q--) {
      var s = particles[q];
      s.life -= dt; s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt; s.vz -= 3 * dt;
      if (s.life <= 0) particles.splice(q, 1);
    }
  }

  function fireHitscan() {
    var wallD = zbuf ? zbuf[W >> 1] : 99;
    var best = null, bd = 1e9;
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      if (e.dead) continue;
      var d = Math.hypot(e.x - player.x, e.y - player.y);
      if (d > wallD + 0.3 || d >= bd) continue;
      if (Math.abs(angleTo(e.x, e.y)) > Math.atan(0.42 / d)) continue;
      best = e; bd = d;
    }
    if (!best) return;
    best.hp--; best.hit = 1; best.aware = true;
    burst(best.x, best.y, ACC, 6);
    if (best.hp <= 0) { best.dead = 0.001; score += 100; burst(best.x, best.y, ACC2, 18); }
  }

  function burst(x, y, col, n) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, s = 0.6 + Math.random() * 1.6;
      particles.push({ x: x, y: y, z: 0.5, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: 1 + Math.random() * 1.5, life: 0.5 + Math.random() * 0.5, col: col });
    }
  }

  /* ============================================================== render: world */

  var FOG = [4, 5, 16];
  var FOG_DIST = 17;

  function shade(c, d) {
    // c = packed colour; darken towards the fog colour with distance.
    var k = d / FOG_DIST;
    if (k > 1) k = 1;
    k = k * k * (3 - 2 * k);
    var r = c & 255, g = (c >>> 8) & 255, b = (c >>> 16) & 255;
    return px(r + (FOG[0] - r) * k, g + (FOG[1] - g) * k, b + (FOG[2] - b) * k);
  }

  // Packed once: the floor/ceiling pass touches every pixel, every frame.
  // A raised datacenter floor: grey tiles, dark seams, some perforated cold-aisle tiles.
  var P_FLOOR_LINE = px(12, 13, 18), P_FLOOR_A = px(52, 56, 66), P_FLOOR_B = px(46, 50, 60), P_FLOOR_PERF = px(22, 26, 34);
  var P_CEIL = px(24, 26, 40), P_CEIL_SEAM = px(17, 18, 30), P_CEIL_LIGHT = px(170, 190, 225);

  function renderWorld(now) {
    var dirX = Math.cos(player.a), dirY = Math.sin(player.a);
    // Camera plane half-width = half the aspect ratio: square pixels (walls are H/dist tall), so
    // a 16:9 zone and a 4:3 one both see an undistorted station, just a wider or narrower slice.
    var fov = 0.5 * W / H;
    var plX = -dirY * fov, plY = dirX * fov;
    var half = H >> 1;
    var bobOff = mode === 'play' ? Math.sin(player.bob) * H * 0.006 : 0;
    var horizon = half + bobOff | 0;

    // Floor and ceiling, cast per row.
    var rx0 = dirX - plX, ry0 = dirY - plY, rx1 = dirX + plX, ry1 = dirY + plY;
    for (var y = 0; y < H; y++) {
      var p = y - horizon;
      var isFloor = p > 0;
      var rowDist = (0.5 * H) / Math.max(0.5, Math.abs(p));
      var stepX = rowDist * (rx1 - rx0) / W, stepY = rowDist * (ry1 - ry0) / W;
      var fx = player.x + rowDist * rx0, fy = player.y + rowDist * ry0;
      var row = y * W;
      for (var x = 0; x < W; x++) {
        var cx = fx | 0, cy = fy | 0, ux = fx - cx, uy = fy - cy;
        var c;
        if (isFloor) {
          if (ux < 0.03 || uy < 0.03) c = P_FLOOR_LINE;
          else if (hash2(cx, cy + 99) > 0.78 && ((ux * 12) % 1) < 0.35 && ((uy * 12) % 1) < 0.35) c = P_FLOOR_PERF;
          else c = (cx + cy) & 1 ? P_FLOOR_A : P_FLOOR_B;
        } else if (ux < 0.04 || uy < 0.04) {
          c = P_CEIL_SEAM;
        } else {
          c = (ux > 0.25 && ux < 0.75 && uy > 0.25 && uy < 0.75 && hash2(cx, cy) > 0.72) ? P_CEIL_LIGHT : P_CEIL;
        }
        buf[row + x] = shade(c, rowDist);
        fx += stepX; fy += stepY;
      }
    }

    // Walls.
    var pulse = 0.75 + 0.25 * Math.sin(now / 180);
    for (var col = 0; col < W; col++) {
      var camX = 2 * col / W - 1;
      var rdx = dirX + plX * camX, rdy = dirY + plY * camX;
      var mapX = player.x | 0, mapY = player.y | 0;
      var ddx = Math.abs(1 / rdx), ddy = Math.abs(1 / rdy);
      var stepx = rdx < 0 ? -1 : 1, stepy = rdy < 0 ? -1 : 1;
      var sdx = rdx < 0 ? (player.x - mapX) * ddx : (mapX + 1 - player.x) * ddx;
      var sdy = rdy < 0 ? (player.y - mapY) * ddy : (mapY + 1 - player.y) * ddy;
      var side = 0, hit = 0, guard = 0;
      while (!hit && guard++ < 64) {
        if (sdx < sdy) { sdx += ddx; mapX += stepx; side = 0; } else { sdy += ddy; mapY += stepy; side = 1; }
        if (mapX < 0 || mapY < 0 || mapX >= MAP || mapY >= MAP) { hit = 1; break; }
        hit = map[mapY * MAP + mapX];
      }
      var perp = side === 0 ? sdx - ddx : sdy - ddy;
      if (perp < 0.05) perp = 0.05;
      zbuf[col] = perp;
      var lineH = (H / perp) | 0;
      var top = horizon - (lineH >> 1), bot = top + lineH;
      var tex = hit === 1 ? TEX_RACK[((now / 450) | 0) & 1] : (WALL_TEX[hit] || TEX_RACK[0]);
      var wallX = side === 0 ? player.y + perp * rdy : player.x + perp * rdx;
      wallX -= Math.floor(wallX);
      var tx = (wallX * TS) | 0;
      if ((side === 0 && rdx > 0) || (side === 1 && rdy < 0)) tx = TS - tx - 1;
      var y0 = top < 0 ? 0 : top, y1 = bot > H ? H : bot;
      var dim = side ? 0.78 : 1;
      if (hit === 4) dim *= pulse;
      for (var yy = y0; yy < y1; yy++) {
        var ty = (((yy - top) * TS / lineH) | 0) & (TS - 1);
        var t = tex[ty * TS + tx];
        if (dim !== 1) t = px((t & 255) * dim, ((t >>> 8) & 255) * dim, ((t >>> 16) & 255) * dim);
        buf[yy * W + col] = shade(t, perp);
      }
    }

    // Sprites, far to near.
    var list = [];
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      if (e.dead > 0.45) continue;
      var tex2 = e.hit > 0 ? SPR_BUG_HIT : SPR_BUG[hash2((now / 90) | 0, i) > 0.85 ? 1 : 0];
      list.push({ x: e.x, y: e.y, tex: tex2, scale: e.dead ? 1 - e.dead * 2 : 1, lift: Math.sin(e.bob) * 0.06, glow: e.dead ? 1 : 0 });
    }
    for (var p2 = 0; p2 < pickups.length; p2++) {
      if (!pickups[p2].taken) list.push({ x: pickups[p2].x, y: pickups[p2].y, tex: pickups[p2].kind === 'health' ? SPR_COFFEE : SPR_PATCH, scale: 0.55, lift: -0.22 + Math.sin(now / 300 + p2) * 0.03 });
    }
    for (var b = 0; b < bolts.length; b++) list.push({ x: bolts[b].x, y: bolts[b].y, tex: SPR_PACKET, scale: 0.3, lift: 0, glow: 1 });
    for (var s = 0; s < list.length; s++) list[s].d = (list[s].x - player.x) * (list[s].x - player.x) + (list[s].y - player.y) * (list[s].y - player.y);
    list.sort(function (a, b2) { return b2.d - a.d; });
    var inv = 1 / (plX * dirY - dirX * plY);
    for (var n = 0; n < list.length; n++) drawSprite(list[n], dirX, dirY, plX, plY, inv, horizon);

    // Sparks as single bright pixels.
    for (var q = 0; q < particles.length; q++) {
      var pt = particles[q];
      var sx = pt.x - player.x, sy = pt.y - player.y;
      var txp = inv * (dirY * sx - dirX * sy), typ = inv * (-plY * sx + plX * sy);
      if (typ <= 0.1) continue;
      var scr = ((W / 2) * (1 + txp / typ)) | 0;
      var scy = (horizon + (0.5 - pt.z) * H / typ) | 0;
      if (scr < 0 || scr >= W || scy < 0 || scy >= H || typ > zbuf[scr]) continue;
      buf[scy * W + scr] = px(pt.col[0], pt.col[1], pt.col[2]);
    }
  }

  function drawSprite(sp, dirX, dirY, plX, plY, inv, horizon) {
    var sx = sp.x - player.x, sy = sp.y - player.y;
    var tX = inv * (dirY * sx - dirX * sy);
    var tY = inv * (-plY * sx + plX * sy);
    if (tY <= 0.15) return;
    var screenX = ((W / 2) * (1 + tX / tY)) | 0;
    var size = Math.abs((H / tY) * sp.scale) | 0;
    if (size < 1) return;
    var vOff = ((0.5 - sp.scale / 2 + sp.lift) * H / tY) | 0;
    var top = horizon - (size >> 1) + vOff, left = screenX - (size >> 1);
    var x0 = left < 0 ? 0 : left, x1 = left + size > W ? W : left + size;
    var y0 = top < 0 ? 0 : top, y1 = top + size > H ? H : top + size;
    for (var x = x0; x < x1; x++) {
      if (tY >= zbuf[x]) continue;
      var tx = ((x - left) * TS / size) | 0;
      for (var y = y0; y < y1; y++) {
        var ty = ((y - top) * TS / size) | 0;
        var c = sp.tex[ty * TS + tx];
        if (!c) continue;
        buf[y * W + x] = sp.glow ? c : shade(c, tY);
      }
    }
  }

  /* ============================================================== render: weapon + HUD */

  function drawWeapon(now) {
    var cw = W, ch = H;
    var bob = mode === 'play' ? Math.sin(player.bob) : Math.sin(now / 400);
    var ox = cw * 0.5 + bob * cw * 0.012, oy = ch * 0.98 + Math.abs(bob) * ch * 0.015 + player.flash * ch * 0.03;
    var s = ch / 225;
    vctx.save();
    vctx.translate(ox, oy);
    vctx.scale(s, s);
    if (player.flash > 0) {
      var g = vctx.createRadialGradient(0, -78, 2, 0, -78, 38);
      g.addColorStop(0, 'rgba(255,255,255,' + player.flash + ')');
      g.addColorStop(0.4, 'rgba(' + ACC.join(',') + ',' + (player.flash * 0.8) + ')');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      vctx.fillStyle = g;
      vctx.fillRect(-40, -118, 80, 80);
    }
    vctx.fillStyle = '#1a1e2c';
    vctx.beginPath(); vctx.moveTo(-26, 0); vctx.lineTo(-14, -62); vctx.lineTo(14, -62); vctx.lineTo(26, 0); vctx.fill();
    vctx.fillStyle = '#2d3346';
    vctx.fillRect(-9, -76, 18, 16);
    vctx.fillStyle = 'rgb(' + ACC.join(',') + ')';
    vctx.fillRect(-2, -74, 4, 44);
    vctx.fillStyle = 'rgb(' + ACC2.join(',') + ')';
    vctx.fillRect(-18, -34, 4, 20); vctx.fillRect(14, -34, 4, 20);
    vctx.restore();
  }

  function neon(text, x, y, size, col, align, blur) {
    hctx.font = '700 ' + size + 'px ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace';
    hctx.textAlign = align || 'center';
    hctx.textBaseline = 'middle';
    hctx.shadowColor = 'rgb(' + col.join(',') + ')';
    hctx.shadowBlur = blur === undefined ? size * 0.5 : blur;
    hctx.fillStyle = 'rgb(' + mixc(col, [255, 255, 255], 0.55).map(Math.round).join(',') + ')';
    hctx.fillText(text, x, y);
    hctx.shadowBlur = 0;
  }

  function bar(x, y, w, h, frac, col, label) {
    hctx.fillStyle = 'rgba(0,0,0,.55)';
    hctx.fillRect(x, y, w, h);
    hctx.fillStyle = 'rgb(' + col.join(',') + ')';
    hctx.shadowColor = hctx.fillStyle; hctx.shadowBlur = h;
    hctx.fillRect(x + 2, y + 2, Math.max(0, (w - 4) * frac), h - 4);
    hctx.shadowBlur = 0;
    neon(label, x, y - h * 0.9, h * 0.9, col, 'left', 4);
  }

  function renderHud(now) {
    hctx.clearRect(0, 0, HW, HH);
    var u = HH / 100;   // 1% of the height
    if (player.hurt > 0) {
      var g = hctx.createRadialGradient(HW / 2, HH / 2, HH * 0.2, HW / 2, HH / 2, HH * 0.8);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(255,40,90,' + (player.hurt * 0.55) + ')');
      hctx.fillStyle = g;
      hctx.fillRect(0, 0, HW, HH);
    }
    if (mode === 'play' && !deadUntil) {
      // Crosshair.
      hctx.strokeStyle = 'rgba(' + ACC.join(',') + ',.85)';
      hctx.lineWidth = Math.max(1, u * 0.25);
      var c = u * 1.4;
      hctx.beginPath();
      hctx.moveTo(HW / 2 - c, HH / 2); hctx.lineTo(HW / 2 - c * 0.4, HH / 2);
      hctx.moveTo(HW / 2 + c * 0.4, HH / 2); hctx.lineTo(HW / 2 + c, HH / 2);
      hctx.moveTo(HW / 2, HH / 2 - c); hctx.lineTo(HW / 2, HH / 2 - c * 0.4);
      hctx.moveTo(HW / 2, HH / 2 + c * 0.4); hctx.lineTo(HW / 2, HH / 2 + c);
      hctx.stroke();
    }
    // Status.
    bar(u * 3, HH - u * 7, HW * 0.22, u * 2.6, Math.max(0, player.hp) / 100, [60, 255, 150], 'UPTIME ' + Math.ceil(Math.max(0, player.hp)) + '%');
    bar(HW - u * 3 - HW * 0.22, HH - u * 7, HW * 0.22, u * 2.6, player.energy / 100, ACC, 'PATCHES ' + Math.floor(player.energy));
    var left = 0;
    for (var i = 0; i < enemies.length; i++) if (!enemies[i].dead) left++;
    neon('FLOOR ' + level + '   ' + String(score).padStart(6, '0') + '   BUGS ' + left, HW / 2, u * 4, u * 2.6, ACC, 'center', u);

    if (message && now < messageUntil) {
      var a = Math.min(1, (messageUntil - now) / 500);
      hctx.globalAlpha = a;
      neon(message, HW / 2, HH * 0.3, u * 7, message === 'KERNEL PANIC' ? [255, 60, 70] : ACC2, 'center');
      if (messageSub) neon(messageSub, HW / 2, HH * 0.3 + u * 7, u * 2.4, message === 'KERNEL PANIC' ? [255, 60, 70] : [60, 255, 120], 'center', u);
      hctx.globalAlpha = 1;
    }

    if (mode !== 'play') {
      // Title card over the bot's game — on for 6 s of every 16, so passers-by see the action
      // too. The "press any key" line stays up throughout.
      var cyc = (now % 16000) / 16000;
      var cardA = cyc < 0.375 ? Math.min(1, cyc * 16) : Math.max(0, 1 - (cyc - 0.375) * 16);
      if (PLAYABLE && ((now / 600) | 0) % 2 === 0) neon('CLICK OR PRESS ANY KEY TO PLAY', HW / 2, HH * 0.86, u * 2.4, [255, 255, 255], 'center', u);
      neon('AUTOPILOT DEMO', u * 3, u * 4, u * 1.8, ACC2, 'left', 3);
      if (cardA <= 0) return;
      hctx.globalAlpha = cardA;
      hctx.fillStyle = 'rgba(2,3,10,.45)';
      hctx.fillRect(0, 0, HW, HH);
      var flick = 0.9 + 0.1 * Math.sin(now / 70) * (Math.sin(now / 1300) > 0.97 ? 1 : 0);
      hctx.globalAlpha = cardA * flick;
      neon(TITLE, HW / 2, HH * 0.42, Math.min(u * 13, HW / (TITLE.length * 0.72)), ACC, 'center', u * 3);
      hctx.globalAlpha = cardA;
      if (TAGLINE) neon(TAGLINE, HW / 2, HH * 0.53, Math.min(u * 2.6, HW / (TAGLINE.length * 0.7)), ACC2, 'center', u);
      if (PLAYABLE) neon('MOVE  ARROWS / WASD     TURN  ← → / Q E     PATCH  SPACE / CTRL / F     QUIT  ESC', HW / 2, HH * 0.64, u * 1.7, ACC, 'center', 2);
      hctx.globalAlpha = 1;
    }
  }

  /* ============================================================== trailer intro */

  // A cold open, like a film trailer: the ScreenTinker mark powers up, "presents", then the title
  // smashes in. Drawn entirely in code (no image files) so it is crisp at any resolution. It plays
  // on load and every time the game goes back to attract mode; any key or click skips straight in.
  var INTRO_MS = 12200;
  var BRAND = [59, 130, 246];   // ScreenTinker blue
  var introStart = 0;
  var noiseRng = rng(42);

  function ease(t) { return t < 0 ? 0 : t > 1 ? 1 : 1 - Math.pow(1 - t, 3); }
  function seg(t, a, b) { return t <= a ? 0 : t >= b ? 1 : (t - a) / (b - a); }

  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  // The ScreenTinker mark, from the app icon's geometry (a 512 box): screen, stand, play button.
  function drawMark(cx, cy, size, draw, play, alpha, jitter) {
    var k = size / 512;
    var ctx = hctx;
    ctx.save();
    ctx.translate(cx - 256 * k + (jitter || 0), cy - 235 * k);
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 16 * k;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgb(' + mixc(BRAND, [255, 255, 255], 0.25).map(Math.round).join(',') + ')';
    ctx.shadowColor = 'rgb(' + BRAND.join(',') + ')';
    ctx.shadowBlur = 28 * k * dpr;
    var w = 352 * k, h = 218 * k, r = 24 * k;
    var per = 2 * (w + h) - 8 * r + 2 * Math.PI * r;
    ctx.setLineDash([per * draw, per]);
    roundRectPath(ctx, 80 * k, 100 * k, w, h, r);
    ctx.stroke();
    ctx.setLineDash([]);
    if (draw > 0.85) {
      var st = seg(draw, 0.85, 1);
      ctx.beginPath();
      ctx.moveTo(256 * k, 318 * k); ctx.lineTo(256 * k, (318 + 52 * st) * k);
      ctx.moveTo((256 - 78 * st) * k, 340 * k); ctx.lineTo((256 + 78 * st) * k, 340 * k);
      ctx.stroke();
    }
    if (play > 0) {
      var pr = 40 * k * (0.6 + 0.4 * ease(play)) * (1 + 0.15 * Math.sin(play * Math.PI));
      ctx.fillStyle = 'rgb(' + BRAND.join(',') + ')';
      ctx.globalAlpha = alpha * Math.min(1, play * 2);
      ctx.beginPath(); ctx.arc(256 * k, 210 * k, pr, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.moveTo(256 * k - pr * 0.32, 210 * k - pr * 0.42);
      ctx.lineTo(256 * k + pr * 0.48, 210 * k);
      ctx.lineTo(256 * k - pr * 0.32, 210 * k + pr * 0.42);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  function glowText(text, x, y, size, col, alpha, spacing, weight) {
    hctx.save();
    hctx.globalAlpha = alpha;
    hctx.font = (weight || 700) + ' ' + size + 'px ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace';
    hctx.textAlign = 'center';
    hctx.textBaseline = 'middle';
    if ('letterSpacing' in hctx) hctx.letterSpacing = (spacing || 0) + 'px';
    hctx.shadowColor = 'rgb(' + col.join(',') + ')';
    hctx.shadowBlur = size * 0.45;
    hctx.fillStyle = 'rgb(' + mixc(col, [255, 255, 255], 0.5).map(Math.round).join(',') + ')';
    hctx.fillText(text, x, y);
    hctx.restore();
  }

  function drawIntro(now) {
    var t = (now - introStart) / 1000;
    var u = HH / 100;
    hctx.clearRect(0, 0, HW, HH);
    hctx.fillStyle = '#000';
    hctx.fillRect(0, 0, HW, HH);

    // Signal static before anything arrives, and under the glitch.
    var staticA = t < 0.9 ? 0.22 * (1 - t / 0.9) : (t > 3.9 && t < 4.4 ? 0.3 : 0);
    if (staticA > 0) {
      hctx.fillStyle = 'rgba(160,170,200,' + staticA + ')';
      for (var n = 0; n < 260; n++) hctx.fillRect(noiseRng() * HW, noiseRng() * HH, u * (0.2 + noiseRng()), u * 0.15);
    }

    var cx = HW / 2, cy = HH * 0.4, size = Math.min(HW * 0.42, HH * 0.62);
    if (t < 4.4) {
      // Power-up: outline draws on, flickering like a neon tube catching.
      var draw = ease(seg(t, 0.7, 2.0));
      var flick = t < 2.2 ? (hash2((t * 30) | 0, 7) > 0.28 ? 1 : 0.2) : 1;
      var play = seg(t, 1.9, 2.5);
      var out = seg(t, 3.9, 4.4);
      var jit = out > 0 ? (noiseRng() - 0.5) * u * 6 * out : 0;
      if (out > 0) {
        // Glitch-out: split channels.
        hctx.globalCompositeOperation = 'lighter';
        drawMark(cx - u * 1.2 * out, cy, size, 1, 1, 0.5 * (1 - out), jit);
        drawMark(cx + u * 1.2 * out, cy, size, 1, 1, 0.5 * (1 - out), -jit);
        hctx.globalCompositeOperation = 'source-over';
      } else {
        drawMark(cx, cy, size, draw, play, flick, 0);
      }
      // Scanline sweep when the mark completes.
      var sw = seg(t, 2.0, 2.6);
      if (sw > 0 && sw < 1) {
        var gy = HH * (0.1 + 0.7 * sw);
        var g = hctx.createLinearGradient(0, gy - u * 4, 0, gy + u * 4);
        g.addColorStop(0, 'rgba(59,130,246,0)'); g.addColorStop(0.5, 'rgba(180,210,255,.35)'); g.addColorStop(1, 'rgba(59,130,246,0)');
        hctx.fillStyle = g;
        hctx.fillRect(0, gy - u * 4, HW, u * 8);
      }
      // Wordmark types in, then "presents".
      var word = 'SCREENTINKER';
      var shown = Math.floor(seg(t, 2.3, 3.1) * word.length);
      var wa = 1 - out;
      if (shown > 0) glowText(word.slice(0, shown) + (shown < word.length && ((now / 90) | 0) % 2 ? '_' : ''), cx, cy + size * 0.5, Math.min(u * 8, HW / 12), BRAND, wa, u * 1.2, 800);
      var pa = seg(t, 3.1, 3.5) * wa;
      if (pa > 0) glowText('P R E S E N T S', cx, cy + size * 0.5 + u * 9, u * 2.8, [200, 210, 230], pa, u * 0.3, 600);
    }

    // Trailer cards: white on black, typed out, the way a trailer voice would say them.
    var cardsT = [[4.5, 6.0, '3036.', 'EVERY SERVER IS DOWN.'], [6.0, 7.5, 'ONE TECH', 'IS ON CALL.']];
    for (var ci = 0; ci < cardsT.length; ci++) {
      var ct = cardsT[ci];
      if (t < ct[0] || t > ct[1]) continue;
      var cp = seg(t, ct[0], ct[1]);
      var ca = Math.min(1, cp * 5) * Math.min(1, (1 - cp) * 5);
      var line2 = ct[3].slice(0, Math.ceil(seg(t, ct[0] + 0.25, ct[0] + 0.9) * ct[3].length));
      glowText(ct[2], cx, HH * 0.44, u * 7, [230, 236, 250], ca, u * 0.4, 800);
      glowText(line2, cx, HH * 0.56, u * 3.6, ci === 0 ? [255, 70, 80] : [60, 255, 120], ca, u * 0.3, 700);
    }

    // CRT power-on line, then the title smash.
    var line = seg(t, 7.5, 8.1);
    if (line > 0 && t < 8.4) {
      var lw = HW * ease(line);
      var lh = Math.max(2, u * 0.5 * (1 - seg(t, 8.1, 8.4)) + u * 3 * seg(t, 8.1, 8.4));
      hctx.fillStyle = 'rgba(235,245,255,' + (1 - seg(t, 8.2, 8.4)) + ')';
      hctx.shadowColor = 'rgb(' + ACC.join(',') + ')'; hctx.shadowBlur = u * 3;
      hctx.fillRect(cx - lw / 2, HH / 2 - lh / 2, lw, lh);
      hctx.shadowBlur = 0;
    }
    if (t >= 8.2) {
      var p = seg(t, 8.2, 8.75);
      var sc = 1 + 1.4 * Math.pow(1 - ease(p), 2);
      var split = u * 2.2 * (1 - ease(seg(t, 8.2, 9.2)));
      var fade = 1 - seg(t, 11.4, 12.2);
      var tsize = Math.min(u * 13, HW / (TITLE.length * 0.72));
      hctx.save();
      hctx.translate(cx, HH * 0.46);
      hctx.scale(sc, sc);
      hctx.globalCompositeOperation = 'lighter';
      glowText(TITLE, -split, 0, tsize, ACC2, 0.8 * p * fade, u * 0.2, 800);
      glowText(TITLE, split, 0, tsize, ACC, 0.8 * p * fade, u * 0.2, 800);
      hctx.globalCompositeOperation = 'source-over';
      glowText(TITLE, 0, 0, tsize, ACC, p * fade, u * 0.2, 800);
      hctx.restore();
      var flash = 1 - seg(t, 8.7, 9.3);
      if (p >= 1 && flash > 0) { hctx.fillStyle = 'rgba(255,255,255,' + (0.55 * flash) + ')'; hctx.fillRect(0, 0, HW, HH); }
      var sub = seg(t, 9.4, 10) * fade;
      if (TAGLINE) glowText(TAGLINE, cx, HH * 0.58, Math.min(u * 2.6, HW / (TAGLINE.length * 0.7)), ACC2, sub, u * 0.1, 600);
      var credit = seg(t, 10, 10.6) * fade;
      glowText('A  S C R E E N T I N K E R  G A M E', cx, HH * 0.84, u * 2.4, BRAND, credit, 0, 600);
    }
    // Letterbox bars: it is a trailer.
    hctx.fillStyle = '#000';
    hctx.fillRect(0, 0, HW, HH * 0.08); hctx.fillRect(0, HH * 0.92, HW, HH * 0.08);
  }

  function startIntro() {
    mode = 'intro';
    introStart = performance.now();
    releaseAll();
  }

  /* ============================================================== loop */

  newGame(3036);
  startIntro();
  var last = performance.now(), acc = 0;
  function frame(now) {
    var dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (mode === 'intro') {
      if (now - introStart > INTRO_MS) { mode = 'attract'; last = now; acc = 0; }
      else {
        vctx.fillStyle = '#000'; vctx.fillRect(0, 0, W, H);
        drawIntro(now);
        window.requestAnimationFrame(frame);
        return;
      }
    }
    if (mode === 'play' && now - lastInput > IDLE_MS) { newGame((Math.random() * 1e9) | 0); startIntro(); }
    acc += dt;
    while (acc >= 1 / 60) { update(1 / 60, now); acc -= 1 / 60; }
    renderWorld(now);
    vctx.putImageData(img, 0, 0);
    if (!deadUntil) drawWeapon(now);
    renderHud(now);
    window.requestAnimationFrame(frame);
  }
  window.requestAnimationFrame(frame);
});
