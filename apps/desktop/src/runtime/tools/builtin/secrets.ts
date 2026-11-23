// Secret tools for agents (owner 29.10.2026: the secrets store is a catalog like a skill, with zero restrictions).
// secrets.list reads like a skill index – every entry with its id, name, description, kind, route, tags, the site or
// tool it was saved from and its handle (a login or card: one handle per field) – the same entries as the route files
// <data>/secrets/<route>.md (secrets/files.ts), where a name, description or tags are changed by editing the file.
// secrets.save adds an entry: a description and a value that goes straight into the vault (route chosen and id
// generated; the agent may name either); with a chat message's seq (16.11.2026) the handle stands in that message instead
// of the value (secrets/text-capture.ts showHandleIn). secrets.generate creates a random password (crypto.randomInt in the vault)
// as a single secret, a new login (username) or into a stored login (group). secrets.import reads a password export or
// the secrets of a .env or flat JSON file on this PC by its path into the vault (no value reaches the agent) and
// deletes a known browser's or manager's export after a complete import (owner 04.11.2026: every entry stored whole,
// none skipped), never a .env, JSON or other CSV file. Agents use a secret only by its handle `secret://<id>` – in a
// browser field, typed on the screen, a command's env, a web.fetch header, a connector – on any site and for any host, at
// any length (B-080); the value is decrypted
// at that moment inside the runtime and never appears in a prompt, output or journal (secrets.save's value is a hidden
// argument). Owner 04.11.2026 (the AI should simply do it): secrets.export writes chosen entries with their values into one
// CSV file on this PC (secrets/export.ts) – for secrets.import in another company or on another PC; secrets.delete removes
// entries by id, route or all at once (the CEO's linked PCs follow through the device sync); "all" and a route leave the
// app's own working credentials unless named (secrets/units.ts catalogUnits). Both return names, a path and counts only.
// Sicher-Runde 19.11.2026 (REVIEW-2 1): in Secure mode an agent's export leaves the payment entries out (cards, the payment
// route – spending money is closed there) and its note says so; the file it writes passes the write switch (tool-gate.ts).
// secrets.list ranks by the catalog's word index (F19, secrets/metadata.ts rankSecrets: a named id, the most words held, bm25,
// then use – the ones in use lead a listing without a query), shows at most LIST_MAX with how many fit and each entry's use
// count; with a route, other routes' entries holding as many of the words as the route's best match come too; its note says
// that the engine's own shell passes a handle on as plain text.
// Owns: the agent's view of the catalog. Never: returns or logs a value.

import { readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { SecretGroup, SecretInfo } from '../../../shared/model/security.ts';
import { SECRET_ROUTES } from '../../../shared/model/security.ts';
import { isKeyValueFormat } from '../../../shared/model/key-values.ts';
import { registrableDomain } from '../../secrets/service.ts';
import { newEntryId } from '../../secrets/entry-id.ts';
import type { ToolContext, ToolDef } from '../types.ts';
import { HUMAN_ID, SYSTEM_ID } from '../../../shared/ids.ts';
import { CHAT_ID_PROPERTY, failure, json } from '../types.ts';
import { clip, defineTool, internal, iso, resolveChat } from './util.ts';
import { showHandleIn } from '../../secrets/text-capture.ts';
import { rankSecrets, SECRET_WHERE, type SecretHit } from '../../secrets/metadata.ts';
import { ROOT_SECRETS } from '../../root/layout.ts';
import { importSecrets, reviewBrief, reviewCount, storedCount } from '../../secrets/import.ts';
import { GENERIC_EXPORT, MAX_IMPORT_CHARS, MAX_IMPORT_ROWS } from '../../secrets/import-parse.ts';
import { exportSecrets } from '../../secrets/export.ts';
import { catalogUnits } from '../../secrets/units.ts';

/** Entries a listing shows at most; its count says how many fit (F19: the 128 entries of a live catalog were cut to ~6). */
export const LIST_MAX = 20;
/** A description in a listing at most (its route file holds the whole text). */
const LIST_DESCRIPTION = 600;
export const NOTE = `Values stay hidden. ${SECRET_WHERE} Every secret works everywhere, any length – any site, any command, any host, cards and CVCs included; savedFrom only says where it came from, tags are notes. A login or card has one handle per field; a 2FA field fills the current one-time code. What a command or request returns has the values it received masked, and values stay out of my notes, memory, rules, files and messages. Each route is a file <route>.md in the folder named here – I edit a name, description or tags there.`;

const TAGS = { type: 'array', items: { type: 'string', maxLength: 120 }, maxItems: 12, description: 'Usage notes.' } as const;
const ROUTE = { type: 'string', maxLength: 40, description: `${SECRET_ROUTES.join(', ')} or my own; default chosen.` } as const;
const NAME = { type: 'string', minLength: 1, maxLength: 120 } as const;
const DESCRIPTION = { type: 'string', minLength: 1, maxLength: 4000, description: 'What it opens and when it is used.' } as const;

/** A description as a listing shows it. */
const listed = (text: string | undefined): string | undefined => (text && text.length > LIST_DESCRIPTION ? `${text.slice(0, LIST_DESCRIPTION)} …` : text || undefined);

function single(info: SecretInfo): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: info.id, name: info.label, description: listed(info.description), kind: info.kind, route: info.route, tags: info.tags,
    savedFrom: info.source, handle: `secret://${info.id}`, hint: info.hint, lastUsed: iso(info.lastUsedAt), used: info.uses,
  };
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out;
}

