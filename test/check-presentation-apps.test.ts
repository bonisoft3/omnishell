import { analyzeScreen, checkApp } from "../check-presentation.ts";
import { resolveMachineMarkup } from "../interpreter/lint.ts";
import { assertEquals } from "jsr:@std/assert@1.0.13";

Deno.test("a synthetic selector on the Snapcards tree leaves removal unchecked", async () => {
  const root = new URL("../../../apps/snapcards/", import.meta.url);
  const shell = JSON.parse(await Deno.readTextFile(new URL("shell/shell.json", root)));
  const route = shell.routes.find((r: { screen: string }) => r.screen === "generate");
  const html = resolveMachineMarkup(await Deno.readTextFile(new URL(route.files.html, root)), shell.cortex.actors, route.screen);
  const css = await Deno.readTextFile(new URL(route.files.css, root));
  const marker = '.studio-container[data-status="failed"] { color: red; }';
  const withMapping = analyzeScreen(route.files.html, html, { "generate.css": `${css}\n${marker}` });
  const removed = analyzeScreen(route.files.html, html, { "generate.css": css });
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

