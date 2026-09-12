// Ends in an object rather than a function: the source evaluates and the role
// refuses the value, which is the contract half of the check.
const reduce = (state, event) => ({ updates: [] });
({ reduce });
