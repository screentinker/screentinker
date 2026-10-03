'use strict';

/*
 * THIS process's host health, O(1), for the NOC strip: CPU of this process since the previous
 * sample, resident memory, and free space on the filesystem that holds DATA_DIR. Nothing here
 * reads a table, opens a socket or touches another node — it is the box reporting on itself.
 *
 * ⚠️ NULL WHEN A PROBE CANNOT ANSWER, never 0. A disk that reads "0 B free" because statfs threw
 * would send an operator running for a bigger drive; "—" sends them to the log. The first CPU
 * sample is null too: a percentage needs two readings, and inventing one from process start would
 * average away the spike the page exists to show.
 */

const fs = require('node:fs');
const config = require('../config');

let lastCpu = null; // { usage: process.cpuUsage(), at: hrtime ns }

function cpuPct() {
  const usage = process.cpuUsage();
  const at = process.hrtime.bigint();
  const prev = lastCpu;
  lastCpu = { usage, at };
  if (!prev) return null;
  const elapsedUs = Number(at - prev.at) / 1000;
  if (!(elapsedUs > 0)) return null;
  const spentUs = (usage.user - prev.usage.user) + (usage.system - prev.usage.system);
  // Percent of ONE core: a busy server on a 4-core box can legitimately read 250.
  return Math.round((spentUs / elapsedUs) * 1000) / 10;
}

function diskOf(dir) {
  try {
    if (typeof fs.statfsSync !== 'function') return { free: null, total: null };
    const s = fs.statfsSync(dir);
    const free = Number(s.bavail) * Number(s.bsize);
    const total = Number(s.blocks) * Number(s.bsize);
    return { free: Number.isFinite(free) && total > 0 ? free : null, total: Number.isFinite(total) && total > 0 ? total : null };
  } catch (e) { return { free: null, total: null }; }
}

/** One sample. Every field is a number or null. */
function sample({ dir = config.dataDir } = {}) {
  let cpu = null, rss = null;
  try { cpu = cpuPct(); } catch (e) { cpu = null; }
  try { rss = process.memoryUsage.rss(); if (!(rss > 0)) rss = null; } catch (e) { rss = null; }
  const disk = diskOf(dir);
  return { cpu_pct: cpu, rss_bytes: rss, disk_free_bytes: disk.free, disk_total_bytes: disk.total };
}

/** Test hook: forget the previous CPU reading. */
function _reset() { lastCpu = null; }

module.exports = { sample, _reset };
