'use strict';

/*
 * Embedded firmware on this server (#2): where a preset's binary lives, its digest and version, and
 * whether a given panel may be offered it. Shared by routes/embedded.js (the download routes and the
 * `update` offer on a poll) and lib/device-command.js (refusing an `update` at the door that no poll
 * could ever deliver).
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const config = require('../config');

const SHA256_HEX = /^[0-9a-f]{64}$/i;

/*
 * The preset a device's firmware is filed under, or '' when it cannot be told.
 *
 * ⚠️ NO DEFAULT. An unknown or empty profile is not Sticky. Defaulting here pointed a non-Sticky
 * panel at Sticky firmware. Callers treat '' as "no update for this device".
 */
function normalizePresetName(profileOrPreset) {
  if (!profileOrPreset) return '';
  let str = profileOrPreset;
  if (typeof str === 'object') {
    str = str.preset || '';
  } else if (typeof str === 'string' && str.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(str);
      str = parsed.preset || '';
    } catch (_) {}
  }
  return String(str || '').replace(/-/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
}

const _firmwareHashCache = new Map(); // filePath -> { mtimeMs, size, sha256 }

function getFirmwareInfo(preset) {
  const safePreset = normalizePresetName(preset);
  if (!safePreset) return null;

  const candidateDirs = [];
  if (process.env.ST_FIRMWARE_DIR) {
    candidateDirs.push(path.join(process.env.ST_FIRMWARE_DIR, safePreset));
  } else {
    if (config.embeddedFirmwareDir) {
      candidateDirs.push(path.join(config.embeddedFirmwareDir, safePreset));
    }
    candidateDirs.push(path.join(__dirname, '../data/firmware', safePreset));
    candidateDirs.push(path.join(__dirname, '../firmware', safePreset));
  }

  for (const base of candidateDirs) {
    const binPaths = [
      path.join(base, 'firmware.bin'),
      path.join(base, 'latest.bin'),
      path.join(base, `${safePreset}.bin`),
      path.join(base, `${safePreset}-firmware.bin`),
    ];

    for (const binPath of binPaths) {
      if (fs.existsSync(binPath)) {
        try {
          const stat = fs.statSync(binPath);
          let sha256 = null;
          const cached = _firmwareHashCache.get(binPath);
          if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
            sha256 = cached.sha256;
          } else {
            const fd = fs.openSync(binPath, 'r');
            try {
              const hash = crypto.createHash('sha256');
              const chunk = Buffer.alloc(65536);
              let bytesRead = 0;
              while ((bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
                hash.update(chunk.subarray(0, bytesRead));
              }
              sha256 = hash.digest('hex');
            } finally {
              fs.closeSync(fd);
            }
            _firmwareHashCache.set(binPath, { mtimeMs: stat.mtimeMs, size: stat.size, sha256 });
          }

          let version = null;
          let declaredSha256 = null;
          const vJsonPath = path.join(path.dirname(binPath), 'version.json');
          const vTxtPath = path.join(path.dirname(binPath), 'version.txt');
          if (fs.existsSync(vJsonPath)) {
            try {
              const parsed = JSON.parse(fs.readFileSync(vJsonPath, 'utf8'));
              if (parsed.version) version = String(parsed.version);
              if (typeof parsed.sha256 === 'string' && SHA256_HEX.test(parsed.sha256)) declaredSha256 = parsed.sha256;
            } catch (_) {}
          } else if (fs.existsSync(vTxtPath)) {
            try {
              const vStr = fs.readFileSync(vTxtPath, 'utf8').trim();
              if (vStr) version = vStr;
            } catch (_) {}
          }

          return {
            preset: safePreset,
            version,
            size: stat.size,
            sha256,
            declaredSha256,
            filePath: binPath,
            download_url: `/api/embedded/firmware/${safePreset}/latest.bin`
          };
        } catch (_) {}
      }
    }
  }

  return null;
}

/*
 * ⚠️ THE BOARD A PANEL REPORTS ABOUT ITSELF, as a preset name ('' when it reports none).
 *
 * screentinker_mcu v1.3.0 sends no board header on its polls: its only statement of what it is, is
 * the compile-time DEVICE_SCREEN_PROFILE it registers with (POST /pair/register screen_profile),
 * which pairing records in devices.reported_board. A later firmware can state it on every poll with
 * `X-ST-Preset: seeed-reterminal-e1004` (or the same value in X-ST-Device-Model). screen_profile is
 * an operator SETTING and can be edited; this is what the hardware said.
 */
const BOARD_SHAPE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
function boardFrom(value) {
  if (typeof value !== 'string') return '';
  const v = value.trim().toLowerCase();
  return BOARD_SHAPE.test(v) ? normalizePresetName(v) : '';
}
function boardFromRequest(req) {
  const hd = (req && req.headers) || {};
  return boardFrom(hd['x-st-preset']) || boardFrom(hd['x-st-device-model']);
}

/*
 * May this embedded panel be offered a firmware update, and which? Checked when an operator queues
 * `update` (so a non-Seeed panel is refused with a reason instead of the command silently vanishing
 * on its next poll) and again when the offer is built.
 *
 * @returns {{ok: true, firmware: {preset, version, board_verified}} | {ok: false, code, error}}
 */
function checkOffer(device, reportedBoard) {
  const preset = normalizePresetName(device && device.screen_profile);
  const fw = preset ? getFirmwareInfo(preset) : null;
  if (!fw || !fw.sha256 || !fw.version) {
    return {
      ok: false,
      code: 'EMBEDDED_NO_FIRMWARE',
      error: preset
        ? `This server has no firmware for the screen profile '${preset}'. Over-the-air updates are available for Seeed reTerminal panels only.`
        : 'This panel\'s screen profile names no firmware preset, so it cannot be updated over the air.',
    };
  }
  const board = reportedBoard !== undefined ? reportedBoard : boardFrom(device && device.reported_board);
  if (board && board.toLowerCase() !== preset.toLowerCase()) {
    return {
      ok: false,
      code: 'EMBEDDED_BOARD_MISMATCH',
      error: `This panel reports it is a '${board}', but its screen profile is '${preset}'. Fix the screen profile before updating its firmware.`,
    };
  }
  return { ok: true, firmware: { preset, version: fw.version, board_verified: Boolean(board) } };
}

module.exports = { SHA256_HEX, normalizePresetName, getFirmwareInfo, boardFrom, boardFromRequest, checkOffer };
