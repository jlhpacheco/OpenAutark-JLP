// Checks for the person's live-view requests (rpc/handlers/browser.ts): one input, the tab it is for, a steering
// step, a takeover request and – 21.11.2026, shared with the mesh (devices/browser-view.ts) – the agent and a pull. Error texts are fixed and name only the field: they never echo what was typed.
// Owns: the input shapes and limits. Never: sends input or decides anything (view.ts).

import { WorkforceError } from '../../shared/errors.ts';
import { PULL_MAX_BYTES, PULL_MIN_BYTES, PULL_WAIT_MAX_MS, type BrowserButton, type BrowserInput, type BrowserPullRequest, type BrowserSteer, type BrowserTakeoverRequest } from '../../shared/model/browser.ts';
import { id, input, obj, onlyKeys, optNum } from '../rpc/params.ts';

const MAX_AT = Number.MAX_SAFE_INTEGER;

/** Text one input may insert (a paste or an IME commit). */
export const MAX_INPUT_TEXT = 2000;
const MAX_DELTA = 10_000;
const MAX_SIDE = 100_000;
const BUTTONS: readonly BrowserButton[] = ['left', 'middle', 'right'];
/** Control characters other than tab and line breaks. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const KEY = /^[^\u0000-\u001f\u007f]{1,32}$/;
const CODE = /^[A-Za-z0-9]{0,32}$/;

function bad(field: string): never {
  throw new WorkforceError('bad_request', `Invalid browser input (${field}).`, { details: { param: field } });
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad(field);
  return value as Record<string, unknown>;
}

function int(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) bad(field);
  return value as number;
}

function number(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) bad(field);
  return value;
}

/** A point on the frame: x/y inside width × height. */
function point(o: Record<string, unknown>): { x: number; y: number; width: number; height: number } {
  const width = number(o.width, 'width', Number.MIN_VALUE, MAX_SIDE);
  const height = number(o.height, 'height', Number.MIN_VALUE, MAX_SIDE);
  return { x: number(o.x, 'x', 0, width), y: number(o.y, 'y', 0, height), width, height };
}

type Mouse = Extract<BrowserInput, { kind: 'mouse' }>;
type Key = Extract<BrowserInput, { kind: 'key' }>;

/** One input of the person (see BrowserInput). */
export function inputOf(value: unknown): BrowserInput {
  const o = record(value, 'input');
  const modifiers = int(o.modifiers, 'modifiers', 0, 15);
  switch (o.kind) {
    case 'mouse': {
      if (o.type !== 'down' && o.type !== 'up' && o.type !== 'move') bad('type');
      if (o.button !== undefined && !BUTTONS.includes(o.button as BrowserButton)) bad('button');
      const mouse: Mouse = { kind: 'mouse', type: o.type, ...point(o) };
      if (o.button !== undefined) mouse.button = o.button as BrowserButton;
      const buttons = int(o.buttons, 'buttons', 0, 7);
      const clicks = int(o.clicks, 'clicks', 1, 3);
      if (buttons !== undefined) mouse.buttons = buttons;
      if (clicks !== undefined) mouse.clicks = clicks;
      if (modifiers !== undefined) mouse.modifiers = modifiers;
      return mouse;
    }
    case 'wheel': {
      const deltaX = number(o.deltaX ?? 0, 'deltaX', -MAX_DELTA, MAX_DELTA);
      const deltaY = number(o.deltaY ?? 0, 'deltaY', -MAX_DELTA, MAX_DELTA);
      return modifiers === undefined ? { kind: 'wheel', ...point(o), deltaX, deltaY } : { kind: 'wheel', ...point(o), deltaX, deltaY, modifiers };
    }
    case 'key': {
      if (o.type !== 'down' && o.type !== 'up') bad('type');
      if (typeof o.key !== 'string' || !KEY.test(o.key)) bad('key');
      const code = o.code ?? '';
      if (typeof code !== 'string' || !CODE.test(code)) bad('code');
      if (o.repeat !== undefined && typeof o.repeat !== 'boolean') bad('repeat');
      const key: Key = { kind: 'key', type: o.type, key: o.key, code };
      const keyCode = int(o.keyCode, 'keyCode', 0, 255);
      if (keyCode !== undefined) key.keyCode = keyCode;
      if (modifiers !== undefined) key.modifiers = modifiers;
      if (o.repeat === true) key.repeat = true;
      return key;
    }
    case 'text':
      if (typeof o.text !== 'string' || !o.text || o.text.length > MAX_INPUT_TEXT || CONTROL.test(o.text)) bad('text');
      return { kind: 'text', text: o.text };
    default:
      return bad('kind');
  }
}

