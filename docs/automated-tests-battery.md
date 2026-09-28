---
type: concept
title: Automated tests
description: Every handler and validation module an app ships is tested automatically, with no test written by hand, for confinement, termination through fuel, and purity.
---

# Automated tests

Every handler and validation module an app ships is tested automatically, with
no test written by hand: its inputs are drawn from the app's own schema, and
every run holds it to confinement, termination through fuel, and purity.
Renderers, adapters and folds take no state and event to draw, so they are
only loaded, by `check handlers`. The suite is the battery,
`omnishell check battery` at `test`. Where [visual lint](visual-lint.md) measures
a rendered page, the battery runs an app's modules themselves, hundreds of times
each, with no page at all.

`check-battery.ts` runs every handler and validation module an app declares
against inputs its own schema admits, and holds three properties over every
draw:

- **confinement** — the module runs in the compartment production runs it in
  (`interpreter/jessie.js`), endowed with nothing but its meter, which is
  sealed onto the compartment global as neither writable nor configurable; a
  module that binds the meter's own name is refused and reported.
- **termination** — `instrument.ts` rewrites the source so every loop head and
  function entry spends [fuel](#fuel), so a module that does not finish is
  stopped by a counter rather than by CI's wall clock.
- **purity** — the state, the event and the chart's literal params are
  deep-frozen and the call is made twice; a module that mutates what it was
  handed, spends a different number of steps, or answers differently, says so.

Inputs are drawn, never accepted-and-discarded. `plugins/pronto/bounds.ts`
reads each column's CEL into a domain that names no language — `enumValues`,
or `intMin`/`intMax`, `sizeMin`/`sizeMax`, `regex` — and a conjunct it does not
recognise leaves the domain wider, never narrower; `derive-cel.ts` renders it
into `program_cel.cue`, `emit.cue` carries it into `shell/shell.yaml` beside
the field, and `arbitrary.ts` builds a fast-check generator per column from
that. So the terminal generates rows for a program whose constraint language it
does not speak, and every sample is a row the program would accept. The run is
seeded, so a counter-example replays, and the shrunk one is what the finding
quotes. A handler runs once per call site the screens state — a chart's
literal params are a third argument, so each distinct set is its own run — and
a validation against the rows its declared edges reach.

`.say.yaml` runs `check battery --self-test` through `runtime/cli.ts` on the
deno the tool stub pins, so the checker's own claims are graded on the same
runtime an app's are.

## Fuel

A wall-clock timeout is not deterministic: a test that waits 2 s fails under CI
load and stalls on an infinite cycle. Two meters replace it, and these are
their units.

**Jessie steps** (`instrument.ts`, spent by `check-battery.ts`). Every loop
head and function entry is one step; a call into a frozen intrinsic is one step
whatever it costs, so a module can still buy wall-clock time it spends no fuel
for. The budget is 1,000,000 steps per call (`FUEL`) over 100 seeded draws per
call site (`RUNS`, `SEED` 0); over budget throws
`Jessie fuel limit exceeded (<budget> steps)`. The budget answers "did this
finish", not "was it quick", so it is sized to clear the dearest correct module
in the tree — a chess referee naming every legal move and asking mate of each
check, about 160,000 steps with nine queens on the board — and what it exists
to catch spends it in milliseconds.

**Harness fuel** (`test/fuel-meter.ts`, the machine harnesses under
linkedom). `FuelMeter.spend` charges by category, defaulting to `fire` 10,
`transition` 50, `mutation` 50, `wait` 1 per ms and `jessie` 1; `spendEffect`
charges by [effect level](../REFERENCE.md#effects):
`projection` 1, `ephemeral` 10, `compensable` 50, `replicated` 100, `exterior`
250, and an unknown level costs a mutation. Over budget throws
`FuelLimitExceededError` naming the last three actions. Posing
(`test/storybook-battery.ts`) spends one `fire` per query and one `transition`
per frame at 25, under 3,000 per frame.

## Rejected

- **Metering in production.** `screen.js` and plv8 run pristine source: a fuel
  call at every loop head inflates code, disturbs inline caches and loop
  unrolling, and complicates source maps. Production's cutoff is wall-clock,
  which does not penalise fast paths; CI's has to be a count that is identical
  on a fast laptop and a slow worker.
- **Moddable XS (`xst`) instead of an SES compartment.** An external C binary
  per platform that forks a process per property run and hangs the runner on
  any non-terminating input in an uninstrumented batch; the acorn rewrite runs
  in deno with no native toolchain, hundreds of runs per module in milliseconds.
- **Rejection sampling.** A fuzzer discarding what the constraint refuses wastes
  nearly every draw on a two-value enum or `this.size() == 64`; the domain is
  generated by construction instead.
- **Read-only proxies over `deepFreeze`.** A proxy diverges on identity and costs
  on every access; a frozen input turns an illegal write into an immediate
  `TypeError`.
- **Running it at `lint`.** The battery executes modules hundreds of times, work
  `lint` promises not to do, so it is a `test` check.
