import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { expandGlob } from "jsr:@std/fs@1.0.19/expand-glob";

const decoder = new TextDecoder();

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

const terminal = fileURLToPath(new URL("../", import.meta.url));

async function run(cwd: string, args: string[]): Promise<string> {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--no-check", "--config", join(terminal, "test/deno.json"), "--allow-read", "--allow-write=.", "--allow-env", join(terminal, "runtime/cli.ts"), ...args],
    cwd, stdout: "piped", stderr: "piped",
  }).output();
  assert(result.success, decoder.decode(result.stderr));
  return decoder.decode(result.stdout);
}

Deno.test("an installed terminal is named from its own root, a checkout's from the app", async () => {
  const app = await Deno.makeTempDir({ prefix: "omnishell runtime " });
  try {
    await Deno.writeTextFile(join(app, "program.cue"), "package fixture\n");
    const installed = await run(app, ["mode", "."]);
    assert(installed.includes('runtime: ""'), "installed mode named a checkout");
    assert(installed.includes('interpreterRoot: "interpreter"'), "installed interpreter not named from omnishell's root");
    assert(installed.includes('componentsRoot: "components"'), "installed adapters not named from omnishell's root");
    assert(installed.includes('markupReader: "read-markup.ts"'), "installed reader not named from omnishell's root");
    assert(installed.includes('machineSchema: "machine.cue"'), "installed schema not named from omnishell's root");
    assert(!installed.includes(".omnishell"), "installed mode names a copy in the app");
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});

Deno.test("the runtime image's tree holds everything its entry points import", async () => {
  // The image's tree as bayt builds it: the runtime-image target's srcs.
  const project = JSON.parse(await Deno.readTextFile(join(terminal, "bayt.json")));
  const globs: string[] = project.targets["runtime-image"].srcs.globs;
  const image = await Deno.makeTempDir({ prefix: "omnishell image " });
  try {
    for (const glob of globs) {
      for await (const file of expandGlob(glob, { root: terminal, includeDirs: false })) {
        const rel = file.path.slice(terminal.length);
        await Deno.mkdir(join(image, dirname(rel)), { recursive: true });
        await Deno.copyFile(file.path, join(image, rel));
      }
    }
    for (const entry of ["check-visual.ts", "read-markup.ts", "base-url.ts"]) {
      const info = await new Deno.Command(Deno.execPath(), {
        args: ["info", "--json", "--no-config", "--no-lock", entry],
        cwd: image, stdout: "piped", stderr: "piped",
      }).output();
      assert(info.success, decoder.decode(info.stderr));
      // The tree as deno spells it, from the entry it was handed: a path
      // rebuilt here could differ in spelling (Windows short names).
      const graph = JSON.parse(decoder.decode(info.stdout)) as { roots: string[]; modules: { specifier: string; error?: string }[] };
      const root = new URL(".", graph.roots[0]).href;
      // A miss counts when the terminal's own tree holds the file: the image
      // left it out.
      const left = (m: { specifier: string }) => {
        try {
          return Deno.statSync(join(terminal, decodeURIComponent(m.specifier.slice(root.length)))).isFile;
        } catch {
          return false;
        }
      };
      const outside = graph.modules.filter((m) => m.specifier.startsWith("file:") && (!m.specifier.startsWith(root) || (m.error && left(m))));
      assert(outside.length === 0, `the image's ${entry} reaches ${outside.map((m) => m.error ?? m.specifier).join(", ")}`);
    }
  } finally {
    await Deno.remove(image, { recursive: true });
  }
});
