---
type: howto
title: Writing a screen
description: The app author's guide to the interpreter — what a screen is, the reduce contract, time, the rules that bite, and the lineage.
---

# Writing a screen

The app author's guide to the **interpreter**, the half of omnishell that runs
a pronto app's screens. Every `data-*` it answers is in
[REFERENCE.md](REFERENCE.md); this page is how to use them. A whole app — data,
i18n, testing, release, the build loop — is
[`plugins/pronto/GUIDE.md`](../pronto/GUIDE.md); the React library half is mapped in
[CONTRIBUTING.md](CONTRIBUTING.md#layout).

If you have written Elm, React with `useReducer`, or htmx, you already know the
shape; [Lineage](#lineage-and-mappings) at the foot is the translation table.

## What you are writing

A screen is **HTML**. You author it as a CUE string in `<app>/screens.cue`, and
`plugins/pronto/write.ts` emits it to `shell/screens/<name>.html` along with
the rest of the app. You never edit the emitted files; they carry a
do-not-edit header.

Five vocabularies, and that is the whole surface:

| | Spelling | Means |
|---|---|---|
| **Subscription** | `data-live="table"` + `data-filter` + `data-order` | a standing query; the region redraws when its rows change |
| **Binding** | `data-text="{col}"`, `attr="{col}"` | a column into the DOM |
| **Command** | `<form data-entity data-action>` | a write on a gesture |
| **Event** | `data-on-click="name"` | wakes a reduce |
| **Fold** | `shell/handlers/<name>.js` | a pure function from rows to writes |

`data-filter` is **PostgREST's filter grammar, verbatim** — `eq.`, `neq.`,
`is.null`, `in.(a,b)`, joined with `&`. `{col}` placeholders resolve against
the enclosing row.

A control with its own lifecycle — a toggle, an optimistic counter, a tablist —
is a **machine** instead: a chart in `data-machine` over one `tab` or `device`
row, whose transitions assign columns and emit typed effects the terminal
performs ([machines](docs/machines.md), grammar in
[REFERENCE](REFERENCE.md#machines)). Pick one at the pure-data end (a component
generates it, no code) and the many-states end (a reviewer reads the chart as
an inventory); in between, two states around real arithmetic read better as a
reduce ([when to reach for which](docs/machines.md#machine-or-reduce)).

## The reduce contract

A handler is one arrow function, evaluated in an SES compartment with **nothing
endowed**.

```js
(state, event) => ({ updates: [...], then: {type, delay} })
```

**What it receives**

- `state.rows` — `{table: [row, ...]}` for every table named in the waking
  region's `data-reads`.
- `state.items` — the region's own current rows, in DOM order.
- `event` — see below.

**What wakes it**

| Attribute | `event` | Notes |
|---|---|---|
| `data-on-mutation="ref"` | `{type: "mutation"}` | every refresh of the region — first paint and each change to its own read; a table named only in `data-reads` is read, not heard, so mount the fold on a region per table |
| `data-on-click="ref"` | `{type: "click", id, from}` | `id` is the **row's** id; `from` is the element's DOM `id` |
| a returned `then` | `{type: <yours>}` | your own scheduled beat |
| a refused write | `{type: "refused", entity, kind, id, validation}` | `kind` is `"refused"` (validation) or `"failed"`; `validation` names the validation that said no, when one did |

> **A click carries no payload.** `id` and `from` are all you get, so **design
> the row id to be the datum** — `apps/chess` declares `Square.id` as
> `cel: "this.size() == 2"`: the id *is* the square's name, and a click on it
> says which square. Use `from` to tell sibling affordances apart (four
> promotion buttons, one reduce).

**What it may return**

| Shape | Store call | Says |
|---|---|---|
| `{op: "put", entity?, id, row}` | `write` | the row at this key **is** this |
| `{op: "patch", entity?, id, row}` | `patch` | the fields it names **become** this |
| `{op: "delete", entity?, id}` | `drop` | this key **has no** row |
| `then: {type, delay?, seed?, with?}` | re-wakes this reduce after `delay`; `seed: true` hands it `event.seed`, a draw `?seed=` replays; `with` arrives as `event.with` | the only source of time |

`id` is the key and `row` is the body — the identity is the URI and never
repeated inside the payload, so a row need not carry a key that may be spelled
`article_id` or `tag`. `entity` defaults to the region's `data-live`.

**`op` is required and never inferred**: a patch that happened to carry a row
would be a put by accident, and silence is how that ships. An update naming no
op, an op outside the three, or a put or patch missing its `id` or `row`
throws.

**There is no `post`.** POST is the verb where the caller does not know the key,
and a reduce is never in that position: the store requires every write to carry
its key so a retry is idempotent, and a compartment has no `crypto` and no
`Math.random` to invent one with. A reduce derives a key from what the row
identifies, which is why stating the same conclusion twice states the same row.
Minting a fresh key is a form's job (`data-action="create"`), at the boundary
where randomness exists.

Consecutive updates of the same op against the same collection go down as one
store call, so a fold stating a thousand rows costs one write. Order within the
array is kept.

The chain is [capped](docs/data.md#the-step-after); exceeding the cap throws
`handler chain did not settle`. One refused write **aborts the remaining
updates in that batch** — the writes after it concluded from a premise the
store just withdrew.

**What it may not have**

`window`, `document`, `globalThis`, `fetch`, `XMLHttpRequest`, `WebSocket`,
`eval`, `Function`, `import`, `require`, `Date`, `Math.random`, `plv8` and
`this` are refused by `plugins/pronto/jessie.ts`. The compartment endows
nothing besides, so timers and every other global are absent whether or not
they are named. So:

- **No dependency.** Rules, parsing, algorithms: written in the handler. That is
  only safe with a grader — `apps/chess` generates moves in
  `shell/handlers/referee.js` and grades them in `tests/perft.test.ts`, and
  every handler and validation module an app ships runs under
  [the automated tests](docs/automated-tests-battery.md).
- **No clock.** See below.

## Time

There is no clock on any reduce path. `{now}` is the terminal's clock, admitted
only where the terminal performs the write — a form's hidden `data-value` and a
machine effect's `values` — so time enters the data plane as a *written
column*.

**The metronome row** is the idiom in the tree. `apps/chess` declares a `Tick`
entity seeded `[{id: "tick", n: 0, beat: "on"}]`, one machine advances it, and
the referee reads `n`: time arrives the way randomness does, as an input
somebody else writes.

A reduce that returns `then: {delay: 1000}` and subtracts exactly 1000 on the
next wake keeps a clock with no wall time at all. Both shapes hold still under
`?clock=manual` — the terminal owns the wait — which is what lets a stepped
test assert a timeout rather than sleep through one.

## Rules that bite

Symptom first, because that is what you will have.

### A form inside a row updates *that* row

`data-action="update"` writes to the enclosing item's id. An
`<input name="id">` is **ignored** for the target (it is still submitted as a
column), so a form inside a list item cannot write to any row but that item's;
put it in the enclosing region, or make it a click.

### `data-empty-row` binds only on a slot

A region that *contains another region* collects that region's template too and
is never a [slot](REFERENCE.md#what-a-region-may-say). Symptom: your fallback
never appears and the region shows `data-empty`.

### A nested slot must say what it looks like with no row

`slot region "x" ... is nested and declares no empty treatment` fails the
**build** for a slot inside another region's item. A top-level slot falls back
to the screen's `gone` or `empty` state; a nested one has no state to move to,
so it declares its own (`data-empty="…"`, `data-empty=""`, or
`data-empty-row`). Without a declaration, a readout that has lost its row and a
probe holding its peace render the same blank. Markup mounted outside a build —
a fixture, a harness — gets the interpreter's `... has no row and declares no
empty treatment` instead.

### Every bound column must exist on the row

`binding {x} not in row [...]` means a template binds a column your `create`
omitted. A column that is `required: false` is still **bound**; the creating
form must state it, empty string included.

### Recompute absolutely, write differentially

A write is a mutation and a mutation wakes the reduce. A fold that restates all
its rows every time **wakes itself forever** and races the store. Derive the
whole world, then emit only what changed:

```js
const txt = (v) => String(v ?? "");
const differs = (want, have) => have === undefined ||
  Object.keys(want).some((k) => txt(have[k]) !== txt(want[k]));
```

This makes the fold a fixpoint: a wake that changes nothing writes nothing and
the chain ends. `apps/chess/shell/handlers/referee.js` is the reference.

The delete is what makes that discipline **total**: without it a fold can state
what should exist and change what does, but never shrink the set, so anything
that removes has to leave the reduce and become a form. `apps/jsfb` is the
worked case — Create, Clear and the row's own ✕ are all one fold.

### Rows that must exist are seeded

`seed: [...]` on an entity gives a fresh local collection its bootstrap rows
(an entity the cluster holds renders them into `900_seed.sql`). A slot's row
must exist. Do not mint scenery from a reduce if you can declare it.

### Design tokens are `--primary`, not `--color-primary`

The preset supplies `--neutral --surface --surface-muted --border --primary
--secondary --accent --danger --attention`, spacing `--sp-sm|md|lg|xl`, radii
`--r-sm|md|full`, and `--motion-*`. A `var()` naming a token that does not exist
makes the whole declaration invalid and it is **silently dropped** — the symptom
is a screen with no layout and no error. `apps/shadcnui` is the worked gallery.

### An item template holds exactly one element

Wrap multiple children in a single element; a template holding two throws
`region "<table>" has a template with N elements`.

### Refusals are events, not exceptions

If the waking region declares `data-on-mutation`, a rejected write is delivered
to your reduce as `{type: "refused"}`. **A reduce with no branch for it turns a
rejected write into silence.** Add one, even if it only throws:

```js
if (event.type === "refused") {
  throw new Error(`store refused ${event.entity} (${event.kind})`);
}
```

### The writer deleted my handler

[Pronto's build loop](../pronto/GUIDE.md#the-build-loop) removes what the last
manifest listed and the current bundle lacks, so deleting
`shell/screens/*.html` to clear a stale error takes the hand-authored handlers
those screens named with it. Patch the emitted file instead; the next write
overwrites it. If a handler is already gone, the last image still carries it:
`docker compose exec caddy cat /srv/shell/handlers/<name>.js` from the app's
directory.

## Lineage and mappings

The vocabulary is its own; the algebra is borrowed on purpose.

### The Elm Architecture

The closest single ancestor, argued in
[the terminal](docs/terminal.md).

| TEA | omnishell |
|---|---|
| `Model` | the rows |
| `view` | the markup |
| `update` | the Jessie reduce, or a machine's transitions |
| `Msg` | a form submit, a click, a refusal |
| `Cmd` | `then: {type, delay}`, a machine's effects |
| `Sub` | `data-live` |
| ports | the hatch (`data-hatch`) |

**Where the analogy stops, and why there is a write vocabulary at all.** Elm's
`update` returns the next `Model`, so removal is `List.filter` and there is no
delete verb to design. A reduce cannot: the rows are a store shared with a
server, other tabs and the network, and handing back a whole new one is neither
possible nor affordable. So a reduce returns a **diff**, and a diff language
needs a word for removal or it cannot express a shrinking set. That is the
argument for `delete`, and why "recompute absolutely, write differentially" is
the doctrine: compute Elm's next model, then say how it differs. The reduce
being pure and total is Elm's `update` with SES enforcing what Elm's type
system enforces.

### Datalog and differential dataflow

`data-live` + `data-filter` + `data-project` is a conjunctive query with a
standing subscription, maintained incrementally rather than re-run — the
tradition of Materialize, `d2ts` and TanStack DB;
[pronto's one graph](../pronto/docs/component-contracts.md#one-graph)
works the semantics.

It also settles the write vocabulary. Differential dataflow carries changes as
`(record, multiplicity)` and has no patch: an update is a retraction and an
assertion. So `put` and `delete` are the complete pair, and `patch` is the
useful extra that says the fields it does not mention are none of its
business. Datomic makes the same split (`:db/add`, `:db/retract`) and puts the
**op first** rather than leaving a reader to infer it from shape; REST spells
the three PUT, PATCH and DELETE and puts the identity in the URI, which is why
`id` sits beside `row`. No tradition with a diff language infers the operation
from which field is present.

### The rest

htmx and Hotwire ("a click is spelled as a write"; read the form-as-command
rule as Hotwire with a local database), CQRS (commands through forms,
projections through reduces and pipelines), SES (why `Date` and `import` are
gone: a reduce is a function of its inputs alone) and local-first (the
`device`/`tab` split; Electric SQL and PGlite under `libraries/mecha`).

`apps/shadcnui` is the presentation gallery; `apps/chess` is the reference for
the data plane — reduce, seeds, clock, derived board;
[a count the reader is inside of](../pronto/GUIDE.md#a-count-the-reader-is-inside-of)
works one derivation end to end.
