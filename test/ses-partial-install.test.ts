// An installer that failed after the cage and before the seal installed
// nothing that can be locked down, so the next ask installs again. Its own
// file, because it stands the realm's SES globals in for the bundle's.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { ensureSes } from "../interpreter/jessie.js";

Deno.test("a partial installation is installed again on the next ask", async () => {
  const g = globalThis as Record<string, unknown>;
  let sealed = 0;
  let installs = 0;
  await assertRejects(() => ensureSes(async () => {
    installs++;
    g.Compartment = class {};
    throw new TypeError("Failed to fetch");
  }), TypeError, "Failed to fetch");
  await ensureSes(async () => {
    installs++;
    g.lockdown = () => void sealed++;
  });
  assertEquals(installs, 2);
  assertEquals(sealed, 1);
  assert(g.__prontoLockdown === true, "the realm is sealed");
});
