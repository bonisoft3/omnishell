// Deterministic compiler and runtime projection from Omnishell screen markup
// (shell/screens/*.{html,css}, screens/*.html, shell/design.css, shell/shell.yaml) to:
//   1. Upstream DivKit SDUI JSON + DivVariableController descriptors (Phone: Android & iOS)
//   2. Rust `winio` Elm-like (init / update / render) widget trees (Desktop: macOS, Windows, Linux GTK/Qt)
//   3. Headless Omnishell native engine bundle (QuickJS / JavaScriptCore)

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

export const BLANK_SVG_DATA_URI =
  "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%221%22%20height%3D%221%22%2F%3E";

const BINDING_PLACEHOLDER_RE = /\{([a-zA-Z0-9_.\[\]]+)\}/;

/**
 * Resolve an image source (`data-image-src` or `img[src]`) for DivKit `div-image`:
 *   - Inline `data:image/svg+xml;utf8,...` / `;base64,...` Level-0 card placeholders stay inline
 *     (normalizing raw XML delimiters in `;utf8,` payloads when unescaped).
 *   - Same-origin `/img/*` paths resolve against `origin` (`https://snapcards.fun`).
 *   - Empty sources map to a 1x1 transparent SVG data URI so DivKit never fetches an empty string.
 */
export function resolveNativeImageUrl(
  rawSrc: string,
  origin = "https://snapcards.fun",
): string {
  const trimmed = (rawSrc || "").trim();
  if (!trimmed) return BLANK_SVG_DATA_URI;

  if (trimmed.startsWith("data:image/svg+xml")) {
    const utf8Prefix = "data:image/svg+xml;utf8,";
    if (trimmed.startsWith(utf8Prefix)) {
      const payload = trimmed.slice(utf8Prefix.length);
      if (payload.includes("<") || payload.includes("#") || payload.includes('"')) {
        const encoded = payload
          .replace(/%/g, "%25")
          .replace(/#/g, "%23")
          .replace(/</g, "%3C")
          .replace(/>/g, "%3E")
          .replace(/"/g, "%22");
        return utf8Prefix + encoded;
      }
    }
    return trimmed;
  }

  if (trimmed.startsWith("data:") || trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
    return trimmed;
  }

  const cleanOrigin = origin.replace(/\/+$/, "");
  if (trimmed.startsWith("/")) {
    return `${cleanOrigin}${trimmed}`;
  }
  return `${cleanOrigin}/${trimmed}`;
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

export const DEFAULT_DARK_THEME: ThemeTokens = {
  primary: "#F7F5F0",
  secondary: "#9CA3AF",
  accent: "#FBBF24",
  danger: "#EF4444",
  neutral: "#090E17",
  surface: "#111827",
  border: "#1F2937",
  surfaceMuted: "#1A2234",
  fontSans: "sans-serif",
  fontSerif: "serif",
  fontMono: "monospace",
};

export type ThemePalettes = {
  light: ThemeTokens;
  dark: ThemeTokens;
};

const RTL_LANGS = new Set(["he", "iw", "ar", "fa", "ur", "yi"]);

export function directionOfLocale(locale?: string): "ltr" | "rtl" {
  if (!locale) return "ltr";
  const prefix = locale.trim().toLowerCase().split(/[-_]/)[0];
  return RTL_LANGS.has(prefix) ? "rtl" : "ltr";
}

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
  kind: "text" | "multiline" | "range" | "select" | "checkbox" | "number";
  placeholder?: string;
  label?: string;
  required: boolean;
  min?: number;
  max?: number;
  valueBinding?: string;
};

export type NativeActionSpec = {
  id: string;
  kind: "navigate" | "form" | "handler" | "command" | "touch" | "popover" | "auth" | "chart" | "bridge";
  url: string;
  label: string;
  route?: string;
  entity?: string;
  op?: string;
  handler?: string;
  command?: string;
  popoverTarget?: string;
  popoverOp?: "toggle" | "show" | "hide";
};

export type NativeImageSpec = {
  src: string;
  isResponsiveBinding: boolean;
  sizes?: string;
  alt?: string;
  width?: number;
  height?: number;
  scale: "fit" | "fill";
};

export type NativeSheetSpec = {
  kind: "popover" | "dialog" | "modal";
  sheetId: string;
  stateVar: string;
};

export type NativeFlipCardSpec = {
  flippedBinding: string;
  flippedVar: string;
};

export type NativeRealmSpec = {
  unit: string;
  customType: "web-realm" | "print-realm";
  isolation: "realm" | "agent" | "host-dom";
  grants: string[];
  src?: string;
  subdomain?: string;
  props: Record<string, string>;
  events: Record<string, string>;
};

export type NativeNavEntry = {
  screen: string;
  label: string;
  key?: string;
  icon?: string;
  params?: Record<string, string>;
};

export type NativeFoldSpec = {
  id: string;
  table: string;
  filter?: string;
  handler: string;
  reads: string[];
  namedReads: Record<string, string>;
  parentTable?: string;
  parentFilter?: string;
  parentEmptyRow?: Record<string, unknown>;
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
  isRepeater?: boolean;
  itemTemplates?: NativeNode[];
  onMutation?: string;
  cortexActor?: string;
  machineRef?: string;
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
  rawText?: string;
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
  extraActions?: NativeActionSpec[];
  image?: NativeImageSpec;
  sheet?: NativeSheetSpec;
  flipCard?: NativeFlipCardSpec;
  realm?: NativeRealmSpec;
  isProbe?: "owned" | "favorite" | "preload";
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
  realms?: NativeRealmSpec[];
  folds?: NativeFoldSpec[];
  chartTargets?: Record<string, { field: string; nextState?: string }>;
};

export type DivKitVariable = {
  name: string;
  type: "string" | "number" | "integer" | "boolean";
  value: string | number | boolean;
};

export type DivKitPaletteColor = {
  name: string;
  light: string;
  dark: string;
};

export type DivKitCard = {
  card: {
    log_id: string;
    variables: DivKitVariable[];
    palette?: DivKitPaletteColor[];
    omnishell_meta?: Record<string, unknown>;
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
  palettes?: ThemePalettes;
  navEntries?: NativeNavEntry[];
  defaultLocale?: string;
  locales?: string[];
  screens: Record<string, {
    ir: NativeScreenIr;
    divkit: DivKitCard;
    winio: WinioScreenSpec;
  }>;
  winioRustSource: string;
  nativeRuntimeLogic?: string;
};

export interface ScreenUnitDecl {
  isolation?: "realm" | "agent";
  src?: string;
  subdomain?: string;
  grants?: string[];
}

export interface ScreenIrOptions {
  legacyV1?: boolean;
  chartTargets?: Record<string, { field: string; nextState?: string }>;
  units?: Record<string, ScreenUnitDecl>;
  hostDom?: Record<string, { src?: string }>;
}

export interface DivKitProjectionOptions {
  legacyV1?: boolean;
  origin?: string;
  palettes?: ThemePalettes;
  themeMode?: "light" | "dark" | "auto";
  systemColorScheme?: "light" | "dark";
  locale?: string;
  viewportWidthDp?: number;
  navEntries?: NativeNavEntry[];
}

/** Extract both light and dark `light-dark(lightHex, darkHex)` palettes from CSS token declarations. */
export function parseDesignPalettes(cssText: string): ThemePalettes {
  const light: ThemeTokens = { ...DEFAULT_THEME };
  const dark: ThemeTokens = { ...DEFAULT_DARK_THEME };
  const readVar = (name: string): string | null => {
    const snapMatches = [...cssText.matchAll(new RegExp(`--snapcards-${name}\\s*:\\s*([^;]+);`, "g"))];
    if (snapMatches.length > 0) return snapMatches[snapMatches.length - 1][1].trim();
    const colorMatches = [...cssText.matchAll(new RegExp(`--color-${name}\\s*:\\s*([^;]+);`, "g"))];
    if (colorMatches.length > 0) return colorMatches[colorMatches.length - 1][1].trim();
    const plainMatches = [...cssText.matchAll(new RegExp(`--${name}\\s*:\\s*([^;]+);`, "g"))];
    if (plainMatches.length > 0) return plainMatches[plainMatches.length - 1][1].trim();
    return null;
  };
  const pairOf = (val: string | null, lightFallback: string, darkFallback: string): [string, string] => {
    if (!val) return [lightFallback, darkFallback];
    const hexes = [...val.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    if (hexes.length >= 2) return [hexes[0], hexes[1]];
    if (hexes.length === 1) return [hexes[0], hexes[0]];
    return [lightFallback, darkFallback];
  };
  [light.primary, dark.primary] = pairOf(readVar("primary"), light.primary, dark.primary);
  [light.secondary, dark.secondary] = pairOf(readVar("secondary"), light.secondary, dark.secondary);
  [light.accent, dark.accent] = pairOf(readVar("accent"), light.accent, dark.accent);
  [light.danger, dark.danger] = pairOf(readVar("danger"), light.danger, dark.danger);
  [light.neutral, dark.neutral] = pairOf(readVar("neutral"), light.neutral, dark.neutral);
  [light.surface, dark.surface] = pairOf(readVar("surface"), light.surface, dark.surface);
  [light.border, dark.border] = pairOf(readVar("border"), light.border, dark.border);
  [light.surfaceMuted, dark.surfaceMuted] = pairOf(readVar("surface-muted"), light.surfaceMuted, dark.surfaceMuted);
  return { light, dark };
}

/** Extract theme design tokens from shell/design.css if present. */
export function parseDesignTokens(cssText: string): ThemeTokens {
  return parseDesignPalettes(cssText).light;
}

export function buildDivKitPalette(palettes: ThemePalettes): DivKitPaletteColor[] {
  return [
    { name: "palette_primary", light: palettes.light.primary, dark: palettes.dark.primary },
    { name: "palette_secondary", light: palettes.light.secondary, dark: palettes.dark.secondary },
    { name: "palette_accent", light: palettes.light.accent, dark: palettes.dark.accent },
    { name: "palette_danger", light: palettes.light.danger, dark: palettes.dark.danger },
    { name: "palette_neutral", light: palettes.light.neutral, dark: palettes.dark.neutral },
    { name: "palette_surface", light: palettes.light.surface, dark: palettes.dark.surface },
    { name: "palette_border", light: palettes.light.border, dark: palettes.dark.border },
    { name: "palette_surface_muted", light: palettes.light.surfaceMuted, dark: palettes.dark.surfaceMuted },
  ];
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

function inferOrientation(tag: string, classes: string[], legacyV1 = false): "vertical" | "horizontal" {
  if (!legacyV1 && (tag === "aside" || tag === "section")) return "vertical";
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
      c.includes("group") ||
      (!legacyV1 &&
        (c.includes("switch") ||
          c.includes("tabs") ||
          c.includes("pills") ||
          c.includes("picks") ||
          c.includes("controls") ||
          c.includes("stepper") ||
          c.includes("meta") ||
          c.includes("btn-fav") ||
          c === "desk-locale-pill"))
    ) {
      return "horizontal";
    }
  }
  return "vertical";
}

function sanitizeVarName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_]/g, "_");
}

function sheetStateVarForId(sheetId: string): string {
  if (sheetId === "login-modal-overlay" || sheetId.startsWith("login-modal")) {
    return "modal_login_state";
  }
  return `sheet_${sanitizeVarName(sheetId)}_state`;
}

