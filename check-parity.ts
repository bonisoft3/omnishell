// omnishell parity check: verify semantic and affordance parity between
// Web (LinkeDOM/HTML) and Native (DivKit SDUI JSON AST) representations
// of screens declared in an app's shell.yaml.
//
// Parity is an omnishell-level concept:
// 1. Input Affordance Completeness: Every interactive input field on Web must
//    exist as an editable input on Native with identical field key and matching
//    input mode (single-line vs multiline), and vice-versa.
// 2. Action Affordance Completeness: Every primary action or navigation trigger
//    on Web must have an equivalent actionable trigger on Native.
//
// Opt-outs are configured programmatically by the test script (check-parity.test.ts):
// - ignoreRoutes: string[] (routes to skip, e.g. ['/settings'])
// - ignoreFields: string[] | Record<string, string[]> (fields to ignore globally or per-screen)
// - ignoreActions: string[] | Record<string, string[]> (actions to ignore globally or per-screen)

import { parseHTML } from "npm:linkedom@0.18.4";
import { load as parseYaml } from "./interpreter/vendor/js-yaml.js";
import { fileURLToPath } from "node:url";

export type Finding = { severity: string; path: string; message: string };

export const fails = (findings: Finding[]) => findings.some((f) => f.severity !== "advisory");

export type ParityOptions = {
  ignoreRoutes?: string[];
  ignoreFields?: string[] | Record<string, string[]>;
  ignoreActions?: string[] | Record<string, string[]>;
};

export type InputSpec = {
  field: string;
  type: "text" | "multiline" | "select" | "checkbox" | string;
  placeholder?: string;
  required?: boolean;
};

export type ActionSpec = {
  target: string;
  normalized: string;
  name: string;
  role: "button" | "link";
};

/** Resolves an ignore configuration (array or screen-keyed map) for a specific screen. */
export function resolveIgnored(
  config: string[] | Record<string, string[]> | undefined,
  screenName: string,
): Set<string> {
  const set = new Set<string>();
  if (!config) return set;
  if (Array.isArray(config)) {
    for (const item of config) set.add(item);
    return set;
  }
  if (Array.isArray(config["*"])) {
    for (const item of config["*"]) set.add(item);
  }
  if (Array.isArray(config[screenName])) {
    for (const item of config[screenName]) set.add(item);
  }
  return set;
}

/** Normalizes Web links/forms and Native event URIs into canonical semantic intents. */
export function normalizeTarget(target: string): string {
  if (!target) return "";
  const t = target.trim();
  if (t === "#/" || t === "/" || t === "") return "NAVIGATE:home";
  if (t === "#/editor" || t === "/editor") return "NAVIGATE:editor";
  if (t.startsWith("#/article/") || t.startsWith("/article/")) return "VIEW:article";
  if (t.startsWith("#/profile/") || t.startsWith("/profile/")) return "VIEW:profile";
  if (t.startsWith("#/tag/") || t.startsWith("/tag/")) return "SELECT:tag";
  if (t.startsWith("#/older/") || t.startsWith("/older/")) return "NAVIGATE:older";
  if (t.includes("publish-article") || t.includes("PUBLISH_ARTICLE")) return "ACTION:publish_article";

  if (t.startsWith("pronto://event/")) {
    const raw = t.replace("pronto://event/", "");
    const [action, qs] = raw.split("?");
    const params = new URLSearchParams(qs || "");
    if (action === "NAVIGATE") return `NAVIGATE:${params.get("screen") || "home"}`;
    if (action === "VIEW_ARTICLE") return "VIEW:article";
    if (action === "PUBLISH_ARTICLE") return "ACTION:publish_article";
    if (action === "SELECT_TAG") return "SELECT:tag";
    if (action === "SELECT_TAB") return `TAB:${params.get("tab") || ""}`;
    return `ACTION:${action.toLowerCase()}`;
  }

  if (t.startsWith("form:")) {
    const f = t.replace("form:", "");
    if (f.includes("publish")) return "ACTION:publish_article";
    return `ACTION:${f.toLowerCase()}`;
  }

  return t;
}

/** Extract writable input controls from LinkeDOM HTML document. */
export function extractWebInputs(root: any, ignored: Set<string>): Map<string, InputSpec> {
  const map = new Map<string, InputSpec>();
  const nodes = root.querySelectorAll("input, textarea, select");
  for (const el of nodes) {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "hidden" || type === "submit") continue;
    const name = el.getAttribute("name") || el.getAttribute("id");
    if (!name || ignored.has(name)) continue;
    const isMultiline = el.tagName === "TEXTAREA";
    map.set(name, {
      field: name,
      type: isMultiline ? "multiline" : type,
      placeholder: el.getAttribute("placeholder") || el.getAttribute("aria-label") || undefined,
      required: el.hasAttribute("required"),
    });
  }
  return map;
}

