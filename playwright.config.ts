// The browser tier: the suites that drive the interpreter in a real engine and
// serve every file themselves, so none of them needs a cluster.
//
// They are here because a DOM shim answers the wrong thing about them —
// linkedom has no moveBefore and no activeElement, so it could only ever check
// which method was called, and which method was called is not what a reader
// notices. Every other .pw.ts in this directory runs under `deno test` against
// a cluster (see package.json test:pw) and is deliberately not collected here.
import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./playwright-tests",
  testMatch: /(region-reorder|roving-tabstop|focus-target)\.pw\.ts$/,
})
