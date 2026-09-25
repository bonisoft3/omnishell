import { describe, expect, it } from "@test/harness"
import { machineLint } from "../interpreter/lint.ts"
import { machineShape } from "../interpreter/fragment.js"

const FIB = {
  field: "phase",
  initial: "counting",
  context: { current: 1, previous: 0 },
  on: { refused: { target: "counting" } },
  states: {
    counting: {
      on: {
        click: { raise: "tick" },
        tick: [
          { guard: "pastLimit", target: "done" },
          { assign: { current: "advance", previous: "carry" } },
        ],
      },
    },
    playing: { after: { beat: { raise: "tick" } }, on: { tick: { target: "playing" } } },
    done: { on: { click: "counting" } },
  },
}
const MODULES = new Set(["pastLimit", "advance", "carry", "beat"])

describe("machineShape", () => {
  it("collects references, dual-position strings, raises, handled keys and arrows", () => {
    const s = machineShape(FIB)
    expect(s.refs.sort()).toEqual(["beat", "pastLimit"])
    expect(s.assignStrings.sort()).toEqual(["advance", "carry"])
    expect(s.raises).toEqual(["tick"])
    expect(s.handled.sort()).toEqual(["click", "refused", "tick"])
    // One arrow per (state, key, candidate): root refused, counting's three,
    // playing's after and tick, done's click.
    expect(s.arrows.length).toBe(7)
  })
})

describe("machineLint", () => {
  it("passes the fib machine against its modules", () => {
    expect(machineLint(FIB, MODULES)).toBe(null)
  })

  it("reports a guard naming no module", () => {
    const why = machineLint(FIB, new Set(["advance", "carry", "beat"]))
    expect(why).toContain('"pastLimit"')
    expect(why).toContain("no module")
  })

  it("reports a reference after-delay naming no module", () => {
    const why = machineLint(FIB, new Set(["pastLimit", "advance", "carry"]))
    expect(why).toContain('"beat"')
  })

  it("reports a raise no state handles — the undrawn arrow", () => {
    const m = JSON.parse(JSON.stringify(FIB))
    m.states.counting.on.click.raise = "bang"
    const why = machineLint(m, MODULES)
    expect(why).toContain('"bang"')
    expect(why).toContain("undrawn")
  })

  it("reports a transition key outside the subset", () => {
    const m = JSON.parse(JSON.stringify(FIB))
    m.states.done.on.click = { target: "counting", invoke: "nope" }
    const why = machineLint(m, MODULES)
    expect(why).toContain('"invoke"')
    expect(why).toContain("subset")
  })

  it("reports context carrying the machine's own field", () => {
    const m = JSON.parse(JSON.stringify(FIB))
    m.context.phase = "counting"
    const why = machineLint(m, MODULES)
    expect(why).toContain('"phase"')
    expect(why).toContain("one writer")
  })
})

describe("machineLint params", () => {
  const withGuard = (guard: unknown) => ({
    field: "phase",
    initial: "a",
    states: { a: { on: { click: { guard, target: "b" } } }, b: {} },
  })
  it("a {type, params} guard resolves like a bare name", () => {
    expect(machineLint(withGuard({ type: "under", params: { limit: 2 } }), new Set(["under"]))).toBe(null)
    expect(machineLint(withGuard({ type: "under" }), new Set())).toContain('"under" name no module')
  })
  it("params must be literals — data, never structure", () => {
    expect(machineLint(withGuard({ type: "under", params: { limit: { nested: true } } }), new Set(["under"])))
      .toContain("non-literal")
  })
  it("an object in a value position must be exactly {type, params?}", () => {
    expect(machineLint(withGuard({ type: "under", extra: 1 }), new Set(["under"])))
      .toContain("not {type, params?}")
  })
  it("a {type, params} assign value joins refs, not dual-position strings", () => {
    const m = {
      field: "phase",
      initial: "a",
      states: { a: { on: { click: { assign: { n: { type: "bump", params: { by: 3 } } } } } } },
    }
    const s = machineShape(m)
    expect(s.refs).toEqual(["bump"])
    expect(machineLint(m, new Set())).toContain('"bump" name no module')
  })
})

