---
type: concept
title: Screen updates
description: "How the terminal changes the page when data or state changes: rows moved by key, bodies replaced when their source changes, state stamped as attributes that stylesheets draw."
---

# Screen updates

A screen is rendered once from its markup; after that the terminal changes the
page in place. **When data changes**, rows are moved by key and a body is
replaced when its source changes — there is no virtual DOM to diff. **When state
changes**, the terminal stamps it as attributes and a stylesheet draws them.
Where and how nodes are created at all — the renderer's allowlist, the security
boundary — is [the terminal's](terminal.md#where-nodes-are-created).

## When data changes

The terminal never diffs a virtual tree; keyed reconciliation is the bill for
that. Three mechanisms, each owning one kind of change:

- **Rows** reconcile in `screen.js`'s keyed loop: the `live` Map keyed on
  `row.id`, surviving nodes moved with `Element.moveBefore()`, or with
  `insertBefore` for a node not yet connected or on an engine without
  `moveBefore`.
- **Bodies** — a renderer's output — reconcile by `render.js`'s memo on the
  interpolated source string, compared before anything is parsed and rebuilt
  wholesale when it changed.
- **The static skeleton** has morphlex (`morphScreen`), which halts at every
  `[data-live]` and `[data-hatch]` with `preserveChanges: true` and never
  touches a row; nothing in the interpreter calls it
  ([a pre-rendered page](#a-pre-rendered-page)).

On a table synced on demand a view is a subset still loading until its rows
and its embeds' have arrived; the store holds its wakes until then, so the
keyed loop never binds a row whose embed is missing
([data](data.md#a-table-synced-on-demand)).

A row is painted once the regions nested in it have made their first
attempt, and the screen says `populated` once its top regions' rows are and no
region says an outage, so `populated` means what it shows is on it. A nested
region whose first read fails lets its row in standing empty and says
`network-error`, retrying on its backoff; whichever region in outage reads
again last puts the state back, however deep it is. A read that never answers
thus holds neither its row nor its list's later passes. A render that throws
once the store has answered is said on the console and retried on the region's
backoff, as an outage is.

Every number below was measured in Playwright's Chromium with the harnesses in
[`reconciliation-spike/`](reconciliation-spike/README.md), so it can be re-run
rather than believed.

### Node state must survive a move

The metric is node-state survival, not operation count. Swapping two distant
rows of a 20-row list, each holding a sandboxed iframe:

| strategy | DOM ops | iframe reloads |
|---|---|---|
| keyed loop + `insertBefore` | 13 | 13 |
| keyed loop + `moveBefore` | 13 | 0 |
| udomdiff | 2 | 2 |

A library that creates nodes is out before any measurement, because node
creation is [the security boundary](terminal.md#where-nodes-are-created); morphdom
and morphlex pass that test, handed two real trees they create none. A keyed
differ cuts operations sixfold and still reloads frames; `moveBefore`
performs the same moves and reloads nothing, and udomdiff calls `insertBefore`
with no injection point, so the two cannot be combined. The cursor cascade the
loop pays — 997 moves to exchange two rows of 1000 — is linear, sub-millisecond
at every size a screen renders, and free once each move keeps its state.

**The body memo covers the case that arises.** An unchanged 180-block article
costs 0.0003 ms to compare, against 2.0 ms for morphdom to find the same
nothing. When a body does change, morphdom keeps every node and the reader's
selection where `replaceChildren` keeps none — but that is a body changing
under a reader's eyes, which an article read here and edited elsewhere never
does.

### On a feed, the libraries lose on their own terms

Against morphlex, idiomorph and morphdom, with each post a row holding ticking
counters, an unsent draft, a sandboxed embed, a running animation and a nested
comment region:

- **They key on `id`; a region's rows carry `data-id`.** Without a real `id`
  all three morph rows by position: the order looks right, every survival check
  passes, and the node holding a reader's half-written reply now sits under a
  different post. The loop's `row.id` is a stronger key than any library derives
  from the DOM.
- **A DOM-to-DOM morph needs a throwaway target list** of N bound rows before it
  can compare. At 200 rows a ticking counter costs 1.0 ms in the loop against
  7.0 ms in morphlex and 7.7 ms in idiomorph.
- **morphdom does not use `moveBefore`**: one post arriving at the head of a
  200-row feed reloads 201 iframes and drops focus.
- **Five behaviours would have to be re-taught through callbacks**: exit
  animations (`playExit`), nested regions (another hydrator's output, absent
  from any target tree), unsent input (`_prontoDirty` — idiomorph's
  `ignoreActiveValue` clobbered a draft in a row the reader had left), hatch
  lifetime, and once-per-node form wiring. No library offers an order-only API.

### What would reopen it

- **A body that changes under a reader's eyes** — a live preview, a streamed or
  generated body, comments appended while reading — makes morphdom right for
  `render.js`: it creates no nodes, so the allowlist keeps owning them, and no
  keying is involved.
- **The cursor cascade showing in a profile** wants a longest-increasing-
  subsequence pass over `screen.js`'s own `order` array: about fifteen lines,
  no dependency, no target tree, no `id` invariant.
- **Grafting server HTML into a live screen** is morphlex's
  `morphInner(parent, target)`. It re-inserts inter-element whitespace it
  refuses to match, so pretty-printed item markup costs extra operations per row
  per pass.

## A pre-rendered page

Regions, items, text and filters over collections, styled by CSS, are
synchronous once the rows are in memory, so a screen renders wherever a DOM
exists: `storybook.js` renders one against a fixture store with no cluster and
no auth, in a browser or in linkedom, and that is the renderer a build uses to
write a route's document ahead of time. No unit is mounted in a fixture render;
a hatch is its `data-hatch` element until a live screen mounts it.

Two mechanisms let a live screen take over markup it did not render:

- **Rows are adopted by key.** On a region's first pass, a child already
  carrying a row's `data-id` becomes that row's node instead of a fresh clone
  (`stamp` in `screen.js`, [`m-ssr-hydration.test.ts`](../test/m-ssr-hydration.test.ts)).
  The key comes from the data, so adoption is one pass and a newer row is a
  delta to apply rather than a mismatch to reconcile, which is what makes
  hydration hard for a framework that matches by position. What a region
  renders must survive a parser: its empty note in a table section is a row,
  since a `<p>` there is moved out of the table when the served page is read.
- **The skeleton morphs in place.** `morphScreen` runs morphlex over a screen's
  static markup, never descending into `[data-live]` or `[data-hatch]`, and
  keeps what the reader typed (`preserveChanges`,
  [`morph-screen.test.ts`](../test/morph-screen.test.ts)). A screen handle
  exposes it as `morph`.

The shell replaces its mount's contents when it boots (`mount.replaceChildren`),
so a document rendered before the page's own boot is painted and then replaced,
not adopted.

## When state changes

The terminal ships no style. It stamps state as attributes at moments no screen
could observe — a screen's lifecycle in `data-state`, a form in flight, a row
not yet synced, arriving (`data-enter`) or leaving (`data-exit`), a screen
entering — and the design layer (`shell/design.css`, emitted from the program)
owns every rule, motion tokens included. The stamps are
[REFERENCE's table](../REFERENCE.md#what-the-terminal-stamps); a stylesheet and
a test read them and never write them. An app that styles nothing still works.

**Motion lives in stylesheets.** A stamp drives whatever keyframes the design
binds, and the terminal waits on the animations that actually start
(`getAnimations`) before it releases the slot: a leaving row stays in the list,
`inert` and stripped of its ids, until its exit finishes, capped at 1 s so an
animation that never settles cannot strand it. Where none run — a
reduced-motion reader, an engine without the Animations API — release is
immediate. Past 32 rows arriving or leaving in one pass, the pass is a load and
plays no motion: each animated node costs a frame and a style resolution.

**A reduce may wake on motion.** An `animationend`, `animationiteration` or
`transitionend` is a DOM event like any other, so `data-on-<type>` names a
reduce for it, and the event carries `animationName` so a reduce can tell its
own animation from the terminal's arrivals bubbling to the same region. Time
itself is the terminal's clock — `then` and `after` ([machines](machines.md)).

## Rejected

- **A virtual DOM** — a pure `view` diffed each pass would make the served
  artifact code rather than data a reviewer signs and a lint reads
  ([the terminal](terminal.md)).
- **Computing presentation in the terminal** — inline styles or classes the
  binder picks would put design in the runtime and the app's styling out of
  the stylesheet a reviewer reads; the terminal stamps state and stops.
- **Template-literal renderers and snabbdom** — they create nodes, moving the
  security boundary out of the terminal ([terminal](terminal.md#where-nodes-are-created)).
- **udomdiff for rows** — fewer operations, but `insertBefore` reloads every
  moved frame.
- **morphdom, idiomorph or morphlex for rows** — keyed on `id`, a throwaway
  target list per pass, and (morphdom) no `moveBefore`: disqualified, not
  deferred.
- **incremental-dom** — out on maintenance alone.
