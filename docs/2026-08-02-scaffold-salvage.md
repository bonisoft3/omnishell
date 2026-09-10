# Salvaged from the React scaffold

`scaffold/` was pre-pronto omnishell: a TanStack Start + Vite + Storybook app,
component-shaped rather than artifact-interpreting, kept as a reference
application after the terminal became a vanilla-JS interpreter. Nothing
imported it, `tsconfig.json` never typechecked it (`include: ["src/**/*.ts"]`),
and pronto never read it — it only appeared in bayt `srcs` globs, where it cost
cache invalidation and kept bun pinned.

Its lint doctrine did not live there and is unaffected: the ten rules under
`src/lint/eslint/rules/` are path-glob based (`**/components/**`,
`**/routes/**`) and guarded by their own RuleTester tests.

Three things did live only there, and they are recorded here because each one
is an implementation of something the terminal currently records as missing.

## 1. Service worker — the capability `terminal.cue` calls blocked

`terminal.cue` declares `push` and `background-sync` under `background:` with
the note that the event "fires in the service worker, never in a unit —
blocked on service-worker registration support, not yet grantable". The
scaffold registered one.

Registration was ordinary and worth nothing to preserve verbatim:
feature-detect `"serviceWorker" in navigator`, register `/sw.js` on `load`,
swallow the failure so dev builds without a generated worker still run.

The generation step is the part with decisions in it. `workbox-build`'s
`generateSW` ran as a post-build step over the client bundle:

- precache `**/*.{js,css,html,svg,png,webmanifest,json}`, ignoring `sw.js` and
  `workbox-*.js` so the worker never precaches itself;
- `skipWaiting` + `clientsClaim`, i.e. a new worker takes over immediately
  rather than waiting for every tab to close;
- runtime caching in two buckets, both `StaleWhileRevalidate`: images (capped
  at 50 entries / 30 days) and `js|css` (uncapped).
- if the client build directory is absent, exit 0 rather than fail — the SW is
  an additive artifact, not a build gate.

For pronto the shape would differ — there is no bundler, and the emitted shell
is a fixed set of statics the Caddyfile already enumerates, so the precache
manifest is derivable from `#Static` rather than discovered by globbing a
build output. That is an argument for the terminal generating the worker, not
against generating one.

A web app manifest sat beside it (`display: standalone`, `start_url: "/"`, a
single SVG icon at `sizes: "any"`, background/theme colours). No emitted app
has one today.

## 2. i18n — five locales, and the honest limit of it

`@inlang/paraglide-js` with `plugin-message-format`, messages as
`messages/{locale}.json`, source `en`, tags `["en", "pt", "es", "zh", "he"]`,
compiled by a Vite plugin with `outputStructure: "message-modules"` (one module
per message, so unused strings drop out of the bundle).

**The limit, stated because it would otherwise be overclaimed: there is no RTL
handling.** `he` exists as a translated message file and nothing more — no
`dir` attribute, no logical-property audit, no mirrored layout. The commitment
was to translation, not to bidirectionality.

Nothing anywhere else in `plugins/` or `apps/` has any i18n at all. Every
emitted screen carries its copy inline in the markup, which is the thing a
message catalogue would have to displace — and `data-text="{title}"` bindings
are already a seam a catalogue could key on.

## 3. `shared/{schemas,collections,actions}` — one line worth keeping

The folder convention itself is superseded and not worth restoring: pronto puts
entity shape in `program.cue`, mutations in forms, and collections in the
emitted mecha cluster, so the three concerns exist but not as directories an
app author maintains. The lint rules still name `actions/` in their messages
("Move data fetching to `actions/`"), which after deletion points at a
convention with no example left in the tree — a wording problem, not a design
one.

What is worth keeping is a single call. The scaffold's notes collection was:

```ts
createCollection<Note>(localOnlyCollectionOptions({ id: "notes", getKey, schema, initialData }))
```

`localOnlyCollectionOptions` is an **in-memory TanStack DB collection** —
optimistic writes, same change stream, same `subscribeChanges`, no sync plane
and no server. Its sibling `localStorageCollectionOptions` is the persisted
variant.

Both are exported from `@tanstack/db` and therefore already inside
`interpreter/vendor/mecha-client.js`.

That lands directly on the durability axis in
[`../../pronto/docs/2026-08-02-incremental-model.md`](../../pronto/docs/2026-08-02-incremental-model.md),
whose second "what the model predicts is missing" entry is `tab`/`device`
durability — "blocks app-authored frontend-only state; today the only honest
home for a toggle is Postgres":

| durability | doc's description | factory |
|---|---|---|
| `tab` | in-memory collection, survives navigation | `localOnlyCollectionOptions` |
| `device` | IndexedDB / PGlite, survives restart | `localStorageCollectionOptions` |

So the two missing tiers are not a research question. A `tab` entity is
another input node entered through the same door — read by a `data-live`
region, mutated by a form, with no migration, no publication entry, no RLS
policy and no outbox to emit. What remains is the emitter deciding those tiers
from `#Entity` and `data-crud.js` building the collection from the right
factory.
