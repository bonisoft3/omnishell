import { describe, expect, it } from "@test/harness"
import { kindedRegions, machineRegions, scanScreen, slotRegions } from "../interpreter/lint.ts"

const MACHINE = '{"field":"choice","initial":"a","states":{"a":{"on":{"click":"b"}},"b":{}}}'

// Commented-out markup renders nothing, so a scanner that still saw it would
// derive reads, vet machines, or claim slots for regions the DOM never
// mounts — and the four readers would disagree about what the screen says.
describe("comment stripping", () => {
  const commented = `
    <div>
      <!-- <section data-live="ghosts" data-filter="id=eq.ghost"
             data-machine='${MACHINE}' data-on-click="spook">
             <template data-item data-when="kind=eq.x"></template>
           </section> -->
      <p data-live="real" data-filter="id=eq.the"></p>
    </div>`

  it("keeps a commented-out region invisible to all four readers", () => {
    const { tables, handlers, filters } = scanScreen(commented)
    expect(tables).toEqual(["real"])
    expect(handlers).toEqual([])
    expect(filters).toEqual([{ table: "real", filter: "id=eq.the" }])
    expect(machineRegions(commented)).toEqual([])
    expect(slotRegions(commented)).toEqual([{ table: "real", filter: "id=eq.the" }])
    expect(kindedRegions(commented)).toEqual([])
  })
})

// The emission side (components/attr_check.cue) pins the escaped bytes; this
// side pins that the walker's decode hands the authored JSON back, so a
// label carrying the delimiting quote survives the whole trip.
describe("single-quoted attribute entities", () => {
  const esc = '{"field":"f","initial":"x","states":{"x":{}},"context":{"label":"d&#39;or &amp; friends"}}'
  const html = `<div data-live="prefs" data-filter="id=eq.the" data-machine='${esc}'></div>`

  it("decodes &#39; and &amp; back to the authored JSON", () => {
    const regions = machineRegions(html)
    expect(regions.length).toEqual(1)
    const parsed = JSON.parse(regions[0].machine)
    expect(parsed.context.label).toEqual("d'or & friends")
  })
})
