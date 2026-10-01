# omnishell

# Entry points

* [omnishell](../README.md) - concept: Pronto's frontend framework, the virtual terminal that renders a program's screens and owns every effect at the browser boundary.
* [Writing a screen](../GUIDE.md) - howto: The app author's guide to the interpreter — what a screen is, the reduce contract, time, the rules that bite, and the lineage.
* [The binding vocabulary](../REFERENCE.md) - reference: Every data-* attribute the terminal answers or stamps, the placeholder grammar every attribute may carry, and the escape.
* [Contributing to omnishell](../CONTRIBUTING.md) - howto: Changing omnishell itself — the layout, the two invariants, the commands, which suite sees which change, and where each subsystem is argued.
* [Pending](../PENDING.md) - metric: What the terminal argues for and has not built, each argued here or in the document it links, checked against this tree on the date given.

# Subsystems

* [The terminal and its units](terminal.md) - concept: What the terminal owns and what a unit may do — the surfaces it hands in, the unit ladder, and the compartment, iframe and worker seats.
* [Rows, reduces and writes](data.md) - concept: How a region's rows reach a reduce, what it writes back, why a refusal returns as an event, and how stored rows meet a newer program.
* [Machines](machines.md) - concept: A chart over one browser-owned row whose transitions assign columns and emit typed effects the terminal performs, times and answers.
* [Focus and ARIA](accessibility.md) - concept: ARIA state is derived columns a region projects over its own rows, and the terminal owns the tab order, moving focus only when a column moves.
* [Screen updates](screen-updates.md) - concept: How the terminal changes the page when data or state changes: rows moved by key, bodies replaced when their source changes, state stamped as attributes that stylesheets draw.
* [Kinetic host](kinetic.md) - concept: Fixed-step tick engine, snapshot ring buffer, and time-travel controller for high-frequency interactive simulations.
* [Visual lint](visual-lint.md) - concept: The Playwright DOM checks and vision review over a rendered app — what each check needs to be sound, where it runs, and how shared checks change.
* [Automated tests](automated-tests-battery.md) - concept: Every handler and validation module an app ships is tested automatically, with no test written by hand, for confinement, termination through fuel, and purity.
* [Native hosts](native-hosts.md) - concept: How a pronto app runs on Android and iOS — a headless JS engine behind native bridges, a DivKit SDUI renderer, and realworld's parity check against the web screens.
* [Native capabilities](native-capabilities.md) - concept: Why standard HTML5 primitives and W3C APG patterns replace ad-hoc framework attributes, and how the platform owns what script used to simulate.

# Harnesses and fixtures

* [Reconciliation spike harnesses](reconciliation-spike/README.md) - howto: How to re-run the measurements behind screen updates.
* [daisyUI theme coverage](../test/design-tokens.md) - metric: The finding design-tokens.test.ts prints when its reading of daisyUI's themes and its pin disagree.
* [Visibility fixtures](../test/fixtures/visibility/README.md) - reference: Frozen copies of app stylesheets and markup that visibility.test.ts reads, each mirroring its source under apps/.
