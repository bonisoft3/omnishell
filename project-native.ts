// Deterministic compiler and runtime projection from Omnishell screen markup
// (shell/screens/*.{html,css}, shell/design.css, shell/shell.yaml) to:
//   1. Upstream DivKit SDUI JSON + DivVariableController descriptors (Phone: Android & iOS)
//   2. Rust `winio` Elm-like (init / update / render) widget trees (Desktop: macOS, Windows, Linux GTK/Qt)
//   3. Headless Omnishell native engine bundle (QuickJS / JavaScriptCore)
//
// Replaces hand-authored per-app native bundles and `check-parity.ts` by construction:
// every input, action, live region, CSS state rule, `data-kinetic` 3D slot,
// `canvas[data-layer]` fast HUD placeholder, and `data-touch-zone` derives from
// the single vetted screen source (`shell/screens/*.{html,css}`).

import { load as parseYaml } from "./interpreter/vendor/js-yaml.js";
import { fileURLToPath, pathToFileURL } from "node:url";

type HtmlAttr = { name: string; value: string };

class HtmlElementNode {
  tagName: string;
  attributes: HtmlAttr[];
  attrMap: Map<string, string>;
  children: HtmlElementNode[];
  textParts: string[];
  parent: HtmlElementNode | null;
  content?: HtmlElementNode;

  constructor(tagName: string, attributes: HtmlAttr[], parent: HtmlElementNode | null = null) {
    this.tagName = tagName.toLowerCase();
    this.attributes = attributes;
    this.attrMap = new Map(attributes.map((a) => [a.name, a.value]));
    this.children = [];
    this.textParts = [];
    this.parent = parent;
    if (this.tagName === "template") {
      this.content = this;
    }
  }

  getAttribute(name: string): string | null {
    const val = this.attrMap.get(name.toLowerCase());
    return val === undefined ? null : val;
  }

  hasAttribute(name: string): boolean {
    return this.attrMap.has(name.toLowerCase());
  }

  get textContent(): string {
    const parts: string[] = [...this.textParts];
    for (const c of this.children) {
      parts.push(c.textContent);
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  closest(tag: string): HtmlElementNode | null {
    const target = tag.toLowerCase();
    let cur: HtmlElementNode | null = this;
    while (cur) {
      if (cur.tagName === target) return cur;
      cur = cur.parent;
    }
    return null;
  }
}

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function decodeEntities(raw: string): string {
  return raw
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&larr;/g, "←")
    .replace(/&rarr;/g, "→")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&middot;/g, "·")
    .replace(/&nbsp;/g, " ");
}

function parseAttributes(attrText: string): HtmlAttr[] {
  const attrs: HtmlAttr[] = [];
  const re = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrText)) !== null) {
    const name = m[1].toLowerCase();
    const rawVal = m[2] ?? m[3] ?? m[4] ?? "";
    attrs.push({ name, value: decodeEntities(rawVal) });
  }
  return attrs;
}

function parseHtmlTree(html: string): HtmlElementNode {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");

  const root = new HtmlElementNode("document", []);
  const stack: HtmlElementNode[] = [root];

  const tokenRe = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)([^>]*?)(\/?)>|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(cleaned)) !== null) {
    const [, closing, rawTag, attrText, selfClose, textNode] = match;
    if (textNode !== undefined) {
      const t = decodeEntities(textNode).trim();
      if (t) {
        stack[stack.length - 1].textParts.push(t);
      }
      continue;
    }
    const tag = rawTag.toLowerCase();
    if (closing === "/") {
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].tagName === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const parent = stack[stack.length - 1];
    const el = new HtmlElementNode(tag, parseAttributes(attrText || ""), parent);
    parent.children.push(el);
    if (selfClose !== "/" && !VOID_TAGS.has(tag)) {
      stack.push(el);
    }
  }

  for (const child of root.children) {
    if (child.hasAttribute("data-screen") || (child.getAttribute("class") || "").split(/\s+/).includes("screen")) {
      return child;
    }
  }
  return root.children[0] || root;
}

export type ThemeTokens = {
  primary: string;
  secondary: string;
  accent: string;
  danger: string;
  neutral: string;
  surface: string;
  border: string;
  surfaceMuted: string;
  fontSans: string;
  fontSerif: string;
  fontMono: string;
};

export const DEFAULT_THEME: ThemeTokens = {
  primary: "#16181A",
  secondary: "#6B7076",
  accent: "#1D6A4F",
  danger: "#A93226",
  neutral: "#FBFAF7",
  surface: "#FFFFFF",
  border: "#E4E1D9",
  surfaceMuted: "#EFEDE6",
  fontSans: "sans-serif",
  fontSerif: "serif",
  fontMono: "monospace",
};

export type VisibilityMode = "all" | "keys-only" | "touch-only";

export type CssStateRule = {
  selector: string;
  attr: string;
  op: "eq" | "present" | "contains";
  value: string;
  targetClass: string;
  visible: boolean;
  negated: boolean;
};

export type NativeInputSpec = {
  field: string;
  kind: "text" | "multiline" | "range" | "select" | "checkbox";
  placeholder?: string;
  label?: string;
  required: boolean;
  min?: number;
  max?: number;
  valueBinding?: string;
};

export type NativeActionSpec = {
  id: string;
  kind: "navigate" | "form" | "handler" | "command" | "touch";
  url: string;
  label: string;
  route?: string;
  entity?: string;
  op?: string;
  handler?: string;
  command?: string;
};

export type NativeLiveSpec = {
  table: string;
  filter?: string;
  order?: string;
  select?: string;
  empty?: string;
  emptyRow?: Record<string, unknown>;
  project?: Record<string, unknown>;
  reads: string[];
  namedReads: Record<string, string>;
  when?: string;
};

export type NativeKineticSpec = {
  actor: string;
  props: Record<string, string>;
  events: Record<string, string>;
};

export type NativeHudLayerSpec = {
  layer: string;
  widthEm?: number;
  fill: boolean;
};

export type NativeTouchZoneSpec = {
  zones: string[];
  tap: boolean;
  seat?: number;
};

export type NativeNode = {
  id: string;
  tag: string;
  classes: string[];
  role?: string;
  ariaLabel?: string;
  visibility: VisibilityMode;
  hidden: boolean;
  orientation: "vertical" | "horizontal";
  text?: string;
  textBinding?: string;
  textFormat?: string;
  typography: "display" | "prose" | "meta" | "mono" | "body";
  stateAttrs: Record<string, string>;
  live?: NativeLiveSpec;
  kinetic?: NativeKineticSpec;
  kineticControls?: string;
  hudLayer?: NativeHudLayerSpec;
  touchZone?: NativeTouchZoneSpec;
  input?: NativeInputSpec;
  action?: NativeActionSpec;
  children: NativeNode[];
};

