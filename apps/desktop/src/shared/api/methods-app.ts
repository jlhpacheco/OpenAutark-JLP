// RPC contract part: feedback reports, the app's look (<data>/theme.css, runtime/root/theme.ts), voice
// transcription. Handlers: runtime/rpc/handlers/app.ts.
// Merged into Methods by module augmentation (split from methods.ts by area, 23.10.).
// Owns: these method shapes. Never: behaviour.

import type { LocalSpeechModels, LocalSpeechPull, SpokenAudio } from '../model/local-speech-models.ts';
import type { FeedbackKind, FeedbackReport, FeedbackVisibility } from '../model/system.ts';
import type { SpanMark } from '../voice/marks.ts';

declare module '../api/methods.ts' {
  interface Methods {
    // ----------------------------------------------------------------- feedback, the app's look
    /**
     * A person's report, saved on this PC (feedback.send delivers it). 16.11.2026: `kind` optional; `clientId` (≤ 64,
     * [A-Za-z0-9_-]) – the same id again returns the stored report; `client` – where it was written; `clientDiagnostics`
     * – the device's own diagnostics; `dictated` – the text is a dictation's transcript (owner 20.11.2026: a report never
     * carries a recording); `imageFileIds` – its images in order (≤ FEEDBACK_IMAGES_MAX, owner 21.11.2026).
     */
    'feedback.create': {
      params: {
        kind?: FeedbackKind; text: string; imageFileIds?: string[]; dictated?: boolean; view?: string; conversationId?: string;
        clientId?: string; client?: string; clientDiagnostics?: string;
      };
      result: FeedbackReport;
    };
    'feedback.list': { params: void; result: FeedbackReport[] };
    'feedback.send': { params: { id: string; visibility?: FeedbackVisibility }; result: FeedbackReport };
    'feedback.dismiss': { params: { id: string }; result: FeedbackReport };
    /** The CSS of <data>/theme.css ('' = none); open to every device – phones look the same. */
    'theme.get': { params: void; result: ThemeCss };


    // ----------------------------------------------------------------- voice
    /**
     * Transcribes an uploaded recording (keys stay in the runtime); a local model also gives segment and word times.
     * B-082: `text` is plain; `marks` – the unsure places as spans in it (shared/voice/marks.ts). `before` (≤ 2000 chars):
     * text heard earlier in the same take, as context. `live`: a spoken conversation line – heard fast, never marked.
     * F27 (16.11.2026): `by` – who heard it; `planMissed` – the ChatGPT plan's dictation was asked first and gave no text,
     * so `by` heard it instead (both absent from older PCs).
     */
    'voice.transcribe': { params: { fileId: string; language?: string; chatId?: string; before?: string; live?: true }; result: { text: string; marks?: SpanMark[]; segments?: HeardSegment[]; words?: HeardWord[]; by?: HeardBy; planMissed?: true } };
    /** B-047 D14: this PC's local speech models (fitted to its memory and cores) and whether the local engine runs here. */
    'voice.localModels': { params: void; result: LocalSpeechModels };
    /** B-047 D14, owner: downloads a local speech model (sha256-checked) and chooses it; progress arrives as `voice.pull`. */
    'voice.pullLocal': { params: { id: string }; result: { ok: true } };
    /** B-047 D14: one line spoken by the chosen local voice (`voice`: the speaker number) – base64 PCM16 mono. */
    'voice.speak': { params: { text: string; voice?: string; language?: string }; result: SpokenAudio };
  }
}

declare module '../api/events.ts' {
  interface EventMap {
    /** theme.css changed on disk (topic 'system'; every device applies it). */
    'theme.updated': ThemeCss;
    /** B-047 D14: a voice.pullLocal download moved on (topic 'system', owner only). */
    'voice.pull': LocalSpeechPull;
  }
}

/** The app's look: the text of <data>/theme.css. */
export interface ThemeCss { css: string }
/** Who heard a take (runtime/voice/transcribe.ts): the ChatGPT plan's dictation, this PC's speech model, a transcription service, a listening model. */
export type HeardBy = 'plan' | 'local' | 'service' | 'listener';
/** A recognized stretch of a take (seconds from its start). */
export interface HeardSegment { text: string; start: number; end: number }
/** A recognized word with its time and – when the model gives token probabilities – the probability of its weakest token. */
export interface HeardWord { text: string; start: number; end: number; confidence?: number }
