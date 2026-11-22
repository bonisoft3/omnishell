// A first visit fetches before the worker it registers controls the page, so
// what it fetched then is fetched again when control arrives, once.
import { assertEquals } from "jsr:@std/assert@1";
import { refetchOnControl } from "../interpreter/data-sync.js";

const container = (controller: unknown) => Object.assign(new EventTarget(), { controller });
const settle = () => new Promise((r) => setTimeout(r, 0));

Deno.test("an uncontrolled page fetches its sources again when a worker takes control, once", async () => {
  const sw = container(null);
  const fetched: string[] = [];
  refetchOnControl(sw, ["https://app.test/a.js", "https://app.test/b.js"], (url: string) => {
    fetched.push(url);
    return Promise.reject(new TypeError("Failed to fetch"));
  });
  await settle();
  assertEquals(fetched, []);
  sw.dispatchEvent(new Event("controllerchange"));
  await settle();
  assertEquals(fetched, ["https://app.test/a.js", "https://app.test/b.js"]);
  sw.dispatchEvent(new Event("controllerchange"));
  await settle();
  assertEquals(fetched.length, 2);
});

Deno.test("a controlled page, a page with no workers, or no sources wait for nothing", async () => {
  const fetched: string[] = [];
  const fetcher = (url: string) => (fetched.push(url), Promise.resolve(new Response("")));
  const controlled = container({});
  refetchOnControl(controlled, ["https://app.test/a.js"], fetcher);
  refetchOnControl(undefined, ["https://app.test/a.js"], fetcher);
  const empty = container(null);
  refetchOnControl(empty, [], fetcher);
  controlled.dispatchEvent(new Event("controllerchange"));
  empty.dispatchEvent(new Event("controllerchange"));
  await settle();
  assertEquals(fetched, []);
});

Deno.test("a store that stops waiting fetches nothing when control arrives", async () => {
  const sw = container(null);
  const fetched: string[] = [];
  const stop = refetchOnControl(sw, ["https://app.test/a.js"], (url: string) => (fetched.push(url), Promise.resolve(new Response(""))));
  stop();
  sw.dispatchEvent(new Event("controllerchange"));
  await settle();
  assertEquals(fetched, []);
});
