---
type: reference
title: The binding vocabulary
description: Every data-* attribute the terminal answers or stamps, the placeholder grammar every attribute may carry, and the escape.
---

# The binding vocabulary

Every `data-*` the terminal answers, and the one rule that keeps the list from
being the whole story. How to use them is [GUIDE.md](GUIDE.md).

**A screen is interpreted, not compiled**, so the file a reviewer signs is the
file that runs ([rejected](#rejected)). `shell/shell.yaml` carries no screen
semantics: every one lives in the markup where a reviewer reads it. Being
reviewed source, screen markup is not filtered by the renderer's allowlist, so
the platform's own primitives — `popover` (`popover="auto"` / `popovertarget`),
`<dialog>` (`<form method="dialog">`), `commandfor`, anchor positioning, and
W3C APG patterns — need no vocabulary here. Why native capabilities are
preferred over custom framework shims is argued in
[Native capabilities](docs/native-capabilities.md).

## Placeholders

**Any attribute may carry `{field}`, and the binder resolves it against the
row.** `data-suit`, `data-hue`, `data-done` are not vocabulary — they are an
app's own columns reflected onto an element so a stylesheet can match them.
Nothing declares them and nothing here lists them.

A placeholder names one of four things, told apart by prefix in `lookup()`
(`interpreter/screen.js`); nothing else is admitted inside the braces:

| Placeholder | Resolves to |
|---|---|
| `{col}`, `{a.b}` | a dot path into the bound row. A column the row lacks throws `binding {x} not in row`, except on a row whose write is still in flight, which carries only what was submitted; a null embed (a joined row RLS hides) binds blank |
| `{param.x}` | the route parameter `x`; an unknown name throws |
| `{msg.key}` | the message `key` in the active locale's catalogue, then the app's default catalogue; `a.b` descends into a nested catalogue. A key neither answers throws — the markup named a message nobody wrote |
| `{msg[column]}` | the message whose key the ROW carries in `column`: a writer stored a key rather than a sentence, so the reader's locale chooses the text. A column holding nothing renders nothing, and a key no catalogue answers renders as the key itself, because row data never takes a screen down (`check i18n` reports it) |

`data-machine` is a declaration: its placeholders remain intact during DOM
binding. An effect resolves them against the machine row after its transition's
assignments, so `{title}` inside `effect.values` reads the draft at submit time.

Messages are text content and attribute values, never CSS generated content:
the human, the screen reader and the test runner all read the DOM, and CSS
`content` is invisible to the accessibility tree, to find-in-page, to the
clipboard and to `getByRole`, and cannot reach a `placeholder`, an `<option>`
or a submit value. Messages are authored in standard ICU MessageFormat syntax
and compiled at build time into JSON ASTs; screens bind them with `{msg.key}`,
evaluating arguments, plurals, and selects dynamically with zero runtime
dependencies in pure SES via endowed `Intl.PluralRules` and `Intl.NumberFormat`.
An arm is text and may interpolate `{col}`, never another `{msg.…}`. `Intl`
is the interpreter's alone — no handler, renderer or validation can reach it,
and only an adapter is endowed with a guarded one — which is why plural selection
and the value formats below resolve here.

The active locale is the most explicit thing the arrival carries: the
address's locale prefix, then `?lang=`, then a bound row's own `locale`
column, then `Accept-Language` negotiated against the app's declared locales,
then the app's default. The router resolves all but the row (`resolveLocale`,
`interpreter/fragment.js`); a slot's row carrying a `locale` column switches
the screen to it when the address decided nothing. At run time direction comes
from the same tag through `Intl.Locale`'s text info (`directionOf`), and an
engine that cannot answer throws rather than assume `ltr`. The entry document's pre-boot `dir`, written
before any script runs, comes from `#RtlLanguages` in `terminal.cue`, a list
`test/locale-resolver.test.ts` grades against `directionOf` for every member and
every tag an app declares.

Three exceptions, each because the empty string is not "absent":

- A **URL attribute** (`src`, `href`, `srcset`, `poster`, `action`,
  `formaction`, `data`) still carrying a placeholder is neutralised until it
  resolves — `src="{image_url}"` is a relative path the document would fetch
  the moment the tree connects, 404ing before any row exists.
- A **boolean attribute** (`disabled`, `checked`, `readonly`, `required`,
  `selected`, `hidden`, `open`, `multiple`) is absent when its bound value is
  empty. `disabled=""` is disabled, so interpolating an empty string would pin
  a control shut.
- A **declaration** is never interpolated in place: `REGION_ATTRS` in
  `interpreter/screen.js` and the `data-read-` family are read with their
  placeholders intact, against a row the binder is not the one holding. The
  binder consumes a placeholder on first resolve, so an order map bound once
  would answer its first key forever — a sort that never sorts again.

## Structure

| Attribute | Meaning |
|---|---|
| `data-screen="<name>"` | the screen root; the emitted CSS is scoped under it, because a screen's stylesheet assumes it owns the screen and not the page |
| `data-live="<table>"` | bind a region to a table; the region is the unit that re-binds when the table changes |
| `data-item` on `<template>` | the row template, instantiated once per result; it holds exactly one element |
| `data-name="<id>"` / `data-template="<id>"` | define a template once and reference it elsewhere in the screen; the referencing region owns the referenced template's `data-when` |
| `data-id` | the row's identity, stamped on each instantiated item |
| `data-verbatim` | the element shows braces on purpose: the [visual lint](docs/visual-lint.md) placeholder scan subtracts the braces it encloses, by count, while it is rendered. The binder does not read it |

## What a region may say

| Attribute | Meaning |
|---|---|
| `data-filter` | a PostgREST filter fragment, parsed once by `interpreter/fragment.js` and read two ways: as predicates for a snapshot, as where-clauses for a live query. A `limit=` in it is a cap applied after ordering; an embed-path filter is untranslatable and the region reads through PostgREST instead |
| `data-select` | a PostgREST select fragment — the embeds a row arrives with |
| `data-order` | the ordering. Where it varies, it is a closed map the file states and a column picks a key of; a key the map lacks is a `ProgramError` ([vary over a closed set](docs/accessibility.md#vary-over-a-closed-set-never-over-a-name)) |
| `data-when` | the same filter grammar, literals only, matched against the row itself. A template with no `data-when` admits every row |
| `data-exit-motion="none"` | rows leave at once, removed in the pass that loses them — for a list whose filter selects one row, where a leaving row beside its replacement is a layout jump. `none` is the only value, and a slot has no rows to leave; either mistake is refused |
| `data-empty` | the empty-state copy, shown when the query returns none. A slot nested in another region's item has no screen state to fall back on, so it owes a declaration: copy, `data-empty=""` for a probe whose output is its presence, or `data-empty-row`; one that states none is refused at generate and by the interpreter |
| `data-empty-row` | the row a region binds when it has none, resolved against the enclosing row as `data-filter` is — a whole `{col}` keeps its type and null, so a draft nested in the row it edits starts from it. A machine region synthesizes one from `{...context, field: initial}`; where both are present they must agree, vetted at generate and never arbitrated at runtime |
| `data-project` | [derived columns](#derived-columns) a region states about its own rows |
| `data-text` | text interpolation from the bound row or singleton |
| `data-reads="a,b"` | the foreign tables a reduce this region wakes receives as `state.rows`, read at each step and never subscribed: a change to one does not wake the region |
| `data-read-<name>` | a named foreign read, resolved per step against the region's current row |

A **slot** is a region with no item template; it binds at most one row. Item
templates are collected with an unscoped `querySelectorAll`, so a region
containing another region is never a slot.

## Derived columns

`data-project` maps an output column to a clause, as JSON:
`'{"selected":{"eq":["id","{value}"]},"posinset":"index","setsize":"count"}'`.
The clause set is closed:

| Clause | Answers |
|---|---|
| `"index"` | the row's 1-based position in the region's filter and order (`aria-posinset`) |
| `"count"` | how many rows the region holds (`aria-setsize`) |
| `{"eq": [column, value]}` | `"true"` or `"false"`; `value` may carry placeholders, resolved against the enclosing row |
| `"next"`, `"prev"`, `"first"`, `"last"` | the key of the neighbouring or end row along the region's order; an end names itself, never wraps |
| `{"next": column}`, any lane kind | the same among the rows sharing `column` — a grid's minor axis |

Answers are merged into each row before binding and never into the stored
rows, so no guard or assign sees them, and a region with a projection re-binds
every row on every pass. Refused at hydration as a `ProjectionError`: an
unknown clause kind; a derived name a stored column already carries; a
projection on a slot; an `eq` naming a column no row carries (a row still in
flight excepted); a spec that is not JSON or not a map of clauses. Refused by
design: a predicate over any rows but the region's and its enclosing row's; an
aggregate (`sum`, `min`, `max` — a fold is a reduce on `data-on-mutation` or a
`#Pipeline`); and an expression in markup, where the answer is another derived
column ([focus and ARIA](docs/accessibility.md)).

## Values

| Attribute | Meaning |
|---|---|
| `data-text-format="plain"` | the default spelled out: the looked-up value as text |
| `data-text-format="datetime"` | the value as a moment in the reader's language and clock — `Aug 2, 09:00` to an American, `2 de ago., 09:00` to a Brazilian. A storybook render pins UTC — the checks' frames and pronto's prerendered documents alike — since an ambient zone would make each differ by where it was rendered |
| `data-text-format="number"` | grouped and punctuated for the reader's language — `1.234,5` to a Brazilian, `1,234.5` to an American |
| `data-text-format="money"` | the same, with the currency the bound column declares (`#Field.money`). The column is an integer count of minor units and the code and scale are the column's, never the attribute's; a column declaring none is refused at hydration and by `check markup` |
| `data-text-format="<name>"` | an app renderer, resolved by basename out of the route's `files.renderers` — a pure `(value) => nodes` Jessie module. `interpreter/render.js` owns the node schema, the tag and attribute allowlists, the URL-scheme check and the DOM write, so a renderer emits no markup it was not granted. A name colliding with a built-in is refused |
| `data-value` | bind a form control's value from the row. A control the reader has touched is left alone until its form submits or resets — regions re-bind on any change to their table, so binding through would wipe an unsent edit. Checkboxes are exempt: their value is the state, and a refused toggle must roll back where the reader can see it. In a hidden input, `{now}` is the terminal's clock and `null` is JSON null |
| `data-value-adapter="<module>"` | the [adapter](#adapters) a control's value crosses |

### Adapters

A control is the one holder that does not keep a column's canonical spelling: a
`datetime-local` holds local wall time with no zone, and the column holds an
instant. `data-value-adapter="<module>"` names a Jessie module whose value is
`{format, parse}` — `format(value, {zone})` fills the control at bind,
`parse(text, {zone})` makes the column at serialize — one module for both
directions, because two halves that can drift are two bugs. The reader's zone
arrives as data. The adapter role alone is endowed with `Intl`, every host
default refused: a service names its locale, its `timeZone` and the instant it
formats, a locale the host lacks throws, and services are constructed with
`new` (the guard is a subclass that stops a module reading its machine by
accident, not a sandbox). An adapter stores numbers — the offset `longOffset`
names — and classifier answers, never a formatter's text, which is the host's
ICU data. Which instant a daylight-saving gap or overlap means is the module's
policy. The terminal ships `wallclock.js` (`datetime-local`) from
`/omnishell/components/`; an app's own lives under `shell/handlers/`. A control
naming none forwards its text unchanged — `date` needs none — and one wanting
seconds says `step="1"`. The value is computed at the click from the control's
current text rather than materialized through a draft row and a derivation:
both inputs are in hand at that moment, so a watermark, a sink and a join
would buy nothing.

## Mutations

`<form data-entity="<table>" data-action="…">` is a command, and it goes
through the same collection layer as everything else, optimistic writes
included:

| `data-action` | Writes |
|---|---|
| `create` | a new row; the form mints its key, because every write carries one so a retry is idempotent |
| `update` | patches the enclosing item's row — a `name="id"` input does not retarget it |
| `upsert` | the row for this natural key — a declared unique, else the primary key — existing or not |
| `delete` | the enclosing item's row, or every row `data-filter` names |
| `navigate` | nothing: with `data-route`, the form's named inputs fill the route's `:params` at submit |

A file input carrying `data-upload` sends its blob to the store's object
bucket first, and the row carries only the resulting key. Validation is the
platform's: the native constraint attributes the compiler derived from the same
CEL that became the SQL check, with the message as markup beside the field.

## Links

An internal link names a route, never a path. The terminal composes the address
from the route table and the page's locale (`routeHref`,
`interpreter/fragment.js`), so the same markup addresses `/regras` and
`/es/reglas`.

| Attribute | Meaning |
|---|---|
| `data-route="<screen>"` | the route whose address becomes this element's `href`. A screen no route serves is a `ProgramError` |
| `data-param-<name>` | the route's `:name`. A param the route takes and the markup does not declare is a `ProgramError`; one declared and bound empty drops the `href`, because the row is saying there is nowhere to go |
| `data-locale="<tag>"` | address the link in that locale instead of the page's — a language switcher is the same link in another locale |
| `data-locale-current` | on a link naming a locale, `aria-current` (the attribute's value, or `page`) when that locale is the page's |

## Behaviour

| Attribute | Meaning |
|---|---|
| `data-on-<type>` | a reduce woken by a DOM event type, resolved like any Jessie module; what it receives is [the reduce contract](GUIDE.md#the-reduce-contract) |
| `data-on-mutation` | woken by a row changing rather than by a reader — the fold seat |
| `data-handler` | the handler a binding site names |
| `data-key='{…}'` | a key in APG's set submits the form it names, the way a form with no submit button submits on change. A literal form id naming nothing throws; an interpolated one resolving to nothing is a no-op |
| `data-drag-handle` | the grab point within a row template; its presence makes a region's items draggable |

A default is cancelled only for a gesture the
markup declared; the displacing set is `contextmenu` (`DISPLACING_EVENTS`,
`screen.js`). Why each is so is [machines](docs/machines.md#gestures-and-cancels).

## Machines

A chart's grammar is `#Machine` in [`machine.cue`](machine.cue), vetted by
`cue vet` at generate and mirrored in `interpreter/lint.ts`.

- **Closed over one row.** Its state is its `field` on a row, which belongs to a
  `tab` or `device` table ([machines](docs/machines.md#the-chart)); leaves see
  `{items: [row]}` and the event and nothing else; every transition lands as
  one stated row. A region with no `data-empty-row` binds
  `{...context, [field]: initial}` plus its filter's equalities.
- **Data, and value positions.** Targets, state names, `initial`, `context` and
  raised types are data. A `guard`, an `assign` value or an `after` delay is a
  literal or a Jessie module called `(state, event, params?)` with literal
  `params`; an assign string is a module reference exactly when it names a
  declared module. `{type: "event", params: {field}}` reads the event's
  `value`, `checked`, `valueAsNumber`, `key`, or `pointerX`/`pointerY` in
  integer parts per thousand of the affordance's own box.
- **Beyond the key sets**, `<type>@<dom-id>` narrows an arrow to one affordance
  and a target prefixed `.` resolves against the enclosing compound state.
  `raise` is delivered after the writes through the reduce's `step()`, under
  its [cap](docs/data.md#the-step-after); `after` is armed on entry, cancelled
  on exit, re-armed by a self-target and timed by the terminal's clock;
  `parallel` regions share the row over disjoint columns (`parallelLint`); a
  `final` substate takes the parent's `onDone`.
- **Refused**: `invoke`, `sendTo`/`emit`, actions naming JavaScript,
  `customElements.define`, shadow DOM. Event keys are DOM types plus the
  synthesized `refused` and `sync_ack`; `*` is not a wildcard.
- **Components** are CUE tags — `omnishell--<name>`, `<app>--<name>` — expanded
  at emit into this vocabulary; the tag survives as an inert wrapper.

### Effects

An arrow's `effect` is `{level?, op: create | update | delete | upsert,
entity?, token?, filter?, values?}`, its `values` literals, `{now}`, the event
leaf or a module, interpolated against the post-assign row. The terminal
performs it through the store and answers the region's charts with `sync_ack`
(carrying `token`) when the store settles it, and with `refused` if the write is
withdrawn, possibly after. An immediate store error also delivers `refused`:
`NonRetriableError` carries `kind: "refused"`, and other failures carry
`kind: "failed"`. Either aborts the rest of that batch. A chart that offers
retry should handle `refused` in every state where a pending write can fail.

| Level | Name | Guarantee | Durability |
|---|---|---|---|
| 0 | `projection` | a function of the row; changes nothing | — |
| 1 | `ephemeral` | a write to a browser-owned row; settles | `tab`, `device` |
| 2 | `compensable` | optimistic; on `refused` the speculative row is withdrawn, never undone by arithmetic | `offline`, `live` |
| 3 | `replicated` | a join-semilattice write; out-of-order CDC converges | `server` |
| 4 | `exterior` | at-least-once delivery, exactly once by token; compensation is explicit | outside the cluster |

The durability column is `#DurabilityEffectLevel`, defined in
[`machine.cue`](machine.cue) and in `plugins/pronto/schema.cue`, and nothing
compares an effect against it. `machineLint` refuses an effect stating
`level: 2` or `"compensable"` in a chart with no `refused` arrow; an effect
naming no level escapes it ([machines](docs/machines.md#effects)).

## What the terminal stamps

Hooks a stylesheet or a test observes and never writes:

| Attribute | On | When |
|---|---|---|
| `data-state` | the screen root | its lifecycle — `empty`, `loading`, `populated` from the query; `gone` when a top-level slot loses its row and the route declares that state; `form-submit`, `success`, `validation-error`, `network-error` from the form engine |
| `data-submitting` | a form | its write is in flight |
| `data-pending="true"` | a row's node | the row has not synced yet |
| `data-enter` | a row's node | it is arriving; removed once its entry animation settles |
| `data-exit` | a row's node | it is leaving; it is also `inert` and loses its ids, because its replacement may carry the same ones |
| `data-dragging` | a row's node | it is being dragged |
| `data-entering` | the arriving `.shell-screen` | the frame before its entry transition |

## The escape

`data-hatch` mounts a vendored unit, and `data-prop-*` are its props in —
resolved against the row by the same binder as every other attribute and
resynchronised on every refresh, so a hatch sees a current-value feed rather
than a message it has to keep up with. What comes back out is named and
request-shaped, and crosses as a parsed, frozen event (`parseDetail`). This is
the only rung where code the terminal did not emit runs on a reader's device.
A unit declares its seat, a frame or a worker; what each seat grants and
performs is `terminal.cue`'s `hatch`, and what each buys and what an app owes
an answer is [the terminal](docs/terminal.md#the-seats).

## Rejected

- **A component per screen, bundled** — the artifact a reviewer signs would
  not be the artifact that runs, and every rung below the screen is built on
  those being one file.
- **`data-t` and `data-msg-attr` for message keys** — a message is another
  placeholder prefix in the one expression the binder already resolves, as a
  route parameter is.
- **`data-text-format="currency:<col>"`** — a colon is a second grammar inside
  an attribute value, carrying a fact the column already states.
