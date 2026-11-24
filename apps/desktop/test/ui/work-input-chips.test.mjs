// Owns: the Work view's input line when a quest is selected – the quest chip's name must stay inside its chip and
// never paint over the hint (the placeholder-like line after the chips), at 100 % and 150 % and at narrow widths.
// Renders the real styles (tokens.css, base.css, tasks-page.css) and the chip row's markup as TaskInput.tsx writes it.
// Never: starts the app, reads live data, or opens a listening socket.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '../..');
const styles = path.join(root, 'src/ui/styles');

const QUEST_TITLE = 'Integer-cent totals, per-line VAT and total CLI in invoice-import';
const HINT = 'A time in your words goes on the calendar · /15:00 works too';

async function pageFor({ width, zoom }) {
  const [tokens, base, tasks] = await Promise.all(
    ['tokens.css', 'base.css', 'tasks-page.css'].map((name) => readFile(path.join(styles, name), 'utf8')),
  );
  // The chip row as TaskInput.tsx renders it while a quest is selected (questMode off, no extra chips, no time).
  return `<!doctype html><html><head><style>${tokens}\n${base}\n${tasks}
    body { margin: 0; font-family: system-ui, sans-serif; zoom: ${zoom}; }
    #host { width: ${width}px; padding: 12px; box-sizing: border-box; }
    </style></head><body><div id="host">
      <form class="task-input">
        <div class="task-input-row">
          <div class="task-input-box"><textarea class="task-input-field" rows="1" placeholder="Add anything – a to-do, a time, or just talk…"></textarea></div>
        </div>
        <div class="task-input-chips">
          <span class="task-chip quest" style="--qc: var(--wf-c1)"><span class="task-dot" aria-hidden="true"></span><span class="task-chip-text">In ${QUEST_TITLE}</span><button type="button" class="task-chip-x" aria-label="Not into this quest">×</button></span>
          <span class="task-input-hint">${HINT}</span>
        </div>
      </form>
    </div></body></html>`;
}

const WIDTHS = [1000, 620, 420, 300];
const ZOOMS = [1, 1.5];

test('quest chip name never paints over the hint line (100 % and 150 %, wide to narrow)', { timeout: 120_000 }, async () => {
  // HEADLESS_SHELL_PATH: an installed chrome-headless-shell when Playwright's own download is missing.
  const browser = await chromium.launch({ headless: true, executablePath: process.env.HEADLESS_SHELL_PATH || undefined });
  try {
    for (const zoom of ZOOMS) {
      for (const width of WIDTHS) {
        const page = await browser.newPage({ viewport: { width: 1200, height: 400 } });
        await page.setContent(await pageFor({ width, zoom }));
        const result = await page.evaluate(() => {
          const chip = document.querySelector('.task-chip.quest');
          const label = chip.querySelector('.task-chip-text');
          const hint = document.querySelector('.task-input-hint');
          const c = chip.getBoundingClientRect();
          const h = hint.getBoundingClientRect();
          const l = label ? label.getBoundingClientRect() : null;
          return {
            hasLabelSpan: !!label,
            chipRight: c.right,
            chipVisualOverflow: chip.scrollWidth - chip.clientWidth,
            labelRight: l ? l.right : null,
            labelTruncated: label ? label.scrollWidth > label.clientWidth : null,
            hintLeft: h.left,
            hintWidth: h.width,
          };
        });
        const where = `zoom ${zoom}, width ${width}`;
        assert.ok(result.chipVisualOverflow <= 0.5, `${where}: the quest chip paints ${result.chipVisualOverflow}px past its box`);
        assert.ok(result.chipRight <= result.hintLeft + 0.5, `${where}: quest chip ends at ${result.chipRight}, hint starts at ${result.hintLeft}`);
        assert.ok(result.labelRight === null || result.labelRight <= result.hintLeft + 0.5, `${where}: quest name ends at ${result.labelRight}, hint starts at ${result.hintLeft}`);
        assert.ok(result.hasLabelSpan, `${where}: the quest name needs its own .task-chip-text box to be cut at its end`);
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});
