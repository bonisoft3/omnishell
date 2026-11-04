// A single-file page has no network to import a host-DOM hatch from, so it
// hands the terminal the modules it compiled in; given that map, a hatch it
// does not hold is refused rather than fetched.
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { hostDomScreen } from "../interpreter/host-dom.js";

const route = { hatches: ["press"] };
const declarations = { press: { src: "shell/hatches/press.js", note: "prints" } };
const APP = "https://app.example/";

Deno.test("a compiled hatch is mounted from the page's own module, by its src", async () => {
  const mounted: string[] = [];
  const hostDomModules = { "shell/hatches/press.js": { default: () => (mounted.push("press"), () => mounted.push("stopped")) } };
  const screen = await hostDomScreen(route, APP, declarations, { hostDomModules });
  screen.start({} as HTMLElement, {});
  screen.stop();
  assertEquals(mounted, ["press", "stopped"]);
});

Deno.test("given compiled hatches, one the page does not hold is refused", async () => {
  await assertRejects(
    () => hostDomScreen(route, APP, declarations, { hostDomModules: {} }),
    Error,
    "host-DOM hatch shell/hatches/press.js is not compiled into this page",
  );
});
