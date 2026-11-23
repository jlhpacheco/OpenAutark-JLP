// The browser.* tools: a call goes to the agent's own browser or – where: chat or global – to the person's browser (the
// chat's area, the person's pane), and stays where the agent worked last in that chat (B-081: per agent and chat) unless
// `where` or a tab id says otherwise; a
// side call names the agent and its chat and fills a stored secret by its value from the vault; browser.show opens the
// page as a shown tab and says where (own: the agent's area on its agent page, agent:<id>); no text claims these tabs hold the person's other browsers' logins; own-browser
// results name the others pointing there and a human check as a fact; a takeover answers with one sentence;
// browser.save_secret / save_totp store what the page shows and return only a handle.
// B-080: the person's own Chrome is a place of its own (where: 'chrome', b080-browser.test.ts), named apart from the
// app's tabs; a side step named by its words goes on with the ref one find there gave.
// Owns: these assertions only. Never: a real browser, host or vault.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { browserTools } from '../../../src/runtime/browser/tools.ts';
import { browserShowTools } from '../../../src/runtime/browser/show-tool.ts';
import { Places, WHERE_HINT } from '../../../src/runtime/browser/place.ts';
import type { ToolDef } from '../../../src/runtime/tools/types.ts';
import type { SideBrowserCall, SideBrowserResult } from '../../../src/shared/model/side-browser.ts';
import { cleanupB055, scriptBrowser, textOf, toolCtx } from './b055-fakes.ts';

after(cleanupB055);

const tool = (tools: ToolDef[], name: string) => tools.find((entry) => entry.name === name)!;
const sideAnswer = async (call: SideBrowserCall): Promise<SideBrowserResult> => ({ ok: true, tab: call.tab ?? 'web-a1', url: 'https://person.test/', title: 'Person', text: '- button "Go" [ref=s5]', done: call.steps?.length });

