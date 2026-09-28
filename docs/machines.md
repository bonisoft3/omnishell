---
type: concept
title: Machines
description: A chart over one browser-owned row whose transitions assign columns and emit typed effects the terminal performs, times and answers.
---

# Machines

A machine is the XState-JSON data subset the terminal executes itself, closed
over one row: `data-machine` on a region, `#Machine` in
[`machine.cue`](../machine.cue), key by key in
[REFERENCE](../REFERENCE.md#machines).

## Machine or reduce

A form mints keys where randomness exists, a reduce derives writes from rows,
and a machine states screen state as it changes: from TEA and Harel, a
transition emits a mutation as a pure descriptor and the store's answer returns
as an event. Machine or reduce is the author's choice: a chart is strongest
component-generated or with many states (an inventory a reviewer reads by
set-difference), weakest at two states around real arithmetic.

## The chart

- **Data, not code.** Sync-and-pure goes to Jessie, async-and-effectful to the
  terminal, anything addressed elsewhere through the store. Durable state is
  rows; the transient state of an interaction is a machine's, and no app chart
  carries code.
- **Closed over the row.** Leaves see `{items: [row]}` and the event, and every
  transition lands as one stated row through the `step()` a reduce uses, so
  replay, `?tempo=`, `?clock=manual`, `?seed=` and refusals apply with the
  machine knowing nothing. A foreign fact is derived into a column first. The
  row belongs to a `tab` or `device` entity — nothing keeps a server row's
  transitions — and other entities are reached only by effect. Nothing checks
  the durability: `writeLint` returns early for every other one and no other
  rule asks, so a `data-machine` over a `live` table mounts and writes its
  state there. A `check markup` rule would make it a build failure.
- **State names are the ARIA attribute's values** where one speaks the state,
  so one column is both the semantics and the styling hook.
- **Generated grammar is not vocabulary.** A spelling only a component writes
  (`<type>@<dom-id>`) may be ugly and change at will; one a human writes must
  survive the third case.

## Effects

A callback cannot be verified, rolled back or replayed, so an effect is a
descriptor whose level says what can be claimed of it
([table](../REFERENCE.md#effects)).

- **`sync_ack` is the store settling, not the server agreeing.** A write
  settles when confirmed or when the 2.5 s acceptance window closes with it
  still queued (`settle`, `interpreter/data-sync.js`), so `refused` can follow
  `sync_ack`, carrying no `token`. A chart that must hear the no in every state
  draws `refused` at the root `on:`.
- **A compensable effect draws `refused`**
  ([the lint](../REFERENCE.md#effects)), since a chart deaf to the no has a
  zombie state by construction. The rule is partial: the interpreter defaults
  an unlabelled effect to 2 and reads it nowhere, so an unlabelled upsert onto
  an `offline` or `live` entity ships a chart deaf to the server's no. Reading
  the level off the effect's entity, whose durability `shell.yaml` carries,
  would make the rule total.

## Gestures and cancels

The event vocabulary is the DOM's and the effect vocabulary ours; before
calling a wall a missing event, check which of the two it is.

- **Every cancel belongs to a gesture the markup declared** — a submit, a drag,
  a `data-key` keydown, an arrow answering a displacing type. The displacing
  set is closed ([the set](../REFERENCE.md#behaviour)) so growing it is a
  reviewed edit, and it holds only defaults incoherent to keep: an app menu and
  the UA's cannot both be what the reader asked for.
- **The cancel is the arrow's.** The default goes only where the standing state
  draws an arrow for the event, narrowed to this affordance or not, decided
  before any await, which `preventDefault` cannot survive. A keydown displaces
  only a roving key: a page scrolling while a tabstop moves is incoherent, a
  printable key is a reader typing.
- **Geometry is framed on the affordance.** Raw `clientX` loses the rendered
  position, where the menu clipped off the edge lives. The affordance's box is
  a frame the replay also renders: the surface anchors to it, `position-try`
  re-derives the clipping, and the app sees the quotient, never the divisor.
  Integer, because a replayed column should not be a float; measured only when
  a chart reads it, since it costs a synchronous layout.
- **A surface has one owner.** `data-open` re-derives openness on every bind,
  so a replay lands it; `data-interest` stores nothing, which is its licence —
  openness nobody stores cannot disagree with anything. Both on one surface
  are two writers of one fact: the row restating itself would shut a surface
  the reader is under. `data-interest` waits on the terminal's clock, so
  `?clock=manual` holds its delays still, and an `auto` popover makes WCAG
  1.4.13's dismissible clause the element's, so the terminal listens for no
  key ([the rules](../REFERENCE.md#behaviour)).

Keys and focus are [Focus and ARIA](accessibility.md).

## Time

A compartment with nothing endowed has no clock, so time arrives as an event
the terminal delivers — which is what makes confinement possible at all.
`{now}` enters only where the terminal performs the write. A reduce's
[`then`](data.md#the-step-after) re-wakes it after a delay; a machine's `after`
is the relocated `invoke`, being in the state *is* the pending timer. Every
wait is the terminal's, so `?tempo=` scales it and `?clock=manual` holds it for
`__prontoClock.advance(ms)`.

- **A reduce re-arming its own `then:` can double**: two chains find the armed
  phase and both re-arm. Carry a generation mark on the row, or use `after`,
  whose mark is the cancellation.
- **The mark cancels waits, not answers.** A `sync_ack` or `refused` from an
  attempt the chart has left lands in whatever state it stands in now, dropped
  only where that state draws no arrow for it or a guard compares the `token`.

## Bounded statecharts

SCXML runs to quiescence, which admits livelocks; TEA has no hierarchy and no
lifecycle cancellation. The terminal takes the middle:

- **No run-to-quiescence.** `raise` shares the reduce's
  [step cap](data.md#the-step-after). `always` and `onDone` hops within one
  transition stop at 10, silently, where they should throw the way a `raise`
  chain does.
- **A local timer never ends an inflight write**, nor does anything else a
  chart does: only the store's refusal withdraws one. So `after` moves into a
  nested pending state (`favoriting.delayed`, a degraded badge) while the parent
  keeps listening for `sync_ack`; a reader's `cancel` leaves the wait, not the
  write.
- **Parallel regions own disjoint columns** (`parallelLint`), so a write-write
  race is unrepresentable rather than arbitrated.
- **Final states chain lifecycles**: a hand's end starts the next phase through
  `onDone`.

## What stays provable

State is relational, modules run under SES with no ambient IO, guards are data
with literal params, and context is the row, which keeps an SMT reading of a
chart open: an invariant (`count >= 0`) under any order of clicks and refusals,
each guard's satisfiability (`UNSAT` is a dead arrow), a candidate list's
disjointness and coverage. No checker reads a chart this way, so an
unsatisfiable guard surfaces only as an arrow the walk reports never fired.

## Machine harnesses

Every check reads the chart and nothing else, from the emitted HTML: CUE tested
against CUE proves only that the parser read what the generator wrote, while
the HTML is the contract the reader touches, run the same however it was made.

- **The walk** (`test/walker.ts`, `omnishell check machines`) fires every arrow
  through the real interpreter on a Chinese Postman tour, one mount per region
  so a sibling's timer never comes due under another's walk, and replays the
  trace through XState's own `transition()`, which must land on the same field
  value. A never-fired arrow is an error. A guard param named after an event
  field says which event satisfies the arrow, so the walk synthesizes it; a
  chart reached only through an unseeded route param is advisory.
- **Posing** (`test/storybook-battery.ts`, over every app from
  `test/universal-storybook.test.ts`) reaches a state without a transition,
  since state is a column: seed `{[field]: state, ...context}`, mount under
  `handlers: false`, assert no store write — a story that mutated would drift
  every sibling baseline. Independent regions cost Σ|Sᵢ| frames, not Π|Sᵢ|;
  `includePairwise`, off in that run, pairs only a chart's first two regions,
  so interacting parallel regions are posed one at a time. It spends
  [fuel](automated-tests-battery.md#fuel), not wall-clock time.
- **The late acknowledgment** is driven through the interpreter by
  `interpreter/machine-v2-smoke.js` against a slow store.
  `test/outbox-simulator.ts` models the lifecycle as a queue no interpreter
  consults; only `apps/truco`'s tests drive it, and its `delayed` behaves as
  `offline`. A store adapter over it, handed to `mountScreen`, would let each
  app's `refused` and late-`sync_ack` arrows be walked the way the walk drives
  clicks.
- **Synthetic seeds** (`plugins/pronto/synthetic-seed.ts`): hand fixtures drift
  and random ones crash hydration on orphaned keys, so a seeded DuckDB query
  builds rows from `.pronto/facts.json` whose `_id`s name parent rows, reading
  only a CEL's enums and closed ranges, and keeps one member per `cur_`, `chk_`
  or `exp_` group reading true, so no posed row trips a set's one-current-member
  refusal. Run by hand; posing reads its committed `.pronto/seeds.json`.

## Rejected

- **Forms as the only mutation path** — two implicit states, no timeout, no
  coordinated rollback, nothing a checker reads; realworld's favourite fakes a
  lifecycle with a probe, two forms and sibling CSS.
- **`invoke`** — `after` is its relocation; the effect roster is the only `src`.
- **`sendTo`, `emit`, app actors** — addressed to someone else is a write
  observed through a read: recorded and lintable, never a message.
- **Actions naming JavaScript** — a chart is declarative only while its action
  vocabulary is closed and terminal-owned.
- **A per-app interpreter, `customElements.define`, shadow DOM** — every walker
  the interpreter has assumes one light tree.
- **`*` as a wildcard** — it would swallow `refused` and `sync_ack`.
- **Cancelling by event type** — one narrowed arrow would make a region inert.
- **Viewport pixels or fractions** — a resize makes any pinned viewport a lie.
- **A clock of CSS animations** — a `prefers-reduced-motion` sweep to `1ms`
  runs the table at infinite speed for readers who asked for calm, background
  tabs throttle it, `display: none` fires nothing, and `?clock=manual` cannot
  hold it. Motion is [Screen updates](screen-updates.md).
- **Inline DOM handlers** — the value stops being a declaration (what it hears,
  writes or names is unreadable) and stops being a reduce (it takes an `Event`).
- **The name `interestfor`** — it dresses our behaviour as a spec no engine
  ships.
