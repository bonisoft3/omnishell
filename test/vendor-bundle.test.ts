// interpreter/vendor/mecha-client.js is built from the client's source by
// package.json's `bundle:mecha-client`, and nothing until now noticed when the
// checked-in copy stopped matching what that produces. A stale bundle does not
// fail: the terminal runs the old data plane, and every suite that imports it —
// the smokes, the order tests, an app's own checks — grades platform code that
// is no longer the platform's. This rebuilds it and compares.
//
// Host-only, like the other tests that read outside this plugin: the bundle's
// source is libraries/mecha, which the image does not carry (bayt.cue leaves it
// out of the image's test run for that reason).
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

Deno.test({
  name: "the vendored client bundle is what its source builds",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const scratch = await Deno.makeTempDir({ prefix: "omnishell-vendor-bundle-" });
    try {
      // The script package.json states, which bayt's `bundle` target also
      // runs (bayt.cue reads it from there): a command spelled again here
      // could rebuild something the build never would.
      const script: string = JSON.parse(await Deno.readTextFile(join(PLUGIN, "package.json"))).scripts["bundle:mecha-client"];
      const built = join(scratch, "mecha-client.js");
      const argv = script.split(" ");
      const target = argv.lastIndexOf("-o");
      if (argv[0] !== "deno" || target < 0) throw new Error(`bundle:mecha-client is not a deno bundle with an -o target: ${script}`);
      argv[target + 1] = built;
      const bundle = await new Deno.Command(argv[0], {
        args: argv.slice(1),
        cwd: PLUGIN,
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!bundle.success) throw new Error(`deno bundle failed: ${new TextDecoder().decode(bundle.stderr)}`);
      assertEquals(
        await digest(join(PLUGIN, "interpreter", "vendor", "mecha-client.js")),
        await digest(built),
        "the checked-in bundle is stale: run `pnpm run bundle:mecha-client` (package.json) and commit it",
      );
    } finally {
      await Deno.remove(scratch, { recursive: true });
    }
  },
});
