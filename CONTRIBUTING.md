# Contributing to omnishell

For changing the interpreter itself. `README.md` is the pitch, `GUIDE.md` is
the app author's page, `docs/2026-07-30-the-binding-vocabulary.md` is the
reference for what a screen may say, and `docs/` holds the arguments behind
each design.

## Layout

```
interpreter/       the runtime: vanilla ES modules, no build step
  screen.js        the binder — regions, rows, attributes, events, and the
                   chart executor, whose grammar is ../machine.cue
  fragment.js      the filter/select/read grammar, parsed once for both readings
  data-crud.js     the store adapter
  render.js        the renderer's node schema and allowlists
  hatch.js         the vendored-unit boundary; hatch-worker.js is its worker half
  membrane.js      the read-only DOM membrane handed across the SES boundary
  jessie.js        module resolution and the denied-globals list
  lint.ts          the markup rules, stated beside the vocabulary
  *-smoke.js       the fast tier (deno + linkedom)
check-*.ts       compile-time checkers
test/            unit tests for the checkers and lint rules
playwright-tests/ the browser tier
src/             the React library, published as @omnishell/core
```

## Two invariants worth knowing before you change anything

**The interpreter has no build step, and that is load-bearing.** A screen is an
interpreted artifact so the file a reviewer signs is the file that executes;
every rung of the ladder below the screen assumes those are the same thing. The
checkers are free to be TypeScript — they run at compile time and never reach a
reader's page — but the runtime stays vanilla ES modules.

**A declaration and a value are bound differently.** Most attributes take
`{field}` and are interpolated against the row. The `REGION_ATTRS` set in
`screen.js` is held back on purpose: those are declarations a region resolves
later, against a row the binder is not the one holding. Binding an order map
once would answer its first key forever — a sort that never sorts again. The
same distinction explains the other two special cases, and both come from the
empty string not meaning absence: a URL still carrying a placeholder is
neutralised, because `src="{image_url}"` is a relative path the document fetches
the moment the tree connects; a bound boolean attribute is dropped when empty,
because `disabled=""` is disabled.

## The loop

Four tiers, fastest first. Pick the cheapest one that can actually see your
change:

| Tier | Command | Sees |
|---|---|---|
| smokes | `just test` | the binder, machines, rendering, data flow |
| unit | `just test` | checkers and lint rules |
| browser | `deno task pw` in `playwright-tests/` | focus, layout, real timing |
| visual | `just integrate` | a rendered app in a cluster |

**Choosing between the first and the third is usually the whole decision.**
linkedom gives the smokes their speed by answering a useful subset of the DOM,
and the subset stops exactly at focus and layout: it answers `focus()` and
never sets `activeElement`, so a roving tabstop, a caret or a `data-focus` move
passes a smoke whether or not focus actually moved. Those belong in
`playwright-tests/`.

The related quirk is worth knowing because it looks like a bug in your code: a
`<template>`'s children stay parented to the template under linkedom, so
`getElementById` answers from markup that never rendered. Its selectors are
already correct, so the harness closes the one method by rejecting a hit whose
`closest("template")` is not null. That is why the library has not been
swapped — happy-dom and jsdom are more faithful, and one method is cheaper to
correct than the tier is to slow down.

**Time is drivable.** `?clock=manual` with `__prontoClock.advance(ms)`, plus
`?tempo=` and `?seed=`, are in `screen.js`. Walk the clock rather than sleeping.

## Common tasks

**Adding a binding.** Answer it in `screen.js`, add its row to
`docs/2026-07-30-the-binding-vocabulary.md`, and — if it constrains what a
screen may say — put the rule in `interpreter/lint.ts` so a wrong declaration
is a compile-time error rather than a runtime mystery. The table is the only
place the vocabulary is listed together, and it drifts when the first two steps
happen without the third.

**Adding a smoke.** `.vscode/tasks.json` names the file set twice: `cache-smokes`
pre-caches its deps, `test-smoke` runs it. A file in one list and not the other
does not run, and does not complain. (`membrane-smoke.js` is in neither today.)

**Changing the visual battery.** `check-visual.ts` measures one settled moment
per route, where settled means the geometry fingerprint stopped changing. Two
consequences shape what it can assert: a perpetual animation never settles, and
it never hovers. Both are tracked in `plugins/pronto/PENDING.md`.

## Getting it in

`just build` type-checks; `just test` does not, so a type error survives a green
test run. Run `just integrate` when you touch anything the battery observes —
the visual tier lives in a cluster, and it is the only place a real stylesheet
and a real layout meet the markup.
