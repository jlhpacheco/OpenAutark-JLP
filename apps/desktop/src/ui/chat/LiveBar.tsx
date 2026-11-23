// The chat's live bar right above its composer (owner 13.11.2026: "eine Leiste über dem Textfeld … dass eine KI
// arbeitet"): one slim line per agent – or part of a split agent – working for this chat right now, "● Lena · Reading
// invoices.pdf · 2 min" (a part: "● Lena · #2 Press DACH · …"). Where it shows is the runtime's one rule
// (runtime/chat/live.ts, the summary's `live`): the work came from this chat, posted into it, or was given away from it
// (20.11.2026: Felix on the task Konrad gave him here). Its Stop names the line's agent and this chat (StopRun.tsx). A line is a button to
// the agent's Work page with its activity log (the log lives there since F11, 16.11.2026); its title says what it runs on (model · effort · temperature). Feedback F21
// (16.11.2026): at its right end, in a fixed slot, that agent's own Stop (StopRun.tsx – only this run, others keep
// working; a split part has none, its slot stays empty). A run on another of the person's PCs shows here too
// (runtime/devices/sync/live.ts) and its Stop reaches that PC. The bar
// takes its height only while someone works and sits between the messages and the composer, so the person's newest
// line stays right above it; nothing in it moves on a click. The minutes advance on one 30 s clock while it shows.
// 22.11.2026: a context fold's line says "Folding its context" instead of its step (its steps stay in the ▾ list).
// Owner 19.11.2026: each line starts with a ▾ in a fixed cell that opens it a little – its recent steps to scroll and
// "Watch live" (LiveBarMore.tsx); the cell only swaps ▾ for ▴, and an open line stays open while its run runs.
// 20.11.2026: the bar is the one place for who works – the header's live line (LiveLine.tsx) opens or closes every
// line of this chat's bar (toggleLines); the working popover that drew the same rows a second time is gone. A click
// inside an open line keeps the bar's height (keptHeight) until a line opens, closes or ends: a part's steps or older
// steps open inside it and scroll there, never moving the rows above the click.
// Owns: the bar's markup, which lines are open, its kept height and its clock. Never: invents a step, or shows work the summary does not list.

import { useEffect, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import type { ConversationSummary, LiveRun } from '../../shared/model/chat.ts';
import { agentName } from '../lib/store.ts';
import { go } from '../lib/router.ts';
import { can } from '../lib/session.ts';
import { partLabel } from '../splits/split-text.ts';
import { Icon } from '../lib/ui.tsx';
import { StopRun } from './StopRun.tsx';
import { LiveBarMore } from './LiveBarMore.tsx';
import { barStopRun, doingOf, keptHeight, modelLine, noteText, openLines, shownOf, withTemperature } from './live-text.ts';
import type { KeptBar } from './live-text.ts';

const TICK_MS = 30_000;
const clock = signal(Date.now());
/** The runs whose line the person opened (kept across chats and re-renders; a run that ends leaves with its line). */
const opened = signal<ReadonlySet<string>>(new Set());

function toggle(runId: string): void {
  const next = new Set(opened.value);
  if (!next.delete(runId)) next.add(runId);
  opened.value = next;
}

/** True while one of these runs' lines is open (the header's live line shows it as pressed). */
export function linesOpen(runIds: readonly string[]): boolean {
  return runIds.some((id) => opened.value.has(id));
}

/** The header's live line: opens every line of the chat's bar, or closes them when one is open. */
export function toggleLines(runIds: readonly string[]): void {
  const next = new Set(opened.value);
  const open = linesOpen(runIds);
  for (const id of runIds) { if (open) next.delete(id); else next.add(id); }
  opened.value = next;
}

/** How long it works so far: "<1 min", "4 min", "1 h 5 min". */
export function sinceText(startedAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - startedAt) / 60_000);
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ''}`;
}

/** What a line says after the name: a part's label first, then what it does now (a fold says so, else its step, else its note). */
export function lineText(run: Pick<LiveRun, 'step' | 'note' | 'split' | 'fold'>): string {
  const doing = noteText(doingOf(run));
  return run.split ? `${partLabel(run.split)} · ${doing}` : doing;
}

export function LiveBar(props: { chat: Pick<ConversationSummary, 'id' | 'live'> }) {
  const runs = props.chat.live ?? [];
  const working = runs.length > 0;
  const [kept, setKept] = useState<KeptBar>();
  useEffect(() => {
    if (!working) return;
    clock.value = Date.now();
    const timer = setInterval(() => { clock.value = Date.now(); }, TICK_MS);
    return () => clearInterval(timer);
  }, [working]);
  if (!working) return null;
  const now = Math.max(clock.value, ...runs.map((run) => run.startedAt));
  const stops = can('runs.cancel');
  const open = opened.value;
  const lines = openLines(runs, open);
  const height = keptHeight(kept, lines);
  // A click inside an open line (a part's row, older steps) keeps the bar's height first: the bar grows upward from the
  // composer, so what opens there would move every row above the click; inside the kept height it scrolls instead.
  const keep = (event: MouseEvent) => {
    const bar = event.currentTarget as HTMLElement;
    if (lines && (event.target as Element).closest('.live-bar-more')) setKept({ lines, height: parseFloat(getComputedStyle(bar).height) });
  };
  return (
    <div class={`live-bar${lines ? ' open' : ''}`} style={height ? { height: `${height}px` } : undefined} onClickCapture={keep}
      role="status" aria-label="Working now">
      {runs.map((run) => {
        const name = agentName(run.agentId);
        const text = lineText(run);
        const model = withTemperature(modelLine({ modelName: run.model, effort: run.effort }), shownOf(run));
        const stop = barStopRun(run, stops);
        const isOpen = open.has(run.runId);
        return (
          <div key={run.runId} class="live-bar-item">
            <div class="live-bar-row">
              <button type="button" class="live-bar-caret" aria-expanded={isOpen} aria-controls={`live-more-${run.runId}`}
                aria-label={isOpen ? `Close what ${name} does` : `Open what ${name} does`} onClick={() => toggle(run.runId)}>
                <Icon name={isOpen ? 'caret-up' : 'caret-down'} size={12} />
              </button>
              <button type="button" class="live-bar-line" data-run-id={run.runId} onClick={() => go.work(run.agentId)}
                title={[`${name} · ${text}`, model].filter(Boolean).join('\n')}>
                <span class="live-bar-dot" aria-hidden="true" />
                <span class="live-bar-name">{name}</span>
                <span class="live-bar-text">{text}</span>
                <span class="live-bar-time tabular">{sinceText(run.startedAt, now)}</span>
              </button>
              {stops && <span class="live-bar-stop">{stop && <StopRun key={stop} runId={stop} name={name} shown={{ agentId: run.agentId, chatId: props.chat.id }} />}</span>}
            </div>
            {isOpen && <LiveBarMore run={run} name={name} />}
          </div>
        );
      })}
    </div>
  );
}
