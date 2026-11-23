// `record` ask widget as a voice-over (block with `video` + `cues`; task_2xr88cmc, 17.11.2026, owner wish via Clara: "zu
// einem fertigen Video selbst einsprechen und dabei sehen, was ich wann sagen soll und wie schnell").
// Flow: video on its first frame + the lines → Start microphone → Record → 3-2-1 → the video plays SILENT, the current line
// stands large with a bar for its time left and the pace it asks for, the voice is taped from the first frame → the video's
// end (or Stop) → the take (WAV) plays with the video → Retake / Send.
// Time: the microphone's raw blocks are counted (voiceover.ts SampleTape); the sample count at the moment the video really
// plays ('playing') is second 0 of the file, so the WAV and the video start together to within one block (20 ms) – no
// MediaRecorder, whose first data comes up to a second late (recorder.ts).
// Answer: {file, name, mime: 'audio/wav', seconds, size, video?}. Owns: this page of the recorder. Never: records without
// a click, plays the video's own sound while recording, or keeps the microphone open after a take.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { parseCues } from '../../../shared/blocks/cues.ts';
import type { Cue } from '../../../shared/blocks/cues.ts';
import { openMicrophone } from '../../lib/microphone.ts';
import type { Microphone } from '../../lib/microphone.ts';
import { learnKinds, videoFacts } from '../../lib/media-kinds.ts';
import { activeConversationId } from '../../lib/store.ts';
import { Button } from '../../lib/ui.tsx';
import { toastError } from '../../lib/toasts.ts';
import { duration } from '../ask.ts';
import { isFileId } from '../host.ts';
import { uploadBlob } from '../../lib/files.ts';
import { Markdown } from '../markdown.tsx';
import type { AskWidgetProps } from './ask-types.ts';
import { useLiveWords } from './live-words.ts';
import { useMediaUrl } from './Media.tsx';
import { armMedia, friendlyError, openStream, stopStream } from './recorder.ts';
import type { RecorderState } from './recorder.ts';
import { holdTake, releaseTake, takeBusy, useDeviceChoice } from './media-devices.ts';
import { RecordDevice } from './RecordDevice.tsx';
import { SampleTape, encodeWav, momentAt, paceHint, targetWpm, wavSeconds } from './voiceover.ts';
import { s } from './util.ts';

type Phase = 'idle' | 'preparing' | 'ready' | 'countdown' | 'recording' | 'recorded' | 'error';
interface Take { blob: Blob; url: string; seconds: number }

/** The countdown before the video starts, in seconds; the audio is taped from its first tick. */
const COUNTDOWN = 3;
/** Taped after the video's last frame, so the last word is not cut. */
const TAIL_MS = 700;
const BLOCK_MS = 20;

/** This page can voice-over: a live microphone and an audio context (no MediaRecorder needed). */
export function canVoiceover(): boolean {
  return typeof AudioContext !== 'undefined' && typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

const mmss = (seconds: number): string => duration(Math.max(0, Math.round(seconds)));

function CueStage(props: { cues: readonly Cue[]; time: number; running: boolean; wpm?: number; count: number }) {
  const cues = props.cues;
  const moment = momentAt(cues, props.time);
  const cue = moment.current >= 0 ? cues[moment.current] : undefined;
  const next = moment.next >= 0 ? cues[moment.next] : undefined;
  const asked = cue ? targetWpm(cue) : 0;
  const hint = props.running ? paceHint(asked, props.wpm) : undefined;
  return (
    <div class="w-voice-stage" aria-live="off">
      <div class={`w-voice-now${cue ? '' : ' is-waiting'}`} data-testid="voice-now">{cue ? cue.text : next && props.running ? '…' : ' '}</div>
      {props.running && (
        <div class={`w-voice-bar${cue && moment.fraction > 0.85 ? ' is-late' : ''}`} role="progressbar" aria-label="Time left in this line"
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(moment.fraction * 100)}>
          <span style={{ width: `${(cue ? moment.fraction : 0) * 100}%` }} />
        </div>
      )}
      <div class="w-voice-meta tabular">
        {cue && <span>{moment.remaining.toFixed(1)} s left</span>}
        {cue && asked > 0 && <span title="Words per minute this line asks for">≈ {asked} wpm</span>}
        {hint && hint !== 'on pace' && <span class="is-hint">{hint === 'faster' ? 'a little faster' : 'a little slower'}</span>}
        {!cue && next && props.running && <span>Next line in {moment.remaining.toFixed(1)} s</span>}
        {props.running && <span class="muted">{mmss(props.time)}</span>}
      </div>
      {next && cue && <div class="w-voice-next">{next.text}</div>}
      {props.count > 0 && <div class="w-voice-count" role="status" aria-label={`Starts in ${props.count}`}>{props.count}</div>}
    </div>
  );
}

