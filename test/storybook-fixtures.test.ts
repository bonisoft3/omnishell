import { describe, expect, it } from "@test/harness";
import { parseHTML } from "linkedom";
import { fixtureStore, renderStorybook } from "../interpreter/storybook.js";

describe("storybook fixture values", () => {
  it("caps list and singleton fixtures using the runtime's filter limit", async () => {
    const store = fixtureStore("populated");
    for (const [filter, count] of [
      ["limit=0", 0], ["limit=1", 1], ["limit=2", 2], ["limit=40", 3],
      ["id=eq.fixture-0&limit=1&name=like.*", 1], ["title=eq.limit=1", 3],
    ] as const) {
      const rows = await store.query("item", undefined, { filter });
      expect(rows.length).toBe(count);
      expect(rows.map((item) => (item as Record<string, unknown>).id)).toEqual(
        Array.from({ length: count }, (_, i) => `fixture-${i}`),
      );
    }
    expect((await store.query("item")).length).toBe(3);
    expect((await store.query("item", undefined, { singleton: true, filter: "limit=2" })).length).toBe(1);
    expect((await store.query("item", undefined, { singleton: true, filter: "limit=0" })).length).toBe(0);
    for (const state of ["empty", "loading"]) {
      expect(await fixtureStore(state).query("item", undefined, { filter: "limit=1" })).toEqual([]);
    }
  });

  it("does not multiply an entire nested editor through limit-one item templates", async () => {
    const source = `<main data-screen="editor">
      <div data-live="editor" data-filter="limit=1"><template data-item><div class="editor">
        <div data-live="championship" data-filter="id=eq.{id}&limit=1"><template data-item><article>
          <ul data-live="group"><template data-item><li data-text="{id}"></li></template></ul>
        </article></template></div>
      </div></template></div>
    </main>`;
    const { document } = parseHTML('<!doctype html><html><head></head><body><div id="mount"></div></body></html>');
    const held = { document: globalThis.document, fetch: globalThis.fetch, location: globalThis.location };
    Object.assign(globalThis, {
      document,
      location: new URL("http://app.test/"),
      fetch: (url: unknown) => {
        const path = new URL(String(url), "http://app.test/").pathname;
        if (path === "/editor.html") return Promise.resolve(new Response(source));
        if (path === "/editor.css") return Promise.resolve(new Response(""));
        throw new Error(`unexpected storybook asset: ${path}`);
      },
    });
    try {
      const mount = document.getElementById("mount")!;
      await renderStorybook(mount, "http://app.test/", {
        screen: "editor", files: { html: "editor.html", css: "editor.css" }, states: ["populated"],
      });
      expect(mount.querySelectorAll(".frame .editor").length).toBe(1);
      expect(mount.querySelectorAll(".frame article").length).toBe(1);
      expect([...mount.querySelectorAll(".frame li")].map((item) => item.textContent)).toEqual([
        "fixture-0", "fixture-1", "fixture-2",
      ]);
    } finally {
      Object.assign(globalThis, held);
    }
  });

  it("uses a table field's declared enum default and keeps the enum closed", async () => {
    const store = fixtureStore("populated", new Set(), {
      archive_page: {
        fields: [
          { name: "sort", default: "1y", enum: ["1m", "3m", "1y"] },
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
