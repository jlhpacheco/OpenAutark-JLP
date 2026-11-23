// Several companies on one PC (B-072, owner 04.11.2026: "das sind nicht Accounts bei uns, sondern ... einfach neue Firmen"):
// a company is one data folder with its own chats, agents, settings, secrets and linked devices. The first is the app's
// own folder; every other one lies in "<first> Companies/<id>" beside it. companies.list names them; companies.open
// switches: that company's window opens (it starts when it does not run) and this one goes to the tray, its agents keep
// working. A new company starts with the normal first run; joining another company (Eine-ID: as a new member with its company ID, or as one of my devices with my ID) is connecting
// to that company's PC (remote.connect). B-075 (owner 04.11.2026, an agent could not find the other company): the company
// asked names its own role and linked PCs in companies.list, and companies.tool runs one agent tool in it for an agent of
// another company on this PC (tools.call with company – runtime/tools/placement.ts); both runtimes reach each other over
// loopback with the owner token of the other's runtime.json (parseRuntimeFile, the same rule in main and runtime).
// 16.11.2026 (owner: "die Firmen nur wie Konten ... austreten ... löschen ... exportieren ... importieren"): companies
// are like accounts in one app. Each entry names its folder ("first", "company-2"), so two of the same name are told
// apart. companies.remove takes one off this PC: it stops, its folder goes to the recycle bin and a removal mark
// (REMOVED_FILE) keeps it out of every list and start until then; the first one may go too once another exists – a plain
// start then opens the next one (main/company-remove.ts). companies.export writes a backup plus its secrets file into a
// chosen folder, companies.import makes such an export a new company here (runtime/portability/company.ts).
// Owns: the id and folder rules (the logins folder beside the companies is none), the label rule, the runtime.json
// rule, the removal mark's name and the methods' contract. Never: behaviour
// (runtime/root/companies.ts lists and calls, main/companies.ts opens and stops, main/company-remove.ts removes).

/** A company's folder name: lower-case letters, digits and dashes ("company-2"). */
export const COMPANY_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Windows device names, which no folder may carry ("con", "nul", "com1" …). */
const DEVICE_NAME = /^(con|prn|aux|nul|com\d|lpt\d)$/;

/** The folder beside the companies that holds this PC's plan logins, shared by all of them (runtime/root/companies.ts loginsFolder): never a company. */
export const LOGINS_FOLDER = 'logins';

export function isCompanyId(value: unknown): value is string {
  return typeof value === 'string' && COMPANY_ID.test(value) && !DEVICE_NAME.test(value) && value !== LOGINS_FOLDER;
}

/** The first company's folder as lists and agents name it (its data folder is the app's own and has no company id). */
export const FIRST_FOLDER = 'first';

/** A company's folder as lists and agents name it: its id, or 'first' for the first one. */
export const folderOf = (entry: { id: string | null }): string => entry.id ?? FIRST_FOLDER;

/** The next free id: company-2, company-3, … */
export function nextCompanyId(taken: readonly string[]): string {
  for (let n = 2; ; n += 1) if (!taken.includes(`company-${n}`)) return `company-${n}`;
}

/** 16.11.2026: the mark in a company's folder that it is being removed from this PC ({at, name}); main/company-remove.ts. */
export const REMOVED_FILE = 'company-removed.json';

/** The person's place in a company: its owner (the CEO), or an employee of another firm whose data it holds (it joined that firm's PC as an employee). */
export type CompanyRole = 'owner' | 'employee';

/**
 * B-078: how a new company from the company menu's "+" starts (main passes it as `--start=`): its own first run ('new'),
 * or (Eine-ID 22.11.2026) connecting by an ID ('join') – a company's ID makes it a new member there, a person's ID one
 * of that person's devices; the ID decides, nobody picks a role.
 */
export type CompanyStart = 'new' | 'join';

export function isCompanyStart(value: unknown): value is CompanyStart {
  return value === 'new' || value === 'join';
}

/** One company on this PC; `id` null = the first one (the app's own data folder); `current` = the one asked. */
export interface CompanyEntry {
  id: string | null;
  label: string;
  /** 16.11.2026: its folder (folderOf) – tells two companies of the same name apart. */
  folder: string;
  current: boolean;
  /** B-075: the person's role there – on the current entry, and on a running other one where its facts were asked. */
  role?: CompanyRole;
  /**
   * Owner 21.11.2026 ("unten drunter … ob man CEO ist oder … wie man darin heißt"): where the person is an employee, how
   * that company names them – "Designer · Kim", "CEO · Kim" for a CEO member (runtime/devices/company-facts.ts). roleLine reads it.
   */
  title?: string;
  /** B-075: its linked PCs (not removed or half-paired) and whether each is online – where `role` is named. */
  linkedPcs?: Array<{ name: string; online: boolean }>;
  /** 16.11.2026: only where the others' facts were asked – whether this other company runs now. */
  running?: boolean;
  /** B-078: only on the current entry – how this start was asked for (`--start=`; its first run opens that way). */
  start?: CompanyStart;
}

