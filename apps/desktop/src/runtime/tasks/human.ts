// Human to-do flows of the TaskService: agent ask blocks → to-dos (B-078 D9: only important ones, "todo": true and
// timers – catalog.ts becomesTodo; the rest are quick replies answered in the message; idempotent per
// message + block index; a block "id" replaces the earlier open one of the same author – another
// agent's block with that id is a to-do of its own –, and answers or snoozes of
// the newer block find it – tasks/block-todo.ts), answers (store result, complete the to-do quietly,
// post the person's own line – a click on a button is what they picked, in full, shared/blocks/answer-text.ts –
// and wake the authoring agent as for a line they typed; F06: the answer's stored files ride on that line –
// tasks/answer-files.ts, tasks/answer-receipt.ts; the person's decline {declined, reason} drops the to-do instead –
// tasks/decline.ts, never a mini-app's own data),
// widget switching ("Show as…"; mini-apps keep theirs; a typed line is tasks/quick.ts), "Later" (F03: the
// to-do's `at` moves – it rings then; no receipt, nobody woken; a snooze answer of older widgets is routed here) and repeating timers
// (Done posts a receipt and the to-do's `at` moves to its next time; the author hears only the first Done; "Stop repeating"
// ends it); every widget goes through tasks/timers.ts (validated when an agent wrote it, a timer's time is the to-do's `at`). B-054: a to-do needs no chat – one typed into the
// list is chat-free, and an answer to a chat-free to-do is stored on its row (no receipt; the author's wake has
// no chat). The old hidden To-do chat stays an inert row (migration 82 keeps it out of every chat list).
// Mini-app to-dos (F01): every ```app todo=true fence of an agent's message becomes a to-do too
// (ingestApps, run by ingestBlocks; same `blk:<messageId>:<index>` key, so the app's
// wf.complete → blocks.answer finishes it with "Done in mini-app" and the data the app handed back as the
// person's line); fences the person or a bridge wrote are none, and its widget
// (shared/blocks/app-todo.ts) cannot be switched to a catalog one. X03: its answer carries the
// files the app stored with wf.upload, and answering or declining releases the rest (tasks/app-files.ts).
// F-52: in a chat with people an agent's ask goes to the human who wrote last (people/ask-target.ts).
// Sicher-Runde 19.11.2026: a security request's to-do (tasks/approval-todo.ts) is answered by the security service –
// no person's line, no author wake here (the service wakes the agent when no call waits).
// Umzug 21.11.2026 (H2): a request another of the person's PCs holds gets the answer there (security/answer-relay.ts).
// Owns: those flows. Never: puts agent work on the list.

import { HUMAN_ID } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { APP_TODO_TITLE, appTodoWidget, appWidgetOf } from '../../shared/blocks/app-todo.ts';
import { becomesTodo, isImportantAsk, type UiBlock } from '../../shared/blocks/catalog.ts';
import { appTodosOf, uiBlocksOf } from '../../shared/blocks/parse.ts';
import type { Message } from '../../shared/model/chat.ts';
import { isFinished, type Task, type TaskView, type TodoRepeat } from '../../shared/model/tasks.ts';
import { nextWorkStart, ringAt } from '../../shared/model/day-settings.ts';
import { dayZone, daySettings } from '../day/clock.ts';
import type { TaskService } from '../contracts.ts';
import type { TaskServiceImpl } from './service.ts';
import { answerText, oneLine } from '../../shared/blocks/answer-text.ts';
import { answerFiles, fileNames } from './answer-files.ts';
import { releaseAppFiles } from './app-files.ts';
import { evidenceFor, postAnswer } from './answer-receipt.ts';
import { blockTodo } from './block-todo.ts';
import { declineFrom, declineTodo } from './decline.ts';
import { nextRepeat, prepareWidget, repeatOf, snoozeUntil } from './timers.ts';
import { isAskBlock, titleForBlock, widgetOfType } from './widgets.ts';
import { parseWhen } from '../tools/builtin/util.ts';
import { askTarget } from '../people/ask-target.ts';
import { approvalAnswer, approvalIdOf } from './approval-todo.ts'; // Sicher-Runde: security requests as to-dos
import { answerAs } from '../security/rpc-guard.ts'; // FX1 H1: who may answer how
import { relayAnswer } from '../security/answer-relay.ts'; // Umzug H2: an answer for a request another PC holds
import { currentCaller } from '../rpc/caller.ts';
import type { ApprovalAnswer } from '../../shared/model/security-settings.ts';
import type { RuntimeServices } from '../contracts.ts';

