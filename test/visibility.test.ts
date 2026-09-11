// What a screen shows, and how many gestures away, read from its stylesheets
// and the tree alone. Each case is a small screen: markup, the css it ships,
// and the depth each control is judged at.
import { describe, expect, it } from "@test/harness";
import { parseHTML } from "linkedom";
import type { Route } from "./screen-harness.ts";
import { atoms, cssRules, routeSheet, specificity, type VEl, visibility } from "./visibility.ts";

type Doc = {
  getElementById(id: string): VEl | null;
  querySelector(selector: string): VEl | null;
  querySelectorAll(selector: string): Iterable<VEl>;
};

const screen = (html: string, css: string) => {
  const { document } = parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`) as unknown as {
    document: Doc;
  };
  const sheet = cssRules(css);
  const el = (id: string) => {
    const found = document.getElementById(id);
    if (found === null) throw new Error(`the fixture has no #${id}`);
    return found;
  };
  // One evaluator per state: a test that changes the tree asks again.
  const at = (id: string) => visibility(document, sheet).vis(el(id));
  return { at, el, sheet, document };
};

describe("the cascade picks one display per element", () => {
  it("the more specific rule wins, and order breaks a tie", () => {
    const { at } = screen(
      `<div class="a b"><button id="spec"></button></div>
       <button id="late"></button><button id="early"></button>
       <button id="idw" class="x y z w"></button>`,
      `.a.b button { display: none }
       .a button { display: inline }
       #late { display: none }
       #late { display: block }
       #early { display: block }
       #early { display: none }
       #idw { display: none }
       .x.y.z.w { display: block }`,
    );
    expect(at("spec")).toEqual({ depth: undefined, why: "css .a.b button" });
    expect(at("late")).toEqual({ depth: 0 });
    expect(at("early")).toEqual({ depth: undefined, why: "css #early" });
    expect(at("idw")).toEqual({ depth: undefined, why: "css #idw" });
  });

  it("!important outranks specificity and the inline style; an inline style outranks any normal rule", () => {
    const { at } = screen(
      `<button id="imp" class="imp"></button>
       <button id="inl" style="display:none"></button>
       <button id="inlimp" class="k" style="display: block"></button>
       <button id="inlwin" class="k2" style="color: red; display: inline-flex"></button>`,
      `#imp { display: block }
       .imp { display: none !important }
       #inl { display: block }
       .k { display: none !important }
       #inlwin.k2 { display: none }`,
    );
    expect(at("imp")).toEqual({ depth: undefined, why: "css .imp" });
    expect(at("inl")).toEqual({ depth: undefined, why: "inline style" });
    expect(at("inlimp")).toEqual({ depth: undefined, why: "css .k" });
    expect(at("inlwin")).toEqual({ depth: 0 });
  });

  it("a :not list counts as its most specific argument", () => {
    expect(specificity(".row:not(#nope, .x) .go")).toBe(1_002_000);
    expect(specificity(":where(#a) .go")).toBe(1_000);
    expect(specificity(".t:has(> [data-s], #r) b")).toBe(1_001_001);
    // :nth-child(An+B of S) is a pseudo-class plus its most specific S.
    expect(specificity("li:nth-child(2n of #a, .b)")).toBe(1_001_001);
    expect(specificity("li:nth-last-child(odd of .b)")).toBe(2_001);
    expect(specificity("li:nth-child(2n)")).toBe(1_001);
    const { at } = screen(
      `<div class="row"><button id="go" class="go now yes"></button></div>
       <div class="row x"><button id="go2" class="go now yes"></button></div>`,
      `.row:not(#nope, .x) .go { display: none }
       .row .go.now.yes { display: inline }`,
    );
    // One id in the list outweighs the later rule's three classes.
    expect(at("go")).toEqual({ depth: undefined, why: "css .row:not(#nope, .x) .go" });
    expect(at("go2")).toEqual({ depth: 0 });
  });

  it(":has reads the subtree the row bound", () => {
    const { at } = screen(
      `<div class="table"><i class="result" data-status="over"></i><button id="resign"></button></div>
       <div class="table"><i class="result" data-status="playing"></i><button id="resign2"></button></div>`,
      `.table:has(.result[data-status="over"]) button { display: none }`,
    );
    expect(at("resign")).toEqual({ depth: undefined, why: 'css .table:has(.result[data-status="over"]) button' });
    expect(at("resign2")).toEqual({ depth: 0 });
  });

  it("attribute operators match as a browser's do, and each is an atom", () => {
    const { document, sheet } = screen(
      `<div class="on" data-ply="12" data-tags="cold hot" data-lang="en-GB" data-s="playover" data-k="AB">
         <b class="b1"></b><b class="b2"></b><b class="b3"></b><b class="b4"></b><b class="b5"></b><b class="b6"></b>
       </div>
       <div class="off" data-ply="21" data-tags="hotter" data-lang="english" data-s="overtime" data-k="ABC">
         <b class="b1"></b><b class="b2"></b><b class="b3"></b><b class="b4"></b><b class="b5"></b><b class="b6"></b>
       </div>`,
      `[data-ply^="1"] .b1 { display: none }
       [data-tags~=hot] .b2 { display: none }
       [data-lang|="en"] .b3 { display: none }
       [data-s$='over'] .b4 { display: none }
       [data-s*="lay"] .b5 { display: none }
       [data-k="ab" i] .b6 { display: none }
       [data-shown] .b1 { display: block }`,
    );
    const { vis } = visibility(document, sheet);
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(vis(document.querySelector(`.on .b${n}`)!).depth).toBe(undefined);
      expect(vis(document.querySelector(`.off .b${n}`)!).depth).toBe(0);
    }
    // No display:none rule names data-shown, so it is no atom.
    expect(atoms(sheet.rules)).toEqual([
      '[data-k="ab" i]',
      '[data-lang|="en"]',
      '[data-ply^="1"]',
      '[data-s$="over"]',
      '[data-s*="lay"]',
      '[data-tags~="hot"]',
    ]);
  });

  it("an attribute name is one atom in any case, and [|x] is the attribute x", () => {
    const { at, sheet } = screen(
      `<div data-ply="0"><b id="x" class="x"></b><b id="y" class="y"></b><b id="z" class="z"></b></div>`,
      `[Data-Ply="0"] .x { display: none }
       [data-ply="0"] .y { display: none }
       [|DATA-PLY] .z { display: none }`,
    );
    expect(at("x").depth).toBe(undefined);
    expect(at("z").depth).toBe(undefined);
    expect(atoms(sheet.rules)).toEqual(['[data-ply="0"]', "[data-ply]"]);
  });

  it("[hidden] and the other UA rules lose to any author rule", () => {
    const { at } = screen(
      `<button id="h" hidden></button>
       <div hidden><button id="hc"></button></div>
       <div hidden class="shown"><button id="hs"></button></div>
       <div hidden class="rv"><button id="hr"></button></div>
       <template><button id="t"></button></template>
       <dialog><button id="dlg"></button></dialog>
       <dialog open><button id="dlgo"></button></dialog>`,
      `.shown { display: flex }
       .rv { display: revert }`,
    );
    expect(at("h")).toEqual({ depth: undefined, why: "[hidden]" });
    expect(at("hc")).toEqual({ depth: undefined, why: "[hidden]" });
    expect(at("hs")).toEqual({ depth: 0 });
    expect(at("hr")).toEqual({ depth: undefined, why: "[hidden]" });
    expect(at("t")).toEqual({ depth: undefined, why: "css template" });
    expect(at("dlg")).toEqual({ depth: undefined, why: "dialog: (no reachable invoker)" });
    expect(at("dlgo")).toEqual({ depth: 0 });
  });

  it("a disabled control is on screen and unreachable", () => {
    const { at } = screen(
      `<button id="d" disabled></button>
       <button id="ad" aria-disabled="true"></button>
       <fieldset disabled><legend><button id="lg"></button></legend><button id="fs"></button></fieldset>`,
      ``,
    );
    expect(at("d")).toEqual({ depth: undefined, why: "disabled" });
    expect(at("ad")).toEqual({ depth: undefined, why: "disabled" });
    expect(at("fs")).toEqual({ depth: undefined, why: "disabled" });
    expect(at("lg")).toEqual({ depth: 0 });
  });
});

