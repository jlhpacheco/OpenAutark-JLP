// B-085: why a report did not come out – drop.ts keeps the cause (timeout / offline / refused / server + status,
// not_set_up without a receiver), the service logs set up / sent / failed without the report's text, and the short
// report number both sides show.
// Owns: these assertions. Never: contacts Firebase.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { dropSealed, networkReason } from '../../../src/runtime/feedback/drop.ts';
import { FeedbackService, sendFailure } from '../../../src/runtime/feedback/service.ts';
import { generateReceiverKeys } from '../../../src/runtime/feedback/seal.ts';
import { reportNumber } from '../../../src/shared/model/feedback-delivery.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { MemoryLogger } from '../fakes.ts';
import { API_KEY, PROJECT, fakeMailbox, feedbackEnv, type Env } from './fakes.ts';

const envs: Env[] = [];
after(() => { for (const env of envs) env.cleanup(); });
const config = { publicKey: 'A'.repeat(43), project: PROJECT, apiKey: API_KEY };
const id = '6f9619ff-8b86-4011-b42d-00cf4fc964ff';
const sealed = Buffer.from('WFB1-sealed-bytes');

async function reasonOf(run: typeof fetch, cfg = config): Promise<Record<string, unknown> | undefined> {
  try { await dropSealed(cfg, id, sealed, run); } catch (error) { assert.ok(error instanceof WorkforceError); return error.details; }
  assert.fail('the drop did not fail');
}

test('a failed drop keeps its cause: offline, timeout, refused or server with the HTTP status', async () => {
  const box = fakeMailbox();
  box.state.create = 'throw';
  assert.deepEqual(await reasonOf(box.fetch), { reason: 'offline' });
  for (const status of [500, 503, 429]) {
    box.state.create = status;
    assert.deepEqual(await reasonOf(box.fetch), { reason: 'server', status });
  }
  box.state.create = null;
  assert.deepEqual(await reasonOf(box.fetch, { ...config, apiKey: 'AIzaWrongWrongWrongWrong00000' }), { reason: 'refused', status: 403 });
  const timedOut = (async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }) as typeof fetch;
  assert.deepEqual(await reasonOf(timedOut), { reason: 'timeout' });
  const answer = (status: number) => (async () => new Response('{"error":"remote detail"}', { status })) as typeof fetch;
  assert.deepEqual(await reasonOf(answer(400)), { reason: 'refused', status: 400 });
  assert.deepEqual(await reasonOf(answer(404)), { reason: 'refused', status: 404 });
  assert.deepEqual(await reasonOf(answer(502)), { reason: 'server', status: 502 });
});

test('network reasons: a timeout or abort is "timeout", anything else "offline"', () => {
  assert.equal(networkReason(new DOMException('x', 'TimeoutError')), 'timeout');
  assert.equal(networkReason(new DOMException('x', 'AbortError')), 'timeout');
  assert.equal(networkReason(new TypeError('fetch failed')), 'offline');
  assert.equal(networkReason('weird'), 'offline');
});

test('sendFailure logs our code, reason and status – never more than the error message', () => {
  const error = new WorkforceError('unavailable', 'Feedback could not be sent right now.', { details: { reason: 'server', status: 503 } });
  assert.deepEqual(sendFailure('fb_1', error), { id: 'fb_1', code: 'unavailable', reason: 'server', status: 503, error: 'Feedback could not be sent right now.' });
  assert.deepEqual(sendFailure('fb_2', new WorkforceError('bad_request', 'Too large.')), { id: 'fb_2', code: 'bad_request', error: 'Too large.' });
  assert.deepEqual(sendFailure('fb_3', new Error('boom')), { id: 'fb_3', code: 'internal', error: 'boom' });
});

function setup(receiver: 'set' | null = 'set') {
  const env = feedbackEnv();
  envs.push(env);
  const box = fakeMailbox();
  const team = generateReceiverKeys();
  const service = new FeedbackService({ services: () => env.s, receiver: receiver ? { publicKey: team.publicKey, project: PROJECT, apiKey: API_KEY } : null, fetch: box.fetch, os: 'test' });
  const log = env.s.log as unknown as MemoryLogger;
  return { env, box, service, log };
}

test('start says once whether sending is set up', () => {
  const on = setup();
  on.service.start();
  assert.deepEqual(on.log.entries.map((e) => [e.level, e.message, e.data]), [['info', 'feedback sending set up', { project: PROJECT }]]);
  const off = setup(null);
  off.service.start();
  assert.equal(off.log.entries.length, 1);
  assert.equal(off.log.entries[0].level, 'warn');
  assert.match(off.log.entries[0].message, /^feedback sending not set up/);
  assert.match(String(off.log.entries[0].data?.receiverFile), /receiver\.json$/);
});

test('one line per sent report (id, receipt) and per failed one (id, code, reason, status); the text never', async () => {
  const { box, service, log } = setup();
  const text = 'The sidebar secret text never reaches the log';
  const report = service.create({ kind: 'bug', text, author: 'human' });
  box.state.create = 503;
  await assert.rejects(service.send(report.id), (error: WorkforceError) => error.details?.reason === 'server');
  const failed = log.entries.find((e) => e.message === 'feedback send failed');
  assert.deepEqual({ ...failed?.data, error: undefined }, { id: report.id, code: 'unavailable', reason: 'server', status: 503, error: undefined });
  box.state.create = null;
  const sent = await service.send(report.id);
  const line = log.entries.find((e) => e.message === 'feedback sent');
  assert.deepEqual(line?.data, { id: report.id, receipt: sent.receiptId });
  assert.equal(JSON.stringify(log.entries).includes('secret text'), false);
});

test('without a receiver the send fails with reason not_set_up and a log line', async () => {
  const { service, log } = setup(null);
  const report = service.create({ kind: 'bug', text: 'Saved only', author: 'human' });
  await assert.rejects(service.send(report.id), (error: WorkforceError) => error.details?.reason === 'not_set_up');
  assert.equal(log.entries.find((e) => e.message === 'feedback send failed')?.data?.reason, 'not_set_up');
});

test('the report number: the first 8 letters and digits of the receipt, in capitals', () => {
  assert.equal(reportNumber('6f9619ff-8b86-4011-b42d-00cf4fc964ff'), '6F9619FF');
  assert.equal(reportNumber('ab-cd-ef-12-34'), 'ABCDEF12');
  assert.equal(reportNumber(undefined), '');
  assert.equal(reportNumber(''), '');
});
