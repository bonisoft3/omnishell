# Writing a screen

The app author's guide. It covers the **interpreter** — the half of omnishell
that runs a pronto app's screens. Every `data-*` it answers is catalogued in
`docs/2026-07-30-the-binding-vocabulary.md`; this page is how to use them. For
the React library half (auth, layout, lint presets) see `README.md`, and for
changing the interpreter itself see `CONTRIBUTING.md`.

If you have written Elm, React with `useReducer`, or htmx, you already know the
shape; see [Lineage](#lineage-and-mappings) at the foot for the translation
table. Read that section first if the vocabulary feels alien — most of it has a
name you already use.

---

## What you are writing

A screen is **HTML**. You author it as a CUE string in `<app>/screens.cue`, and
`plugins/pronto/write.ts` emits it to `shell/screens/<name>.html` along with
`shell.yaml`, `compose.yaml` and the docker context. You never edit the emitted
files; they carry a do-not-edit header.

Five vocabularies, and that is the whole surface:

| | Spelling | Means |
|---|---|---|
| **Subscription** | `data-live="table"` + `data-filter` + `data-order` | a standing query; the region redraws when its rows change |
| **Binding** | `data-text="{col}"`, `attr="{col}"` | a column into the DOM |
| **Command** | `<form data-entity data-action>` | the only way to change data |
| **Event** | `data-on-click="name"` | wakes a reduce |
| **Fold** | `shell/handlers/<name>.js` | a pure function from rows to writes |

`data-filter` is **PostgREST's filter grammar, verbatim** — `eq.`, `neq.`,
`is.null`, `in.(a,b)`, joined with `&`. If you know PostgREST you know it
already. `{col}` placeholders resolve against the enclosing row.

---

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
- `event` — see the table below.

**What wakes it**

| Attribute | `event` | Notes |
|---|---|---|
| `data-on-mutation="ref"` | `{type: "mutation"}` | any write to a table in `data-reads` |
| `data-on-click="ref"` | `{type: "click", id, from}` | `id` is the **row's** id; `from` is the element's DOM `id` |
| a returned `then` | `{type: <yours>}` | your own scheduled beat |
| a refused write | `{type: "refused", entity, kind, id, validation}` | `kind` is `"refused"` (validation) or `"failed"`; `validation` names the validation that said no, when one did |

> **A click carries no payload.** There is no way to attach `{"sq": "e4"}` to a
> button. `id` and `from` are all you get, so **design the row id to be the
> datum** — this is why `apps/chess` declares `Square.id` as
> `cel: "this.size() == 2"`: the id *is* the square's name, and a click on it
> says which square. Use `from` to tell sibling affordances apart (four
> promotion buttons, one reduce).

**What it may return**

| Shape | Store call | Says |
|---|---|---|
| `{op: "put", entity?, id, row}` | `write` | the row at this key **is** this |
| `{op: "patch", entity?, id, row}` | `patch` | the fields it names **become** this |
| `{op: "delete", entity?, id}` | `drop` | this key **has no** row |
| `then: {type, delay}` | re-wakes this reduce after `delay` | the only source of time |

`id` is the key and `row` is the body, for all three — the identity is the URI
and never repeated inside the payload, so a row need not carry a key that may be
spelled `article_id` or `tag`. Delete has no body. `entity` defaults to the
region's `data-live`.

**`op` is required and never inferred**: a patch that happened to carry a row
would be a put by accident, and silence is how that ships. An update naming no
op, an op outside the three, a put or patch with no `id`, or a put or patch with
no `row`, all throw.

**There is no `post`.** POST is the verb where the caller does not know the key,
and a reduce is never in that position: the store requires every write to carry
its key so a retry is idempotent, and a compartment has no `crypto` and no
`Math.random` to invent one with. A reduce may only write where it can name the
key — it derives one from what the row identifies, which is why stating the same
conclusion twice states the same row. Minting a fresh key is a form's job
(`data-action="create"`), at the boundary where randomness exists.

A patch's `row` is a partial one: the fields it does not mention are none of its
business, which is the one thing neither of the others can say.

Consecutive updates of the same op against the same collection go down as one
store call, so a fold stating a thousand rows costs one write and not a
thousand. Order within the array is kept.

The chain is capped at **8 steps**; exceeding it throws
`handler chain did not settle`. One refused write **aborts the remaining
updates in that batch** — the writes after it concluded from a premise the
store just withdrew.

**What it may not have**

`window`, `document`, `globalThis`, `fetch`, `XMLHttpRequest`, `WebSocket`,
`eval`, `Function`, `import`, `require`, `Date`, `Math.random`, `plv8` and
`this` are refused by `plugins/pronto/jessie.ts`. The compartment endows
nothing besides, so timers and every other global are absent whether or not
they are named. Two consequences worth stating plainly:

- **No dependency.** Rules, parsing, algorithms: written in the handler. That is
  only safe with a grader — `apps/chess` generates moves in
  `shell/handlers/referee.js` and grades them in `tests/perft.test.ts`.
- **No clock.** See below.

---

## Time

There is no clock on any reduce path. `{now}` exists **only** in a form's hidden
`data-value`, so time enters the data plane as a *written column*.

**The metronome row** is the idiom in the tree. `apps/chess` declares a `Tick`
entity seeded `[{id: "tick", n: 0, beat: "on"}]`, one machine advances it, and
the referee reads `n`. Its own program says it plainly: time arrives the way
randomness does, as an input somebody else writes.

A second shape falls out of `then` and is worth knowing about: a reduce that
returns `then: {delay: 1000}` and subtracts exactly 1000 on the next wake keeps
a clock with no wall time at all. Both shapes hold still under
`?clock=manual` — the terminal owns the wait — which is what lets a stepped
test assert a timeout rather than sleep through one. No app in the tree runs
the second shape yet; the first is the one to copy.

---

## Rules that bite

Symptom first, because that is what you will have.

### A form inside a row updates *that* row

`data-action="update"` writes to `rowId()` — the enclosing item's id. A
`<input name="id">` is **ignored** for the target (it is still submitted as a
column). A form inside a list item therefore cannot write to any row but that
item's; put it in the enclosing region, whose row context is the one you want,
or make it a click.

### `data-empty-row` binds only on a slot

A **slot** is a region with no item template; it binds at most one row and may
declare a fallback so the markup renders before the row exists. Item templates
are collected with an **unscoped** `querySelectorAll("template[data-item]")`, so
a region that *contains another region* counts that region's template too and
is never a slot. Symptom: your fallback never appears and the region shows
`data-empty`.

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
(server tiers render them into `900_seed.sql`). A slot's row must exist — that
is the seed doctrine. Do not mint scenery from a reduce if you can declare it.

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

---

## The build loop

```bash
deno run --allow-read --allow-write --allow-run --allow-env \
  plugins/pronto/write.ts apps/<name>
```

`write.ts` derives from the **emitted** markup, then re-emits, then re-derives
until fixed point. Two consequences:

- **A markup change reports errors about the previous markup** on the first run.
  Run it again, or align the emitted file by hand.
- **Do not delete `shell/screens/*.html` to clear a stale error.** Manifest
  cleanup removes files that were in the last manifest and are absent from the
  current bundle — and with the emitted markup gone, your **hand-authored
  handler is no longer referenced and is removed with it**. Patch the emitted
  file instead; the next write overwrites it correctly. If a handler does go,
  the last container image still carries it —
  `docker compose exec caddy cat /srv/shell/handlers/<name>.js`.

Bootstrapping a brand-new app needs `program_derived.cue` to exist before the
first export can complete, because the export requires every decision's `note`
and the notes come from derivation. Write a stub with one line per decision and
let the first run replace it.

An app also needs, or the build fails: `ir.html` with an
`id="decision-NN" data-kind="decision"` element per declared decision,
`acceptance.md`, `DESIGN.md`, `brief.md` + `brief.html`, and a local TLS pair
(`mise exec -- mkcert -cert-file .certs/localhost.pem -key-file
.certs/localhost-key.pem localhost 127.0.0.1 ::1`).

---

## Lineage and mappings

The design is not novel for novelty's sake; almost every part has a name from a
system you may already know. The vocabulary here is its own, but the algebra is
borrowed on purpose.

### The Elm Architecture

The closest single ancestor. `docs/2026-08-02-terminal-doctrine.md`
argues the comparison directly, including where pronto is *better* (data
subscriptions are declarative and in the markup) and where it is thinner
(everything else that can wake an app).

| TEA | omnishell |
|---|---|
| `Model` | the rows |
| `view` | the markup |
| `update` | the Jessie reduce |
| `Msg` | a form submit, or a click |
| `Cmd` | `then: {type, delay}` |
| `Sub` | `data-live` |
| ports | the hatch (`data-hatch`, vendored units) |

**Where the analogy stops, and why there is a write vocabulary at all.** Elm's
`update` returns the next `Model` — one value, replacing the last — so removal
is `List.filter` and there is no delete verb to design. A reduce cannot do that:
the rows are a store shared with a server, other tabs and the network, and
handing back a whole new one is neither possible nor affordable. So a reduce
returns a **diff**, and a diff language needs a word for removal or it cannot
express a shrinking set. That is the whole argument for `delete`, and it is why
"recompute absolutely, write differentially" is the doctrine: compute Elm's next
model, then say how it differs.

The reduce being **pure and total** — rows in, writes out, no ambient authority
— is Elm's `update` with SES enforcing what Elm's type system enforces.

### Datalog and differential dataflow

`data-live` + `data-filter` + `data-project` is a conjunctive query with a
standing subscription, maintained incrementally rather than re-run. That is the
Datalog/differential-dataflow tradition (Materialize, `d2ts`, TanStack DB), and
`plugins/pronto/docs/2026-08-02-incremental-model.md` works the semantics.
"Recompute absolutely, write differentially" is the same discipline applied to
the *app* rather than the engine.

It also settles the shape of the write vocabulary. Differential dataflow carries
changes as `(record, multiplicity)` — +1 asserts, −1 retracts — and has no patch
at all: an update is a retraction and an assertion. So `put` and
`delete` are the complete pair, and `patch` is the useful extra: it says what
the other two cannot, that the fields it does not mention are none of its
business. Datomic makes the same split explicitly (`:db/add`, `:db/retract`,
`retractEntity`) and, like this one, puts the **op first** rather than leaving a
reader to infer it from shape. REST — whose filter grammar this platform already
borrows from PostgREST — spells the three PUT, PATCH and DELETE, and puts the
identity in the URI rather than the body, which is why `id` sits beside `row`
and not inside it. Every tradition with a diff language names its operations;
none infers one from which field is present.

### htmx / Hotwire / Turbo

"A click is spelled as a write" is their whole thesis, and the closest living
relative of the forms-only mutation rule. If forms-as-the-only-mutation-channel
feels strange, read it as Hotwire with a local database instead of a server.

### Datomic

The database as a value; facts are stated, not mutated in place. "A move is a
row", the append-only move log, and derived tables recomputed rather than
patched are all Datomic-shaped. So is `put` — *state the row for this key* —
against `update`'s *change these fields of that row*.

### CQRS / event sourcing

The split between what the reader writes (commands, through forms) and what the
app derives (projections, through reduces and pipelines).

### SES / Hardened JS (Agoric)

The compartment. This is *why* `Date` and `import` are gone — not an arbitrary
restriction but the price of a reduce whose behaviour is a function of its
inputs alone.

### Local-first

The `device` / `tab` path split, and an app that owes the network nothing after
load. Kleppmann's local-first essay is the background; Electric SQL and PGlite
are the machinery underneath `libraries/mecha`.

### Further reading in this tree

- `docs/2026-08-02-terminal-doctrine.md` — the roles, and the Elm comparison
- `plugins/pronto/docs/2026-08-02-incremental-model.md` — the semantics under the regions
- `docs/2026-08-27-events-and-the-clock.md` — what may wake a handler, and why the event surface is asymmetric
- `plugins/pronto/docs/2026-08-12-derived-counts-the-reader-is-inside.md` — one derivation worked end to end
- `apps/shadcnui` — 33 screens, 30 components: the presentation gallery
- `apps/chess` — the reference for the data plane: reduce, seeds, clock, derived board
