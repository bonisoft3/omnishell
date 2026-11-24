// Verifies that Snapcards' 6 core screens (`cards`, `generate`, `explore`, `deck`, `card`, `about`)
// compile cleanly through `project-native.ts` and reconcile through `runtime/reconciler.ts` into
// valid DivKit JSON cards with:
//   - `[data-image-src]` & `img[src]` -> `div-image` (`/img/*` origin URLs + `data:image/svg+xml;utf8,...`)
//   - `[popover]` & modal dialogs -> `div-state` blocks (`closed` / `open`)
//   - `[data-status]`, `[data-flipped]`, `[hidden]`, ownership (`is_owned_deck`) & favorite (`is_favorited`) visibility
//   - `data-live` `<template data-item>` repeaters & empty-state templates
//   - `.flashcard-frame` / `[data-flipped]` -> `div-custom` (`custom_type: "flip-card"`) with front/back items

import { describe, expect, it } from "@test/harness";
import { directionOfLocale, projectAppNative, resolveNativeImageUrl, type DivKitCard } from "../project-native.ts";
import { HeadlessDivKitSession, parsePrintReturnUrl, reconcileScreenToDivKit } from "../runtime/reconciler.ts";
import { createAuthBridge } from "../runtime/auth-bridge.ts";
import {
  createHeadlessSwrRuntime,
  createSqliteStorageBridge,
  planNativeRelease,
  verifyEntryManifestEd25519,
  type NativeScreenAssetRef,
} from "../runtime/swr-cache.ts";
import { createStore } from "../interpreter/data-sync.js";

const snapcardsDir = new URL("../../../apps/snapcards/", import.meta.url);
const CORE_SCREENS = ["cards", "generate", "explore", "deck", "card", "about"] as const;

function collectNodesByPredicate(
  div: Record<string, unknown>,
  pred: (node: Record<string, unknown>) => boolean,
  out: Array<Record<string, unknown>> = [],
): Array<Record<string, unknown>> {
  if (pred(div)) out.push(div);
  for (const key of ["items", "states"] as const) {
    const arr = div[key];
    if (Array.isArray(arr)) {
      for (const child of arr) {
        if (child && typeof child === "object") {
          collectNodesByPredicate(child as Record<string, unknown>, pred, out);
        }
      }
    }
  }
  if (div.div && typeof div.div === "object") {
    collectNodesByPredicate(div.div as Record<string, unknown>, pred, out);
  }
  return out;
}

function findNodesOfType(card: DivKitCard, type: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const st of card.card.states) {
    collectNodesByPredicate(st.div, (n) => n.type === type, out);
  }
  return out;
}

