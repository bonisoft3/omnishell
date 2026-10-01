// omnishell jessie load: every module an app declares loads in the compartment
// its role runs in.
//
//   omnishell check handlers <appDir>
//   omnishell check handlers --self-test
//
// The app supplies nothing but its emitted shell.yaml, which names a Jessie
// module five ways — a route's handlers, its renderers and its control adapters,
// an entity's validations, a pipeline's fold. Each way is a ROLE, and the role decides what
// the source must end in, what its compartment endows, and how the authored
// file is adapted to a script: interpreter/jessie.js owns all three, and this
// check is that ownership exercised from outside a browser. A module that does
// not satisfy its role's contract is the finding, in the words the role states
// it in.
//
// The fold is why the roles cannot be guessed at a distance: it is authored as
// an ES module, so its `export` keywords are stripped before evaluation and its
// completion value is four functions rather than one. A checker that assumed
// every Jessie module was a reduce would report every fold an app ships.
//
// What this does NOT do is RUN the module: nothing here supplies a state or an
// event, so a handler that throws on its first row passes. That is the
// battery's rung (check-battery.ts), which draws inputs from the schema and
// meters fuel. This one answers what the battery cannot: whether the source
// loads at all, in the cage production loads it in.
//
// ACCEPTED HAZARD — evaluation here is unbounded. Loading a module runs its
// top level, and this rung meters no fuel, sets no timeout and holds no abort:
// a module whose body is `while (true) {}` hangs `sayt lint` until the CI job's
// wall clock kills it. Wrapping the call in a Promise.race would not fix that
// and should not be added — a spinning loop never yields the thread, so the
// timer that was supposed to win never runs. The rung that bounds this is the
// battery, which rewrites the source to spend a step at every loop head before
// evaluating it, and whose budget covers the top level as well as the
// completion value; bounding this check means borrowing that rewrite, not
// racing it.
//
// OUT OF SCOPE — `pipelines[].shim`. realworld declares three and thenote one,
// and they reach the browser exactly as folds do, but a shim is
// (rows) => one row on id (schema.cue) where a fold is four functions. That is
// a fifth role in jessie.js, not a fifth spelling here, so shims go unchecked
// until the role exists.
//
// Findings print as {severity, path, message} JSON (SPEC.md lint format);
// exit 1 when any finding is reported.

import { load as parseYaml } from "./interpreter/vendor/js-yaml.js";
import { evaluateRole } from "./interpreter/jessie.js";

type Finding = { severity: string; path: string; message: string };

/** Whether a run's findings fail the verb. Nothing this check reports is a
 * fact about the checker — a module either loads as its role or does not — so
 * every finding here is an error. The band is stated anyway, because the verb
 * gate is the loop's vocabulary and not this file's to redefine.
 * check-machines and check-visual band the same way. */
export const fails = (findings: Finding[]) => findings.some((f) => f.severity !== "advisory");

const said = (err: unknown) => err instanceof Error ? err.message : String(err);

/** The five ways shell.yaml names a Jessie module, and the role each names it
 * for. Paths are app-relative as written: a route's files and a validation's
 * `src` sit under shell/, a pipeline's fold beside the bloblang it mirrors. */
type Shell = {
  routes?: { files?: { handlers?: string[]; renderers?: string[]; adapters?: string[] } }[];
  validations?: Record<string, Record<string, { src?: string }>>;
  pipelines?: { fold?: string }[];
  endowments?: Record<string, string[]>;
};

type Job = { path: string; role: string };

/** What the app declares, deduplicated by path and role: one module named by
 * two routes is one load, and the same file in two roles is two — the roles
 * disagree about what it must end in, so both answers are worth having. */
export function declaredModules(shell: Shell): Job[] {
  const seen = new Set<string>();
  const jobs: Job[] = [];
  const take = (path: string | undefined, role: string) => {
    if (path === undefined) return;
    const key = `${path} ${role}`;
    if (seen.has(key)) return;
    seen.add(key);
    jobs.push({ path, role });
  };
  for (const route of shell.routes ?? []) {
    for (const path of route.files?.handlers ?? []) take(path, "handler");
    for (const path of route.files?.renderers ?? []) take(path, "renderer");
    for (const path of route.files?.adapters ?? []) take(path, "adapter");
  }
  for (const entity of Object.values(shell.validations ?? {})) {
    for (const declared of Object.values(entity)) take(declared.src, "validation");
  }
  for (const pipeline of shell.pipelines ?? []) take(pipeline.fold, "fold");
  return jobs;
}

