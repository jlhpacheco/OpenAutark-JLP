// Who may make an RPC call that changes something (Sicher-Runde 19.11.2026, FX1). The person is an owner session marked
// `person` – the desktop window, main's link, the in-memory person token (protocol.ts) – and the person's paired phone (a
// device scope; its tier still applies, rpc/table.ts). Everything else with the owner's scope is NOT the person: an
// agent's own `wf` (its id, http/ws.ts) and whatever read <data>/runtime.json (no id: a shell, a script, another
// company's runtime). For those:
// - the security setup (security.saveTopic, security.answer, settings.update with `security`) and the links that make a
//   new device or person token (pwa.link, phone.pairLink, people.invite – such a token is a person session, REVIEW-2 5) are
//   refused in every mode, the rest of rpc-map.ts PERSON_ONLY (exports, restore, linked PCs) in Secure mode – Trust AI
//   stays the open system;
// - an approval request's to-do (client id apr:…, tasks/approval-todo.ts) is not finished, changed or removed through
//   the tasks/todos methods – it ends with the person's answer (REVIEW-2 11);
// - every other method that changes something passes the switch a tool call of its kind passes (rpc-map.ts): an agent's
//   `wf` through the same gate (open, or the approval request and its wait, or closed); a session without an agent's
//   name has nobody to ask for, so only what is open passes. In Trust AI mode the gate opens all but its three switches.
// rpc/table.ts wraps every method's handler with checkCall. answerAs() is the one rule for an answer to a security request
// (security.answer and the request's to-do, tasks/human.ts): 'setting'/'place' only with the 'settings' tier, else 'once'.
// Owns: the person test, the refusals' words and answerAs. Never: the method table (rpc-map.ts) or a decision (policy.ts).

import type { ClientScope } from '../../shared/api/protocol.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { SECURITY_LABELS, type ApprovalAnswer } from '../../shared/model/security-settings.ts';
import { securityOf } from '../../shared/model/system.ts';
import type { HandlerContext } from '../rpc/table.ts';
import type { SecurityActor } from '../../shared/model/security-log.ts';
import { fingerprintOf } from './policy.ts';
import { methodNeed } from './rpc-map.ts';
import { approvalIdOf } from '../tasks/approval-todo.ts';

/** The person's own methods in every mode; the rest of rpc-map.ts PERSON_ONLY only in Secure mode. */
const ALWAYS_PERSON: ReadonlySet<string> = new Set(['security.saveTopic', 'security.answer', 'pwa.link', 'phone.pairLink', 'people.invite']);
/** The tasks/todos methods that only read a to-do (an approval to-do stays readable). */
const TODO_READS: ReadonlySet<string> = new Set(['tasks.get', 'tasks.list', 'todos.list']);

/** The company's mode; undefined when it can't be read (then the stricter rule holds). */
function modeOf(security: { current?(): { mode: string } } | undefined): string | undefined {
  try { return security?.current?.().mode; } catch { return undefined; }
}

/** True for the person's own sessions: an owner session marked `person` (never with an agent's id) and their phone. */
export function isPersonScope(scope: ClientScope): boolean {
  if (scope.kind === 'owner') return scope.person === true && scope.agentId === undefined;
  return scope.kind === 'device';
}

/** An owner session that is not the person (an agent's wf, a runtime.json token) – the only sessions this guard looks at. */
const notPerson = (scope: ClientScope): boolean => scope.kind === 'owner' && !isPersonScope(scope);

/** A Trust agreement's actor must come from the bound local owner session, never the request body. */
export function requireTrustAgreementActor(ctx: Pick<HandlerContext, 'scope' | 'services'>): SecurityActor {
  const scope = ctx.scope;
  if (!scope || scope.kind !== 'owner' || scope.person || scope.main || !scope.agentId
      || !ctx.services.security || securityOf(ctx.services.settings.get()).mode !== 'trust') {
    throw new WorkforceError('forbidden', 'A named local agent session changes agreements only in Trust AI mode.');
  }
  const agent = ctx.services.org.get(scope.agentId);
  if (!agent || agent.archivedAt !== undefined) throw new WorkforceError('forbidden', 'The local agent is archived or no longer known.');
  return { kind: 'agent', id: scope.agentId, name: agent.name };
}