export type NativeScreenIr = {
  name: string;
  route: string;
  theme: string;
  root: NativeNode;
  stateRules: CssStateRule[];
  inputs: NativeInputSpec[];
  actions: NativeActionSpec[];
  hudLayers: NativeHudLayerSpec[];
  touchZones: NativeTouchZoneSpec[];
  kineticMounts: NativeKineticSpec[];
};

export type DivKitVariable = {
  name: string;
  type: "string" | "number" | "integer" | "boolean";
  value: string | number | boolean;
};

export type DivKitCard = {
  card: {
    log_id: string;
    variables: DivKitVariable[];
    states: Array<{
      state_id: number;
      div: Record<string, unknown>;
    }>;
  };
};

export type WinioWidgetSpec = {
  id: string;
  widget: "Window" | "StackPanel" | "Label" | "Button" | "Edit" | "Slider" | "LiveRegion" | "KineticSurface" | "HudLayer";
  orientation?: "Vertical" | "Horizontal";
  classes: string[];
  role?: string;
  accessibilityLabel?: string;
  text?: string;
  textBinding?: string;
  stateAttrs: Record<string, string>;
  liveTable?: string;
  liveFilter?: string;
  kineticActor?: string;
  kineticProps?: Record<string, string>;
  hudLayer?: string;
  hudWidthEm?: number;
  inputField?: string;
  inputKind?: string;
  inputPlaceholder?: string;
  inputMin?: number;
  inputMax?: number;
  actionUri?: string;
  children: WinioWidgetSpec[];
};

export type WinioScreenSpec = {
  screen: string;
  route: string;
  stateRules: CssStateRule[];
  root: WinioWidgetSpec;
};

export type NativeAppProjection = {
  app: string;
  theme: ThemeTokens;
  screens: Record<string, {
    ir: NativeScreenIr;
    divkit: DivKitCard;
    winio: WinioScreenSpec;
  }>;
  winioRustSource: string;
  nativeRuntimeLogic?: string;
};

