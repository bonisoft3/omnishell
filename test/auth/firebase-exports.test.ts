import { describe, test, expect } from "@test/harness"
import * as omnishell from "../../src/index"

describe("Firebase adapter exports", () => {
  test("FirebaseAdapter is exported", () => {
    expect(typeof omnishell.FirebaseAdapter).toBe("function")
  })

  test("exchangeFirebaseToken is exported", () => {
    expect(typeof omnishell.exchangeFirebaseToken).toBe("function")
  })
})
