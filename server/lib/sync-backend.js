'use strict';

/*
 * Which synchronisation protocol a group runs.
 *
 * ScreenTinker has its own group sync: every member derives its position from a shared clock,
 * so it needs no leader, survives a server outage, and works across Android, web, Tizen and
 * BrightSign alike. BrightSign has its own — BrightWall — which is native, frame-accurate, and
 * only exists between BrightSign players.
 *
 * The choice is therefore not "which is better" but "what is in this group":
 *
 *   screentinker  works everywhere, mixed fleets included; sync is to the second, not the frame
 *   brightsign    frame-accurate video walls; requires EVERY member to be a BrightSign
 *
 * `auto` picks the strongest protocol the group can actually run, which is what an operator
 * means when they say "just make the wall work". Explicit settings are honoured, except the one
 * that cannot physically work (native sync with a non-BrightSign member) — that downgrades and
 * says why, rather than silently doing nothing on the screens that can't participate.
 *
 * Kept pure so the decision is testable without a fleet: callers pass plain device rows.
 */

const BACKENDS = ['auto', 'screentinker', 'brightsign'];

/*
 * A device is a BrightSign if it said so: the player sends ?platform=brightsign (autorun.brs puts
 * it there), which lands in devices.platform.
 *
 * There is deliberately NO user-agent fallback. An earlier version had one, to catch panels paired
 * before this port existed — which registered as "Chrome 120" with a BrightSign user agent. It
 * could never fire: `devices` has no user_agent column, so the field is always undefined on a row
 * read from the database. It read as defensive and was dead code.
 *
 * Those pre-port panels are identified the moment they re-register on a build that carries the
 * host, which every one of them gets on its next update. Recognising them earlier would mean
 * persisting the user agent, and a column added solely to identify a population that disappears on
 * its own is not worth carrying.
 */
function isBrightSignDevice(device) {
  if (!device) return false;
  return String(device.platform || '').toLowerCase().includes('brightsign');
}

/*
 * SyncManager is MULTICAST (224.0.126.10:1539), so every member must share one L2 network. A group
 * spanning sites or VLANs cannot use it — and the failure is silent: each subnet would sync neatly
 * within itself while drifting from the others.
 *
 * The evidence available server-side is the address each device connects from. Comparing the /24
 * is a heuristic, not proof — two VLANs can share a public IP, and one subnet can span a routed
 * boundary that blocks multicast. So it is used in ONE direction only: differing networks are
 * treated as evidence against native sync, while matching ones are never treated as proof for it.
 * Unknown addresses block nothing, because "we cannot see it" must not read as "it is broken".
 */
function networkOf(device) {
  const ip = String((device && (device.ip_address || device.last_ip)) || '').trim();
  if (!ip) return null;
  if (ip.includes(':')) {                      // IPv6: compare the /64
    const parts = ip.split(':');
    return parts.slice(0, 4).join(':').toLowerCase();
  }
  const octets = ip.split('.');
  if (octets.length !== 4) return null;
  return octets.slice(0, 3).join('.');
}

function networksDiffer(members) {
  const nets = members.map(networkOf).filter(Boolean);
  if (nets.length < 2) return false;           // nothing to contradict
  return new Set(nets).size > 1;
}

/**
 * @param {string} setting  'auto' | 'screentinker' | 'brightsign' (unknown values read as auto)
 * @param {Array}  members  device rows in the group
 * @returns {{backend: 'screentinker'|'brightsign', reason: string, code: string, count?: number, downgraded: boolean}}
 *   `reason` is English for logs and the player; `code` (+ `count`) is what the dashboard translates.
 */
function resolveSyncBackend(setting, members) {
  const list = Array.isArray(members) ? members.filter(Boolean) : [];
  const requested = BACKENDS.includes(setting) ? setting : 'auto';

  const brightsignCount = list.filter(isBrightSignDevice).length;
  const allBrightSign = list.length > 0 && brightsignCount === list.length;
  const split = networksDiffer(list);

  if (requested === 'screentinker') {
    return { backend: 'screentinker', reason: 'explicitly selected', code: 'explicit', downgraded: false };
  }

  if (requested === 'brightsign') {
    if (allBrightSign && !split) {
      return { backend: 'brightsign', reason: 'explicitly selected', code: 'explicit', downgraded: false };
    }
    if (allBrightSign && split) {
      // Every member is a BrightSign, but they are not on one network. Native sync would appear
      // to work inside each subnet while the subnets drifted apart — worse than not using it.
      return {
        backend: 'screentinker',
        reason: 'displays are on different networks — native sync is multicast and cannot cross them',
        code: 'split_network_multicast',
        downgraded: true
      };
    }
    // Refusing to pretend: BrightWall cannot include a non-BrightSign screen, and a group that
    // half-syncs is worse than one that syncs to the second everywhere.
    const others = list.length - brightsignCount;
    return {
      backend: 'screentinker',
      reason: list.length === 0
        ? 'group is empty — native sync needs BrightSign members'
        : `group has ${others} non-BrightSign display${others === 1 ? '' : 's'}`,
      code: list.length === 0 ? 'empty_native' : 'non_brightsign',
      count: others,
      downgraded: true
    };
  }

  // auto
  if (allBrightSign && !split) {
    return { backend: 'brightsign', reason: 'every display is a BrightSign', code: 'all_brightsign', downgraded: false };
  }
  if (allBrightSign && split) {
    return {
      backend: 'screentinker',
      reason: 'displays are on different networks',
      code: 'split_network',
      downgraded: false
    };
  }
  // Not "mixed fleet": a group of three identical web players is not mixed, it simply has no
  // BrightSign in it — which is the only thing this branch actually knows.
  return {
    backend: 'screentinker',
    reason: list.length === 0 ? 'no displays in the group' : 'not every display is a BrightSign',
    code: list.length === 0 ? 'empty' : 'not_all_brightsign',
    downgraded: false
  };
}

module.exports = { resolveSyncBackend, isBrightSignDevice, networksDiffer, BACKENDS };
