import { parseHTML } from "npm:linkedom@0.18.4";
import { assertEquals } from "jsr:@std/assert@1.0.13";
import { checkAria } from "../check-aria.ts";

const check = (html: string, completeDocument = false) => checkAria(parseHTML(html).document, { path: "test.html", phase: "declaration", completeDocument });
const statuses = (html: string) => check(html).filter((o) => o.property.endsWith("cardinality")).map((o) => o.status);

Deno.test("current cardinality follows explicit sets, not the whole document", () => {
  assertEquals(statuses('<nav><a aria-current="page">A</a><a aria-current="page">B</a></nav>'), ["violation"]);
  assertEquals(statuses('<nav><ul><li aria-current="page">A</li></ul><ul><li aria-current="page">B</li></ul></nav>'), ["satisfied", "satisfied"]);
  assertEquals(statuses('<div><a aria-current="page">A</a><a aria-current="page">B</a></div>'), ["unchecked", "unchecked"]);
  assertEquals(statuses('<ul><li aria-current="false">A</li><li aria-current="custom">B</li></ul>'), ["satisfied"]);
  assertEquals(statuses('<ul><li aria-current="{current}">A</li><li aria-current="page">B</li></ul>'), ["unchecked"]);
  assertEquals(statuses('<template><ul><li aria-current="page"></li><li aria-current="page"></li></ul></template>'), []);
});

Deno.test("single selection respects explicit multiplicity and nested composites", () => {
  const tabs = '<div role="tablist"><button role="tab" aria-selected="true">A</button><button role="tab" aria-selected="true">B</button></div>';
  assertEquals(statuses(tabs), ["violation"]);
  assertEquals(statuses(tabs.replace('role="tablist"', 'role="tablist" aria-multiselectable="true"')), []);
  assertEquals(statuses(tabs.replace('role="tablist"', 'role="tablist" aria-multiselectable="{multi}"')), ["unchecked"]);
  assertEquals(statuses('<div role="radiogroup"><div role="radio" aria-checked="true"></div><div role="radiogroup"><div role="radio" aria-checked="true"></div></div></div>'), ["satisfied", "satisfied"]);
});

Deno.test("ID references distinguish complete documents from fragments and dynamic bindings", () => {
  assertEquals(check('<button aria-controls="missing"></button>')[0].status, "unchecked");
  assertEquals(check('<button aria-controls="missing"></button>', true)[0].status, "violation");
  assertEquals(check('<button aria-controls="{panel}"></button>', true)[0].status, "unchecked");
  assertEquals(check('<button aria-controls="panel"></button><div id="panel"></div>', true)[0].status, "satisfied");
  assertEquals(check('<button aria-controls="panel"></button><div id="panel"></div><div id="panel"></div>')[0].status, "violation");
});

Deno.test("dynamic exposure cannot prove or disprove exclusivity", () => {
  for (const attr of ["hidden", "aria-hidden"]) {
    assertEquals(statuses(`<ul><li ${attr}="{left}" aria-current="page">A</li><li ${attr}="{right}" aria-current="page">B</li></ul>`), ["unchecked"]);
    assertEquals(statuses(`<ul ${attr}="{visible}"><li aria-current="page">A</li><li aria-current="page">B</li></ul>`), ["unchecked"]);
    assertEquals(statuses(`<div role="tablist"><button role="tab" ${attr}="{left}" aria-selected="true">A</button><button role="tab" ${attr}="{right}" aria-selected="true">B</button></div>`), ["unchecked"]);
  }
  assertEquals(statuses('<ul><li aria-current="page">A</li><li aria-current="page">B</li><li hidden="{hidden}" aria-current="page">C</li></ul>'), ["violation"]);
  assertEquals(statuses('<ul><li aria-current="page">A</li><li hidden aria-current="page">B</li></ul>'), ["satisfied"]);
});

Deno.test("fallback roles resolve against the pinned ARIA vocabulary", () => {
  const obligations = check('<div role="unknown tablist"><button role="tab" aria-selected="true">A</button></div>');
  assertEquals(obligations.some((o) => o.property === "aria-role-coverage"), false);
  assertEquals(obligations.some((o) => o.property === "aria-required-owned" && o.status === "satisfied"), true);
});

