// The two text sizes (owner 21.11.2026: "Schriftgröße soll man ändern können … für Überschriften, Chatnamen,
// Einstellungsnamen … und eine zweite Einstellung für Content, Chats … überall wo Texte wie Systemprompt stehen"), kept
// on this device (a screen's own choice, never synced). Owner 21.11.2026 later: "Pixel-Einstellungen, nicht nur größer,
// sondern auch kleiner … hoch und runter und selber Eingabe, aber mit klaren Grenzen" – each size is a pixel value with
// fixed bounds around the default; the stylesheets get its ratio to the default:
// - Labels (--ui-text): every font size of the app's stylesheets is `calc(Npx * var(--ui-text, 1))`, so headings, chat
//   names, setting names and every short text follow it – only the letters (a row with a minimum height grows by what they
//   need; icons, cells and the window frame keep their size, no native page shifts);
// - Text (--text-size): content – textareas (system prompts, skills, notes), rendered markdown and code take it as their
//   --ui-text (base.css); a chat's own column grows as a whole by CSS zoom (--chat-zoom, chat.css; Theo 17.11.2026),
//   inside it both sizes read 1. Ctrl and + / = / − / 0 on the desktop steps the text size by 1 px (shell/Shell.tsx).
// Owns: the defaults, the bounds, the stored sizes and the root properties. Never: zooms the whole window or any native view.

import { signal } from '@preact/signals';

/** One size: its default (what the stylesheets are written for), its bounds and where it is kept. */
export interface SizeSpec { base: number; min: number; max: number; key: string }
/** Labels: written for 13 px (most labels); 10–17 px, what fixed cells (header, rail) still hold. */
export const LABELS: SizeSpec = { base: 13, min: 10, max: 17, key: 'wf.labelPx' };
/** Text: written for 14 px (a chat message); 10–24 px. */
export const TEXT: SizeSpec = { base: 14, min: 10, max: 24, key: 'wf.textPx' };

/** The labels size now, in px. */
export const labelPx = signal(LABELS.base);
/** The text size now, in px. */
export const textPx = signal(TEXT.base);

/** A typed or stored value inside the bounds, whole pixels; anything else is the default. */
export function clampPx(raw: unknown, spec: SizeSpec): number {
  const value = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(',', '.').trim() || NaN);
  if (!Number.isFinite(value)) return spec.base;
  return Math.min(spec.max, Math.max(spec.min, Math.round(value)));
}

/** Which way a key press sizes the text (undefined: not a size key). `mod` is Ctrl (Cmd on macOS), no Alt. */
export function zoomKey(event: { key: string; mod: boolean; alt: boolean }): -1 | 0 | 1 | undefined {
  if (!event.mod || event.alt) return undefined;
  if (event.key === '+' || event.key === '=') return 1;
  if (event.key === '-' || event.key === '_') return -1;
  if (event.key === '0') return 0;
  return undefined;
}

function apply(spec: SizeSpec, px: number): void {
  const root = document.documentElement.style;
  const ratio = px / spec.base;
  const set = (name: string) => (px === spec.base ? root.removeProperty(name) : root.setProperty(name, String(Number(ratio.toFixed(4)))));
  if (spec === LABELS) { labelPx.value = px; set('--ui-text'); return; }
  textPx.value = px;
  set('--text-size');
  set('--chat-zoom');
}

/** Sets a size (clamped) and keeps it on this device; returns the px it took. */
export function setSize(spec: SizeSpec, raw: unknown): number {
  const px = clampPx(raw, spec);
  apply(spec, px);
  try { if (px === spec.base) localStorage.removeItem(spec.key); else localStorage.setItem(spec.key, String(px)); } catch { /* storage blocked: this page only */ }
  return px;
}

/** Reads both stored sizes at start (idempotent). */
export function restoreTextSizes(): void {
  for (const spec of [LABELS, TEXT]) {
    let raw: string | null = null;
    try { raw = localStorage.getItem(spec.key); } catch { /* none */ }
    apply(spec, raw === null ? spec.base : clampPx(raw, spec));
  }
}
