// RPC handlers: feedback reports, the app's look (theme.get – <data>/theme.css, runtime/root/theme.ts),
// onboarding and voice transcription.
// Owns: param checks and scope rules. Requests from a client are always authored by the human; `theme.get` is
// open to every authenticated device and to employees' devices (they all look the same). Writing and listing feedback and dictation need
// 'chat'; so do `feedback.send`, `feedback.dismiss` and `feedback.status` (whether this build can send at all) and `feedback.context` (the window's own send asks what only the runtime knows):
// Send seals the report for the team (B-055); the team inbox and setup are owner-only (handlers/feedback-inbox.ts).
// Onboarding stays owner-only. Local speech: voice.localModels and voice.speak need 'chat',
// voice.pullLocal (a download) is the owner's and – B-084 (D6) – the owner's phone's on a secure transport ('settings' + secure).
// Never: implements feedback/onboarding/voice behaviour (extras do), or uploads anything.

import type { FeedbackKind } from '../../../shared/model/system.ts';
import { FEEDBACK_CLIENT_DIAGNOSTICS_MAX, FEEDBACK_CLIENT_ID, FEEDBACK_CLIENT_MAX, FEEDBACK_IMAGES_MAX } from '../../../shared/model/feedback-delivery.ts';
import { AUDIO_TAGGER, localSpeechIds } from '../../../shared/model/local-speech-models.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import { readTheme } from '../../root/theme.ts';
import { bad, input, oneOf, onlyKeys, optBool, optId, optOneOf, optText, text, type Obj } from '../params.ts';
import type { Handler, HandlerTable } from '../table.ts';
import { register as registerVoiceRetry } from './voice-retry.ts';

const CHAT = { capability: 'chat' } as const;
/** B-084 (D6): the Models page's Download on my phone on a secure transport, like the PC. */
const SETTINGS_SECURE = { capability: 'settings', secure: true } as const;

const FEEDBACK_KINDS: readonly FeedbackKind[] = ['bug', 'idea', 'change', 'praise'];
const SHA256 = /^[0-9a-f]{64}$/;

function fileId(o: Obj, key: string): string {
  const value = o[key];
  if (typeof value !== 'string' || !SHA256.test(value)) bad(key, 'a file id');
  return value;
}

/** feedback.create `imageFileIds`: up to FEEDBACK_IMAGES_MAX file ids, in order. */
function imageFileIds(o: Obj): string[] | undefined {
  const value = o.imageFileIds;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > FEEDBACK_IMAGES_MAX) bad('imageFileIds', `at most ${FEEDBACK_IMAGES_MAX} file ids`);
  for (const id of value) if (typeof id !== 'string' || !SHA256.test(id)) bad('imageFileIds', 'a list of file ids');
  return value as string[];
}

function optClientId(o: Obj): string | undefined {
  const value = optText(o, 'clientId', { max: 64 });
  if (value !== undefined && !FEEDBACK_CLIENT_ID.test(value)) bad('clientId', 'letters, digits, "_" or "-"');
  return value;
}

