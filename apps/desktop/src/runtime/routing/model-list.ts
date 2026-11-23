// The model comparison behind the models.list tool (RT4): the models the calling agent may use for a kind of work,
// best first as router.ts ranks them – the same inputs: the agent's effective policy band (floor, ceiling, avoid;
// prefer as the score bonus), cost mode, "never" priors, the mode's minimum tier (for its own category; a preference as in pool.ts,
// so the list never says "nothing fits" where the router runs a lower tier), the healthy accounts of each model (API keys only as a
// spill-over unless settings.json routing.allowPaidFallback allows them or nothing else is left) and scoreModel (curated priors, work plan bonus).
// One compact line per model (texts: model-facts.ts), at most MAX_MODELS lines and about MAX_CHARS characters.
// Decisions and embeddings are uses of their own (B-072): what answers them now (context/setup-facts.ts usesLine) and
// only the connected models made for them – a chat model with no prior for them is no embedding model.
// B-083: the footer names my start model (and who set it); 17.11.2026 (the model settles): as the model I run on from my
// next context, and model.set as the way to name another, which then stays my start model (or runs at once with now:
// true); a start model of mine that cannot run now says so, with the stand-in rule (router.ts D3). A limited line
// says until when (unfit.ts backAt). B-083 (live 09.11.): a line names whether the model takes a temperature
// (model-facts.ts temperatureTag).
// Owns: this selection and its text. Never: changes state, routes a turn, or lists a chat model outside the policy band
// (decisions and embeddings list what is connected for that use).

