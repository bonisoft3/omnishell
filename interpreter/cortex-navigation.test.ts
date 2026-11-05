import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { createCortexNavigation } from "./cortex-navigation.js";

const screen = () => ({ initial: "loading", states: {
  loading: { invoke: { src: "navigation", onDone: "ready", onError: "failed" } }, ready: {}, failed: {},
} });
const definition = () => ({ config: { initial: "idle", states: { idle: {}, home: screen(), article: screen() }, on: {
  "route:home": { target: ".home", reenter: true }, "route:article": { target: ".article", reenter: true },
} }, actors: { navigation: { via: "navigation" } } });
const request = (screen: string) => ({ screen, navigationType: "push", path: `/${screen}` });
function controlled() {
  const calls: Array<{ request: any; signal: AbortSignal; resolve: (value?: any) => void; reject: (error: any) => void }> = [];
  const activate = (request: any, { signal }: { signal: AbortSignal }) => new Promise((resolve, reject) => calls.push({ request, signal, resolve, reject }));
  return { calls, activate };
}

Deno.test("deep link and repeated route invoke loading each time", async () => {
  const sink = controlled();
  const nav = createCortexNavigation(definition(), sink.activate);
  const first = nav.navigate(request("article"));
  assertEquals(nav.snapshot().value, { article: "loading" });
  assertEquals(sink.calls[0].request, { ...request("article"), token: 1 });
  sink.calls[0].resolve("first");
  assertEquals(await first, "first");
  assertEquals(nav.snapshot().value, { article: "ready" });
  const second = nav.navigate(request("article"));
  assertEquals(sink.calls.length, 2);
  sink.calls[1].resolve("second");
  assertEquals(await second, "second");
  nav.stop();
});

for (const late of ["resolve", "reject"] as const) Deno.test(`superseded navigation ignores late ${late}`, async () => {
  const sink = controlled();
  const nav = createCortexNavigation(definition(), sink.activate);
  const old = nav.navigate(request("home"));
  const next = nav.navigate(request("article"));
  assertEquals(sink.calls[0].signal.aborted, true);
  assertEquals(await old, undefined);
  sink.calls[1].resolve("new");
  assertEquals(await next, "new");
  sink.calls[0][late](new Error("late"));
  await Promise.resolve();
  assertEquals(nav.snapshot().value, { article: "ready" });
  nav.stop();
});

Deno.test("a newer route supersedes a failing request without restoring its old state", async () => {
  const sink = controlled();
  const nav = createCortexNavigation(withRows(), sink.activate, () => () => {});
  try {
    const first = nav.navigate(request("home"));
    sink.calls[0].resolve();
    await first;
    const failing = nav.navigate(request("article"));
    sink.calls[1].reject(new Error("failed"));
    const winning = nav.navigate(request("home"));
    assertEquals(await failing, undefined);
    sink.calls[2].resolve("winner");
    assertEquals(await winning, "winner");
    assertEquals(nav.snapshot().value, { home: "ready" });
  } finally { nav.stop(); }
});

Deno.test("stop cancels pending navigation", async () => {
  const sink = controlled();
  const nav = createCortexNavigation(definition(), sink.activate);
  const pending = nav.navigate(request("home"));
  nav.stop();
  assertEquals(sink.calls[0].signal.aborted, true);
  assertEquals(await pending, undefined);
  sink.calls[0].resolve();
  await assertRejects(() => nav.navigate(request("home")), Error, "stopped");
});

Deno.test("failure transitions to failed and a later route recovers", async () => {
  const sink = controlled();
  const nav = createCortexNavigation(definition(), sink.activate);
  const pending = nav.navigate(request("home"));
  const failure = new Error("sink failed");
  sink.calls[0].reject(failure);
  await assertRejects(() => pending, Error, "sink failed");
  assertEquals(nav.snapshot().value, { home: "failed" });
  const retry = nav.navigate(request("home"));
  sink.calls[1].resolve();
  await retry;
  assertEquals(nav.snapshot().value, { home: "ready" });
  await assertRejects(() => nav.navigate(request("unknown")), Error, "Unhandled");
  nav.stop();
});

Deno.test("invalid invocation and actor configurations fail immediately", () => {
  const invalid = definition();
  (invalid.config.states.home.states.loading.invoke as any).input = {};
  assertThrows(() => createCortexNavigation(invalid, async () => {}), Error, "Invalid navigation invocation");
  assertThrows(() => createCortexNavigation({ ...definition(), actors: { navigation: { via: "other" } } }, async () => {}), Error, "Invalid navigation actor");
});

