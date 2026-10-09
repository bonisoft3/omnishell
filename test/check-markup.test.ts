// The markup check's own claims, run by the test verb rather than by hand:
// check-markup.ts is a checker, not a suite, so its cases reach CI only
// through this file.
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { screenFindings, selfTest } from "../check-markup.ts";

Deno.test({
  name: "check-markup self-test",
  async fn() {
    const { failures } = await selfTest();
    if (failures.length > 0) throw new Error(failures.join("\n"));
  },
});

Deno.test("check-markup distinguishes aggregate result cardinality from grouped input rows", () => {
  const schema = { stat: { durability: "server", fields: [
    { name: "id", type: "uuid", pk: true },
    { name: "team_id", type: "uuid" },
    { name: "minutes", type: "int32" },
  ] } };
  const findings = (select: string) => screenFindings("totals.html",
    `<div data-live="stat" data-select="${select}" data-filter="team_id=eq.{param.team}&amp;limit=1"><span data-text="{total}"></span></div>`,
    schema, new Set(), []);
  assertEquals(findings("total:minutes.sum()"), []);
  const grouped = findings("team_id,total:minutes.sum()");
  assertEquals(grouped.length, 1);
  assertStringIncludes(grouped[0].message, "may bind more than one row");
});
