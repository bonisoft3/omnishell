// Verifies Sprint 1 headless native runtime capabilities:
//   1. StorageBridge-backed 5-method CacheStorage (`open`, `keys`, `delete`, `match`, `put`) over SQLite
//   2. `offline-first-sw.js` executing unmodified in headless runtime (cold `pronto-kept` boot,
//      SWR hit + background revalidation, immutable addressed asset caching, stale cache pruning)
//   3. Ed25519 `#pronto-assets` manifest signing (`release-addresses.ts`) & verification + native OTA planning
//   4. `AuthBridge` (`passkeySignIn`, `passkeyRegister`, `oidcStart` PKCE S256, `loadSession`, `saveSession`, `clearSession`)

import * as path from "node:path";
import { describe, expect, it } from "@test/harness";
import {
  buildNativeOidcStartUrl,
  computePkceChallengeS256,
  createAuthBridge,
  createProvisionalOfflineGuestSession,
} from "../runtime/auth-bridge.ts";
import {
  createHeadlessSwrRuntime,
  createSqliteStorageBridge,
  createStorageCacheStorage,
  generateEd25519KeyPair,
  planNativeRelease,
  seedBundledRelease,
  verifyEntryManifestEd25519,
} from "../runtime/swr-cache.ts";
import { addressRelease } from "../server/release-addresses.ts";

const swSource = await Deno.readTextFile(new URL("../offline-first-sw.js", import.meta.url));
const ORIGIN = "https://snapcards.fun";

