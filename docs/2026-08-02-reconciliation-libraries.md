# Should reconciliation come from a library?

Date: 2026-08-02
Status: evaluation done and acted on. No library adopted. Items 1 and 3 of the
closing list have landed — `moveBefore` in `screen.js`'s row loop (guarded by
`playwright-tests/region-reorder.pw.ts`) and the source-string memo as
`render.js`'s `renderInto`, measured at 0.170 ms → 0.0003 ms per unchanged
re-bind. Item 4, morphdom, remains correctly unadopted and its trigger
conditions are listed at the end. Every number below was measured in the Chromium
Playwright 1.59.1 ships (HeadlessChrome/151.0.7922.34), not estimated. The
harnesses are in `reconciliation-spike/` beside this file so the numbers can be
re-run rather than believed.

**Superseded in scope by the amendment at the end of this file**, which redoes
the evaluation against a social feed rather than an article. The conclusion
holds; the reasoning below for *why* it holds does not. Both are kept — the
scope error is the useful part.

## Recommendation, up front

**Adopt `Node.moveBefore()` in `screen.js`'s row loop. Adopt no library.**

The measurements invert the question. The thing that costs a reader something
is not how *many* DOM operations a reorder performs, it is whether those
operations **destroy node state**. A keyed differ addresses the first and not
the second. `moveBefore` addresses the second completely, is one line, and
brings no dependency.

Concretely, swapping two rows in a 20-row list where each row holds a hatch
iframe:

| strategy | DOM ops | iframe reloads |
|---|---|---|
| today (hand-rolled + `insertBefore`) | 13 | **13** |
| hand-rolled + `moveBefore` | 13 | **0** |
| udomdiff (uses `insertBefore` internally) | 2 | **2** |

The library reduces operations by 6× and still reloads iframes. The one-line
change reduces reloads to zero while performing the same 13 moves. On the
metric a user can perceive, the non-library option wins outright.

For the renderer's own output: **keep the memo, adopt nothing.** Reasoning
below — it is a genuine "no", not a deferral.

## The criterion, and what it rules out

Node creation is where the security property lives: the allowlist, the scheme
check, `createElement`/`textContent` and nothing else. A library that takes
over node creation moves that boundary into code we would have to audit and
keep auditing.

**lit-html and every template-literal library are ruled out** without
measurement. The renderer would author markup strings, and "there is no node
kind for raw markup, so no renderer can ask for it" is the guarantee the whole
design rests on. A library whose input is an HTML string cannot preserve a
property whose content is *there are no HTML strings*.

## Candidates

Sizes are bundled through this repo's own `bun build --target=browser --minify`,
which is the number that matters, not the registry's.

| | version | license | last publish | min | gzip | takes over node creation? |
|---|---|---|---|---|---|---|
| **morphdom** | 2.7.8 | MIT | 2026-01-14 | 5416 B | **2216 B** | **No** — takes two DOM trees |
| **udomdiff** | 1.1.2 | ISC | 2024-11-27 | 813 B | **456 B** | No — children order only |
| **snabbdom** | 3.6.4 | MIT | 2026-06-17 | 14358 B | 5241 B | **Yes** — vnode → element |
| **incremental-dom** | 0.7.0 | Apache-2.0 | **2019-10-29** | 9692 B | 3933 B | **Yes** — owns the open/close calls |

**incremental-dom is out on maintenance alone**: last publish 2019, seven years
and ten releases total. The brief asked for accumulated learnings from a
maintained package; this is the opposite.

**snabbdom is out on the criterion.** It is healthy and well documented, and
its vnode `{sel, data, children, text, key}` really does match our node
description closely — that similarity is what makes it tempting. But taking it
means the allowlist has to move in front of its module pipeline, and we would
have to prove that the `attrs`, `props`, `dataset` and `style` modules cannot
be reached with anything we did not sanction. `props` alone assigns directly to
DOM properties, which is a different and wider surface than `setAttribute`.
That is a permanent verification burden — re-incurred at every upgrade — bought
in exchange for a diffing algorithm. I do not think it is worth it, and the
measurements below show the diffing itself is not what we are short of.

