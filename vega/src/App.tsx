/*
 * ScreenTinker shell for Vega OS.
 *
 * The web player (https://<server>/player) does the playing. This app is what a browser tab on
 * these sticks is not: an installed package, a server address and a pairing that survive a
 * WebView data clear, hardware media services turned on, and autoplay without a remote click. Fire TV Stick
 * 4K Select and Fire TV Stick HD (2026) are not Android — the APK cannot be installed here.
 *
 * Protocol, same as webos/ and documented on the player page:
 *   player -> shell:  { source:'screentinker-player', type:'host:hello' }
 *                     { source:'screentinker-player', type:'host:command', action, payload }
 *   shell -> player:  { source:'screentinker-host', type:'host:ready', platform, capabilities, info }
 *                     { source:'screentinker-host', type:'host:result', action, ok, error }
 *
 * The WebView is the top window, so the player cannot postMessage a parent. It calls
 * window.ReactNativeWebView.postMessage, and we answer by injecting a MessageEvent.
 *
 * Capabilities announced here are ONLY what this shell itself performs. Content capabilities
 * (video, widgets, zones, volume, screenshots) are declared by the page, because that is the
 * code that does them. Announcing a reboot from here would put a dashboard button on a
 * stick that has no reboot API.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { WebView } from '@amazon-devices/webview';
import { LIFESPAN_POLICY, useSetLifespanCallback, useSetTimeoutCallback } from '@amazon-devices/react-native-kepler';
import { APP_VERSION, modelLabel, readIdentity, VegaIdentity } from './deviceInfo';
import { readPairing, readServerUrl, writePairing, writeServerUrl, clearPairing, VegaPairing } from './storage';

type WebRef = {
  injectJavaScript: (source: string) => void;
  reload?: () => void;
};

function normaliseUrl(raw: string): string {
  let u = String(raw || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  return u.replace(/\/+$/, '');
}

export const App = () => {
  const webRef = useRef<WebRef | null>(null);
  const [booting, setBooting] = useState(true);
  const [serverUrl, setServerUrl] = useState('');
  const [draft, setDraft] = useState('');
  const [setupOpen, setSetupOpen] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [identity, setIdentity] = useState<VegaIdentity>({ model: '', os: 'Vega', version: APP_VERSION });
  // The pairing the page should adopt if its own localStorage was cleared. Read before the
  // WebView mounts (booting stays up until then), so the first host:ready already carries it.
  const pairingRef = useRef<VegaPairing | null>(null);

  // LCM suppresses the screensaver for a PERMANENT component. The idle handler logs
  // "Screensaver disabled by policy". This is not a wake lock: power-service-core can
  // still force the panel off, and Amazon ships no API for that. A silent looping video
  // would also hold the panel, and it would take a decoder — the CMA claim that killed
  // the last run — so we do not. A video that is actually playing already holds a
  // video-playback session, which the resource manager treats as display-keeping.
  const setLifespan = useSetLifespanCallback();
  const setInactivityTimeout = useSetTimeoutCallback();
  useEffect(() => {
    try {
      setLifespan(LIFESPAN_POLICY.PERMANENT);
      // Seconds. A year, so inactivity does not background the sign. The stick's Ambient
      // timeout is a separate setting and this call does not raise it.
      setInactivityTimeout(60 * 60 * 24 * 365);
    } catch (e) { /* manifest timeout-secs is the same request if the runtime refuses */ }
  }, [setLifespan, setInactivityTimeout]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [url, id, pairing] = await Promise.all([readServerUrl(), readIdentity(), readPairing()]);
      if (cancelled) return;
      pairingRef.current = pairing;
      setIdentity(id);
      const normalised = normaliseUrl(url);
      setServerUrl(normalised);
      setDraft(normalised);
      setSetupOpen(!normalised);
      setBooting(false);
    })();
    return () => { cancelled = true; };
  }, []);

  // Back exits a Vega app by default. On a sign that is a black TV with no one in the room to
  // launch us again. Swallow it. From the player it opens the server card (the WebView stays
  // mounted, so the sign keeps playing underneath). From the card, with a server already saved,
  // it returns to the sign.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!serverUrl) return true;
      setSetupOpen((open) => !open);
      setError('');
      return true;
    });
    return () => sub.remove();
  }, [serverUrl]);

  const deliver = useCallback((msg: Record<string, unknown>) => {
    const payload = JSON.stringify(Object.assign({ source: 'screentinker-host' }, msg));
    const js = `window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(payload)}}));true;`;
    try { webRef.current && webRef.current.injectJavaScript(js); } catch (e) { /* page not up yet */ }
  }, []);

  const announce = useCallback(() => {
    // Nothing in this list is a content feature. restart is the one action the shell performs
    // that the page cannot: reload the WebView itself when the document is wedged. The page
    // already claims system.restart_player for location.reload(); this is the same capability,
    // honoured one level up. Reboot is not offered: the stick has no API for it.
    const pairing = pairingRef.current;
    deliver({
      type: 'host:ready',
      platform: 'vega',
      version: identity.version || APP_VERSION,
      capabilities: [],
      info: {
        model: identity.model || '',
        os: identity.os || 'Vega',
        version: identity.version || APP_VERSION,
        name: modelLabel(identity.model),
        // Both, or neither. An id without its token is how a stick gets a second dashboard row.
        ...(pairing && pairing.deviceId && pairing.deviceToken
          ? { deviceId: pairing.deviceId, deviceToken: pairing.deviceToken }
          : {}),
      },
    });
  }, [deliver, identity]);

  const onCommand = useCallback((action: string, payload: { deviceId?: unknown; deviceToken?: unknown } | null) => {
    if (action === 'restart') {
      const ref = webRef.current;
      try {
        if (ref && typeof ref.reload === 'function') ref.reload();
        else if (ref) ref.injectJavaScript('location.reload();true;');
        deliver({ type: 'host:result', action, ok: true });
      } catch (e) {
        deliver({ type: 'host:result', action, ok: false, error: 'reload failed' });
      }
      return;
    }
    const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    if (action === 'set-identity') {
      const deviceId = text(payload && payload.deviceId);
      const deviceToken = text(payload && payload.deviceToken);
      if (!deviceId || !deviceToken || deviceId.length > 200 || deviceToken.length > 500) {
        deliver({ type: 'host:result', action, ok: false, error: 'identity incomplete' });
        return;
      }
      pairingRef.current = { deviceId, deviceToken };
      writePairing(deviceId, deviceToken).then(
        () => deliver({ type: 'host:result', action, ok: true }),
        () => deliver({ type: 'host:result', action, ok: false, error: 'could not store identity' }),
      );
      return;
    }
    if (action === 'clear-identity') {
      // Drop it from memory first, so a host:ready that races the file write does not hand the
      // page the identity an unpair just threw away.
      pairingRef.current = null;
      clearPairing().then(
        () => deliver({ type: 'host:result', action, ok: true }),
        () => deliver({ type: 'host:result', action, ok: false, error: 'could not clear identity' }),
      );
      return;
    }
    deliver({ type: 'host:result', action, ok: false, error: 'unsupported' });
  }, [deliver]);

  const onMessage = useCallback((event: { nativeEvent?: { data?: string } }) => {
    let data: { source?: string; type?: string; action?: string; payload?: { deviceId?: unknown; deviceToken?: unknown } | null } | null = null;
    try { data = JSON.parse(String(event && event.nativeEvent && event.nativeEvent.data || '')); }
    catch (e) { return; }
    if (!data || data.source !== 'screentinker-player') return;
    if (data.type === 'host:hello') announce();
    else if (data.type === 'host:command' && typeof data.action === 'string') onCommand(data.action, data.payload || null);
  }, [announce, onCommand]);

  const save = useCallback(async () => {
    const next = normaliseUrl(draft);
    if (!next) {
      setError('Enter the server address.');
      return;
    }
    try {
      await writeServerUrl(next);
    } catch (e) {
      setError('Could not save the address on this stick.');
      return;
    }
    setError('');
    setLoadError('');
    setServerUrl(next);
    setSetupOpen(false);
  }, [draft]);

  const playerUri = serverUrl ? `${serverUrl}/player?host=vega` : '';

  return (
    <View style={styles.root}>
      {playerUri ? (
        <WebView
          ref={webRef as any}
          key={playerUri}
          style={styles.web}
          source={{ uri: playerUri }}
          hasTVPreferredFocus={!setupOpen}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          // Signage starts with nobody holding the remote. The default (true) leaves every
          // video paused on the first frame until a keypress that will never come.
          mediaPlaybackRequiresUserAction={false}
          thirdPartyCookiesEnabled={true}
          // A playlist item can be http on an https server (a camera on the LAN). Blocking
          // mixed content blanks that item and looks like a broken playlist.
          mixedContentMode={'Always' as any}
          // A replaced user agent drops the Chromium token the player uses to choose hls.js.
          // Identity goes through host:ready, not the UA string.
          allowJavaScriptInBackground={true}
          allowSystemKeyEvents={true}
          onMessage={onMessage}
          onLoad={() => { setLoadError(''); announce(); }}
          onError={(event: any) => {
            const desc = event && event.nativeEvent && (event.nativeEvent.description || event.nativeEvent.code);
            setLoadError(desc ? String(desc) : 'Could not open the player.');
            setSetupOpen(true);
          }}
        />
      ) : null}

      {booting ? (
        <View style={styles.boot}>
          <ActivityIndicator color="#5eead4" />
        </View>
      ) : null}

      {setupOpen && !booting ? (
        <View style={styles.overlay}>
          <View style={styles.card}>
            <Text style={styles.kicker}>ScreenTinker</Text>
            <Text style={styles.title}>Vega player</Text>
            <Text style={styles.mut}>
              Enter your ScreenTinker server. The screen then shows a pairing code to claim in the dashboard.
            </Text>
            <Text style={styles.label}>Server URL</Text>
            <TextInput
              style={styles.input}
              value={draft}
              onChangeText={(t) => { setDraft(t); setError(''); }}
              placeholder="https://signage.example.com"
              placeholderTextColor="#64748b"
              autoCapitalize="none"
              autoCorrect={false}
              hasTVPreferredFocus={true}
              onSubmitEditing={save}
            />
            {error ? <Text style={styles.err}>{error}</Text> : null}
            {loadError ? <Text style={styles.err}>{loadError}</Text> : null}
            <Pressable style={styles.button} onPress={save}>
              <Text style={styles.buttonText}>Save and start</Text>
            </Pressable>
            {serverUrl ? (
              <Pressable style={styles.secondary} onPress={() => { setSetupOpen(false); setError(''); }}>
                <Text style={styles.secondaryText}>Back to the screen</Text>
              </Pressable>
            ) : null}
            <Text style={styles.meta}>
              {`App v${identity.version || APP_VERSION} · ${modelLabel(identity.model)} · ${identity.os || 'Vega'}`}
            </Text>
            <Text style={styles.hint}>Back on the remote opens this card. It does not quit the app.</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000000' },
  web: { flex: 1, backgroundColor: '#000000' },
  boot: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center', backgroundColor: '#000000',
  },
  overlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.72)',
    alignItems: 'center', justifyContent: 'center',
  },
  card: {
    width: 760,
    maxWidth: '92%',
    backgroundColor: '#0f172a',
    borderRadius: 16,
    paddingHorizontal: 36,
    paddingVertical: 32,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  kicker: { color: '#5eead4', fontSize: 18, fontWeight: '600', letterSpacing: 0.4 },
  title: { color: '#f8fafc', fontSize: 40, fontWeight: '700', marginTop: 4 },
  mut: { color: '#94a3b8', fontSize: 20, lineHeight: 28, marginTop: 12 },
  label: { color: '#e2e8f0', fontSize: 18, marginTop: 22, marginBottom: 8 },
  input: {
    backgroundColor: '#020617',
    color: '#f8fafc',
    fontSize: 22,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#334155',
  },
  err: { color: '#fda4af', fontSize: 18, marginTop: 10 },
  button: {
    marginTop: 22,
    backgroundColor: '#0f766e',
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
  },
  buttonText: { color: '#f0fdfa', fontSize: 22, fontWeight: '700' },
  secondary: { marginTop: 12, paddingVertical: 12, alignItems: 'center' },
  secondaryText: { color: '#cbd5e1', fontSize: 18 },
  meta: { color: '#64748b', fontSize: 16, marginTop: 22 },
  hint: { color: '#64748b', fontSize: 16, marginTop: 6 },
});