describe("StorageBridge-backed CacheStorage and headless offline-first-sw.js", () => {
  it("cold pronto-kept boot serves pre-seeded entry and immutable assets completely offline", async () => {
    const storage = createSqliteStorageBridge(":memory:");
    try {
      const bootAsset = `/shell/_immutable-${"b".repeat(64)}-boot.js`;
      const divkitAsset = `/shell/screens/_immutable-${"c".repeat(64)}-cards.divkit.json`;

      let networkCalls = 0;
      const runtime = createHeadlessSwrRuntime({
        workerSource: swSource,
        origin: ORIGIN,
        storage,
        networkFetch: () => {
          networkCalls++;
          return Promise.reject(new TypeError("Failed to fetch (offline cold boot)"));
        },
      });

      await seedBundledRelease(runtime.caches, ORIGIN, {
        entryPaths: ["/", "/mine"],
        entryHtml:
          `<!doctype html><html><head><title>Snapcards</title></head><body><main id="app">v1</main><script type="application/json" id="pronto-reads">{"stale":true}</script></body></html>`,
        addressedAssets: {
          [bootAsset]: { body: "export const boot = 1;" },
          [divkitAsset]: {
            body: '{"card":{"log_id":"omnishell_cards","states":[]}}',
            contentType: "application/json",
          },
        },
      });

      const entryRes = await runtime.fetch("/", { mode: "navigate" });
      const entryHtml = await entryRes.text();
      await runtime.flushBackground();

      expect(entryRes.status).toBe(200);
      expect(entryHtml.includes('<meta name="pronto-kept">')).toBe(true);
      expect(entryHtml.includes("pronto-reads")).toBe(false);
      expect(entryHtml.includes("v1")).toBe(true);

      const mineRes = await runtime.fetch("/mine", { mode: "navigate" });
      expect((await mineRes.text()).includes('<meta name="pronto-kept">')).toBe(true);

      // Immutable asset hit ignores query string and never hits network
      const jsRes = await runtime.fetch(`${bootAsset}?v=preload`);
      expect(await jsRes.text()).toBe("export const boot = 1;");
      const divRes = await runtime.fetch(divkitAsset);
      expect(await divRes.text()).toBe('{"card":{"log_id":"omnishell_cards","states":[]}}');
      expect(networkCalls).toBe(2); // Only background revalidations for `/` and `/mine` attempted network
    } finally {
      storage.close();
    }
  });

  it("serves SWR cached entry immediately, updates SQLite behind it, and survives engine reboot", async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "omnishell-swr-sqlite-" });
    const dbPath = path.join(tmpDir, "omnishell.sqlite");
    let currentServerHtml = `<!doctype html><html><head></head><body>release-1<script type="application/json" id="pronto-reads">{"r":1}</script></body></html>`;
    let serverStatus = 200;

    try {
      const storage1 = createSqliteStorageBridge(dbPath);
      const runtime1 = createHeadlessSwrRuntime({
        workerSource: swSource,
        origin: ORIGIN,
        storage: storage1,
        networkFetch: () =>
          Promise.resolve(
            new Response(currentServerHtml, {
              status: serverStatus,
              headers: { "Cache-Control": "public, no-cache" },
            }),
          ),
      });

      // First online visit populates `pronto-entries-v1`
      const first = await (await runtime1.fetch("/explore", { mode: "navigate" })).text();
      await runtime1.flushBackground();
      expect(first.includes("release-1")).toBe(true);

      // Deploy release-2 on server; next navigation returns kept release-1 immediately and updates cache in background
      currentServerHtml = `<!doctype html><html><head></head><body>release-2</body></html>`;
      const second = await (await runtime1.fetch("/explore", { mode: "navigate" })).text();
      expect(second).toBe(`<!doctype html><html><head><meta name="pronto-kept"></head><body>release-1</body></html>`);
      await runtime1.flushBackground();
      storage1.close();

      // Simulate process death & cold offline restart over the same SQLite file
      const storage2 = createSqliteStorageBridge(dbPath);
      const runtime2 = createHeadlessSwrRuntime({
        workerSource: swSource,
        origin: ORIGIN,
        storage: storage2,
        networkFetch: () => Promise.reject(new TypeError("Offline after restart")),
      });

      const third = await (await runtime2.fetch("/explore", { mode: "navigate" })).text();
      await runtime2.flushBackground();
      expect(third).toBe(`<!doctype html><html><head><meta name="pronto-kept"></head><body>release-2</body></html>`);
      storage2.close();
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  });

  it("caches addressed assets forever, prunes legacy caches on activate, and bypasses /electric & /auth", async () => {
    const storage = createSqliteStorageBridge(":memory:");
    try {
      const rawCaches = createStorageCacheStorage(storage, ORIGIN);
      const legacy = await rawCaches.open("workbox-precache-v2");
      await legacy.put(`${ORIGIN}/old.js`, new Response("stale"));
      await rawCaches.open("nuxt-sw-v1");

      let serverBody = "const handler = 'v1';";
      let serverStatus = 200;
      const bypassedPaths: string[] = [];

      const runtime = createHeadlessSwrRuntime({
        workerSource: swSource,
        origin: ORIGIN,
        storage,
        networkFetch: (req) => {
          const pathname = new URL(req.url).pathname;
          bypassedPaths.push(pathname);
          return Promise.resolve(
            new Response(serverBody, {
              status: serverStatus,
              headers: { "Cache-Control": "public, max-age=31536000, immutable" },
            }),
          );
        },
      });

      const address = `/shell/handlers/_immutable-${"d".repeat(64)}-create_set.js`;
      expect(await (await runtime.fetch(address)).text()).toBe("const handler = 'v1';");
      await runtime.flushBackground();

      // Subsequent fetches never hit network even if server changes
      serverBody = "mutated";
      expect(await (await runtime.fetch(address)).text()).toBe("const handler = 'v1';");
      expect(bypassedPaths).toEqual([address]);

      // Activate prunes legacy caches while preserving pronto-addressed-v1
      await runtime.activate();
      const remainingKeys = await runtime.caches.keys();
      expect(remainingKeys).toEqual(["pronto-addressed-v1"]);

      // Data-plane and auth endpoints bypass SW cache completely
      serverBody = '{"ok":true}';
      await runtime.fetch("/electric/v1/shapes?table=card_set");
      await runtime.fetch("/auth/refresh", { method: "POST" });
      expect(bypassedPaths.slice(1)).toEqual(["/electric/v1/shapes", "/auth/refresh"]);

      // Seed an entry and verify 404 on a missing immutable asset purges pronto-entries-v1
      const entries = await runtime.caches.open("pronto-entries-v1");
      await entries.put(`${ORIGIN}/`, new Response("<head><meta name=\"pronto-kept\"></head>"));
      serverStatus = 404;
      const missingAddr = `/shell/handlers/_immutable-${"e".repeat(64)}-missing.js`;
      const res404 = await runtime.fetch(missingAddr);
      expect(res404.status).toBe(404);
      await runtime.flushBackground();
      expect((await runtime.caches.keys()).includes("pronto-entries-v1")).toBe(false);
    } finally {
      storage.close();
    }
  });
});

