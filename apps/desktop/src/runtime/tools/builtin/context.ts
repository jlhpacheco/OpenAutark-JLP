// The main AI's own way back (owner 28.10.2026): context.restore {ids, keep?} brings condensed or hidden parts of its working
// context back as this tool's output (context/ledger/restore.ts). Reached through tools.find; the stamp under a condensed text
// names it. Finding what it forgot goes through the subconscious tool instead.
// Owns: the definition and its short spec. Never: another agent's or thread's ledger.

import type { ToolDef } from '../types.ts';
import { text } from '../types.ts';
import { threadKey } from '../../../shared/model/origin.ts';
import { MAX_RESTORE_IDS, restoreFetched } from '../../context/ledger/restore.ts';
import { PIN_TURNS } from '../../../shared/model/context-ledger.ts';
import { defineTool, internal } from './util.ts';

const restore = defineTool<{ ids: string[]; keep?: boolean }>({
  name: 'context.restore',
  description: `Brings condensed or hidden parts of my context back for ${PIN_TURNS} turns, as the output.`,
  inputSchema: {
    type: 'object',
    properties: {
      ids: { type: 'array', minItems: 1, maxItems: MAX_RESTORE_IDS, items: { type: 'string', minLength: 2, maxLength: 16 }, description: 'From their stamps.' },
      keep: { type: 'boolean', description: 'true: for good; false lets a kept one go.' },
    },
    required: ['ids'], additionalProperties: false,
  },
  category: 'read',
  describe: (args) => internal(`Restore ${args.ids.slice(0, 5).join(', ')}${args.keep ? ' (keep)' : ''}`),
  async run(args, ctx) {
    return text(await restoreFetched(ctx.services, ctx.agent.id, threadKey(ctx), { ids: args.ids, ...(args.keep !== undefined ? { keep: args.keep } : {}) }));
  },
});

export const contextTools: ToolDef[] = [restore];