function canonicalActionUrl(
  el: HtmlElementNode,
  formEl: HtmlElementNode | null,
  messages: Record<string, string>,
  legacyV1 = false,
  chartTargets?: Record<string, { field: string; nextState?: string }>,
): { primary?: NativeActionSpec; extras: NativeActionSpec[] } {
  const tag = (el.tagName || "").toLowerCase();
  const id = el.getAttribute("id") || el.getAttribute("name") || el.getAttribute("data-form") || "";
  const rawLabel =
    interpolateMessages(el.getAttribute("data-text") || undefined, messages) ||
    el.textContent?.trim() ||
    interpolateMessages(el.getAttribute("aria-label") || undefined, messages) ||
    id ||
    tag;

  const extras: NativeActionSpec[] = [];

  if (!legacyV1 && el.hasAttribute("popovertarget")) {
    const targetId = el.getAttribute("popovertarget") || "";
    const rawOp = (el.getAttribute("popovertargetaction") || "toggle").toLowerCase();
    const popoverOp: "toggle" | "show" | "hide" =
      rawOp === "hide" ? "hide" : rawOp === "show" ? "show" : "toggle";
    if (targetId) {
      extras.push({
        id: id || `popover_${targetId}_${popoverOp}`,
        kind: "popover",
        popoverTarget: targetId,
        popoverOp,
        url: `pronto://event/POPOVER?target=${encodeURIComponent(targetId)}&op=${popoverOp}&id=${encodeURIComponent(id)}`,
        label: rawLabel,
      });
    }
  }

  const touchZone = el.getAttribute("data-touch-zone");
  if (touchZone) {
    const tap = el.hasAttribute("data-touch-tap");
    const firstZone = touchZone.trim().split(/\s+/)[0];
    return {
      primary: {
        id: id || `touch_${firstZone}`,
        kind: "touch",
        url: `pronto://touch/${encodeURIComponent(touchZone.trim())}?tap=${tap ? "1" : "0"}`,
        label: rawLabel || firstZone,
      },
      extras,
    };
  }

  const collectDatasetParams = (): URLSearchParams => {
    const ds = new URLSearchParams();
    if (legacyV1) return ds;
    for (const attr of el.attributes || []) {
      if (
        attr.name.startsWith("data-") &&
        !attr.name.startsWith("data-param-") &&
        attr.name !== "data-route" &&
        attr.name !== "data-on-click" &&
        attr.name !== "data-action" &&
        attr.name !== "data-form" &&
        attr.name !== "data-entity" &&
        attr.name !== "data-text" &&
        attr.name !== "data-locale" &&
        attr.name !== "data-locale-current" &&
        attr.name !== "data-host-dom" &&
        attr.name !== "data-auth-action" &&
        attr.name !== "data-auth-provider"
      ) {
        ds.set(`data_${attr.name.slice("data-".length)}`, attr.value);
      }
    }
    return ds;
  };
  const unescapeBraces = (s: string) => (legacyV1 ? s : s.replace(/%7B/gi, "{").replace(/%7D/gi, "}"));

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
      params.set("locale", el.getAttribute("data-locale")!);
    }
    const actionName = dataRoute === "article" ? "VIEW_ARTICLE" : dataRoute === "tag" ? "SELECT_TAG" : "NAVIGATE";
    if (actionName === "SELECT_TAG" && params.has("name")) {
      params.set("tag", params.get("name")!);
    }
    if (!legacyV1 && el.hasAttribute("data-on-click")) {
      const handler = el.getAttribute("data-on-click")!;
      const ds = collectDatasetParams();
      ds.set("handler", handler);
      ds.set("id", id);
      extras.unshift({
        id: id ? `${id}_click` : `click_${handler}`,
        kind: "handler",
        handler,
        url: `pronto://event/CLICK?${unescapeBraces(ds.toString())}`,
        label: rawLabel,
      });
    }
    return {
      primary: {
        id: id || `nav_${dataRoute}`,
        kind: "navigate",
        route: dataRoute,
        url: `pronto://event/${actionName}?${unescapeBraces(params.toString())}`,
        label: rawLabel,
      },
      extras,
    };
  }

  if (tag === "a" && el.hasAttribute("href")) {
    const href = el.getAttribute("href") || "";
    if (href && href !== "#") {
      return {
        primary: {
          id: id || `link_${href}`,
          kind: "navigate",
          url: href.startsWith("pronto://") ? href : `pronto://event/NAVIGATE?href=${encodeURIComponent(href)}`,
          label: rawLabel,
        },
        extras,
      };
    }
  }

  if (tag === "button" || (tag === "input" && (el.getAttribute("type") || "").toLowerCase() === "submit")) {
    const explicitAction = el.getAttribute("data-action");
    const onClick = el.getAttribute("data-on-click");
    const command = el.getAttribute("command");
    const commandFor = el.getAttribute("commandfor");

    if (!legacyV1) {
      const authAction = el.getAttribute("data-auth-action");
      const authProvider = el.getAttribute("data-auth-provider");
      if (authAction || authProvider) {
        const method = authProvider ? `oidc:${authProvider}` : authAction!;
        extras.push({
          id: id ? `${id}_auth` : `auth_${method}`,
          kind: "auth",
          url: `pronto://event/AUTH?method=${encodeURIComponent(method)}&id=${encodeURIComponent(id)}`,
          label: rawLabel,
        });
      }
      if (id === "btn-window-print" || id === "btn-print-trigger") {
        extras.push({
          id: `${id}_print_bridge`,
          kind: "bridge",
          url:
            `omnishell://print?job=Snapcards&source=window-print&button=${encodeURIComponent(id)}` +
            `&deck={set_id}&vendor={vendor}&paper={paper}&orientation={orientation}&card_size={card_size}&layout={layout}&cut_lines={cut_lines}`,
          label: rawLabel,
        });
      } else if (id === "btn-shop-download") {
        return {
          primary: {
            id,
            kind: "bridge",
            url: `omnishell://print?job=Snapcards&source=print-shop&format=pdf&deck={set_id}&orientation={orientation}`,
            label: rawLabel,
          },
          extras,
        };
      } else if (id === "btn-order-print") {
        return {
          primary: {
            id,
            kind: "popover",
            popoverTarget: "print-checkout-panel",
            popoverOp: "show",
            url: `pronto://event/POPOVER?target=print-checkout-panel&op=show&id=btn-order-print`,
            label: rawLabel,
          },
          extras,
        };
      } else if (id === "btn-checkout-close") {
        return {
          primary: {
            id,
            kind: "popover",
            popoverTarget: "print-checkout-panel",
            popoverOp: "hide",
            url: `pronto://event/POPOVER?target=print-checkout-panel&op=hide&id=btn-checkout-close`,
            label: rawLabel,
          },
          extras,
        };
      } else if (id === "btn-checkout-pay") {
        return {
          primary: {
            id,
            kind: "bridge",
            url: `omnishell://checkout?order={order_id}&deck={set_id}&return_url=${encodeURIComponent("snapcards://print/return")}`,
            label: rawLabel,
          },
          extras: [
            ...extras,
            {
              id: "btn-checkout-pay_event",
              kind: "handler",
              handler: "print-checkout",
              url: "pronto://event/CHECKOUT_PAY?id=btn-checkout-pay&order={order_id}",
              label: rawLabel,
            },
          ],
        };
      } else if (id === "btn-checkout-refresh") {
        return {
          primary: {
            id,
            kind: "handler",
            handler: "print-checkout",
            url: "pronto://event/ORDER_RECHECK?order={order_id}&id=btn-checkout-refresh",
            label: rawLabel,
          },
          extras,
        };
      } else if (el.hasAttribute("data-host-dom") && !command && !onClick && !explicitAction) {
        const hatch = el.getAttribute("data-host-dom") || "host-dom";
        return {
          primary: {
            id: id || `host_dom_${hatch}`,
            kind: "handler",
            handler: hatch,
            url: `pronto://event/HOST_DOM?hatch=${encodeURIComponent(hatch)}&id=${encodeURIComponent(id)}`,
            label: rawLabel,
          },
          extras,
        };
      }
    }

    if (command) {
      const ds = collectDatasetParams();
      ds.set("handler", onClick || commandFor || "");
      ds.set("command", command);
      ds.set("id", id);
      return {
        primary: {
          id: id || `cmd_${command}`,
          kind: "command",
          command,
          handler: onClick || commandFor || undefined,
          url: `pronto://event/COMMAND?${unescapeBraces(ds.toString())}`,
          label: rawLabel,
        },
        extras,
      };
    }

    if (onClick) {
      const ds = collectDatasetParams();
      ds.set("handler", onClick);
      ds.set("id", id);
      return {
        primary: {
          id: id || `click_${onClick}`,
          kind: "handler",
          handler: onClick,
          url: `pronto://event/CLICK?${unescapeBraces(ds.toString())}`,
          label: rawLabel,
        },
        extras,
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
          primary: {
            id: id || "publish_article",
            kind: "form",
            entity,
            op,
            url: "pronto://event/PUBLISH_ARTICLE",
            label: rawLabel,
          },
          extras,
        };
      }
      if (formName === "search" || route === "search") {
        return {
          primary: {
            id: id || "search",
            kind: "form",
            route: "search",
            url: "pronto://event/SEARCH",
            label: rawLabel,
          },
          extras,
        };
      }
      const formQs = new URLSearchParams();
      if (!legacyV1 && ownerForm) {
        if (entity) formQs.set("entity", entity);
        if (op) formQs.set("op", op);
        for (const ch of ownerForm.children || []) {
          if (ch.tagName === "input" && (ch.getAttribute("type") || "").toLowerCase() === "hidden") {
            const hName = ch.getAttribute("name");
            const hVal = ch.getAttribute("data-value") ?? ch.getAttribute("value");
            if (hName && hVal !== null) formQs.set(hName, hVal);
          }
        }
      }
      const eventName = formName.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
      const qsSuffix = formQs.toString() ? `?${unescapeBraces(formQs.toString())}` : "";
      return {
        primary: {
          id: id || `form_${formName}`,
          kind: "form",
          entity,
          op,
          url: `pronto://event/${eventName}${qsSuffix}`,
          label: rawLabel,
        },
        extras,
      };
    }

    if (!legacyV1 && extras.length > 0) {
      return { primary: extras[0], extras: extras.slice(1) };
    }
  }

  if (!legacyV1) {
    const authAction = el.getAttribute("data-auth-action");
    const authProvider = el.getAttribute("data-auth-provider");
    if (authAction || authProvider) {
      const method = authProvider ? `oidc:${authProvider}` : authAction!;
      return {
        primary: {
          id: id || `auth_${method}`,
          kind: "auth",
          url: `pronto://event/AUTH?method=${encodeURIComponent(method)}&id=${encodeURIComponent(id)}`,
          label: rawLabel,
        },
        extras,
      };
    }

    if (tag === "label" && el.getAttribute("for") === "login-modal-toggle") {
      return {
        primary: {
          id: id || "toggle_login_modal",
          kind: "popover",
          popoverTarget: "login-modal-overlay",
          popoverOp: "toggle",
          url: `pronto://event/POPOVER?target=login-modal-overlay&op=toggle&id=${encodeURIComponent(id)}`,
          label: rawLabel,
        },
        extras,
      };
    }

    if (id && (chartTargets?.[id] || id.startsWith("card-flip-"))) {
      return {
        primary: {
          id,
          kind: "chart",
          url: `pronto://event/CHART_CLICK?id=${encodeURIComponent(id)}`,
          label: rawLabel,
        },
        extras,
      };
    }
  }

  return { primary: undefined, extras };
}

