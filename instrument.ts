// Fuel metering for Jessie source, by rewriting.
//
// A handler is source the app wrote and the terminal runs, so how long it may
// run is the terminal's to decide. Every loop head and every function entry is
// made to spend one step of a budget the caller holds, which bounds a module
// deterministically — a step count is the same on every machine, where a
// wall-clock timeout is not, and a spinning loop never yields the thread a
// timer would have to run on.
//
// The rewrite leaves a Jessie module a Jessie module: the same top-level
// statements, the same completion value, one name more in scope. So the
// rewritten source loads in the same compartment, under the same role, as the
// file it came from, and what the battery measures is the module production
// runs rather than a harness built around it.

import * as acorn from "npm:acorn@8.14.0";
import * as walk from "npm:acorn-walk@8.3.4";
import { evaluateCaged } from "./interpreter/jessie.js";

/** The name a rewritten module spends fuel through. The counter stays outside
 * the compartment, in the closure `fuelMeter` holds, so the module can burn its
 * budget and cannot read, reset or widen it. The name reaches the module as an
 * endowment that is neither writable nor configurable, and a module that binds
 * the name itself is refused below — so every call the rewrite emits reaches
 * the meter and nothing the module supplied. */
export const METER = "__fuel";

/** A budget and the endowment that spends it. `consumed` is the steps since
 * the last `reset`, which is what a caller reports per run. */
export type Meter = {
  endowments: Record<string, () => void>;
  reset: () => void;
  consumed: () => number;
};

export function fuelMeter(limit: number): Meter {
  let spent = 0;
  return {
    endowments: {
      [METER]: () => {
        spent++;
        if (spent > limit) throw new RangeError(`Jessie fuel limit exceeded (${limit} steps)`);
      },
    },
    reset: () => {
      spent = 0;
    },
    consumed: () => spent,
  };
}

/** Every name a binding pattern introduces. */
// deno-lint-ignore no-explicit-any
function patternNames(node: any, out: string[]): void {
  if (node === null || node === undefined) return;
  if (node.type === "Identifier") out.push(node.name);
  else if (node.type === "ObjectPattern") {
    for (const p of node.properties) patternNames(p.type === "Property" ? p.value : p.argument, out);
  } else if (node.type === "ArrayPattern") for (const el of node.elements) patternNames(el, out);
  else if (node.type === "AssignmentPattern") patternNames(node.left, out);
  else if (node.type === "RestElement") patternNames(node.argument, out);
}

/**
 * What a module does with the meter's name, as a phrase naming the line, or
 * null where it leaves the name alone.
 *
 * Every form listed here resolves ahead of the compartment's global, so a
 * module carrying one calls its own value wherever the rewrite means to spend
 * a step. All of them are static — a binding is a fact about the text — so the
 * whole class is decided before a step is ever spent. Writing the endowment
 * from the module is the other half, and the compartment refuses that itself.
 */
function meterCapture(ast: acorn.Program): string | null {
  const said: { pos: number; phrase: string }[] = [];
  // deno-lint-ignore no-explicit-any
  const binds = (node: any, pattern: any, phrase: string) => {
    const names: string[] = [];
    patternNames(pattern, names);
    if (names.includes(METER)) said.push({ pos: node.start, phrase: `${phrase} on line ${node.loc.start.line}` });
  };
  // deno-lint-ignore no-explicit-any
  walk.full(ast, (node: any) => {
    switch (node.type) {
      case "VariableDeclarator":
        binds(node, node.id, "declares it as a variable");
        break;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        if (node.id !== null && node.id !== undefined) binds(node, node.id, "declares it as a function");
        for (const param of node.params) binds(node, param, "takes it as a parameter");
        break;
      case "ClassDeclaration":
      case "ClassExpression":
        binds(node, node.id, "declares it as a class");
        break;
      case "CatchClause":
        binds(node, node.param, "takes it as a catch binding");
        break;
      case "AssignmentExpression":
        binds(node, node.left, "assigns it");
        break;
      case "UpdateExpression":
        binds(node, node.argument, "assigns it");
        break;
    }
  });
  said.sort((a, b) => a.pos - b.pos);
  return said.length === 0 ? null : said[0].phrase;
}

