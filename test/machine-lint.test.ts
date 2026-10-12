import { describe, expect, it } from "@test/harness"
import { machineLint, type Reach } from "../interpreter/lint.ts"
import { machineShape } from "../interpreter/fragment.js"

/** Where a chart's writes land, as check-markup hands it over from shell.yaml. */
const reach = (durabilities: Record<string, string> = {}, table = "row"): Reach => ({ table, durabilityOf: (t) => durabilities[t] })
const lint = (m: unknown, available: Set<string>, r: Reach = reach({ favorite: "live" })) => machineLint(m as Parameters<typeof machineLint>[0], available, r)

const FIB = {
  field: "phase",
  initial: "counting",
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
    expect(lint(FIB, MODULES)).toBe(null)
  })

  it("reports a guard naming no module", () => {
    const why = lint(FIB, new Set(["advance", "carry", "beat"]))
    expect(why).toContain('"pastLimit"')
    expect(why).toContain("no module")
  })

  it("reports a reference after-delay naming no module", () => {
    const why = lint(FIB, new Set(["pastLimit", "advance", "carry"]))
    expect(why).toContain('"beat"')
  })

  it("reports a raise no state handles — the undrawn arrow", () => {
    const m = JSON.parse(JSON.stringify(FIB))
    m.states.counting.on.click.raise = "bang"
    const why = lint(m, MODULES)
    expect(why).toContain('"bang"')
    expect(why).toContain("undrawn")
  })

  it("reports a transition key outside the subset", () => {
    const m = JSON.parse(JSON.stringify(FIB))
    m.states.done.on.click = { target: "counting", invoke: "nope" }
    const why = lint(m, MODULES)
    expect(why).toContain('"invoke"')
    expect(why).toContain("subset")
  })

  it("refuses chart context because the entity owns row defaults", () => {
    const m = JSON.parse(JSON.stringify(FIB))
    m.context = { current: 1 }
    const why = lint(m, MODULES)
    expect(why).toContain("context")
    expect(why).toContain("entity's field defaults")
  })
})

describe("machineLint params", () => {
  const withGuard = (guard: unknown) => ({
    field: "phase",
    initial: "a",
    states: { a: { on: { click: { guard, target: "b" } } }, b: {} },
  })
  it("a {type, params} guard resolves like a bare name", () => {
    expect(lint(withGuard({ type: "under", params: { limit: 2 } }), new Set(["under"]))).toBe(null)
    expect(lint(withGuard({ type: "under" }), new Set())).toContain('"under" name no module')
  })
  it("params must be literals — data, never structure", () => {
    expect(lint(withGuard({ type: "under", params: { limit: { nested: true } } }), new Set(["under"])))
      .toContain("non-literal")
  })
  it("an object in a value position must be exactly {type, params?}", () => {
    expect(lint(withGuard({ type: "under", extra: 1 }), new Set(["under"])))
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
    expect(lint(m, new Set())).toContain('"bump" name no module')
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
    expect(lint(nestedMachine, new Set(["myHandler"]))).toBe(null)
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
    expect(lint(nestedMachine, new Set())).toContain('"myHandler" name no module')
  })

  it("reports an unknown key in an effect", () => {
    const bad = JSON.parse(JSON.stringify(nestedMachine))
    bad.states.unfavorited.on.click.effect.bogus = "value"
    expect(lint(bad, new Set(["myHandler"]))).toContain('"bogus"')
  })

  it("reports an invalid effect op", () => {
    const bad = JSON.parse(JSON.stringify(nestedMachine))
    bad.states.unfavorited.on.click.effect.op = "not_an_op"
    expect(lint(bad, new Set(["myHandler"]))).toContain('effect op "not_an_op"')
  })

  it("a write to a live row is compensable: the chart draws refused, or is refused", () => {
    expect(lint(nestedMachine, new Set(["myHandler"]))).toBe(null)
    const deaf = JSON.parse(JSON.stringify(nestedMachine))
    delete deaf.states.favoriting.on.refused
    expect(lint(deaf, new Set(["myHandler"]))).toContain('effect on "favorite" is compensable (live)')
    // The same chart over a row this tab owns claims nothing of the server,
    // so it owes no arrow: the level is the entity's, never the chart's.
    expect(lint(deaf, new Set(["myHandler"]), reach({ favorite: "tab" }))).toBe(null)
  })

  it("an effect states no level of its own, and names no row the schema lacks", () => {
    const bad = JSON.parse(JSON.stringify(nestedMachine))
    bad.states.unfavorited.on.click.effect.level = "replicated"
    expect(lint(bad, new Set(["myHandler"]))).toContain('"level"')
    expect(lint(nestedMachine, new Set(["myHandler"]), reach({}))).toContain('effect on "favorite", which the emitted schema does not declare')
  })

  it("an effect naming no entity writes the region's row", () => {
    const own = JSON.parse(JSON.stringify(nestedMachine))
    delete own.states.unfavorited.on.click.effect.entity
    delete own.states.favoriting.on.refused
    expect(lint(own, new Set(["myHandler"]), reach({ article: "live" }, "article"))).toContain('effect on "article" is compensable (live)')
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
    expect(lint(advanced as never, new Set())).toBe(null)
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
    expect(lint(bad as never, new Set())).toContain('"invalidKey" — outside the #Action subset')
  })
})