/** Throws (forbidden, my own words) when this session may not make the call now; waits like a tool call when the gate asks. */
export async function checkCall(method: string, params: unknown, ctx: Pick<HandlerContext, 'scope' | 'services' | 'signal'>): Promise<void> {
  // Refuse in Secure before the generic gate can create an approval request.
  if (method === 'security.saveTrustAgreement') requireTrustAgreementActor(ctx);
  if (!ctx.scope || ctx.scope.kind !== 'owner' || !notPerson(ctx.scope)) return; // no scope: the runtime itself (an internal call)
  const agentId = ctx.scope.agentId;
  const p = params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {};
  if (method === 'companies.tool') return companyTool(ctx);
  if (approvalTodo(method, p, ctx)) throw new WorkforceError('forbidden', `This to-do is ${personName(ctx)}'s answer to a security request; it ends when they answer it – on their Tasks page or in Settings › Security –, and their answer reaches me as a wake.`);
  const need = methodNeed(method, p, agentId);
  if (need.kind === 'open') return;
  const name = personName(ctx);
  const security = (ctx.services as Partial<Pick<HandlerContext['services'], 'security'>> | undefined)?.security;
  // Trust AI mode stays the open system (owner 19.11.2026): only the security setup itself, the answers to its requests and
  // the links that mint a person's session are the person's there; exports, restore and linked PCs are theirs in Secure mode.
  if (need.kind === 'person' && (ALWAYS_PERSON.has(method) || method === 'settings.update' || modeOf(security) !== 'trust')) throw new WorkforceError('forbidden', personOnlyText(method, name));
  if (need.kind === 'person') return;
  if (!security) return; // a runtime without the security service (narrow test rigs): nothing to gate by
  const summary = method === 'settings.update' ? `Change settings: ${Object.keys(p).join(', ') || 'none'}` : `wf ${method}${need.path ? ` ${need.path}` : ''}`;
  const fingerprint = fingerprintOf(method, params);
  if (!agentId) {
    const verdict = security.check({ agentId: '', capability: need.capability, ...(need.path ? { path: need.path } : {}), fingerprint });
    if (verdict !== 'open') throw new WorkforceError('forbidden', `${SECURITY_LABELS[need.capability]} is closed on this PC for a call that names no agent (a wf without its agent, a script with the token from runtime.json): there is nobody the app could ask ${name} for. An agent's own wf asks ${name}; ${name} does it in Autark.`);
    return;
  }
  const result = await security.gate({ agentId, capability: need.capability, summary, ...(need.path ? { path: need.path } : {}), fingerprint, signal: ctx.signal });
  if (!result.ok) throw new WorkforceError('forbidden', result.text);
}

/**
 * companies.tool is how another company's runtime on this PC runs one of ITS agents' tool calls here (tools/registry.ts,
 * with this company's runtime.json token – no agent name, so it cannot be told apart from a shell). Refused for an agent's
 * own wf (named): its own tools it calls directly. What passes is gated inside with the caller's agent and this company's
 * settings (tools/builtin/companies.ts). The declared agent is not checked against this company's agents: a company made
 * from another's export has the same agent ids, and its calls are real ones.
 */
function companyTool(ctx: Pick<HandlerContext, 'scope'>): void {
  if (ctx.scope.kind === 'owner' && ctx.scope.agentId) throw new WorkforceError('forbidden', "companies.tool carries another company's tool calls into this one; my own tools I call directly, where the app checks them for me.");
}

/** True when a tasks/todos call that changes something names an approval request's to-do. */
function approvalTodo(method: string, p: Record<string, unknown>, ctx: Pick<HandlerContext, 'services'>): boolean {
  if (!/^(tasks|todos)./.test(method) || TODO_READS.has(method) || typeof p.id !== 'string') return false;
  try { return approvalIdOf(ctx.services.db, p.id) !== undefined; } catch { return false; }
}

/** The refusal of one of the person's own methods, in the calling agent's voice. */
export function personOnlyText(method: string, name: string): string {
  if (method === 'security.answer') return `Answering a security request is ${name}'s own step; their answer reaches me as a wake.`;
  if (method === 'security.saveTopic') return `${name} saves the security texts in Settings › Security. In Trust AI mode I change an agreement in its file under security/trust/ when ${name} clearly wants that change.`;
  if (method === 'settings.update') return `The security mode and its switches are ${name}'s; they change them in Settings › Security.`;
  if (method === 'pwa.link' || method === 'phone.pairLink' || method === 'people.invite') return `A link for a new phone, browser or person is ${name}'s own step: they add it in Settings › Devices › Add a device. I tell ${name} what it is for, and they make it there.`;
  return `${method} is ${name}'s own step: the app takes it only from ${name} themselves – Autark's window or their phone –, never from a wf or a script. I tell ${name} what it is for, and they do it there.`;
}

/**
 * The answer a session gives a security request: refused for an owner session that is not the person and for an agent
 * or a linked PC's runtime; 'setting'/'place' (they open a switch) only with the 'settings' tier – a to-do-only phone or
 * a colleague answers 'once' instead. `scope` undefined: the runtime itself (no RPC caller) – the answer stands.
 */
export function answerAs(scope: ClientScope | undefined, answer: ApprovalAnswer): ApprovalAnswer {
  if (!scope) return answer;
  if (notPerson(scope) || scope.kind === 'agent' || scope.kind === 'external') throw new WorkforceError('forbidden', 'A security request is answered by the person themselves.');
  if (answer !== 'setting' && answer !== 'place') return answer;
  const settings = scope.kind === 'owner' || (scope.kind === 'device' && scope.capabilities.includes('settings'));
  return settings ? answer : 'once';
}

function personName(ctx: Pick<HandlerContext, 'services'>): string {
  try { return ctx.services.settings.get().profile.name?.trim() || 'the person'; } catch { return 'the person'; }
}