/** The same source, spending a step at every loop head and every function
 * entry. Empty source rewrites to empty source: a module with nothing in it
 * runs no step and is not a parse failure.
 *
 * A module that binds the meter's name is refused rather than rewritten: what
 * the rewrite emits is a call to that name, and a module holding the name
 * holds the calls. */
export function instrument(source: string): string {
  if (!source.trim()) return "";

  const ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "script", locations: true });
  const captured = meterCapture(ast);
  if (captured !== null) {
    throw new Error(`${METER} is the meter this module is run under, and this module ${captured}`);
  }
  const edits: { pos: number; insert: string }[] = [];
  const stmtCheck = `${METER}();`;

  // deno-lint-ignore no-explicit-any
  const loopBody = (body: any) => {
    if (body.type === "BlockStatement") {
      edits.push({ pos: body.start + 1, insert: ` ${stmtCheck}` });
    } else {
      edits.push({ pos: body.start, insert: `{ ${stmtCheck} ` });
      edits.push({ pos: body.end, insert: " }" });
    }
  };

  walk.simple(ast, {
    ForStatement(node) { loopBody(node.body); },
    ForInStatement(node) { loopBody(node.body); },
    ForOfStatement(node) { loopBody(node.body); },
    WhileStatement(node) { loopBody(node.body); },
    DoWhileStatement(node) { loopBody(node.body); },
    ArrowFunctionExpression(node) {
      if (node.body.type === "BlockStatement") {
        edits.push({ pos: node.body.start + 1, insert: ` ${stmtCheck}` });
      } else {
        // A concise body is an expression and must stay one, so the step is
        // spent by a comma operator rather than by a statement.
        edits.push({ pos: node.body.start, insert: `(${METER}(), (` });
        edits.push({ pos: node.body.end, insert: "))" });
      }
    },
    FunctionDeclaration(node) {
      edits.push({ pos: node.body.start + 1, insert: ` ${stmtCheck}` });
    },
    FunctionExpression(node) {
      edits.push({ pos: node.body.start + 1, insert: ` ${stmtCheck}` });
    },
  });

  edits.sort((a, b) => b.pos - a.pos);
  let out = source;
  for (const edit of edits) {
    out = out.slice(0, edit.pos) + edit.insert + out.slice(edit.pos);
  }
  return out;
}

/**
 * The rewriter's own claims, as sentences; empty is a pass. Returned rather
 * than printed so the caller owns the stream, as the checkers' are.
 *
 * Every case runs through the compartment a handler runs in, because what the
 * rewrite owes is a module that loads: source that meters perfectly and does
 * not parse as Jessie passes a test that only counts steps.
 */
