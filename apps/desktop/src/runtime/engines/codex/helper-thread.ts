// The settings a Codex thread opens with. Every thread is lean: Codex's own tools, instruction blocks, skill list, sub-agents
// (`agents.enabled`, which takes their role text and spawn tools away – `features.multi_agent` does not) and its question
// tool (`tools.experimental_request_user_input`) are off, so the model reads only Autark's instructions and tools.
// - A helper thread (decisions, verifier, compaction, widget fills …) is ephemeral, has no environment (`environments: []`:
//   no shell or patch tool) and gets HELPER_NOTE: in code mode Codex still offers `exec`/`wait`, which reach nothing there.
//   KI-Runde 17.11.2026: a turn with `keep` (a call's voice) holds its helper thread open for the call – it stays loaded in
//   the app-server and the turn answers with it, so each spoken line is one input on the thread the call started with.
// - An agent thread keeps the shell with its patch tool, the shell snapshot, view_image (the only way it sees a stored image),
//   image_generation (the plan's own pictures) and Codex's live web search; a new one asks for raw Responses items
//   (code-mode.ts reads its exec calls there) and is stored as 'chatgpt_hidden', so the Codex desktop app does not list it.
//   A plan-image thread has image_generation as its one tool. An agent thread compacts near RUN_CEILING (agentLeanConfig).
// - Opening waits THREAD_OPEN_MS, or for an agent turn until its signal (untilStopped, orStopped); a thread a late
//   thread/start opened leaves the app-server again.
// A Codex that refuses these settings fails the open with its own error – there is no plainer fallback.
// Owns: these settings, the open limit and the open's end at the turn's signal. Never: reads CODEX_HOME files or replaces an
// isolation key (isolation.ts) – the lean config is merged under it.

import type { RpcClient } from './rpc.ts';
import { WORKSPACE_FEATURES } from './isolation.ts';
import { RUN_CEILING } from '../../agents/compaction-policy.ts';

/** How long opening a thread may take (a cold app-server needed ~65 s live). */
export const THREAD_OPEN_MS = 120_000;

/** The source a new agent thread is stored with – the Codex desktop app leaves such threads out of its lists. */
export const HIDDEN_THREAD = { threadSource: 'chatgpt_hidden' } as const;

/** `work`'s outcome, or "The turn was stopped." once `signal` aborts first – `work` itself goes on (its late answer is the caller's). */
export function orStopped<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new Error('The turn was stopped.'));
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

/**
 * `rpc` for opening a turn's thread (engine.ts run): a request also ends when `signal` aborts – a Stop, the stall watch's cut,
 * or a helper call's own shorter time limit. A request after the signal ended is not sent; a thread a late thread/start
 * opened leaves the app-server again (nobody knows its id). `hold` (server.ts beginTurn) keeps the app-server from its idle
 * shutdown while the wait lasts.
 */
export function untilStopped(rpc: Pick<RpcClient, 'request'>, signal: AbortSignal, hold?: () => () => void): Pick<RpcClient, 'request'> {
  return {
    request: <T = unknown>(method: string, params?: unknown, timeoutMs?: number) => {
      if (signal.aborted) return Promise.reject(new Error('The turn was stopped.'));
      const release = hold?.();
      const sent = rpc.request<T>(method, params, timeoutMs);
      return orStopped(sent, signal).catch((error: unknown) => {
        if (method === 'thread/start' && signal.aborted) void sent.then((late) => leaveLate(rpc, late), () => undefined);
        throw error;
      }).finally(() => release?.());
    },
  };
}

/** The thread a thread/start opened after the turn's signal ended the wait leaves the app-server. */
function leaveLate(rpc: Pick<RpcClient, 'request'>, answer: unknown): Promise<unknown> | undefined {
  const id = (answer as { thread?: { id?: unknown } } | undefined)?.thread?.id;
  return typeof id === 'string' && id ? rpc.request('thread/unsubscribe', { threadId: id }).catch(() => undefined) : undefined;
}

/** The app-server requests that open an agent thread (thread/fork: a split's native fork). */
export type AgentThreadMethod = 'thread/start' | 'thread/resume' | 'thread/fork';

/** Codex features a helper thread does not need (per-thread `config.features.<name> = false`). */
export const HELPER_FEATURES_OFF: readonly string[] = [
  'shell_tool', 'unified_exec', 'view_image', 'image_generation', 'apps', 'plugins', 'skill_search', 'tool_suggest',
  'goals', 'sleep_tool', 'hooks', 'memories', 'workspace_dependencies', 'worktrees', 'shell_snapshot', 'mentions_v2', 'remote_plugin', 'realtime_conversation', 'computer_use', 'browser_use',
];

/**
 * The Codex features an agent thread keeps – the shell with its patch tool, the shell snapshot (off with a kept shell, the
 * thread hung), view_image (no tool of ours shows a stored image to the model) and image_generation: the plan's own
 * images, the free portrait route (agent-avatar.ts madeByRun), without a connected image model.
 */
export const AGENT_FEATURES_KEPT: readonly string[] = ['shell_tool', 'unified_exec', 'shell_snapshot', 'view_image', 'image_generation'];

/** An agent thread searches the web with Codex's own live search (the plan's search meets no bot checks); helper and image threads have none. */
export const AGENT_WEB_SEARCH: 'live' | 'disabled' = 'live';

