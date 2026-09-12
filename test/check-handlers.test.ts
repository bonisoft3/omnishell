// The jessie load check's own claims, run by the test verb rather than by hand:
// check-handlers.ts is a checker, not a suite, so its cases reach CI only
// through this file.
import { selfTest } from "../check-handlers.ts";

Deno.test({
  name: "check-handlers self-test",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { failures } = await selfTest();
    if (failures.length > 0) throw new Error(failures.join("\n"));
  },
});
