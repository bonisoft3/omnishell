// StorageBridge-backed CacheStorage, headless ServiceWorker host for offline-first-sw.js,
// Ed25519 #pronto-assets manifest verification, and native OTA release planning.

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { filesMoved } from "../interpreter/release-plan.js";
import type { StorageBridgeLike } from "./auth-bridge.ts";

export interface SwrMatchOptions {
  ignoreSearch?: boolean;
}

export interface SwrRequestLike {
  url: string;
  method: string;
  mode: string;
  cache: string;
  headers: Headers;
  body?: string | null;
}

export interface SwrCache {
  match(request: SwrRequestLike | Request | string, options?: SwrMatchOptions): Promise<Response | undefined>;
  put(request: SwrRequestLike | Request | string, response: Response): Promise<void>;
  delete(request: SwrRequestLike | Request | string, options?: SwrMatchOptions): Promise<boolean>;
  keys(): Promise<Request[]>;
}

export interface SwrCacheStorage {
  open(cacheName: string): Promise<SwrCache>;
  keys(): Promise<string[]>;
  delete(cacheName: string): Promise<boolean>;
  match(request: SwrRequestLike | Request | string, options?: SwrMatchOptions): Promise<Response | undefined>;
}

export interface NativeScreenAssetRef {
  html: string;
  css: string;
  divkit?: string;
  handlers?: string[];
}

export type NativeReleasePlan =
  | { kind: "unchanged" }
  | {
      kind: "morph";
      screens: string[];
      divkitScreens: string[];
      catalogues: string[];
      handlers: string[];
    }
  | { kind: "restart" }
  | { kind: "bridge-mismatch"; currentBridge: string; nextBridge: string };

const SERVED_READS_RE = /<script type="application\/json" id="pronto-reads">[\s\S]*?<\/script>/;
const HEAD_OPEN_RE = /<head\b[^>]*>/i;
const PRONTO_KEPT_RE = /<meta\b[^>]*\bname=["']pronto-kept["'][^>]*>/i;

function normalizeUrl(input: SwrRequestLike | Request | string, origin: string): URL {
  const raw = typeof input === "string" ? input : input.url;
  return new URL(raw, origin);
}

function serializeHeaders(headers: Headers): string {
  const obj: Record<string, string> = {};
  headers.forEach((value, key) => {
    obj[key] = value;
  });
  return JSON.stringify(obj);
}

export function createSqliteStorageBridge(dbPath = ":memory:"): StorageBridgeLike & { close(): void } {
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE IF NOT EXISTS omnishell_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);",
  );

  return {
    kv: {
      get(key: string): string | null {
        const row = db.prepare("SELECT v FROM omnishell_kv WHERE k = ?;").get(key) as
          | { v: string }
          | undefined;
        return row ? row.v : null;
      },
      set(key: string, value: string): void {
        db.prepare("INSERT OR REPLACE INTO omnishell_kv (k, v) VALUES (?, ?);").run(key, String(value));
      },
      delete(key: string): boolean {
        const res = db.prepare("DELETE FROM omnishell_kv WHERE k = ?;").run(key);
        return Number(res.changes) > 0;
      },
      clear(): void {
        db.exec("DELETE FROM omnishell_kv;");
      },
      keys(): string[] {
        const rows = db.prepare("SELECT k FROM omnishell_kv ORDER BY k ASC;").all() as Array<{ k: string }>;
        return rows.map((r) => r.k);
      },
    },
    sql: {
      exec(sql: string, params?: unknown[]): { rowsAffected: number; lastInsertRowId?: number } {
        if (!params || params.length === 0) {
          db.exec(sql);
          return { rowsAffected: 0 };
        }
        const stmt = db.prepare(sql);
        const res = stmt.run(...(params as SQLInputValue[]));
        return {
          rowsAffected: Number(res.changes),
          lastInsertRowId: Number(res.lastInsertRowid),
        };
      },
      query(sql: string, params?: unknown[]): Record<string, unknown>[] {
        const stmt = db.prepare(sql);
        const rows = params && params.length > 0
          ? stmt.all(...(params as SQLInputValue[]))
          : stmt.all();
        return rows.map((r) => ({ ...(r as Record<string, unknown>) }));
      },
    },
    close(): void {
      db.close();
    },
  };
}

