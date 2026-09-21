// The i18n check's own claims, run by the test verb rather than by hand:
// check-i18n.ts is a checker, not a suite, so its cases reach CI only through
// this file.
import { selfTest } from "../check-i18n.ts";

Deno.test({
  name: "check-i18n self-test",
  async fn() {
    const { failures } = await selfTest();
    if (failures.length > 0) throw new Error(failures.join("\n"));
  },
});