/** Extract theme design tokens from shell/design.css if present. */
export function parseDesignTokens(cssText: string): ThemeTokens {
  const tokens: ThemeTokens = { ...DEFAULT_THEME };
  const readVar = (name: string): string | null => {
    const m =
      cssText.match(new RegExp(`--color-${name}\\s*:\\s*([^;]+);`)) ??
      cssText.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`));
    return m ? m[1].trim() : null;
  };
  const hexOf = (val: string | null, fallback: string): string => {
    if (!val) return fallback;
    const hexMatch = val.match(/#[0-9a-fA-F]{3,8}\b/);
    return hexMatch ? hexMatch[0] : fallback;
  };
  tokens.primary = hexOf(readVar("primary"), tokens.primary);
  tokens.secondary = hexOf(readVar("secondary"), tokens.secondary);
  tokens.accent = hexOf(readVar("accent"), tokens.accent);
  tokens.danger = hexOf(readVar("danger"), tokens.danger);
  tokens.neutral = hexOf(readVar("neutral"), tokens.neutral);
  tokens.surface = hexOf(readVar("surface"), tokens.surface);
  tokens.border = hexOf(readVar("border"), tokens.border);
  tokens.surfaceMuted = hexOf(readVar("surface-muted"), tokens.surfaceMuted);
  return tokens;
}

/** Split a selector list on top-level commas (outside parentheses and brackets). */
function splitTopLevelSelectors(rawSelectors: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < rawSelectors.length; i++) {
    const ch = rawSelectors[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      out.push(rawSelectors.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = rawSelectors.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/** Extract declarative data-* CSS state visibility rules from a screen stylesheet. */
export function parseCssStateRules(cssText: string): CssStateRule[] {
  const rules: CssStateRule[] = [];
  const clean = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  const blockRe = /([^{]+)\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(clean)) !== null) {
    const rawSelectors = match[1].trim();
    const body = match[2].trim();
    const displayNone = /display\s*:\s*none/i.test(body);
    const displayShow = /display\s*:\s*(?:flex|grid|block|inline-flex|inline-block|inline)/i.test(body);
    if (!displayNone && !displayShow) continue;

    for (const s of splitTopLevelSelectors(rawSelectors)) {
      const allAttrMatches = [...s.matchAll(/\[data-([a-z0-9-]+)(?:([~*^$|]?=)"([^"]*)")?\]/g)];
      if (allAttrMatches.length === 0) continue;
      const firstAttr = allAttrMatches[0];
      const [, attr, rawOp, firstVal] = firstAttr;
      const sameAttrVals = allAttrMatches
        .filter((m) => m[1] === attr && m[3] !== undefined)
        .map((m) => m[3]);
      const val = sameAttrVals.length > 1 ? sameAttrVals.join("|") : (firstVal ?? "");
      const op: "eq" | "present" | "contains" = !rawOp ? "present" : rawOp === "~=" || rawOp === "*=" ? "contains" : "eq";

      // Extract target class(es) or IDs after the last attribute selector (or on the subject element itself)
      const lastAttr = allAttrMatches[allAttrMatches.length - 1];
      const afterAttr = s.slice((lastAttr.index ?? 0) + lastAttr[0].length);
      const isMatch = afterAttr.match(/:is\(([^)]+)\)/);
      const targetClasses: string[] = [];
      if (isMatch) {
        for (const m of isMatch[1].matchAll(/[.#]([a-zA-Z0-9_-]+)/g)) {
          targetClasses.push(m[1]);
        }
      } else {
        const trailingTargets = [...afterAttr.matchAll(/[.#]([a-zA-Z0-9_-]+)/g)].map((m) => m[1]);
        if (trailingTargets.length > 0) {
          targetClasses.push(trailingTargets[trailingTargets.length - 1]);
        } else if (afterAttr.replace(/\)/g, "").trim() === "") {
          const leadingClasses = [...s.slice(0, firstAttr.index ?? 0).matchAll(/[.#]([a-zA-Z0-9_-]+)/g)].map((m) => m[1]);
          if (leadingClasses.length > 0) {
            targetClasses.push(leadingClasses[leadingClasses.length - 1]);
          }
        }
      }

      const beforeAttr = s.slice(0, firstAttr.index ?? 0);
      const notIdx = beforeAttr.lastIndexOf(":not(");
      const negated = notIdx !== -1 && !beforeAttr.slice(notIdx + 5).includes(")");

      if (targetClasses.length === 0) {
        rules.push({
          selector: s,
          attr,
          op,
          value: val ?? "",
          targetClass: "",
          visible: displayShow && !displayNone,
          negated,
        });
      } else {
        for (const tc of targetClasses) {
          rules.push({
            selector: s,
            attr,
            op,
            value: val ?? "",
            targetClass: tc,
            visible: displayShow && !displayNone,
            negated,
          });
        }
      }
    }
  }
  return rules;
}

/** Resolve `{msg.<key>}` placeholders against default locale messages when static text is empty. */
function interpolateMessages(raw: string | undefined, messages: Record<string, string>): string | undefined {
  if (raw === undefined) return undefined;
  return raw.replace(/\{msg\.([a-zA-Z0-9_.-]+)\}/g, (_, k) => messages[k] ?? k);
}

function classifyTypography(classes: string[]): "display" | "prose" | "meta" | "mono" | "body" {
  for (const c of classes) {
    if (c.includes("display") || c.includes("title")) return "display";
    if (c.includes("prose") || c.includes("serif")) return "prose";
    if (c.includes("mono") || c.includes("code") || c.includes("digits")) return "mono";
    if (c.includes("meta") || c.includes("label") || c.includes("sub")) return "meta";
  }
  return "body";
}

function inferOrientation(tag: string, classes: string[]): "vertical" | "horizontal" {
  if (tag === "header" || tag === "nav" || tag === "dl") return "horizontal";
  for (const c of classes) {
    if (
      c.includes("row") ||
      c.includes("bar") ||
      c.includes("strip") ||
      c.includes("chips") ||
      c.includes("arms") ||
      c.includes("head") ||
      c.includes("foot") ||
      c.includes("actions") ||
      c.includes("buttons") ||
      c.includes("btns") ||
      c.includes("pedals") ||
      c.includes("pad") ||
      c.includes("group")
    ) {
      return "horizontal";
    }
  }
  return "vertical";
}

function canonicalActionUrl(
  el: any,
  formEl: any,
  messages: Record<string, string>,
): NativeActionSpec | undefined {
  const tag = (el.tagName || "").toLowerCase();
  const id = el.getAttribute("id") || el.getAttribute("name") || el.getAttribute("data-form") || "";
  const rawLabel =
    interpolateMessages(el.getAttribute("data-text") || undefined, messages) ||
    el.textContent?.trim() ||
    interpolateMessages(el.getAttribute("aria-label") || undefined, messages) ||
    id ||
    tag;

  const touchZone = el.getAttribute("data-touch-zone");
  if (touchZone) {
    const tap = el.hasAttribute("data-touch-tap");
    const firstZone = touchZone.trim().split(/\s+/)[0];
    return {
      id: id || `touch_${firstZone}`,
      kind: "touch",
      url: `pronto://touch/${encodeURIComponent(touchZone.trim())}?tap=${tap ? "1" : "0"}`,
      label: rawLabel || firstZone,
    };
  }

  const dataRoute = el.getAttribute("data-route");
  if (dataRoute) {
    const params = new URLSearchParams();
    params.set("screen", dataRoute);
    for (const attr of el.attributes || []) {
      if (attr.name.startsWith("data-param-")) {
        params.set(attr.name.slice("data-param-".length), attr.value);
      }
    }
    if (el.hasAttribute("data-locale")) {
      params.set("locale", el.getAttribute("data-locale"));
    }
    const actionName = dataRoute === "article" ? "VIEW_ARTICLE" : dataRoute === "tag" ? "SELECT_TAG" : "NAVIGATE";
    if (actionName === "SELECT_TAG" && params.has("name")) {
      params.set("tag", params.get("name")!);
    }
    return {
      id: id || `nav_${dataRoute}`,
      kind: "navigate",
      route: dataRoute,
      url: `pronto://event/${actionName}?${params.toString()}`,
      label: rawLabel,
    };
  }

  if (tag === "a" && el.hasAttribute("href")) {
    const href = el.getAttribute("href") || "";
    if (href && href !== "#") {
      return {
        id: id || `link_${href}`,
        kind: "navigate",
        url: href.startsWith("pronto://") ? href : `pronto://event/NAVIGATE?href=${encodeURIComponent(href)}`,
        label: rawLabel,
      };
    }
  }

  if (tag === "button" || (tag === "input" && (el.getAttribute("type") || "").toLowerCase() === "submit")) {
    const explicitAction = el.getAttribute("data-action");
    const onClick = el.getAttribute("data-on-click");
    const command = el.getAttribute("command");
    const commandFor = el.getAttribute("commandfor");

    if (command) {
      return {
        id: id || `cmd_${command}`,
        kind: "command",
        command,
        handler: onClick || commandFor || undefined,
        url: `pronto://event/COMMAND?handler=${encodeURIComponent(onClick || commandFor || "")}&command=${encodeURIComponent(command)}&id=${encodeURIComponent(id)}`,
        label: rawLabel,
      };
    }

    if (onClick) {
      return {
        id: id || `click_${onClick}`,
        kind: "handler",
        handler: onClick,
        url: `pronto://event/CLICK?handler=${encodeURIComponent(onClick)}&id=${encodeURIComponent(id)}`,
        label: rawLabel,
      };
    }

    const ownerForm = formEl || (el.closest ? el.closest("form") : null);
    if (explicitAction || ownerForm) {
      const formName =
        explicitAction ||
        ownerForm?.getAttribute("data-form") ||
        ownerForm?.getAttribute("data-action") ||
        ownerForm?.getAttribute("data-entity") ||
        "submit";
      const entity = ownerForm?.getAttribute("data-entity") || undefined;
      const op = ownerForm?.getAttribute("data-action") || undefined;
      const route = ownerForm?.getAttribute("data-route") || undefined;
      if (formName === "publish-article") {
        return {
          id: id || "publish_article",
          kind: "form",
          entity,
          op,
          url: "pronto://event/PUBLISH_ARTICLE",
          label: rawLabel,
        };
      }
      if (formName === "search" || route === "search") {
        return {
          id: id || "search",
          kind: "form",
          route: "search",
          url: "pronto://event/SEARCH",
          label: rawLabel,
        };
      }
      return {
        id: id || `form_${formName}`,
        kind: "form",
        entity,
        op,
        url: `pronto://event/${formName.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`,
        label: rawLabel,
      };
    }
  }

  return undefined;
}