describe("a closed popover or dialog is one gesture past its invoker", () => {
  const NESTED = `
    <button id="open-a" commandfor="pa" command="toggle-popover"></button>
    <div id="pa" popover>
      <button id="open-b" popovertarget="pb"></button>
      <div id="pb" popover><button id="deep"></button></div>
    </div>
    <div id="lonely" popover><button id="stranded"></button></div>
    <button popovertarget="shut" popovertargetaction="hide"></button>
    <div id="shut" popover><button id="only-hides"></button></div>
    <div id="loop" popover><button id="self" commandfor="loop" command="show-popover"></button></div>`;

  it("a popover two levels deep is reached through two invokers", () => {
    const { at } = screen(NESTED, ``);
    expect(at("open-a")).toEqual({ depth: 0 });
    expect(at("pa")).toEqual({ depth: 1 });
    expect(at("open-b")).toEqual({ depth: 1 });
    expect(at("pb")).toEqual({ depth: 2 });
    // Both pa and pb are closed ancestors of #deep. Resolving pb walks through
    // pa, and pa must still be reachable for the second ancestor: the seen set
    // is a copy per branch.
    expect(at("deep")).toEqual({ depth: 2 });
  });

  it("an open popover costs nothing, and the depth below it drops", () => {
    const { at, el } = screen(NESTED, ``);
    el("pa").setAttribute("data-popover-open", "");
    expect(at("open-b")).toEqual({ depth: 0 });
    expect(at("deep")).toEqual({ depth: 1 });
  });

  it("a popover nothing reachable opens is unreachable", () => {
    const { at } = screen(NESTED, ``);
    expect(at("stranded")).toEqual({ depth: undefined, why: "popover:lonely (no reachable invoker)" });
    expect(at("only-hides")).toEqual({ depth: undefined, why: "popover:shut (no reachable invoker)" });
    expect(at("self")).toEqual({ depth: undefined, why: "popover:loop (no reachable invoker)" });
  });

  it("the nearest reachable invoker counts; a hidden one does not", () => {
    const { at, el } = screen(
      `<button class="gone" commandfor="pc" command="toggle-popover"></button>
       <div id="menu"><button id="near" commandfor="pc" command="show-popover"></button></div>
       <div id="pc" popover><button id="in-c"></button></div>`,
      `.gone { display: none }`,
    );
    expect(at("in-c")).toEqual({ depth: 1 });
    el("menu").setAttribute("hidden", "");
    expect(at("in-c")).toEqual({ depth: undefined, why: "popover:pc (no reachable invoker)" });
  });

  it("a closed popover's subtree is judged as it shows once open, and the tree is left as found", () => {
    const { at, el } = screen(
      `<button commandfor="m" command="toggle-popover"></button>
       <div id="m" class="menu" popover><button id="item" class="item"></button></div>
       <button commandfor="n" command="toggle-popover"></button>
       <div id="n" class="sheet" popover><button id="in-n"></button></div>`,
      `.menu .item { display: none }
       .menu:popover-open .item { display: block }
       .sheet:not(:popover-open) { display: none }`,
    );
    expect(at("item")).toEqual({ depth: 1 });
    expect(at("in-n")).toEqual({ depth: 1 });
    expect(el("m").hasAttribute("data-popover-open")).toBe(false);
    expect(el("n").hasAttribute("data-popover-open")).toBe(false);
  });

  it("a popover an author rule shows through its open ancestor opens with that ancestor", () => {
    const { at, el } = screen(
      `<button commandfor=a command=toggle-popover></button><div id=a class=a popover><div id=b class=b popover><button id=in></button></div></div>`,
      `.a:popover-open .b { display: block }`,
    );
    expect(at("in")).toEqual({ depth: 1 });
    expect(at("b")).toEqual({ depth: 1 });
    expect(el("a").hasAttribute("data-popover-open")).toBe(false);
    expect(el("b").hasAttribute("data-popover-open")).toBe(false);
  });

  it("an author display on the popover itself outranks the UA rule: it shows closed, at no gesture's cost", () => {
    const { at } = screen(
      `<div id="p" class="p" popover><button id="in-p"></button></div>
       <div id="q" class="q" popover><button id="in-q"></button></div>
       <div id="r" class="r" popover><button id="in-r"></button></div>`,
      `.p { display: block }
       .q { display: none }
       [popover].r { display: revert }`,
    );
    expect(at("p")).toEqual({ depth: 0 });
    expect(at("in-p")).toEqual({ depth: 0 });
    // An author display:none hides it closed, and open as well.
    expect(at("in-q")).toEqual({ depth: undefined, why: "css .q" });
    // revert rolls back to the UA rule, which hides it closed.
    expect(at("in-r")).toEqual({ depth: undefined, why: "popover:r (no reachable invoker)" });
  });

  it("a dialog [command=show-modal] opens is one gesture away, and the tree is left as found", () => {
    const { at, el } = screen(
      `<button id="open-d" commandfor="d" command="show-modal"></button>
       <dialog id="d" class="d"><button id="close-d" commandfor="d" command="close"></button></dialog>
       <button commandfor="e" command="toggle-popover"></button>
       <dialog id="e"><button id="in-e"></button></dialog>
       <button commandfor="f" command="show-modal"></button>
       <dialog id="f" class="f"><button id="in-f"></button></dialog>
       <dialog id="g" class="g"><button id="in-g"></button></dialog>`,
      `.d .inner { display: none }
       .d:not([open]) #close-d { display: none }
       .f[open] #in-f { display: none }
       .g { display: grid }`,
    );
    expect(at("open-d")).toEqual({ depth: 0 });
    // Judged open: the rule keyed on the closed dialog no longer holds.
    expect(at("close-d")).toEqual({ depth: 1 });
    expect(el("d").hasAttribute("open")).toBe(false);
    // A popover command opens no dialog.
    expect(at("in-e")).toEqual({ depth: undefined, why: "dialog:e (no reachable invoker)" });
    expect(at("in-f")).toEqual({ depth: undefined, why: "css .f[open] #in-f" });
    // An author display on the dialog outranks dialog:not([open]).
    expect(at("in-g")).toEqual({ depth: 0 });
  });

  it("only show-modal opens a dialog: close, request-close and a custom command do not", () => {
    const { at } = screen(
      `<button commandfor="h" command="close"></button>
       <button commandfor="h" command="request-close"></button>
       <button commandfor="h" command="--custom"></button>
       <dialog id="h"><button id="in-h"></button></dialog>`,
      ``,
    );
    expect(at("in-h")).toEqual({ depth: undefined, why: "dialog:h (no reachable invoker)" });
  });
});

