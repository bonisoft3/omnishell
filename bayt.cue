// plugins/omnishell/bayt.cue — bayt configuration for the omnishell
// linting/auth plugin.
//
// Deno resolves source imports; host browser tests use the workspace's pnpm
// lockfile. The container build does not need node_modules.
//
// It composes mise + sayt verbs directly rather than a language stack — same
// shape as services/boxer (Rust) and services/tracker-tx (yaml-only), where
// no stack exists either.
//
// release / launch / verify stay in .say.yaml as direct invocations
// (omnishell publishes via npm, not a release image).
@extern(embed)
package omnishell

import (
	"strings"

	bayt "github.com/bonisoft3/bayt/core:bayt"
	mise "github.com/bonisoft3/bayt/stacks/mise"
	sayt "github.com/bonisoft3/bayt/stacks/sayt"
)

// Unit tests: the deno suite over test/ (per test/deno.json, which maps
// @test/harness), then a curated subset of the deno interpreter smokes — this
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
// test/design-tokens.test.ts, test/check-parity.test.ts,
// test/chrome-direction.test.ts, test/entry-document.test.ts,
// test/locale-resolver.test.ts, test/vendor-bundle.test.ts and
// test/arbitrary-types.test.ts read the repository root — pronto's schema
// and its type table, apps/realworld's emitted shell, every app's emitted
// design.css, every app's entry document, every app's declared locales, and
// the client source both the vendored bundle and the battery's generator are
// graded against — which no image here carries, so both
// targets leave them out. The host test verb runs package.json's test
// script on a full checkout, and that is where they run.
_smokes: strings.Join([
	for f in ["adapter", "clock", "handler", "hatch", "kinetic", "login", "nav", "ondemand", "pending", "renderer", "validate", "worker"] {"interpreter/\(f)-smoke.js"},
], " ")

_smokeCmd: {
	"cache-smokes": {
		priority: -1
		do:       "deno cache --config interpreter/deno.json --lock interpreter/deno.lock --frozen --allow-import=cdn.jsdelivr.net:443 \(_smokes)"
	}
	"builtin": {
		shell: "sh"
		do:    "sh -c 'deno test --config test/deno.json --lock test/deno.lock --frozen --cached-only --no-check --allow-env --allow-read --allow-import --allow-net --allow-sys --ignore=test/design-tokens.test.ts,test/check-parity.test.ts,test/chrome-direction.test.ts,test/entry-document.test.ts,test/locale-resolver.test.ts,test/vendor-bundle.test.ts,test/arbitrary-types.test.ts test/ && deno test --config interpreter/deno.json --lock interpreter/deno.lock --frozen --cached-only --allow-env --allow-read \(_smokes)'"
	}
}

