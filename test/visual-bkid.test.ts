// The visual check once brought the launch stack up under the person's own
// compose project and photographed it, so a check run could recreate or tear
// down the stack someone was using. It now runs as a bkid runner whose inner
// stack is its own: nothing in the rule may name a compose project.
Deno.test("the visual check runs as its bkid runner, naming no compose project", async () => {
  const cue = await Deno.readTextFile(new URL("../terminal.cue", import.meta.url));
  const visual = cue.split("checks: visual: {")[1]?.split('note: "DOM checks')[0];
  if (visual === undefined) throw new Error("terminal.cue has no visual integration check");
  if (!visual.includes('(#BkidCheck & {runner: "ci-visual"}).out')) {
    throw new Error("the visual check must run its ci-visual bkid runner");
  }
  for (const named of ["docker compose", "COMPOSE_PROJECT_NAME", " -p "]) {
    if (visual.includes(named)) throw new Error(`the visual check names a compose project itself: ${named}`);
  }
  const bkid = cue.split("#BkidCheck: {")[1]?.split("\n}")[0];
  if (bkid === undefined) throw new Error("terminal.cue has no #BkidCheck");
  if (!bkid.includes("--bake --no-up --with-buildx")) {
    throw new Error("a bkid check is the bake envelope: the runner's exit code is its verdict");
  }
});
