// 14.11. global model rating: the generator (scripts/model-priors/generate.mts) on the recorded-shape AA fixture – our
// judgement passes through unchanged, AA list prices land on the hosted models AA lists under the same name, local models
// and other variants stay apart, the file is one the app takes, and the key is never printed or written. No network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Priors, relCostOfPrices } from '../../../src/runtime/models/priors.ts';
import { feedCopy } from '../../../src/runtime/models/priors-feed.ts';
import {
  AA_URL, ATTRIBUTION, baseOf, buildFeed, effortOf, fetchAa, KEY_ENV, parseAaPage, readJudgment, SHIPPED, stemOf,
} from '../../../../../scripts/model-priors/generate.mts';
import { tempDir } from '../store/helpers.ts';

const SCRIPT = path.resolve(import.meta.dirname, '../../../../../scripts/model-priors/generate.mts');
const FIXTURE = path.resolve(import.meta.dirname, '../../../../../scripts/model-priors/fixture-aa.json');
const pages = JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown[];
const judgment = readJudgment(SHIPPED);
const shipped = Priors.load(SHIPPED);
const JUDGEMENT_FIELDS = ['match', 'name', 'tier', 'smarts', 'strengths', 'note', 'caps', 'efforts', 'defaultEffort'] as const;

test('AA names, slugs and our ids meet on one base; effort labels are read', () => {
  assert.equal(baseOf('Claude Opus 5.5 (max, fallback)'), 'claudeopus55');
  assert.equal(baseOf('claude-opus-5-5-high-fallback'), 'claudeopus55');
  assert.equal(baseOf('GPT-6.1 Sol (xhigh)'), 'gpt61sol');
  assert.equal(baseOf('gpt-6-1-sol-medium'), 'gpt61sol');
  assert.equal(baseOf('DeepSeek V4 Flash 0731'), 'deepseekv4flash');
  assert.equal(stemOf('gpt-6.1-sol*'), 'gpt61sol');
  assert.equal(stemOf('claude-opus-5-5*'), 'claudeopus55');
  assert.equal(stemOf('text-embedding-3-small'), 'textembedding3small');
  assert.equal(stemOf('*embed*'), undefined);
  assert.equal(stemOf('gemini-cli:default'), undefined);
  assert.equal(effortOf('Claude Opus 5.5 (high with fallback)'), 'high');
  assert.equal(effortOf('Model X (Non-reasoning)'), 'none');
  assert.equal(effortOf('gpt-6-1-sol-xhigh'), 'xhigh');
  assert.equal(effortOf('GPT-6 Luna'), undefined);
  const rows = parseAaPage(pages[0]);
  assert.equal(rows.length, 11, 'the item without name and slug is skipped');
  assert.equal(rows[0].intelligence, 58);
  assert.equal(parseAaPage(pages[1]).find((row) => row.name === 'Muse Wonder Full (max)')?.input, undefined, 'null = not measured');
});

