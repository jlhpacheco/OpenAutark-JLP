// What I, my task's giver or my subconscious asked a coming turn to run on (model.set, tasks.add / tasks.update for, the
// call before a turn) and the choice a turn starts from.
// 17.11.2026 (the model settles; measured 15.–17.11.: 36 switches were the return to a model several runs old, 38 a task's
// model request from its giver, re-resolved on every turn of an agent that worked on two things): the model I am on is
// where every turn starts – the model my session is on, else my newest done run's – and a request moves the effort on any
// turn, the model only where my context starts anew (routing/router.ts decides with RouteRequest.boundary).
// Owns: these rows of the kv table –
//   - my next turn's step (ns next_route, one per agent – one context, wherever the turn is woken): an effort and a
//     temperature for that one turn – mine (model.set) or my subconscious's (`by: 'subconscious'`, its why as `reason`).
//     planTurn reads it with its `at`, agents/turn.ts takes that one just before the engine starts, so a turn that fails
//     before its engine leaves it and one written while the turn was prepared holds for the next turn (B-080);
//   - the model I asked for (ns next_model, one per agent): a model or a kind of model (B-048 E4.2 `need` + `from`,
//     routing/need.ts) that waits for my next boundary, or runs my next turn at once with `now`; the turn that could
//     apply it takes it (takeNextModel), and it stands past that stretch as my own start model, which model.set writes
//     beside this row (tools/builtin/models.ts) and clearNextModel drops with it; another start model set after it (the
//     person's, my lead's – startModelSet) ends it: the newest choice holds (FIXES-3b F3);
//   - a task's request (ns next_route_task, per agent and task): an effort and a temperature for every turn of mine on
//     that task, in any chat, until it is done or cancelled, then its row is dropped. A model on such a row – written
//     before this version – is not read: a model is named where a context starts (a part, a new colleague, a colleague's
//     settled model – agents.split, agents.create, agents.update).
// `returnChoice`, a turn's RouteRequest.previous: the model I am on with my settled effort there – that of my newest done
// run on it whose effort nobody asked for, with its category; a request in force on top, marked explicit – a named model carries `from`, the model I am on, where the turn stays
// off a boundary and while the named one cannot run; an effort that is not my own carries whose it is (`by`: my
// subconscious's, my task's) with its why, so the route's reason names its source.
// `catalogModel`, the check of a model a request names (model.set, a split's part, agents.create): B-083 D5 the one lookup
// (routing/pins.ts modelMatches), D4 no effort refused – the router clamps it; `modelWord`: cheap / strong as a need
// relative to the model I run on.
// B-078 (D14/D16): a request may carry a temperature (0..2), kept like the effort; B-080: planTurn puts it on
// TurnPlan.temperature and the turn hands it to the engine; engines without one ignore it.
// Never: bypasses the router – a request reaches it as the explicit previous choice and the router keeps policy, budget
// and availability bounds (routing/previous.ts).

import type { Db } from '../db/database.ts';
import { KvRepo } from '../store/kv.ts';
import type { ModelCatalog, RouteRequest } from '../contracts.ts';
import type { Effort, ModelInfo } from '../../shared/model/providers.ts';
import { ROUTE_BY_REQUEST, type Run } from '../../shared/model/runs.ts';
import { resolvePin } from '../routing/pins.ts';

const NS = 'next_route';
const MODEL_NS = 'next_model';
const TASK_NS = 'next_route_task';

/** RouteRequest.previous as returnChoice gives it. */
export type Previous = NonNullable<RouteRequest['previous']>;
type Need = NonNullable<Previous['need']>['kind'];

/** `need` + `from` (E4.2): a kind of model relative to the one the agent ran on; `modelId` is then the model model.set named.
 *  `temperature` (B-078): the sampling temperature 0..2, kept like the effort; engines that take one send it.
 *  `by` (B-083): 'subconscious' – my subconscious set this turn's effort (its why is `reason`); absent – my own model.set or my task's giver.
 *  `now`: my own model.set with now – the model runs my next turn, inside my live session too. */
export interface NextRoute { modelId?: string; effort?: Effort; reason?: string; at: number; need?: Need; from?: string; temperature?: number; by?: 'subconscious'; now?: true }

function taskKey(agentId: string, taskId: string): string {
  return `${agentId}:${taskId}`;
}

const put = (db: Db, ns: string, k: string, value: object, at: number): void => new KvRepo(db).set(ns, k, value, at);
const read = (db: Db, ns: string, k: string): NextRoute | undefined => new KvRepo(db).get<NextRoute>(ns, k);
const drop = (db: Db, ns: string, k: string): void => { new KvRepo(db).delete(ns, k); };

/** `value` without its undefined fields. */
function set<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

/** The effort and temperature of a request – what one turn, or a task's turns, take from it. */
const stepOf = (value: NextRoute) => set({ effort: value.effort, temperature: value.temperature, reason: value.reason, by: value.by, at: value.at });
/** The model of a request – what waits for my next boundary. */
const modelOf = (value: NextRoute) => set({ modelId: value.modelId, need: value.need, from: value.from, reason: value.reason, now: value.now, at: value.at });

