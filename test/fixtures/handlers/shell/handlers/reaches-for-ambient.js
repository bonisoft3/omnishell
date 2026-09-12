// Reaches for ambient authority the compartment withholds, ABOVE the
// completion expression. The order is the whole point: the reach runs while
// the module is still being evaluated, so only a host that withholds `fetch`
// can reject this file. Were the reach the last expression instead, its value
// — the string "fetch" — would fail the handler role's "ends in a function"
// contract on any host at all, and the fixture would report a finding whether
// or not it had been caged.
//
// So: caged, the const throws and the module never yields a value. Uncaged,
// `fetch` is the host's, the arrow below is the completion value, the role is
// satisfied and NO finding is produced — which is how the self-test's count
// tells a real compartment from host globals.
const probe = fetch.name;
(state, event) => ({ updates: [] });
