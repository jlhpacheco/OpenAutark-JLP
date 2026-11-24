// Eine-ID 22.11.2026 in the UI (owner: one ID per company, one per person, "nicht mehr dieses Auswählen zwischen Mitarbeiter
// und so weiter"): Settings › Devices shows "Company ID" first and "My ID" – each only once it exists, the phone QR only
// with the company's ID –, no role anywhere a PC connects (the connect field, nearby rows, the first run's card, the
// company menu's "+"), my profile name goes with the request and "Your name" changes it while I wait as a new member, a
// new member's request opens with the name field prefilled from the name they proposed (a person to pick only where this PC
// is no member's – review L7), "Yes, add" before this PC becomes another person's device (review H1), and the first-run
// card leaves ending the first run to the runtime (it closes when the step is 'done').
// Owns: these assertions on the sources (a .tsx file cannot run under node --test). Never: renders or calls a runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/ui');
const read = (file: string) => readFileSync(path.join(UI, file), 'utf8');
const code = (file: string) => read(file).replace(/^\s*\/\/.*$/gm, '').replace(/\/\*\*[\s\S]*?\*\//g, '');

test('Settings › Devices: Company ID first, then My ID – each only when it is there; the phone QR only with the company\'s ID', () => {
  const rows = code('settings/connect-rows.tsx');
  assert.match(rows, /\{self\?\.companyId && <IdRow label="Company ID" id=\{self\.companyId\} hint=\{remoteIdHint\(props\.relay, self\.findable, COMPANY_ID_BASE\)\} \/>\}\n\s*\{self\?\.myId && <IdRow label="My ID" id=\{self\.myId\} hint=\{MY_ID_HINT\} qr=\{props\.myIdQr\} \/>\}/);
  assert.match(rows, /onClick=\{copy\}>Copy<\/button>\n\s*\{props\.qr\}/, 'two IDs: the QR sits in the My ID row, after Copy');
  assert.doesNotMatch(rows, /companyCode|My Remote ID|SEAT_ID_BASE|COMPANY_ID_HINT|RemoteIdRow/, 'the 21.11. seat variant is gone');
  const group = code('settings/DevicesGroup.tsx');
  assert.match(group, /\{can\('remote\.state'\) && <IdRows remote=\{props\.remote\} relay=\{props\.relay\} myIdQr=\{props\.remote\?\.self\.companyId \? <MyIdQr remote=\{props\.remote\} \/> : undefined\} \/>\}/);
  // two IDs, 23.11.2026: no third number and no own "Connect a phone" row – the QR beside My ID carries this PC's link
  assert.doesNotMatch(group, /label="Connect a phone"|PhoneQr|remote-slot-code|groupDigits\(digits\)/);
  assert.match(group, /rpc\.call\('phone\.pairLink'\)/);
  // two IDs, 24.11.2026: exactly two ID rows in "Add a device", and the QR shows no digits of its own (only an image)
  assert.equal(rows.match(/<IdRow /g)?.length, 2, 'Company ID and My ID, nothing else');
  assert.equal(group.match(/<IdRows /g)?.length, 1, 'the ID rows once in "Add a device"');
  const qr = group.slice(group.indexOf('function MyIdQr'), group.indexOf('type UpdateResult'));
  assert.match(qr, /<img class="remote-qr-code"/);
  assert.doesNotMatch(qr, /remoteId\}|groupDigits|\.remoteId\s*\)/, 'the QR\'s own ID is never written as text');
  assert.match(code('styles/remote.css'), /\.remote-qr\b[^{]*\{[^}]*(width|height)/, 'the QR box reserves its size before the image loads');
});

test('no role anywhere a PC connects: the ID typed decides; my profile name goes with the request', () => {
  const rows = code('settings/connect-rows.tsx');
  assert.doesNotMatch(rows, /JoinRole|role: props\.role|props\.role/);
  assert.equal(rows.match(/rpc\.call\('remote\.connect', connectParams\(/g)?.length, 2, 'the connect field and the nearby rows');
  assert.match(rows, /rpc\.call\('remote\.connect', connectParams\(nearbyTarget\(pc\)\)\)/, 'a nearby row asks with its company\'s ID');
  assert.match(rows, /return name \? \{ target, name \} : \{ target \};/);
  assert.match(rows, /placeholder="Company ID, your ID or an address"/);
  assert.match(rows, /\{member \? 'Your name' : 'Connect with an ID'\}/, 'one fixed row: its label and field change inside it');
  assert.match(rows, /<TextField label="Your name" placeholder="Your name" maxLength=\{80\} value=\{out\?\.myName \?\? profileName\(\)\} onCommit=\{rename\} \/>/);
  assert.match(rows, /rpc\.call\('remote\.name', \{ name: name\.trim\(\) \}\)/);
  for (const file of ['settings/DevicesGroup.tsx', 'onboarding/ConnectCard.tsx', 'onboarding/FirstRun.tsx']) {
    assert.doesNotMatch(code(file), /role=|JoinRole|'mine'|'employee'/, file);
  }
});

test('review H1: "Yes, add" (remote.confirm) takes Connect\'s place while the request asks to become another person\'s device', () => {
  const rows = code('settings/connect-rows.tsx');
  assert.match(rows, /const confirming = out\?\.status === 'confirm';/);
  assert.match(rows, /try \{ await rpc\.call\('remote\.confirm'\); \} catch \(cause\) \{ props\.onError\(errorText\(cause\)\); \}/);
  assert.match(rows, /\{confirming\n\s*\? <Button variant="primary" class="small" busy=\{busy\} onClick=\{confirm\}>Yes, add<\/Button>\n\s*: <Button variant="ghost" class="small"[^\n]*>Connect<\/Button>\}/, 'the same slot of the same row; Cancel stays in the line');
  assert.match(code('onboarding/ConnectCard.tsx'), /<ConnectRow remote=\{remote\.data\}/, 'the first run\'s card is the same row');
});

test('a new member\'s request: the name field first, prefilled with the proposed name; a person to pick only off a member\'s PC', () => {
  const rows = code('settings/connect-rows.tsx');
  assert.match(rows, /const choosable = props\.member \? \[\] : props\.people;/, 'review L7: on a member\'s PC the company makes the person');
  assert.match(code('settings/DevicesGroup.tsx'), /<IncomingRow key=\{request\.id\} request=\{request\} people=\{props\.people\} member=\{props\.remote\?\.self\.member === true\} \/>/);
  assert.match(rows, /const name = typed \?\? request\.proposedName \?\? '';/, 'it follows their name until someone types here');
  assert.match(rows, /incomingText\(request, settings\.value\?\.profile\.company\)/);
  assert.match(rows, /if \(event\.key === 'Escape' && \(phone \|\| choosable\.length\)\)/, 'the person select only where people can be picked');
});

test('the first run: one Connect card for "+ › Connect with an ID"; the runtime ends the first run, the card closes with it', () => {
  const card = code('onboarding/ConnectCard.tsx');
  assert.doesNotMatch(card, /goStep|IncomingRow/, 'no step written here; a company not set up yet takes no requests');
  assert.match(card, /const done = settings\.value\?\.onboarding\.step === 'done';\n\s*useEffect\(\(\) => \{ if \(done\) props\.onClose\(\); \}, \[done\]\);/);
  assert.match(card, /title="Connect with an ID"/);
  assert.match(code('onboarding/FirstRun.tsx'), /if \(start === 'join' && /);
});
