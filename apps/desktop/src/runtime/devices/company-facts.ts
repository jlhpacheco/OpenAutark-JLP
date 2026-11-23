// The company an employee's PC belongs to (owner 21.11.2026: "da steht wieder company-2, obwohl die Firma … ganz anders
// heißt … unten drunter … ob man CEO ist oder … wie man darin heißt … die Firma soll nur eine Remote-ID haben"). The
// company's PC answers 'company.facts' to the PCs of its employees: the company's name, its one Remote ID (the person
// code of its PCs, remote/code.ts) and how the person is named there (name, title, a CEO member). The employee's PC asks
// each time its employer link comes up, keeps the answer in kv and writes the company's name into its own
// profile.company – so companies.list, the profile menu and the agents name the company after the firm, never after its
// folder ("company-2"). The Remote ID row of this company then shows the company's ID (remote/service.ts companyCode),
// the one code everybody shares, and the person's own row here carries their title there (not "CEO").
// Fest 22.11.2026 ("Stand statt Nachricht", contract rule 6: never store a fallback): the facts come again with every
// round of the link's catch-up rhythm ('sync.round', sync/service.ts – every 2 min), so a renamed company or person heals on
// its own, and a name stored before (an older version wrote the employer PC's name) is overwritten by the next answer
// that names the company. Nothing but the company's answer is written: a company PC that does not know the method yet
// (older version) leaves profile.company as it is, and the Remote ID to that PC's own. The name the company knows the
// person by fills an empty profile.name here (a name the person chose stays; join.ts keeps the one typed while joining).
// Owner 21.11.2026 (photos: on the employee's PC the CEO's lines read "Former member"): the answer also names the
// company's people – id as the person sees it ('owner' = the CEO here), name and title, nothing else – so that PC names
// every colleague in chats, calls and the team (employerPeople → people.list / nameOf there).
// Eine-ID 22.11.2026 (one Company ID on every member's PC): the company PC signs the asking PC into its company tree and
// answers its chain; the employee's PC keeps that chain as its company tree (remote/code.ts adoptChain – only when it
// ends at its own key), so it answers for the Company ID itself. When its last employer link goes, that tree goes too.
// Owns: the method, its answer, its rhythm, the kv entry and the names it writes. Never: answers a link that is not an
// employee's, tells an employee anything beyond these facts and its own chain (no contact data, scopes, devices or
// invites), or stores a name the company did not answer.

import type { RuntimeServices } from '../contracts.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { DEFAULT_PERSON_SCOPES, OWNER_ALIAS, type Person } from '../../shared/model/people.ts';
import { defaultAvatar } from '../org/avatar.ts';
import { viewId } from '../people/perspective.ts';
import { chainIn, codeFor, employerPc, type Chain } from '../remote/code.ts';
import { remoteIdOf } from '../remote/id.ts';
import { KvRepo } from '../store/kv.ts';
import { fingerprintOf, fromB64url } from './keys.ts';
import type { DeviceMesh } from './mesh.ts';
import { DevicesRepo } from './repo.ts';
import { links } from './sync/home.ts';

export const FACTS_METHOD = 'company.facts';
const NS = 'company.employer';
const KEY = 'facts';
const ASK_MS = 10_000;
const REMOTE_ID = /^\d{9}$/;
const COLLEAGUE_ID = /^(owner|per_[0-9a-z]{8,40})$/;
const MAX_PEOPLE = 500;

/** A colleague as the company names them to an employee's PC (id in that person's terms). */
export interface Colleague { id: string; name: string; title: string; ceo?: true; pcs?: ColleaguePc[] }
/** 21.11.2026 (pane between people): a colleague's PC, so an employee's PC can put a tab there (runtime/pane/relay.ts). */
export interface ColleaguePc { id: string; name: string }
const PC_ID = /^[\w.:-]{1,128}$/;

