// HUMAN.md (owner 15.11.2026: "ein Feld … wenn man auf den Agent klickt, dann kann man das als Mensch editieren …
// unten angehängt … wird doch nicht überschrieben … als separate Datei"): the person's lines to one agent, in its
// folder beside SYSTEM.md, last in its system prompt under "## From <name>" (context/prompt-stable.ts). The person
// writes it on the agent page (agents.setHuman) or as a file, and the agent may change it too (owner 16.11.2026); no
// standard or update ever rewrites it. A hire starts without one: what concerns the whole team about a topic is that
// topic's security text (owner 19.11.2026, <data>/security/<mode>/<topic>.md – the "I'm not a robot" line is
// captcha.md).
// Owns: the file's path, read and write. Never: writes a file nobody asked for, or polls.

import path from 'node:path';
import { HUMAN_FILE, MAX_HUMAN_MD } from '../../shared/model/agent-core.ts';
import { readText, writeAtomic, type OwnWrites } from '../root/text-doc.ts';
import { agentFolder } from './layout.ts';

/** Read up to this much; the prompt and the page take the first MAX_HUMAN_MD characters. */
const LIMITS = { maxBytes: 64 * 1024, maxChars: 64 * 1024 };

export const humanFile = (dataDir: string, agentId: string): string => path.join(agentFolder(dataDir, agentId), HUMAN_FILE);

/** HUMAN.md's text, trimmed, at most MAX_HUMAN_MD characters ('' when missing, empty or unreadable). */
export function readHuman(dataDir: string, agentId: string): string {
  try {
    const read = readText(humanFile(dataDir, agentId), LIMITS);
    return read.kind === 'ok' ? read.text.trim().slice(0, MAX_HUMAN_MD).trim() : '';
  } catch { return ''; }
}

/** Writes HUMAN.md as the person gave it (one final line end; '' leaves it empty, so nothing is appended). */
export function writeHuman(dataDir: string, agentId: string, text: string, writes?: OwnWrites): void {
  const body = text.replace(/\r\n?/g, '\n').trim();
  writeAtomic(humanFile(dataDir, agentId), body ? `${body}\n` : '', writes);
}
