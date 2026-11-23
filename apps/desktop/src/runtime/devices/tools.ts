// Device tools for agents (computer.*, browser.*, phone.*, devices.list, devices.send_file, and devices.connect where
// connecting PCs is wired) and the peer handlers that let a linked PC run them here: 'tools.call' (remote tool execution – the tool registry forwards a
// call whose `device` or the agent's home device names another PC), 'files.put' (a sent file or folder: receive-file.ts)
// 'security.answer' (Umzug 21.11.2026: an approval request answered on another of my PCs, security/answer-relay.ts)
// and 'computer.preview' (the live screen image). A call from a linked PC runs like a call of this PC's own agent (one log line),
// after this PC's security gate for that agent (Sicher-Runde 19.11.2026: security/tool-gate.ts gateForwarded) – and
// before it, this PC's `security.otherPcs` (Umzug 21.11.2026: yes / ask / no, other-pcs.ts);
// computer.* tools show in the activity pill and end at the person's Stop (computer/activity.ts). localCaps: what this PC
// offers, with the app version it runs (F25).
// Owns: the device tool list and the executor side of a remote call. Never: executes a tool that is
// not marked remote, forwards a received call to a third PC, or sends values of this PC's secrets back.

import type { RuntimeServices } from '../contracts.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../tools/types.ts';
import { DEVICE_ARG } from '../tools/types.ts';
import { validate } from '../tools/validate.ts';
import { normalizeOutput } from '../tools/registry.ts';
import type { DeviceCaps } from '../../shared/model/devices.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { PeerHandler } from './rpc-peer.ts';
import type { ComputerService } from '../computer/service.ts';
import type { BrowserService } from '../browser/service.ts';
import type { PhoneDriver, PhoneWireless } from '../phone/driver.ts';
import type { PhonesHere } from '../phone/drivers.ts';
import { computerTools } from '../computer/tools.ts';
import { browserTools } from '../browser/tools.ts';
import { phoneTools } from '../phone/tools.ts';
import { detectChannel } from '../browser/channel.ts';
import { bindComputerActivity, type ComputerActivity } from '../computer/activity.ts';
import { devicesConnect, type DeviceLink } from './connect-tool.ts';
import { devicesList } from './list-tool.ts';
import { sendFile } from './send-file.ts';
import { receivePiece } from './receive-file.ts';
import { gateForwarded, needFingerprint } from '../security/tool-gate.ts'; // Sicher-Runde 19.11.2026
import { gateOtherPcs } from './other-pcs.ts';
import { ANSWER_METHOD, serveAnswer } from '../security/answer-relay.ts';
import type { LinkKind } from './mesh.ts';

export interface DeviceToolDeps {
  computer: ComputerService;
  browser: BrowserService;
  /** ADB and the Android app's phone use behind one driver (phone/drivers.ts mergedPhones; PhonesHere for the caps). */
  phone: PhoneDriver & PhoneWireless & Partial<PhonesHere>;
  /** Connecting PCs (remote/service.ts, the meeting server): devices.connect, and devices.list's Remote ID and server state. */
  link?: DeviceLink;
}

export function deviceTools(deps: DeviceToolDeps): ToolDef[] {
  const computer = computerTools(deps.computer).map((tool) => watched(tool, deps.computer.activity));
  // B-080: browser.open where: 'chrome' works in the person's own Chrome through this PC's computer use.
  return [...computer, ...browserTools(deps.browser, deps.computer), ...phoneTools(deps.phone), devicesList(deps.link), sendFile, ...(deps.link ? [devicesConnect(deps.link)] : [])];
}

/** Which linked PC sent a call (set for the ctx a remote call runs with). */
const remoteCaller = new WeakMap<ToolContext, string>();

/** A computer.* tool that shows up in the activity pill and ends at the person's Stop. */
export function watched(tool: ToolDef, activity: ComputerActivity): ToolDef {
  return {
    ...tool,
    run: (args, ctx) => {
      let summary = tool.name;
      try { summary = ctx.services.secrets.redact(tool.describe?.(args, ctx).summary || tool.name); } catch { /* the name says enough */ }
      return activity.run(
        { agent: ctx.agent.name, agentId: ctx.agent.id, fromDevice: remoteCaller.get(ctx), summary, signal: ctx.signal },
        (signal) => tool.run(args, { ...ctx, signal }),
      );
    },
  };
}

/**
 * What this PC can do for agents (updateSelf), its phones among them: the ones attached here right now as the phone
 * driver last saw them (phone/drivers.ts PhonesHere – no adb call of its own), so every PC of mine knows which PC a
 * phone hangs off (phone/linked.ts). Both keys are always sent, so a list of an older run is replaced.
 * F25 (16.11.2026): `version` – the app version this PC runs, so my other PCs see it (Settings › Devices, their update check).
 */
export async function localCaps(deps: DeviceToolDeps & { version?: string }): Promise<DeviceCaps> {
  let browser = false;
  try { detectChannel(); browser = true; } catch { browser = false; }
  const phones = deps.phone.here?.() ?? { app: [], adb: [] };
  return {
    computerUse: deps.computer.canControl(), browser, os: deps.computer.platform,
    adbPhones: phones.adb.length ? phones.adb : undefined, appPhones: phones.app.length ? phones.app : undefined,
    ...(deps.version ? { version: deps.version } : {}),
  };
}

interface RemoteCall { name: string; args: Record<string, unknown>; agentId: string; agentName?: string; runId: string; conversationId?: string; taskId?: string; mode: string }

