// The server terminal: a route's document rendered on request, with its rows.
//
//   DOOR=http://caddy:8080 ENTRY=<entry page> ORIGIN=https://app.example \
//     deno run --config server/deno.json --allow-net --allow-env --allow-read server/render.ts
//
// It reads the app as a reader does, through the door (DOOR, the cluster's
// proxy): the files the door serves, a guest it mints, and a store over the
// door's /electric, so every row it renders passed the shape gate a fresh
// guest's would. That is what makes a document cacheable by anyone: it holds
// nothing a stranger could not read, whoever asked for it.
//
// A document with request-only reads is rendered for each request. Others
// are held until a read that drew them changes. The store already knows when
// that is — it wakes a region when
// its read moves — so each read a render makes is listened to from the moment
// it is made, and the document is dropped on the first wake. A wake that comes
// before the document is held means it is answered and not held. Nothing
// guesses a lifetime. A 404 is not held: a row that does not exist yet will.
//
// The interpreter reads one ambient document, so documents are rendered one
// at a time, and a request for one already being rendered waits for that one.
//
// Its absolute links are spelled against the deployment's origin (ORIGIN),
// never the request's: the door answers any Host, and a document anyone may
// keep must not spell what a stranger asked for.

import { parseHTML } from "linkedom";
import { controlProperties } from "./linkedom-controls.ts";

type Store = {
  subscribe(table: string, fn: () => void, opts?: unknown): () => void;
  query(...args: unknown[]): Promise<unknown[]>;
};
type Route = { screen: string; path: string; states?: string[] };
type Found = { route: Route; params: Record<string, unknown>; locale?: string; written?: string };
type Drawn = { html: string; gone: boolean };
/** One render's listening: what it heard, and how to stop hearing. */
type Ticket = { stale: boolean; cacheable: boolean; stops: (() => void)[]; key?: string };

export type Renderer = {
  handle(req: Request): Promise<Response>;
  /** How many documents are held. */
  readonly held: number;
};

export async function warmEagerTables(store: Pick<Store, "query">, cfg: {
  tables: string[];
  schema?: Record<string, { durability?: string }>;
  sync?: Record<string, string>;
}): Promise<void> {
  await Promise.all(cfg.tables
    .filter(t => cfg.schema?.[t]?.durability !== "server" && cfg.sync?.[t] !== "on-demand")
    .map(t => store.query(t, null, {})));
}

/** The deployment's origin as ORIGIN states it, or the renderer's end: a
 * guess would be written into every document anyone may keep. */
export function admittedOrigin(value: string | undefined): string {
  if (value === undefined) throw new Error("ORIGIN names no origin: set it to the scheme and host readers reach the door at, as https://app.example");
  const url = URL.parse(value);
  if (url === null || !/^https?:$/.test(url.protocol) || url.origin !== value) {
    throw new Error(`ORIGIN ${value} is not an origin: set it to the scheme and host readers reach the door at, as https://app.example`);
  }
  return value;
}

const etagOf = async (html: string) => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(html)));
  return `"${Array.from(digest.slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("")}"`;
};

/** What a screen reads of a query once one of its renders walked its params
 * whole: every key. */
const ALL = Symbol("all");

/**
 * The renderer over a store and an app. `render` draws one route's document
 * at an address; it is injected so the cache, the eviction and the answer can
 * be held to their contract without a cluster. `queue` bounds the renders
 * waiting their turn: past it a request is answered 503 rather than made to
 * wait behind every address anyone has asked for.
 */
