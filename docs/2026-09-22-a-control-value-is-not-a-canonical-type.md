# A control's value is not a canonical type

Written from the Pronto type system work
(`plugins/pronto/docs/2026-09-23-pronto-type-system.md`): every
holder now keeps a value in one canonical spelling, and the form control is the
last seat that does not. A `datetime-local` holds `2026-09-22T10:00` — local
wall time, no zone, minute precision — and the column it writes holds an
instant. Something has to convert, and today that something is thirteen lines
of `screen.js` (`1169-1180`, `1734-1739`) that treat the wall time as UTC and
drop the seconds.

The claim: **the conversion is a pure function of the control's text and the
reader's zone, so it belongs in a module an app ships, and the terminal's whole
share is passing the zone in and calling it at two seats.**

## The two seats, and why there are exactly two

A control's value crosses the boundary twice, and the directions are inverses:

- **Bind** — a row's column fills the control. `format(value, {zone})`.
- **Serialize** — the control's text becomes a column of the row a form writes.
  `parse(text, {zone})`.

One module carries both, because a pair whose halves can drift is two bugs
waiting to disagree — and a module whose value is a map of pure functions is
what `plugins/pronto/jessie.ts` already calls an **adapter**, so this is a
fifth role rather than a new concept. The platform names it on the element
(`data-value-adapter="<module>"`, the spelling `data-text-format` already
establishes) and never learns what a date is.

## Why the reader's zone is data and not an ambient read

`Intl` is absent in the cage every other role runs in (measured: `typeof Intl
=== "undefined"` inside `evaluateCaged`), and an ambient zone read would make
`update(state, event)` a function of the machine it ran on. So the zone arrives
as a parameter, the way `ctx.timeZone` already reaches every formatted binding,
and the checking tiers keep pinning UTC.

What the module cannot compute from a zone name alone is the offset in effect
at an instant: that is a tz-database lookup. So the adapter role is endowed
with **`Intl`** — the whole namespace, the API every author already knows,
rather than a helper nobody has seen before. An adapter reads the offset out of
a `DateTimeFormat` (`timeZoneName: "longOffset"` names `GMT-03:00`) and stores
that number.

Nothing in `Intl` is withheld, because nothing in it is reachable by the data
an adapter is handed: no member does I/O, none takes a capability, and the
worst a hostile argument buys is an exception, which is visible. What the 
2026-09-18 discussion drew — classifiers in, formatters out — survives as a
rule about what an adapter may STORE, not about what it may call: `Collator`'s
order and every formatter's text are the host's locale data, so they belong on
a screen and never in a column, where a reader's ICU version would decide what
the row says.

**Every ambient reading Intl offers is a default the host fills in**, so each
is closed by making the argument mandatory. Measured in the cage on 2026-09-22,
before and after:

| what it was | what it is |
|---|---|
| `new Intl.NumberFormat()` took the host's locale | refused: *name the locale* |
| `new Intl.DateTimeFormat("en-US")` took the host's zone, silently | refused: *name the timeZone* |
| `fmt.format()` answered the current instant — a clock, which SES had taken away by taming `Date` | refused: *name the instant* |
| asking for a locale the host lacks (`xx-YY`, `und`, `[]`) resolved to the host's own | refused: *no data for it, and no falling back to the host's* |

Stated in full, the API is the standard one and answers about the zone it was
given: `new Intl.DateTimeFormat("en-US", {timeZone: "Asia/Tokyo"})` formats, and
its `resolvedOptions().timeZone` is Tokyo rather than the host's. What remains
environment-dependent is what a formatter SAYS — ICU decides that the space
before `AM` is U+202F — which is the same reason its text belongs on a screen
and never in a column.

Two consequences of the guard being a subclass: these services must be
constructed with `new`, and the unguarded methods are still on the prototype it
inherits, so a module written to reach past it can. It is a guard against a
module reading its machine by accident, which is how it would happen, and not a
sandbox against one written to.

A wall time is not always one instant. In a spring-forward gap it is none, in a
fall-back overlap it is two, and the offsets either side of the day are enough
to compute all three cases purely. Which one a screen wants — refuse the gap, take the earlier
instant — is the module's policy, stated in the package, not the platform's.

## What this is not: a streaming join

The first design of this doc had the conversion materialize: a draft row
written by the control's machine, a reduce deriving the instant, and the form
submitting what the reduce wrote. That shape raises a real question — has the
derivation caught up with what the reader typed? — and the honest answer to it
is the one the fold already uses one tier down: a watermark, `counted_txid`
against the reader's own `txid` (`data-sync.js`), which is a streaming join
in miniature.

It is the right answer to that question, and the question does not arise here.
A watermark buys agreement where there are concurrent producers and no total
order. The typed text and the click are two events on one thread from one
producer, strictly ordered, and the derivation is a pure function — so the
value can be computed AT the click, from the control's current text, and there
is nothing to wait for. `store.query` already establishes the pattern for the
read direction: `project()` maps a fold sink's row at the read sink rather than
storing what it computed.

The rule that generalises: **materialise a derived value only when its inputs
are not both in hand at the moment it is needed.** When they are, a map is not
a pipeline, and giving it a version, a sink and a join would buy nothing but
the apparatus.

## Where the code lives

The adapter modules live beside the CUE components, in
`plugins/omnishell/components/`, because they are the terminal's and not any
app's — the same place the mecha client lives inside mecha. No app carries a
copy: the cage resolves a module by filename over HTTP, so the terminal serves
one from `/omnishell/components/`, and an app's proxy image copies it from the
plugin at build (`COPY --from=root plugins/omnishell/components/…`). A module
with one source has nothing to drift from.

The platform holds: the two calls, the zone parameter,
the endowment, and the checks that go with a role — a module is loaded as the
role that names it, and the identifier denylist carries the one role each
endowed name is excused for, so `Intl` in a reduce is still a finding and
`Intl` in an adapter is not. It holds no dates, no formats and no policy.

Consequences accepted: a control naming no adapter forwards its text unchanged,
so `date` needs no adapter at all (a civil day is already its own spelling), and
a control that needs seconds says so in its markup (`step="1"`) rather than in
the platform.

See [`../../pronto/docs/2026-09-23-pronto-type-system.md`](../../pronto/docs/2026-09-23-pronto-type-system.md) for the full Pronto language type
system and boundary execution across database, lake, and client tiers.