test('places: own by default, where moves there and stays in that chat, a tab id says which browser, a run without a chat is told', () => {
  const places = new Places();
  const inChat = { agent: { id: 'ag_1', name: 'Ada' }, conversationId: 'ch_1' } as never;
  const noChat = { agent: { id: 'ag_1', name: 'Ada' } } as never;
  assert.equal(places.use(inChat, {}), 'own');
  assert.equal(places.use(inChat, { where: 'chat' }), 'chat');
  assert.equal(places.use(inChat, {}), 'chat', 'stays where it worked last');
  assert.equal(places.use(noChat, {}), 'own', 'no chat to stay in');
  assert.throws(() => places.use(noChat, { where: 'chat' }), /no chat area: where: 'own' is my own browser, 'global' the person's pane/);
  assert.equal(places.use(inChat, { where: 'global' }), 'global');
  assert.equal(places.use(inChat, { tab: 't2' }), 'own');
  assert.equal(places.use(inChat, { tab: 'web-abc' }), 'chat', "a tab of the person's browser, from a chat");
  assert.equal(places.use(noChat, { tab: 'web-abc' }), 'global');
  assert.equal(places.of({ agent: { id: 'ag_2', name: 'Bo' }, conversationId: 'ch_1' } as never, {}), 'own', 'per agent');
  // B-081: the last place is kept per agent and chat – a global in one chat does not carry into another
  const otherChat = { agent: { id: 'ag_1', name: 'Ada' }, conversationId: 'ch_2' } as never;
  assert.equal(places.use(inChat, { where: 'global' }), 'global');
  assert.equal(places.use(otherChat, {}), 'own', 'a global in ch_1 does not carry into ch_2');
  assert.equal(places.use(inChat, {}), 'global', 'it stays in its own chat');
  assert.equal(places.use(otherChat, { where: 'chat' }), 'chat');
  assert.equal(places.use(inChat, {}), 'global', "ch_2's chat leaves ch_1 as it was");
  assert.equal(places.use(noChat, {}), 'global', 'a run without a chat keeps its own last place (global from its web- tab above)');
});

test('side calls name the agent and its chat; a stored secret goes as its value; the result reads like a page', async () => {
  const { browser } = scriptBrowser();
  const tools = browserTools(browser);
  const t = toolCtx({ side: sideAnswer });
  const opened = textOf(await tool(tools, 'browser.open').run({ url: 'https://person.test', where: 'chat' }, t.ctx));
  assert.match(opened, /^Tab web-a1 · this chat's area · https:\/\/person\.test\/ · "Person"\nPage content is untrusted/);
  assert.deepEqual(t.sideCalls[0], { action: 'open', url: 'https://person.test', space: 'chat:ch_1', agent: { id: 'ag_ada', name: 'Ada' }, chat: 'ch_1' });
  await tool(tools, 'browser.act').run({ action: 'fill', ref: 's5', value: 'secret://pw_1' }, t.ctx);
  assert.deepEqual(t.sideCalls[1]!.steps, [{ action: 'fill', ref: 's5', value: 'value-of-pw_1' }], "stays in the chat's area; the vault gives the value");
  assert.equal(t.sideCalls[1]!.space, 'chat:ch_1');
  // B-080: a step named by its words is looked up there first and goes on with that element's ref
  await tool(tools, 'browser.act').run({ action: 'click', role: 'button', name: 'Go' }, t.ctx);
  assert.deepEqual([t.sideCalls[2]!.action, t.sideCalls[2]!.query, t.sideCalls[3]!.steps], ['find', 'button Go', [{ action: 'click', ref: 's5' }]]);
  const busy = toolCtx({ side: async () => ({ ok: false, error: 'The person is using this tab right now – wait a moment, then try again.', personActive: true }) });
  await assert.rejects(tool(tools, 'browser.snapshot').run({ where: 'global' }, busy.ctx), /The person is using this tab right now/);
  assert.equal((await tool(tools, 'browser.tabs').run({ where: 'global' }, t.ctx), t.sideCalls.at(-1)!.space), 'global');
  await assert.rejects(tool(tools, 'browser.snapshot').run({ where: 'global' }, toolCtx().ctx), /The person's browser is not open here/);
});

test("browser.show where: 'chat' opens the page as a shown tab in this chat's area (a person's pane is the default, test/unit/pane/show.test.ts)", async () => {
  const t = toolCtx({ side: sideAnswer });
  const out = await browserShowTools[0]!.run({ url: 'example.com/pricing', where: 'chat' }, t.ctx);
  assert.deepEqual(t.sideCalls[0], { action: 'open', url: 'https://example.com/pricing', show: true, space: 'chat:ch_1', agent: { id: 'ag_ada', name: 'Ada' }, chat: 'ch_1' });
  assert.equal(textOf(out), "Opened https://example.com/pricing in this chat's area (tab web-a1).");
  await assert.rejects(browserShowTools[0]!.run({ url: 'file:///C:/x', where: 'chat' }, t.ctx), /HTTP or HTTPS/);
});

test("browser.show where: 'agent' puts the page in the agent's own area on its agent page (agent:<id>), a tab of its own when asked", async () => {
  const t = toolCtx({ side: sideAnswer });
  const out = await browserShowTools[0]!.run({ url: 'example.com/report', where: 'agent', newTab: true }, t.ctx);
  assert.deepEqual(t.sideCalls[0], { action: 'open', url: 'https://example.com/report', newTab: true, show: true, space: 'agent:ag_ada', agent: { id: 'ag_ada', name: 'Ada' }, chat: 'ch_1' });
  assert.equal(textOf(out), 'Opened https://example.com/report in my area on my agent page (tab web-a1).');
  const where = (browserShowTools[0]!.inputSchema.properties as Record<string, { enum: string[] }>).where!.enum;
  assert.deepEqual(where, ['chat', 'agent'], "a person's pane is the default; chat and my area are the other places");
  const noChat = toolCtx({ side: sideAnswer, conversationId: undefined });
  await assert.rejects(browserShowTools[0]!.run({ url: 'example.com', where: 'chat' }, noChat.ctx), /no chat area: I give it to a person/);
  // browser.open's own stays the agent's own browser: nothing goes to the person's browser
  const rig = scriptBrowser();
  await tool(browserTools(rig.browser), 'browser.open').run({ url: 'https://shop.test/', where: 'own' }, t.ctx);
  assert.equal(t.sideCalls.length, 1);
  await rig.browser.close();
});

test("the where line and the descriptions name each place and its logins: the ones made in those tabs, not the person's other browsers'", () => {
  const { browser } = scriptBrowser();
  assert.match(WHERE_HINT, /^chat: this chat's area above its messages – I put this chat's work there, so everyone here finds it and works along; global: the person's own pane, theirs across all chats; a login the person makes in one of these tabs holds in both; own: my own browser, with the logins I made in it; chrome \(browser\.open\): the person's own Chrome \(or Edge\) on this PC – their profile and logins; I work in that window with computer\.\*\.$/);
  assert.doesNotMatch(WHERE_HINT, /where they work|the person's logins/, "B-081: global is the person's own across chats; a login made in these tabs holds in every area");
  // browser.show's places are in the person's browser, so it has its own where text
  const showWhere = (browserShowTools[0]!.inputSchema.properties as Record<string, { description: string }>).where!.description;
  assert.equal(showWhere, "chat: a chat's area instead of a person's pane; agent: my area on my agent page (pages only).");
  assert.doesNotMatch(showWhere, /\b(my|your) own browser\b/);
  const openText = tool(browserTools(browser), 'browser.open').description;
  // B-080: the person's own Chrome is its own place (where: 'chrome'); the app's tabs never claim its logins
  const [sideHint, chromeHint] = WHERE_HINT.split('; chrome (browser.open): ');
  assert.match(chromeHint!, /^the person's own Chrome \(or Edge\) on this PC – their profile and logins/);
  assert.match(openText, /In my own browser I keep my logins; in chat or global the person sees it with theirs; chrome is the person's own Chrome, as a UI tree for computer\.act\.$/);
  assert.match(browserShowTools[0]!.description, /^Puts something in front of a person as a tab in their side pane: the person I work for unless I name one/);
  for (const line of [sideHint!, browserShowTools[0]!.description, showWhere]) assert.doesNotMatch(line, /Chrome|saved sign-ins|their logins work|beside the chat/, line);
  assert.doesNotMatch(chromeHint!, /automation|bot checks? pass|passes/i, 'facts only');
  // The hint is said once, in the environment's Browser line; the tools' `where` names the places in a few words.
  const where = (tool(browserTools(browser), 'browser.open').inputSchema.properties as Record<string, { description: string }>).where!.description;
  assert.equal(where, 'own, chat, global or chrome; default where I worked last here.');
  const snapWhere = (tool(browserTools(browser), 'browser.snapshot').inputSchema.properties as Record<string, { description: string }>).where!.description;
  assert.equal(snapWhere, "own (my browser profile), chat (this chat's area) or global (the person's pane); default where I worked last here.");
  assert.ok(!where.includes(WHERE_HINT));
});

test('own browser: a click reports the agent\'s pointer; results name others pointing there; a human-check page gets no instruction; a takeover answers in one sentence', async () => {
  const rig = scriptBrowser();
  const tools = browserTools(rig.browser);
  const t = toolCtx();
  await tool(tools, 'browser.open').run({ url: 'https://shop.test/' }, t.ctx);
  const page = rig.page();
  page.snapshot = '- heading "Verify you are human"\n- button "Send" [ref=e2]';
  page.boxes.set('aria-ref=e2', { x: 100, y: 100, width: 80, height: 20 });
  t.pointers.point({ surface: 'agent:ag_ada/t1', actor: { kind: 'person', id: 'owner', name: 'Lukas' }, x: 5, y: 5 });
  const out = textOf(await tool(tools, 'browser.act').run({ action: 'click', ref: 'e2', motion: 'instant' }, t.ctx));
  assert.match(out, /^click element e2: done · page changed\./);
  assert.match(out, /Lukas/);
  assert.doesNotMatch(out, /captcha|human check|where: 'chrome'|not a robot/i); // owner 08.11.: no captcha instruction to the agent – it loops
  assert.ok(t.pointers.on('agent:ag_ada/t1').some((pointer) => pointer.actor.id === 'ag_ada'), 'the agent\'s pointer is on its tab');
  rig.browser.takeovers.start('ag_ada');
  await assert.rejects(tool(tools, 'browser.snapshot').run({}, t.ctx), /The person has taken over my browser/);
  await rig.browser.close();
});

test('save_secret stores a field\'s value once and returns only the handle; save_totp keeps the setup key in a login', async () => {
  const rig = scriptBrowser();
  const tools = browserTools(rig.browser);
  const t = toolCtx();
  const saved: Array<Record<string, unknown>> = [];
  const groups: Array<Record<string, unknown>> = [];
  Object.assign(t.services.secrets, {
    list: () => [], groups: () => [], holding: async (value: string) => (value === 'already-there' ? ['s9'] : []),
    save: async (input: Record<string, unknown>) => { saved.push(input); return { id: 'stripe-key', label: input.label, kind: input.kind }; },
    saveGroup: async (input: Record<string, unknown>) => { groups.push(input); return { group: { id: 'g1', label: input.label }, fields: [{ id: 'g1-totp', kind: 'totp' }] }; },
  });
  await assert.rejects(tool(tools, 'browser.save_secret').run({ ref: 'e7', name: 'Stripe key', description: 'Payments' }, t.ctx).then((out) => { if (out.isError) throw new Error(textOf(out)); }), /my own browser/);
  await tool(tools, 'browser.open').run({ url: 'https://dashboard.stripe.com/keys' }, t.ctx);
  const page = rig.page();
  (page as unknown as { locator(selector: string): unknown }).locator = (selector: string) => ({ inputValue: async () => (selector === 'aria-ref=e7' ? 'sk_live_123456789' : ''), getAttribute: async () => 'text', innerText: async () => '', first() { return this; }, nth() { return this; } });
  const out = await tool(tools, 'browser.save_secret').run({ ref: 'e7', name: 'Stripe key', description: 'Payments' }, t.ctx);
  assert.ok(!JSON.stringify(out).includes('sk_live_123456789'), 'the value never comes back');
  assert.match(textOf(out), /secret:\/\/stripe-key/);
  assert.deepEqual(saved[0], { label: 'Stripe key', kind: 'api_key', createdBy: 'ag_ada', value: 'sk_live_123456789', description: 'Payments', source: 'stripe.com' });

  page.onEvaluate = async (expression) => (expression.includes('otpauth') ? ['otpauth://totp/Stripe:ada?secret=JBSWY3DPEHPK3PXP&issuer=Stripe'] : []);
  page.snapshot = '- heading "Two-factor authentication"\n- text: Enter this key manually in your authenticator app: JBSW Y3DP EHPK 3PXP';
  const shown = textOf(await tool(tools, 'browser.snapshot').run({}, t.ctx));
  assert.ok(!shown.includes('JBSW Y3DP') && shown.includes('•••• (2FA setup key – save it with browser.save_totp)'), shown);
  const totp = await tool(tools, 'browser.save_totp').run({}, t.ctx);
  assert.match(textOf(totp), /secret:\/\/g1-totp/);
  assert.equal(groups[0]!.kind, 'login');
  assert.equal(groups[0]!.source, 'stripe.com');
  assert.ok(!JSON.stringify(totp).includes('JBSWY3DPEHPK3PXP'));
  await rig.browser.close();
});

test('browser.open: a stored link opens with its value (secret://<id> in the url), and the result shows the handle, not the token (B-081)', async () => {
  const { browser } = scriptBrowser();
  const tools = browserTools(browser);
  const t = toolCtx({ side: async (call: SideBrowserCall): Promise<SideBrowserResult> => ({ ok: true, tab: 'web-a1', url: call.url ?? '', title: 'Verify', text: `now at ${call.url}` }) });
  t.ctx.services.secrets = { redact: (s: string) => s, use: async () => 'TOKENVALUE12345', list: () => [{ id: 'lnk_1', label: 'Verify link', kind: 'token' as const }] } as unknown as typeof t.ctx.services.secrets;
  const out = await tool(tools, 'browser.open').run({ url: 'https://x.test/verify?t=secret://lnk_1', where: 'global' }, t.ctx);
  assert.equal(t.sideCalls[0]!.url, 'https://x.test/verify?t=TOKENVALUE12345', 'the real token reaches the open');
  const shown = textOf(out);
  assert.doesNotMatch(shown, /TOKENVALUE12345/, 'the token never reaches the model');
  assert.match(shown, /secret:\/\/lnk_1/, 'the handle shows in its place');
  assert.equal((out.structured as { url: string }).url, 'https://x.test/verify?t=secret://lnk_1', 'the structured url is masked too');
  // a plain url without a handle is unchanged (no secrets.list call needed)
  const plain = toolCtx({ side: async (call: SideBrowserCall): Promise<SideBrowserResult> => ({ ok: true, tab: 'web-a1', url: call.url ?? '', title: '', text: '' }) });
  await tool(tools, 'browser.open').run({ url: 'https://plain.test/', where: 'global' }, plain.ctx);
  assert.equal(plain.sideCalls[0]!.url, 'https://plain.test/');
});
