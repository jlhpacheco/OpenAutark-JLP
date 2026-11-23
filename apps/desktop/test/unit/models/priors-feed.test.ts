// 14.11. global model rating (runtime/models/priors-feed.ts): the daily copy from openautark.com is checked with the
// priors parser, kept as the last good copy, taken in place when it is not older than the priors in use (catalog, routing
// and turn pricing hold the same object), and the shipped priors stay the fallback.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Priors } from '../../../src/runtime/models/priors.ts';
import { buildModel } from '../../../src/runtime/models/catalog-merge.ts';
import { adoptCopy, feedCopy, PRIORS_FEED_MS, PRIORS_FEED_URL, priorsFeedDue, refreshPriorsFeed, useStoredCopy } from '../../../src/runtime/models/priors-feed.ts';
import { MemoryLogger } from '../fakes.ts';
import { clock, memoryDb } from '../store/helpers.ts';

const SHIPPED = path.resolve(import.meta.dirname, '../../../resources/model-priors.json');

/** A copy as the generator writes it: dated, our entries, one changed judgement. */
function copy(version: string, smarts = 97): Record<string, unknown> {
  return {
    $source: 'test',
    version,
    categories: { coding: 'Software engineering' },
    models: [
      { match: 'claude-opus-5-5*', name: 'Claude Opus 5.5', tier: 'frontier', smarts, priceInputPerM: 4, priceOutputPerM: 20, strengths: { coding: 0.9 } },
      { match: 'claude-fable-5-1*', name: 'Claude Fable 5.1', tier: 'frontier', smarts: 90, strengths: { coding: 0.6 } },
    ],
  };
}

const answer = (body: unknown, status = 200) => async () => ({ ok: status < 400, status, text: async () => typeof body === 'string' ? body : JSON.stringify(body) });

test('a copy counts with a dated version and at least one model; anything else is no copy', () => {
  assert.equal(feedCopy(copy('2026-11-14'))?.data.models.length, 2);
  assert.equal(feedCopy(copy('2026-11-14T03:00:00Z'))?.data.version, '2026-11-14T03:00:00Z');
  assert.equal(feedCopy({ ...copy('x'), version: 'latest' }), undefined);
  assert.equal(feedCopy({ version: '2026-11-14', models: [] }), undefined);
  assert.equal(feedCopy({ version: '2026-11-14', models: [{ nope: true }] }), undefined, 'entries without a match are dropped by the parser');
  assert.equal(feedCopy([copy('2026-11-14')]), undefined);
  assert.equal(feedCopy('2026-11-14'), undefined);
  assert.equal(feedCopy(null), undefined);
  assert.equal(PRIORS_FEED_URL, 'https://openautark.com/model-priors.json');
});

test('a copy is taken in place when not older than the priors in use; older or equal content changes nothing', () => {
  const priors = Priors.parse(copy('2026-11-06', 94));
  const model = () => buildModel({ provider: 'claude', engine: 'claude', listed: { model: 'claude-opus-5-5', name: 'claude-opus-5-5', efforts: [] }, priors });
  assert.equal(model().smarts, 94);
  assert.equal(adoptCopy(priors, feedCopy(copy('2026-11-01', 50))), false, 'older than the priors in use');
  assert.equal(model().smarts, 94);
  assert.equal(adoptCopy(priors, feedCopy(copy('2026-11-14'))), true);
  assert.equal(priors.data.version, '2026-11-14');
  assert.equal(model().smarts, 97, 'everyone holding the object reads the new entries');
  assert.equal(adoptCopy(priors, feedCopy(copy('2026-11-14'))), false, 'the same content again');
  assert.equal(adoptCopy(priors, undefined), false);
  const broken = Priors.empty(); // a shipped file that could not be read: any dated copy is newer
  assert.equal(adoptCopy(broken, feedCopy(copy('2026-01-01'))), true);
});

test('a new release of a family follows the adopted entries, not the old ones (the predecessor lookup starts over)', () => {
  const priors = Priors.parse(copy('2026-11-06', 94));
  assert.equal(priors.forNewer('claude-opus-5-6')?.smarts, 94);
  adoptCopy(priors, feedCopy(copy('2026-11-14', 97)));
  assert.equal(priors.forNewer('claude-opus-5-6')?.smarts, 97);
});

