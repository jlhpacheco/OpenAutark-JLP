// people.list (B-050 K10): the people of the organisation as agents may reach them – the owner ('human') and every
// colleague (per_…) who is not revoked, with name, title, manager and whether they joined yet. It is the directory
// each person sees too (people/rpc-base.ts people.list): no devices, invites, scopes or chats, so it holds nothing
// of any chat. chat.direct, chat.create and chat.update (add) take these ids.
// B-078 (D20): per person also where they are reachable – their own PC linked here (its name, online or not) – and
// whether I reach a calendar of theirs (calendar/members.ts: on their PC, here, or none); on an employee's PC one more
// line names the company ('owner') the same way. F13: the CEOs – the owner and anyone with the role 'ceo' – carry
// `role: 'ceo'`; I work for each of them.
// Owns: that read. Never: changes people, or shows revoked people, invites, scopes or another PC's addresses.

import type { ToolContext, ToolDef } from '../types.ts';
import { json, text } from '../types.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import { OWNER_ALIAS } from '../../../shared/model/people.ts';
import '../../contracts/people.ts';
import { resolveMember } from '../../calendar/members.ts';
import { authorName, defineTool, internal } from './util.ts';

/** Where `id` is reachable and whether a calendar of theirs is (never throws). */
function reach(ctx: ToolContext, id: string): Record<string, unknown> {
  try {
    const member = resolveMember(ctx.services, id, (person) => authorName(ctx, person));
    if (member.where === 'linked') return { pc: { name: member.pc, online: member.online }, calendar: member.online ? 'on their PC' : 'on their PC (offline now)' };
    if (member.where === 'here') return id === HUMAN_ID ? { pc: 'this PC', calendar: 'here' } : { calendar: 'here' };
    return {};
  } catch { return {}; }
}

const listPeople = defineTool<Record<string, never>>({
  name: 'people.list',
  description: 'Lists the people of the organisation: the CEOs I work for (role ceo) and colleagues. Each with id, name, title, manager, PC, online and whether I reach their calendar.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  category: 'read',
  describe: () => internal('List the people of the organisation'),
  async run(_args, ctx) {
    const people = ctx.services.people?.list().filter((person) => person.status !== 'revoked') ?? [];
    const company = reach(ctx, OWNER_ALIAS);
    const companyRow = company.pc && !people.some((person) => person.id === OWNER_ALIAS) ? [{ id: OWNER_ALIAS, name: 'The owner of the company this PC works in', ...company }] : [];
    if (!people.length && !companyRow.length) return text('Only the person I work for ("human") – no colleagues in the organisation yet. Their calendar is here.');
    return json([...people.slice(0, 200).map((person) => ({
      id: person.id, name: person.id === HUMAN_ID ? authorName(ctx, HUMAN_ID) : person.name, ...(person.role === 'ceo' ? { role: 'ceo' } : {}), ...(person.title ? { title: person.title } : {}),
      ...(person.managerId ? { manager: `${authorName(ctx, person.managerId)} (${person.managerId})` } : {}),
      ...(person.status === 'invited' ? { joined: false } : {}), ...reach(ctx, person.id),
    })), ...companyRow]);
  },
});

export const peopleTools: ToolDef[] = [listPeople];
