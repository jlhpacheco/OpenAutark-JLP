// Memory tools: the tree of Markdown files (knowledge/memory-tree.ts), on demand, never a list of memory in a prompt –
// memory.browse {folder}, memory.read {path}, memory.write {…} and memory.forget {path}. Finding is knowledge.find (notes by
// their words, `in` memory folders); vector.search reaches files embedded on purpose. memory.write is the one write: the folder is the place
// (agents/<me> by default, company, branches/<space>, chats/<chat>, company/websites/<host>, company/apps/<process> with the
// host or process name normalised – knowledge/scope-id.ts –, company/modes/<mode>, references/<person> or any topic
// folder); a file of the same title, or clearly the same content, in that folder is updated – never a duplicate, the old
// version kept as history; `pinned` moves it into or out of its place's pinned/ folder (withPinned); into references/ it
// keeps the person's own words with a reference kind (references/references.ts captureReference).
// Runde „Halb“ 21.11.2026 (owner: a memory "gibt einfach einen kurzen Einstieg … das nicht zu vergessen", not a work
// instruction): a note is a small pointer to one thing, and its description – now required – is the line the subconscious's
// hint carries (subconscious/hints.ts); a way of working is a skill. The subconscious's thoughts.md is no note: memory.browse
// leaves it out (find/service.ts leaves it out of the search).
// Owns: these tools and their wording (folderText also for the subconscious's memory.browse).

import type { ToolContext, ToolDef } from '../types.ts';
import { failure, json } from '../types.ts';
import type { KnowledgeItem } from '../../../shared/model/knowledge.ts';
import { foldText } from '../../knowledge/normalize.ts';
import { appId, websiteId } from '../../knowledge/scope-id.ts';
import { memoryId, scopeOfPath } from '../../knowledge/memory-tree.ts';
import { REFERENCE_KINDS, captureReference, type ReferenceKind } from '../../references/references.ts';
import { COVERS, similarity } from '../../subconscious/text.ts';
import type { MemoryFolder, MemoryKind } from '../../../shared/model/memory.ts';
import { clip, defineTool, internal, parseWhen } from './util.ts';
import { subjectOf } from './references.ts';

const KINDS = ['fact', 'preference', 'experience', 'procedure', 'plan', 'note'] as const;
const REFERENCES = /^references(?:\/([^/]+))?\/?$/;

/** The current note a new one would only repeat in other words: same title, else clearly the same content. */
function twinOf(current: readonly KnowledgeItem[], title: string, body: string): KnowledgeItem | undefined {
  const key = foldText(title);
  const text = `${title} ${body}`;
  let best: { item: KnowledgeItem; score: number } | undefined;
  for (const item of current) {
    if (foldText(item.title) === key) return item;
    const score = similarity(`${item.title} ${item.body}`, text);
    if (score >= COVERS && (!best || score > best.score)) best = { item, score };
  }
  return best?.item;
}

