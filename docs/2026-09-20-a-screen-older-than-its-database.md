# A screen older than its database

The browser holds two copies of the schema and neither of them is the
database's. One is the served bundle — `shell.yaml`'s tables, keys, access
mirror and validations, every `data-live` filter, every form's columns, every
field a reduce reads — compiled from `program.cue` and therefore correct for
*some* version of the schema. The other is the rows in `localStorage`, written
by whatever program was running when the reader last used the app.

Both can be older than what they are talking to. This doc is the terminal's
half of schema evolution: how it finds out, what it says, and what it does with
persisted rows a newer program cannot describe. The fan-out this is one branch
of is
[`../../pronto/docs/2026-09-24-refusing-a-schema-change.md`](../../pronto/docs/2026-09-24-refusing-a-schema-change.md);
the cluster's half is
[`../../../libraries/mecha/docs/2026-09-24-a-schema-that-moves.md`](../../../libraries/mecha/docs/2026-09-24-a-schema-that-moves.md).

## Skew is not an outage, and the terminal already knows the difference

A bundle and a database move separately by construction. In development, the
migrate service restarts and applies a migration while the page stays open. In
production, a rolling deploy moves one before the other in whichever order the
platform chose. Either way there is a window where the screen asks for a column
that does not exist yet, or writes a row the database has stopped accepting.

Today both land in the wrong place:

- A failed live read is dressed `network-error` and retried on a doubling
  backoff up to fifteen seconds, forever (`interpreter/screen.js:3327`). The
  reader is told the store is down. No retry will ever repair a column that is
  not there.
- A refused write — PostgREST answering 400 because the column is unknown —
  arrives as the client's `NonRetriableError` and is dressed `validation-error`
  (`interpreter/screen.js:1846`), a state that "only user input clears". The
  reader is told their typing is wrong.

The terminal already has the right idea and even the right name for it.
`ProgramError` (`interpreter/fragment.js:384`) exists precisely for this
distinction — its comment reads *"a broken invariant rather than an outage: no
retry repairs it, and the network-error dressing would say the store is down
when the program is wrong"* — and the guard rethrows it past the outage
dressing rather than retrying it. Cardinality, projection, key binding and
template cycles each have a class. Schema skew is the same kind of thing and
has none.

So: **`SchemaSkewError extends ProgramError`**, and a way to decide it.

## Deciding it

Unbuilt, and none of it is omnishell's to publish. The terminal would need two
numbers from the cluster — the migration version the database was brought to,
and the floor below which a client is no longer served — against a version the
bundle was compiled with, and `floor ≤ built ≤ applied` is the whole test.
`built > applied` is a client ahead of its database; `built < floor` is a client
behind a change that broke it. An additive migration moves `applied` and leaves
`floor`, so every open page keeps working. Which changes raise the floor is the
compiler's table, in the pronto doc.

Checked at boot and again on a 4xx, never on a timer: a skew nothing is asking
about has no symptom, and every skew that has one produces a 4xx.

An outbox reaches the same verdict late. A write queued at `offline` is composed
under one program and delivered under whichever is applied when the network
returns — the one holder here carrying *writes* across a change — so an entry
the normalize pass refuses is kept and shown rather than discarded.

## The device tier is a database with no migration path

`durability: "device"` rows are persisted by
`localStorageCollectionOptions({ storageKey: "mecha:<table>" })`
(`libraries/mecha/packages/client/src/mecha-client.ts:391`). The key carries no
version and names the entity by its *label*, so renaming `game` today silently
orphans every reader's saved games — the rows are still there, under a key the
program no longer reads. Keyed by the entity's type id (`mecha:0xdbb9ad1f…`),
the same rename costs nothing. chess persists `game`, `move` and `setup`; truco
persists its own.
chess is `server: false` with `tables: []` — for a browser-only app the device
tier *is* the whole database, and every mechanism in the other two docs does
nothing for it.

The terminal has already met this problem once and decided it correctly, which
is the best evidence that the rest of it is real. `reconcile()`
(`interpreter/data-sync.js`) re-judges a device collection's declared uniques
at load — *"Browser-tier rows outlive the invariants declared over them: a
device collection may hold rows written before a unique existed, and a slot
meeting them would die on data no one can repair from the screen"* — and drops
the losers with one warning. One invariant kind, load time, no ledger. The
design below is that mechanism generalised from uniques to shape.

What is not yet judged:

- **Field constraints reach the browser and nothing there keeps them** — and
  this one is a rule violation rather than a gap. A field's `cel:` is rendered
  into a SQL `CHECK` and into CUE; `shell.yaml` carries no `cel`, only the
  `enum` and `bounds` derived from it, which the build-time checkers and the
  storybook read and no runtime enforces. For a server entity that is fine:
  Postgres enforces it on every write, and a migration adding a constraint fails
  loudly if the existing rows violate it. For a device entity there is no
  Postgres, so the constraint is enforced nowhere. Narrow chess's `setup.bot`
  from five names to four and a reader's saved setup still names a bot the
  program no longer admits. Under the entity doc's rule — *a formal statement is
  a promise that something checks it* — that is a wired statement nothing keeps,
  which is forbidden. The terminal therefore **owes** a CEL runtime:
  `@bufbuild/cel` is the same library `cel.ts` already parses with, and it runs
  in a browser.
- **Validations judge writes, not rows.** A validation runs in the store seat
  before a write. A row already in `localStorage` is loaded straight into the
  collection and has never been seen by the predicates of the program now
  running.
