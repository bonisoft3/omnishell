// omnishell i18n check: verifies that every declared route and storyboard state
// renders cleanly across all configured locales without un-interpolated
// placeholders ({msg.*}), default-language text leaks, or unlocalized content —
// and that the URL table those locales address the app through is sound.
//
//   deno run --no-lock --no-check --node-modules-dir=none --config ../../plugins/omnishell/test/deno.json \
//     --allow-read=.,../../plugins/omnishell/interpreter --allow-env \
//     ../../plugins/omnishell/check-i18n.ts <appDir>
//   deno run check-i18n.ts --self-test
//
import { parseHTML } from "npm:linkedom@0.18.4";
import { parse as parseYaml } from "jsr:@std/yaml@1.0.5";
import { renderStorybook } from "./interpreter/storybook.js";
import { directionOf, PLACEHOLDER, PLACEHOLDERS } from "./interpreter/fragment.js";
// The terminal's own copy table, so the keys required here are the keys the
// terminal actually asks for and cannot drift from them.
import { CHROME_KEYS } from "./interpreter/chrome.js";
import { controlProperties } from "./test/linkedom-controls.ts";
import { type MessageNode, compileCatalog, parseMessage } from "./src/messages.ts";

export type Finding = { severity: string; path: string; message: string };

/** A catalogue value is a plain string, a compile-time AST array, or an obsolete arms map. */
export type Arms = Record<string, string>;
export type CatalogValue = string | MessageNode[] | Arms;
export type Catalog = Record<string, CatalogValue>;

const USER_FACING_ATTRS = new Set([
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "placeholder",
  "title",
  "alt",
]);

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Route = {
  path: string;
  screen: string;
  // A message key, present on a route whose first segment is translated. The
  // catalogue answers it per locale, which is why a slug missing in Spanish is
  // the same finding as a button label missing there.
  slug?: string;
  // Written as a document per locale at build, so a crawler receives HTML.
  prerender?: boolean;
  // The pattern per declared tag, resolved by the emitter; absent on a route
  // that declares no slug.
  paths?: Record<string, string>;
  // What the terminal's nav strip says about this route. `label` is the
  // default-language spelling; `key` and `labels` are what `slug` and `paths`
  // are for the address. Optional here, where an emitted shell.yaml is graded
  // with no program beside it.
  nav?: { label: string; key?: string; labels?: Record<string, string>; strip?: boolean };
  files: { html: string; css: string; handlers?: string[]; shared?: string[] };
  states?: string[];
};

type I18n = { default: string; locales: Record<string, { path: string }> };

type ShellConfig = {
  app?: string;
  i18n?: I18n;
  // The facts that decide which of the terminal's own chrome a reader reaches:
  // a required gate draws the login screen, either a gate or a table of the
  // app's own mints the session the strip names, and promote offers a guest
  // that session's passkey.
  auth?: { required?: boolean; promote?: boolean };
  tables?: string[];
  routes?: Route[];
  units?: Record<string, unknown>;
  // Passed through to every mount rather than read here: a value format
  // resolves a column's declaration in it.
  schema?: Record<string, unknown>;
};

// One URL segment: lowercase, unreserved, no percent-encoding. A locale's own
// prefix and a route's resolved slug are the same kind of thing and answer to
// the same shape; accents are transliterated by the author in the catalogue,
// because a machine guessing at transliteration gets Turkish dotted i wrong.
const SEGMENT = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The pattern a route is matched by under one locale. A route that declares
 * no `paths` is not translated and wears the one pattern in every language. */
const patternOf = (route: Route, tag: string): string | undefined =>
  route.paths === undefined ? route.path : route.paths[tag];

/** A pattern as matchRoute compares it: a `:param` captures whatever segment
 * is there, so `/a/:x` and `/a/:y` are one address rather than two. */
const shapeOf = (pattern: string) => pattern.split("/").map((s) => (s.startsWith(":") ? ":" : s)).join("/");

export async function checkApp(appDir: URL): Promise<{ findings: Finding[] }> {
  const findings: Finding[] = [];

  let shellText: string;
  try {
    shellText = await Deno.readTextFile(new URL("shell/shell.yaml", appDir));
  } catch (err) {
    findings.push({
      severity: "error",
      path: "shell/shell.yaml",
      message: `cannot read shell/shell.yaml: ${(err as Error).message}`,
    });
    return { findings };
  }

  const shell = parseYaml(shellText) as ShellConfig;
  const i18n = shell.i18n;
  // An app that declares no i18n block has one language and no URL table.
  if (i18n === undefined) return { findings };
  const declared = i18n.locales;
  if (declared === null || typeof declared !== "object" || Array.isArray(declared)) {
    findings.push({
      severity: "error",
      path: "shell/shell.yaml",
      message: `i18n.locales is a map of BCP 47 tag to {path}; ${JSON.stringify(declared)} is not one`,
    });
    return { findings };
  }
  const locales = Object.keys(declared);
  // A shell.yaml with no `routes` key and one with an empty list are the same
  // absence of a URL table, and checkLocalizedUrls grades it as the error it is.
  const routes = shell.routes ?? [];

  const messages: Record<string, Catalog> = {};
  for (const loc of locales) {
    try {
      const txt = await Deno.readTextFile(new URL(`messages/${loc}.json`, appDir));
      messages[loc] = compileCatalog(JSON.parse(txt)) as Catalog;
    } catch (err) {
      findings.push({
        severity: "error",
        path: `messages/${loc}.json`,
        message: `cannot read message catalog messages/${loc}.json: ${(err as Error).message}`,
      });
    }
  }

  const files: Record<string, string> = {};
  for (const route of routes) {
    try {
      files[route.files.html] = await Deno.readTextFile(new URL(route.files.html, appDir));
      files[route.files.css] = await Deno.readTextFile(new URL(route.files.css, appDir));
    } catch (err) {
      findings.push({
        severity: "error",
        path: route.files.html,
        message: `failed reading route asset: ${(err as Error).message}`,
      });
    }
  }

  const handlers: Record<string, string> = {};
  for (const route of routes) {
    for (const rel of route.files.handlers ?? []) {
      try {
        handlers[rel] = await Deno.readTextFile(new URL(rel, appDir));
      } catch (err) {
        findings.push({
          severity: "error",
          path: rel,
          message: `failed reading handler: ${(err as Error).message}`,
        });
      }
    }
  }

  findings.push(...checkLocalizedUrls(i18n, routes, messages));
  findings.push(...checkMessageArms(i18n, routes, messages, files));
  findings.push(...checkChrome(shell, messages));
  findings.push(...await checkMemoryApp(shell, messages, files));
  findings.push(...await checkPseudoLocale(shell, messages, files));
  findings.push(...checkHandlerText(files, handlers));
  return { findings };
}

/**
 * What the URL table says about itself: the locales an app declares, and the
 * address each route answers to in each of them.
 *
 * Most of this is also a cue error over the program — the schema constrains a
 * tag's shape and the emitter unifies the resolved patterns against each other.
 * It is restated here because this check reads an EMITTED shell.yaml standalone,
 * with no program beside it, and because a unification failure is not a sentence
 * anybody can act on. Every rule below is decidable from that one file plus the
 * catalogues, and every finding names the route and the locale it is about.
 */
