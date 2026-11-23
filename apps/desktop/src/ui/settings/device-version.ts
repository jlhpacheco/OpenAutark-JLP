// Feedback F25 (16.11.2026, "warum das hier nicht synchron läuft"): the app version each PC runs, as Settings › Devices
// writes it after a PC's line – "0.3.6 – behind server 0.3.8" when another listed PC runs a newer one, else just
// "0.3.8". The version comes with each PC's caps (runtime/devices/tools.ts localCaps); a PC on an older version sends
// none and shows none.
// Feedback 1b136d01 (19.11.2026): a PC that is behind and online gets an Update button on its row (DevicesGroup.tsx,
// system.update {device}) – updateOffered says when. Sicher-Runde 19.11.2026 (owner: "Update-Knöpfe als Leiste … jeden PC
// einzeln updaten oder alle auf einmal … ganz oben This PC"): E3 – only my own PCs (an employee's PC or my employer's
// refuses the update); the list split into "This PC" and the strip of the others (splitDevices); the PCs "Update all"
// presses, this PC last (updateQueue); the row's one action – Update or Wake (rowAction); and the words of what each
// updater answered (answerText, E4; updateAllText for several).
// Owns: these texts and decisions. Never: compares anything but the devices list carries, or starts an update itself.

import { compareAppVersions, type Device, type UpdateAnswer } from '../../shared/model/devices.ts';

type Listed = Pick<Device, 'id' | 'kind' | 'name' | 'caps' | 'status'>;

/** My own PC: no employee's PC (personId) and none I joined as an employee (an update there is that company's). */
export const isOwnPc = (device: Pick<Device, 'kind' | 'personId' | 'joinedAs'>): boolean =>
  device.kind === 'pc' && !device.personId && device.joinedAs !== 'employee';

/** Whether a PC's row offers its Update: my own PC that runs an older version than another listed PC, and is online. */
export function updateOffered(device: Pick<Device, 'id' | 'kind' | 'caps' | 'status' | 'personId' | 'joinedAs'>, list: ReadonlyArray<Listed>): boolean {
  return isOwnPc(device) && device.status === 'online' && versionHint(device, list).includes(' – behind ');
}

/** The version part of a PC's line in Settings › Devices; '' for a phone, a browser or a PC that sends no version. */
export function versionHint(device: Pick<Device, 'id' | 'kind' | 'caps'>, list: ReadonlyArray<Listed>): string {
  const own = device.kind === 'pc' ? device.caps.version : undefined;
  if (!own) return '';
  let ahead: { name: string; version: string } | undefined;
  for (const other of list) {
    const version = other.kind === 'pc' && other.id !== device.id && other.status !== 'revoked' ? other.caps.version : undefined;
    if (version && compareAppVersions(version, ahead?.version ?? own) > 0) ahead = { name: other.name, version };
  }
  return ahead ? `${own} – behind ${ahead.name} ${ahead.version}` : own;
}

/** The Devices group: "This PC" on its own at the top, the others (PCs first, then by name) in the strip under it. */
export function splitDevices<T extends Pick<Device, 'self' | 'kind' | 'name' | 'status'>>(list: readonly T[]): { self?: T; others: T[] } {
  const shown = list.filter((device) => device.status !== 'revoked' && device.status !== 'pairing');
  const others = shown.filter((device) => !device.self)
    .sort((a, b) => Number(b.kind === 'pc') - Number(a.kind === 'pc') || a.name.localeCompare(b.name));
  const self = shown.find((device) => device.self);
  return self ? { self, others } : { others };
}

/**
 * The PCs "Update all" presses, in order: every listed PC whose Update is offered (`offered`), this PC last – its update
 * closes this window (or the phone's way in), so the others hear their request first.
 */
export function updateQueue<T extends Pick<Device, 'self'>>(list: readonly T[], offered: (device: T) => boolean): T[] {
  const queue = list.filter(offered);
  return [...queue.filter((device) => !device.self), ...queue.filter((device) => device.self)];
}

/** "Update all (n)" shows when at least this many PCs are behind. */
export const UPDATE_ALL_FROM = 2;

