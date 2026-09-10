import { describe, expect, it } from "@test/harness"
import { unwitnessedControls } from "../interpreter/lint.ts"

// The silent cases come first, because a control's wiring is invisible in its
// own tag and a predicate narrower than the seams the interpreter actually
// offers condemns working screens — and this rule stops an app generating.
// Most of the shapes below are markup an app ships today, named where they
// are; the rest are seams the grammar sanctions that no app has reached for
// yet, which is exactly why a corpus scan cannot stand in for them.
describe("unwitnessedControls stays silent on wired controls", () => {
  it("a data-on-click inside a region", () => {
    expect(
      unwitnessedControls(
        '<div class="actions" data-live="round" data-filter="current=eq.yes">' +
          '<button type="button" class="act" id="btn-truco" data-on-click="table">TRUCO!</button></div>',
      ),
    ).toEqual([])
  })

  // apps/omnishell-shadcn-ui/shell/screens/switch.html: the button IS the
  // region and IS the machine host — the interpreter attaches the click
  // listener to this very element, so cover has to be ancestor-or-self.
  it("a button that is itself the region and the machine host", () => {
    const machine =
      '{"field":"checked","initial":"false","states":{"false":{"on":{"click":"true"}},"true":{"on":{"click":"false"}}}}'
    expect(
      unwitnessedControls(
        `<button type="button" role="switch" class="switch" data-live="switch_demo" data-filter="id=eq.the" ` +
          `data-machine='${machine}'>go</button>`,
      ),
    ).toEqual([])
  })

  // apps/truco/shell/screens/arena.html: the picker's transitions key on
  // click@trigger-mineiro, and the opener is a native command invoker — the
  // platform toggles the popover, so nothing in the terminal has to reach it.
  it("a trigger named by the machine, and a native invoker beside it", () => {
    const machine = '{"field":"variant","initial":"mineiro","states":' +
      '{"paulista":{"on":{"click@trigger-mineiro":[{"target":"mineiro"}]}},' +
      '"mineiro":{"on":{"click@trigger-paulista":[{"target":"paulista"}]}}}}'
    expect(
      unwitnessedControls(
        `<div class="picker" data-live="match" data-filter="status=eq.playing" data-machine='${machine}'>` +
          '<button type="button" id="picker-open-variant" commandfor="picker-pop-variant" ' +
          'command="toggle-popover">Variante</button>' +
          '<ul popover><li><button type="button" id="trigger-paulista">Paulista</button></li>' +
          '<li><button type="button" id="trigger-mineiro">Mineiro</button></li></ul></div>',
      ),
    ).toEqual([])
  })

  // screen.js binds data-on-* on every element bindTree walks, the region
  // itself included, and a click bubbles to it — so cover for this seam is
  // ancestor-or-self exactly as it is for a form and for a machine.
  it("a data-on-* on an ancestor inside the region", () => {
    expect(
      unwitnessedControls(
        '<div data-live="thing" data-on-click="go"><button type="button">Go</button></div>',
      ),
    ).toEqual([])
    expect(
      unwitnessedControls(
        '<div data-live="thing"><span data-on-click="go"><button type="button">Go</button></span></div>',
      ),
    ).toEqual([])
  })

  // A named item template is screen-scoped: withTemplates collects it from
  // anywhere in the screen and hydrateRegion stamps it into the region that
  // names it, so its controls are bound by that region and not by whatever
  // the template happens to sit inside.
  it("a control in a named template the region stamps", () => {
    const html = '<template data-item data-name="card"><li>' +
      '<button type="button" data-on-click="pin">pin</button></li></template>' +
      '<ul data-live="note" data-template="card"></ul>'
    expect(unwitnessedControls(html)).toEqual([])
  })

  it("a named template the region's machine answers for", () => {
    const machine = '{"field":"phase","initial":"a","states":{"a":{"on":{"click":"b"}},"b":{}}}'
    const html = '<template data-item data-name="card"><li><button type="button">go</button></li></template>' +
      `<ul data-live="note" data-template="card" data-machine='${machine}'></ul>`
    expect(unwitnessedControls(html)).toEqual([])
  })

  // A [data-widget] is nothing the interpreter knows: a button under one is
  // as bare as one anywhere.
  it("a widget's parts are not a seam", () => {
    expect(
      unwitnessedControls(
        '<span class="daypick" data-widget="date-picker" data-part="root">' +
          '<button type="button" data-part="trigger" aria-label="Choose a day">x</button></span>',
      ),
    ).toHaveLength(1)
  })

  // A form[data-action] outside every region is wired at screen level: it
  // addresses its row through a hidden id field.
  it("a submit button in a form outside every region", () => {
    expect(
      unwitnessedControls(
        '<form data-action="delete" data-entity="article"><input type="hidden" name="id" data-value="{id}">' +
          "<button>Delete</button></form>",
      ),
    ).toEqual([])
  })

  it("a submit input in a form", () => {
    expect(unwitnessedControls('<form data-action="create"><input type="submit" value="Post"></form>')).toEqual([])
  })

  // A type="button" submits nothing however deep in a form it sits, so a
  // machine's click is the only seam that can reach it.
  it("a type=button inside a form is not wired by the form", () => {
    expect(
      unwitnessedControls(
        '<form data-action="create"><div class="picker">' +
          '<button type="button" aria-label="show labels">v</button></div></form>',
      ),
    ).toHaveLength(1)
  })

  it("a control stamped from an item template belongs to its region", () => {
    expect(
      unwitnessedControls(
        '<ul data-live="note"><template data-item><li>' +
          '<button type="button" data-on-click="pin">pin</button></li></template></ul>',
      ),
    ).toEqual([])
  })

  // A summary, a select, a textarea and a bare checkbox are legitimately
  // JS-free markup here — apps/realworld/shell/screens/article.html opens a
  // native <details>, and xpense's veil-box toggle is pure :checked CSS.
  it("markup that is an affordance, not a control", () => {
    expect(
      unwitnessedControls(
        '<details><summary class="act armer">Delete…</summary></details>' +
          '<label class="veil-toggle"><input type="checkbox" class="veil-box" aria-label="Esconder valores"></label>' +
          "<select><option>a</option></select><textarea></textarea>",
      ),
    ).toEqual([])
  })

  // A popover opener and a command invoker are the platform's own wiring:
  // apps/truco and apps/omnishell-shadcn-ui open every picker this way, and
  // no JS of any tier is involved.
  it("a native invoker", () => {
    expect(unwitnessedControls('<button popovertarget="pop">open</button>')).toEqual([])
    expect(unwitnessedControls('<button commandfor="pop" command="toggle-popover">open</button>')).toEqual([])
  })

  it("markup inside comments, style and script blocks is not scanned", () => {
    expect(
      unwitnessedControls(
        '<!-- <button id="ghost">theatre</button> --><style>button{}</style>' +
          '<script>const s = "<button id=\'in-a-string\'>x</button>";</script>',
      ),
    ).toEqual([])
  })
})