export function register(table: HandlerTable): void {
  registerVoiceRetry(table); // B-082: voice.retranscribe (handlers/voice-retry.ts)
  // ---------------------------------------------------------------- feedback
  // 16.11.2026: a person's report needs no kind; `client` and `clientDiagnostics` are taken generously and kept to
  // FEEDBACK_CLIENT_MAX / FEEDBACK_CLIENT_DIAGNOSTICS_MAX by the service, so a long user agent never loses a report.
  table.add('feedback.create', (params, ctx) => {
    const o = input(params);
    // Bridge 20.11.2026: a page from an older build (a cached PWA, the iPhone web app) still sends its recordings' ids –
    // taken as "dictated" and otherwise ignored, so its report goes (a report never carries a recording).
    onlyKeys(o, ['kind', 'text', 'imageFileIds', 'dictated', 'audioFileIds', 'view', 'conversationId', 'clientId', 'client', 'clientDiagnostics']);
    const dictated = optBool(o, 'dictated') || (Array.isArray(o.audioFileIds) && o.audioFileIds.length > 0) || undefined;
    const clientId = optClientId(o);
    const images = imageFileIds(o);
    const client = optText(o, 'client', { max: 4 * FEEDBACK_CLIENT_MAX, multiline: true });
    const clientDiagnostics = optText(o, 'clientDiagnostics', { max: 5 * FEEDBACK_CLIENT_DIAGNOSTICS_MAX, multiline: true });
    return ctx.extras.feedback.create({
      kind: optOneOf(o, 'kind', FEEDBACK_KINDS),
      text: text(o, 'text', { max: 20_000, multiline: true }),
      ...(images?.length ? { imageFileIds: images } : {}),
      view: optText(o, 'view', { max: 120 }),
      conversationId: optId(o, 'conversationId'),
      ...(dictated ? { dictated } : {}),
      ...(clientId ? { clientId } : {}),
      ...(client ? { client } : {}),
      ...(clientDiagnostics ? { clientDiagnostics } : {}),
      author: HUMAN_ID,
    });
  }, CHAT);
  table.add('feedback.list', (_params, ctx) => ctx.extras.feedback.list(), CHAT);
  // B-055: `receiving` (this PC holds the team's key: Settings › Feedback shows the inbox) only ever for the owner.
  table.add('feedback.status', (_params, ctx) => {
    const status = ctx.extras.feedback.status?.();
    return { sending: status?.sending === true, receiving: ctx.scope.kind === 'owner' && status?.receiving === true };
  }, CHAT);
  table.add('feedback.context', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['text']);
    const body = text(o, 'text', { max: 20_000, multiline: true });
    return ctx.extras.feedback.context?.(body) ?? { text: body };
  }, CHAT);
  table.add('feedback.send', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'visibility']);
    const visibility = o.visibility === undefined ? 'public' : oneOf(o, 'visibility', ['public', 'private'] as const);
    return ctx.extras.feedback.send(text(o, 'id', { max: 128 }), { reveal: ctx.scope.kind === 'owner', visibility });
  }, CHAT);
  table.add('feedback.dismiss', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id']);
    return ctx.extras.feedback.dismiss(text(o, 'id', { max: 128 }));
  }, CHAT);

  // ---------------------------------------------------------------- the app's look
  const theme: Handler<'theme.get'> = (_params, ctx) => ({ css: readTheme(ctx.services.paths.data, ctx.services.log) });
  table.add('theme.get', theme, 'any');
  table.addPerson('theme.get', theme); // an employee's device looks the same

  // ---------------------------------------------------------------- onboarding & import
  table.add('onboarding.reset', (_params, ctx) => { // "Set up team again" (owner only): the first-run layer again
    ctx.extras.onboarding.reset();
    return { ok: true };
  });
  // B-044: the first-run cards are through – the Manager's first chat and the app's start text there as the person's line (owner only).
  table.add('onboarding.start', (params, ctx) => {
    onlyKeys(input(params), []);
    return ctx.extras.onboarding.start();
  });

  // ---------------------------------------------------------------- voice
  table.add('voice.transcribe', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['fileId', 'language', 'chatId', 'before', 'live']);
    const language = optText(o, 'language', { max: 16 });
    const chatId = optText(o, 'chatId', { max: 64 }); // the chat dictated into: its last agent message helps a listening model
    if (language !== undefined && !/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(language)) bad('language', 'a language code like "de" or "en-US"');
    const before = optText(o, 'before', { max: 2_000, multiline: true, allowEmpty: true }); // B-082: the take's earlier text, context
    if (o.live !== undefined && o.live !== true) bad('live', 'true or left out');
    return ctx.extras.voice.transcribe({ fileId: fileId(o, 'fileId'), language, ...(chatId ? { chatId } : {}), ...(before ? { before } : {}), ...(o.live === true ? { live: true } : {}) });
  }, CHAT);
  // B-047 D14: local speech – the list and the voice for every chat device (the phone reads answers through
  // the PC's voice), the download (it writes to disk and chooses the model) for the owner and my phone on a secure transport.
  table.add('voice.localModels', (params, ctx) => {
    onlyKeys(input(params), []);
    return ctx.extras.voice.localModels();
  }, CHAT);
  table.add('voice.pullLocal', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id']);
    const id = text(o, 'id', { max: 80 });
    // B-058 (T7): also the sound tagger (only downloaded, never chosen)
    if (!localSpeechIds('stt').includes(id) && !localSpeechIds('tts').includes(id) && id !== AUDIO_TAGGER.id) bad('id', 'a local speech model id from voice.localModels');
    return ctx.extras.voice.pullLocal(id);
  }, SETTINGS_SECURE);
  table.add('voice.speak', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['text', 'voice', 'language']);
    const voice = optText(o, 'voice', { max: 8 });
    if (voice !== undefined && !/^\d{1,2}$/.test(voice)) bad('voice', 'a speaker number like "0"');
    const language = optText(o, 'language', { max: 16 });
    if (language !== undefined && !/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(language)) bad('language', 'a language code like "de" or "en-US"');
    return ctx.extras.voice.speak({ text: text(o, 'text', { max: 2_000, multiline: true }), voice, language });
  }, CHAT);
}
