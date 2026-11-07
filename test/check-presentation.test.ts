import { analyzeScreen } from "../check-presentation.ts";
import { assertEquals } from "jsr:@std/assert@1.0.13";

const html = `<div id="job" class="job" data-live="job" data-machine='{"field":"status","initial":"idle","states":{"idle":{"on":{"click@go":"running"}},"running":{"on":{"click@fail":"failed"}},"failed":{"on":{"click@go":"running"}}}}' data-status="{status}"><button id="go">Go</button><button id="fail">Fail</button></div>`;
const styles = { "job.css": `.job[data-status="idle"] { color: black } .job[data-status="running"] { color: blue } .job[data-status="failed"] { color: red }` };
const state = (results: ReturnType<typeof analyzeScreen>, name: string) => results.find((o) => o.id.endsWith(`:${name}`))!;

Deno.test("generated fragment headers do not hide ARIA obligations", () => {
  const markup = '<!-- generated -->\n<nav><a href="/a" aria-current="page">A</a><a href="/b" aria-current="page">B</a></nav>';
  const report = analyzeScreen("generated.html", markup, {});
  assertEquals(report.find((o) => o.property === "aria-current-cardinality")?.status, "violation");
});

Deno.test("state selectors are consumers, bookkeeping alone is not", () => {
  const original = analyzeScreen("job.html", html, styles);
  assertEquals(state(original, "failed").status, "satisfied");
  const removed = analyzeScreen("job.html", html, { "job.css": styles["job.css"].replace('.job[data-status="failed"] { color: red }', "") });
  assertEquals(state(removed, "failed").status, "violation");
  assertEquals(state(analyzeScreen("job.html", html, {}), "failed").status, "unchecked");
});

Deno.test("unrelated selectors and guarded or transient states stay open", () => {
  const css = { "job.css": `.job[data-status="idle"] { color: black } .other[data-status="failed"] { color: red }` };
  const unbound = { "job.css": `.job[data-status="idle"] { color: black } .job[data-state="failed"] { color: red }` };
  assertEquals(state(analyzeScreen("job.html", html, unbound), "failed").status, "violation");
  assertEquals(state(analyzeScreen("job.html", html, css), "failed").status, "violation");
  const scoped = { "job.css": `.job[data-status="idle"] { color: black } .other .job[data-status="failed"] { color: red }` };
  assertEquals(state(analyzeScreen("job.html", html, scoped), "failed").status, "unchecked");
  const empty = { "job.css": `.job[data-status="idle"] { color: black } .job[data-status="failed"] { }` };
  assertEquals(state(analyzeScreen("job.html", html, empty), "failed").status, "violation");
  const identical = { "job.css": ["idle", "running", "failed"].map((s) => `.job[data-status="${s}"] { color: black }`).join(" ") };
  assertEquals(state(analyzeScreen("job.html", html, identical), "failed").status, "unchecked");
  const guarded = html.replace('"click@fail":"failed"', '"signal:fail":{"target":"failed","guard":"opaque"}');
  assertEquals(state(analyzeScreen("job.html", guarded, css), "failed").status, "unchecked");
  const transient = html.replace('"failed":{"on":', '"failed":{"always":"idle","on":');
  assertEquals(state(analyzeScreen("job.html", transient, css), "failed").status, "unchecked");
});

Deno.test("a missing chart initial remains an explicit gap", () => {
  const missing = html.replace('"initial":"idle",', "");
  assertEquals(state(analyzeScreen("job.html", missing, styles), "idle").reason.includes("mounted row"), true);
});

Deno.test("non-rendering bindings do not count as presentation", () => {
  const insert = (content: string) => html.replace("</div>", `${content}</div>`);
  for (const content of ['<span data-html="{status}"></span>', '<input type="hidden" data-value="{status}">', '<span hidden data-text="{status}"></span>']) {
    assertEquals(state(analyzeScreen("job.html", insert(content), {}), "failed").status, "unchecked");
  }
  assertEquals(state(analyzeScreen("job.html", insert('<span data-text="{status}"></span>'), {}), "failed").status, "satisfied");
});

Deno.test("ordered alternatives and state events do not invent reachable states", () => {
  const shadowed = html.replace('"click@fail":"failed"', '"click@fail":[{"target":"idle"},{"target":"failed"}]');
  assertEquals(state(analyzeScreen("job.html", shadowed, styles), "failed").status, "unchecked");
  const guarded = html.replace('"click@fail":"failed"', '"click@fail":[{"target":"idle","guard":"unknown"},{"target":"failed"}]');
  assertEquals(state(analyzeScreen("job.html", guarded, styles), "failed").status, "unchecked");
  const overridden = html.replace('"states":{', '"on":{"click@fail":"failed"},"states":{').replace('"click@fail":"failed"', '"click@fail":"failed"');
  const blocked = overridden.replace('"running":{"on":{"click@fail":"failed"}}', '"running":{"on":{"click@fail":"idle"}}')
    .replace('"idle":{"on":{"click@go":"running"}}', '"idle":{"on":{"click@go":"running","click@fail":"idle"}}');
  assertEquals(state(analyzeScreen("job.html", blocked, styles), "failed").status, "unchecked");
});