/** Parse one screen's HTML and CSS into the bound Omnishell NativeScreenIr. */
export function projectScreenIr(
  screenName: string,
  routePath: string,
  htmlText: string,
  cssText: string,
  messages: Record<string, string> = {},
): NativeScreenIr {
  const rootEl = parseHtmlTree(htmlText);
  const theme = rootEl?.getAttribute?.("data-theme") || "press";
  const stateRules = parseCssStateRules(cssText);

  const inputs: NativeInputSpec[] = [];
  const actions: NativeActionSpec[] = [];
  const hudLayers: NativeHudLayerSpec[] = [];
  const touchZones: NativeTouchZoneSpec[] = [];
  const kineticMounts: NativeKineticSpec[] = [];

  let autoId = 0;

  function walkElement(el: any, inheritedVisibility: VisibilityMode, enclosingSeat?: number): NativeNode | null {
    const tag = (el.tagName || "div").toLowerCase();
    if (tag === "script" || tag === "style" || tag === "svg") return null;

    const classAttr = el.getAttribute?.("class") || "";
    const classes = classAttr.split(/\s+/).filter(Boolean);
    if (classes.includes("skeleton") || classes.includes("skeleton-rail") || classes.includes("sr-only")) {
      return null;
    }

    let visibility: VisibilityMode = inheritedVisibility;
    if (classes.includes("keys-only")) visibility = "keys-only";
    else if (classes.includes("touch-only")) visibility = "touch-only";

    const hidden = el.hasAttribute?.("hidden") ?? false;
    const seatAttr = el.getAttribute?.("data-seat");
    const seat = seatAttr ? Number(seatAttr) : enclosingSeat;

    const id = el.getAttribute?.("id") || el.getAttribute?.("name") || `${screenName}_${tag}_${++autoId}`;
    const role = el.getAttribute?.("role") || undefined;
    const ariaLabel = interpolateMessages(el.getAttribute?.("aria-label") || undefined, messages);

    const stateAttrs: Record<string, string> = {};
    const kineticProps: Record<string, string> = {};
    const kineticEvents: Record<string, string> = {};
    const namedReads: Record<string, string> = {};

    const reservedData = new Set([
      "data-screen",
      "data-theme",
      "data-live",
      "data-filter",
      "data-order",
      "data-select",
      "data-empty",
      "data-empty-row",
      "data-project",
      "data-reads",
      "data-text",
      "data-text-format",
      "data-value",
      "data-kinetic",
      "data-kinetic-controls",
      "data-layer",
      "data-touch-zone",
      "data-touch-tap",
      "data-seat",
      "data-item",
      "data-when",
      "data-route",
      "data-form",
      "data-entity",
      "data-action",
      "data-on-click",
      "data-on-mutation",
    ]);

    for (const attr of el.attributes || []) {
      if (attr.name.startsWith("data-prop-")) {
        kineticProps[attr.name.slice("data-prop-".length)] = attr.value;
      } else if (attr.name.startsWith("data-on-") && attr.name !== "data-on-click" && attr.name !== "data-on-mutation") {
        kineticEvents[attr.name.slice("data-on-".length)] = attr.value;
      } else if (attr.name.startsWith("data-read-")) {
        namedReads[attr.name.slice("data-read-".length)] = attr.value;
      } else if (attr.name.startsWith("data-") && !reservedData.has(attr.name) && !attr.name.startsWith("data-param-")) {
        stateAttrs[attr.name.slice("data-".length)] = attr.value;
      }
    }

    let live: NativeLiveSpec | undefined;
    if (el.hasAttribute?.("data-live")) {
      const rawEmptyRow = el.getAttribute("data-empty-row");
      const emptyRow = rawEmptyRow
        ? (JSON.parse(rawEmptyRow) as Record<string, unknown>)
        : undefined;
      const rawProject = el.getAttribute("data-project");
      const project = rawProject
        ? (JSON.parse(rawProject) as Record<string, unknown>)
        : undefined;
      const reads = (el.getAttribute("data-reads") || "")
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
      live = {
        table: el.getAttribute("data-live"),
        filter: el.getAttribute("data-filter") || undefined,
        order: el.getAttribute("data-order") || undefined,
        select: el.getAttribute("data-select") || undefined,
        empty: interpolateMessages(el.getAttribute("data-empty") || undefined, messages),
        emptyRow,
        project,
        reads,
        namedReads,
        when: el.getAttribute("data-when") || undefined,
      };
    }

    let kinetic: NativeKineticSpec | undefined;
    if (el.hasAttribute?.("data-kinetic")) {
      kinetic = {
        actor: el.getAttribute("data-kinetic"),
        props: kineticProps,
        events: kineticEvents,
      };
      kineticMounts.push(kinetic);
    }

    const kineticControls = el.getAttribute?.("data-kinetic-controls") || undefined;

    let hudLayer: NativeHudLayerSpec | undefined;
    if (tag === "canvas" && el.hasAttribute?.("data-layer")) {
      const style = el.getAttribute("style") || "";
      const widthMatch = style.match(/width\s*:\s*([0-9.]+)em/);
      hudLayer = {
        layer: el.getAttribute("data-layer"),
        widthEm: widthMatch ? Number(widthMatch[1]) : undefined,
        fill: classes.includes("hud-layer-fill") || classes.includes("stk-layer"),
      };
      hudLayers.push(hudLayer);
    }

    let touchZone: NativeTouchZoneSpec | undefined;
    if (el.hasAttribute?.("data-touch-zone")) {
      const zones = el.getAttribute("data-touch-zone").trim().split(/\s+/).filter(Boolean);
      touchZone = {
        zones,
        tap: el.hasAttribute("data-touch-tap"),
        ...(seat !== undefined ? { seat } : {}),
      };
      touchZones.push(touchZone);
    }

    let input: NativeInputSpec | undefined;
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const inputType = (el.getAttribute("type") || "text").toLowerCase();
      if (inputType !== "hidden" && inputType !== "submit") {
        const field = el.getAttribute("name") || el.getAttribute("id") || id;
        const kind: NativeInputSpec["kind"] =
          tag === "textarea"
            ? "multiline"
            : tag === "select"
              ? "select"
              : inputType === "range"
                ? "range"
                : inputType === "checkbox"
                  ? "checkbox"
                  : "text";
        const placeholder = interpolateMessages(
          el.getAttribute("placeholder") || el.getAttribute("aria-label") || undefined,
          messages,
        );
        input = {
          field,
          kind,
          placeholder,
          required: el.hasAttribute("required"),
          ...(el.hasAttribute("min") ? { min: Number(el.getAttribute("min")) } : {}),
          ...(el.hasAttribute("max") ? { max: Number(el.getAttribute("max")) } : {}),
          ...(el.hasAttribute("data-value") ? { valueBinding: el.getAttribute("data-value") } : {}),
        };
        if (!inputs.some((i) => i.field === field)) {
          inputs.push(input);
        }
      }
    }

    const action = canonicalActionUrl(el, null, messages);
    if (action && !actions.some((a) => a.url === action.url && a.id === action.id)) {
      actions.push(action);
    }

    const rawTextBinding = el.getAttribute?.("data-text") || undefined;
    const textBinding = interpolateMessages(rawTextBinding, messages);
    const textFormat = el.getAttribute?.("data-text-format") || undefined;

    const children: NativeNode[] = [];
    for (const child of el.children || []) {
      const childTag = (child.tagName || "").toLowerCase();
      if (childTag === "template") {
        const tplWhen = child.getAttribute?.("data-when") || undefined;
        const contentRoot = child.content || child;
        for (const tplChild of contentRoot.children || []) {
          const walked = walkElement(tplChild, visibility, seat);
          if (walked) {
            if (tplWhen && walked.live) walked.live.when = tplWhen;
            children.push(walked);
          }
        }
        continue;
      }
      const walked = walkElement(child, visibility, seat);
      if (walked) children.push(walked);
    }

    let directText: string | undefined;
    if (children.length === 0) {
      const t = (el.textContent || "").trim();
      if (t.length > 0) directText = t;
    }

    return {
      id,
      tag,
      classes,
      role,
      ariaLabel,
      visibility,
      hidden,
      orientation: inferOrientation(tag, classes),
      text: directText,
      textBinding,
      textFormat,
      typography: classifyTypography(classes),
      stateAttrs,
      live,
      kinetic,
      kineticControls,
      hudLayer,
      touchZone,
      input,
      action,
      children,
    };
  }

  const root = walkElement(rootEl, "all") || {
    id: `${screenName}_root`,
    tag: "div",
    classes: ["screen"],
    visibility: "all",
    hidden: false,
    orientation: "vertical",
    typography: "body",
    stateAttrs: {},
    children: [],
  };

  return {
    name: screenName,
    route: routePath,
    theme,
    root,
    stateRules,
    inputs,
    actions,
    hudLayers,
    touchZones,
    kineticMounts,
  };
}

