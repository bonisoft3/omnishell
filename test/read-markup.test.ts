// The markup reader's own claims, run by the test verb rather than by hand:
// read-markup.ts is a command, not a suite, and its output is a published
// contract, so the shape it prints reaches CI only through this file.
import { selfTest } from "../read-markup.ts";

Deno.test({
  name: "read-markup self-test",
  fn() {
    const { failures } = selfTest();
    if (failures.length > 0) throw new Error(failures.join("\n"));
  },
});
