// The one newline-delimited JSON-RPC client over a child's stdio: the Codex app-server's (codex/rpc.ts RpcClient) and an
// ACP agent's (acp/protocol.ts AcpConnection). They differ only in their wire (LineRpcWire): the error each end of a
// request becomes, the JSON-RPC 2.0 tag and the longest line.
// Owns: request/response matching, notification fan-out, peer→client requests (answered by `handler`; without one -32601),
// timeouts (0 = none: the request waits until answered or closed) and connection failure.
// Never: knows threads, sessions or turns, or logs message bodies.

import type { ChildLike } from '../system/supervisor.ts';
import { isRecord, readJsonLines } from './shared.ts';

export interface RpcNote { method: string; params: Record<string, unknown> }
export type PeerRequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export interface LineRpcWire {
  /** JSON-RPC 2.0 (ACP): every message carries `jsonrpc: '2.0'` and an empty answer goes as null. */
  jsonrpc2: boolean;
  lineMax?: number;
  /** The connection ended (`reason`: exit, stdin, spawn …). */
  closed(reason?: string): Error;
  /** No answer to `method` in time. */
  timeout(method: string): Error;
  /** The peer answered with this error object. */
  remote(error: Record<string, unknown>): Error;
  /** A handler's error that is the wire's own carries its code back to the peer; any other answers -32603. */
  codeOf(error: unknown): number | undefined;
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> };

export class LineRpc {
  private readonly child: ChildLike;
  private readonly wire: LineRpcWire;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(note: RpcNote) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private sequence = 0;
  private closed: Error | undefined;
  handler: PeerRequestHandler | undefined;

  constructor(child: ChildLike, wire: LineRpcWire) {
    this.child = child;
    this.wire = wire;
    if (!child.stdout || !child.stdin) throw wire.closed('no piped stdio');
    const fail = (reason: string) => this.close(wire.closed(reason));
    readJsonLines(child.stdout, (message) => this.receive(message), fail, wire.lineMax);
    child.stdin.on('error', () => fail('stdin'));
    child.once('exit', () => fail('exit'));
    child.once('error', () => fail('spawn'));
  }

  get isClosed(): boolean { return this.closed !== undefined; }

  onNotification(listener: (note: RpcNote) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: (error: Error) => void): () => void {
    if (this.closed) { listener(this.closed); return () => {}; }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** `timeoutMs` 0 = no timer: it waits until answered or closed (a turn's own wait ends it, or an ACP prompt waits for approvals). */
  request<T = unknown>(method: string, params: unknown = {}, timeoutMs = 20_000): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { resolve: resolve as (value: unknown) => void, reject };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => { this.pending.delete(id); reject(this.wire.timeout(method)); }, timeoutMs);
        entry.timer.unref?.();
      }
      this.pending.set(id, entry);
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(entry.timer); this.pending.delete(id); reject(error as Error); }
    });
  }

  /** Throws when the connection is gone. */
  notify(method: string, params: unknown = {}): void {
    this.write({ method, params });
  }

  close(error: Error = this.wire.closed()): void {
    if (this.closed) return;
    this.closed = error;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    for (const listener of this.closeListeners) { try { listener(error); } catch { /* isolate */ } }
    this.closeListeners.clear();
  }

  private write(message: Record<string, unknown>): void {
    if (this.closed) throw this.closed;
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed) throw this.wire.closed('stdin unavailable');
    stdin.write(`${JSON.stringify(this.wire.jsonrpc2 ? { jsonrpc: '2.0', ...message } : message)}\n`);
  }

  private receive(message: unknown): void {
    if (!isRecord(message)) return;
    const id = message.id;
    const method = typeof message.method === 'string' && message.method ? message.method : undefined;
    const params = isRecord(message.params) ? message.params : {};
    if (method && id !== undefined && id !== null) { void this.answer(id, method, params); return; }
    if (method) {
      for (const listener of this.listeners) { try { listener({ method, params }); } catch { /* isolate */ } }
      return;
    }
    if (typeof id !== 'number') return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (isRecord(message.error)) entry.reject(this.wire.remote(message.error));
    else entry.resolve(message.result);
  }

  private async answer(id: unknown, method: string, params: Record<string, unknown>): Promise<void> {
    let reply: Record<string, unknown>;
    if (!this.handler) reply = { id, error: { code: -32601, message: 'This action is not available.' } };
    else {
      try {
        const result = await this.handler(method, params);
        reply = { id, result: this.wire.jsonrpc2 ? result ?? null : result };
      } catch (error) {
        const code = this.wire.codeOf(error);
        reply = { id, error: code === undefined ? { code: -32603, message: 'The request failed.' } : { code, message: (error as Error).message } };
      }
    }
    try { this.write(reply); } catch { /* connection gone */ }
  }
}
