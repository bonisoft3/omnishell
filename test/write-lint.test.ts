import { describe, expect, it } from "@test/harness"
import { type Entity, machineRegions, machineWrites, writeLint, type Write } from "../interpreter/lint.ts"

const match = (extra: Partial<Entity> = {}): Entity => ({
  table: "match",
  durability: "device",
  fields: [
    { name: "id", type: "text", pk: true },
    { name: "variant", type: "text" },
    { name: "winner", type: "text" },
    { name: "hand_no", type: "int" },
    { name: "stake", type: "int" },
    { name: "archived", type: "bool" },
  ],
  uniques: [],
  ...extra,
})

const w = (...pairs: [string, string | number | boolean][]): Write[] =>
  pairs.map(([col, value]) => ({ col, value }))

describe("machineWrites", () => {
  it("collects the empty row, the context, the state column and every assign literal", () => {
    const machine = {
      field: "variant",
      initial: "mineiro",
      context: { winner: "" },
      states: {
        mineiro: { on: { "click@trigger-paulista": [{ target: "paulista", assign: { hand_no: "1", stake: "2" } }] } },
        paulista: {},
      },
    }
    // initial: and every target are writes of the machine's own field, and
    // expectState compares that column strictly on every step — a machine
    // spelling it one way in an arrow and another in an assign disowns half
    // its own rows, which is the defect this rule is for.
    expect(machineWrites(machine, '{"id":"","variant":"mineiro"}')).toEqual([
      { col: "id", value: "" },
      { col: "variant", value: "mineiro" },
      { col: "winner", value: "" },
      { col: "variant", value: "mineiro" },
      { col: "hand_no", value: "1" },
      { col: "stake", value: "2" },
      { col: "variant", value: "paulista" },
    ])
  })

  // apps/truco assigns {"type":"stake0"} to stake; the module returns "1" or
  // "2" and nothing in #Machine declares a return type. An undecidable write
  // must pass, not fail.
  it("a {type, params} assign is a module's return and carries no literal", () => {
    const machine = {
      field: "seats",
      initial: "1v1",
      states: { "1v1": { on: { click: { target: "2v2", assign: { stake: { type: "stake0" } } } } }, "2v2": {} },
    }
    // The state column is still collected — initial: and the target are
    // literals the machine states itself; only the assign is undecidable.
    expect(machineWrites(machine)).toEqual([
      { col: "seats", value: "1v1" },
      { col: "seats", value: "2v2" },
    ])
  })
})

describe("writeLint stays silent on the corpus's shapes", () => {
  // What a crud, live or offline row settles to is the server's answer, so
  // spelling is not a fact about the markup there. The narrowing is a scope
  // decision: only tab and device rows are read back from the same local
  // factory that wrote them.
  it("only the browser tiers are this rule's", () => {
    for (const durability of ["server", "live", "offline"]) {
      expect(writeLint(w(["hand_no", 1], ["hand_no", "1"]), match({ durability }))).toBe(null)
    }
  })

  it("one spelling per column passes, whichever spelling it is", () => {
    expect(writeLint(w(["hand_no", "1"], ["hand_no", "0"], ["stake", "2"]), match())).toBe(null)
    expect(writeLint(w(["hand_no", 1], ["hand_no", 0], ["stake", 2]), match())).toBe(null)
  })

  it("a bool's two spellings are each self-consistent", () => {
    expect(writeLint(w(["archived", true], ["archived", false]), match())).toBe(null)
    expect(writeLint(w(["archived", "true"], ["archived", "false"]), match())).toBe(null)
  })

  it("a text column written as a string is the only spelling it has", () => {
    expect(writeLint(w(["variant", "mineiro"], ["winner", ""], ["id", ""]), match())).toBe(null)
  })
})

// The shapes below are synthetic: no app has shipped a machine region that
// spells one column two ways, and the markup subset is young enough that none
// yet could. What makes them worth guarding is that #Transition.assign admits
// `hand_no: 1` beside another region's "1" with nothing to reconcile them, and
// that every consumer of a browser-tier row compares strictly.
describe("writeLint", () => {
  it("catches one column written in two spellings on a browser tier", () => {
    const why = writeLint(w(["hand_no", "1"], ["hand_no", 1]), match())
    expect(why).toContain('"hand_no"')
    expect(why).toContain('2 spellings ("1", 1)')
    expect(why).toContain("spell every write of a column the same way")
  })

  it("catches it on a tab tier as well as a device tier", () => {
    expect(writeLint(w(["stake", 2], ["stake", "2"]), match({ durability: "tab" }))).toContain('"stake"')
  })

  // Two spellings that are both non-string are the same defect: a bool
  // written as false in one region and 0 in another loses every row to a
  // strict compare against either. The predicate is how many spellings the
  // column has, never whether a string is among them.
  it("catches two spellings neither of which is a string", () => {
    expect(writeLint(w(["archived", false], ["archived", 0]), match())).toContain("2 spellings")
    expect(writeLint(w(["hand_no", true], ["hand_no", 1]), match())).toContain("2 spellings")
  })

  // int, bigint and bool are the types whose one value has a second JS
  // spelling; a text column has exactly one, so a number written into it is
  // not a spelling but a second type.
  it("refuses a non-string written into a column with one spelling", () => {
    const why = writeLint(w(["variant", 2]), match())
    expect(why).toContain('"variant" is text')
    expect(why).toContain("write it as a string")
  })

  it("refuses a write naming no field of the entity", () => {
    expect(writeLint(w(["ghost", "x"]), match())).toContain('not a field of "match"')
  })
})

describe("machineRegions anchors a machine to its table", () => {
  it("carries the region's data-live", () => {
    const machine = '{"field":"variant","initial":"mineiro","states":{"mineiro":{}}}'
    expect(machineRegions(`<div data-live="match" data-filter="status=eq.playing" data-machine='${machine}'></div>`))
      .toEqual([{ table: "match", machine, parallel: [machine], emptyRow: undefined, filter: "status=eq.playing" }])
  })

  it("makes a list of charts one entry each, carrying the group they share a row with", () => {
    // Every rule below is a chart's; only disjointness is the group's, so the
    // group rides along rather than the list staying whole.
    const a = '{"field":"open","initial":"none","states":{"none":{}}}'
    const b = '{"field":"caret","initial":"one","states":{"one":{}}}'
    const parallel = [a, b]
    expect(machineRegions(`<div data-live="match" data-machine='[${a},${b}]'></div>`)).toEqual([
      { table: "match", machine: a, parallel, emptyRow: undefined, filter: undefined },
      { table: "match", machine: b, parallel, emptyRow: undefined, filter: undefined },
    ])
  })

  // The interpreter reads a machine from region.dataset and from nowhere
  // else, so a data-machine off a region binds nothing at all.
  it("a machine with no region is a precondition error", () => {
    expect(() => machineRegions(`<div data-machine='{"field":"f","initial":"a","states":{"a":{}}}'></div>`)).toThrow()
  })
})
