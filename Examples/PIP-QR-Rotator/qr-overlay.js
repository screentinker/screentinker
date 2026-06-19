// QR Rotator overlay — generates the QR code CLIENT-SIDE, with NO network calls and NO
// external libraries, so it satisfies the player's CSP (scriptSrc 'self') and works
// fully offline. Reads ?data (the QR payload) and ?label (caption) from the URL.
//
// The encoder is a compact byte-mode implementation of the QR Code spec (ISO/IEC 18004),
// based on Nayuki's "QR Code generator" reference algorithm (MIT License). Byte mode is
// used for everything, so any UTF-8 payload works (URLs, WIFI: strings, plain text).
//
// It also exports its internals via module.exports when require()'d in Node, so the
// offline test can verify the Reed-Solomon / encoder core without needing a decoder.
(function (global) {
  'use strict';

  // ---------- GF(256) arithmetic & Reed-Solomon (Nayuki) ----------
  function rsMul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }
  function rsDivisor(degree) {
    if (degree < 1 || degree > 255) throw new RangeError('degree out of range');
    var result = [];
    for (var i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);
    var root = 1;
    for (i = 0; i < degree; i++) {
      for (var j = 0; j < result.length; j++) {
        result[j] = rsMul(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = rsMul(root, 0x02);
    }
    return result;
  }
  function rsRemainder(data, divisor) {
    var result = divisor.map(function () { return 0; });
    for (var k = 0; k < data.length; k++) {
      var factor = data[k] ^ result.shift();
      result.push(0);
      for (var i = 0; i < divisor.length; i++) result[i] ^= rsMul(divisor[i], factor);
    }
    return result;
  }

  // ---------- spec tables: [ecl 0..3 = L,M,Q,H][version 1..40] ----------
  var ECC_CW = [
    [-1,7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
    [-1,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28],
    [-1,13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
    [-1,17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30]
  ];
  var ECC_BLOCKS = [
    [-1,1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25],
    [-1,1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49],
    [-1,1,1,2,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68],
    [-1,1,1,2,4,4,4,5,6,8,8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81]
  ];
  var ECL_FORMAT = [1, 0, 3, 2]; // 2-bit format value for L,M,Q,H
  var ECL_INDEX = { L: 0, M: 1, Q: 2, H: 3 };

  function numRawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }
  function numDataCodewords(ver, ecl) {
    return Math.floor(numRawDataModules(ver) / 8) - ECC_CW[ecl][ver] * ECC_BLOCKS[ecl][ver];
  }
  function alignmentPositions(ver) {
    if (ver === 1) return [];
    var numAlign = Math.floor(ver / 7) + 2;
    var step = (ver === 32) ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    var size = ver * 4 + 17;
    var result = [6];
    for (var pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }
  function getBit(x, i) { return ((x >>> i) & 1) !== 0; }

  // UTF-8 bytes for a string, dependency-free (TextEncoder when present).
  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(str));
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F)); }
      else { out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F)); }
    }
    return out;
  }

  // ---------- encode bytes -> { size, modules } ----------
  function encodeBytes(dataBytes, eclName) {
    var ecl = ECL_INDEX[eclName] != null ? ECL_INDEX[eclName] : 1;

    // smallest version that fits
    var ver;
    for (ver = 1; ; ver++) {
      if (ver > 40) throw new RangeError('Data too long to fit in any QR version');
      var ccbits = ver <= 9 ? 8 : 16;
      var usedBits = 4 + ccbits + dataBytes.length * 8;
      if (usedBits <= numDataCodewords(ver, ecl) * 8) break;
    }
    // boost ECC level for free if it still fits at this version
    [1, 2, 3].forEach(function (newEcl) {
      var ccbits = ver <= 9 ? 8 : 16;
      var usedBits = 4 + ccbits + dataBytes.length * 8;
      if (newEcl > ecl && usedBits <= numDataCodewords(ver, newEcl) * 8) ecl = newEcl;
    });

    // build bit buffer
    var bb = [];
    function appendBits(val, len) { for (var i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1); }
    appendBits(0x4, 4);                                  // byte mode indicator
    appendBits(dataBytes.length, ver <= 9 ? 8 : 16);     // char count
    for (var i = 0; i < dataBytes.length; i++) appendBits(dataBytes[i], 8);

    var capacityBits = numDataCodewords(ver, ecl) * 8;
    appendBits(0, Math.min(4, capacityBits - bb.length)); // terminator
    appendBits(0, (8 - bb.length % 8) % 8);               // byte align
    for (var pad = 0xEC; bb.length < capacityBits; pad ^= 0xEC ^ 0x11) appendBits(pad, 8);

    var dataCodewords = [];
    for (i = 0; i < bb.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | bb[i + j];
      dataCodewords.push(b);
    }

    var allCodewords = addEccAndInterleave(dataCodewords, ver, ecl);
    return buildMatrix(allCodewords, ver, ecl);
  }

  function addEccAndInterleave(data, ver, ecl) {
    var numBlocks = ECC_BLOCKS[ecl][ver];
    var blockEccLen = ECC_CW[ecl][ver];
    var rawCodewords = Math.floor(numRawDataModules(ver) / 8);
    var numShortBlocks = numBlocks - rawCodewords % numBlocks;
    var shortBlockLen = Math.floor(rawCodewords / numBlocks);
    var blocks = [];
    var divisor = rsDivisor(blockEccLen);
    for (var i = 0, k = 0; i < numBlocks; i++) {
      var dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
      k += dat.length;
      var ecc = rsRemainder(dat, divisor);
      if (i < numShortBlocks) dat = dat.concat([0]);
      blocks.push(dat.concat(ecc));
    }
    var result = [];
    for (i = 0; i < blocks[0].length; i++) {
      for (var j = 0; j < blocks.length; j++) {
        if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(blocks[j][i]);
      }
    }
    return result;
  }

  function buildMatrix(allCodewords, ver, ecl) {
    var size = ver * 4 + 17;
    var modules = [], isFunc = [];
    for (var i = 0; i < size; i++) { modules.push(new Array(size).fill(false)); isFunc.push(new Array(size).fill(false)); }
    function set(x, y, dark) { if (x >= 0 && x < size && y >= 0 && y < size) { modules[y][x] = dark; isFunc[y][x] = true; } }

    // timing patterns
    for (i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    // finder patterns + separators
    [[3, 3], [size - 4, 3], [3, size - 4]].forEach(function (c) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy));
        set(c[0] + dx, c[1] + dy, dist !== 2 && dist !== 4);
      }
    });
    // alignment patterns
    var ap = alignmentPositions(ver), n = ap.length;
    for (i = 0; i < n; i++) for (var j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) {
        set(ap[j] + dx, ap[i] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }

    function drawFormat(mask) {
      var data = (ECL_FORMAT[ecl] << 3) | mask;
      var rem = data;
      for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var bits = ((data << 10) | rem) ^ 0x5412;
      for (i = 0; i <= 5; i++) set(8, i, getBit(bits, i));
      set(8, 7, getBit(bits, 6)); set(8, 8, getBit(bits, 7)); set(7, 8, getBit(bits, 8));
      for (i = 9; i < 15; i++) set(14 - i, 8, getBit(bits, i));
      for (i = 0; i < 8; i++) set(size - 1 - i, 8, getBit(bits, i));
      for (i = 8; i < 15; i++) set(8, size - 15 + i, getBit(bits, i));
      set(8, size - 8, true); // always-dark module
    }
    function drawVersion() {
      if (ver < 7) return;
      var rem = ver;
      for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      var bits = (ver << 12) | rem;
      for (i = 0; i < 18; i++) {
        var bit = getBit(bits, i);
        var a = size - 11 + i % 3, b = Math.floor(i / 3);
        set(a, b, bit); set(b, a, bit);
      }
    }
    drawFormat(0); // reserve the format areas as function modules
    drawVersion();

    // draw data + ecc codewords (zigzag, bottom-right -> up)
    var bitIdx = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var c2 = 0; c2 < 2; c2++) {
          var x = right - c2;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? size - 1 - vert : vert;
          if (!isFunc[y][x] && bitIdx < allCodewords.length * 8) {
            modules[y][x] = getBit(allCodewords[bitIdx >>> 3], 7 - (bitIdx & 7));
            bitIdx++;
          }
        }
      }
    }

    // choose the mask with the lowest penalty, then apply it for real
    function applyMask(mask) {
      for (var y = 0; y < size; y++) for (var x = 0; x < size; x++) {
        if (isFunc[y][x]) continue;
        var invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = (x * y) % 2 + (x * y) % 3 === 0; break;
          case 6: invert = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
          case 7: invert = ((x + y) % 2 + (x * y) % 3) % 2 === 0; break;
        }
        if (invert) modules[y][x] = !modules[y][x];
      }
    }

    var best = -1, minPenalty = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      drawFormat(mask); applyMask(mask);
      var p = penalty(modules, size);
      if (p < minPenalty) { minPenalty = p; best = mask; }
      applyMask(mask); // undo (XOR is its own inverse)
    }
    drawFormat(best); applyMask(best);

    return { size: size, modules: modules, version: ver, ecl: ecl };
  }

  // ---------- mask penalty (Nayuki getPenaltyScore) ----------
  function penalty(modules, size) {
    var N1 = 3, N2 = 3, N3 = 40, N4 = 10, result = 0;

    function countPatterns(rh) {
      var nn = rh[1];
      var core = nn > 0 && rh[2] === nn && rh[3] === nn * 3 && rh[4] === nn && rh[5] === nn;
      return (core && rh[0] >= nn * 4 && rh[6] >= nn ? 1 : 0) + (core && rh[6] >= nn * 4 && rh[0] >= nn ? 1 : 0);
    }
    function addHistory(run, rh) { if (rh[0] === 0) run += size; rh.pop(); rh.unshift(run); }
    function terminate(color, run, rh) {
      if (color) { addHistory(run, rh); run = 0; }
      run += size; addHistory(run, rh);
      return countPatterns(rh);
    }

    // rows
    for (var y = 0; y < size; y++) {
      var color = false, run = 0, rh = [0, 0, 0, 0, 0, 0, 0];
      for (var x = 0; x < size; x++) {
        if (modules[y][x] === color) { run++; if (run === 5) result += N1; else if (run > 5) result++; }
        else { addHistory(run, rh); if (!color) result += countPatterns(rh) * N3; color = modules[y][x]; run = 1; }
      }
      result += terminate(color, run, rh) * N3;
    }
    // columns
    for (var x2 = 0; x2 < size; x2++) {
      var color2 = false, run2 = 0, rh2 = [0, 0, 0, 0, 0, 0, 0];
      for (var y2 = 0; y2 < size; y2++) {
        if (modules[y2][x2] === color2) { run2++; if (run2 === 5) result += N1; else if (run2 > 5) result++; }
        else { addHistory(run2, rh2); if (!color2) result += countPatterns(rh2) * N3; color2 = modules[y2][x2]; run2 = 1; }
      }
      result += terminate(color2, run2, rh2) * N3;
    }
    // 2x2 blocks
    for (var yy = 0; yy < size - 1; yy++) for (var xx = 0; xx < size - 1; xx++) {
      var c = modules[yy][xx];
      if (c === modules[yy][xx + 1] && c === modules[yy + 1][xx] && c === modules[yy + 1][xx + 1]) result += N2;
    }
    // dark proportion
    var dark = 0;
    for (var a = 0; a < size; a++) for (var b = 0; b < size; b++) if (modules[a][b]) dark++;
    var total = size * size;
    var k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * N4;
    return result;
  }

  var QR = { rsMul: rsMul, rsDivisor: rsDivisor, rsRemainder: rsRemainder, encodeBytes: encodeBytes, utf8Bytes: utf8Bytes, numDataCodewords: numDataCodewords };
  if (typeof module !== 'undefined' && module.exports) module.exports = QR;
  else global.QR = QR;

  // ---------- browser rendering ----------
  if (typeof document === 'undefined') return;

  function draw() {
    var q = new URLSearchParams(location.search);
    var data = q.get('data') || '';
    var label = (q.get('label') || '').trim();

    var labelEl = document.getElementById('label');
    if (labelEl) labelEl.textContent = label;

    var canvas = document.getElementById('qr');
    var placeholder = document.getElementById('placeholder');

    if (!data) { show(placeholder); hide(canvas); return; }
    try {
      var qr = encodeBytes(utf8Bytes(data), 'M');
      paint(canvas, qr);
      show(canvas); hide(placeholder);
    } catch (e) {
      if (placeholder) placeholder.textContent = 'QR error: ' + (e && e.message ? e.message : e);
      show(placeholder); hide(canvas);
    }
  }
  function show(el) { if (el) el.style.display = ''; }
  function hide(el) { if (el) el.style.display = 'none'; }

  function paint(canvas, qr) {
    if (!canvas) return;
    var quiet = 4;
    var dim = qr.size + quiet * 2;
    var scale = Math.max(2, Math.floor(560 / dim)); // crisp internal resolution
    canvas.width = dim * scale;
    canvas.height = dim * scale;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000000';
    for (var y = 0; y < qr.size; y++) for (var x = 0; x < qr.size; x++) {
      if (qr.modules[y][x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', draw);
  else draw();
})(typeof globalThis !== 'undefined' ? globalThis : this);