**morphdom passes the criterion cleanly**, and I checked rather than assumed.
Its every string-to-markup path (`innerHTML` ×3, `createContextualFragment`)
sits behind exactly one guard, `typeof toNode === 'string'` at
`dist/morphdom.js:317`. Handed a DOM node, that branch is unreachable. So the
integration is: our builder fills a **detached** tree — same allowlist, same
scheme check, same `createElement` — and morphdom is handed two real trees. It
never sees a string and never turns a description into an element. The safety
argument stays entirely ours.

**udomdiff** is the keyed children-diff on its own, and it is tiny. It also
does not create nodes: you hand it the node list.

## Measurement 1 — `moveBefore` exists, and it is the whole ballgame

`Element.prototype.moveBefore` is a function in the Chromium Playwright uses
(151.0.7922.34). It is on the `ParentNode` mixin, so it is on `Element` and not
on `Node.prototype` — a check written against `Node.prototype` finds nothing
and concludes wrongly.

Three rows, each holding a sandboxed iframe, list reversed, load events
counted (`reconciliation-spike/movebefore.mjs`, one fresh page per arm):

    insertBefore   3 loads → 6   (every moved iframe reloaded)
    moveBefore     3 loads → 3   (none reloaded)

Same resulting order in both. This is the mechanism behind the table at the
top, and it is why the recommendation is not a library.

Two constraints the integration must respect. `moveBefore` requires the node to
be **already connected** — a freshly built row must still go in with
`insertBefore` — so the call site is
`node.isConnected ? moveBefore : insertBefore`, which is also the shape a
capability check wants. And it is Chromium-only at the time of writing; I
measured only the Chromium above, so the fallback is not optional and the
feature test must be real.

## Measurement 2 — the renderer's own output does not need a differ

A 60-section Conduit-shaped article: 180 blocks, 540 elements
(`reconciliation-spike/spike.mjs`). morphdom is driven exactly as described
above — our `buildNodes` fills a detached tree, morphdom gets two trees.

| case | strategy | nodes surviving | reader's selection kept | ms |
|---|---|---|---|---|
| body unchanged | memo (today) | 100% | yes | 0.18 |
| body unchanged | morphdom | 100% | yes | 2.0 |
| one word changed | `replaceChildren` (today) | **0%** | **no** | 0.9 |
| one word changed | morphdom | **100%** | **yes** | 1.1 |
| block appended | `replaceChildren` (today) | **0%** | **no** | 0.7 |
| block appended | morphdom | **100%** | **yes** | 1.1 |

morphdom is unambiguously better *when the body changes* — total node survival
and the selection preserved, for two tenths of a millisecond.

**And I still recommend against adopting it, because of when that case
arises.** The memo already covers "the body did not change", which is the
entire experience of reading an article. The differ only pays while a body is
changing under a reader's eyes, and in the app driving this work — Conduit, an
article a reader reads and an author edits on a different screen — that is not
a thing that happens. Adopting a differ for it would be buying a real
capability for a hypothetical case, and the brief explicitly invited "adopt
nothing" over adoption for its own sake.

The decision would flip on a concrete surface: a live-preview editor, a
streamed/generated body, or comments appended while read. morphdom is the right
answer for those, it is 2.2 KB, and this section is the argument already made
so it does not have to be re-derived.

One small thing the measurement did surface, worth fixing whoever wins: the
memo compares *after* parsing, so an unchanged body still costs
`parseMarkdown` + `JSON.stringify` on every re-bind — 0.18 ms for this article,
against ~0 if the interpolated source string were compared first. That is
small, it is not a reason to do anything urgently, and it is free.

