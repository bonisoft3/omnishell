---
type: concept
title: The terminal and its units
description: What the terminal owns and what a unit may do — the surfaces it hands in, the unit ladder, and the compartment, iframe and worker seats.
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
posts named events. *A capability object* — hatches only, and both hatch seats
are granted nothing: a unit declaring `capabilities` is refused at mount
(`hatch.js`, `hatch-worker.js`).

**What cannot be handed to a unit.** The durable outbox is leader-elected per
origin through Web Locks, so two of them means one wins and the other's writes
silently stop being durable; the shape connections share one connection budget
per origin. Everything else is handed in.

**The host is one interface with three adapters**: *fixture* over fixture
collections, *local* over PGlite collections in the page, and *synced* over
Electric collections.

## Units

| unit | receives | brings its own build |
|---|---|---|
| handler | its arguments, nothing else | no |
| region | collections, its filter | no |
| screen | collections, params | no |
| hatch | props, a channel | yes |

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
  app-authored role runs here; only the adapter is endowed, with `Intl` whole
  and its host defaults refused. Whole, because the offset in effect at an
  instant is a tz-database lookup and no member of `Intl` does I/O or takes a
  capability: the worst a hostile argument buys is an exception.
- **iframe** (`hatch.js`) — opaque origin, no storage or cookies, and
  `window.parent` only to post to, never the parent's DOM; same thread. For a
  unit whose untrusted half arrives over the network at read time.
- **worker** (`hatch-worker.js`) — its own thread, same origin, so it keeps
  `fetch`, IndexedDB and the cache API: more authority than the frame. For a
  hash-pinned binary vendored at build time, trusted by the app's audit and the
  pin.

`mountHatch` throws for any other isolation rather than substituting a
boundary. A hatch speaks `pronto:props` in and `pronto:ready`/`pronto:event`
out over `postMessage`, never handles — Elm's ports — which is what lets one
unit sit behind a frame or a worker unchanged; the cost is that everything
crosses async.

**The terminal parses; the app owes the rest.** Whatever the seat, the
boundary is a parser: `parseDetail` admits at most 8 keys matching
`^[a-z][a-z0-9_]{0,23}$`, each a printable-ASCII string of at most 128
characters, into a frozen record, and a detail that fails drops the event.
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