/** The small line under a company in the profile menu: "CEO" where it is the person's own, else how that company names them. */
export function roleLine(entry: Pick<CompanyEntry, 'role' | 'title'>): string {
  if (entry.role === 'owner') return 'CEO';
  if (entry.role === 'employee') return entry.title || 'Employee';
  return '';
}

/** A company's name: profile.company of its settings, else the person's name there, else its folder ("First company"). */
export function companyLabel(profile: { company?: unknown; name?: unknown } | null | undefined, id: string | null): string {
  const pick = (value: unknown) => (typeof value === 'string' ? value.trim().slice(0, 80) : '');
  return pick(profile?.company) || pick(profile?.name) || (id ?? 'First company');
}

/** The file a company's runtime writes once it listens: {port, token, pid} (runtime/main.ts). */
export const RUNTIME_FILE = 'runtime.json';

/** runtime.json's text as {port, token, pid} – a port in range and a header-safe token –, else null. */
export function parseRuntimeFile(text: string): { port: number; token: string; pid: number } | null {
  try {
    const { port, token, pid } = JSON.parse(text) as { port?: unknown; token?: unknown; pid?: unknown };
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
    if (typeof token !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(token) || typeof pid !== 'number' || !Number.isInteger(pid)) return null;
    return { port, token, pid };
  } catch {
    return null;
  }
}

/** B-075: one agent tool call another company on this PC sends here (its registry checked it there; `from` is its name). */
export interface CompanyToolCall {
  name: string;
  args?: Record<string, unknown>;
  agentId: string;
  agentName?: string;
  runId: string;
  mode?: string;
  from?: string;
}

declare module '../api/methods.ts' {
  interface Methods {
    /**
     * B-072: the companies on this PC, the first one first; empty where there are none (a test profile, headless). B-075:
     * the current one with its role and linked PCs. 16.11.2026: `facts` – each other company says whether it runs, and a
     * running one its own role and linked PCs (asked from it over loopback).
     */
    'companies.list': { params: { facts?: boolean } | void; result: { companies: CompanyEntry[] } };
    /**
     * 16.11.2026: takes a company off this PC – id from companies.list, null = the first one. It stops, its start at
     * sign-in goes, and its folder moves to the recycle bin (the first one's: its data, not the app's own profile; its
     * workspace folder stays); linked PCs and phones keep their copy. The company open here goes too: the next one opens
     * and this one quits. Refused for the only company on this PC. 20.11.2026: a running company leaves first – its live
     * linked PCs drop this PC (device.bye 'left', runtime/devices/away.ts).
     */
    'companies.remove': { params: { id: string | null }; result: { ok: true } };
    /**
     * 16.11.2026: exports a company (none = this one; another one exports itself while it runs) into a new folder inside
     * `dir`: a backup (system.backup) plus secrets.csv with the secrets' values readable (secrets.export), so another
     * Autark opens it with companies.import. `dir` is absolute and outside the company's data folder.
     */
    'companies.export': { params: { id?: string | null; dir: string }; result: { path: string; bytes: number; secrets: number } };
    /** 16.11.2026: makes an export (or any backup folder) a new company on this PC; its window opens and its first start puts the data in. */
    'companies.import': { params: { path: string }; result: { ok: true; id: string } };
    /**
     * B-072: switches to a company – id from companies.list, null or none = the first one – or starts a new one (create: true;
     * with an id: that folder name). Its window opens, this one goes to the tray and keeps working. B-078: `start` with
     * create – 'join' opens the new company's first run at connecting by an ID.
     */
    'companies.open': { params: { id?: string | null; create?: boolean; start?: CompanyStart }; result: { ok: true; id: string | null } };
    /**
     * B-075: runs one agent tool here for an agent of another company on this PC (tools.call with company) and returns its
     * output, values of this company's secrets masked; refused where the person is an employee of another firm.
     */
    'companies.tool': { params: CompanyToolCall; result: { content: Array<Record<string, unknown>>; isError?: boolean; effect?: { status: 'confirmed' | 'unknown' | 'failed'; externalId?: string } } };
  }
}
