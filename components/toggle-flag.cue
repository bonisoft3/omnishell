// omnishell--toggle-flag: a unified statechart toggle flag powered by
// #Machine and #Effect. Instead of two forms and a probe span, a single
// button runs a 2-state toggle machine that executes declarative mutation
// effects (upsert or create/delete) directly into the store.
package components

import (
	terminal "github.com/bonisoft3/omnishell:terminal"
)

#ToggleFlag: F={
	// The flag's own table, and the column+value addressing the flagged row.
	entity: string
	on:     string
	value:  string

	buttonClass: string
	// The button's face per direction; when `count` is set, the face is
	// followed by the live count span.
	label: {off: string, on: string}
	aria?: {off: string, on: string}
	// The count probe: a sink table read beside the flag, keyed by the same
	// column and rendered inside the button.
	count?: {entity: string, column: string}

	retract: "stamp" | "delete"
	stamp:   *"deleted_at" | string

	// Prefixed to every emitted line.
	indent: *"            " | string

	_countSpan: [
		if F.count != _|_ {
			" <span data-live=\"\(F.count.entity)\" data-filter=\"\(F.on)=eq.\(F.value)\" data-empty-row='{\"\(F.count.column)\":0}' data-text=\"{\(F.count.column)}\">0</span>"
		},
		"",
	][0]
	_ariaOff: [if F.aria != _|_ {" aria-label=\"\(F.aria.off)\""}, ""][0]
	_ariaOn: [if F.aria != _|_ {" aria-label=\"\(F.aria.on)\""}, ""][0]
	_srOff: [if F.aria != _|_ {"<span class=\"sr-only\">\(F.aria.off) — </span>"}, ""][0]
	_srOn: [if F.aria != _|_ {"<span class=\"sr-only\">\(F.aria.on) — </span>"}, ""][0]

	_filter: [
		if F.retract == "stamp" {"\(F.on)=eq.\(F.value)&\(F.stamp)=is.null"},
		"\(F.on)=eq.\(F.value)",
	][0]

	_setEffect: [
		if F.retract == "stamp" {
			terminal.#Effect & {
				op:     "upsert"
				entity: F.entity
				values: {
					(F.on):    F.value
					(F.stamp): null
				}
			}
		},
		terminal.#Effect & {
			op:     "create"
			entity: F.entity
			values: {
				(F.on): F.value
			}
		},
	][0]

	_unsetEffect: [
		if F.retract == "stamp" {
			terminal.#Effect & {
				op:     "upsert"
				entity: F.entity
				values: {
					(F.on):    F.value
					(F.stamp): "{now}"
				}
			}
		},
		terminal.#Effect & {
			op:     "delete"
			entity: F.entity
			filter: "\(F.on)=eq.\(F.value)"
		},
	][0]

	machine: terminal.#Machine & {
		field:   "status"
		initial: "unset"
		states: {
			unset: on: click: {
				target: "set"
				effect: _setEffect
			}
			set: on: click: {
				target: "unset"
				effect: _unsetEffect
			}
		}
	}

	markup: """
\(F.indent)<omnishell--toggle-flag>
\(F.indent)  <button type="button" class="\(F.buttonClass) role-meta-sm"
\(F.indent)          data-live="\(F.entity)" data-filter="\(_filter)"
\(F.indent)          data-empty-row='{"id":"","status":"unset"}'
\(F.indent)          data-state="{status}"
\(F.indent)          data-machine='\((#attrJSON & {in: F.machine}).out)'>
\(F.indent)    <span class="face-off">\(_srOff)\(F.label.off)\(_countSpan)</span>
\(F.indent)    <span class="face-on">\(_srOn)\(F.label.on)\(_countSpan)</span>
\(F.indent)  </button>
\(F.indent)</omnishell--toggle-flag>
"""
}