describe("what the tier cannot judge it reports", () => {
  it("a rule under @media, @container or @supports never wins, and is named where it would flip the verdict", () => {
    const { at, sheet } = screen(
      `<button id="narrow"></button>
       <div class="card"><button id="in-card"></button></div>
       <button id="layered"></button>
       <button id="shown-if"></button>`,
      `@media (max-width: 40rem) { #narrow { display: none } }
       .card { @container (width < 1px) { display: none } }
       @layer base { #layered { display: none } }
       #shown-if { display: none }
       @supports (display: grid) { #shown-if { display: block } }`,
    );
    expect(at("narrow")).toEqual({ depth: 0, cond: ["@media (max-width: 40rem) #narrow"] });
    expect(at("in-card")).toEqual({ depth: 0, cond: ["@container (width < 1px) .card"] });
    expect(at("layered")).toEqual({ depth: undefined, why: "css #layered" });
    expect(at("shown-if")).toEqual({
      depth: undefined,
      why: "css #shown-if",
      cond: ["@supports (display: grid) #shown-if"],
    });
    expect(sheet.rules.filter((r) => r.cond !== undefined).map((r) => `${r.cond} ${r.sel}`)).toEqual([
      "@media (max-width: 40rem) #narrow",
      "@container (width < 1px) .card",
      "@supports (display: grid) #shown-if",
    ]);
  });

  it("an unknown pseudo-class is unjudged, never silently matched; the states no screen is in never match", () => {
    const { at, sheet } = screen(
      `<button id="x"></button><button id="y"></button><button id="z"></button>
       <div class="sq"><button id="w"></button></div><button id="v"></button><button id="u"></button>`,
      `#x:bogus { display: none }
       #y:hover { display: none }
       #z:not(:focus-visible) { display: none }
       .sq:-webkit-drag #w { display: none }
       #v::before { display: none }
       #v:after { display: none }
       #u { display: var(--shown) }`,
    );
    expect(sheet.unjudged.map((u) => u.sel)).toEqual(["#x:bogus", "#u"]);
    expect(sheet.unjudged[0].why).toContain("bogus");
    expect(sheet.unjudged[1].why).toBe("display: var(--shown)");
    expect(sheet.rules.map((r) => r.sel)).toEqual(["#y:hover", "#z:not(:focus-visible)", ".sq:-webkit-drag #w"]);
    expect(sheet.rules.map((r) => r.test)).toEqual(["#y:not(*)", "#z:not(:not(*))", ".sq:not(*) #w"]);
    expect(at("x")).toEqual({ depth: 0 });
    expect(at("y")).toEqual({ depth: 0 });
    // Nothing is ever focused here, so :not(:focus-visible) always holds.
    expect(at("z")).toEqual({ depth: undefined, why: "css #z:not(:focus-visible)" });
    expect(at("w")).toEqual({ depth: 0 });
    expect(at("v")).toEqual({ depth: 0 });
  });

  it("a gated rule that could not outrank the winner is not named", () => {
    const { at } = screen(
      `<button id="imp" class="b"></button><button id="spec" class="b"></button><button id="flip" class="b"></button>`,
      `#imp { display: none !important }
       @media (min-width: 1px) { #imp { display: block } }
       #spec { display: none }
       @media (min-width: 1px) { .b { display: block } }
       #flip { display: none }
       @media (min-width: 1px) { #flip.b { display: block } }`,
    );
    expect(at("imp")).toEqual({ depth: undefined, why: "css #imp" });
    expect(at("spec")).toEqual({ depth: undefined, why: "css #spec" });
    expect(at("flip")).toEqual({ depth: undefined, why: "css #flip", cond: ["@media (min-width: 1px) #flip.b"] });
  });

  it("one selector the browser rejects drops its whole list; :is() and :where() forgive", () => {
    const { at, sheet } = screen(
      `<button id="a" class="a"></button><button id="c" class="c"></button>
       <div class="p"><button id="n" class="n"></button></div>
       <button id="f" class="f"></button><button id="w" class="w"></button><button id="e" class="e"></button>`,
      `.a, .b:bogus { display: none }
       .c, .d::bogus { display: none }
       .p, .q:bogus { & .n { display: none } }
       :is(.f, .x:bogus) { display: none }
       :where(.w, :bogus) { display: none }
       .e:is(:bogus) { display: none }`,
    );
    expect(at("a")).toEqual({ depth: 0 });
    expect(at("c")).toEqual({ depth: 0 });
    expect(at("n")).toEqual({ depth: 0 });
    expect(at("f")).toEqual({ depth: undefined, why: "css :is(.f, .x:bogus)" });
    expect(at("w")).toEqual({ depth: undefined, why: "css :where(.w, :bogus)" });
    // A forgiving list left empty matches nothing.
    expect(at("e")).toEqual({ depth: 0 });
    expect(sheet.rules.map((r) => [r.sel, r.test, r.spec])).toEqual([
      [":is(.f, .x:bogus)", ":is(.f)", 1_000],
      [":where(.w, :bogus)", ":where(.w)", 0],
      [".e:is(:bogus)", ".e:not(*)", 1_000],
    ]);
    expect(sheet.unjudged).toEqual([
      { sel: ".a, .b:bogus", why: "the browser drops the whole rule: .b:bogus names the unknown pseudo-class :bogus" },
      { sel: ".c", why: "the browser drops the whole rule: .d::bogus names the unknown pseudo-element ::bogus" },
      {
        sel: ":is(.p, .q:bogus) .n",
        why: "the browser drops the whole rule: .q:bogus names the unknown pseudo-class :bogus",
      },
    ]);
  });

  it("a rejected argument of :not() or :nth-child(… of S) drops the rule, and no pseudo-element stands in an argument", () => {
    const { at, sheet } = screen(
      `<button id="a" class="a"></button><button id="c" class="c"></button><button id="d" class="d"></button>
       <button id="f" class="f"></button>`,
      `.a, li:nth-child(1 of :bogus) { display: none }
       .c, .z:not(::before) { display: none }
       .d, .z:not(:after) { display: none }
       :is(.f, ::before) { display: none }`,
    );
    expect(at("a")).toEqual({ depth: 0 });
    expect(at("c")).toEqual({ depth: 0 });
    expect(at("d")).toEqual({ depth: 0 });
    // A forgiving list drops the pseudo-element and keeps the rest.
    expect(at("f")).toEqual({ depth: undefined, why: "css :is(.f, ::before)" });
    expect(sheet.rules.map((r) => [r.sel, r.test])).toEqual([[":is(.f, ::before)", ":is(.f)"]]);
    expect(sheet.unjudged).toEqual([
      {
        sel: ".a, li:nth-child(1 of :bogus)",
        why: "the browser drops the whole rule: li:nth-child(1 of :bogus) names the unknown pseudo-class :bogus",
      },
      {
        sel: ".c, .z:not(::before)",
        why: "the browser drops the whole rule: .z:not(::before) puts the pseudo-element ::before inside :not()",
      },
      {
        sel: ".d, .z:not(:after)",
        why: "the browser drops the whole rule: .z:not(:after) puts the pseudo-element :after inside :not()",
      },
    ]);
  });

  it("an unknown ::-webkit- pseudo-element is kept, as Chromium keeps it; an unknown ::-moz- one drops the rule", () => {
    const { at, sheet } = screen(
      `<button id="k" class="k"></button><button id="m" class="m"></button>`,
      `.k, .z::-webkit-scrollbar-thumb-bogus { display: none }
       .m, .z::-moz-selection { display: none }`,
    );
    // The ::-webkit- selector targets a box, not an element; its sibling applies.
    expect(at("k")).toEqual({ depth: undefined, why: "css .k" });
    expect(at("m")).toEqual({ depth: 0 });
    expect(sheet.rules.map((r) => r.sel)).toEqual([".k"]);
    expect(sheet.unjudged).toEqual([
      {
        sel: ".m",
        why: "the browser drops the whole rule: .z::-moz-selection names the unknown pseudo-element ::-moz-selection",
      },
    ]);
  });

  it("a selector the browser accepts and linkedom cannot compile is unjudged alone", () => {
    const { at, sheet } = screen(
      `<button id="a" class="a"></button><div data-x><b id="y" class="y"></b></div>`,
      `.a, dialog:modal .x { display: none }
       [*|data-x] .y { display: none }
       li:nth-child(1 of .z) { display: none }`,
    );
    // Its sibling in the list still applies, as the browser applies it.
    expect(at("a")).toEqual({ depth: undefined, why: "css .a" });
    expect(at("y")).toEqual({ depth: 0 });
    expect(sheet.unjudged.map((u) => u.sel)).toEqual(["dialog:modal .x", "[*|data-x] .y", "li:nth-child(1 of .z)"]);
    expect(sheet.unjudged[1].why).toContain("Namespaced");
    expect(atoms(sheet.rules)).toEqual([]);
  });

  it("a stray } drops the rule after it, as the browser does, and says so", () => {
    const { sheet } = screen(
      ``,
      `.a { display: none } }
       .b { display: none }
       .c { display: none }`,
    );
    expect(sheet.rules.map((r) => r.sel)).toEqual([".a", ".c"]);
    expect(sheet.unjudged).toEqual([{ sel: "} .b", why: "a stray } before it: the browser drops this rule" }]);
  });
});

