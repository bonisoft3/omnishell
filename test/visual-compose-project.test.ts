Deno.test("visual integration commands share the configured Compose project", async () => {
  const cue = await Deno.readTextFile(new URL("../terminal.cue", import.meta.url));
  const definition = cue.split("#ComposeProject: {")[1]?.split("\n}")[0];
  if (definition === undefined) throw new Error("terminal.cue has no #ComposeProject");
  if (!definition.includes("COMPOSE_PROJECT_NAME") || !definition.includes("\\(app)")) {
    throw new Error("the compose project must use the environment override and app fallback");
  }

  const visual = cue.split("checks: visual: {")[1]?.split('note: "DOM checks')[0];
  if (visual === undefined) throw new Error("terminal.cue has no visual integration check");
  if (!visual.includes("let composeProject = (#ComposeProject & {app: T.app}).out")) {
    throw new Error("visual integration must name its project through #ComposeProject");
  }
  const ups = visual.split("docker compose -p \\(composeProject)").length - 1;
  const closures = visual.split("#ClosureUp & {project: composeProject,").length - 1;
  if (ups !== 1 || closures !== 1) {
    throw new Error(`visual integration selects its project ${ups} + ${closures} times, expected the launch up and its closure`);
  }
});
