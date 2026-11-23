// What a company on this PC offers, as rules both places use (16.11.2026 Settings › General › Companies; 20.11.2026 the
// profile menu's ⋯ beside each company – owner: "ein Drei-Punkte-Menü ... neben der Firma ... dass man da austreten kann
// ... wie Account-Einstellung"): whether taking it off this PC is a Leave (others keep it: an employee's company or one
// with linked PCs) or a Delete, the line under its name, and the ⋯ menu's rows – for the company open here its account
// pages (Profile, Devices, Models & sign-ins: Settings pages that exist), then Export… and Leave or Delete for any.
// Owns: these rules. Never: calls the runtime, opens a page or asks the person (settings/CompaniesGroup.tsx and
// shell/ProfileMenu.tsx do).

import type { CompanyEntry } from '../../shared/model/companies.ts';

export const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

/** The others keep it – an employee's company or one with linked PCs: Leave, else Delete. */
export const leaves = (entry: CompanyEntry): boolean => entry.role === 'employee' || (entry.linkedPcs?.length ?? 0) > 0;

/** The line under the name: the folder, "this one" or whether it runs, the role and the linked PCs. */
export function companyLine(entry: CompanyEntry): string {
  const pcs = entry.linkedPcs?.length ?? 0;
  const state = entry.current ? 'this one' : entry.running === false ? 'not running' : '';
  return [entry.folder, state, entry.role === 'employee' ? 'employee' : '', pcs ? plural(pcs, 'linked PC') : ''].filter(Boolean).join(' · ');
}

/** One row of a company's ⋯ menu; `action` names what the caller does with it. */
export type CompanyAction = 'profile' | 'devices' | 'models' | 'export' | 'leave' | 'delete';
export interface CompanyRow { action: CompanyAction; label: string; description?: string; disabled?: boolean; danger?: boolean }

/**
 * A company's ⋯ menu: the open one's account pages first (its Settings live in this window), Export… where a folder can be
 * picked (another company exports itself while it runs), then Leave or Delete – off for the only company on this PC.
 */
export function companyMenu(entry: CompanyEntry, options: { only: boolean; canExport: boolean }): CompanyRow[] {
  const rows: CompanyRow[] = entry.current ? [
    { action: 'profile', label: 'Profile', description: 'Your name, photo and the company name' },
    { action: 'devices', label: 'Devices', description: 'This PC, linked PCs and phones' },
    { action: 'models', label: 'Models & sign-ins', description: 'The plans and keys the agents use' },
  ] : [];
  if (options.canExport) rows.push({ action: 'export', label: 'Export…', description: 'A copy to open in Autark elsewhere', disabled: !entry.current && entry.running === false });
  const keeper = entry.role === 'employee' ? 'the firm keeps it' : 'your linked PCs keep it';
  rows.push(options.only
    ? { action: leaves(entry) ? 'leave' : 'delete', label: leaves(entry) ? 'Leave' : 'Delete', description: 'The only company on this PC', disabled: true, danger: true }
    : leaves(entry)
      ? { action: 'leave', label: 'Leave', description: `This PC leaves, ${keeper}`, danger: true }
      : { action: 'delete', label: 'Delete', description: 'From this PC, to the recycle bin', danger: true });
  return rows;
}
