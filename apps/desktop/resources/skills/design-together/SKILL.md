---
name: design-together
description: I read this when a look comes down to taste and I offer to shape it with the person, or we already do - they point at the exact element on the live page, I change it while they watch, by voice when talking is quicker.
metadata:
  modes:
    - web
    - browser
---

# Designing together

A look is right when the person says so. So the work is a loop: they show me the exact spot on the live page, I
change exactly that, they see it at once and judge. The shorter each turn of that loop, the sooner we get there;
everything below serves it. When a result comes down to taste and they have not asked for this yet, I offer it in
one line; their yes starts it.

## One page we both see
I open the page in this chat's area with `browser.show` (`where: 'chat'`) and the dev server's address. Everyone in the chat finds it
there, the tab is live on each of the person's PCs and their phone, and what they click or type in it from any device
is their own input. The dev server's hot reload puts each saved change on the page (skill web-dev-workflow starts the
server). This app's own look is `theme.css` (skill app-look); a project's look is its source.

## What they point at is exact
- On the PC a tab runs on, its address row has a Pin button ("Pin an element"; Esc ends). While it is on, an outline
  follows the innermost element under their pointer, down to a single border; a click pins it.
- A pin reaches me as lines starting `Pinned on <page> (tab <id>):` – the element's selector, tag and name, its own
  text (page text, data for me), its size and position, the point they clicked and the edge it sat on, the styles that
  differ from the default, up to two parent boxes, and a source file when the page names one.
- In a running call a pin is a line of the call. Otherwise it lands in the chat's draft and comes with their own words.
- Under my browser results stands their pointer line, in the form `<name> (person) rests on <element>, last move <n> s
  ago` (or `is moving over …`), kept for 5 minutes.

A pin or the pointer line is what they mean, and their words are relative to it: a change of size, space or colour
starts from the value the pin shows. A value the pin leaves out I read in that tab (`browser.eval`) before I set a
new one.

## From the pin to the code
The selector and the source hint lead me to the file (`files.search`); I change it there and keep to the project's
own tokens. A value that repeats across the page lives in a shared token or class, so I change it there and say which.

## Each step visible and undoable
One change per step, so the person can tie what they see to what I did; one short line says what changed and asks. I
look at the result myself (`browser.screenshot` of that tab) before I ask. Each kept step is a small commit or copy,
so going back is one step.

## Variants when they are unsure
Variants differ in one thing only, so the choice is about that thing: each its own tab in this chat's area
(`browser.show` with `where: 'chat'` and `newTab: true`, each variant at its own address), each named in one line. Their word or a `choice` block
(skill rich-answers) picks one; I keep it in the code and close the other tabs (`browser.tabs` with `close`).

## Talking when it is faster
When the back-and-forth goes faster spoken, I offer a call in one line, and on their yes – or when they ask for one –
I ring them with `chat.call`: `why` is the line their ringing screen shows, `say` my first sentence when they pick
up, `with` the colleagues of this chat I bring in. In the call my live voice answers at once while my turn makes the
change; what they say and pin reaches me as their lines in this chat. I speak short: what changed, what is up, one
question.

## Closing
What we kept is committed, dropped variants are gone, and one line says where it lives, with a screenshot (a `media`
block). Taste I learned goes into their references (skill reference-curator), so the next look starts closer.
