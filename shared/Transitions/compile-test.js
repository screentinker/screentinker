'use strict';
// Shader compile test — compiles + links all 14 transition shaders in a REAL WebGL context
// (Chrome via puppeteer-core, ANGLE/SwiftShader) so we catch GLSL ES errors the way a panel would,
// not a lenient CPU validator. Also enforces manifest<->file consistency and that the manifest's
// params never drift from what params.js parses out of the shader source (the single source of truth).
//
// Run:  npm run test:shaders   (from repo root)
// CI :  .github/workflows/shaders.yml
//
// puppeteer-core is Apache-2.0 and uses the system Chrome — no bundled binary is downloaded.

const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const { PREAMBLE, EPILOGUE, VERTEX } = require('./params.js');
const genManifest = require('./generate-manifest.js');

// Resolve puppeteer-core: prefer a real install, else the repo-relative copy in video/ (portable).
function loadPuppeteer() {
  const tries = ['puppeteer-core', path.resolve(DIR, '../../video/node_modules/puppeteer-core')];
  for (const t of tries) { try { return require(t); } catch (e) { /* next */ } }
  console.error('FATAL: puppeteer-core not found. `npm install` at repo root, or set it up in video/.');
  process.exit(2);
}
function chromePath() {
  const env = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_BIN;
  const cands = [env, '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/snap/bin/chromium'].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return null; // let puppeteer try its own resolution
}

function loadShaders() {
  const glslFiles = fs.readdirSync(DIR).filter((f) => f.endsWith('.glsl')).sort();
  const problems = [];

  // The manifest is GENERATED from the shaders (generate-manifest.js). Assert the committed bytes
  // equal a fresh regeneration — a mismatch means someone edited a shader without running
  // `npm run build:manifest`, so the manifest (and dashboard) would be stale. Staleness = test failure.
  const committed = fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8');
  const regenerated = genManifest.serialize(genManifest.build());
  if (committed !== regenerated) {
    problems.push('manifest.json is stale — run `npm run build:manifest` (shaders changed since it was generated)');
  }

  // Compile every shader on disk (the manifest is derived, so disk is the authoritative list).
  const shaders = glslFiles.map((file) => ({ id: file.replace(/\.glsl$/, ''), file, src: fs.readFileSync(path.join(DIR, file), 'utf8') }));
  return { shaders, problems, glslCount: glslFiles.length };
}

// Runs in the browser: compile+link each shader, return [{id, ok, error}]
function browserCompile(jobs) {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
  if (!gl) return [{ id: '(context)', ok: false, error: 'no WebGL context available' }];
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { const log = gl.getShaderInfoLog(s); gl.deleteShader(s); return { err: log }; }
    return { shader: s };
  };
  const out = [];
  const vs = compile(gl.VERTEX_SHADER, jobs.VERTEX);
  for (const j of jobs.shaders) {
    if (vs.err) { out.push({ id: j.id, ok: false, error: 'vertex: ' + vs.err }); continue; }
    const fs_ = compile(gl.FRAGMENT_SHADER, jobs.PREAMBLE + '\n' + j.src + '\n' + jobs.EPILOGUE);
    if (fs_.err) { out.push({ id: j.id, ok: false, error: 'fragment: ' + fs_.err }); continue; }
    const prog = gl.createProgram();
    gl.attachShader(prog, vs.shader); gl.attachShader(prog, fs_.shader);
    gl.bindAttribLocation(prog, 0, 'aPos'); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { out.push({ id: j.id, ok: false, error: 'link: ' + gl.getProgramInfoLog(prog) }); }
    else out.push({ id: j.id, ok: true });
    gl.deleteShader(fs_.shader); gl.deleteProgram(prog);
  }
  return out;
}

(async () => {
  const { shaders, problems, glslCount } = loadShaders();
  console.log(`Found ${glslCount} .glsl files, ${shaders.length} in manifest.\n`);

  const puppeteer = loadPuppeteer();
  const exe = chromePath();
  const browser = await puppeteer.launch({
    executablePath: exe || undefined,
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
  });
  let results;
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('pageerror:', e.message));
    await page.goto('about:blank');
    results = await page.evaluate(browserCompile, { shaders, VERTEX, PREAMBLE, EPILOGUE });
  } finally {
    await browser.close();
  }

  let failed = 0;
  for (const r of results) {
    if (r.ok) { console.log(`  PASS  ${r.id}`); }
    else { failed++; console.log(`  FAIL  ${r.id}\n        ${String(r.error).trim().replace(/\n/g, '\n        ')}`); }
  }
  if (problems.length) {
    console.log('\nManifest/consistency problems:');
    for (const p of problems) console.log('  ✗ ' + p);
  } else {
    console.log('\nmanifest.json is up to date with the shader sources (byte-identical to a fresh build).');
  }

  const compiledOk = results.filter((r) => r.ok).length;
  console.log(`\n${compiledOk}/${results.length} shaders compiled+linked; ${problems.length} consistency problems.`);
  process.exit(failed === 0 && problems.length === 0 ? 0 : 1);
})().catch((e) => { console.error('runner error:', e); process.exit(2); });
