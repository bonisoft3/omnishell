// plugins/omnishell/bayt.cue — bayt configuration for the omnishell
// linting/auth plugin.
//
// TypeScript/Bun project. Uses bayt.nubox + mise.install with the
// github-backend bun plugin (`github:oven-sh/bun = "bun-v1.3.12"` in
// .mise.toml). mise's core bun plugin always picks the musl variant
// which fails on opensuse/leap (glibc); the github backend with mise
// >= 2026.5.2 (bundled in lazybox v0.8.3) correctly picks
// bun-linux-x64.zip.
//
// No language stack exists for bun in plugins/bayt/stacks yet (only
// gradle/mise/pnpm/sayt), so this composes mise + sayt verbs directly
// with hand-written `bun` commands — same shape as services/boxer
// (Rust) and services/tracker-tx (yaml-only) where no language stack
// exists either.
//
// release / launch / verify stay in .say.yaml as direct invocations
// (omnishell publishes via npm, not a release image).
package omnishell

import (
	"strings"

	bayt "bonisoft.org/plugins/bayt/core:bayt"
	mise "bonisoft.org/plugins/bayt/stacks/mise"
	sayt "bonisoft.org/plugins/bayt/stacks/sayt"
	Bake "bonisoft.org/bake"
)

// Unit tests: the deno suite over test/ (per test/deno.json, which maps
// @test/harness — bun cannot read that import map, so bun never runs
// these), then a curated subset of the deno interpreter smokes — this
// target's share, not the whole list.
//
// A smoke is named and invoked by path, never discovered: the non-.test name
// keeps it out of test discovery, and shell.js imports js-yaml through a CDN
// specifier only deno's --allow-import admits. --allow-env is for the
// LOCKDOWN_* options lockdown probes.
//
// The smokes fetch a lockfile-pinned ses bundle, and `test` may not touch the
// network, so acquisition is its own lower-priority cmd and the run itself is
// --cached-only. The test/ suite needs no acquisition cmd: the build stage's
// `deno check` walks the same test/deno.json graph and integrate FROMs build,
// so DENO_DIR already holds it. DENO_DIR must stay a real image path: a cache
// mount would be scoped to the acquiring RUN and the next layer would find it
// empty.
// --lock is explicit because deno anchors the lockfile at the workspace root
// (this package.json), not beside --config; without it the pins go unread.
_smokes: strings.Join([
	for f in ["handler", "hatch", "login", "nav", "pending", "renderer", "worker"] {"interpreter/\(f)-smoke.js"},
], " ")

_smokeCmd: {
	"cache-smokes": {
		priority: -1
		do:       "deno cache --config interpreter/deno.json --lock interpreter/deno.lock --frozen --allow-import=cdn.jsdelivr.net:443 \(_smokes)"
	}
	"builtin": {
		shell: "sh"
		do:    "sh -c 'deno test --config test/deno.json --lock test/deno.lock --frozen --cached-only --no-check --allow-env --allow-read --allow-import --allow-net --allow-sys test/ && deno test --config interpreter/deno.json --lock interpreter/deno.lock --frozen --cached-only --allow-env --allow-read \(_smokes)'"
	}
}

_omnishell: bayt.#project & {
	dir:      "plugins/omnishell"
	activate: "mise x --"

	// Per-target cache scope for cross-project consumers (iris's
	// dindbox cascade transitively builds omnishell-setup / build /
	// ops; without this they run fresh every time, breaking the
	// outer cacheonly probe's cache-hit chain).
	bake: cache: Bake.monorepoCache

	targets: {
		"setup": sayt.setup & mise.install & {
			dockerfile: bayt.nubox
		}
		"doctor": sayt.doctor & mise.doctor

		// Build = `bun install --frozen-lockfile && bun run check`. The
		// check script (`bun x tsc --noEmit`) is the typecheck — that's
		// what gates a successful "build". No emitted JS artifact:
		// downstream consumers (iris e2e helpers) `FROM` this stage and
		// import .ts directly, so the typecheck IS the build.
		"build": sayt.build & mise.exec & {
			// Public so iris's integrate target can FROM-COPY the
			// playwright lint helpers under src/lint/playwright/.
			visibility: "public"
			srcs: globs: [
				"src/**/*",
				// The check script typechecks test/ too, and reads its
				// deno.json — the image needs both. Tests import
				// interpreter modules, so those are check inputs as well.
				"test/**/*",
				"interpreter/**/*",
				// test/check-machines.test.ts imports the checker beside
				// them; a checker at the plugin root is in no other glob.
				"check-machines.ts",
				"package.json",
				"bun.lock",
				"tsconfig.json",
				"bunfig.toml",
			]
			// Typecheck-only build, no artifact. Cross-project consumers
			// of the omnishell source tree (e.g. iris's pnpm workspace
			// symlink) use `plugins_omnishell:build:srcs` instead.
			// `mise.exec` wraps the cmd with `mise x --`, which only
			// activates the env for a single argv. Chained commands
			// (`bun install && bun run check`) need an explicit `sh -c`
			// so both run under the same mise activation. `shell: "sh"`
			// switches RUN to shell-form so the inner single quotes are
			// parsed correctly.
			cmd: "builtin": {
				shell: "sh"
				do:    "sh -c 'bun install --frozen-lockfile && bun run check'"
			}
			dockerfile: from: ref: ":setup"
		}

		// Chains FROM :build so node_modules + sources from build flow in.
		// Stays parallel to integrate, which re-uses the same command —
		// omnishell has no separate integration suite.
		"test": sayt.test & mise.exec & {
			srcs: globs: ["test/**/*", "interpreter/**/*", "check-machines.ts"]
			cmd: _smokeCmd
		}

		// CI's bake plugins_omnishell builds the integrate stage and never
		// :test, so this is what gates landing changes — install + check
		// (from the build chain) + the same unit tests. No dind.sh wrap
		// (no docker socket needed).
		"integrate": sayt.integrate & mise.exec & {
			srcs: globs: ["test/**/*", "interpreter/**/*", "check-machines.ts"]
			dockerfile: {
				from: ref: ":build"
			}
			cmd: _smokeCmd
		}

		// The terminal's data plane, a build product of
		// libraries/mecha/packages/client: `tsc` and the unit tests read src/,
		// the browser reads this.
		//
		// The cross-project srcs dep materialises mecha at its natural
		// /monorepo/... path, so entry.ts's relative import resolves in the build
		// exactly as it does in the worktree.
		//
		// The output is checked in, like .bayt/ and the apps' emitted trees: the
		// shell images COPY it from the repo (pronto's terminal emit), and CI's
		// tests job runs `bayt:generate` and fails on a diff.
		"bundle": mise.exec & {
			visibility: "public"
			taskfile: run: "when_changed"
			deps: ["libraries_mecha:setup:srcs"]
			srcs: globs: ["interpreter/vendor/entry.ts"]
			outs: globs: ["interpreter/vendor/mecha-client.js"]
			cmd: "builtin": do: strings.Join([
				"deno bundle",
				"--config ../../libraries/mecha/packages/client/deno.json",
				"--platform browser --format esm --minify",
				"interpreter/vendor/entry.ts",
				"-o interpreter/vendor/mecha-client.js",
			], " ")
			dockerfile: from: ref: ":setup"
		}

		"generate": sayt.generate & {deps: [":bundle"], cmd: "builtin": do: "true"}
	}
}

project: _omnishell