/**
 * Deterministic Phone Back-End: lowers a bound Omnishell NativeScreenIr to an
 * upstream DivKit SDUI Card JSON with `DivVariableController` variables and
 * `div-custom` mounts for `data-kinetic` (Filament 3D surface) and `canvas[data-layer]`.
 */
export function projectScreenToDivKit(
  screenIr: NativeScreenIr,
  theme: ThemeTokens = DEFAULT_THEME,
): DivKitCard {
  const variables: DivKitVariable[] = [];
  const seenVars = new Set<string>();
  const addVar = (name: string, type: DivKitVariable["type"], value: string | number | boolean) => {
    const clean = name.replace(/[^a-zA-Z0-9_]/g, "_");
    if (seenVars.has(clean)) return clean;
    seenVars.add(clean);
    variables.push({ name: clean, type, value });
    return clean;
  };

  for (const layer of screenIr.hudLayers) {
    addVar(`hud_${layer.layer}`, "string", "");
  }
  for (const inp of screenIr.inputs) {
    addVar(`input_${inp.field}`, "string", "");
  }

  function lowerNode(node: NativeNode): Record<string, unknown> | null {
    // Phone target omits keyboard-only hints and buttons (.keys-only), keeping .touch-only and shared UI.
    if (node.visibility === "keys-only" || node.hidden) return null;

    if (node.kinetic) {
      for (const [k, v] of Object.entries(node.kinetic.props)) {
        addVar(`kinetic_${node.kinetic.actor}_${k}`, "string", v);
      }
      return {
        type: "custom",
        id: `kinetic_${node.kinetic.actor}`,
        custom_type: `kinetic:${node.kinetic.actor}`,
        width: { type: "match_parent" },
        height: { type: "match_parent" },
        custom_props: {
          actor: node.kinetic.actor,
          props: node.kinetic.props,
          events: node.kinetic.events,
        },
      };
    }

    if (node.hudLayer) {
      const varName = addVar(`hud_${node.hudLayer.layer}`, "string", "");
      return {
        type: "custom",
        id: `layer_${node.hudLayer.layer}`,
        custom_type: `kinetic-layer:${node.hudLayer.layer}`,
        width: node.hudLayer.widthEm
          ? { type: "fixed", value: Math.round(node.hudLayer.widthEm * 14) }
          : { type: "match_parent" },
        height: { type: "wrap_content" },
        custom_props: {
          layer: node.hudLayer.layer,
          variable: `@{${varName}}`,
          fill: node.hudLayer.fill,
        },
      };
    }

    if (node.input) {
      const varName = addVar(`input_${node.input.field}`, "string", "");
      return {
        type: "input",
        id: node.input.field,
        hint_text: node.input.placeholder || node.input.field,
        text_variable: varName,
        keyboard_type: node.input.kind === "multiline" ? "multi_line_text" : "single_line_text",
        font_size: node.typography === "display" ? 20 : 15,
        font_family: node.typography === "prose" ? "serif" : "sans-serif",
        text_color: theme.primary,
        ...(node.input.placeholder
          ? { accessibility: { description: node.input.placeholder } }
          : {}),
      };
    }

    const childDivs: Record<string, unknown>[] = [];
    for (const child of node.children) {
      const lowered = lowerNode(child);
      if (lowered) childDivs.push(lowered);
    }

    const actions = node.action
      ? [{ log_id: node.action.id, url: node.action.url }]
      : undefined;

    const customProps: Record<string, unknown> = {};
    if (node.touchZone) {
      customProps.touch_zone = node.touchZone.zones.join(" ");
      customProps.touch_tap = node.touchZone.tap;
      if (node.touchZone.seat !== undefined) customProps.seat = node.touchZone.seat;
    }
    if (node.live) {
      customProps.data_live = node.live.table;
      if (node.live.filter) customProps.data_filter = node.live.filter;
      if (node.live.order) customProps.data_order = node.live.order;
    }
    if (Object.keys(node.stateAttrs).length > 0) {
      customProps.state_attrs = node.stateAttrs;
    }

    if (childDivs.length === 0) {
      const displayText = node.text ?? node.textBinding ?? node.action?.label ?? "";
      if (!displayText && !actions && !node.touchZone) return null;
      return {
        type: "text",
        id: node.id,
        text: displayText,
        font_size: node.typography === "display" ? 22 : node.typography === "meta" ? 12 : 15,
        font_weight: node.typography === "display" || node.tag === "b" || node.tag === "strong" || node.tag === "button" ? "bold" : "regular",
        font_family: node.typography === "prose" ? "serif" : "sans-serif",
        text_color: node.tag === "button" || node.tag === "a" ? theme.accent : theme.primary,
        ...(actions ? { actions } : {}),
        ...(Object.keys(customProps).length > 0 ? { extension_props: customProps } : {}),
      };
    }

    return {
      type: "container",
      id: node.id,
      orientation: node.orientation,
      items: childDivs,
      ...(actions ? { actions } : {}),
      ...(Object.keys(customProps).length > 0 ? { extension_props: customProps } : {}),
    };
  }

  const rootDiv = lowerNode(screenIr.root) || {
    type: "container",
    id: `${screenIr.name}_root`,
    orientation: "vertical",
    items: [],
  };

  return {
    card: {
      log_id: `omnishell_${screenIr.name}`,
      variables,
      states: [
        {
          state_id: 0,
          div: rootDiv,
        },
      ],
    },
  };
}

/**
 * Deterministic Desktop Back-End: lowers a bound Omnishell NativeScreenIr to
 * Rust `winio`'s Elm-like (`init` / `update` / `render`) native widget tree.
 */