Deno.test("required roles use standard ownership paths, native context and loading semantics", () => {
  const find = (html: string, property: string) => check(html, true).filter((o) => o.property === property).map((o) => o.status);
  assertEquals(find('<div role="tablist"></div>', "aria-required-owned"), ["violation"]);
  assertEquals(find('<div role="tablist" aria-busy="true"></div>', "aria-required-owned"), ["unchecked"]);
  assertEquals(find('<div role="tablist"><template><button role="tab"></button></template></div>', "aria-required-owned"), ["unchecked"]);
  assertEquals(find('<button role="tab"></button>', "aria-required-context"), ["violation"]);
  assertEquals(find('<ul><li role="listitem">Item</li></ul>', "aria-required-context"), ["satisfied"]);
  assertEquals(find('<div role="tablist" aria-owns="tab"></div><button id="tab" role="tab"></button>', "aria-required-context"), ["satisfied"]);
  assertEquals(find('<div role="tablist" aria-owns="tab"></div><button id="tab" role="tab"></button>', "aria-required-owned"), ["satisfied"]);
  assertEquals(find('<div role="grid"><div role="rowgroup"><div role="row"><span role="gridcell"></span></div></div></div>', "aria-required-owned"), ["satisfied", "satisfied", "satisfied"]);
});

Deno.test("native cardinality uses live properties and form ownership, not default attributes", () => {
  const { document } = parseHTML('<form id="a"><input type="radio" name="pick"><input type="radio" name="pick"></form><form id="b"><input type="radio" name="pick"></form><select><option>A</option><option>B</option></select>');
  const inputs = [...document.querySelectorAll("input")];
  inputs.forEach((el) => Object.defineProperty(el, "checked", { value: true, configurable: true }));
  const run = () => checkAria(document, { path: "controls", phase: "execution", completeDocument: true, nativeProperties: "browser" });
  assertEquals(run().filter((o) => o.property === "native-radio-cardinality").map((o) => o.status), ["violation", "satisfied"]);
  assertEquals(checkAria(document, { path: "controls", phase: "declaration" }).filter((o) => o.property === "native-radio-cardinality").every((o) => o.status === "unchecked"), true);
  for (const option of document.querySelectorAll("option")) Object.defineProperty(option, "selected", { value: true });
  assertEquals(run().find((o) => o.property === "native-select-cardinality")?.status, "violation");
  assertEquals(checkAria(document, { path: "controls", phase: "execution", nativeProperties: "adapter" }).filter((o) => o.property.startsWith("native-")).every((o) => o.status === "unchecked"), true);
});

Deno.test("external ownership and partial native groups do not create false cardinality proofs", () => {
  assertEquals(statuses('<nav><a id="a" aria-current="page">A</a><a id="b" aria-current="page">B</a></nav><div role="group" aria-owns="a"></div>'), ["unchecked"]);
  const { document } = parseHTML('<input type="radio" name="pick">');
  Object.defineProperty(document.querySelector("input"), "checked", { value: true });
  assertEquals(checkAria(document, { path: "fragment", phase: "execution", nativeProperties: "browser" }).find((o) => o.property === "native-radio-cardinality")?.status, "unchecked");
});

Deno.test("screen inventory reports violations and does not claim dynamic output is complete", async () => {
  const { checkApp } = await import("../check-aria-app.ts");
  const app = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${app}/shell/screens`, { recursive: true });
    await Deno.writeTextFile(`${app}/shell/screens/example.html`, '<nav><a aria-current="page">A</a><a aria-current="page">B</a></nav><button aria-controls="panel"></button>');
    const { obligations, checked } = await checkApp(app);
    assertEquals(checked, 1);
    assertEquals(obligations.find((o) => o.property === "aria-current-cardinality")?.status, "violation");
    assertEquals(obligations.find((o) => o.property.startsWith("aria-reference"))?.status, "unchecked");
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});
