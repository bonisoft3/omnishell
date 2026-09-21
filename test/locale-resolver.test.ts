// The order a screen's language is decided in, asserted where it is defined.
// Four sources re-derived at three call sites is how a row and a path come to
// disagree, so the order is one function and these are its claims.
import { directionOf, localeByPath, localeTable, negotiateLocale, resolveLocale } from "../interpreter/fragment.js";

const assert = (ok: unknown, msg: string) => {
  if (!ok) throw new Error(msg);
};

// The shape an app declares once localized URLs exist.
const I18N = {
  default: "pt-BR",
  locales: {
    "pt-BR": { path: "pt-br" },
    "es": { path: "es" },
    "en": { path: "en" },
  },
};

Deno.test("a declared locale's segment is its own", () => {
  assert(localeTable(I18N)["pt-BR"].path === "pt-br", "pt-BR takes the segment it declares");
  assert(localeByPath(I18N)["pt-br"] === "pt-BR", "the segment resolves back to the tag");
});

Deno.test("the default's segment is in the table, because the server redirects it away", () => {
  // It addresses no document; it exists so /pt-br/regras can 301 to /regras
  // rather than 404 for a reader who guessed the symmetrical spelling.
  assert(localeByPath(I18N)["pt-br"] === "pt-BR", "the default locale keeps a segment");
});

Deno.test("a path outranks every other source", () => {
  const got = resolveLocale(I18N, {
    path: "en",
    query: "es",
    row: "pt-BR",
    preferred: ["es"],
  });
  assert(got === "en", `the address decides a localized route, got ${got}`);
});

Deno.test("a link someone was handed outranks a choice made here", () => {
  const got = resolveLocale(I18N, { query: "es", row: "pt-BR", preferred: ["en"] });
  assert(got === "es", `?lang= outranks the row, got ${got}`);
});

Deno.test("a choice made here outranks a standing browser preference", () => {
  // Accept-Language is a standing need and must never override present intent.
  const got = resolveLocale(I18N, { row: "es", preferred: ["en", "pt-BR"] });
  assert(got === "es", `the row outranks the header, got ${got}`);
});

Deno.test("the header decides where nothing explicit was said", () => {
  assert(resolveLocale(I18N, { preferred: ["en"] }) === "en", "the header is consulted");
  assert(resolveLocale(I18N, {}) === "pt-BR", "and the app's default answers last");
});

Deno.test("an undeclared source is ignored rather than honoured", () => {
  // A row carrying a locale the app does not ship must not blank the screen.
  assert(resolveLocale(I18N, { row: "de" }) === "pt-BR", "an unknown row falls through");
  assert(resolveLocale(I18N, { path: "de", row: "es" }) === "es", "an unknown path falls through");
  assert(resolveLocale(I18N, { query: "" }) === "pt-BR", "an empty query is not a locale");
});

Deno.test("negotiation prefers the exact tag over its own language", () => {
  const regional = { default: "en", locales: { "pt-BR": { path: "pt-br" }, "pt-PT": { path: "pt-pt" }, "en": { path: "en" } } };
  assert(negotiateLocale(regional, ["pt-BR"]) === "pt-BR", "an exact tag wins");
  // A reader asking for bare `pt` gets a Portuguese the app has, rather than
  // the default — which one is the declaration order's to say.
  assert(String(negotiateLocale(regional, ["pt"])).startsWith("pt"), "bare pt finds a Portuguese");
  assert(negotiateLocale(regional, ["de"]) === undefined, "no match is undefined, not a guess");
});

// --- and which way it reads ------------------------------------------------

Deno.test("the engine's own table says which way a language reads", () => {
  // The spectrum the i18n contract names as proved — Hebrew and Arabic with
  // and without a region — plus the Persian/Urdu/Sorani/Yiddish tail, which is
  // where a list of languages assembled by hand starts being wrong.
  for (const tag of ["he", "ar", "fa", "ur", "ckb", "yi", "he-IL", "ar-EG"]) {
    assert(directionOf(tag) === "rtl", `${tag} reads right-to-left, got ${directionOf(tag)}`);
  }
  for (const tag of ["en", "pt-BR", "es", "ja"]) {
    assert(directionOf(tag) === "ltr", `${tag} reads left-to-right, got ${directionOf(tag)}`);
  }
});

Deno.test("a tag nobody can be asked about is an error, not a guess", () => {
  // Answering "ltr" for an absent tag renders Hebrew backwards and reports
  // success; every caller resolves a locale before it asks.
  let threw = false;
  try {
    directionOf(undefined);
  } catch {
    threw = true;
  }
  assert(threw, "an absent tag throws rather than defaulting");
});

// The entry document's dir is written before any script runs, by an emitter
// that has no Intl to ask — so terminal.cue carries the list, and these two are
// what keep it honest.
const terminalCue = await Deno.readTextFile(new URL("../terminal.cue", import.meta.url));
const rtlLanguages = [...(terminalCue.match(/#RtlLanguages:\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)]
  .map((m) => m[1]);

Deno.test("terminal.cue's right-to-left list agrees with the engine", () => {
  assert(rtlLanguages.length > 0, "terminal.cue declares no #RtlLanguages");
  for (const tag of rtlLanguages) {
    assert(directionOf(tag) === "rtl", `#RtlLanguages carries ${tag}, which the engine reads ${directionOf(tag)}`);
  }
});

Deno.test("every tag an app declares is classified the same by the list and by the engine", async () => {
  // The two ways a base-language list can be wrong: a language nobody had
  // declared when it was written, and a tag naming a script that flips its
  // language's direction (sd-Deva reads left-to-right where sd does not).
  const apps = new URL("../../../apps/", import.meta.url);
  let seen = 0;
  for await (const app of Deno.readDir(apps)) {
    if (!app.isDirectory) continue;
    let yaml: string;
    try {
      yaml = await Deno.readTextFile(new URL(`${app.name}/shell/shell.yaml`, apps));
    } catch {
      continue;
    }
    // The emitted `i18n.locales` block: one tag per line, each opening a map.
    const block = yaml.match(/\n {2}locales:\n((?: {4}\S.*\n(?: {6}.*\n)*)+)/)?.[1] ?? "";
    for (const [, tag] of block.matchAll(/^ {4}([\w-]+):$/gm)) {
      seen++;
      const listed = rtlLanguages.includes(tag.split("-")[0]) ? "rtl" : "ltr";
      const engine = directionOf(tag);
      assert(listed === engine, `${app.name} declares ${tag}: the list says ${listed}, the engine says ${engine}`);
    }
  }
  assert(seen > 0, "no app declared a locale, so this asserted nothing");
});
