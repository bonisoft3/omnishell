---
type: metric
title: Pending
description: What the terminal argues for and has not built, each argued here or in the document it links, checked against this tree on the date given.
---

# Pending

What the terminal argues for and does not have, and what a measurement found
that nothing has fixed. A line leaves when it lands or when a document refuses
it. Anything a subsystem document already states is not repeated here; a line
names what to build and links it.

Every claim below was checked against this tree on 2026-09-27.

## Text

**No `data-prefetch`.** A link carrying it would run the target route's reads
under the page's locale when it enters the viewport or takes hover or focus, so
the click lands on warm collections — and, where translation is route-driven,
on rows already translated. It is the web's own prefetch idiom on the link that
already names the route, where the alternative is a client tracking which items
it has asked about. Nothing in `interpreter/` reads the attribute.

**Messages have no ICU MessageFormat.** A catalogue value is one sentence or a
flat map of arms that one element's `data-msg-plural` or `data-msg-select`
picks from, and an arm may not interpolate another `{msg.…}`, so a sentence
carrying a count and a gender, or two counts, cannot be one message. A vendored
`@formatjs/intl-messageformat` in `interpreter/vendor/` would parse the
standard syntax translators and their tools already speak, once per pattern,
and format it in the interpreter, the one place `Intl` is endowed.

**`date`, `time` and `relative-time` are not value formats.** `TEXT_FORMATS` in
`screen.js` is `plain`, `datetime`, `number` and `money`. A date is not a
moment, and neither format shows one in the reader's language: `plain` shows a
`date` column as raw `2026-08-02`, and so does `datetime`, whose offset repair
reads the `-02` as a zone and leaves no instant to format.
`relative-time` ("há 3 minutos") is formatting against now, which only the
terminal's clock can supply, since no compartment has one, so it can only ever
be a built-in.

**A name inside a sentence is not isolated.** Screen markup can wrap a whole
binding in `<bdi>`, as realworld's feed does, but a `{col}` a message arm
interpolates is written as bare text, and `render.js` admits `dir` and not
`<bdi>`, so a renderer cannot isolate one either. A right-to-left name inside a
left-to-right sentence then reorders the punctuation beside it; the binder
wrapping every interpolated value in FSI…PDI, and `bdi` in the renderer's
allowlist, would close both.

## The terminal

**A unit's messages are an open vocabulary.** A hatch's event names are the
app's own; a contribution manifest per unit would close them into Elm's `Msg`,
so a checker could see every message a unit may send.

**No merge-policy role.** TanStack DB rolls an optimistic write back and resolves
no conflict, but it tracks `rowOrigins` and `preSyncVisibleState`, the raw
material a Jessie role could decide from.

**Presence has no owner.** It is shared and not durable, the quadrant neither the
cluster nor the terminal holds.

**Which capabilities are grantable is undecided.** A role with nothing endowed
cannot read a sensor or a camera frame and stay a function of its inputs; a
hatch could and is granted nothing. MediaPipe's per-frame case and
`terminal.cue`'s `sensors` are the evidence waiting on it.

**The interpreter's own wiring is ad hoc.** The navigation listener, retry
timers and drag live inside the host instead of as a unit's returned requests.

**No palette of pure libraries.** A library with no DOM, clock, randomness or
network — date math (`@internationalized/date`), colour, fuzzy search, decimal
arithmetic, `d3-scale`/`d3-shape` — is a function of its inputs, which a
compartment with nothing endowed can run, so a pinned vendored bundle and a
lint entry would admit one to every role. One reaching for time, randomness,
network, storage or the DOM is a hatch unit instead, and one that patches
intrinsics cannot run once lockdown has frozen them. No role can reach a
library: `import` is refused, and `interpreter/vendor/` holds only the
terminal's own.

## Data