/**
 * My request for what comes next, wherever I am woken: its effort and temperature are my next turn's step (replacing the
 * one stored), its model or kind of model is the model I asked for (replacing an earlier one).
 */
export function setNextRoute(db: Db, agentId: string, value: NextRoute): void {
  if (value.effort !== undefined || value.temperature !== undefined) put(db, NS, agentId, stepOf(value), value.at);
  if (value.modelId !== undefined || value.need !== undefined) put(db, MODEL_NS, agentId, modelOf(value), value.at);
}

/** The effort and temperature of every turn of the agent on `taskId`, in any chat, until the task is done (replaces an earlier one). */
export function setTaskRoute(db: Db, agentId: string, taskId: string, value: NextRoute): void {
  if (value.effort !== undefined || value.temperature !== undefined) put(db, TASK_NS, taskKey(agentId, taskId), stepOf(value), value.at);
}

/**
 * Deletes my next turn's step and returns it (it is that one turn's: agents/turn.ts takes it as the engine starts). B-080:
 * with `at` – the step that turn read (PendingRoute.stepAt) – only while it is still the stored one: one written since
 * stays for the next turn. Without `at` – my running turn took the request inside it (tookInTurn) – whatever is
 * stored, the model I asked for with it.
 */
export function takeNextRoute(db: Db, agentId: string, at?: number): NextRoute | undefined {
  const step = read(db, NS, agentId);
  const taken = step && (at === undefined || step.at === at) ? step : undefined;
  if (taken) drop(db, NS, agentId);
  if (at !== undefined) return taken;
  const model = read(db, MODEL_NS, agentId);
  if (model) drop(db, MODEL_NS, agentId);
  return taken || model ? { ...model, ...taken, at: (taken ?? model)!.at } : undefined;
}

/**
 * My running turn runs on the model I asked for with now (the engine ran a request on it – agents/turn-attempt.ts, FIXES-3
 * C1): my request ends, except its temperature, which my next turn takes (a running turn keeps the one it started with).
 * A turn that ends before a request ran on it leaves the request for my next turn.
 */
export function tookInTurn(db: Db, agentId: string, at: number): void {
  const taken = takeNextRoute(db, agentId);
  if (taken?.temperature !== undefined) setNextRoute(db, agentId, { temperature: taken.temperature, ...(taken.by ? { by: taken.by } : {}), ...(taken.reason ? { reason: taken.reason } : {}), at });
}

/** The model I asked for has had its turn – the one that read it at `at` (PendingRoute.modelAt) started at a boundary, or ran it at once: it is used up while it is still the stored one. */
export function takeNextModel(db: Db, agentId: string, at: number): void {
  if (read(db, MODEL_NS, agentId)?.at === at) drop(db, MODEL_NS, agentId);
}

/** I leave the model to my kind of work again (model.set with auto): the model I asked for is gone. */
export function clearNextModel(db: Db, agentId: string): void {
  drop(db, MODEL_NS, agentId);
}

/**
 * FIXES-3b F3: my start model changed (org/service.ts, every edit of my model policy). The newest choice holds: a start
 * model other than the one I asked for – the person's, my lead's – ends my older request; model.set writes the model it
 * asks for as my start model too, so my own request stays.
 */
export function startModelSet(db: Db, agentId: string, pin: string | undefined): void {
  const asked = read(db, MODEL_NS, agentId);
  if (asked && asked.modelId !== pin) drop(db, MODEL_NS, agentId);
}

/**
 * The request in force for a turn; `stepAt` (B-080): the `at` of the step in it, the one takeNextRoute ends; `modelAt`: the
 * `at` of the model I asked for in it, the one takeNextModel ends; `by`: whose its effort is when it is not my own.
 */
export type PendingRoute = Omit<NextRoute, 'by'> & { stepAt?: number; modelAt?: number; by?: 'subconscious' | 'task' };

/**
 * The request in force for a turn (read, left in place): the model I asked for, the effort and temperature of my step
 * over my task's, field by field; the agent's task requests of finished tasks (`finished`) are dropped first.
 */
export function pendingRoute(db: Db, agentId: string, taskId: string | undefined, finished: (taskId: string) => boolean): PendingRoute | undefined {
  const prefix = `${agentId}:`;
  for (const row of new KvRepo(db).list(TASK_NS, prefix)) if (finished(row.key.slice(prefix.length))) drop(db, TASK_NS, row.key);
  const step = read(db, NS, agentId);
  const model = read(db, MODEL_NS, agentId);
  const scoped = taskId ? read(db, TASK_NS, taskKey(agentId, taskId)) : undefined;
  const mine = step?.effort !== undefined;
  const effort = mine ? step!.effort : scoped?.effort;
  const temperature = step?.temperature ?? scoped?.temperature;
  if (!step && !model && effort === undefined && temperature === undefined) return undefined; // a task row from before this version that names only a model
  const by = effort === undefined ? undefined : mine ? step!.by : 'task' as const;
  return set({
    modelId: model?.modelId, need: model?.need, from: model?.from, now: model?.now, effort, temperature, by,
    reason: by === 'task' ? scoped!.reason : by === 'subconscious' ? step!.reason : undefined,
    at: (step ?? model ?? scoped)!.at, stepAt: step?.at, modelAt: model?.at,
  });
}

