// The keyring name of a data folder that came from the old product name ("Proactive Agent Workforce"; 0.3.0 moved the
// folder to "Autark"). macOS and Linux derive the key that protects secrets and cookies from the app's name (Keychain item,
// keyring entry), so a moved folder carries the old name in <data>/keyring-name: the app goes by it until `ready`
// (Electron has read the keyring name by then) and by its own name afterwards, so titles and menus show the new name.
// Windows keeps its key in `Local State` inside the folder; a fresh install has no marker.
// Owns: reading the marker and the name until `ready`. Never: moves or writes data, imports electron at runtime.

import { readFileSync } from 'node:fs';
import path from 'node:path';

export const KEYRING_MARKER = 'keyring-name';

/** The keyring name a folder carries; null when it has none or the file is not one line of a name. */
export function readMarker(dir: string): string | null {
  try {
    const name = readFileSync(path.join(dir, KEYRING_MARKER), 'utf8').trim();
    return name && name.length <= 128 && !/[\r\n]/.test(name) ? name : null;
  } catch {
    return null;
  }
}

/** The part of Electron's app this needs. */
export interface KeyringApp {
  isPackaged: boolean;
  getName(): string;
  setName(name: string): void;
  getPath(name: 'userData'): string;
  setPath(name: 'userData', value: string): void;
  whenReady(): Promise<unknown>;
}

/** The top of main/index.ts, before anything reads safeStorage. app.setName can change the default userData, so the folder stays pinned. */
export function applyKeyringName(app: KeyringApp, platform: string = process.platform): void {
  if (!app.isPackaged || platform === 'win32') return;
  const dir = app.getPath('userData');
  const name = readMarker(dir);
  const own = app.getName();
  if (!name || name === own) return;
  app.setName(name);
  app.setPath('userData', dir);
  void app.whenReady().then(() => app.setName(own));
}
