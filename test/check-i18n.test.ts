// The i18n check's own claims, run by the test verb rather than by hand:
// check-i18n.ts is a checker, not a suite, so its cases reach CI only through
// this file.
import { selfTest } from "../check-i18n.ts";

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
