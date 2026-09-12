// The one module this fixture app ships: what makes the dangling-reference
// rule a real question, since a chart naming `spun` resolves and a chart
// naming anything else does not. Never loaded here — check-markup reads the
// directory for the names and check-handlers is the rung that runs the source.
(state, event) => ({ updates: [] });