## Measurement 3 — the row list, where a keyed differ was expected to pay

`screen.js`'s cursor loop transcribed and compared against udomdiff, counting
real DOM mutations (`reconciliation-spike/rows.mjs`). Departed rows are evicted
before the loop, as `screen.js` does — modelling that wrongly makes the
hand-rolled algorithm look broken on deletion when it is not.

| scenario | hand-rolled | + `moveBefore` | udomdiff |
|---|---|---|---|
| reverse 20 | 19 | 19 | 20 |
| **swap two distant rows** | **13** | **13** | **2** |
| prepend one | 1 | 1 | 1 |
| delete middle | 0 | 0 | 0 |
| move one to front | 1 | 1 | 1 |

All correct. The hand-rolled algorithm matches or beats udomdiff everywhere
except one shape — two rows exchanging distant positions — where its cursor
cascades every row between them. That is a real inefficiency and it scales:

    20 rows:    17 ops / 0.2 ms      udomdiff 2 ops / 0.1 ms
    200 rows:  197 ops / 0.2 ms      udomdiff 2 ops / 0.0 ms
    1000 rows: 997 ops / 0.3 ms      udomdiff 2 ops / 0.2 ms

Linear in list length — but **sub-millisecond at every size**, including a
thousand rows no screen renders. So the op count is not a performance problem.
It was only ever a problem because each op destroyed node state, and that is
precisely what `moveBefore` removes: 997 state-preserving moves cost a reader
nothing, while 13 state-destroying ones cost thirteen iframe reloads.

**udomdiff and `moveBefore` are mutually exclusive today.** udomdiff calls
`parentNode.insertBefore` / `removeChild` / `replaceChild` directly
(`index.js:46,52,77,121,127`) with no injection point for the DOM operation.
Taking udomdiff means taking `insertBefore` with it, unless we fork it. Given
the table at the top, that trade goes the wrong way.

## What I would do, in order

1. **`moveBefore` in `screen.js`'s move loop**, feature-tested, with
   `insertBefore` for not-yet-connected nodes. Biggest measured win, no
   dependency, and it makes the hatch usable inside an ordered region — today a
   reorder reloads every embed it steps over.
2. **Leave `render.js` alone.** The memo is the right amount of machinery for
   content that either does not change or changes wholesale.
3. Optionally, compare the source string before parsing rather than the
   description after. 0.18 ms per re-bind, free.
4. **Revisit morphdom when a changing-body surface exists** — live preview,
   streaming, or appended comments. The evaluation is done and the integration
   shape is settled: our builder fills a detached tree, morphdom diffs two
   trees, node creation never leaves our side.

Fixing the cursor cascade is not on this list. Once moves preserve state, its
cost is a fraction of a millisecond, and the current loop's deliberate
step-over-exiting-nodes behaviour is load-bearing for the motion system in a
way a general differ would have to be taught.

---

# Amendment, same day: the workload was wrong

The evaluation above is sound and its central finding — **node-state survival,
not operation count, is the metric** — is the one thing to carry forward. But
it measured the wrong workload, and said so in its own words: "in the app
driving this work — Conduit, an article a reader reads and an author edits on a
different screen — that is not a thing that happens."

That is the scope error. `screen.js` is not Conduit's reconciler; it is the
terminal's, and the terminal is infrastructure for every pronto app. The
workload that decides the question is a **social feed**: posts arriving at the
head, reaction and comment counters ticking, comments appending under one post
while the rest sit still, rows leaving mid-list, and the whole list reordering.
Section "Measurement 3" tested five list shapes against `udomdiff` counting
only DOM ops. This amendment tests eight shapes against the three morphing
libraries, counting DOM ops **and** node-state survival **and** wall clock, at
20 and 200 rows.

Harness: `reconciliation-spike/feed.mjs` + `feed-entry.js`. Same Chromium
(Playwright 1.59.1, HeadlessChrome/151.0.7922.34), one fresh page per arm.

