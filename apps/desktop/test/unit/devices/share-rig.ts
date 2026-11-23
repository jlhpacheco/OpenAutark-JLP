// The rig of the share tests (share*.test.ts): the row sync's fake PCs (sync-net.ts) with a ShareSync each on
// 'sync.share', a data folder and a disk of their own (a home project's one absolute path lies on each PC's own disk),
// no folder watch (a test says what changed: `changed`), the agent Mara, and fake browser profiles. Every temp folder
// it makes goes again when the test file is done.
// Owns: this rig only. Never: asserts anything.

import { after } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ContextLike, StorageStateLike } from '../../../src/runtime/browser/page.ts';
import type { Session } from '../../../src/runtime/browser/sessions.ts';
import { SHARE_METHOD, ShareSync } from '../../../src/runtime/devices/sync/share.ts';
import { agent } from '../chat/harness.ts';
import { fakeHost } from './fakes.ts';
import { makePc, type Net, type Pc } from './sync-net.ts';

export const MARA = 'ag_mara';
/** Mara's home project: one absolute path, the same on every PC. */
export const HOME = path.resolve(os.tmpdir(), 'share-home-project');

const made: string[] = [];
/** A temp folder that goes when the test file is done. */
export async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}
after(async () => { for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined); });

export type SharePc = Pc & {
  share: ShareSync; data: string; disk: string; root: string;
  /** agent.json's home per agent here. */
  homes: Map<string, string>;
  /** What the folder watch would report, looked at now. */
  changed(...rels: string[]): Promise<void>;
  /** What the folder watch reports; the look still waits. */
  report(...rels: string[]): void;
  write(rel: string, text: string, mtime?: number): Promise<void>;
  read(rel: string): Promise<string | undefined>;
};

/** A PC with the share sync; Mara runs on `runsOn` and is at home on `homes` too. `project`: her agent.json names HOME here. */
export async function sharePc(net: Net, id: string, runsOn: string, homes: string[], project = true): Promise<SharePc> {
  const pc = makePc(net, id);
  const base = await tmp(`share-${id}-`);
  const data = path.join(base, 'data');
  const disk = path.join(base, 'disk');
  await mkdir(data, { recursive: true });
  await mkdir(disk, { recursive: true });
  const services = pc.h.services as RuntimeServices;
  (services as { paths: unknown }).paths = { data };
  (services as { host: unknown }).host = fakeHost();
  const known = new Map<string, string>(project ? [[MARA, HOME]] : []);
  (services as { agentCore: unknown }).agentCore = { homes: { stored: (agentId: string) => known.get(agentId) } };
  pc.h.org.add(agent(MARA, 'Mara', { deviceId: runsOn, homes }));
  const share = new ShareSync(services);
  const root = path.join(disk, path.basename(HOME));
  share.project.place = (home) => path.join(disk, path.basename(home));
  const reports: Array<(rel: string) => void> = [];
  share.project.watch = (_root, report) => { reports.push(report); return { close: () => { reports.splice(reports.indexOf(report), 1); } }; };
  share.project.retryMs = [];
  pc.handlers.set(SHARE_METHOD, (params, from) => share.receive(params, from));
  return Object.assign(pc, {
    share, data, disk, root, homes: known,
    report: (...rels: string[]) => { for (const rel of rels) for (const report of reports) report(rel); },
    changed: async (...rels: string[]) => { for (const rel of rels) for (const report of reports) report(rel); await share.project.flush(MARA); },
    write: async (rel: string, text: string, mtime?: number) => {
      const file = path.join(root, ...rel.split('/'));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
      if (mtime !== undefined) await utimes(file, mtime / 1000, mtime / 1000);
    },
    read: (rel: string) => readFile(path.join(root, ...rel.split('/')), 'utf8').catch(() => undefined),
  });
}

/** Waits until `done` holds (the mirrors work in the background); throws after two seconds. */
export async function until(done: () => boolean | Promise<boolean>, what = 'it'): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`${what} did not happen`);
}

/** Lets the background work of every PC run out. */
export const calm = async (): Promise<void> => { for (let i = 0; i < 40; i++) await new Promise((resolve) => setTimeout(resolve, 5)); };

export type FakeProfile = ContextLike & { state: StorageStateLike; sets: number; reads: number };

/** A browser profile that hands out and takes its storage state like Playwright's context. */
export function profile(state: StorageStateLike): FakeProfile {
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const context = {
    state, sets: 0, reads: 0,
    pages: () => [], newPage: async () => { throw new Error('no page'); }, close: async () => {}, on: () => undefined, setDefaultTimeout: () => {},
    storageState: async () => { context.reads++; return copy(context.state); },
    setStorageState: async (next: StorageStateLike) => { context.sets++; context.state = copy(next); },
  };
  return context as unknown as FakeProfile;
}

export const sessionOf = (context: ContextLike, usedAt: number, agentId = MARA): Session => ({ agentId, context, usedAt } as unknown as Session);

export const cookie = (name: string, value: string, domain = 'example.com') => ({ name, value, domain, path: '/' });
