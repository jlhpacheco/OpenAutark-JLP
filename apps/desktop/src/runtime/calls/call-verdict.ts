// The call voice's last act after a call (talker.ts handOver at the end): reading its verdict – which agents of the chat the
// call holds something for ("<name>: yes – <what>") – tolerantly, as models write such lines.
// Owns: reading that verdict. Never: asks the voice or wakes anyone (talker.ts).

/**
 * The agents the voice's closing lines name as acting on the call ("<name>: yes – <what>"), each with what it acts on ('' when
 * the line names nothing), read tolerantly: a bold or underlined name, a role in brackets after it, a dash instead of the
 * colon. Undefined when no line names one of the agents: the verdict cannot be read.
 */
export function actsOn(verdict: string, agents: Array<{ id: string; name: string }>): Map<string, string> | undefined {
  const acts = new Map<string, string>();
  let named = false;
  for (const line of verdict.split('\n')) {
    const match = /^[-•\d.)\s]*([^:–—(]{1,80}?)\s*(?:\([^)]*\))?\s*[:–—-]\s*(ja|yes|nein|no)\b(.*)$/i.exec(line.replace(/[*_`]/g, '').trim());
    if (!match) continue;
    const wanted = match[1].trim().toLowerCase();
    const who = agents.find((agent) => agent.name.toLowerCase() === wanted || agent.id.toLowerCase() === wanted);
    if (!who) continue;
    named = true;
    if (/^(ja|yes)$/i.test(match[2])) acts.set(who.id, match[3].replace(/^[\s:–—,-]+/, '').trim());
  }
  return named ? acts : undefined;
}
