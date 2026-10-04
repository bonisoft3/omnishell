---
type: concept
title: Rows, reduces and writes
description: How a region's rows reach a reduce, what it writes back, why a refusal returns as an event, and how stored rows meet a newer program.
---

# Rows, reduces and writes

A region is a standing read; a reduce is a pure function from its rows to keyed
writes; the store performs them and the region redraws. What a reduce receives
and returns is [the reduce contract](../GUIDE.md#the-reduce-contract); this is
why the contract has that shape, and where it bites.

## A region's rows

`data-live` with its filter, order and select is a query the store maintains
(`subscribe`, [`data-sync.js`](../interpreter/data-sync.js)). A region wakes
when a row its filter could show changes, or a table its embeds, row visibility
or fold sink depends on; a write elsewhere costs it nothing. Each wake re-reads,
keeps `currentRows` and [patches by key](screen-updates.md#when-data-changes).

The store has many writers — forms, reduces, machine effects, sync, other tabs —
so no writer knows a region changed; the renderer does, having just applied the
rows. Elm's one funnel knows what it changed and needs no hook; here the
transition has to be published and its cycles bounded.

## A table synced on demand

`shell.yaml`'s `sync` names the tables pronto derived as on demand
([screens](../../pronto/docs/screens.md#the-reads-decide-how-a-table-syncs)).
The store passes the mode to mecha's client, which opens the shape from now and
loads each maintained view's rows, and its embeds' by key, as subset
snapshots. Three rules follow from a collection that holds only what its views
asked for:

- **A view is read only once it is settled**: ready, and loading no subset.
  `toArrayWhenReady` answers on the first row, which renders half a list as the
  list. A read holds the view while it waits, so a region released mid-load
  (a Back press) still gets its answer and its refresh ends.
- **A failed subset is charged to the views that were loading it, and only
  those.** mecha's client tells each failure as it happens and keeps none,
  since a failure kept on the collection would fail every later view of the
  table. A refusal of the subset itself, a 400 whose `errors.subset` names
  the parameter as Electric, the stack's gate and the page's cluster answer
  one, is a `ProgramError` naming the table, because no retry repairs a predicate that
  cannot be stated. Any other failure is said on the console and the view is
  rebuilt after a pause that doubles from 100ms to 5s, while the reads waiting
  on it go on waiting. Failing the read at once instead sends the screen to
  network-error and re-reads on the region's backoff, seconds per miss, and a
  screen loading forty subsets misses more than once. Electric's own fetch
  already waits out a 5xx and a dropped connection, so what reaches a view is
  a 4xx a retry answers: a token to re-mint, a token minted for a where the
  stream has moved off, a 409 loop the client gave up on. A failure still
  there after six rebuilds, about six seconds, is not one of those: an auth
  service that mints nothing, a gate that refuses what it minted. It fails the
  reads waiting on the view, so the screen says network-error and the region's
  backoff takes over, and the next read starts the rebuilds over.
- **A view holds its wakes while it loads a subset**, so no region binds a row
  whose embed has not arrived yet.
- **Nothing else reads the collection as the table.** A snapshot read, a
  validation, a visibility rule, a fold's projection, an upsert, a delete by
  filter and a mutation reduce's write by key all raise a `ProgramError`
  naming the site (`whole` in `data-sync.js`) when they meet an on-demand
  table. pronto's rule keeps such a table eager, so one raised is a drift
  between the two.
- **An update or a delete by key loads its row first.** A row the collection
  lacks is loaded as a view of its key and held until the write has gone out;
  Electric keeps a loaded row current from then on. A key no row has stays
  missing, and the write is the collection's refusal of it.

A clause on a typed column sends one literal of its type, read against the
column's own field and in the spelling its rows carry (`1.50` against a decimal
is the row holding `1.5`), which is also what the subset asks Electric to cast.
A literal the column cannot hold equals no row. Only an untyped column, or one
declared by a physical label such as `timestamptz`, whose rows keep the
transport's spelling, hedges between the text and the number a value could be.

## The fold seat

After every refresh of a region, first paint included, its `data-on-mutation`
reduce is called with `{type: "mutation"}` and, as `state.items`, the rows the
terminal just applied (a slot's is `[row]`). The fact is published at the patch
site, not recovered from the DOM, and named for the store's event: no DOM change
fires it.

**What wakes a fold is its region's own read.** A table named only in
`data-reads` reaches the reduce as `state.rows` and is never listened to. A fold
that must hear several tables is mounted on a region per table with the same
`data-reads`, as `apps/chess`'s board mounts `referee` on `tick`, `game`,
`square`, `piece` and `move`.

**One seat per handler and declared world**, screen-wide: regions naming the
same handler, `data-reads` and `data-read-*` never run it concurrently, because
two runs would each conclude from a world missing the other's writes. A mutation
arriving mid-run is remembered and re-runs the fold once; dropped, a fold that
writes its own collection would sleep with its last write unanswered. It ends
because a fold that writes nothing makes no mutation, which is why a fold
[recomputes absolutely and writes differentially](../GUIDE.md#recompute-absolutely-write-differentially).
The re-run carries the rows of whichever region started the seat, so a fold on
several regions reads its world from `state.rows`, not `state.items`.

## The step after

The command goes in the return. `then` is not an effect but the next event,
delivered to the same reduce after the writes land: after `delay` on the
terminal's clock, so `?clock=manual` holds it; with a draw when it says
`seed: true`, since the compartment has no randomness and `?seed=` replays the
draw; with `with` carried across. A value can be recorded and a promise
cannot, so a reduce returning one throws.

A hook makes runaway cascades cheap too, so the terminal owns the depth: 8
steps, then `handler chain did not settle`. An app cannot bound a cycle it
cannot see.

## A refused write is an event

A write settles twice: accepted optimistically and already on screen, then
confirmed or withdrawn, possibly after a reload from the IndexedDB outbox.
The withdrawal cannot be a return value, so it arrives in the region's fold as
`{type: "refused", entity, id?, kind, validation?}`, from every write the region
makes — its forms, its reduces, a drag, a machine effect — and the same way
inside the 2.5 s acceptance window (`ACCEPT_MS`) or after it.

- `kind: "refused"` is `NonRetriableError`: mecha's answer to a 4xx other than
  408 or 429, the optimistic row already rolled back, or a validation the store
  seat judged before the write ([`validate.js`](../interpreter/validate.js)).
  That judge runs whatever the durability, so a `tab` or `device` write can be
  refused.
  `validation` names it; anything else is `"failed"`.
- A machine on the region drawing a `refused` arrow hears it first and the fold
  does not. With no fold, a form reveals its `.store-error` and the screen goes
  `validation-error` or `network-error`.
- A refusal inside the window ends the batch and the chain, whose later steps
  concluded from a withdrawn premise; a late one arrives after both finished.
  `id` names the first row of the refused run.

It is an event because clicks, draws, delays and mutations are events the
terminal owns, which is what `?seed=` and `?clock=manual` replay; a callback
could not be replayed. Elm and redux-offline agree.

## Declaration follows durability

`#Durability` in [`schema.cue`](../../pronto/schema.cue) is a ladder monotonic
in expense, and the emitter derives everything from it: a `tab` or `device`
entity emits no table, trigger, publication, policy or SQL check and takes no
`access`. `device` refuses `seed` — seeding a collection that outlives the page
resurrects what the reader deleted, and a row the program states belongs at
`tab`, where the program is its durable copy.

Ceremony scales with what is at stake: a flat cost per declaration prices the
cheapest thing like the most expensive and makes escaping upward rational —
nothing at `tab`, a line at `device`, the full entity where a reviewer signs
DDL and policy. The entity itself is declared in full whatever its durability:
pronto's `objects.ts` pairs every entity with an ir section, so a collection
that emits nothing and dies with the tab costs an entity and an ir object the
markup already implies. The rule is about state, not code: a Jessie module
keeps its `surface.handlers` entry and its ir section whatever the durability.

## Derived, not restated

A screen's `reads` (every read `data-live`, `data-reads` and `data-read-*`
make, routed by `fragment.js`'s `routeOf` as the store routes them), `writes`
and `files.handlers` (every name `data-handler` and `data-on-*` bind) are
projected out of its markup by [`read-markup.ts`](../read-markup.ts) for
[`derive.ts`](../../pronto/derive.ts), into `program_derived.cue`. Check against published data, never a copy: a rule
comparing a restatement with the markup would grade a copy, so none exists
([screens](../../pronto/docs/screens.md#derived-from-the-markup)).

## Stored rows and a newer program

The browser holds two copies of the schema and neither is the database's: the
served bundle, and the rows in `localStorage` written by whichever program last
ran. `device` rows persist under `mecha:<table>`: no version, and the table's
name rather than the entity's type id.

Before its first read or write in a boot, a local collection is prepared
(`prepare`, `data-sync.js`): seeded, then `fill()` gives each stored row
every optional column the program added (`""` for text, else `null`), since
binding a column a row lacks throws, then `reconcile()` re-judges the declared
uniques, partial ones included. The newest row per key wins (`created_at`, else
load order) and the rest are dropped with one warning: the terminal cannot mint
values to move a loser out of a unique's domain.

Nothing else is judged at load. A field's `cel:` reaches the browser only as the
`enum` and `bounds` the checkers read; validations judge writes, never stored
rows; the shape is unversioned, so a removed field stays and a renamed entity's
rows are orphaned. Keys compare as strings, sound only because the mecha client
makes every value [canonical](../../pronto/docs/types-and-identity.md#portable-types);
order goes through the type's comparator, never a JavaScript type.

## Skew

A bundle and its database move separately: a migration applies under an open
page, a rolling deploy moves one first. A read against a skewed database is
dressed `network-error` and retried from 2 s, doubling to 15 s, forever, and a
write refused for an unknown column blames the reader's input. No retry repairs
a missing column, which is what [`ProgramError`](../interpreter/fragment.js)
means — a broken invariant, rethrown past the outage guard — and nothing raises
skew as one ([the compiler's half](../../pronto/docs/schema-change-admission.md),
[the cluster's](../../../libraries/mecha/docs/schema.md)).

Deciding it would need two numbers the cluster does not expose — the migration
version the database was brought to (`applied`) and the floor below which a
client is no longer served — against the version the bundle was compiled with
(`built`); `floor ≤ built ≤ applied` is the whole test. An additive migration
moves `applied` and leaves the floor, so every open page keeps working. The
test belongs at boot and on a 4xx, never on a timer: no retry repairs a missing
column, and every skew with a symptom produces a 4xx.

## Rejected

- **Observing the DOM for a transition.** An observer fires once the DOM
  settled and rebuilds rows from attributes the renderer wrote.
- **A CSS animation as the event.** Control flow in a stylesheet, where a
  `@keyframes` nested in a style rule is silently dropped and the program stops.
- **A callback, a promise or an `Either` for a refusal.** A promise settles once
  and this settles twice; an `Either` assumes the answer exists at the call
  site; a callback sits outside the recording.
- **New markup for computed writes.** `data-row="tint/the"` respelled
  `data-live` + `data-filter`; a cycle grammar held two states in a fixed order
  and died on a conditional one. The reduce is the general answer.
- **A versioned storage key** (`mecha:<table>@<version>`). Orphans every saved
  row on every schema change.
- **Dropping persistence**, every local entity `tab`. Removes the feature with
  the problem: closing a tab is not resigning a game.
- **Per-app migration code.** One chance per app to get it wrong and none for a
  check to read it.
- **Reloading on skew.** Discards what the reader typed; the terminal says, the
  reader decides.
