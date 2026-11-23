// Connectors as files: the service applies <data>/connectors/mcp.json and mail.json – connect, list and register the
// tools, write status.json –, follows changes of the files (added, changed, disabled, removed), fills secret://<id>
// handles from the vault, starts the browser sign-in only for an entry that was just added or changed (or on
// apps.reconnect) and registers cached tools at start without a connection.
// Owns: these assertions. Never: a real server or network (connect, OAuth and the vault are fakes).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConnectors, mutateConnectors, slug } from '../../../src/runtime/apps/connectors.ts';
import { McpAuthRequired } from '../../../src/runtime/apps/types.ts';
import { appsFixture, dataFolder, FakeKv } from './service-fakes.ts';

const settle = async (f: ReturnType<typeof appsFixture>) => { await f.apps.idle(); f.timers.fireAll(); await f.apps.idle(); };

test('files: mcp.json servers (http and stdio) and mail.json mailboxes become connectors; problems are named', () => {
  const data = dataFolder();
  data.write('mcp.json', { mcpServers: { Notion: { url: 'https://mcp.notion.com/mcp' }, files: { command: 'npx', args: ['-y', 'x'], env: { KEY: 'secret://k' } }, off: { url: 'https://a.example/mcp', disabled: true }, broken: { nothing: true } } });
  data.write('mail.json', { mailboxes: { work: { address: 'me@example.com', password: 'secret://mail', agent: 'Secretary' }, bad: { address: 'x' } } });
  const { connectors, problems } = readConnectors(data.dir);
  assert.deepEqual(connectors.map((c) => [c.id, c.transport, c.enabled]), [['notion', 'http', true], ['files', 'stdio', true], ['off', 'http', false], ['work', 'mail', true]]);
  assert.equal(connectors[1].env?.KEY, 'secret://k');
  assert.equal(connectors[3].mail?.agent, 'Secretary');
  assert.equal(problems.length, 2);
  assert.equal(slug('My GitHub!'), 'my-github');
  data.write('mcp.json', '{ not json');
  assert.match(readConnectors(data.dir).problems[0], /^mcp\.json:/);
});

test('start: creates the files, connects an entry, registers its tools for every agent and writes status.json', async () => {
  const f = appsFixture();
  f.data.write('mcp.json', { mcpServers: { linear: { url: 'https://mcp.linear.app/mcp' } } });
  f.servers.add('https://mcp.linear.app/mcp', ['list_issues', 'create_issue']);
  f.apps.start();
  await settle(f);
  assert.ok(f.data.exists('mail.json'));
  assert.deepEqual(f.tools.names(), ['app.linear.create_issue', 'app.linear.list_issues']);
  assert.deepEqual(f.apps.usableBy('anyone'), ['linear']);
  const status = f.data.read('status.json') as { connectors: Record<string, { status: string; tools: number }> };
  assert.equal(status.connectors.linear.status, 'ok');
  assert.equal(status.connectors.linear.tools, 2);
  await f.apps.stop();
});

test('a key: the secret://<id> handle in a header is filled from the vault when it connects; a bare token gets Bearer', async () => {
  const f = appsFixture();
  const saved = await f.secrets.save({ label: 'GitHub', kind: 'token', value: 'ghp_123' });
  f.data.write('mcp.json', { mcpServers: { github: { url: 'https://api.example.com/mcp', headers: { Authorization: `secret://${saved.id}` } } } });
  const server = f.servers.add('https://api.example.com/mcp', ['repos'], { requires: { header: 'Authorization', value: 'Bearer ghp_123' } });
  f.apps.start();
  await settle(f);
  assert.equal(server.seen?.Authorization, 'Bearer ghp_123');
  assert.equal(f.apps.list()[0].status, 'ok');
  await f.apps.stop();
});

test('changes of the files: added, disabled and removed entries; a removed one loses its sign-in and tools', async () => {
  const f = appsFixture();
  f.data.write('mcp.json', { mcpServers: { a: { url: 'https://a.example/mcp' } } });
  f.servers.add('https://a.example/mcp', ['one']);
  f.servers.add('https://b.example/mcp', ['two']);
  f.apps.start();
  await settle(f);
  f.data.write('mcp.json', { mcpServers: { a: { url: 'https://a.example/mcp', disabled: true }, b: { url: 'https://b.example/mcp' } } });
  f.changedFile();
  await settle(f);
  assert.deepEqual(f.tools.names(), ['app.b.two']);
  assert.equal(f.apps.list().find((app) => app.id === 'a')?.status, 'off');
  f.data.write('mcp.json', { mcpServers: {} });
  f.changedFile();
  await settle(f);
  assert.deepEqual(f.tools.names(), []);
  assert.deepEqual(f.oauth.forgotten.sort(), ['a', 'b']);
  await f.apps.stop();
});