/** A field of a group: its handle and kind; a 2FA field says what it fills (never a value). */
function fieldView(info: SecretInfo): Record<string, unknown> {
  const digits = /^(\d) digits/.exec(info.hint ?? '')?.[1] ?? '6';
  const hint = info.kind === 'totp' ? `fills the current ${digits}-digit code` : info.hint;
  return { field: info.field, handle: `secret://${info.id}`, kind: info.kind, ...(hint ? { hint } : {}) };
}

function groupView(group: SecretGroup, fields: SecretInfo[]): Record<string, unknown> {
  return {
    id: group.id, name: group.label, ...(group.description ? { description: listed(group.description) } : {}), kind: group.kind, route: group.route,
    ...(group.tags?.length ? { tags: group.tags } : {}), ...(group.source ? { savedFrom: group.source } : {}), fields: fields.map(fieldView),
    ...(group.lastUsedAt ? { lastUsed: iso(group.lastUsedAt) } : {}), ...(group.uses ? { used: group.uses } : {}),
  };
}

const list = defineTool<{ query?: string; route?: string }>({
  name: 'secrets.list',
  description: `Lists the secrets catalog with id, name, description, kind, route, handle and how often each was used – the ones in use first, at most ${LIST_MAX}. ${SECRET_WHERE} Logins and cards have a handle per field; a 2FA field fills the current code.`,
  inputSchema: { type: 'object', properties: {
    query: { type: 'string', maxLength: 100, description: 'Words of name, id, description, tags or source; the best fit first.' }, route: { type: 'string', maxLength: 40 },
  }, additionalProperties: false },
  category: 'read',
  describe: () => internal('List the secrets catalog'),
  async run(args, ctx) {
    // F19 (16.11.2026): the word index's ranking (secrets/metadata.ts rankSecrets) – a named id first, the entries holding the
    // most words (B-080, live: "windows password" in route logins gave three failed sign-ins that mention "password" – the
    // Windows entry was a note), bm25, then use; without a query the ones in use first. With a route, an entry of another
    // route that holds as many of the words as the route's best match comes too (the route's first on a tie). At most LIST_MAX:
    // the whole catalog (85k characters live) was cut to its first 6,000.
    const route = args.route?.trim().toLowerCase();
    const query = args.query?.trim() ?? '';
    const hits = rankSecrets(ctx.services, query);
    const inRoute = route ? hits.filter((hit) => hit.entry.route === route) : hits;
    const best = Math.max(0, ...inRoute.map((hit) => hit.held));
    const others = route && query ? hits.filter((hit) => hit.entry.route !== route && (hit.exact || hit.held >= best)) : [];
    const ranked: SecretHit[] = [...inRoute, ...others].sort((a, b) => Number(b.exact) - Number(a.exact) || b.held - a.held); // stable: the route's first on a tie
    const all = ctx.services.secrets.list();
    const groups = new Map(ctx.services.secrets.groups().map((group) => [group.id, group]));
    const singles = new Map(all.filter((info) => !info.group).map((info) => [info.id, info]));
    const secrets = ranked.slice(0, LIST_MAX).flatMap(({ entry }) => {
      const group = groups.get(entry.id);
      const info = singles.get(entry.id);
      return group ? [groupView(group, all.filter((field) => field.group?.id === group.id))] : info ? [single(info)] : [];
    });
    const found = !others.length ? undefined : inRoute.length
      ? `Entries of other routes that hold as many of the words are here too; each shows its route.`
      : `None in route ${route}; these are in other routes.`;
    const rest = ranked.length - secrets.length;
    const more = rest <= 0 ? undefined : query ? `${rest} more fit; more words or a route narrow it.` : `${rest} more are in the catalog; words or a route find them.`;
    const data = ctx.services.paths?.data;
    return json({
      ...(found ? { found } : {}), ...(more ? { more } : {}),
      note: NOTE, ...(data ? { folder: path.join(data, ROOT_SECRETS) } : {}), count: ranked.length, secrets,
    });
  },
});

