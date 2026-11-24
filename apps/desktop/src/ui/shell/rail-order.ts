// Feedback 20031F6D (owner 21.11.2026, "die sachen würde ich gerne selber drag and drop anordnen wie ich will"): the
// rail's destinations are arranged by the person. A destination is dragged onto another and takes its place (the drop
// marker – a line on the side it lands – is drawn on the target itself, so nothing in the rail moves while dragging,
// like team-drag.ts); without a mouse Alt+Arrow up/down on a focused destination, or its right-click menu (Move up,
// Move down, Reset order). Each change saves settings.preferences.navOrder at once (lib/store.ts updatePreferences,
// optimistic) – kept across restarts and synced to the person's PCs; the phone tabs take the same order.
// Only a session that may change settings arranges; any other sees the saved order as it is.
// Owns: the drag state, the arranging actions and the destination's menu. Never: the order rule (nav-order.ts) or the rail's markup.

import { computed, signal } from '@preact/signals';
import { os } from '../lib/platform.ts';
import type { MenuSection } from '../lib/popover.tsx';
import { can } from '../lib/session.ts';
import { preferences, updatePreferences } from '../lib/store.ts';
import { toastError } from '../lib/toasts.ts';
import { DEFAULT_NAV_ORDER, dropNav, isDefaultNav, moveNav, navToSave, orderNav } from './nav-order.ts';
import type { RailKey } from './nav-order.ts';

/** The rail's (and the phone tabs') destinations in the person's order. */
export const navOrder = computed<RailKey[]>(() => orderNav(DEFAULT_NAV_ORDER, preferences.value.navOrder));

const dragged = signal<RailKey | null>(null);
/** The destination the dragged one would land on (its drop marker). */
const dropTarget = signal<RailKey | null>(null);

/** This session may arrange the rail (the order lives in settings). */
export function canArrange(): boolean {
  return can('settings.update');
}

function save(order: readonly RailKey[]): void {
  updatePreferences({ navOrder: navToSave(DEFAULT_NAV_ORDER, order) }).catch((error: unknown) => toastError(error, 'Could not save the order'));
}

/** The keyboard focus stays on the moved destination once the rail has redrawn. */
function keepFocus(key: RailKey): void {
  requestAnimationFrame(() => document.querySelector<HTMLElement>(`.rail [data-nav="${key}"] button`)?.focus({ preventScroll: true }));
}

/** Moves `key` one step up (-1) or down (1); false at the end it would leave. */
export function moveDestination(key: RailKey, step: -1 | 1, focus = false): boolean {
  const next = moveNav(navOrder.peek(), key, step);
  if (!next) return false;
  save(next);
  if (focus) keepFocus(key);
  return true;
}

/** Back to the default order. */
export function resetNavOrder(): void {
  save(DEFAULT_NAV_ORDER);
}

/** Where `key` shows the drop marker while another is dragged over it: the side the dragged one lands on. */
export function dropSide(key: RailKey): 'before' | 'after' | null {
  const from = dragged.value;
  if (!from || dropTarget.value !== key || from === key) return null;
  const order = navOrder.value;
  return order.indexOf(from) > order.indexOf(key) ? 'before' : 'after';
}

/** `key` is being dragged. */
export function isDragged(key: RailKey): boolean {
  return dragged.value === key;
}

function end(): void {
  dragged.value = null;
  dropTarget.value = null;
}

/** The drag props of one rail destination (none where this session cannot arrange). */
export function navDrag(key: RailKey): Record<string, unknown> {
  if (!canArrange()) return {};
  return {
    draggable: true,
    onDragStart: (event: DragEvent) => {
      dragged.value = key;
      if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', key); }
    },
    onDragOver: (event: DragEvent) => {
      const from = dragged.peek();
      if (!from || from === key) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      if (dropTarget.peek() !== key) dropTarget.value = key;
    },
    onDragLeave: (event: DragEvent) => {
      const item = event.currentTarget as HTMLElement;
      if (!item.contains(event.relatedTarget as Node | null) && dropTarget.peek() === key) dropTarget.value = null;
    },
    onDrop: (event: DragEvent) => {
      const from = dragged.peek();
      end();
      const next = from && dropNav(navOrder.peek(), from, key);
      if (!next) return;
      event.preventDefault();
      save(next);
    },
    onDragEnd: end,
  };
}

/** Alt+Arrow up/down on a focused destination moves it (the drag's keyboard way). */
export function onNavKey(key: RailKey, event: KeyboardEvent): void {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !canArrange()) return;
  const step = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
  if (!step) return;
  event.preventDefault();
  moveDestination(key, step, true);
}

const ALT = os === 'mac' ? '⌥' : 'Alt+';

/** A destination's right-click menu: Move up, Move down, Reset order (empty where this session cannot arrange). */
export function navMenu(key: RailKey): MenuSection[] {
  if (!canArrange()) return [];
  const order = navOrder.peek();
  const at = order.indexOf(key);
  return [
    { items: [
      { label: 'Move up', icon: 'arrow-up', hint: `${ALT}↑`, disabled: at <= 0, onSelect: () => { moveDestination(key, -1, true); } },
      { label: 'Move down', icon: 'arrow-down', hint: `${ALT}↓`, disabled: at < 0 || at >= order.length - 1, onSelect: () => { moveDestination(key, 1, true); } },
    ] },
    { items: [
      { label: 'Reset order', icon: 'arrow-counter-clockwise', disabled: isDefaultNav(DEFAULT_NAV_ORDER, order), onSelect: resetNavOrder },
    ] },
  ];
}
