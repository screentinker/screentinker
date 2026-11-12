/*
 * A STREAM RENDERER'S SOUND LINK (the page side of lib/stream-out.js "THE RENDERER'S SOUND LINK").
 * Loaded only in the server's own renderer, by the stub the server puts there (window.__stAudio),
 * never by a screen.
 *
 * Each guest's sound, as it arrives over their connection, goes up to the server, where it is a strip
 * of its own on the stream's console. What comes back down is the mix (a track that screens showing
 * the stream with sound are sent) and, for each guest who is to hear the show, the show without their
 * own voice, which is put on the connection back to that guest.
 *
 * While the link is not open, active() says so and the player plays guests into the programme as it
 * always did.
 */
const A = window.__stAudio;
const RATE = 44100;

if (A && !A.__loaded && window === window.top && typeof A._key === 'function') {
  A.__loaded = true;
  const key = A._key();
  const ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' });
  const ready = ctx.audioWorklet.addModule('/js/stream-render-worklet.js');
  const sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination);   // keeps the taps running, silently
  const taps = new Map();      // guest id -> { src, node }
  const plays = new Map();     // 'master' | guest id -> { node, dest }
  const senders = new Map();   // guest id -> the RTCRtpSender of their connection's sound back to them
  const enc = new TextEncoder(), dec = new TextDecoder();
  let ws = null, open = false, workletOk = false;

  const frame = (type, id, pcm) => {
    const idb = enc.encode(id), b = new Uint8Array(2 + idb.length + (pcm ? pcm.byteLength : 0));
    b[0] = type; b[1] = idb.length; b.set(idb, 2); if (pcm) b.set(new Uint8Array(pcm), 2 + idb.length);
    return b;
  };
  const connect = () => {
    ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/stream-render/audio?k=' + encodeURIComponent(key || ''));
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { open = true; };
    ws.onclose = () => { open = false; setTimeout(connect, 2000); };
    ws.onerror = () => {};
    ws.onmessage = (e) => {
      const b = new Uint8Array(e.data);
      if (b[0] === 2) feed('master', b.subarray(1));
      else if (b[0] === 3) { const n = b[1]; feed(dec.decode(b.subarray(2, 2 + n)), b.subarray(2 + n)); }
    };
  };
  const play = (key) => {
    let p = plays.get(key);
    // A guest's feed only while their sound is here: one that comes in just after they left makes nothing.
    if (p || !workletOk || (key !== 'master' && !taps.has(key))) return p || null;
    const node = new AudioWorkletNode(ctx, 'st-play', { numberOfInputs: 0, outputChannelCount: [2] });
    const dest = ctx.createMediaStreamDestination();
    node.connect(dest);
    p = { node, dest, track: dest.stream.getAudioTracks()[0] };
    plays.set(key, p);
    if (key !== 'master') { const s = senders.get(key); if (s) s.replaceTrack(p.track).catch(() => {}); }
    return p;
  };
  const feed = (key, bytes) => {
    const p = play(key); if (!p) return;
    const copy = bytes.slice().buffer;            // a whole buffer of its own, aligned, to hand over
    p.node.port.postMessage(copy, [copy]);
  };
  const api = {
    guest(id, track, sender) {
      if (sender) { senders.set(id, sender); const p = plays.get(id); if (p) sender.replaceTrack(p.track).catch(() => {}); }
      ready.then(() => {
        const old = taps.get(id); if (old) { try { old.src.disconnect(); old.node.disconnect(); } catch (e) { /* gone */ } }
        const src = ctx.createMediaStreamSource(new MediaStream([track]));
        const node = new AudioWorkletNode(ctx, 'st-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
        node.port.onmessage = (e) => { if (open && ws.bufferedAmount < 256 * 1024) ws.send(frame(1, id, e.data)); };
        src.connect(node); node.connect(sink);
        taps.set(id, { src, node });
      });
    },
    drop(id) {
      const tp = taps.get(id); if (tp) { try { tp.src.disconnect(); tp.node.disconnect(); } catch (e) { /* gone */ } taps.delete(id); }
      const p = plays.get(id); if (p) { try { p.node.disconnect(); p.track.stop(); } catch (e) { /* gone */ } plays.delete(id); }
      senders.delete(id);
      if (open) ws.send(frame(4, id, null));
    },
    active() { return open && workletOk && ctx.state === 'running'; },
    masterTrack() { const p = play('master'); return p ? p.track : null; },
  };
  ready.then(() => { workletOk = true; ctx.resume().catch(() => {}); connect(); A._ready(api); })
    .catch((e) => console.warn('[sound link] no worklet:', e && e.message));
}