const DAY_MS = 86_400_000;

export class HumanTodos {
  private readonly t: TaskServiceImpl;
  constructor(tasks: TaskServiceImpl) { this.t = tasks; }

  ingestBlocks(message: Message, blocks: UiBlock[], indexes?: number[]): TaskView[] {
    const out: TaskView[] = [];
    const zone = dayZone(this.t.s);
    blocks.forEach((block, position) => {
      if (!isAskBlock(block) || block.todo === false) return;
      const index = indexes?.[position] ?? position; // parse index = the chat's blockIndex
      const clientId = `blk:${message.id}:${index}`;
      const existing = this.t.repo.byClientId(clientId);
      if (existing) { out.push(this.t.views([existing])[0]); return; }
      const title = titleForBlock(block);
      // A later block with the same "id" in the same chat replaces the open one – only the same author's.
      const previous = typeof block.id === 'string' && block.id ? this.t.repo.openByBlockId(message.conversationId, block.id, message.authorId) : undefined;
      // B-078 D9: an ordinary quick reply stays in the message (blocks.answer answers it there); only an important
      // one, "todo": true or a timer becomes a to-do – and a block that updates an open to-do keeps it current.
      if (!previous && !becomesTodo(block)) return;
      if (previous) {
        const armed = prepareWidget(block, message.createdAt, message.authorId, zone);
        const updated = this.t.mutate(previous.id, draft => {
          draft.widget = armed.widget; draft.title = title; draft.messageId = message.id;
          if (armed.at !== undefined) draft.at = armed.at; // a timer's time is the to-do's
        });
        out.push(this.t.emit(updated));
        return;
      }
      const asked = askTarget(this.t.s.db, message.conversationId, message.seq, block); // the person who wrote last, else the owner
      const view = this.t.create({
        conversationId: message.conversationId, title, assigneeKind: 'human', ...(asked ? { assigneeId: asked } : {}), widget: block,
        createdBy: message.authorId, priority: isImportantAsk(block) ? 1 : 0, at: parseWhen(block.due, message.createdAt, zone),
        parentId: this.openParent(message),
      }, { anchor: message, clientId });
      out.push(view);
    });
    out.push(...this.ingestApps(message));
    return out;
  }

  /**
   * ```app todo=true fences of an agent's message → mini-app to-dos, idempotent per message +
   * parse index (create keeps the first to-do of a client id). Title from title= ('Mini-app'),
   * reason from reason= ('taste'); the widget is the runtime's own (not validated as a block).
   * A fence that cannot become one is logged and skipped (own savepoint): it never fails the turn.
   */
  ingestApps(message: Message): TaskView[] {
    if (message.authorKind !== 'agent' || message.meta?.via === 'bridge') return [];
    const out: TaskView[] = [];
    for (const { index, attrs } of appTodosOf(message.body)) {
      try {
        const asked = askTarget(this.t.s.db, message.conversationId, message.seq);
        out.push(this.t.s.db.tx(() => this.t.create({
          conversationId: message.conversationId, title: attrs.title?.trim() || APP_TODO_TITLE, assigneeKind: 'human', ...(asked ? { assigneeId: asked } : {}),
          // Task.widget is still typed UiBlock; the stored value is an AppTodoWidget (shared/model/tasks.ts).
          widget: appTodoWidget(message.id, index, attrs) as unknown as UiBlock,
          createdBy: message.authorId, parentId: this.openParent(message),
        }, { anchor: message, clientId: `blk:${message.id}:${index}`, runtimeWidget: true })));
      } catch (error) {
        this.t.s.log?.warn('mini-app to-do failed', { messageId: message.id, index, error: String(error) });
      }
    }
    return out;
  }

  /** The message's open top-level task: a to-do from its blocks becomes a step of it. */
  private openParent(message: Message): string | undefined {
    const parent = message.taskId ? this.t.repo.get(message.taskId) : undefined;
    return parent && !isFinished(parent.status) && !parent.parentId ? parent.id : undefined;
  }

