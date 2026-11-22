// Owns: exact packaged executable smoke in a newly allocated disposable profile.
// Never: starts the source Electron binary or loads production accounts.
import { testNetworkEnv } from './test-network-env.mjs';
import { pathToFileURL } from 'node:url';
import { _electron } from 'playwright-core';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
export async function packagedSmoke(executable, electron = _electron) {
const executablePath = path.resolve(executable);
const profile = await mkdtemp(path.join(tmpdir(), 'autark-packaged-smoke-'));
const env = testNetworkEnv(profile, { WORKFORCE_FAKE_ENGINE: '1' });
delete env.ELECTRON_RUN_AS_NODE;
let desktop;
try {
  desktop = await electron.launch({ executablePath, args: [], env, timeout: 60000 });
  const window = await desktop.firstWindow({ timeout: 60000 });
  await window.waitForLoadState('domcontentloaded');
  const state = await desktop.evaluate(({ app }) => ({ packaged: app.isPackaged, exe: app.getPath('exe'), profile: app.getPath('userData'), ready: app.isReady() }));
  if (!state.packaged || !state.ready || path.resolve(state.profile) !== profile || state.exe.toLowerCase() !== executablePath.toLowerCase()) throw new Error('Packaged identity/profile/ready mismatch');
  await window.locator('body').waitFor({ state: 'visible', timeout: 30000 });
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/windows-packaged-smoke.json', JSON.stringify({ ...state, sha256: createHash('sha256').update(await readFile(executablePath)).digest('hex'), fakeEngine: true, productionAccounts: false }, null, 2));
} finally {
  // Playwright closes only its own Electron application, not other desktop sessions.
  if (desktop) await desktop.close();
  if (path.dirname(profile) === path.resolve(tmpdir()) && path.basename(profile).startsWith('autark-packaged-smoke-')) await rm(profile, { recursive: true, force: true });
}

}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await packagedSmoke(process.argv[2] ?? 'dist/win-unpacked/Autark.exe');
