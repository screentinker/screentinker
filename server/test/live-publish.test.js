'use strict';
// The web-player live PUBLISHER control core (lib/live-publish.js). The browser I/O is injected, so
// these tests exercise the state machine without a real getDisplayMedia or RTCPeerConnection.
//
// The guarantee under test is the same one the viewer makes: publishing is NEVER load-bearing. A
// denied capture, an absent peer API, a 409/live-off route, or a silent go2rtc must all resolve to
// a stopped publisher without throwing — the player keeps rendering content regardless.
const { test } = require('node:test');
const assert = require('node:assert');
const { createPublisher } = require('../lib/live-publish');

// A minimal RTCPeerConnection-like fake. ICE is reported already complete so waitForIce resolves
// immediately (no timers), and createOffer/setLocalDescription/setRemoteDescription are recorded.
function fakePeer() {
  const pc = {
    iceGatheringState: 'complete',
    localDescription: null,
    tracks: [],
    closed: false,
    addTrack(t) { this.tracks.push(t); },
    addEventListener() {},
    removeEventListener() {},
    async createOffer() { return { type: 'offer', sdp: 'OFFER_SDP' }; },
    async setLocalDescription(d) { this.localDescription = { sdp: d.sdp || 'OFFER_SDP' }; },
    async setRemoteDescription(d) { this.remote = d; },
    close() { this.closed = true; },
  };
  return pc;
}

function fakeStream() {
  const v = { kind: 'video', stopped: false, onended: null, stop() { this.stopped = true; } };
  return { _v: v, getTracks() { return [v]; } };
}

test('happy path: capture -> offer -> publish -> live', async () => {
  const states = [];
  let posted = null;
  const peer = fakePeer();
  const stream = fakeStream();
  const pub = createPublisher({
    onState: (s) => states.push(s),
    getDisplayMedia: async () => stream,
    createPeer: () => peer,
    postOffer: async (sdp) => { posted = sdp; return { ok: true, status: 200, sdp: 'ANSWER_SDP' }; },
  });
  const ok = await pub.start([{ urls: 'stun:x' }]);
  assert.equal(ok, true);
  assert.equal(pub.state, 'live');
  assert.equal(posted, 'OFFER_SDP');
  assert.deepEqual(peer.tracks, [stream._v]);
  assert.deepEqual(peer.remote, { type: 'answer', sdp: 'ANSWER_SDP' });
  assert.ok(states.includes('starting') && states.includes('live'));
});

test('denied capture resolves stopped, does not throw', async () => {
  let reason = null;
  const pub = createPublisher({
    onState: (s, r) => { if (s === 'stopped') reason = r; },
    getDisplayMedia: async () => { throw new Error('NotAllowedError'); },
    createPeer: fakePeer,
    postOffer: async () => ({ ok: true, status: 200, sdp: 'A' }),
  });
  const ok = await pub.start([]);
  assert.equal(ok, false);
  assert.equal(pub.state, 'stopped');
  assert.equal(reason, 'capture_denied');
});

test('missing peer API is unsupported, not a throw', async () => {
  const pub = createPublisher({
    getDisplayMedia: async () => fakeStream(),
    createPeer: undefined,
    postOffer: async () => ({ ok: true, status: 200, sdp: 'A' }),
  });
  const ok = await pub.start([]);
  assert.equal(ok, false);
  assert.equal(pub.state, 'stopped');
});

test('route refuses (409 live off): stops, stream released', async () => {
  const stream = fakeStream();
  const peer = fakePeer();
  const pub = createPublisher({
    getDisplayMedia: async () => stream,
    createPeer: () => peer,
    postOffer: async () => ({ ok: false, status: 409, sdp: '' }),
  });
  const ok = await pub.start([]);
  assert.equal(ok, false);
  assert.equal(pub.state, 'stopped');
  assert.equal(stream._v.stopped, true, 'the captured track must be stopped on failure');
  assert.equal(peer.closed, true, 'the peer must be closed on failure');
});

test('go2rtc silent (postOffer returns null-ish): stops', async () => {
  const pub = createPublisher({
    getDisplayMedia: async () => fakeStream(),
    createPeer: fakePeer,
    postOffer: async () => null,
  });
  const ok = await pub.start([]);
  assert.equal(ok, false);
  assert.equal(pub.state, 'stopped');
});

test('operator ending the OS share tears the publisher down', async () => {
  const stream = fakeStream();
  const peer = fakePeer();
  const pub = createPublisher({
    getDisplayMedia: async () => stream,
    createPeer: () => peer,
    postOffer: async () => ({ ok: true, status: 200, sdp: 'ANSWER' }),
  });
  await pub.start([]);
  assert.equal(pub.state, 'live');
  assert.equal(typeof stream._v.onended, 'function');
  stream._v.onended();                 // simulate "Stop sharing"
  assert.equal(pub.state, 'stopped');
  assert.equal(peer.closed, true);
});

test('stop() during capture prompt aborts cleanly', async () => {
  let releaseCapture;
  const stream = fakeStream();
  const peer = fakePeer();
  const pub = createPublisher({
    getDisplayMedia: () => new Promise((res) => { releaseCapture = () => res(stream); }),
    createPeer: () => peer,
    postOffer: async () => ({ ok: true, status: 200, sdp: 'A' }),
  });
  const p = pub.start([]);
  pub.stop('navigated_away');          // stop while getDisplayMedia is still pending
  releaseCapture();                    // prompt resolves late
  const ok = await p;
  assert.equal(ok, false);
  assert.notEqual(pub.state, 'live');
  assert.equal(stream._v.stopped, true, 'a stream that arrives after stop must be released');
});
