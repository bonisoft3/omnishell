// The machine walk's own claims, run by the test verb rather than by hand:
// check-machines.ts is a checker, not a suite, so its cases reach CI only
// through this file.
import { checkApp, fails, selfTest } from "../check-machines.ts";

Deno.test({
  name: "check-machines self-test",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { failures } = await selfTest();
    if (failures.length > 0) throw new Error(failures.join("\n"));
  },
});

Deno.test({
  name: "seeded relationships and parameter dependencies reach machine walks while invalid reads fail",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const run = await checkApp(new URL("./fixtures/relationship-machines/", import.meta.url));
    const byScreen = (name: string) => run.findings.filter((f) => f.path === `shell/screens/${name}.html`);
    for (const name of ["game", "game-hidden", "game-base", "campaign-hidden", "dependency"]) {
      if (byScreen(name).length !== 0) throw new Error(`${name} failed to walk: ${JSON.stringify(byScreen(name))}`);
    }
    for (const [name, count] of [["broken-game", 1], ["broken-game-hidden", 1], ["broken-game-base", 1], ["broken-dependency", 2]] as const) {
      const findings = byScreen(name);
      if (findings.length !== count || findings.some((f) => f.severity !== "error" || !f.message.includes("missing-control"))) {
        throw new Error(`${name} hid a broken transition: ${JSON.stringify(findings)}`);
      }
    }
    for (const [name, reason] of [
      ["invalid-column", "unknown column game.misspelled"],
      ["invalid-relation", "declared relationships"],
      ["unsupported-filter", "outside the grammar"],
      ["blocked-invalid", "unknown column param_card.misspelled"],
    ]) {
      const findings = byScreen(name);
      if (findings.length !== 1 || findings[0].severity !== "error" || !findings[0].message.includes(reason)) {
        throw new Error(`${name} skipped query validation: ${JSON.stringify(findings)}`);
      }
    }
    const cycles = byScreen("cycle");
    if (cycles.length !== 2 || cycles.some((f) => f.severity !== "error" || !f.message.includes("dependency cycle"))) {
      throw new Error(`seeded parameter cycles were silently demoted: ${JSON.stringify(cycles)}`);
    }
    const unresolved = byScreen("unresolved");
    if (unresolved.length !== 2 || unresolved.some((f) => f.severity !== "advisory" || !f.message.includes("no seeded row answers"))) {
      throw new Error(`empty parameter dependencies failed to terminate as unresolved: ${JSON.stringify(unresolved)}`);
    }
    // Both segment orders share each dependency screen. Every valid chart
    // must be driven, including those whose filter fields are not projected;
    // healthy siblings prevent the zero-walk floor masking a skipped chart.
    if (run.authored !== 26 || run.walked !== 24 || run.findings.length !== 13) {
      throw new Error(`relationship or dependency coverage changed: ${JSON.stringify(run)}`);
    }
    const empty = await checkApp(new URL("./fixtures/relationship-machines-empty/", import.meta.url));
    if (empty.authored !== 1 || empty.walked !== 0 || !fails(empty.findings) || !empty.findings.some((f) => f.message.includes("none was walked"))) {
      throw new Error(`an empty joined chart bypassed the coverage floor: ${JSON.stringify(empty)}`);
    }
  },
});

