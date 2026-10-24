// Running app-authored Jessie: the one place the platform evaluates source it
// did not write. Nothing here endows ambient authority — an absent global
// cannot be argued with, which is the only reason app source is safe to run
// unread.

// ses pin: the vendored umd dist (bundle:ses), loaded beside this module —
// same-origin, so the platform's own image is the integrity boundary. One
// load + one lockdown per page; hosts that pre-install Compartment (the deno
// smoke) skip injection.
const SES_URL = new URL("./vendor/ses.umd.min.js", import.meta.url).href;

// SES alone may submit strings to eval/Function. The default policy grants
// that crossing only while the platform is loading or evaluating its cage;
// it never admits script elements, HTML or script URLs.
let evaluating = 0;
let evalPolicy;
function prepareEval() {
  if (globalThis.trustedTypes && !evalPolicy) {
    evalPolicy = trustedTypes.createPolicy("default", {
      createScript(source, _type, sink) {
        if (evaluating === 0 || (sink !== "eval" && sink !== "Function")) throw new TypeError(`untrusted script sink: ${sink}`);
        return source;
      },
    });
  }
}

let sesReady;
// Single-file releases supply their compiled SES installer; the same policy
// window owns both that installation and the ordinary module load.
export function ensureSes(install = () => import(SES_URL)) {
  return (sesReady ??= (async () => {
    prepareEval();
    if (!globalThis.Compartment) {
      evaluating++;
      try {
        await install();
      } finally {
        evaluating--;
      }
    }
    // What the bundle owes: the cage, and the call that seals the realm around
    // it. Running app source without either is not a weaker boundary, it is
    // none, so a host that reaches here with one missing is told which.
    const missing = ["Compartment", "lockdown"].filter((n) => globalThis[n] === undefined);
    if (missing.length > 0) {
      throw new Error(`${SES_URL} installed no ${missing.join(" and no ")}`);
    }
    // lockdown throws when repeated; the flag survives multiple module
    // instances of this file on one page.
    if (!globalThis.__prontoLockdown) {
      globalThis.__prontoLockdown = true;
      evaluating++;
      try {
        lockdown({ errorTaming: "unsafe" });
      } finally {
        evaluating--;
      }
    }
  })());
}

// A Jessie role is a module the app writes and the platform runs: the source's
// last expression is the Compartment's completion value, and the role decides
// what shape that value must have, what the compartment endows, and how the
// authored file is adapted to a script.
// What roles are endowed with: pure, deterministic platform primitives
// granted via manifest endowments or requestedEndowments (SAFE_ENDOWMENTS: tamed Intl,
// TextEncoder, TextDecoder, URL, URLSearchParams). An adapter is endowed with
// Intl by default; other roles receive no endowments unless granted, and one
// reached undeclared throws, naming itself.
// Intl has the host's defaults refused — a module states its locale, its zone
// and its instant, or it throws. Why it is admitted is
// plugins/omnishell/docs/terminal.md#the-seats; the rule about what an adapter
// may STORE out of it is plugins/omnishell/REFERENCE.md#adapters.
const NEEDS_AN_INSTANT = new Set(["format", "formatToParts", "formatRange", "formatRangeToParts"]);

// The raw service behind each wrapper, so a wrapper handed back as an argument
// — `new Intl.DateTimeFormat(someLocale)` — reaches the service as itself.
const behind = new WeakMap();

/**
 * One Intl service, wrapped so the host's defaults are refused. By COMPOSITION
 * and never by subclassing: `class W extends Service` publishes the untamed
 * Service as `Object.getPrototypeOf(W)`, and a module that walks there
 * constructs one with no arguments and reads the machine's zone, locale and
 * clock. Here the service is reachable only from this closure.
 *
 * `locales` is required of every service, `options.timeZone` of the ones that
 * carry a zone, and a formatter refuses to format the instant it was not
 * given. The asked locales are canonicalised before they are compared with the
 * resolved one, so a legacy tag ("iw" for "he") is not read as a fallback.
 */
