// The machine walk's own claims, run by the test verb rather than by hand:
// check-machines.ts is a checker, not a suite, so its cases reach CI only
// through this file.
import { selfTest } from "../check-machines.ts";

Deno.test({
  name: "check-machines self-test",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { failures } = await selfTest();
    if (failures.length > 0) throw new Error(failures.join("\n"));
  },
});
