---
type: concept
title: The terminal and its units
description: What the terminal owns and what a unit may do — the surfaces it hands in, the unit ladder, the compartment, realm and agent seats with the agent's question and presenter roles, and the server terminal that renders documents on request.
---

# The terminal and its units

The terminal is a host. It owns what cannot be federated and mounts units into
boxes; every unit receives collections, returns requests, and reaches nothing
else. The cluster can stay small because its escape is unbounded — "add a
container" absorbs whatever mecha declines to be — and a terminal without one
turns every unmet need into a core feature, so the hatch comes before
vocabulary.

## What the terminal owns

**Four surfaces.** *Collections* — all state, the session and the route
included, read-only where a unit should not write; the one data interface
every unit receives. *Markup* — slots; the element carrying `data-hatch` is the
slot. *Returned requests* — a unit describes and the host performs: a reduce
returns `{updates, then}`, a machine transition effects and a `raise`, a hatch
posts named events. *Ports* — hatches only (ports and adapters, Cockburn
2005): `reads`, the tables whose row a mount's `data-prop-*` are read off,
and `raises`, the events a mount's `data-on-*` may hear. The terminal is the
adapter on both and grants nothing else at either seat: a mount fed a region
outside `reads` is refused (`screen.js`), an event outside `raises` is refused
where it would become a DOM event (`hatch.js`), and `check markup` says both
before any mount and that every raise is handled somewhere.

**What cannot be handed to a unit.** The durable outbox is leader-elected per
origin through Web Locks, so two of them means one wins and the other's writes
silently stop being durable; the shape connections share one connection budget
per origin. Everything else is handed in.

**The host is one interface with three adapters**: *fixture* over fixture
collections, *local* over PGlite collections in the page, and *synced* over
Electric collections.

## The markup boundary

Screen HTML is parsed in an inert template and checked before its nodes are
mounted. Scripts, inline handlers, executable URLs, `srcdoc` and embedded
objects are refused, including inside nested templates. The compiler's markup
check uses the same refusal. The terminal never executes a screen's scripts. A route may explicitly name a
`host-dom` hatch in its manifest: trusted ES modules with ambient host access,
served and versioned with the release. Their mount receives the screen,
messages, params and an abort signal and returns cleanup. Pause, stop and morph
abort and clean up; resume and a visible morph mount again. See the
[[../../pronto/SPEC|artifact contract]] for declarations and obligations.