export function VoiceoverWidget(props: AskWidgetProps) {
  const { block } = props;
  const parsed = useMemo(() => (block.cues === undefined ? { cues: [] } : parseCues(block.cues)), [block.cues]);
  const cues = parsed.cues ?? [];
  const fileId = isFileId(s(block.fileId)) ? s(block.fileId) : undefined;
  const source = s(block.video) || fileId || '';
  const stored = fileId ?? (isFileId(source) ? source : undefined);
  const conversationId = activeConversationId.value;
  useEffect(() => { if (stored) learnKinds(conversationId ?? undefined); }, [stored, conversationId]); // 17.11.2026: a heavy video plays its light copy, as in a media block
  const copy = stored ? videoFacts.value.get(stored)?.previewFileId : undefined;
  const media = useMediaUrl(source, copy ?? stored, { stream: true });
  const maxSeconds = typeof block.maxSeconds === 'number' && block.maxSeconds > 0 ? block.maxSeconds : undefined;

  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const [time, setTime] = useState(0);
  const [take, setTake] = useState<Take | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const live = useRef<{ stream: MediaStream | null; mic: Microphone | null; tape: SampleTape | null; mark: number; epoch: number; frame: number; phase: Phase; take: Take | null }>(
    { stream: null, mic: null, tape: null, mark: 0, epoch: 0, frame: 0, phase: 'idle', take: null });
  const holder = useRef({}).current;
  const move = (next: Phase) => { live.current.phase = next; setPhase(next); };

  const devices = useDeviceChoice('audio', { remembered: true, arm: armMedia, onSwitch: () => { if (live.current.phase === 'ready') void prepare(); } });
  const recording = phase === 'recording';
  const words = useLiveWords(recording ? stream : null, recording);

  /** Everything the take holds goes: the microphone, the stream, the tape, the video's clock. */
  const stopAll = () => {
    const state = live.current;
    state.epoch++;
    cancelAnimationFrame(state.frame);
    state.mic?.close();
    state.mic = null;
    stopStream(state.stream);
    state.stream = null;
    setStream(null);
    video.current?.pause();
  };
  const dropTake = () => {
    const current = live.current.take;
    if (current) URL.revokeObjectURL(current.url);
    live.current.take = null;
    setTake(null);
  };
  const discard = () => { stopAll(); dropTake(); setError(null); setCount(0); setTime(0); if (video.current) video.current.currentTime = 0; move('idle'); };

  useEffect(() => () => { stopAll(); dropTake(); }, []);
  const asRecorder: RecorderState = phase === 'countdown' ? 'recording' : phase;
  const busy = takeBusy(asRecorder, take !== null);
  useEffect(() => {
    if (!props.draftKey || !busy) return;
    holdTake(props.draftKey, holder, discard);
    return () => releaseTake(props.draftKey, holder);
  }, [props.draftKey, busy]);

  const prepare = async (): Promise<void> => {
    stopAll();
    setError(null);
    move('preparing');
    try {
      const next = await openStream('audio', 'any', devices.chooser?.wanted());
      live.current.stream = next;
      setStream(next);
      void devices.chooser?.refresh(next.getAudioTracks()[0]?.getSettings?.().deviceId);
      move('ready');
    } catch (failure) {
      setError(friendlyError(failure));
      move('error');
    }
  };
  const chooseDevice = (id: string): void => {
    devices.chooser?.choose(id);
    if (live.current.phase === 'ready') void prepare();
  };

  /** The take ends: the voice from the video's first frame on, as a WAV. */
  const finish = (): void => {
    const state = live.current;
    const tape = state.tape;
    const samples = tape ? tape.slice(state.mark) : new Float32Array(0);
    const rate = tape?.sampleRate ?? 0;
    stopAll();
    if (!tape || samples.length < rate * 0.4) { setError('Nothing was recorded.'); move('error'); return; }
    const blob = new Blob([encodeWav(samples, rate)], { type: 'audio/wav' });
    const next = { blob, url: URL.createObjectURL(blob), seconds: wavSeconds(samples.length, rate) };
    state.take = next;
    setTake(next);
    if (video.current) video.current.currentTime = 0;
    move('recorded');
  };

  const record = async (): Promise<void> => {
    const state = live.current;
    const el = video.current;
    if (!state.stream || !el) return;
    const epoch = ++state.epoch;
    const alive = () => state.epoch === epoch;
    state.tape = null;
    state.mark = 0;
    move('countdown');
    try {
      devices.chooser?.pause(); // no device switch mid-take
      // The tap opens first and listens through the whole countdown; blocks from before the video are cut off by `mark`.
      state.mic = await openMicrophone((block, rate) => { state.tape ??= new SampleTape(rate); state.tape.push(block); }, { stream: state.stream, blockMs: BLOCK_MS });
      el.muted = true;
      el.currentTime = 0;
      for (let n = COUNTDOWN; n > 0; n--) {
        setCount(n);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (!alive()) return;
      }
      setCount(0);
      await new Promise<void>((resolve, reject) => {
        el.addEventListener('playing', () => resolve(), { once: true });
        el.play().catch(reject);
      });
      if (!alive()) return;
      state.mark = taped(); // the video's first frame is on screen: this sample is second 0
      move('recording');
      const started = performance.now();
      const step = () => {
        if (!alive()) return;
        setTime(el.currentTime);
        const tooLong = maxSeconds !== undefined && (performance.now() - started) / 1000 >= maxSeconds;
        if (el.ended || tooLong) { setTimeout(() => { if (alive()) finish(); }, el.ended ? TAIL_MS : 0); return; }
        state.frame = requestAnimationFrame(step);
      };
      state.frame = requestAnimationFrame(step);
    } catch (failure) {
      if (!alive()) return;
      stopAll();
      setCount(0);
      setError(friendlyError(failure));
      move('error');
    }
  };

  /** Samples taped so far (a call, so the type is read fresh after the awaits of record()). */
  const taped = (): number => live.current.tape?.length ?? 0;

  const retake = (): void => { dropTake(); setTime(0); void prepare(); };

  const playBoth = (): void => {
    const picture = video.current;
    const voice = audio.current;
    if (!picture || !voice) return;
    picture.muted = true;
    picture.currentTime = 0;
    voice.currentTime = 0;
    void Promise.all([picture.play(), voice.play()]).catch(() => undefined);
  };

  const send = async (): Promise<void> => {
    const current = live.current.take;
    if (!current) return;
    if (typeof block.maxBytes === 'number' && current.blob.size > block.maxBytes) {
      toastError(new Error('This recording is too large. Record a shorter take.'), 'Upload failed');
      return;
    }
    setProgress(0);
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const ref = await uploadBlob(current.blob, `voice-over-${stamp}.wav`, setProgress);
      const ok = await props.submit({ file: ref.id, name: ref.name || `voice-over-${stamp}.wav`, mime: 'audio/wav', seconds: Math.round(current.seconds * 10) / 10, size: ref.size, ...(stored ? { video: stored } : {}) });
      if (ok) discard();
    } catch (failure) {
      toastError(failure, 'Upload failed');
    } finally {
      setProgress(null);
    }
  };

  const idle = phase === 'idle' || phase === 'error';
  const showStage = cues.length > 0 && (phase === 'ready' || phase === 'countdown' || phase === 'recording');
  return (
    <div class="w-record mode-audio w-voice">
      {block.instructions !== undefined && idle && <Markdown text={s(block.instructions)} class="w-details" />}
      {parsed.cues === undefined && <p class="w-record-error" role="alert">The lines of this voice-over could not be read: {parsed.problem}</p>}
      {media.url
        ? <video ref={video} class="w-voice-video" src={media.url} muted playsInline preload="auto" aria-label="Video to speak to" controls={idle || phase === 'ready'} />
        : <div class="b-media-missing"><span>{media.failed ? 'The video could not be opened.' : 'Loading the video…'}</span></div>}
      {showStage && <CueStage cues={cues} time={time} running={recording} wpm={words.wpm} count={phase === 'countdown' ? count : 0} />}
      {idle && cues.length > 0 && (
        <ol class="w-voice-lines" aria-label="Lines to speak">
          {cues.map((cue, index) => <li key={index}><span class="tabular">{mmss(cue.start)}</span>{cue.text}</li>)}
        </ol>
      )}
      {phase === 'recorded' && take && (
        <div class="w-voice-playback">
          <audio ref={audio} src={take.url} controls preload="metadata" aria-label="Your voice" />
          <div class="w-record-status tabular" role="status"><span>{duration(Math.round(take.seconds))}</span><span class="muted"> · from the first frame of the video</span></div>
        </div>
      )}
      {error && <p class="w-record-error" role="alert">{error}</p>}
      {progress !== null && <div class="w-thin-bar" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${progress * 100}%` }} /></div>}
      <div class="w-actions">
        {idle && <Button variant="primary" icon="microphone" disabled={!media.url} onClick={() => void prepare()}>Start microphone</Button>}
        {phase === 'preparing' && <Button variant="primary" busy>Start microphone</Button>}
        {phase === 'ready' && (
          <>
            <Button variant="primary" onClick={() => void record()}>Record</Button>
            <Button variant="ghost" onClick={discard}>Cancel</Button>
            <RecordDevice mode="audio" choice={devices.choice} onChoose={chooseDevice} />
          </>
        )}
        {phase === 'countdown' && <Button variant="ghost" onClick={discard}>Cancel</Button>}
        {recording && <Button variant="primary" icon="stop" onClick={finish}>Stop</Button>}
        {phase === 'recorded' && (
          <>
            <Button variant="primary" busy={props.busy || progress !== null} onClick={() => void send()}>Send</Button>
            <Button variant="secondary" disabled={props.busy || progress !== null} onClick={playBoth}>Play with video</Button>
            <Button variant="secondary" disabled={props.busy || progress !== null} onClick={retake}>Retake</Button>
          </>
        )}
      </div>
    </div>
  );
}
