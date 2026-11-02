'use strict';

/* Verify the built SSSP3 package before it is served. Every panel trusts the
 * manifest's <size> (BYTES for Orsay SSSP3, unlike the Tizen wgt manifest whose
 * unit is kilobytes) and compares <ver> numerically, so the artifact and the
 * manifest that advertises it must agree or panels refuse silent installs. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = __dirname;
const release = JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8'));
const zip = path.join(root, 'dist', 'ScreenTinkerSSSP3.zip');
const manifest = path.join(root, 'dist', 'sssp_config.xml');
function fail(message) { throw new Error('SSSP3 package verification failed: ' + message); }
function readConfig(file) { return execFileSync('unzip', ['-p', file, 'config.xml'], { encoding: 'utf8' }); }
function readEntry(file, name) { return execFileSync('unzip', ['-p', file, name], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }); }
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
