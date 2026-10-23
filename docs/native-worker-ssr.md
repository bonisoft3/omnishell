# Native Worker SSR

The Cloudflare release builder accepts `--ssr-origin <https-origin>`. By default
it keeps the entry Worker's existing Mecha/PGlite database namespace and adds a
separate renderer Durable Object running M-SSR. New deployments can opt into
`--ssr-database separate` for a thin entry and a separate compressed database. PostgreSQL and the DOM interpreter occupy
separate isolates. See [[../../pronto/docs/release-targets#cloudflare]] for the
build and publish contract. The container server remains described in [[terminal]].

The entry passes its release's renderer capability to the database. The database
opens a public, read-only repeatable-read transaction and supplies a temporary RPC
reader to the renderer. The response body is consumed before that transaction
ends. All reads obey PostgreSQL RLS without minting a guest or using browser
credentials. Ordinary writes wait for the snapshot to close.

`server/worker-document.ts` uses the release's real templates, catalogues, roles
and request-local browser tables. Startup-compiled role factories create a fresh
lexical scope for each evaluation and freeze their compartment globals. Unknown
roles fail. A bounded queue serializes the interpreter's ambient document across
all renderer objects in one isolate. Database admission also limits queued and
active public snapshots to 16, before they join the chain shared with writes.
Excess requests receive 503 with `Retry-After`; read or render errors reject the
response.

Rendered 200 HTML documents stream their `<head>` and top-level regions as soon
as top-level reads settle, then stream nested regions in document order and
embed their snapshot `/crud/*` responses in
`<script type="application/json" id="pronto-reads">` before `</body>` so fresh
guest tabs adopt the SSR DOM without re-fetching those queries after first
paint. Prefetches (`X-Pronto-Prefetch: 1`) also receive `<!--pronto-read:...-->`
comments as each region's reads resolve, letting an in-flight navigation seed
the store progressively; those comments are stripped before storing the document
in `caches.default`. Within one snapshot render or one browser microtask,
overlapping `/crud/*` reads are coalesced: identical queries share one read,
same-filter queries differing only in `limit` share the widest limit, complete
unfiltered/subset rowsets satisfy alternate column orders and embed subsets in
memory, and unpaginated row-preserving `col=eq.<val>` waves combine into
`col=in.(...)` while still recording each caller's original query key in
`#pronto-reads`. The entry Worker stores 200 GET renders in `caches.default` for
86,400 s, keyed by renderer, reset, public-write timestamp, locale and URL,
while sending `Cache-Control: public, no-cache, must-revalidate` and
`Vary: Accept-Language` to the browser. Concurrent cold misses and stale
revalidations for the same key share one in-flight render. Interactive renders,
intent-driven prefetches (`pointerover`/`pointerdown`/`focusin`), and `/crud/*`
requests take the high-priority PGlite lane ahead of background Electric shape
snapshots, stale SWR revalidations, and idle navigation-strip prefetches
(`X-Pronto-Speculative: 1`).
Fresh cache hits (`<= 60s`) keep `#pronto-reads` and their ETag; stale hits
(`> 60s`) drop the ETag, trigger `ctx.waitUntil` background regeneration, and
strip `#pronto-reads` on navigation so the browser paints the cached HTML
immediately and refreshes its live regions from `/crud/*` after first paint.
Matching `If-None-Match` GET/HEAD requests bypass the edge cache and can receive
304 from the renderer. Locale resolution matches the browser and honors explicit
localized URLs before language preferences. Immutable assets retain independent
edge caching and HTTP 103 hints, and `release-addresses.ts` retains previous
releases' `_immutable-*` assets so cached entry documents never 404 across a
deploy. Guests share public-only `/crud/*` cache entries across the colo for 5 s
while keeping subject-scoped reads isolated per guest; mutations advance both
write markers.

The full compressed Golaberto archive and both target pages have been exercised
on a separate Cloudflare deployment. This establishes the integrated runtime on
the available **Paid account**, not Free-plan enforcement. The public app retains
the edge target's existing guest-only authentication and derivation limitations.

[[../spikes/native-worker/deployed-results.json]] records the integrated archive
deployment and [[../spikes/native-worker/deployed-app-check.ts]] checks anonymous
HTML across public routes, homepage adoption, player search/pagination and chart
hover. SQL-view embeds use the app's declared references under the same public
RLS as base-table reads. Acknowledged biography
inserts and updates appeared in the next anonymous profile render; a rejected
write did not. The test biography content was cleared afterward.

Mobile Lighthouse samples after the locale fix and deferred shape initialization:

| Page | Without server warm-up | After one preparatory request |
|---|---:|---:|
| Players | 91 | 96 |
| Flamengo | 82 | 95 |

Both pages had zero layout shift. Every navigation still rendered afresh; the
warm-up warmed processes and database buffers, not an HTML cache. These are small
samples. Open Electric requests produced Lighthouse load-timeout warnings, so
functional browser checks accompany the reports. Cold-start latency remains a
limitation, particularly on Flamengo, rather than a claim of consistent 90+.

## Revision-cache experiments

The older captured-data and small live-database probes below test retained HTML
for data whose dependencies are revision-covered. They are measurements and
protocol tests, not the release renderer's cache behavior.

## Freshness contract

Each navigation selects a committed revision at the authority during its request.
It includes every write acknowledged before that request began. An overlapping
write may fall after this selection; the response still represents one consistent
snapshot. Already-open browser documents retain their existing synchronization
contract.

`durable-worker.ts` routes the captured public page to one SQLite-backed Durable
Object. Data changes, the revision increment, and removal of retained documents
commit in one transaction. Rendering consumes a detached snapshot: no SQLite cursor
crosses an await. A saved document is reusable only after checking its revision
against the authority. The identity also includes the release and canonical URL.

Missing documents are rendered synchronously from the reader's perspective.
Concurrent requests for the same identity and revision share a promise. Requests
for a newer revision cannot join it. A render may publish only while its revision
remains current. Rendering errors propagate; old HTML is never used to answer a
failed freshness check or render. A shared, bounded queue serializes the
interpreter's ambient document across objects in the isolate.

HTML responses use `public, no-cache, must-revalidate`. Conditional GET and HEAD
check the authority before answering 304. The Worker entrypoint must not be cached
ahead of that check. There is no TTL, purge dependency, background regeneration,
or grace period. Content-addressed assets can be cached independently.

The public renderer does not mint a guest or depend on the requesting browser's
cookies. This prototype accepts only the captured canonical pathname without
query parameters. It rejects other addresses instead of silently rendering the
fixture for them. The authenticated test controls exist only in
`freshness-probe.ts`, which subclasses the rendering object for fault injection.

## What the experiment establishes

The captured-data tests use the actual M-SSR interpreter and Flamengo page, with the same
validation, event wiring, and machine handling as the baseline native spike.
The deliberately incomplete variants in `floor-modes.json` are not used.

SQLite holds captured query results, including already-derived tab rows. The test
writer replaces those results atomically. This establishes the revision protocol,
snapshot isolation, durable reuse after eviction, error behavior, and real HTML
rendering. It does not establish consistency of a live Mecha/Postgres read path,
SQL query performance, or fresh browser data after adoption.

The first implementation deliberately uses one revision for all captured data.
Refining dependencies is an optimization: a table or competition revision must
cover inserts, deletes, aggregate changes, permissions, and every import/write
path. Async subscriptions alone cannot establish this contract. Multiple database
shards would require a consistent published snapshot rather than independent
revision checks.

The release path adds a renderer identity covering its origin, sources and bundled
assets, supports the manifest's routes and parameters, and freezes compartment
globals. The captured fixture alone does not prove those properties.

## Real database path

The app adapter in `app-document.ts` renders a release's routes through
`server/snapshot-store.js`. Remote queries go to a supplied snapshot reader;
browser-owned tables start from their seeds for each render and are populated by
the actual handlers. Remote mutations fail, and a failed read cannot be hidden by
a rendered error state. The store releases subscriptions and collections after
rendering. The caller must serialize renders because the interpreter uses ambient
browser globals.

`app-prepare.ts` reads role declarations from the release manifest and builds
startup-compiled factories. Each evaluation creates a fresh lexical scope.
`app-check.ts` exercises this adapter with captured **remote** query results;
captured tab rows are excluded. This command is an offline adapter check; the
release path above connects the same adapter to Golaberto's actual database.
After running `prepare.ts`, run from `apps/golaberto`:

```sh
mise exec -- deno run --no-config --allow-read --allow-write ../../plugins/omnishell/spikes/native-worker/app-prepare.ts /absolute/path/to/release-public
mise exec -- deno run --no-check --config ../../plugins/omnishell/spikes/native-worker/.generated/app-deno.json --allow-env --allow-read --allow-write ../../plugins/omnishell/spikes/native-worker/app-check.ts /tmp/golaberto-native-ssr-fixture /tmp/golaberto-app-snapshot.html
```

`live-database-worker.ts` and `live-render-worker.ts` connect the revision protocol
to real PGlite and M-SSR. They run as two Workers so PostgreSQL's WASM and the DOM
interpreter occupy separate isolates. The entry Worker forwards `/board` to the
database object. It opens a [[../../../libraries/mecha/packages/mecha-edge/README|public snapshot]],
then calls the renderer object with its revision and a temporary RPC reader.
The renderer reuses matching HTML or performs M-SSR through that reader. The
database transaction stays open until the response is ready. With one serialized
database connection, subsequent requests reuse the first completed render.

The renderer sees only public rows under PostgreSQL RLS, without creating a guest.
The transaction revision catches writes through ordinary CRUD and direct SQL;
the persistent directory generation also invalidates documents after a restore.
Render/read failures reject the response. Saved HTML cannot bypass a database
failure. Both the entry and renderer are required: a public Worker receives HTTP,
and the database authority must validate every document before it is served.

This experiment uses a small public board and private notes, not Golaberto's full
schema. It verifies anonymous meaningful HTML, conditional responses, CRUD
invalidation, private-row exclusion, concurrent readers, insertion/deletion, and
restoring an earlier directory. The local run in `live-results.json` took about
296 ms for the first page, 16 ms for a fresh page after a write, and 3.1 ms median
for validated reuse (30 requests, 6.7 ms p95). These are local wall-clock timings,
not billed CPU or predictions for Golaberto. The first sample includes database
startup after import; the renderer process may already be warm.

The whole-database revision deliberately trades cache efficiency for complete
invalidation. Time-dependent SQL, randomness, external reads and sequence state
are outside its MVCC contract. Application integration must identify those
dependencies. The remaining Golaberto work is a request-local store for its
browser-derived entities, complete route/input identities, browser adoption,
release generation, and remote CPU/memory validation. Nothing here changes the
production deployment or establishes a production Lighthouse score.

## Browser startup and adoption

`production-browser-results.json` records three serial mobile runs per route on
`golaberto.bonisoft3.com`, after the player-table geometry fix. Production remains
client-rendered. Each run used a fresh Chrome profile, Lighthouse 13.5.0's default
simulated mobile settings, and no concurrent QA queries.

| Page | Scores | Median | Median LCP | Median TBT | CLS |
| --- | --- | ---: | ---: | ---: | ---: |
| `/en/players` | 88, 94, 95 | 94 | 2.82 s | 18 ms | 0 |
| Flamengo, Brazilian championship 2026 | 94, 95, 96 | 95 | 2.76 s | 15 ms | 0 |

The first players run followed deployment. Its guest request took about 2 s,
compared with 0.2 s on the second run; directory reads still took about 2 s.
This is consistent with a cold backend, but the benchmark did not force or
instrument object eviction. Its 88 remains part of the result: the median exceeds
90, while every cold navigation has not been shown to do so. Before the CSS fix,
one players baseline scored 84 with CLS 0.208. Fixed table columns and reserved
table height prevent arriving rows from resizing columns or displacing visible
content below the table. Production search and both pagination directions passed
without JavaScript exceptions; mobile scrolling stays within the table.

All six reports warned that loading exceeded the time limit; Electric requests
remained open. Keep this limitation when quoting the scores. HTTP 103 and the
updated immutable stylesheet were verified on the production hostname. These
results do not measure a deployed M-SSR renderer.

`browser-results.json` records the mobile measurements from October 13, 2026.
Lighthouse 13.5.0 used its default simulated mobile throttling. The production
Flamengo page was client-rendered; the local preview served actual M-SSR HTML
from captured query results, then adopted it with live browser reads.

| Target | Performance | FCP | LCP | TBT | CLS |
| --- | ---: | ---: | ---: | ---: | ---: |
| Live Workers deployment | 69 | 2.91 s | 6.83 s | 107 ms | 0 |
| Local captured-data M-SSR | 93 | 2.55 s | 2.55 s | 67.5 ms | 0 |

These are single runs, not a controlled estimate of production SSR latency.
Both reports warned that the page did not finish loading within the time limit;
live Electric requests remained open. Neither recorded a browser exception, and
the LCP element was the championship subtitle, not an error overlay. The preview
must serve the real service worker: returning 404 for its registration produces
an error page and invalidates the comparison. The result supports testing SSR in
production, not promising a stable score of 93.

A separate Chromium CPU profile used 4× CPU slowdown, an empty browser context,
disabled HTTP cache, blocked service workers, and unthrottled networking. M-SSR
painted at 276 ms and finished adoption at 2.38 s, retaining the heading and
185 of 186 marked rows. The live client-rendered page painted at 3.27 s; its
heading appeared at 3.76 s and chart at 6.25 s. One guest-mint request took
2.27 s. Those waits matter to rendering latency but are not browser blocking.

Both profiles spend their main JavaScript time in screen binding/refresh,
Mecha subscriptions and SES property checks. In the SSR sample, `screen.js`
accounted for about 333 ms of sampled self time, `mecha-client.js` 217 ms and
SES 113 ms. SSR moves useful paint before that work; adoption still installs
bindings and subscriptions. Inclusive times for `refresh`, `interpretScreen`,
`bindAttributes` and `bindTexts` overlap and must not be added together.

The screenshot's historical 2,450 ms TBT cannot be attributed exactly without
its original trace. The older release embedded 5.73 MB of HTML, including a
3.38 MB base64 file payload and 2.28 MB inline module, but a local replay did not
reproduce that blocking total. The measured live TBT is now much lower. TBT is
the portion beyond 50 ms of long tasks between FCP and TTI, not total JavaScript
CPU or time waiting for data. `browser-profile.ts` reports a different, explicitly
bounded observation window; its blocking total must not be called Lighthouse TBT.
See Chrome's [TBT definition](https://developer.chrome.com/docs/lighthouse/performance/lighthouse-total-blocking-time).

The content-addressed assets and route-specific HTTP preload headers already
exist in the [[../../pronto/docs/release-targets#cloudflare|Cloudflare release]].
HTTP 103 can overlap their downloads with rendering, but cannot remove binding
CPU or replace meaningful server HTML. Improving public-data navigation and
completing the live SSR adapter remain the larger opportunity.

To capture a profile, run from `apps/golaberto` with Chromium installed for the
script's pinned Playwright version:

```sh
mise exec -- deno run --no-check --no-config --allow-all ../../plugins/omnishell/spikes/native-worker/browser-profile.ts 'https://golaberto.davi-d2c.workers.dev/equipe-campeonato/flamengo-rj/brazil-campeonato-brasileiro-2026?lang=pt-BR' /tmp/golaberto-browser 4
```

The script writes a timing/network summary and a DevTools-compatible CPU profile.
Its readiness selectors target this Flamengo page. It captures request URLs but
not authentication headers; raw Lighthouse traces should remain local because
they can contain credentials.

## Run locally

Use Deno 2.9.7 through the app's mise environment, Wrangler 4.149.0, and the
spike's pinned npm dependencies. Commands below run from the repository root;
substitute paths to an existing capture and reference HTML. `prepare.ts` requires
the output of `capture.ts`; see those scripts' argument errors for the capture
inputs. Generated files and local SQLite state are not committed.

```sh
cd apps/golaberto
mise exec -- deno run --no-config --allow-read --allow-write ../../plugins/omnishell/spikes/native-worker/prepare.ts /tmp/golaberto-native-ssr-fixture
mise exec -- deno run --no-config --allow-read --allow-write ../../plugins/omnishell/spikes/native-worker/freshness-prepare.ts local-release-1
mise exec -- deno test --no-config ../../plugins/omnishell/spikes/native-worker/fresh-render.test.ts
cd ../../plugins/omnishell/spikes/native-worker
wrangler dev --config .generated/freshness-wrangler.json --local --port 20228 --inspector-port 20229 --persist-to /tmp/golaberto-freshness-storage
```

In another terminal, from `plugins/omnishell/spikes/native-worker`:

```sh
python3 freshness-check.py http://127.0.0.1:20228 /tmp/golaberto-native-ssr-fixture /tmp/freshness-results.json
```

The integration test deliberately injects render errors, conflicting writes,
transaction rollback, and object eviction. Those requests must return 500. It
checks saved HTML byte-for-byte, mutations, conditional responses, deletion and
reinsertion, and eight concurrent readers behind a paused render. It also records
local response timings with the profiler disconnected.

For memory sampling, from `apps/golaberto`:

```sh
mise exec -- deno run --no-check --no-config --allow-net --allow-read --allow-write --allow-env ../../plugins/omnishell/spikes/native-worker/freshness-memory.ts http://127.0.0.1:20228 http://127.0.0.1:20229 /tmp/freshness-memory.json
```

This forces a data commit and fresh render on every iteration, sampling the JS
heap every 20 renders. The tighter local run starts Wrangler with
`MINIFLARE_WORKERD_V8_FLAGS='--max-old-space-size=64 --max-semi-space-size=4'`.
These V8 flags exercise memory pressure; they are not Cloudflare's isolate limit.
JS heap samples exclude some native allocations and can miss transient peaks.
Local workerd does not prove Free-plan CPU or production memory enforcement.

For the real-database experiment, first run `prepare.ts` above to generate the
native role bundle, and build the pinned `pglite-workerd` package. From
`apps/golaberto`, substitute its absolute output directory:

```sh
mise exec -- deno run --no-config --allow-read --allow-write ../../plugins/omnishell/spikes/native-worker/live-prepare.ts /absolute/path/to/pglite-workerd/dist
```

Start these in **separate terminals**, both from
`plugins/omnishell/spikes/native-worker`. Wrangler's combined multi-Worker dev
middleware mutates console methods after SES freezes them; separate dev processes
connect through Wrangler's local registry without that wrapper.

```sh
wrangler dev --config .generated/live-render-wrangler.json --local --port 20258 --inspector-port 20259 --persist-to /tmp/golaberto-live-render-state
```

```sh
wrangler dev --config .generated/live-database-wrangler.json --local --port 20248 --inspector-port 20249 --persist-to /tmp/golaberto-live-database-state
```

Then, from `apps/golaberto`:

```sh
mise exec -- deno run --no-check --config ../../libraries/mecha/packages/mecha-browser/cluster.deno.json --allow-read --allow-write --allow-env --allow-net ../../plugins/omnishell/spikes/native-worker/live-check.ts http://127.0.0.1:20248 /tmp/golaberto-live-ssr-results.json
mise exec -- deno test -A --config ../../libraries/mecha/packages/mecha-edge/deno.json --lock ../../libraries/mecha/packages/mecha-edge/deno.lock --frozen ../../libraries/mecha/packages/mecha-edge/test/
```

The generated configs contain local test credentials and a fixed test release
identity. They are not deployment configs. `live-check.ts` resets its endpoint's
database and imports its small fixture; use only the isolated local endpoint.

Cloudflare documents the applicable [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
and [transactional SQLite API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
Remote Free-plan execution remains a separate validation step.

## Archive storage feasibility

`storage-results.json` records an offline audit of the full archive release copy,
not the live object's current allocation. Its PostgreSQL files occupy 7.34 GB:
user tables account for 3.16 GB and their indexes 4.13 GB. The largest relations
including indexes are `team_rating` (2.40 GB), `player_game` (1.42 GB), and
`team_odds_history` (0.96 GB). Moving ratings and odds history would therefore
address a substantial fraction, but native SQLite requires porting their queries
and maintaining consistent revisions across stores.

The existing `SqliteFS` already stores PostgreSQL pages as SQLite blobs. A local
experiment compressed every 8 KiB block independently with zlib level 1, storing
raw bytes when compression was larger and one byte identifying the encoding.
The payload occupied 2.08 GB. In a local SQLite database with the production
`fs_block` schema and 4 KiB SQLite pages, it occupied 3.94 GB including allocation
overhead. Every stored block was read back, decompressed, and compared with its
source bytes. A second full-archive build used 128 KiB blocks: 56,995 rows occupied
1.94 GB including SQLite allocation, with every codec result checked against its
source. Larger compressed values waste less space on SQLite overflow pages.
An isolated Cloudflare probe now implements the lossless 128 KiB codec and stores
the full archive in **1,951,252,480 bytes**, with 56,995 initial block rows. All
2,937 source chunks passed hash verification before opening PostgreSQL. The
players query, Flamengo rating history and player/team counts matched the local
archive both before and after aborting the object. The package's
[[../../../libraries/mecha/packages/pglite-workerd/README.md]] describes the
persisted format and reproducible probe; its
[[../../../libraries/mecha/packages/pglite-workerd/spikes/compression-results.json]]
holds sanitized measurements.

The warm players query consumed 3,212 ms CPU and 3,941 ms object wall time;
Flamengo's warm 100-row rating history used 5 ms each. A matched raw-format cloud
baseline is still needed to separate query cost from compression overhead.
Compression fits this archive within the account storage budget, but these
measurements do not establish production latency or Free-plan eligibility.

A separate 79,500-row sample retained all eight rating columns in native SQLite,
using binary UUIDs, integer dates, a WITHOUT ROWID primary key, and one covering
history index. It occupied 12.60 MB, projecting to roughly 1.30 GB for the complete
rating relation. That projection has not been checked against full-data query
plans or application behavior.

The [Free storage budget](https://developers.cloudflare.com/durable-objects/platform/pricing/)
is 5 GB per account and 100,000 row writes per day. Compression leaves 896,181
block rows at 8 KiB: the initial import alone needs at least nine daily write
budgets, before metadata and other traffic. The resumable importer can spread
that work across days. At 128 KiB the initial block count is below one daily
allowance, but every isolated page update reads and rewrites a larger block.
Measure random reads, write amplification, decompression CPU, import metadata
writes, and crash recovery before selecting a block size.
The [limits page](https://developers.cloudflare.com/durable-objects/platform/limits/)
currently lists 10 GB per object in its table but still says 1 GB for Free in its
storage-full FAQ. Verify the enforced Free per-object limit before treating a
single compressed object as deployable. Leave room for database growth, other objects,
and retained rendered documents.
