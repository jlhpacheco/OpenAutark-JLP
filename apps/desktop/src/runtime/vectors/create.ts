// Puts services.vectors together: the store, the meaning ranking with its one queue and the added files (vectorSystem), and for
// the composition root the embedding model the use "embeddings" resolves to right now (one client per model) and what a paid
// model costs (spend.ts). A stored text whose note is gone (deleted while the app was closed – a removal while it runs
// forgets at once, knowledge/memory-follow.ts) is forgotten at the first ranking (`gone`), so no deleted note's words stay.
// Owns: that wiring and that one sweep. Never: logic of its own beyond it.

import { existsSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import type { VectorService } from '../contracts/vectors.ts';
import type { Db } from '../db/database.ts';
import { embeddingChoice } from '../models/embeddings.ts';
import { HttpEmbedder, type Embedder } from './embedders.ts';
import { FileTexts, type ReadFile } from './files.ts';
import { LocalEmbedder } from './local-model.ts';
import { Meaning } from './meaning.ts';
import { Places } from './places.ts';
import { EmbedSpend } from './spend.ts';
import { VectorStore } from './store.ts';

export interface VectorDeps {
  db: Db;
  /** The embedding model now (settings, connections, what this PC can run); undefined = none chosen. */
  embedder: () => Embedder | undefined;
  /** Removes secrets from stored texts and from a query that leaves this PC. */
  redact?: (text: string) => string;
  log?: { warn(message: string, details?: Record<string, unknown>): void };
  now?: () => number;
  /** Ends what the embedder holds (the local model's worker) when the system stops. */
  release?: () => void;
  readFile?: ReadFile;
  platform?: NodeJS.Platform;
  queryWaitMs?: number;
  /** A stored text whose source is gone; asked once, at the first ranking. */
  gone?: (key: string) => boolean;
}

/** services.vectors over a database and an embedder. */
export function vectorSystem(deps: VectorDeps): VectorService & { settled(ms?: number): Promise<void> } {
  const now = deps.now ?? Date.now;
  const store = new VectorStore(deps.db, now);
  const meaning = new Meaning({ store, embedder: deps.embedder, now, redact: deps.redact, log: deps.log, release: deps.release, queryWaitMs: deps.queryWaitMs });
  const files = new FileTexts({ store, meaning, places: new Places(deps.platform), now, redact: deps.redact, readFile: deps.readFile });
  let swept = !deps.gone;
  const sweep = () => {
    if (swept) return;
    swept = true;
    try { for (const key of store.keys()) if (deps.gone!(key)) store.removeUnder(key); } catch (error) { deps.log?.warn('stored texts of gone notes not forgotten', { error: String(error) }); }
  };
  return {
    available: () => meaning.available(),
    rank: (input) => { sweep(); return meaning.rank(input); },
    embed: (paths, opts) => files.add(paths, opts),
    search: (input) => files.search(input),
    forget: (key) => store.removeUnder(key),
    stop: () => meaning.stop(),
    settled: (ms) => meaning.settled(ms),
  };
}

/** A memory note's file (knowledge/search.ts noteKey of a file item); a stored row of the knowledge table has no .md. */
const NOTE_FILE = /^memory\/.+\.md$/i;

export function createVectors(s: RuntimeServices): VectorService {
  const local = new LocalEmbedder({ dataDir: s.paths.data });
  const spend = new EmbedSpend(() => s);
  let client: { key: string; embedder: Embedder } | undefined;
  const embedder = (): Embedder | undefined => {
    const choice = embeddingChoice(s, local.possible());
    if (!choice) return undefined;
    if (choice.kind === 'local') return local;
    const key = `${choice.accountId}|${choice.baseUrl}|${choice.model}`;
    if (client?.key !== key) {
      client = {
        key,
        embedder: new HttpEmbedder({
          provider: choice.provider, baseUrl: choice.baseUrl, model: choice.model, remote: !choice.local, sendDimensions: !choice.local,
          apiKey: () => s.accounts.apiKey(choice.accountId),
          onUsage: (use) => spend.add(choice, use),
        }),
      };
    }
    return client.embedder;
  };
  return vectorSystem({
    db: s.db, embedder, log: s.log, redact: (text) => s.secrets.redact(text), now: () => s.clock.now(),
    gone: (key) => NOTE_FILE.test(key) && !existsSync(path.join(s.paths.data, key)), // a note's key is its path under <data> (memory/…)
    release: () => { local.stop(); spend.flush(); },
  });
}
