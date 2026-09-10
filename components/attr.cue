// Values destined for single-quoted HTML attributes. A `'` inside the value
// would end the attribute early, and both readers of the value — the DOM's
// attribute parse and lint.ts's entity decode — reverse `&amp;` and `&#39;`,
// so `&` must be escaped too or entity-looking text corrupts on the way
// back. Every JSON interpolated into `data-*='…'` goes through one of these.
package components

import (
	"encoding/json"
	"strings"
)

#attrEscape: {
	in:  string
	out: strings.Replace(strings.Replace(in, "&", "&amp;", -1), "'", "&#39;", -1)
}

#attrJSON: {
	in:  _
	out: (#attrEscape & {"in": json.Marshal(in)}).out
}
