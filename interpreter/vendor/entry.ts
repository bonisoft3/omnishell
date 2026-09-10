// Bundle entry: the platform data-plane driver the interpreter's cluster
// store rides (built by the `bundle:mecha-client` script; the output is the
// checked-in vendor/mecha-client.js static).
export { createMechaClient } from "../../../../libraries/mecha/packages/client/src/mecha-client.ts"
// The incremental-view-maintenance surface, taken from the client's own
// exports so this entry never reaches past it into @tanstack/db.
export {
	and,
	BasicIndex,
	BTreeIndex,
	createLiveQueryCollection,
	eq,
	gt,
	gte,
	inArray,
	isNull,
	liveQueryCollectionOptions,
	lt,
	lte,
	not,
	or,
} from "../../../../libraries/mecha/packages/client/src/index.ts"