describe("Ed25519 #pronto-assets verification and native OTA release planning", () => {
  it("signs #pronto-assets + /@native/bridge + .divkit.json in addressRelease and rejects tampering", async () => {
    const out = await Deno.makeTempDir({ prefix: "omnishell-signed-release-" });
    try {
      const kp = await generateEd25519KeyPair();
      const cfg = {
        routes: [
          {
            path: "/",
            screen: "cards",
            nav: { label: "Cards" },
            files: { html: "shell/screens/cards.html", css: "shell/screens/cards.css" },
          },
        ],
      };
      const treeFiles: Record<string, string> = {
        "shell/index.html":
          '<html><head><base href="/shell/"><link rel="stylesheet" href="./shell.css"></head><body><script type="module" src="./boot.js"></script></body></html>',
        "shell/boot.js": 'export const booted = true;',
        "shell/shell.css": "body {}",
        "shell/shell.json": JSON.stringify(cfg),
        "shell/screens/cards.html": '<section data-screen="cards">Cards</section>',
        "shell/screens/cards.css": ".screen {}",
        "shell/screens/cards.divkit.json": '{"card":{"log_id":"omnishell_cards","states":[]}}',
      };
      for (const [rel, content] of Object.entries(treeFiles)) {
        await Deno.mkdir(path.dirname(path.join(out, rel)), { recursive: true });
        await Deno.writeTextFile(path.join(out, rel), content);
      }

      const bridgeBytes = new TextEncoder().encode("omnishell-native-bridge-abi-v1");
      const release = await addressRelease(out, {
        nativeBridge: bridgeBytes,
        ed25519PrivateKey: kp.privateKeyPkcs8,
      });

      expect(release.imports["/@native/bridge"]?.endsWith("-bridge")).toBe(true);
      expect(release.imports["/shell/screens/cards.divkit.json"]?.endsWith("-cards.divkit.json")).toBe(true);
      expect(typeof release.signature).toBe("string");

      const entryHtml = await Deno.readTextFile(path.join(out, "shell/index.html"));
      const verified = await verifyEntryManifestEd25519(entryHtml, kp.publicKeyBase64);
      expect(verified.imports["/@native/bridge"]).toBe(release.imports["/@native/bridge"]);
      expect(verified.imports["/shell/screens/cards.divkit.json"]).toBe(
        release.imports["/shell/screens/cards.divkit.json"],
      );

      // Tampering a single character inside #pronto-assets fails Ed25519 verification loudly
      const tampered = entryHtml.replace("-cards.divkit.json", "-tampered.divkit.json");
      await expect(verifyEntryManifestEd25519(tampered, kp.publicKeyBase64)).rejects.toThrow(
        "Ed25519 signature verification failed",
      );

      // Wrong public key fails loudly
      const otherKp = await generateEd25519KeyPair();
      await expect(verifyEntryManifestEd25519(entryHtml, otherKp.publicKeyBase64)).rejects.toThrow(
        "Ed25519 signature verification failed",
      );
    } finally {
      await Deno.remove(out, { recursive: true });
    }
  });

  it("distinguishes in-place DivKit morph, isolate restart, and /@native/bridge store update", () => {
    const screens = [
      {
        html: "/screens/cards.html",
        css: "/shell/screens/cards.css",
        divkit: "/shell/screens/cards.divkit.json",
        handlers: ["/shell/handlers/create_set.js"],
      },
    ];
    const base = {
      "/@native/bridge": `/_immutable-${"1".repeat(64)}-bridge`,
      "/shell/boot.js": `/shell/_immutable-${"2".repeat(64)}-boot.js`,
      "/screens/cards.html": `/screens/_immutable-${"3".repeat(64)}-cards.html`,
      "/shell/screens/cards.css": `/shell/screens/_immutable-${"4".repeat(64)}-cards.css`,
      "/shell/screens/cards.divkit.json": `/shell/screens/_immutable-${"5".repeat(64)}-cards.divkit.json`,
      "/messages/pt.json": `/messages/_immutable-${"6".repeat(64)}-pt.json`,
      "/shell/handlers/create_set.js": `/shell/handlers/_immutable-${"7".repeat(64)}-create_set.js`,
    };

    expect(planNativeRelease(base, { ...base }, screens)).toEqual({ kind: "unchanged" });

    // DivKit JSON + message catalogue + existing handler -> morph in place
    const morphNext = {
      ...base,
      "/shell/screens/cards.divkit.json": `/shell/screens/_immutable-${"8".repeat(64)}-cards.divkit.json`,
      "/messages/pt.json": `/messages/_immutable-${"9".repeat(64)}-pt.json`,
      "/shell/handlers/create_set.js": `/shell/handlers/_immutable-${"a".repeat(64)}-create_set.js`,
    };
    expect(planNativeRelease(base, morphNext, screens)).toEqual({
      kind: "morph",
      screens: [],
      divkitScreens: ["/shell/screens/cards.divkit.json"],
      catalogues: ["/messages/pt.json"],
      handlers: ["/shell/handlers/create_set.js"],
    });

    // Shared runtime change with unchanged /@native/bridge -> isolate restart
    const restartNext = {
      ...base,
      "/shell/boot.js": `/shell/_immutable-${"b".repeat(64)}-boot.js`,
    };
    expect(planNativeRelease(base, restartNext, screens)).toEqual({ kind: "restart" });

    // /@native/bridge moved -> stay on cached release and prompt store binary update
    const bridgeNext = {
      ...base,
      "/@native/bridge": `/_immutable-${"f".repeat(64)}-bridge`,
    };
    expect(planNativeRelease(base, bridgeNext, screens)).toEqual({
      kind: "bridge-mismatch",
      currentBridge: base["/@native/bridge"],
      nextBridge: bridgeNext["/@native/bridge"],
    });
  });
});