describe("the sheet a route puts in the document", () => {
  it("nesting is flattened the way the browser resolves &", () => {
    const { at, sheet } = screen(
      `<div class="card"><button id="g1" class="go"><span id="n1" class="note"></span></button><p id="dd" class="direct"></p></div>
       <div class="card on"><button id="g2" class="go"></button></div>`,
      `.card {
         display: grid;
         & .go { display: none }
         &.on .go { display: inline }
         .note { display: none }
         > .direct { display: none }
       }
       .a, .b { .c & { display: none } }
       .p .q { .r & { display: none } }`,
    );
    expect(sheet.rules.map((r) => r.sel)).toEqual([
      ".card",
      ".card .go",
      ".card.on .go",
      ".card .note",
      ".card > .direct",
      ".c :is(.a, .b)",
      ".r :is(.p .q)",
    ]);
    expect(at("g1")).toEqual({ depth: undefined, why: "css .card .go" });
    expect(at("g2")).toEqual({ depth: 0 });
    expect(at("dd")).toEqual({ depth: undefined, why: "css .card > .direct" });
  });

  const ROUTE = {
    screen: "s",
    files: {
      html: "s.html",
      css: "s.css",
      handlers: [],
      shared: ["shell/shared/base.css", "shell/shared/chrome.css", "shell/shared/type.css"],
    },
  };

  it("the screen css expands its @import from the shared files, and the markup's <style> blocks come last", () => {
    const sheet = routeSheet(ROUTE, {
      "shell/shared/base.css": `.go { display: none }`,
      // A shared sheet's own import resolves beside it.
      "shell/shared/chrome.css": `@import "type.css" (max-width: 2px);\n.bar { display: flex }`,
      "shell/shared/type.css": `.fine { display: none }`,
      "s.css": `@import url("shared/base.css");\n@import "./shared/chrome.css";\n.go.on { display: inline }`,
      "s.html": `<section><style>.x { display: none }</style>
        <style media="(max-width: 1px)">.go { display: block }</style></section>`,
    });
    expect(sheet.rules.map((r) => [r.sel, r.order, r.cond])).toEqual([
      [".go", 0, undefined],
      [".fine", 1, "@import (max-width: 2px)"],
      [".bar", 2, undefined],
      [".go.on", 3, undefined],
      [".x", 4, undefined],
      [".go", 5, "@media (max-width: 1px)"],
    ]);
  });

  it("an @import naming no shared file is an error", () => {
    expect(() =>
      routeSheet(ROUTE, { "s.css": `@import "shared/other.css";`, "s.html": `` })
    ).toThrow(`s.css imports "shared/other.css", which is none of the route's shared files`);
  });

  it("an @import after a rule is ignored, as the browser ignores it", () => {
    expect(cssRules(`@charset "utf-8";\n@layer base;\n@import "a.css";\n.x { display: none }\n@import "b.css";`).imports)
      .toEqual([{ url: "a.css", cond: undefined }]);
    expect(cssRules(`@namespace svg url(http://www.w3.org/2000/svg);\n@import "a.css";`).imports).toEqual([]);
    const sheet = routeSheet(ROUTE, {
      "shell/shared/base.css": `.go { display: none }`,
      "s.css": `.go.on { display: inline }\n@import url("shared/base.css");`,
      "s.html": ``,
    });
    expect(sheet.rules.map((r) => r.sel)).toEqual([".go.on"]);
  });

  it("an @import inside a block, or one that cannot be read, is an error", () => {
    expect(() => cssRules(`.a { @import "x.css"; }`)).toThrow(`cssRules: "@import "x.css"" is not at the top level`);
    expect(() => cssRules(`@media print { @import "x.css"; }`)).toThrow(
      `cssRules: "@import "x.css"" is not at the top level`,
    );
    expect(() => cssRules(`@import x.css;`)).toThrow(`cssRules: cannot read "@import x.css"`);
  });

  it("an @import cycle is an error", () => {
    expect(() =>
      routeSheet(ROUTE, {
        "shell/shared/base.css": `@import "chrome.css";`,
        "shell/shared/chrome.css": `@import "base.css";`,
        "s.css": `@import "shared/base.css";`,
        "s.html": ``,
      })
    ).toThrow("shell/shared/base.css → shell/shared/chrome.css → shell/shared/base.css imports itself");
  });
});

