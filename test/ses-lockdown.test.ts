// A lockdown that fails leaves a realm that is neither sealed nor safe to
// seal again, so the cage refuses for the page's lifetime: every later ask
// meets the same failure, from any module instance, and lockdown is never
// called twice. Its own file, because the failure is the process's for good.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { ensureSes, evaluateRole } from "../interpreter/jessie.js";

Deno.test("a failed lockdown refuses every later load and evaluation", async () => {
  const g = globalThis as Record<string, unknown>;
  let calls = 0;
  // The cage is present, so nothing is installed: what fails is the seal.
  g.Compartment = class {};
  g.lockdown = () => {
    calls++;
    throw new Error("lockdown refused");
  };
  await assertRejects(() => ensureSes(), Error, "lockdown refused");
  await assertRejects(() => ensureSes(), Error, "lockdown refused");
  await assertRejects(() => evaluateRole("({ context }) => context;\n", "handler"), Error, "lockdown refused");
  const again = await import("../interpreter/jessie.js?instance=2");
  await assertRejects(() => again.ensureSes(), Error, "lockdown refused");
  assertEquals(calls, 1);
  assert(g.__prontoLockdown !== true, "a failed lockdown is not recorded as done");
});
