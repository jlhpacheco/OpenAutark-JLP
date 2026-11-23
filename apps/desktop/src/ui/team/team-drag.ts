// Team-Call 21.11.2026: drag and drop in the team tree (TeamTree.tsx rows, sidebar and Team page alike). A row is
// draggable where the session may edit agents; while one is dragged, the row under the pointer that would take it
// (drop-model.ts dropChange) is the one drop highlight – a colour on the row itself, so nothing in the layout moves.
// The drop saves the new manager (agents.update managerId). Without a mouse the same change is the agent menu's
// "Change reports-to…" (menus.ts).
// Owns: the drag state and the row's drag props. Never: decides what a drop means (drop-model.ts) or draws rows.

import { signal } from '@preact/signals';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { agents, upsertById } from '../lib/store.ts';
import { toastError } from '../lib/toasts.ts';
import { dropChange } from './drop-model.ts';
import type { DragItem, DropChange } from './drop-model.ts';
import { teamPeople } from './org-state.ts';

const dragged = signal<DragItem | null>(null);
/** The id of the row that would take the dragged one (its highlight). */
export const dropTarget = signal<string | null>(null);

function changeFor(target: DragItem): DropChange | null {
  const from = dragged.peek();
  return from ? dropChange(from, target, agents.peek(), teamPeople.peek()) : null;
}

function end(): void {
  dragged.value = null;
  dropTarget.value = null;
}

async function save(change: DropChange): Promise<void> {
  try {
    // null clears the manager (the owner, the top); JSON keeps null where undefined would vanish (runtime org/patch.ts).
    const patch = { managerId: change.managerId ?? null };
    upsertById(agents, await rpc.call('agents.update', { id: change.agentId, patch }));
  } catch (error) {
    toastError(error, 'Could not change who it reports to');
  }
}

/** The drag props of one tree row (none where this session cannot edit agents, or for a read-only colleague). */
export function rowDrag(item: DragItem, readOnly = false): Record<string, unknown> {
  if (readOnly || !can('agents.update')) return {};
  return {
    draggable: true,
    onDragStart: (event: DragEvent) => {
      dragged.value = item;
      if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.id); }
    },
    onDragOver: (event: DragEvent) => {
      if (!changeFor(item)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      if (dropTarget.peek() !== item.id) dropTarget.value = item.id;
    },
    onDragLeave: (event: DragEvent) => {
      const row = event.currentTarget as HTMLElement;
      if (!row.contains(event.relatedTarget as Node | null) && dropTarget.peek() === item.id) dropTarget.value = null;
    },
    onDrop: (event: DragEvent) => {
      const change = changeFor(item);
      end();
      if (!change) return;
      event.preventDefault();
      void save(change);
    },
    onDragEnd: end,
  };
}
