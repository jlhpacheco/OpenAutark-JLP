// ACP (Agent Client Protocol) wire: newline-delimited JSON-RPC 2.0 over an agent's stdio (the line client: engines/line-rpc.ts).
// Owns: ACP's errors on that client (prompt turns pass timeout 0: they can wait hours for approvals), the initialize request
// (protocol version 1, no fs/terminal client capabilities) and reading the agent's capabilities
// (prompt images and, B-058 G7, audio) and auth methods; classifying errors (auth required, usage limit, gone).
// Never: knows sessions or turns (process.ts / turn.ts do), logs message bodies, or offers the
// agent file or terminal access through us (it uses its own tools; we only approve them).

import type { ChildLike } from '../../system/supervisor.ts';
import { LineRpc } from '../line-rpc.ts';
import { isRecord, str } from '../shared.ts';

export const ACP_PROTOCOL_VERSION = 1;
/** ACP's error code for "authentication required" (RequestError.authRequired). */
export const AUTH_REQUIRED = -32000;
export const METHOD_NOT_FOUND = -32601;

const AUTH_TEXT = /auth(entication|orization)? required|not (signed|logged) in|please (log|sign) ?in|unauthori[sz]ed|invalid credentials|login required/i;
const LIMIT_TEXT = /rate.?limit|quota|usage limit|too many requests|\b429\b|resource.?exhausted/i;

export class AcpRpcError extends Error {
  readonly rpcCode: number;
  /** 'remote' = the agent answered with an error; 'timeout' = no answer in time; 'closed' = connection gone. */
  readonly kind: 'remote' | 'timeout' | 'closed';
  constructor(kind: AcpRpcError['kind'], code: number, message: string) {
    super(message);
    this.name = 'AcpRpcError';
    this.kind = kind;
    this.rpcCode = code;
  }
}

/** The agent says it needs a sign-in (code -32000, or the usual wording on another code). */
/**
 * B-059 #184: a JSON-RPC error's text – its message plus the detail an agent puts in `data` (the ACP SDK turns a thrown
 * error into "Internal error" with the real text, e.g. Gemini's "[API Error: got status: 503 …]", in data.details), at
 * most 300 characters, so sign-in, limit and outage texts are recognized.
 */
export function rpcErrorText(error: Record<string, unknown>): string {
  const base = typeof error.message === 'string' ? error.message : 'The agent reported an error.';
  const data = error.data;
  const detail = typeof data === 'string' ? data
    : isRecord(data) && typeof data.details === 'string' ? data.details
      : isRecord(data) && isRecord(data.error) && typeof data.error.message === 'string' ? data.error.message : '';
  return (detail && detail !== base ? `${base}: ${detail}` : base).slice(0, 300);
}

export function isAuthError(error: unknown): boolean {
  return error instanceof AcpRpcError && error.kind === 'remote' && (error.rpcCode === AUTH_REQUIRED || AUTH_TEXT.test(error.message));
}

/** The agent reports a used-up plan or a rate limit. */
export function isLimitError(error: unknown): boolean {
  return error instanceof AcpRpcError && error.kind === 'remote' && LIMIT_TEXT.test(error.message);
}

/** An ACP agent's connection: the one line client (engines/line-rpc.ts) on ACP's wire – JSON-RPC 2.0, AcpRpcError for every failure. */
export class AcpConnection extends LineRpc {
  constructor(child: ChildLike) {
    super(child, {
      jsonrpc2: true,
      closed: (reason) => new AcpRpcError('closed', -32099, reason ? `ACP connection closed (${reason})` : 'ACP connection closed'),
      timeout: (method) => new AcpRpcError('timeout', -32098, `The agent did not answer ${method}.`),
      remote: (error) => new AcpRpcError('remote', typeof error.code === 'number' ? error.code : -32603, rpcErrorText(error)),
      codeOf: (error) => (error instanceof AcpRpcError ? error.rpcCode : undefined),
    });
  }
}

export interface AuthMethod { id: string; name: string; description?: string }

/** What the agent said about itself in its initialize answer. */
export interface AgentInfo {
  protocolVersion: number;
  loadSession: boolean; // session/load (replays the history as session/update)
  resumeSession: boolean; // session/resume (no replay)
  closeSession: boolean; // session/close
  images: boolean; // image content blocks in prompts
  audio: boolean; // B-058 G7: audio content blocks in prompts (promptCapabilities.audio)
  mcpHttp: boolean; // HTTP MCP servers in session/new
  authMethods: AuthMethod[];
  title?: string;
}

const present = (value: unknown) => value !== undefined && value !== null && value !== false;

export function parseAgentInfo(result: unknown): AgentInfo {
  const r = isRecord(result) ? result : {};
  const caps = isRecord(r.agentCapabilities) ? r.agentCapabilities : {};
  const prompt = isRecord(caps.promptCapabilities) ? caps.promptCapabilities : {};
  const mcp = isRecord(caps.mcpCapabilities) ? caps.mcpCapabilities : {};
  const sessions = isRecord(caps.sessionCapabilities) ? caps.sessionCapabilities : {};
  const agent = isRecord(r.agentInfo) ? r.agentInfo : {};
  const methods = Array.isArray(r.authMethods) ? r.authMethods : [];
  return {
    protocolVersion: typeof r.protocolVersion === 'number' ? r.protocolVersion : ACP_PROTOCOL_VERSION,
    loadSession: caps.loadSession === true,
    resumeSession: present(sessions.resume),
    closeSession: present(sessions.close),
    images: prompt.image === true,
    audio: prompt.audio === true,
    mcpHttp: mcp.http === true,
    authMethods: methods.filter(isRecord).flatMap((m) => {
      const id = str(m.id);
      return id && id.length <= 200 ? [{ id, name: (str(m.name) ?? id).slice(0, 200), description: str(m.description)?.slice(0, 500) }] : [];
    }).slice(0, 20),
    title: (str(agent.title) ?? str(agent.name))?.slice(0, 200),
  };
}

/** Sends initialize; rejects when the agent speaks another protocol version. */
export async function initialize(conn: AcpConnection, version: string): Promise<AgentInfo> {
  const result = await conn.request('initialize', {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'workforce', title: 'Autark', version },
  }, 30_000);
  const info = parseAgentInfo(result);
  if (info.protocolVersion !== ACP_PROTOCOL_VERSION) throw new AcpRpcError('remote', -32600, 'The agent speaks an unsupported ACP version.');
  return info;
}
