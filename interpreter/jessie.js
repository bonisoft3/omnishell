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
 * not promise. A parsing-only DOM (the linkedom tier) appends the element and
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
  // A pipeline transform. Authored as an ES module because the same file is
  // inlined into the rpk stream at container tier; a Compartment script takes
  // no `export` and yields its last expression, so both ends adapt it.
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
  return new Compartment(endowments).evaluate(source);
}

export async function evaluateRole(source, role = "handler") {
  const spec = ROLES[role];
  if (spec === undefined) throw new Error(`unknown Jessie role "${role}"`);
  let value;
  try {
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