function parseCall(params: unknown): RemoteCall {
  const p = (params ?? {}) as Record<string, unknown>;
  const str = (key: string, required: boolean): string | undefined => {
    const value = p[key];
    if (value === undefined || value === null) { if (required) throw new WorkforceError('bad_request', `${key} is required.`); return undefined; }
    if (typeof value !== 'string' || value.length > 200) throw new WorkforceError('bad_request', `${key} must be a short string.`);
    return value;
  };
  const raw = p.args === undefined ? {} : p.args;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new WorkforceError('bad_request', 'args must be an object.');
  // The caller's registry already picked this PC: a forwarded call never travels on to another one.
  const args = { ...(raw as Record<string, unknown>) };
  delete args[DEVICE_ARG];
  return {
    name: str('name', true)!, args, agentId: str('agentId', true)!, agentName: str('agentName', false)?.slice(0, 60), runId: str('runId', true)!,
    conversationId: str('conversationId', false), taskId: str('taskId', false), mode: str('mode', false) ?? 'computer',
  };
}

/** Runs a linked PC's call here ('tools.call') like a call of this PC's own agent. */
export async function runRemoteTool(services: RuntimeServices, params: unknown, fromDeviceId: string, signal: AbortSignal): Promise<ToolOutput> {
  const call = parseCall(params);
  const tool = services.tools.get(call.name);
  if (!tool?.remote) throw new WorkforceError('bad_request', `${call.name} does not run on another PC.`);
  const errors = validate(call.args, tool.inputSchema);
  if (errors.length) throw new WorkforceError('bad_request', `Invalid arguments for ${call.name}:\n${errors.join('\n')}`);
  let deviceId: string | undefined;
  try { deviceId = services.devices.self().id; } catch { deviceId = undefined; }
  let from = 'a linked PC';
  try { from = services.devices.list().find((device) => device.id === fromDeviceId)?.name ?? from; } catch { /* unnamed */ }
  const agent = services.org.get(call.agentId) ?? standIn(call.agentId, from, call.agentName);
  const ctx: ToolContext = {
    agent, runId: call.runId, conversationId: call.conversationId, taskId: call.taskId, mode: call.mode, deviceId, services, signal,
    fromPc: from,
    status: () => undefined,
  };
  remoteCaller.set(ctx, from);
  services.log.info('remote tool call', { from: fromDeviceId, tool: call.name, agentId: call.agentId, runId: call.runId });
  let summary = tool.name;
  try { summary = tool.describe?.(call.args, ctx).summary || summary; } catch { /* the name says what it is */ }
  await gateOtherPcs(services, { // Umzug: what calls from agents on my other PCs get here
    agentId: call.agentId, agentName: agent.name, summary, fingerprint: needFingerprint(tool.name, { capability: 'otherPcs' }, call.args),
    chatId: call.conversationId, taskId: call.taskId, signal,
  }, from);
  await gateForwarded(tool, call.args, ctx); // Sicher-Runde: this PC's gate for the calling agent; a refusal travels back
  return redactOutput(services, normalizeOutput(await tool.run(call.args, ctx)));
}

/** The calling PC's agent as this PC's tools see it (it is not in this PC's org). */
function standIn(id: string, from: string, name?: string): ToolContext['agent'] {
  return {
    id, name: name ? `${name} (${from})` : `Agent from ${from}`, role: '', avatar: { kind: 'initials', value: 'AG' }, instructions: '', mode: 'computer',
    skills: [], modelPolicy: {}, status: 'working', createdBy: 'human', createdAt: 0, updatedAt: 0,
  } as unknown as ToolContext['agent'];
}

/** Values of this PC's secrets (typed into a page and visible in a snapshot) never go back in the output. */
function redactOutput(services: RuntimeServices, output: ToolOutput): ToolOutput {
  const redact = (value: string): string => { try { return services.secrets.redact(value); } catch { return value; } };
  const deep = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') return redact(value);
    if (depth > 6 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => deep(item, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deep(item, depth + 1)]));
  };
  return {
    ...output,
    content: output.content.map((part) => (part.type === 'text' ? { ...part, text: redact(part.text) } : part)),
    ...(output.structured === undefined ? {} : { structured: deep(output.structured, 0) }),
  };
}

/** Registers the device peer handlers on the mesh once at startup. */
export function registerDeviceHandlers(mesh: { register(method: string, handler: PeerHandler, kinds?: readonly LinkKind[]): void }, deps: { services: () => RuntimeServices; computer: ComputerService }): void {
  try { bindComputerActivity(deps.services(), deps.computer.activity); } catch { /* bound when ComputerService saw the services */ }
  mesh.register('tools.call', (params, fromDeviceId, signal) => runRemoteTool(deps.services(), params, fromDeviceId, signal));
  mesh.register('files.put', (params, fromDeviceId, signal) => receivePiece(deps.services(), params, fromDeviceId, signal));
  mesh.register(ANSWER_METHOD, (params, fromDeviceId) => serveAnswer(deps.services(), params, fromDeviceId), ['ceo']); // Umzug H2: an approval answered on another of my PCs
  mesh.register('computer.preview', async (params) => {
    const p = (params ?? {}) as { display?: unknown };
    const display = typeof p.display === 'number' && Number.isInteger(p.display) && p.display >= 0 && p.display <= 16 ? p.display : undefined;
    return deps.computer.preview({ display }); // never forwards again (no deviceId)
  });
}
