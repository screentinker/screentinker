#!/usr/bin/env node
'use strict';

/*
 * Render-thread rule check. Some BrightScript components may only be created on the main thread or
 * in a Task. Created on the render thread (any SceneGraph component that is not a Task, and every
 * script it includes), CreateObject returns invalid and the next call on it crashes the app into the
 * debugger. On a TV that is a black screen.
 *
 * ⚠️ The simulator does NOT enforce this. ST_UrlEncode used roUrlTransfer.Escape(), passed every
 * simulator test, and crashed on the first real Roku (Streaming Stick 4K, OS 15.3.4) as soon as a
 * video item built its URL. So the rule is checked here, statically, instead.
 *
 * Usage: node roku/tests/check-threads.js   (exit 1 on a violation)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Components the Roku docs list as unavailable on the render thread.
const TASK_ONLY = ['roUrlTransfer', 'roStreamSocket', 'roDataGramSocket', 'roSocketAddress', 'roChannelStore'];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

// Code only: drop ' and REM comments, ignoring quotes inside string literals.
function stripComment(line) {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inStr = !inStr;
    else if (!inStr && c === "'") return line.slice(0, i);
    else if (!inStr && /^rem(\s|$)/i.test(line.slice(i)) && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function resolveScript(uri, xmlFile) {
  if (uri.startsWith('pkg:/')) return path.join(ROOT, uri.slice(5));
  return path.join(path.dirname(xmlFile), uri);
}

function check() {
  const violations = [];
  const xmls = walk(path.join(ROOT, 'components')).filter((f) => f.endsWith('.xml'));
  for (const xml of xmls) {
    const src = fs.readFileSync(xml, 'utf8');
    const comp = src.match(/<component\s+name="([^"]+)"\s+extends="([^"]+)"/);
    if (!comp || comp[2] === 'Task') continue;
    for (const m of src.matchAll(/<script[^>]*uri="([^"]+)"/g)) {
      const file = resolveScript(m[1], xml);
      if (!fs.existsSync(file)) continue;
      fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
        for (const c of stripComment(line).matchAll(/CreateObject\(\s*"(ro\w+)"/gi)) {
          const name = TASK_ONLY.find((t) => t.toLowerCase() === c[1].toLowerCase());
          if (name) violations.push(`${path.relative(ROOT, file)}:${i + 1} creates ${name}, but ${comp[1]} (extends ${comp[2]}) runs it on the render thread`);
        }
      });
    }
  }
  return violations;
}

if (require.main === module) {
  const v = check();
  if (v.length) {
    console.error('Render-thread rule violations (these crash on a real Roku, not in the simulator):');
    for (const l of v) console.error('  ' + l);
    process.exit(1);
  }
  console.log('check-threads: no task-only components created on the render thread');
}

module.exports = { check, stripComment, TASK_ONLY };