export function createStorageCacheStorage(
  storage: StorageBridgeLike,
  origin: string,
): SwrCacheStorage {
  if (!storage?.sql) {
    throw new Error("createStorageCacheStorage requires a StorageBridge with sql support");
  }
  const cleanOrigin = origin.replace(/\/+$/, "");

  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS omnishell_cache_names (cache_name TEXT PRIMARY KEY);",
  );
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS omnishell_http_cache (" +
      "cache_name TEXT NOT NULL, " +
      "url TEXT NOT NULL, " +
      "pathname TEXT NOT NULL, " +
      "status INTEGER NOT NULL, " +
      "status_text TEXT NOT NULL, " +
      "headers_json TEXT NOT NULL, " +
      "body TEXT NOT NULL, " +
      "PRIMARY KEY (cache_name, url));",
  );
  storage.sql.exec(
    "CREATE INDEX IF NOT EXISTS idx_omnishell_http_cache_path ON omnishell_http_cache (cache_name, pathname);",
  );

  function openSync(cacheName: string): SwrCache {
    storage.sql.exec(
      "INSERT OR IGNORE INTO omnishell_cache_names (cache_name) VALUES (?);",
      [cacheName],
    );

    return {
      match(
        request: SwrRequestLike | Request | string,
        options?: SwrMatchOptions,
      ): Promise<Response | undefined> {
        const parsed = normalizeUrl(request, cleanOrigin);
        const rows = options?.ignoreSearch
          ? storage.sql.query(
              "SELECT status, status_text, headers_json, body FROM omnishell_http_cache WHERE cache_name = ? AND pathname = ? LIMIT 1;",
              [cacheName, parsed.pathname],
            )
          : storage.sql.query(
              "SELECT status, status_text, headers_json, body FROM omnishell_http_cache WHERE cache_name = ? AND url = ? LIMIT 1;",
              [cacheName, parsed.href],
            );
        if (!rows || rows.length === 0) return Promise.resolve(undefined);
        const row = rows[0];
        const headersObj = JSON.parse(String(row.headers_json || "{}")) as Record<string, string>;
        return Promise.resolve(
          new Response(String(row.body ?? ""), {
            status: Number(row.status),
            statusText: String(row.status_text ?? ""),
            headers: headersObj,
          }),
        );
      },

      async put(request: SwrRequestLike | Request | string, response: Response): Promise<void> {
        const parsed = normalizeUrl(request, cleanOrigin);
        const body = await response.clone().text();
        const headersJson = serializeHeaders(response.headers);
        storage.sql.exec(
          "INSERT OR IGNORE INTO omnishell_cache_names (cache_name) VALUES (?);",
          [cacheName],
        );
        storage.sql.exec(
          "INSERT OR REPLACE INTO omnishell_http_cache " +
            "(cache_name, url, pathname, status, status_text, headers_json, body) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?);",
          [
            cacheName,
            parsed.href,
            parsed.pathname,
            response.status,
            response.statusText || "",
            headersJson,
            body,
          ],
        );
      },

      delete(
        request: SwrRequestLike | Request | string,
        options?: SwrMatchOptions,
      ): Promise<boolean> {
        const parsed = normalizeUrl(request, cleanOrigin);
        const existing = options?.ignoreSearch
          ? storage.sql.query(
              "SELECT url FROM omnishell_http_cache WHERE cache_name = ? AND pathname = ? LIMIT 1;",
              [cacheName, parsed.pathname],
            )
          : storage.sql.query(
              "SELECT url FROM omnishell_http_cache WHERE cache_name = ? AND url = ? LIMIT 1;",
              [cacheName, parsed.href],
            );
        if (!existing || existing.length === 0) return Promise.resolve(false);
        if (options?.ignoreSearch) {
          storage.sql.exec(
            "DELETE FROM omnishell_http_cache WHERE cache_name = ? AND pathname = ?;",
            [cacheName, parsed.pathname],
          );
        } else {
          storage.sql.exec(
            "DELETE FROM omnishell_http_cache WHERE cache_name = ? AND url = ?;",
            [cacheName, parsed.href],
          );
        }
        return Promise.resolve(true);
      },

      keys(): Promise<Request[]> {
        const rows = storage.sql.query(
          "SELECT url FROM omnishell_http_cache WHERE cache_name = ? ORDER BY url ASC;",
          [cacheName],
        );
        return Promise.resolve(rows.map((r) => new Request(String(r.url))));
      },
    };
  }

  return {
    open(cacheName: string): Promise<SwrCache> {
      return Promise.resolve(openSync(cacheName));
    },

    keys(): Promise<string[]> {
      const rows = storage.sql.query(
        "SELECT cache_name FROM omnishell_cache_names " +
          "UNION SELECT DISTINCT cache_name FROM omnishell_http_cache " +
          "ORDER BY cache_name ASC;",
      );
      return Promise.resolve(rows.map((r) => String(r.cache_name)));
    },

    delete(cacheName: string): Promise<boolean> {
      const hasName = storage.sql.query(
        "SELECT cache_name FROM omnishell_cache_names WHERE cache_name = ? LIMIT 1;",
        [cacheName],
      );
      const hasRows = storage.sql.query(
        "SELECT cache_name FROM omnishell_http_cache WHERE cache_name = ? LIMIT 1;",
        [cacheName],
      );
      const existed = (hasName && hasName.length > 0) || (hasRows && hasRows.length > 0);
      storage.sql.exec("DELETE FROM omnishell_http_cache WHERE cache_name = ?;", [cacheName]);
      storage.sql.exec("DELETE FROM omnishell_cache_names WHERE cache_name = ?;", [cacheName]);
      return Promise.resolve(Boolean(existed));
    },

    async match(
      request: SwrRequestLike | Request | string,
      options?: SwrMatchOptions,
    ): Promise<Response | undefined> {
      const names = await this.keys();
      for (const name of names) {
        const cache = openSync(name);
        const hit = await cache.match(request, options);
        if (hit) return hit;
      }
      return undefined;
    },
  };
}