interface SaveArgs { name: string; description: string; value: string; kind?: 'api_key' | 'token' | 'password' | 'card' | 'note' | 'totp'; username?: string; route?: string; id?: string; tags?: string[]; source?: string; seq?: number; chatId?: string }

/** With `seq`: the chat message that showed the value shows `secretId`'s handle instead – what happened, as a line. */
function shownIn(ctx: ToolContext, args: Pick<SaveArgs, 'seq' | 'chatId'>, value: string, secretId: string): string | undefined {
  if (args.seq === undefined) return undefined;
  try {
    const message = ctx.services.chats.messages(resolveChat(ctx, args.chatId), { afterSeq: args.seq - 1, limit: 1 }).find((item) => item.seq === args.seq);
    if (!message) return `No message #${args.seq} in that chat.`;
    return showHandleIn(ctx.services, message, value, secretId) ? `Message #${args.seq} shows the handle now.` : `Message #${args.seq} does not hold the value as a whole.`;
  } catch (error) { return (error as Error).message; }
}

const save = defineTool<SaveArgs>({
  name: 'secrets.save',
  description: 'Stores a secret in the encrypted catalog the moment I get one and returns its handle. Every agent can use it, the route and id are chosen for me, and I keep the value here, nowhere else; a value already stored returns its handle.',
  inputSchema: {
    type: 'object',
    properties: {
      name: NAME,
      description: DESCRIPTION,
      value: { type: 'string', minLength: 1, maxLength: 16_384 },
      kind: { type: 'string', enum: ['api_key', 'token', 'password', 'card', 'note', 'totp'], description: 'Default api_key; totp: a 2FA setup key whose handle fills the current code.' },
      username: { type: 'string', minLength: 1, maxLength: 320, description: 'With a password: a login.' },
      route: ROUTE,
      id: { type: 'string', maxLength: 60, description: 'A suggested id, e.g. "github-ci-token".' },
      tags: TAGS,
      source: { type: 'string', maxLength: 200, description: 'Where it came from.' },
      seq: { type: 'integer', minimum: 1, description: 'A chat message (#seq) that shows the value: it shows the handle there from then on.' },
      chatId: CHAT_ID_PROPERTY,
    },
    required: ['name', 'description', 'value'], additionalProperties: false,
  },
  category: 'write_local',
  describe: (args) => internal(`Save the secret "${clip(args.name.replace(/["\s]+/g, ' '), 60)}" in the catalog${args.route ? ` (route ${clip(args.route, 40)})` : ''}`),
  async run(args, ctx) {
    const secrets = ctx.services.secrets;
    const value = args.value;
    // The value reaches this tool as given (registry VAULT_ARGS: the leak guard leaves it alone).
    if (/^secret:\/\/[A-Za-z0-9_-]+$/.test(value.trim())) return failure('Give the value itself, not a handle (that one is already stored).');
    const known = secrets.holding ? (await secrets.holding(value, ctx.agent.id))[0] : undefined;
    const stored = known ? secrets.list().find((info) => info.id === known) : undefined;
    if (stored) {
      const shown = shownIn(ctx, args, value, stored.id);
      return json({ ok: true, id: stored.id, handle: `secret://${stored.id}`, name: stored.group ? `${stored.field ?? 'field'} of ${stored.group.label}` : stored.label, note: 'That value is already stored; nothing new was saved. Use this handle.', ...(shown ? { message: shown } : {}) });
    }
    const id = newEntryId(secrets.list(), secrets.groups(), args.name, args.id);
    if (args.username !== undefined) { // review intent #9: a server or database login as one entry with two handles
      const login = await secrets.saveGroup({
        id, label: args.name, kind: 'login', description: args.description, ...(args.route ? { route: args.route } : {}), ...(args.tags ? { tags: args.tags } : {}),
        ...(args.source?.trim() ? { source: args.source.trim() } : {}),
        fields: [{ field: 'username', kind: 'text', value: args.username.trim() }, { field: 'password', kind: 'password', value }],
      }, { createdBy: ctx.agent.id });
      const handles = Object.fromEntries(login.fields.map((field) => [field.field, `secret://${field.id}`]));
      const password = login.fields.find((field) => field.field === 'password');
      const shown = password ? shownIn(ctx, args, value, password.id) : undefined;
      return json({ ok: true, id: login.group.id, name: login.group.label, route: login.group.route, handles, note: 'Stored in the catalog as a login. I use each field by its handle everywhere, without typing it out or copying it.', ...(shown ? { message: shown } : {}) });
    }
    const saved = await secrets.save({
      id, label: args.name, kind: args.kind ?? 'api_key', value, description: args.description,
      createdBy: ctx.agent.id, ...(args.route ? { route: args.route } : {}), ...(args.tags ? { tags: args.tags } : {}),
      ...(args.source?.trim() ? { source: args.source.trim() } : {}),
    });
    const shown = shownIn(ctx, args, value, saved.id);
    return json({ ok: true, id: saved.id, handle: `secret://${saved.id}`, name: saved.label, route: saved.route, note: 'Stored in the catalog. I use it by its handle everywhere, without typing it out or copying it.', ...(shown ? { message: shown } : {}) });
  },
});

