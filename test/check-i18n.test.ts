// The i18n check's own claims, run by the test verb rather than by hand:
// check-i18n.ts is a checker, not a suite, so its cases reach CI only through
// this file.
import { parseHTML } from "linkedom";
import { inspectedElements, selfTest } from "../check-i18n.ts";

Deno.test("localization traversal preserves exclusions and document order across frame boundaries", () => {
  const { document } = parseHTML(`<main>
    <div id="frame"><p id="before">Visible</p>
      <section translate="no"><p>Excluded</p><section translate="yes"><p>Still excluded</p></section></section>
      <script><span>Ignored</span></script><style>Ignored</style>
      <section data-text-format="number"><span>Formatted</span></section>
      <section translate="NO"><p>Case-sensitive fixture</p></section>
      <template><p>Template</p></template><svg><text>SVG</text><script>Ignored</script></svg>
      <section><p id="after">Visible again</p></section>
    </div>
    <section translate="no"><div id="excluded"><p>Outside ancestor</p></div></section>
    <section data-text-format="number"><div id="formatted"><p>Outside formatter</p></div></section>
  </main>`);
  for (const id of ["frame", "excluded", "formatted"]) {
    const root = document.getElementById(id)!;
    for (const formatted of [false, true]) {
      const expected = [...root.querySelectorAll("*")].filter((el) =>
        el.tagName !== "SCRIPT" && el.tagName !== "STYLE" && !el.closest("script, style") &&
        !el.closest('[translate="no"]') && (!formatted || !el.closest("[data-text-format]"))
      );
      const actual = [...inspectedElements(root, formatted)];
      if (actual.length !== expected.length || actual.some((el, i) => el !== expected[i])) {
        throw new Error(`traversal differs for ${id}, formatted=${formatted}:\n` +
          `expected ${expected.map((el) => el.tagName + ":" + el.textContent).join("|")}\n` +
          `actual ${actual.map((el) => el.tagName + ":" + el.textContent).join("|")}`);
      }
    }
  }
});

Deno.test({
  name: "check-i18n self-test",
  async fn() {
    const { failures } = await selfTest();
    if (failures.length > 0) throw new Error(failures.join("\n"));
  },
});

Deno.test("catalog leak screening retains overlapping phrases, duplicate entries and literal punctuation", async () => {
  const { checkMemoryApp } = await import("../check-i18n.ts");
  const findings = await checkMemoryApp({
    i18n: { default: "en", locales: { en: { path: "en" }, pt: { path: "pt" } } },
    routes: [{ path: "/", screen: "home", states: ["populated"], files: { html: "home.html", css: "home.css" } }],
  }, {
    en: { short: "Football", long: "Football cup", alias: "Football cup", punctuation: "(Football)+" },
    pt: { short: "Futebol", long: "Copa A", alias: "Copa B", punctuation: "Copa especial" },
  }, {
    "home.html": '<main><p title="(Football)+">FOOTBALL CUP</p><p>xFootballx</p></main>',
    "home.css": "",
  });
  const text = findings.filter((f) => f.message.includes("text leak '") && f.message.includes("FOOTBALL CUP"));
  if (text.length !== 3) throw new Error(JSON.stringify(findings));
  if (!findings.some((f) => f.message.includes('text leak in title="(Football)+"'))) throw new Error(JSON.stringify(findings));
  if (findings.some((f) => f.message.includes('text: "xFootballx"'))) throw new Error(JSON.stringify(findings));
});
