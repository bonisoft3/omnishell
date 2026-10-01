---
type: concept
title: Focus and ARIA
description: ARIA state is derived columns a region projects over its own rows, and the terminal owns the tab order, moving focus only when a column moves.
---

# Focus and ARIA

A component's ARIA state belongs to the rows it describes, and focus is a pen
the terminal shares with the reader. The attributes are
[derived columns](../REFERENCE.md#derived-columns) and
[focus](../REFERENCE.md#behaviour); cancels are
[Machines](machines.md#gestures-and-cancels).

## ARIA is derived columns

Stored as N columns of one row, a component's state freezes its items at
compile time, takes invented prefixes (`sel_`, `chk_`) because none of the N can
be called `aria-selected`, and grows N(N−1) arrows writing N²(N−1) literal
assigns; a row arriving mid-visit cannot be an option. The wall is the
comparison: bindings interpolate and never evaluate, and `data-when` is
literals-only so which arm a row picks stays decidable from the markup. So
`data-project` compares and emits the answer — `selected: "true"`,
`posinset: 5` — and each arm's ARIA values are literals in the file, as a radio
group already binds (`test/radio-bind.test.ts`).

- **APG names the columns**, each for the ARIA state it answers, so the screen
  reader, a role-and-name test query and the spec share one vocabulary. Every
  emitted id carries its instance, or `aria-controls` finds a duplicate.
- **Merged before binding, never stored.** A machine reads the stored rows, and
  a derived column reaching a transition would widen what a chart is decidable
  from past the row and the event.
- **A `ProjectionError` is a `ProgramError`**, because a nested region resolves
  inside its parent's refresh, whose outage guard retries any other error
  forever and reports the store down while the markup is wrong.
- **A lane clause names a row, not a step**, so a gesture writes a key and
  never does arithmetic. Ends do not wrap: APG decides that per pattern, and a
  compile-time chart may (`#OneOf` does). A lane is partitioned by a column
  because a grid's minor axis otherwise runs off one lane into the next, and a
  caret walking down a Monday lands on a Tuesday; prefer the clause that
  corrects a wrong answer to one that supplies a missing one.

## What the projection refuses

Allowed: positional facts about the region's own filter and order, a comparison
against the enclosing row, and the answer as a column. Refused: a predicate over
a foreign collection, or the chart stops being a complete inventory of what a
screen can do; an aggregate over rows the reader does not hold, since a count
is exact only over rows the reader holds; an expression in markup, whose answer
is another derived column. So every answer is over rows the region holds at
refresh, and no incremental-view engine is needed.

**An aggregate is a fold seat.** `sum`, `min` and `max` as clauses would be a
third read dialect beside PostgREST fragments and mecha's incremental views,
weaker than the two seats a fold already has — a Jessie reduce on
`data-on-mutation` over rows the browser holds, and a `#Pipeline` over a
`server` entity, whose fold contract is `empty`/`step`/`combine`/`result` with
its laws.

Walked against APG, every pattern fits. Where focus stays on a container
(listbox, combobox, grid, tree), `aria-activedescendant` is a binding and
`data-key` submits the form `next`/`prev` name, with no chart; where focus moves
between items (tablist, toolbar, menubar), a chart arrow carries the key and
roving `tabindex` follows its column. `aria-checked="mixed"` lands on the parent's
row, where no clause answers; shadcnui's checkbox screen reaches it through a
roll-up module. When a pattern needs what is refused, reopen the design
rather than widen the rule; renaming `test/projection.test.ts`'s `{"sum": …}`
exemplar is the quiet widening.

## A tablist whose tabs are rows

[`test/row-backed-tabs.test.ts`](../test/row-backed-tabs.test.ts) runs one.
Which tab is chosen is an id on the enclosing choice row; every tab's
`aria-selected`, `aria-posinset` and `aria-setsize` come off one projection;
the panel is a `data-when` arm over the same derived column, so it cannot
disagree with the tab; and the pick is an upsert by the form the tab already
is. Both id references, `aria-controls` and `aria-labelledby`, are built from
the row's own id.

**The contract is the form plus the projection, not the chart.** There is no
machine on the screen, so a reviewer told to read the chart finds it empty and
must be told to read these two instead. The property a chart gives survives: a
projection's clause kinds are a closed set, finite to read, and a derived
column cannot reach a guard, an assign or a target. What it buys is growth: a
chart spelling the same choice needs N(N−1) arrows and N²(N−1) literal
assigns, the row-backed one writes one column per pick at any N, and a fourth
tab arriving as a row mid-visit keeps the contract, which a chart whose
options are compile-time states cannot express.

**The per-row form carries `role="none"`**, because a `<form>` between the
tablist and its tabs would break the pattern's required child structure.

## The tab order is standard W3C APG

Tab moves focus with no row changing, so a terminal re-asserting focus on every
refresh fights the reader for it. Focus is a singleton, settled like every
two-writer problem here: by adhering directly to W3C APG patterns ([native capabilities](native-capabilities.md#3-w3c-apg-roving-tabstop-roletablist--roletab--tabindex)).

- **The active member holds the tabstop.** APG roving tabstops declare
  `tabindex="0"` on the currently selected item and `tabindex="-1"` on siblings.
- **Focus follows standard browser keyboard navigation.** A
  recorded cause — a one-shot armed by a gesture — is state the rows do not
  hold, so a replay and a jump to the same state could part. A delta between
  two views answers the same either way, and a lane's end or a first paint
  moves nothing without a rule saying so.
- **The column has one writer.** A caret follows only the reader's own row,
  since another reader can write the rest and their move would take this reader's
  focus; a projected caret moves with the row it compares against, so that row
  is held to the same.
- **The reader closes the loop.** A chart drawing `focusin` hears the DOM's own
  moves for patterns like the accordion that keep every affordance in the Tab
  sequence.
- **The arrows and the tabstop are one contract.** `#OneOf`'s `walk` flag
  (`apps/shadcnui/components/one-of.cue`) turns on the arrows and `focusin`
  together: a tabstop with no arrows strands every unchosen option, and arrows
  moving the choice while focus stands still tell a reader nothing. A menu's
  `menuitemradio` set takes neither, since the menu's arrows cross every item.
  One guard, `is-key`, reads `event.key` against a `key` param for every arrow.

Smokes check the call and the tab order; where focus lands is the browser
suite's ([why](../CONTRIBUTING.md#workflows)).

## Vary over a closed set, never over a name

Interpolating `data-order`'s clause would let a row name a column — reflection —
and a reviewer could no longer finish reading what a screen can do. A key of a
map the file states costs nothing, and a key the map lacks is an `OrderError`;
`data-when`'s arms and a machine's states make the same trade. A nested region
is reused only when its filter *and* order match, or a header that writes its
column never re-reads.

The same line splits a `data-key` miss: a literal form id naming nothing is the
markup naming what is not there, and throws; an interpolated one resolving to
nothing is an empty set, so the key stays uncancelled. A declaration that varies
and one that cannot are different declarations.

## Rejected

- **N ARIA columns on one row** — frozen items and N(N−1) arrows; no option can
  arrive as a row.
- **Expressions in `data-when`** — the arm a row picks stops being decidable.
- **Aggregate clauses** — a third fold spelling, weaker than both seats.
- **Wrapping at lane ends** — APG decides it per pattern.
- **Re-asserting focus each refresh, or recording who moved it** — the first
  fights the reader's Tab; the second is state no snapshot restores.
- **A caret over a row another reader can write** — their write moves this
  reader's focus.
- **An interpolated `data-order` clause** — the reads stop being enumerable.