/** One module, loaded as its role. A module the app names and does not ship is
 * the same defect as one that does not load: the terminal fetches it by this
 * path and the screen dies on the reader's first gesture. */
/** An adapter the terminal serves is read from this plugin, where it lives;
 * everything else is the app's own file. */
const sourceOf = (appDir: URL, path: string) =>
  path.startsWith("/omnishell/components/")
    ? new URL(`./components/${path.slice("/omnishell/components/".length)}`, import.meta.url)
    : new URL(path, appDir);

async function loadFinding(appDir: URL, job: Job, endowments: string[] = []): Promise<Finding[]> {
  let source: string;
  try {
    source = await Deno.readTextFile(sourceOf(appDir, job.path));
  } catch (err) {
    return [{ severity: "error", path: job.path, message: `${job.role}: ${said(err)}` }];
  }
  try {
    await evaluateRole(source, job.role, endowments);
    return [];
  } catch (err) {
    return [{ severity: "error", path: job.path, message: `${job.role}: ${said(err)}` }];
  }
}

export type Loaded = { findings: Finding[]; checked: number };

export async function checkApp(appDir: URL): Promise<Loaded> {
  let shell: Shell;
  try {
    shell = parseYaml(
      await Deno.readTextFile(new URL("shell/shell.yaml", appDir)),
    ) as Shell;
  } catch (err) {
    // The one file this check cannot do without. Unreadable or malformed, it is
    // a finding in the format the verb reads rather than a stack trace: a run
    // that cannot enumerate has covered nothing, and must say so in the same
    // words it would use for a module.
    return {
      findings: [{ severity: "error", path: "shell/shell.yaml", message: said(err) }],
      checked: 0,
    };
  }
  const jobs = declaredModules(shell);
  const endowmentsMap = shell.endowments ?? {};
  const findings: Finding[] = [];
  for (const job of jobs) {
    const granted = endowmentsMap[job.path] ?? endowmentsMap[job.path.split("/").pop() ?? ""] ?? [];
    findings.push(...await loadFinding(appDir, job, granted));
  }
  // An app declaring none is a true answer and not a silent one: apps whose
  // screens are all bindings ship no Jessie at all.
  return { findings, checked: jobs.length };
}

/**
 * The check's own claims, as sentences; empty is a pass. Returned rather than
 * printed so the caller owns the stream — check-machines' self-test says why.
 */