describe("a chart says whether it wants the pointer measured", () => {
  const chart = (assign: Record<string, unknown>) => ({
    field: "open",
    initial: "false",
    states: {
      "false": { on: { "contextmenu@t": [{ target: "true", assign }] } },
      "true": {},
    },
  })

  it("reports no pointer for a chart that reads none", () => {
    // The invariant this guards is a cost, not a result: reading the pointer
    // measures the affordance's box, which is a synchronous layout, and a click
    // carries clientX in EVERY browser. Measuring unconditionally would put a
    // reflow in front of every gesture in every app for the sake of the one
    // screen that wants a point.
    expect(machineShape(chart({})).pointer).toBe(false)
    expect(machineShape(chart({ v: { type: "event", params: { field: "value" } } })).pointer).toBe(false)
  })

  it("reports one for either axis", () => {
    for (const field of ["pointerX", "pointerY"]) {
      expect(machineShape(chart({ v: { type: "event", params: { field } } })).pointer).toBe(true)
    }
  })
})

describe("machineLint effects and nested states", () => {
  const nestedMachine = {
    field: "phase",
    initial: "unfavorited",
    states: {
      unfavorited: {
        on: {
          click: {
            target: "favoriting",
            effect: {
              level: 2,
              op: "upsert",
              entity: "favorite",
              token: "tok-1",
              values: { article_id: "a1", custom: { type: "myHandler", params: { foo: "bar" } } },
            },
          },
        },
      },
      favoriting: {
        initial: "inflight",
        on: {
          sync_ack: { target: "favorited" },
          refused: { target: "unfavorited" },
        },
        states: {
          inflight: {
            after: { 50: "delayed" },
          },
          delayed: {},
        },
      },
      favorited: {},
    },
  }

  it("passes a machine with nested states and valid effect", () => {
    expect(machineLint(nestedMachine, new Set(["myHandler"]))).toBe(null)
  })

  it("machineShape extracts handler refs from effect values and walks nested states", () => {
    const shape = machineShape(nestedMachine)
    expect(shape.refs).toContain("myHandler")
    expect(shape.handled).toContain("click")
    expect(shape.handled).toContain("sync_ack")
    expect(shape.handled).toContain("refused")
    expect(shape.arrows.some((a) => a.state === "favoriting.inflight")).toBe(true)
  })

  it("reports missing handler in effect values", () => {
    expect(machineLint(nestedMachine, new Set())).toContain('"myHandler" name no module')
  })

  it("reports an unknown key in an effect", () => {
    const bad = JSON.parse(JSON.stringify(nestedMachine))
    bad.states.unfavorited.on.click.effect.bogus = "value"
    expect(machineLint(bad, new Set(["myHandler"]))).toContain('"bogus"')
  })

  it("reports an invalid effect op", () => {
    const bad = JSON.parse(JSON.stringify(nestedMachine))
    bad.states.unfavorited.on.click.effect.op = "not_an_op"
    expect(machineLint(bad, new Set(["myHandler"]))).toContain('effect op "not_an_op"')
  })

  it("passes with descriptive effect level and verifies compensable effect requires refused", () => {
    const descMachine = JSON.parse(JSON.stringify(nestedMachine))
    descMachine.states.unfavorited.on.click.effect.level = "compensable"
    expect(machineLint(descMachine, new Set(["myHandler"]))).toBe(null)

    // Missing refused transition fails loudly
    delete descMachine.states.favoriting.on.refused
    expect(machineLint(descMachine, new Set(["myHandler"]))).toContain(
      'compensable effect on "favorite" requires "refused" transition',
    )
  })

  it("reports an invalid effect level", () => {
    const bad = JSON.parse(JSON.stringify(nestedMachine))
    bad.states.unfavorited.on.click.effect.level = "magic"
    expect(machineLint(bad, new Set(["myHandler"]))).toContain('effect level "magic" is not in')
  })

  it("passes a machine with entry, exit, onDone, always, and parallel states", () => {
    const advanced = {
      type: "parallel",
      states: {
        r1: {
          field: "f1",
          initial: "s1",
          entry: { assign: { a: 1 } },
          exit: { assign: { a: 0 } },
          states: {
            s1: {
              always: { target: "s2" },
            },
            s2: {
              type: "final",
            },
          },
          onDone: { target: "s1" },
        },
      },
    }
    expect(machineLint(advanced as never, new Set())).toBe(null)
  })

  it("reports an invalid key inside entry action", () => {
    const bad = {
      field: "phase",
      initial: "idle",
      states: {
        idle: {
          entry: { invalidKey: true },
        },
      },
    }
    expect(machineLint(bad as never, new Set())).toContain('"invalidKey" — outside the #Action subset')
  })
})

