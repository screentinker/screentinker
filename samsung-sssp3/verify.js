'use strict';

/* Verify the built SSSP3 package before it is served. Every panel trusts the
 * manifest's <size> (BYTES for Orsay SSSP3, unlike the Tizen wgt manifest whose
 * unit is kilobytes) and compares <ver> numerically, so the artifact and the
 * manifest that advertises it must agree or panels refuse silent installs. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = __dirname;
const release = JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8'));
const zip = path.join(root, 'dist', 'ScreenTinkerSSSP3.zip');
const manifest = path.join(root, 'dist', 'sssp_config.xml');
function fail(message) { throw new Error('SSSP3 package verification failed: ' + message); }
/* The build already creates a regular ZIP with Node/Python standard libraries.
 * Reading its central directory here avoids relying on an ambient `unzip` binary
 * (or a sandbox policy that permits spawning one) for the release gate. */
function readEntry(file, name) {
  const archive = fs.readFileSync(file);
  const eocd = 0x06054b50, central = 0x02014b50, local = 0x04034b50;
  let end = -1;
  for (let i = archive.length - 22; i >= Math.max(0, archive.length - 65557); i--) {
    if (archive.readUInt32LE(i) === eocd) { end = i; break; }
  }
  if (end < 0) fail('ZIP end-of-central-directory is missing');
  const entries = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  for (let i = 0; i < entries; i++) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== central) fail('ZIP central directory is corrupt');
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const entryName = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;
    if (entryName !== name) continue;
    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== local) fail('ZIP local entry is corrupt: ' + name);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(start, start + compressedSize);
    if (compressed.length !== compressedSize) fail('ZIP entry is truncated: ' + name);
    let bytes;
    if (method === 0) bytes = compressed;
    else if (method === 8) bytes = zlib.inflateRawSync(compressed);
    else fail('ZIP entry uses unsupported compression method ' + method + ': ' + name);
    if (bytes.length !== uncompressedSize) fail('ZIP entry size is invalid: ' + name);
    return bytes.toString('utf8');
  }
  fail('ZIP entry is missing: ' + name);
}
function readConfig(file) { return readEntry(file, 'config.xml'); }
function value(xml, tag) { const m = new RegExp('<' + tag + '(?:\\s[^>]*)?>([^<]+)</' + tag + '>').exec(xml); return m && m[1]; }

if (!Number.isSafeInteger(release.version) || release.version < 1) fail('release.json version is invalid');
if (!fs.existsSync(zip) || !fs.existsSync(manifest)) fail('package ZIP or manifest is missing (build it first: ./build-sssp3.sh)');
const size = fs.statSync(zip).size;
const configVersion = value(readConfig(zip), 'ver');
const manifestXml = fs.readFileSync(manifest, 'utf8');
if (Number(configVersion) !== release.version) fail('ZIP config version ' + configVersion + ' != release version ' + release.version);
if (Number(value(manifestXml, 'ver')) !== release.version) fail('manifest version differs from release version');
if (Number(value(manifestXml, 'size')) !== size) fail('manifest size differs from ZIP size (bytes)');
if (value(manifestXml, 'widgetname') !== release.package) fail('manifest package differs from release package');
const zipConfig = readConfig(zip);
if (value(zipConfig, 'network') !== 'n') fail('package network permission must remain n');
if (value(zipConfig, 'autoUpdate') !== 'n') fail('package autoUpdate must be n so URL Launcher starts the installed ZIP when sssp_config is unreachable');
const expectedCapabilities = [
  'playback.video', 'playback.image', 'playback.widget', 'playback.zones', 'playback.pip',
  'playback.sssp3_fit_renditions',
  'remote.screenshot', 'system.restart_player', 'sync.clock', 'clock.tz_table', 'offline.schedule_plan',
];
const renderer = readEntry(zip, 'renderer-main.js');
const capabilityMatch = /function declaredCapabilities\(\)\s*\{\s*return (\[[^\]]*\])\.slice\(\);\s*\}/.exec(renderer);
if (!capabilityMatch) fail('renderer capability contract is missing or dynamic');
let actualCapabilities;
try { actualCapabilities = JSON.parse(capabilityMatch[1]); } catch { fail('renderer capability contract is not valid JSON'); }
if (JSON.stringify(actualCapabilities) !== JSON.stringify(expectedCapabilities)) {
  fail('renderer capability contract differs from the qualified SSSP3 set');
}
if (!/data\.platform = ['"]Samsung SSSP3\/Orsay['"]/.test(renderer)) fail('renderer does not report the SSSP3 platform');
const hash = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
console.log('Verified ScreenTinkerSSSP3 v' + release.version + ': bytes=' + size + ' sha256=' + hash);
