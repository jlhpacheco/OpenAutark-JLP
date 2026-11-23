// The switch `security.otherPcs` on the receiving PC (Umzug 21.11.2026, PCSEC – each PC keeps its own security): before
// a call from an agent on another of the person's PCs runs here – a forwarded tool (tools.ts runRemoteTool) or a file it
// sends (receive-file.ts) – 'yes' lets it on to this PC's normal gate, 'ask' asks the person through the security gate
// (category otherPcs: once, always, decline – security/service.ts), 'no' refuses with where it changes. A call that names
// no agent (a PC on a version before this one sending a file) cannot be asked for, so 'ask' refuses it too. An agent
// that runs on this PC itself (it fetched a file from another PC) is no agent on another PC.
// Owns: that check and its refusal text. Never: decides the call's other switches (security/tool-gate.ts gateForwarded).

import type { RuntimeServices } from '../contracts.ts';
import { otherPcsOf, type OtherPcs } from '../../shared/model/security-settings.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import { homeElsewhere } from './sync/home.ts';

export interface OtherPcCall {
  /** The calling agent; absent for a call that names none. */
  agentId?: string;
  agentName?: string;
  /** One line, what the call would do here. */
  summary: string;
  /** The same step tried again is the same request ("once" lets one identical call through). */
  fingerprint: string;
  chatId?: string;
  taskId?: string;
  signal?: AbortSignal;
}

/** What `security.otherPcs` says on this PC; a section that cannot be read asks (the stricter rule with a way through). */
export function otherPcsHere(services: Pick<RuntimeServices, 'security'>): OtherPcs {
  if (!services.security) return 'yes';
  try { return otherPcsOf(services.security.current()); } catch { return 'ask'; }
}

/** This PC's name, as the refusal says it. */
function selfName(services: Pick<RuntimeServices, 'devices'>): string {
  try { return services.devices.self().name || 'This PC'; } catch { return 'This PC'; }
}

/** The calling agent runs on this PC (known here and not homed on another CEO PC). */
function runsHere(services: RuntimeServices, agentId: string): boolean {
  try { return Boolean(services.org.get(agentId)) && !homeElsewhere(services, agentId); } catch { return false; }
}

/** The refusal of 'no', in the words the calling agent reads. */
export function refusedText(services: Pick<RuntimeServices, 'devices'>): string {
  return `${selfName(services)} takes no calls from agents on other PCs (Settings › Security there).`;
}

/** Passes a call from another PC through `otherPcs`; throws 'forbidden' with the text for the calling agent. */
export async function gateOtherPcs(services: RuntimeServices, call: OtherPcCall, fromPc: string): Promise<void> {
  const value = otherPcsHere(services);
  const agentId = call.agentId === HUMAN_ID || call.agentId === SYSTEM_ID ? undefined : call.agentId; // a forwarded call is an agent's
  if (value === 'yes' || (agentId && runsHere(services, agentId))) return;
  if (value === 'no' || !agentId) throw new WorkforceError('forbidden', refusedText(services));
  const result = await services.security.gate({
    agentId, capability: 'otherPcs', summary: `From ${fromPc}: ${call.summary}`, fingerprint: call.fingerprint,
    ...(call.agentName ? { agentName: call.agentName } : {}), ...(call.chatId ? { chatId: call.chatId } : {}), ...(call.taskId ? { taskId: call.taskId } : {}),
    ...(call.signal ? { signal: call.signal } : {}),
  });
  if (!result.ok) throw new WorkforceError('forbidden', result.text);
}
