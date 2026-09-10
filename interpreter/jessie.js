// Running app-authored Jessie: the one place the platform evaluates source it
// did not write. Nothing here endows ambient authority — an absent global
// cannot be argued with, which is the only reason app source is safe to run
// unread.

// ses pin: the vendored umd dist (bundle:ses), loaded beside this module —
// same-origin, so the platform's own image is the integrity boundary. One
// load + one lockdown per page; hosts that pre-install Compartment (the deno
// smoke) skip injection.
const SES_URL = new URL("./vendor/ses.umd.min.js", import.meta.url).href;

let sesReady;
export function ensureSes() {
  return (sesReady ??= (async () => {
    if (!globalThis.Compartment) {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = SES_URL;
        script.onload = resolve;
        script.onerror = () => reject(new Error(`failed loading ${SES_URL}`));
        document.head.append(script);
      });
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
  fold: {
    endow: () => ({}),
    wrap: (s) =>
      `${s.replaceAll("export const ", "const ")}\nharden({ empty, step, combine, result });`,
    ok: (v) =>
      typeof v === "object" && v !== null &&
      ["empty", "step", "combine", "result"].every((k) => typeof v[k] === "function"),
    want: "empty, step, combine and result",
  },
};

export async function evaluateRole(source, role = "handler") {
  await ensureSes();
  const spec = ROLES[role];
  if (spec === undefined) throw new Error(`unknown Jessie role "${role}"`);
  const value = new Compartment(spec.endow()).evaluate(spec.wrap(source));
  if (!spec.ok(value)) throw new Error(`${role} source must end in ${spec.want}`);
  return value;
}

export const evaluateHandler = (source) => evaluateRole(source, "handler");
export const evaluateFold = (source) => evaluateRole(source, "fold");
