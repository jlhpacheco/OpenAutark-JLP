// The see-through prompt (B-066, the owner's question "wird da irgendwas verschwiegen?"): every turn of the agent's main
// lane (B-076: not a split's parts, which run beside it) <data>/agents/<id>/last-prompt.md shows what the app sent this
// turn – the system prompt, then the input with the live context first (agents/turn-prepare.ts, once the session is chosen).
// Secrets are replaced by their handles before; overwritten each turn; never fails a turn; never creates the agent's folder.
// Owns: this file's name and text form. Never: reads it back or lets it influence a prompt.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { agentFolder, isCoreFolderName } from '../agent-core/layout.ts';

export const LAST_PROMPT_FILE = 'last-prompt.md';

/** The file's text: what it is, then the system prompt and the input as sent. */
export function lastPromptText(parts: { system: string; input: string }): string {
  return [
    '<!-- What the app sent on my last turn, secrets replaced by their handles; the app writes this file again each turn, so editing it changes nothing. First my system prompt: who I am, How I work, my SYSTEM.md (my role, what I have here – the file I change), my environment, skills, more tools and my mode. Then the input of that turn: the live context in <live> (all of it on a new session, only what changed on a resumed one), then the notes and new messages. The engine (Claude Code, Codex) adds its own tool descriptions and texts; on ACP my system prompt travels inside the first message; what my subconscious picked from my knowledge stands in <live> under "## From my memory". What I did on that turn – each tool call and its result, my final text – is in last-run.md beside it; earlier turns are in my run log: Team › Runs in the app, or wf call agents.runs \'{"id":"<my id>"}\' and then wf call runs.items \'{"runId":"<run id>"}\' (the JSON quoted for the shell). -->',
    '',
    '# System prompt',
    '',
    parts.system,
    '',
    '# Input',
    '',
    parts.input,
    '',
  ].join('\n');
}

/** Writes the file when the agent has its folder; any failure is only a debug line. */
export function writeLastPrompt(dataDir: string | undefined, agentId: string, parts: { system: string; input: string }, debug?: (message: string, data: Record<string, unknown>) => void): void {
  if (!dataDir || !isCoreFolderName(agentId)) return;
  try {
    writeFileSync(path.join(agentFolder(dataDir, agentId), LAST_PROMPT_FILE), lastPromptText(parts), 'utf8');
  } catch (error) {
    debug?.('last prompt not written', { agentId, error: String(error) });
  }
}