/** Codex features an agent thread does not get – our own tools replace them; isolation.ts's workspace features stay off. */
export const AGENT_FEATURES_OFF: readonly string[] = [
  ...HELPER_FEATURES_OFF.filter((name) => !AGENT_FEATURES_KEPT.includes(name)),
  ...WORKSPACE_FEATURES.filter((name) => !HELPER_FEATURES_OFF.includes(name)),
];

declare module '../types.ts' {
  interface EngineTurnInput {
    /** 'image' – a new Codex thread whose one native tool is image_generation (imageThread; media/codex-image.ts). Other engines ignore it. */
    nativeTools?: 'image';
  }
}

/**
 * thread/start settings of a plan-image turn – the helper features all off except image_generation (on),
 * isolation.ts's workspace features off, no environment; the lean instruction blocks, web search and apps off as
 * for every lean thread. Merged over `settings.config`, whose isolation keys it never replaces.
 */
export function imageThread<T extends { config?: Record<string, unknown> }>(settings: T): T & { config: Record<string, unknown>; environments: [] } {
  const off = [...HELPER_FEATURES_OFF, ...WORKSPACE_FEATURES].filter((name) => name !== 'image_generation');
  const lean = leanConfig(off);
  return {
    ...settings,
    config: { ...(settings.config ?? {}), ...lean, features: { ...(lean.features as Record<string, boolean>), image_generation: true } },
    environments: [],
  };
}

/** What a helper thread knows about the functions Codex still offers it (its answer is its reply), naming no engine's tools. */
export const HELPER_NOTE = 'The functions offered in this thread reach nothing, and no tool my instructions name is behind them. My answer is my reply, not a function call.';

/** Config keys merged into a helper thread's `config` (on top of isolation.ts's overrides). */
export function helperConfig(): Record<string, unknown> {
  return leanConfig(HELPER_FEATURES_OFF);
}

/**
 * Config keys of a lean agent thread (merged under isolation.ts's overrides), Codex's own live web search on, and (Runde "Halb"
 * 21.11.2026) its own compaction near the run ceiling instead of the window's edge (`model_auto_compact_token_limit`, a key of
 * codex-cli 0.167's config; agents/compaction-policy.ts RUN_CEILING).
 */
export function agentLeanConfig(): Record<string, unknown> {
  return { ...leanConfig(AGENT_FEATURES_OFF, AGENT_WEB_SEARCH), model_auto_compact_token_limit: RUN_CEILING };
}

function leanConfig(off: readonly string[], webSearch: 'disabled' | 'live' = 'disabled'): Record<string, unknown> {
  return {
    features: Object.fromEntries(off.map((name) => [name, false])),
    include_permissions_instructions: false,
    include_apps_instructions: false,
    include_collaboration_mode_instructions: false,
    include_environment_context: false,
    web_search: webSearch,
    apps: { _default: { enabled: false } },
    skills: { include_instructions: false, bundled: { enabled: false } },
    agents: { enabled: false },
    tools: { experimental_request_user_input: { enabled: false } },
  };
}

/** thread/start settings of a helper turn: `settings` (model, cwd, instructions, isolation) made lean and ephemeral. */
export function helperThread<T extends { config?: Record<string, unknown>; developerInstructions?: string }>(settings: T): Omit<T, 'developerInstructions'> & {
  config: Record<string, unknown>; environments: []; ephemeral: true; developerInstructions: string;
} {
  const { developerInstructions, ...rest } = settings;
  return {
    ...rest,
    developerInstructions: developerInstructions?.trim() ? `${developerInstructions}\n\n${HELPER_NOTE}` : HELPER_NOTE,
    config: { ...(settings.config ?? {}), ...helperConfig() },
    environments: [],
    ephemeral: true,
  };
}

/** thread/start of a helper thread (helperThread). */
export function startHelperThread<T extends { config?: Record<string, unknown>; developerInstructions?: string }>(
  rpc: Pick<RpcClient, 'request'>, settings: T,
): Promise<{ thread?: { id?: string } }> {
  return rpc.request<{ thread?: { id?: string } }>('thread/start', helperThread(settings), THREAD_OPEN_MS);
}

/** thread/start, thread/resume or thread/fork settings of an agent thread made lean; every other setting (isolation included) as given. */
export function agentThread<T extends { config?: Record<string, unknown> }>(settings: T): T & { config: Record<string, unknown> } {
  return { ...settings, config: { ...agentLeanConfig(), ...(settings.config ?? {}) } };
}

/**
 * Opens an agent thread lean: a start or fork is stored hidden, a start also asks for raw Responses items (thread/resume
 * and thread/fork have no such field; a resumed thread keeps its stored source). `openMs` is the request's limit (0: none –
 * an agent turn's open waits on its signal through `rpc`, engine.ts).
 */
export function openAgentThread<R>(
  rpc: Pick<RpcClient, 'request'>, method: AgentThreadMethod, given: { config?: Record<string, unknown> } & Record<string, unknown>, openMs = THREAD_OPEN_MS,
): Promise<R> {
  const settings = method === 'thread/resume' ? given : { ...given, ...HIDDEN_THREAD, ...(method === 'thread/start' ? { experimentalRawEvents: true } : {}) };
  return rpc.request<R>(method, agentThread(settings), openMs);
}
