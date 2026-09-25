/*
 * What survives a WebView data clear.
 *
 * The page keeps its own copy of the pairing in localStorage, which is origin-scoped and is the
 * first thing a data clear throws away. The server address and the pairing have to outlive that,
 * the way BrightSign's registry does (BS.setIdentity) and the way the Android player stores them
 * in ServerConfig. Otherwise the stick comes back as a new device and the dashboard keeps a dead
 * row.
 *
 * /data persists across reboots and package upgrades and is private to this app. A config.json
 * shipped in the package is the fleet path for the URL only: bake it in, and a stick that has
 * never been typed on still knows where to pair. A value typed on the remote wins, because it is
 * the one written to /data. The pairing is never in the package — it is learned from the server.
 */

const FILE = '/data/screentinker.json';
const PACKAGED = '/pkg/assets/config.json';

type Stored = { serverUrl?: string; deviceId?: string; deviceToken?: string };

export type VegaPairing = { deviceId: string; deviceToken: string };

function fileSystem(): {
  readFileAsString: (path: string, encoding: string) => Promise<string>;
  writeStringToFile: (path: string, content: string, encoding: string) => Promise<number>;
} {
  // Resolved at call time. The module exists only inside a Vega SDK install; requiring it at
  // module load would make every unit test of this file import a native turbo module.
  const mod = require('@amazon-devices/kepler-file-system');
  const api = (mod && (mod.KeplerFileSystem || mod.default)) || mod;
  if (!api || typeof api.readFileAsString !== 'function') {
    throw new Error('kepler-file-system unavailable');
  }
  return api;
}

async function readJson(path: string): Promise<Stored | null> {
  try {
    const text = await fileSystem().readFileAsString(path, 'UTF-8');
    if (!text) return null;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (e) {
    return null;
  }
}

async function writeStored(next: Stored): Promise<void> {
  await fileSystem().writeStringToFile(FILE, JSON.stringify(next), 'UTF-8');
}

export async function readServerUrl(): Promise<string> {
  const saved = await readJson(FILE);
  if (saved && typeof saved.serverUrl === 'string' && saved.serverUrl.trim()) return saved.serverUrl.trim();
  const packaged = await readJson(PACKAGED);
  if (packaged && typeof packaged.serverUrl === 'string') return packaged.serverUrl.trim();
  return '';
}

export async function writeServerUrl(serverUrl: string): Promise<void> {
  // Merge. Replacing the file would forget a pairing that already survived one data clear.
  const saved = (await readJson(FILE)) || {};
  saved.serverUrl = serverUrl;
  await writeStored(saved);
}

export async function readPairing(): Promise<VegaPairing | null> {
  const saved = await readJson(FILE);
  if (!saved) return null;
  const deviceId = typeof saved.deviceId === 'string' ? saved.deviceId.trim() : '';
  const deviceToken = typeof saved.deviceToken === 'string' ? saved.deviceToken.trim() : '';
  // The id without the token is not an identity: the server would reject it and issue a new row.
  if (!deviceId || !deviceToken) return null;
  return { deviceId, deviceToken };
}

export async function writePairing(deviceId: string, deviceToken: string): Promise<void> {
  const saved = (await readJson(FILE)) || {};
  saved.deviceId = deviceId;
  saved.deviceToken = deviceToken;
  await writeStored(saved);
}

export async function clearPairing(): Promise<void> {
  const saved = (await readJson(FILE)) || {};
  delete saved.deviceId;
  delete saved.deviceToken;
  await writeStored(saved);
}