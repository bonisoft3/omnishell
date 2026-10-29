---
type: concept
title: Screen updates
description: "How the terminal changes the page when data or state changes: rows moved by key, bodies replaced when their source changes, state stamped as attributes that stylesheets draw, and a served document taken over in place."
---

# Screen updates

A screen is rendered once from its markup; after that the terminal changes the
page in place. **When data changes**, rows are moved by key and a body is
replaced when its source changes — there is no virtual DOM to diff. **When state
changes**, the terminal stamps it as attributes and a stylesheet draws them.
Where and how nodes are created at all — the renderer's allowlist, the security
boundary — is [the terminal's](terminal.md#where-nodes-are-created).

Navigation keeps the outgoing screen visible while the destination loads in a
hidden mount. Its subscriptions and automatic writes pause, but its presentation
stays in place. Preparation includes settling derived writes and navigation intents, so a
resolver route does not flash between the source and its final destination.
Once the destination is ready, the shell switches its stylesheet
and visible mount together; a superseded navigation cannot take the screen.
Host-DOM hatches start after the destination is visible, so they can measure its
layout, and the outgoing hatches stop at that handoff. A failed load keeps the
outgoing screen and restores its interaction while reporting the error.

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
- **The static skeleton** has morphlex (`morphScreen`), which never enters a
  list or a hatch and keeps what the reader typed (`preserveChanges: true`);
  it brings a screen to a newer template, served or running, and its rows to
  the newer item ([a pre-rendered page](#a-pre-rendered-page)).

## When a deployment lands

A release is its entry. The door serves every file a page runs or fetches at
its content address, `_immutable-<sha256>-<name>` beside the file, and every
entry document carries the map from logical path to address
(`#pronto-assets`, written by `server/release-addresses.ts`): native imports
resolve through it as an import map, and everything the terminal fetches —
templates, stylesheets, handlers, renderers, adapters, validations,
catalogues — through `assetURL` (`preloads.js`). An address never changes, so a
page cannot run files from two deployments, and a first visit runs the one it
loaded without asking anything else.

The service worker (`offline-first-sw.js`) answers an address from its copy
forever and a navigation from the entry it kept, revalidated behind it: a kept
entry is a whole earlier release, so painting it is coherent, and offline it is
the page. It holds no release state of its own.

An open page learns of a deployment by asking its own address past the worker,
when it is shown again and every five minutes, and reads the map the answer
carries. The difference between the two maps decides what it does
(`release-plan.js`):

- **a screen's template or stylesheet, or a catalogue**: taken in place. The
  page swaps the map `assetURL` reads; each held screen whose files moved is
  morphed to its new template, carrying what the reader typed through the
  morph, and its stylesheet swapped once the new one has loaded what it
  imports; the screen on show and the strip are written in the new words at
  once, and a held screen as it is shown again.
- **anything else** — a handler, a renderer, a validation, the config, a
  shared stylesheet, the interpreter — is code the page runs: it restarts into
  the new entry. It waits while an editable control is focused, a file is
  selected or a form submits; before the reload it records edited identifiable
  controls and `tab` rows, and drops the entries the worker kept, each of
  which names the older release. Rows return only when their schema is
  identical. Recovery belongs to the account that saved it; signing out or
  switching accounts discards it. A plain-text draft stays text when its
  control becomes a rich editor. Passwords and file contents are never
  serialized.

A template that cannot be taken is a deploy that broke the screen, and the
shell's banner takes its place, as a boot's that failed does; one the network
failed to answer is an outage, and the screen on show says `network-error`.
Templates are taken one at a time in the order they arrive: a later one
landing first would be morphed back to the earlier.

On a table read lazily a view is a subset still loading until its rows and its
embeds' have arrived; the store holds its wakes until then, so the keyed loop
never binds a row whose embed is missing ([data](data.md#a-table-read-lazily)).

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

Regions, items, text and filters over collections, styled by CSS, render
wherever a DOM exists. [`interpreter/document.js`](../interpreter/document.js) renders a
route's whole document in linkedom with the interpreter itself: the app's entry
page with the screen in its mount (marked `data-served`), the strip a guest
sees beside it and the head the shell would write (`describe` and the strip are
pure functions over any document, in `chrome.js`, which the shell calls too),
with its canonical, `hreflang` alternates and `og:url` spelled after the origin
it is handed. The head also names the template the screen was rendered from:
`<meta name="pronto-cas">`, `templateHash` of the template's text, which the
shell recomputes from the template it fetches. A document asks for the
terminal's modules after its first contentful paint, observed with a
`PerformanceObserver`, so the page's own bytes have the link until it has
painted. No unit is mounted and no screen script is kept: both are the shell's
to start, on the screen it takes over.

The selected route's existing `files` declarations also supply hydration
preloads. Templates, stylesheets read by the interpreter, and Jessie sources
use fetch preloads; shared stylesheet dependencies use style preloads. These
start alongside the boot modules after first contentful paint, with duplicate
URLs removed. A SPA starts the selected route's source and shared-style hints
as soon as its initial route is resolved, beside its existing template fetch.
Neither path speculates about other routes, data, or images.

On-request rendering waits for the screen's current reads, derived writes and
resulting region refreshes before closing `</body>`. When a caller supplies
`onChunk` (`document.js`), the `<head>` and regions on screens without a fold
(`data-on-mutation`) stream in document order as each region's own read
settles, while screens with a fold hold the stream until their derivations
settle. Browser mounting hides children inside an unsettled region
(`[data-hydrating] > *`) so progressive hydration paints without placeholder
flicker. A derived region's declared auxiliary reads are revisited
when another initial derivation writes their tables. Long-poll streams and
future machine timers do not belong to that finite work. A failed read or
derivation, or a derivation that does not converge, fails the render rather than
caching an incomplete document.

Two callers render one:

- **Before any request**, `omnishell render documents` (`render-documents.ts`)
  writes one per prerendered route per locale from the app's tree on disk,
  against a store that answers no rows: the screen as it stands before its first
  read lands, `data-state="loading"`, with no empty note, since nothing has
  said a list is empty. A slot is drawn from its `data-empty-row`, and a route
  with a region that names no such row is refused, since its rows would move
  what follows it once they land
  ([`document.test.ts`](../test/document.test.ts)). It is handed whatever the
  door that serves it replaces with the deployment's origin.
- **On request**, the server terminal renders one with its rows, against the
  deployment's origin ([the terminal](terminal.md#the-server-terminal)).

The service worker paints a navigation from the entry it kept and revalidates
behind it, so a document on show can be a deploy and any number of row changes
old; it names its own release, so the files the shell fetches to take it over
are the ones it was drawn from ([when a deployment lands](#when-a-deployment-lands)).
The shell takes it over where it stands, by the mechanisms that let a live
screen own markup it did not render
([`served-adoption.test.ts`](../test/served-adoption.test.ts)):

- **The skeleton is kept, or morphed.** The first `show()` hands the served
  screen to `interpretScreen`, which prepares the screen's template as a mount
  would and reads the served tree against it (`adoptTree`): what a render holds
  only in memory — a placeholder attribute's template, a list's item templates
  — is set on the served node it became, the route's declared host-DOM hatches
  mount in place, and the words are rewritten only where the catalogue says
  otherwise. Where `pronto-cas` is not the fetched template's hash,
  `morphScreen` brings the skeleton to the template, entering slots, which
  nothing has bound yet, but no list or hatch, and leaving every bound text and
  attribute as served until its binding writes it; a region's own attributes
  are its read, and take the template's. A served tree that is not its
  template's render is a `ProgramError`, not a partial adoption.
- **Rows are adopted by key.** On a region's first pass, a child already
  carrying a row's `data-id` becomes that row's node instead of a fresh clone
  (`stamp` in `screen.js`), its bindings read off the item template, and the
  pass binds it to the row as the store holds it now; a row the store no longer
  holds goes with the sweep. A row an older template drew is morphed to the
  current item first, as the skeleton was. What a region renders must survive a parser: its empty note
  in a table section is a row, since a `<p>` there is moved out of the table
  when the served page is read
  ([`m-ssr-hydration.test.ts`](../test/m-ssr-hydration.test.ts)).

Nothing on show is replaced, so the reader's focus, scroll, selection and
anything typed stay where they are; a control typed into before the shell
arrived is held as edited, as one typed into after is. There is no fade and no
jump to the top, and `data-served` comes off once the screen is bound. A
served strip naming the strip's routes is kept, its words and addresses
rewritten in place, and its guest box bound; one naming others is another
deploy's and is drawn again. A kept document that names no template, or draws a
screen its address no longer maps to, is a deploy the shell is not, and gives
way to a fresh mount. A tab opened offline holds no session, since one lives in
the tab: the document stays the page, unbound, until a guest session can be
minted ([`nav-smoke.js`](../interpreter/nav-smoke.js)).

A newer template taken in place ([when a deployment
lands](#when-a-deployment-lands)) reaches a screen through the handle's
`morph`, once the screen is mounted, and ends where a mount of the newer
template would, keeping every node it leaves standing with the reader's focus
and anything typed in it. The skeleton is morphed as above, and each region
still reading what it read follows: a list takes its items from the newer
template and morphs the rows it holds to them, so a row drawn before and a row
stamped after are the newer item's, and a slot morphs its own markup down to
the regions under it; the regions under either follow in turn, and the pass
after binds what changed and wires what arrived. A region the newer template
adds, or whose read (`data-live`, `data-filter`, `data-order` and the rest a
region reads once) it changes, stands as a fresh copy of its markup and is
hydrated as a mount would hydrate it; one it drops is stopped. The hatches and
named templates the newer markup names are resolved before the screen or
anything it reads by name is touched, so a template that cannot be taken is not
partly taken. A screen the reader leaves meanwhile is stopped and morphs no
further; one held for a back press takes the newer template and listens again
as it resumes. Its ordinary markup never runs scripts. Declared host-DOM
hatches stop before a morph and mount again after its regions are ready; a
paused screen waits until resume.

The document names no position in the change log to resume its rows from:
they become current through the regions' first reads and the live stream, and
Electric resumes a shape only from a handle of its own
([pending](../PENDING.md#the-terminal)).

## When state changes

The terminal ships no style. It stamps state as attributes at moments no screen
could observe — a screen's lifecycle in `data-state`, a form in flight, a row
not yet synced, arriving (`data-enter`) or leaving (`data-exit`) — and the
design layer (`shell/design.css`, emitted from the program)
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