test('the built file: our judgement unchanged, AA prices on the models AA lists, relCost then derived', () => {
  const { feed, report } = buildFeed({ judgment, pages, today: '2026-11-14', from: 'from the recorded answer fixture-aa.json' });
  assert.equal(feed.version, judgment.version, "the judgement's version: an app update with a newer judgement wins (review 14.11.)");
  assert.ok(feed.$source.includes('on 2026-11-14'), 'the day of the prices stands in $source');
  assert.ok(feed.$source.includes(ATTRIBUTION) && feed.$source.includes(`version ${judgment.version}`));
  assert.equal(feed.models.length, judgment.models.length);
  for (const [index, entry] of feed.models.entries()) {
    for (const field of JUDGEMENT_FIELDS) assert.deepEqual(entry[field], judgment.models[index][field], `${String(entry.match)} ${field}`);
  }
  const copy = feedCopy(feed);
  assert.ok(copy, 'the app takes it');
  const prior = (model: string) => copy.forModel(model)!;
  // picked by the entry's default effort: Opus high (54), Sol medium (48); prices the same on every variant
  assert.deepEqual([prior('claude-opus-5-5').priceInputPerM, prior('claude-opus-5-5').priceOutputPerM, prior('claude-opus-5-5').priceCachedInputPerM], [4, 20, 0.2]);
  // review 2, 17.11.2026: the read price our judgement carries is the CLI's own (measured), so AA's cached price never
  // replaces it – it raised company-2's repaired Opus figure from $1,943 to $2,883; a model without one takes AA's
  assert.ok(report.includes('claude-opus-5-5*: smarts 94 · AA index 54 (high) · price 4/20 (cached 0.2) → 4/20 (cached 0.2)'), report.join('\n'));
  assert.equal(prior('gpt-6.1-sol').priceCachedInputPerM, 0.2, 'Sol has no read price of ours: it takes AA\'s');
  assert.equal(prior('claude-opus-5-5').priceCacheWritePerM, 8, 'the write price passes through the generator');
  assert.ok(report.some((line) => line.startsWith('gpt-6.1-sol*: smarts 93 · AA index 48 (medium) · price – → 2/10')));
  // a hand-set relCost gives way to the prices
  assert.equal(shipped.forModel('gpt-6.1-sol')!.relCost, 0.3);
  assert.equal(prior('gpt-6.1-sol').relCost, relCostOfPrices(2, 10));
  assert.equal(prior('grok-4.7').relCost, relCostOfPrices(3, 15), 'Grok 4.7 Fast is another model: its prices stay apart');
  // AA's index never replaces our smarts (Astra: AA 53 over Sol's 48, ours keeps Sol above, D16)
  assert.equal(prior('gpt-6-astra').smarts, shipped.forModel('gpt-6-astra')!.smarts);
  assert.ok(prior('gpt-6-astra').smarts! <= prior('gpt-6.1-sol').smarts!);
  // local entries keep theirs (Qwen3.8 Max is the hosted flagship), other versions stay apart (V4.1 Flash is no V4)
  assert.deepEqual(feed.models.find((entry) => entry.match === 'qwen3.8*'), judgment.models.find((entry) => entry.match === 'qwen3.8*'));
  assert.deepEqual(feed.models.find((entry) => entry.match === 'deepseek-v4*'), judgment.models.find((entry) => entry.match === 'deepseek-v4*'));
  assert.ok(report.at(-1)!.startsWith('AA models we do not rate (index): Muse Wonder Full 56, Qwen3.8 Max 45, Grok 4.7 Fast 40'), report.at(-1));
});

test('without AA data the file is our judgement alone, dated today', () => {
  const { feed, report } = buildFeed({ judgment, today: '2026-11-14' });
  assert.deepEqual(feed.models, judgment.models);
  assert.equal(report.length, 0);
  assert.ok(!feed.$source.includes('Artificial Analysis'));
  assert.equal(feedCopy(feed)?.data.models.length, shipped.data.models.length);
});

test('fetchAa: the key only in the x-api-key header, every page, and errors that never carry it', async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const got = await fetchAa('key-123', async (url, init) => {
    calls.push({ url, headers: init.headers });
    return { ok: true, status: 200, json: async () => pages[calls.length - 1] };
  });
  assert.equal(got.length, 2);
  assert.deepEqual(calls.map((call) => call.url), [AA_URL, `${AA_URL}?page=2`]);
  assert.equal(calls[0].headers['x-api-key'], 'key-123');
  assert.ok(!calls[1].url.includes('key-123'));
  await assert.rejects(fetchAa('key-123', async () => ({ ok: false, status: 401, json: async () => ({}) })), (error: Error) => {
    assert.equal(error.message, 'Artificial Analysis answered HTTP 401 (key rejected or tier too low)');
    return !error.message.includes('key-123');
  });
  await assert.rejects(fetchAa('k', async () => ({ ok: true, status: 200, json: async () => ({ error: 'x' }) })), /without a data list/);
});

test('the command: a recorded answer needs --out, the key never reaches output or file, LF only', () => {
  const temp = tempDir('model-priors-');
  try {
    const out = path.join(temp.dir, 'model-priors.json');
    const secret = 'aa-test-key-never-printed';
    const run = (args: string[], key?: string) => {
      const env: Record<string, string | undefined> = { ...process.env };
      delete env[KEY_ENV];
      if (key) env[KEY_ENV] = key;
      return spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8' });
    };
    const recorded = run(['--fixture', FIXTURE, '--out', out], secret);
    assert.equal(recorded.status, 0, recorded.stderr);
    const text = readFileSync(out, 'utf8');
    assert.ok(!`${recorded.stdout}${recorded.stderr}${text}`.includes(secret));
    assert.equal(text.includes('\r'), false);
    assert.ok(feedCopy(JSON.parse(text)));
    assert.match(String(JSON.parse(text).version), /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(recorded.stdout.includes('price – → 2/10'));
    const refused = run(['--fixture', FIXTURE], secret);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /--fixture needs --out/);
    const alone = run(['--out', out]);
    assert.equal(alone.status, 0, alone.stderr);
    assert.ok(alone.stdout.includes(`${KEY_ENV} is not set`));
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).models, judgment.models);
  } finally {
    temp.cleanup();
  }
});
