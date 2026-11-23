// B-072: companies.list and companies.open, the companies on this PC (shared/model/companies.ts) for the profile menu and
// for agents (wf call companies.list). The list comes from the data folders (runtime/root/companies.ts); opening one is
// main's (host op company.open, main/companies.ts). B-075: the list names the current company's role and linked PCs, and
// companies.tool runs one agent tool here for an agent of another company on this PC (tools/builtin/companies.ts). Owner
// scope: all are about this PC (another company's runtime calls with this one's owner token, over loopback).
// 16.11.2026: companies.list with facts (each other company's own, for Settings › General › Companies), companies.remove
// (main takes it off this PC: main/company-remove.ts), companies.export (this one here, another one by itself over
// loopback) and companies.import (portability/company.ts). 20.11.2026 (owner: "austreten"): the company taken off is this
// one (its folder is this runtime's data folder – from its window, or main asking it over loopback after writing the
// removal mark) – it first says the goodbye 'left' to every live link (devices/away.ts), so its linked PCs drop this PC
// and keep the company. A company that does not run says none (main removes it without starting it).
// Owns: these registrations and their params. Never: the folder rule, starting or removing a company or running a tool itself.

import path from 'node:path';
import '../../../shared/model/companies.ts'; // the method shapes (module augmentation)
import { WorkforceError } from '../../../shared/errors.ts';
import { isCompanyId, isCompanyStart } from '../../../shared/model/companies.ts';
import { exportCompany, importCompany } from '../../portability/company.ts';
import { callCompany, companyFolder, listCompanies, withOtherFacts } from '../../root/companies.ts';
import { runCompanyTool, withOwnFacts } from '../../tools/builtin/companies.ts';
import { bad, input, onlyKeys, optBool, optObj, optText, text } from '../params.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';
import type { MeshApi } from '../extras.ts';
import type { DeviceMesh } from '../../devices/mesh.ts';
import { LEFT } from '../../devices/away.ts';

/** How long companies.list with facts waits for each other company's own. */
const FACTS_MS = 3_000;

/** A company id from companies.list, or null for the first one. */
const companyId = (raw: unknown): string | null => (raw === null ? null : isCompanyId(raw) ? raw : bad('id', 'a company id from companies.list, or null for the first company'));

/** The goodbye 'left' to every live link (at most BYE_MS); a mesh without it (a test profile) has none to tell. */
const leave = (ctx: HandlerContext): Promise<void> => (ctx.extras.mesh as (MeshApi & Partial<Pick<DeviceMesh, 'bye'>>) | undefined)?.bye?.(LEFT) ?? Promise.resolve();

/** An absolute path param (paths on this PC never resolve against the runtime's cwd). */
function absolute(o: Record<string, unknown>, key: string): string {
  const value = text(o, key, { max: 4096 });
  return path.isAbsolute(value) ? value : bad(key, 'an absolute path');
}

export function register(table: HandlerTable): void {
  table.add('companies.list', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['facts']);
    const { app } = ctx.services.host;
    const companies = withOwnFacts(ctx.services, listCompanies(app));
    return { companies: optBool(o, 'facts') === true ? await withOtherFacts(app, companies, { signal: ctx.signal, timeoutMs: FACTS_MS }) : companies };
  });
  table.add('companies.remove', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id']);
    if (!('id' in o)) bad('id', 'a company id from companies.list, or null for the first company');
    const id = companyId(o.id);
    const { host } = ctx.services;
    if (!host.removeCompany || !host.app.companies) throw new WorkforceError('unavailable', 'Companies are removed only in the desktop app.');
    const all = listCompanies(host.app); // a company main already marked for removal is no longer in it
    const self = path.resolve(companyFolder(host.app, id)!) === path.resolve(host.app.dataDir); // by its folder: main asks a marked one over loopback
    if (self && all.some((item) => item.id !== id)) await leave(ctx); // this PC leaves the company (the only one stays, main/company-remove.ts): its linked PCs drop it before it stops
    const name = all.find((item) => item.id === id)?.label;
    return host.removeCompany({ id, ...(name ? { name } : {}) });
  });
  table.add('companies.export', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'dir']);
    const dir = absolute(o, 'dir');
    const entries = listCompanies(ctx.services.host.app);
    const id = o.id === undefined ? undefined : companyId(o.id);
    const entry = id === undefined ? entries.find((item) => item.current) : entries.find((item) => item.id === id);
    if (id !== undefined && !entry) throw new WorkforceError('not_found', 'There is no company with this id on this PC (companies.list).');
    if (entry && !entry.current) { // another company exports itself: its data and secrets are its own
      const folder = companyFolder(ctx.services.host.app, entry.id)!;
      return callCompany(folder, 'companies.export', { dir }, { signal: ctx.signal }) as Promise<{ path: string; bytes: number; secrets: number }>;
    }
    const name = entry?.label ?? ctx.services.settings.get().profile?.company ?? '';
    return exportCompany(ctx.services, (folder) => ctx.extras.portability.backup(folder), dir, name);
  });
  table.add('companies.import', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['path']);
    return importCompany(ctx.services, absolute(o, 'path'));
  });
  table.add('companies.open', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'create', 'start']);
    const id = o.id === undefined ? null : companyId(o.id);
    const create = optBool(o, 'create') === true;
    const start = o.start === undefined ? undefined : isCompanyStart(o.start) ? o.start : bad('start', "'new' or 'join'");
    const { host } = ctx.services;
    if (!host.openCompany || !host.app.companies) throw new WorkforceError('unavailable', 'Other companies open only in the desktop app.');
    return host.openCompany(create ? { id, create, ...(start ? { start } : {}) } : { id });
  });
  table.add('companies.tool', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['name', 'args', 'agentId', 'agentName', 'runId', 'mode', 'from']);
    const call = {
      name: text(o, 'name', { max: 120 }), args: optObj(o, 'args') ?? {}, agentId: text(o, 'agentId', { max: 200 }), agentName: optText(o, 'agentName', { max: 200 }),
      runId: text(o, 'runId', { max: 200 }), mode: optText(o, 'mode', { max: 200 }), from: optText(o, 'from', { max: 200 }),
    };
    return runCompanyTool(ctx.services, call, ctx.signal);
  });
}
