# Reconciliation spike harnesses

Every number in `../2026-08-02-reconciliation-libraries.md` comes from these.
They are not wired into any verb — `bayt.cue` scopes its srcs to `interpreter/`
and `test/`, so nothing here runs in `just test`. A measurement nobody can
re-run is an assertion, which is the only reason they are checked in.

They need the candidate libraries, which are deliberately **not** dependencies
of `plugins/omnishell`. Install them somewhere else and bundle from there:

    BUN=$(mise which bun)
    mkdir -p /tmp/recon && cd /tmp/recon
    echo '{"name":"spike","private":true}' > package.json
    "$BUN" add morphdom udomdiff snabbdom incremental-dom

    # copy the two entry files here, fix the absolute path inside spike-entry.js
    # to point at this checkout's interpreter/, then:
    "$BUN" build spike-entry.js --target=browser --format=esm --outfile spike.js
    "$BUN" build rows-entry.js  --target=browser --format=esm --outfile rows.js

Then, from `plugins/omnishell`:

    mise exec -- bun docs/reconciliation-spike/movebefore.mjs          # moveBefore vs insertBefore, iframe reloads
    mise exec -- bun docs/reconciliation-spike/spike.mjs   /tmp/recon/spike.js   # morphdom vs replaceChildren on a real article
    mise exec -- bun docs/reconciliation-spike/cost.mjs    /tmp/recon/spike.js   # parse / stringify / re-bind breakdown
    mise exec -- bun docs/reconciliation-spike/rows.mjs    /tmp/recon/rows.js    # DOM ops per reorder shape
    mise exec -- bun docs/reconciliation-spike/cost2.mjs   /tmp/recon/rows.js    # iframe reloads for a two-row swap
    mise exec -- bun docs/reconciliation-spike/scale.mjs   /tmp/recon/rows.js    # how the cursor cascade scales

`spike-entry.js` imports the real `markdown.js` and `render.js` by absolute
path: the point is to measure the shipped parser and the shipped builder, not a
reimplementation of them.

Two traps worth keeping, both of which produced wrong numbers first time:

- Use a **fresh page per arm**. A `message` listener left attached from a
  previous arm double-counts the next one's load events.
- Model **eviction before the move loop**, the way `screen.js` does. Leaving
  departed rows in place makes the hand-rolled algorithm look incorrect on
  deletion when it is not.

## The feed harness (amendment)

`feed.mjs` + `feed-entry.js` drive the social-feed workload the amendment
measures: eight list shapes against morphlex, idiomorph and morphdom, counting
DOM operations, node-state survival and wall clock.

    BUN=$(mise which bun)
    cd /tmp/recon && "$BUN" add morphlex idiomorph morphdom
    cp <this-dir>/feed-entry.js .
    "$BUN" build feed-entry.js --target=browser --format=esm --outfile feed.js

Then, from `plugins/omnishell`:

    mise exec -- bun docs/reconciliation-spike/feed.mjs /tmp/recon/feed.js [format] [keying] [rows]

`format` is `pretty` (default) or `compact` — morphlex re-inserts inter-element
whitespace it refuses to match, so the item markup's indentation changes its op
count by 9 per row per pass. `keying` is `id` (default) or `data-id`: the
libraries key on the `id` attribute and a region's rows carry only `data-id`,
so `data-id` is the arrangement we would actually be adopting, and it is the
run where they morph rows onto the wrong nodes. `rows` defaults to 20; the
amendment also reports 200.

A third trap, on top of the two above:

- Assert **row correspondence**, not just node survival. A morph can keep every
  node, its focus, its unsent input and its running animation, leave the list
  in the right order, and still have rewritten each node's *content* to a
  different row. Every operation count and survival flag reads clean while it
  happens.
