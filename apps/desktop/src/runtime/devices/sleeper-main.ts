// Sicher-Runde 19.11.2026: the wake helper's program (bundled as app/sleeper.mjs, started by main/sleeper.ts as
// `ELECTRON_RUN_AS_NODE=1 <Autark.exe> sleeper.mjs <data>/wake.json -- <the app's own start arguments>`). It reads the
// helper's file, ends at once when the app is running already, and otherwise runs the helper (sleeper.ts) until a wake
// starts the app, the app starts by itself (run-state.json turns 'running': a directory watch, no polling) or another
// helper takes its key over. Its few lines go to <data>/logs/sleeper.log (never a key).
// Owns: the helper process – its file, its app start (the Node switch removed, so the app starts as the app) and its end.
// Never: loads the runtime, the database or a window.

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, watch } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { RUN_STATE_FILE } from '../../shared/model/launch.ts';
import { Sleeper } from './sleeper.ts';
import { parseWakeFile } from './wake-sign.ts';

const [file = '', ...rest] = process.argv.slice(2);
const appArgs = rest[0] === '--' ? rest.slice(1) : rest;
const dir = path.dirname(path.resolve(file || '.'));
const read = (target: string) => { try { return readFileSync(target, 'utf8'); } catch { return ''; } };
const running = () => { try { return (JSON.parse(read(path.join(dir, RUN_STATE_FILE))) as { state?: unknown }).state === 'running'; } catch { return false; } };
const log = (line: string) => {
  try { mkdirSync(path.join(dir, 'logs'), { recursive: true }); appendFileSync(path.join(dir, 'logs', 'sleeper.log'), `${new Date().toISOString()} ${line}\n`); } catch { /* no log */ }
};

const wake = file ? parseWakeFile(read(file)) : undefined;
if (!wake || running()) process.exit(0);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // the app starts as the app
const sleeper = new Sleeper({
  file: wake!,
  socket: (url) => new WebSocket(url, { maxPayload: 70 * 1024, handshakeTimeout: 10_000, perMessageDeflate: false }),
  startApp: () => { spawn(process.execPath, appArgs, { detached: true, stdio: 'ignore', env }).unref(); },
  exit: () => { log('ending'); process.exit(0); },
  log,
});
try {
  watch(dir, (_event, name) => { if (name === RUN_STATE_FILE && running()) sleeper.end(); });
} catch { /* no watch: the helper waits on; a wake while the app runs only shows its window (single instance) */ }
log(`started (pid ${process.pid})`);
sleeper.start();
