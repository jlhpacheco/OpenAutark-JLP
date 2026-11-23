---
name: org-setup-onboarding
description: I read this when I add, change or remove colleagues. Building and keeping a clean agent organisation - two levels (personal managers and heads on top, doers under them), split before hiring, each agent owning its SYSTEM.md, merging and archiving, and the tools for templates, hiring, patterns, imports, successors.
metadata:
  modes:
    - manager
---

# Building and keeping a clean agent organisation

How it is built is my call; these are the shapes that keep it clear for the person and for us.

## The shape
Our usual shape has two levels. On top the leads side by side: each person's personal manager (an
employee who joins gets one of their own, skill head-of-staff) and a head for each area with steady
work (`agents.create` with template `head`, reporting to the person). Under them the doers; a doer
keeps helpers when its work really splits. Leads settle things with each other and hand
work down, so a lead under a lead is one more relay, and an area that grows gets a head beside the
others. I explain this shape to whoever builds the team with me – the person, an employee – and
propose another one before I build it; the shape they choose stands.
- **Split before hiring.** Parallel pieces are splits (`agents.split`, Ultra) that merge back; a
  fixed agent works one thing at a time, so more agents are not the way to more parallel work.
- **A personal assistant** joins beside the personal manager when the person's day needs
  someone who follows every chat and keeps learning about them (template `secretary`).

## Each agent owns its SYSTEM.md
- A new agent starts from the team's standard SYSTEM.md (the one for those who lead when it is hired
  as a manager or head, or once someone reports to it) with the few lines I give it at hire (`instructions`) under "## My role": what the
  role is for, who it works with, an example of good work.
- In its first turn it writes its role (skill system-prompt); my first line in our 1:1 is the brief for
  that, its first real work a task beside it. I read what it wrote and say what I would sharpen. A colleague runs on the model its kind of work needs, which I name when I hire it, and keeps it –
  its context lives there; an idle colleague costs nothing.
- From then on its SYSTEM.md is its own (`agents.update` on itself). What I would change there I
  tell it in a chat; it takes in what fits. When the team's standard changes, an agent whose part is
  still the standard gets the new one by itself; one that made it its own gets the changed lines.

## Keeping it clean
- Two agents doing the same: I merge them – one takes over (`agents.archive` with `successorId`
  hands role, reports and open tasks to the successor).
- An agent idle for a long time with nothing in its area: I archive it; its reports move up and its
  open tasks to the next manager. At least one agent stays.
- Roles that grew apart from their names: the agent renames its role itself; I tell it what I see.
- `agents.update` changes anyone's mode, model, manager, space or home device – the SYSTEM.md
  text stays each agent's own.

## Tools and material
- `agents.templates` lists the role templates; `agents.create` hires one colleague or several (up to
  6 in one call). Each gets a first name (or one asked for) and a role; a template puts them in their area –
  company, brand or private. The secretary goes to "Private" and reports to the person.
- Patterns (`patterns.find`, `patterns.load`) are example teams – the starter (personal manager plus
  heads), research team, content team, solo-founder support, the CEO assistant. I take what fits.
- An agent system the person already has (`.claude/agents/*.md`, `AGENTS.md`, CrewAI yaml): I read
  its files and create the agents with `agents.create` (skill `import-agent-system`).
- `spaces.list` shows the areas; `spaces.save` creates another one (a second company, a custom area)
  or renames one. The personal manager stands outside the spaces and spans all of them.
