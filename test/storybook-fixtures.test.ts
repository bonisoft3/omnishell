import { describe, expect, it } from "@test/harness";
import { fixtureStore } from "../interpreter/storybook.js";

describe("storybook fixture values", () => {
  it("uses a table field's declared enum default and keeps the enum closed", async () => {
    const store = fixtureStore("populated", new Set(), {
      archive_page: {
        fields: [
          { name: "sort", default: "'1y'", enum: ["1m", "3m", "1y"] },
          { name: "period", default: "invalid", enum: ["1m", "all"] },
        ],
      },
      other_table: { fields: [{ name: "sort", enum: ["newest", "oldest"] }] },
    });

    const pages = await store.query("archive_page");
    const page = pages[0] as Record<string, unknown>;
    expect(page.sort).toBe("1y");
    expect(page.period).toBe("1m");
    expect(page.title).toBe("Sample title 1");

    const other = await store.query("other_table", undefined, {
      singleton: true,
    });
    expect((other[0] as Record<string, unknown>).sort).toBe("newest");
  });
});