// Frozen copies of app sheets and markup, under fixtures/visibility/ (its
// README names each source): each case sets the attributes a bound row writes
// and asserts the control the sheet's rule hides or shows.
describe("frozen app sheets", () => {
  const FIXTURES = new URL("./fixtures/visibility/", import.meta.url);
  const SHARED: Record<string, string> = {
    chess: "shell/shared/paper.css",
    truco: "shell/shared/table.css",
    shadcnui: "shell/shared/chrome.css",
  };
  const routeOf = (app: string, screenName: string): Route => ({
    screen: screenName,
    files: {
      html: `shell/screens/${screenName}.html`,
      css: `shell/screens/${screenName}.css`,
      handlers: [],
      shared: [SHARED[app]],
    },
  });
  const read = (app: string, path: string) => Deno.readTextFile(new URL(`${app}/${path}`, FIXTURES));
  const open = async (app: string, screenName: string) => {
    const route = routeOf(app, screenName);
    const files: Record<string, string> = {};
    for (const path of [...route.files.shared ?? [], route.files.css, route.files.html]) {
      files[path] = await read(app, path);
    }
    const sheet = routeSheet(route, files);
    const { document } = parseHTML(
      `<!doctype html><html><head></head><body>${files[route.files.html]}</body></html>`,
    ) as unknown as { document: Doc };
    const one = (selector: string) => {
      const found = document.querySelector(selector);
      if (found === null) throw new Error(`${app}/${screenName} has no ${selector}`);
      return found;
    };
    const at = (selector: string) => visibility(document, sheet).vis(one(selector));
    return { sheet, one, at };
  };

  it("chess board: the game's status and mode hide the actions they end", async () => {
    const { sheet, one, at } = await open("chess", "board");
    expect(sheet.unjudged).toEqual([]);
    expect(atoms(sheet.rules)).toEqual(
      expect.arrayContaining(['[data-reviewing="yes"]', '[data-screen="board"]', '[data-status="over"]']),
    );
    const acts = one(".acts");
    acts.setAttribute("data-status", "playing");
    acts.setAttribute("data-mode", "house");
    for (const id of ["btn-new", "btn-resign", "btn-draw", "btn-takeback"]) expect(at(`#${id}`)).toEqual({ depth: 0 });
    acts.setAttribute("data-mode", "hotseat");
    expect(at("#btn-takeback")).toEqual({
      depth: undefined,
      why: 'css [data-screen="board"] .acts[data-mode="hotseat"] #btn-takeback',
    });
    expect(at("#btn-resign")).toEqual({ depth: 0 });
    acts.setAttribute("data-status", "over");
    for (const id of ["btn-resign", "btn-draw"]) {
      expect(at(`#${id}`)).toEqual({ depth: undefined, why: `css [data-screen="board"] .acts[data-status="over"] #${id}` });
    }
    expect(at("#btn-new")).toEqual({ depth: 0 });
  });

  it("chess board: each picker's options are one gesture past its trigger", async () => {
    const { at } = await open("chess", "board");
    for (const p of ["mode", "bot", "tc", "set", "view"]) {
      expect(at(`#picker-open-${p}`)).toEqual({ depth: 0 });
      expect(at(`#picker-pop-${p} button`)).toEqual({ depth: 1 });
    }
  });

  it("an orphaned brace is reported unjudged", async () => {
    // The frozen truco arena sheet carries one, before `@keyframes ember`.
    const { sheet } = await open("truco", "arena");
    expect(sheet.unjudged).toEqual([{ sel: "} @keyframes ember", why: "a stray } before it: the browser drops this rule" }]);
  });

  it("truco arena: each phase shows its own actions", async () => {
    const { one, at } = await open("truco", "arena");
    const play = one(".play");
    const A = '.screen[data-screen="arena"]';
    play.setAttribute("data-phase", "idle");
    expect(at("#btn-start")).toEqual({ depth: 0 });
    expect(at("#btn-truco")).toEqual({ depth: undefined, why: `css ${A} .play[data-phase="idle"] #btn-truco` });
    expect(at("#btn-again")).toEqual({ depth: undefined, why: `css ${A} #btn-again` });
    expect(at("#btn-accept")).toEqual({ depth: undefined, why: `css ${A} .answers` });
    play.setAttribute("data-phase", "your-turn");
    expect(at("#btn-truco")).toEqual({ depth: 0 });
    expect(at("#btn-next")).toEqual({ depth: undefined, why: `css ${A} .play[data-phase="your-turn"] #btn-next` });
    expect(at("#btn-start")).toEqual({ depth: undefined, why: `css ${A} #btn-start` });
    play.setAttribute("data-phase", "raised");
    expect(at("#btn-accept")).toEqual({ depth: 0 });
    expect(at("#btn-truco")).toEqual({ depth: undefined, why: `css ${A} .actions` });
    play.setAttribute("data-phase", "over");
    expect(at("#btn-again")).toEqual({ depth: 0 });
    expect(at("#btn-truco")).toEqual({ depth: undefined, why: `css ${A} .play[data-phase="over"] #btn-truco` });
  });

  it("shadcnui: every screen's sheet is judged whole, and a modal's controls are one gesture past its trigger", async () => {
    const screens: string[] = [];
    for await (const entry of Deno.readDir(new URL("shadcnui/shell/screens/", FIXTURES))) {
      if (entry.name.endsWith(".css")) screens.push(entry.name.slice(0, -".css".length));
    }
    expect(screens.length).toBeGreaterThan(30);
    for (const screenName of screens.sort()) {
      // Only the sheets are frozen for most screens: their markup carries no
      // <style>, so it is stood for by an empty page.
      const route = routeOf("shadcnui", screenName);
      const files = {
        [SHARED.shadcnui]: await read("shadcnui", SHARED.shadcnui),
        [route.files.css]: await read("shadcnui", route.files.css),
        [route.files.html]: "",
      };
      expect({ screen: screenName, unjudged: routeSheet(route, files).unjudged })
        .toEqual({ screen: screenName, unjudged: [] });
    }
    const { at } = await open("shadcnui", "overlays");
    expect(at("#dialog-open-modal")).toEqual({ depth: 0 });
    expect(at("#dialog-modal .dialog-dismiss")).toEqual({ depth: 1 });
    expect(at("#dialog-inline .dialog-dismiss")).toEqual({ depth: 1 });
  });

  it("shadcnui input-otp: reset shows only once the code is verified", async () => {
    const { one, at } = await open("shadcnui", "input-otp");
    const otp = one(".otp");
    otp.setAttribute("data-state", "idle");
    expect(at(".otp-reset")).toEqual({
      depth: undefined,
      why: 'css .screen-input-otp .otp:not([data-state="verified"]) .otp-reset',
    });
    otp.setAttribute("data-state", "verified");
    expect(at(".otp-reset")).toEqual({ depth: 0 });
  });
});