Deno.test("renderer-owned descendants are not text bindings", () => {
  const rendered = html.replace("</div>", '<div data-text-format="custom"><span data-text="{status}"></span></div></div>');
  assertEquals(state(analyzeScreen("job.html", rendered, {}), "failed").status, "unchecked");
});

Deno.test("item templates expose nested machines and scoped event sources", () => {
  const nested = `<div data-live="list"><template data-item>${html}</template></div>`;
  const report = analyzeScreen("nested.html", nested, styles);
  assertEquals(report.filter((o) => o.property === "presentation-consumer").length, 3);
  const event = report.find((o) => o.property === "interaction-source" && o.id.endsWith(":click@fail"))!;
  assertEquals(event.status, "satisfied");
  const missing = analyzeScreen("nested.html", nested.replace('<button id="fail">Fail</button>', ""), styles);
  assertEquals(missing.find((o) => o.id === event.id)?.status, "violation");
  const elsewhere = analyzeScreen("nested.html", nested.replace('<button id="fail">Fail</button>', "") + '<button id="fail">Outside</button>', styles);
  assertEquals(elsewhere.find((o) => o.id === event.id)?.status, "violation");
});

Deno.test("opaque event sources stay unchecked and host events are inventoried", () => {
  const missing = html.replace('<button id="fail">Fail</button>', "");
  const result = (markup: string, opaque = false) => analyzeScreen("job.html", markup, styles, opaque)
    .find((o) => o.property === "interaction-source" && o.id.endsWith(":click@fail"))!.status;
  assertEquals(result(missing, true), "unchecked");
  assertEquals(result(missing.replace('</div>', '<div data-live="controls" data-template="controls"></div></div>')), "unchecked");
  assertEquals(result(missing.replace('</div>', '<button id="{control_id}"></button></div>')), "unchecked");
  assertEquals(result(missing.replace('id="job"', 'id="fail"')), "satisfied");
});

Deno.test("inert templates neither supply controls nor introduce active machines", () => {
  const inert = html.replace('<button id="fail">Fail</button>', '<template><button id="fail">Fail</button></template>');
  assertEquals(analyzeScreen("job.html", inert, styles).find((o) => o.property === "interaction-source" && o.id.endsWith(":click@fail"))?.status, "violation");
  for (const attrs of ["", 'data-item data-name="unused"']) {
    assertEquals(analyzeScreen("job.html", `<template ${attrs}>${html}</template>`, styles).length, 0);
  }
  const duplicate = analyzeScreen("job.html", html + html.replace('<button id="fail">Fail</button>', ""), styles);
  assertEquals(new Set(duplicate.map((o) => o.id)).size, duplicate.length);
});

Deno.test("named templates expand independently at each live reference", () => {
  const definition = `<template data-item data-name="shared">${html}</template>`;
  const report = analyzeScreen("job.html", `${definition}<div data-live="a" data-template="shared"></div><div data-live="b" data-template="shared"></div>`, styles);
  assertEquals(report.filter((o) => o.property === "presentation-consumer").length, 6);
  assertEquals(report.filter((o) => o.property === "interaction-source").every((o) => o.status === "satisfied"), true);
  assertEquals(new Set(report.map((o) => o.id)).size, report.length);
  assertEquals(report.filter((o) => o.property === "presentation-coverage").length, 0);
});

Deno.test("unresolved and recursive references are unchecked within their owning region", () => {
  const missing = html.replace('<button id="fail">Fail</button>', '<div data-live="children" data-template="child"></div>');
  for (const definitions of ["", `<template data-item data-name="child"><div></div></template><template data-item data-name="child"><div></div></template>`, `<template data-item data-name="child"><div data-live="children" data-template="child"></div></template>`]) {
    const report = analyzeScreen("job.html", missing + definitions, styles);
    assertEquals(report.find((o) => o.property === "presentation-coverage")?.status, "unchecked");
    assertEquals(report.find((o) => o.property === "interaction-source" && o.id.endsWith(":click@fail"))?.status, "unchecked");
  }
});