_omnishell: bayt.#project & {
	dir:      "plugins/omnishell"
	activate: "mise x --"

	// No bake.cache: the shared scope lives in bonisoft.org/bake, a
	// monorepo-root package with no mirror, and this project is
	// published as a CUE module — an import a consumer cannot resolve
	// leaves the mirror untidy, which `cue mod publish` refuses.
	// Cross-project consumers rebuild these targets uncached.

	targets: {
		"setup": sayt.setup & mise.install & {
			dockerfile: bayt.nubox
		}
		"doctor": sayt.doctor & mise.doctor

		// Build = the typecheck, which is what gates a successful "build".
		// No emitted JS artifact: downstream consumers (iris e2e helpers)
		// `FROM` this stage and import .ts directly, so the typecheck IS the
		// build.
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
				// A checker, a reader or one of the battery's two halves at the
				// plugin root is in no other glob. Matched by shape rather than
				// named one by one: a checker the command line dispatches to and
				// this list has not learned of typechecks against a context it
				// is absent from, which is a container that builds and a verb
				// that fails.
				"check-*.ts",
				"arbitrary.ts",
				// The adapter modules the terminal serves to an app's routes
				// (terminal.cue `componentsRoot`), and the suite that grades
				// them: both are this plugin's, so both ride its image.
				"components/**/*",
				// What a checker imports and the shape glob cannot reach:
				// check-visual reads the door's address from base-url, and the
				// list of served modules test/served-modules grades the
				// interpreter's import graph against lives in terminal.cue.
				"base-url.ts",
				"terminal.cue",
				"instrument.ts",
				"read-markup.ts",
				// The command line the checkers are reached through, which the
				// check script typechecks beside them.
				"runtime/**/*",
				"package.json",
				"tsconfig.json",
			]
			// Typecheck-only build, no artifact. Cross-project consumers
			// of the omnishell source tree (e.g. iris's pnpm workspace
			// symlink) use `plugins_omnishell:build:srcs` instead.
			// package.json's `check`, spelled again: bayt scans this file
			// outside the CUE module, where @embed cannot read a sibling.
			cmd: "builtin": do: "deno check --config test/deno.json src/ test/ check-visual.ts runtime/cli.ts"
			dockerfile: from: ref: ":setup"
		}

		// Chains FROM :build so node_modules + sources from build flow in.
		// Stays parallel to integrate, which re-uses the same command —
		// omnishell has no separate integration suite.
		"test": sayt.test & mise.exec & {
			srcs: globs: ["test/**/*", "interpreter/**/*", "components/**/*", "check-*.ts", "base-url.ts", "terminal.cue", "read-markup.ts", "offline-first-sw.js"]
			cmd: _smokeCmd
		}

		// CI's bake plugins_omnishell builds the integrate stage and never
		// :test, so this is what gates landing changes — install + check
		// (from the build chain) + the same unit tests. No dind.sh wrap
		// (no docker socket needed).
		"integrate": sayt.integrate & mise.exec & {
			srcs: globs: ["test/**/*", "interpreter/**/*", "components/**/*", "check-*.ts", "base-url.ts", "terminal.cue", "read-markup.ts", "offline-first-sw.js"]
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
		// `fresh` rung runs `bayt:generate` and fails on a diff.
		"bundle": mise.exec & {
			visibility: "public"
			taskfile: run: "when_changed"
			deps: ["libraries_mecha:setup:srcs"]
			srcs: globs: [
				"interpreter/vendor/entry.ts",
				"interpreter/vendor/entry-morphlex.ts",
				"interpreter/vendor/bundle-morphlex.ts",
				"interpreter/vendor/entry-js-yaml.ts",
			]
			outs: globs: [
				"interpreter/vendor/mecha-client.js",
				"interpreter/vendor/morphlex.js",
				"interpreter/vendor/js-yaml.js",
			]
			// The mecha-client leg is the script package.json states, rather
			// than a second spelling of it: test/vendor-bundle.test.ts runs
			// that same script to decide whether the checked-in bundle is
			// stale, and a bundle built two ways is one of them can be wrong
			// about.
			cmd: "builtin": {
				shell: "sh"
				do:    "sh -c '" + _packageJson.scripts["bundle:mecha-client"] + " && deno run --allow-run=deno --allow-read --allow-write interpreter/vendor/bundle-morphlex.ts && deno bundle --config interpreter/deno.json --platform browser --format esm --minify interpreter/vendor/entry-js-yaml.ts -o interpreter/vendor/js-yaml.js && " + _packageJson.scripts["bundle:messages"] + "'"
			}
			dockerfile: from: ref: ":setup"
		}

		"generate": sayt.generate & {deps: [":bundle"], cmd: "builtin": do: "nu -c \"null\""}

		// What an installed app's images read of the terminal, at the image's
		// root: the interpreter and adapters caddy serves, the visual checker
		// and what it imports, the URL base tests share, and the markup reader
		// and machine schema. Published as bonitao/omnishell (cd.yml); an app
		// in the monorepo builds it from here instead (MONOREPO_COMPOSE_MODE).
		"runtime-image": {
			visibility: "public"
			cmd: "builtin": null
			activate: ""
			srcs: globs: _runtimeTree
			// At the root: the sources bayt copies land where the app's
			// images read them, as one layer.
			dockerfile: {
				from:    null
				workdir: "/"
			}
		}
	}
}

// The runtime image's tree; runtime/cli_test.ts holds it closed under what
// check-visual.ts and read-markup.ts import.
_runtimeTree: [
	"interpreter/**",
	"components/**",
	"src/**",
	"test/storybook-injector.ts",
	"test/canonical.ts",
	"check-visual.ts",
	"base-url.ts",
	"read-markup.ts",
	"machine.cue",
]

_packageJson: _ @embed(file="package.json")

project: _omnishell