interface GenerateArgs { source?: string; name?: string; description?: string; length?: number; symbols?: boolean; username?: string; group?: string; replace?: boolean }

const generate = defineTool<GenerateArgs>({
  name: 'secrets.generate',
  description: 'Creates a strong random password in the catalog and returns only its handle. I fill the password fields with that handle in browser.act.',
  inputSchema: {
    type: 'object',
    properties: {
      source: { type: 'string', minLength: 3, maxLength: 300, description: 'The site or system it is for; noted as its source.' },
      name: NAME, description: DESCRIPTION,
      length: { type: 'integer', minimum: 12, maximum: 64 },
      symbols: { type: 'boolean', description: 'false for sites that refuse them.' },
      username: { type: 'string', minLength: 1, maxLength: 320, description: 'Makes a login of username and password.' },
      group: { type: 'string', maxLength: 64, description: 'A stored login to put it into.' },
      replace: { type: 'boolean', description: "true: replaces that login's password (and username, when given)." },
    },
    additionalProperties: false,
  },
  category: 'write_local',
  describe: (args) => internal(`Create a password for ${args.source ? clip(registrableDomain(args.source) ?? args.source, 80) : 'a new secret'}${args.username !== undefined || args.group ? ' (login)' : ''}`),
  async run(args, ctx: ToolContext) {
    const site = args.source?.trim() || undefined;
    const label = args.name?.trim() || `${ctx.agent.name} · ${(site ? registrableDomain(site) : undefined) ?? site ?? 'password'}`;
    const info = await ctx.services.secrets.generate({
      label, agentId: ctx.agent.id, ...(site ? { site } : {}), length: args.length, symbols: args.symbols, username: args.username, groupId: args.group, replace: args.replace,
    });
    const purpose = args.description?.trim();
    // A new login takes the description; an existing login keeps its own.
    if (purpose && info.group && args.group === undefined) await ctx.services.secrets.saveGroup({ id: info.group.id, label: info.group.label, description: purpose });
    else if (purpose && !info.group) await ctx.services.secrets.save({ id: info.id, kind: info.kind, label: info.label, description: purpose });
    if (!info.group) return json({ ok: true, handle: `secret://${info.id}`, label: info.label, savedFrom: info.source, note: 'Stored in the catalog. I fill it with the handle instead of typing it out.' });
    const fields = ctx.services.secrets.list().filter((entry) => entry.group?.id === info.group!.id);
    const handles = Object.fromEntries(fields.map((field) => [field.field, `secret://${field.id}`]));
    return json({
      ok: true, group: info.group.id, label: info.group.label, handle: `secret://${info.id}`, handles, savedFrom: info.source,
      note: 'My login in the catalog. I fill each field with its handle instead of typing the password out.',
    });
  },
});

