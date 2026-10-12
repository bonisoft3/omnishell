// Regression rationale: asserts read-only visual isolation (0 store writes) and
// deterministic fuel budget bounds across all screen machines in the ecosystem.

import { describe, expect, it } from "@test/harness";
import { runStorybookBatteryForApp } from "./storybook-battery.ts";

const appsDir = new URL("../../../apps", import.meta.url);
const discoveredApps: string[] = [];
for await (const entry of Deno.readDir(appsDir)) {
  if (entry.isDirectory) {
    try {
      const stat = await Deno.stat(new URL(`../../../apps/${entry.name}/shell/screens`, import.meta.url));
      if (stat.isDirectory) discoveredApps.push(entry.name);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
}
discoveredApps.sort();

describe("Universal Statechart-to-Storybook Battery & DuckDB Synthetic Seeds", () => {
  for (const app of discoveredApps) {
    it(`poses all screen machines in apps/${app} with 0 mutations within fuel budget`, async () => {
      const appUrl = new URL(`../../../apps/${app}/`, import.meta.url);
      const stat = await Deno.stat(appUrl);
      if (!stat.isDirectory) {
        throw new Error(`Expected ${appUrl} to be a directory`);
      }
      const report = await runStorybookBatteryForApp(appUrl);

      expect(report.success).toBe(true);
      expect(report.errors).toEqual([]);
      expect(report.mutationsDispatched).toBe(0);
      expect(report.screensChecked).toBeGreaterThan(0);
      expect(report.totalFrames).toBeGreaterThan(0);
      expect(report.totalFuelSpent).toBeGreaterThan(0);
    });
  }
});