  answer(input: Parameters<TaskService['answer']>[0]): TaskView | undefined {
    const s = this.t.s;
    let task: Task | undefined = input.taskId ? this.t.repo.get(input.taskId) : undefined;
    if (!task && input.messageId && input.blockIndex !== undefined) task = blockTodo(s, input.messageId, input.blockIndex);
    if (input.taskId && !task) throw new WorkforceError('not_found', 'To-do not found.', { details: { taskId: input.taskId } });
    if (!task && !input.messageId) throw new WorkforceError('bad_request', 'An answer needs a taskId or a messageId.');
    if (task?.status === 'done' && task.result?.answer !== undefined) return this.t.views([task])[0]; // double answer
    const approval = task ? approvalIdOf(s.db, task.id) : undefined; // a security request: its answer goes to the service, no chat line
    if (task && approval) return this.answerApproval(task, approval, approvalAnswer(input.answer, declineFrom(input, task) !== undefined));
    // A snooze answer (older widgets) snoozes the to-do instead of finishing it.
    const snooze = task?.widget?.type === 'timer' ? snoozeUntil(input.answer, s.clock.now()) : undefined;
    if (task && snooze !== undefined) return this.snooze(task.id, snooze);
    const messageId = input.messageId ?? task?.messageId;
    const message = messageId ? s.chats.message(messageId) : undefined;
    const conversationId = task?.conversationId ?? message?.conversationId; // B-054: none for a chat-free to-do
    if (!task && !message) throw new WorkforceError('not_found', 'Message not found.');
    const block = task?.widget;
    const blockKey = typeof block?.id === 'string' && block.id ? block.id
      : messageId && input.blockIndex !== undefined ? `${messageId}:${input.blockIndex}` : task?.id ?? messageId!;
    // "Can't do this…" (F06): the to-do is cancelled and its author hears why (tasks/decline.ts);
    // the entry point decides – a mini-app's own data never declines (declineFrom).
    const declined = declineFrom(input, task);
    if (declined) {
      const cancelled = declineTodo(this.t, { task, message, conversationId, blockKey, by: input.by, clientId: input.clientId }, declined);
      releaseAppFiles(s, block, []); // a mini-app's stored takes go to the clean-up
      return cancelled;
    }
    // A block without a to-do ("todo": false) is read from its message, so its line says what was picked too.
    const asked = block ?? (message && input.blockIndex !== undefined ? uiBlocksOf(message.body).find((item) => item.index === input.blockIndex)?.block : undefined);
    const files = answerFiles(s, input.answer, asked); // stored files only: attached to the person's line
    const text = answerText(asked, input.answer, fileNames(files)); // the person's line: what they picked, in full
    const summary = oneLine(text);

    let view: TaskView | undefined;
    let receiptKey = blockKey;
    let first = true;
    const repeat = task ? repeatOf(task.widget) : undefined;
    if (task && repeat) {
      // A repeating timer is done for now: its `at` moves to its next time (each Done has its own receipt).
      const count = (task.ledger.doneCount ?? 0) + 1;
      first = count === 1;
      receiptKey = `${blockKey}@${count}`;
      const now = s.clock.now();
      const next = nextRepeat(repeat, task.at ?? now, now);
      view = this.t.emit(this.t.mutate(task.id, draft => {
        draft.ledger = { ...draft.ledger, doneCount: count };
        draft.at = next;
        if (draft.widget?.type === 'timer') draft.widget = { ...draft.widget, at: new Date(next).toISOString() };
      }));
    } else if (task) {
      view = this.t.finish(task.id, { status: 'done', summary, evidence: evidenceFor(summary, files, input.answer), answer: input.answer }, input.by);
    }
    // The person's line (with the answer's files; only in a chat) and, for the first answer, the author's wake.
    const question = asked ? titleForBlock(asked) : task?.title; // review fix: which ask this line answers
    postAnswer(s, { conversationId, text, summary, question, by: input.by, message, task, blockKey, receiptKey, clientId: input.clientId, files, wake: first });
    releaseAppFiles(s, block, files.map((file) => file.attachment.fileId)); // the takes it did not hand back go
    return view;
  }

