// phone.type and phone.open with a stored secret (12.11.2026, Nora/CEO report): the phone gets the value, the agent's
// arguments and what comes back keep the handle – a later phone.ui_tree shows the value masked as its handle (the
// vault's redactor), which is not literal typing. phone.open takes a stored private link by its handle. An unknown
// handle is refused before anything reaches the phone. Owns: these assertions only. Never: adb or a real phone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { ManualClock } from '../fakes.ts';
import { SecretVault } from '../../../src/runtime/secrets/service.ts';
import { phoneTools } from '../../../src/runtime/phone/tools.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';

const host = {
  encrypt: async (plain: string) => Uint8Array.from(Buffer.from(plain, 'utf8'), (byte) => byte ^ 0x5a),
  decrypt: async (cipher: Uint8Array) => Buffer.from(Uint8Array.from(cipher, (byte) => byte ^ 0x5a)).toString('utf8'),
};
const LINK = 'https://verify.example.com/session/abc123private';

/** `field`: what the phone says the field reads after typing (the Autark app from 0.3.15); absent = an older app. */
function setup(field?: (typed: string) => string) {
  const db = new Db(':memory:');
  migrate(db);
  const vault = new SecretVault({ db, host, clock: new ManualClock() });
  const sent: Array<{ op: string; value: unknown }> = [];
  const phone = {
    type: async (_serial: unknown, value: string) => { sent.push({ op: 'type', value }); return field?.(value); },
    open: async (_serial: unknown, target: { url?: string; package?: string }) => { sent.push({ op: 'open', value: target }); return target.url ?? target.package; },
  };
  const services = { db, secrets: vault, devices: { self: () => ({ id: 'dev_self', name: 'Desk' }), list: () => [] } } as unknown as RuntimeServices;
  const ctx = { agent: { id: 'ag_nora', name: 'Nora' }, runId: 'run_1', mode: 'computer', services, signal: new AbortController().signal, status() {} } as unknown as ToolContext;
  const tools = new Map(phoneTools(phone as never).map((tool) => [tool.name, tool]));
  return { vault, sent, ctx, tools };
}
const text = (out: ToolOutput) => out.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');

test('phone.type sends the value, keeps the handle in what it returns and says the readback is masked', async () => {
  const f = setup();
  const saved = await f.vault.save({ label: 'Private link', kind: 'token', value: LINK });
  const args = { text: `secret://${saved.id}` };
  const out = await f.tools.get('phone.type')!.run(args as never, f.ctx);
  assert.equal(out.isError ?? false, false, text(out));
  assert.deepEqual(f.sent, [{ op: 'type', value: LINK }], 'the phone gets the value, not the handle');
  assert.equal(args.text, `secret://${saved.id}`, 'the arguments keep the handle');
  assert.ok(!text(out).includes(LINK));
  assert.match(text(out), /phone\.ui_tree shows it as its secret:\/\/ handle \(masked\)/);
  assert.equal(f.vault.redact(`EditText "${LINK}" #url_bar`), `EditText "secret://${saved.id}" #url_bar`, 'a later readback shows the handle – masked, not typed');
});

test('phone.type without a handle types the text as given and adds no note', async () => {
  const f = setup();
  const out = await f.tools.get('phone.type')!.run({ text: 'Message hello' } as never, f.ctx);
  assert.deepEqual(f.sent, [{ op: 'type', value: 'Message hello' }], 'real text with the word Message stays whole');
  assert.ok(!/masked/.test(text(out)));
});

// Chat sweep 16.11.2026 (owner 12.11.: extra words in an email field, "Message" in WhatsApp): the field's text read back.
test('phone.type shows what the field reads afterwards, so extra words beside mine show at once', async () => {
  const f = setup((typed) => `Message${typed}`);
  const out = await f.tools.get('phone.type')!.run({ text: 'Hallo' } as never, f.ctx);
  assert.equal(text(out), 'Typed 5 characters. The field now reads: "MessageHallo".');
});

test('phone.type with a stored secret masks the value in the field it reads back', async () => {
  const value = 'Zq7vR2mK9wL4tX8';
  const f = setup((typed) => `anna@example.com ${typed}`);
  const saved = await f.vault.save({ label: 'Mail login', kind: 'password', value });
  const out = await f.tools.get('phone.type')!.run({ text: `secret://${saved.id}` } as never, f.ctx);
  assert.ok(!text(out).includes(value), text(out));
  assert.match(text(out), new RegExp(`The field now reads: "anna@example\\.com secret://${saved.id}"`));
});

test('phone.open opens a stored private link by its handle and never returns the value', async () => {
  const f = setup();
  const saved = await f.vault.save({ label: 'Private link', kind: 'token', value: LINK });
  const out = await f.tools.get('phone.open')!.run({ url: `secret://${saved.id}` } as never, f.ctx);
  assert.equal(out.isError ?? false, false, text(out));
  assert.deepEqual(f.sent, [{ op: 'open', value: { url: LINK, package: undefined, app: undefined } }]);
  assert.ok(!text(out).includes(LINK), text(out));
  assert.match(text(out), new RegExp(`secret://${saved.id}`));
});

test('an unknown handle is refused before anything reaches the phone', async () => {
  const f = setup();
  for (const [name, args] of [['phone.type', { text: 'secret://sec_missing' }], ['phone.open', { url: 'secret://sec_missing' }]] as const) {
    await assert.rejects(f.tools.get(name)!.run(args as never, f.ctx), /not in the secrets catalog/);
  }
  assert.deepEqual(f.sent, []);
});
