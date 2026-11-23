---
name: memory
description: I read this when I want to keep something for later or look for what is already known. It shows how the memory tree works - folders of Markdown files for the company, each branch and each agent, how to write, find, correct, pin and forget entries.
metadata:
  modes:
    - general
    - manager
    - secretary
    - research
    - writing
    - finance
---

# Memory

Memory is plain files in `<data>/memory` (the data folder; `memory.browse` shows it). No list of it ever goes into
anybody's prompt, so it can grow without limit. I open what I need.

## The tree

- `company/` - what the whole company knows. `company/websites/<host>/`, `company/apps/<name>/`, `company/modes/<key>/`
  hold what was learned about a site, an app or a kind of work.
- `branches/<space>/` - what one branch knows.
- `agents/<agent>/` - what one agent keeps for itself. This is where `memory.write` goes by default.
- `references/<person>/` - people's own words, reasons and corrections (skill reference-curator).
- `chats/<chat>/` - notes for one chat only.
- Any topic subfolder I find useful, as deep as it helps: `company/kunden/mueller/`. `_folder.md` says what a folder is for;
  I write one when the name does not say it.
- A file in a `pinned/` subfolder of company, my branch, my own folder or this chat is always in the prompt, together with
  the few skills marked `always` – one set under one cap: a short text stands whole, a long one by its description.
  So a pinned note stays tiny and always relevant.

One entry is one Markdown file:

```
---
title: Rechnung Müller
description: Beim Abrechnen mit Müller – zahlt per Lastschrift, keine Rechnung zum Überweisen schicken.
kind: fact
tags: [kunde]
updated: 2026-11-01T09:30:00.000Z
source: human
valid-to: 2026-12-31T00:00:00.000Z
---

Zahlt per Lastschrift.
```

`kind`: fact, preference, experience, procedure, plan, note. The `description:` is the line my later self gets as a hint
when a request touches the note: when it matters and what it changes. `memory.write` asks for it; a note without one
hints with its first words.

## Tools

- `memory.browse {folder}` - a folder: its description, subfolders, newest files.
- `memory.read {path}` - one file.
- `memory.write {folder or path, title, text, description, kind, tags, source, pinned, validFrom, validTo}` - creates or updates. The
  same title (or clearly the same content) in a folder updates that file; the old state stays as a version for a while.
  `pinned` moves it into or out of the folder's `pinned/`, which stands in its readers' prompt.
- `memory.forget {path}` - deletes a file for good.
- `knowledge.find {query, in: ["memory/company", "memory/agents/<me>"]}` - finds notes by their words: whatever is written or
  edited here is findable at once. The names and words a note itself would carry find it best. I name the folders that
  fit, or leave `in` out for what is mine to read – company, my branch, my own folder, my chats, the references – together
  with the knowledge catalog: skills and my home project's instructions. Another agent's own folder I name when I want it.
  Where a person chose an embedding model, it finds by meaning as well.

Memory and skills are one knowledge system, the public library (`library.find`) its shared shelf: Markdown with a little front matter. What is small and
factual goes to memory as a pointer; a way of working I read before a kind of work is a skill (skill writing-skills); what helps
everyone outside this company can go public (`library.publish`).

I can also edit the files directly with any tool or editor. The app sees the change and makes it findable.

## What I do

A note is a small pointer for a later me: it makes me think of something I would otherwise not think of – such as that
WhatsApp runs as the desktop app here. It is not an instruction for a kind of work; a way of working that needs more than
a few lines is a skill. When an exchange taught me such a thing, I keep it: one thing per file, short, dated, its title
and description in the words a later request would use. Before
I start a turn my subconscious hands me the hint lines of the notes that fit, and I open one when I need the rest. I
search before I write, so one fact stays in one file. What to keep and how: the skill memory-hygiene.
