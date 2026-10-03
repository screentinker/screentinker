'use strict';

/*
 * The user-facing release notes, read from release-notes.json at the repo root.
 *
 * ⚠️ WHY A SEPARATE FILE FROM CHANGELOG.md, which already exists and already has a section per
 * version. Because the changelog is written for whoever touches the code next: it carries issue
 * numbers, SQL, and arguments about the event loop. Rendering that at an operator who wanted to
 * know whether anything they do has changed would be worse than showing them nothing at all. Two
 * audiences, two files; the shared discipline is that a release writes both.
 *
 * ⚠️ READ ONCE, AT LOAD. Same reasoning as version.js next door: the notes only change across a
 * deploy, and a deploy restarts the process. A missing or malformed file yields an empty list
 * rather than throwing — an install must never fail to boot over a cosmetic panel.
 */

const fs = require('fs');
const path = require('path');
const VERSION = require('../version');

/** @type {Array<{version: string, date: string, notes: string[]}>} */
let releases = [];
try {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'release-notes.json'), 'utf8'));
  if (Array.isArray(raw.releases)) {
    releases = raw.releases.filter(
      (r) => r && typeof r.version === 'string' && Array.isArray(r.notes) && r.notes.length > 0
    );
  }
} catch (e) {
  console.warn(`[release-notes] not loaded (${e && e.message}) — the What's new panel will stay hidden`);
}

/** The entry for a version, or null when it has none (a dev build, a fork, a forgotten release). */
function forVersion(version = VERSION) {
  return releases.find((r) => r.version === version) || null;
}

/**
 * What the API hands the client: the running version, its notes if any, and the history for the
 * full list under Settings. One request, because the panel needs all three and a dashboard should
 * not pay for three round trips to decide whether to show a box.
 */
function payload() {
  return {
    version: VERSION,
    current: forVersion(),
    history: releases,
  };
}

module.exports = { releases, forVersion, payload };
