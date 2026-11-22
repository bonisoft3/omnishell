// Two module instances of the cage waiting on one installation attempt one
// lockdown between them, and both meet its failure. Its own file, because the
// failure is the process's for good.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { ensureSes } from "../interpreter/jessie.js";

Deno.test("instances awaiting one installation attempt lockdown once and share its failure", async () => {
  const g = globalThis as Record<string, unknown>;
  const other = await import("../interpreter/jessie.js?instance=2");
  let calls = 0;
  let land = () => {};
  const installed = new Promise<void>((r) => (land = r));
  // One installation both instances wait on, as two imports of one bundle do.
  const install = async () => {
    await installed;
    g.Compartment ??= class {};
    g.lockdown ??= () => {
      calls++;
      throw new Error(`lockdown refused #${calls}`);
    };
  };
  const first = ensureSes(install).then(() => null, (e: unknown) => e);
  const second = other.ensureSes(install).then(() => null, (e: unknown) => e);
  land();
  const [a, b] = await Promise.all([first, second]);
  assertEquals(calls, 1);
  assert(a instanceof Error && a.message === "lockdown refused #1", `the first instance meets the failure, got ${a}`);
  assert(b === a, `the second meets the same failure, got ${b}`);
  assert(g.__prontoLockdown !== true, "a failed lockdown is not recorded as done");
});