function extractChartClickTargets(
  actors: Record<string, unknown> | undefined,
  screenName: string,
): Record<string, { field: string; nextState?: string }> {
  const targets: Record<string, { field: string; nextState?: string }> = {};
  if (!actors) return targets;

  function scanTransitions(onMap: unknown, field: string) {
    if (!onMap || typeof onMap !== "object") return;
    for (const [evt, transition] of Object.entries(onMap as Record<string, unknown>)) {
      if (!evt.startsWith("click@")) continue;
      const targetId = evt.slice("click@".length);
      const nextState = typeof transition === "string"
        ? transition
        : (transition && typeof transition === "object" && typeof (transition as Record<string, unknown>).target === "string")
          ? String((transition as Record<string, unknown>).target)
          : undefined;
      targets[targetId] = { field, nextState };
    }
  }

  function scanChart(chart: unknown) {
    if (!chart || typeof chart !== "object") return;
    if (Array.isArray(chart)) {
      for (const item of chart) scanChart(item);
      return;
    }
    const c = chart as Record<string, unknown>;
    const field = typeof c.field === "string" ? c.field : "status";
    scanTransitions(c.on, field);
    if (c.states && typeof c.states === "object") {
      for (const st of Object.values(c.states as Record<string, unknown>)) {
        if (st && typeof st === "object") {
          scanTransitions((st as Record<string, unknown>).on, field);
        }
      }
    }
  }

  for (const actor of Object.values(actors)) {
    if (!actor || typeof actor !== "object") continue;
    const a = actor as Record<string, unknown>;
    if (a.via !== "rows" || a.screen !== screenName) continue;
    if (a.charts && typeof a.charts === "object") {
      for (const chart of Object.values(a.charts as Record<string, unknown>)) {
        scanChart(chart);
      }
    }
  }

  return targets;
}

