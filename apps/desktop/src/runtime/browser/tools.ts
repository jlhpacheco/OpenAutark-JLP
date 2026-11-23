// browser.* tools. An agent browses in its own browser (its own profile: the logins it made stay – service.ts) or in the
// person's browser – `where: 'chat'` (this chat's area above its messages, shared by everyone in the chat, where that
// chat's work goes) or 'global' (the person's own pane, theirs across chats), one session: a login the person makes in
// one of those tabs holds in both (side.ts). A call goes where the agent worked last in this chat unless `where` or a
// tab id says otherwise (place.ts); a page opened there without newTab takes the agent's preview tab (show-tool.ts
// show-tool.ts). 'own' here is always the agent's own browser; its area on its agent page takes pages through
// browser.show (show-tool.ts). Stored secrets fill by handle in both (value
// "secret://<id>"). Page results carry the untrusted-content line, the others pointing at that tab (named cursors,
// runtime/pointers), a human check as a fact and `structured.url` (the registry's site hints). browser.find/console/network/eval/wait are inspect-tools.ts,
// browser.save_secret and browser.save_totp secret-tools.ts.
// B-080: browser.open where: 'chrome' opens the page in the person's own Chrome (own-chrome.ts: their profile and logins,
// a window I then work in with computer.*) – decided before Places, so every other browser tool keeps own, chat and
// global; in the person's browser a step named by its words is looked up there first (side.ts); every tab line names
// its browser (place.ts tabLine).
// 21.11.2026 (owner): browser.batch moves like a hand by default, like browser.act (motion.ts, DEFAULT_MOTION); the agent
// passes `glide` (≤ 300 ms per pointed step) or `instant` (a jump) for a step or batch that should be quick, in either browser.
// 18.11.2026 (owner: "the AI can always see each human's tabs"): browser.tabs in chat or global also lists what that
// space holds on the person's other PCs (other-pc-tabs.ts) – a chat's area is what everyone in that chat sees.
// Owns: schemas, where a call goes, summaries and outputs. Never: puts secret values into outputs.

import type { ToolContext, ToolDef, ToolOutput } from '../tools/types.ts';
import { text } from '../tools/types.ts';
import { defineTool } from '../tools/builtin/util.ts';
import { imageOutput } from '../computer/tools.ts';
import { DEFAULT_MOTION, MOTION_STYLES, type MotionStyle } from '../../shared/model/pointer-motion.ts';
import { BATCH_MAX, type BatchOutcome, type BatchStep, type BrowserService } from './service.ts';
import { describeTarget, type BrowserAction, type BrowserTarget } from './page.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { SideActStep } from '../../shared/model/side-browser.ts';
import type { ComputerService } from '../computer/service.ts';
import { callerOf } from '../computer/lease.ts';
import { POINTER_ACTIONS } from './motion.ts';
import { SECRET, sideCall, sidePage, sideStep, type StepArgs } from './side.ts';
import { maskSetupKeys, pageText, Places, sideOn, surfaceOf, tabLine, TAB_ID, TAB_PROP, UNTRUSTED, useOf, WHERE_PROP, type On, type Place } from './place.ts';
import { openInOwnChrome, type OwnChromeOptions } from './own-chrome.ts';
import { typedText } from '../secrets/handles.ts'; // a stored link (secret://<id>) in browser.open's url
import { inspectTools } from './inspect-tools.ts';
import { secretTools } from './secret-tools.ts';
import { otherPcTabs } from './other-pc-tabs.ts';
import { GLOBAL_SPACE } from '../../shared/api/workspace-browser.ts';

const ACTIONS: BrowserAction[] = [
  'click', 'double_click', 'right_click', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'hover', 'scroll_into_view', 'upload', 'scroll', 'back', 'forward', 'reload',
];