export async function selfTest(): Promise<{ failures: string[] }> {
  const failures: string[] = [];

  // Enumeration: every spelling shell.yaml has, including the two that share a
  // route and the one that is not under shell/ at all.
  const declared = declaredModules({
    routes: [
      { files: { handlers: ["shell/handlers/a.js"], renderers: ["shell/renderers/r.js"] } },
      { files: { handlers: ["shell/handlers/a.js", "shell/handlers/b.js"] } },
      { files: {} },
    ],
    validations: { favorite: { "own-article": { src: "shell/validations/v.js" } } },
    pipelines: [{ fold: "pipelines/f.js" }, { key: "no fold here" } as { fold?: string }],
  });
  const wantDeclared = [
    "shell/handlers/a.js:handler",
    "shell/renderers/r.js:renderer",
    "shell/handlers/b.js:handler",
    "shell/validations/v.js:validation",
    "pipelines/f.js:fold",
  ];
  const gotDeclared = declared.map((j) => `${j.path}:${j.role}`);
  if (JSON.stringify(gotDeclared) !== JSON.stringify(wantDeclared)) {
    failures.push(`the modules a shell.yaml declares: ${JSON.stringify(gotDeclared)}`);
  }

  // The orchestration, against a fixture app carrying one module per branch.
  const fixture = new URL("./test/fixtures/handlers/", import.meta.url);
  const run = await checkApp(fixture);
  const got = run.findings.map((f) => `${f.path.split("/").pop()}: ${f.message}`);
  const want = [
    // sound.js, the renderer, the validation and the whole fold report nothing.
    "not-a-reduce.js: handler: handler source must end in its reduce function",
    // The role contracts are ours and pinned word for word; how the engine
    // phrases a throw from inside the compartment is not, so these two are
    // matched by their prefix.
    "reaches-for-ambient.js: handler: ",
    "absent.js: handler: ",
    "partial-fold.js: fold: fold source must end in empty, step, combine and result",
  ];
  // This list is also what tells a real compartment from this process's own
  // globals. reaches-for-ambient.js reads `fetch` ABOVE its completion
  // expression, so a host that endows `fetch` evaluates it, yields the arrow
  // below it and satisfies the handler role — dropping its entry and leaving
  // three findings where four are named. Weaken the cage and this is the
  // assertion that goes red.
  const orchestrated = got.length === want.length && want.every((w, i) => got[i].startsWith(w));
  if (!orchestrated) {
    failures.push(`the fixture app's findings: ${JSON.stringify(got, null, 2)}`);
  }
  // The sound half is the half that would go dark if loading stopped at the
  // first defect: a count, so a fixture that grows is not silently half-read.
  if (run.checked !== 9) {
    failures.push(`the fixture app declares 9 modules, loaded ${run.checked}`);
  }

  // A fold is the role pronto's static scan does not know: its `export`
  // keywords are stripped and its completion value is four functions, so a
  // sound one must load and a fold judged as a handler must not. Both
  // spellings of the four, because the contract names the functions and not
  // the keyword that declares them.
  const soundFold = await Deno.readTextFile(new URL("pipelines/sound-fold.js", fixture));
  const functionFold = await Deno.readTextFile(new URL("pipelines/function-fold.js", fixture));
  for (const [named, source] of [["sound-fold.js", soundFold], ["function-fold.js", functionFold]]) {
    try {
      await evaluateRole(source, "fold");
    } catch (err) {
      failures.push(`the fixture's ${named} did not load as a fold: ${said(err)}`);
    }
  }
  try {
    await evaluateRole(soundFold, "handler");
    failures.push("a fold loaded as a handler, so the role decides nothing");
  } catch {
    // The contract refusing it is the point.
  }

  // The verb gate.
  const gate: [Finding[], boolean][] = [
    [[], false],
    [[{ severity: "advisory", path: "t", message: "m" }], false],
    [[{ severity: "error", path: "t", message: "m" }], true],
  ];
  for (const [given, want] of gate) {
    if (fails(given) !== want) failures.push(`the verb gate on ${JSON.stringify(given.map((f) => f.severity))}`);
  }

  return { failures };
}

// What the `check handlers` leaf of the command line is: runtime/cli.ts
// resolves the permissions this needs and hands over what followed the
// subcommand.
export async function run(args: string[]): Promise<void> {
  // An evaluation that stalls — a module awaiting something that never comes —
  // drains the event loop with nothing reported, and Deno exits 0 on an empty
  // loop. So the run is failed until it has said what it found.
  Deno.exitCode = 1;
  if (args[0] === "--self-test") {
    const { failures } = await selfTest();
    const say = (line: string) => Deno.stderr.writeSync(new TextEncoder().encode(`${line}\n`));
    for (const f of failures) say(`FAIL ${f}`);
    say(failures.length === 0 ? "check-handlers self-test: passed" : `check-handlers self-test: ${failures.length} failed`);
    Deno.exit(failures.length === 0 ? 0 : 1);
  }
  const appDir = args[0];
  if (appDir === undefined) {
    console.error("usage: check-handlers.ts <appDir> | --self-test");
    Deno.exit(1);
  }
  const { findings, checked } = await checkApp(new URL(`${appDir.replace(/\/*$/, "")}/`, `file://${Deno.cwd()}/`));
  console.log(JSON.stringify(findings, null, 2));
  // What was covered, not just what was wrong: an app declaring no Jessie at
  // all prints the same empty findings as one that loaded six, and only the
  // count separates a clean run from a run that read nothing.
  console.error(`check-handlers: ${checked} module(s) loaded; ${findings.length} finding(s).`);
  if (!fails(findings)) Deno.exitCode = 0;
}

if (import.meta.main) await run(Deno.args);