function stated(Service, name, zoned) {
  const shape = {};
  for (const key of Object.getOwnPropertyNames(Service.prototype)) {
    if (key === "constructor") continue;
    const held = Object.getOwnPropertyDescriptor(Service.prototype, key);
    const guarded = zoned && NEEDS_AN_INSTANT.has(key);
    const unnamed = `Intl.${name}.${key}: name the instant — a formatter with no argument reads the clock`;
    if (held.get !== undefined) {
      Object.defineProperty(shape, key, {
        get() {
          const call = held.get.call(behind.get(this));
          return guarded
            ? (...args) => {
              if (args[0] === undefined) throw new Error(unnamed);
              return call(...args);
            }
            : call;
        },
        configurable: true,
      });
    } else if (typeof held.value === "function") {
      Object.defineProperty(shape, key, {
        value: function (...args) {
          if (guarded && args[0] === undefined) throw new Error(unnamed);
          return held.value.apply(behind.get(this), args);
        },
        writable: true,
        configurable: true,
      });
    }
  }

  function Stated(locales, options) {
    const asked = locales === undefined ? [] : (Array.isArray(locales) ? locales : [locales]);
    if (asked.length === 0) throw new Error(`Intl.${name}: name the locale — the cage has no default`);
    if (zoned && (options === undefined || options.timeZone === undefined)) {
      throw new Error(`Intl.${name}: name the timeZone — the cage has no default`);
    }
    const service = new Service(asked.map((tag) => behind.get(tag) ?? tag), options);
    // A locale the host has no data for resolves to the HOST's own, which is
    // the last way its machine could answer instead of the module's arguments.
    const resolved = typeof service.resolvedOptions === "function" ? service.resolvedOptions().locale : undefined;
    if (resolved !== undefined) {
      const language = (tag) => String(tag).split("-")[0].toLowerCase();
      const canonical = Intl.getCanonicalLocales(asked.map((tag) => String(behind.get(tag) ?? tag)));
      if (!canonical.some((tag) => language(tag) === language(resolved))) {
        throw new Error(
          `Intl.${name}: no data for ${asked.join(", ")} — the cage will not fall back to the host's ${resolved}`,
        );
      }
    }
    const made = Object.create(shape);
    behind.set(made, service);
    return made;
  }
  // A service is callable without `new`, and its statics answer about locale
  // data rather than about the host.
  for (const key of Object.getOwnPropertyNames(Service)) {
    if (typeof Service[key] === "function") Stated[key] = (...args) => Service[key](...args);
  }
  Object.defineProperty(Stated, "name", { value: name });
  Stated.prototype = shape;
  return Stated;
}

// The zone-bearing services; everything else only ever resolves a locale.
const ZONED = new Set(["DateTimeFormat"]);

// Built on first use and kept: `harden` is the lockdown's, so this cannot be
// built at import, and the services are classes worth minting once.
// Capitalised members are the services (`getCanonicalLocales` and
// `supportedValuesOf` are plain functions and pass through).
let endowedIntl;
const intlSubset = () => (endowedIntl ??= harden(Object.fromEntries(
  Object.getOwnPropertyNames(Intl).map((name) => [
    name,
    /^[A-Z]/.test(name) ? stated(Intl[name], name, ZONED.has(name)) : Intl[name],
  ]),
)));

export const SAFE_ENDOWMENTS = {
  Intl: intlSubset,
  TextEncoder: () => TextEncoder,
  TextDecoder: () => TextDecoder,
  URL: () => URL,
  URLSearchParams: () => URLSearchParams,
};

export function buildEndowments(names = []) {
  const result = {};
  for (const name of names) {
    const factory = SAFE_ENDOWMENTS[name];
    if (typeof factory !== "function") {
      throw new Error(`unpermitted endowment "${name}"`);
    }
    result[name] = factory();
  }
  return result;
}

