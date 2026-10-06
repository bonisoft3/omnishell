import { describe, expect, it } from "@test/harness";
import { memoryStore, type Schema } from "./screen-harness.ts";

const schema: Schema = {
  game_card: { fields: [{ name: "id", type: "uuid", ref: "game" }, { name: "state", type: "string" }] },
  game: { fields: [{ name: "id", type: "uuid" }, { name: "slug", type: "string" }, { name: "phase_id", type: "uuid", ref: "phase" }] },
  phase: { fields: [{ name: "id", type: "uuid" }, { name: "championship_id", type: "uuid", ref: "championship" }] },
  championship: { fields: [{ name: "id", type: "uuid" }, { name: "slug", type: "string" }] },
};
const tables = {
  game_card: [{ id: "other", state: "off" }, { id: "match", state: "off" }, { id: "missing", state: "off" }],
  game: [{ id: "other", slug: "other-game", phase_id: "p2" }, { id: "match", slug: "chosen&game", phase_id: "p1" }],
  phase: [{ id: "p1", championship_id: "c1" }, { id: "p2", championship_id: "c2" }],
  championship: [{ id: "c1", slug: "chosen-season" }, { id: "c2", slug: "other-season" }],
};

describe("seed queries use declared relationships", () => {
  it("filters aliased joins before projecting and applies inner joins before paging", async () => {
    const store = memoryStore(tables, { schema });
    expect(await store.query("game_card", "id.asc", {
      select: "id,game:id!inner(slug)", filter: "game.slug=eq.chosen%26game&limit=1",
    })).toEqual([{ id: "match", game: { slug: "chosen&game" } }]);
    expect(await store.query("game_card", "id.asc", {
      select: "id,game:id!inner()", filter: "game.slug=eq.chosen%26game",
    })).toEqual([{ id: "match", game: {} }]);
    expect(await store.query("game_card", "id.asc", {
      select: "id,game:id!inner(slug)", filter: "offset=1&limit=1",
    })).toEqual([{ id: "other", game: { slug: "other-game" } }]);
  });

  it("keeps a base row when an outer join's predicate leaves the embed null", async () => {
    const store = memoryStore(tables, { schema });
    expect(await store.query("game_card", "id.asc", {
      select: "id,game:id(slug)", filter: "game.slug=eq.chosen%26game",
    })).toEqual([
      { id: "match", game: { slug: "chosen&game" } },
      { id: "missing", game: null },
      { id: "other", game: null },
    ]);
  });

  it("propagates nested inner joins and filters through aliases", async () => {
    const store = memoryStore(tables, { schema });
    expect(await store.query("game_card", null, {
      select: "id,game:id!inner(stage:phase!inner(championship!inner(slug)))",
      filter: "game.stage.championship.slug=eq.chosen-season",
    })).toEqual([{ id: "match", game: { stage: { championship: { slug: "chosen-season" } } } }]);
  });

  it("refuses invalid queries before inspecting an empty seed", async () => {
    const store = memoryStore(Object.fromEntries(Object.keys(tables).map((t) => [t, []])), { schema });
    const cases = [
      [{ select: "*,championship(slug)" }, /0 declared relationships/],
      [{ select: "*,game:id!inner(slug)", filter: "game.misspelled=eq.x" }, /unknown column game.misspelled/],
      [{ select: "*,game:id!inner(misspelled)" }, /unknown column game.misspelled/],
      [{ select: "*,game:id!inner(slug)", filter: "wrong.slug=eq.x" }, /not selected/],
      [{ filter: "misspelled=eq.x" }, /unknown column game_card.misspelled/],
      [{ filter: "state=in.(off,on)" }, /outside the grammar/],
      [{ filter: "or=(state.eq.off,state.eq.on)" }, /outside the grammar/],
      [{ filter: "state=eq.off&" }, /outside the grammar/],
      [{ select: "*,game:id!unsupported(slug)" }, /outside the grammar/],
      [{ select: "state::text" }, /outside the grammar/],
      [{ order: "misspelled.asc" }, /unknown column game_card.misspelled/],
      [{ filter: "offset=-1" }, /outside the grammar/],
      [{ select: "*,...game:id(slug)" }, /outside the grammar/],
    ] as const;
    for (const [query, error] of cases) await expect(store.query("game_card", null, query)).rejects.toThrow(error);
    const brokenTarget = memoryStore(tables, { schema: { ...schema, game: { fields: [{ name: "slug", type: "string" }] } } });
    await expect(brokenTarget.query("game_card", null, { select: "*,game:id(slug)" })).rejects.toThrow(/unknown column game.id/);
    const ambiguous = memoryStore(tables, { schema: { ...schema, game_card: { fields: [
      ...schema.game_card.fields, { name: "another_game_id", type: "uuid", ref: "game" },
    ] } } });
    await expect(ambiguous.query("game_card", null, { select: "*,game(slug)" })).rejects.toThrow(/2 declared relationships/);
  });
});