/**
 * The one action in a row's fixed slot: 'update' (offered, see above), 'wake' (my own linked PC that is offline and
 * whose wake helper key it sent – its app is closed or it is away; runtime/devices/wake.ts) or nothing.
 */
export function rowAction(device: Pick<Device, 'id' | 'kind' | 'caps' | 'status' | 'self' | 'personId' | 'joinedAs'>, list: ReadonlyArray<Listed>, selfOffered = false): 'update' | 'wake' | undefined {
  if (device.self) return selfOffered || updateOffered(device, list) ? 'update' : undefined;
  if (updateOffered(device, list)) return 'update';
  return isOwnPc(device) && device.status === 'offline' && device.caps.wakeKey ? 'wake' : undefined;
}

export interface AnswerText { title: string; body?: string; tone?: 'error' }

/** E4: what a PC's updater answered to its Update, in words ("<PC>: already the newest official version (0.3.5)"). */
export function answerText(name: string, answer: UpdateAnswer | undefined): AnswerText {
  const next = answer?.availableVersion ? ` ${answer.availableVersion}` : '';
  switch (answer?.status) {
    case 'current': return { title: `${name}: already the newest official version${answer.version ? ` (${answer.version})` : ''}`, body: 'A newer number elsewhere is a local build, not an official update.' };
    case 'available':
      if (answer.automaticInstall === false) return { title: `${name}: update${next} available`, body: 'That PC installs it by hand – Settings › About there.' };
      return { title: `${name} is downloading${next}`, body: 'It installs it and starts again by itself.' };
    case 'downloading': return { title: `${name} is downloading${next}`, body: 'It installs it and starts again by itself.' };
    case 'downloaded':
    case 'installing': return { title: `${name} is installing${next}`, body: 'It closes and starts again by itself.' };
    case 'error': return { title: `${name} could not update`, body: answer.message ?? 'Its updater reported an error.', tone: 'error' };
    case 'development': return { title: `${name} runs a development build`, body: 'It has no updater.', tone: 'error' };
    case 'checking':
    case 'idle': return { title: `${name} is checking for the update`, body: 'It installs a newer version by itself when it finds one.' };
    default: return { title: `${name} got the update request`, body: 'Its Autark is older and does not say what it found; it installs a newer official version by itself.' };
  }
}

/** One PC's part of the "Update all" summary. */
function shortAnswer(result: { answer?: UpdateAnswer; error?: string }): string {
  if (result.error) return result.error;
  const answer = result.answer;
  const next = answer?.availableVersion ? ` ${answer.availableVersion}` : '';
  switch (answer?.status) {
    case 'current': return `already the newest${answer.version ? ` (${answer.version})` : ''}`;
    case 'available': return answer.automaticInstall === false ? `install${next} by hand` : `downloading${next}`;
    case 'downloading': return `downloading${next}`;
    case 'downloaded':
    case 'installing': return `installing${next}`;
    case 'error': return `could not update${answer.message ? `: ${answer.message}` : ''}`;
    case 'development': return 'development build';
    case 'checking':
    case 'idle': return 'checking';
    default: return 'asked';
  }
}

const GOING = new Set(['available', 'downloading', 'downloaded', 'installing', 'checking', 'idle', undefined]);

/** The one toast after "Update all": how many go on, and each PC's part ("Laptop: already the newest (0.3.5)"). */
export function updateAllText(results: ReadonlyArray<{ name: string; answer?: UpdateAnswer; error?: string }>): AnswerText {
  if (results.length === 1) {
    const [one] = results;
    return one.error ? { title: `${one.name} could not update`, body: one.error, tone: 'error' } : answerText(one.name, one.answer);
  }
  const going = results.filter((result) => !result.error && GOING.has(result.answer?.status) && !(result.answer?.status === 'available' && result.answer.automaticInstall === false)).length;
  const failed = results.some((result) => result.error || result.answer?.status === 'error');
  return {
    title: `Updating ${going} of ${results.length} PCs`,
    body: results.map((result) => `${result.name}: ${shortAnswer(result)}`).join(' · '),
    ...(failed ? { tone: 'error' as const } : {}),
  };
}