/** The tab the person saw (its id, 't2'). */
export function tabOf(value: unknown): string {
  if (typeof value !== 'string' || !/^t\d{1,6}$/.test(value)) bad('tab');
  return value;
}

/** A takeover request: on, an optional http(s) address to open the closed browser at, wake. */
export function takeoverOf(o: Record<string, unknown>): BrowserTakeoverRequest {
  if (typeof o.on !== 'boolean') throw new WorkforceError('bad_request', 'Say on: true to take the browser over or on: false to hand it back.');
  if (o.url !== undefined && o.url !== null && (typeof o.url !== 'string' || !o.url.trim() || o.url.length > 2000 || /[\r\n]/.test(o.url))) {
    throw new WorkforceError('bad_request', 'url must be a web address.');
  }
  if (o.wake !== undefined && typeof o.wake !== 'boolean') throw new WorkforceError('bad_request', 'wake must be true or false.');
  return { on: o.on, ...(typeof o.url === 'string' ? { url: o.url } : {}), ...(typeof o.wake === 'boolean' ? { wake: o.wake } : {}) };
}

/** Exactly one of tab, url, action (back, forward, reload) or window (show, hide). */
export function steerOf(p: Record<string, unknown>): BrowserSteer {
  const given = ['tab', 'url', 'action', 'window'].filter((key) => p[key] !== undefined && p[key] !== null);
  if (given.length !== 1) throw new WorkforceError('bad_request', 'Give exactly one of tab, url, action or window.');
  if (typeof p.tab === 'string' && /^t\d{1,6}$/.test(p.tab)) return { tab: p.tab };
  if (typeof p.url === 'string' && p.url.trim() && p.url.length <= 2000 && !/[\r\n]/.test(p.url)) return { url: p.url };
  if (p.action === 'back' || p.action === 'forward' || p.action === 'reload') return { action: p.action };
  if (p.window === 'show' || p.window === 'hide') return { window: p.window };
  throw new WorkforceError('bad_request', 'tab is a tab id like t2, url a web address, action back, forward or reload, window show or hide.');
}

/** The agent a live-view call is for, and its params (only `agentId` and `extra`). */
export function browserTarget(params: unknown, extra: readonly string[] = []): { agentId: string; o: Record<string, unknown> } {
  const o = input(params);
  onlyKeys(o, ['agentId', ...extra]);
  return { agentId: id(o, 'agentId'), o };
}

/** {agentId, after?: {state?, frame?}, maxBytes?, waitMs?} of browser.pull (`extra`: further keys passed over). */
export function pullOf(params: unknown, extra: readonly string[] = []): BrowserPullRequest {
  const { agentId, o } = browserTarget(params, ['after', 'maxBytes', 'waitMs', ...extra]);
  const request: BrowserPullRequest = { agentId };
  if (o.after !== undefined && o.after !== null) {
    const after = obj(o, 'after');
    onlyKeys(after, ['state', 'frame'], 'after');
    request.after = { state: optNum(after, 'state', { min: 0, max: MAX_AT }), frame: optNum(after, 'frame', { min: 0, max: MAX_AT }) };
  }
  request.maxBytes = optNum(o, 'maxBytes', { min: PULL_MIN_BYTES, max: PULL_MAX_BYTES });
  request.waitMs = optNum(o, 'waitMs', { min: 1000, max: PULL_WAIT_MAX_MS });
  return request;
}
