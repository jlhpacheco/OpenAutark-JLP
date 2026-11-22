// fb_1m7g38pj9cprfyhvs (15.11.2026, two companies on one PC): company one listened at 0.0.0.0:47811, company two at
// 127.0.0.1:47811 – Windows let both bind, loopback calls then reached company two and company one's token got 401.
// listen.ts holds 127.0.0.1 beside a 0.0.0.0 listener, so the second company takes another port, either way round.
// Real sockets on a free port of this machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { listenWithFallback } from '../../../src/runtime/http/listen.ts';

const services = {} as RuntimeServices; // no database: nothing remembered

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const named = (name: string) => () => createServer((_req, res) => { res.end(name); });

function get(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/' }, (res) => { let body = ''; res.on('data', (chunk) => { body += chunk; }); res.on('end', () => resolve(body)); });
    req.on('error', reject);
    req.end();
  });
}

async function close(...servers: Server[]): Promise<void> {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
}

for (const [firstHost, secondHost] of [['0.0.0.0', '127.0.0.1'], ['127.0.0.1', '0.0.0.0'], ['0.0.0.0', '0.0.0.0']] as const) {
  test(`two companies, one PC: ${firstHost} first, then ${secondHost} – the second takes its own port, loopback stays the first's`, async () => {
    const port = await freePort();
    const one = await listenWithFallback(named('one'), firstHost, port, services);
    const two = await listenWithFallback(named('two'), secondHost, port, services);
    try {
      assert.equal(one.port, port);
      assert.notEqual(two.port, port, 'the second company moved off the taken port');
      assert.equal(await get(port), 'one', '127.0.0.1 on the first port reaches the first company');
      assert.equal(await get(two.port), 'two');
    } finally {
      await close(one.server, two.server);
    }
  });
}
