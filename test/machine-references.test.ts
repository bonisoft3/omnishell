/// <reference lib="dom" />
import assert from "node:assert/strict";
import { parseHTML } from "npm:linkedom@0.18.4";
import { resolveMachineReferences } from "../interpreter/row-attachments.js";
import { resolveMachineMarkup, machineRegions } from "../interpreter/lint.ts";
import { projectApp, projectScreen } from "../read-markup.ts";

const chart = { field: "status", initial: "idle", states: { idle: { on: { click: { target: "done", assign: { label: "it's <done> & ready" } } } }, done: {} } };
const actors = { rows: { via: "rows", lifetime: "attachment", screen: "sample", charts: { main: chart } } };
const markup = '<section><template data-item><button data-live="form" data-cortex="rows" data-machine-ref="main">Go</button></template></section>';

Deno.test("named charts project the declaration and resolve inside runtime templates", () => {
  const expanded = resolveMachineMarkup(markup, actors, "sample");
  assert.deepEqual(JSON.parse(machineRegions(expanded)[0].machine), chart);
  assert.deepEqual(JSON.parse(projectScreen(markup, actors, "sample").machines[0].machine), chart);
  const { document } = parseHTML(markup);
  resolveMachineReferences(document, actors, "sample");
  const button = document.querySelector("template")!.content.querySelector("button")!;
  assert.deepEqual(JSON.parse(button.getAttribute("data-machine")!), chart);
  assert.equal(button.hasAttribute("data-machine-ref"), false);
});

Deno.test("named charts refuse undeclared families, charts, wrong screens and conflicting declarations", () => {
  for (const [html, bindings, screen, message] of [
    [markup, {}, "sample", /Undeclared row attachment/],
    [markup.replace('ref="main"', 'ref="missing"'), actors, "sample", /has no chart/],
    [markup, actors, "other", /wrong screen/],
    [markup.replace('data-live="form"', ''), actors, "sample", /no data-live/],
    [markup.replace('data-live="form"', 'data-live="form" data-machine="{}"'), actors, "sample", /cannot share/],
  ] as const) {
    assert.throws(() => resolveMachineMarkup(html, bindings, screen), message);
    const { document } = parseHTML(html);
    assert.throws(() => resolveMachineReferences(document, bindings, screen), message);
  }
});

Deno.test("projection reads declared authored paths without consuming stale emitted markup", async () => {
  const dir = await Deno.makeTempDir();
  const app = new URL(`file://${dir}/`);
  try {
    await Deno.mkdir(new URL("screens/", app));
    await Deno.mkdir(new URL("shell/screens/", app), { recursive: true });
    await Deno.writeTextFile(new URL("screens/sample.html", app), markup);
    await Deno.writeTextFile(new URL("shell/screens/stale.html", app), '<div data-machine="invalid"></div>');
    const result = await projectApp(app, actors, { sample: "screens/sample.html" });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(Object.keys(result.screens), ["sample"]);
    assert.deepEqual(JSON.parse(result.screens.sample.machines[0].machine), chart);
  } finally { await Deno.remove(dir, { recursive: true }); }
});

Deno.test("resolving machine references preserves executable markup for the markup gate", () => {
  const html = '<script>alert(1)</script><!-- <div data-machine-ref="missing"> --><section onclick="bad()"></section>';
  assert.equal(resolveMachineMarkup(html, actors, "sample"), html);
});
