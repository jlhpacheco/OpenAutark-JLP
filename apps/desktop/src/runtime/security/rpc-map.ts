// What an RPC method needs from an owner session that is not the person (Sicher-Runde FX1 19.11.2026): an agent's own
// `wf` (owner scope with its id) or anything that read <data>/runtime.json (owner scope without `person`). Three kinds:
// - 'person': the person's own step in every mode – what changes the security setup or hands out power (a device or
//   person token, a linked PC, the secrets' values, a restore of old data); the app takes it only from the window,
//   main's link, the person token or the person's paired phone (rpc-guard.ts).
// - 'open': reads and the team's own work (chats, tasks, to-dos, knowledge …) – what a to-do-only phone also reaches.
// - 'switch': every other method that changes something, by family the switch a tool call of the same kind passes
//   (settings/agents/skills/modes/… → setup, secrets/accounts/apps → accounts, files by their path → read/write,
//   bridges/feedback → message, …); a write method nobody named → setup.
// REVIEW-2 (19.11.2026): a file method keeps its path also with `device` (the linked PC shares these settings and gates its
// own files.path once more, devices/sync/paths.ts); computer.preview is the computer switch, chats.export {dir} writes,
// spaces.save is team, bridges.connectTelegram accounts.
// Owns: these tables and methodNeed(). Never: decides open/ask (policy.ts), asks or refuses (rpc-guard.ts).

import type { SecuritySwitch } from '../../shared/model/security-settings.ts';

export type MethodNeed =
  | { kind: 'person' }
  | { kind: 'open' }
  | { kind: 'switch'; capability: SecuritySwitch; path?: string };

/** The person's own methods: the security setup and whatever hands out power (tokens, links, values, old data). */
export const PERSON_ONLY: ReadonlySet<string> = new Set([
  'security.saveTopic', 'security.answer', // the security texts and the answers to its requests
  'secrets.export', 'companies.export', // the stored values, readable
  'system.restore', // old data back – an older security section with it
  'pwa.link', 'phone.pairLink', 'people.invite', // a new device or person token
  'remote.connect', 'remote.decide', // a linked PC: its settings and tool calls reach this one
  'remote.name', // Eine-ID: the name I give myself as a new member of another company
  'remote.confirm', // review H1: yes to this PC becoming one of another person's devices (a full mirror)
  'bridges.linkOwner', // a chat account that speaks as the person
]);

/** Method names (the part after the family) that only read or show. */
const READS: ReadonlySet<string> = new Set([
  'list', 'get', 'read', 'search', 'state', 'status', 'info', 'history', 'thread', 'members', 'preview', 'sources', 'catalog',
  'topics', 'requests', 'apps', 'uses', 'recent', 'getPolicy', 'meta', 'items', 'positions', 'position', 'activity', 'log',
  'runs', 'core', 'templates', 'org', 'groups', 'folder', 'fillChoices', 'diagnostics', 'resources', 'root',
  'restartReadiness', 'restoreStatus', 'localModels', 'forModel', 'methods', 'pcs', 'audit', 'chats', 'pushConfig', 'pull',
  'pullPart', 'subscribe', 'unsubscribe', 'awaitJoin', 'nearby', 'validateAdd', 'appHtml', 'file', 'sandboxUrl', 'live',
  'realtimePull', 'providerHistories', 'openFolder', 'openHome', 'export', 'refresh', 'securityLog', 'detect', 'test',
  'inboxList', 'inboxFetch', 'inboxImage',
]);

/** Families of the team's own work: open for an agent's `wf` in every mode (the tools of the same kind are, too). */
const WORK: ReadonlySet<string> = new Set([
  'chats', 'messages', 'tasks', 'todos', 'day', 'knowledge', 'notes', 'references', 'pages', 'events', 'session', 'rpc',
  'runs', 'splits', 'ui', 'tabs', 'pointers', 'blocks', 'voice', 'calls', 'work', 'usage', 'efforts', 'routing', 'abilities',
  'media', 'spend', 'calendar', 'schedules', 'spaces',
]);

/** The switch of a family's writes (absent: setup – Autark's own setup is what an unnamed method changes). */
const FAMILY: Readonly<Record<string, SecuritySwitch>> = {
  secrets: 'accounts', accounts: 'accounts', apps: 'accounts',
  bridges: 'message', feedback: 'message',
  phoneUse: 'phone', computer: 'computer', browser: 'web', side: 'web',
};

/** Single methods that differ from their family. */
const METHOD: Readonly<Record<string, SecuritySwitch | 'open'>> = {
  'security.saveTrustAgreement': 'setup',
  'agents.create': 'team', 'agents.archive': 'team', 'agents.restore': 'team',
  'calendar.connectGoogle': 'accounts', 'chats.connectExternal': 'setup',
  'computer.stop': 'open', 'computer.preview': 'computer', 'spaces.save': 'team', 'bridges.connectTelegram': 'accounts', 'work.resume': 'setup', 'voice.pullLocal': 'setup', 'voice.removeLocal': 'setup',
  'files.open': 'open', 'files.read': 'open', 'files.get': 'open', 'files.upload': 'open', 'files.uploadChunk': 'open',
};

/** Methods on a path (of this PC, or of the linked PC in `device`): reading or listing it, and changing it. */
const PATH_READ: ReadonlySet<string> = new Set(['files.readPath', 'files.listPath', 'files.uploadPath', 'files.openPath']);
const PATH_WRITE: ReadonlySet<string> = new Set(['files.writePath']);
/**
 * What another company's main calls here with this company's runtime.json token (no agent name): the removal the person
 * started there. From an agent's own `wf` (named) it is this company's setup. (companies.tool: rpc-guard.ts companyTool.)
 */
const CROSS_COMPANY: ReadonlySet<string> = new Set(['companies.remove']);
/** Methods on one agent: open when it is the calling agent itself (its own instructions, main skills, home). */
const OWN_AGENT: ReadonlySet<string> = new Set(['agents.update', 'agents.saveMainSkill', 'agents.setHome']);

const OPEN: MethodNeed = { kind: 'open' };

/** What `method` with `params` needs from a session that is not the person; `agentId`: the calling agent, if named. */
export function methodNeed(method: string, params: Record<string, unknown>, agentId?: string): MethodNeed {
  if (PERSON_ONLY.has(method)) return { kind: 'person' };
  if (method === 'settings.update' && Object.hasOwn(params, 'security')) return { kind: 'person' };
  if (PATH_READ.has(method) || PATH_WRITE.has(method)) {
    const target = typeof params.path === 'string' ? params.path : undefined;
    return { kind: 'switch', capability: PATH_WRITE.has(method) ? 'write' : 'read', ...(target ? { path: target } : {}) };
  }
  if (method === 'chats.export') return typeof params.dir === 'string' ? { kind: 'switch', capability: 'write', path: params.dir } : OPEN; // without dir: the company's own exports
  if (CROSS_COMPANY.has(method)) return agentId ? { kind: 'switch', capability: 'setup' } : OPEN;
  const fixed = METHOD[method];
  if (fixed) return fixed === 'open' ? OPEN : { kind: 'switch', capability: fixed };
  if (OWN_AGENT.has(method) && agentId && (params.id ?? params.agentId) === agentId) return OPEN;
  const dot = method.indexOf('.');
  const family = dot < 0 ? method : method.slice(0, dot);
  if (READS.has(method.slice(dot + 1)) || WORK.has(family)) return OPEN;
  return { kind: 'switch', capability: FAMILY[family] ?? 'setup' };
}
