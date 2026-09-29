Deno.test("visual integration commands share the configured Compose project", async () => {
  const cue = await Deno.readTextFile(new URL("../terminal.cue", import.meta.url));
  const visual = cue.split("checks: visual: {")[1]?.split('note: "DOM checks')[0];
  if (visual === undefined) throw new Error("terminal.cue has no visual integration check");

  const project = visual.match(/let composeProject = "([^"\n]+)"/)?.[1];
  if (project === undefined || !project.includes("COMPOSE_PROJECT_NAME") || !project.includes("\\(T.app)")) {
    throw new Error("visual integration project must use the environment override and app fallback");
  }
  const uses = visual.split("docker compose -p \\(composeProject)").length - 1;
  if (uses !== 2) throw new Error(`visual integration has ${uses} Compose project selections, expected 2`);
});
