import { describe, expect, it } from "@test/harness"
import { templateArity } from "../interpreter/lint.ts"

describe("templateArity stays silent on stampable templates", () => {
  it("one element child", () => {
    expect(templateArity('<ul data-live="note"><template data-item><li>x</li></template></ul>')).toEqual([])
  })

  // The emitter indents its output, and every app's templates carry text
  // between the tags. Text is not an item, so it must not count.
  it("text and comments around the one element", () => {
    expect(
      templateArity(
        '<ul data-live="note">\n  <template data-item>\n    <!-- one item -->\n    <li>x</li>\n  </template>\n</ul>',
      ),
    ).toEqual([])
  })

  // apps/realworld's cover, and every avatar in the corpus: a
  // void element is a whole item.
  it("a single void element", () => {
    expect(templateArity('<div data-live="a"><template data-item><img src="{url}" alt=""></template></div>')).toEqual([])
  })

  it("a self-closing single element", () => {
    expect(templateArity('<div data-live="a"><template data-item><img src="{url}" /></template></div>')).toEqual([])
  })

  it("a nested region's template is counted on its own, not as the outer's child", () => {
    expect(
      templateArity(
        '<ul data-live="article"><template data-item><li>' +
          '<ol data-live="comment"><template data-item><li>y</li></template></ol>' +
          "</li></template></ul>",
      ),
    ).toEqual([])
  })

  it("a template without data-item is invisible end to end", () => {
    expect(templateArity("<template><b>a</b><i>b</i></template>")).toEqual([])
  })

  it("markup inside comments and style blocks is not scanned", () => {
    expect(
      templateArity('<!-- <template data-item><b>a</b><i>b</i></template> --><style>template{}</style>'),
    ).toEqual([])
  })
})

describe("templateArity", () => {
  // The shipped bug (realworld, "the cover is one figure"): the cover
  // template held img + figcaption as two children. Stamping clones
  // content.firstElementChild, so the credit vanished the moment a real
  // article row hydrated — and the interpreter's own arity guard fires only
  // at hydrate, on a screen with a cover, in a browser.
  it("catches a two-child item template", () => {
    const found = templateArity(
      '<figure class="cover" data-live="article" data-filter="id=eq.{id}&amp;cover_url=not.is.null">' +
        '<template data-item>' +
        '<img class="cover-img" src="{cover_url}" alt="" width="1600" height="800">' +
        '<figcaption class="cover-credit" data-text="{cover_credit}"></figcaption>' +
        "</template></figure>",
    )
    expect(found.length).toBe(1)
    expect(found[0]).toContain("holds 2 elements (img, figcaption)")
    expect(found[0]).toContain("an item is exactly one")
  })

  it("catches an empty item template", () => {
    expect(templateArity('<ul data-live="note"><template data-item></template></ul>')[0])
      .toContain("holds no element")
  })

  // A named template is resolved through the same clone, so it answers for
  // its arity wherever it is declared.
  it("names the template it found", () => {
    expect(templateArity('<template data-item data-name="pinned"><b>a</b><i>b</i></template>')[0])
      .toContain('template[data-item][data-name="pinned"]')
  })

  it("reports every offending template in the screen", () => {
    expect(
      templateArity(
        '<ul data-live="a"><template data-item><b>x</b><i>y</i></template></ul>' +
          '<ul data-live="b"><template data-item></template></ul>',
      ).length,
    ).toBe(2)
  })

  // Anonymous templates have no name to be told apart by, and a screen may
  // carry several; the region and the data-when are what the reader needs to
  // find the one that is wrong.
  it("locates an anonymous template by its region and its data-when", () => {
    const found = templateArity(
      '<ul data-live="note"><template data-item data-when="kind=eq.poll"><b>x</b><i>y</i></template></ul>',
    )
    expect(found[0]).toContain('template[data-item][data-when="kind=eq.poll"] in [data-live="note"]')
  })

  // HTML lets a following sibling stand in for these end tags, and the DOM
  // this template stamps from has two children whatever the source says.
  it("counts the children an implied end tag makes siblings", () => {
    expect(templateArity('<ul data-live="a"><template data-item><li>x<li>y</template></ul>')[0])
      .toContain("holds 2 elements (li, li)")
    expect(templateArity('<div data-live="a"><template data-item><p>x<p>y</template></div>')[0])
      .toContain("holds 2 elements (p, p)")
    expect(templateArity('<ul data-live="a"><template data-item><li>x</template></ul>')).toEqual([])
  })
})