describe("AuthBridge headless contract", () => {
  it("persists sessions, generates RFC 7636 PKCE S256 OIDC URLs, and promotes guest passkeys", async () => {
    const storage = createSqliteStorageBridge(":memory:");
    try {
      const provisional = createProvisionalOfflineGuestSession("guest-uuid-001");
      let capturedStartUrl = "";
      let capturedVerifier = "";

      const auth = createAuthBridge({
        kv: storage.kv,
        credentialHandler: {
          passkeySignIn: (opts) =>
            Promise.resolve({ id: "cred-1", rpId: opts.rpId, challenge: opts.challenge }),
          passkeyRegister: (opts) =>
            Promise.resolve({
              id: "cred-promoted",
              promotedUserId: opts.userId,
              promote: opts.promote ?? false,
            }),
          oidcStart: (_provider, startUrl, verifier) => {
            capturedStartUrl = startUrl;
            capturedVerifier = verifier;
            return Promise.resolve({
              ticket: "ticket_pkce_123",
              codeVerifier: verifier,
              callbackUrl: "snapcards://auth/callback?ticket=ticket_pkce_123",
              session: {
                token: "jwt_google_abc",
                refreshToken: "rt_rotating_001",
                userId: provisional.userId,
                handle: "learner@example.com",
                isGuest: false,
                expiresAtEpochS: 1_900_000_000,
              },
            });
          },
        },
      });

      expect(auth.loadSession()).toBe(null);
      auth.saveSession(provisional);
      expect(auth.loadSession()?.userId).toBe("guest-uuid-001");
      expect(auth.loadSession()?.isGuest).toBe(true);

      const regRes = await auth.passkeyRegister({
        rpId: "snapcards.fun",
        rpName: "Snapcards",
        challenge: "chal_reg",
        userId: provisional.userId,
        userName: "guest",
        promote: true,
        guestBearerToken: provisional.token,
      });
      expect(regRes.promotedUserId).toBe("guest-uuid-001");
      expect(regRes.promote).toBe(true);

      const signRes = await auth.passkeySignIn({
        rpId: "snapcards.fun",
        challenge: "chal_login",
      });
      expect(signRes.id).toBe("cred-1");

      const oidcRes = await auth.oidcStart("google", {
        origin: ORIGIN,
        guestBearerToken: provisional.token,
      });
      const expectedChallenge = await computePkceChallengeS256(capturedVerifier);
      expect(capturedStartUrl).toBe(
        buildNativeOidcStartUrl(ORIGIN, "google", expectedChallenge),
      );
      expect(capturedStartUrl.includes("return=native")).toBe(true);
      expect(oidcRes.ticket).toBe("ticket_pkce_123");

      // Session saved automatically upon OIDC completion, preserving adopted userId
      const promoted = auth.loadSession();
      expect(promoted?.token).toBe("jwt_google_abc");
      expect(promoted?.refreshToken).toBe("rt_rotating_001");
      expect(promoted?.userId).toBe("guest-uuid-001");
      expect(promoted?.isGuest).toBe(false);

      auth.clearSession();
      expect(auth.loadSession()).toBe(null);
    } finally {
      storage.close();
    }
  });
});
