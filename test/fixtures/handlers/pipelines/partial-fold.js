// Four names, one of which is not a function: the module evaluates and the
// fold role refuses the shape, naming all four rather than the one that failed.

export const empty = (id) => harden({ id, total: 0 });

export const step = (acc) => acc;

export const combine = (a) => a;

export const result = 7;