const ROLES = {
  // reduce(state, event) -> {updates}.
  handler: {
    defaultEndowments: [],
    endow: (req = []) => buildEndowments(req),
    wrap: (s) => s,
    ok: (v) => typeof v === "function",
    want: "its reduce function",
  },
  // render(value) -> node description; render.js owns what one may become.
  renderer: {
    defaultEndowments: [],
    endow: (req = []) => buildEndowments(req),
    wrap: (s) => s.replace(/^[ \t]*export[ \t]+default[ \t]+/m, ""),
    ok: (v) => typeof v === "function",
    want: "its render function",
  },
  // validation(state, event) -> boolean.
  validation: {
    defaultEndowments: [],
    endow: (req = []) => buildEndowments(req),
    wrap: (s) => s,
    ok: (v) => typeof v === "function",
    want: "its predicate",
  },
  // adapter(value, {zone}) both ways: format fills a form control from a row's
  // column, parse reads the control's text back. One module carries both, so
  // the halves cannot drift apart into two spellings of one value, and its
  // completion value is the map of pure functions pronto/jessie.ts already
  // calls an adapter.
  adapter: {
    defaultEndowments: ["Intl"],
    endow: (req = []) => buildEndowments(["Intl", ...req]),
    wrap: (s) => s,
    ok: (v) => typeof v === "object" && v !== null && typeof v.format === "function" && typeof v.parse === "function",
    want: "its format and parse functions",
  },
  // A pipeline's browser-side transform (pronto's schema.cue `fold`), authored
  // as an ES module; a Compartment script takes no `export` and yields its last
  // expression, so the wrap adapts it. Only check-handlers loads one: the
  // container runs the pipeline's bloblang, and the terminal's projection of a
  // fold sink counts contributions and calls none of the four.
  //
  // The keyword is stripped whatever follows it. The contract (pronto's
  // schema.cue) names empty, step, combine and result and not how they are
  // spelled, so `export function step()` is as much a fold as
  // `export const step =`, and a rewrite that knew only the latter would hand
  // the compartment an `export` it cannot parse — reporting a syntax error
  // against a file that is perfectly well formed.
  fold: {
    defaultEndowments: [],
    endow: (req = []) => buildEndowments(req),
    wrap: (s) =>
      `${s.replace(/^[ \t]*export[ \t]+/gm, "")}\nharden({ empty, step, combine, result });`,
    ok: (v) =>
      typeof v === "object" && v !== null &&
      ["empty", "step", "combine", "result"].every((k) => typeof v[k] === "function"),
    want: "empty, step, combine and result",
  },
};

/**
 * The cage itself, and the only place one is built. What an app authors goes
 * through evaluateRole below; this is for source the PLATFORM generates around
 * an app's module — the battery's fuel harness — which answers to no role and
 * still may not run with more authority than the module it wraps.
 */
