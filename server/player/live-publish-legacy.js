"use strict";
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};
(function() {
  function createPublisher(deps) {
    const iceGatherWaitMs = deps.iceGatherWaitMs != null ? deps.iceGatherWaitMs : 1500;
    let pc = null;
    let stream = null;
    let state = "idle";
    let seq = 0;
    function setState(s, reason) {
      state = s;
      try {
        deps.onState && deps.onState(s, reason);
      } catch (_) {
      }
    }
    function teardown() {
      try {
        if (stream && stream.getTracks) stream.getTracks().forEach((t) => t.stop());
      } catch (_) {
      }
      try {
        if (pc) pc.close();
      } catch (_) {
      }
      pc = null;
      stream = null;
    }
    function stop(reason) {
      seq++;
      teardown();
      if (state !== "stopped" && state !== "idle") setState("stopped", reason || "stopped");
      else state = "stopped";
    }
    function start(iceServers) {
      return __async(this, null, function* () {
        const mine = ++seq;
        const getStream = deps.getStream || deps.getDisplayMedia;
        if (typeof deps.createPeer !== "function" || typeof getStream !== "function") {
          setState("stopped", "unsupported");
          return false;
        }
        setState("starting");
        try {
          stream = yield getStream();
        } catch (_) {
          setState("stopped", "capture_denied");
          return false;
        }
        if (mine !== seq) {
          teardown();
          return false;
        }
        try {
          pc = deps.createPeer(iceServers || []);
          const tracks = stream.getTracks ? stream.getTracks() : stream.tracks || [];
          for (const track of tracks) {
            if (pc.addTrack) pc.addTrack(track, stream);
            else if (pc.addTransceiver) pc.addTransceiver(track, { direction: "sendonly", streams: [stream] });
          }
          const vids = tracks.filter((t) => t.kind === "video");
          if (vids[0]) vids[0].onended = () => stop("share_ended");
          try {
            const RS = typeof window !== "undefined" && window.RTCRtpSender;
            if (RS && RS.getCapabilities && pc.getTransceivers) {
              const caps = RS.getCapabilities("video");
              if (caps && caps.codecs && caps.codecs.length) {
                const pref = caps.codecs.slice().sort((a, b) => {
                  const h = (c) => /h264/i.test(c.mimeType) ? 0 : 1;
                  return h(a) - h(b);
                });
                for (const tr of pc.getTransceivers()) {
                  const kind = tr.sender && tr.sender.track && tr.sender.track.kind;
                  if (kind === "video" && tr.setCodecPreferences) {
                    try {
                      tr.setCodecPreferences(pref);
                    } catch (_) {
                    }
                  }
                }
              }
            }
          } catch (_) {
          }
          const offer = yield pc.createOffer();
          yield pc.setLocalDescription(offer);
          yield waitForIce(pc, iceGatherWaitMs);
          if (mine !== seq) {
            teardown();
            return false;
          }
          const sdp = pc.localDescription && pc.localDescription.sdp || offer && offer.sdp;
          const res = yield deps.postOffer(sdp);
          if (mine !== seq) {
            teardown();
            return false;
          }
          if (!res || !res.ok || !res.sdp) {
            stop(res ? "publish_" + res.status : "publish_failed");
            return false;
          }
          yield pc.setRemoteDescription({ type: "answer", sdp: res.sdp });
          if (mine !== seq) {
            teardown();
            return false;
          }
          setState("live");
          return true;
        } catch (_) {
          stop("exchange_error");
          return false;
        }
      });
    }
    return { start, stop, get state() {
      return state;
    } };
  }
  function waitForIce(pc, capMs) {
    if (!pc || pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try {
          pc.removeEventListener("icegatheringstatechange", check);
        } catch (_) {
        }
        clearTimeout(timer);
        resolve();
      };
      const check = () => {
        if (pc.iceGatheringState === "complete") finish();
      };
      try {
        pc.addEventListener("icegatheringstatechange", check);
      } catch (_) {
      }
      const timer = setTimeout(finish, capMs);
    });
  }
  const EXPORTS = { createPublisher, waitForIce };
  if (typeof module !== "undefined" && module.exports) module.exports = EXPORTS;
  if (typeof window !== "undefined") {
    window.STLivePublishCore = EXPORTS;
    window.STLivePublish = /* @__PURE__ */ (function() {
      let pub = null;
      return {
        isSupported: function() {
          return !!window.RTCPeerConnection;
        },
        // opts: { deviceId, deviceToken, iceServers, onState, getStream }
        //   getStream: () => MediaStream  — the player's OWN content (canvas/video captureStream,
        //   no gesture). If omitted, falls back to getDisplayMedia (which DOES need a gesture).
        start: function(opts) {
          return __async(this, null, function* () {
            opts = opts || {};
            if (!this.isSupported() || !opts.deviceId || !opts.deviceToken) return false;
            if (pub && (pub.state === "live" || pub.state === "starting")) return true;
            if (pub) pub.stop("restart");
            const base = (opts.serverUrl || "").replace(/\/+$/, "");
            const url = base + "/api/devices/" + encodeURIComponent(opts.deviceId) + "/live/publish?token=" + encodeURIComponent(opts.deviceToken);
            pub = createPublisher({
              onState: opts.onState,
              getStream: opts.getStream || function() {
                return navigator.mediaDevices.getDisplayMedia({
                  video: { frameRate: { ideal: 15, max: 30 } },
                  audio: false
                });
              },
              createPeer: function(iceServers) {
                return new RTCPeerConnection({ iceServers });
              },
              postOffer: function(sdp) {
                return __async(this, null, function* () {
                  try {
                    const r = yield fetch(url, { method: "POST", headers: { "Content-Type": "application/sdp" }, body: sdp });
                    return { ok: r.ok, status: r.status, sdp: r.ok ? yield r.text() : "" };
                  } catch (_) {
                    return { ok: false, status: 0, sdp: "" };
                  }
                });
              }
            });
            return pub.start(opts.iceServers || [{ urls: "stun:stun.l.google.com:19302" }]);
          });
        },
        stop: function() {
          if (pub) {
            pub.stop("manual");
            pub = null;
          }
        },
        get state() {
          return pub ? pub.state : "idle";
        }
      };
    })();
  }
})();
