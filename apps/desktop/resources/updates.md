# Autark updates

One section per version, newest first. Each says what changed and, for what an older version may have left behind on a
PC, how it shows, how I check for it and how I fix it. With every new version the personal manager reads the sections
since the version its PC ran before, looks through its company and puts right what it finds. A release adds its section
here before it ships (the release check looks for it).

## 0.3.18

What changed: linked PCs and phones keep each other current by themselves – a message a shaky connection lost arrives
within two minutes, and once from the start after either PC changes version. Who works where travels as a pulse of a few
characters and leaves the live bar within seconds when it stops; a context fold shows there as "Folding its context".
Every window and phone notices a dead connection by itself and loads everything again. Settings no longer get lost
between PCs on different versions. Codex keeps itself current like Claude Code, so a provider's new models appear by
themselves. Card numbers and other secrets on web pages and in screen readings are masked by their label and their
grouping now, not only in their exact stored form. On an employee's PC the company's name and the person's name come from
the company every time the link is up. Settings › Security offers two modes: Trust AI mode – the open system of
before, which every existing PC keeps, so agents still operate the lock screen and Windows prompts themselves – and
Secure mode, which closes capabilities behind switches and asks the person; it is only ever on when the person chooses
it. After each version change the personal manager wakes with these notes and checks the company.

**Secure mode on without the person choosing it.** Shows as: Settings › Security shows Secure mode, or agents are asked
for steps they did freely before, although nobody switched it. I check: the security section of settings.json and the
chats for the person's word on it. I fix it: nothing on my own – I tell the person in one line which mode is on and
that Trust AI mode is the one this PC had before; the person switches.

**A card number in plain digits in our notes.** Shows as: before this version a card number could reach an agent in plain
digits when a page or a form showed it grouped ("4111 1111 …") or as a field's value; an agent may have written it into a
memory note, a file or a chat line, or written itself a workaround such as "no screenshot while a card form is open".
I check: memory.browse, files.search and chat.search across our company for groups of digits that form a card number,
and for such workaround notes. I fix it: the digits become the secret's ID (secrets.list names it), a line of mine I edit
with chat.edit, a note I rewrite, and a workaround note I delete – the masking does that job now.

**The newest ChatGPT models missing.** Shows as: models.list lacks the newest GPT models of a ChatGPT plan. I check:
which Codex this PC runs – a copy under %LOCALAPPDATA%\OpenAI\Codex\bin\ (or inside Codex.app on a Mac) belongs to the
Codex desktop app. I fix it: a Codex from its installer or from npm updates itself within a few hours of this start, and
the models follow; the Codex desktop app's own copy updates only when that app is opened, so there I tell the person in
one line that opening the Codex app once brings the new models.

**"company-2" or a PC's name instead of our company's name on an employee's PC.** Shows as: on a PC that joined our
company as an employee, the company menu names the company after its folder or after one of our PCs. I check:
devices.list – each employee PC's caps.version. I fix it: an employee PC on this version takes our name and its person's
name from us by itself within two minutes; to the person of one that still runs an older version I say in one line that
updating Autark there puts it right.

## 0.3.17

- Windows: Opt in to signing in after a restart using a password from the
  secrets catalog. No password is stored or used unless you enable the
  feature. The broker stops retrying after a rejected password or repeated
  failures. The screen locks by default once Autark starts.
- Development: Standard runtime tests use loopback instead of LAN
  listeners. Real WebRTC and Windows TCP checks still run explicitly in CI.
