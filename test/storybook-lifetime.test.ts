import { expect } from "@test/harness";
import { parseHTML } from "linkedom";
import { renderStorybook, stopStorybook } from "../interpreter/storybook.js";
import { checkMemoryApp, checkPseudoLocale } from "../check-i18n.ts";

const source = '<main data-screen="fixture"><div data-live="item"><template data-item><p data-text="{name}"></p></template></div></main>';
const broken = `<main data-screen="fixture"><div data-live="item"><template data-item><article><div data-live="nested" data-project='{"up":{"eq":["state","ready"]}}'><span></span></div></article></template></div></main>`;
const route = { path: "/", screen: "fixture", files: { html: "fixture.html", css: "fixture.css" }, states: ["empty", "populated"] };

async function fixture(run: (mount: HTMLElement, counts: () => number[]) => Promise<void>) {
  const { document } = parseHTML('<html><head></head><body><div id="mount"></div></body></html>');
  const held = { document: globalThis.document, fetch: globalThis.fetch, location: globalThis.location, CSS: globalThis.CSS,
    addEventListener: globalThis.addEventListener, removeEventListener: globalThis.removeEventListener };
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>([
    ["pagehide", new Set()], ["pageshow", new Set()],
  ]);
  Object.assign(globalThis, { document, location: new URL("http://app.test/"), CSS: { escape: (s: string) => s },
    fetch: async (url: unknown) => new Response(String(url).endsWith(".css") ? "" : source),
  });
  globalThis.addEventListener = (...[type, listener, options]: Parameters<typeof held.addEventListener>) => {
    listeners.get(type)?.add(listener);
    held.addEventListener.call(globalThis, type, listener, options);
  };
  globalThis.removeEventListener = (...[type, listener, options]: Parameters<typeof held.removeEventListener>) => {
    listeners.get(type)?.delete(listener);
    held.removeEventListener.call(globalThis, type, listener, options);
  };
  const mount = document.getElementById("mount")!;
  try { await run(mount, () => [...listeners.values()].map((set) => set.size)); }
  finally {
    try { stopStorybook(mount); }
    finally {
      for (const [type, callbacks] of listeners) for (const listener of callbacks) held.removeEventListener.call(globalThis, type, listener);
      Object.assign(globalThis, held);
    }
  }
}

Deno.test("storybook replacement owns only its live frames and explicit disposal preserves their DOM", () => fixture(async (mount, counts) => {
  let previous: Awaited<ReturnType<typeof renderStorybook>> | undefined;
  for (let i = 0; i < 3; i++) {
    const book = await renderStorybook(mount, "http://app.test/", route);
    previous?.stop();
    expect(counts()).toEqual([2, 2]);
    expect(mount.querySelectorAll("figure").length).toBe(2);
    expect([...document.head.querySelectorAll("style")].filter((style) => style.textContent?.includes(".storybook {")).length).toBe(1);
    previous = book;
  }
  previous!.stop();
  expect(counts()).toEqual([0, 0]);
  expect(mount.querySelectorAll("figure").length).toBe(2);
  previous!.stop();
  expect(counts()).toEqual([0, 0]);
}));

Deno.test("storybook hydration failure releases the completed frame and the rejecting frame", () => fixture(async (mount, counts) => {
  globalThis.fetch = async (url) => new Response(String(url).endsWith(".css") ? "" : broken);
  await expect(renderStorybook(mount, "http://app.test/", route)).rejects.toThrow(/slot and declares data-project/);
  expect(mount.querySelectorAll("figure").length).toBe(2);
  expect(counts()).toEqual([0, 0]);
}));

Deno.test("a replaced storybook stops a frame that finishes mounting later", () => fixture(async (mount, counts) => {
  const response = Promise.withResolvers<Response>();
  const requested = Promise.withResolvers<void>();
  globalThis.fetch = (url) => {
    if (String(url).endsWith("held.html")) { requested.resolve(); return response.promise; }
    return Promise.resolve(new Response(String(url).endsWith(".css") ? "" : source));
  };
  const first = renderStorybook(mount, "http://app.test/", { ...route, files: { html: "held.html", css: "fixture.css" } });
  await requested.promise;
  const current = await renderStorybook(mount, "http://app.test/", route);
  response.resolve(new Response(source));
  const old = await first;
  old.stop();
  expect(counts()).toEqual([2, 2]);
  expect(mount.querySelectorAll("figure").length).toBe(2);
  current.stop();
  expect(counts()).toEqual([0, 0]);
}));

Deno.test("normal and pseudo i18n passes release their final and failed storybooks", () => fixture(async (_mount, counts) => {
  const shell = { i18n: { default: "en", locales: { en: { path: "en" }, pt: { path: "pt" } } }, routes: [route] };
  const messages = { en: { name: "Name" }, pt: { name: "Nome" } };
  for (const check of [checkMemoryApp, checkPseudoLocale]) {
    for (const html of [source, broken]) {
      const findings = await check(shell, messages, { "fixture.html": html, "fixture.css": "" });
      expect(findings.some((finding) => finding.message.includes("renderStorybook failed"))).toBe(html === broken);
      expect(counts()).toEqual([0, 0]);
    }
  }
}));