## The answer, up front

**The answer does not flip. Adopt nothing — and now for stronger reasons than
before.** The recommendation survives the feed workload, and one candidate
turns out to be actively dangerous at this altitude.

What changed is the *quality* of the "no". The earlier "no" was "the case never
arises." This one is "the case arises constantly, we measured it, and the
hand-rolled loop wins on the metric that matters and on wall clock."

Three things decide it, each measured below:

1. **Every one of these libraries keys on the `id` attribute. Our rows carry
   `data-id`.** Without a real `id`, all three morph rows *positionally*: the
   list ends up displaying the right order, every survival flag reads clean,
   and the reader's half-written reply is now attached to a different post.
   It fails **silently and correctly-looking**.
2. **They morph DOM toward DOM, so adopting one means building a throwaway
   target list of N bound rows on every refresh** — where `screen.js` patches N
   surviving nodes in place. At 200 rows that tax is 3–9× wall clock on the
   single most common feed event, a counter ticking with no structural change.
3. **morphdom is disqualified outright.** It does not use `moveBefore`. One
   post arriving at the head of a 200-row feed reloads **201 iframes** and
   drops focus.

## Candidates, verified rather than summarised

Sizes bundled through this repo's own `bun build --target=browser --minify`.

| | version | license | last publish | repo health | min | gzip | uses `moveBefore`? |
|---|---|---|---|---|---|---|---|
| **morphlex** | 1.4.0 | MIT | 2026-03-10 | yippee-fun/morphlex, 214★, 3 open | 6881 B | **2254 B** | **Yes** |
| **idiomorph** | 0.7.4 | 0BSD | 2025-09-29 | bigskysoftware/idiomorph, 1111★, 24 open | 9302 B | **3410 B** | **Yes** |
| **morphdom** | 2.7.8 | MIT | 2026-01-14 | patrick-steele-idem/morphdom, 3568★, 65 open | 5438 B | **2236 B** | **No** |

Two corrections to the brief that sent me here, both checked in the shipped
packages rather than the READMEs:

- **Idiomorph *does* use `moveBefore`** — 16 call sites in
  `dist/idiomorph.esm.js`, behind `if (parentNode.moveBefore)` with a
  `try`/`catch` fall back to `insertBefore`. Its README never mentions it,
  which is where the belief that it lacks it comes from. It also uses
  `moveBefore` to park nodes in a "pantry" element it appends to the document
  for the duration of the morph — the stray `remove:1` in every idiomorph row
  below is that pantry being cleaned up.
- **Idiomorph's license is 0BSD**, not the BSD-3 its GitHub page reports; npm
  and GitHub disagree (GitHub says `NOASSERTION`). 0BSD is permissive and
  attribution-free, so this is a nit, not an obstacle.

Morphlex's advertised behaviour all checks out in `dist/morphlex.js`:
`SUPPORTS_MOVE_BEFORE` at line 2, `longestIncreasingSubsequence` at line 526,
and a `morphlex-dirty` marker attribute stamped on inputs, textareas and
options whose value has drifted from its default — the same problem
`screen.js` solves with `_prontoDirty`.

## The benchmark

One row is one feed post: two counters that tick, an unsent comment draft, a
sandboxed provider embed, a running CSS animation, and a nested comment region
carrying a comment that only its own hydrator put there. The `handRolled` arm
is `screen.js`'s loop transcribed. The library arms are driven the way they are
meant to be: our builder stamps a **detached target list** from the same
`<template>`, binds it with the same `data-text` pass, and the library morphs
the live region toward it — the security boundary stays exactly where the
original evaluation put it, since no library ever sees a string.