test('sign-in: a new entry that answers 401 opens the sign-in page; at start it only says how; reconnect opens it', async () => {
  const f = appsFixture();
  f.data.write('mcp.json', { mcpServers: {} });
  f.servers.add('https://mcp.notion.com/mcp', ['search'], { requires: { header: 'Authorization', value: 'Bearer oauth-access' } });
  f.apps.start();
  await settle(f);
  f.data.write('mcp.json', { mcpServers: { notion: { url: 'https://mcp.notion.com/mcp' } } });
  f.changedFile();
  await settle(f);
  assert.equal(f.apps.list()[0].status, 'waiting');
  assert.equal(f.browser.length, 1);
  f.oauth.complete('notion');
  await settle(f);
  assert.equal(f.apps.list()[0].status, 'ok');
  await f.apps.stop();

  const g = appsFixture();
  g.data.write('mcp.json', { mcpServers: { notion: { url: 'https://mcp.notion.com/mcp' } } });
  g.servers.add('https://mcp.notion.com/mcp', ['search'], { requires: { header: 'Authorization', value: 'Bearer oauth-access' } });
  g.apps.start();
  await settle(g);
  assert.equal(g.apps.list()[0].status, 'signin');
  assert.match(g.apps.list()[0].error ?? '', /apps\.reconnect/);
  assert.equal(g.browser.length, 0);
  assert.equal((await g.apps.reconnect('notion')).status, 'waiting');
  assert.equal(g.browser.length, 1);
  await g.apps.stop();
});

test('reconnect of a disabled or stale row conflicts before connection or sign-in side effects', async () => {
  const f = appsFixture();
  f.data.write('mcp.json', { mcpServers: { off: { url: 'https://off.example/mcp', disabled: true } } });
  f.servers.add('https://off.example/mcp', ['tool']);
  f.apps.start();
  await settle(f);
  const off = f.apps.list()[0];
  await assert.rejects(f.apps.reconnect(off.id, { id: off.id, name: off.name, transport: off.transport }), (error: unknown) => (error as { code?: string }).code === 'conflict');
  assert.deepEqual(f.servers.opened, []);
  assert.deepEqual(f.oauth.begins, []);

  f.data.write('mcp.json', { mcpServers: { other: { url: 'https://off.example/mcp' } } }); // watcher has not yet refreshed the cached row
  await assert.rejects(f.apps.reconnect(off.id, { id: off.id, name: off.name, transport: off.transport }), (error: unknown) => (error as { code?: string }).code === 'conflict');
  assert.deepEqual(f.servers.opened, []);
  assert.deepEqual(f.oauth.begins, []);
  await f.apps.stop();
});

test('cached tools: at start an unchanged entry registers its tools without starting the server', async () => {
  const f = appsFixture();
  f.data.write('mcp.json', { mcpServers: { files: { command: 'fake-server' } } });
  f.servers.add('fake-server', ['read_file']);
  f.apps.start();
  await settle(f);
  await f.apps.stop();
  const opened = f.servers.opened.length;
  const again = appsFixture({ kv: f.kv, dataDir: f.data.dir, connect: f.servers.connect });
  again.apps.start();
  await again.apps.idle();
  assert.deepEqual(again.tools.names(), ['app.files.read_file']);
  assert.equal(f.servers.opened.length, opened);
  await again.apps.stop();
});

test('the tool host: a call runs on the server; a 401 on a call turns the connector to signin', async () => {
  const f = appsFixture();
  f.data.write('mcp.json', { mcpServers: { linear: { url: 'https://mcp.linear.app/mcp' } } });
  const server = f.servers.add('https://mcp.linear.app/mcp', ['list_issues'], { callFailures: [new McpAuthRequired({ status: 401 })] });
  f.apps.start();
  await settle(f);
  await assert.rejects(f.apps.host.call('linear', 'list_issues', {}), McpAuthRequired);
  assert.equal(f.apps.list()[0].status, 'signin');
  const result = await f.apps.host.call('linear', 'list_issues', { q: 1 });
  assert.equal(result.content[0].type, 'text');
  assert.deepEqual(server.calls, [{ tool: 'list_issues', args: { q: 1 } }]);
  assert.equal(f.apps.list()[0].status, 'ok');
  await f.apps.stop();
});