/**
 * What happened to the imported file, in one line: a known browser's or password manager's export is deleted once every
 * entry is in the catalog whole; a .env or JSON file, any other CSV and an incomplete import stay.
 */
function settleFile(file: string, result: { format: string; failed: number; skipped: number }): string {
  const plain = `the export stays at ${file} – it holds every password in plain text.`;
  const entries = (count: number) => `${count} ${count === 1 ? 'entry was' : 'entries were'}`;
  if (isKeyValueFormat(result.format)) return 'Kept: a .env or JSON file is a working file of its own.';
  if (result.format === GENERIC_EXPORT) return `Kept: not a known password manager's export, so ${plain}`;
  if (result.failed) return `Kept: ${entries(result.failed)} not stored completely (e.g. a 2FA key the vault could not read), so ${plain}`;
  if (result.skipped) return `Kept: ${entries(result.skipped)} not imported (e.g. a note or a row without a password), so ${plain}`;
  try { rmSync(file, { force: true }); } catch { return `Kept: the export could not be deleted, so ${plain}`; }
  return 'Deleted: every value is in the catalog now, and the export held them in plain text.';
}

const importFile = defineTool<{ path: string }>({
  name: 'secrets.import',
  description: 'Imports a password export or key/value file from this PC into the catalog. The app reads it, so no value reaches me (reading it myself would); a browser or manager export is deleted once all is stored, and then I name, describe and check the new entries.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', minLength: 1, maxLength: 1000, description: 'A browser or password-manager CSV, a secrets.export file, Bitwarden JSON, .env or flat JSON.' } },
    required: ['path'], additionalProperties: false,
  },
  category: 'write_local',
  describe: (args) => internal(`Import the secrets of ${clip(path.basename(args.path), 80)} into the secrets catalog`),
  async run(args, ctx) {
    const file = path.resolve(args.path);
    let content: string;
    try {
      if (statSync(file).size > MAX_IMPORT_CHARS) return failure('The file is larger than 5 MB.');
      content = readFileSync(file, 'utf8');
    } catch { return failure('The file could not be read.'); }
    try {
      // The person's secrets: stored as theirs, not the agent's.
      const result = await importSecrets(ctx.services.secrets, content, { fileName: path.basename(file), now: ctx.services.clock.now() });
      const next = reviewCount(result) ? reviewBrief(result) : storedCount(result) ? 'Every new entry came with its own name and description.' : 'Nothing new was stored.';
      return json({ ok: true, ...result, file: settleFile(file, result), next });
    } catch (error) { return failure((error as Error).message); }
  },
});

const IDS = { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: MAX_IMPORT_ROWS } as const;