describe("unwitnessedControls", () => {
  // The shipped bug (truco, "Começar partida"): btn-start sat in a .nomatch
  // div outside every region, with no data-on-*, no form and no machine. The
  // handler module still loaded and the click still did nothing, so neither
  // the loader nor a test noticed — only the player did.
  it("catches a control outside every region, form and widget", () => {
    const found = unwitnessedControls(
      '<div class="nomatch" id="nomatch"><p>O baralho está cortado.</p>' +
        '<button type="button" class="act" id="btn-start">Começar partida</button></div>',
    )
    expect(found.length).toBe(1)
    expect(found[0]).toContain('<button id="btn-start">')
    expect(found[0]).toContain("wired to nothing")
  })

  // The type is what decides whether a form reaches it: only a submit-capable
  // control fires the submit listener, however deep in the form it sits.
  it("a type=button inside a form submits nothing", () => {
    expect(unwitnessedControls('<form data-action="create"><button type="button">nope</button></form>').length).toBe(1)
    expect(unwitnessedControls('<form data-action="create"><button type="reset">nope</button></form>').length).toBe(1)
    expect(unwitnessedControls('<form data-action="create"><button type="submit">yes</button></form>')).toEqual([])
  })

  // The machine is a region's, and only a region's: bindTree and the machine
  // listener both start from a [data-live] element.
  it("a data-on-* outside every region binds nothing", () => {
    expect(unwitnessedControls('<div><button data-on-click="table">go</button></div>').length).toBe(1)
  })

  it("a machine handling no click leaves its buttons unreached", () => {
    const machine = '{"field":"phase","initial":"a","states":{"a":{"on":{"tick":"b"}},"b":{}}}'
    expect(
      unwitnessedControls(
        `<div data-live="m" data-filter="id=eq.the" data-machine='${machine}'>` +
          '<button type="button" id="btn">go</button></div>',
      ).length,
    ).toBe(1)
  })

  // candidatesFor tries `click@<id>` before `click`, with the id of the
  // pressed element's nearest ancestor-or-self carrying one. A machine whose
  // every click key names an id drops a click from anywhere else, so being
  // inside the region is not being reached by it.
  it("a machine keyed only by dom ids reaches only those ids", () => {
    const machine = '{"field":"variant","initial":"mineiro","states":' +
      '{"paulista":{"on":{"click@trigger-mineiro":[{"target":"mineiro"}]}},' +
      '"mineiro":{"on":{"click@trigger-paulista":[{"target":"paulista"}]}}}}'
    const found = unwitnessedControls(
      `<div class="picker" data-live="match" data-machine='${machine}'>` +
        '<button type="button" id="btn-start">Começar partida</button>' +
        '<button type="button" id="trigger-paulista">Paulista</button></div>',
    )
    expect(found.length).toBe(1)
    expect(found[0]).toContain('<button id="btn-start">')
  })

  it("one unkeyed click key opens the region to every control under it", () => {
    const machine = '{"field":"p","initial":"a","states":{"a":{"on":{"click@one":"b","click":"b"}},"b":{}}}'
    expect(
      unwitnessedControls(
        `<div data-live="m" data-machine='${machine}'><button type="button" id="two">go</button></div>`,
      ),
    ).toEqual([])
  })

  // A machine the rule cannot read is machineLint's finding, and derive takes
  // that finding first. Answering "no click, then" here would report a
  // correctly wired button as theatre and hide the real message.
  it("a data-machine that is not JSON is a precondition, not a verdict", () => {
    expect(() => unwitnessedControls('<div data-live="m" data-machine=\'{"field":,}\'><button>go</button></div>'))
      .toThrow()
  })

  it("names the control by class when it carries no id", () => {
    expect(unwitnessedControls('<button class="act ghost">go</button>')[0]).toContain('<button class="act ghost">')
  })
})
