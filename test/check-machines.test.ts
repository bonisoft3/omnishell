// The machine walk's own claims, run by the test verb rather than by hand:
// check-machines.ts is a checker, not a suite, so its cases reach CI only
// through this file.
import { checkApp, fails, selfTest } from "../check-machines.ts";

Deno.test({
  name: "check-machines self-test",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { failures } = await selfTest();
    if (failures.length > 0) throw new Error(failures.join("\n"));
  },
});

Deno.test({
  name: "seeded relationships and parameter dependencies reach machine walks while invalid reads fail",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const run = await checkApp(new URL("./fixtures/relationship-machines/", import.meta.url));
    const byScreen = (name: string) => run.findings.filter((f) => f.path === `shell/screens/${name}.html`);
    for (const name of ["game", "game-hidden", "game-base", "campaign-hidden", "dependency"]) {
      if (byScreen(name).length !== 0) throw new Error(`${name} failed to walk: ${JSON.stringify(byScreen(name))}`);
    }
    for (const [name, count] of [["broken-game", 1], ["broken-game-hidden", 1], ["broken-game-base", 1], ["broken-dependency", 2]] as const) {
      const findings = byScreen(name);
      if (findings.length !== count || findings.some((f) => f.severity !== "error" || !f.message.includes("missing-control"))) {
        throw new Error(`${name} hid a broken transition: ${JSON.stringify(findings)}`);
      }
    }
    for (const [name, reason] of [
      ["invalid-column", "unknown column game.misspelled"],
      ["invalid-relation", "declared relationships"],
      ["unsupported-filter", "outside the grammar"],
      ["blocked-invalid", "unknown column param_card.misspelled"],
    ]) {
      const findings = byScreen(name);
      if (findings.length !== 1 || findings[0].severity !== "error" || !findings[0].message.includes(reason)) {
        throw new Error(`${name} skipped query validation: ${JSON.stringify(findings)}`);
      }
    }
    const cycles = byScreen("cycle");
    if (cycles.length !== 2 || cycles.some((f) => f.severity !== "error" || !f.message.includes("dependency cycle"))) {
      throw new Error(`seeded parameter cycles were silently demoted: ${JSON.stringify(cycles)}`);
    }
    const unresolved = byScreen("unresolved");
    if (unresolved.length !== 2 || unresolved.some((f) => f.severity !== "advisory" || !f.message.includes("no seeded row answers"))) {
      throw new Error(`empty parameter dependencies failed to terminate as unresolved: ${JSON.stringify(unresolved)}`);
    }
    // Both segment orders share each dependency screen. Every valid chart
    // must be driven, including those whose filter fields are not projected;
    // healthy siblings prevent the zero-walk floor masking a skipped chart.
    if (run.authored !== 26 || run.walked !== 24 || run.findings.length !== 13) {
      throw new Error(`relationship or dependency coverage changed: ${JSON.stringify(run)}`);
    }
    const empty = await checkApp(new URL("./fixtures/relationship-machines-empty/", import.meta.url));
    if (empty.authored !== 1 || empty.walked !== 0 || !fails(empty.findings) || !empty.findings.some((f) => f.message.includes("none was walked"))) {
      throw new Error(`an empty joined chart bypassed the coverage floor: ${JSON.stringify(empty)}`);
    }
  },
});
