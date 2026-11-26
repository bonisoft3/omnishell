import { describe, expect, it } from "@test/harness"
import { conversionLinkLint } from "../interpreter/lint.ts"

const LINKS = ["github"]
const GOOD = '<a href="https://github.com/bonisoft3/pronto" target="_blank" rel="noopener" data-conversion="github">Get started</a>'

describe("conversionLinkLint", () => {
  it("passes a declared link that leaves for another site in a new tab, and says which names it used", () => {
    expect(conversionLinkLint(GOOD + GOOD + '<a href="https://example.com">x</a>', LINKS)).toEqual({ findings: [], named: ["github", "github"] })
  })

  it("refuses a name the app does not declare", () => {
    expect(conversionLinkLint(GOOD.replace('"github">', '"omnishell">'), LINKS).findings).toEqual([
      'data-conversion="omnishell" names no link conversion in meta.googleTag.conversions.links',
    ])
  })

  // The tag frame lives in the page: a link that navigates the page away
  // takes the frame down with the conversion it was just handed.
  it("refuses a conversion link that opens in this tab", () => {
    expect(conversionLinkLint(GOOD.replace(' target="_blank"', ""), LINKS).findings).toEqual([
      '<a data-conversion="github"> opens in this tab, whose tag frame goes before it can send the conversion: add target="_blank"',
    ])
  })

  it("refuses a conversion link to no other site, and one on something that is not a link", () => {
    expect(conversionLinkLint('<a data-route="home" target="_blank" data-conversion="github">x</a>', LINKS).findings).toEqual([
      '<a data-conversion="github"> leaves for no https:// address: a link conversion is a click to another site',
    ])
    expect(conversionLinkLint('<button type="button" data-conversion="github">x</button>', LINKS).findings).toEqual([
      '<button data-conversion="github"> is not a link: a link conversion is a click on <a href>',
    ])
  })

  it("reads no conversion out of a comment", () => {
    expect(conversionLinkLint('<!-- <a data-conversion="ghost"> -->', LINKS)).toEqual({ findings: [], named: [] })
  })
})
