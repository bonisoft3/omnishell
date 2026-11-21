// The terminal's held clock as a host reads it: mecha's page cluster runs its
// schedules on heldTime, so one advance steps them with the screen's waits.
import { expect } from "@test/harness"

const locationBeforeImport = Object.getOwnPropertyDescriptor(globalThis, "location")
Object.defineProperty(globalThis, "location", { value: { search: "?clock=manual&epoch=2026-01-01T00:00:00Z" }, configurable: true, writable: true })
const { heldTime: held } = await import("../interpreter/screen.js")
if (locationBeforeImport) Object.defineProperty(globalThis, "location", locationBeforeImport)
else delete (globalThis as any).location
if (held === undefined) throw new Error("?clock=manual gives the page a held clock")
const heldTime = held

type Held = { advance: (ms: number) => number; due: () => { in: number; label: { kind: string } }[] }
const clock = () => (globalThis as unknown as { __prontoClock: Held }).__prontoClock
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

Deno.test("a host's wait is the terminal's: it starts at the epoch, is listed, and fires only when advanced past", async () => {
  const start = Date.parse("2026-01-01T00:00:00Z")
  expect(heldTime.now()).toBe(start)
  const fired: number[] = []
  heldTime.after(5000, () => fired.push(heldTime.now()))
  expect(clock().due()).toEqual([{ in: 5000, label: { kind: "cluster" } }])
  expect(clock().advance(4999)).toBe(1)
  await settle()
  expect(fired).toEqual([])
  expect(heldTime.now()).toBe(start + 4999)
  expect(clock().advance(1)).toBe(0)
  await settle()
  expect(fired).toEqual([start + 5000])
})

Deno.test("a cancelled host wait never comes due and the clock stops counting it", async () => {
  const fired: string[] = []
  const cancel = heldTime.after(10, () => fired.push("cancelled"))
  heldTime.after(20, () => fired.push("kept"))
  cancel()
  expect(clock().due().map((d) => d.in)).toEqual([20])
  expect(clock().advance(20)).toBe(0)
  await settle()
  expect(fired).toEqual(["kept"])
})