test('package C: a price the copy does not carry stays, a price it carries wins, and a model it drops is gone', () => {
  const priors = Priors.load(SHIPPED);
  const opus = () => priors.forModel('claude-opus-5-5')!;
  assert.deepEqual([opus().priceCachedInputPerM, opus().priceCacheWritePerM], [0.2, 8]);
  // The generator's copy lists input and output from Artificial Analysis; it does not carry the CLI's read and write prices yet.
  assert.equal(adoptCopy(priors, feedCopy(copy('2026-11-20'))), true);
  assert.deepEqual([opus().priceInputPerM, opus().priceOutputPerM], [4, 20]);
  assert.deepEqual([opus().priceCachedInputPerM, opus().priceCacheWritePerM], [0.2, 8], 'the shipped read and write prices survive the refresh');
  assert.equal(adoptCopy(priors, feedCopy(copy('2026-11-20'))), false, 'the same copy again changes nothing');
  const listed = { ...copy('2026-11-21'), models: [{ match: 'claude-opus-5-5*', strengths: {}, priceInputPerM: 5, priceOutputPerM: 25, priceCachedInputPerM: 0.5, priceCacheWritePerM: 10 }] };
  assert.equal(adoptCopy(priors, feedCopy(listed)), true);
  assert.deepEqual([opus().priceCachedInputPerM, opus().priceCacheWritePerM], [0.5, 10], 'what the copy lists is the price');
  assert.equal(priors.forModel('claude-sonnet-5-5'), undefined, 'the copy is the list of models');
});

test('refreshPriorsFeed: once a day, stored and taken; a newer shipped file wins over an older copy', async () => {
  const db = memoryDb();
  const time = clock();
  const log = new MemoryLogger();
  const priors = Priors.load(SHIPPED);
  const shippedVersion = priors.data.version;
  const urls: string[] = [];
  let reply = answer(copy('2999-01-01'));
  const deps = { db, clock: time, log, priors, fetch: async (url: string) => { urls.push(url); return reply(); } };
  assert.equal(priorsFeedDue(db, time.now()), true);
  assert.equal(await refreshPriorsFeed(deps), true);
  assert.deepEqual(urls, [PRIORS_FEED_URL]);
  assert.equal(priors.data.version, '2999-01-01');
  assert.ok(log.entries.some((entry) => entry.message === 'model priors refreshed'));
  assert.equal(await refreshPriorsFeed(deps), false, 'not due again the same day');
  assert.equal(urls.length, 1);

  // the next start: the stored copy goes into the shipped priors; an app update with newer priors keeps its own
  const restarted = Priors.load(SHIPPED);
  assert.equal(useStoredCopy(db, restarted), true);
  assert.equal(restarted.data.version, '2999-01-01');
  const updated = Priors.parse({ ...copy('3000-01-01', 99) });
  assert.equal(useStoredCopy(db, updated), false);
  assert.equal(updated.data.version, '3000-01-01');

  // a copy older than the priors in use is stored, not taken
  time.advance(PRIORS_FEED_MS);
  reply = answer(copy('2000-01-01'));
  const fresh = Priors.load(SHIPPED);
  assert.equal(await refreshPriorsFeed({ ...deps, priors: fresh }), false);
  assert.equal(fresh.data.version, shippedVersion);
});

test('refreshPriorsFeed: a 404 page, odd JSON or no network is skipped – the stored copy and the priors stay; retried after 6 h', async () => {
  const db = memoryDb();
  const time = clock();
  const log = new MemoryLogger();
  const priors = Priors.load(SHIPPED);
  let calls = 0;
  let reply = answer(copy('2999-01-01'));
  const deps = { db, clock: time, log, priors, fetch: async () => { calls += 1; return reply(); } };
  assert.equal(await refreshPriorsFeed(deps), true);
  time.advance(PRIORS_FEED_MS);
  reply = answer('<!doctype html><title>Not found</title>', 404);
  assert.equal(await refreshPriorsFeed(deps), false);
  assert.equal(calls, 2);
  assert.ok(log.entries.some((entry) => entry.message === 'model priors skipped' && entry.data?.error === 'HTTP 404'));
  assert.equal(priors.data.version, '2999-01-01', 'the priors in use stay');
  assert.equal(priorsFeedDue(db, time.now()), false, 'a failure waits');
  time.advance(6 * 60 * 60_000);
  assert.equal(priorsFeedDue(db, time.now()), true);
  reply = answer('{"version": "2026-11-14", "models": []}');
  assert.equal(await refreshPriorsFeed(deps), false);
  time.advance(6 * 60 * 60_000);
  reply = answer('not json');
  assert.equal(await refreshPriorsFeed(deps), false);
  time.advance(6 * 60 * 60_000);
  reply = async () => { throw new Error('offline'); };
  assert.equal(await refreshPriorsFeed(deps), false, 'a thrown fetch never throws on');
  time.advance(6 * 60 * 60_000);
  reply = answer('x'.repeat(2_000_001));
  assert.equal(await refreshPriorsFeed(deps), false);
  const next = Priors.load(SHIPPED);
  assert.equal(useStoredCopy(db, next), true, 'the last good copy is still stored');
  assert.equal(next.data.version, '2999-01-01');
});

test('without a stored copy the shipped priors are in use', () => {
  const priors = Priors.load(SHIPPED);
  const version = priors.data.version;
  assert.equal(useStoredCopy(memoryDb(), priors), false);
  assert.equal(priors.data.version, version);
});