export async function selfTest(): Promise<{ failures: string[] }> {
  const failures: string[] = [];

  const check = (name: string, ok: boolean, detail: string) => {
    if (!ok) failures.push(`instrument ${name}: ${detail}`);
  };

  /** One module, loaded metered: its completion value and its own budget. */
  async function load(source: string, limit: number) {
    const meter = fuelMeter(limit);
    const target = await evaluateCaged(instrument(source), meter.endowments) as (...args: unknown[]) => unknown;
    meter.reset();
    return { meter, target };
  }

  const normalSrc = `
const bump = (n) => n + 1;
(state, event) => {
  let s = 0;
  for (const x of state.items) s += bump(x);
  return { s };
};
`;

  const normal = await load(normalSrc, 1000);
  const res1 = normal.target({ items: [1, 2, 3] }) as { s: number };
  check("normal result", res1.s === 9, JSON.stringify(res1));
  check("step consumption", normal.meter.consumed() === 7, `consumed ${normal.meter.consumed()}`);

  normal.meter.reset();
  normal.target({ items: [10] });
  check("a reset run is counted from zero", normal.meter.consumed() === 3, `consumed ${normal.meter.consumed()}`);

  // Regression: Parenthesised concise arrow expression must wrap in fuel check without syntax error
  const paren = await load(
    `
const num = (v) => (Number(v) || 0);
(state, event) => ({ n: num(event.x) });
`,
    1000,
  );
  const resParen = paren.target({}, { x: "42" }) as { n: number };
  check("paren expression arrow result", resParen.n === 42, JSON.stringify(resParen));

  /** What running a module threw, or null where it returned. */
  const threw = async (source: string, limit: number): Promise<string | null> => {
    const { target } = await load(source, limit);
    try {
      target({}, {});
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };

  // Regression: While loop must exhaust fuel limit and abort execution
  const loop = await threw(`(state, event) => { while (true) {} };`, 500);
  check("infinite loop caught", loop?.includes("Jessie fuel limit exceeded") === true, `threw ${loop}`);

  // Regression: Unbounded function recursion must exhaust fuel limit before stack overflow
  const recurse = await threw(
    `
const recurse = () => recurse();
(state, event) => recurse();
`,
    200,
  );
  check("runaway recursion caught", recurse?.includes("Jessie fuel limit exceeded") === true, `threw ${recurse}`);

  // Regression: the budget bounds the module's TOP LEVEL too. A file whose
  // statements never finish reaches no completion value, and a meter armed
  // only around the returned function would let it hang the verb.
  let topLevel: string | null = null;
  try {
    await load(`while (true) {}\n(state, event) => state;\n`, 300);
  } catch (e) {
    topLevel = (e as Error).message;
  }
  check("a spinning top level is caught", topLevel?.includes("Jessie fuel limit exceeded") === true, `threw ${topLevel}`);

  // A budget bounds a module only while the calls the rewrite emits reach the
  // meter. Each source below hands the name a callable of its own and then
  // spins: `Function.prototype` rather than an app-written stub, because a
  // stub is itself rewritten and would spend the steps its own body owes.
  // Unmetered, every one of them returns having spent nothing.
  const hot = `for (let i = 0; i < 200000; i++) {}`;
  const spin = `${hot}\n(state, event) => ({});\n`;

  /** What instrument refused about a source, or null where it rewrote it. */
  const refused = (source: string): string | null => {
    try {
      instrument(source);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };

  // A binding is a fact about the text, so the rewriter decides these itself,
  // and says which line did what.
  const captures: [string, string][] = [
    ["a const", `const ${METER} = Function.prototype;\n${spin}`],
    ["a var", `var ${METER} = Function.prototype;\n${spin}`],
    ["a destructured const", `const { a: ${METER} } = { a: Function.prototype };\n${spin}`],
    ["a function declaration", `function ${METER}() {}\n${spin}`],
    ["a class declaration", `class ${METER} {}\n${spin}`],
    ["a parameter", `(function (${METER}) { ${hot} })(Function.prototype);\n(state, event) => ({});\n`],
    ["a catch binding", `try { null.x; } catch (${METER}) { ${hot} }\n(state, event) => ({});\n`],
    ["a bare assignment", `${METER} = Function.prototype;\n${spin}`],
  ];
  for (const [what, source] of captures) {
    const said = refused(source);
    check(
      `${what} named ${METER} is refused`,
      said !== null && said.includes(METER) && /line \d+/.test(said),
      `instrument said ${said}`,
    );
  }

  /** What loading a module threw, or null where it reached a value. */
  const loadThrew = async (source: string, limit: number): Promise<string | null> => {
    try {
      await load(source, limit);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };

  // Writing the name is the compartment's to refuse, and it refuses the
  // spelled name and the computed one alike — so a module that reads the
  // global's own property names off the cage learns nothing it can use.
  const written: [string, string][] = [
    ["the global is written", `globalThis.${METER} = Function.prototype;\n${spin}`],
    [
      "the global is written under a computed name",
      `const found = Object.getOwnPropertyNames(globalThis).filter((k) => k === ${JSON.stringify(METER)});\n` +
      `globalThis[found[0]] = Function.prototype;\n${spin}`,
    ],
    [
      "the global is redefined",
      `Object.defineProperty(globalThis, ${JSON.stringify(METER)}, { value: Function.prototype });\n${spin}`,
    ],
  ];
  for (const [what, source] of written) {
    const said = await loadThrew(source, 100);
    check(`${what}, the compartment refuses`, said !== null && said.includes(METER), `loading said ${said}`);
  }

  return { failures };
}

if (import.meta.main) {
  const { failures } = await selfTest();
  for (const f of failures) console.error(`FAIL ${f}`);
  console.error(failures.length === 0 ? "instrument self-test: passed" : `instrument self-test: ${failures.length} failed`);
  Deno.exit(failures.length === 0 ? 0 : 1);
}
