// The JSON-RPC client of `codex app-server --listen stdio://`: the one line client (engines/line-rpc.ts) on Codex's wire –
// no JSON-RPC 2.0 tag, lines up to CODEX_LINE_MAX (a generated image comes as one line), RpcError for every failure.
// B-080: a request with timeoutMs 0 has no timer – it waits for Codex's answer (the caller ends its own wait,
// helper-thread.ts orStopped); close() still rejects it.
// Owns: that wire, its error codes and threadGone (a refusal that says the thread is gone). Never: knows thread/turn semantics beyond that reading (server.ts / engine.ts do) or logs message bodies.

import type { ChildLike } from '../../system/supervisor.ts';
import { LineRpc } from '../line-rpc.ts';
import { CODEX_LINE_MAX } from '../shared.ts';

export class RpcError extends Error {
  readonly rpcCode: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.rpcCode = code;
    this.data = data;
  }
}

export const RPC_TIMEOUT = -32000; // RpcClient's code for "codex did not answer" (a timeout, not a refusal)
const RPC_NO_METHOD = -32601; // JSON-RPC "method not found"

/** Wave 2: `thread/delete` refused because the thread itself is gone – not because this Codex lacks the method. */
export function threadGone(error: RpcError): boolean {
  if (error.rpcCode === RPC_TIMEOUT || error.rpcCode === RPC_NO_METHOD) return false;
  if (/method not found|unknown (variant|method|request)|unsupported/i.test(error.message)) return false;
  return /\bthread\b[^\n]{0,80}\b(not found|does not exist|unknown|missing)\b|\b(no such|unknown) thread\b|\bno rollout found\b/i.test(error.message); // B-080: Codex's own answer for a deleted thread
}

export class RpcClient extends LineRpc {
  constructor(child: ChildLike) {
    super(child, {
      jsonrpc2: false, lineMax: CODEX_LINE_MAX,
      closed: (reason) => new Error(reason ? `codex connection closed (${reason})` : 'codex connection closed'),
      timeout: (method) => new RpcError(-32000, `codex did not answer ${method}`), // RPC_TIMEOUT
      remote: (error) => new RpcError(
        typeof error.code === 'number' ? error.code : -32000, typeof error.message === 'string' ? error.message.slice(0, 300) : 'codex error', error.data,
      ),
      codeOf: (error) => (error instanceof RpcError ? error.rpcCode : undefined),
    });
  }
}