  /** Sicher-Runde: the person's answer to a security request (tasks/approval-todo.ts); the service ends the to-do. */
  private answerApproval(task: Task, requestId: string, answer: ApprovalAnswer | undefined): TaskView {
    if (!answer) throw new WorkforceError('bad_request', 'Answer with one of the request\'s options.');
    const security = (this.t.s as Partial<Pick<RuntimeServices, 'security'>>).security;
    if (!security) throw new WorkforceError('unavailable', 'Security requests are not available.');
    const given = answerAs(currentCaller()?.scope, answer); // FX1 H1: a to-do-only phone's 'Always …' counts as 'once'
    try { security.answer(requestId, given); } catch (error) {
      if (!(error instanceof WorkforceError) || error.code !== 'not_found') throw error;
      const drop = () => { const now = this.t.repo.get(task.id); if (now && !isFinished(now.status)) this.t.finish(task.id, { status: 'dropped', summary: 'No longer waiting', quiet: true, answer: { choice: given } }, HUMAN_ID); };
      // Umzug 21.11.2026 (H2): the request is held on the PC that asked – the answer goes there (security/answer-relay.ts)
      const relayed = isFinished(task.status) ? 'none' : relayAnswer(this.t.s as RuntimeServices, requestId, given, drop);
      if (relayed === 'offline') throw new WorkforceError('unavailable', 'The PC that asked is not reachable right now; this request waits until it is back.');
      if (relayed === 'none') drop(); // answered elsewhere or gone
    }
    return this.t.views([this.t.require(task.id)])[0];
  }

  /**
   * "Later": the to-do (by id, or the to-do of a chat block) moves to `until` – its `at`, so it rings then; no receipt,
   * nobody woken (the person's Undo takes it back).
   */
  snooze(ref: string | { messageId: string; blockIndex: number }, until: number): TaskView {
    const s = this.t.s;
    const found = typeof ref === 'string' ? this.t.repo.get(ref) : blockTodo(s, ref.messageId, ref.blockIndex);
    if (!found) throw new WorkforceError('not_found', 'To-do not found.');
    const task = found;
    const id = task.id;
    if (task.assigneeKind !== 'human') throw new WorkforceError('bad_request', 'Only to-dos can be snoozed.');
    if (isFinished(task.status)) throw new WorkforceError('conflict', 'This to-do is already finished.');
    const now = s.clock.now();
    if (!Number.isFinite(until) || until < now + 60_000 || until > now + 30 * DAY_MS) throw new WorkforceError('bad_request', 'Snooze for at least a minute and at most 30 days.');
    return this.t.update(id, { at: until }, HUMAN_ID);
  }

  /** "Stop repeating": the repeating timer ends and the to-do is done. */
  stopRepeating(id: string, by: string): TaskView {
    const task = this.t.require(id);
    if (task.assigneeKind !== 'human' || !repeatOf(task.widget)) throw new WorkforceError('bad_request', 'This to-do does not repeat.');
    const { repeat: _ended, ...widget } = task.widget!;
    this.t.mutate(id, (draft) => { draft.widget = widget as UiBlock; });
    return this.t.finish(id, { status: 'done', summary: 'Stopped repeating', evidence: [{ kind: 'note', label: 'Stopped repeating' }] }, by);
  }

  /** "Show as" another widget (mini-apps keep theirs). With `repeat` (the menu's Repeat › Daily · Weekdays · Weekly, type
   *  'timer') the to-do repeats at its own time – without one from the start of the next working day. */
  changeWidget(id: string, type: string, repeat?: TodoRepeat): TaskView {
    const task = this.t.require(id);
    if (task.assigneeKind !== 'human') throw new WorkforceError('bad_request', 'Only human to-dos have a widget.');
    if (appWidgetOf(task.widget)) throw new WorkforceError('bad_request', 'A mini-app to-do keeps its mini-app.');
    if (repeat && type !== 'timer') throw new WorkforceError('bad_request', 'Only a timer repeats.', { details: { type } });
    let block: UiBlock;
    try { block = widgetOfType(type, task.title, task.widget); } catch {
      throw new WorkforceError('bad_request', 'Unknown widget type.', { details: { type } });
    }
    const now = this.t.s.clock.now();
    const zone = dayZone(this.t.s);
    if (repeat) {
      const { workStart } = daySettings(this.t.s);
      const at = ringAt(task, zone, workStart) ?? nextWorkStart(now, zone, workStart); // a day without a time: its work start
      block = { ...block, repeat, at: new Date(at).toISOString() };
    }
    const armed = prepareWidget(block, now, HUMAN_ID, zone);
    const updated = this.t.mutate(id, draft => {
      draft.widget = armed.widget;
      if (armed.at !== undefined) draft.at = armed.at; // a timer's time is the to-do's
    });
    return this.t.emit(updated);
  }
}
