// 15.11.2026 (two companies on one PC): Windows let 0.0.0.0:P and 127.0.0.1:P of two processes coexist and loopback traffic
// reached the other company's runtime (MCP 401). A listener at 0.0.0.0 holds 127.0.0.1 on its port itself, so loopback on
// a chosen port always answers its own runtime – in both bind orders, with the other listener slipping in between our
// listen and our hold, when both start at once, and across a restart. Each server answers with its name; that is checked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttp, get, type Server } from 'node:http';
import { createServer as createNet } from 'node:net';
import type { AddressInfo } from 'node:net';
import { DEFAULT_PORT, listenWithFallback } from '../../../src/runtime/http/listen.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';

const close = (server: { close(cb: () => void): unknown }) => new Promise<void>((resolve) => { server.close(() => resolve()); });

async function freePort(): Promise<number> {
  const probe = createNet();
  await new Promise<void>((resolve) => probe.listen(0, '0.0.0.0', () => resolve()));
  const { port } = probe.address() as AddressInfo;
  await close(probe);
  return port;
}

/** An HTTP server that answers every request with `name`. */
const named = (name: string): Server => createHttp((_request, response) => { response.end(name); });

async function other(host: string, port: number): Promise<Server> {
  const server = named('other company');
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve()); });
  return server;
}

/** Who answers http://127.0.0.1:port (a fresh connection each time). */
function whoAnswers(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = get({ host: '127.0.0.1', port, path: '/', agent: false }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve(body));
    });
    request.on('error', reject);
  });
}

/** Services whose kv keeps one remembered port, like the runtime's (http/fallbackPort). */
function services(initial?: number): RuntimeServices & { remembered(): number | undefined } {
  let value = initial;
  const db = {
    get: () => (value === undefined ? undefined : { value: JSON.stringify(value) }),
    run: (_sql: string, params: unknown[]) => { value = JSON.parse(String(params[2])); },
  };
  return { db, clock: { now: () => 0 }, remembered: () => value } as unknown as RuntimeServices & { remembered(): number | undefined };
}

for (const [taken, ours] of [['0.0.0.0', '127.0.0.1'], ['127.0.0.1', '0.0.0.0'], ['127.0.0.1', '127.0.0.1'], ['0.0.0.0', '0.0.0.0']] as const) {
  test(`another listener already at ${taken}: ours at ${ours} – loopback on our port answers ours`, async () => {
    const port = await freePort();
    const theirs = await other(taken, port);
    try {
      const { server, port: chosen } = await listenWithFallback(() => named('ours'), ours, port, services());
      try {
        assert.equal(await whoAnswers(chosen), 'ours');
        if (taken === '127.0.0.1' || ours === taken) assert.notEqual(chosen, port, 'their exact address is theirs');
      } finally { await close(server); }
    } finally {
      await close(theirs);
    }
  });
}

test('the other one slips in at 127.0.0.1 after our 0.0.0.0 listen and before our hold – we take another port', async () => {
  const port = await freePort();
  let theirs: Server | undefined;
  const hooks = { listening: async (chosen: number) => { if (chosen === port) theirs = await other('127.0.0.1', port); } };
  const { server, port: chosen } = await listenWithFallback(() => named('ours'), '0.0.0.0', port, services(), hooks);
  try {
    if (theirs) {
      assert.notEqual(chosen, port);
      assert.equal(await whoAnswers(port), 'other company');
    }
    assert.equal(await whoAnswers(chosen), 'ours');
  } finally {
    await close(server);
    if (theirs) await close(theirs);
  }
});

test('once ours listens at 0.0.0.0, nobody else can take 127.0.0.1 on that port', async () => {
  const port = await freePort();
  const { server, port: chosen } = await listenWithFallback(() => named('ours'), '0.0.0.0', port, services());
  try {
    assert.equal(chosen, port);
    await assert.rejects(other('127.0.0.1', port), (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE' || error.code === 'EACCES');
    assert.equal(await whoAnswers(port), 'ours');
  } finally { await close(server); }
});

test('two companies starting at once on one port: each loopback endpoint answers its own runtime (20 rounds, both host orders)', async () => {
  for (let round = 0; round < 20; round++) {
    const port = await freePort();
    const [hostA, hostB] = round % 2 ? ['0.0.0.0', '127.0.0.1'] : ['127.0.0.1', '0.0.0.0'];
    const [a, b] = await Promise.all([
      listenWithFallback(() => named('A'), hostA, port, services()),
      listenWithFallback(() => named('B'), hostB, port, services()),
    ]);
    try {
      assert.notEqual(a.port, b.port, `round ${round}`);
      assert.equal(await whoAnswers(a.port), 'A', `round ${round}`);
      assert.equal(await whoAnswers(b.port), 'B', `round ${round}`);
    } finally {
      await Promise.all([close(a.server), close(b.server)]);
    }
  }
});

test('closing our server frees both addresses of its port', async () => {
  const port = await freePort();
  const { server } = await listenWithFallback(() => named('ours'), '0.0.0.0', port, services());
  await close(server);
  const again = await other('127.0.0.1', port);
  await close(again);
  const wide = await other('0.0.0.0', port);
  await close(wide);
});

test('a company that found the default port taken keeps its own port across a restart', async () => {
  const kept = services();
  const port = await freePort();
  const theirs = await other('127.0.0.1', port);
  let first: number;
  try {
    // configured = the taken port: the fallback is remembered …
    const started = await listenWithFallback(() => named('ours'), '0.0.0.0', port, kept);
    first = started.port;
    assert.notEqual(first, port);
    assert.equal(kept.remembered(), first);
    await close(started.server);
  } finally {
    await close(theirs);
  }
  // … and with the default configured, the remembered one comes first – also after the other company stopped.
  const restarted = await listenWithFallback(() => named('ours'), '0.0.0.0', DEFAULT_PORT, kept);
  try {
    assert.equal(restarted.port, first);
    assert.equal(await whoAnswers(first), 'ours');
  } finally { await close(restarted.server); }
});