const STEP_PROPS = {
  action: { type: 'string', enum: ACTIONS },
  ref: { type: 'string', maxLength: 24, description: 'From the last snapshot; the surest way to name an element.' },
  role: { type: 'string', maxLength: 40, description: 'ARIA role, with name.' },
  name: { type: 'string', maxLength: 300 },
  label: { type: 'string', maxLength: 300 },
  placeholder: { type: 'string', maxLength: 300 },
  text: { type: 'string', maxLength: 300 },
  css: { type: 'string', maxLength: 500, description: 'My own browser only.' },
  exact: { type: 'boolean' },
  nth: { type: 'integer', minimum: 0, maximum: 500, description: 'Which match, from 0.' },
  value: { type: 'string', maxLength: 20_000, description: 'Text to fill or type; a secret or 2FA code as "secret://<id>".' },
  values: { type: 'array', items: { type: 'string', maxLength: 300 }, maxItems: 50, description: 'Options to select.' },
  key: { type: 'string', maxLength: 40, description: 'For press, e.g. Enter, Control+A.' },
  files: { type: 'array', items: { type: 'string', maxLength: 1000 }, minItems: 1, maxItems: 20, description: 'For upload: workspace paths.' },
  amount: { type: 'integer', minimum: -20_000, maximum: 20_000, description: 'Scroll pixels, positive is down.' },
  // fb_1m7mtty0aszywt5y0 (17.11.2026): a point inside an element – an image CAPTCHA's tile in its iframe, a canvas, a map
  x: { type: 'number', minimum: 0, maximum: 20_000, description: 'With y: click or hover at this point, CSS px from the top-left of the element (an image tile, a canvas); without an element, in the visible page (the person’s browser).' },
  y: { type: 'number', minimum: 0, maximum: 20_000 },
  submit: { type: 'boolean', description: 'true when it sends, posts, pays, books or signs in; journaled as an outside effect.' },
};

const MOTION_PROP = { type: 'string', enum: [...MOTION_STYLES], description: 'human (default, a hand-like move), glide (at most 300 ms) or instant.' };
const FULL_PROP = { type: 'boolean', description: 'true: the whole snapshot instead of what changed.' };

type ActArgs = StepArgs & BrowserTarget & { action: BrowserAction; submit?: boolean };

