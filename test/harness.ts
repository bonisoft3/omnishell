// The unit-test harness, so no test file names a runtime.
//
// `describe`/`it`/`expect` come from deno's std, which implements the same BDD
// surface these tests were written against. `mock` is the one place the two
// runtimes disagree — bun returns a callable carrying `.mock.calls`, std's
// `spy` carries `.calls` with a different entry shape — so the compatible
// subset is re-wrapped once here rather than at each call site.
export {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
  it as test,
} from "jsr:@std/testing@1/bdd"
export { expect } from "jsr:@std/expect@1"

// bun:test's `mock(fn)`. `expect`'s call matchers recognise only its own mock,
// so this is @std/expect's `fn` under bun's name — not @std/testing's `spy`,
// which those matchers reject even though it records the same calls.
export { fn as mock } from "jsr:@std/expect@1"
