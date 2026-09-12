# omnishell

Omnishell is Pronto's frontend framework: the virtual terminal that renders a
program's screens and owns every effect at the browser boundary. A screen is
HTML; a `data-live` region is a standing query in PostgREST's filter grammar;
data changes only through a form or through the writes a Jessie reduce returns;
and a reduce is a pure function from rows to writes.

This gives an application the modern frontend properties without an application
framework inside every screen: reads are local and reactive, mutations follow
one visible path, offline is ordinary, and the remaining client computation is
pure. The interpreter owns fetching, DOM effects, replication, and authority;
application code only declares screens and derives writes.

> **Writing an app? Start with [GUIDE.md](GUIDE.md).** It covers the
> reduce contract, what wakes it and what it receives, the rules that bite, and
> the mappings to Elm/TEA, Datalog, htmx and Datomic. `apps/shadcnui` is the
> worked gallery for the presentation vocabulary; `apps/chess` is the reference
> for the data plane.

## The runtime

| Concern | Where |
|---|---|
| Writing a screen — the contracts, in one page | [GUIDE.md](GUIDE.md) |
| Region grammar, bindings, forms, clicks | `interpreter/screen.js` (the comments are the spec) |
| The reduce sandbox and its denylist | `plugins/pronto/jessie.ts` |
| What may be declared: entities, screens, forms, seeds | `plugins/pronto/schema.cue` |
| Emission — markup, `shell.yaml`, compose, docker | `plugins/pronto/write.ts` |
| Design tokens and presets | `plugins/pronto/styles.ts`, `apps/shadcnui` |
| Terminal doctrine, the event surface, the arguments | [`docs/`](docs/) |
| Every `data-*`, with its meaning | [`docs/2026-07-30-the-binding-vocabulary.md`](docs/2026-07-30-the-binding-vocabulary.md) |
| Changing the interpreter itself | [CONTRIBUTING.md](CONTRIBUTING.md) |

The interpreter is loaded by `interpreter/shell.js` at runtime. It is plain ES
modules and takes no build step.

### The command line

What a program reaches the terminal's checks through. Pin the release in the
project's `.mise.toml` and `omnishell` is on PATH:

```toml
[tools]
"github:bonisoft3/omnishell" = "0.2.0"
```

```
omnishell check markup   <appDir>    # every screen says what the grammar admits
omnishell check handlers <appDir>    # every Jessie module loads in its role's compartment
omnishell check machines <appDir>    # every arrow of every emitted chart fires
omnishell read  markup   <appDir>    # what one app's screens say, as JSON
omnishell mode  <appDir> [--local]   # the stanza naming which omnishell the checks run
```

A check takes `--self-test` in the directory's place, and answers on its own
fixtures. Findings print as `{severity, path, message}` JSON on stdout; a
finding that is not advisory is a non-zero exit.

The deno flags and the permission grants each leaf runs on live behind
`runtime/cli.ts`, so a caller states the check and the directory and nothing
else. `omnishell mode` is what `terminal.cue`'s `surface.runtime` reads: a
checkout beside the program names its launcher by a path, anything else names
the bare token.

## Development

```bash
just setup     # install bun via mise
just build     # typecheck (tsc --noEmit)
just test      # the deno unit suite over test/
just integrate # Docker build, then that suite plus this target's share of the smokes
```

[CONTRIBUTING.md](CONTRIBUTING.md) covers which test tier can see which kind of
change, and the two invariants to preserve when touching the interpreter.
