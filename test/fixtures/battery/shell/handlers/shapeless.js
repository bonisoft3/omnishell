// A handler answering in a shape the store cannot apply: `updates` is the
// role's word for a list of writes, and "nudge" is not one of them.
() => ({ updates: [{ op: "nudge", entity: "note", id: "one" }] });