export function checkLocalizedUrls(
  i18n: I18n,
  routes: Route[],
  messages: Record<string, Catalog>,
): Finding[] {
  const findings: Finding[] = [];
  const shellPath = "shell/shell.yaml";
  const report = (path: string, message: string) => findings.push({ severity: "error", path, message });
  const tags = Object.keys(i18n.locales);

  // The table is what every rule below reads. An app that declares locales and
  // no routes has no address in any of them, and grading that as sound says the
  // opposite of what the run proved.
  if (routes.length === 0) {
    report(shellPath, `i18n declares ${tags.join(", ")} and the route table is empty: no URL answers in any of them`);
  }

  if (!tags.includes(i18n.default)) {
    report(shellPath, `i18n.default '${i18n.default}' is not one of the declared locales (${tags.join(", ")})`);
  }

  // Segment -> the locale that owns it. Two locales sharing one prefix means
  // /es addresses whichever the router happens to read first.
  const byPath = new Map<string, string>();
  for (const [tag, spec] of Object.entries(i18n.locales)) {
    const segment = spec?.path;
    if (typeof segment !== "string" || !SEGMENT.test(segment)) {
      report(
        shellPath,
        `locale '${tag}' takes the URL prefix ${JSON.stringify(segment)}, which is not one lowercase segment`,
      );
      continue;
    }
    const owner = byPath.get(segment);
    if (owner === undefined) byPath.set(segment, tag);
    else report(shellPath, `locales '${owner}' and '${tag}' both take the URL prefix "${segment}"`);
  }

  // Intl is the only thing that knows a tag from a string that looks like one,
  // so a misspelling is refused here rather than absorbed: `pt_BR` and `ptbr`
  // negotiate against nothing and index as nothing.
  for (const tag of tags) {
    let canonical: string | undefined;
    try {
      canonical = Intl.getCanonicalLocales(tag)[0];
    } catch {
      canonical = undefined;
    }
    if (canonical === undefined) report(shellPath, `locale '${tag}' is not a well-formed BCP 47 tag`);
    else if (canonical !== tag) {
      report(shellPath, `locale '${tag}' is not its canonical BCP 47 spelling; write '${canonical}'`);
    }
  }

  // A translated route carries one pattern per declared tag. A tag missing from
  // `paths` is a shell.yaml disagreeing with its own i18n block, and every rule
  // after it would judge the route against nothing.
  const patterns = new Map<Route, Map<string, string>>();
  for (const route of routes) {
    const mine = new Map<string, string>();
    for (const tag of tags) {
      const pattern = patternOf(route, tag);
      if (pattern === undefined) report(shellPath, `route '${route.screen}' [${tag}]: paths names no pattern`);
      else mine.set(tag, pattern);
    }
    patterns.set(route, mine);
    // `lang` is the query's name for a locale, and the router folds a query
    // into the same params a pattern fills — so a route capturing :lang would
    // hand the screen whichever of the two the URL happened to carry, and the
    // router drops that key on the way past. The name is the wire's.
    for (const pattern of mine.values()) {
      if (/(^|\/):lang(\/|$)/.test(pattern)) {
        report(shellPath, `route '${route.screen}': ":lang" is the name a locale travels under, so a param cannot take it`);
        break;
      }
    }
  }

  // The slug is a message key like every other string, so a locale missing one
  // is the finding a missing button label gets, filed against the catalogue.
  for (const route of routes) {
    if (route.slug === undefined) continue;
    for (const tag of tags) {
      // An unreadable catalogue is already this run's finding; saying every key
      // is missing from it says the same thing once per key.
      const catalogue = messages[tag];
      if (catalogue === undefined) continue;
      const path = `messages/${tag}.json`;
      const value = catalogue[route.slug];
      if (typeof value !== "string" || value.trim() === "") {
        report(path, `route '${route.screen}' [${tag}]: slug key "${route.slug}" is missing`);
      } else if (!SEGMENT.test(value)) {
        report(
          path,
          `route '${route.screen}' [${tag}]: slug key "${route.slug}" is ${JSON.stringify(value)}, which is not ` +
            `one lowercase URL segment — transliterate the accents rather than percent-encoding them`,
        );
      }
    }
  }

  // After the prefix is stripped, every route in a locale is matched from one
  // table, so slugged and unslugged routes collide with each other.
  for (const tag of tags) {
    const seen = new Map<string, string>();
    for (const route of routes) {
      const pattern = patterns.get(route)?.get(tag);
      if (pattern === undefined) continue;
      const owner = seen.get(shapeOf(pattern));
      if (owner === undefined) seen.set(shapeOf(pattern), route.screen);
      else report(shellPath, `[${tag}]: routes '${owner}' and '${route.screen}' both answer to "${pattern}"`);
    }
  }

  // The default locale is unprefixed, so its first segment sits where a prefix
  // would: /es would be both the Spanish home and the route whose Portuguese
  // slug is `es`.
  for (const route of routes) {
    const pattern = patterns.get(route)?.get(i18n.default);
    if (pattern === undefined) continue;
    const owner = byPath.get(pattern.split("/")[1] ?? "");
    if (owner === undefined) continue;
    report(
      shellPath,
      `route '${route.screen}' [${i18n.default}] answers to "${pattern}", whose first segment is locale ` +
        `'${owner}'s URL prefix`,
    );
  }

  // Prerendering runs at build, where the rows a :param would name do not exist.
  for (const route of routes) {
    if (route.prerender !== true) continue;
    const said = new Set<string>();
    for (const [tag, pattern] of patterns.get(route) ?? []) {
      if (!pattern.includes(":") || said.has(pattern)) continue;
      said.add(pattern);
      report(
        shellPath,
        `route '${route.screen}' [${tag}] is prerendered and answers to "${pattern}": a :param names rows that ` +
          `do not exist when the build runs`,
      );
    }
  }

  return findings;
}

/**
/**
 * Verifies compile-time MessageFormat ASTs across all configured locales.
 *
 * For plurals (type: 6), asserts that all CLDR categories required for each
 * locale are present in options, and that no unsupported categories are declared.
 * For selects (type: 5), asserts that options agree across all locales.
 * Refuses obsolete data-msg-plural and data-msg-select attributes.
 */
export function checkMessageArms(
  i18n: I18n,
  routes: Route[],
  messages: Record<string, Catalog>,
  files: Record<string, string>,
): Finding[] {
  const findings: Finding[] = [];
  const report = (path: string, message: string) => findings.push({ severity: "error", path, message });

  // 1. Refuse obsolete data-msg-plural and data-msg-select in templates
  const obsoleteSelectors = /<([a-z][\w-]*)\b([^>]*\bdata-msg-(?:plural|select)=[^>]*)>/g;
  for (const route of routes) {
    const html = files[route.files.html];
    if (html === undefined) continue;
    const path = route.files.html;
    for (const [, el, blob] of html.matchAll(obsoleteSelectors)) {
      const attrs = new Map([...blob.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, n, v]) => [n, v]));
      const where = `<${el}>`;
      const plural = attrs.get("data-msg-plural");
      const select = attrs.get("data-msg-select");
      if (plural !== undefined && select !== undefined) {
        report(path, `${where} carries data-msg-plural and data-msg-select: an arm is selected once`);
      } else if (plural !== undefined) {
        report(path, `${where} carries obsolete data-msg-plural: use ICU MessageFormat in catalogues and clean {msg.<key>} bindings`);
      } else {
        report(path, `${where} carries obsolete data-msg-select: use ICU MessageFormat in catalogues and clean {msg.<key>} bindings`);
      }
    }
  }

  // 2. Grade ASTs across all locales
  const tags = Object.keys(i18n.locales).filter((tag) => {
    try {
      new Intl.PluralRules(tag);
      return true;
    } catch {
      return false;
    }
  });

  type SelectArm = { tag: string; arms: string };
  const selectsByKey = new Map<string, SelectArm[]>();

  for (const tag of tags) {
    const catalogue = messages[tag];
    if (catalogue === undefined) continue;
    const cat = `messages/${tag}.json`;

    for (const [key, rawValue] of Object.entries(catalogue)) {
      if (typeof rawValue === "object" && rawValue !== null && !Array.isArray(rawValue)) {
        report(cat, `"${key}" is an obsolete map: compile to ICU MessageFormat`);
        continue;
      }
      let ast: MessageNode[] | null = null;
      if (Array.isArray(rawValue)) {
        ast = rawValue as MessageNode[];
      } else if (typeof rawValue === "string" && rawValue.includes("{")) {
        try {
          const parsed = parseMessage(rawValue);
          if (Array.isArray(parsed)) ast = parsed;
        } catch {
          // Syntax errors are reported during catalog parsing/compilation
        }
      }
      if (!Array.isArray(ast)) continue;

      const visit = (nodes: MessageNode[]) => {
        for (const node of nodes) {
          if (node.type === 1) { // argument
            if (/^msg[.[]/.test(node.value)) {
              report(cat, `"${key}" [${tag}] names another message: an arm is text, not a key`);
            }
          } else if (node.type === 6) { // plural
            const arms = Object.keys(node.options).sort();
            const want: string[] = [...new Intl.PluralRules(tag).resolvedOptions().pluralCategories].sort();
            const missing = want.filter((c) => !arms.includes(c));
            const extra = arms.filter((c) => !c.startsWith("=") && !want.includes(c));
            if (missing.length > 0 || extra.length > 0) {
              report(
                cat,
                `plural "${key}" [${tag}] carries [${arms.join(", ")}]; ${tag} pluralizes as [${want.join(", ")}]` +
                  `${missing.length > 0 ? ` — missing ${missing.join(", ")}` : ""}` +
                  `${extra.length > 0 ? ` — ${extra.join(", ")} is not a category of this language` : ""}`,
              );
            }
            for (const opt of Object.values(node.options) as { value?: MessageNode[] }[]) {
              if (opt?.value) visit(opt.value);
            }
          } else if (node.type === 5) { // select
            const arms = Object.keys(node.options).sort().join(", ");
            const list = selectsByKey.get(key) ?? [];
            list.push({ tag, arms });
            selectsByKey.set(key, list);
            for (const opt of Object.values(node.options) as { value?: MessageNode[] }[]) {
              if (opt?.value) visit(opt.value);
            }
          }
        }
      };
      visit(ast);
    }
  }

  // 3. Select options must agree across locales
  for (const [key, list] of selectsByKey) {
    const first = list[0];
    for (const item of list.slice(1)) {
      if (item.arms !== first.arms) {
        report(
          `messages/${item.tag}.json`,
          `select "${key}" [${item.tag}] carries [${item.arms}] where [${first.tag}] carries [${first.arms}]: one column picks both`,
        );
      }
    }
  }

  return findings;
}