export function createRenderer({
  store,
  origin,
  route,
  render,
  capacity,
  queue,
  cacheableRead = () => true,
}: {
  store: Store;
  /** What every document's absolute links are spelled against. */
  origin: string;
  /** What an address says, or null where it names no screen. */
  route: (pathname: string, search: string) => Found | null;
  render: (found: Found, store: Store, base: URL) => Promise<{ html: string; gone: boolean }>;
  capacity: number;
  queue: number;
  /** Whether changes to this read can invalidate a retained document. */
  cacheableRead?: (table: string) => boolean;
}): Renderer {
  // The render in progress. Each read it makes is listened to at once, beside
  // the region that made it and on the same view: a change landing anywhere
  // between that read and the document's last request is heard, where a
  // listener opened once the render is over would hear only what came after.
  let current: Ticket | null = null;
  const watched: Store = new Proxy(store, {
    get(target, name, receiver) {
      if (name === "query") return (table: string, ...args: unknown[]) => {
        if (current === null) throw new Error(`a read of ${table} outside any render`);
        current.cacheable &&= cacheableRead(table);
        return target.query(table, ...args);
      };
      if (name !== "subscribe") return Reflect.get(target, name, receiver);
      return (table: string, fn: () => void, opts?: unknown) => {
        const ticket = current;
        if (ticket === null) throw new Error(`a read of ${table} outside any render`);
        if (!cacheableRead(table)) ticket.cacheable = false;
        else {
          ticket.stops.push(target.subscribe(table, () => {
            ticket.stale = true;
            if (ticket.key !== undefined && held.get(ticket.key)?.ticket === ticket) drop(ticket.key);
          }, opts));
        }
        return target.subscribe(table, fn, opts);
      };
    },
  });
  // Insertion-ordered, so the first key is the one used longest ago.
  const held = new Map<string, Drawn & { ticket: Ticket }>();
  const stopAll = (ticket: Ticket) => {
    for (const stop of ticket.stops.splice(0)) stop();
  };
  const drop = (key: string) => {
    const entry = held.get(key);
    if (entry === undefined) return;
    held.delete(key);
    stopAll(entry.ticket);
  };
  const drawing = new Map<string, Promise<Drawn>>();
  let turn: Promise<unknown> = Promise.resolve();
  const serially = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = turn.then(fn);
    turn = next.catch(() => {});
    return next;
  };

  // A document depends on its path and on the query keys its screen reads, so
  // those are its address; any other key rides along without making another
  // document. Which keys a screen reads is learnt from its renders, and until
  // one has run every key counts.
  const reads = new Map<string, Set<string> | typeof ALL>();
  const addressOf = (url: URL, screen: string) => {
    const known = reads.get(screen);
    const kept = [...new URLSearchParams(url.search)]
      .filter(([k]) => k === "lang" || known === undefined || known === ALL || known.has(k))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const query = new URLSearchParams(kept).toString();
    return new URL(`${url.pathname}${query === "" ? "" : `?${query}`}`, origin);
  };
  const noting = (found: Found) => {
    const asked = new Set<string>();
    let whole = false;
    const params = new Proxy(found.params, {
      has: (t, k) => (typeof k === "string" && asked.add(k), Reflect.has(t, k)),
      get: (t, k, r) => (typeof k === "string" && asked.add(k), Reflect.get(t, k, r)),
      ownKeys: (t) => ((whole = true), Reflect.ownKeys(t)),
    });
    // A key the screen asked for is a query key unless the path supplied it,
    // so one the address lacked is noted too: the next address may carry it.
    const note = (screen: string, url: URL) => {
      const before = reads.get(screen) ?? new Set<string>();
      if (before === ALL || whole) return reads.set(screen, ALL);
      const query = new URLSearchParams(url.search);
      for (const k of asked) if (query.has(k) || !Object.hasOwn(found.params, k)) before.add(k);
      reads.set(screen, before);
    };
    return { found: { ...found, params }, note };
  };

  const draw = (found: Found, base: URL, url: URL): Promise<Drawn> =>
    serially(async () => {
      const ticket: Ticket = { stale: false, cacheable: true, stops: [] };
      const { found: asked, note } = noting(found);
      current = ticket;
      let html: string, gone: boolean;
      try {
        ({ html, gone } = await render(asked, watched, base));
      } catch (err) {
        stopAll(ticket);
        throw err;
      } finally {
        current = null;
      }
      note(found.route.screen, url);
      const key = addressOf(url, found.route.screen).href;
      // A document a read moved under, or one drawn for an address its screen
      // turned out not to read all of, is answered once and not held.
      if (gone || !ticket.cacheable || ticket.stale || key !== base.href) {
        stopAll(ticket);
        return { html, gone };
      }
      drop(key);
      ticket.key = key;
      held.set(key, { html, gone, ticket });
      while (held.size > capacity) drop(held.keys().next().value!);
      return { html, gone };
    });

  const answer = async ({ html, gone }: Drawn, req: Request) => {
    const etag = await etagOf(html);
    const headers = new Headers({
      "Content-Type": "text/html; charset=utf-8",
      // Anyone may keep it, nobody may serve it unasked: the next change to
      // a read that drew it is not a time anyone downstream can know.
      "Cache-Control": "public, no-cache",
      ETag: etag,
    });
    if (gone) return new Response(html, { status: 404, headers });
    if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    return new Response(html, { status: 200, headers });
  };

  return {
    get held() {
      return held.size;
    },
    async handle(req) {
      const url = new URL(req.url);
      const found = route(url.pathname, url.search);
      if (found === null) return new Response("no such address\n", { status: 404 });
      const base = addressOf(url, found.route.screen);
      const key = base.href;
      const hit = held.get(key);
      if (hit !== undefined) {
        held.delete(key);
        held.set(key, hit);
        return answer(hit, req);
      }
      let pending = drawing.get(key);
      if (pending === undefined) {
        if (drawing.size >= queue) {
          return new Response("too many documents waiting to be rendered\n", { status: 503, headers: { "Retry-After": "1" } });
        }
        pending = draw(found, base, url).finally(() => drawing.delete(key));
        drawing.set(key, pending);
      }
      return answer(await pending, req);
    },
  };
}

