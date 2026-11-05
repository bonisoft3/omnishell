/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { checkAria, type AriaObligation } from "./check-aria.ts";
import { expandTemplates } from "./expand-templates.ts";
import { parseHTML } from "npm:linkedom@0.18.4";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Status = "satisfied" | "violation" | "unchecked";
export type Obligation = AriaObligation | {
  id: string;
  path: string;
  property: "presentation-consumer" | "presentation-coverage" | "interaction-source";
  status: Status;
  reason: string;
  evidence: string[];
  assumptions: string[];
};
export type Report = { obligations: Obligation[]; counts: Record<Status, number> };
type Node = Record<string, unknown>;
const object = (v: unknown): Node => v && typeof v === "object" && !Array.isArray(v) ? v as Node : {};
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [v];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const visibleEvent = /^(click|input|change|submit|keydown|keyup|pointerdown|pointerup)@(.+)$/;

function nativeSource(event: string, el: Element): boolean {
  const editing = el.closest("[contenteditable]")?.getAttribute("contenteditable")?.toLowerCase();
  const editable = editing === "" || editing === "true" || editing === "plaintext-only";
  if (event === "input" || event === "change") {
    return (event === "input" && editable) || el.localName === "textarea" || el.localName === "select" ||
      (el.localName === "input" && !["hidden", "button", "submit", "reset", "image"].includes((el.getAttribute("type") ?? "text").toLowerCase()));
  }
  if (event === "submit") return el.localName === "form";
  if (event === "keydown" || event === "keyup") return editable ||
    el.matches("a[href], a[data-route], area[href], button, select, textarea, summary, [tabindex], audio[controls], video[controls], input:not([type=hidden])");
  return true;
}

function alternatives(value: unknown): { target: string; uncertain: boolean }[] {
  const result: { target: string; uncertain: boolean }[] = [];
  let earlierGuard = false;
  for (const edge of array(value)) {
    const e = object(edge);
    const guard = e.guard !== undefined;
    const target = typeof edge === "string" ? edge : e.target;
    if (typeof target === "string") result.push({ target, uncertain: guard || earlierGuard });
    if (!guard) break;
    earlierGuard = true;
  }
  return result;
}

function edges(node: Node, rootOn: Node): { target: string; uncertain: boolean }[] {
  const result: { target: string; uncertain: boolean }[] = [];
  for (const value of Object.values({ ...rootOn, ...object(node.on) })) result.push(...alternatives(value));
  for (const value of Object.values(object(node.after))) result.push(...alternatives(value));
  for (const edge of alternatives(node.always)) result.push({ ...edge, uncertain: true });
  return result;
}

// Selectors skip inert template contents; their declarations still belong in the inventory.
function elements(root: { children: Iterable<unknown> }): Element[] {
  return [...root.children as Iterable<Element>].flatMap((child) => {
    const owner = child.parentElement?.closest("[data-live]");
    const inert = child.localName === "template" &&
      (!child.hasAttribute("data-item") || !owner || owner.hasAttribute("data-template"));
    return [child, ...(!inert && !child.hasAttribute("data-text-format") ? elements(child) : [])];
  });
}

