# The binding vocabulary

Every `data-*` the terminal answers, and the one rule that keeps the list from
being the whole story. A screen is markup the shell interprets at runtime —
there is no build step and no component per screen — so this vocabulary is the
entire interface between what `program.cue` emits and what a reader sees.

The claim worth arguing, because the table below rests on it: **a screen is an
interpreted artifact, not a compiled one.** The alternative was emitting a
component per screen and letting a bundler own the result. It was refused
because the artifact a reviewer signs would then not be the artifact that runs,
and every rung of the ladder below the screen is built on those being the same
file. `shell/shell.yaml` is deliberately not a DSL for the same reason: it maps
routes to files and carries nav labels, and every screen semantic lives in the
markup where a reviewer reads it.

## The rule that makes this list short

**Any attribute may carry `{field}`, and the binder resolves it against the
row.** `data-suit`, `data-hue`, `data-done` are not vocabulary — they are an
app's own columns reflected onto an element so a stylesheet can match them.
Nothing needs to declare them and nothing here lists them.

Three exceptions the binder makes, each because the empty string is not
"absent":

- A **URL attribute** (`src`, `href`, `srcset`, `poster`, `action`,
  `formaction`, `data`) still carrying a placeholder is neutralised until it
  resolves — an unresolved `src="{image_url}"` is a relative path the document
  would fetch the moment the tree connects, and it 404s before any row exists.
- A **boolean attribute** (`disabled`, `checked`, `readonly`, `required`,
  `selected`, `hidden`, `open`, `multiple`) is absent when its bound value is
  empty. `disabled=""` is disabled, so interpolating an empty string would pin
  a control shut.
- The **region attributes** below are never interpolated in place. They are
  declarations read with their placeholders intact, against a row the binder is
  not the one holding; binding an order map once would answer its first key
  forever, which is a sort that never sorts again.

## Structure

| Attribute | Meaning |
|---|---|
| `data-screen="<name>"` | the screen root; the emitted CSS is scoped under it, because a screen's stylesheet assumes it owns the screen and not the page |
| `data-live="<table>"` | bind a region to a table; the region is the unit that re-binds when the table changes |
| `data-item` on `<template>` | the row template, instantiated once per result |
| `data-name="<id>"` / `data-template="<id>"` | define a template once and reference it from elsewhere in the screen; the referencing region owns the referenced template's `data-when` at runtime |
| `data-id` | the row's identity, stamped on each instantiated item |
| `data-state` | the shell's own per-screen lifecycle — `empty`, `loading`, `populated` from the query, `form-submit`, `success`, `validation-error`, `network-error` from the form engine. Screens style it and never transition it; it is the hook the flow and visual tiers observe |

## What a region may say

The closed set, and it is closed in code — `REGION_ATTRS` in
`interpreter/screen.js`, plus the `data-read-` prefix.

| Attribute | Meaning |
|---|---|
| `data-filter` | a PostgREST filter fragment, parsed once by `interpreter/fragment.js` and read two ways: as predicates for a snapshot, as where-clauses for a live query. A `limit=` in it is a cap rather than a predicate, applied after ordering; an embed-path filter is untranslatable and the region reads through PostgREST instead |
| `data-select` | a PostgREST select fragment — the embeds a row arrives with |
| `data-order` | the ordering. Where a header sorts, it is a closed map: the interpreter reads the attribute raw, so no column interpolates into it |
| `data-when` | the same filter grammar, matched against the row itself. A template with no `data-when` admits every row |
| `data-empty` | the empty-state copy, shown when the query returns none |
| `data-empty-row` | the row a region binds when it has none. A machine region synthesizes one from `{...context, field: initial}`; where both are present they must agree, vetted at generate and never arbitrated at runtime |
| `data-project` | derived columns a region states about its own rows, merged into each row before binding. The clause set is closed and its refusals are the point — `2026-09-01-aria-is-columns.md` |
| `data-text` | text interpolation from the bound row or singleton; `{param.x}` reads a route param, any other expression is a dot path into the row |
| `data-reads="a,b"` | the foreign tables this region depends on, so a change to one wakes it |
| `data-read-<name>` | a named foreign read, resolved per step against the region's current row |

## Values

| Attribute | Meaning |
|---|---|
| `data-text-format="datetime"` | render the interpolated value as the app's one fixed UTC timestamp |
| `data-text-format="<name>"` | an app renderer, resolved by basename out of the route's `files.renderers` — a pure `(value) => nodes` Jessie module. `interpreter/render.js` owns the node schema, the tag and attribute allowlists, the URL-scheme check and the DOM write, so a renderer can emit no markup it was not granted |
| `data-value` | bind a form control's value from the row. A control the reader has touched is left alone until its form submits or resets — regions re-bind on any change to their table, so binding through would wipe an unsent edit. Checkboxes are exempt: their value is the state, and a refused toggle must roll back where the reader can see it |

## Mutations

Forms only. `data-form` with `data-entity` and `data-action` names the mutation
— create inserts, update patches the enclosing item's row, delete removes it —
and it goes through the same collection layer as everything else, optimistic
writes included. Validation is the platform's: the native constraint attributes
the compiler derived from the same CEL that became the SQL check, with the
message as markup beside the field.

## Behaviour

| Attribute | Meaning |
|---|---|
| `data-on-<type>` | a handler for a DOM event type, resolved like any Jessie module |
| `data-on-mutation` | woken by a row changing rather than by a reader — the fold seat |
| `data-handler` | the handler a binding site names |
| `data-machine='[…]'` | one or more charts over one row, each mounted knowing nothing of its siblings and sharing only the row a transition states. Duplicate fields are refused at mount; the grammar itself is `plugins/omnishell/machine.cue` |
| `data-key='{…}'` | a key in APG's set submits the form it names, the way a form with no submit button submits on change |
| `data-focus="{column}"` | move focus to the member whose column reads true, leaving the tab order alone. Acts only when the reader is already inside the region and on another member, and needs the region's chart to hear `focusin` — otherwise the reader's own move is undone on the next refresh |
| `data-rove="{column}"` | a roving tabstop: the member whose column reads true is in the tab order, every other member is out of it, and focus moves there when a declared gesture moved the column and never otherwise — `2026-09-03-the-reader-is-also-a-writer.md` |
| `data-open` | open the popover this element names; a program error on an element that declares none |
| `data-interest` | the element a hover or focus opens, which must be `popover="auto"` so light dismiss and Escape stay the platform's — WCAG 1.4.13's half that no script should be reimplementing |
| `data-drag-handle` | the grab point within a row template; its presence is what makes a region's items draggable |

## The escape

`data-hatch` mounts a vendored unit inside an iframe, and `data-prop-*` are its
props in — resolved against the row by the same binder as every other attribute
and resynchronised on every refresh, so a hatch sees a current-value feed rather
than a message it has to keep up with. What comes back out is named and
request-shaped. This is the only rung where code the terminal did not emit runs
against a reader's screen, and the iframe is why: a vendored unit is trusted
because an engineer audited it, and contained because what it renders was
audited by nobody.