import type { RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { ModeInfo } from '../../shared/model/knowledge.ts';
import { servesUse } from '../../shared/model/models-uses.ts';
import type { Account, ModelInfo } from '../../shared/model/providers.ts';
import { isDecisionModel, usesLine } from '../context/setup-facts.ts';
import { profileZone, stampText } from '../context/time.ts';
import { categoryLabel, resolveCategory } from './categories.ts';
import { backAt } from './unfit.ts';
import { effectivePolicy } from './policies.ts';
import { PIN_TEXT, resolvePin } from './pins.ts';
import { MODEL_CHOICE_LABELS } from '../../shared/model/model-guide.ts';
import { workPlanOf } from './preference.ts';
import { SYSTEM_ID } from '../../shared/ids.ts';
import { NEVER, isPaid, scoreModel, strengthOf, withinTiers, type CostMode } from './score.ts';
import { preferTier, runnableAccounts } from './pool.ts';
import { effortRange, priceText, signed, sourceOf, strengthOverview, temperatureTag } from './model-facts.ts';

export const MAX_MODELS = 30;
export const MAX_CHARS = 2500;
export const NO_MODELS_TEXT = 'No model is connected yet. The person adds a plan, an API key or a local server in Settings → Models.';

export interface ModelListInput {
  services: RuntimeServices;
  agent: Agent;
  /** The caller's mode: its category is the default kind of work, its minTier applies to that category (as router.ts). */
  mode: Pick<ModeInfo, 'category' | 'minTier'>;
  category?: string;
  includeUnavailable?: boolean;
}

type State = 'ok' | 'limited' | 'paid-off' | 'none';

interface Entry { model: ModelInfo; account?: Account; state: State; score: number; text?: string }

const STATE_TEXT: Record<Exclude<State, 'ok'>, string> = {
  limited: 'limited right now', 'paid-off': 'API key, used only when nothing else is left', none: 'no usable account',
};

const LEGEND = 'fit = strength -1…+1 for this work · $in/$out = API list price per 1M tokens (a plan costs nothing per turn while its quota lasts) · smarts = overall capability 0…100';

export function modelList(input: ModelListInput): string {
  const s = input.services;
  if (input.category === 'decision' || input.category === 'embeddings') return useModelList(s, input.category);
  const models = s.catalog.list();
  if (!models.length) return NO_MODELS_TEXT;
  const settings = s.settings.get().routing;
  const policy = effectivePolicy(s, input.agent);
  const own = resolveCategory(input.mode.category, undefined);
  const category = input.category ?? own;
  const explicit = input.category !== undefined;
  const costMode: CostMode = policy.costMode ?? settings.costMode ?? 'balanced';

  // The mode's minimum tier is the router's preference (pool.ts preferTier): below it only while no connected model reaches it.
  const tiered = preferTier(models, category === own ? input.mode.minTier : undefined);
  const fits = tiered.filter((model) => withinTiers(model.tier, policy.floorTier, policy.ceilingTier) && !policy.avoid.includes(model.id)
    && strengthOf(model, category) > NEVER);
  const candidates = fits.map((model) => {
    const all = model.available ? runnableAccounts(s, model) : [];
    return { model, all, usable: all };
  });
  const paidSpill = !settings.allowPaidFallback && candidates.some((entry) => entry.usable.some((account) => !isPaid(account)));
  const now = s.clock.now();
  const states = candidates.map((entry) => {
    const usable = paidSpill ? entry.usable.filter((account) => !isPaid(account)) : entry.usable;
    const state: State = !entry.model.available ? 'none' : !entry.all.length ? 'limited' : !usable.length ? 'paid-off' : 'ok';
    const until = state === 'limited' ? backAt(s, [entry.model], now).until : undefined;
    return { model: entry.model, account: usable[0] ?? entry.all[0], state, ...(until !== undefined ? { text: `limited until ${stampText(until, profileZone(s), now)}` } : {}) };
  });
  const prefer = new Set(policy.prefer);
  const workPlan = input.agent.id === SYSTEM_ID ? undefined : workPlanOf(s);
  const ranked: Entry[] = states
    .map((entry) => ({ ...entry, score: scoreModel({ model: entry.model, account: entry.account, category, costMode, preferred: prefer.has(entry.model.id), now, workPlan }) }))
    .sort((a, b) => Number(b.state === 'ok') - Number(a.state === 'ok') || b.score - a.score || a.model.id.localeCompare(b.model.id));
  const shown = input.includeUnavailable ? ranked : ranked.filter((entry) => entry.state === 'ok');
  const hidden = ranked.length - shown.length;

  const pin = policy.pin;
  const pinned = pin ? resolvePin(models, pin.modelId) : undefined;
  const lines = shown.slice(0, MAX_MODELS).map((entry) => lineOf(entry, category, explicit, pinned && pin ? { id: pinned.id, text: PIN_TEXT[pin.source] } : undefined));

  const bounds = policy.floorTier || policy.ceilingTier ? `; my model policy spans ${policy.floorTier ?? 'local'} to ${policy.ceilingTier ?? 'frontier'} models` : '';
  const title = `Models I can use for ${categoryLabel(category)}${explicit ? '' : " (my mode's kind of work; category picks another)"}, best first as routing ranks them (model preference ${MODEL_CHOICE_LABELS[costMode]}${bounds}):`;
  const footer: string[] = [];
  if (hidden) footer.push(`${hidden} more cannot run right now (includeUnavailable: true lists ${hidden === 1 ? 'it' : 'them'} with the reason).`);
  // My start model is where a fresh context of mine runs, and model.set names another from the next one on.
  const name = pinned?.name ?? pin?.modelId;
  const held = pinned ? ranked.find((entry) => entry.model.id === pinned.id) : undefined; // hidden entries included
  if (pin && held && (held.state === 'limited' || held.state === 'none')) { // a key-only start model still runs (router.ts tryPin)
    footer.push(`My start model is ${name}${setBy(input.agent)}; it cannot run now (${held.text ?? STATE_TEXT[held.state]}) – until then my turns start on a model from the strongest tier that runs at most at its price.`);
  } else if (pin) footer.push(`My start model is ${name}${setBy(input.agent)}; I run on it from my next context.`);
  if (shown.length) footer.push('I ask for one with model.set (its id, or a need such as "stronger" or "cheaper"): it runs from my next context, or at once with now: true, and stays my start model until I, my lead or the person names another.');

  if (!shown.length) return [title, `No model I can use fits ${categoryLabel(category)} right now.`, ...footer].join('\n');
  const moreLine = (count: number) => `… ${count} more not shown${explicit ? '' : ' (category narrows it)'}.`;
  const fixed = [title, LEGEND, ...footer, moreLine(shown.length)].join('\n').length;
  const picked: string[] = [];
  let used = fixed;
  for (const line of lines) {
    if (picked.length && used + line.length + 1 > MAX_CHARS) break;
    picked.push(line);
    used += line.length + 1;
  }
  const more = shown.length - picked.length;
  return [title, LEGEND, ...picked, ...(more ? [moreLine(more)] : []), ...footer].join('\n');
}

/** Decisions or embeddings: the model that answers now, then the connected models made for that use. */
function useModelList(s: RuntimeServices, use: 'decision' | 'embeddings'): string {
  let now = '';
  let accounts: Account[] = [];
  try { now = usesLine(s); } catch { /* a source that cannot be read: the list alone */ }
  try { accounts = s.accounts.list(); } catch { /* source as the provider tells */ }
  const made = s.catalog.list().filter((model) => model.available
    && (use === 'embeddings' ? servesUse(model, 'embeddings') : isDecisionModel(model)));
  const lines = made.slice(0, MAX_MODELS).map((model) => {
    const named = model.name && model.name.toLowerCase() !== model.model.toLowerCase();
    return `- ${named ? `${model.id} (${model.name})` : model.id} · ${sourceOf(model, accounts.find((account) => model.accounts.includes(account.id)))}`;
  });
  const kind = use === 'embeddings' ? 'Embedding models' : 'Decision models';
  return [
    ...(now ? [`Now: ${now}`] : []),
    lines.length ? `${kind} connected (settings.json routing.${use} takes the id):` : `${kind} connected: none (skill ai-providers shows the ways to add one).`,
    ...lines,
  ].join('\n');
}

/** " (Stanislaus set it)" / " (I set it myself)" – who set my start model (ModelPolicy.pinBy), else nothing. */
function setBy(agent: Agent): string {
  const by = agent.modelPolicy?.pinBy;
  if (by?.self) return ' (I set it myself)';
  return typeof by?.name === 'string' && by.name ? ` (${by.name} set it)` : '';
}

function lineOf(entry: Entry, category: string, explicit: boolean, pinned: { id: string; text: string } | undefined): string {
  const { model } = entry;
  const named = model.name && model.name.toLowerCase() !== model.model.toLowerCase();
  const parts = [named ? `${model.id} (${model.name})` : model.id, model.tier, sourceOf(model, entry.account)];
  const efforts = effortRange(model.efforts);
  if (efforts) parts.push(efforts);
  parts.push(`fit ${signed(strengthOf(model, category))}`);
  if (!explicit) {
    const overview = strengthOverview(model, category);
    if (overview) parts.push(overview);
  }
  const price = priceText(model); // B-078: the real list price and smarts instead of the relative cost
  if (price) parts.push(price);
  if (model.smarts !== undefined) parts.push(`smarts ${model.smarts}`);
  const temperature = temperatureTag(model); // B-083
  if (temperature) parts.push(temperature);
  if (entry.state !== 'ok') parts.push(entry.text ?? STATE_TEXT[entry.state]);
  if (model.id === pinned?.id) parts.push(pinned.text);
  return `- ${parts.join(' · ')}`;
}

/** Accounts that can run the model now (the router's rule: its provider, its listed accounts, healthy). */
