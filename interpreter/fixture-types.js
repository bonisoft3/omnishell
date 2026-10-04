// The type table a store is served where the test is about the terminal
// and not about the types: a smoke, or an ordering check. It is an input
// and not a definition — what canonical IS belongs to the program (pronto's
// types.cue), and what these prove is that the interpreter applies the
// table it is handed, ordering a txid by value rather than as text. The
// agreement between a real table and the client's transformations is held by
// the suite that has both (plugins/pronto/type-agreement.test.ts).
//
// It states no spelling: a pattern here would be a canonical form nobody
// emitted, and what these callers need from an entry is which JSON kind a
// value is and how two of them compare. It lives beside the interpreter
// because the image carries no app to read a real one from.
export const FIXTURE_TYPES = {
  types: {
    string: { pg: "text", column: "plain", subset: true, base: ["text"], json: "string", order: "text", beyond: [] },
    int32: { pg: "integer", column: "plain", subset: true, base: ["int4"], json: "number", min: -2147483648, max: 2147483647, order: "number", beyond: [] },
    int64: { pg: "bigint", column: "domain", subset: false, sql: "portable_int64", base: ["int8"], json: "string", order: "integer", beyond: [] },
    timestamp: { pg: "timestamptz", column: "domain", subset: false, sql: "portable_timestamp", base: ["timestamptz"], json: "string", order: "text", beyond: [] },
    date: { pg: "date", column: "checked", subset: true, base: ["date"], json: "string", order: "text", beyond: [] },
    duration: { pg: "interval", column: "domain", subset: false, sql: "portable_duration", base: ["interval"], json: "string", order: "duration", beyond: [] },
    decimal: { pg: "numeric", column: "domain", subset: false, base: ["numeric"], json: "string", order: "decimal", beyond: ["decimal-profile"] },
    double: { pg: "double precision", column: "checked", subset: true, base: ["float8"], json: "number", order: "number", beyond: [] },
    uuid: { pg: "uuid", column: "plain", subset: true, base: ["uuid"], json: "string", order: "text", beyond: [] },
  },
  aliases: { text: "string", int: "int32", bigint: "int64", timestamptz: "timestamp", tsvector: "string" },
};

export const FIXTURE_CARRIERS = FIXTURE_TYPES;
