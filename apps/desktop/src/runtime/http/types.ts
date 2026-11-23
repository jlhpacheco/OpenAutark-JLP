// Shapes the HTTP server needs from other packages (RPC server, MCP hub, PWA access, pairing,
// device mesh). They are narrow interfaces so the server is tested with
// fakes and never depends on another package's class.
// Owns: these interface shapes and the per-request facts handed to route modules.
// Never: implementations or business logic.

import type { ClientScope, RpcResponse } from '../../shared/api/protocol.ts';
import type { Logger, RuntimeServices } from '../contracts.ts';
import type { SocketLike } from '../devices/channel.ts';
import type { RpcConnection } from '../rpc/connection.ts';
import type { PwaApi } from '../rpc/extras.ts';

export type { RpcConnection };

/** What the HTTP server needs from the RPC server (implemented by rpc/server.ts). */
export interface RpcAttach {
  /** Serves one authenticated connection; returns a detach function. */
  attach(connection: RpcConnection, scope: ClientScope): () => void;
  /** The unauthenticated `POST /rpc` path (only `pwa.exchange` is allowed there). */
  handleHttp(frame: unknown): Promise<RpcResponse>;
}

export interface McpReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** The MCP hub's HTTP entry (Streamable HTTP, JSON response mode). */
export interface McpHttp {
  handle(token: string | undefined, body: unknown, headers?: Record<string, string | undefined>): Promise<McpReply>;
}

/** Pairing of linked PCs over plain HTTP (the proofs are inside the bodies). */
export interface PairingHttp {
  wellKnown(): unknown;
  handle(body: unknown, remote: { address?: string }): Promise<unknown>;
}

/** Server side of the encrypted peer channel (`GET /peer` upgrade); undefined: the link was not kept (B-087: a race's other link stays). */
export interface MeshAccept {
  accept(socket: SocketLike): Promise<string | undefined>;
}

export interface HttpServerDeps {
  services: () => RuntimeServices;
  rpc: RpcAttach;
  mcp: McpHttp;
  pwa: PwaApi;
  pairing: PairingHttp;
  mesh: MeshAccept;
  /** Built UI (app/ui): index.html, main.js, sw.js, chunks/, icons/, sandbox/wf.js. */
  staticDir: string;
  /** Owner token of this runtime (runtime.json: `wf`, scripts, another company's main). Accepted from loopback only; never the person. */
  launchToken: string;
  /**
   * FX1 19.11.2026: the person token – owner scope marked `person`, from loopback only. It lives in memory: the headless
   * CLI prints it on stdout to whoever started it, a test profile hands it in; never written to a file.
   */
  personToken?: string;
  /** Where to listen; read again on settings changes (bind host follows settings.pwa.bind). */
  bind: () => { host: string; port: number };
  log?: Logger;
  /** Extra Host names to accept (e.g. a MagicDNS name the integrator knows). */
  allowedHosts?: () => string[];
  /** Time a new `/ws` client has to send its Hello (default 10 s; tests use less). */
  helloTimeoutMs?: number;
}

/** Facts about one request, computed once by the server and passed to route modules. */
export interface RequestInfo {
  url: URL;
  /** Remote IP without the IPv4-mapped prefix ('' when unknown). */
  remote: string;
  loopback: boolean;
}

/** Maps a presented token to a scope (owner from loopback with the launch token, else device). */
export type Authenticate = (token: string | undefined, loopback: boolean) => ClientScope | undefined;
