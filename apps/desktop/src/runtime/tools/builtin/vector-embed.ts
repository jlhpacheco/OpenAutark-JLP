// vector.embed: a model adds files or folders to what vector.search finds, on purpose; they stay added (runtime/vectors/files.ts).
// Owns: the tool's wording, argument shape and result text. Never: picks what is added (runtime/vectors does the work).

import path from 'node:path';
import type { VectorEmbedResult } from '../../../shared/model/vectors.ts';
import type { ToolContext, ToolDef } from '../types.ts';
import { failure, text } from '../types.ts';
import { clip, defineTool } from './util.ts';
import { readPath } from './files.ts';
import '../../contracts/vectors.ts';

const LISTED = 20;

/** "memory…" and "catalog" (searched where they live) as they are; anything else as files.read would find it. */
export async function placePath(ctx: ToolContext, given: string): Promise<string> {
  const place = given.trim();
  return place === 'memory' || /^memory[\\/]/.test(place) || place === 'catalog' ? place : path.resolve(await readPath(ctx, place));
}

function report(result: VectorEmbedResult): string {
  const lines = [`Added ${result.embedded}, read again ${result.reembedded}, already added ${result.unchanged}.`];
  const shown = result.skipped.slice(0, LISTED).map((entry) => `- ${entry.path}: ${clip(entry.reason, 120)}`);
  if (shown.length) lines.push(`Left out:`, ...shown);
  if (result.skipped.length > LISTED) lines.push(`… and ${result.skipped.length - LISTED} more.`);
  if (result.remaining) lines.push(`${result.remaining} files not finished: call vector.embed again with the same paths to go on.`);
  if (result.waiting) lines.push(`${result.waiting} pieces get their meaning in the background; their words are found already.`);
  return lines.join('\n');
}

export const vectorEmbed: ToolDef = defineTool<{ paths: string[] }>({
  name: 'vector.embed',
  description: 'Adds files or folders to what vector.search finds: their words at once, their meaning once an embedding model has embedded them. I add what my work keeps coming back to; unchanged files are skipped, folders leave out binaries, dependencies, caches and secrets, and a big folder takes more calls.',
  inputSchema: {
    type: 'object',
    properties: { paths: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 1024 } } },
    required: ['paths'], additionalProperties: false,
  },
  category: 'read',
  describe: (args) => ({ summary: `Add ${clip(args.paths.join(', '), 120)} to the search`, resource: args.paths[0], reversible: true, external: false }),
  async run(args, ctx) {
    if (ctx.fromPc !== undefined) return failure('vector.embed runs only for agents of this PC.');
    const places = await Promise.all(args.paths.map((given) => placePath(ctx, given)));
    return text(report(await ctx.services.vectors.embed(places)));
  },
});
