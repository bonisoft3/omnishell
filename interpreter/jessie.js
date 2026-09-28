// Running app-authored Jessie: the one place the platform evaluates source it
// did not write. Nothing here endows ambient authority — an absent global
// cannot be argued with, which is the only reason app source is safe to run
// unread.

// ses pin: the vendored umd dist (bundle:ses), loaded beside this module —
// same-origin, so the platform's own image is the integrity boundary. One
// load + one lockdown per page; hosts that pre-install Compartment (the deno
// smoke) skip injection.
const SES_URL = new URL("./vendor/ses.umd.min.js", import.meta.url).href;

/**
 * Whether this host EXECUTES a script handed to it, which is what the element
 * path below actually depends on — and which the presence of a `document` does
 * not promise. A parsing-only DOM (linkedom's) appends the element and
 * runs nothing, so its `onload` never fires and a branch keyed on `document`
 * would hang there rather than fail. Asked rather than assumed, with an inline
 * script, which a host that runs scripts runs synchronously on insertion.
 */
function runsInjectedScripts() {
  if (typeof document === "undefined" || document === null) return false;
  if (typeof document.createElement !== "function" || !document.head) return false;
  const probe = document.createElement("script");
  probe.textContent = "globalThis.__prontoScriptProbe = true;";
  document.head.append(probe);
  probe.remove();
  const ran = globalThis.__prontoScriptProbe === true;
  delete globalThis.__prontoScriptProbe;
  return ran;
}

let sesReady;
export function ensureSes() {
  return (sesReady ??= (async () => {
    if (!globalThis.Compartment) {
      // Same bytes either way, by the means the host actually has: a page that
      // runs scripts loads a script element, and everything else — deno, and
      // any DOM that only parses — imports the bundle as a module.
      if (runsInjectedScripts()) {
        await new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = SES_URL;
          script.onload = resolve;
          script.onerror = () => reject(new Error(`failed loading ${SES_URL}`));
          document.head.append(script);
        });
      } else {
        await import(SES_URL);
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
      lockdown({ errorTaming: "unsafe" });
    }
  })());
}

// A Jessie role is a module the app writes and the platform runs: the source's
// last expression is the Compartment's completion value, and the role decides
// what shape that value must have, what the compartment endows, and how the
// authored file is adapted to a script.
// What an adapter is endowed with: Intl, whole, with the host's defaults
// refused — a module states its locale, its zone and its instant, or it throws.
// Why it is admitted whole is plugins/omnishell/docs/terminal.md#the-seats; the
// rule about what an adapter may STORE out of it is
// plugins/omnishell/REFERENCE.md#adapters.
//
// The other roles get nothing. A validation also runs in plv8, which carries
// none of this data, so a module reaching for it there explodes where it is
// seen.
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

const ROLES = {
  // reduce(state, event) -> {updates}. Needs nothing.
  handler: {
    endow: () => ({}),
    wrap: (s) => s,
    ok: (v) => typeof v === "function",
    want: "its reduce function",
  },
  // render(value) -> node description; render.js owns what one may become.
  renderer: {
    endow: () => ({}),
    wrap: (s) => s,
    ok: (v) => typeof v === "function",
    want: "its render function",
  },
  // validation(state, event) -> boolean. Needs nothing.
  validation: {
    endow: () => ({}),
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
    endow: () => ({ Intl: intlSubset() }),
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
    endow: () => ({}),
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
export async function evaluateCaged(source, endowments = {}) {
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
  return cage.evaluate(source);
}

export async function evaluateRole(source, role = "handler") {
  const spec = ROLES[role];
  if (spec === undefined) throw new Error(`unknown Jessie role "${role}"`);
  let value;
  try {
    // The lockdown first: an endowment is hardened, and `harden` is what
    // lockdown installs — a role whose module is the first one a screen loads
    // would otherwise build its endowment before the realm was sealed.
    await ensureSes();
    value = await evaluateCaged(spec.wrap(source), spec.endow());
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

export const evaluateHandler = (source) => evaluateRole(source, "handler");
export const evaluateFold = (source) => evaluateRole(source, "fold");