/** Extract interactive actions and submit triggers from LinkeDOM HTML document. */
export function extractWebActions(root: any, ignored: Set<string>): Map<string, ActionSpec> {
  const map = new Map<string, ActionSpec>();
  const btns = root.querySelectorAll("button, [role='button'], input[type='submit']");
  for (const el of btns) {
    const form = el.closest ? el.closest("form") : null;
    const formAction = form?.getAttribute("data-form") || form?.getAttribute("data-action");
    const explicitAction = el.getAttribute("data-action");
    const target = explicitAction || (formAction ? `form:${formAction}` : el.getAttribute("name") || el.textContent?.trim());
    if (!target || ignored.has(target)) continue;
    const norm = normalizeTarget(target);
    map.set(norm, {
      target,
      normalized: norm,
      name: el.textContent?.trim() || el.getAttribute("aria-label") || target,
      role: "button",
    });
  }

  const links = root.querySelectorAll("a[href]");
  for (const el of links) {
    const href = el.getAttribute("href");
    if (!href || href === "#" || ignored.has(href)) continue;
    const norm = normalizeTarget(href);
    map.set(norm, {
      target: href,
      normalized: norm,
      name: el.textContent?.trim() || el.getAttribute("aria-label") || href,
      role: "link",
    });
  }
  return map;
}

/** Extract inputs from DivKit JSON AST. */
export function extractDivInputs(root: any, ignored: Set<string>): Map<string, InputSpec> {
  const map = new Map<string, InputSpec>();
  function walk(node: any) {
    if (!node || typeof node !== "object") return;
    if (node.type === "input") {
      const field = node.id || node.accessibility?.description;
      if (field && !ignored.has(field)) {
        const isMultiline = node.keyboard_type === "multi_line_text";
        map.set(field, {
          field,
          type: isMultiline ? "multiline" : "text",
          placeholder: node.hint_text,
        });
      }
    }
    if (Array.isArray(node.items)) {
      for (const item of node.items) walk(item);
    }
  }
  walk(root);
  return map;
}

/** Extract actions from DivKit JSON AST. */
export function extractDivActions(root: any, ignored: Set<string>): Map<string, ActionSpec> {
  const map = new Map<string, ActionSpec>();
  function walk(node: any) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.actions)) {
      for (const act of node.actions) {
        const url = act.url || act.log_id;
        if (!url || ignored.has(url)) continue;
        const norm = normalizeTarget(url);
        map.set(norm, {
          target: url,
          normalized: norm,
          name: node.text || act.log_id || url,
          role: "button",
        });
      }
    }
    if (Array.isArray(node.items)) {
      for (const item of node.items) walk(item);
    }
  }
  walk(root);
  return map;
}

/** Compare web and native affordances for a single route. */
export function compareScreenAffordances(
  pathOrScreen: string,
  webInputs: Map<string, InputSpec>,
  nativeInputs: Map<string, InputSpec>,
  webActions: Map<string, ActionSpec>,
  nativeActions: Map<string, ActionSpec>,
): Finding[] {
  const findings: Finding[] = [];

  // 1. Input Affordance Completeness
  for (const [field, w] of webInputs) {
    const n = nativeInputs.get(field);
    if (!n) {
      findings.push({
        severity: "error",
        path: pathOrScreen,
        message: `field '${field}' is an interactive input on web (<${w.type}>) but missing on native`,
      });
    } else if (w.type === "multiline" && n.type !== "multiline") {
      findings.push({
        severity: "major",
        path: pathOrScreen,
        message: `field '${field}' is a multiline textarea on web but single-line on native`,
      });
    }
  }

  for (const [field, n] of nativeInputs) {
    if (!webInputs.has(field)) {
      findings.push({
        severity: "error",
        path: pathOrScreen,
        message: `field '${field}' is an interactive input on native but missing on web`,
      });
    }
  }

  // 2. Action Affordance Completeness (primary web actions must have native peers)
  for (const [norm, w] of webActions) {
    if (norm.startsWith("ACTION:") || norm.startsWith("NAVIGATE:")) {
      if (!nativeActions.has(norm)) {
        findings.push({
          severity: "major",
          path: pathOrScreen,
          message: `action '${w.target}' (${w.normalized}) on web has no equivalent action trigger on native`,
        });
      }
    }
  }

  return findings;
}