Deno.test("named references cannot borrow controls from another instance or inert content", () => {
  const definition = `<template data-item data-name="shared">${html.replace('<button id="fail">Fail</button>', '')}</template>`;
  const report = analyzeScreen("job.html", `${definition}<div data-live="a" data-template="shared"></div><button id="fail"></button><template><button id="fail"></button></template><div data-live="b" data-template="shared"></div>`, styles);
  assertEquals(report.filter((o) => o.property === "interaction-source" && o.id.endsWith(":click@fail")).map((o) => o.status), ["violation", "violation"]);
});

Deno.test("invalid item declarations do not prove a region or its children render", () => {
  const machine = html.replace('</div>', '<template data-item><button id="extra"></button><div></div></template></div>');
  const both = html.replace('data-live="job"', 'data-live="job" data-template="shared"').replace('</div>', '<template data-item><div></div></template></div>') + '<template data-item data-name="shared"><div></div></template>';
  for (const markup of [machine, both]) {
    const report = analyzeScreen("job.html", markup, styles);
    assertEquals(report.find((o) => o.property === "presentation-coverage")?.status, "unchecked");
    assertEquals(report.filter((o) => o.property !== "presentation-coverage").every((o) => o.status === "unchecked"), true);
  }
});

Deno.test("scoped input sources require native producers, including bubbling and editing hosts", () => {
  const check = (body: string, event = "input") => analyzeScreen("editor.html",
    `<section data-machine='{ "initial":"idle", "states":{"idle":{"on":{"${event}@editor":"idle"}}} }'>${body}</section>`, {})
    .find((o) => o.property === "interaction-source")?.status;
  assertEquals(check('<div id="editor"></div>'), "violation");
  assertEquals(check('<div id="editor"><input></div>'), "satisfied");
  assertEquals(check('<div id="editor"><input type="hidden"></div>'), "violation");
  assertEquals(check('<div id="editor"><template><input></template></div>'), "violation");
  assertEquals(check('<div id="editor" contenteditable></div>'), "satisfied");
  assertEquals(check('<div id="editor" contenteditable="false"></div>'), "violation");
  assertEquals(check('<div id="editor"><custom-editor></custom-editor></div>'), "unchecked");
  assertEquals(check('<div id="editor"><select></select></div>', "change"), "satisfied");
  assertEquals(check('<div id="editor"></div>', "submit"), "violation");
  assertEquals(check('<div id="editor"><form></form></div>', "submit"), "satisfied");
  assertEquals(check('<div id="editor"></div>', "keydown"), "violation");
  assertEquals(check('<div id="editor" tabindex="0"></div>', "keydown"), "satisfied");
  assertEquals(check('<a id="editor" data-route="home">Home</a>', "keydown"), "satisfied");
});

Deno.test("mounted item ARIA remains an explicit gap rather than disappearing", () => {
  const item = '<div role="listbox"><span role="option" aria-selected="true">A</span><span role="option" aria-selected="true">B</span></div>';
  assertEquals(analyzeScreen("direct.html", item, {}).some((o) => o.property === "aria-selection-cardinality" && o.status === "violation"), true);
  for (const markup of [
    `<div data-live="items"><template data-item>${item}</template></div>`,
    `<template data-item data-name="choice">${item}</template><div data-live="items" data-template="choice"></div>`,
  ]) {
    const report = analyzeScreen("items.html", markup, {});
    assertEquals(report.some((o) => o.property === "aria-item-coverage" && o.status === "unchecked"), true);
  }
  const inert = analyzeScreen("inert.html", `<template data-item data-name="unused">${item}</template>`, {});
  assertEquals(inert.some((o) => o.property.startsWith("aria-")), false);
});

Deno.test("declared chart references retain presentation obligations outside shell/screens", async () => {
  const { checkApp } = await import("../check-presentation.ts");
  const dir = await Deno.makeTempDir();
  const app = new URL(`file://${dir}/`);
  try {
    await Deno.mkdir(new URL("shell/", app));
    await Deno.mkdir(new URL("screens/", app));
    const machine = JSON.parse(html.match(/data-machine='([^']+)'/)![1]);
    const source = html.replace(/data-machine='[^']+'/, 'data-cortex="jobRows" data-machine-ref="main"');
    await Deno.writeTextFile(new URL("screens/job.html", app), source);
    await Deno.writeTextFile(new URL("screens/job.css", app), styles["job.css"].replace('.job[data-status="failed"] { color: red }', ""));
    await Deno.writeTextFile(new URL("shell/shell.json", app), JSON.stringify({
      routes: [{ screen: "job", files: { html: "screens/job.html", css: "screens/job.css" } }],
      cortex: { actors: { jobRows: { via: "rows", lifetime: "attachment", screen: "job", charts: { main: machine } } } },
    }));
    const result = await checkApp(app);
    assertEquals(state(result.obligations, "failed").status, "violation");
    assertEquals(state(result.obligations, "idle").status, "satisfied");
  } finally { await Deno.remove(dir, { recursive: true }); }
});
