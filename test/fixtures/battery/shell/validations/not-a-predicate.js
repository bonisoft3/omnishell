// A validation that answers an object. Both seats that run one — the store
// before an optimistic write, plv8 before commit — read the answer as a
// refusal or a pass, and an object is truthy in one and neither in the other.
(state, event) => ({ ok: (state.rows.note ?? []).length === 0 });
