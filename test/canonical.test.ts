import { describe, expect, it } from "@test/harness"
import { createMachine, initialTransition, transition } from "npm:xstate@5.32.6"
import { canonical, guardNames, type Machine } from "./canonical.ts"

// The fib specimen from the machines doc — every v2 construct in one chart.
const FIB: Machine = {
  field: "phase",
  initial: "counting",
  context: { current: 1, previous: 0 },
  on: { refused: { target: "counting" } },
  states: {
    counting: {
      on: {
        click: { raise: "tick" },
        dblclick: { target: "playing", raise: "tick" },
        tick: [
          { guard: { type: "pastLimit", params: { limit: 40 } }, target: "done" },
          { assign: { current: "advance", previous: "carry" } },
        ],
      },
    },
    playing: {
      after: { "30": { raise: "tick" } },
      on: { dblclick: { target: "counting" } },
    },
    done: { on: { click: { target: "counting", assign: { current: 1, previous: 0 } } } },
  },
}

describe("canonical", () => {
  it("the faithful form is a config createMachine accepts, after and raise intact", () => {
    const cfg = canonical(FIB) as {
      initial: string
      context: unknown
      on: Record<string, { target?: string }[]>
      states: Record<string, { on?: Record<string, unknown>; after?: Record<string, unknown> }>
    }
    expect(cfg.initial).toBe("counting")
    expect(cfg.context).toEqual({ current: 1, previous: 0 })
    expect("field" in cfg).toBe(false)
    // Root-level targets address the root's children — the leading dot.
    expect(cfg.on.refused[0].target).toBe(".counting")
    expect(cfg.states.playing.after).toBeDefined()
    const click = (cfg.states.counting.on as Record<string, unknown[]>).click[0] as {
      actions: { type: string; params: unknown }[]
    }
    expect(click.actions).toEqual([{ type: "raise", params: { event: "tick" } }])
    createMachine(cfg as never) // accepts, or throws
  })

  it("the drive form lifts after to its trace key and strips raise", () => {
    const cfg = canonical(FIB, { drive: true }) as {
      states: Record<string, { on?: Record<string, unknown>; after?: unknown }>
    }
    expect(cfg.states.playing.after).toBeUndefined()
    expect((cfg.states.playing.on as Record<string, unknown>)["after:30"]).toBeDefined()
    const click = (cfg.states.counting.on as Record<string, unknown[]>).click[0] as {
      actions?: unknown
    }
    expect(click.actions).toBeUndefined()
  })

  it("v1 string shorthand canonicalizes to a target", () => {
    const cfg = canonical({
      field: "checked",
      initial: "false",
      states: { false: { on: { click: "true" } }, true: { on: { click: "false" } } },
    }) as { states: Record<string, { on: Record<string, { target: string }[]> }> }
    expect(cfg.states.false.on.click[0].target).toBe("true")
    createMachine(cfg as never)
  })

  it("guarded selection transitions the way the interpreter does", () => {
    let admit = false
    const m = createMachine(canonical(FIB, { drive: true }) as never).provide({
      guards: { pastLimit: () => admit },
      actions: { assign: () => {} },
    })
    let [st] = initialTransition(m)
    expect(String(st.value)).toBe("counting")
    ;[st] = transition(m, st, { type: "tick" }) // guard false → targetless second candidate
    expect(String(st.value)).toBe("counting")
    admit = true
    ;[st] = transition(m, st, { type: "tick" }) // guard true → done
    expect(String(st.value)).toBe("done")
    ;[st] = transition(m, st, { type: "refused" }) // root arrow
    expect(String(st.value)).toBe("counting")
  })

  it("guardNames collects string and object spellings once", () => {
    expect(guardNames(FIB)).toEqual(["pastLimit"])
  })
})

// The differential must be able to fail: a trace claiming a field value
// XState's own transition does not produce is a divergence, named per arrow.
import { differ } from "./walker.ts"

describe("differ", () => {
  it("accepts a faithful trace and rejects a forged one", () => {
    const good = [
      { state: "counting", key: "dblclick", index: 0, to: "playing" },
      { state: "playing", key: "dblclick", index: 0, to: "counting" },
    ]
    differ(FIB, good)
    const forged = [{ state: "counting", key: "dblclick", index: 0, to: "done" }]
    expect(() => differ(FIB, forged)).toThrow("XState landed on")
  })
})