export async function evaluateCaged(source, endowments = {}, undeclared = {}) {
  await ensureSes();
  const cage = new Compartment(endowments);
  // An endowment is authority the platform hands INTO the cage, and source
  // that could overwrite one holds it rather than uses it — the battery's
  // meter most of all, which the rewritten module is supposed to spend and
  // not to supply. So each is sealed onto the compartment's global: writing
  // it, redefining it and deleting it are all TypeErrors, whether the name is
  // spelled or computed.
  for (const [name, value] of Object.entries(endowments)) {
    Object.defineProperty(cage.globalThis, name, {
      value,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
  // A name the platform could endow and this module did not declare throws
  // where it is reached, saying so, as mecha's cages do.
  for (const [name, why] of Object.entries(undeclared)) {
    Object.defineProperty(cage.globalThis, name, {
      get: () => {
        throw new TypeError(why);
      },
      enumerable: false,
      configurable: false,
    });
  }
  evaluating++;
  try {
    return cage.evaluate(source);
  } finally {
    evaluating--;
  }
}

export async function evaluateRole(source, role = "handler", requestedEndowments = []) {
  const spec = ROLES[role];
  if (spec === undefined) throw new Error(`unknown Jessie role "${role}"`);
  let value;
  try {
    // The lockdown first: an endowment is hardened, and `harden` is what
    // lockdown installs — a role whose module is the first one a screen loads
    // would otherwise build its endowment before the realm was sealed.
    await ensureSes();
    const combined = [...new Set([...(spec.defaultEndowments ?? []), ...requestedEndowments])];
    const undeclared = Object.fromEntries(Object.keys(SAFE_ENDOWMENTS).filter((n) => !combined.includes(n)).map((n) => [
      n,
      `${role}: ${n} is not endowed; declare it among the module's endowments`,
    ]));
    value = await evaluateCaged(spec.wrap(source), spec.endow(combined), undeclared);
  } catch (err) {
    // What the compartment is handed is the role's adaptation of the file, not
    // the file: a parse failure is a statement about the shape the role asked
    // for, and the engine's own words describe source the author never wrote.
    // So the role says what it wanted, and carries the parse text behind it
    // for whoever has to find the character.
    if (err instanceof Error && err.name === "SyntaxError") {
      throw new Error(`${role} source must end in ${spec.want} (${err.message})`);
    }
    throw err;
  }
  if (!spec.ok(value)) throw new Error(`${role} source must end in ${spec.want}`);
  return value;
}

// What a kinetic graph's entry exports, by its role (docs/kinetic.md): an
// engine's contract, or a sound role's factory over the context it is handed.
const EXPORTS = {
  engine: ["initState", "advanceFrame", "saveState", "loadState"],
  sound: ["createSound"],
};

/** The key a specifier names from its importer's, both `./`-rooted app paths:
 * what pronto's engine-link.ts resolved when it linked the graph. */
function resolveLinked(specifier, referrer) {
  const parts = referrer.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  return parts.join("/");
}

/**
 * A kinetic engine, from the graph pronto linked at build time: every module a
 * record Endo's ModuleSource precompiled, imported by the cage's own module
 * system. One compartment holds the graph, so each module evaluates once and
 * the engine's cage — no endowments — is the ceiling for all of them. `role`
 * names what the entry exports: an engine's contract, or a sound role's
 * factory, whose one authority is the context the terminal hands it.
 */
export async function evaluateEngine(graph, role = "engine") {
  const required = EXPORTS[role];
  if (required === undefined) throw new Error(`engine: unknown role ${JSON.stringify(role)}`);
  await ensureSes();
  const modules = Object.fromEntries(Object.entries(graph.modules).map(([key, record]) => [key, { source: record }]));
  const cage = new Compartment({
    __options__: true,
    modules,
    resolveHook: resolveLinked,
    importNowHook: (specifier) => {
      throw new Error(`engine: ${specifier} is not a module of the linked graph`);
    },
  });
  for (const name of Object.keys(SAFE_ENDOWMENTS)) {
    Object.defineProperty(cage.globalThis, name, {
      get: () => {
        throw new TypeError(`engine: ${name} is not endowed; an engine is endowed with nothing`);
      },
      enumerable: false,
      configurable: false,
    });
  }
  let namespace;
  evaluating++;
  try {
    namespace = cage.importNow(graph.entry);
  } finally {
    evaluating--;
  }
  const missing = required.filter((name) => typeof namespace[name] !== "function");
  if (missing.length > 0) throw new Error(`${role} ${graph.entry} must export ${missing.join(", ")}`);
  return namespace;
}

export const evaluateHandler = (source, requestedEndowments = []) => evaluateRole(source, "handler", requestedEndowments);
export const evaluateFold = (source, requestedEndowments = []) => evaluateRole(source, "fold", requestedEndowments);