export function stampProntoKeptHtml(html: string): string {
  const withoutReads = html.replace(SERVED_READS_RE, "");
  if (PRONTO_KEPT_RE.test(withoutReads)) return withoutReads;
  if (HEAD_OPEN_RE.test(withoutReads)) {
    return withoutReads.replace(HEAD_OPEN_RE, (head) => `${head}<meta name="pronto-kept">`);
  }
  return `<head><meta name="pronto-kept"></head>${withoutReads}`;
}

export async function seedBundledRelease(
  caches: SwrCacheStorage,
  origin: string,
  bundle: {
    entryPaths?: string[];
    entryHtml: string;
    addressedAssets: Record<string, { body: string; contentType?: string }>;
  },
): Promise<void> {
  const cleanOrigin = origin.replace(/\/+$/, "");
  const entryCache = await caches.open("pronto-entries-v1");
  const stampedHtml = stampProntoKeptHtml(bundle.entryHtml);
  const paths = bundle.entryPaths && bundle.entryPaths.length > 0 ? bundle.entryPaths : ["/"];
  for (const p of paths) {
    const normalizedPath = p.startsWith("/") ? p : `/${p}`;
    await entryCache.put(
      `${cleanOrigin}${normalizedPath}`,
      new Response(stampedHtml, {
        status: 200,
        statusText: "OK",
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );
  }

  const addressedCache = await caches.open("pronto-addressed-v1");
  for (const [assetPath, asset] of Object.entries(bundle.addressedAssets)) {
    const normalizedPath = assetPath.startsWith("/") ? assetPath : `/${assetPath}`;
    await addressedCache.put(
      normalizedPath,
      new Response(asset.body, {
        status: 200,
        statusText: "OK",
        headers: {
          "Content-Type": asset.contentType || "application/javascript; charset=utf-8",
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      }),
    );
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function generateEd25519KeyPair(): Promise<{
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyRaw: Uint8Array;
  publicKeyBase64: string;
  privateKeyPkcs8: Uint8Array;
}> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const privPkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  return {
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    publicKeyRaw: pubRaw,
    publicKeyBase64: bytesToBase64(pubRaw),
    privateKeyPkcs8: privPkcs8,
  };
}

export async function signManifestPayloadEd25519(
  manifestJson: string,
  privateKey: CryptoKey | Uint8Array,
): Promise<string> {
  const key = privateKey instanceof Uint8Array
    ? await crypto.subtle.importKey("pkcs8", new Uint8Array(privateKey), { name: "Ed25519" }, false, ["sign"])
    : privateKey;
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    key,
    new TextEncoder().encode(manifestJson),
  );
  return bytesToBase64(new Uint8Array(sig));
}

export async function verifyManifestPayloadEd25519(
  manifestJson: string,
  signatureBase64: string,
  publicKey: CryptoKey | Uint8Array | string,
): Promise<boolean> {
  const key = typeof publicKey === "string"
    ? await crypto.subtle.importKey(
        "raw",
        new Uint8Array(base64ToBytes(publicKey)),
        { name: "Ed25519" },
        false,
        ["verify"],
      )
    : publicKey instanceof Uint8Array
      ? await crypto.subtle.importKey("raw", new Uint8Array(publicKey), { name: "Ed25519" }, false, ["verify"])
      : publicKey;
  const sigBytes = base64ToBytes(signatureBase64);
  if (sigBytes.length !== 64) return false;
  return await crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    new Uint8Array(sigBytes),
    new TextEncoder().encode(manifestJson),
  );
}

export async function verifyEntryManifestEd25519(
  entryHtml: string,
  publicKey: CryptoKey | Uint8Array | string,
): Promise<{ imports: Record<string, string>; screens: Record<string, string[]> }> {
  const scriptMatch = entryHtml.match(
    /<script\b([^>]*\bid=["']pronto-assets["'][^>]*)>([\s\S]*?)<\/script>/i,
  );
  if (!scriptMatch) {
    throw new Error("Entry document is missing #pronto-assets manifest");
  }
  const [, attrStr, rawPayload] = scriptMatch;
  const sigMatch = attrStr.match(/\bdata-signature=["']([^"']+)["']/i);
  if (!sigMatch || !sigMatch[1]) {
    throw new Error("#pronto-assets manifest is missing Ed25519 data-signature");
  }
  const valid = await verifyManifestPayloadEd25519(rawPayload, sigMatch[1], publicKey);
  if (!valid) {
    throw new Error("Ed25519 signature verification failed for #pronto-assets");
  }
  const parsed = JSON.parse(rawPayload) as {
    imports?: Record<string, string>;
    screens?: Record<string, string[]>;
  };
  if (!parsed || typeof parsed.imports !== "object" || parsed.imports === null) {
    throw new Error("Verified #pronto-assets manifest has no imports map");
  }
  return {
    imports: parsed.imports,
    screens: parsed.screens ?? {},
  };
}

const UNRUN_ASSET_RE = /\.(md|txt|xml|png|jpe?g|webp|gif|svg|ico)$/;

export function planNativeRelease(
  current: Record<string, string>,
  next: Record<string, string>,
  screens: NativeScreenAssetRef[],
): NativeReleasePlan {
  if (
    current["/@native/bridge"] !== undefined &&
    next["/@native/bridge"] !== undefined &&
    current["/@native/bridge"] !== next["/@native/bridge"]
  ) {
    return {
      kind: "bridge-mismatch",
      currentBridge: current["/@native/bridge"],
      nextBridge: next["/@native/bridge"],
    };
  }

  const differ = filesMoved(current, next);
  if (differ.length === 0) return { kind: "unchanged" };

  const changed = differ.filter(
    (name: string) => !name.startsWith("/docs/") && !UNRUN_ASSET_RE.test(name),
  );
  if (changed.length === 0) {
    return {
      kind: "morph",
      screens: [],
      divkitScreens: [],
      catalogues: [],
      handlers: [],
    };
  }

  const movedHtmlCss = screens.filter(
    (s) => changed.includes(s.html) || changed.includes(s.css),
  );
  const movedDivkit = screens.filter(
    (s) => s.divkit !== undefined && changed.includes(s.divkit),
  );
  const divkitByConvention = changed.filter((name: string) => name.endsWith(".divkit.json"));
  const catalogues = changed.filter((name: string) => name.startsWith("/messages/"));
  const handlers = [...new Set(screens.flatMap((s) => s.handlers ?? []))].filter(
    (name) => changed.includes(name) && current[name] !== undefined && next[name] !== undefined,
  );

  const taken = new Set<string>([
    ...movedHtmlCss.flatMap((s) => [s.html, s.css]),
    ...movedDivkit.map((s) => s.divkit!),
    ...divkitByConvention,
    ...catalogues,
    ...handlers,
  ]);

  if (changed.some((name: string) => !taken.has(name))) {
    return { kind: "restart" };
  }

  return {
    kind: "morph",
    screens: movedHtmlCss.map((s) => s.html),
    divkitScreens: [
      ...new Set([...movedDivkit.map((s) => s.divkit!), ...divkitByConvention]),
    ],
    catalogues,
    handlers,
  };
}

export interface HeadlessSwrFetchInit {
  method?: string;
  mode?: "navigate" | "cors" | "same-origin" | "no-cors";
  cache?: "default" | "no-store" | "reload" | "no-cache" | "force-cache" | "only-if-cached";
  headers?: HeadersInit;
  body?: string | null;
}

export interface HeadlessSwrRuntime {
  readonly caches: SwrCacheStorage;
  install(): Promise<void>;
  activate(): Promise<void>;
  fetch(input: string | URL | SwrRequestLike, init?: HeadlessSwrFetchInit): Promise<Response>;
  postMessage(data: unknown): Promise<void>;
  flushBackground(): Promise<PromiseSettledResult<unknown>[]>;
}

export function createHeadlessSwrRuntime(options: {
  workerSource: string;
  origin: string;
  storage: StorageBridgeLike;
  networkFetch: (request: SwrRequestLike) => Promise<Response>;
}): HeadlessSwrRuntime {
  const cleanOrigin = options.origin.replace(/\/+$/, "");
  const caches = createStorageCacheStorage(options.storage, cleanOrigin);
  const handlers: Record<string, Array<(event: unknown) => void>> = {};
  const backgroundTasks: Promise<unknown>[] = [];

  const selfScope = {
    location: { origin: cleanOrigin },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
    registration: {
      navigationPreload: {
        disable: () => Promise.resolve(),
      },
    },
    addEventListener(type: string, listener: (event: unknown) => void) {
      if (!handlers[type]) handlers[type] = [];
      handlers[type].push(listener);
    },
  };

  const workerFetch = async (input: SwrRequestLike | Request | string, init?: RequestInit): Promise<Response> => {
    if (typeof input === "string") {
      const resolved = new URL(input, cleanOrigin).href;
      return await options.networkFetch({
        url: resolved,
        method: init?.method?.toUpperCase() ?? "GET",
        mode: "cors",
        cache: (init?.cache as string) ?? "default",
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : null,
      });
    }
    if (input instanceof Request) {
      return await options.networkFetch({
        url: input.url,
        method: input.method,
        mode: input.mode || "cors",
        cache: input.cache || "default",
        headers: new Headers(input.headers),
        body: null,
      });
    }
    return await options.networkFetch(input);
  };

  const evaluateWorker = new Function("self", "caches", "fetch", "Response", "Headers", "URL", options.workerSource);
  evaluateWorker(selfScope, caches, workerFetch, Response, Headers, URL);

  function waitUntil(p: Promise<unknown> | undefined): void {
    if (p) backgroundTasks.push(Promise.resolve(p));
  }

  return {
    caches,

    async install(): Promise<void> {
      for (const fn of handlers.install ?? []) {
        fn({ waitUntil });
      }
      await Promise.all(backgroundTasks.splice(0));
    },

    async activate(): Promise<void> {
      for (const fn of handlers.activate ?? []) {
        fn({ waitUntil });
      }
      await Promise.all(backgroundTasks.splice(0));
    },

    async fetch(input: string | URL | SwrRequestLike, init?: HeadlessSwrFetchInit): Promise<Response> {
      const req: SwrRequestLike = typeof input === "string" || input instanceof URL
        ? {
            url: new URL(String(input), cleanOrigin).href,
            method: (init?.method ?? "GET").toUpperCase(),
            mode: init?.mode ?? "cors",
            cache: init?.cache ?? "default",
            headers: new Headers(init?.headers),
            body: init?.body ?? null,
          }
        : input;

      let responded: Promise<Response> | undefined;
      for (const fn of handlers.fetch ?? []) {
        fn({
          request: req,
          respondWith(promise: Promise<Response>) {
            responded = promise;
          },
          waitUntil,
        });
        if (responded) break;
      }

      if (responded) {
        return await responded;
      }
      return await options.networkFetch(req);
    },

    async postMessage(data: unknown): Promise<void> {
      for (const fn of handlers.message ?? []) {
        fn({ data, waitUntil });
      }
      await Promise.all(backgroundTasks.splice(0));
    },

    flushBackground(): Promise<PromiseSettledResult<unknown>[]> {
      return Promise.allSettled(backgroundTasks.splice(0));
    },
  };
}
