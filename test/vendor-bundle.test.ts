// Compare rebuilt bundles with the shipped bytes so tests cannot grade stale engines.
import { assertEquals } from "jsr:@std/assert@1";
import { encodeHex } from "jsr:@std/encoding@1/hex";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Digests, not the files: a mismatch on two minified megabytes prints one line
// rather than both of them.
async function digest(path: string): Promise<string> {
  return encodeHex(await crypto.subtle.digest("SHA-256", await Deno.readFile(path)));
}

const PLUGIN = fileURLToPath(new URL("../", import.meta.url));

for (const name of ["mecha-client", "xstate"]) Deno.test({
  name: `the vendored ${name} bundle is what its source builds`,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const scratch = await Deno.makeTempDir({ prefix: "omnishell-vendor-bundle-" });
    try {
      // The script package.json states, which bayt's `bundle` target also
      // runs (bayt.cue reads it from there): a command spelled again here
      // could rebuild something the build never would.
      const script: string = JSON.parse(await Deno.readTextFile(join(PLUGIN, "package.json"))).scripts[`bundle:${name}`];
      const built = join(scratch, `${name}.js`);
      const argv = script.split(" ");
      const target = argv.lastIndexOf("-o");
      if (argv[0] !== "deno" || target < 0) throw new Error(`bundle:${name} is not a deno bundle with an -o target: ${script}`);
      argv[target + 1] = built;
      const bundle = await new Deno.Command(argv[0], {
        args: argv.slice(1),
        cwd: PLUGIN,
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!bundle.success) throw new Error(`deno bundle failed: ${new TextDecoder().decode(bundle.stderr)}`);
      assertEquals(
        await digest(join(PLUGIN, "interpreter", "vendor", `${name}.js`)),
        await digest(built),
        `the checked-in bundle is stale: run pnpm run bundle:${name} and commit it`,
      );
    } finally {
      await Deno.remove(scratch, { recursive: true });
    }
  },
});