/**
 * The words the TERMINAL says: the login gate's copy, the control that ends a
 * session, and the label each route wears on the nav strip. No rule above
 * reaches them — they are drawn by the terminal rather than by any screen — so
 * without this a fully translated app still wears English chrome.
 *
 * The terminal ships built-in copy for every chrome key, which is what an app
 * declaring no catalogues shows, so nothing here is asked of such an app. Of
 * one that does declare them, only the chrome its own declaration puts on
 * screen is asked: the gate where auth is required, the strip wherever a
 * session exists, and a label only for a route the strip actually lists.
 *
 * Under the label half sits a stronger check: the emitter resolves `nav.labels`
 * out of the catalogues, so a missing key is a cue error before any check runs.
 * It is restated here for the reason checkLocalizedUrls states, and because a
 * route carrying no key at all is invisible to that check.
 */
export function checkChrome(
  shell: ShellConfig,
  messages: Record<string, Catalog>,
): Finding[] {
  const findings: Finding[] = [];
  const shellPath = "shell/shell.yaml";
  const report = (path: string, message: string) => findings.push({ severity: "error", path, message });
  const tags = Object.keys(shell.i18n?.locales ?? {});
  if (tags.length === 0) return findings;

  // A catalogue that could not be read is already this run's finding; saying
  // every key is missing from it says the same thing once per key.
  //
  // A map of arms is missing too, and deliberately: the terminal draws its own
  // chrome (interpreter/chrome.js) with no element to carry a selector, so
  // nothing there could pick an arm out of one.
  const said = (tag: string, key: string): boolean => {
    const catalogue = messages[tag];
    if (catalogue === undefined) return true;
    const value = catalogue[key];
    return typeof value === "string" && value.trim() !== "";
  };

  const gated = shell.auth?.required === true;
  // The guest every app with a table of its own is handed is a session too, and
  // a session is what puts the person and the way out in the strip.
  const session = gated || (shell.tables?.length ?? 0) > 0;
  const promote = session && shell.auth?.promote === true;
  for (const key of [...(gated ? CHROME_KEYS.login : []), ...(session ? CHROME_KEYS.session : []), ...(promote ? CHROME_KEYS.promote : [])]) {
    for (const tag of tags) {
      if (said(tag, key)) continue;
      report(`messages/${tag}.json`, `chrome key "${key}" is missing: the terminal speaks its own English here`);
    }
  }

  // A parametrized route has no static href, and a route reached from somewhere
  // more specific than "everywhere" takes itself off — so the strip is what the
  // terminal draws, not the route table. With one route on it and nobody signed
  // in, the terminal draws none at all.
  const strip = (shell.routes ?? []).filter((r) => !r.path.includes(":") && r.nav?.strip !== false);
  if (strip.length <= 1 && !session) return findings;
  for (const route of strip) {
    const key = route.nav?.key;
    if (key === undefined) {
      report(
        shellPath,
        `route '${route.screen}' wears the strip label ${JSON.stringify(route.nav?.label)} in every locale: ` +
          `name a message key for it`,
      );
      continue;
    }
    for (const tag of tags) {
      if (!said(tag, key)) report(`messages/${tag}.json`, `route '${route.screen}' [${tag}]: label key "${key}" is missing`);
      const label = route.nav?.labels?.[tag];
      if (typeof label !== "string" || label.trim() === "") {
        report(shellPath, `route '${route.screen}' [${tag}]: nav.labels resolves "${key}" to nothing`);
      }
    }
  }
  return findings;
}

/** A column bound into a screen is read by somebody, so what a handler writes
 * there is text a reader sees — and a sentence written there is a sentence no
 * locale can reach, because it is already in the language the handler was
 * typed in. The markup says which columns those are: every `{name}` it
 * interpolates is a column that arrives on screen.
 *
 * A key is what a handler may write instead. The catalogue turns it into the
 * reader's language, and the row carries the parameters it interpolates — the
 * stake, the opponent's name — as columns of its own, already bound. */
export function checkHandlerText(
  files: Record<string, string>,
  handlers: Record<string, string>,
): Finding[] {
  const findings: Finding[] = [];
  // Only the columns a screen renders AS TEXT: a column bound into a data-*
  // the dealer reads is state, not language, and the deadlines and scores that
  // travel that way are not sentences anyone reads.
  const bound = new Set<string>();
  const textBindings = [/data-text="([^"]*)"/g, ...[...USER_FACING_ATTRS].map((a) => new RegExp(`${a}="([^"]*)"`, "g"))];
  for (const html of Object.values(files)) {
    for (const re of textBindings) {
      for (const [, expr] of html.matchAll(re)) {
        for (const [, name] of expr.matchAll(/\{([a-z][a-z0-9_]*)\}/g)) bound.add(name);
      }
    }
  }
  if (bound.size === 0) return findings;

  // A key names a message. Prose is what carries a space between words or the
  // punctuation a sentence ends on — a bare number, a timestamp or a card's
  // face is a value the reader sees but no locale rewrites.
  const isKey = (v: string) => /^[a-z][a-z0-9_]*$/.test(v);
  const isProse = (v: string) => /[A-Za-zÀ-ÿ]/.test(v) && /[ .!?…]/.test(v);

  for (const [path, src] of Object.entries(handlers)) {
    for (const col of bound) {
      const assigned = new RegExp(`\\b${escapeRegex(col)}\\s*[:=]\\s*"([^"\\\\]+)"`, "g");
      for (const [, value] of src.matchAll(assigned)) {
        if (value === "" || isKey(value) || !isProse(value)) continue;
        findings.push({
          severity: "error",
          path,
          message:
            `handler writes prose into the bound column "${col}": ${JSON.stringify(value)} — write a message key and let the screen resolve it`,
        });
      }
    }
  }
  return findings;
}

/** A document with one mount, whose form controls answer as a browser's do. */
function mountDocument() {
  const { document } = parseHTML('<!doctype html><html><head></head><body><div id="mount"></div></body></html>');
  controlProperties(document);
  return document;
}