test('new mail wakes the mailbox\'s agent (by name or id, else the assistant) with durable due times instead of a process-local debounce timer', async () => {
  const { MailWaker, mailAgent } = await import('../../../src/runtime/apps/mail-wake.ts');
  const { ManualTimers } = await import('./service-fakes.ts');
  const box = { id: 'work', name: 'work', transport: 'mail' as const, enabled: true, fingerprint: 'f', mail: { address: 'me@example.com', password: 'secret://pw', agent: 'Secretary' } };
  const agents = [{ id: 'ag_sec', name: 'Secretary', managerId: undefined }, { id: 'ag_old', name: 'Old', archivedAt: 1 }];
  const org = { list: () => agents, get: (id: string) => agents.find((a) => a.id === id), managers: () => [] };
  assert.equal(mailAgent({ org } as never, box), 'ag_sec');
  const wakes: Array<{ agentId: string; note: string; dueAt: number }> = [];
  let now = 1_000_000;
  const timers = new ManualTimers();
  const waker = new MailWaker({ services: { org, wakes: { list: () => [], wake: (input: { agentId: string; note: string; dueAt: number }) => { wakes.push(input); } }, clock: { now: () => now } } as never, connected: () => box, timers });
  waker.notice('work', { count: 1, from: 'Maria <maria@client.example>', subject: 'Offer' });
  waker.notice('work', { count: 2, subject: 'Again' });
  assert.equal(wakes.length, 2);
  assert.equal(wakes[0].dueAt, now);
  assert.equal(wakes[1].dueAt, now + 60_000);
  assert.match(wakes[0].note, /New mail in me@example\.com: 1 new message\. Newest from "Maria \(maria@client\.example\)"/);
  now += 61_000;
  timers.fireAll();
  assert.equal(wakes.length, 2);
  assert.match(wakes[1].note, /2 new messages/);
});

test('structured mutations preserve raw connector fields, DNC binding, and validate add batches before commit', () => {
  const data = dataFolder();
  data.write('mcp.json', { meta: { keep: true }, mcpServers: { service: { url: 'https://example.test/mcp', headers: { Authorization: 'Bearer secret://token1', 'X-Keep': 'yes' }, unknown: { keep: 7 } } } });
  data.write('mail.json', { mailboxes: { work: { address: 'me@example.test', password: 'secret://pw', contactStopFile: 'dnc.json', disabled: true, custom: 'keep' } } });
  const app = readConnectors(data.dir).connectors.find((item) => item.name === 'service')!;
  mutateConnectors(data.dir, { kind: 'setToken', id: app.id, name: app.name, transport: 'http', secretId: 'token2' });
  mutateConnectors(data.dir, { kind: 'setEnabled', id: app.id, name: app.name, transport: 'http', enabled: false });
  const root = data.read('mcp.json') as { meta: unknown; mcpServers: Record<string, Record<string, unknown>> };
  assert.deepEqual(root.meta, { keep: true });
  assert.deepEqual(root.mcpServers.service.unknown, { keep: 7 });
  assert.equal((root.mcpServers.service.headers as Record<string,string>)['X-Keep'], 'yes');
  assert.equal((root.mcpServers.service.headers as Record<string,string>).Authorization, 'Bearer secret://token2');
  const mail = data.read('mail.json') as { mailboxes: Record<string, Record<string,unknown>> };
  assert.equal(mail.mailboxes.work.contactStopFile, 'dnc.json');
  assert.equal(mail.mailboxes.work.custom, 'keep');
  assert.equal(mail.mailboxes.work.disabled, true);
  const mailbox = readConnectors(data.dir).connectors.find((item) => item.name === 'work')!;
  mutateConnectors(data.dir, { kind: 'setEnabled', id: mailbox.id, name: mailbox.name, transport: 'mail', enabled: true });
  const enabledMail = data.read('mail.json') as { mailboxes: Record<string, Record<string, unknown>> };
  assert.equal(enabledMail.mailboxes.work.disabled, undefined);
  assert.equal(enabledMail.mailboxes.work.contactStopFile, 'dnc.json');
  assert.equal(enabledMail.mailboxes.work.custom, 'keep');
  assert.throws(() => mutateConnectors(data.dir, { kind: 'add', entries: [
    { name: 'ok', entry: { url: 'https://ok.test/mcp' } },
    { name: 'bad', entry: { command: 'x', contactStopFile: 'evil' } },
  ] }));
  assert.deepEqual(Object.keys((data.read('mcp.json') as {mcpServers: Record<string,unknown>}).mcpServers), ['service']);
  assert.throws(() => mutateConnectors(data.dir, { kind: 'remove', id: 'work', name: 'work', transport: 'mail' }), /mailbox removal/);
});

