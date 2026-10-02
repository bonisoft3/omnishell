// The virtual terminal, published as CUE: omnishell's unconfigured shell for
// one app — the entry page and the static-file wiring the cluster's proxy
// serves, against default entrypoints (shell/shell.yaml, the interpreter at
// /omnishell/interpreter/). Configure or override by unification; pin or fork
// this package to version the terminal independently of the app.
@extern(embed)

package terminal

import (
	"list"
	"strings"
)

#Path:   string
#Jessie: #Path & =~"\\.js$"

// The base languages written right-to-left, as data, because the emitter needs
// a direction at compile time and CUE has no Intl to ask. Everything else asks
// the engine instead (interpreter/fragment.js directionOf), and
// test/locale-resolver.test.ts grades this list against that answer for every
// member AND for every tag any app declares. Two ways it can be wrong, both
// caught there: a language nobody has declared yet is missing, or a tag names a
// script that flips its language's direction (sd-Deva reads left-to-right where
// sd reads right-to-left) — matching on the base language cannot see that.
#RtlLanguages: ["ar", "arc", "ckb", "dv", "fa", "he", "ks", "mzn", "nqo", "ps", "sd", "syr", "ug", "ur", "yi"]

// Embedded locally: @embed cannot cross a directory boundary, so this only
// works because shell.html/shell.css/boot.js live beside this file. Exposed
// on #Terminal.surface.assets; emit.cue reads them as plain CUE values
// (text:), never a src: path — write.ts refuses any src leaving the app's
// own directory (checked directly).
_shellHtmlAsset: _ @embed(file="shell.html", type=text)
_shellCssAsset:  _ @embed(file="shell.css", type=text)
_bootJsAsset:    _ @embed(file="boot.js", type=text)
_swJsAsset:      _ @embed(file="offline-first-sw.js", type=text)

// cluster.#Static-shaped, not imported: terminal.cue and cluster.cue each
// define their own copy rather than coupling the two packages together.
#Static: {
	file:   #Path
	target: string
	watch:  *false | bool
}