/** Analyze authored markup and styles without mounting a screen or executing its code. */
export function analyzeScreen(path: string, html: string, styles: Record<string, string>, opaque = false): Obligation[] {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  const obligations: Obligation[] = checkAria(document, { path, phase: "declaration", opaque });
  let regionIndex = 0;
  const itemRegions = [...document.querySelectorAll("[data-live]")].filter((region) =>
    region.hasAttribute("data-template") || region.querySelector("template[data-item]") !== null);
  const gaps = expandTemplates(document);
  const declaredElements = elements(document);
  for (const [index, region] of itemRegions.entries()) {
    if (!document.contains(region)) continue;
    const aria = [region, ...elements(region)].filter((el) =>
      el.hasAttribute("role") || el.getAttributeNames().some((name) => name.startsWith("aria-")));
    if (!aria.length) continue;
    obligations.push({ id: `${path}#aria-items:${index}`, path, property: "aria-item-coverage", status: "unchecked",
      oracleClass: "completeness", coverageRoute: "default", authority: "ARIA item-template inventory boundary",
      reason: "Item-template ARIA is outside the declaration inventory; row instantiation, repetition and ownership are not established.",
      evidence: [region.getAttribute("data-live")!, ...aria.map((el) => el.getAttribute("role") ?? el.localName)], assumptions: [] });
  }
  gaps.forEach((gap, index) => {
    obligations.push({ id: `${path}#template-reference:${index}`, path, property: "presentation-coverage", status: "unchecked",
      reason: `${gap.reason} named template reference prevents complete inventory`,
      evidence: [gap.reference], assumptions: [] });
  });
  for (const region of declaredElements.filter((el) => el.hasAttribute("data-machine"))) {
    const descendants = elements(region);
    const declared: unknown = JSON.parse(region.getAttribute("data-machine")!);
    const charts = Array.isArray(declared) ? declared : [declared];
    const regionName = `${region.id || region.getAttribute("data-live") || "region"}[${++regionIndex}]`;
    charts.forEach((raw, chartIndex) => {
      const chart = object(raw);
      const invalidRegion = gaps.some((gap) => gap.element === region);
      const sourceEvents = (node: Node, statePath: string) => {
        for (const event of Object.keys(object(node.on))) {
          const match = event.match(visibleEvent);
          if (!match) continue;
          const candidates = [region, ...descendants].filter((el) => el.id === match[2]);
          const dynamic = opaque || [region, ...descendants].some((el) =>
            gaps.some((gap) => gap.element === el) || el.id.includes("{") || el.hasAttribute("data-text-format") || el.localName.includes("-"));
          const sources = candidates.flatMap((el) => [el, ...descendants.filter((child) => el.contains(child))]);
          const supplied = sources.some((el) => nativeSource(match[1], el));
          const status: Status = invalidRegion ? "unchecked" : supplied ? "satisfied" : dynamic ? "unchecked" : "violation";
          obligations.push({
            id: `${path}#${regionName}:${chartIndex}:event:${statePath}:${event}`, path,
            property: "interaction-source", status,
            reason: invalidRegion ? "invalid item templates prevent this region from mounting"
              : supplied ? "a declared native source can supply this scoped DOM event, directly or by bubbling; runtime availability is not established"
              : dynamic ? "no supported static event source; dynamic markup or custom elements may supply it"
              : "no declared native source can supply this scoped DOM event inside its machine region",
            evidence: [event, ...candidates.map((el) => el.localName)],
            assumptions: ["DOM events bubble through the owning region; arbitrary script-generated events are outside this check"],
          });
        }
        for (const [name, child] of Object.entries(object(node.states))) sourceEvents(object(child), `${statePath}.${name}`);
      };
      sourceEvents(chart, "$root");
      const states = object(chart.states);
      const names = Object.keys(states);
      const field = typeof chart.field === "string" ? chart.field : "state";
      const unsupported = chart.type === "parallel" || names.some((n) => object(states[n]).states !== undefined);
      const reachable = new Set<string>();
      const possible = new Set<string>();
      if (typeof chart.initial === "string" && names.includes(chart.initial)) reachable.add(chart.initial);
      let changed = true;
      while (changed) {
        changed = false;
        for (const name of [...reachable, ...possible]) {
          for (const edge of edges(object(states[name]), object(chart.on))) {
            if (!names.includes(edge.target)) continue;
            const definite = reachable.has(name) && !edge.uncertain;
            const dest = definite ? reachable : possible;
            if (!dest.has(edge.target)) { dest.add(edge.target); changed = true; }
          }
        }
      }
      const attrs = new Set<string>();
      for (const attr of [...region.attributes]) {
        if (attr.value === `{${field}}` && !new Set([
          "data-text", "data-filter", "data-select", "data-empty", "data-empty-row", "data-when",
          "data-project", "data-order", "data-display-order", "data-exit-motion", "data-machine",
        ]).has(attr.name) && !attr.name.startsWith("data-read-")) attrs.add(attr.name);
      }
      const cssEvidence = (name: string): { evidence: string; declarations: string }[] => {
        const found: { evidence: string; declarations: string }[] = [];
        for (const [file, css] of Object.entries(styles)) {
          const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
          for (const rule of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
            const declarations = rule[2].trim();
            if (!declarations || !declarations.includes(":")) continue;
            for (const selector of rule[1].split(",")) for (const attr of attrs) {
              const pattern = new RegExp(`^\\s*([.#][\\w-]+|[\\w-]+)\\[${esc(attr)}\\s*=\\s*(["'])${esc(name)}\\2\\]\\s*$`);
              const match = selector.match(pattern);
              if (match && region.matches(match[1])) found.push({ evidence: `${file}: ${selector.trim()}`, declarations });
            }
          }
        }
        return found;
      };
      const directBinding = [region, ...descendants.filter((el) => el.hasAttribute("data-text") || el.hasAttribute("data-value"))].some((el) => {
        if (el.closest("[data-live]") !== region || el.closest("[hidden], template") || el.parentElement?.closest("[data-text-format]")) return false;
        const text = el.getAttribute("data-text");
        const format = el.getAttribute("data-text-format");
        if (text?.includes(`{${field}}`) && (!format || format === "plain")) return true;
        return ["input", "textarea", "select"].includes(el.localName) &&
          el.getAttribute("type")?.toLowerCase() !== "hidden" &&
          (el.getAttribute("data-value")?.includes(`{${field}}`) ?? false);
      });
      const perState = names.map((name) => cssEvidence(name));
      const identical = names.length > 1 && perState.every((rules) => rules.length > 0) &&
        perState.every((rules) => rules.map((r) => r.declarations).sort().join("\n") === perState[0].map((r) => r.declarations).sort().join("\n"));
      const anySurface = directBinding || (!identical && perState.some((e) => e.length > 0));
      names.forEach((name, i) => {
        const node = object(states[name]);
        const stateEvents = Object.keys(object(node.on)).filter((e) => visibleEvent.test(e));
        const uniqueEvents = stateEvents.filter((e) => !names.some((other) => other !== name && e in object(object(states[other]).on)) && !(e in object(chart.on)));
        const interactions = uniqueEvents.filter((e) => {
          const id = e.match(visibleEvent)![2];
          return descendants.filter((el) => el.hasAttribute("id")).some((el) => el.id === id);
        });
        const evidence = [...(identical ? [] : perState[i].map((r) => r.evidence)), ...(directBinding ? [`markup: {${field}} in presentation binding`] : []), ...interactions.map((e) => `interaction: ${e}`)];
        const uncertainSyntax = unsupported || node.always !== undefined || node.type === "history";
        const userEntry = names.some((from) => reachable.has(from) && Object.entries({ ...object(chart.on), ...object(object(states[from]).on) }).some(([event, value]) =>
          visibleEvent.test(event) && descendants.filter((el) => el.hasAttribute("id")).some((el) => el.id === event.match(visibleEvent)![2]) &&
          alternatives(value).some((edge) => edge.target === name && !edge.uncertain)));
        const dynamicBinding = descendants.some((el) => el.closest("[data-live]") === region && [...el.attributes].some((a) => a.value.includes(`{${field}}`)));
        const complexCss = Object.values(styles).some((css) => {
          const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
          return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].some((rule) => rule[1].split(",").some((selector) =>
            [...attrs].some((attr) => selector.includes(`[${attr}`)) &&
            !/^\s*(?:[.#][\w-]+|[\w-]+)\[[-\w]+\s*=\s*(["'])[^"']+\1\]\s*$/.test(selector)));
        });
        let status: Status;
        let reason: string;
        if (invalidRegion) {
          status = "unchecked";
          reason = "invalid item templates prevent this region from mounting";
        } else if (unsupported || !reachable.has(name) || uncertainSyntax) {
          status = "unchecked";
          reason = unsupported ? "hierarchical or parallel chart is unsupported" : typeof chart.initial !== "string" ? "no chart initial is declared; the mounted row or schema may supply its state" : !reachable.has(name) ? "reachability is guarded or not established" : "state may be transient";
        } else if (evidence.length) {
          status = "satisfied";
          reason = "a declared presentation dependency or state-specific interaction exists";
        } else if (!anySurface || opaque || gaps.some((gap) => region.contains(gap.element)) || !userEntry || dynamicBinding || complexCss) {
          status = "unchecked";
          reason = "internal state, dynamic bindings, complex CSS, or opaque presentation may account for this state";
        } else {
          status = "violation";
          reason = "no declared consumer for this reachable state in the supported presentation mappings";
        }
        obligations.push({ id: `${path}#${regionName}:${chartIndex}:${field}:${name}`, path, property: "presentation-consumer", status, reason, evidence, assumptions: ["graph reachability assumes unguarded events can occur", "CSS selectors indicate declared dependencies, not computed visibility"] });
      });
    });
  }
  return obligations;
}

type Route = { files: { html: string; css: string; shared?: string[]; renderers?: string[] } };
export async function checkApp(appDir: URL): Promise<Report> {
  const shell = JSON.parse(await Deno.readTextFile(new URL("shell/shell.json", appDir))) as { routes: Route[] };
  const obligations: Obligation[] = [];
  for (const route of shell.routes) {
    const path = route.files.html.replace(/^\//, "");
    const html = await Deno.readTextFile(new URL(path, appDir));
    const styles: Record<string, string> = {};
    for (const file of [route.files.css, ...(route.files.shared ?? [])].filter((p) => p.endsWith(".css"))) {
      styles[file] = await Deno.readTextFile(new URL(file.replace(/^\//, ""), appDir));
    }
    const dom = parseHTML(`<html><body>${html}</body></html>`).document;
    for (const style of elements(dom).filter((el) => el.localName === "style")) styles[`${path}#style-${Object.keys(styles).length}`] = style.textContent ?? "";
    obligations.push(...analyzeScreen(path, html, styles, (route.files.renderers ?? []).length > 0));
    expandTemplates(dom);
    for (const [kind, selector] of [["kinetic", "[data-kinetic]"], ["native-form", "form[data-entity]"]] as const) {
      const nodes = elements(dom).filter((el) => el.matches(selector));
      for (let i = 0; i < nodes.length; i++) obligations.push({
        id: `${path}#${kind}:${nodes[i].id || i + 1}`, path, property: "presentation-coverage", status: "unchecked",
        reason: `${kind} presentation is outside this checker`, evidence: [], assumptions: [],
      });
    }
    if ((route.files.renderers ?? []).length) obligations.push({
      id: `${path}#opaque-renderers`, path, property: "presentation-coverage", status: "unchecked",
      reason: "renderer output is outside this checker", evidence: route.files.renderers!, assumptions: [],
    });
  }
  const counts: Record<Status, number> = { satisfied: 0, violation: 0, unchecked: 0 };
  for (const obligation of obligations) counts[obligation.status]++;
  return { obligations, counts };
}

export async function run(args: string[]): Promise<void> {
  if (!args[0]) throw new Error("usage: check-presentation.ts <appDir>");
  const appDir = pathToFileURL(`${resolve(args[0])}/`);
  const report = await checkApp(appDir);
  console.log(JSON.stringify(report, null, 2));
  if (report.counts.unchecked) console.error(`warning: ${report.counts.unchecked} presentation obligation(s) unchecked`);
  if (report.counts.violation) Deno.exitCode = 1;
}
if (import.meta.main) await run(Deno.args);
