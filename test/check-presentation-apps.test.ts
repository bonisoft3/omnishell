import { analyzeScreen, checkApp } from "../check-presentation.ts";
import { assertEquals } from "jsr:@std/assert@1.0.13";

Deno.test("a synthetic selector on the Snapcards tree leaves removal unchecked", async () => {
  const root = new URL("../../../apps/snapcards/", import.meta.url);
  const html = await Deno.readTextFile(new URL("shell/screens/generate.html", root));
  const css = await Deno.readTextFile(new URL("shell/screens/generate.css", root));
  const marker = '.studio-container[data-status="failed"] { color: red; }';
  const withMapping = analyzeScreen("shell/screens/generate.html", html, { "generate.css": `${css}\n${marker}` });
  const removed = analyzeScreen("shell/screens/generate.html", html, { "generate.css": css });
  const target = (os: typeof withMapping) => os.find((o) => o.id.includes("#generation-form[") && o.id.endsWith(":failed"))!;
  assertEquals(target(withMapping).status, "satisfied");
  assertEquals(target(removed).status, "unchecked");
});

Deno.test("application loader inventories emitted routes", async () => {
  const report = await checkApp(new URL("../../../apps/snapcards/", import.meta.url));
  assertEquals(report.obligations.length > 0, true);
});

Deno.test("application coverage gaps are explicit", async () => {
  const report = await checkApp(new URL("../../../apps/apexrun/", import.meta.url));
  assertEquals(report.obligations.some((o) => o.property === "presentation-coverage" && o.reason.includes("kinetic")), true);
  assertEquals(report.obligations.some((o) => o.property === "presentation-coverage" && o.reason.includes("native-form")), true);
});