const hostOf = (url: string) => { try { return new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`).hostname || undefined; } catch { return undefined; } };
const hasTarget = (args: BrowserTarget) => Boolean(args.ref || args.role || args.label || args.placeholder || args.text || args.css);
const targetOf = (args: BrowserTarget): BrowserTarget | undefined => (hasTarget(args)
  ? { ref: args.ref, role: args.role, name: args.name, label: args.label, placeholder: args.placeholder, text: args.text, css: args.css, exact: args.exact, nth: args.nth } : undefined);

/** 'click element e3', 'fill field "Email" (stored secret)'. */
function stepSummary(args: ActArgs): string {
  const secret = args.value && SECRET.test(args.value) ? ' (stored secret)' : '';
  const at = args.x !== undefined && args.y !== undefined ? ` at ${Math.round(args.x)},${Math.round(args.y)}` : '';
  return `${args.action.replace(/_/g, ' ')} ${describeTarget(targetOf(args))}${at}${args.action === 'press' ? ` ${args.key ?? ''}` : ''}${secret}`.trim();
}

function ownStep(args: ActArgs): BatchStep {
  const secretId = args.value !== undefined ? SECRET.exec(args.value)?.[1] : undefined;
  const offset = args.x !== undefined && args.y !== undefined ? { offset: { x: args.x, y: args.y } } : {};
  return { action: args.action, target: targetOf(args), ...(secretId ? { secretId } : { value: args.value }), values: args.values, key: args.key, files: args.files, amount: args.amount, ...offset };
}

/** Runs steps in either browser and answers like one call (browser.act is one step). */
async function runSteps(browser: BrowserService, places: Places, ctx: ToolContext, args: On & { steps: ActArgs[]; motion?: MotionStyle; full?: boolean }, motion: MotionStyle): Promise<ToolOutput> {
  const place = places.use(ctx, args);
  const summaries = args.steps.map(stepSummary);
  const outside = args.steps.some((step) => step.submit === true);
  const one = args.steps.length === 1;
  ctx.status(one ? summaries[0]! : `${args.steps.length} browser steps`);
  const why = (failure: string) => failure.replace(/\.$/, '');
  const headOf = (done: number, failure: string | undefined, after = '') => `${one
    ? `${summaries[0]}: ${failure ? `failed – ${why(failure)}` : 'done'}`
    : `Batch: ${done} of ${args.steps.length} steps done${failure ? ` – step ${done + 1} (${summaries[done] ?? 'next'}) failed: ${why(failure)}` : ''}`}${after}.`;
  if (place !== 'own') {
    const on = sideOn(ctx, place, args);
    const steps: SideActStep[] = [];
    for (const step of args.steps) steps.push(await sideStep(ctx, on, step)); // a step named by its words: one find there
    const result = await sideCall(ctx, { action: 'act', steps, motion: args.motion ?? motion, ...on }, true);
    const done = result.done ?? (result.ok ? steps.length : 0);
    const page = sidePage(result);
    return {
      ...text(pageText(ctx, place, page, result.changes ?? result.text ?? '', headOf(done, result.ok ? undefined : result.error ?? 'unknown'))),
      ...(done === 0 && !result.ok ? { isError: true } : {}),
      effect: outside ? { status: done === steps.length ? 'unknown' : 'failed' } : undefined, structured: { url: page.url, tab: page.tab, done },
    };
  }
  const outcome: BatchOutcome = await browser.batch(ctx.agent.id, {
    tab: args.tab, steps: args.steps.map(ownStep), motion: args.motion ?? motion, full: args.full, use: useOf(ctx),
    secret: (id, host) => ctx.services.secrets.use(id, ctx.agent.id, host),
  });
  const pointed = args.steps.slice(0, outcome.done).filter((step) => POINTER_ACTIONS.has(step.action) && hasTarget(step));
  outcome.points.forEach((point, index) => {
    const step = pointed[index];
    try {
      ctx.services.pointers?.point({
        surface: surfaceOf(ctx, place, point.tab), actor: { kind: 'agent', id: ctx.agent.id, name: ctx.agent.name }, x: point.x, y: point.y,
        action: step?.action === 'hover' ? 'move' : 'click', path: point.path, ...(step?.ref ? { target: { ref: step.ref } } : {}),
      });
    } catch { /* a cursor is a hint; the step counts */ }
  });
  const moved = `${outcome.urlChanged ? ` (now ${outcome.url})` : ''}${outcome.newTab ? ` (now in tab ${outcome.tab})` : ''}`;
  const all = outcome.done === outcome.total;
  return {
    ...text(pageText(ctx, place, outcome, outcome.changes.text, headOf(outcome.done, outcome.failure, ` · page ${outcome.changed ? 'changed' : 'did not change'}${moved}`))),
    ...(outcome.done === 0 && outcome.failure ? { isError: true } : {}),
    effect: outside ? { status: !all ? 'failed' : outcome.changed ? 'confirmed' : 'unknown' } : undefined,
    structured: { done: outcome.done, total: outcome.total, changed: outcome.changed, url: outcome.url, tab: outcome.tab, full: outcome.changes.full },
  };
}

/**
 * Opens the page in the person's own Chrome under the caller's pointer lease and answers with that window's UI tree (own-chrome.ts).
 * B-080 (live 09.11.: windows behind the person's app read as blank pages): a window that did not come to the front
 * (Windows kept it behind, or the person was working), and a tree with the browser's frame only (own-chrome.ts `frame`,
 * with its cause), are each one fact line.
 */
async function inOwnChrome(computer: ComputerService | undefined, options: OwnChromeOptions, ctx: ToolContext, url: string, mask: (text: string) => string = (text) => text): Promise<ToolOutput> {
  if (!computer) throw new WorkforceError('unavailable', "The person's own Chrome is reached through computer use on this PC, which this runtime has not.");
  const opened = await openInOwnChrome(url, computer, { signal: ctx.signal, caller: callerOf(ctx) }, options);
  const { window, tree } = opened;
  const title = tree.window.title || window.title;
  // mask: a stored link opened here carries its token in the address bar (tree.text / url); the output shows the handle.
  return {
    ...text(mask([
      `Opened in the person's own ${opened.browser}, window ${window.hwnd} "${title}" – their profile and logins. I go on there with computer.ui_tree / computer.act (a password as its secret:// handle).`,
      ...(opened.focused ? [] : [`I did not bring this window to the front; ${opened.browser} draws a page only in a window that is not covered.`]),
      ...(opened.frame ? [opened.frame] : []),
      `${tree.count} elements${tree.truncated ? ' (truncated – computer.ui_tree with maxNodes or a name reads more)' : ''}. Format: role "name" [ref] #automationId = value [state] (actions) @centre-x,centre-y`,
      UNTRUSTED, tree.text,
    ].join('\n'))),
    structured: { url: mask(opened.url), window: window.hwnd, app: window.process },
  };
}

