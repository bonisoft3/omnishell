// The machine vocabulary, published beside the capability roster (same
// package; its own file so `cue vet -d '#Machine'` can load it without the
// shell-asset embeds terminal.cue carries).
//
// #Machine is the XState-JSON data subset the terminal executes itself — no
// compartment, because a machine is data. Value positions — a guard, an
// assign's value, an `after` delay — hold a literal or the name of a Jessie
// module (resolved like any data-on-* handler, called with the reduce's
// signature); everything that draws the chart — targets, initial, context,
// state names, raised event types — is always data. The machine is closed
// over its row: its leaves see {items: [row]} and nothing else, its writes
// never leave the row, and every transition lands as one stated row through
// the same step() machinery reduces use — replay, tempo and the refusal
// event apply with the machine knowing nothing.
//
// A machine writes the row a browser owns; a form writes the row a server
// keeps. That is the whole choice between them — an assign states screen state
// as it changes, a submit commits data on a gesture — and it is why every
// table a machine writes is a tab or device one.
//
// The machine is the writer of the initial fact: a region without
// data-empty-row binds a row synthesized from {...context, field: initial}
// plus its filter equalities; where data-empty-row is present it must agree
// (vetted at generate, never arbitrated at runtime).
//
// Everything XState has beyond this shape — entry/exit, invoke, nested and
// parallel states, sendTo/emit — fails unification loudly. `after` is the
// relocated invoke: armed on state entry, canceled on exit, performed by the
// terminal's clock. `raise` is the reduce's `then:` under XState's name —
// literal types, so the cascade stays drawable, delivered depth-bounded (the
// deliberate SCXML deviation: a cascade with no owner has no end). Root-level
// `on:` applies in every state unless the state declares the same key. Event
// keys are the terminal's own event types plus the synthesized `refused`;
// `<type>@<dom-id>` narrows a transition to one affordance, a spelling
// components generate and no author writes.
//
// A DISPLACING type — `contextmenu`, and it is the whole set — has its default
// canceled wherever an arrow answers it, because the app's answer and the UA's
// cannot both stand. The cancel is the arrow's rather than a second attribute's:
// answering the type is the markup declaring the gesture, which is what every
// cancel the terminal makes already belongs to.
package terminal

#Machine: M={
	// The row column the state lives in. The machine's current state IS this
	// field's value — no second store of truth, no `initial` beside the row.
	field:   string
	initial: or([for k, _ in M.states {k}])
	// Literal initial values for the row's other columns; with `initial` this
	// makes the machine the complete statement of the initial world. Never the
	// machine's own field — one fact, one writer.
	context?: [string]: string | number | bool
	// Root-level transitions, applied in every state unless the state declares
	// the same event key.
	on?: M.#On
	states: [Name=string]: close({
		on?: M.#On
		// The relocated invoke: key is milliseconds (digits) or the name of a
		// Jessie module returning them; armed on entry, canceled on exit,
		// re-armed by a self-target.
		after?: [string]: M.#TransitionValue
	})

	// A bare state name is the v1 shorthand for {target}; an array is XState's
	// ordered candidate list — first guard-pass wins, every arrow drawn.
	#TransitionValue: or([for k, _ in M.states {k}]) | M.#Transition | [...M.#Transition]
	// A parameterized reference in XState's own spelling: the module is
	// called (state, event, params), params are literals only — thresholds
	// live in the chart as data, so one module serves every instance a
	// component generates.
	// `event` is the terminal's own leaf, never a module — excluded here so the
	// disjunction cannot fall through to this and leave #EventRef's field enum
	// deciding nothing.
	#Ref: close({
		type: string & !="event"
		params?: [string]: string | number | bool
	})
	// The one leaf a machine states instead of importing: the value the control
	// was showing when it fired. It reads the EVENT, never another row, so the
	// closure above holds — a transition is still decidable from the row and
	// the event, and the chart is still a whole inventory of what can happen.
	//
	// pointerX/pointerY are where in the AFFORDANCE's own box the pointer was,
	// in parts per thousand of it — never viewport pixels. The frame of
	// reference is an element a replay also renders, so no viewport is pinned
	// and no chart can reach the geometry the value was measured against. An
	// integer because a column a replay must reproduce exactly should not be a
	// float, and because the stylesheet is where the pixels come back.
	#EventRef: close({
		type: "event"
		params: close({field: "value" | "checked" | "valueAsNumber" | "key" | "pointerX" | "pointerY"})
	})
	#Transition: close({
		guard?:  string | M.#Ref // Jessie module; (state, event, params?) => boolean
		target?: or([for k, _ in M.states {k}])
		// Values for the machine's own row's columns: a literal, a Jessie
		// module name computing one, or a parameterized #Ref. All assigns read
		// the pre-transition snapshot and merge with the field write into ONE
		// stated row.
		assign?: [string]: string | number | bool | M.#EventRef | M.#Ref
		// A self-addressed event, XState's raise ≡ the reduce's then: literal
		// type, delivered by the terminal after the writes.
		raise?: string
	})
	#On: [Event=string]: M.#TransitionValue
}