describe("Snapcards 6 core screens -> DivKit compilation & headless reconciliation", () => {
  it("projects all 6 core screens (`cards`, `generate`, `explore`, `deck`, `card`, `about`) into valid DivKit cards", async () => {
    const projection = await projectAppNative(snapcardsDir, {
      origin: "https://snapcards.fun",
    });

    for (const screenName of CORE_SCREENS) {
      const entry = projection.screens[screenName];
      expect(entry !== undefined).toBe(true);
      expect(entry.divkit.card.log_id).toBe(`omnishell_${screenName}`);
      expect(entry.divkit.card.states.length).toBe(1);
      expect(entry.divkit.card.states[0].state_id).toBe(0);
      expect(typeof entry.divkit.card.states[0].div.type).toBe("string");
    }

    // `about` resolves all 3 fanned `/img/*` seed cards into origin-qualified `div-image` blocks + its ⋯ sheet `div-state`
    const aboutImages = findNodesOfType(projection.screens.about.divkit, "image");
    expect(aboutImages.length).toBe(3);
    for (const img of aboutImages) {
      expect(String(img.image_url).startsWith("https://snapcards.fun/img/insecure/plain/s3://mecha-objects/seed/")).toBe(true);
    }
    const aboutStates = findNodesOfType(projection.screens.about.divkit, "state");
    expect(aboutStates.some((s) => s.id === "state_more-sheet-about")).toBe(true);
    // No screen draws its own sign-in: the projection adds the account sheet from `auth`.
    expect(aboutStates.some((s) => s.id === "state_login-modal-overlay")).toBe(true);

    // `generate` lowers all 3 `[popover]` menus (`draft-loc-menu`, `locale-combo-menu`, `difficulty-combo-menu`) + its ⋯ sheet to `div-state`
    const genStates = findNodesOfType(projection.screens.generate.divkit, "state");
    const genStateIds = genStates.map((s) => String(s.id));
    expect(genStateIds.includes("state_more-sheet-generate")).toBe(true);
    expect(genStateIds.includes("state_login-modal-overlay")).toBe(true);
    expect(genStateIds.includes("state_draft-loc-menu")).toBe(true);
    expect(genStateIds.includes("state_locale-combo-menu")).toBe(true);
    expect(genStateIds.includes("state_difficulty-combo-menu")).toBe(true);

    // `generate` captures headless `data-on-mutation` folds (`create_set`, `localize_content`)
    const genFoldHandlers = new Set((projection.screens.generate.ir.folds ?? []).map((f) => f.handler));
    expect(genFoldHandlers.has("create_set")).toBe(true);
    expect(genFoldHandlers.has("localize_content")).toBe(true);

    // `explore` and `card` emit `div-custom` (`custom_type: "flip-card"`) with front/back faces and `card-edit-sheet` popover `div-state`
    for (const studyScreen of ["explore", "card"] as const) {
      const divCard = projection.screens[studyScreen].divkit;
      const customNodes = findNodesOfType(divCard, "custom");
      const flipCards = customNodes.filter((n) => n.custom_type === "flip-card");
      expect(flipCards.length).toBe(1);
      const flip = flipCards[0];
      expect(Array.isArray(flip.items) && flip.items.length === 2).toBe(true);
      const props = flip.custom_props as Record<string, unknown>;
      expect(props.flipped).toBe("@{flipped}");
      expect(props.flipped_variable).toBe("flipped");
      expect(props.perspective_px).toBe(1200);
      expect(divCard.card.variables.some((v) => v.name === "flipped" && v.value === "no")).toBe(true);

      const states = findNodesOfType(divCard, "state");
      expect(states.some((s) => s.id === "state_card-edit-sheet")).toBe(true);
      expect(states.some((s) => s.id === `state_more-sheet-${studyScreen}`)).toBe(true);
      expect(states.some((s) => s.id === "state_login-modal-overlay")).toBe(true);

      // Visibility expressions for `[data-status]` (`fullscreen`, `completed`) and ownership (`is_owned_deck`)
      const rawJson = JSON.stringify(divCard);
      expect(rawJson.includes("@{status == 'fullscreen' ? 'visible' : 'gone'}")).toBe(true);
      expect(rawJson.includes("@{status == 'completed' ? 'visible' : 'gone'}")).toBe(true);
      expect(rawJson.includes("@{is_owned_deck ? 'visible' : 'gone'}")).toBe(true);
    }

    // `cards` emits `data-live` repeater metadata, `[data-image-src]` `div-image`, ownership & favorite visibility expressions
    const cardsJson = JSON.stringify(projection.screens.cards.divkit);
    expect(cardsJson.includes('"data_image_src":"{cover}"')).toBe(true);
    expect(cardsJson.includes("@{is_favorited ? 'visible' : 'gone'}")).toBe(true);
    expect(cardsJson.includes("@{is_favorited ? 'gone' : 'visible'}")).toBe(true);
    expect(cardsJson.includes("@{author_filter == 'mine' ? 'visible' : 'gone'}")).toBe(true);
    // The account sheet shows an account a guest's sign-in found held, with Switch and Stay, and
    // Delete account asks once before the press that deletes.
    expect(cardsJson.includes("@{held_handle != '' ? 'visible' : 'gone'}")).toBe(true);
    expect(cardsJson.includes("@{delete_confirm == 'yes' ? 'visible' : 'gone'}")).toBe(true);
    expect(cardsJson.includes("method=delete-ask") && cardsJson.includes("method=switch")).toBe(true);

    // `deck` emits empty-state template for `data-empty`
    const deckJson = JSON.stringify(projection.screens.deck.divkit);
    expect(deckJson.includes("@{deck_is_empty ? 'visible' : 'gone'}")).toBe(true);
  });

  it("reconciles `cards`, `explore`, and `deck` with live rows, Level-0 SVG data URIs, ownership/favorites, and interactive flips/sheets", async () => {
    const projection = await projectAppNative(snapcardsDir, {
      origin: "https://snapcards.fun",
    });

    const level0Svg =
      'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="#FAF7F2"/><text x="128" y="140">🦫</text></svg>';

    const tables = {
      me: [{ id: "user-me", handle: "davi" }],
      play_session: [
        {
          id: "session",
          set_id: "deck-owned",
          card_id: "card-1",
          card_index: 0,
          flipped: "no",
          mastered: 0,
          total: 2,
          status: "playing",
          finished: "",
          front: "Capivara",
          back: level0Svg,
          emoji: "🦫",
          library_query: "",
        },
      ],
      localized_deck: [
        {
          id: "deck-owned",
          name: "Animais do Pantanal",
          category: "Fauna",
          cover_emoji: "🎨",
          locale: "pt-BR",
          region: "Brasil",
          count: 2,
          owner: "user-me",
        },
        {
          id: "deck-public",
          name: "Frutas Tropicais",
          category: "Frutas",
          cover_emoji: "🍍",
          locale: "pt-BR",
          region: "Brasil",
          count: 5,
          owner: "user-other",
        },
      ],
      card_set: [
        { id: "deck-owned", name: "Animais do Pantanal", owner: "user-me", cover_emoji: "🎨" },
        { id: "deck-public", name: "Frutas Tropicais", owner: "user-other", cover_emoji: "🍍" },
      ],
      deck_stats: [
        { deck_id: "deck-owned", cover: level0Svg, favorite_count: 3 },
        { deck_id: "deck-public", cover: "/img/insecure/plain/s3://mecha-objects/seed/pineapple.webp", favorite_count: 12 },
      ],
      favorite: [
        { user_id: "user-me", deck_id: "deck-owned", deleted_at: null },
      ],
      localized_card: [
        { id: "card-1", set_id: "deck-owned", front: "Capivara", original_front: "capybara", emoji: "🦫" },
        { id: "card-2", set_id: "deck-owned", front: "Arara", original_front: "macaw", emoji: "🦜" },
      ],
      flashcard: [
        { id: "card-1", set_id: "deck-owned", front: "Capivara", back: level0Svg, description: "A friendly capybara" },
        { id: "card-2", set_id: "deck-owned", front: "Arara", back: "/img/insecure/plain/s3://mecha-objects/seed/macaw.webp", description: "Blue macaw" },
      ],
    };

    // 1. Reconcile `cards` library screen: stamps both decks, resolves Level-0 SVG + `/img/*` covers,
    //    shows delete button ONLY on `deck-owned`, and swaps favorite heart arm per deck!
    const cardsCard = reconcileScreenToDivKit(projection.screens.cards.ir, {
      origin: "https://snapcards.fun",
      tables,
      theme: projection.theme,
    });
    const cardsImages = findNodesOfType(cardsCard, "image");
    const imageUrls = cardsImages.map((img) => String(img.image_url));
    expect(imageUrls.some((u) => u.startsWith("data:image/svg+xml;utf8,%3Csvg"))).toBe(true);
    expect(imageUrls.includes("https://snapcards.fun/img/insecure/plain/s3://mecha-objects/seed/pineapple.webp")).toBe(true);

    const cardsStr = JSON.stringify(cardsCard);
    expect(cardsStr.includes("Animais do Pantanal")).toBe(true);
    expect(cardsStr.includes("Frutas Tropicais")).toBe(true);
    expect(cardsStr.includes("__deck_owned")).toBe(true);
    expect(cardsStr.includes("__deck_public")).toBe(true);

    // `/mine` shelf filters out non-owned decks
    const mineCard = reconcileScreenToDivKit(projection.screens.cards.ir, {
      origin: "https://snapcards.fun",
      params: { shelf: "mine" },
      tables,
      theme: projection.theme,
    });
    const mineStr = JSON.stringify(mineCard);
    expect(mineStr.includes("Animais do Pantanal")).toBe(true);
    expect(mineStr.includes("Frutas Tropicais")).toBe(false);

    // 2. Reconcile `deck` screen against an empty deck ID -> renders empty-state template and `deck_is_empty = true`
    const emptyDeckCard = reconcileScreenToDivKit(projection.screens.deck.ir, {
      origin: "https://snapcards.fun",
      params: { deck: "deck-missing" },
      tables,
      theme: projection.theme,
    });
    expect(emptyDeckCard.card.variables.find((v) => v.name === "deck_is_empty")?.value).toBe(true);
    expect(JSON.stringify(emptyDeckCard).includes("_empty")).toBe(true);

    // 3. Interactive `HeadlessDivKitSession` on `explore`: flip card (`no` -> `yes` -> `no`) and open/close edit popover
    const session = new HeadlessDivKitSession(projection, {
      origin: "https://snapcards.fun",
      initialScreen: "explore",
      tables,
    });
    const initialExplore = session.render();
    expect(initialExplore.card.variables.find((v) => v.name === "flipped")?.value).toBe("no");
    expect(initialExplore.card.variables.find((v) => v.name === "is_owned_deck")?.value).toBe(true);
    expect(initialExplore.card.variables.find((v) => v.name === "deck_card_count")?.value).toBe(2);

    const afterFlip = session.dispatchAction("pronto://event/CHART_CLICK?id=card-flip-visual");
    expect(afterFlip.card.variables.find((v) => v.name === "flipped")?.value).toBe("yes");

    const afterOpenEdit = session.dispatchAction("pronto://event/POPOVER?target=card-edit-sheet&op=toggle&id=btn-edit");
    expect(afterOpenEdit.card.variables.find((v) => v.name === "sheet_card_edit_sheet_state")?.value).toBe("open");

    const afterCloseEdit = session.dispatchAction("pronto://event/POPOVER?target=card-edit-sheet&op=hide&id=btn-done");
    expect(afterCloseEdit.card.variables.find((v) => v.name === "sheet_card_edit_sheet_state")?.value).toBe("closed");

    // Helper sanity check on `resolveNativeImageUrl`
    expect(resolveNativeImageUrl("/img/card.webp", "https://snapcards.fun")).toBe("https://snapcards.fun/img/card.webp");
    expect(resolveNativeImageUrl(level0Svg).startsWith("data:image/svg+xml;utf8,%3Csvg")).toBe(true);
  });

  it("persists Snapcards offline UGC (`card_set`, `favorite` upsert, `device`) in SQLite across cold reboot and adopts provisional UUID on guest promotion", async () => {
    const shellJson = JSON.parse(await Deno.readTextFile(new URL("shell/shell.json", snapcardsDir)));
    expect(shellJson.schema.favorite.durability).toBe("offline");
    expect(shellJson.tables.includes("favorite")).toBe(true);

    const tmpDir = await Deno.makeTempDir({ prefix: "snapcards-sqlite-" });
    const dbFile = `${tmpDir}/snapcards.sqlite`;
    const provisionalId = "019a0000-0000-7000-8000-000000000001";
    const adoptedUserId = "019a0000-0000-7000-8000-000000000099";

    const b64url = (obj: unknown) =>
      btoa(JSON.stringify(obj)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const makeJwt = (sub: string) =>
      `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub, role: "app_user" })}.sig`;

    let online = false;
    let isProvisional = true;
    const makeSessionObj = (sub: string, rt: string) => ({
      token: makeJwt(sub),
      refresh_token: rt,
      user: { id: sub, guest: true },
    });
    let heldAuthSession: Record<string, unknown> | null = makeSessionObj(provisionalId, "rt-prov");
    const crudPosts: Array<{ url: string; method: string; body: unknown; auth: string | null }> = [];
    const serverRows: Record<string, Array<Record<string, unknown>>> = {
      card_set: [],
      favorite: [],
    };
    const streamWaiters = new Map<string, Array<() => void>>();

    const g = globalThis as Record<string, unknown>;
    const prevFetch = globalThis.fetch;
    const prevSessionStorage = g.sessionStorage;
    const prevLocalStorage = g.localStorage;
    const prevHostStorage = g.__omnishellStorage;
    const prevAuthBridge = g.AuthBridge;

    let txSeq = 10;
    let electricCursor = 0;
    let forceFirstCrud401 = true;
    const electricSchemaFor = (table: string) => {
      const fields = (shellJson.schema?.[table]?.fields ?? []) as Array<{ name: string; type: string }>;
      const out: Record<string, { type: string }> = { txid: { type: "int8" } };
      for (const f of fields) {
        out[f.name] = { type: f.type === "int32" ? "int4" : f.type === "int64" ? "int8" : f.type === "bool" ? "bool" : "text" };
      }
      return out;
    };
    const toElectricWireRow = (r: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v == null ? null : String(v)]));
    const fakeFetch: typeof fetch = async (input, init) => {
      if (!online) throw new TypeError("Failed to fetch: offline");
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const u = new URL(rawUrl, "https://snapcards.fun");
      const reqHeaders = new Headers(init?.headers);
      if (u.pathname === "/auth/refresh") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        expect(body.refresh_token).toBe("rt-guest-1");
        const rotated = makeSessionObj(adoptedUserId, "rt-guest-2");
        return new Response(JSON.stringify(rotated), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.pathname === "/auth/shape") {
        return new Response(JSON.stringify({ token: "shape-tok", where: "true", expires_in: 900 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.pathname.startsWith("/electric/v1/shape")) {
        const table = u.searchParams.get("table") ?? "";
        const offset = u.searchParams.get("offset");
        const live = u.searchParams.get("live") === "true";
        const clientSeq = offset && offset.startsWith("0_") ? Number(offset.slice(2)) : -1;
        const unseenBefore = (serverRows[table] ?? []).filter((r) => Number(r.txid ?? 0) > clientSeq);
        if (live && unseenBefore.length === 0) {
          await new Promise<void>((resolve, reject) => {
            const list = streamWaiters.get(table) ?? [];
            list.push(resolve);
            streamWaiters.set(table, list);
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
          });
        }
        const unseen = (serverRows[table] ?? []).filter((r) => Number(r.txid ?? 0) > clientSeq);
        const messages = [
          ...unseen.map((r, idx) => ({
            key: `"public"."${table}"/"${String(r.id ?? idx)}"`,
            value: toElectricWireRow(r),
            headers: { operation: "insert", relation: ["public", table], txids: [Number(r.txid ?? txSeq)] },
          })),
          { headers: { control: "up-to-date", global_last_seen_lsn: String(txSeq) } },
        ];
        return new Response(JSON.stringify(messages), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "electric-handle": `handle-${table}`,
            "electric-offset": `0_${txSeq}`,
            "electric-schema": JSON.stringify(electricSchemaFor(table)),
            "electric-cursor": String(++electricCursor),
          },
        });
      }
      if (u.pathname.startsWith("/crud/")) {
        if (forceFirstCrud401) {
          forceFirstCrud401 = false;
          return new Response(JSON.stringify({ message: "JWT expired" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        const table = u.pathname.slice("/crud/".length);
        const method = init?.method ?? "GET";
        const bodyText = typeof init?.body === "string" ? init.body : "";
        const parsed = bodyText ? JSON.parse(bodyText) : null;
        crudPosts.push({ url: u.pathname + u.search, method, body: parsed, auth: reqHeaders.get("Authorization") });
        const nextTx = String(++txSeq);
        if (method === "POST") {
          const items = Array.isArray(parsed) ? parsed : [parsed];
          for (const item of items) {
            const stamped = { ...item, txid: nextTx, ...(table === "favorite" && !item.user_id ? { user_id: adoptedUserId } : {}) };
            serverRows[table] ??= [];
            serverRows[table].push(stamped);
          }
          for (const wake of (streamWaiters.get(table) ?? []).splice(0)) wake();
          return new Response(JSON.stringify(serverRows[table]), {
            status: 201,
            headers: { "Content-Type": "application/json", "x-txid": nextTx },
          });
        }
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json", "x-txid": nextTx } });
      }
      throw new Error(`unexpected URL in test: ${u.href}`);
    };

    const minimalCfg = {
      app: "snapcards",
      carriers: shellJson.carriers,
      tables: ["card_set", "favorite"],
      local: { device: "device" },
      schema: {
        card_set: shellJson.schema.card_set,
        favorite: shellJson.schema.favorite,
        device: shellJson.schema.device,
      },
      access: {
        card_set: shellJson.access.card_set,
        favorite: shellJson.access.favorite,
      },
      uniques: {
        favorite: shellJson.uniques.favorite,
      },
    };

    let bridge1: ReturnType<typeof createSqliteStorageBridge> | null = null;
    let bridge2: ReturnType<typeof createSqliteStorageBridge> | null = null;
    try {
      g.fetch = fakeFetch;
      // A native host has no web storage: the session is the bridge's alone.
      delete g.sessionStorage;
      delete g.localStorage;
      g.AuthBridge = {
        loadSession: () => heldAuthSession,
        saveSession: (next: Record<string, unknown>) => { heldAuthSession = next; },
        clearSession: () => { heldAuthSession = null; },
      };

      // Boot 1: completely offline on first launch with provisional subject UUID!
      bridge1 = createSqliteStorageBridge(dbFile);
      g.__omnishellStorage = bridge1;
      const store1 = createStore("https://snapcards.fun", {
        ...minimalCfg,
        provisional: () => isProvisional,
      });

      await store1.write("device", [{ key: "device", row: { id: "device", key: "dev-offline-1", theme: "light", locale: "" } }]);
      await store1.write("card_set", [{
        key: "deck-offline-1",
        row: {
          id: "deck-offline-1",
          name: "Aves do Cerrado",
          category: "Fauna",
          locale: "pt-BR",
          region: "Brasil",
          count: 5,
          cover_emoji: "🦜",
          details: "",
          device: "dev-offline-1",
          owner: provisionalId,
          audience_key: "diff_kids",
          audience: "",
          number: 1,
        },
      }]);
      await store1.upsertBy("favorite", { deck_id: "deck-offline-1", deleted_at: null });

      const offlineDecks1 = await store1.query("card_set");
      expect(offlineDecks1.some((d: Record<string, unknown>) => d.id === "deck-offline-1" && d.owner === provisionalId)).toBe(true);
      const offlineFavs1 = await store1.query("favorite");
      expect(offlineFavs1.some((f: Record<string, unknown>) => f.deck_id === "deck-offline-1" && f.deleted_at === null)).toBe(true);

      await store1.close();
      bridge1.close();
      bridge1 = null;

      // Boot 2: cold restart from disk SQLite STILL offline -> device row + queued outbox survive!
      bridge2 = createSqliteStorageBridge(dbFile);
      g.__omnishellStorage = bridge2;
      const store2 = createStore("https://snapcards.fun", {
        ...minimalCfg,
        provisional: () => isProvisional,
      });
      const coldDevice = await store2.query("device");
      expect(coldDevice[0]?.key).toBe("dev-offline-1");
      const coldDecks = await store2.query("card_set");
      expect(coldDecks.some((d: Record<string, unknown>) => d.id === "deck-offline-1")).toBe(true);

      // Connectivity arrives: `/auth/guest` mints `adoptedUserId` -> rebind provisional subject, rotate expired JWT on 401 via /auth/refresh, & flush outbox!
      online = true;
      isProvisional = false;
      heldAuthSession = makeSessionObj(adoptedUserId, "rt-guest-1");
      await store2.adoptProvisionalSubject(provisionalId, adoptedUserId);

      const deadline = Date.now() + 5000;
      while (crudPosts.filter((p) => p.method === "POST").length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }

      const cardSetPost = crudPosts.find((p) => p.url.startsWith("/crud/card_set") && p.method === "POST");
      expect(cardSetPost !== undefined).toBe(true);
      const postedDeck = Array.isArray(cardSetPost!.body) ? cardSetPost!.body[0] : cardSetPost!.body;
      expect((postedDeck as Record<string, unknown>).owner).toBe(adoptedUserId);
      expect((heldAuthSession as Record<string, unknown>)?.refresh_token).toBe("rt-guest-2");

      const favPost = crudPosts.find((p) => p.url.startsWith("/crud/favorite") && p.method === "POST");
      expect(favPost !== undefined).toBe(true);
      const postedFav = Array.isArray(favPost!.body) ? favPost!.body[0] : favPost!.body;
      expect((postedFav as Record<string, unknown>).user_id).toBe(adoptedUserId);

      await store2.close();
      bridge2.close();
      bridge2 = null;
    } finally {
      g.fetch = prevFetch;
      if (prevSessionStorage === undefined) delete g.sessionStorage;
      else g.sessionStorage = prevSessionStorage;
      if (prevLocalStorage === undefined) delete g.localStorage;
      else g.localStorage = prevLocalStorage;
      if (prevHostStorage === undefined) delete g.__omnishellStorage;
      else g.__omnishellStorage = prevHostStorage;
      if (prevAuthBridge === undefined) delete g.AuthBridge;
      else g.AuthBridge = prevAuthBridge;
      bridge1?.close();
      bridge2?.close();
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    }
  });

  it("projects `/print` scoped realms (`web-realm` & `print-realm`), handles `snapcards://print/return` order recheck, and executes the host's Apple sign-in + Delete Account wipe", async () => {
    const projection = await projectAppNative(snapcardsDir, {
      origin: "https://snapcards.fun",
    });

    const printEntry = projection.screens.print;
    expect(printEntry !== undefined).toBe(true);
    expect(printEntry.divkit.card.log_id).toBe("omnishell_print");

    const customNodes = findNodesOfType(printEntry.divkit, "custom");
    const webRealms = customNodes.filter((n) => n.custom_type === "web-realm");
    const printRealms = customNodes.filter((n) => n.custom_type === "print-realm");
    expect(webRealms.length >= 2).toBe(true);
    expect(printRealms.length).toBe(1);

    const mapRealm = webRealms.find((n) => (n.custom_props as Record<string, unknown>)?.unit === "delivery-map");
    expect(mapRealm !== undefined).toBe(true);
    expect(((mapRealm!.custom_props as Record<string, unknown>).grants as string[]).includes("geolocation")).toBe(true);

    const paymentRealm = webRealms.find((n) => (n.custom_props as Record<string, unknown>)?.unit === "print-payment");
    expect(paymentRealm !== undefined).toBe(true);
    expect((paymentRealm!.custom_props as Record<string, unknown>).subdomain).toBe("payments");

    const sheetProps = printRealms[0].custom_props as Record<string, unknown>;
    expect((sheetProps.grants as string[]).includes("print")).toBe(true);
    expect((sheetProps.grants as string[]).includes("canvas-300dpi")).toBe(true);
    expect(String(sheetProps.print_action_url).startsWith("omnishell://print?")).toBe(true);
    expect(String(sheetProps.checkout_action_url).startsWith("omnishell://checkout?")).toBe(true);

    const printJson = JSON.stringify(printEntry.divkit);
    // Snapcards ships an Android host alone, so Google stands without Apple (App Review 4.8 binds iOS).
    expect(printJson.includes("btn-auth-google")).toBe(true);
    expect(printJson.includes("btn-auth-apple")).toBe(false);
    expect(printJson.includes("btn-auth-delete")).toBe(true);

    // Parse both custom-scheme and Universal Link Stripe Checkout return URLs
    expect(parsePrintReturnUrl("snapcards://print/return?order=ord_123")?.orderId).toBe("ord_123");
    expect(parsePrintReturnUrl("https://snapcards.fun/he/print?order=ord_456&status=paid")?.orderId).toBe("ord_456");

    // End-to-end order recheck via HeadlessDivKitSession.handleDeepLink
    const patchedBodies: Array<Record<string, unknown>> = [];
    const printTables = {
      card_set: [{ id: "deck-solar", name: "Our Solar System", owner: "user-apple", count: 10 }],
      print_config: [{ id: "config", set_id: "deck-solar", paper: "a4", card_size: "standard", layout: "fold", cut_lines: "yes", orientation: "portrait", vendor: "cloudprinter", stock: "gloss" }],
      print_order: [{ id: "ord_123", set_id: "deck-solar", status: "awaiting_payment", checks: 0, checkout_url: "https://checkout.stripe.com/c/pay/cs_test_123" }],
    };
    const printSession = new HeadlessDivKitSession(projection, {
      origin: "https://snapcards.fun",
      initialScreen: "print",
      locale: "en",
      themeMode: "dark",
      tables: printTables,
    });
    const reconciledPrint = printSession.render();
    const reconciledSheet = findNodesOfType(reconciledPrint, "custom").find((n) => n.custom_type === "print-realm")!;
    const reconciledProps = reconciledSheet.custom_props as Record<string, unknown>;
    expect(reconciledProps.deck_id).toBe("deck-solar");
    expect(reconciledProps.order_id).toBe("ord_123");
    expect(reconciledProps.theme).toBe("dark");
    expect(String(reconciledProps.checkout_action_url).includes("order=ord_123")).toBe(true);

    const recheckResult = await printSession.handleDeepLink("snapcards://print/return?order=ord_123", {
      bearerToken: "jwt-apple-1",
      fetcher: async (input, init) => {
        const u = new URL(String(input), "https://snapcards.fun");
        const method = (init?.method ?? "GET").toUpperCase();
        if (u.pathname === "/crud/print_order" && method === "GET") {
          return new Response(JSON.stringify([{ id: "ord_123", status: "awaiting_payment", checks: 2 }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (u.pathname === "/crud/print_order" && method === "PATCH") {
          const parsed = JSON.parse(String(init?.body ?? "{}"));
          patchedBodies.push(parsed);
          return new Response(JSON.stringify([{ id: "ord_123", ...parsed }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`Unexpected URL ${u.href}`);
      },
    });
    expect(recheckResult !== null).toBe(true);
    expect(patchedBodies).toEqual([{ status: "checking", checks: 3 }]);
    expect(recheckResult!.card.card.variables.find((v) => v.name === "print_order_status")?.value).toBe("checking");

    // Sign in with Apple + Account Deletion (DELETE /auth/account + SQLite wipe preserving public shapes)
    const storage = createSqliteStorageBridge(":memory:");
    try {
      storage.sql!.exec("CREATE TABLE mecha_outbox (id TEXT PRIMARY KEY, payload TEXT);");
      storage.sql!.exec("CREATE TABLE mecha_shape_row (shape_id TEXT, subject TEXT, row_key TEXT, row_json TEXT);");
      storage.sql!.exec("CREATE TABLE mecha_shape_meta (shape_id TEXT, subject TEXT, updated_at INTEGER);");
      storage.sql!.exec("INSERT INTO mecha_outbox VALUES ('tx1', '{}');");
      storage.sql!.exec("INSERT INTO mecha_shape_row VALUES ('favorite', 'user-apple-1', 'fav1', '{}');");
      storage.sql!.exec("INSERT INTO mecha_shape_row VALUES ('card_set', '', 'deck-curated', '{\"id\":\"deck-curated\"}');");
      storage.sql!.exec("INSERT INTO mecha_shape_meta VALUES ('favorite', 'user-apple-1', 1);");
      storage.sql!.exec("INSERT INTO mecha_shape_meta VALUES ('card_set', '', 1);");
      storage.kv.set("draft_pref", "1");

      let deleteAuthHeader: string | null = null;
      const authBridge = createAuthBridge({
        kv: storage.kv,
        sql: storage.sql,
        credentialHandler: {
          passkeySignIn: async () => ({}),
          passkeyRegister: async () => ({}),
          oidcStart: async () => ({ ticket: "t1", callbackUrl: "snapcards://auth/callback?ticket=t1", codeVerifier: "v1" }),
          appleSignIn: async () => ({
            identityToken: "apple.id.jwt",
            authorizationCode: "apple_code_1",
            userIdentifier: "001234.apple",
            email: "reader@privaterelay.appleid.com",
            fullName: "Ada Lovelace",
            session: {
              token: "session_jwt_apple_1",
              refreshToken: "rt_apple_1",
              userId: "user-apple-1",
              handle: "Ada Lovelace",
              isGuest: false,
            },
          }),
        },
        fetcher: async (input, init) => {
          const u = new URL(String(input));
          expect(u.pathname).toBe("/auth/account");
          expect(init?.method).toBe("DELETE");
          deleteAuthHeader = new Headers(init?.headers).get("Authorization");
          return new Response(JSON.stringify({ deleted: true }), { status: 200 });
        },
      });

      const appleRes = await authBridge.appleSignIn({ origin: "https://snapcards.fun" });
      expect("userIdentifier" in appleRes && appleRes.userIdentifier).toBe("001234.apple");
      expect(authBridge.loadSession()?.token).toBe("session_jwt_apple_1");

      const delRes = await authBridge.deleteAccount({ origin: "https://snapcards.fun" });
      expect(delRes.deleted).toBe(true);
      expect(deleteAuthHeader).toBe("Bearer session_jwt_apple_1");
      expect(authBridge.loadSession()).toBe(null);
      expect(storage.kv.keys().length).toBe(0);
      expect(storage.sql!.query("SELECT * FROM mecha_outbox").length).toBe(0);
      expect(storage.sql!.query("SELECT * FROM mecha_shape_row WHERE subject = 'user-apple-1'").length).toBe(0);
      // Public curated shape snapshot (`subject = ''`) remains intact for offline browsing!
      expect(storage.sql!.query("SELECT * FROM mecha_shape_row WHERE subject = ''").length).toBe(1);
    } finally {
      storage.close();
    }
  });

  it("adapts Phone (`390dp`) vs Tablet (`820dp` `88dp` rail + 2-col grid), `light-dark()` palettes, and Hebrew (`he`) RTL alignment", async () => {
    const projection = await projectAppNative(snapcardsDir, {
      origin: "https://snapcards.fun",
    });

    // `light-dark()` palette extraction from design.css
    expect(projection.palettes !== undefined).toBe(true);
    expect(projection.palettes!.light.neutral.toLowerCase()).toBe("#faf8f5");
    expect(projection.palettes!.dark.neutral.toLowerCase()).toBe("#0b0f17");
    expect(directionOfLocale("he")).toBe("rtl");
    expect(directionOfLocale("en")).toBe("ltr");

    const sampleTables = {
      localized_deck: [
        { id: "d1", name: "מערכת השמש", category: "מדע", cover_emoji: "🪐", count: 10, owner: "u1" },
        { id: "d2", name: "חיות האוקיינוס", category: "טבע", cover_emoji: "🐋", count: 5, owner: "u1" },
      ],
      card_set: [
        { id: "d1", name: "מערכת השמש", owner: "u1", cover_emoji: "🪐" },
        { id: "d2", name: "חיות האוקיינוס", owner: "u1", cover_emoji: "🐋" },
      ],
      deck_stats: [
        { deck_id: "d1", cover: "/img/solar.webp", favorite_count: 4 },
        { deck_id: "d2", cover: "/img/ocean.webp", favorite_count: 2 },
      ],
    };

    // Phone (< 768dp): vertical shell with 64dp 3-CTA bar + Avatar bottom sheet trigger, 1-col deck container
    const phoneSession = new HeadlessDivKitSession(projection, {
      origin: "https://snapcards.fun",
      initialScreen: "cards",
      viewportWidthDp: 390,
      themeMode: "light",
      locale: "en",
      tables: sampleTables,
    });
    const phoneCard = phoneSession.render();
    expect(phoneCard.card.variables.find((v) => v.name === "form_factor")?.value).toBe("phone");
    expect(phoneCard.card.variables.find((v) => v.name === "resolved_theme")?.value).toBe("light");
    expect(phoneCard.card.palette?.some((c) => c.name === "palette_neutral")).toBe(true);
    expect(phoneCard.card.palette?.some((c) => c.name === "palette_surface")).toBe(true);
    const phoneBars = collectNodesByPredicate(phoneCard.card.states[0].div, (n) => n.id === "omnishell_phone_nav_bar");
    expect(phoneBars.length).toBe(1);
    expect((phoneBars[0].height as Record<string, unknown>)?.value).toBe(64);
    const avatarTriggers = collectNodesByPredicate(phoneCard.card.states[0].div, (n) => n.id === "omnishell_avatar_sheet_trigger");
    expect(avatarTriggers.length).toBe(1);
    expect(findNodesOfType(phoneCard, "grid").length).toBe(0);

    // Switch runtime theme (`light` -> `dark`)
    const darkCard = phoneSession.dispatchAction("pronto://event/CHART_CLICK?id=theme-dark");
    expect(darkCard.card.variables.find((v) => v.name === "resolved_theme")?.value).toBe("dark");
    const darkPhoneShell = darkCard.card.states[0].div;
    expect(darkPhoneShell.background).toEqual([{ type: "solid", color: projection.palettes!.dark.neutral }]);

    // Tablet/iPad (>= 768dp) + Hebrew (`he`) RTL: 88dp navigation rail + 2-column `.deck-grid` + RTL layout mirroring
    const tabletHeCard = reconcileScreenToDivKit(projection.screens.cards.ir, {
      origin: "https://snapcards.fun",
      viewportWidthDp: 820,
      locale: "he",
      themeMode: "dark",
      palettes: projection.palettes,
      navEntries: projection.navEntries,
      tables: sampleTables,
    });
    expect(tabletHeCard.card.variables.find((v) => v.name === "form_factor")?.value).toBe("tablet");
    expect(tabletHeCard.card.variables.find((v) => v.name === "layout_direction")?.value).toBe("rtl");

    const navRails = collectNodesByPredicate(tabletHeCard.card.states[0].div, (n) => n.id === "omnishell_tablet_nav_rail");
    expect(navRails.length).toBe(1);
    expect((navRails[0].width as Record<string, unknown>)?.value).toBe(88);

    const grids = findNodesOfType(tabletHeCard, "grid");
    expect(grids.length).toBe(1);
    expect(grids[0].column_count).toBe(2);

    const rtlTexts = findNodesOfType(tabletHeCard, "text").filter((t) => t.text_alignment_horizontal !== undefined);
    expect(rtlTexts.some((t) => t.text_alignment_horizontal === "right")).toBe(true);

    // RTL flip-card on `explore` carries `direction: "rtl"` in custom_props
    const rtlExplore = reconcileScreenToDivKit(projection.screens.explore.ir, {
      origin: "https://snapcards.fun",
      locale: "he",
      palettes: projection.palettes,
      tables: sampleTables,
    });
    const rtlFlip = findNodesOfType(rtlExplore, "custom").find((n) => n.custom_type === "flip-card")!;
    expect((rtlFlip.custom_props as Record<string, unknown>).direction).toBe("rtl");
  });

  // Snapcards ships no native host (its Android app is a TWA of the web one),
  // so a native cold boot is realworld's, a test app that declares no package
  // of its own: the test names one.
  it("boots a native host 100% offline from pre-seeded `seed-cache.sql` + `derived.sql` with zero network requests and gates OTA `morph` / `restart` / `bridge-mismatch`", async () => {
    const realworldDir = new URL("../../../apps/realworld/", import.meta.url);
    const origin = "https://realworld.bonisoft3.com";
    const prontoDir = new URL("../../pronto/", import.meta.url);
    const { buildNativeApp } = await import(new URL("bundle/native.ts", prontoDir).href);
    const tmpAndroid = await Deno.makeTempDir({ prefix: "realworld-cold-android-" });
    await buildNativeApp({
      appDir: realworldDir.pathname,
      platform: "android",
      omnishellDir: new URL("../", import.meta.url).pathname,
      mechaDir: new URL("../../../libraries/mecha/", import.meta.url).pathname,
      outDir: tmpAndroid,
      domain: "realworld.bonisoft3.com",
      androidPackage: "com.bonisoft3.realworld",
    });
    const cacheSql = await Deno.readTextFile(`${tmpAndroid}/app/src/main/assets/seed-cache.sql`);
    const derivedSql = await Deno.readTextFile(`${tmpAndroid}/app/src/main/assets/derived.sql`);
    const signingMeta = JSON.parse(await Deno.readTextFile(`${tmpAndroid}/app/src/main/assets/manifest-signing.json`)) as {
      publicKeyBase64: string;
      nativeBridgeAddress: string;
    };
    const swSource = await Deno.readTextFile(new URL("../offline-first-sw.js", import.meta.url));

    const tmpDir = await Deno.makeTempDir({ prefix: "realworld-zero-net-" });
    const dbPath = `${tmpDir}/cold.sqlite`;
    let addressedNetworkCalls = 0;
    const g = globalThis as Record<string, unknown>;
    const prevFetch = globalThis.fetch;
    const prevStorage = g.__omnishellStorage;

    const storage = createSqliteStorageBridge(dbPath);
    try {
      // Seed SQLite on cold install BEFORE any runtime or network activity
      storage.sql!.exec(cacheSql);
      storage.sql!.exec(derivedSql);

      // Airplane mode: reject every network request so cold boot relies 100% on pre-seeded SQLite
      g.fetch = (() => Promise.reject(new TypeError("Airplane mode: network disabled"))) as typeof fetch;
      g.__omnishellStorage = storage;

      const sw = createHeadlessSwrRuntime({
        workerSource: swSource,
        origin,
        storage,
        networkFetch: (req) => {
          if (req.url.includes("_immutable-")) addressedNetworkCalls++;
          return Promise.reject(new TypeError("Airplane mode: network disabled"));
        },
      });

      // 1. Cold navigation to `/` hits `pronto-entries-v1` (stamped `<meta name="pronto-kept">`) in airplane mode.
      const entryRes = await sw.fetch(`${origin}/`, { mode: "navigate" });
      expect(entryRes.status).toBe(200);
      const entryHtml = await entryRes.text();
      expect(entryHtml.includes('<meta name="pronto-kept">')).toBe(true);
      await sw.flushBackground();

      // 2. Ed25519 signature verification passes against the pinned public key, and every screen's `.divkit.json` resolves from `pronto-addressed-v1` with 0 network calls.
      const verified = await verifyEntryManifestEd25519(entryHtml, signingMeta.publicKeyBase64);
      expect(verified.imports["/@native/bridge"]).toBe(signingMeta.nativeBridgeAddress);
      const projection = await projectAppNative(realworldDir, { origin });
      for (const name of Object.keys(projection.screens)) {
        const url = verified.imports[`/shell/screens/${name}.divkit.json`];
        expect(typeof url).toBe("string");
        const res = await sw.fetch(`${origin}${url}`);
        expect(res.status).toBe(200);
        expect(((await res.json()) as DivKitCard).card.log_id).toBe(`omnishell_${name}`);
      }
      expect(addressedNetworkCalls).toBe(0);

      // 4. Live OTA release planner: `morph` vs `restart` vs `bridge-mismatch` (`store_update`)
      const screenRefs: NativeScreenAssetRef[] = Object.keys(projection.screens).map((name) => ({
        html: `/shell/screens/${name}.html`,
        css: `/shell/screens/${name}.css`,
        divkit: `/shell/screens/${name}.divkit.json`,
      }));

      const first = Object.keys(projection.screens)[0];
      const morphNext = {
        ...verified.imports,
        [`/shell/screens/${first}.divkit.json`]: `/shell/screens/_immutable-9999-${first}.divkit.json`,
        "/messages/he.json": "/messages/_immutable-9999-he.json",
      };
      const morphPlan = planNativeRelease(verified.imports, morphNext, screenRefs);
      expect(morphPlan.kind).toBe("morph");
      if (morphPlan.kind === "morph") {
        expect(morphPlan.divkitScreens).toEqual([`/shell/screens/${first}.divkit.json`]);
        expect(morphPlan.catalogues).toEqual(["/messages/he.json"]);
      }

      const restartNext = {
        ...verified.imports,
        "/omnishell/interpreter/shell.js": "/omnishell/interpreter/_immutable-8888-shell.js",
      };
      expect(planNativeRelease(verified.imports, restartNext, screenRefs).kind).toBe("restart");

      const bridgeMismatchNext = {
        ...verified.imports,
        "/@native/bridge": "/_immutable-ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff-bridge",
      };
      const bridgePlan = planNativeRelease(verified.imports, bridgeMismatchNext, screenRefs);
      expect(bridgePlan.kind).toBe("bridge-mismatch");
    } finally {
      g.fetch = prevFetch;
      if (prevStorage === undefined) delete g.__omnishellStorage;
      else g.__omnishellStorage = prevStorage;
      storage.close();
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
      await Deno.remove(tmpAndroid, { recursive: true }).catch(() => {});
    }
  });
});
