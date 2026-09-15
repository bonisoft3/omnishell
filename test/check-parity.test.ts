// Parity test suite for Omnishell: verifies semantic parity between
// Web (LinkeDOM) and Native (DivKit SDUI) across app routes.
//
// Opt-outs are configured here in the test script, keeping production markup
// and generated shell.yaml free of testing directives.

import { checkApp, selfTest } from "../check-parity.ts";

Deno.test({
  name: "check-parity self-test",
  async fn() {
    const { failures } = await selfTest();
    if (failures.length > 0) throw new Error(failures.join("\n"));
  },
});

Deno.test({
  name: "realworld web and native semantic parity with test-configured opt-outs",
  async fn() {
    const realworldDir = new URL("../../../apps/realworld/", import.meta.url);

    // Opt-outs configured explicitly by the test suite:
    // 1. `q` and `form:search`: Web masthead search bar is web-specific.
    // 2. `cover_credit`: Optional editorial credit field authored on web.
    const { findings, checked } = await checkApp(realworldDir, {
      ignoreFields: {
        "*": ["q"],
        editor: ["cover_credit"],
      },
      ignoreActions: {
        "*": ["form:search"],
      },
    });

    if (findings.length > 0) {
      throw new Error(
        `expected 0 parity findings, got ${findings.length}:\n${JSON.stringify(findings, null, 2)}`,
      );
    }
    if (checked !== 13) {
      throw new Error(`expected 13 screens checked, got ${checked}`);
    }
  },
});
