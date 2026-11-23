// B-080 – a part names its model through the one model lookup (agents/next-route.ts catalogModel – model.set and
// agents.delegate use it too; splits/validate.ts modelOf): an id is stored as that id, the words same/cheap/strong stay
// words, an unknown or unusable model is refused with the lookup's own answer. Live 09.11.: "GPT-6 Luna" named the
// Vercel gateway entry for a delegation while the split took codex:gpt-6-luna – once B-083's plain-name lookup is in,
// both store codex:gpt-6-luna (that case is skipped until then).
// Owns: these checks. Never: an engine or the real dispatcher.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogModel } from '../../../src/runtime/agents/next-route.ts';
import type { ModelInfo } from '../../../src/shared/model/providers.ts';
import { part, world } from './fixture.ts';

const MODELS = [
  { id: 'vercel-free:openai/gpt-6-luna', model: 'openai/gpt-6-luna', name: 'GPT-6 Luna', efforts: ['none'], available: true },
  { id: 'codex:gpt-6-luna', model: 'gpt-6-luna', name: 'GPT-6-Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], available: true },
  { id: 'claude:claude-opus-5-5', model: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['low', 'high'], available: false },
] as unknown as ModelInfo[];
const CATALOG = { get: (id: string) => MODELS.find((model) => model.id === id), list: () => MODELS };
const found = catalogModel(CATALOG, 'GPT-6 Luna');
const plainNames = typeof found !== 'string' && found.id === 'codex:gpt-6-luna';

function stored(model: string): string | undefined {
  const w = world();
  Object.assign(w.services, { catalog: CATALOG });
  return w.splits.create(w.ctx(), { goal: 'Routine', parts: [part('A', { model })] }).splits[0].model;
}

function refused(model: string): { code?: string; message: string } {
  try { stored(model); } catch (error) { return { code: (error as { code?: string }).code, message: (error as Error).message }; }
  return { message: 'not refused' };
}

test('an id is stored as that id; the words stay words; an unknown or unusable model is refused with the lookup\'s answer', () => {
  assert.equal(stored('codex:gpt-6-luna'), 'codex:gpt-6-luna');
  assert.equal(stored('Cheap'), 'cheap');
  assert.equal(stored('same'), 'chain', "'same' names none: the fresh part's needs (the fixture's chain) decides");
  assert.match(refused('gpt-9-ultra').message, /^Part #1: .*gpt-9-ultra.* It also takes same, cheap or strong\.$/);
  assert.match(refused('claude:claude-opus-5-5').message, /^Part #1: .*Claude Opus 5\.5.* It also takes same, cheap or strong\.$/);
});

test('"GPT-6 Luna" is stored as codex:gpt-6-luna, the model agents.delegate stores for it', { skip: plainNames ? false : "B-083's plain-name lookup is not in next-route.ts yet" }, () => {
  assert.equal(stored('GPT-6 Luna'), 'codex:gpt-6-luna');
  assert.equal(stored('gpt-6-luna'), 'codex:gpt-6-luna');
});