test('structured add accepts http:// servers, rejects credential URLs and prevents existing ids from moving', () => {
  const data = dataFolder();
  data.write('mcp.json', { mcpServers: { service: { url: 'https://example.test/mcp' } } });
  data.write('mail.json', { mailboxes: { 'Foo 2': { address: 'me@example.test', password: 'secret://pw' } } });
  mutateConnectors(data.dir, { kind: 'add', entries: [{ name: 'local', entry: { url: 'http://127.0.0.1:3000/mcp' } }] });
  assert.throws(() => mutateConnectors(data.dir, { kind: 'add', entries: [{ name: 'bad-auth', entry: { url: 'https://user:password@example.test/mcp' } }] }), /embedded credentials/);
  assert.throws(() => mutateConnectors(data.dir, { kind: 'add', entries: [{ name: 'foo-2', entry: { command: 'node' } }] }), /change another app id/);
  const connectors = readConnectors(data.dir).connectors;
  assert.equal(connectors.find((item) => item.name === 'Foo 2')?.id, 'foo-2');
  assert.equal(connectors.find((item) => item.name === 'local')?.url, 'http://127.0.0.1:3000/mcp');
});

test('integer-like add names are rejected before preflight or write can reorder connector IDs', () => {
  const data = dataFolder();
  data.write('mcp.json', { mcpServers: { 'app 1': { url: 'https://first.example/mcp' } } });
  data.write('mail.json', { mailboxes: {} });
  const before = data.read('mcp.json');
  assert.equal(readConnectors(data.dir).connectors[0].id, 'app-1');
  const batch = [
    { name: 'ordinary', entry: { url: 'https://ordinary.example/mcp' } },
    { name: '1', entry: { url: 'https://numeric.example/mcp' } },
  ];
  assert.throws(() => mutateConnectors(data.dir, { kind: 'add', entries: batch }, { validateOnly: true }), /Integer connector names/);
  assert.throws(() => mutateConnectors(data.dir, { kind: 'add', entries: batch }), /Integer connector names/);
  assert.deepEqual(data.read('mcp.json'), before);
  assert.deepEqual(readConnectors(data.dir).connectors.map(({ name, id }) => [name, id]), [['app 1', 'app-1']]);
});

test('MCP add preflight validates without writing or starting a connector', () => {
  const data = dataFolder();
  data.write('mcp.json', { meta: { preserve: true }, mcpServers: {} });
  data.write('mail.json', { mailboxes: {} });
  mutateConnectors(data.dir, { kind: 'add', entries: [{ name: 'preflight', entry: { url: 'https://example.test/mcp' } }] }, { validateOnly: true });
  assert.deepEqual(data.read('mcp.json'), { meta: { preserve: true }, mcpServers: {} });
});

test('structured mutation reads a prior external file edit and preserves its added fields', () => {
  const data = dataFolder();
  data.write('mcp.json', { mcpServers: { live: { url: 'https://example.test/mcp' } } });
  const listed = readConnectors(data.dir).connectors[0];
  data.write('mcp.json', { rootExtra: { latest: true }, mcpServers: { live: { url: 'https://example.test/mcp', externalEdit: { keep: true } } } });
  mutateConnectors(data.dir, { kind: 'setEnabled', id: listed.id, name: listed.name, transport: 'http', enabled: false });
  const latest = data.read('mcp.json') as { rootExtra: unknown; mcpServers: Record<string, Record<string, unknown>> };
  assert.deepEqual(latest.rootExtra, { latest: true });
  assert.deepEqual(latest.mcpServers.live.externalEdit, { keep: true });
  assert.equal(latest.mcpServers.live.disabled, true);
});

test('remove refuses to rebind colliding MCP ids across remaining MCP and mail entries', () => {
  const mcpData = dataFolder();
  mcpData.write('mcp.json', { mcpServers: { 'A B': { url: 'https://a.example/mcp' }, 'A-B': { url: 'https://b.example/mcp' } } });
  mcpData.write('mail.json', { mailboxes: {} });
  const mcpApps = readConnectors(mcpData.dir).connectors;
  assert.deepEqual(mcpApps.map(({ name, id }) => [name, id]), [['A B', 'a-b'], ['A-B', 'a-b-2']]);
  assert.throws(() => mutateConnectors(mcpData.dir, { kind: 'remove', id: 'a-b', name: 'A B', transport: 'http' }), /change another app id/);
  assert.equal(Object.keys((mcpData.read('mcp.json') as { mcpServers: Record<string, unknown> }).mcpServers).length, 2);

  const crossData = dataFolder();
  crossData.write('mcp.json', { mcpServers: { 'A B': { url: 'https://a.example/mcp' } } });
  crossData.write('mail.json', { mailboxes: { 'A-B': { address: 'me@example.test', password: 'secret://pw' } } });
  const all = readConnectors(crossData.dir).connectors;
  assert.deepEqual(all.map(({ name, id }) => [name, id]), [['A B', 'a-b'], ['A-B', 'a-b-2']]);
  assert.throws(() => mutateConnectors(crossData.dir, { kind: 'remove', id: 'a-b', name: 'A B', transport: 'http' }), /change another app id/);
  assert.equal(Object.keys((crossData.read('mcp.json') as { mcpServers: Record<string, unknown> }).mcpServers).length, 1);
});