export async function checkMemoryApp(
  shell: ShellConfig,
  messages: Record<string, Catalog>,
  files: Record<string, string>,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const locales = Object.keys(shell.i18n?.locales ?? {});
  // Every rule below reads one locale against another, so a single-locale app
  // has nothing here to grade — its URL table still does.
  if (locales.length < 2) return findings;

  const defaultLocale = shell.i18n?.default ?? locales[0];
  const secondaryLocales = locales.filter((l) => l !== defaultLocale);

  const document = mountDocument();
  const global = globalThis as unknown as Record<string, unknown>;
  global.document = document;
  global.location ??= new URL("http://app.test/?clock=manual&seed=1");
  (global as { CSS?: { escape: (s: string) => string } }).CSS ??= { escape: (s: string) => s };

  global.fetch = (url: unknown) => {
    const path = new URL(String(url), "http://app.test/").pathname.replace(/^\//, "");
    const source = files[path];
    if (source !== undefined) return Promise.resolve(new Response(source));
    return Promise.reject(new Error(`the screen fetched ${path}, which is not in files`));
  };

  const mount = document.getElementById("mount")!;

  for (const route of shell.routes ?? []) {
    const screenTextsByLocale: Record<string, string[]> = {};
    const html = files[route.files.html] ?? "";
    const hasMsgRefs = html.includes("{msg.");

    for (const locale of locales) {
      screenTextsByLocale[locale] = [];

      try {
        await renderStorybook(mount, "http://app.test/", route, {}, (shell.units ?? {}) as Record<string, never>, {
          messages,
          locale,
          // A data-route link is addressed from the table, so a screen
          // carrying one renders only where the storybook holds it.
          routes: shell.routes,
          i18n: shell.i18n,
          // A money binding resolves its currency and its scale off the bound
          // column, so a screen carrying one renders only where the schema does.
          schema: shell.schema,
        });
      } catch (err) {
        findings.push({
          severity: "error",
          path: route.files.html,
          message: `renderStorybook failed under [${locale}]: ${(err as Error).message}`,
        });
        continue;
      }

      const defCat = messages[defaultLocale] ?? {};
      const locCat = messages[locale] ?? {};

      for (const fig of mount.querySelectorAll("figure")) {
        const state = fig.id.replace(new RegExp(`^${route.screen}-`), "");
        const frame = fig.querySelector(".frame");
        if (!frame) continue;

        for (const el of frame.querySelectorAll("*")) {
          if (el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.closest("script, style")) continue;
          if (el.closest('[translate="no"]')) continue;

          // 1. Exact catalog binding match on data-text="{msg.<key>}"
          const dt = el.getAttribute("data-text");
          if (dt && dt.startsWith("{msg.") && dt.endsWith("}")) {
            const key = dt.slice(5, -1);
            const expected = locCat[key];
            // A key with arms renders one of them, and comparing a rendered
            // arm against the whole map says nothing; checkMessageArms grades
            // those keys instead.
            if (typeof expected === "string") {
              const actual = (el.textContent ?? "").trim();
              const expTrimmed = expected.trim();
              if (actual !== expTrimmed) {
                findings.push({
                  severity: "error",
                  path: route.files.html,
                  message: `state '${state}' [${locale}]: data-text="${dt}" rendered "${actual}", expected "${expTrimmed}"`,
                });
              }
            }
          }

          // 2. Child text nodes: check for un-interpolated placeholders and default-language prose leaks
          for (const child of el.childNodes) {
            if (child.nodeType === 3 /* text node */) {
              const val = (child.nodeValue ?? "").trim();
              if (val.length === 0) continue;
              screenTextsByLocale[locale].push(val);

              const phMatch = val.match(/\{msg\.[^}]+\}/);
              if (phMatch) {
                findings.push({
                  severity: "error",
                  path: route.files.html,
                  message: `state '${state}' [${locale}]: un-interpolated placeholder '${phMatch[0]}' in <${el.tagName.toLowerCase()}>`,
                });
              }

              if (locale !== defaultLocale && !dt && !val.startsWith("Sample ")) {
                for (const [key, defVal] of Object.entries(defCat)) {
                  const locVal = locCat[key];
                  if (typeof defVal === "string" && typeof locVal === "string") {
                    const d = defVal.trim();
                    const l = locVal.trim();
                    if (
                      d.length >= 4 &&
                      d.toLowerCase() !== l.toLowerCase() &&
                      !l.toLowerCase().includes(d.toLowerCase())
                    ) {
                      const regex = new RegExp(`(?:^|\\W)${escapeRegex(d)}(?:$|\\W)`, "i");
                      if (regex.test(val)) {
                        findings.push({
                          severity: "error",
                          path: route.files.html,
                          message: `state '${state}' [${locale}]: '${defaultLocale}' text leak '${d}' (expected '${l}') in <${el.tagName.toLowerCase()}> text: "${val}"`,
                        });
                      }
                    }
                  }
                }
              }
            }
          }

          // 3. User-facing attributes: check placeholders and default-language leaks
          for (const attr of el.attributes ?? []) {
            const name = attr.name;
            if (name === "data-text" || name.startsWith("data-") || !USER_FACING_ATTRS.has(name)) continue;
            const val = (attr.value ?? "").trim();
            if (val.length === 0) continue;

            const phMatch = val.match(/\{msg\.[^}]+\}/);
            if (phMatch) {
              findings.push({
                severity: "error",
                path: route.files.html,
                message: `state '${state}' [${locale}]: un-interpolated placeholder '${phMatch[0]}' in ${name}="${val}"`,
              });
            }

            if (locale !== defaultLocale) {
              for (const [key, defVal] of Object.entries(defCat)) {
                const locVal = locCat[key];
                if (typeof defVal === "string" && typeof locVal === "string") {
                  const d = defVal.trim();
                  const l = locVal.trim();
                  if (
                    d.length >= 4 &&
                    d.toLowerCase() !== l.toLowerCase() &&
                    !l.toLowerCase().includes(d.toLowerCase())
                  ) {
                    const regex = new RegExp(`(?:^|\\W)${escapeRegex(d)}(?:$|\\W)`, "i");
                    if (regex.test(val)) {
                      findings.push({
                        severity: "error",
                        path: route.files.html,
                        message: `state '${state}' [${locale}]: '${defaultLocale}' text leak in ${name}="${val}" (expected '${l}')`,
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // 4. Divergence: localized screens must not produce identical visible text to defaultLocale
    const defTexts = screenTextsByLocale[defaultLocale]?.join(" ") ?? "";
    if (hasMsgRefs && defTexts.length > 0) {
      for (const sec of secondaryLocales) {
        const secTexts = screenTextsByLocale[sec]?.join(" ") ?? "";
        if (secTexts === defTexts) {
          findings.push({
            severity: "error",
            path: route.files.html,
            message: `route '${route.path}' [${sec}]: rendered text is identical to '${defaultLocale}'; localization did not take effect`,
          });
        }
      }
    }
  }

  return findings;
}

/* --- the string that reaches no catalogue --------------------------------
 *
 * Every rule above compares one shipped locale against another, so a run that
 * reaches no catalogue at all is invisible to them: it paints the same in every
 * language, which is exactly what a translated string does. The static
 * invariant that reads prose out of the markup cannot see it either — it walks
 * the parsed document, and a <template data-item> keeps its children in a
 * fragment that querySelectorAll does not descend into.
 *
 * So ask the opposite question. Synthesize a catalogue that is TOTAL over the
 * default one's keys and decorate every sentence in it beyond mistaking, render
 * the app under a locale nothing declares, and report whatever came out plain.
 * Total is what makes the rule decidable rather than a heuristic: lookup's
 * fall-back to the default catalogue can never fire, so an undecorated run
 * provably did not come from a catalogue.
 *
 * The same render is where the screen root's `dir` is observed, because it is
 * the only check that paints one without a browser.
 */

/** Two tags: one per direction, so the dir write is exercised both ways by the
 * same pass. XA and XB are the private-use spellings the industry already uses
 * for this, and both are canonical under Intl — an app could legally declare
 * one, which is what keeps the choice from painting anyone into a corner. */
const PSEUDO_TAGS = ["en-XA", "ar-XB"];

const OPEN = "⟦";
const CLOSE = "⟧";

/** Latin letters mapped to a decorated twin: still readable, unmistakably not
 * the sentence the author wrote. Anything outside it — CJK, Arabic, digits,
 * punctuation — passes through, and the brackets are what the rule tests, so
 * a catalogue in a script this table does not cover is graded all the same. */
const ACCENTS: Record<string, string> = {
  a: "á", b: "ƀ", c: "ç", d: "ð", e: "é", f: "ƒ", g: "ĝ", h: "ĥ", i: "í", j: "ĵ",
  k: "ķ", l: "ļ", m: "ɱ", n: "ñ", o: "ó", p: "þ", q: "ǫ", r: "ŕ", s: "š", t: "ţ",
  u: "ú", v: "ṽ", w: "ŵ", x: "ẋ", y: "ý", z: "ž",
  A: "Á", B: "Ɓ", C: "Ç", D: "Ð", E: "É", F: "Ƒ", G: "Ĝ", H: "Ĥ", I: "Í", J: "Ĵ",
  K: "Ķ", L: "Ļ", M: "Ṁ", N: "Ñ", O: "Ó", P: "Þ", Q: "Ǫ", R: "Ŕ", S: "Š", T: "Ţ",
  U: "Ú", V: "Ṽ", W: "Ŵ", X: "Ẋ", Y: "Ý", Z: "Ž",
};

/** A run of two or more letters in any script — what makes a text a sentence
 * rather than a separator, a digit or an icon. */
const PROSE = /\p{L}{2,}/u;

/** What the storybook's own fixture rows spell (storybook.js fixture()), which
 * is data standing in for a row and not copy anybody translates. */
/** What the storybook answered with, rather than what an author wrote. Not
 * anchored: markup decorates a bound value as readily as it prints one — a tag
 * page writes "#{param.name}" and a byline writes "@{handle}" — and an anchored
 * test stops recognising its own fixture the moment one character precedes it.
 * A missed finding is the cost of a false negative here; a false POSITIVE is a
 * checker telling an app to translate a row. */
const SYNTHETIC = /(Sample |fixture-)/;

/** A run that is nothing but bindings. An un-interpolated binding is a
 * different finding, reported by checkMemoryApp against the shipped locales;
 * reporting it twice under a tag no app declares would say the pseudo pass
 * found something it did not. */
const ONLY_PLACEHOLDERS = new RegExp(`^(?:\\s*${PLACEHOLDER.source}\\s*)+$`);

/** One sentence, decorated and grown by 40% — the expansion a translation into
 * German or Finnish costs. Bindings are left alone: accenting the inside of
 * `{param.name}` would break the lookup and turn a layout question into an
 * un-interpolated placeholder. */
function pseudoSentence(text: string): string {
  const parts = text.split(PLACEHOLDERS);
  const body = parts
    .map((part, i) => (i % 2 === 1 ? `{${part}}` : [...part].map((c) => ACCENTS[c] ?? c).join("")))
    .join("");
  const pad = "·".repeat(Math.ceil((text.match(/\p{L}/gu)?.length ?? 0) * 0.4));
  return `${OPEN}${body}${pad}${CLOSE}`;
}

function pseudoAst(nodes: MessageNode[], tag: string): MessageNode[] {
  const categories = new Intl.PluralRules(tag).resolvedOptions().pluralCategories;
  return nodes.map((node) => {
    switch (node.type) {
      case 0:
        return { type: 0, value: pseudoSentence(node.value) };
      case 1:
        return { ...node };
      case 5: {
        const options: Record<string, { value: MessageNode[] }> = {};
        for (const [k, v] of Object.entries(node.options) as [string, { value: MessageNode[] }][]) {
          options[k] = { value: pseudoAst(v.value, tag) };
        }
        return { ...node, options };
      }
      case 6: {
        const options: Record<string, { value: MessageNode[] }> = {};
        for (const [k, v] of Object.entries(node.options) as [string, { value: MessageNode[] }][]) {
          options[k] = { value: pseudoAst(v.value, tag) };
        }
        const spare = options.other ?? Object.values(options)[0];
        for (const category of categories) {
          options[category] ??= spare;
        }
        return { ...node, options };
      }
      case 7:
        return { ...node };
      default:
        return node;
    }
  });
}

/** Total over keys AND over arms. The arm set a message needs is the pseudo
 * tag's own — Arabic asks for zero/two/few where Portuguese asks for none of
 * them — so an AST carried over unchanged makes the render throw rather than
 * report. The missing arms are the decorated `other`, which says the right
 * thing for a pass that grades reach rather than grammar. */
function pseudoCatalog(source: Catalog, tag: string): Catalog {
  const categories = new Intl.PluralRules(tag).resolvedOptions().pluralCategories;
  const out: Catalog = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") {
      out[key] = pseudoSentence(value);
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = pseudoAst(value as MessageNode[], tag);
      continue;
    }
    const arms: Arms = Object.fromEntries(Object.entries(value).map(([arm, s]) => [arm, pseudoSentence(s)]));
    const spare = arms.other ?? Object.values(arms)[0];
    for (const category of categories) arms[category] ??= spare;
    out[key] = arms;
  }
  return out;
}

export async function checkPseudoLocale(
  shell: ShellConfig,
  messages: Record<string, Catalog>,
  files: Record<string, string>,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const i18n = shell.i18n;
  if (i18n === undefined) return findings;
  const source = messages[i18n.default];
  // The default catalogue is what the pseudo one is total over. Its absence is
  // already reported by the read in checkApp, and guessing a key set from a
  // secondary locale would grade the app against a catalogue nobody ships.
  if (source === undefined) return findings;

  // A locale nothing declares has no address, and routeHref refuses to compose
  // a link it has no pattern for. So the pseudo tag borrows the default's
  // patterns: the app's own shell.yaml is untouched and this view exists only
  // for the length of the render.
  const view: I18n = {
    default: i18n.default,
    locales: { ...i18n.locales, ...Object.fromEntries(PSEUDO_TAGS.map((t) => [t, { path: t.toLowerCase() }])) },
  };
  const routes = (shell.routes ?? []).map((route) =>
    route.paths === undefined
      ? route
      : {
        ...route,
        paths: { ...route.paths, ...Object.fromEntries(PSEUDO_TAGS.map((t) => [t, route.paths![i18n.default]])) },
      }
  );
  const catalogues = { ...messages, ...Object.fromEntries(PSEUDO_TAGS.map((t) => [t, pseudoCatalog(source, t)])) };

  const document = mountDocument();
  const global = globalThis as unknown as Record<string, unknown>;
  global.document = document;
  global.location ??= new URL("http://app.test/?clock=manual&seed=1");
  (global as { CSS?: { escape: (s: string) => string } }).CSS ??= { escape: (s: string) => s };
  global.fetch = (url: unknown) => {
    const path = new URL(String(url), "http://app.test/").pathname.replace(/^\//, "");
    const src = files[path];
    if (src !== undefined) return Promise.resolve(new Response(src));
    return Promise.reject(new Error(`the screen fetched ${path}, which is not in files`));
  };
  const mount = document.getElementById("mount")!;

  for (const route of routes) {
    for (const tag of PSEUDO_TAGS) {
      try {
        await renderStorybook(mount, "http://app.test/", route, {}, (shell.units ?? {}) as Record<string, never>, {
          messages: catalogues,
          locale: tag,
          routes,
          i18n: view,
          schema: shell.schema,
        });
      } catch (err) {
        findings.push({
          severity: "error",
          path: route.files.html,
          message: `renderStorybook failed under the pseudo locale [${tag}]: ${(err as Error).message}`,
        });
        continue;
      }

      const wanted = directionOf(tag);
      for (const fig of mount.querySelectorAll("figure")) {
        const state = fig.id.replace(new RegExp(`^${route.screen}-`), "");
        const frame = fig.querySelector(".frame");
        if (!frame) continue;

        // The screen root, not the document: a row carrying its own locale
        // switches one screen and leaves the page around it alone. Reported
        // rather than skipped when the frame is empty, because a silently
        // ungraded frame is how this claim stops being observed.
        const root = frame.firstElementChild;
        const said = root?.getAttribute("dir");
        if (said !== wanted) {
          findings.push({
            severity: "error",
            path: route.files.html,
            message: root === null
              ? `state '${state}' [${tag}]: the frame painted no screen`
              : `state '${state}' [${tag}]: the screen root says dir=${JSON.stringify(said)}, and ${tag} reads ${wanted}`,
          });
        }

        for (const el of frame.querySelectorAll("*")) {
          if (el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.closest("script, style")) continue;
          if (el.closest('[translate="no"]')) continue;
          // Intl formats a date or an amount under the pseudo tag's base
          // language, so its output is correctly undecorated: "Aug 2, 09:00" is
          // not a string anybody translates.
          if (el.closest("[data-text-format]")) continue;

          const plain = (where: string, value: string) => {
            const val = value.trim();
            if (val === "" || val.includes(OPEN) || SYNTHETIC.test(val)) return;
            if (!PROSE.test(val) || ONLY_PLACEHOLDERS.test(val)) return;
            findings.push({
              severity: "error",
              path: route.files.html,
              message: `state '${state}' [${tag}]: ${where} reads ${JSON.stringify(val)}, which reaches no catalogue`,
            });
          };

          for (const child of el.childNodes) {
            if (child.nodeType === 3) plain(`<${el.tagName.toLowerCase()}>`, child.nodeValue ?? "");
          }
          for (const attr of el.attributes ?? []) {
            if (USER_FACING_ATTRS.has(attr.name)) plain(`${attr.name}=`, attr.value ?? "");
          }
        }
      }
    }
  }

  return findings;
}

export async function selfTest(): Promise<{ failures: string[] }> {
  const failures: string[] = [];

  const baseShell: ShellConfig = {
    app: "testapp",
    i18n: { default: "pt", locales: { pt: { path: "pt" }, es: { path: "es" } } },
    routes: [
      {
        path: "/",
        screen: "home",
        files: { html: "home.html", css: "home.css" },
        states: ["populated"],
      },
    ],
  };

  const baseMessages = {
    pt: { greeting: "Olá mundo", note: "fixas", btn_title: "Fechar janela" },
    es: { greeting: "Hola mundo", note: "fijas", btn_title: "Cerrar ventana" },
  };

  // Case 1: Clean localized app passes with 0 findings
  const cleanFiles = {
    "home.html": `<section class="screen" data-screen="home">
      <h1 data-text="{msg.greeting}">Olá mundo</h1>
      <span class="note" data-text="{msg.note}">fixas</span>
      <button type="button" title="{msg.btn_title}">X</button>
    </section>`,
    "home.css": "",
  };
  const cleanFindings = await checkMemoryApp(baseShell, baseMessages, cleanFiles);
  if (cleanFindings.length !== 0) {
    failures.push(`clean app expected 0 findings, got ${JSON.stringify(cleanFindings)}`);
  }

  // Case 2: Catches un-interpolated placeholder in text node
  const placeholderFiles = {
    "home.html": `<section class="screen" data-screen="home">
      <h1>{msg.missing_key}</h1>
    </section>`,
    "home.css": "",
  };
  const phFindings = await checkMemoryApp(baseShell, baseMessages, placeholderFiles);
  if (!phFindings.some((f) => f.message.includes("missing_key"))) {
    failures.push(`expected placeholder finding, got ${JSON.stringify(phFindings)}`);
  }

  // Case 3: Catches un-interpolated placeholder in attribute
  const attrPhFiles = {
    "home.html": `<section class="screen" data-screen="home">
      <button type="button" title="{msg.missing_title}">X</button>
    </section>`,
    "home.css": "",
  };
  const attrPhFindings = await checkMemoryApp(baseShell, baseMessages, attrPhFiles);
  if (!attrPhFindings.some((f) => f.message.includes("missing_title"))) {
    failures.push(`expected attribute placeholder finding, got ${JSON.stringify(attrPhFindings)}`);
  }

  // Case 4: Catches raw Portuguese text leak in secondary locale
  const leakFiles = {
    "home.html": `<section class="screen" data-screen="home">
      <h1 data-text="{msg.greeting}">Olá mundo</h1>
      <span class="untranslated-note">fixas</span>
    </section>`,
    "home.css": "",
  };
  const leakFindings = await checkMemoryApp(baseShell, baseMessages, leakFiles);
  if (!leakFindings.some((f) => f.message.includes("text leak 'fixas' (expected 'fijas')"))) {
    failures.push(`expected Portuguese leak finding, got ${JSON.stringify(leakFindings)}`);
  }

  // Case 5: Catches lack of divergence when secondary locale is unlocalized
  const noDivMessages = {
    pt: { greeting: "Olá mundo", note: "fixas", btn_title: "Fechar janela" },
    es: { greeting: "Olá mundo", note: "fixas", btn_title: "Fechar janela" },
  };
  const noDivFindings = await checkMemoryApp(baseShell, noDivMessages, cleanFiles);
  if (!noDivFindings.some((f) => f.message.includes("rendered text is identical to 'pt'"))) {
    failures.push(`expected divergence failure finding, got ${JSON.stringify(noDivFindings)}`);
  }

  failures.push(...urlFailures());
  failures.push(...chromeFailures());
  failures.push(...armFailures());
  failures.push(...await pseudoFailures());
  return { failures };
}

/** The pseudo-locale rules. The sound app comes first and carries the dir claim
 * with it: a frame whose root lost its `dir` is a finding under both tags, so
 * "0 findings" is the whole of what interpreter/screen.js's applyLocale writes,
 * observed rather than assumed. */
async function pseudoFailures(): Promise<string[]> {
  const failures: string[] = [];

  const shell: ShellConfig = {
    app: "testapp",
    i18n: { default: "pt", locales: { pt: { path: "pt" } } },
    routes: [{
      path: "/",
      screen: "home",
      files: { html: "home.html", css: "home.css" },
      states: ["populated"],
    }],
  };
  const messages = { pt: { greeting: "Olá mundo", btn_title: "Fechar janela", item: "Item" } };
  const region = `<section data-live="note"><template data-item>` +
    `<li data-text="{msg.item}"></li></template></section>`;
  const home = (extra: string) => ({
    "home.html": `<section class="screen" data-screen="home">
      <h1 data-text="{msg.greeting}">Olá mundo</h1>
      <button type="button" title="{msg.btn_title}">×</button>
      ${extra}
    </section>`,
    "home.css": "",
  });

  const clean = await checkPseudoLocale(shell, messages, home(region));
  if (clean.length !== 0) failures.push(`a localized app expected 0 pseudo findings, got ${JSON.stringify(clean)}`);

  // One per pseudo tag: the run is undecorated in both, and a rule that
  // reported it once would be reporting the tag rather than the string.
  const bare = await checkPseudoLocale(shell, messages, home(`<span>Rodada encerrada</span>`));
  if (bare.length !== PSEUDO_TAGS.length || !bare.every((f) => f.message.includes("Rodada encerrada"))) {
    failures.push(`expected one finding per pseudo tag naming the bare span, got ${JSON.stringify(bare)}`);
  }

  // The regression this pass exists for: the static prose invariant walks the
  // parsed document, and linkedom's querySelectorAll does not descend into a
  // <template>'s content — so copy hidden in an item template is graded here
  // and nowhere else.
  const templated = await checkPseudoLocale(
    shell,
    messages,
    home(`<section data-live="note"><template data-item>` +
      `<li title="Desconto aplicado" data-text="{msg.item}"></li></template></section>`),
  );
  if (!templated.some((f) => f.message.includes("Desconto aplicado"))) {
    failures.push(`expected a finding inside the item template, got ${JSON.stringify(templated)}`);
  }

  // A fixture row is data standing in for a row, not copy anybody translates.
  const fixtures = await checkPseudoLocale(
    shell,
    messages,
    home(`<section data-live="note"><template data-item>` +
      `<li data-text="{title}"></li></template></section>`),
  );
  if (fixtures.length !== 0) failures.push(`a fixture-derived run is not copy, got ${JSON.stringify(fixtures)}`);

  // Elements marked translate="no" are explicitly non-translatable and pass cleanly.
  const untranslated = await checkPseudoLocale(
    shell,
    messages,
    home(`<section translate="no"><span>Explicitly untranslated section</span></section>`),
  );
  if (untranslated.length !== 0) failures.push(`translate="no" element expected 0 findings, got ${JSON.stringify(untranslated)}`);

  // Intl formats under the pseudo tag's base language, so a timestamp comes out
  // correctly undecorated — and it is not a string a catalogue holds.
  const formatted = await checkPseudoLocale(
    shell,
    messages,
    home(`<section data-live="note"><template data-item>` +
      `<li data-text="{due}" data-text-format="datetime"></li></template></section>`),
  );
  if (formatted.length !== 0) failures.push(`a formatted value is not copy, got ${JSON.stringify(formatted)}`);

  return failures;
}

/** The arm rules, each against the sound declaration with one thing moved. The
 * sound one comes first, and it is three languages deep on purpose: pt-BR and
 * es pluralize as one/many/other where en is one/other, which is the whole
 * reason the category set is computed rather than written down here. */
function armFailures(): string[] {
  const failures: string[] = [];

  const i18n: I18n = {
    default: "pt-BR",
    locales: { "pt-BR": { path: "pt-br" }, es: { path: "es" }, en: { path: "en" } },
  };
  const routes: Route[] = [{ screen: "home", path: "/", files: { html: "home.html", css: "home.css" } }];
  const html = (item: string) => ({ "home.html": `<section data-screen="home">${item}</section>` });
  const priced = html(`<small data-text="{msg.worth}"></small>`);
  const messages: Record<string, Catalog> = {
    "pt-BR": compileCatalog({ worth: "{rung, plural, one {vale # ponto} many {vale # pontos} other {vale # pontos}}" }) as Catalog,
    es: compileCatalog({ worth: "{rung, plural, one {vale # punto} many {vale # puntos} other {vale # pontos}}" }) as Catalog,
    en: compileCatalog({ worth: "{rung, plural, one {worth # point} other {worth # points}}" }) as Catalog,
  };

  const sound = checkMessageArms(i18n, routes, messages, priced);
  if (sound.length !== 0) failures.push(`a sound plural expected 0 findings, got ${JSON.stringify(sound)}`);

  const grades = (
    name: string,
    want: string,
    over: { messages?: Record<string, Catalog>; files?: Record<string, string> },
  ) => {
    const got = checkMessageArms(i18n, routes, over.messages ?? messages, over.files ?? priced);
    if (got.some((f) => f.message.includes(want))) return;
    failures.push(`${name}: expected a finding saying ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  };

  grades("a Spanish plural short an arm its language has", "missing many", {
    messages: {
      ...messages,
      es: compileCatalog({ worth: "{rung, plural, one {vale # punto} other {vale # pontos}}" }) as Catalog,
    },
  });

  grades("an English plural carrying an arm its language does not have", "many is not a category of this language", {
    messages: {
      ...messages,
      en: compileCatalog({ worth: "{rung, plural, one {worth # point} many {worth # points} other {worth # points}}" }) as Catalog,
    },
  });

  grades("an element carrying obsolete data-msg-plural", "obsolete data-msg-plural", {
    files: html(`<small data-text="{msg.worth}" data-msg-plural="rung"></small>`),
  });

  grades("an element carrying obsolete data-msg-select", "obsolete data-msg-select", {
    files: html(`<small data-text="{msg.worth}" data-msg-select="rung"></small>`),
  });

  grades("an element carrying both obsolete attributes", "an arm is selected once", {
    files: html(`<small data-text="{msg.worth}" data-msg-plural="rung" data-msg-select="rung"></small>`),
  });

  grades("an arm naming another message", "an arm is text, not a key", {
    messages: {
      ...messages,
      "pt-BR": {
        worth: [{
          type: 6,
          value: "rung",
          offset: 0,
          pluralType: "cardinal",
          options: {
            one: { value: [{ type: 1, value: "msg.worth" }] },
            many: { value: [{ type: 0, value: "x" }] },
            other: { value: [{ type: 0, value: "x" }] },
          },
        }],
      },
    },
  });

  const greet = html(`<small data-text="{msg.greet}"></small>`);
  const greetings: Record<string, Catalog> = {
    "pt-BR": compileCatalog({ greet: "{gender, select, f {bem-vinda} m {bem-vindo} other {bem-vinde}}" }) as Catalog,
    es: compileCatalog({ greet: "{gender, select, f {bienvenida} m {bienvenido} other {bienvenide}}" }) as Catalog,
    en: compileCatalog({ greet: "{gender, select, f {welcome} m {welcome} other {welcome}}" }) as Catalog,
  };
  const soundSelect = checkMessageArms(i18n, routes, greetings, greet);
  if (soundSelect.length !== 0) {
    failures.push(`a sound select expected 0 findings, got ${JSON.stringify(soundSelect)}`);
  }
  grades("a select whose locales disagree about the arms", "one column picks both", {
    files: greet,
    messages: {
      ...greetings,
      es: compileCatalog({ greet: "{gender, select, f {bienvenida} n {bienvenide} other {bienvenide}}" }) as Catalog,
    },
  });

  return failures;
}

/** The chrome's rules, each against the sound declaration with one thing moved.
 * The sound one comes first, and the last two cases are the reason the strip is
 * filtered rather than read straight off the route table. */
function chromeFailures(): string[] {
  const failures: string[] = [];

  const i18n: I18n = { default: "pt-BR", locales: { "pt-BR": { path: "pt-br" }, es: { path: "es" } } };
  const route = (screen: string, path: string, nav: Route["nav"]): Route => ({
    screen,
    path,
    nav,
    files: { html: `${screen}.html`, css: `${screen}.css` },
  });
  const shell: ShellConfig = {
    app: "testapp",
    i18n,
    auth: { required: true },
    tables: ["match"],
    routes: [
      route("arena", "/", { label: "Mesa", key: "nav_table", labels: { "pt-BR": "Mesa", es: "Mesa" } }),
      route("bar", "/bar", { label: "Bar", key: "nav_bar", labels: { "pt-BR": "Bar", es: "Bar" } }),
    ],
  };
  const catalogue = {
    chrome_signin_hint: "Um toque",
    chrome_signin: "Entrar",
    chrome_signin_guest: "Entrar como convidado",
    chrome_signin_failed: "Não deu certo",
    chrome_signout: "sair",
    nav_table: "Mesa",
    nav_bar: "Bar",
  };
  const messages = { "pt-BR": catalogue, es: catalogue };

  const sound = checkChrome(shell, messages);
  if (sound.length !== 0) failures.push(`sound chrome expected 0 findings, got ${JSON.stringify(sound)}`);

  const grades = (
    name: string,
    want: string,
    over: { shell?: Partial<ShellConfig>; messages?: Record<string, Catalog> },
  ) => {
    const got = checkChrome({ ...shell, ...over.shell }, over.messages ?? messages);
    if (got.some((f) => f.message.includes(want))) return;
    failures.push(`${name}: expected a finding saying ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  };

  const quiet = (name: string, over: { shell?: Partial<ShellConfig>; messages?: Record<string, Catalog> }) => {
    const got = checkChrome({ ...shell, ...over.shell }, over.messages ?? messages);
    if (got.length !== 0) failures.push(`${name}: expected 0 findings, got ${JSON.stringify(got)}`);
  };

  const without = (key: string) => {
    const { [key]: _gone, ...rest } = catalogue as Record<string, string>;
    return { "pt-BR": catalogue as Record<string, string>, es: rest };
  };

  grades("a gate whose Spanish has no Continue", `chrome key "chrome_signin" is missing`, {
    messages: without("chrome_signin"),
  });

  grades("a session whose Spanish has no way out", `chrome key "chrome_signout" is missing`, {
    messages: without("chrome_signout"),
  });

  // The strip names the person and the way out for a guest exactly as it does
  // behind a gate, so an ungated app with a table of its own is still asked.
  grades("an ungated app with a table of its own", `chrome key "chrome_signout" is missing`, {
    shell: { auth: { required: false } },
    messages: without("chrome_signout"),
  });

  // A guest offered a passkey reads the offer in the page's language; an app
  // that offers none is not asked for it.
  grades("a guest offered a passkey in no Spanish", `chrome key "chrome_passkey" is missing`, {
    shell: { auth: { required: false, promote: true } },
  });
  quiet("an app that offers no passkey", { shell: { auth: { required: false } } });

  // The whole of the built-in copy's point: an app that shows neither surface
  // is asked for none of it.
  // Deliberately narrower than `catalogue`, and typed as the catalogue it is
  // rather than as the one this suite's others are: an app reaching neither
  // surface carries none of the chrome keys, which is the whole claim.
  const navOnly: Record<string, string> = { nav_table: "Mesa", nav_bar: "Bar" };
  quiet("an app with no gate and no table", {
    shell: { auth: { required: false }, tables: [] },
    messages: { "pt-BR": navOnly, es: navOnly },
  });

  grades("a strip label spelled in the route table alone", `route 'bar' wears the strip label "Bar"`, {
    shell: { routes: [shell.routes![0], route("bar", "/bar", { label: "Bar" })] },
  });

  grades("a label key no catalogue answers", `route 'bar' [es]: label key "nav_bar" is missing`, {
    messages: without("nav_bar"),
  });

  grades("a label the emitter resolved for one locale only", `route 'bar' [es]: nav.labels resolves "nav_bar"`, {
    shell: {
      routes: [shell.routes![0], route("bar", "/bar", { label: "Bar", key: "nav_bar", labels: { "pt-BR": "Bar" } })],
    },
  });

  quiet("a route that takes itself off the strip", {
    shell: { routes: [shell.routes![0], route("bar", "/bar", { label: "Bar", strip: false })] },
  });

  quiet("a route whose address has a hole in it", {
    shell: { routes: [shell.routes![0], route("perfil", "/perfil/:handle", { label: "Perfil" })] },
  });

  return failures;
}

/** The URL table's rules, each against the sound declaration with one thing
 * moved. The sound one comes first: a rule that refuses a correct route table
 * stops every app generating, and every case below is a mutation of markup an
 * app really ships. */
function urlFailures(): string[] {
  const failures: string[] = [];

  const at = (screen: string, path: string, rest: Partial<Route> = {}): Route => ({
    screen,
    path,
    files: { html: `${screen}.html`, css: `${screen}.css` },
    ...rest,
  });

  const i18n: I18n = {
    default: "pt-BR",
    locales: { "pt-BR": { path: "pt-br" }, es: { path: "es" }, en: { path: "en" } },
  };
  const routes: Route[] = [
    at("arena", "/"),
    at("regras", "/regras", {
      slug: "route_rules",
      prerender: true,
      paths: { "pt-BR": "/regras", es: "/reglas", en: "/rules" },
    }),
    at("article", "/artigo/:slug", {
      slug: "route_article",
      paths: { "pt-BR": "/artigo/:slug", es: "/articulo/:slug", en: "/article/:slug" },
    }),
  ];
  const messages = {
    "pt-BR": { route_rules: "regras", route_article: "artigo" },
    es: { route_rules: "reglas", route_article: "articulo" },
    en: { route_rules: "rules", route_article: "article" },
  };

  const sound = checkLocalizedUrls(i18n, routes, messages);
  if (sound.length !== 0) failures.push(`a sound URL table expected 0 findings, got ${JSON.stringify(sound)}`);

  const grades = (
    name: string,
    want: string,
    over: { i18n?: I18n; routes?: Route[]; messages?: Record<string, Catalog> },
  ) => {
    const got = checkLocalizedUrls(over.i18n ?? i18n, over.routes ?? routes, over.messages ?? messages);
    if (got.some((f) => f.message.includes(want))) return;
    failures.push(`${name}: expected a finding saying ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  };

  // Before any rule about a route: an app whose routes key is missing or empty
  // is graded, rather than passing because there was nothing to disagree with.
  grades("locales declared over an empty route table", "the route table is empty", { routes: [] });

  grades("a slug key no catalogue answers", 'route \'regras\' [es]: slug key "route_rules" is missing', {
    messages: { ...messages, es: { route_article: "articulo" } },
  });

  grades("a slug that is not one URL segment", "is not one lowercase URL segment", {
    messages: { ...messages, es: { ...messages.es, route_rules: "reglas/del/juego" } },
  });

  grades("a slug carrying the accent the author owes a transliteration", "is not one lowercase URL segment", {
    messages: { ...messages, es: { ...messages.es, route_rules: "règlas" } },
  });

  grades("two routes at one address", `routes 'regras' and 'copia' both answer to "/regras"`, {
    routes: [...routes, at("copia", "/regras")],
  });

  grades("two routes whose :params differ in name alone", `both answer to "/artigo/:outro"`, {
    routes: [...routes, at("copia", "/artigo/:outro")],
  });

  grades("a route capturing the name a locale travels under", '":lang" is the name a locale travels under', {
    routes: [...routes, at("idioma", "/idioma/:lang")],
  });

  grades("a default pattern sitting where a locale prefix does", `'es's URL prefix`, {
    routes: [...routes, at("espanhol", "/es")],
  });

  grades("a default naming a locale the app does not carry", "i18n.default 'pt' is not one of the declared", {
    i18n: { ...i18n, default: "pt" },
  });

  grades("two locales reaching for one prefix", `locales 'es' and 'en' both take the URL prefix "es"`, {
    i18n: { ...i18n, locales: { ...i18n.locales, en: { path: "es" } } },
  });

  grades("a prefix that is not one lowercase segment", "which is not one lowercase segment", {
    i18n: { ...i18n, locales: { ...i18n.locales, en: { path: "EN" } } },
  });

  // Intl is what tells a tag from a string shaped like one. `pt_BR` and `ptbr`
  // are refused rather than absorbed; `pt-BR` above is proof the rule is not
  // simply refusing regions.
  grades("an underscore where a hyphen belongs", "locale 'pt_BR' is not a well-formed BCP 47 tag", {
    i18n: { default: "pt_BR", locales: { pt_BR: { path: "pt-br" } } },
  });

  grades("a tag run together", "locale 'ptbr' is not a well-formed BCP 47 tag", {
    i18n: { default: "ptbr", locales: { ptbr: { path: "pt-br" } } },
  });

  grades("a tag spelled in the wrong case", "write 'pt-BR'", {
    i18n: { default: "PT-br", locales: { "PT-br": { path: "pt-br" } } },
  });

  grades("a prerendered route carrying a hole", "a :param names rows that do not exist when the build runs", {
    routes: routes.map((r) => (r.screen === "article" ? { ...r, prerender: true } : r)),
  });

  grades("a translated route missing a locale's pattern", "route 'regras' [en]: paths names no pattern", {
    routes: routes.map((r) => (r.screen === "regras" ? { ...r, paths: { "pt-BR": "/regras", es: "/reglas" } } : r)),
  });

  return failures;
}

export async function run(args: string[]): Promise<void> {
  Deno.exitCode = 1;
  if (args[0] === "--self-test") {
    const { failures } = await selfTest();
    const say = (line: string) => Deno.stderr.writeSync(new TextEncoder().encode(`${line}\n`));
    for (const f of failures) say(`FAIL ${f}`);
    say(failures.length === 0 ? "check-i18n self-test: passed" : `check-i18n self-test: ${failures.length} failed`);
    Deno.exit(failures.length === 0 ? 0 : 1);
  }
  const appDir = args[0];
  if (appDir === undefined) {
    console.error("usage: check-i18n.ts <appDir> | --self-test");
    Deno.exit(1);
  }
  const { findings } = await checkApp(new URL(`${appDir.replace(/\/*$/, "")}/`, `file://${Deno.cwd()}/`));
  console.log(JSON.stringify(findings, null, 2));
  if (findings.length === 0) Deno.exitCode = 0;
}

if (import.meta.main) await run(Deno.args);
