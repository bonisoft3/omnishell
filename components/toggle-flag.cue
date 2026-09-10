// omnishell--toggle-flag: the pair-of-forms flag — a probe region carrying
// whether the reader's row exists, and one form per direction. Forms, never a
// machine: the flag's state is a row whose retraction may be a server-minted
// timestamp ({now}), and the clock is an effect the terminal owns.
//
// Two retraction algebras, chosen by `retract`:
//   - "stamp": both directions are upserts on the reader's natural key, the
//     stamp column carrying null / {now}; the probe filters the stamp null.
//   - "delete": setting creates the row, retracting is a filter-scoped delete
//     (a bare sibling delete would address the enclosing row's id and remove
//     nothing; RLS narrows the filter to the reader's own row).
//
// The markup carries no wrapper tag: an arm's visibility is the probe's
// :empty reaching it through a sibling combinator, and a wrapper would put
// the probe out of the arms' selector reach — the probe and both forms land
// as siblings of whatever surrounds the instance.
package components

import (
	"list"
	"strings"
)

#ToggleFlag: F={
	// The flag's own table, and the column+value addressing the flagged row.
	entity: string
	on:     string
	value:  string

	probeClass: string
	// Per direction: the form's declared id, its visibility class (styled off
	// the probe's :empty), and the words both refusal paragraphs carry.
	set: {id: string, class: string, words: string}
	unset: {id: string, class: string, words: string}

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

	// Prefixed to every emitted line: the block reproduces at the depth its
	// screen authored it.
	indent: *"            " | string

	_countSpan: [
		if F.count != _|_ {
			" <span data-live=\"\(F.count.entity)\" data-filter=\"\(F.on)=eq.\(F.value)\" data-empty-row='{\"\(F.count.column)\":0}' data-text=\"{\(F.count.column)}\">0</span>"
		},
		"",
	][0]
	_ariaOff: [if F.aria != _|_ {" aria-label=\"\(F.aria.off)\""}, ""][0]
	_ariaOn: [if F.aria != _|_ {" aria-label=\"\(F.aria.on)\""}, ""][0]
	// A counted face carries its purpose as hidden text instead of aria-label:
	// the live count is part of the visible label, and an accessible name that
	// omits it fails label-content-name-mismatch.
	_srOff: [if F.aria != _|_ {"<span class=\"sr-only\">\(F.aria.off) — </span>"}, ""][0]
	_srOn: [if F.aria != _|_ {"<span class=\"sr-only\">\(F.aria.on) — </span>"}, ""][0]

	_probeFilter: [
		if F.retract == "stamp" {"\(F.on)=eq.\(F.value)&\(F.stamp)=is.null"},
		"\(F.on)=eq.\(F.value)",
	][0]

	_probe: [
		"<span class=\"\(F.probeClass)\" data-live=\"\(F.entity)\" data-filter=\"\(_probeFilter)\">",
		"  <template data-item><i></i></template>",
		"</span>",
	]
	_setRefusals: [
		"  <p class=\"invalid role-meta-sm\" hidden>\(F.set.words)</p>",
		"  <p class=\"store-error role-meta-sm\" hidden>\(F.set.words)</p>",
	]
	_unsetRefusals: [
		"  <p class=\"invalid role-meta-sm\" hidden>\(F.unset.words)</p>",
		"  <p class=\"store-error role-meta-sm\" hidden>\(F.unset.words)</p>",
	]

	_lines: [...string]
	if F.retract == "stamp" {
		_lines: list.Concat([_probe, [
			"<form class=\"\(F.set.class)\" data-form=\"\(F.set.id)\" data-entity=\"\(F.entity)\" data-action=\"upsert\">",
			"  <input type=\"hidden\" name=\"\(F.on)\" data-value=\"\(F.value)\">",
			"  <input type=\"hidden\" name=\"\(F.stamp)\" data-value=\"null\">",
			"  <button class=\"\(F.buttonClass) role-meta-sm\" type=\"submit\">\(_srOff)\(F.label.off)\(_countSpan)</button>",
		], _setRefusals, [
			"</form>",
			"<form class=\"\(F.unset.class)\" data-form=\"\(F.unset.id)\" data-entity=\"\(F.entity)\" data-action=\"upsert\">",
			"  <input type=\"hidden\" name=\"\(F.on)\" data-value=\"\(F.value)\">",
			"  <input type=\"hidden\" name=\"\(F.stamp)\" data-value=\"{now}\">",
			"  <button class=\"\(F.buttonClass) set role-meta-sm\" type=\"submit\">\(_srOn)\(F.label.on)\(_countSpan)</button>",
		], _unsetRefusals, [
			"</form>",
		]])
	}
	if F.retract == "delete" {
		_lines: list.Concat([_probe, [
			"<form class=\"\(F.set.class)\" data-form=\"\(F.set.id)\" data-entity=\"\(F.entity)\" data-action=\"create\">",
			"  <input type=\"hidden\" name=\"\(F.on)\" data-value=\"\(F.value)\">",
			"  <button class=\"\(F.buttonClass) role-meta-sm\" type=\"submit\"\(_ariaOff)>\(F.label.off)</button>",
		], _setRefusals, [
			"</form>",
			"<form class=\"\(F.unset.class)\" data-form=\"\(F.unset.id)\" data-entity=\"\(F.entity)\" data-action=\"delete\" data-filter=\"\(F.on)=eq.\(F.value)\">",
			"  <button class=\"\(F.buttonClass) set role-meta-sm\" type=\"submit\"\(_ariaOn)>\(F.label.on)</button>",
		], _unsetRefusals, [
			"</form>",
		]])
	}

	markup: F.indent + strings.Join(_lines, "\n"+F.indent)
}
