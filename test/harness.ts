import "npm:fake-indexeddb@6.2.5/auto"

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

// @std/expect's call matchers require its own fn.
export { fn as mock } from "jsr:@std/expect@1"