/** Parse one screen's HTML and CSS into the bound Omnishell NativeScreenIr. */
export function projectScreenIr(
  screenName: string,
  routePath: string,
  htmlText: string,
  cssText: string,
  messages: Record<string, string> = {},
  options: ScreenIrOptions = {},
): NativeScreenIr {
  const legacyV1 = Boolean(options.legacyV1);
  const chartTargets = options.chartTargets;
  const rootEl = parseHtmlTree(htmlText);
  const theme = rootEl?.getAttribute?.("data-theme") || "press";
  const stateRules = parseCssStateRules(cssText);

  const inputs: NativeInputSpec[] = [];
  const actions: NativeActionSpec[] = [];
  const hudLayers: NativeHudLayerSpec[] = [];
  const touchZones: NativeTouchZoneSpec[] = [];
  const kineticMounts: NativeKineticSpec[] = [];
  const realms: NativeRealmSpec[] = [];
  const folds: NativeFoldSpec[] = [];

  let autoId = 0;

  function collectHiddenFolds(
    el: HtmlElementNode,
    parentLive?: { table: string; filter?: string; emptyRow?: Record<string, unknown> },
  ): void {
    const isLive = el.hasAttribute("data-live");
    const liveTable = isLive ? el.getAttribute("data-live")! : undefined;
    const liveFilter = isLive ? (el.getAttribute("data-filter") || undefined) : undefined;
    const rawEmptyRow = isLive ? el.getAttribute("data-empty-row") : null;
    const liveEmptyRow = rawEmptyRow ? (JSON.parse(rawEmptyRow) as Record<string, unknown>) : undefined;
    if (isLive && el.hasAttribute("data-on-mutation")) {
      const foldId = el.getAttribute("id") || `${screenName}_fold_${folds.length + 1}`;
      const reads = (el.getAttribute("data-reads") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const namedReads: Record<string, string> = {};
      for (const attr of el.attributes) {
        if (attr.name.startsWith("data-read-")) {
          namedReads[attr.name.slice("data-read-".length)] = attr.value;
        }
      }
      folds.push({
        id: foldId,
        table: liveTable!,
        filter: liveFilter,
        handler: el.getAttribute("data-on-mutation")!,
        reads,
        namedReads,
        ...(parentLive
          ? {
              parentTable: parentLive.table,
              ...(parentLive.filter ? { parentFilter: parentLive.filter } : {}),
              ...(parentLive.emptyRow ? { parentEmptyRow: parentLive.emptyRow } : {}),
            }
          : {}),
      });
    }
    const nextParent = isLive && !el.hasAttribute("data-on-mutation")
      ? { table: liveTable!, filter: liveFilter, emptyRow: liveEmptyRow }
      : parentLive;
    for (const child of el.children) {
      if ((child.tagName || "").toLowerCase() === "template") {
        const contentRoot = child.content || child;
        for (const tplChild of contentRoot.children || []) {
          collectHiddenFolds(tplChild, nextParent);
        }
      } else {
        collectHiddenFolds(child, nextParent);
      }
    }
  }

  function hasDescendantWithClass(el: HtmlElementNode, cls: string): boolean {
    const classes = (el.getAttribute("class") || "").split(/\s+/);
    if (classes.includes(cls)) return true;
    for (const c of el.children) {
      if (hasDescendantWithClass(c, cls)) return true;
    }
    return false;
  }

  function walkElement(
    el: HtmlElementNode,
    inheritedVisibility: VisibilityMode,
    enclosingSeat?: number,
    insideSheet = false,
    insideHidden = false,
  ): NativeNode | null {
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
      ...(legacyV1 ? [] : ["data-image-src", "data-hatch", "data-host-dom"]),
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

    let isProbe: NativeNode["isProbe"];
    if (!legacyV1) {
      if (classes.includes("fav-probe")) {
        isProbe = "favorite";
      } else if (
        hidden &&
        (hasDescendantWithClass(el, "owned-deck") ||
          hasDescendantWithClass(el, "owned-preview") ||
          hasDescendantWithClass(el, "owned-generation"))
      ) {
        isProbe = "owned";
      } else if (hidden && el.getAttribute("data-live") === "next_picture") {
        isProbe = "preload";
      }
      if (hidden && !insideHidden && (el.hasAttribute("data-on-mutation") || el.children.some((c) => c.tagName === "template"))) {
        collectHiddenFolds(el);
      }
      if (hidden && classes.includes("delivery-geocoder")) {
        for (const geoChild of el.children) {
          if (geoChild.hasAttribute("data-hatch")) {
            const unitName = geoChild.getAttribute("data-hatch")!;
            const unitDecl = options.units?.[unitName];
            const gProps: Record<string, string> = {};
            const gEvents: Record<string, string> = {};
            for (const a of geoChild.attributes) {
              if (a.name.startsWith("data-prop-")) gProps[a.name.slice("data-prop-".length)] = a.value;
              else if (a.name.startsWith("data-on-")) gEvents[a.name.slice("data-on-".length)] = a.value;
            }
            realms.push({
              unit: unitName,
              customType: "web-realm",
              isolation: unitDecl?.isolation ?? "agent",
              grants: unitDecl?.grants ?? [],
              ...(unitDecl?.src ? { src: unitDecl.src } : {}),
              ...(unitDecl?.subdomain ? { subdomain: unitDecl.subdomain } : {}),
              props: gProps,
              events: gEvents,
            });
          }
        }
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
      const onMutation = !legacyV1 ? (el.getAttribute("data-on-mutation") || undefined) : undefined;
      if (!legacyV1 && onMutation && !hidden && !insideHidden) {
        folds.push({
          id,
          table: el.getAttribute("data-live")!,
          filter: el.getAttribute("data-filter") || undefined,
          handler: onMutation,
          reads,
          namedReads,
        });
      }
      live = {
        table: el.getAttribute("data-live")!,
        filter: el.getAttribute("data-filter") || undefined,
        order: el.getAttribute("data-order") || undefined,
        select: el.getAttribute("data-select") || undefined,
        empty: interpolateMessages(el.getAttribute("data-empty") || undefined, messages),
        emptyRow,
        project,
        reads,
        namedReads,
        when: el.getAttribute("data-when") || undefined,
        ...(legacyV1
          ? {}
          : {
              ...(onMutation ? { onMutation } : {}),
              ...(el.hasAttribute("data-cortex") ? { cortexActor: el.getAttribute("data-cortex")! } : {}),
              ...(el.hasAttribute("data-machine-ref") ? { machineRef: el.getAttribute("data-machine-ref")! } : {}),
            }),
      };
    }

    let kinetic: NativeKineticSpec | undefined;
    if (el.hasAttribute?.("data-kinetic")) {
      kinetic = {
        actor: el.getAttribute("data-kinetic")!,
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
        layer: el.getAttribute("data-layer")!,
        widthEm: widthMatch ? Number(widthMatch[1]) : undefined,
        fill: classes.includes("hud-layer-fill") || classes.includes("stk-layer"),
      };
      hudLayers.push(hudLayer);
    }

    let touchZone: NativeTouchZoneSpec | undefined;
    if (el.hasAttribute?.("data-touch-zone")) {
      const zones = el.getAttribute("data-touch-zone")!.trim().split(/\s+/).filter(Boolean);
      touchZone = {
        zones,
        tap: el.hasAttribute("data-touch-tap"),
        ...(seat !== undefined ? { seat } : {}),
      };
      touchZones.push(touchZone);
    }

    let image: NativeImageSpec | undefined;
    if (!legacyV1 && (tag === "img" || el.hasAttribute("data-image-src"))) {
      const isResponsive = el.hasAttribute("data-image-src");
      const rawSrc = (isResponsive ? el.getAttribute("data-image-src") : el.getAttribute("src")) ?? "";
      const isCoverFill = classes.some((c) => c.includes("bg") || c === "cover-photo");
      image = {
        src: rawSrc,
        isResponsiveBinding: isResponsive,
        sizes: el.getAttribute("sizes") || undefined,
        alt: interpolateMessages(el.getAttribute("alt") || undefined, messages),
        ...(el.hasAttribute("width") ? { width: Number(el.getAttribute("width")) } : {}),
        ...(el.hasAttribute("height") ? { height: Number(el.getAttribute("height")) } : {}),
        scale: isCoverFill ? "fill" : "fit",
      };
    }

    let sheet: NativeSheetSpec | undefined;
    if (!legacyV1 && !insideSheet) {
      if (el.hasAttribute("popover")) {
        sheet = {
          kind: "popover",
          sheetId: id,
          stateVar: sheetStateVarForId(id),
        };
      } else if (tag === "dialog") {
        sheet = {
          kind: "dialog",
          sheetId: id,
          stateVar: sheetStateVarForId(id),
        };
      } else if (classes.includes("login-modal-overlay") || role === "dialog") {
        const sheetId = classes.includes("login-modal-overlay") ? "login-modal-overlay" : id;
        sheet = {
          kind: "modal",
          sheetId,
          stateVar: sheetStateVarForId(sheetId),
        };
      }
    }

    let flipCard: NativeFlipCardSpec | undefined;
    if (!legacyV1 && (classes.includes("flashcard-frame") || el.hasAttribute("data-flipped"))) {
      const rawFlip = el.getAttribute("data-flipped") || "{flipped}";
      const varMatch = rawFlip.match(BINDING_PLACEHOLDER_RE);
      flipCard = {
        flippedBinding: rawFlip,
        flippedVar: sanitizeVarName(varMatch ? varMatch[1] : "flipped"),
      };
    }

    let realm: NativeRealmSpec | undefined;
    if (!legacyV1 && el.hasAttribute("data-hatch")) {
      const unitName = el.getAttribute("data-hatch")!;
      const unitDecl = options.units?.[unitName];
      const interpolatedProps: Record<string, string> = {};
      for (const [pk, pv] of Object.entries(kineticProps)) {
        interpolatedProps[pk] = interpolateMessages(pv, messages) ?? pv;
      }
      realm = {
        unit: unitName,
        customType: "web-realm",
        isolation: unitDecl?.isolation ?? "realm",
        grants: unitDecl?.grants ?? (unitName === "delivery-map" ? ["geolocation"] : []),
        ...(unitDecl?.src ? { src: unitDecl.src } : {}),
        ...(unitDecl?.subdomain ? { subdomain: unitDecl.subdomain } : {}),
        props: interpolatedProps,
        events: kineticEvents,
      };
      realms.push(realm);
    }

    let input: NativeInputSpec | undefined;
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const inputType = (el.getAttribute("type") || "text").toLowerCase();
      const isCssHiddenToggle =
        !legacyV1 &&
        (inputType === "radio" ||
          classes.includes("pill-radio") ||
          classes.includes("login-modal-chk") ||
          classes.includes("study-mode-chk"));
      if (inputType !== "hidden" && inputType !== "submit" && !isCssHiddenToggle) {
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
                  : !legacyV1 && inputType === "number"
                    ? "number"
                    : "text";
        const placeholder = interpolateMessages(
          el.getAttribute("placeholder")?.trim() ||
            el.getAttribute("aria-label") ||
            (!legacyV1 ? el.getAttribute("aria-description") : null) ||
            undefined,
          messages,
        );
        input = {
          field,
          kind,
          placeholder,
          required: el.hasAttribute("required"),
          ...(el.hasAttribute("min") ? { min: Number(el.getAttribute("min")) } : {}),
          ...(el.hasAttribute("max") ? { max: Number(el.getAttribute("max")) } : {}),
          ...(el.hasAttribute("data-value") ? { valueBinding: el.getAttribute("data-value")! } : {}),
        };
        if (!inputs.some((i) => i.field === field)) {
          inputs.push(input);
        }
      }
    }

    const resolvedActions = canonicalActionUrl(el, null, messages, legacyV1, chartTargets);
    const action = resolvedActions.primary;
    if (action && !actions.some((a) => a.url === action.url && a.id === action.id)) {
      actions.push(action);
    }
    for (const extra of resolvedActions.extras) {
      if (!actions.some((a) => a.url === extra.url && a.id === extra.id)) {
        actions.push(extra);
      }
    }

    const rawTextBinding = el.getAttribute?.("data-text") || undefined;
    const textBinding = interpolateMessages(rawTextBinding, messages);
    const textFormat = el.getAttribute?.("data-text-format") || undefined;

    const children: NativeNode[] = [];
    const itemTemplates: NativeNode[] = [];
    let sawItemTemplate = false;
    const nextInsideSheet = insideSheet || Boolean(sheet);
    const nextInsideHidden = insideHidden || hidden;

    for (const child of el.children || []) {
      const childTag = (child.tagName || "").toLowerCase();
      if (childTag === "template") {
        const isItemTpl = !legacyV1 && child.hasAttribute("data-item");
        if (isItemTpl) sawItemTemplate = true;
        const tplWhen = child.getAttribute?.("data-when") || undefined;
        const contentRoot = child.content || child;
        for (const tplChild of contentRoot.children || []) {
          const walked = walkElement(tplChild, visibility, seat, nextInsideSheet, nextInsideHidden);
          if (walked) {
            if (tplWhen && walked.live) walked.live.when = tplWhen;
            children.push(walked);
            if (isItemTpl) itemTemplates.push(walked);
          }
        }
        continue;
      }
      const walked = walkElement(child, visibility, seat, nextInsideSheet, nextInsideHidden);
      if (walked) children.push(walked);
    }

    if (!legacyV1 && live && sawItemTemplate) {
      live.isRepeater = true;
      live.itemTemplates = itemTemplates;
    }

    if (!legacyV1 && screenName === "print" && classes.includes("print-preview-wrapper")) {
      const printSheetRealmSpec: NativeRealmSpec = {
        unit: "print-sheet",
        customType: "print-realm",
        isolation: "realm",
        grants: ["print", "canvas-300dpi"],
        src: options.hostDom?.["window-print"]?.src || "shell/hatches/window-print.js",
        props: {
          deck_id: "{set_id}",
          vendor: "{vendor}",
          paper: "{paper}",
          orientation: "{orientation}",
          card_size: "{card_size}",
          layout: "{layout}",
          cut_lines: "{cut_lines}",
          stock: "{stock}",
          dpi: "300",
        },
        events: {
          print: "window-print",
          checkout: "print-checkout",
        },
      };
      realms.push(printSheetRealmSpec);
      children.unshift({
        id: "print_sheet_realm",
        tag: "div",
        classes: ["print-realm-surface"],
        visibility: "all",
        hidden: false,
        orientation: "vertical",
        typography: "body",
        stateAttrs: {},
        realm: printSheetRealmSpec,
        children: [],
      });
    }

    let directText: string | undefined;
    if (children.length === 0) {
      const t = (el.textContent || "").trim();
      if (t.length > 0) directText = t;
    }

    const rawDataText = !legacyV1
      ? (el.getAttribute("data-text") || el.getAttribute("placeholder") || undefined)
      : undefined;
    return {
      id,
      tag,
      classes,
      role,
      ariaLabel,
      visibility,
      hidden,
      orientation: inferOrientation(tag, classes, legacyV1),
      text: directText,
      textBinding,
      ...(rawDataText && rawDataText.includes("{msg.") ? { rawText: rawDataText } : {}),
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
      ...(!legacyV1 && resolvedActions.extras.length > 0 ? { extraActions: resolvedActions.extras } : {}),
      ...(!legacyV1 && image ? { image } : {}),
      ...(!legacyV1 && sheet ? { sheet } : {}),
      ...(!legacyV1 && flipCard ? { flipCard } : {}),
      ...(!legacyV1 && realm ? { realm } : {}),
      ...(!legacyV1 && isProbe ? { isProbe } : {}),
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
    ...(legacyV1
      ? {}
      : {
          folds,
          ...(realms.length > 0 ? { realms } : {}),
          ...(chartTargets ? { chartTargets } : {}),
        }),
  };
}

/**
 * Deterministic Phone Back-End: lowers a bound Omnishell NativeScreenIr to an
 * upstream DivKit SDUI Card JSON with `DivVariableController` variables,
 * `div-image`, `div-state` sheets, declarative visibility expressions,
 * `data-live` repeater descriptors, and `div-custom` mounts (`flip-card`, `kinetic:*`).
 */
export function applyDivTextStyle(
  div: Record<string, unknown>,
  node: NativeNode,
  theme: ThemeTokens,
  inHorizontalParent: boolean,
): Record<string, unknown> {
  const cls = new Set(node.classes);
  if (inHorizontalParent && div.width === undefined) {
    div.width = { type: "wrap_content" };
  }
  const isPrimaryBtn = cls.has("btn-primary") || cls.has("about-btn");
  const isSecondaryBtn =
    cls.has("btn-secondary") ||
    cls.has("btn-outline") ||
    cls.has("checkout-secondary") ||
    cls.has("fullscreen-exit-btn");
  const isPill =
    cls.has("filter-pill-label") ||
    cls.has("mobile-shelf-tab") ||
    cls.has("quick-pick-pill") ||
    cls.has("count-step-pill") ||
    cls.has("theme-btn") ||
    cls.has("lang-link") ||
    cls.has("category-pill") ||
    cls.has("hero-badge") ||
    cls.has("hero-pill-category") ||
    cls.has("desk-category-badge") ||
    cls.has("card-specimen-seal");

  if (isPrimaryBtn) {
    div.background = [{ type: "solid", color: theme.accent }];
    div.text_color = "#FFFFFF";
    div.font_weight = "bold";
    div.text_alignment_horizontal = "center";
    div.paddings = { left: 16, right: 16, top: 10, bottom: 10 };
    div.border = { corner_radius: 12 };
  } else if (isSecondaryBtn) {
    div.background = [{ type: "solid", color: theme.surface }];
    div.text_color = theme.primary;
    div.font_weight = "bold";
    div.text_alignment_horizontal = "center";
    div.paddings = { left: 14, right: 14, top: 10, bottom: 10 };
    div.border = { corner_radius: 12, stroke: { color: theme.border, width: 1 } };
  } else if (isPill) {
    div.background = [{ type: "solid", color: cls.has("hero-badge") ? "#F59E0B" : theme.surfaceMuted }];
    div.text_color = cls.has("hero-badge") ? "#181D25" : theme.secondary;
    div.font_size = 12;
    div.font_weight = "bold";
    div.paddings = { left: 10, right: 10, top: 6, bottom: 6 };
    div.border = { corner_radius: 999 };
  }

  if (cls.has("card-back-title")) {
    div.font_size = 30;
    div.font_weight = "bold";
    div.text_alignment_horizontal = "center";
  } else if (cls.has("hero-title") || cls.has("about-title") || cls.has("generator-title") || cls.has("print-main-title") || cls.has("desk-deck-title")) {
    div.font_size = 24;
    div.font_weight = "bold";
  } else if (cls.has("card-set-title") || cls.has("section-title")) {
    div.font_size = 18;
    div.font_weight = "bold";
  } else if (cls.has("section-subtitle") || cls.has("hero-subtitle") || cls.has("about-lede") || cls.has("contact-sheet-sub")) {
    div.text_color = theme.secondary;
    div.font_size = 14;
  }
  return div;
}

export function applyDivContainerStyle(
  div: Record<string, unknown>,
  node: NativeNode,
  theme: ThemeTokens,
  inHorizontalParent: boolean,
): Record<string, unknown> {
  const cls = new Set(node.classes);
  if (node.orientation === "horizontal") {
    div.layout_mode =
      cls.has("lang-switch") || cls.has("theme-switch") || cls.has("mobile-shelf-tabs")
        ? "no_wrap"
        : "wrap";
    div.item_spacing = cls.has("lang-switch") || cls.has("theme-switch") ? 6 : 8;
    div.line_spacing = 8;
    div.content_alignment_vertical = "center";
  } else {
    div.item_spacing = cls.has("screen") || cls.has("library-shell") || cls.has("play-container") ? 12 : 6;
  }

  if (inHorizontalParent && div.width === undefined) {
    div.width = { type: "wrap_content" };
  }

  const isCardSurface =
    cls.has("card-set-item") ||
    cls.has("featured-hero") ||
    cls.has("login-modal-card") ||
    cls.has("card-edit-sheet") ||
    cls.has("studio-container") ||
    cls.has("specimen-preview-card") ||
    cls.has("deck-selector-card") ||
    cls.has("play-completed-card") ||
    cls.has("print-readiness-banner") ||
    cls.has("my-cards-cta-card") ||
    cls.has("card-rail-item");

  if (cls.has("card-face")) {
    div.width = { type: "match_parent" };
    div.height = { type: "match_parent" };
    div.content_alignment_vertical = "space-between";
    div.background = [{ type: "solid", color: theme.surface }];
    div.border = { corner_radius: 20, stroke: { color: theme.border, width: 1 } };
    div.paddings = { left: 16, right: 16, top: 14, bottom: 14 };
  } else if (cls.has("face-content-back")) {
    div.width = { type: "match_parent" };
    div.height = { type: "fixed", value: 230 };
    div.content_alignment_horizontal = "center";
    div.content_alignment_vertical = "center";
    div.paddings = { top: 20, bottom: 20, left: 12, right: 12 };
  } else if (cls.has("plate-header")) {
    div.width = { type: "match_parent" };
    div.layout_mode = "no_wrap";
    div.content_alignment_horizontal = "space-between";
  } else if (cls.has("play-controls")) {
    div.width = { type: "match_parent" };
    div.content_alignment_horizontal = "center";
    div.item_spacing = 12;
    div.margins = { top: 12, bottom: 12 };
  } else if (isCardSurface) {
    div.width = inHorizontalParent
      ? { type: "fixed", value: cls.has("card-rail-item") ? 156 : 280 }
      : { type: "match_parent" };
    div.background = [{ type: "solid", color: theme.surface }];
    div.border = { corner_radius: 16, stroke: { color: theme.border, width: 1 } };
    div.paddings = { left: 14, right: 14, top: 14, bottom: 14 };
    div.margins = { bottom: 10 };
    div.item_spacing = 8;
  } else if (cls.has("btn-fav") || cls.has("deck-picker-card") || cls.has("login-method-btn") || cls.has("modal-nav-link")) {
    div.background = [{ type: "solid", color: theme.surfaceMuted }];
    div.border = { corner_radius: 12, stroke: { color: theme.border, width: 1 } };
    div.paddings = { left: 10, right: 10, top: 8, bottom: 8 };
  } else if (cls.has("top-bar-search") || cls.has("deck-search-box")) {
    div.width = inHorizontalParent ? { type: "fixed", value: 260 } : { type: "match_parent" };
    div.background = [{ type: "solid", color: theme.surface }];
    div.border = { corner_radius: 12, stroke: { color: theme.border, width: 1 } };
    div.paddings = { left: 12, right: 12, top: 6, bottom: 6 };
    div.layout_mode = "no_wrap";
  }

  return div;
}

export function buildResponsiveShellWrapper(
  screenName: string,
  innerRoot: Record<string, unknown>,
  options: {
    viewportWidthDp: number;
    direction: "ltr" | "rtl";
    theme: ThemeTokens;
    navEntries?: NativeNavEntry[];
  },
): Record<string, unknown> {
  const { viewportWidthDp, direction, theme, navEntries } = options;
  const entries = navEntries && navEntries.length > 0
    ? navEntries
    : [
        { screen: "cards", label: "Home", icon: "🏠" },
        { screen: "generate", label: "Create", icon: "✨" },
        { screen: "cards", label: "My Cards", icon: "🗂️", params: { shelf: "mine" } },
        { screen: "cards", label: "Gallery", icon: "🌐", params: { shelf: "gallery" } },
        { screen: "print", label: "Print", icon: "🖨️" },
        { screen: "about", label: "About", icon: "📖" },
      ];

  const makeNavButton = (entry: NativeNavEntry, idx: number, isActive: boolean, isPhoneBar = false): Record<string, unknown> => {
    const qs = new URLSearchParams({ screen: entry.screen });
    for (const [k, v] of Object.entries(entry.params ?? {})) qs.set(k, v);
    return {
      type: "text",
      id: `nav_item_${entry.screen}_${idx}`,
      text: entry.icon ? `${entry.icon} ${entry.label}` : entry.label,
      font_size: 13,
      font_weight: isActive ? "bold" : "medium",
      font_family: "sans-serif",
      text_color: isActive ? "#181D25" : theme.secondary,
      text_alignment_horizontal: direction === "rtl" && !isPhoneBar ? "right" : "center",
      text_alignment_vertical: "center",
      ...(isPhoneBar
        ? {
            width: { type: "match_parent", weight: 1 },
            height: { type: "fixed", value: 44 },
          }
        : {
            paddings: { left: 8, right: 8, top: 10, bottom: 10 },
          }),
      border: { corner_radius: 10 },
      ...(isActive ? { background: [{ type: "solid", color: "#F59E0B" }] } : {}),
      actions: [{ log_id: `nav_${entry.screen}_${idx}`, url: `pronto://event/NAVIGATE?${qs.toString()}` }],
    };
  };

  if (viewportWidthDp >= 768) {
    const isStudyRoute = screenName === "card" || screenName === "explore" || screenName === "deck";
    const railItems = entries.map((e, i) =>
      makeNavButton(e, i, (e.screen === screenName || (isStudyRoute && e.screen === "cards")) && !e.params?.shelf, false),
    );
    railItems.push({
      type: "text",
      id: "omnishell_rail_account",
      text: "👤 Account",
      font_size: 12,
      font_weight: "bold",
      font_family: "sans-serif",
      text_color: theme.primary,
      paddings: { left: 8, right: 8, top: 10, bottom: 10 },
      ...(direction === "rtl" ? { text_alignment_horizontal: "right" } : {}),
      actions: [
        { log_id: "rail_open_account", url: "pronto://event/COMMAND?handler=play_select&command=open-login&id=btn-top-login" },
        { log_id: "rail_open_account_var", url: "div-action://set_variable?name=modal_login_state&value=open" },
      ],
    });
    const navRail: Record<string, unknown> = {
      type: "container",
      id: "omnishell_tablet_nav_rail",
      orientation: "vertical",
      width: { type: "fixed", value: 88 },
      height: { type: "match_parent" },
      paddings: { left: 6, right: 6, top: 12, bottom: 12 },
      item_spacing: 6,
      background: [{ type: "solid", color: theme.neutral }],
      items: railItems,
      ...(direction === "rtl" ? { content_alignment_horizontal: "right" } : {}),
    };
    const mainPane: Record<string, unknown> = {
      type: "gallery",
      id: "omnishell_tablet_main",
      orientation: "vertical",
      width: { type: "match_parent" },
      height: { type: "match_parent" },
      paddings: { left: 20, right: 20, top: 16, bottom: 28 },
      items: [innerRoot],
    };
    return {
      type: "container",
      id: "omnishell_tablet_shell",
      orientation: "horizontal",
      width: { type: "match_parent" },
      height: { type: "match_parent" },
      background: [{ type: "solid", color: theme.neutral }],
      items: direction === "rtl" ? [mainPane, navRail] : [navRail, mainPane],
      extension_props: {
        form_factor: "tablet",
        viewport_width_dp: viewportWidthDp,
        layout_direction: direction,
      },
    };
  }

  const isStudyScreen = screenName === "card" || screenName === "explore" || screenName === "deck";
  const phonePrimaryScreens = new Set(["cards", "generate", "print"]);
  const phonePrimaryEntries = entries.filter(
    (e) => phonePrimaryScreens.has(e.screen) && (!e.params || Object.keys(e.params).length === 0),
  );
  const barItems = phonePrimaryEntries.map((e, i) =>
    makeNavButton(e, i, e.screen === screenName || (isStudyScreen && e.screen === "cards"), true),
  );
  barItems.push({
    type: "text",
    id: "omnishell_avatar_sheet_trigger",
    text: "👤",
    font_size: 16,
    font_weight: "bold",
    font_family: "sans-serif",
    text_color: theme.primary,
    text_alignment_horizontal: "center",
    text_alignment_vertical: "center",
    width: { type: "fixed", value: 48 },
    height: { type: "fixed", value: 44 },
    background: [{ type: "solid", color: theme.surfaceMuted }],
    border: { corner_radius: 12, stroke: { color: theme.border, width: 1 } },
    actions: [
      { log_id: "phone_open_avatar_sheet", url: "pronto://event/COMMAND?handler=play_select&command=open-login&id=btn-top-login" },
      { log_id: "phone_open_avatar_var", url: "div-action://set_variable?name=modal_login_state&value=open" },
    ],
  });
  const orderedBarItems = direction === "rtl" ? [...barItems].reverse() : barItems;
  const topBar: Record<string, unknown> = {
    type: "container",
    id: "omnishell_phone_nav_bar",
    orientation: "horizontal",
    width: { type: "match_parent" },
    height: { type: "fixed", value: 64 },
    paddings: { left: 10, right: 10, top: 8, bottom: 8 },
    item_spacing: 6,
    content_alignment_vertical: "center",
    background: [{ type: "solid", color: theme.surface }],
    border: { stroke: { color: theme.border, width: 1 } },
    items: orderedBarItems,
  };
  const bodyScroll: Record<string, unknown> = {
    type: "gallery",
    id: "omnishell_phone_scroll",
    orientation: "vertical",
    width: { type: "match_parent" },
    height: { type: "match_parent" },
    paddings: { left: 14, right: 14, top: 12, bottom: 32 },
    item_spacing: 12,
    items: [innerRoot],
  };
  return {
    type: "container",
    id: "omnishell_phone_shell",
    orientation: "vertical",
    width: { type: "match_parent" },
    height: { type: "match_parent" },
    background: [{ type: "solid", color: theme.neutral }],
    items: [topBar, bodyScroll],
    extension_props: {
      form_factor: "phone",
      viewport_width_dp: viewportWidthDp,
      layout_direction: direction,
    },
  };
}

export function projectScreenToDivKit(
  screenIr: NativeScreenIr,
  theme: ThemeTokens = DEFAULT_THEME,
  options: DivKitProjectionOptions = {},
): DivKitCard {
  const legacyV1 = Boolean(options.legacyV1);
  const origin = options.origin || "https://snapcards.fun";
  const palettes: ThemePalettes = options.palettes ?? { light: theme, dark: DEFAULT_DARK_THEME };
  const themeMode = options.themeMode ?? "auto";
  const resolvedScheme: "light" | "dark" =
    themeMode === "dark"
      ? "dark"
      : themeMode === "light"
        ? "light"
        : options.systemColorScheme === "dark"
          ? "dark"
          : "light";
  const activeTheme: ThemeTokens = legacyV1
    ? theme
    : resolvedScheme === "dark"
      ? palettes.dark
      : palettes.light;
  const locale = options.locale || "pt";
  const direction = legacyV1 ? "ltr" : directionOfLocale(locale);
  const isTablet = !legacyV1 && typeof options.viewportWidthDp === "number" && options.viewportWidthDp >= 768;

  const variables: DivKitVariable[] = [];
  const seenVars = new Set<string>();
  const addVar = (name: string, type: DivKitVariable["type"], value: string | number | boolean) => {
    const clean = sanitizeVarName(name);
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

  function buildDivActions(node: NativeNode): Array<Record<string, unknown>> | undefined {
    if (legacyV1) {
      return node.action ? [{ log_id: node.action.id, url: node.action.url }] : undefined;
    }

    const out: Array<Record<string, unknown>> = [];
    const allSpecs: NativeActionSpec[] = [
      ...(node.extraActions ?? []),
      ...(node.action ? [node.action] : []),
    ];

    for (const spec of allSpecs) {
      out.push({ log_id: spec.id, url: spec.url });
      if (spec.popoverTarget) {
        const stateVar = addVar(sheetStateVarForId(spec.popoverTarget), "string", "closed");
        const nextVal = spec.popoverOp === "hide" ? "closed" : "open";
        out.push({
          log_id: `${spec.id}_sheet_${nextVal}`,
          url: `div-action://set_variable?name=${encodeURIComponent(stateVar)}&value=${nextVal}`,
        });
      }
      if (spec.command === "open-login") {
        const stateVar = addVar("modal_login_state", "string", "closed");
        addVar("status", "string", "playing");
        out.push({
          log_id: `${spec.id}_open_login`,
          url: `div-action://set_variable?name=${encodeURIComponent(stateVar)}&value=open`,
        });
      } else if (
        spec.command === "close-login" ||
        spec.command === "auth-guest" ||
        spec.command === "auth-passkey" ||
        spec.command === "auth-google" ||
        spec.command === "auth-apple" ||
        spec.command === "auth-signout" ||
        spec.command === "auth-delete"
      ) {
        const stateVar = addVar("modal_login_state", "string", "closed");
        out.push({
          log_id: `${spec.id}_close_login`,
          url: `div-action://set_variable?name=${encodeURIComponent(stateVar)}&value=closed`,
        });
      }
    }

    if (node.id === "card-flip-visual" || node.id === "card-flip-prompt") {
      const flippedVar = addVar("flipped", "string", "no");
      out.push({
        log_id: `${node.id}_flip_yes`,
        url: `div-action://set_variable?name=${encodeURIComponent(flippedVar)}&value=yes`,
      });
    } else if (node.id === "card-flip-back" || node.id === "card-flip-back-prompt") {
      const flippedVar = addVar("flipped", "string", "no");
      out.push({
        log_id: `${node.id}_flip_no`,
        url: `div-action://set_variable?name=${encodeURIComponent(flippedVar)}&value=no`,
      });
    }

    return out.length > 0 ? out : undefined;
  }

  function inferVisibilityExpression(node: NativeNode): string | undefined {
    if (legacyV1) return undefined;

    if (node.hidden) {
      if (node.classes.includes("store-error") || node.role === "alert") {
        const errVar = addVar("store_error", "string", "");
        return `@{${errVar} != '' ? 'visible' : 'gone'}`;
      }
      if (node.realm?.unit === "print-payment") {
        const payOpenVar = addVar("checkout_payment_open", "boolean", false);
        return `@{${payOpenVar} ? 'visible' : 'gone'}`;
      }
      return undefined;
    }

    const cls = new Set(node.classes);

    // The projected account sheet's parts (nativeAccountSheet).
    if (cls.has("native-ways") || cls.has("native-held")) {
      const v = addVar("held_handle", "string", "");
      return `@{${v} ${cls.has("native-held") ? "!=" : "=="} '' ? 'visible' : 'gone'}`;
    }
    if (cls.has("native-delete-ask") || cls.has("native-delete-confirm")) {
      const v = addVar("delete_confirm", "string", "no");
      return `@{${v} ${cls.has("native-delete-confirm") ? "==" : "!="} 'yes' ? 'visible' : 'gone'}`;
    }

    if (cls.has("fullscreen-topbar")) {
      const v = addVar("status", "string", "playing");
      return `@{${v} == 'fullscreen' ? 'visible' : 'gone'}`;
    }
    if ((cls.has("play-header") || cls.has("explore-contact-sidebar")) &&
        (screenIr.name === "explore" || screenIr.name === "card")) {
      const v = addVar("status", "string", "playing");
      return `@{${v} == 'fullscreen' ? 'gone' : 'visible'}`;
    }
    if (cls.has("flashcard-stack-wrap") || cls.has("play-controls")) {
      const v = addVar("status", "string", "playing");
      return `@{${v} == 'completed' ? 'gone' : 'visible'}`;
    }
    if (cls.has("play-completed-card")) {
      const v = addVar("status", "string", "playing");
      return `@{${v} == 'completed' ? 'visible' : 'gone'}`;
    }
    if (cls.has("generated-deck-banner")) {
      const st = addVar("generation_status", "string", "idle");
      const own = addVar("has_owned_generation", "boolean", false);
      return `@{${st} == 'done' || ${st} == 'generating' || ${st} == 'partial' || ${own} ? 'visible' : 'gone'}`;
    }
    if (cls.has("my-cards-cta-card")) {
      const af = addVar("author_filter", "string", "");
      return `@{${af} == 'mine' ? 'visible' : 'gone'}`;
    }
    if (cls.has("featured-hero")) {
      const af = addVar("author_filter", "string", "");
      return `@{${af} == 'mine' || ${af} == 'gallery' ? 'gone' : 'visible'}`;
    }
    if (cls.has("btn-delete-deck") || cls.has("btn-edit-card")) {
      const own = addVar("is_owned_deck", "boolean", false);
      return `@{${own} ? 'visible' : 'gone'}`;
    }
    if (cls.has("card-delete")) {
      const own = addVar("is_owned_deck", "boolean", false);
      const cnt = addVar("deck_card_count", "integer", 0);
      return `@{${own} && ${cnt} > 1 ? 'visible' : 'gone'}`;
    }
    if (cls.has("card-delete-idle")) {
      const ds = addVar("delete_state", "string", "idle");
      return `@{${ds} == 'armed' || ${ds} == 'confirmed' ? 'gone' : 'visible'}`;
    }
    if (cls.has("card-delete-armed")) {
      const ds = addVar("delete_state", "string", "idle");
      return `@{${ds} == 'armed' || ${ds} == 'confirmed' ? 'visible' : 'gone'}`;
    }
    if (cls.has("when-unset")) {
      const fav = addVar("is_favorited", "boolean", false);
      return `@{${fav} ? 'gone' : 'visible'}`;
    }
    if (cls.has("when-set")) {
      const fav = addVar("is_favorited", "boolean", false);
      return `@{${fav} ? 'visible' : 'gone'}`;
    }
    if (cls.has("deck-loading")) {
      const empty = addVar("deck_is_empty", "boolean", false);
      return `@{${empty} ? 'gone' : 'visible'}`;
    }
    if (cls.has("deck-empty-back")) {
      const empty = addVar("deck_is_empty", "boolean", false);
      return `@{${empty} ? 'visible' : 'gone'}`;
    }
    if (cls.has("translation-error")) {
      const tf = addVar("translation_failed_topic", "string", "");
      return `@{${tf} != '' ? 'visible' : 'gone'}`;
    }

    for (const rule of screenIr.stateRules) {
      if (!rule.targetClass || !cls.has(rule.targetClass)) continue;
      if (rule.attr === "screen" || rule.attr === "locale") continue;
      if (rule.op === "eq" && rule.value && !rule.value.includes("|")) {
        const hasPairedHide = screenIr.stateRules.some(
          (r) => !r.visible && r.targetClass === rule.targetClass && r.attr === rule.attr,
        );
        if (rule.visible && !rule.negated) {
          if (!hasPairedHide) continue;
          const attrVar = addVar(`state_${rule.attr}`, "string", "");
          return `@{${attrVar} == '${rule.value}' ? 'visible' : 'gone'}`;
        }
        if (!rule.visible && !rule.negated && !rule.selector.includes("::before") && !rule.selector.includes("::after")) {
          const attrVar = addVar(`state_${rule.attr}`, "string", "");
          return `@{${attrVar} == '${rule.value}' ? 'gone' : 'visible'}`;
        }
      }
    }

    return undefined;
  }

  function findByClass(root: NativeNode, className: string): NativeNode | null {
    if (root.classes.includes(className)) return root;
    for (const c of root.children) {
      const hit = findByClass(c, className);
      if (hit) return hit;
    }
    return null;
  }

  function lowerNode(node: NativeNode, inHorizontalParent = false): Record<string, unknown> | null {
    if (node.visibility === "keys-only") return null;
    if (!legacyV1 && node.isProbe) return null;

    const visibilityExpr = inferVisibilityExpression(node);
    if (node.hidden && !visibilityExpr && !node.sheet) return null;

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

    if (!legacyV1 && node.flipCard) {
      const flippedVar = addVar(node.flipCard.flippedVar, "string", "no");
      const frontNode = findByClass(node, "card-front") ?? node.children[0];
      const backNode = findByClass(node, "card-back") ?? node.children[1];
      const frontDiv = frontNode ? lowerNode(frontNode, false) : null;
      const backDiv = backNode ? lowerNode(backNode, false) : null;
      const items = [frontDiv, backDiv].filter((x): x is Record<string, unknown> => x !== null);
      const customId = node.children[0]?.id && node.children[0].classes.includes("card-inner")
        ? node.children[0].id
        : node.id;
      return {
        type: "custom",
        id: customId,
        custom_type: "flip-card",
        width: { type: "match_parent" },
        height: { type: "fixed", value: 380 },
        items,
        custom_props: {
          flipped: `@{${flippedVar}}`,
          flipped_variable: flippedVar,
          perspective_px: 1200,
          duration_ms: 600,
          direction,
        },
        ...(visibilityExpr ? { visibility: visibilityExpr } : {}),
      };
    }

    if (!legacyV1 && node.realm) {
      const deckVar = addVar("active_deck_id", "string", "");
      const orderVar = addVar("active_order_id", "string", "");
      return {
        type: "custom",
        id: node.id,
        custom_type: node.realm.customType,
        width: { type: "match_parent" },
        height:
          node.realm.customType === "print-realm"
            ? { type: "fixed", value: 360 }
            : node.realm.props.mode === "locate"
              ? { type: "fixed", value: 44 }
              : { type: "fixed", value: 260 },
        custom_props: {
          unit: node.realm.unit,
          isolation: node.realm.isolation,
          grants: node.realm.grants,
          ...(node.realm.src ? { src: node.realm.src } : {}),
          ...(node.realm.subdomain ? { subdomain: node.realm.subdomain } : {}),
          deck_id: `@{${deckVar}}`,
          order_id: `@{${orderVar}}`,
          locale,
          direction,
          theme: resolvedScheme,
          origin,
          props: node.realm.props,
          events: node.realm.events,
          print_action_url: `omnishell://print?job=Snapcards&unit=${encodeURIComponent(node.realm.unit)}&deck=@{${deckVar}}`,
          checkout_action_url: `omnishell://checkout?order=@{${orderVar}}&deck=@{${deckVar}}&return_url=${encodeURIComponent("snapcards://print/return")}`,
        },
        ...(visibilityExpr ? { visibility: visibilityExpr } : {}),
      };
    }

    if (!legacyV1 && node.image) {
      const hasPlaceholder = BINDING_PLACEHOLDER_RE.test(node.image.src);
      let imageUrl: string;
      const extProps: Record<string, unknown> = {};
      if (node.image.isResponsiveBinding) {
        extProps.data_image_src = node.image.src;
        if (node.image.sizes) extProps.sizes = node.image.sizes;
      } else if (hasPlaceholder) {
        extProps.image_src = node.image.src;
      }
      if (hasPlaceholder) {
        const imgVar = addVar(`img_${node.id}`, "string", BLANK_SVG_DATA_URI);
        imageUrl = `@{${imgVar}}`;
      } else {
        imageUrl = resolveNativeImageUrl(node.image.src, origin);
      }
      const defaultImgHeight = node.classes.includes("card-illustration-img")
        ? 230
        : node.classes.includes("hero-bg-photo")
          ? 160
          : node.classes.includes("card-rail-thumb") || node.classes.includes("deck-picker-cover")
            ? 110
            : 180;
      return {
        type: "image",
        id: node.id,
        image_url: imageUrl,
        scale: node.classes.includes("hero-bg-photo") ? "fit" : node.image.scale,
        preload_required: !node.image.isResponsiveBinding,
        width: node.image.width
          ? { type: "fixed", value: node.image.width }
          : inHorizontalParent
            ? { type: "fixed", value: 140 }
            : { type: "match_parent" },
        height: node.image.height
          ? { type: "fixed", value: node.image.height }
          : { type: "fixed", value: defaultImgHeight },
        border: { corner_radius: 12 },
        ...(node.image.alt ? { accessibility: { description: node.image.alt } } : {}),
        ...(visibilityExpr ? { visibility: visibilityExpr } : {}),
        ...(Object.keys(extProps).length > 0 ? { extension_props: extProps } : {}),
      };
    }

    if (node.input) {
      const varName = addVar(`input_${node.input.field}`, "string", "");
      const keyboardType =
        node.input.kind === "multiline"
          ? "multi_line_text"
          : !legacyV1 && (node.input.kind === "number" || node.input.kind === "range")
            ? "number"
            : "single_line_text";
      return {
        type: "input",
        id: node.input.field,
        hint_text: node.input.placeholder || node.input.field,
        text_variable: varName,
        keyboard_type: keyboardType,
        font_size: node.typography === "display" ? 20 : 15,
        font_family: node.typography === "prose" ? "serif" : "sans-serif",
        text_color: activeTheme.primary,
        ...(direction === "rtl" ? { text_alignment_horizontal: "right" } : {}),
        ...(node.input.placeholder
          ? { accessibility: { description: node.input.placeholder } }
          : {}),
        ...(!legacyV1 && node.rawText ? { extension_props: { raw_text: node.rawText } } : {}),
        ...(visibilityExpr ? { visibility: visibilityExpr } : {}),
      };
    }

    const childDivs: Record<string, unknown>[] = [];
    const childInHoriz = !legacyV1 && node.orientation === "horizontal";
    if (legacyV1 || !node.live?.isRepeater) {
      for (const child of node.children) {
        const lowered = lowerNode(child, childInHoriz);
        if (lowered) childDivs.push(lowered);
      }
    }

    if (!legacyV1 && node.live?.empty && node.live.empty.length > 0) {
      const countVar = addVar(`live_${node.id}_count`, "integer", 0);
      childDivs.push({
        type: "text",
        id: `${node.id}_empty`,
        text: node.live.empty,
        font_size: 14,
        font_weight: "regular",
        font_family: "sans-serif",
        text_color: activeTheme.secondary,
        ...(direction === "rtl" ? { text_alignment_horizontal: "right" } : {}),
        visibility: `@{${countVar} == 0 ? 'visible' : 'gone'}`,
      });
    }

    const actions = buildDivActions(node);

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
      if (!legacyV1) {
        if (node.live.isRepeater) {
          customProps.repeater = true;
          const tplDivs = (node.live.itemTemplates ?? [])
            .map((tpl) => lowerNode(tpl, childInHoriz))
            .filter((x): x is Record<string, unknown> => x !== null);
          if (tplDivs.length > 0) customProps.item_templates = tplDivs;
        }
        if (node.live.empty !== undefined && node.live.empty.length > 0) {
          customProps.data_empty = node.live.empty;
        }
        if (node.live.emptyRow) {
          customProps.data_empty_row = node.live.emptyRow;
        }
        if (node.live.onMutation) {
          customProps.data_on_mutation = node.live.onMutation;
        }
      }
    }
    if (Object.keys(node.stateAttrs).length > 0) {
      customProps.state_attrs = node.stateAttrs;
    }
    if (!legacyV1) {
      if (node.classes.length > 0) customProps.classes = node.classes;
      if (node.rawText) customProps.raw_text = node.rawText;
    }

    if (!legacyV1 && node.sheet) {
      const stateVar = addVar(node.sheet.stateVar, "string", "closed");
      const openDiv: Record<string, unknown> = {
        type: "container",
        id: node.id,
        orientation: node.orientation,
        items: childDivs,
        ...(actions ? { actions } : {}),
        ...(Object.keys(customProps).length > 0 ? { extension_props: customProps } : {}),
      };
      if (!legacyV1) applyDivContainerStyle(openDiv, node, activeTheme, false);
      return {
        type: "state",
        id: `state_${node.sheet.sheetId}`,
        div_id: `state_${node.sheet.sheetId}`,
        default_state_id: "closed",
        state_id_variable: stateVar,
        states: [
          { state_id: "closed" },
          { state_id: "open", div: openDiv },
        ],
      };
    }

    if (childDivs.length === 0) {
      const displayText = legacyV1
        ? (node.text ?? node.textBinding ?? node.action?.label ?? "")
        : (node.textBinding ?? node.text ?? node.action?.label ?? "");
      if (!displayText && !actions && !node.touchZone && !(node.live?.isRepeater && !legacyV1)) return null;
      if (!legacyV1 && !displayText && !actions && node.live?.isRepeater) {
        const emptyRepeater: Record<string, unknown> = {
          type: "container",
          id: node.id,
          orientation: node.orientation,
          items: [],
          ...(visibilityExpr ? { visibility: visibilityExpr } : {}),
          ...(Object.keys(customProps).length > 0 ? { extension_props: customProps } : {}),
        };
        return applyDivContainerStyle(emptyRepeater, node, activeTheme, inHorizontalParent);
      }
      const textDiv: Record<string, unknown> = {
        type: "text",
        id: node.id,
        text: displayText,
        font_size: node.typography === "display" ? 22 : node.typography === "meta" ? 12 : 15,
        font_weight: node.typography === "display" || node.tag === "b" || node.tag === "strong" || node.tag === "button" ? "bold" : "regular",
        font_family: node.typography === "prose" ? "serif" : "sans-serif",
        text_color: node.tag === "button" || node.tag === "a" ? activeTheme.accent : activeTheme.primary,
        ...(direction === "rtl" ? { text_alignment_horizontal: "right" } : {}),
        ...(actions ? { actions } : {}),
        ...(visibilityExpr ? { visibility: visibilityExpr } : {}),
        ...(Object.keys(customProps).length > 0 ? { extension_props: customProps } : {}),
      };
      return legacyV1 ? textDiv : applyDivTextStyle(textDiv, node, activeTheme, inHorizontalParent);
    }

    const isDeckGrid = !legacyV1 && isTablet && (node.classes.includes("deck-grid") || node.classes.includes("cards-grid"));
    if (isDeckGrid) {
      return {
        type: "grid",
        id: node.id,
        column_count: 2,
        items: childDivs,
        ...(direction === "rtl" ? { content_alignment_horizontal: "right" } : {}),
        ...(actions ? { actions } : {}),
        ...(visibilityExpr ? { visibility: visibilityExpr } : {}),
        ...(Object.keys(customProps).length > 0 ? { extension_props: customProps } : {}),
      };
    }

    const orderedChildDivs =
      !legacyV1 && direction === "rtl" && node.orientation === "horizontal"
        ? [...childDivs].reverse()
        : childDivs;

    const containerDiv: Record<string, unknown> = {
      type: "container",
      id: node.id,
      orientation: node.orientation,
      items: orderedChildDivs,
      ...(!legacyV1 && direction === "rtl" ? { content_alignment_horizontal: "right" } : {}),
      ...(actions ? { actions } : {}),
      ...(visibilityExpr ? { visibility: visibilityExpr } : {}),
      ...(Object.keys(customProps).length > 0 ? { extension_props: customProps } : {}),
    };
    return legacyV1 ? containerDiv : applyDivContainerStyle(containerDiv, node, activeTheme, inHorizontalParent);
  }

  if (!legacyV1) {
    addVar("theme_mode", "string", themeMode);
    addVar("resolved_theme", "string", resolvedScheme);
    addVar("layout_direction", "string", direction);
  }

  let rootDiv = lowerNode(screenIr.root) || {
    type: "container",
    id: `${screenIr.name}_root`,
    orientation: "vertical",
    items: [],
  };

  if (!legacyV1 && typeof options.viewportWidthDp === "number") {
    addVar("form_factor", "string", options.viewportWidthDp >= 768 ? "tablet" : "phone");
    rootDiv = buildResponsiveShellWrapper(screenIr.name, rootDiv, {
      viewportWidthDp: options.viewportWidthDp,
      direction,
      theme: activeTheme,
      navEntries: options.navEntries,
    });
  }

  return {
    card: {
      log_id: `omnishell_${screenIr.name}`,
      variables,
      ...(!legacyV1
        ? {
            palette: buildDivKitPalette(palettes),
            omnishell_meta: {
              screen: screenIr.name,
              route: screenIr.route,
              folds: screenIr.folds ?? [],
              chart_targets: screenIr.chartTargets ?? {},
              nav_entries: options.navEntries ?? [],
              palettes,
              default_locale: locale,
            },
          }
        : {}),
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
/** The account sheet a native host shows from its rail or bar: on the web the
 * terminal's chip and panel draw it, which a native host has no DOM for, so
 * the projection writes the same choices from the app's auth declaration —
 * a passkey, each provider, the way out and deleting the account — and every
 * screen carries it as the sheet the host's account button opens. */
export function nativeAccountSheet(auth: { service?: string; providers?: string[] } | undefined): string {
  if (auth?.service === undefined) return "";
  const names: Record<string, string> = { google: "Google", apple: "Apple" };
  const choice = (id: string, attr: string, text: string) =>
    `<button type="button" id="${id}" class="login-method-btn" ${attr}><span class="login-method-title">${text}</span></button>`;
  // The runtime's variables say which part shows (inferVisibilityExpression):
  // the ways in, or the account a guest's sign-in found held; Delete account,
  // or, once asked, the press that deletes for good.
  return [
    `<div class="login-modal-overlay" id="login-modal-overlay" data-native-account>`,
    `<div class="login-modal-card" role="dialog" aria-labelledby="native-account-title">`,
    `<button type="button" id="btn-login-close" command="close-login" commandfor="shell" aria-label="{msg.chrome_close}">✕</button>`,
    `<div class="native-ways">`,
    `<strong id="native-account-title" data-text="{msg.chrome_keep}"></strong>`,
    choice("btn-auth-passkey", `data-auth-action="passkey-signin"`, `<span data-text="{msg.chrome_device}"></span>`),
    ...(auth.providers ?? []).map((p) => choice(`btn-auth-${p}`, `data-auth-provider="${p}"`, names[p] ?? p)),
    choice("btn-auth-signout", `data-auth-action="signout"`, `<span data-text="{msg.chrome_signout}"></span>`),
    `<div class="native-delete-ask">`,
    choice("btn-auth-delete", `data-auth-action="delete-ask"`, `<span data-text="{msg.chrome_delete_account}"></span>`),
    `</div><div class="native-delete-confirm">`,
    choice("btn-auth-delete-confirm", `data-auth-action="delete-account"`, `<span data-text="{msg.chrome_delete_confirm}"></span>`),
    `</div></div>`,
    `<div class="native-held">`,
    `<p data-text="{msg.chrome_taken}"></p><strong data-text="{held_handle}"></strong>`,
    choice("btn-auth-switch", `data-auth-action="switch"`, `<span data-text="{msg.chrome_switch}"></span>`),
    choice("btn-auth-stay", `data-auth-action="stay"`, `<span data-text="{msg.chrome_stay}"></span>`),
    `</div>`,
    `</div></div>`,
  ].join("");
}

export async function projectAppNative(
  appDir: URL,
  options: { origin?: string; locale?: string; viewportWidthDp?: number; themeMode?: "light" | "dark" | "auto" } = {},
): Promise<NativeAppProjection> {
  const dirPath = fileURLToPath(appDir).replace(/\/+$/, "");
  const shellPath = `${dirPath}/shell/shell.yaml`;
  const shellText = await Deno.readTextFile(shellPath);
  const shell = (parseYaml(shellText) || {}) as {
    app?: string;
    i18n?: { default?: string; locales?: string[] | Record<string, unknown> };
    cortex?: { actors?: Record<string, unknown> };
    units?: Record<string, ScreenUnitDecl>;
    hostDom?: Record<string, { src?: string }>;
    auth?: { service?: string; providers?: string[] };
    routes?: Array<{
      path: string;
      screen: string;
      nav?: {
        strip?: boolean;
        label?: string;
        key?: string;
        icon?: string;
        entries?: Array<{ label?: string; key?: string; icon?: string; params?: Record<string, string> }>;
      };
      files?: { html?: string; css?: string; shared?: string[] };
    }>;
  };

  let nativeRuntimeLogic: string | undefined;
  try {
    nativeRuntimeLogic = await Deno.readTextFile(`${dirPath}/android/bundle/runtime_logic.js`);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  const legacyV1 = nativeRuntimeLogic !== undefined;

  let designCss = "";
  try {
    designCss = await Deno.readTextFile(`${dirPath}/shell/design.css`);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  let chromeCss = "";
  if (!legacyV1) {
    try {
      chromeCss = await Deno.readTextFile(`${dirPath}/shell/shared/chrome.css`);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
  const combinedTokenCss = chromeCss ? `${designCss}\n${chromeCss}` : designCss;
  const palettes = parseDesignPalettes(combinedTokenCss);
  const theme = legacyV1 ? parseDesignTokens(designCss) : palettes.light;

  let defaultMessages: Record<string, string> = {};
  const defaultLocale = shell.i18n?.default || "en";
  const targetLocale = options.locale || defaultLocale;
  try {
    const msgText = await Deno.readTextFile(`${dirPath}/messages/${targetLocale}.json`);
    defaultMessages = JSON.parse(msgText);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
    if (targetLocale !== defaultLocale) {
      try {
        const fallbackText = await Deno.readTextFile(`${dirPath}/messages/${defaultLocale}.json`);
        defaultMessages = JSON.parse(fallbackText);
      } catch (err2) {
        if (!(err2 instanceof Deno.errors.NotFound)) throw err2;
      }
    }
  }

  const navEntries: NativeNavEntry[] = [];
  if (!legacyV1) {
    let navCssIcons: Record<string, string> = {};
    try {
      const navCssText = await Deno.readTextFile(`${dirPath}/shell/shared/nav.css`);
      for (const m of navCssText.matchAll(/a\[data-route="([^"]+)"\]::before\s*\{\s*content:\s*"([^"]+)"/g)) {
        navCssIcons[m[1]] = m[2];
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }

    for (const r of shell.routes || []) {
      const hasRequiredParam = r.path.split("/").some((seg) => seg.startsWith(":") && !seg.endsWith("?"));
      if (hasRequiredParam || r.nav?.strip === false) continue;
      const baseLabel = (r.nav?.key && defaultMessages[r.nav.key]) || r.nav?.label || r.screen;
      const resolvedIcon = r.nav?.icon || navCssIcons[r.screen];
      navEntries.push({
        screen: r.screen,
        label: baseLabel,
        ...(r.nav?.key ? { key: r.nav.key } : {}),
        ...(resolvedIcon ? { icon: resolvedIcon } : {}),
      });
      for (const sub of r.nav?.entries || []) {
        const subLabel = (sub.key && defaultMessages[sub.key]) || sub.label || r.screen;
        navEntries.push({
          screen: r.screen,
          label: subLabel,
          ...(sub.key ? { key: sub.key } : {}),
          ...(sub.icon ? { icon: sub.icon } : {}),
          ...(sub.params ? { params: sub.params } : {}),
        });
      }
    }
  }

  const sharedCssCache = new Map<string, string>();
  async function readSharedCss(rel: string): Promise<string> {
    if (sharedCssCache.has(rel)) return sharedCssCache.get(rel)!;
    let content = "";
    try {
      content = await Deno.readTextFile(`${dirPath}/${rel}`);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
    sharedCssCache.set(rel, content);
    return content;
  }

  const screens: NativeAppProjection["screens"] = {};
  const winioMap: Record<string, WinioScreenSpec> = {};

  const routes = shell.routes || [];
  for (const route of routes) {
    const screenName = route.screen;
    if (screens[screenName]) continue;
    const htmlRel = route.files?.html || `shell/screens/${screenName}.html`;
    const cssRel = route.files?.css || `shell/screens/${screenName}.css`;
    const screenHtml = await Deno.readTextFile(`${dirPath}/${htmlRel}`);
    const close = screenHtml.lastIndexOf("</");
    const sheet = legacyV1 ? "" : nativeAccountSheet(shell.auth);
    const htmlText = sheet === "" || close < 0 ? screenHtml : `${screenHtml.slice(0, close)}${sheet}${screenHtml.slice(close)}`;
    let cssText = "";
    try {
      cssText = await Deno.readTextFile(`${dirPath}/${cssRel}`);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
    if (!legacyV1 && route.files?.shared) {
      const sharedParts: string[] = [];
      for (const sh of route.files.shared) {
        sharedParts.push(await readSharedCss(sh));
      }
      cssText = `${sharedParts.join("\n")}\n${cssText}`;
    }
    const chartTargets = legacyV1
      ? undefined
      : extractChartClickTargets(shell.cortex?.actors, screenName);
    const ir = projectScreenIr(screenName, route.path, htmlText, cssText, defaultMessages, {
      legacyV1,
      chartTargets,
      ...(!legacyV1 ? { units: shell.units, hostDom: shell.hostDom } : {}),
    });
    const divkit = projectScreenToDivKit(ir, theme, {
      legacyV1,
      origin: options.origin,
      ...(!legacyV1
        ? {
            palettes,
            locale: targetLocale,
            themeMode: options.themeMode,
            viewportWidthDp: options.viewportWidthDp,
            navEntries,
          }
        : {}),
    });
    const winio = projectScreenToWinio(ir);
    screens[screenName] = { ir, divkit, winio };
    winioMap[screenName] = winio;
  }

  const appName = shell.app || "app";
  const winioRustSource = emitWinioRustSource(appName, winioMap);
  const localesList = Array.isArray(shell.i18n?.locales)
    ? shell.i18n!.locales
    : shell.i18n?.locales && typeof shell.i18n.locales === "object"
      ? Object.keys(shell.i18n.locales)
      : undefined;

  return {
    app: appName,
    theme,
    ...(!legacyV1
      ? {
          palettes,
          navEntries,
          defaultLocale,
          ...(localesList ? { locales: localesList } : {}),
        }
      : {}),
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

  // 3. Test Snapcards DivKit constructs: div-image, div-state popover, and 3D flip-card div-custom
  const studyHtml = `
    <section class="screen" data-screen="study">
      <button type="button" id="btn-edit" class="btn-edit-card" popovertarget="card-edit-sheet">Edit</button>
      <div class="flashcard-frame" data-flipped="{flipped}">
        <div class="card-inner" id="card-flip">
          <div class="card-face card-front">
            <div id="card-flip-visual"><img data-image-src="{back}" sizes="auto, 160px" loading="lazy" alt="Specimen" /></div>
          </div>
          <div class="card-face card-back">
            <div id="card-flip-back"><h2 data-text="{front}">Capybara</h2></div>
          </div>
        </div>
      </div>
      <div id="card-edit-sheet" popover role="dialog">
        <button type="button" popovertarget="card-edit-sheet" popovertargetaction="hide">Done</button>
      </div>
    </section>
  `;
  const studyIr = projectScreenIr("study", "/study", studyHtml, "");
  const studyDivJson = JSON.stringify(projectScreenToDivKit(studyIr));
  check(studyDivJson.includes('"custom_type":"flip-card"'), "Study screen must emit flip-card div-custom");
  check(studyDivJson.includes('"type":"image"'), "Study screen must emit div-image for data-image-src");
  check(studyDivJson.includes('"type":"state"'), "Study screen must emit div-state for [popover]");

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
        } else if (action === "POPOVER" && params.target) {
            const varName = params.target === "login-modal-overlay" ? "modal_login_state" : ("sheet_" + params.target.replace(/[^a-zA-Z0-9_]/g, "_") + "_state");
            const prev = next.variables[varName] || "closed";
            const nextVal = params.op === "hide" ? "closed" : params.op === "show" ? "open" : (prev === "open" ? "closed" : "open");
            next.variables = Object.assign({}, next.variables, { [varName]: nextVal });
        } else if (action === "CHART_CLICK" && params.id) {
            if (params.id === "card-flip-visual" || params.id === "card-flip-prompt") {
                next.variables = Object.assign({}, next.variables, { flipped: "yes" });
            } else if (params.id === "card-flip-back" || params.id === "card-flip-back-prompt") {
                next.variables = Object.assign({}, next.variables, { flipped: "no" });
            }
        } else if (action === "COMMAND" || action === "CLICK" || action === "AUTH") {
            if (params.command === "open-login") {
                next.variables = Object.assign({}, next.variables, { status: "login", modal_login_state: "open" });
            } else if (params.command === "close-login") {
                next.variables = Object.assign({}, next.variables, { status: "playing", modal_login_state: "closed" });
            } else if (params.command === "fullscreen") {
                next.variables = Object.assign({}, next.variables, { status: "fullscreen" });
            } else if (params.command === "exit-fullscreen") {
                next.variables = Object.assign({}, next.variables, { status: "playing" });
            }
        } else {
            throw new Error("Unknown pronto://event/ action: " + action);
        }
        return next;
    }

    function projectToDivKit(s) {
        const entry = PROJECTION.screens[s.screen] || Object.values(PROJECTION.screens)[0];
        if (!entry) return { card: { log_id: PROJECTION.app + "_sdui", states: [] } };
        const cardCopy = JSON.parse(JSON.stringify(entry.divkit));
        if (cardCopy.card && Array.isArray(cardCopy.card.variables)) {
            for (const v of cardCopy.card.variables) {
                if (Object.prototype.hasOwnProperty.call(s.variables, v.name)) {
                    v.value = s.variables[v.name];
                }
            }
        }
        return cardCopy;
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
