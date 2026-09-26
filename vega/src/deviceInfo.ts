/*
 * Panel identity for the host:ready message.
 *
 * getModel() on Vega returns the Amazon model code (AFTCA002 on a 4K Select). getDeviceId()
 * has been observed to return that same code rather than a per-unit serial, so it is only a
 * fallback for the model and is NEVER reported as a serial — a fake serial would make two
 * sticks look like one device to anything that keys on it. The web player's own fingerprint
 * remains the install identity.
 *
 * Every call is optional. A missing turbo module must not keep the player off the screen.
 */

export const APP_VERSION = '2.2.2';

export type VegaIdentity = {
  model: string;
  os: string;
  version: string;
};

async function readField(deviceInfo: any, name: string): Promise<string> {
  const fn = deviceInfo && deviceInfo[name];
  if (typeof fn !== 'function') return '';
  try {
    const value = fn.call(deviceInfo);
    const resolved = value && typeof value.then === 'function' ? await value : value;
    return resolved == null ? '' : String(resolved);
  } catch (e) {
    return '';
  }
}

export async function readIdentity(): Promise<VegaIdentity> {
  const out: VegaIdentity = { model: '', os: 'Vega', version: APP_VERSION };
  try {
    const mod = require('@amazon-devices/react-native-device-info');
    const deviceInfo = (mod && mod.default) || mod;
    const model = (await readField(deviceInfo, 'getModel')) || (await readField(deviceInfo, 'getDeviceId'));
    if (model) out.model = model;
    const sysName = await readField(deviceInfo, 'getSystemName');
    const sysVer = await readField(deviceInfo, 'getSystemVersion');
    const os = [sysName || 'Vega', sysVer].filter(Boolean).join(' ');
    if (os) out.os = os;
    const version = await readField(deviceInfo, 'getVersion');
    if (version) out.version = version;
  } catch (e) {
    // Identity is additive. Playback does not wait on it.
  }
  return out;
}

// Marketing names for the setup card. The value sent to the server stays the model code.
const NAMES: { [code: string]: string } = {
  AFTCA002: 'Fire TV Stick 4K Select',
  AFTCL001: 'Fire TV Stick HD (2026)',
};

export function modelLabel(model: string): string {
  if (!model) return 'Vega OS';
  const name = NAMES[model];
  return name ? `${name} (${model})` : model;
}
