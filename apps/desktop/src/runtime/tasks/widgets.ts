// Pure helpers for human to-do widgets (ask blocks from the catalog): a minimal block of a given type (the "Show as…"
// switch), titles and an agent's ask widget as stored (normalizeAskWidget); a block's time is the agents' one time
// reader (tools/builtin/util.ts parseWhen), the person's line for an answer is shared/blocks/answer-text.ts.
// Owns: those rules. Never: I/O, model calls, or a time parser of its own.

import { ALIASES, ASK_TYPES, HOST_ONLY_PROPS, YES_NO, type BlockType, type UiBlock } from '../../shared/blocks/catalog.ts';
import { excerpt } from '../../shared/text/chat-names.ts';

export function isAskBlock(block: UiBlock): boolean {
  return ASK_TYPES.has(block.type);
}

/** A minimal valid block of `type` for an existing to-do (the "Show as…" menu). */
export function widgetOfType(type: string, title: string, previous?: UiBlock): UiBlock {
  const base: Partial<UiBlock> = {};
  if (previous?.id) base.id = previous.id;
  if (previous?.due) base.due = previous.due;
  switch (type as BlockType) {
    case 'timer': return { ...base, type: 'timer', label: title, ...(previous?.at ? { at: previous.at } : {}) };
    case 'record': return { ...base, type: 'record', mode: typeof previous?.mode === 'string' ? previous.mode : 'audio', instructions: title };
    case 'upload': return { ...base, type: 'upload', label: title };
    case 'approve': return { ...base, type: 'approve', action: title };
    case 'review': return { ...base, type: 'review', src: typeof previous?.src === 'string' ? previous.src : '', question: title };
    case 'checklist': return { ...base, type: 'checklist', items: title.split(/,|;/).map(item => item.trim()).filter(Boolean) };
    case 'choice': return { ...base, type: 'choice', question: title, options: Array.isArray(previous?.options) ? previous.options : [...YES_NO] };
    case 'form': return { ...base, type: 'form', fields: [{ name: 'text', label: title, kind: 'longtext' }] };
    case 'confirm': return { ...base, type: 'confirm', instructions: title };
    default: throw new Error(`not an ask block type: ${type}`);
  }
}

/** Short verb-first title for a to-do created from a block. */
export function titleForBlock(block: UiBlock): string {
  const text = [block.title, block.question, block.action, block.label, block.instructions, block.script ? 'Record with teleprompter' : undefined]
    .find(value => typeof value === 'string' && value.trim()) as string | undefined;
  if (text) return excerpt(text, 120);
  switch (block.type) {
    case 'record': return block.video || block.fileId ? 'Record a voice-over' : block.mode === 'video' ? 'Record a video' : block.mode === 'screen' ? 'Record the screen' : 'Record audio';
    case 'upload': return 'Upload files';
    case 'checklist': return listTitle(block.items, (item) => (typeof item === 'string' ? item : (item as { text?: unknown })?.text)) ?? 'Checklist';
    case 'review': return 'Review';
    case 'form': return listTitle(block.fields, (field) => (field as { label?: unknown; name?: unknown })?.label ?? (field as { name?: unknown })?.name) ?? 'Fill in';
    default: return 'Confirm';
  }
}

/** "Charge the camera, Clean the desk +1" – the content says more than the widget name. */
function listTitle(items: unknown, text: (item: unknown) => unknown): string | undefined {
  if (!Array.isArray(items)) return undefined;
  const names = items.map(text).filter((value): value is string => typeof value === 'string' && value.trim() !== '').map((value) => value.trim());
  if (!names.length) return undefined;
  const shown = names.slice(0, 2).join(', ');
  return excerpt(names.length > 2 ? `${shown} +${names.length - 2}` : shown, 120);
}

/** What an old approve widget carried besides its yes/no (details, amount, risk) – read before it becomes a choice. */
export function approveNotes(widget: Record<string, unknown>): string {
  if (String(widget.type ?? '').toLowerCase() !== 'approve') return '';
  const amount = widget.amount && typeof widget.amount === 'object' ? widget.amount as { value?: unknown; currency?: unknown } : undefined;
  return [
    typeof widget.details === 'string' ? widget.details.trim() : '',
    amount?.value !== undefined ? `Amount: ${String(amount.value)}${typeof amount.currency === 'string' ? ` ${amount.currency}` : ''}` : '',
    typeof widget.risk === 'string' && widget.risk.trim() ? `Risk: ${widget.risk.trim()}` : '',
  ].filter(Boolean).join('\n\n');
}

/** An agent's ask widget as stored: a catalog ask type (an approve becomes a yes/no choice), no host-only props; else why not. */
export function normalizeAskWidget(widget: Record<string, unknown>): UiBlock | string {
  const raw = String(widget.type ?? '').toLowerCase();
  const type = (raw === 'approve' ? 'choice' : ALIASES[raw] ?? raw) as BlockType;
  if (!ASK_TYPES.has(type) || type === 'approve') return `widget.type must be one of: ${[...ASK_TYPES].filter((name) => name !== 'approve').join(', ')}`;
  const rest: Record<string, unknown> = { ...widget };
  for (const key of HOST_ONLY_PROPS) delete rest[key];
  if (type === 'choice' && type !== raw && rest.options === undefined) {
    rest.options = [...YES_NO];
    rest.question ??= rest.action;
  }
  return { ...rest, type } as UiBlock;
}
