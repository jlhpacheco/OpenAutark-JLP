// models.setUse: one model use set to one value in one call – the same change of settings.json the Settings selects make
// (shared/model/models-uses.ts useWrite), and a local model that is not on this PC yet starts its download (which chooses it
// once it is here). Answers models.uses again, so the caller sees what the use runs on now.
// Owns: checking the value and applying that change. Never: maps a value itself (useWrite does) or waits for a download.

import type { RuntimeServices } from '../contracts.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { MODEL_USES, OFFABLE_USES, USE_OFF, useWrite, type ModelUse, type UseNow } from '../../shared/model/models-uses.ts';
import { modelUses } from './uses.ts';

export interface SetUseDeps {
  /** Starts a local speech model's download (voice.pullLocal). */
  pull(id: string): Promise<unknown>;
}

export async function setUse(s: RuntimeServices, use: string, value: string, deps: SetUseDeps): Promise<UseNow[]> {
  if (!(MODEL_USES as readonly string[]).includes(use)) throw new WorkforceError('bad_request', `use is one of ${MODEL_USES.join(', ')}.`);
  const wanted = value.trim();
  if (!wanted) throw new WorkforceError('bad_request', 'value is a value from the use\'s choices (models.uses).');
  if (wanted === USE_OFF && !OFFABLE_USES.has(use as ModelUse)) throw new WorkforceError('bad_request', `${use} cannot be turned off.`);
  let offers: Parameters<typeof useWrite>[2] = [];
  try { offers = s.stt.localModels().models; } catch { offers = []; }
  const { download, ...patch } = useWrite(use as ModelUse, wanted, offers);
  if (patch.routing || patch.voice) s.settings.update(patch);
  if (download) void deps.pull(download).catch((error: unknown) => s.log.warn('local model download did not start', { id: download, error: String(error) }));
  return modelUses(s);
}
