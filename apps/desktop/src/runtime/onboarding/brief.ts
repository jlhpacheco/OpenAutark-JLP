// The first chat's two opening lines when the first-run layer ends: F07 (owner 15.11.2026) the start line in the person's
// voice, then B-090 the Manager's first message as its own line below it. resources/prompts/onboarding.md (or the
// person's own <data>/prompts/onboarding.md, context/templates.ts) rendered twice – with {{start}} for the start line,
// without for the greeting – with the profile's name, company, language, the security mode ({{secure}}: "yes" in Secure
// mode – the placeholder keeps the name onboarding.md knows) and the one language
// section that fits the profile's language (German, French, Spanish, else English). A prompt without a start part
// renders the same text twice: then there is no start line. Written by the app, so no model runs for either line; the
// person's answer is the Manager's first turn.
// Owns: these values and the rendering. Never: account labels, e-mails, keys, base URLs or ids.

import type { RuntimeServices } from '../contracts.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { languageName } from '../context/prompt-stable.ts';
import { renderTemplate } from '../context/templates.ts';
import { securityOf } from '../../shared/model/system.ts';

/** An own prompt far too long for one chat line is cut. */
export const BRIEF_MAX = 3800;

/** The languages the shipped message is written in; any other profile language gets English. */
export const WELCOME_LANGUAGES = ['de', 'fr', 'es', 'en'] as const;

/** Used when neither an own version nor the shipped prompt can be read: the shipped English text. */
const FALLBACK = `{{#start}}
Sent by Autark when I clicked Start: I've just set up my company here – let's begin.
{{/start}}
{{^start}}
Hi{{#name}} {{name}}{{/name}}, I'm your Manager – your right hand in Autark. Before I start, a few quick questions. Answer whatever matters to you; whatever stays open I decide myself.

1. **Language:** Which language do we speak with you – and which among ourselves in the team (notes, tasks, code)? For example everything in English, or internally English and with you in your own language.
2. **Way of working:** How should we work – how independently, how often you hear from us, what matters most to you?
3. **Setup:** {{^secure}}This PC is fully open to us. Shall I set it up completely myself right away – install what is missing, connect your apps and accounts, set everything up the way we need it?{{/secure}}{{#secure}}On this PC I work in my own area. Shall I set myself up there completely right away and connect your apps and accounts?{{/secure}}
4. **Names:** What should your team members be called – human names like Emma or Noah, or by their role, such as "Programmer"?
5. **Structure:** Do you already have ideas for how the team or your projects should be built – or shall I just start?

As soon as you answer, I work the way you say: I get to know you – what is on this PC and on the web about you, your earlier conversations with other AIs (ChatGPT, Claude and others) and what they keep about you. For each real area of your work I build a head set up like me and working beside me; I stay your direct contact, and for parallel work I split myself (Ultra). The passwords saved in your browsers I move unread into the secrets catalog, so we can fill logins everywhere. And I look at which AI models carry us better – for the work, for decisions and for search by meaning – and what you already have for them. I keep your answers as agreements for the whole team. If I should wait, just say so – I start when you are ready.
{{/start}}`;

/** The shipped language section for a profile language ('de-AT' → 'de'; anything unknown → 'en'). */
export function welcomeLanguage(code: string | undefined): (typeof WELCOME_LANGUAGES)[number] {
  const base = (code ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return (WELCOME_LANGUAGES as readonly string[]).includes(base) ? base as (typeof WELCOME_LANGUAGES)[number] : 'en';
}

/** The first chat's opening lines (each at most BRIEF_MAX characters): `start` in the person's voice ('' when the prompt has
 *  no start part) and `answer`, the Manager's first message below it ('' when the prompt renders to nothing). */
export function setupLines(s: RuntimeServices): { start: string; answer: string } {
  let template = '';
  try { template = s.prompts?.text('onboarding') ?? ''; } catch (error) { s.log.warn('onboarding prompt unreadable', { error: String(error) }); }
  const settings = s.settings.get();
  const profile = settings.profile;
  const lang = welcomeLanguage(profile.language);
  const values = {
    name: excerpt(profile.name.trim(), 80), company: excerpt(profile.company.trim(), 120), language: languageName(profile.language),
    secure: securityOf(settings).mode === 'secure' ? 'yes' : '', // 19.11.2026: Secure mode asks for the team's own area
    ...Object.fromEntries(WELCOME_LANGUAGES.map((code) => [`lang_${code}`, code === lang ? 'yes' : ''])),
  };
  const line = (start: boolean) => {
    const text = renderTemplate(template.trim() || FALLBACK, { ...values, start: start ? 'yes' : '' });
    return text.length > BRIEF_MAX ? `${text.slice(0, BRIEF_MAX - 1).trimEnd()}…` : text;
  };
  const answer = line(false);
  const start = line(true);
  return { start: start === answer ? '' : start, answer };
}