**A `SchemaSkewError` that is a `ProgramError`**, and the two versions the
cluster would expose to decide it ([data](docs/data.md#skew)).

**A device collection has no migration path.** Rows persist under
`mecha:<table>` with no version, so renaming an entity orphans every reader's
saved rows, and a removed or re-meant field is indistinguishable from a kept
one. Keyed by the entity's type id with a header — the shape fingerprint and
each ordinal's label — a load could bring rows forward by ordinal (default
written, optional filled, moved label re-keyed, retired ordinal removed) and
refuse an ordinal beyond the program's last, which only a newer bundle writes;
under a Web Lock per type id, with rows and header in one write, since two tabs
need not run the same bundle.

**Stale device rows are dropped, never quarantined.** `reconcile()` drops a
unique's losers with a warning, and nothing judges a stored row against the
running program's predicates or chart; for a row the reader made on the only
device holding it, that is data loss dressed as a cache miss. A failing row, or
one whose stored state the chart no longer has, would move under
`mecha:quarantine:<type id>` with the statement that refused it, and the reader
would be told.

**A field's `cel:` is enforced nowhere for a device entity.** `shell.yaml`
carries only the `enum` and `bounds` the checkers read, so narrowing chess's
`setup.bot` leaves a saved setup naming a bot the program no longer admits.
`@bufbuild/cel`, which pronto's `cel.ts` already parses with, runs in a browser.

**Declaration ceremony that scales with durability**
([data](docs/data.md#declaration-follows-durability)).

**A machine does not name the field it governs.** `governs: {entity, field}` on
the machine, rather than the entity naming it, would keep omnishell's
vocabulary out of pronto's entity and let one machine govern several fields;
neither `schema.cue` nor `machine.cue` carries it.

## Visual lint

**A root option per geometry check**, so the width-driven ones run on the
storybook ([visual lint](docs/visual-lint.md#the-container-is-not-the-viewport)).

**The dark twins' claim is unchecked.** `contrast` reads each claimed
appearance, but nothing compares a `-dark` frame's geometry with its base frame,
which is what a program's dark-twin decision asserts.

**The vision review at `verify` for pronto apps, throwing when it cannot run**
([visual lint](docs/visual-lint.md#where-it-hooks)).

**An element identity the emitter stamps**, so a finding traces to
`program.cue` ([visual lint](docs/visual-lint.md#touching-shared-code)).

## Machines

**A `check markup` rule holding a machine's row to `tab` or `device`**
([machines](docs/machines.md#the-chart)).

**An effect level read off its entity's durability**
([machines](docs/machines.md#effects)).

**`always` and `onDone` chains that throw at their cap**
([machines](docs/machines.md#bounded-statecharts)).

**realworld's favourite is a probe and two forms.** Ten screens emit
`.fav-probe`, two forms and a sibling-CSS rule from `screens_pills.cue`. The
chart that replaces them — a `tab` row, an `upsert` effect on `favorite`,
`after` for the delayed state, `refused` rolling back — runs only in
`interpreter/machine-v2-smoke.js`; in realworld it would be the one place the
effect lifecycle meets a real server.

**A store adapter over the outbox simulator**
([machines](docs/machines.md#machine-harnesses)).

**Synthetic seeds read two CEL shapes.** `synthetic-seed.ts` understands
`this in [...]` and a closed range and fills everything else by name, so a
column with a regex, size or cross-field CEL gets a value the program would
refuse. `plugins/pronto/bounds.ts` already turns each column's CEL into a
domain for the battery; seeding from it would make every posed row one the
program accepts.

**Pairwise posing in the universal run**
([machines](docs/machines.md#machine-harnesses)).

**An SMT reading of a chart** ([machines](docs/machines.md#what-stays-provable)).

## Backend machines

**The chart model stops at the browser.** The same statecharts, reduces and
incremental views would run backend computation — live aggregates, TF-IDF,
stateful reasoning nodes — on shard nodes: both sides of a join partitioned by
its key (`hash(k) % N == p`), each shard subscribing to the Electric shapes its
partition filters, so a streaming join runs in memory with no shuffle, and a
node holding no disk replays from its last acknowledged LSN after a crash.
Placement is Dapr's placement service, a daemon keeping its hash ring in an
in-memory Raft group with no external store, with Postgres
(`state.postgresql`) where an actor needs state, so no Redis enters. The
alternatives are Postgres advisory leases on a heartbeat table, StatefulSet
ordinals with jump consistent hashing, and Caddy's `lb_policy
consistent_hashing` for request routing. Four pitfalls shape it: a new or
resharded node cannot replay the WAL from zero, so it takes a snapshot at an
LSN and streams from there; one hot key saturates one shard, so additive
aggregates pre-aggregate per shard and a combiner joins the partial sums; a
large table outgrows a node's memory, so the view backs onto a paged local
engine (DuckDB or RocksDB, as Feldera does); and a paused shard holds its
replication slot and bloats the WAL, so ingestion is decoupled from effect
dispatch. Nothing in the tree builds any of it.

## Sessions

**A session is a value, and nothing records it.** A session is initial rows,
the inputs that cross the boundary inward — gestures, form values, each dealt
draw, each server answer — and a seed; the deterministic core already owns
delays (`?tempo=`, `?clock=manual`), draws (`?seed=`) and event synthesis, so
everything else re-derives and a recording is bytes where a DOM capture is
megabytes. A bug that reproduces only under rows accumulated in one profile's
`device` collections costs its diagnosis, not its fix, and a recording is what
reaches that state. Missing: an always-on bounded recorder in a reserved
`device` table outside every app's read space, with a rolling snapshot of the
local collections; a six-character id a screenshot can carry; a loader
(`?replay=<id>&to=N`) that seeds a fixture-mode store under the manual clock,
in the browser and in linkedom, so a wedge is found by bisecting the inputs;
and the ir's sha pinned, so a replay against another emission fails loudly. The
design names the recording in the hash while the terminal routes on the
Navigation API over path URLs, so where the name rides is undecided.

**Nothing exports a session.** A `?trace=<id>` page would show, copy and
download the recording, every terminal-rendered error screen would carry a
*copy this session* affordance, and in debug mode the terminal would stream
the recording to a `/traces/<id>` sink that exists only in the dev profile, so
an agent reads the id off a screenshot and fetches the whole report with no
human step.

**The composite is old; the terminal makes it cheap.** `rr` records at the
nondeterminism boundary and must create determinism with ptrace, which this
terminal has by doctrine; Doom and Factorio demos ship play as inputs plus a
seed, pinned to a version; Elm's debugger and Redux DevTools export the action
log and jump to N; Java Flight Recorder is the always-on bounded ring dumped on
demand. Not wanted: a payload in the URL, a history entry per input, a
production sink, DOM capture (rrweb records consequences; the terminal
re-derives them from cause), a recorder table any app read can see, or wedge
detection as a runtime ledger rather than an analysis over the trace in the
tooling that reads it.

**The terminal's own lifecycle is not a `#Machine`.** Mount, loading, then
empty, populated or gone lives informally in `screen.js`, though every screen
declares its `states:` and styles them per `data-state`. As a chart the walker
covers, a replay would drive it through every arrow with a trace's own inputs,
and per-state invariants would be assertions checked at each step: nothing
binds observably before `populated`, `loading`'s treatment covers everything
that binds, and `gone` releases what `populated` held.

## Native hosts

**No desktop host.** A Tauri host would pair a Rust runtime with the operating
system's own webview (WebKit on macOS, WebKitGTK on Linux, WebView2 on
Windows), mount the web terminal unchanged, and bridge the filesystem, SQLite
and notifications through Tauri's IPC commands, mirroring `StorageBridge` and
`NetworkBridge`. Nothing in the tree builds one.

**A parity check any native app can run**
([native hosts](docs/native-hosts.md#declaring-it-and-holding-it-to-the-web)).

**The native suites under `just test` in `plugins/omnishell`**
([native hosts](docs/native-hosts.md#building-and-testing)).

## The interpreter

**One smoke is on disk and in no list**: `interpreter/membrane-smoke.js` is
in neither `cache-smokes` nor `test-smoke` in
`plugins/omnishell/.vscode/tasks.json`, so `just test` never runs it.

**The incremental read path**: `lt`/`gt`/`gte`/`lte` are exported from the
predicate vocabulary and no translator emits them — `data-sync.js` refuses a
spec carrying one — so a cursor route reads through PostgREST;
`currentStateAsChanges` has no caller outside the vendored client, so first
paint is a full pass.
