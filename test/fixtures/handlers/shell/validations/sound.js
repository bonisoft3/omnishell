// A validation is a predicate over the state and the event.
(state, event) => (state.rows?.article ?? []).every((a) => a.author_id !== event.row?.user_id);
