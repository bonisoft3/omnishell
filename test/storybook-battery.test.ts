import { describe, expect, it } from "@test/harness";
import { runStorybookBatteryForApp } from "./storybook-battery.ts";

function poseControl(caseName: string) {
  return runStorybookBatteryForApp(new URL(`./fixtures/storybook-controls/${caseName}/`, import.meta.url));
}

describe("storybook battery control rows", () => {
  it("uses a declared default for a control outside the posed machine", async () => {
    const report = await poseControl("valid");
    expect(report.errors).toEqual([]);
    expect(report.success).toBe(true);
    expect(report.totalFrames).toBe(3);
    expect(report.mutationsDispatched).toBe(0);
  });

  it("refuses a control default outside the declared order choices", async () => {
    const report = await poseControl("invalid");
    expect(report.success).toBe(false);
    expect(report.errors).toHaveLength(3);
    expect(report.errors.every((error) => error.includes('is "unknown", which is not one of name, date'))).toBe(true);
    expect(report.mutationsDispatched).toBe(0);
  });
});