/** What the company's PC tells an employee's PC. */
export interface CompanyFacts {
  company?: string;
  /** The company's Remote ID (9 digits). */
  code?: string;
  /** How the person is named in that company. */
  person?: { name: string; title: string; ceo?: true };
  /** The company's other people (the CEO as 'owner'). */
  people?: Colleague[];
  /** Eine-ID 22.11.2026: the asking PC's chain into the company tree – it keeps it (remote/code.ts adoptChain), not in kv. */
  chain?: Chain;
}

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** An answer as this PC keeps it: only the known keys, texts cut, a code only when it has 9 digits. */
export function cleanFacts(value: unknown): CompanyFacts {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const person = (raw.person && typeof raw.person === 'object' ? raw.person : undefined) as Record<string, unknown> | undefined;
  const company = text(raw.company, 80);
  const code = typeof raw.code === 'string' && REMOTE_ID.test(raw.code) ? raw.code : '';
  const name = text(person?.name, 80);
  const people = (Array.isArray(raw.people) ? raw.people : []).slice(0, MAX_PEOPLE).flatMap((entry): Colleague[] => {
    const row = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const colleague = text(row.name, 80);
    if (typeof row.id !== 'string' || !COLLEAGUE_ID.test(row.id) || !colleague) return [];
    const pcs = (Array.isArray(row.pcs) ? row.pcs : []).slice(0, 20).flatMap((pc): ColleaguePc[] => {
      const item = (pc && typeof pc === 'object' ? pc : {}) as Record<string, unknown>;
      return typeof item.id === 'string' && PC_ID.test(item.id) ? [{ id: item.id, name: text(item.name, 80) || 'PC' }] : [];
    });
    return [{ id: row.id, name: colleague, title: text(row.title, 80), ...(row.ceo === true ? { ceo: true as const } : {}), ...(pcs.length ? { pcs } : {}) }];
  });
  return {
    ...(company ? { company } : {}),
    ...(code ? { code } : {}),
    ...(person && name ? { person: { name, title: text(person.title, 80), ...(person.ceo === true ? { ceo: true as const } : {}) } } : {}),
    ...(people.length ? { people } : {}),
  };
}

/** The company's people as this employee's PC shows them (people.list, names): read-only rows, never its own people. */
export function employerPeople(s: Pick<RuntimeServices, 'db'>): Person[] {
  return (employerFacts(s)?.people ?? []).map((colleague) => ({
    id: colleague.id, name: colleague.name, title: colleague.ceo ? colleague.title || 'CEO' : colleague.title,
    avatar: defaultAvatar(colleague.id, colleague.name), status: 'active', owner: false, role: colleague.ceo ? 'ceo' : 'member',
    scopes: DEFAULT_PERSON_SCOPES, createdAt: 0, updatedAt: 0, fromEmployer: true,
  }));
}

/** The company's people in an employee's terms: everyone not revoked but that person ('human' here becomes 'owner'). */
function colleaguesFor(s: Pick<RuntimeServices, 'people' | 'settings' | 'db'>, personId: string): Colleague[] {
  return (s.people?.list() ?? []).filter((person) => person.status !== 'revoked' && person.id !== personId).slice(0, MAX_PEOPLE).map((person) => {
    const id = viewId(personId, person.id);
    const name = id === OWNER_ALIAS ? text(s.settings.get().profile.name, 80) || person.name : person.name;
    const pcs = links(s.db).flatMap(({ record, link }) => (link.kind === 'employee' && link.personId === person.id ? [{ id: record.id, name: record.name }] : []));
    return { id, name, title: person.title ?? '', ...(person.role === 'ceo' || id === OWNER_ALIAS ? { ceo: true as const } : {}), ...(pcs.length ? { pcs } : {}) };
  }).filter((colleague) => COLLEAGUE_ID.test(colleague.id) && colleague.name);
}

/** The facts this PC last heard from its employer's PC; undefined where it is no employee's PC or never heard any. */
export function employerFacts(s: Pick<RuntimeServices, 'db'>): CompanyFacts | undefined {
  try { return new KvRepo(s.db).get<CompanyFacts>(NS, KEY); } catch { return undefined; }
}

/** The company's Remote ID on an employee's PC: what its PC told, else that PC's own ID; undefined on a company's own PCs. */
export function companyCode(s: Pick<RuntimeServices, 'db'>): string | undefined {
  try {
    const pc = employerPc(s.db);
    if (!pc) return undefined;
    return employerFacts(s)?.code ?? remoteIdOf(pc.fingerprint);
  } catch {
    return undefined;
  }
}

/**
 * Owner 22.11.2026 ("die gleiche Firma zweimal … nur mit unterschiedlichen Nutzern"): the person's name on an employee's
 * PC as the company told it, so the LAN hello reads "Dojo · Momo" beside the company's own "Dojo"; undefined on the
 * company's own PCs.
 */
export function seatPerson(s: Pick<RuntimeServices, 'db'>): string | undefined {
  try { return employerPc(s.db) ? employerFacts(s)?.person?.name || undefined : undefined; } catch { return undefined; }
}

/** The name this company gives itself: profile.company, else the person's name (never a folder). */
function ownName(s: Pick<RuntimeServices, 'settings'>): string {
  const profile = s.settings.get().profile;
  return text(profile.company, 80) || text(profile.name, 80);
}

/** Writes the company's `name` into profile.company where it differs (the menu, companies.list and the agents read it there). */
function nameCompany(s: Pick<RuntimeServices, 'settings' | 'log'>, name: string): void {
  if (!name || text(s.settings.get().profile.company, 80) === name) return;
  try { s.settings.update({ profile: { company: name } }); } catch (error) { s.log.warn('company name not kept', { error: String(error) }); }
}

