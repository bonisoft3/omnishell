// The cage loads once per page, and a load that fails is not that once: the
// next module to ask loads it again, under a specifier of its own so a browser
// that kept the failed fetch for the first does not answer the retry with it.
// Its own file, because the first load that succeeds locks this process down.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { ensureSes, evaluateRole, retrySpecifier, sesAddress } from "../interpreter/jessie.js";

Deno.test("a failed SES load is dropped, and the next ask loads it again by a new specifier", async () => {
  const asked: string[] = [];
  const failing = (specifier: string) => {
    asked.push(specifier);
    return Promise.reject(new TypeError("Failed to fetch"));
  };
  await assertRejects(() => ensureSes(failing), TypeError, "Failed to fetch");
  await ensureSes((specifier: string) => {
    asked.push(specifier);
    return import(specifier);
  });
  assertEquals(asked.length, 2);
  assert(asked[0].endsWith("/vendor/ses.umd.min.js"), `the first load names the bundle as it is, got ${asked[0]}`);
  assertEquals(asked[1], `${asked[0]}?retry=1`);
  const handler = await evaluateRole("({ context }) => context.n + 1;\n", "handler") as (a: { context: { n: number } }) => number;
  assertEquals(handler({ context: { n: 1 } }), 2);
});

Deno.test("a retry names the address the import map resolves to, not the logical path", () => {
  const logical = "https://app.test/omnishell/interpreter/vendor/ses.umd.min.js";
  const pinned = `https://app.test/omnishell/interpreter/vendor/_immutable-${"a".repeat(64)}-ses.umd.min.js`;
  const map = (s: string) => (s === logical ? pinned : s);
  assertEquals(retrySpecifier(logical, 1, map), `${pinned}?retry=1`);
  assertEquals(retrySpecifier(logical, 2, map), `${pinned}?retry=2`);
  assertEquals(retrySpecifier(logical, 1, (s: string) => s), `${logical}?retry=1`);
});

Deno.test("the bundle's address is what the import map resolves its first load to", () => {
  const pinned = `https://app.test/omnishell/interpreter/vendor/_immutable-${"b".repeat(64)}-ses.umd.min.js`;
  assertEquals(sesAddress((s: string) => (s.endsWith("/vendor/ses.umd.min.js") ? pinned : s)), pinned);
  assert(sesAddress((s: string) => s).endsWith("/interpreter/vendor/ses.umd.min.js"), "unmapped, the bundle's own path");
});