/**
 * A guest kept for as long as the process runs: minted now, and again once
 * half its token's life is gone, so the store's next shape mint carries one
 * the gate accepts. A mint that fails is the renderer's end: a store holding a
 * refused token stops syncing and says nothing, and its documents would stand
 * frozen behind a healthy /health.
 */
export async function keepGuest(
  mint: () => Promise<{ token: string }>,
  keep: (guest: { token: string }) => void,
  die: (err: unknown) => void,
  later: (fn: () => void, ms: number) => unknown = setTimeout,
): Promise<void> {
  const renew = async () => {
    const guest = await mint();
    const exp = JSON.parse(atob(guest.token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).exp;
    if (typeof exp !== "number") throw new Error("the guest's token states no expiry");
    keep(guest);
    later(() => renew().catch(die), Math.max(0, (exp * 1000 - Date.now()) / 2));
  };
  await renew();
}

const parse = (html: string) => (parseHTML(html) as unknown as { document: unknown }).document;

/**
 * The world the interpreter expects, installed on this realm: a screen reads
 * its clock knobs off location at module evaluation, and its stylesheet and
 * markup by URL against the door. Its location is the door's root, and a
 * reload: a page reloads when the door refuses its token, to be gated again
 * (data-sync.js); a renderer has no gate, and its store reads nothing more
 * past the refusal, so its reload is its end, and whatever runs it starts it
 * again with a guest minted afresh.
 */
export function inhabit(door: string, die: (err: unknown) => void): void {
  const global = globalThis as unknown as Record<string, unknown>;
  global.location = Object.assign(new URL(`${door}/`), {
    reload: () => die(new Error(`the door at ${door} refused the renderer's token`)),
  });
  global.document = parse("<!doctype html><html><head></head><body></body></html>");
  // A bound select or checkbox is drawn through the control's property, which
  // linkedom's lacks.
  controlProperties(global.document);
  (global as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };
  global.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
}

if (import.meta.main) await serve().catch((err) => {
  // The realm is sealed by then, and a sealed realm reports an unhandled
  // rejection and exits 0: a renderer that could not start must say so in its
  // exit code, or nothing restarts it.
  console.error(err);
  Deno.exit(1);
});

export async function serve(env: (name: string) => string | undefined = (name) => Deno.env.get(name)) {
  const door = env("DOOR");
  if (door === undefined) throw new Error("DOOR names no door: the renderer reads the app through the cluster's proxy");
  const origin = admittedOrigin(env("ORIGIN"));
  const capacity = Number(env("RENDER_CAPACITY") ?? "512");
  const queue = Number(env("RENDER_QUEUE") ?? "64");
  const port = Number(env("PORT") ?? "8090");

  // Whatever ends the renderer says why, and exits so whatever runs it can
  // start it again.
  const die = (err: unknown) => {
    console.error(err);
    Deno.exit(1);
  };
  inhabit(door, die);

  const read = async (path: string) => {
    const res = await fetch(`${door}${path}`);
    if (!res.ok) throw new Error(`${res.status} reading ${path} through ${door}`);
    return res;
  };
  // The Jessie tier's realm is sealed before anything else loads, as the
  // terminal's own harness seals it: a renderer evaluates app handlers too.
  await import("../interpreter/vendor/ses.umd.min.js");
  const { ensureSes } = await import("../interpreter/jessie.js");
  await ensureSes();
  const { renderDocument } = await import("../interpreter/document.js");
  const { routeAt } = await import("../interpreter/shell.js");
  const { createStore } = await import("../interpreter/data-sync.js");
  const { compileCatalog } = await import("../interpreter/vendor/messages.js");
  const { templateHash } = await import("../interpreter/screen.js");

  const cfg = await (await read("/shell/shell.json")).json();
  // The entry is the one file read off the image rather than through the
  // door: the door answers its own address with a redirect to the app's root,
  // which is a document already rendered.
  const entryPath = Deno.env.get("ENTRY");
  if (entryPath === undefined) throw new Error("ENTRY names no entry page to render documents from");
  const entry = await Deno.readTextFile(entryPath);
  const messages: Record<string, unknown> = {};
  const words: Record<string, string> = {};
  for (const tag of Object.keys(cfg.i18n?.locales ?? {})) {
    const text = await (await read(`/messages/${tag}.json`)).text();
    messages[tag] = compileCatalog(JSON.parse(text));
    words[tag] = templateHash(text);
  }
  // A guest is who a document is rendered for, minted the way a reader's tab
  // mints one. Its token is the store's, through sessionStorage as in a tab.
  await keepGuest(
    async () => {
      const minted = await fetch(`${door}/auth/guest`, { method: "POST" });
      if (!minted.ok) throw new Error(`${minted.status} minting a guest through ${door}: ${await minted.text()}`);
      return await minted.json();
    },
    (guest) => sessionStorage.setItem("pronto-token", JSON.stringify(guest)),
    die,
  );
  const appBase = new URL(`${door}/`);
  const store = createStore(door, { ...cfg, appBase });
  const cacheableRead = (table: string) => cfg.schema?.[table]?.durability !== "server";

  const renderer = createRenderer({
    store,
    origin,
    capacity,
    queue,
    cacheableRead,
    // The door has already chosen the language: an unprefixed address reaching
    // here is the default's, so no preference is consulted.
    route: (pathname, search) => routeAt(cfg, pathname, search, []) as Found | null,
    async render(found, watched, base) {
      const { html, handle, gone } = await renderDocument({
        entry,
        parse,
        cfg,
        appBase,
        route: found.route,
        params: found.params,
        locale: found.locale,
        written: found.written,
        store: watched,
        messages,
        words,
        rows: true,
        origin: base.origin,
        here: base.pathname,
      });
      handle.stop();
      return { html, gone };
    },
  });

  let ready = false;
  Deno.serve({ port, hostname: "0.0.0.0", onListen: () => {} }, (req) => {
    if (new URL(req.url).pathname === "/health") {
      return new Response(ready ? "ok\n" : "syncing\n", { status: ready ? 200 : 503 });
    }
    return renderer.handle(req);
  });
  // Each retained document's subscriptions hold its on-demand views.
  await warmEagerTables(store, cfg);
  ready = true;
}
