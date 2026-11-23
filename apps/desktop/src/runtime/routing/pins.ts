// Pin helpers of the router (moved out of router.ts unchanged, RT1): the reason texts of start models (B-083),
// the Settings use pin (Work for agents, Decisions for runtime helper calls – shared/model/models-uses.ts),
// why a pin is unusable, and how a named model is found (B-083 D5: one lookup for every place that names a model).
// Owns: these lookups and texts. Never: decides whether a pin wins (router.ts does) or reads
// state beyond the settings and catalog list it is given.

import type { RouteRequest } from '../contracts.ts';
import type { ModelInfo } from '../../shared/model/providers.ts';
import type { RoutingSettings } from '../../shared/model/system.ts';
import { SYSTEM_ID } from '../../shared/ids.ts';
import { chosenFor, isProviderChoice } from '../../shared/model/models-uses.ts';
import { ENGINE_PROVIDERS } from '../accounts/candidates.ts';
import { categoryLabel } from './categories.ts';

/** Provider prefixes of catalog ids (`${provider}:${model}`). */
const PROVIDER_IDS: ReadonlySet<string> = new Set(Object.values(ENGINE_PROVIDERS).flat());

/** Route reasons of a start model (B-083: a suggestion and a start, no pin – the agent's own model.set changes it). */
export const PIN_TEXT: Record<'agent' | 'settings' | 'decision' | 'helper', string> = {
  agent: 'my start model', settings: 'the Work model in Settings',
  decision: 'the Decisions model in Settings', // runtime helper calls' Settings use
  helper: 'helper default', // SG: runtime text calls on a Codex plan's small model (helper-default.ts)
};

/**
 * The Settings use of a route as a pin: agent turns take the Work model (every kind of work; a plan's provider id is
 * no pin – it is the work plan, preference.ts), runtime helper calls (agent 'system') the Decisions model. "auto" = none.
 */
export function settingsPin(settings: RoutingSettings, request: RouteRequest): { modelId: string; source: 'settings' | 'decision' } | undefined {
  const use = request.agent.id === SYSTEM_ID ? 'decision' : 'work';
  const chosen = chosenFor(settings, use);
  return chosen && !isProviderChoice(chosen) ? { modelId: chosen, source: use === 'work' ? 'settings' : 'decision' } : undefined;
}

export function pinProblem(why: string, category: string): string {
  if (why === 'never') return `not for ${categoryLabel(category)}`;
  if (why === 'policy') return 'outside the model policy';
  return `needs ${why}`;
}

/** D5: the plain form of a model name – "GPT-6 Luna" = "GPT-6-Luna" = "gpt-6-luna" (case, spaces, hyphens, underscores). */
const plain = (value: string) => value.toLowerCase().replace(/[\s_-]+/g, '');

/**
 * Every catalog model `named` names, the one to take first: the exact id, the older "<provider>:<model>" (a connection
 * that now names itself, settings.json providers), an id in plain form, then (never for a provider-qualified id – a
 * "codex:" plan pin never becomes an "openai:" key) the provider's model id, then the display name, both in plain form;
 * within each, available first, the catalog order breaks ties. B-083 D5: the one model lookup – pins, Settings uses,
 * model.set, tasks.add / tasks.update for a colleague, a split's part and my subconscious's turn (agents/next-route.ts catalogModel) name alike.
 */
export function modelMatches(models: readonly ModelInfo[], named: string): ModelInfo[] {
  const wanted = plain(named);
  const colon = named.indexOf(':');
  const qualified = colon > 0 && PROVIDER_IDS.has(named.slice(0, colon));
  const steps: Array<(model: ModelInfo) => boolean> = [
    (model) => model.id === named,
    (model) => `${model.provider}:${model.model}` === named,
    (model) => plain(model.id) === wanted,
    ...(qualified ? [] : [(model: ModelInfo) => plain(model.model) === wanted, (model: ModelInfo) => plain(model.name ?? '') === wanted]),
  ];
  const found = new Set<ModelInfo>();
  for (const step of steps) {
    const hits = models.filter(step);
    for (const model of [...hits.filter((item) => item.available), ...hits.filter((item) => !item.available)]) found.add(model);
  }
  return [...found];
}

/** The model a pin (or any named model) runs on: the first of modelMatches. */
export function resolvePin(models: readonly ModelInfo[], pin: string): ModelInfo | undefined {
  return modelMatches(models, pin)[0];
}
