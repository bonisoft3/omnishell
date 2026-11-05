import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHTML } from "npm:linkedom@0.18.4";
import { checkAria, type AriaObligation } from "./check-aria.ts";

export async function checkApp(appDir: string): Promise<{ obligations: AriaObligation[]; checked: number }> {
  const dir = new URL("shell/screens/", pathToFileURL(resolve(appDir) + "/"));
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith(".html")) names.push(entry.name);
  }
  if (names.length === 0) throw new Error(`No screens found in ${dir.pathname}`);
  const obligations: AriaObligation[] = [];
  for (const name of names.sort()) {
    const document = parseHTML(await Deno.readTextFile(new URL(name, dir))).document;
    obligations.push(...checkAria(document, { path: `shell/screens/${name}`, phase: "declaration", opaque: true }));
  }
  return { obligations, checked: names.length };
}

export async function run(args: string[]): Promise<void> {
  if (args[0] === "--self-test") {
    const document = parseHTML('<nav><a aria-current="page">A</a><a aria-current="page">B</a></nav>').document;
    if (!checkAria(document, { path: "self-test", phase: "declaration" }).some((o) => o.status === "violation")) throw new Error("ARIA self-test failed");
    console.error("check-aria self-test: passed");
    return;
  }
  const { obligations, checked } = await checkApp(args[0]);
  console.log(JSON.stringify(obligations, null, 2));
  console.error(`check-aria: ${checked} screen(s) read; ${obligations.length} obligation(s).`);
  if (obligations.some((o) => o.status === "violation")) Deno.exit(1);
}

if (import.meta.main) await run(Deno.args);
