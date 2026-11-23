// A PC's load as its ping answers it (chat sweep 16.11.2026, owner 06.11.: "ihr könnt auch gerne das Notebook verwenden …
// das Notebook ist grad nicht so ausgelastet"): free memory in MB and the agent turns at work on it, so devices.list
// (list-tool.ts) shows which linked PC is idle and an agent can move its work there (agents.update device). A snapshot;
// a PC on an older version answers its ping without it. Umzug 21.11.2026 (PCSEC): the same answer carries that PC's
// security mode and its `otherPcs` switch (each PC keeps its own), so devices.list names the rules each PC works under.
// Owns: the load value and reading it from a ping's answer. Never: decides where work goes.

import { freemem } from 'node:os';
import { OTHER_PCS, otherPcsOf, SECURITY_MODES, type OtherPcs, type SecurityMode, type SecuritySettings } from '../../shared/model/security-settings.ts';

export interface DeviceLoad {
  /** Free memory of the PC now, in MB. */
  freeMemoryMb: number;
  /** Agent turns running on it now. */
  runs: number;
  /** Its security mode (absent from a PC before 21.11.2026). */
  security?: SecurityMode;
  /** What calls from agents on its other PCs get there. */
  otherPcs?: OtherPcs;
}

const MB = 1024 * 1024;

/** This PC's load now, with `runs` turns at work, and its security settings when given. */
export function deviceLoad(runs: number, security?: Pick<SecuritySettings, 'mode' | 'otherPcs'>, free = freemem()): DeviceLoad {
  return { freeMemoryMb: Math.round(free / MB), runs, ...(security ? { security: security.mode, otherPcs: otherPcsOf(security) } : {}) };
}

/** The load in a ping's answer; undefined from a PC that does not send one (older versions) or a malformed one. */
export function loadIn(answer: unknown): DeviceLoad | undefined {
  const load = answer && typeof answer === 'object' ? (answer as { load?: unknown }).load : undefined;
  if (!load || typeof load !== 'object') return undefined;
  const { freeMemoryMb, runs, security, otherPcs } = load as Record<string, unknown>;
  const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
  const free = count(freeMemoryMb);
  const busy = count(runs);
  if (free === undefined || busy === undefined) return undefined;
  const mode = SECURITY_MODES.find((one) => one === security);
  const calls = OTHER_PCS.find((one) => one === otherPcs);
  return { freeMemoryMb: free, runs: busy, ...(mode ? { security: mode } : {}), ...(mode && calls ? { otherPcs: calls } : {}) };
}