#Terminal: T={
	app: string
	// Fills the entry page's meta description. Double quotes would close the
	// attribute they land in.
	description: string
	description: !~ "\""
	// What the entry document says it is in before any script runs. The shell
	// rewrites it per screen once a locale is resolved, but a crawler that does
	// not render and the paint before boot both read this one — so it is the
	// app's declared default, and "en" only for an app that declares nothing.
	language: string | *"en"
	// And which way that language reads, for the same pre-boot paint: without
	// it a Hebrew app lays out left-to-right until a script runs, and never at
	// all for a crawler that runs none. The emitter resolves it from `language`
	// against #RtlLanguages.
	direction: *"ltr" | "rtl"

	state: {
		navigation: true
	}

	capabilities: {
		// Platform doctrine, published as data. Pronto reads this at compile
		// time: the prelude describes it to hop 1, and #emit refuses an app auth
		// mode the terminal does not offer. Users never type identifiers — a
		// passkey ceremony is one tap with a server-generated display handle,
		// and a guest mint (always rendered, origin-independent, no ceremony)
		// issues the same identity shape; social hand-off (firebase) is the
		// planned third mode.
		// `chrome` is the strip the terminal draws for a signed-in person and
		// what an app may tell it about that person: `self.route`, the route
		// that is their own page, whose :params the terminal fills from the
		// session user; and `self.name`, the table and column the name they
		// chose lives in, read live so a rename reaches the strip as it
		// reaches a byline. An app with no page for a person declares no
		// `self` and the handle stands alone — but then the one identity a
		// reader always has on screen leads nowhere.
		auth: {
			modes:    [...string]
			identity: string
			chrome:   string
		}
		auth: {
			modes:    ["passkey", "guest"]
			identity: "generated"
			chrome:   "<name · handle> · sign out; self.route and self.name are the app's"
		}

		// What data-text-format may name without the app declaring anything.
		// These are value formatting, text in and text out; an app formatting
		// its own timestamps or grouping its own digits has reimplemented a
		// platform affordance and will differ from every other app for no
		// reason a reader benefits from. The list is not closed — any other
		// name is an app's own renderer, per `renderer` below.
		"text-formats": [Name=string]: {renders: string, note: string}
		"text-formats": plain:    {renders: "the column's text, placeholders interpolated", note: "the default when data-text-format is absent"}
		"text-formats": datetime: {renders: "the moment in the reader's own language and clock (\"Aug 2, 09:00\" to an American, \"2 de ago., 09:00\" to a Brazilian)", note: "raw ISO / postgres timestamptz never reaches a reader; the zone is the reader's, except in the storybook, which pins UTC for the checks and for prerendered documents"}
		"text-formats": number:   {renders: "the number in the reader's own digits and grouping (\"1.234,5\" to a Brazilian)", note: "the column's ASCII spelling is nobody's"}


		// The renderer role, and the terminal's DOM mutation story. A renderer
		// is a pure (value) => nodes function; interpreter/render.js states why
		// and enforces it. The terminal owns the trusted half and only that: an
		// app wanting highlighting, diagrams or maths declares the renderer it
		// wants rather than waiting for this list to grow one.
		//
		// data-text-format names a built-in format or an app renderer
		// resolved by basename out of the route's files.renderers — the same
		// resolution a data-handler gets. A name colliding with a built-in is
		// refused rather than shadowed.
		renderer: {
			role:    string
			returns: string
			owns: [Name=string]: {is: string, note: string}
			note: string
		}
		renderer: {
			role:    "jessie, evaluated in a compartment with nothing endowed, like handler and fold"
			returns: "an array of nodes, where a node is a string (always text) or {tag, attrs?, children?}"
			owns: schema: {is: "the node description", note: "there is no node kind for raw markup, so no renderer can ask for it and no value can smuggle it"}
			owns: tags: {is: "a prose-element allowlist", note: "no script/style, no iframe/object/embed (that is the hatch, under a sandbox), no form/input (mutations are forms a screen author wrote), no svg/math"}
			owns: attributes: {is: "a per-tag attribute allowlist", note: "on* and style refused; data-* refused hardest, since it is the terminal's own binding vocabulary and a renderer emitting one could forge a region, a binding or a hatch mount out of a reader's prose"}
			owns: urls: {is: "the http/https/mailto scheme check", note: "applied by the builder whether or not the renderer consulted it; a refused URL drops the attribute rather than throwing, because a reader's content must not take the screen down"}
			owns: reconciliation: {is: "the DOM write itself", note: "an unchanged description is not written at all, so a re-bind cannot cost the reader their text selection and idempotence is structural rather than each renderer's to earn"}
			note: "a structural violation — unknown tag, malformed node, refused attribute — throws, because that is a bug in the renderer and not in anyone's data"
		}

		sensors: [Name=string]: {yields: string, note: string}
		sensors: camera:               {yields: "captured frame (Blob), via a returned request", note: "one MediaStream per tab; CameraView is terminal chrome, not a mountable unit"}
		sensors: microphone:           {yields: "captured audio clip (Blob), via a returned request", note: "getUserMedia's audio half"}
		sensors: "screen-capture":     {yields: "a captured frame or recording (Blob), via a returned request", note: "getDisplayMedia"}
		sensors: geolocation:          {yields: "{lat: number, lng: number, accuracy: number}, via a returned request", note: "one-shot read only"}
		sensors: "device-orientation": {yields: "an orientation/acceleration reading", note: "fires continuously — blocked on Q3 (do subscriptions generalize?), declared but not yet grantable"}

		background: [Name=string]: {yields: string, note: string}
		background: notifications:     {yields: "a shown notification, via a returned request", note: "Notifications API"}
		background: push:              {yields: "a push subscription (endpoint + keys), via a returned request", note: "the push event itself fires in the service worker, never in a unit — blocked on service-worker registration support, not yet grantable"}
		background: "background-sync": {yields: "a registered sync tag, via a returned request", note: "same service-worker-only firing as push — same block"}
		background: "wake-lock":       {yields: "an active, auto-released wake lock, via a returned request", note: "Screen Wake Lock API"}

		hardware: [Name=string]: {yields: string, note: string}
		hardware: usb:       {yields: "a connected USB device handle, via a returned request", note: "WebUSB"}
		hardware: hid:       {yields: "a connected HID device handle, via a returned request", note: "WebHID"}
		hardware: serial:    {yields: "a connected serial port handle, via a returned request", note: "Web Serial"}
		hardware: bluetooth: {yields: "a connected Bluetooth device handle, via a returned request", note: "Web Bluetooth"}
		hardware: nfc:       {yields: "a scanned NFC tag reading, via a returned request", note: "Web NFC"}

		"os-bridge":    [Name=string]: {yields: string, note: string}
		"network-peer": [Name=string]: {yields: string, note: string}

		// Boundaries a unit can be given. They are not ordered, and each buys
		// one thing:
		//   compartment  SES, and what generated logic runs in — no ambient
		//                authority at all, the terminal's own code, this thread.
		//   iframe       containment, and this thread. An opaque origin, no
		//                storage, no cookies, no reach through window.parent —
		//                which is what a unit rendering something audited by
		//                nobody (a provider's embed, fetched at read time) has
		//                to sit behind.
		//   worker       a thread, and containment in no sense whatsoever. Same
		//                origin, so fetch, IndexedDB and the cache API all
		//                survive: this is MORE ambient authority than the frame
		//                seat, not less. What stands behind a worker unit is
		//                the app's audit of the wrapper and the pinned hash of
		//                what the wrapper loads — audited and pinned, never
		//                contained.
		isolation: [...string]
		isolation: *["compartment", "iframe", "worker"] | [...string]

		// The terminal's measured floors, in device px — what a body can hit,
		// not what a design would like. WCAG 2.5.8 (AA); 2.5.5's 44px is real
		// advice on a content surface and not a gate, so it is visual lint's
		// own default and not this.
		//
		// One declaration, because the number is two claims that have to agree:
		// the rung #scale publishes as --min-touch, and the threshold
		// check-visual.ts holds a tap target to. Held apart they can be moved
		// apart, and then the rung is a lie visual lint still passes.
		floors: [Name=string]: int
		floors: touch: 24

		// The terminal's hatch. Props in are the mount element's
		// data-prop-* attributes, resolved against the row by the same binder
		// as every other attribute and resynchronised on every refresh, so a
		// hatch in a live region tracks its row for free. Events out are named
		// messages the unit posts over its lifetime; the terminal performs the
		// names it knows and hands the rest to the screen.
		// Keyed by boundary, because the two do not share their answers:
		// `grants: []` is a true statement about an opaque origin and a false
		// one about a same-origin worker, and `height` names a frame that a
		// worker seat does not have.
		hatch: [Boundary=string]: {
			isolation: Boundary
			mount:     string
			props:     string
			events: [Name=string]: {performs: string, note: string}
			grants: [...string]
			note: string
		}
		hatch: iframe: {
			mount: "data-hatch=\"<unit>\", naming an #App.capabilities.vendored entry"
			props: "data-prop-* attributes, delivered as one current-value object"
			events: height: {performs: "sets the unit frame's height", note: "the unit measures itself; clamped so a wrong answer cannot blow out the page"}
			events: answer: {
				performs: "dispatches a non-bubbling CustomEvent of the same name on the mount element, where data-on-answer names the reduce that receives it"
				note:     "the detail is rebuilt from validated strings and frozen; the unit's own object never crosses"
			}
			// An opaque origin is granted nothing, and the terminal refuses a
			// unit that asks for a capability rather than granting silence.
			grants: []
			note: "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox, never allow-same-origin — the unit runs in an opaque origin and cannot reach this one. Props are delivered with targetOrigin \"*\", which an opaque origin leaves no alternative to, so a hatch is never given a secret"
		}
		hatch: worker: {
			mount: "data-hatch=\"<unit>\", naming an #App.capabilities.vendored entry — the element renders nothing"
			props: "data-prop-* attributes, delivered as one current-value object, withheld until the unit says it is ready"
			events: answer: {
				performs: "dispatches a non-bubbling CustomEvent of the same name on the mount element, where data-on-answer names the reduce that receives it"
				note:     "the detail is rebuilt from validated strings and frozen; the unit's own object never crosses"
			}
			// The terminal grants a unit nothing at either boundary.
			grants: []
			note: "a classic same-origin Worker — its own thread, no DOM, and fetch/IndexedDB/the cache API intact. The port is the identity, so there is no origin check to make; the app's audit of the unit script and the pinned hash of what it loads are the whole boundary"
		}
	}

	surface: {
		// entry/css/boot are app-relative TARGET paths — where these land in
		// the app's own served tree, alongside shell.yaml and design.css
		// (pronto/emit.cue-owned, not declared here). Their CONTENT comes from
		// assets below; see _shellHtmlAsset. design.css isn't listed here —
		// it's #App's own generated file, nothing omnishell-specific about it.
		entry: #Path
		entry: *"shell/index.html" | string
		css: #Path
		css: *"shell/shell.css" | string
		boot: #Path
		boot: *"shell/boot.js" | string
		sw: #Path
		sw: *"offline-first-sw.js" | string

		assets: {
			html: strings.Replace(
				strings.Replace(
					strings.Replace(
						strings.Replace(_shellHtmlAsset, "{description}", T.description, 1),
						"{language}", T.language, 1),
					"{direction}", T.direction, 1),
				"{modulepreload}", _preloadHtml, 1)
			css:  _shellCssAsset
			boot: *_bootJsAsset | string
			sw:   _swJsAsset
		}

		interpreterRoot: #Path
		interpreterRoot: *"../../plugins/omnishell/interpreter" | string

		componentsRoot: #Path
		componentsRoot: *"../../plugins/omnishell/components" | string

		// The adapters the terminal ships: a control's value in its own
		// spelling on one side and a canonical type on the other
		// (plugins/omnishell/REFERENCE.md#adapters). Served like
		// the interpreter and never copied into an app, so there is one of each
		// and no app holds a stale twin; an app that needs its own writes it
		// under shell/handlers/ and the route names that instead. Not
		// preloaded: a screen fetches the one it names, when it names one.
		adapters: [...#Path]
		adapters: ["wallclock.js"]

		// Where this app reaches the terminal's command line: a runtime
		// directory of this plugin's own tree, app-relative, or the empty
		// string for the `omnishell` a consumer has on PATH. The layout an app
		// is built in decides, and `omnishell mode` writes that decision into
		// the app's package as a stanza unifying here — which is the whole
		// reason this is a field and not a path written into someone's source.
		runtime: #Path
		runtime: *"" | string

		// One leaf of that command line, run over the app's own directory.
		// Both spellings are one word and a leaf, because which entry answers
		// to the word is the toolchain's to say: a checkout answers with the
		// task below, naming the tree it is standing in, and an install with
		// the platform-native entry it put on PATH. Neither asks the rule
		// which OS it woke up on.
		_command: {
			for leaf in ["check markup", "check handlers", "check machines", "check battery", "check i18n"] {
				(leaf): [
					if T.surface.runtime != "" {"mise run omnishell -- \(leaf) ."},
					"omnishell \(leaf) .",
				][0]
			}
		}

		// The tree the runtime sits in, which is what the command reads beside
		// its own source: the suite config it type-checks against and the
		// interpreter the checkers load.
		_pluginRoot: strings.TrimSuffix(T.surface.runtime, "/runtime")

		// The task that word names in a checkout, for mise to merge from the
		// app's own conf.d. `dir` is what makes the leaf's `.` the app rather
		// than wherever the config was found, and the file is this plugin's
		// to write so the bootstrap config beside it never learns the name.
		miseConf: [
			if T.surface.runtime != "" {"""
				[tasks.omnishell]
				dir = "{{cwd}}"
				run = "deno run --no-lock --no-check --node-modules-dir=none --config \(_pluginRoot)/test/deno.json --allow-read=.,\(_pluginRoot) --allow-write=. --allow-env \(T.surface.runtime)/cli.ts"

				"""},
			"",
		][0]

		// What a compiler reaches this plugin through, rather than importing
		// it: the command that prints one app's markup as JSON
		// (read-markup.ts's header is the contract), and the published
		// #Machine every chart in that markup is vetted against. Both are
		// spawned from the app's own directory, so both are app-relative, and
		// a consumer that keeps the terminal somewhere else states where by
		// unifying these — which is the whole reason they are fields and not
		// paths written into someone's source.
		markupReader: #Path
		markupReader: *"../../plugins/omnishell/read-markup.ts" | string
		machineSchema: #Path
		machineSchema: *"../../plugins/omnishell/machine.cue" | string

		// The entry page fetches the boot graph in parallel at t=0 instead of
		// discovering each import a round-trip after its parent executes.
		// storybook.js loads only under ?storybook and stays lazy; ses/jessie
		// stay undeclared here too — loaded after first paint; mecha-client,
		// data-sync, and hatch are deferred so cold first paint loads minimal
		// paint-critical weight.
		_preloadSkip: {
			"storybook.js":           true
			"vendor/ses.umd.min.js":  true
			"vendor/js-yaml.js":      true
			"vendor/mecha-client.js": true
			"data-sync.js":           true
			"validate.js":            true
			"hatch.js":               true
			"hatch-worker.js":        true
			"jessie.js":              true
			"vendor/morphlex.js":     true
			"kinetic.js":             true
			"prng.js":                true
		}
		_preloadHtml: strings.Join([for m in modules if _preloadSkip[m] == _|_ {
			"<link rel=\"modulepreload\" href=\"/omnishell/interpreter/\(m)\">"
		}], "\n")

		modules: [...#Path]
		modules: [
			"shell.js", "chrome.js", "screen.js", "fragment.js", "data-sync.js", "validate.js", "render.js",
			"hatch.js", "hatch-worker.js", "storybook.js", "jessie.js", "kinetic.js", "prng.js",
			"vendor/mecha-client.js", "vendor/js-yaml.js", "vendor/ses.umd.min.js", "vendor/morphlex.js",
			"vendor/messages.js",
		]

		screens: [...{name: string, html: #Path, css: #Path}]

		handlers: [...#Jessie]
		handlers: *[] | [...#Jessie]

		// The renderer modules backing app-declared `data-text-format` names
		// (see `renderer` above). Served like a handler and resolved like one,
		// by basename out of each route's files.renderers.
		renderers: [...#Jessie]
		renderers: *[] | [...#Jessie]

		// Stylesheets screens share. Served like any other static; the list is
		// the union of what screens name, so it holds only referenced files.
		shared: [...#Path]
		shared: *[] | [...#Path]

		// Fold modules named by `pipelines[].fold`, served as the declared
		// contract of a pipeline's browser-side transform. Nothing executes
		// one: the terminal's projection of a fold sink counts contributions
		// and calls none of the four functions, and only check handlers loads
		// the module.
		folds: [...#Jessie]
		folds: *[] | [...#Jessie]

		// Validation modules backing entity predicates, fetched before write.
		validations: [...#Jessie]
		validations: *[] | [...#Jessie]

		// Every file a vendored unit needs served, its own `src` among them:
		// the wrapper an engineer audited, and whatever that wrapper loads. A
		// glue script derives its .wasm URL from its own script URL, so a
		// unit's files land as siblings under one directory.
		units: [...#Path]
		units: *[] | [...#Path]

		// Served as plain statics so the terminal fetches active and default
		// catalogs by URL rather than embedding them into screen markup.
		messages: [...#Path]
		messages: *[] | [...#Path]

		// Invariants of the terminal's own rendering surface, which no app can
		// re-derive — the same reason auth and text-formats are published here.
		// `verb` is the cheapest layer that can answer each. The loop owns this
		// vocabulary; it is restated here because omnishell is consumed on its
		// own and cannot import a sibling plugin.
		verbs: [Name=string]: {verb: "setup" | "generate" | "build" | "launch" | "release", cmds: [...string], note: string}
		checks: [Name=string]: {verb: "lint" | "test" | "integrate", cmds: [...string], note: string}
		checks: visual: {
			let composeProject = "(^mise exec -- printenv COMPOSE_PROJECT_NAME | complete | get stdout | str trim | str replace -r '^$' '\(T.app)')"
			// A laid-out page over real content, so the cluster has to be up
			// however cheap `lint` would look.
			verb: "integrate"
			cmds: [
				// --build, because compose reuses any image it already has: a
				// lint that photographed the previous build reports green for
				// markup nobody is serving. Under mise exec, because the compose
				// project name is published in the app's .mise.toml [env], and
				// the tool-stub sayt runs rules through applies no [env].
				"mise exec -- docker compose -p \(composeProject) up -d --wait --build launch",
				// No --force-recreate: it recreates the DEPENDENCIES too, so a
				// data-backed app starts every run with an empty database and its
				// rows-first screens never settle. --build is the part that
				// matters, and it rebuilds without discarding state.
				// -p, not --project-directory: the closure's own directory is
				// where its includes and extends resolve, so only the project
				// NAME may move. Without it the closure starts a second project
				// named after .bayt, which brings up a second caddy and collides
				// with the first on its port — and the runtime the line above
				// started would not be the one the lint talks to. The name is
				// the one the line above resolves, read from the same mise env:
				// the published COMPOSE_PROJECT_NAME, else the app's own, which
				// compose derives from the app directory. An empty one counts as
				// unpublished.
				"mise exec -- docker compose -p \(composeProject) --profile '*' -f .bayt/compose.integrate.closure.yaml up bayt --abort-on-container-failure --exit-code-from bayt --build --remove-orphans --attach-dependencies",
			]
			note: "DOM checks over every route at two viewports, run in a container beside the app; only critical findings fail"
		}
		// The four checks below are COMMANDS: which interpreter runs a
		// checker, on which lockfile and type-check policy, reaching which
		// files and which of the environment, is the terminal's own business
		// and lives behind its command line (runtime/cli.ts). What a caller
		// states is the leaf and the directory to answer for.
		checks: machines: {
			verb: "test"
			cmds: [T.surface._command["check machines"]]
			note: "every arrow of every emitted chart fires, and XState agrees where each one lands"
		}
		if len(T.surface.messages) > 0 {
			checks: i18n: {
				verb: "test"
				cmds: [T.surface._command["check i18n"]]
				note: "every route and state hydrates under every declared locale without unlocalized leaks or un-interpolated placeholders"
			}
		}

		checks: handlers: {
			// Source and a compartment are the whole of what it needs — no
			// cluster, no page — so it answers at the cheapest verb there is.
			verb: "lint"
			cmds: [T.surface._command["check handlers"]]
			note: "every Jessie module the app declares loads in the compartment its role runs in"
		}

		checks: battery: {
			// Source, a compartment and the emitted schema are the whole of
			// what it needs — no cluster, no page — but every handler and
			// validation module is run hundreds of times over, so it answers
			// at the verb that admits work rather than at the one whose
			// promise is that it does none.
			verb: "test"
			cmds: [T.surface._command["check battery"]]
			note: "every handler and validation module the app declares survives inputs drawn from its own schema: confined, within its fuel budget, deterministic, and mutating nothing it was handed"
		}

		checks: markup: {
			// The screens and the emitted schema are the whole of what it needs
			// — no cluster, no page, and nothing evaluated — so it answers at
			// the cheapest verb there is. The rules are the terminal's own
			// (interpreter/lint.ts), so a terminal consumed on its own brings
			// them along.
			verb: "lint"
			cmds: [T.surface._command["check markup"]]
			note: "every screen's markup says something the terminal's grammar admits, about entities the program declares"
		}

		statics: [...#Static]
		statics: list.Concat([
			[
				// Watched like the screens are: all of these are regenerated by
				// `just generate` from the program, and a design token or a seed
				// row that does not reach the running container is a hot reload
				// that works for some edits and not others.
				{file: T.surface.entry, target: "/srv/\(T.surface.entry)", watch: true},
				{file: T.surface.css, target: "/srv/\(T.surface.css)", watch: true},
				{file: T.surface.boot, target: "/srv/\(T.surface.boot)", watch: true},
				{file: T.surface.sw, target: "/srv/\(T.surface.sw)", watch: true},
				{file: "shell/shell.yaml", target: "/srv/shell/shell.yaml", watch: true},
				{file: "shell/shell.json", target: "/srv/shell/shell.json", watch: true},
				{file: "shell/design.css", target: "/srv/shell/design.css", watch: true},
			],
			[for s in T.surface.screens for kind in ["html", "css"] {
				file:   s[kind]
				target: "/srv/\(s[kind])"
				watch:  true
			}],
			[for h in T.surface.handlers {
				file:   h
				target: "/srv/\(h)"
				watch:  true
			}],
			[for r in T.surface.renderers {
				file:   r
				target: "/srv/\(r)"
				watch:  true
			}],
			[for c in T.surface.shared {
				file:   c
				target: "/srv/\(c)"
				watch:  true
			}],
			[for f in T.surface.folds {
				file:   f
				target: "/srv/\(f)"
				watch:  true
			}],
			[for v in T.surface.validations {
				file:   v
				target: "/srv/\(v)"
				watch:  true
			}],
			// Unwatched, unlike every other app-authored file here: the watch
			// list becomes compose develop sync+restart entries, and a unit's
			// unaudited half is megabytes that would restart the proxy on every
			// launch. Editing a unit is a rebuild.
			[for u in T.surface.units {
				file:   u
				target: "/srv/\(u)"
				watch:  false
			}],
			[for m in T.surface.messages {
				file:   m
				target: "/srv/\(m)"
				watch:  true
			}],
			// The interpreter is hand-written and edited in the loop, so it is
			// watched like an app's own screens are.
			[for m in T.surface.modules {
				file:   "\(T.surface.interpreterRoot)/\(m)"
				target: "/omnishell/interpreter/\(m)"
				watch:  true
			}],
			[for m in T.surface.adapters {
				file:   "\(T.surface.componentsRoot)/\(m)"
				target: "/omnishell/components/\(m)"
				watch:  true
			}],
		])
	}
}