Deno.test("route events can target arbitrarily named nested navigation states", async () => {
  const sink = controlled();
  const nav = createCortexNavigation({ config: {
    initial: "idle", on: { "route:cards": { target: ".page", reenter: true } },
    states: { idle: {}, page: { initial: "awaiting", states: {
      awaiting: { invoke: { src: "navigation", onDone: "shown", onError: "broken" } }, shown: {}, broken: {},
    } } },
  }, actors: { navigation: { via: "navigation" } } }, sink.activate);
  const first = nav.navigate(request("cards"));
  assertEquals(nav.snapshot().value, { page: "awaiting" });
  sink.calls[0].resolve();
  await first;
  assertEquals(nav.snapshot().value, { page: "shown" });
  const failed = nav.navigate(request("cards"));
  sink.calls[1].reject(new Error("broken"));
  await assertRejects(() => failed, Error, "broken");
  assertEquals(nav.snapshot().value, { page: "shown" });
  nav.stop();
});

Deno.test("initial invocation and routes without an invocation fail loudly", async () => {
  const invalid = definition();
  invalid.config.initial = "home";
  assertThrows(() => createCortexNavigation(invalid, async () => {}), Error, "requires a route request");
  const noInvoke = definition();
  (noInvoke.config.on["route:home"] as any).target = ".idle";
  const nav = createCortexNavigation(noInvoke, async () => {});
  await assertRejects(() => nav.navigate(request("home")), Error, "did not invoke navigation");
  nav.stop();
});

Deno.test("parallel and nested invocations cannot start competing sinks", () => {
  const invalid = definition();
  (invalid.config.states.home as any).type = "parallel";
  assertThrows(() => createCortexNavigation(invalid, async () => {}), Error, "Parallel");
  const nested = definition();
  (nested.config.states.home as any).invoke = { src: "navigation", onDone: "ready", onError: "failed" };
  assertThrows(() => createCortexNavigation(nested, async () => {}), Error, "Nested");
});

for (const key of ["guard", "actions"]) {
  for (const location of ["always", "after", "on", "onDone"]) {
    Deno.test(`${location} cannot silently omit an unsupported ${key}`, () => {
      const invalid = definition();
      const ready = invalid.config.states.home.states.ready as any;
      const candidates = [{ target: "failed", [key]: "commit" }, "failed"];
      ready[location] = location === "after" ? { 0: candidates } : location === "on" ? { custom: candidates } : candidates;
      assertThrows(() => createCortexNavigation(invalid, async () => {}), Error, `Unsupported navigation ${key}`);
    });
  }
  Deno.test(`root transitions cannot silently omit an unsupported ${key}`, () => {
    const invalid = definition();
    (invalid.config.on as any).custom = { target: ".home", [key]: "commit" };
    assertThrows(() => createCortexNavigation(invalid, async () => {}), Error, `Unsupported navigation ${key}`);
  });
}

for (const key of ["entry", "exit"]) Deno.test(`${key} implementations are refused before starting the actor`, () => {
  const invalid = definition();
  (invalid.config.states.home.states.ready as any)[key] = "commit";
  assertThrows(() => createCortexNavigation(invalid, async () => {}), Error, `Unsupported navigation ${key}`);
});

Deno.test("named delays require an implementation and cannot become immediate transitions", () => {
  const invalid = definition();
  (invalid.config.states.home.states.ready as any).after = { timeout: "failed" };
  assertThrows(() => createCortexNavigation(invalid, async () => {}), Error, "Unsupported navigation delay timeout");
});

Deno.test("passive event, automatic, completion and numeric delayed transitions remain supported", async () => {
  const configured = definition();
  (configured.config.on as any).custom = {};
  const states = configured.config.states.home.states as any;
  states.ready = { always: [{ target: "settled" }] };
  states.settled = { initial: "waiting", onDone: "expired", states: {
    waiting: { after: { 0: "finished" }, on: { ignored: {} } }, finished: { type: "final" },
  } };
  states.expired = {};
  const nav = createCortexNavigation(configured, async () => "mounted");
  try {
    assertEquals(await nav.navigate(request("home")), "mounted");
    assertEquals(nav.snapshot().value, { home: { settled: "waiting" } });
    await new Promise(resolve => setTimeout(resolve, 0));
    assertEquals(nav.snapshot().value, { home: "expired" });
  } finally {
    nav.stop();
  }
});