/** Loads native SDUI screens by evaluating bundle or reading static templates. */
async function loadNativeScreens(appDir: URL, shell: any): Promise<Map<string, any>> {
  const screens = new Map<string, any>();
  const dirPath = fileURLToPath(appDir).replace(/\/+$/, "");

  const bundleCandidates = [
    shell.native?.bundle,
    "ios/bundle/realworld_bundle.js",
    "android/bundle/realworld_bundle.js",
  ].filter(Boolean) as string[];

  let bundlePath: string | null = null;
  for (const c of bundleCandidates) {
    const full = `${dirPath}/${c}`.replace(/\/+/g, "/");
    try {
      if ((await Deno.stat(full)).isFile) {
        bundlePath = full;
        break;
      }
    } catch {
      // not found, try next
    }
  }

  if (bundlePath) {
    const code = await Deno.readTextFile(bundlePath);
    let currentScreen = "home";
    let handler: ((act: string) => void) | null = null;

    const emitUiAst = (jsonStr: string) => {
      try {
        const parsed = JSON.parse(jsonStr);
        const cardDiv = parsed?.card?.states?.[0]?.div || parsed;
        screens.set(currentScreen, cardDiv);
      } catch {
        // ignore
      }
    };
    const onAction = (fn: (act: string) => void) => {
      handler = fn;
    };
    const storage = {
      kv: { get: () => null, set: () => {} },
      sql: { exec: () => [] },
    };

    try {
      const runner = new Function("emitUiAst", "onAction", "storage", code);
      runner(emitUiAst, onAction, storage);

      if (handler) {
        const dispatch = handler as (act: string) => void;
        for (const route of shell.routes || []) {
          const sc = route.screen;
          currentScreen = sc;
          if (sc === "article") {
            dispatch("pronto://event/VIEW_ARTICLE?slug=fixture");
          } else {
            dispatch(`pronto://event/NAVIGATE?screen=${sc}`);
          }
        }
        currentScreen = "home";
        dispatch("pronto://event/NAVIGATE?screen=home");
      }
    } catch (e) {
      throw new Error(`failed to evaluate native bundle at ${bundlePath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  for (const route of shell.routes || []) {
    if (!screens.has(route.screen)) {
      const staticCandidates = [
        `${dirPath}/shell/native/${route.screen}.json`,
        `${dirPath}/screens/${route.screen}.json`,
      ];
      for (const p of staticCandidates) {
        try {
          const text = await Deno.readTextFile(p);
          screens.set(route.screen, JSON.parse(text));
          break;
        } catch {
          // continue
        }
      }
    }
  }

  return screens;
}

/** Check parity across all routes declared in an app directory with test-supplied options. */
export async function checkApp(
  appDir: URL,
  options: ParityOptions = {},
): Promise<{ findings: Finding[]; checked: number }> {
  const dirPath = fileURLToPath(appDir).replace(/\/+$/, "");
  const shellPath = `${dirPath}/shell/shell.yaml`;
  let shellDoc = "";
  try {
    shellDoc = await Deno.readTextFile(shellPath);
  } catch {
    return {
      findings: [{ severity: "error", path: shellPath, message: "no shell/shell.yaml found" }],
      checked: 0,
    };
  }

  const shell = (parseYaml(shellDoc) || {}) as {
    app?: string;
    routes?: Array<{
      path: string;
      screen: string;
      files?: { html?: string };
    }>;
    native?: boolean | { bundle?: string; screens?: string; enabled?: boolean };
  };

  const routes = shell.routes || [];
  if (routes.length === 0) {
    return {
      findings: [{ severity: "advisory", path: shellPath, message: "no routes declared in shell.yaml" }],
      checked: 0,
    };
  }

  // An app declares native targets via `native: true` or `native: { ... }` in shell.yaml,
  // matching the symmetry of `server: true` for backends.
  // Apps that omit `native` or set `native: false` are web-only (like truco, chess).
  const hasNativeTarget = shell.native === true || (typeof shell.native === "object" && shell.native.enabled !== false);
  if (!hasNativeTarget) {
    return {
      findings: [{ severity: "advisory", path: shellPath, message: `native targets not declared in ${shellPath}` }],
      checked: 0,
    };
  }

  const nativeScreens = await loadNativeScreens(appDir, shell);
  const findings: Finding[] = [];
  let checked = 0;

  for (const route of routes) {
    // Check if route is opted out in test options
    if (options.ignoreRoutes?.includes(route.path) || options.ignoreRoutes?.includes(route.screen)) {
      continue;
    }

    const htmlRel = route.files?.html || `shell/screens/${route.screen}.html`;
    const htmlFull = `${dirPath}/${htmlRel}`;
    let html = "";
    try {
      html = await Deno.readTextFile(htmlFull);
    } catch {
      findings.push({
        severity: "major",
        path: htmlRel,
        message: `route ${route.path} declares screen ${route.screen} but HTML file is missing`,
      });
      continue;
    }

    const { document } = parseHTML(html);
    const screenEl = document.querySelector(".screen, [data-screen]") || document;

    const nativeDiv = nativeScreens.get(route.screen);
    if (!nativeDiv) {
      findings.push({
        severity: "error",
        path: htmlRel,
        message: `screen '${route.screen}' (${route.path}) is implemented on web but has no native SDUI representation`,
      });
      continue;
    }

    const ignoredFields = resolveIgnored(options.ignoreFields, route.screen);
    const ignoredActions = resolveIgnored(options.ignoreActions, route.screen);

    const webInputs = extractWebInputs(screenEl, ignoredFields);
    const nativeInputs = extractDivInputs(nativeDiv, ignoredFields);
    const webActions = extractWebActions(screenEl, ignoredActions);
    const nativeActions = extractDivActions(nativeDiv, ignoredActions);

    const screenFindings = compareScreenAffordances(htmlRel, webInputs, nativeInputs, webActions, nativeActions);
    findings.push(...screenFindings);
    checked++;
  }

  return { findings, checked };
}

/** Unit self-tests for the parity checker logic and test options. */
export async function selfTest(): Promise<{ failures: string[] }> {
  const failures: string[] = [];

  const webHtml = `
    <section class="screen">
      <input name="title" required placeholder="Title">
      <textarea name="body" required placeholder="Body"></textarea>
      <input name="extra_web" placeholder="Extra Web">
      <button type="submit" data-action="publish-article">Publish</button>
      <button type="button" data-action="special-gesture">Special</button>
    </section>
  `;
  const nativeDiv = {
    type: "container",
    items: [
      { type: "input", id: "title", hint_text: "Title" },
      { type: "input", id: "body", keyboard_type: "multi_line_text", hint_text: "Body" },
      { type: "text", text: "Publish", actions: [{ url: "pronto://event/PUBLISH_ARTICLE" }] }
    ]
  };
  const { document: doc } = parseHTML(webHtml);
  const root = doc.querySelector(".screen") || doc;

  // 1. Without opt-outs: extra_web is missing on native
  const wInUnfiltered = extractWebInputs(root, new Set());
  const nIn = extractDivInputs(nativeDiv, new Set());
  const wActUnfiltered = extractWebActions(root, new Set());
  const nAct = extractDivActions(nativeDiv, new Set());
  const fUnfiltered = compareScreenAffordances("test", wInUnfiltered, nIn, wActUnfiltered, nAct);
  if (!fUnfiltered.some((f) => f.message.includes("extra_web"))) {
    failures.push(`expected extra_web error without opt-outs, got: ${JSON.stringify(fUnfiltered)}`);
  }

  // 2. With test options opt-out: extra_web and special-gesture ignored
  const ignoredFields = resolveIgnored(["extra_web"], "test");
  const ignoredActions = resolveIgnored(["special-gesture"], "test");
  const wInFiltered = extractWebInputs(root, ignoredFields);
  const wActFiltered = extractWebActions(root, ignoredActions);
  const fFiltered = compareScreenAffordances("test", wInFiltered, nIn, wActFiltered, nAct);
  if (fFiltered.length !== 0) {
    failures.push(`expected 0 findings when test opts out extra_web, got: ${JSON.stringify(fFiltered)}`);
  }

  // 3. Screen-scoped opt-outs via Record<string, string[]>
  const scopedFields = resolveIgnored({ editor: ["extra_web"] }, "editor");
  if (!scopedFields.has("extra_web")) {
    failures.push("scopedFields should contain extra_web for editor");
  }
  const otherScreenFields = resolveIgnored({ editor: ["extra_web"] }, "home");
  if (otherScreenFields.has("extra_web")) {
    failures.push("scopedFields should not contain extra_web for home");
  }

  return { failures };
}

export async function run(args: string[]): Promise<void> {
  if (args[0] === "--self-test") {
    const { failures } = await selfTest();
    for (const f of failures) console.error(`FAIL ${f}`);
    console.error(failures.length === 0 ? "check-parity self-test: passed" : `check-parity self-test: ${failures.length} failed`);
    Deno.exit(failures.length === 0 ? 0 : 1);
  }
  const appDir = args[0];
  if (appDir === undefined) {
    console.error("usage: check-parity.ts <appDir> | --self-test");
    Deno.exit(1);
  }
  const target = new URL(`${appDir.replace(/\/*$/, "")}/`, `file://${Deno.cwd()}/`);
  const { findings, checked } = await checkApp(target);
  console.log(JSON.stringify(findings, null, 2));
  console.error(`check-parity: ${checked} screen(s) checked; ${findings.length} finding(s).`);
  Deno.exit(fails(findings) ? 1 : 0);
}

if (import.meta.main) await run(Deno.args);