export function projectScreenToWinio(screenIr: NativeScreenIr): WinioScreenSpec {
  function lowerNode(node: NativeNode, isRoot = false): WinioWidgetSpec | null {
    // Desktop target omits coarse-pointer touch controls (.touch-only), keeping .keys-only and shared UI.
    if (node.visibility === "touch-only" || node.hidden) return null;

    if (node.kinetic) {
      return {
        id: `kinetic_${node.kinetic.actor}`,
        widget: "KineticSurface",
        classes: node.classes,
        role: "img",
        accessibilityLabel: node.ariaLabel || node.kinetic.actor,
        stateAttrs: node.stateAttrs,
        kineticActor: node.kinetic.actor,
        kineticProps: node.kinetic.props,
        children: [],
      };
    }

    if (node.hudLayer) {
      return {
        id: `layer_${node.hudLayer.layer}`,
        widget: "HudLayer",
        classes: node.classes,
        stateAttrs: node.stateAttrs,
        hudLayer: node.hudLayer.layer,
        hudWidthEm: node.hudLayer.widthEm,
        children: [],
      };
    }

    if (node.input) {
      if (node.input.kind === "range") {
        return {
          id: node.id,
          widget: "Slider",
          classes: node.classes,
          role: "slider",
          accessibilityLabel: node.input.placeholder || node.input.field,
          stateAttrs: node.stateAttrs,
          inputField: node.input.field,
          inputKind: "range",
          inputMin: node.input.min ?? 0,
          inputMax: node.input.max ?? 100,
          children: [],
        };
      }
      return {
        id: node.id,
        widget: "Edit",
        classes: node.classes,
        role: "textbox",
        accessibilityLabel: node.input.placeholder || node.input.field,
        stateAttrs: node.stateAttrs,
        inputField: node.input.field,
        inputKind: node.input.kind,
        inputPlaceholder: node.input.placeholder,
        children: [],
      };
    }

    const children: WinioWidgetSpec[] = [];
    for (const c of node.children) {
      const w = lowerNode(c, false);
      if (w) children.push(w);
    }

    if (node.action && (node.tag === "button" || node.tag === "a")) {
      const buttonLabel =
        node.text ||
        node.textBinding ||
        children.map((c) => c.text || c.textBinding || "").filter(Boolean).join(" ").trim() ||
        node.action.label;
      return {
        id: node.id,
        widget: "Button",
        classes: node.classes,
        role: node.tag === "a" ? "link" : "button",
        accessibilityLabel: node.ariaLabel || buttonLabel,
        text: buttonLabel,
        textBinding: node.textBinding,
        stateAttrs: node.stateAttrs,
        actionUri: node.action.url,
        children: [],
      };
    }

    if (children.length === 0) {
      const text = node.text ?? node.textBinding;
      if (!text && !isRoot && !node.live) return null;
      return {
        id: node.id,
        widget: "Label",
        classes: node.classes,
        role: node.role,
        accessibilityLabel: node.ariaLabel || text,
        text,
        textBinding: node.textBinding,
        stateAttrs: node.stateAttrs,
        children: [],
      };
    }

    return {
      id: node.id,
      widget: isRoot ? "Window" : node.live ? "LiveRegion" : "StackPanel",
      orientation: node.orientation === "horizontal" ? "Horizontal" : "Vertical",
      classes: node.classes,
      role: node.role,
      accessibilityLabel: node.ariaLabel,
      stateAttrs: node.stateAttrs,
      liveTable: node.live?.table,
      liveFilter: node.live?.filter,
      actionUri: node.action?.url,
      children,
    };
  }

  const root = lowerNode(screenIr.root, true) || {
    id: `${screenIr.name}_window`,
    widget: "Window",
    orientation: "Vertical",
    classes: ["screen"],
    stateAttrs: {},
    children: [],
  };

  return {
    screen: screenIr.name,
    route: screenIr.route,
    stateRules: screenIr.stateRules,
    root,
  };
}

/** Emit a deterministic Rust module declaring the `winio` screen descriptors for an app. */
export function emitWinioRustSource(
  appName: string,
  screens: Record<string, WinioScreenSpec>,
): string {
  const screenNames = Object.keys(screens).sort();
  const lines: string[] = [
    "// Generated deterministically by omnishell project-native from shell/screens/*.{html,css} — do not edit.",
    "",
    `pub const APP_NAME: &str = ${JSON.stringify(appName)};`,
    `pub const SCREEN_NAMES: &[&str] = &[${screenNames.map((n) => JSON.stringify(n)).join(", ")}];`,
    "",
    "pub fn screen_spec_json(screen: &str) -> Option<&'static str> {",
    "    match screen {",
  ];
  for (const name of screenNames) {
    const json = JSON.stringify(screens[name]);
    lines.push(`        ${JSON.stringify(name)} => Some(${JSON.stringify(json)}),`);
  }
  lines.push("        _ => None,");
  lines.push("    }");
  lines.push("}");
  return lines.join("\n") + "\n";
}

