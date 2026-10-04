// Bundles npm:morphlex for browser delivery, rewriting the top-level prototype
// check so headless test runners evaluate without a global Element.
const command = new Deno.Command(Deno.execPath(), {
  cwd: new URL(".", import.meta.url),
  args: [
    "bundle",
    "--config",
    "../deno.json",
    "--platform",
    "browser",
    "--format",
    "esm",
    "--minify",
    "entry-morphlex.ts",
  ],
});

const output = await command.output();
if (!output.success) {
  const err = new TextDecoder().decode(output.stderr);
  throw new Error(`bundle:morphlex failed:\n${err}`);
}

const raw = new TextDecoder().decode(output.stdout);
const check = '"moveBefore"in Element.prototype';
const found = raw.split(check).length - 1;
if (found !== 1) {
  throw new Error(`bundle:morphlex expected the prototype check once in the bundle, found it ${found} times`);
}
const guarded = raw.replace(check, `typeof Element!=="undefined"&&${check}`);

await Deno.writeTextFile(new URL("./morphlex.js", import.meta.url), guarded);
