---
type: howto
title: Contributing to omnishell
description: Changing omnishell itself — the layout, the two invariants, the commands, which suite sees which change, and where each subsystem is argued.
---

# Contributing to omnishell

For changing omnishell itself. What a screen may say is
[REFERENCE.md](REFERENCE.md); how an app author uses it is [GUIDE.md](GUIDE.md).

## Layout

```
interpreter/       the runtime: vanilla ES modules, no build step
  screen.js        the binder: regions, rows, attributes, events, the chart executor
  fragment.js      the filter/select/read grammar, locales and route addresses
  data-sync.js     the store adapter; validate.js judges a write before it lands
  render.js        the renderer's node schema and allowlists
  hatch.js         the vendored-unit boundary; hatch-worker.js is its worker half
  jessie.js        module resolution, per-role endowments, the denied globals
  lint.ts          the markup rules, stated beside the vocabulary
  *-smoke.js       the smokes (deno + linkedom)
check-*.ts         the checks: omnishell check <name> through runtime/cli.ts,
                   and check-visual.ts at an app's integrate
instrument.ts, arbitrary.ts   the battery's fuel rewrite and input generators
machine.cue, terminal.cue     the chart grammar and the terminal's published surface
components/        the terminal's CUE components and shipped adapters
android/, ios/     the native hosts (docs/native-hosts.md)
test/, playwright-tests/      unit tests and harnesses; the browser suites
src/               the React library, published as @omnishell/core
```

## Two invariants

**The interpreter has no build step.** A screen is interpreted so the file a
reviewer signs is the file that executes, and the interpreter keeps that by
being the same bytes in the repo and in the page. Checkers may be TypeScript —
they never reach a reader's page — but the runtime stays vanilla ES modules.

**A declaration and a value are bound differently.** Most attributes are
interpolated against the row; `REGION_ATTRS` in `screen.js` are held back
because a region resolves them later, against a row the binder is not holding.
The URL and boolean exceptions share the root — the empty string is not absence
([REFERENCE.md](REFERENCE.md#placeholders)).

## Workflows

```bash
just setup     # tools via mise
just build     # deno check over src/, test/ and the command line
just test      # smokes, unit suite, the battery's self-test
just integrate # container build, then the browser and visual suites
```

`just test` runs with `--no-check`, so a type error surfaces at `just lint` (its
`types` rule) or `just build`, which run the same `deno check`.

| Suite | Runs from | Sees |
|---|---|---|
| smokes | `just test` (`interpreter/*-smoke.js`) | the binder, machines, rendering, data flow |
| unit | `just test` (`test/`) | checkers, lint rules, harnesses |
| browser | `just integrate` (`pnpm run test:browser`) | focus, `moveBefore`, real layout and timing |
| visual | `just integrate` (`pnpm run test:pw`, `check-visual.ts`) | a rendered app's geometry, settle, CLS |

linkedom answers `focus()` without setting `activeElement` and has no
`moveBefore`, so a roving tabstop or a focus move passes a smoke whether or not
it happened: where focus lands belongs in `playwright-tests/`
(`roving-tabstop.pw.ts`, `focus-target.pw.ts`), since a browser refuses
`focus()` on an element with no tabindex and a shim reports success. It also
keeps a `<template>`'s children parented to the template, which the harness
corrects by rejecting a `getElementById` hit inside one. happy-dom and jsdom
are more faithful and not used: one method is cheaper to correct than the
smokes are to slow down. Walk time with `?clock=manual` and
`__prontoClock.advance(ms)` rather than sleeping.

**Adding a binding**: answer it in `screen.js`, add its row to REFERENCE.md,
and put any rule it implies in `interpreter/lint.ts` — the reference drifts
when the first step happens without the others. **Adding a smoke**:
`.vscode/tasks.json` names it twice, in `cache-smokes` and `test-smoke`, and a
file in one list only never runs. **Adding a check**: a `check-*.ts` with
`run(args)` and `--self-test`, dispatched by `runtime/cli.ts`, declared in
`terminal.cue` under `checks` at the verb whose layer it needs — `lint` for
source and a compartment, `test` for running modules or mounting screens,
`integrate` for a served app — which emits `omnishell check <name> .` into every
app's `.say.yaml`. Findings are `{severity, path, message}` JSON, and
`advisory` is only for what the checker cannot reach.

## The subsystems

**The terminal** owns what cannot be federated and mounts units into boxes — a
compartment for app roles, an iframe or a worker seat for a vendored unit whose
answer the terminal parses: [terminal.md](docs/terminal.md).

**Data** reaches a screen as rows; a reduce answers with keyed writes, a refused
write comes back as an event, and a stored row meets a newer program through
fill and reconcile: [data.md](docs/data.md).

**Machines** author an interaction's lifecycle as data — the chart grammar,
effects and their levels, gestures, time — and their harnesses walk every
arrow: [machines.md](docs/machines.md).

**Focus and ARIA** are columns a region derives, and the tab order is the
terminal's: [accessibility.md](docs/accessibility.md).

**Screen updates** are how the terminal changes a rendered page: rows moved by
key, bodies replaced when their source changes, and state stamped as attributes
that stylesheets draw: [screen-updates.md](docs/screen-updates.md).

**Visual lint** measures a rendered app's geometry at `integrate`:
[visual-lint.md](docs/visual-lint.md).

**Automated tests** test every handler and validation module an app ships with
no test written by hand — inputs drawn from the app's schema, confinement,
termination through fuel, purity: [automated-tests-battery.md](docs/automated-tests-battery.md).

**Native hosts** run an app in a headless JS engine on Android and iOS, draw it
through DivKit, and hold it to the web screens with a parity check:
[native-hosts.md](docs/native-hosts.md).

Everything else: [docs/index.md](docs/index.md).
