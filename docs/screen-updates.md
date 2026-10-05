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
exists. [`interpreter/document.js`](../interpreter/document.js) renders a
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

The service worker paints a navigation from the copy it kept and revalidates
behind it, so a document on show can be a deploy and any number of row changes
old. The shell takes it over where it stands, by the two mechanisms that let a
live screen own markup it did not render
([`served-adoption.test.ts`](../test/served-adoption.test.ts)):

- **The skeleton is kept, or morphed.** The first `show()` hands the served
  screen to `interpretScreen`, which prepares the screen's template as a mount
  would and reads the served tree against it (`adoptTree`): what a render holds
  only in memory — a placeholder attribute's template, a list's item templates
  — is set on the served node it became, the template's scripts run in place,
  and the words are rewritten only where the catalogue says otherwise. The
  document and the worker's copies of its template and stylesheet are each any
  deploy old, and a hash says only that two differ, not which is newer: where
  `pronto-cas` is not the fetched template's hash, or the stylesheet the
  document carries inline is not the fetched one, both files are asked again
  with `cache: "no-cache"`, which the worker answers from the network, and from
  its copy only offline or when the server fails it (a 5xx). The stylesheet is then the current one, and
  `morphScreen` brings a skeleton whose template moved on to it, entering
  slots, which nothing has bound yet, but no list or hatch, and leaving every
  bound text and attribute as served until its binding writes it; a region's
  own attributes are its read, and take the template's. A served tree
  that is not its template's render is a `ProgramError`, not a partial
  adoption.
- **The words are the current catalogue's.** The worker's copy of a catalogue
  is any deploy old too, and the screen writes its words again as it takes the
  document over: a copy older than the document would write it back to older
  words. The document names the catalogues it is drawn in, `pronto-words`, each
  `tag:hash` (`templateHash` of the catalogue's text), and the shell asks the
  network again, `cache: "no-cache"`, for each it holds otherwise before the
  first `show()` ([`nav-smoke.js`](../interpreter/nav-smoke.js)).
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

A catalogue the worker revalidates to a newer one is announced as a template
is, and taken once the shell's own request for it has landed: the screen on
show and the strip are written in it at once, and a held screen as it is shown
again.

A template the worker revalidates to a newer one reaches the screen on show
through the handle's `morph`, once the screen is mounted and on show, and ends
where a mount of the newer template would, keeping every node it leaves
standing with the reader's focus and anything typed in it. The skeleton is
morphed as above, and each region still reading what it read follows: a list
takes its items from the newer template and morphs the rows it holds to them,
so a row drawn before and a row stamped after are the newer item's, and a slot
morphs its own markup down to the regions under it; the regions under either
follow in turn, and the pass after binds what changed and wires what arrived.
A region the newer template adds, or whose read (`data-live`, `data-filter`,
`data-order` and the rest a region reads once) it changes, stands as a fresh
copy of its markup and is hydrated as a mount would hydrate it; one it drops
is stopped. The modules the newer markup names are loaded, and the hatches and
named templates it names are resolved, before the screen or anything it reads
by name is touched, so a template that cannot be taken is not partly taken.
The modules are named in the config, which the worker keeps as it keeps a
template but announces no change of, so before a newer template is taken the
shell asks the network for the config, `cache: "no-cache"`: one the deploy
changed is a newer app than the one running, and the document is replaced
([`nav-smoke.js`](../interpreter/nav-smoke.js)). A module the network fails to
answer, or answers with a 5xx, is an outage: the screen stays as it was, says
`network-error`, and takes the template the next time it is shown. Anything
else is a deploy that broke the screen, and the shell's banner takes its place,
as a boot's that failed does. Templates are taken one at a time in
the order they arrive: each waits on its own modules, and a later one landing
first would be morphed back to the earlier. A screen
the reader leaves while those load is stopped and morphs no further; one held
for a back press takes the newer template and listens again as it resumes. Its
scripts do not run: a screen's scripts run once, where it is first mounted.

The document names no position in the change log to resume its rows from:
they become current through the regions' first reads and the live stream, and
Electric resumes a shape only from a handle of its own
([pending](../PENDING.md#the-terminal)).

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