function withRows() {
  const configured: any = definition();
  configured.actors.rootRows = { via: "rows", screen: "home", lifetime: "attachment" };
  configured.actors.homeRows = { via: "rows", screen: "home", lifetime: "attachment" };
  configured.actors.otherRows = { via: "rows", screen: "article", lifetime: "attachment" };
  configured.config.invoke = [{ src: "rootRows", id: "root-lease" }];
  configured.config.states.home.invoke = [{ src: "homeRows", id: "home-lease" }];
  configured.config.states.article.invoke = [{ src: "otherRows", id: "other-lease" }];
  return configured;
}

Deno.test("row attachment actors follow their owning states and root stop", async () => {
  const calls: string[] = [];
  const sink = controlled();
  const nav = createCortexNavigation(withRows(), sink.activate, (binding: any, spec: any) => {
    calls.push(`start:${spec.id}:${binding.screen}`);
    return () => calls.push(`stop:${spec.id}`);
  });
  assertEquals(calls, ["start:root-lease:home"]);
  let pending = nav.navigate(request("home"));
  assertEquals(calls, ["start:root-lease:home", "stop:root-lease", "start:root-lease:home", "start:home-lease:home"]);
  sink.calls[0].resolve(); await pending;
  pending = nav.navigate(request("home"));
  assertEquals(calls.slice(-4), ["stop:home-lease", "stop:root-lease", "start:root-lease:home", "start:home-lease:home"]);
  sink.calls[1].reject(new Error("unavailable"));
  await assertRejects(() => pending, Error, "unavailable");
  assertEquals(nav.snapshot().value, { home: "ready" });
  assertEquals(calls.slice(-2), ["start:root-lease:home", "start:home-lease:home"]);
  pending = nav.navigate(request("article"));
  assertEquals(calls.slice(-4), ["stop:home-lease", "stop:root-lease", "start:root-lease:home", "start:other-lease:article"]);
  sink.calls[2].resolve(); await pending;
  nav.stop();
  assertEquals(calls.filter(call => call.startsWith("stop:")).sort(), ["stop:home-lease", "stop:home-lease", "stop:home-lease", "stop:other-lease", "stop:root-lease", "stop:root-lease", "stop:root-lease", "stop:root-lease", "stop:root-lease"]);
});

Deno.test("rows invocations reject unsupported options and invalid bindings", () => {
  for (const option of [{ input: {} }, { onDone: "idle" }, { onError: "idle" }, { systemId: "lease" }]) {
    const invalid = withRows();
    Object.assign(invalid.config.invoke[0], option);
    assertThrows(() => createCortexNavigation(invalid, async () => {}, () => () => {}), Error, "Invalid rows invocation");
  }
  for (const binding of [{ via: "rows", screen: "home", lifetime: "screen" }, { via: "rows", lifetime: "attachment" }, { via: "rows", screen: "home", lifetime: "attachment", extra: true }]) {
    const invalid = withRows();
    invalid.actors.rootRows = binding;
    assertThrows(() => createCortexNavigation(invalid, async () => {}, () => () => {}), Error, "Invalid navigation actor");
  }
  assertThrows(() => createCortexNavigation(withRows(), async () => {}), Error, "Invalid navigation actor");
});

Deno.test("invoke arrays may combine navigation with a state-local lease", async () => {
  const configured: any = definition();
  configured.actors.rows = { via: "rows", screen: "home", lifetime: "attachment", charts: { test: {} } };
  const state = configured.config.states.home.states.loading;
  state.invoke = [state.invoke, { src: "rows", id: "loading-lease" }];
  const events: string[] = [];
  const nav = createCortexNavigation(configured, async () => "done", (_binding: unknown, spec: any) => {
    events.push(`start:${spec.id}`);
    return () => events.push(`stop:${spec.id}`);
  });
  assertEquals(await nav.navigate(request("home")), "done");
  assertEquals(events, ["start:loading-lease", "stop:loading-lease"]);
  nav.stop();
});

Deno.test("a rows attachment must return its synchronous cleanup", () => {
  assertThrows(() => createCortexNavigation(withRows(), async () => {}, () => undefined), Error, "requires a cleanup function");
});

Deno.test("failed recovery preserves both navigation and row attachment errors", async () => {
  const sink = controlled();
  let failRestore = false;
  const nav = createCortexNavigation(withRows(), sink.activate, () => {
    if (failRestore) throw new Error("row attachment failed");
    return () => {};
  });
  try {
    const first = nav.navigate(request("home"));
    sink.calls[0].resolve();
    await first;
    const failing = nav.navigate(request("article"));
    failRestore = true;
    sink.calls[1].reject(new Error("navigation failed"));
    const error = await assertRejects(() => failing, AggregateError, "Navigation recovery failed");
    assertEquals(error.errors.map((cause: Error) => cause.message), ["navigation failed", "row attachment failed"]);
  } finally { nav.stop(); }
});
