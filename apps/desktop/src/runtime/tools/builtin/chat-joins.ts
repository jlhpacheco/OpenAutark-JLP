// Who a chat tool names and who may join a chat by an agent (B-050 K3/K10). Members are named by id – an agent id,
// "human" (the owner), a colleague (per_…) – or by name: the owner's, a colleague's or an agent's, case ignored, or a
// first name only one of them has (an agent may know just the name, and people.list is not offered in every mode).
// The owner is named as my context shows them (chat/mentions.ts humanAliases: the profile name, "CEO", "Human", "You") –
// 19.11.2026, real runs on a profile without a name: chat.direct {with: "CEO"} was refused and the result never reached them.
// B-080 (live: "ag_nora" / "ag_lena" guessed as ids, answered "Unknown agent"): only "human", a per_… id or a known
// agent id is taken as it is; another id-like value is looked up among the agents by the name after its prefix
// ("ag_nora" → Nora), and a name that fits nobody is refused with the names (and ids) that exist.
// Two rules keep an agent from opening more to people than they may see – the rules a person's own invitations
// follow (people/rpc-chats.ts):
//  - a colleague shares a room only with agents they may work with (their spaces, people/access.ts mayUseAgent),
//    checked for the pairs a change makes new, so a room the person put together stays as it is;
//  - colleagues join a chat by the agent that started it – so an agent never opens the owner's chats to a colleague.
//    A 1:1 stays two for everyone (B-078 D7, chat/members-change.ts DIRECT_STAYS_TWO; chat-update.ts checks it first).
// Owns: these lookups and rules. Never: changes members itself, or lets a name choose between two members.

import type { ToolContext } from '../types.ts';
import { HUMAN_ID, SYSTEM_ID } from '../../../shared/ids.ts';
import type { Conversation } from '../../../shared/model/chat.ts';
import { isPersonId, type Person } from '../../../shared/model/people.ts';
import { humanAliases } from '../../chat/mentions.ts';
import { mayUseAgent } from '../../people/access.ts';
import { PeopleRepo } from '../../people/repo.ts';
import { authorName, memberRefusal } from './util.ts';

/** An id as the runtime makes them (ag_…, per_…); one that is no known id is an agent's name after its prefix (B-080). */
const ID_LIKE = /^[a-z]{2,4}_\S+$/;

/** Everyone a name may stand for: the owner, colleagues who are not revoked, the org's agents. */
function directory(ctx: ToolContext): Array<{ id: string; name: string }> {
  const owner = humanAliases(ctx.services.settings).map((name) => ({ id: HUMAN_ID, name })); // the profile name first
  let people: Array<{ id: string; name: string }> = [];
  try { people = ctx.services.db.all<{ id: string; name: string }>(`SELECT id, name FROM people WHERE status <> 'revoked' AND id <> ?`, [HUMAN_ID]); } catch { /* no people table */ }
  return [...owner, ...people, ...ctx.services.org.list().map((agent) => ({ id: agent.id, name: agent.name }))];
}

/** Who a name may stand for whose name is `wanted` (lowercase): the full name, else the first name. */
function fitting(entries: Array<{ id: string; name: string }>, wanted: string): Array<{ id: string; name: string }> {
  const exact = entries.filter((entry) => entry.name.trim().toLowerCase() === wanted);
  return exact.length ? exact : entries.filter((entry) => entry.name.trim().toLowerCase().split(/\s+/)[0] === wanted);
}

/** The member `raw` names (see the header), or why it names nobody or more than one. */
function named(ctx: ToolContext, raw: string): string | { refused: string } {
  const value = raw.trim();
  if (value === HUMAN_ID || isPersonId(value) || ctx.services.org.get(value)) return value;
  const all = directory(ctx);
  // B-080 (live: a guessed "ag_nora" for Nora): an id-like value that is no known id is an agent's name after its prefix.
  const fits = ID_LIKE.test(value)
    ? fitting(ctx.services.org.list().map((agent) => ({ id: agent.id, name: agent.name })), value.replace(/^[a-z]{2,4}_/, '').replace(/[_-]+/g, ' ').toLowerCase())
    : fitting(all, value.toLowerCase());
  if (fits.length === 1) return fits[0].id;
  if (fits.length) return { refused: `"${value}" fits ${fits.slice(0, 5).map((entry) => `${entry.name} (${entry.id})`).join(', ')}: name one by id.` };
  return { refused: `Nobody is called "${value}". Who I can name: ${whoExists(all)}.` };
}

/** B-080: the refusal's list – agents and colleagues (at most 12), then the owner. */
function whoExists(all: Array<{ id: string; name: string }>): string {
  const owner = all.find((entry) => entry.id === HUMAN_ID);
  const others = all.filter((entry) => entry.id !== HUMAN_ID);
  const agentsFirst = [...others.filter((entry) => !isPersonId(entry.id)), ...others.filter((entry) => isPersonId(entry.id))];
  const listed = agentsFirst.slice(0, 12).map((entry) => `${entry.name} (${entry.id})`);
  return [...listed, ...(agentsFirst.length > 12 ? ['…'] : []), owner ? `${owner.name} (human)` : 'the person (human)'].join(', ');
}

/** The member ids `raws` name, once each – every one a member an agent may add (util.ts memberRefusal) – or why not. */
export function namedMembers(ctx: ToolContext, raws: readonly string[]): string[] | string {
  const ids: string[] = [];
  for (const raw of raws) {
    const id = named(ctx, raw);
    if (typeof id !== 'string') return id.refused;
    const why = memberRefusal(ctx, id);
    if (why) return why;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

const isAgentId = (id: string): boolean => id !== HUMAN_ID && id !== SYSTEM_ID && !isPersonId(id) && !id.startsWith('ext:');

/**
 * Why the change would seat a colleague with an agent they may not work with (see the header); undefined when it
 * would not. `present`: the room's active members before it; `added`: who joins (the calling agent too when it opens the room).
 */
export function scopeRefusal(ctx: ToolContext, present: readonly string[], added: readonly string[]): string | undefined {
  const all = [...new Set([...present, ...added])];
  const agents = all.filter(isAgentId);
  if (!agents.length) return undefined;
  const repo = new PeopleRepo(ctx.services.db);
  for (const personId of all.filter((id) => isPersonId(id))) {
    let person: Person | undefined;
    try { person = repo.get(personId); } catch { person = undefined; }
    for (const agentId of agents) {
      if (!added.includes(personId) && !added.includes(agentId)) continue; // a pair the room already had
      if (!person || !mayUseAgent(person, ctx.services.org.get(agentId))) {
        return `${authorName(ctx, personId)} does not work with ${authorName(ctx, agentId)} (not in the spaces the person gave them).`;
      }
    }
  }
  return undefined;
}

/** Why colleagues may not join `chat` by this agent (see the header); undefined when they may or none joins. */
export function colleagueRefusal(ctx: ToolContext, chat: Conversation, added: readonly string[]): string | undefined {
  if (!added.some((id) => isPersonId(id))) return undefined;
  if (chat.createdBy !== ctx.agent.id) {
    return `${authorName(ctx, chat.createdBy)} started this chat and brings colleagues into it; I ask them, or I start a group with chat.create (members …).`;
  }
  return undefined;
}