Each library was given the callbacks it needs to be *correct* here, which is
already part of the finding: don't descend into a nested region
(`beforeChildrenVisited` / `beforeNodeMorphed` / `onBeforeElChildrenUpdated`),
and don't overwrite an unsent draft (`preserveChanges` for morphlex,
a `beforeNodeMorphed` guard for idiomorph, `onBeforeElUpdated` for morphdom).

Columns: **row** = the node that held the draft still shows the row it held;
**id** = that node survived; **drf** = the unsent draft survived; **foc** =
focus survived; **anim** = the animation kept running rather than restarting;
**ifr** = iframes reloaded.

### 20 rows, `id` attribute granted — the libraries at their best

| scenario | arm | ops | ms | row | drf | foc | anim | ifr |
|---|---|---|---|---|---|---|---|---|
| insert at head | handRolled | **1** | 0.9 | Y | Y | Y | Y | 1 |
| | morphlex | **1** | 1.2 | Y | Y | Y | Y | 1 |
| | idiomorph | 2 | 1.9 | Y | Y | Y | Y | 1 |
| | morphdom | 21 | 8.1 | Y | Y | **N** | **N** | **21** |
| insert in middle | handRolled | **1** | 0.5 | Y | Y | Y | Y | 1 |
| | morphlex | **1** | 1.2 | Y | Y | Y | Y | 1 |
| | idiomorph | 2 | 2.0 | Y | Y | Y | Y | 1 |
| | morphdom | 11 | 4.7 | Y | Y | Y | Y | **11** |
| remove from middle | handRolled | **1** | 0.4 | Y | Y | Y | Y | 0 |
| | morphlex | **1** | 1.0 | Y | Y | Y | Y | 0 |
| | idiomorph | 2 | 1.5 | Y | Y | Y | Y | 0 |
| | morphdom | **1** | 1.2 | Y | Y | Y | Y | 0 |
| reverse | handRolled | **19** | 0.1 | Y | Y | Y | Y | 0 |
| | morphlex | **19** | 1.0 | Y | Y | Y | Y | 0 |
| | idiomorph | 27 | 1.7 | Y | Y | Y | Y | 0 |
| | morphdom | **19** | 7.3 | Y | Y | **N** | Y | **19** |
| **swap two distant rows** | handRolled | 13 | **0.1** | Y | Y | Y | Y | 0 |
| | morphlex | **2** | 0.8 | Y | Y | Y | Y | 0 |
| | idiomorph | 4 | 1.5 | Y | Y | Y | Y | 0 |
| | morphdom | 5 | 3.1 | Y | Y | Y | Y | **5** |
| shuffle (seeded) | handRolled | 16 | **0.2** | Y | Y | Y | Y | 0 |
| | morphlex | **13** | 0.9 | Y | Y | Y | Y | 0 |
| | idiomorph | 26 | 1.6 | Y | Y | Y | Y | 0 |
| | morphdom | 18 | 7.1 | Y | Y | **N** | Y | **18** |
| near-sorted (one moved far) | handRolled | **1** | 0.1 | Y | Y | Y | Y | 0 |
| | morphlex | **1** | 0.8 | Y | Y | Y | Y | 0 |
| | idiomorph | 2 | 1.4 | Y | Y | Y | Y | 0 |
| | morphdom | 18 | 7.3 | Y | Y | **N** | Y | **18** |
| batch text update, no reorder | handRolled | **0** | **0.0** | Y | Y | Y | Y | 0 |
| | morphlex | **0** | 1.1 | Y | Y | Y | Y | 0 |
| | idiomorph | 1 | 1.3 | Y | Y | Y | Y | 0 |
| | morphdom | **0** | 1.1 | Y | Y | Y | Y | 0 |
| nested region appends | handRolled | **0** | **0.2** | Y | Y | Y | Y | 0 |
| | morphlex | **0** | 0.8 | Y | Y | Y | Y | 0 |
| | idiomorph | 1 | 1.3 | Y | Y | Y | Y | 0 |
| | morphdom | **0** | 1.0 | Y | Y | Y | Y | 0 |

