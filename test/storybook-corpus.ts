import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const apps = fileURLToPath(new URL("../../../apps/", import.meta.url));
const pronto = fileURLToPath(new URL("../../pronto/", import.meta.url));
const terminal = fileURLToPath(new URL("../runtime/cli.ts", import.meta.url));

async function run(command: string, args: string[], cwd?: string): Promise<string> {
  const result = await new Deno.Command(command, { args, cwd, stdout: "piped", stderr: "piped" }).output();
  if (!result.success) {
    throw new Error(`${basename(command)} failed (${result.code}): ${new TextDecoder().decode(result.stderr)}`);
  }
  return new TextDecoder().decode(result.stdout);
}

async function copy(source: string, target: string): Promise<void> {
  await Deno.mkdir(target, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory) await copy(from, to);
    else if (entry.isSymlink) await Deno.symlink(await Deno.readLink(from), to, { type: (await Deno.stat(from)).isDirectory ? "dir" : "file" });
    else await Deno.copyFile(from, to);
  }
}

// Release-pinned artifacts belong to their installed terminal. A tree-terminal
// test compiles their authored source in a sibling copy so the module's seats
// resolve normally, without changing the app's published corpus.
export async function withStorybookCorpus<T>(app: URL, use: (corpus: URL) => Promise<T>): Promise<T> {
  const layout = await Deno.readTextFile(new URL("program_pronto.cue", app));
  if (!/^loop:\s*surface:\s*sources:\s*pronto:\s*""\s*$/m.test(layout)) return use(app);

  const source = fileURLToPath(app).replace(/[\\/]+$/, "");
  const fixture = await Deno.makeTempDir({ dir: apps, prefix: `.storybook-${basename(source)}-` });
  try {
    await copy(source, fixture);
    const mode = await run(Deno.execPath(), ["run", "--no-config", "--no-check", "--no-lock", "--allow-read", terminal, "mode", fixture, "--local"]);
    await Deno.writeTextFile(join(fixture, "program_terminal.cue"), mode);
    await run(Deno.execPath(), ["run", "--config", join(pronto, "deno.json"), "--frozen", "--allow-read", `--allow-write=${fixture}`, "--allow-run=cue,deno", "--allow-env", join(pronto, "terminal-corpus.ts"), fixture]);
    return await use(pathToFileURL(`${fixture}/`));
  } finally {
    await Deno.remove(fixture, { recursive: true });
  }
}
