// A PC for the pane tests (src/runtime/pane): an in-memory database with linked PCs, a temp data folder for
// side-tabs.json, a fake side browser and a fake mesh that records every call.
// Owns: the rig. Never: assertions.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import type { SideBrowserCall } from '../../../src/shared/model/side-browser.ts';
import type { DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import { readSideTabs, sideTabsFile } from '../../../src/runtime/root/side-tabs.ts';
import { record } from '../devices/sync-net.ts';
import { memoryDb } from '../devices/fakes.ts';

export interface Call { device: string; method: string; params: Record<string, unknown> }

export function paneRig(options: { self?: string; pcs?: Array<[string, Partial<DeviceRecord>]>; online?: string[]; manager?: string; reply?: (call: Call) => unknown } = {}) {
  const db = memoryDb();
  const repo = new DevicesRepo(db);
  const self = options.self ?? 'dev_tower';
  repo.upsert(record(self, { self: true, name: 'Tower' }));
  for (const [id, extra] of options.pcs ?? []) repo.upsert(record(id, extra));
  const data = mkdtempSync(path.join(tmpdir(), 'pane-'));
  const calls: Call[] = [];
  const opened: SideBrowserCall[] = [];
  const people = [{ id: 'human', name: 'Mara', status: 'active' }, { id: 'per_momo1234', name: 'Momo', status: 'active' }, { id: 'per_lena1234', name: 'Lena', status: 'active' }];
  let at = 1000;
  const services = {
    db,
    clock: { now: () => ++at },
    paths: { data },
    devices: {
      self: () => ({ id: self, name: 'Tower' }),
      online: (id: string) => (options.online ?? []).includes(id),
      call: async (device: string, method: string, params: Record<string, unknown>) => {
        const call = { device, method, params };
        calls.push(call);
        return options.reply ? options.reply(call) : method === 'pane.put' ? { id: 'web-far' } : { ok: true };
      },
    },
    host: { sideBrowser: async (call: SideBrowserCall) => { opened.push(call); return { ok: true, tab: 'web-new' }; } },
    people: { list: () => people, nameOf: (id: string) => people.find((person) => person.id === id)?.name },
    org: { get: (id: string) => ({ id, name: 'Ada', ...(options.manager ? { managerId: options.manager } : {}) }) },
  } as unknown as RuntimeServices;
  return {
    services, calls, opened, data, repo,
    spaces: () => readSideTabs(sideTabsFile(data)) ?? {},
    cleanup: () => rmSync(data, { recursive: true, force: true }),
  };
}