const exportFile = defineTool<{ path?: string; ids?: string[]; route?: string }>({
  name: 'secrets.export',
  description: "Writes catalog entries with their values into a CSV file on this PC. It is for secrets.import elsewhere, which deletes it after a complete import; the file holds every value in plain text, so I hand its path on rather than read it. The app's own working credentials stay out unless named.",
  inputSchema: {
    type: 'object', properties: {
      path: { type: 'string', minLength: 1, maxLength: 1000, description: 'Default ~/Downloads/autark-secrets-<date>.csv.' },
      ids: IDS, route: { type: 'string', maxLength: 40 },
    }, additionalProperties: false,
  },
  category: 'secret',
  describe: (args) => internal(`Export ${args.ids?.length ? `${args.ids.length} ${args.ids.length === 1 ? 'entry' : 'entries'}` : args.route ? `the route ${clip(args.route, 40)}` : 'the secrets catalog'} to a file`),
  async run(args, ctx) {
    try {
      const withoutPayment = secureMode(ctx);
      const result = await exportSecrets(ctx.services, { ...(args.ids?.length ? { ids: args.ids } : {}), ...(args.route ? { route: args.route } : {}), ...(args.path ? { file: args.path } : {}), ...(withoutPayment ? { withoutPayment } : {}) });
      const note = [
        'Hand the file to secrets.import in the other company or on the other PC.',
        result.payment ? `${result.payment} payment ${result.payment === 1 ? 'entry' : 'entries'} (cards, the payment route) stayed out: spending money is closed on this PC (Secure mode), so card data never goes into a file I write – ${personName(ctx)} exports those in Settings › Secrets themselves.` : '',
        result.skipped ? `${result.skipped} skipped: a group of free fields has no row in this file, or a value could not be read here.` : '',
        result.notFound ? `${result.notFound.length} of the ids I named are no entry (notFound) – secrets.list shows the ids.` : '',
      ].filter(Boolean).join(' ');
      return json({ ok: true, ...result, note });
    } catch (error) { return failure(`The file could not be written: ${(error as Error).message}`); }
  },
});

/** An agent's call in Secure mode (an unreadable mode counts as Secure); the person and the app itself are never limited here. */
function secureMode(ctx: ToolContext): boolean {
  if (ctx.agent.id === HUMAN_ID || ctx.agent.id === SYSTEM_ID || !ctx.services.security) return false;
  try { return ctx.services.security.current().mode !== 'trust'; } catch { return true; }
}

function personName(ctx: ToolContext): string {
  try { return ctx.services.settings.get().profile.name?.trim() || 'the person'; } catch { return 'the person'; }
}

const removeEntries = defineTool<{ ids?: string[]; route?: string; all?: boolean }>({
  name: 'secrets.delete',
  description: "Deletes catalog entries by id, by route, or all of them, on linked PCs too. The app's own working credentials go only when named by id.",
  inputSchema: {
    type: 'object', properties: {
      ids: { ...IDS, description: "A login or card id: all its fields; a field handle's id: that field." }, route: { type: 'string', maxLength: 40 }, all: { type: 'boolean', enum: [true] },
    }, additionalProperties: false,
  },
  category: 'delete',
  describe: (args) => ({ ...internal(`Delete ${args.ids?.length ? `${args.ids.length} ${args.ids.length === 1 ? 'secret' : 'secrets'}` : args.route ? `the secrets of route ${clip(args.route, 40)}` : 'every secret'} from the catalog`), reversible: false }),
  async run(args, ctx) {
    const vault = ctx.services.secrets;
    if (!args.ids?.length && !args.route && args.all !== true) return failure('Name the entries: ids, a route, or all: true.');
    const removed: string[] = [];
    const notFound: string[] = [];
    if (args.ids?.length) {
      const fields = vault.list();
      const groups = vault.groups();
      for (const id of new Set(args.ids)) {
        const group = groups.find((entry) => entry.id === id);
        const info = fields.find((entry) => entry.id === id);
        if (group) { vault.removeGroup(id); removed.push(group.label); } else if (info) { vault.remove(id); removed.push(info.group ? `${info.field ?? 'field'} of ${info.group.label}` : info.label); } else notFound.push(id);
      }
    } else {
      for (const unit of catalogUnits(ctx.services, args.route)) {
        if (unit.group) vault.removeGroup(unit.id); else vault.remove(unit.id);
        removed.push(unit.name);
      }
    }
    return json({
      ok: true, count: removed.length, removed, ...(notFound.length ? { notFound } : {}),
      note: removed.length ? 'The CEO\'s linked PCs remove them too (device sync).' : 'Nothing was removed.',
    });
  },
});

export const secretTools: ToolDef[] = [list, save, generate, importFile, exportFile, removeEntries];
