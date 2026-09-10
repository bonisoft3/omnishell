// Assertions for the lint battery, thrown rather than borrowed from a test
// runner.
//
// These modules are driven by whichever runner is holding the browser —
// @playwright/test in a consuming app, deno's own runner here — so importing
// `expect` for a value would bind the whole battery to one of them. A type-only
// import of `Page` is free; a value import is not. A throw is equivalent here:
// these are value assertions, never Playwright's auto-retrying locator
// matchers.

export function assertTruthy(value: unknown, message: string): void {
  if (!value) throw new Error(message)
}

export function assertIs<T>(actual: T, expected: T, message: string): void {
  if (!Object.is(actual, expected)) throw new Error(`${message}\n  expected ${expected}, got ${actual}`)
}

export function assertAtMost(actual: number, limit: number, message: string): void {
  if (!(actual <= limit)) throw new Error(`${message}\n  expected at most ${limit}, got ${actual}`)
}

export function assertAtLeast(actual: number, limit: number, message: string): void {
  if (!(actual >= limit)) throw new Error(`${message}\n  expected at least ${limit}, got ${actual}`)
}