/** Fest 22.11.2026: the name the company knows the person by fills an empty profile.name here (a name already there stays). */
function nameMe(s: Pick<RuntimeServices, 'settings' | 'log'>, name: string): void {
  if (!name || text(s.settings.get().profile.name, 80)) return;
  try { s.settings.update({ profile: { name } }); } catch (error) { s.log.warn('own name not kept', { error: String(error) }); }
}

/** The person's own row here names them as their company does ("Designer", "CEO" for a CEO member, else "Employee") – not "CEO". */
function titleMe(s: Pick<RuntimeServices, 'people' | 'log'>, facts: CompanyFacts): void {
  if (!facts.person || !s.people) return;
  const title = facts.person.ceo ? 'CEO' : facts.person.title || 'Employee';
  try {
    if (s.people.get(HUMAN_ID)?.title !== title) s.people.save({ id: HUMAN_ID, title });
  } catch (error) { s.log.warn('own title not kept', { error: String(error) }); }
}

/**
 * Both sides: answers 'company.facts' to an employee's PC, and – on an employee's PC – asks its employer's PC each time
 * that link comes up and at every round of that link's catch-up rhythm ('sync.round');
 * `changed` after an answer that differs from the one kept (the Remote ID row shows the company's ID). Returns the off switch.
 */
export function startCompanyFacts(s: RuntimeServices, mesh: Pick<DeviceMesh, 'register' | 'call' | 'selfInfo'>, changed: () => void): () => void {
  mesh.register(FACTS_METHOD, async (_params, from) => {
    const record = new DevicesRepo(s.db).get(from);
    const personId = record?.personId;
    const person = personId ? s.people?.get(personId) : undefined;
    const fingerprint = fingerprintOf(fromB64url(mesh.selfInfo().pub));
    const facts: CompanyFacts = {
      ...(ownName(s) ? { company: ownName(s) } : {}),
      code: codeFor(fingerprint)?.code() ?? remoteIdOf(fingerprint),
      ...(person ? { person: { name: person.name, title: person.title ?? '', ...(person.role === 'ceo' ? { ceo: true as const } : {}) } } : {}),
      ...(personId ? { people: colleaguesFor(s, personId) } : {}),
      ...memberChain(fingerprint, record?.publicKey),
    };
    return facts;
  }, ['employee']);

  const ask = async (pcId: string) => {
    try {
      const answer = await mesh.call(pcId, FACTS_METHOD, {}, undefined, ASK_MS);
      codeFor(fingerprintOf(fromB64url(mesh.selfInfo().pub)))?.adoptChain((answer as { chain?: unknown } | null)?.chain);
      const facts = cleanFacts(answer);
      const kv = new KvRepo(s.db);
      const fresh = JSON.stringify(facts) !== JSON.stringify(kv.get<CompanyFacts>(NS, KEY));
      if (fresh) kv.set(NS, KEY, facts, s.clock.now());
      nameCompany(s, facts.company ?? '');
      nameMe(s, facts.person?.name ?? '');
      titleMe(s, facts);
      if (fresh) changed();
    } catch {
      // an older company PC (no such method) or none in reach: what this PC knows stays, the next answer brings the rest
    }
  };
  const isEmployer = (peer: string) => links(s.db).some(({ record, link }) => record.id === peer && link.kind === 'employer' && record.status === 'online');
  const off = s.bus.on('device.upserted', (device) => {
    if (device?.kind !== 'pc' || device.self || device.joinedAs !== 'employee') return;
    if (device.status === 'online') void ask(device.id);
    // Eine-ID 22.11.2026: the last employer link went – this PC is its own company again (its own ID as the Company ID)
    if (device.status === 'revoked' && !employerPc(s.db)) codeFor(fingerprintOf(fromB64url(mesh.selfInfo().pub)))?.clear();
  });
  // Fest 22.11.2026: the link's catch-up rhythm (sync/service.ts announces each round) – no timer of its own.
  const offRound = s.bus.on('sync.round', ({ peer }) => { if (isEmployer(peer)) void ask(peer); });
  return () => { off(); offRound(); };
}

/** Eine-ID 22.11.2026: the asking member PC signed into my company tree, and its chain from the root (it keeps it). */
function memberChain(fingerprint: string, pub: string | undefined): { chain: Chain } | Record<string, never> {
  const tree = codeFor(fingerprint);
  if (!tree || !pub) return {};
  tree.sign(pub);
  const chain = chainIn(tree.tree(), fingerprintOf(fromB64url(pub)));
  return chain?.links.length ? { chain } : {};
}