Deno.test({
  name: "machine walks honor each handler's emitted Statechart grant",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "machine grant " });
    try {
      for (const [name, granted] of [["allowed", true], ["denied", false]] as const) {
        const dir = `${root}/${name}`;
        await Deno.mkdir(`${dir}/shell/handlers`, { recursive: true });
        const handler = "shell/handlers/step.js";
        const shell = {
          local: { toggle: [{}] },
          schema: { toggle: { fields: [{ name: "id", type: "string" }, { name: "state", type: "string" }] } },
          seed: { toggle: [{ id: "one", state: "off" }] },
          routes: [{ path: "/", screen: "home", files: { html: "shell/home.html", css: "shell/home.css", handlers: [handler] } }],
          endowments: granted ? { [handler]: ["Statechart"] } : {},
        };
        await Deno.writeTextFile(`${dir}/shell/shell.yaml`, JSON.stringify(shell));
        await Deno.writeTextFile(`${dir}/shell/home.css`, "");
        await Deno.writeTextFile(`${dir}/${handler}`, 'const step = Statechart({initial:"a", states:{a:{final:true,on:{}}}}, {guard:()=>true,reduce:(row)=>row}); (state,event)=>({updates:[]});');
        await Deno.writeTextFile(`${dir}/shell/home.html`, `<section data-screen="home"><div data-live="toggle" data-on-mutation="step" data-machine='{"field":"state","initial":"off","states":{"off":{"on":{"click":"on"}},"on":{"on":{"click":"off"}}}}'><template data-item><button>Toggle</button></template></div></section>`);
        const result = await checkApp(new URL(`file://${dir}/`));
        if (granted && (result.walked !== 1 || fails(result.findings))) throw new Error(`granted handler failed: ${JSON.stringify(result)}`);
        if (!granted && !result.findings.some((f) => f.severity === "error" && f.message.includes("Statechart is not endowed"))) {
          throw new Error(`missing grant was not refused: ${JSON.stringify(result)}`);
        }
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "observation-dependent machine arrows remain unchecked without hiding click failures",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "machine source " });
    try {
      const sourceChart = { field: "state", initial: "a", invoke: { src: "observer" }, states: {
        a: { on: { "signal:source": "b" } }, b: { on: { "click@source-only-control": "a" } },
      } };
      const healthy = { field: "state", initial: "a", states: { a: { on: { click: "b" } }, b: { on: { click: "a" } } } };
      const broken = { field: "state", initial: "a", invoke: { src: "observer" }, states: {
        a: { on: { "click@missing-control": "b", "signal:source": "b" } }, b: {},
      } };
      for (const [name, charts] of [["only", [sourceChart]], ["mixed", [sourceChart, healthy]], ["broken", [broken]]] as const) {
        const dir = `${root}/${name}`;
        await Deno.mkdir(`${dir}/shell`, { recursive: true });
        const local = Object.fromEntries(charts.map((_, i) => [`item${i}`, [{}]]));
        const seed = Object.fromEntries(charts.map((_, i) => [`item${i}`, [{ id: "one", state: "a" }]]));
        const schema = Object.fromEntries(charts.map((_, i) => [`item${i}`, { fields: [{name:"id",type:"string"}, {name:"state",type:"string"}] }]));
        const shell = { local, seed, schema, actors: {observer:{via:"observe",field:"value",event:"signal:source",suffix:false}}, routes:[{path:"/",screen:"home",files:{html:"shell/home.html",css:"shell/home.css",handlers:[]}}] };
        await Deno.writeTextFile(`${dir}/shell/shell.yaml`, JSON.stringify(shell));
        await Deno.writeTextFile(`${dir}/shell/home.css`, "");
        const regions = charts.map((chart, i) => `<div data-live="item${i}" data-machine='${JSON.stringify(chart)}'><template data-item><button>Go</button></template></div>`).join("");
        await Deno.writeTextFile(`${dir}/shell/home.html`, `<section data-screen="home">${regions}</section>`);
        const result = await checkApp(new URL(`file://${dir}/`));
        if (name === "only" && (result.walked !== 0 || !result.findings.some((f) => f.coverage === "unchecked" && f.message.includes("click")) || !fails(result.findings))) throw new Error(JSON.stringify(result));
        if (name === "mixed" && (result.walked !== 1 || fails(result.findings) || !result.findings.some((f) => f.coverage === "unchecked"))) throw new Error(JSON.stringify(result));
        if (name === "broken" && !result.findings.some((f) => f.severity === "error" && f.message.includes("missing-control"))) throw new Error(JSON.stringify(result));
      }
    } finally { await Deno.remove(root, { recursive: true }); }
  },
});

Deno.test("a source shortcut does not hide a longer supported walk", async () => {
  const { walkMachine } = await import("./walker.ts");
  const machine = { field: "state", initial: "a", invoke: { src: "source" }, states: {
    a: { on: { "signal:ready": "c", "click@first": "b" } },
    b: { on: { "click@second": "c" } },
    c: { on: { "click@done": "a" } },
  } };
  let state = "a";
  const fired: string[] = [];
  const result = await walkMachine(machine, {
    field: () => state,
    wait: () => Promise.resolve(),
    fire: (type, from) => {
      const key = from ? `${type}@${from}` : type;
      fired.push(key);
      const target = (machine.states[state as keyof typeof machine.states].on as Record<string, string>)[key];
      if (target !== undefined) {
        (globalThis as Record<string, unknown>).__prontoMachineTrace && ((globalThis as Record<string, unknown>).__prontoMachineTrace as unknown[]).push({ state, key, index: 0, to: target });
        state = target;
      }
      return Promise.resolve();
    },
  }, { sourceEvent: (key) => key === "signal:ready" });
  if (fired.includes("signal:ready") || !fired.includes("click@second") || !fired.includes("click@done") || result.unchecked.length !== 1) throw new Error(JSON.stringify({fired, result}));
});