/** The browser.* tools; `computer` reaches the person's own Chrome (browser.open where: 'chrome'), `ownChrome` is the tests' seam for starting it. */
export function browserTools(browser: BrowserService, computer?: ComputerService, ownChrome: OwnChromeOptions = {}): ToolDef[] {
  const places = new Places();
  const device = { remote: true, requires: 'device' as const };

  const open = defineTool<{ url: string; newTab?: boolean; tab?: string; where?: Place | 'chrome' }>({
    name: 'browser.open',
    description: "Opens a web page and returns its snapshot with element refs. In my own browser I keep my logins; in chat or global the person sees it with theirs; chrome is the person's own Chrome, as a UI tree for computer.act.",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', minLength: 1, maxLength: 4000, description: 'A stored link with a token works as secret://<id>.' },
        newTab: { type: 'boolean', description: 'Else the current tab (in chat or global: my preview tab).' },
        tab: TAB_PROP,
        where: { ...WHERE_PROP, enum: [...WHERE_PROP.enum, 'chrome'], description: 'own, chat, global or chrome; default where I worked last here.' },
      },
      required: ['url'], additionalProperties: false,
    },
    category: 'read', ...device,
    describe: (args) => ({ summary: `Open ${args.url}${args.where === 'chrome' ? " in the person's own Chrome" : ''}`, resource: hostOf(args.url), reversible: true, external: false }),
    async run(args, ctx) {
      const { text: url, mask } = await typedText(ctx, args.url); // a stored link opens with its value; the handle stays in the output
      if (args.where === 'chrome') {
        ctx.status(`opening ${hostOf(args.url) ?? 'a page'} in the person's own Chrome`);
        return inOwnChrome(computer, ownChrome, ctx, url, mask);
      }
      ctx.status(`opening ${hostOf(args.url) ?? 'a page'}`);
      const on: On = { tab: args.tab, where: args.where };
      const place = places.use(ctx, on);
      if (place !== 'own') {
        const newTab = args.tab ? false : args.newTab; // left out: the agent's preview tab there (main/workspace-marks.ts)
        const result = await sideCall(ctx, { action: 'open', url, ...(newTab === undefined ? {} : { newTab }), ...sideOn(ctx, place, on) });
        const page = sidePage(result);
        return { ...text(mask(pageText(ctx, place, page, result.text ?? ''))), structured: { url: mask(page.url), tab: page.tab } };
      }
      const state = await browser.open(ctx.agent.id, { url, newTab: args.newTab, tab: args.tab, use: useOf(ctx) });
      return { ...text(mask(pageText(ctx, place, state, state.snapshot))), structured: { url: mask(state.url), tab: state.tab } };
    },
  });

  const snapshot = defineTool<On>({
    name: 'browser.snapshot',
    description: "Returns a tab's accessibility snapshot with element refs. Its refs are what browser.act works on; browser.find returns only matching lines.",
    inputSchema: { type: 'object', properties: { tab: TAB_PROP, where: WHERE_PROP }, additionalProperties: false },
    category: 'read', ...device,
    describe: () => ({ summary: 'Read the browser page', reversible: true, external: false }),
    async run(args, ctx) {
      const place = places.use(ctx, args);
      if (place !== 'own') {
        const result = await sideCall(ctx, { action: 'snapshot', full: true, ...sideOn(ctx, place, args) });
        const page = sidePage(result);
        return { ...text(pageText(ctx, place, page, result.text ?? '')), structured: { url: page.url, tab: page.tab } };
      }
      const state = await browser.snapshot(ctx.agent.id, { tab: args.tab, use: useOf(ctx) });
      return { ...text(pageText(ctx, place, state, state.snapshot)), structured: { url: state.url, tab: state.tab } };
    },
  });

  const act = defineTool<ActArgs & On & { motion?: MotionStyle; full?: boolean }>({
    name: 'browser.act',
    description: 'Does one action on the page, such as click, fill or select, and returns what changed. type presses real keys for autocomplete; many steps at once go in browser.batch.',
    inputSchema: { type: 'object', properties: { ...STEP_PROPS, tab: TAB_PROP, where: WHERE_PROP, motion: MOTION_PROP, full: FULL_PROP }, required: ['action'], additionalProperties: false },
    category: 'device', ...device,
    describe: (args) => ({ summary: stepSummary(args), reversible: args.submit !== true, external: args.submit === true }),
    run: (args, ctx) => runSteps(browser, places, ctx, { tab: args.tab, where: args.where, full: args.full, motion: args.motion, steps: [args] }, DEFAULT_MOTION),
  });

  const batch = defineTool<On & { steps: ActArgs[]; motion?: MotionStyle; full?: boolean }>({
    name: 'browser.batch',
    description: `Runs up to ${BATCH_MAX} browser.act steps on one tab in one call, stopping at the first that fails. I get how many ran and one change list.`,
    inputSchema: {
      type: 'object',
      properties: {
        steps: { type: 'array', minItems: 1, maxItems: BATCH_MAX, items: { type: 'object', properties: STEP_PROPS, required: ['action'], additionalProperties: false } },
        tab: TAB_PROP, where: WHERE_PROP, motion: MOTION_PROP, full: FULL_PROP,
      },
      required: ['steps'], additionalProperties: false,
    },
    category: 'device', ...device,
    describe: (args) => {
      const outside = args.steps.some((step) => step.submit === true);
      return { summary: `Batch of ${args.steps.length}: ${args.steps.map(stepSummary).join('; ')}`.slice(0, 900), reversible: !outside, external: outside };
    },
    run: (args, ctx) => runSteps(browser, places, ctx, args, DEFAULT_MOTION),
  });

  const screenshot = defineTool<On & { fullPage?: boolean }>({
    name: 'browser.screenshot',
    description: 'Takes a screenshot of a tab. It is for visual checks; elements to act on come from browser.snapshot.',
    inputSchema: { type: 'object', properties: { tab: TAB_PROP, fullPage: { type: 'boolean', description: 'The whole page (my own browser).' }, where: WHERE_PROP }, additionalProperties: false },
    category: 'read', ...device,
    describe: () => ({ summary: 'Screenshot of the browser page', reversible: true, external: false }),
    async run(args, ctx) {
      const place = places.use(ctx, args);
      if (place !== 'own') {
        const result = await sideCall(ctx, { action: 'screenshot', ...sideOn(ctx, place, args) });
        if (!result.image) throw new Error("The person's browser sent no picture.");
        const page = sidePage(result);
        return imageOutput({ data: Buffer.from(result.image.data, 'base64'), mime: result.image.mime }, tabLine(place, page), { url: page.url, tab: page.tab });
      }
      const shot = await browser.screenshot(ctx.agent.id, { tab: args.tab, fullPage: args.fullPage, use: useOf(ctx) });
      return imageOutput(shot, tabLine(place, shot), { url: shot.url, tab: shot.tab });
    },
  });

  const extract = defineTool<On & { css?: string; maxChars?: number }>({
    name: 'browser.extract',
    description: 'Returns the visible text of a page, or of a CSS selector in my own browser.',
    inputSchema: { type: 'object', properties: { tab: TAB_PROP, css: { type: 'string', maxLength: 500 }, maxChars: { type: 'integer', minimum: 500, maximum: 100_000 }, where: WHERE_PROP }, additionalProperties: false },
    category: 'read', ...device,
    describe: () => ({ summary: 'Read text from the browser page', reversible: true, external: false }),
    async run(args, ctx) {
      let result: { text: string; truncated: boolean; tab: string; url: string; title: string };
      const place = places.use(ctx, args);
      if (place !== 'own') {
        const side = await sideCall(ctx, { action: 'text', ...sideOn(ctx, place, args) });
        const max = Math.max(500, Math.min(args.maxChars ?? 30_000, 100_000));
        const raw = side.text ?? '';
        result = { ...sidePage(side), text: raw.slice(0, max), truncated: raw.length > max };
      } else {
        result = await browser.extract(ctx.agent.id, { tab: args.tab, css: args.css, maxChars: args.maxChars, use: useOf(ctx) });
      }
      return { ...text(`${tabLine(place, result)}\n${UNTRUSTED}\n---\n${maskSetupKeys(result.text)}${result.truncated ? '\n… (truncated)' : ''}`), structured: { url: result.url, tab: result.tab } };
    },
  });

  const tabs = defineTool<{ close?: string; activate?: string; where?: On['where'] }>({
    name: 'browser.tabs',
    description: "Lists the open tabs and recent downloads, closes one or switches to one of mine. In chat and global I also see that space's tabs on the person's other PCs – what the people there have open.",
    inputSchema: { type: 'object', properties: { close: TAB_ID, activate: TAB_ID, where: WHERE_PROP }, additionalProperties: false },
    category: 'read', ...device,
    describe: (args) => ({ summary: args.close ? `Close tab ${args.close}` : 'List browser tabs', reversible: true, external: false }),
    async run(args, ctx) {
      const place = places.use(ctx, { where: args.where, tab: args.close ?? args.activate });
      if (place !== 'own') {
        if (args.activate) throw new Error('Pass tab to work in another of these tabs.');
        const { space } = sideOn(ctx, place, {});
        const result = await sideCall(ctx, args.close ? { action: 'close', tab: args.close, space } : { action: 'tabs', space });
        const lines = (result.tabs ?? []).map((tab) => `- ${tab.id}${tab.active ? ' (the person looks at it)' : ''} · ${tab.url} · "${tab.title}"${tab.by ? ` · opened by ${tab.by}` : ''}`);
        const others = args.close ? [] : otherPcTabs(ctx.services, space ?? GLOBAL_SPACE);
        return { ...text([lines.length ? lines.join('\n') : 'No open tabs.', ...others].join('\n')), structured: { tabs: result.tabs ?? [] } };
      }
      const result = await browser.tabs(ctx.agent.id, { close: args.close, activate: args.activate, use: useOf(ctx) });
      const lines = result.tabs.map((tab) => `- ${tab.tab}${tab.active ? ' (current)' : ''} · ${tab.url} · "${tab.title}"`);
      if (!lines.length) lines.push('No open tabs.');
      if (result.downloads.length) lines.push('Downloads (workspace):', ...result.downloads.map((file) => `- ${file}`));
      return { ...text(lines.join('\n')), structured: result };
    },
  });

  return [open, snapshot, act, batch, screenshot, extract, tabs, ...inspectTools(browser, places), ...secretTools(browser)];
}
