// RPC handler: the person's line (tasks.quickCreate) – runtime/tasks/quick.ts, the one intake: their to-do now,
// in a quest, at a time they confirmed, "Only me" (`private`, stays theirs) or not, their assistant woken. Files are checked
// like a chat message's (chats.ts attachmentsOf: stored files only). Tier 'todo' (the line is the person's own to-do);
// `target` (Send to…), `priority` and `spaceId` hand work to others – that takes 'tasks'.
// Owns: param checks and scope rules. Never: business logic.

import { HUMAN_ID } from '../../../shared/ids.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { QUICK_TARGET_KINDS, type QuickTaskTarget } from '../../../shared/model/task-center.ts';
import { quickCreate } from '../../tasks/quick.ts';
import { input, oneOf, onlyKeys, optBool, optId, optNum, optObj, optText, text, type Obj } from '../params.ts';
import type { HandlerTable } from '../table.ts';
import { attachmentsOf } from './chats.ts';

const TODO = { capability: 'todo' } as const;
const PRIORITIES = [0, 1, 2] as const;

function targetOf(o: Obj): QuickTaskTarget | undefined {
  const t = optObj(o, 'target');
  if (!t) return undefined;
  onlyKeys(t, ['kind', 'id'], 'target');
  return { kind: oneOf(t, 'kind', QUICK_TARGET_KINDS), id: text(t, 'id', { max: 120 }) };
}

export function register(table: HandlerTable): void {
  table.add('tasks.quickCreate', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['text', 'attachments', 'at', 'minutes', 'quest', 'private', 'clientId', 'target', 'priority', 'spaceId']);
    const priority = optNum(o, 'priority', { min: 0, max: 2 });
    const target = targetOf(o);
    if (target && target.kind !== 'me' && ctx.scope.kind === 'device' && !ctx.scope.capabilities.includes('tasks')) {
      throw new WorkforceError('forbidden', "This device adds the person's own to-dos; giving work to others needs the tasks access.");
    }
    const minutes = optNum(o, 'minutes', { min: 1, max: 24 * 60 });
    const onlyMe = optBool(o, 'private'); // "Only me": the line stays the person's (an explicit false too – the default is Settings › day.aiHelps)
    const quest = optId(o, 'quest');
    return quickCreate(ctx.services, {
      text: optText(o, 'text', { max: 8000, multiline: true, allowEmpty: true }) ?? '', attachments: attachmentsOf(ctx.services, o.attachments),
      at: optNum(o, 'at', { min: 0 }), ...(minutes !== undefined ? { minutes } : {}), ...(quest ? { quest } : {}), ...(onlyMe !== undefined ? { private: onlyMe } : {}),
      clientId: optText(o, 'clientId', { max: 100 }),
      ...(target ? { target } : {}), priority: priority === undefined ? undefined : PRIORITIES[priority], spaceId: optId(o, 'spaceId'),
    }, HUMAN_ID);
  }, TODO);
}
