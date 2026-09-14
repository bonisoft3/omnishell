import { fileURLToPath } from "node:url";
import { join } from "node:path";

const decoder = new TextDecoder();

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

Deno.test("Omnishell materializes relocatable source assets and names its evaluator", async () => {
  const app = await Deno.makeTempDir({ prefix: "omnishell runtime " });
  const terminal = fileURLToPath(new URL("../", import.meta.url));
  async function run(args: string[]): Promise<string> {
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--no-check", "--config", join(terminal, "test/deno.json"), "--allow-read", "--allow-write=.", "--allow-env", join(terminal, "runtime/cli.ts"), ...args],
      cwd: app, stdout: "piped", stderr: "piped",
    }).output();
    assert(result.success, decoder.decode(result.stderr));
    return decoder.decode(result.stdout);
  }
  try {
    await Deno.writeTextFile(join(app, "program.cue"), "package fixture\n");
    await Deno.mkdir(join(app, "shell/screens"), { recursive: true });
    await run(["materialize", "."]);
    const asset = ".omnishell/interpreter/shell.js";
    assert(await Deno.readTextFile(join(app, asset)) === await Deno.readTextFile(join(terminal, "interpreter/shell.js")), "materialized interpreter differs");
    async function snapshot(dir: string): Promise<string> {
      const entries: string[] = [];
      for await (const entry of Deno.readDir(dir)) {
        const path = join(dir, entry.name);
        entries.push(JSON.stringify([entry.name, entry.isDirectory ? await snapshot(path) : Array.from(await Deno.readFile(path))]));
      }
      return entries.sort().join("\n");
    }
    const clean = await snapshot(join(app, ".omnishell"));
    await Deno.writeTextFile(join(app, asset), "outdated interpreter");
    await Deno.writeTextFile(join(app, ".omnishell/interpreter/removed.js"), "obsolete");
    await Deno.mkdir(join(app, ".omnishell/removed"));
    await Deno.writeTextFile(join(app, ".omnishell/removed/asset.js"), "obsolete");
    await run(["materialize", "."]);
    assert(await snapshot(join(app, ".omnishell")) === clean, "materialization did not replace the generated tree exactly");
    assert(await Deno.readTextFile(join(app, "program.cue")) === "package fixture\n", "materialization changed an app-owned file");
    await run(["materialize", "."]);
    assert(await snapshot(join(app, ".omnishell")) === clean, "materialization is not repeatable");
    const mode = await run(["mode", "."]);
    assert(mode.includes('interpreterRoot: ".omnishell/interpreter"'), "external mode leaked its source location");
    assert(mode.includes('markupReader: ".omnishell/read-markup.ts"'), "external reader still names a checkout");
    assert((await run(["where", "cage"])).trim() === new URL("../interpreter/jessie.js", import.meta.url).href, "cage does not name the production evaluator");
    const reader = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--no-config", "--no-check", "--no-lock", "--allow-read", ".omnishell/read-markup.ts", "."],
      cwd: app, stdout: "piped", stderr: "piped",
    }).output();
    assert(reader.success, decoder.decode(reader.stderr));
    assert(JSON.parse(decoder.decode(reader.stdout)).screens !== undefined, "materialized reader is not executable");
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});