- **The shape itself is unversioned.** A field added since the row was written
  is absent; a field removed is still there; a field whose meaning changed is
  indistinguishable from one whose meaning did not.
- **String equality is only right if the values are canonical.** The entity
  doc's types are defined so that two values are equal exactly when their
  canonical strings are — which is what makes `localStorage`, a tier with no
  type system, compare correctly at all. Postgres emits none of the RFC types
  canonically, and differently on the CRUD and sync paths (the mecha doc's
  "Canonical output"), so a row synced from the server and stored verbatim
  compares wrongly against the same value typed locally. Values arriving from
  the cluster are canonicalised in the mecha client, at the seat each path has;
  values a reader types are canonicalised by the store seat, on every write. And
  a canonical string stays a string: a `timestamp` has microseconds and `Date`
  has milliseconds, so a handler that parses one and prints it again has made a
  different string of an equal instant. Comparison and order go through the
  type's comparator, never through a JavaScript type.

`#Entity.seed` is refused at `device` for a reason that is worth reading
before proposing anything here: *"a device collection outlives the page, so its
birth and the terminal's boot are different moments"*, and seeding once "needs
a ledger of what was already seeded that the reader cannot delete." The
conclusion — `device` is for what the reader makes, and rows the program states
belong at `tab` — is right, and it is why the pass below never resurrects
anything. It also says exactly why shape is the harder case: for a stated row
the program is the durable copy, so no ledger is needed; for a row the reader
made, the program is not, and the only thing that can bring it forward is a
record of the shape it was written under.

### The normalize pass

The collection is stored under the entity's type id, with a header beside the
rows: the shape fingerprint they were written under, and the label each ordinal
had then. Rows stay keyed by label, so a reader's storage is still legible in
devtools, and a load whose fingerprint matches the program's does nothing at
all. When it does not match, the terminal brings the rows forward by identity
rather than by name:

| between the stored header and the program | what happens |
|---|---|
| an ordinal the rows lack, with a `default` production | the default is written into each row |
| an ordinal the rows lack, optional | the field is absent, which is what `optional` already means |
| an ordinal present in both, under a new label | the key is moved, value untouched — read from the ordinal, nothing declared |
| an ordinal the program carries as `retired` | the field is removed |
| a stored state name the chart no longer has | the row is quarantined — a state's name is data, and the entity doc's "Open" has no declaration for renaming one |
| a stored ordinal beyond the program's last | refuse: `SchemaSkewError`, the same state as above |

A moved label needs no declaration here, because the ordinal did not move and
the pass reads that. It is not a licence to rename: a device entity is in the
emitted proto like any other, so a rename is refused before it is ever written
(the compiler's side is
[`../../pronto/docs/2026-09-24-refusing-a-schema-change.md`](../../pronto/docs/2026-09-24-refusing-a-schema-change.md)).
This row is what carries rows written under a program that predates that
refusal. The fourth row is why a program
never forgets a field — a retired ordinal it had deleted would be
indistinguishable from the last row's. And the last row has exactly one cause,
because ordinals are gap-free and only grow: **the rows were written by a newer
bundle than the one reading them** — a second tab, or a deploy rolled back. The
reload the skew state offers is therefore the right repair, and the rows are not
touched.

Rows that survive the pass are then judged: on load, once, against the current
program's predicates. A row that fails is a row the program says cannot exist.
It is **quarantined, never dropped** — moved under `mecha:quarantine:<type id>`
with the statement that refused it, and the reader is told. `reconcile()` drops
its losers with a warning today, and for a row the reader made on the only
device that holds it, that is the data loss dressed as a cache miss this design
exists to stop.

Two tabs make the pass concurrent with itself. `localStorage` is per origin, the
collection syncs across tabs through storage events, and the tabs need not be
running the same bundle. So the pass runs under a Web Lock named for the type id
and writes rows and header in one `setItem` — a crash leaves the old blob, whole
— and a tab that receives rows under a fingerprint that is not its own treats
them as a load: bring forward, or refuse.

## Rejected

- **Versioning the storage key** (`mecha:<table>@<version>`). One line, and it
  silently orphans a saved game on every schema change — data loss dressed as a
  cache miss, which is the failure mode this whole design exists to stop. Keying
  by type id is the opposite move: a key that survives every change rather than
  one that changes with each.
- **Dropping persistence** — make every local tier `tab`. It removes the
  problem by removing the feature; `device` exists because a reader who closes
  a tab has not resigned their game.
- **Per-app migration code.** Apps declare; the terminal owns effects. A
  hand-written `migrateLocalRows()` in every app that persists is one chance
  per app to get it wrong, and no chance for a check to read it.
- **Auto-reloading on skew.** Correct often enough to be tempting, and it
  throws away whatever the reader had typed. The terminal says; the reader
  decides.

## Omnishell's own vocabulary, pointing inward

A machine is omnishell's: XState-JSON, closed over its row, executed by the
terminal, and only ever writing tab and device tables. In the entity model it
**names the field it governs** — `governs: {entity, field}` — rather than the
entity naming it, because a machine is mounted by a screen on a region already
bound to a field, and that binding is here whether or not the entity repeats it.
It also keeps omnishell's vocabulary out of pronto's definition of an entity,
and lets one machine govern several fields. The same rule makes a machine on a
server-owned field a build failure: nothing keeps a server row's transitions.

## Not omnishell's

Emitting the stamp, classifying a change as additive or destructive, and
refusing an undeclared drop are the compiler's. Exposing the applied version
and the floor is the cluster's. The terminal reads two numbers, compares them
to one it was compiled with, and is the only seat that can say what a reader
sees when they disagree.
