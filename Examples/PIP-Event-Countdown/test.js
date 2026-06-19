'use strict';

// Offline unit test for the pure countdown helpers. No network, no player.
const { secondsToTarget, breakdown, durationForTarget, PIP_DUR_MAX } = require('./countdown');

let ok = true;
function check(name, cond) {
  console.log(`${cond ? '•' : '✗'} ${name}`);
  if (!cond) ok = false;
}

// Fixed reference instant so the test is deterministic.
const now = Date.parse('2026-06-18T12:00:00-05:00');

// 1 day, 2 hours, 3 minutes, 4 seconds in the future.
const futureSecs = 1 * 86400 + 2 * 3600 + 3 * 60 + 4; // 93784
const future = now + futureSecs * 1000;

const s1 = secondsToTarget(future, now);
check(`secondsToTarget future = ${futureSecs}`, s1 === futureSecs);

const b1 = breakdown(s1);
check('breakdown days/hours/min/sec', b1.days === 1 && b1.hours === 2 && b1.minutes === 3 && b1.seconds === 4);

// Round UP: 1.4s out still counts as 2 whole seconds remaining.
check('secondsToTarget rounds up partial second', secondsToTarget(now + 1400, now) === 2);

// Past target -> non-positive.
check('past target <= 0', secondsToTarget(now - 5000, now) <= 0);

// Exactly now -> 0.
check('exactly now == 0', secondsToTarget(now, now) === 0);

// breakdown clamps negatives to zero.
const bz = breakdown(-50);
check('breakdown clamps negative to 0', bz.days === 0 && bz.hours === 0 && bz.minutes === 0 && bz.seconds === 0);

// duration clamp: under the cap is unchanged, over the cap is clamped, zero floors to 1.
check('durationForTarget passes through under cap', durationForTarget(3600) === 3600);
check('durationForTarget clamps to 24h cap', durationForTarget(PIP_DUR_MAX + 999) === PIP_DUR_MAX);
check('durationForTarget floors to >=1', durationForTarget(0) === 1);

console.log('\nRESULT:', ok ? 'PASS ✅' : 'FAIL ❌');
process.exit(ok ? 0 : 1);
