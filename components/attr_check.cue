// Guards the attribute round-trip: a label carrying the delimiting quote or
// an ampersand must emit escaped, because the DOM's attribute parse and
// lint.ts's entity decode both reverse the escapes — unescaped, the quote
// ends the attribute early and the machine JSON truncates. Conflicting
// values fail any `cue vet` of this package.
package components

import "strings"

_escaped: (#attrEscape & {in: "d'or & friends"}).out
_escaped: "d&#39;or &amp; friends"

_marshalled: (#attrJSON & {in: {label: "d'or & friends"}}).out
_marshalled: "{\"label\":\"d&#39;or &amp; friends\"}"

// The picker threads its machine through #attrJSON, so an option label with
// an apostrophe reaches the emitted data-machine escaped, never raw.
_picker: #Picker & {
	collection: "prefs"
	label:      "Team"
	options: [
		{name: "a", label: "d'Artagnan"},
		{name: "b", label: "plain"},
	]
}
_pickerMachineAttr: (#attrJSON & {in: _picker.machine}).out
_pickerEscapes:     true
_pickerEscapes:     strings.Contains(_pickerMachineAttr, "d&#39;Artagnan") && !strings.Contains(_pickerMachineAttr, "d'")