Pronto emits the terminal's CSP at the door and in the entry page; verified
release caching retains it. The only Trusted Types policies are the inert
parser, same-origin script URLs, and SES's eval/Function crossing while the
platform evaluates a compartment. The eval policy never accepts HTML or
script elements. These are the reviewed sinks in the
[Trusted Types model](https://www.w3.org/TR/trusted-types/#dom-xss-injection-sinks).
Remote presentation resources require the app's explicit declaration
([[../../pronto/SPEC|artifact spec]]); scripts cannot be added that way.

## Units

| unit | receives | brings its own build |
|---|---|---|
| handler | its arguments, nothing else | no |
| region | collections, its filter | no |
| screen | collections, params | no |
| hatch | props off the row of a table its ports read, a channel for the events its ports raise | yes |

CUE declares what exists — entities, screens, routes, access, design. Jessie
maps between vocabularies, one role per shape of answer (`interpreter/jessie.js`):
a handler's reduce, a renderer's node description, a validation's boolean, an
adapter's `format`/`parse`, a fold's `empty`/`step`/`combine`/`result`.
Everything else is assembly, the HTML and CSS a unit renders.

**Returned requests are Elm's `Cmd`**: not a workaround for a sandbox but what
lets a unit stay a function of its inputs. The cure for a reduce feeling
Redux-ish is the command in the return, not abandoning reduction. Subscriptions
are declared in markup (`data-live`, `data-on-<type>`), and time is the
terminal's — a reduce asks for a beat with `then`, a machine with `after`
([machines](machines.md)) — so no role reads a clock. The deliberate fork from
Elm is the view: assembly rather than a pure `view`, so the artifact is data
that can be served and linted, and keyed reconciliation is the bill
([screen updates](screen-updates.md)). Elm has the same bounded core and narrow hatch,
and ports are its community's most persistent complaint: it validates the shape
and shows the failure mode.

Screens are app source reviewed at the ir, so they are not filtered by the
renderer's allowlist ([REFERENCE](../REFERENCE.md)), and the browser
supplies the widget runtime they need. Checked by launching each engine
(Chromium 147.0.7727.15, Firefox 148.0.2, WebKit 26.4): `popover`,
`<dialog>`/`inert`, anchor positioning (`anchor-name`, `position-area`,
`position-try`) and `command`/`commandfor` work in all three; `interestfor` in
none. A date picker and a combobox driven through the real dispatcher touched 58
DOM members between them, 49 shared, every upward-escaping one for measurement,
placement, dismissal or focus: one shared runtime, which the platform is.

## Where nodes are created

The allowlist, the URL-scheme check and `createElement`/`textContent` are the
only way the terminal makes a node, which is what a renderer's output is held
to (`render.js`'s node schema, [REFERENCE](../REFERENCE.md)); screen markup, as
reviewed source, is not. A library that creates nodes would move that boundary
into code every upgrade needs audited, which rules out every template-literal
renderer (lit-html and kin) without measurement — the guarantee is that there
are no HTML strings — and snabbdom, whose `props` module assigns DOM properties
directly. How existing nodes are changed afterwards is
[screen updates](screen-updates.md).

## The seats

A sandboxed iframe buys containment and no thread. A 1.5 s busy loop, the
parent's main thread sampled every 20 ms in headless Chromium: 1500 ms worst
gap inline, 1501 ms in a sandboxed `allow-scripts` frame, 24 ms in a Web
Worker. A hatch's `src` resolves against the app, so the frame is same-site,
shares the renderer process and blocks the parent as completely as inline code.

- **compartment** (`jessie.js`) — no ambient authority, same thread. Every
  app-authored role runs here, endowed with what shell.yaml's `endowments`
  grants it by its path, from `Intl`, `TextEncoder`, `TextDecoder`, `URL` and
  `URLSearchParams`; one it did not declare throws, naming itself. The adapter
  holds `Intl` without declaring it, whole and its host defaults refused. Whole, because the offset in effect at an
  instant is a tz-database lookup and no member of `Intl` does I/O or takes a
  capability: the worst a hostile argument buys is an exception.
- **realm** (`hatch.js`) — a sandboxed iframe, ECMA-262's realm: its own
  globals and DOM, an opaque origin, no storage or cookies, and
  `window.parent` only to post to, never the parent's DOM; same thread. For a
  unit whose untrusted half arrives over the network at read time.
- **agent** (`hatch-worker.js`) — a worker, ECMA-262's agent: its own thread
  and event loop, same origin, so it keeps `fetch`, IndexedDB and the cache
  API: more authority than the realm. For a hash-pinned binary vendored at
  build time, trusted by the app's audit and the pin.

The boundary does not say what a unit is for, which is pronto's derived
`role`: an agent with a memo is a **question** (below), and an agent without
one is a **presenter**.

| role | seat | what stands behind it | it may |
| --- | --- | --- | --- |
| question | `hatch-worker.js` | the app's audit and the pin | ask, and land its answer in the memo |
| presenter | `hatch-presenter.js` | the worker's realm | paint the frames it is handed, and nothing else |

**A presenter's worker can only paint.** `hatch-presenter.js` transfers a
canvas it puts in the mount, fetches the pinned scripts the unit names
(`terminal.cue` `presenter.scripts`) against their integrity, and starts
`presenter.js` as a module worker. That script is served by both doors with
its own Content-Security-Policy (`presenter-security-policy.txt`), which
governs the worker: `connect-src blob:`, `worker-src 'self'` (Firefox and
WebKit check a module worker's own imports against it),
`script-src 'self' 'unsafe-eval'`, so the network and stray code are the
browser's to refuse. What `script-src 'self'` still admits is a module import
of this origin, a credentialed GET; it arrives as a script's
(`Sec-Fetch-Dest`, `terminal.cue` `presenter.scripted`), and both doors answer
one from a static file only, never from an upstream, whose GET may act. The
worker evaluates the pinned scripts, then prunes its
globals to `presenter-realm.js`'s allow-list, each entry with its reason —
storage, locks and the channels between contexts are what a policy cannot
reach — and only then imports the unit, whose default export
`present(canvas, env)` returns `{frame, props?, resize?}`. A presenter is a
view, GGPO's rule: the frames a host hands it may run backwards on a rewind or
a seek, so it keeps only cosmetic state, survives a jump with at worst a snap,
and sends no state or input back. The worker draws each frame as it arrives,
the newest of any that queued. Nothing is sealed:
Babylon writes onto `Array.prototype.push`, which SES refuses
([pronto's record](../../pronto/docs/decisions/2026-10-22-endowed-babylon.md)),
so the realm, not the code, is what holds. The port carries `pronto:frame`,
`pronto:props` and `pronto:resize` in, `pronto:ready` out, and `pronto:read`
both ways for the bytes of a file the unit declares or an object a blob seed
ships; the seat refuses anything else as a `ProgramError`, and a presenter
declares no raise. The one way past the realm is the policy's `'self'`: a
module import of a path on the app's own origin is a GET carrying whatever its
query says to the app's own door, which `playwright-tests/presenter.pw.ts`
pins beside the probes that fail.

`mountHatch` throws for any other isolation rather than substituting a
boundary. A hatch speaks `pronto:props` in and `pronto:ready`/`pronto:event`
out over `postMessage`, never handles — Elm's ports — which is what lets one
unit sit behind a realm or an agent unchanged; the cost is that everything
crosses async.

**An agent is a question, and its memo is the terminal's to perform.** A unit
seated as an `agent` declares a `memo` (shell.yaml `units.<name>.memo`: the
table, the key fields and the columns an answer fills — Michie's memo table,
answers addressed by what was asked). The mount's `data-prop-*` of the key's
names are the question; before it is posted, `hatch.js` queries the table by
those key fields and, finding a row, dispatches the unit's one raised event
with the key as its detail and never asks. An answer the unit posts carries the key and
every column; it is upserted on the key through the store's natural-key
upsert, then dispatched the same way. The reduce hearing the event reads the
answer off the row — one path for a hit and a fresh answer — so the same
question asked twice runs the unit once (`test/hatch-memo.test.ts`). A props
object with a key field empty is the mount withdrawing its question and passes
through; a question or an answer missing a key field, or an answer missing a
column, is refused. Every refusal of the mount and the seats is a
`ProgramError`: a mount and a question run inside the region's refresh, whose
outage guard retries anything else as a dead gateway, and an answer inside the
port's listener, where a throw is the window's `error` event — the shell
banners a `ProgramError` from there as it does one arriving as a rejection,
and leaves anything else to the browser. An answer the store refuses — a
column outside the entity's cel — or a lookup that fails is the unit
disagreeing with the entity it was declared to land in: the same
`ProgramError`, naming the unit and the table, since no reduce authored the
write and so no `refused` event has anywhere to go.

**The terminal parses; the app owes the rest.** Whatever the seat, the
boundary is a parser: `parseDetail` admits at most 8 keys matching
`^[a-z][a-z0-9_]{0,23}$`, each a printable-ASCII string of at most 128
characters, into a frozen record — the offer `terminal.cue` publishes as
`hatch.<seat>.detail`, which pronto's `vendored-unit.test.ts` holds the parser
equal to, and which pronto's `#emit` holds a memo's columns to as far as the
program states them: their count, their names, and the size bound a column
declares; the alphabet, and the length of a column left unbounded, are the
seat's refusal at runtime. A detail
that fails is dropped with its event by the realm seat, whose sender is a
provider's page, and refused by the agent seat, whose sender is the app's own
wrapper — a memo answer lost in silence would be a question standing forever.
What the answer means is the app's to guard, three ways: look it up against
the app's own rows rather than interpret it, so an engine is trusted for
preference and not possibility when no row exists for an illegal move; carry
the epoch it answers and drop it once that has moved on; and never make it
load-bearing, so no answer, a wedged unit or a missing asset leaves the app
playing. The answer reaches the reduce as an event, not a call, so an oracle is
a source at the graph's edge like a reader's click, and every operator stays a
deterministic function of its inputs.

**Separate an engine's impurity before forking it.** Stockfish 18.0.8's
single-threaded lite WASM, driven as a worker, is reproducible from outside the
binary: `Threads 1`, `Hash 16`, never `UCI_LimitStrength` (a static,
clock-seeded PRNG), `ucinewgame` before every search, `go nodes N` rather than
`movetime`. `go nodes 300000` gives the same move from a cleared table, a warm
one and a fresh worker; at `UCI_Elo 1500` five runs gave three moves. The cost
is strength thrown away per move and an uncalibrated node ladder. When
evaluating a library for a unit, look for its one DOM seam first — Zag keeps
DOM access in `@zag-js/dom-query`, so its pure half is the half worth having.

## The server terminal

[`server/render.ts`](../server/render.ts) is the terminal run as a process: a
route's document rendered on request, with its rows, through the same
[`document.js`](../interpreter/document.js) a build renders ahead of time with
([a pre-rendered page](screen-updates.md#a-pre-rendered-page)). It reads the app
as a reader does, through the door it is served behind (`DOOR`): the files the
door serves, a guest it mints, and a store over the door's `/electric`, so every
row it renders passed the shape gate a fresh guest's would. That is what makes
a document cacheable by anyone, and why a route over anything but public reads
is refused rather than rendered with a service token. The one file read off its
image is the entry page, since the door answers the entry's own address with a
redirect.

The renderer preserves the browser's read modes. Only eager collections are
prewarmed before it becomes healthy. Lazy collections load the subsets
each document reads; retained documents hold those query subscriptions until
invalidation or eviction. Request-only `server` reads go through PostgREST for
each document and are not prewarmed: their rows would be discarded. Each render
waits for the rows it reads. Its guest is minted again once half the
token's life is gone (the auth service renews no token, so each is a guest of
its own), and a mint that fails ends the process: a store whose token the gate
refuses stops syncing without a word, and its documents would stand frozen
behind a healthy `/health`. So does a token the door refuses: the store's
reload, which gates a page's reader again, is the renderer's exit.

A document carries the request-only reads its render made, each /crud GET's
body under its path and query, in `<script type="application/json"
id="pronto-reads">`; the shell taking it over answers each of those addresses
from it for a guest the page minted, while it shows the address it was served
at and has written no remote table, and asks the network for the rest. Nothing
of how a read was asked, a token least of all, is carried. The service worker
keeps its copy of a document without them, so a copy it paints, any number of
changes old, reads from the network.

A document containing a `server` read is rendered for each request, including
when that read is a named input rather than a region. Existing schema durability
decides this; it requires no cache declaration. Concurrent requests for the same
document can share its render, but the result is not retained afterward.

Other documents are rendered on their first request and held until a read that
drew them changes. Each read the render makes is listened to the moment it is made,
beside the region that made it and on the same view, and that listener is what
the held document keeps: the store's own wake — the one that refreshes a
region — is what drops it, embeds and filters included, and no change landing
between a read and the hold goes unheard. A render a read moved under is
answered and not held. Nothing guesses a lifetime. An address whose rows do
not exist (a slot gone, or every top-level region its :params select from a
server table empty) answers 404 and is not held. A document's address is its
path and the query keys its screen reads, learnt from the screen's renders
(every key a render asked for and the path did not supply): a query key no
screen reads makes no second document. The door answers any Host, so the Host
decides nothing: every document spells its absolute links after the
deployment's origin, `ORIGIN`, as the door's templated documents do
([mecha's proxy](../../../libraries/mecha/docs/proxy.md#the-origin)), and a
renderer started without one, or with a value that is not exactly an origin,
exits. The cache is
bounded, least recently used first. Answers say `Cache-Control: public,
no-cache` with an ETag hashing the document's bytes: anyone may keep one,
nobody may serve it unasked. The template's hash the document carries
(`pronto-cas`) is no validator for it, since one template draws a new document
at every change to its rows. A
bound control is drawn as a browser shows it, through the control properties
linkedom lacks (`server/linkedom-controls.ts`, shared with the documents
renderer and the test harness). The
interpreter reads one ambient document, so renders are serial; a request for an
address already rendering waits for that render, and past a bounded queue
(`RENDER_QUEUE`) a request is answered 503
([`render-server.test.ts`](../test/render-server.test.ts)). The app's service
worker paints a navigation from the copy it keeps, online or not, and
revalidates it behind the paint, dropping the copy of an address answered 404,
410 or private since ([`offline-sw.test.ts`](../test/offline-sw.test.ts));
the shell brings that copy's rows current where they stand
([screen updates](screen-updates.md#a-pre-rendered-page)).

It reads the app once, as it starts: `shell.json` and every catalogue
through the door, and its entry off its image. So it starts again whenever any
of those may have moved, and with it go the documents it held: a compiler
restarts it with the door and builds its image from every file it reads
beside its entry, and an edit to the entry in a develop loop restarts it too.

`terminal.cue` publishes it as `#Render`: the image (the deno the toolchain
pins), the runtime directories it is built from, the cache step that fetches
from the lock alone, the command and its health address. A compiler runs it
where a route asks to be rendered on request; pronto does
([screens](../../pronto/docs/screens.md#how-a-routes-first-document-is-rendered)).

## Rejected

- **A worker inside a sandboxed frame** — containment on top of the thread, at
  the cost of CORS and blob plumbing, for an embed's threat model: a page
  arriving over the network at read time is not a hash-pinned binary vendored
  at build time.
- **single-spa** — 8 KB gzipped, indivisible, and a second module loader where
  the `data-hatch` element already is the mount point.
- **Remote DOM** (`@remote-dom/core` 1.11.1) — its polyfill covers 24 of the 55
  DOM members the widgets use; the 31 missing include every layout and
  measurement API, `focus()`, `activeElement`, `closest` and `matches`. A
  mirroring DOM is built to run where there is no layout.
- **near-membrane** (`@locker/near-membrane-dom` 0.18.0) — machinery without a
  policy: with no distortions guest code reached `fetch`, the document and
  `document.cookie`, at 15–51× the cost per DOM call. Facades succeed when
  authors write to them and fail when authors bring code expecting the full DOM.
- **zoid** — unpublished since 2022, 3.3 MB, and it marshals functions across
  the boundary, widening a contract the hatch narrows to "the unit describes,
  the terminal performs". Its one good idea, a second origin, is an
  infrastructure decision.
- **A service worker as a seat** — same origin and unsandboxed, able to
  intercept `fetch` for its whole scope, killed and restarted at will: a caching
  primitive, worst at the long-lived stateful work an engine is.
- **Bundling XState as the machine runtime** — `xstate` 5.32.5 is 52 KB with
  ambient `Date.now`, `Math.random` and `setTimeout`; in a compartment it runs
  only with `console` endowed and without `after`. The terminal interprets its
  JSON subset itself ([machines](machines.md)).
- **Phoenix LiveView or an Elm runtime** — both replace the layer that works to
  fix controls and feedback latency, and LiveView holds nothing on the device,
  so it fails offline.
- **Endowing an oracle into the reduce** — it would make an operator depend on
  something other than its input rows and forfeit ever maintaining it
  incrementally.