/** A folder as stored: a website's host or an app's process name normalised, no slash at either end. */
function placeOf(folder: string): string {
  const clean = folder.trim().replace(/^memory\//, '').replace(/^\/+|\/+$/g, '');
  const area = /^company\/(websites|apps)\/([^/]+)(.*)$/.exec(clean);
  if (!area) return clean;
  const id = area[1] === 'websites' ? websiteId(area[2]) : appId(area[2]);
  return `company/${area[1]}/${id ?? area[2]}${area[3]}`;
}

/** The notes of `folder` itself (and its pinned/), the twin check's candidates. */
async function notesIn(ctx: ToolContext, folder: string): Promise<KnowledgeItem[]> {
  const items = await ctx.services.knowledge.list({ ...scopeOfPath(`${folder}/x.md`), limit: 500 }).catch(() => []);
  return items.filter((item) => item.kind !== 'reference'
    && item.id.split(':').slice(0, -1).filter((part) => part !== 'pinned').join('/') === folder);
}

/** memory.write into references/<person>: the person's own words with a reference kind. */
function writeReference(ctx: ToolContext, person: string | undefined, args: { title: string; text: string; kind?: string; source?: string; audience?: string }) {
  const kind = (args.kind ?? 'example') as ReferenceKind;
  if (!REFERENCE_KINDS.includes(kind)) return failure(`In references/ the kind is one of ${REFERENCE_KINDS.join(', ')}.`);
  const messageId = /^message:(.+)$/.exec(args.source ?? '')?.[1];
  const item = captureReference(ctx.services.knowledge, { kind, text: args.text, subject: subjectOf(ctx.services, person), situation: args.title, ...(args.audience ? { audience: args.audience } : {}), by: ctx.agent.id, ...(messageId ? { messageId } : {}) });
  return json({ ok: true, path: item.id.replace(/:/g, '/'), outcome: 'created', title: item.title });
}

const PATH = { type: 'string', minLength: 1, maxLength: 512 } as const;
const day = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** The subconscious's own thoughts (subconscious/thoughts.ts agents/<id>/thoughts.md): its keywords, not a note – no listing shows them. */
const THOUGHTS = /^agents\/[^/]+\/thoughts\.md$/;

/** A folder as memory.browse lists it: without the subconscious's thoughts file. */
export function listedFolder(folder: MemoryFolder): MemoryFolder {
  return { ...folder, files: folder.files.filter((entry) => !THOUGHTS.test(entry.path)) };
}

/** One memory folder as text: the main AI's memory.browse and the subconscious's (subconscious/tools.ts). */
export function folderText(input: MemoryFolder): string {
  const folder = listedFolder(input);
  return [
    `memory/${folder.path}`.replace(/\/$/, ''),
    ...(folder.description ? [folder.description] : []),
    ...folder.folders.map((entry) => `${entry.path}/${entry.description ? ` – ${clip(entry.description, 160)}` : ''}`),
    ...folder.files.map((entry) => `${entry.path} – ${entry.title}${entry.kind ? ` [${entry.kind}]` : ''} (${day(entry.updated)})${entry.description ? ` – ${entry.description}` : ''}`),
    ...(folder.more ? ['… and older files.'] : []),
    ...(!folder.folders.length && !folder.files.length ? ['Empty.'] : []),
  ].join('\n');
}

const browse = defineTool<{ folder?: string }>({
  name: 'memory.browse',
  description: 'Shows a folder of the memory tree: its subfolders and newest files. Each file with title, kind, date and description.',
  inputSchema: { type: 'object', properties: { folder: { type: 'string', maxLength: 512, description: 'Default the top: company, branches, agents, references.' } }, additionalProperties: false },
  category: 'read',
  describe: (args) => internal(`Browse memory ${clip(args.folder ?? '', 60)}`),
  async run(args, ctx) {
    try {
      const folder = listedFolder(ctx.services.knowledge.memoryBrowse(args.folder ?? ''));
      return { content: [{ type: 'text', text: folderText(folder) }], structured: folder };
    } catch (error) {
      return failure((error as Error).message);
    }
  },
});

const read = defineTool<{ path: string }>({
  name: 'memory.read',
  description: 'Reads one memory file with its title, description, kind, tags, date, source and text.',
  inputSchema: { type: 'object', properties: { path: PATH }, required: ['path'], additionalProperties: false },
  category: 'read',
  describe: (args) => internal(`Read memory ${clip(args.path, 60)}`, args.path),
  async run(args, ctx) {
    try {
      const file = ctx.services.knowledge.memoryRead(args.path);
      if (!file) return failure(`No memory file ${clip(args.path, 200)}.`);
      const facts = [file.kind, file.tags?.join(', '), day(file.updated), file.source].filter(Boolean).join(' · ');
      return { content: [{ type: 'text', text: `${file.title} (${facts})${file.description ? `\n${file.description}` : ''}\n\n${file.text}` }], structured: file };
    } catch (error) {
      return failure((error as Error).message);
    }
  },
});

type WriteArgs = {
  path?: string; folder?: string; title: string; text: string; description?: string; kind?: MemoryKind | ReferenceKind; tags?: string[]; source?: string;
  pinned?: boolean; confidence?: number; validFrom?: string; validTo?: string; audience?: string;
};

const write = defineTool<WriteArgs>({
  name: 'memory.write',
  description: 'Keeps one thing a later turn of mine would otherwise not think of – a fact, a wish of the person, a way that worked or failed here – as a short dated note, findable at once. Its description is the line my later self gets as a hint: when it matters and what it changes, in the words such a request would carry. A way of working that needs more than a few lines is a skill (skills.save). The same title or content in a folder updates that file.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { ...PATH, description: 'A file to update.' },
      folder: { type: 'string', maxLength: 512, description: "Default my own (agents/<me>); company for everyone, branches/<space>, chats/<chat>, company/websites/<host>, company/apps/<process>, company/modes/<mode>, references/<person> for the person's own words, or any topic subfolder." },
      title: { type: 'string', minLength: 1, maxLength: 200 }, text: { type: 'string', minLength: 1, maxLength: 50_000 },
      description: { type: 'string', minLength: 1, maxLength: 300, description: 'The hint line: when it matters and what it changes.' },
      kind: { type: 'string', enum: [...KINDS, ...REFERENCE_KINDS], description: `In references/: ${REFERENCE_KINDS.join(', ')} (default example).` },
      audience: { type: 'string', maxLength: 120, description: 'In references/: whom the person wrote it for, so a later draft for them finds it.' },
      tags: { type: 'array', items: { type: 'string' }, maxItems: 12 }, source: { type: 'string', maxLength: 500, description: 'Where it came from, e.g. "message:<id>".' },
      pinned: { type: 'boolean', description: 'true: in my prompt every turn – for what stays true, kept short; a state that moves I read fresh where it lives. false moves it out.' },
      confidence: { type: 'number', minimum: 0, maximum: 1, description: '0–1.' },
      validFrom: { type: 'string' }, validTo: { type: 'string', description: 'Ends it at this time.' },
    },
    required: ['title', 'text', 'description'], additionalProperties: false,
  },
  category: 'think',
  describe: (args) => internal(`Write memory "${clip(args.title, 60)}"`),
  async run(args, ctx) {
    const now = ctx.services.clock.now();
    try {
      const folder = args.path ? undefined : placeOf(args.folder ?? `agents/${ctx.agent.id}`);
      const reference = folder !== undefined ? REFERENCES.exec(folder) : null;
      if (reference) return writeReference(ctx, reference[1], args);
      if ((REFERENCE_KINDS as readonly string[]).includes(args.kind ?? '')) return failure(`${args.kind} is a reference kind: it goes into references/<person>.`);
      const twin = folder !== undefined ? twinOf(await notesIn(ctx, folder), args.title.trim(), args.text.trim()) : undefined;
      const written = ctx.services.knowledge.memoryWrite({
        ...(args.path ? { path: args.path } : twin ? { path: twin.id } : { folder }),
        title: args.title, text: args.text, ...(args.description !== undefined ? { description: args.description } : {}),
        kind: args.kind as MemoryKind | undefined, tags: args.tags, source: args.source ?? `run:${ctx.runId}`,
        validFrom: parseWhen(args.validFrom, now), validTo: parseWhen(args.validTo, now), confidence: args.confidence, by: ctx.agent.id,
      });
      const path = args.pinned === undefined ? written.path : ctx.services.knowledge.pin(memoryId(written.path), args.pinned, ctx.agent.id).id.replace(/:/g, '/');
      const note = twin && foldText(twin.title) !== foldText(args.title) ? `Updated my note "${clip(twin.title, 60)}" (the old version is kept as history).` : '';
      return json({ ok: true, ...written, path, ...(note ? { note } : {}) });
    } catch (error) {
      return failure((error as Error).message);
    }
  },
});

const forget = defineTool<{ path: string }>({
  name: 'memory.forget',
  description: 'Deletes a memory file for good, with its old versions.',
  inputSchema: { type: 'object', properties: { path: PATH }, required: ['path'], additionalProperties: false },
  category: 'think',
  describe: (args) => internal(`Forget memory ${clip(args.path, 60)}`, args.path),
  async run(args, ctx) {
    try {
      const { removed } = ctx.services.knowledge.memoryForget(args.path);
      return removed ? json({ ok: true }) : failure(`No memory file ${clip(args.path, 200)}.`);
    } catch (error) {
      return failure((error as Error).message);
    }
  },
});

export const memoryTools: ToolDef[] = [browse, read, write, forget];