The `ifr: 1` on the two insert rows is the genuinely new post's own embed
loading. That is correct behaviour, not churn.

**The near-sorted case does not go the way the brief expected.** A
longest-increasing-subsequence pass was supposed to win big there; it ties at 1
op, because moving one row forward is exactly the shape `screen.js`'s cursor
handles optimally. LIS earns its keep on **swap** (2 vs 13) and **shuffle** (13
vs 16) — and on both, the hand-rolled loop is still *faster in wall clock*
while doing more moves, because the moves are `moveBefore` and cost almost
nothing, while building the target list costs real time.

### 200 rows — where wall clock separates

| scenario | handRolled | morphlex | idiomorph | morphdom |
|---|---|---|---|---|
| insert at head | 1 op / **1.6 ms** | 1 op / 4.3 ms | 2 ops / 8.6 ms | 201 ops / 65.5 ms / **201 reloads** |
| insert in middle | 1 op / **1.4 ms** | 1 op / 4.2 ms | 2 ops / 8.8 ms | 191 ops / 62.0 ms / **191 reloads** |
| remove from middle | 1 op / **1.3 ms** | 1 op / 4.0 ms | 2 ops / 8.2 ms | 1 op / 5.8 ms |
| reverse | 199 ops / **1.3 ms** | 199 ops / 5.2 ms | 207 ops / 12.4 ms | 199 ops / 78.8 ms / **199 reloads** |
| swap two distant rows | 13 ops / **0.9 ms** | **2 ops** / 3.6 ms | 4 ops / 7.6 ms | 185 ops / 59.9 ms / **185 reloads** |
| shuffle (seeded) | 196 ops / **1.2 ms** | **169 ops** / 5.2 ms | 270 ops / 11.8 ms | 196 ops / 71.2 ms / **196 reloads** |
| near-sorted | 1 op / **0.9 ms** | 1 op / 3.7 ms | 2 ops / 7.3 ms | 198 ops / 64.2 ms / **198 reloads** |
| batch text update | 0 ops / **1.0 ms** | 0 ops / 7.0 ms | 1 op / 7.7 ms | 0 ops / 5.5 ms |
| nested region appends | 0 ops / **1.0 ms** | 0 ops / 3.4 ms | 1 op / 7.4 ms | 0 ops / 5.1 ms |

The bottom two rows are the whole argument. **Zero DOM operations on every
arm, and morphlex still costs 7× the wall clock** — because a morphing library
has nothing to compare against until we have built 200 bound rows for it to
throw away. A counter ticking is the single most common thing a feed does, and
it is where the impedance mismatch is most expensive.

## The impedance mismatch, measured

Re-run with the `id` attribute withheld — which is what a pronto region's rows
actually carry, `data-id` and nothing else:

| scenario | arm | ops | shows the right row after? |
|---|---|---|---|
| insert at head | handRolled | 1 | **yes** |
| | morphlex | 3 | **NO** |
| | idiomorph | 2 | **NO** |
| | morphdom | 1 | **NO** |
| reverse | handRolled | 19 | **yes** |
| | morphlex | 17 | **NO** |
| | idiomorph | 1 | **NO** |
| | morphdom | **0** | **NO** |
| shuffle (seeded) | handRolled | 16 | **yes** |
| | morphlex | 13 | **NO** |
| | idiomorph | 1 | **NO** |
| | morphdom | **0** | **NO** |

Read the morphdom reverse row carefully: **zero DOM operations, list in the
correct order, focus intact, draft intact, animation intact — and every row's
content has been rewritten onto a different node.** The node holding a reader's
half-written reply now sits under a different post. Nothing in the op count or
in any survival flag catches it. This is why "adopt a library that already does
`moveBefore` and delete our hand-rolled version" is not the trade it looks
like: the hand-rolled version is not the `moveBefore` call, it is the
**`live` Map keyed on `row.id`**, which is a stronger and safer key than any
of these libraries can derive from the DOM.

