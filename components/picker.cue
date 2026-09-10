// omnishell--picker: shadcn's Select (the single-pick lite) restated in the
// binding vocabulary — selection is a #Machine over one field, openness is
// the platform's: `popover` on the listbox, `commandfor`/`command` on the
// buttons, anchor positioning in CSS. Zero script for the open/close half,
// because dismissal, top-layer and the invoker's aria-expanded are browser
// primitives now (plugins/omnishell/docs/2026-08-03-component-tier.md, tier 0).
//
// Selection follows #Tabs' shape: one state per option, one component-written
// `click@trigger-<name>` arrow per (state, option) pair. An option button
// carries BOTH declarative behaviors — its id feeds the machine's
// discrimination, its command closes the popover — one click, two closed
// vocabularies, no code.
//
// Two readouts, because the selected-state has two honest homes:
//   columns — the readout label and each option's aria-selected are columns
//     of the row, kept by literal assigns; ARIA-complete with zero script,
//     for an entity that carries the columns (the gallery's demo row).
//   text — the machine writes only its field plus each option's declared
//     assigns; the readout is per-option <i data-t> spans CSS shows via the
//     bound data-value, and per-option selected-state is the consumer's
//     concern (truco keeps an aria-checked observer). For rows whose entity
//     carries no readout columns.
package components

import (
	"strings"

	terminal "github.com/bonisoft3/omnishell:terminal"
)

#Picker: P={
	collection: string
	row:        *"the" | string
	field:      *"choice" | string
	label:      string
	// Distinguishes instances sharing one collection (ids, data-picker); the
	// single-instance default keeps the collection as the name.
	key: *P.collection | string
	// The slot's read. The default pins the row's id, which is also the
	// machine-region precondition; a filter pinning anything else must bring
	// emptyRow (the lint's other arm).
	filter: *"id=eq.\(P.row)" | string
	// Emitted as data-empty-row when set — the fallback row for a slot whose
	// filter pins no id; must agree with the machine (vetted at generate).
	emptyRow?: string
	// The machine's initial state; an emptyRow's field value must equal it.
	initial: *P.options[0].name | string
	// item is the listbox line, label the readout's short form; assign merges
	// extra columns (literals or {type, params} leaves) into every arrow
	// TARGETING that option — a choice carrying its declared consequences on
	// the row without leaving it.
	options: [...{
		name:  string
		label: string
		item:  *label | string
		assign?: [string]: string | number | bool | {type: string, params?: [string]: string | number | bool}
	}] & [_, _, ...]
	// Applied to every arrow as its one guarded candidate — the picker-wide
	// admission (truco: "a sitting exists").
	guard?: string | {type: string, params?: [string]: string | number | bool}
	readout: *"columns" | "text"

	_pop:          "picker-pop-\(P.key)"
	_initialLabel: [for o in P.options if o.name == P.initial {o.label}][0]

	_assignOf: {for o in P.options {
		(o.name): {
			if P.readout == "columns" {
				"label": o.label
				for u in P.options {
					("sel_\(u.name)"): [if u.name == o.name {"true"}, "false"][0]
				}
			}
			if o.assign != _|_ {o.assign}
		}
	}}
	_hasAssign: {for o in P.options {
		(o.name): P.readout == "columns" || o.assign != _|_
	}}

	machine: terminal.#Machine & {
		field:   P.field
		initial: P.initial
		if P.readout == "columns" {
			context: {
				label: P._initialLabel
				for o in P.options {
					("sel_\(o.name)"): [if o.name == P.initial {"true"}, "false"][0]
				}
			}
		}
		states: {for s in P.options {
			(s.name): on: {for o in P.options if o.name != s.name {
				("click@\(P.key)-trigger-\(o.name)"): [
					if P.guard != _|_ {
						[{
							guard:  P.guard
							target: o.name
							if P._hasAssign[o.name] {assign: P._assignOf[o.name]}
						}]
					},
					{
						target: o.name
						if P._hasAssign[o.name] {assign: P._assignOf[o.name]}
					},
				][0]
			}}
		}}
	}

	_emptyRowAttr: [
		if P.emptyRow != _|_ {"\n       data-empty-row='\((#attrEscape & {in: P.emptyRow}).out)'"},
		"",
	][0]

	if P.readout == "columns" {
		_options: strings.Join([for o in P.options {
			"""
				      <li><button type="button" role="option" id="\(P.key)-trigger-\(o.name)" class="picker-option"
				              aria-selected="{sel_\(o.name)}"
				              commandfor="\(P._pop)" command="hide-popover">\(o.item)</button></li>
				"""
		}], "\n")

		markup: """
			<omnishell--picker>
			  <div class="picker" data-live="\(P.collection)" data-filter="\(P.filter)"\(P._emptyRowAttr)
			       data-state="{\(P.field)}"
			       data-machine='\((#attrJSON & {in: P.machine}).out)'>
			    <button type="button" id="picker-open-\(P.key)" class="picker-trigger"
			            commandfor="\(P._pop)" command="toggle-popover" aria-haspopup="listbox">
			      <span class="picker-label">\(P.label)</span>
			      <span class="picker-value" data-text="{label}">\(P._initialLabel)</span>
			    </button>
			    <ul id="\(P._pop)" class="picker-list" popover role="listbox" aria-label="\(P.label)">
			\(P._options)
			    </ul>
			  </div>
			</omnishell--picker>
			"""
	}

	if P.readout == "text" {
		_options: strings.Join([for o in P.options {
			"""
				      <li><button type="button" role="option" id="\(P.key)-trigger-\(o.name)" data-opt="\(o.name)"
				              commandfor="\(P._pop)" command="hide-popover">\(o.item)</button></li>
				"""
		}], "\n")
		_spans: strings.Join([for o in P.options {"<i data-t=\"\(o.name)\">\(o.label)</i>"}], "")

		markup: """
			<omnishell--picker>
			  <div class="picker" data-picker="\(P.key)" data-value="{\(P.field)}" data-live="\(P.collection)" data-filter="\(P.filter)"\(P._emptyRowAttr)
			       data-machine='\((#attrJSON & {in: P.machine}).out)'>
			    <button type="button" id="picker-open-\(P.key)"
			            commandfor="\(P._pop)" command="toggle-popover" aria-haspopup="listbox">
			      <span class="sr">\(P.label):</span>
			      <span class="pick-label">\(P._spans)</span>
			    </button>
			    <ul id="\(P._pop)" class="picker-list" popover role="listbox" aria-label="\(P.label)">
			\(P._options)
			    </ul>
			  </div>
			</omnishell--picker>
			"""
	}
}
