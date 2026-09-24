// Bundles npm:morphlex for browser delivery, rewriting the top-level prototype
// check so headless test runners evaluate without a global Element.
const config = new URL("../deno.json", import.meta.url).pathname;
const entry = new URL("./entry-morphlex.ts", import.meta.url).pathname;
const dest = new URL("./morphlex.js", import.meta.url).pathname;

const command = new Deno.Command("deno", {
  args: [
    "bundle",
    "--config",
    config,
    "--platform",
    "browser",
    "--format",
    "esm",
    "--minify",
    entry,
  ],
});

const output = await command.output();
if (!output.success) {
  const err = new TextDecoder().decode(output.stderr);
  throw new Error(`bundle:morphlex failed:\n${err}`);
}

const raw = new TextDecoder().decode(output.stdout);
const guarded = raw.replace(
  '"moveBefore"in Element.prototype',
  'typeof Element!=="undefined"&&"moveBefore"in Element.prototype',
);

await Deno.writeTextFile(dest, guarded);