/** The catalog entry a name points to (D5, the one lookup – also for splits/validate.ts), or undefined. */
export function findModel(catalog: Pick<ModelCatalog, 'get' | 'list'>, name: string): ModelInfo | undefined {
  return catalog.get(name) ?? resolvePin(catalog.list(), name);
}

/**
 * A model a request names (model.set, a split's part, agents.create): its catalog entry through the one lookup (D5,
 * routing/pins.ts modelMatches: id, older id, provider model id or name in plain form) – else what I read instead (first
 * person, the fact and what helps). The effort is the router's to clamp (D4, routing/router.ts).
 */
export function catalogModel(catalog: Pick<ModelCatalog, 'get' | 'list'>, model: string): ModelInfo | string {
  const info = findModel(catalog, model);
  if (!info) return `Unknown model "${model}". Known: ${catalog.list().filter((item) => item.available).slice(0, 12).map((item) => item.id).join(', ') || 'none'}.`;
  if (!info.available) return `${info.name} has no usable account right now.`;
  return info;
}

/** D5: cheap / strong where I name a model (model.set) – a need relative to the model I run on (routing/need.ts). */
export function modelWord(named: string): 'cheaper' | 'stronger' | undefined {
  const word = named.trim().toLowerCase();
  return word === 'cheap' ? 'cheaper' : word === 'strong' ? 'stronger' : undefined;
}

/** A done run of my own lane (B-057: never a split's – its model is its part's). */
const doneRun = (run: Run) => !run.splitId && Boolean(run.model) && run.status === 'done';

/** The model I am on, from my runs alone – my newest done run's (a split's aside), whatever shaped its route. */
export function onModel(runs: readonly Run[]): string | undefined {
  return runs.find(doneRun)?.model;
}

/** A run whose effort nobody asked for (B-089 route.effortBy; an older run: its route was not a request's). */
const ownEffort = (run: Run) => (run.route?.effortBy ? run.route.effortBy !== 'request' : run.route?.by !== ROUTE_BY_REQUEST);

/** A run on a model that stands in for one that could not run (routing/router.ts standIn). */
const standsIn = (run: Run) => run.route?.standIn === true;

/**
 * RouteRequest.previous of a turn. `runs` = the agent's runs, newest first; `place.on` = the model my session is on
 * (agents/boundary.ts), else my newest done run's. Its effort is my settled one there – the effort of my newest done run on
 * that model that nobody asked for (an effort set for one message – a colleague's receipt at low – never carries over to the
 * next wake), with that run's category; none such: no effort, the router's default applies. A request without a model and
 * without a model to be on keeps modelId '' (its effort still applies).
 */
export function returnChoice(runs: readonly Run[], requested: PendingRoute | undefined, place: { on?: string } = {}): Previous | undefined {
  const on = place.on ?? onModel(runs);
  const last = on ? runs.find((run) => doneRun(run) && run.model === on && ownEffort(run)) : undefined;
  const settled: Pick<Previous, 'effort' | 'category'> = last?.effort ? { effort: last.effort, ...(last.route?.category ? { category: last.route.category } : {}) } : {};
  // The model I am on stands in for one that could not run: my newest turn there says so, and my kind decides again at my
  // next boundary (routing/router.ts).
  const there = on ? runs.find((run) => doneRun(run) && run.model === on) : undefined;
  const standIn: Pick<Previous, 'standIn'> = there && standsIn(there) ? { standIn: true } : {};
  const whose = requested?.by && requested.effort ? { by: requested.by, ...(requested.reason ? { why: requested.reason } : {}) } : {};
  if (requested?.modelId || requested?.need) {
    // E4.2: the router resolves a need relative to `need.from`; modelId = the model model.set named (else the one I am on).
    const need = requested.need ? { need: { kind: requested.need, ...(requested.from ? { from: requested.from } : {}) } } : {};
    const model = { modelId: requested.modelId ?? on ?? '', explicit: true as const, ...need, ...(on ? { from: on } : {}), ...(requested.now ? { now: true as const } : {}), ...standIn };
    return requested.effort ? { ...model, effort: requested.effort, ...whose } : { ...model, asked: 'model', ...settled };
  }
  if (requested?.effort) return { modelId: on ?? '', effort: requested.effort, explicit: true, asked: 'effort', ...(settled.category ? { category: settled.category } : {}), ...whose, ...standIn };
  return on ? { modelId: on, ...settled, ...standIn } : undefined;
}
