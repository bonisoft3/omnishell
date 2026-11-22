// A lockdown is failed by whatever it throws, undefined included, and is not
// attempted again. Its own file, because the failure is the process's for good.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { ensureSes } from "../interpreter/jessie.js";

const outcome = (p: Promise<void>) => p.then(() => ({ resolved: true, thrown: undefined as unknown }), (thrown: unknown) => ({ resolved: false, thrown }));

Deno.test("a lockdown that throws undefined refuses every later load", async () => {
  const g = globalThis as Record<string, unknown>;
  let calls = 0;
  g.Compartment = class {};
  g.lockdown = () => {
    calls++;
    throw undefined;
  };
  const first = await outcome(ensureSes());
  const second = await outcome(ensureSes());
  assertEquals(first, { resolved: false, thrown: undefined });
  assertEquals(second, { resolved: false, thrown: undefined });
  assertEquals(calls, 1);
  assert(g.__prontoLockdown !== true, "a failed lockdown is not recorded as done");
});
