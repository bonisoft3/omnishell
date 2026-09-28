---
type: concept
title: Visual lint
description: The Playwright DOM checks and vision review over a rendered app — what each check needs to be sound, where it runs, and how shared checks change.
---

# Visual lint

Visual lint is the Playwright DOM checks and the vision review run over a
rendered page; [automated tests](automated-tests-battery.md) are the other
suite, running an app's Jessie modules with no page at all.

## What it checks

[`check-visual.ts`](../check-visual.ts) opens every route in `shell/shell.yaml`
against the running app at 1280×900 and 400×900, waits for each to settle, and
runs the shared checks in [`src/lint/playwright/checks/`](../src/lint/playwright/checks/)
plus a placeholder scan of its own. Findings are `{severity, path, message}`,
and only `critical` fails the verb.

| Severity | Checks |
|---|---|
| critical | `interactive-overlap`, `clipped-controls`, `contrast` under the WCAG floor in each appearance `color-scheme` claims, console errors, placeholder leaks, a page that cannot open |
| major, minor | `touch-targets`, `clipped-content`, `focusable-invisible`, `constrained-images`, `horizontal-overflow`, `viewport-bounds`, `focus-order`, `cls`, console warnings |

A placeholder leak is binding text (`{col}`) painted on screen, sampled every
frame from first paint and again once settled — the runtime twin of a static
placeholder rule that is [not built](../../pronto/PENDING.md#screens). A region
that shows braces on purpose says so with
[`data-verbatim`](../REFERENCE.md#structure).

Coverage is reported, not assumed. A route param no read filters on, or one no
row can fill, is a `major` saying the route went unlinted; so is a route that
renders `gone` or is still moving at the settle cap. A param is filled from the
seed where the store reads that table locally, else from `/crud` as a guest.

**Settled** means no DOM mutation, no moved box, no image loading and no finite
animation running for 100 ms, capped at 2.5 s. So a perpetual animation never
settles and nothing is ever hovered
([what it cannot see](../../pronto/PENDING.md#visual-lint)).
It never waits for `networkidle`, which Electric's open shape connections never
reach.

`theme-stability` is not run: it toggles a `.dark` class, pronto themes through
`prefers-color-scheme` and `-dark` states, and the toggle changes no computed
colour, so it would pass without measuring. `touch-targets` returns nothing
above 768px, so only the narrow viewport measures it.

## What a check needs

A check's need decides where it can run.

- **A rendered page only** — computed style or a box's own overflow: console,
  placeholder leaks, `constrained-images`, `contrast`, `focusable-invisible`,
  `clipped-content`, `clipped-controls`.
- **The viewport to be the screen** — measured against `window`:
  `touch-targets`, `focus-order`, `interactive-overlap`, `viewport-bounds`,
  `horizontal-overflow`, `cls`.
- **A cluster** — real rows rather than fixture text; shell chrome over content,
  `interactive-overlap`'s best target; anything a handler or unit opens; param
  values a server table holds.

## The container is not the viewport

The storybook (`?storybook`) needs no cluster: it renders every state of a route
against fixtures, ahead of the auth gate and the store, with no handler
evaluated and no unit mounted. But each state is a 360px `.frame` with
`overflow: hidden` on a flex-wrap board, and every geometry check resolves
against `window`, which is the board.

Width: a frame is a flex item that may shrink, coupled to the viewport and never
equal to it. `touch-targets` switches off exactly when frames are phone-shaped;
a frame's overflow never widens the document, so `horizontal-overflow` and
`viewport-bounds` cannot fire; `focus-order` reads each frame boundary as a
backward jump; `cls` measures the harness appending frames. Pronto emits no
`container-type`, so a frame is honest about width only where an app declares
`container-type: inline-size` on a screen and answers width with container
queries, which two apps do.

Height has no answer even there: `inline-size` sets no block axis, so `vh`
inside a frame resolves against the board, and a frame as tall as its content
has no fold. The storybook is at best sound for width-driven layout, and
unsound for anything height- or viewport-anchored — the fold, sticky and fixed
positioning, scroll containment, `vh` spacing. So `check-visual.ts` measures
the served app. A root option per check, `window` by default, would let the
width-driven checks run on the storybook below `integrate` with no cluster.

## Where it hooks

[`terminal.cue`](../terminal.cue) declares `checks: visual` at `integrate`, which
emits it into every app's `.say.yaml`: `docker compose up --build launch`, then
`check-visual.ts` in a container beside the app (bayt's integrate closure, with
`APP_URL` at caddy), so an app's own toolchain needs no Node and no Playwright.
`--build` because compose reuses any image it has and would lint the previous
build; not `--force-recreate`, which recreates the dependencies and empties the
database a rows-first screen needs to settle. It cannot be `lint`, which
promises to do no work.

`floors.touch` is one declaration in `terminal.cue`: the `--min-touch` rung the
design scale publishes and the size `touch-targets` holds a control to. A
default in the checker would be a second number.

The vision review (`vision-review.ts`) sends a full-page screenshot and a
context prompt to a model and fails at a chosen severity. Iris and snapcards
call it; no pronto app does. Its home is `verify`: non-deterministic and paid,
it lands after the deterministic half, and a storybook board of every state is
a better prompt than one screen. Without `@anthropic-ai/sdk` or
`ANTHROPIC_API_KEY` it warns and passes, so a green run may have reviewed
nothing; it should throw.

## Touching shared code

`src/lint/playwright/` reaches iris (through `@omnishell/core/playwright/visual-lint`),
snapcards (by relative path), omnishell's own `playwright-tests/` — where
`visual-lint.pw.ts` asserts on `visualLint`'s output — and `check-visual.ts`.
Iris filters `theme-switch-stability` out as flaky. So **no check's default
behaviour changes**: what one consumer needs arrives as an optional parameter
defaulting to the shared behaviour, as `touch-targets`' `minSize` (44 unless
told) does. A check shaped to one consumer lives with it, as the placeholder
scan lives in `check-visual.ts`.

Emitted screens carry no `data-testid`, so a finding names its element by
`aria-label` or text: not unique, and not addressable back to `program.cue`.
An identity the emitter stamps would make a finding actionable.

## Rejected

- **The storybook as the host.** No cluster to boot, but half the checks answer
  about the board, and no fold, shell chrome or opened surface exists there.
- **Failing on `major` or `minor`.** A gate that fails on advice is muted within
  a week, taking the criticals with it.
- **Appearance through `.dark`.** `theme-stability` passes on pronto without
  measuring; `contrast` reads each claimed `color-scheme` instead.
- **The `route-coverage` crawler.** It reads `*.tsx` routes and crawls path URLs
  from `/login`; pronto's routes are `shell.yaml`'s, derived rather than
  discovered.
- **A constant wait instead of settling.** Sized for the slowest screen, paid by
  every screen, and still a guess on the slowest.
- **A shared default changed for pronto.** Two shipped apps and omnishell's own
  tests read the shared default.