/** Project all declared screens of an app into NativeScreenIr, DivKit JSON, and Rust `winio` specs. */
export async function projectAppNative(appDir: URL): Promise<NativeAppProjection> {
  const dirPath = fileURLToPath(appDir).replace(/\/+$/, "");
  const shellPath = `${dirPath}/shell/shell.yaml`;
  const shellText = await Deno.readTextFile(shellPath);
  const shell = (parseYaml(shellText) || {}) as {
    app?: string;
    i18n?: { default?: string };
    routes?: Array<{
      path: string;
      screen: string;
      files?: { html?: string; css?: string };
    }>;
  };

  let designCss = "";
  try {
    designCss = await Deno.readTextFile(`${dirPath}/shell/design.css`);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  const theme = parseDesignTokens(designCss);

  let defaultMessages: Record<string, string> = {};
  const defaultLocale = shell.i18n?.default || "en";
  try {
    const msgText = await Deno.readTextFile(`${dirPath}/messages/${defaultLocale}.json`);
    defaultMessages = JSON.parse(msgText);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }

  const screens: NativeAppProjection["screens"] = {};
  const winioMap: Record<string, WinioScreenSpec> = {};

  const routes = shell.routes || [];
  for (const route of routes) {
    const screenName = route.screen;
    if (screens[screenName]) continue;
    const htmlRel = route.files?.html || `shell/screens/${screenName}.html`;
    const cssRel = route.files?.css || `shell/screens/${screenName}.css`;
    const htmlText = await Deno.readTextFile(`${dirPath}/${htmlRel}`);
    let cssText = "";
    try {
      cssText = await Deno.readTextFile(`${dirPath}/${cssRel}`);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
    const ir = projectScreenIr(screenName, route.path, htmlText, cssText, defaultMessages);
    const divkit = projectScreenToDivKit(ir, theme);
    const winio = projectScreenToWinio(ir);
    screens[screenName] = { ir, divkit, winio };
    winioMap[screenName] = winio;
  }

  let nativeRuntimeLogic: string | undefined;
  try {
    nativeRuntimeLogic = await Deno.readTextFile(`${dirPath}/android/bundle/runtime_logic.js`);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }

  const appName = shell.app || "app";
  const winioRustSource = emitWinioRustSource(appName, winioMap);

  return {
    app: appName,
    theme,
    screens,
    winioRustSource,
    ...(nativeRuntimeLogic ? { nativeRuntimeLogic } : {}),
  };
}

/** Self-test verifying deterministic DivKit and `winio` projection from Omnishell screen markup. */
export async function selfTest(): Promise<{ failures: string[] }> {
  const failures: string[] = [];
  const check = (cond: boolean, msg: string) => {
    if (!cond) failures.push(msg);
  };

  // 1. Test editorial form & list screen projection (RealWorld style)
  const editorHtml = `
    <section class="screen" data-screen="editor">
      <a class="back" data-route="home" data-text="{msg.back}">← Community</a>
      <div class="byline" data-live="me">
        <template data-item><bdi data-text="{handle}"></bdi></template>
      </div>
      <form data-form="publish-article" data-entity="article" data-action="create">
        <input name="title" required placeholder="{msg.title_ph}">
        <textarea name="body" required placeholder="Write your article"></textarea>
        <input name="cover_credit" placeholder="Cover credit">
        <button type="submit">Publish</button>
      </form>
    </section>
  `;
  const editorIr = projectScreenIr("editor", "/editor", editorHtml, "", {
    back: "← Community",
    title_ph: "Article Title",
  });
  check(editorIr.inputs.length === 3, `expected 3 inputs, got ${editorIr.inputs.length}`);
  check(editorIr.inputs.some((i) => i.field === "cover_credit"), "expected cover_credit input in IR");
  check(editorIr.inputs.find((i) => i.field === "body")?.kind === "multiline", "expected body to be multiline");

  const editorDiv = projectScreenToDivKit(editorIr);
  const editorDivStr = JSON.stringify(editorDiv);
  check(editorDivStr.includes('"id":"cover_credit"'), "DivKit projection must include cover_credit input");
  check(editorDivStr.includes('"keyboard_type":"multi_line_text"'), "DivKit projection must preserve multiline textarea");
  check(editorDivStr.includes("pronto://event/PUBLISH_ARTICLE"), "DivKit projection must include publish action");

  const editorWinio = projectScreenToWinio(editorIr);
  const editorWinioStr = JSON.stringify(editorWinio);
  check(editorWinioStr.includes('"widget":"Edit"'), "winio projection must include Edit widgets");
  check(editorWinioStr.includes('"widget":"Button"'), "winio projection must include Button widgets");

  // 2. Test kinetic screen projection (Apex Run style: data-kinetic, canvas[data-layer], data-touch-zone, keys-only vs touch-only)
  const arenaHtml = `
    <div class="screen" data-screen="arena">
      <div class="arena-run" data-live="run" data-phase="{phase}">
        <div class="arena-race" data-kinetic="race" data-prop-seed="{seed}" data-prop-phase="{phase}" data-on-milestone="run"></div>
        <canvas data-layer="speed" class="hud-layer" style="width: 1.9em"></canvas>
        <button type="button" class="keys-only" id="stk-pause-btn" data-on-click="run">PAUSE [ESC]</button>
        <div class="touch-deck touch-only">
          <span data-touch-zone="drive left">◀</span>
          <span data-touch-zone="nitro">NITRO</span>
          <span data-touch-zone="pause" data-touch-tap>❚❚</span>
        </div>
      </div>
    </div>
  `;
  const arenaCss = `
    .arena-run[data-phase="title"] .stk-title-card { display: flex; }
    .arena-run:not([data-phase="title"]) .stk-title-card { display: none; }
  `;
  const arenaIr = projectScreenIr("arena", "/", arenaHtml, arenaCss);
  check(arenaIr.kineticMounts.length === 1 && arenaIr.kineticMounts[0].actor === "race", "expected kinetic actor 'race'");
  check(arenaIr.hudLayers.length === 1 && arenaIr.hudLayers[0].layer === "speed", "expected HUD layer 'speed'");
  check(arenaIr.touchZones.length === 3, `expected 3 touch zones, got ${arenaIr.touchZones.length}`);
  check(arenaIr.stateRules.length === 2, `expected 2 CSS state rules, got ${arenaIr.stateRules.length}`);
  check(
    arenaIr.stateRules[0].visible === true && arenaIr.stateRules[0].negated === false,
    "expected first CSS rule to be visible and non-negated",
  );
  check(
    arenaIr.stateRules[1].visible === false && arenaIr.stateRules[1].negated === true,
    "expected second CSS rule (:not) to be hidden and negated",
  );
  const parsedTheme = parseDesignTokens(":root { --primary: light-dark(#1E1A17, #F5F7FA); --accent: light-dark(#C2410C, #FFB347); }");
  check(parsedTheme.primary === "#1E1A17" && parsedTheme.accent === "#C2410C", "expected parseDesignTokens to extract light-dark hex tokens");

  const arenaDiv = projectScreenToDivKit(arenaIr);
  const arenaDivJson = JSON.stringify(arenaDiv);
  check(arenaDivJson.includes('"custom_type":"kinetic:race"'), "Phone DivKit must mount kinetic:race via div-custom");
  check(arenaDivJson.includes('"custom_type":"kinetic-layer:speed"'), "Phone DivKit must mount kinetic-layer:speed");
  check(!arenaDivJson.includes("stk-pause-btn"), "Phone DivKit must omit .keys-only pause button");
  check(arenaDivJson.includes('"touch_zone":"drive left"'), "Phone DivKit must include .touch-only zones");

  const arenaWinio = projectScreenToWinio(arenaIr);
  const arenaWinioJson = JSON.stringify(arenaWinio);
  check(arenaWinioJson.includes('"widget":"KineticSurface"'), "Desktop winio must mount KineticSurface");
  check(arenaWinioJson.includes('"widget":"HudLayer"'), "Desktop winio must mount HudLayer");
  check(arenaWinioJson.includes("stk-pause-btn"), "Desktop winio must include .keys-only pause button");
  check(!arenaWinioJson.includes("drive left"), "Desktop winio must omit .touch-only zones");

  return { failures };
}

/** Emit a deterministic headless JS runtime bundle driven by projected screen markup. */
export function emitNativeRuntimeBundle(projection: NativeAppProjection): string {
  const themeJson = JSON.stringify(projection.theme, null, 4);
  const screensMeta: Record<string, {
    route: string;
    inputs: NativeInputSpec[];
    actions: NativeActionSpec[];
    hudLayers: NativeHudLayerSpec[];
    touchZones: NativeTouchZoneSpec[];
    kineticMounts: NativeKineticSpec[];
    divkit: DivKitCard;
    winio: WinioScreenSpec;
  }> = {};
  for (const [name, entry] of Object.entries(projection.screens)) {
    screensMeta[name] = {
      route: entry.ir.route,
      inputs: entry.ir.inputs,
      actions: entry.ir.actions,
      hudLayers: entry.ir.hudLayers,
      touchZones: entry.ir.touchZones,
      kineticMounts: entry.ir.kineticMounts,
      divkit: entry.divkit,
      winio: entry.winio,
    };
  }
  const projectionJson = JSON.stringify({
    app: projection.app,
    theme: projection.theme,
    screens: screensMeta,
  });

  return `// Deterministic Omnishell Native Bundle generated by plugins/omnishell/project-native.ts
// Source of truth: shell/screens/*.{html,css}, shell/design.css, shell/shell.yaml

(function() {
    "use strict";

    const PROJECTION = ${projectionJson};
    globalThis.__omnishellProjection = PROJECTION;
    globalThis.__omnishellWinioSpec = function(screenName) {
        const entry = PROJECTION.screens[screenName || state.screen];
        return entry ? JSON.stringify(entry.winio) : null;
    };

    const THEME = ${themeJson};

    let state = {
        screen: Object.keys(PROJECTION.screens)[0] || "home",
        variables: {}
    };

    class ElectricShapeClient {
        constructor(storage, options) {
            this.storage = storage;
            this.baseUrl = (options && options.baseUrl) || "/electric/v1/shapes";
            this.subscriptions = new Map();
        }

        getOffset(table) {
            if (!this.storage || !this.storage.kv) return "-1";
            return this.storage.kv.get("electric_offset_" + table) || "-1";
        }

        setOffset(table, offset) {
            if (this.storage && this.storage.kv) {
                this.storage.kv.set("electric_offset_" + table, String(offset));
            }
        }

        applyMessage(table, pkColumns, msg) {
            if (!msg || !msg.headers || !this.storage || !this.storage.sql) return;
            const op = msg.headers.operation;
            const val = msg.value;

            if (op === "insert" || op === "update") {
                if (!val) return;
                const cols = Object.keys(val);
                const placeholders = cols.map(() => "?").join(", ");
                const colNames = cols.join(", ");
                const sql = \`INSERT OR REPLACE INTO \${table} (\${colNames}) VALUES (\${placeholders});\`;
                const params = cols.map(c => val[c]);
                this.storage.sql.exec(sql, params);
            } else if (op === "delete") {
                const whereClauses = pkColumns.map(col => \`\${col} = ?\`).join(" AND ");
                const params = pkColumns.map(col => (val && val[col]) || msg.key);
                const sql = \`DELETE FROM \${table} WHERE \${whereClauses};\`;
                this.storage.sql.exec(sql, params);
            }

            if (msg.offset != null) {
                this.setOffset(table, msg.offset);
            }
        }

        applyBatch(table, pkColumns, messages) {
            for (const msg of messages) {
                this.applyMessage(table, pkColumns, msg);
            }
        }

        subscribeLive(table, pkColumns, shapeUrl, onUpdate) {
            const offset = this.getOffset(table);
            const fullUrl = \`\${shapeUrl || (this.baseUrl + "?table=" + table)}&live=true&live_sse=true&offset=\${encodeURIComponent(offset)}\`;
            if (typeof EventSource === "undefined") return null;

            const es = new EventSource(fullUrl);
            es.onmessage = (event) => {
                const data = JSON.parse(event.data);
                if (Array.isArray(data)) {
                    this.applyBatch(table, pkColumns, data);
                } else {
                    this.applyMessage(table, pkColumns, data);
                }
                if (onUpdate) onUpdate(table);
            };
            this.subscriptions.set(table, es);
            return es;
        }

        close() {
            for (const [_, es] of this.subscriptions) {
                es.close();
            }
            this.subscriptions.clear();
        }
    }

    const electricClient = typeof __omnishellStorage !== "undefined"
        ? new ElectricShapeClient(__omnishellStorage)
        : null;

    globalThis.__electricClient = electricClient;

${projection.nativeRuntimeLogic ? projection.nativeRuntimeLogic.trimEnd() : `
    function parseActionUri(uri) {
        if (!uri || !uri.startsWith("pronto://event/")) return null;
        const raw = uri.substring("pronto://event/".length);
        const qIdx = raw.indexOf("?");
        if (qIdx === -1) return { action: raw, params: {} };
        const action = raw.substring(0, qIdx);
        const params = {};
        for (const pair of raw.substring(qIdx + 1).split("&")) {
            const [k, v] = pair.split("=");
            if (k) params[decodeURIComponent(k)] = v ? decodeURIComponent(v.replace(/\\+/g, " ")) : "";
        }
        return { action, params };
    }

    function reduce(currState, actionUri) {
        const parsed = parseActionUri(actionUri);
        if (!parsed) return currState;
        const next = Object.assign({}, currState);
        const { action, params } = parsed;
        if (action === "NAVIGATE" && params.screen) {
            next.screen = params.screen;
        } else if (action === "INPUT" && params.field) {
            next.variables = Object.assign({}, next.variables, { [params.field]: params.value });
        } else {
            throw new Error("Unknown pronto://event/ action: " + action);
        }
        return next;
    }

    function projectToDivKit(s) {
        const entry = PROJECTION.screens[s.screen] || Object.values(PROJECTION.screens)[0];
        return entry ? entry.divkit : { card: { log_id: PROJECTION.app + "_sdui", states: [] } };
    }

    if (typeof emitUiAst === "function") {
        emitUiAst(JSON.stringify(projectToDivKit(state)));
    }

    if (typeof onAction === "function") {
        onAction(function(actionUri) {
            state = reduce(state, actionUri);
            if (typeof emitUiAst === "function") {
                emitUiAst(JSON.stringify(projectToDivKit(state)));
            }
        });
    }`}
})();
`;
}

export async function run(args: string[]): Promise<void> {
  if (args[0] === "--self-test") {
    const { failures } = await selfTest();
    for (const f of failures) console.error(`FAIL ${f}`);
    console.error(failures.length === 0 ? "project-native self-test: passed" : `project-native self-test: ${failures.length} failed`);
    Deno.exit(failures.length === 0 ? 0 : 1);
  }
  if (args[0] === "--emit-bundle") {
    const appDir = args[1];
    if (!appDir) {
      console.error("usage: project-native.ts --emit-bundle <appDir>");
      Deno.exit(1);
    }
    const target = new URL(`${appDir.replace(/\/*$/, "")}/`, pathToFileURL(`${Deno.cwd()}/`));
    const projection = await projectAppNative(target);
    const buf = new TextEncoder().encode(emitNativeRuntimeBundle(projection));
    let off = 0;
    while (off < buf.length) {
      off += Deno.stdout.writeSync(buf.subarray(off));
    }
    return;
  }
  const appDir = args[0];
  if (appDir === undefined) {
    console.error("usage: project-native.ts <appDir> | --emit-bundle <appDir> | --self-test");
    Deno.exit(1);
  }
  const target = new URL(`${appDir.replace(/\/*$/, "")}/`, pathToFileURL(`${Deno.cwd()}/`));
  const projection = await projectAppNative(target);
  console.log(JSON.stringify(projection));
}

if (import.meta.main) await run(Deno.args);
