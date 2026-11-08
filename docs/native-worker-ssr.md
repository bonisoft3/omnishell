# Native Worker SSR

The Cloudflare release builder accepts `--ssr-origin <https-origin>`. Rendering
runs inside the existing Mecha/PGlite `Cluster` object in the entry Worker.
See [[../../pronto/docs/release-targets#cloudflare]] for the build and publish
contract. The container server remains described in [[terminal]].

The object opens a public, read-only repeatable-read transaction and passes a
local reader to the renderer. All reads obey PostgreSQL RLS without minting a
guest or using browser credentials. The transaction closes after rendering and
nested reads finish; response consumption does not extend it. Ordinary writes
wait for that snapshot to close.

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
paint. Requests marked `X-Pronto-Prefetch: 1` also receive `<!--pronto-read:...-->`
comments as each region's reads resolve, letting an in-flight navigation seed
the store progressively; those comments are stripped before storing the document
in `caches.default`. Within one snapshot render or one browser microtask,
overlapping `/crud/*` reads are coalesced: identical queries share one read,
same-filter queries differing only in `limit` share the widest limit, complete
unfiltered/subset rowsets satisfy alternate column orders and embed subsets in
memory, and unpaginated row-preserving `col=eq.<val>` waves combine into
`col=in.(...)` while still recording each caller's original query key in
`#pronto-reads`. The entry Worker stores 200 GET renders in `caches.default` for
86,400 s, keyed by renderer, reset, locale and URL,
while sending `Cache-Control: public, no-cache, must-revalidate` and
`Vary: Accept-Language` to the browser. Concurrent cold misses and stale
revalidations for the same key share one in-flight render. Interactive renders,
intent-driven prefetches (`pointerover`/`pointerdown`/`focusin`), and `/crud/*`
requests take the high-priority PGlite lane ahead of background Electric shape
snapshots, stale SWR revalidations, and idle navigation-strip prefetches
(`X-Pronto-Speculative: 1`).
Fresh cache hits (`<= 60s` old, and begun after the last public write) keep
`#pronto-reads` and their ETag; stale hits (any other) drop the ETag, trigger `ctx.waitUntil` background regeneration, and
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

The experiments behind the renderer are recorded in
[[archive/2026-10-13-native-worker-ssr-experiments]].