Making the libraries safe means stamping a document-unique `id` on every row —
a new global invariant on a document that hosts several sibling regions plus
nested regions inside item templates, whose failure mode is the silent
corruption above rather than an error.

## Is the library's behaviour a superset of ours?

No, in both directions.

Morphlex is a superset on exactly one axis — LIS gives a minimum-move reorder,
2 ops where our cursor cascades 13 — and a subset on five others, each of which
`screen.js` currently gets right and would have to re-teach through callbacks:

- **Exit animations.** A departing row deliberately stays in the list until its
  animation ends (`playExit`). A morph told "these are the children" removes it
  at once; keeping it means a `beforeNodeRemoved` that returns false and a
  manual removal later, i.e. re-implementing what we have.
- **Nested regions.** An item's `[data-live]` subtree is another hydrator's
  output and is *absent* from the target tree. Every arm above needed an
  explicit don't-descend callback; without it the parent's refresh wipes the
  comments.
- **Unsent input.** `_prontoDirty` survives until the form submits or resets.
  Idiomorph's `ignoreActiveValue` only shields the *focused* control — measured:
  without an extra `beforeNodeMorphed` guard it clobbered a draft in a row the
  reader had clicked away from. Morphlex's `preserveChanges` is closer but is
  keyed on value-vs-default, not on whether the user typed.
- **Hatch lifetime.** `_prontoHatch` is a JS property with a page-level message
  listener released by `destroy()`. A morph that replaces the element instead
  of matching it leaks the listener silently.
- **Form wiring.** `wireForm` runs once per new node. Under a morph that
  becomes an `afterNodeAdded` callback, with double-wiring as the failure mode.

And one shape that no callback fixes: there is **no order-only API** on any of
the three. You cannot ask them to reorder children and leave content alone,
which is the only thing `screen.js`'s loop is short of.

## Should `render.js` route through one?

**No — leave it exactly as it is.** The feed workload does not move that
question. A post *body* still either does not change or changes wholesale; what
a feed makes dynamic is the row list and the counters, and both live in
`screen.js`. The `renderInto` memo already covers the unchanged case at 0.0003
ms. The trigger conditions in item 4 of the original list stand unchanged — a
live-preview editor, a streamed or generated body — and morphdom remains the
right answer *there*, where node creation is ours and no keying is involved,
which is a different problem from this one.

## What I would do, in order

1. **Nothing.** Keep the `live` Map, keep the cursor loop, keep `moveBefore`.
   It is the fastest arm at both sizes, it is the only arm that cannot attach
   state to the wrong row, and it is already written.
2. If the cursor cascade ever shows up in a profile — it has not; 13 moves cost
   0.1 ms at 20 rows and 0.9 ms at 200 — **add an LIS pass over our own `order`
   array**, about fifteen lines against the array we already have. That buys
   morphlex's one genuine advantage with no dependency, no target tree, no
   `id` invariant, and no callbacks.
3. **If a future surface genuinely needs DOM→DOM morphing** — grafting server
   HTML into a live screen, say — the candidate is **morphlex**: it is the
   smallest, it uses `moveBefore`, it has LIS, and it tracks dirty inputs. Two
   traps to carry forward, both measured: it re-inserts inter-element
   whitespace it refuses to match, so **pretty-printed markup costs 9 extra DOM
   operations per row per pass** (181 ops instead of 1 for a single head insert
   — collapsing to 1 the moment the item markup is whitespace-free); and
   `morphInner(parent, target)` is the entry point for children, not `morph`.
4. **morphdom is disqualified for row reconciliation** and this is not a close
   call. No `moveBefore`, 201 iframe reloads and lost focus on one post
   arriving at the head of a feed. Its earlier pass in "Measurement 2" was
   against a workload with no keys and no embeds, and remains valid *there*.
