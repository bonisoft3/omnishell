import { describe, expect, it } from "@test/harness";
import { parseHTML } from "npm:linkedom@0.18.4";
import { CONSENT_DISMISSED_KEY, CONSENT_KEY, CONSENT_SHOW_DELAY_MS, signalsOf, startConsent } from "../interpreter/consent.js";
import { chromeText } from "../interpreter/chrome.js";

const bar = { mode: "bar", policy: { url: "https://shop.example/privacy", version: "2" }, hosts: ["shop.example"] };
const granted = signalsOf("granted");
const denied = signalsOf("denied");

const makeStorage = (initial: Record<string, string> = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    map,
    api: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    },
  };
};

const start = async ({
  consent = bar as Record<string, unknown>,
  stored = {} as Record<string, string>,
  session = {} as Record<string, string>,
  gpc = false,
  hostname = "shop.example",
} = {}) => {
  const { document } = parseHTML("<!doctype html><html><body><nav></nav><main><button id='go'>Go</button></main></body></html>");
  const local = makeStorage(stored);
  const tab = makeStorage(session);
  const told: unknown[][] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;
  const screen = await startConsent({
    consent,
    doc: document,
    storage: local.api,
    sessionStorage: tab.api,
    navigator: gpc ? { globalPrivacyControl: true } : {},
    location: { hostname },
    gtag: (...args: unknown[]) => told.push(args),
    text: (key: string) => chromeText(key, { messages: {}, locale: "en" }),
    ready: Promise.resolve(),
    now: () => Date.UTC(2026, 10, 22),
    schedule: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    cancel: (id: number) => void timers.delete(id),
  });
  const interact = (trusted = true, target: EventTarget = document.querySelector("#go")!) => {
    const ev = document.createEvent("Event");
    ev.initEvent("pointerdown", true, true);
    Object.defineProperty(ev, "isTrusted", { value: trusted });
    target.dispatchEvent(ev);
  };
  const flushTimers = () => {
    for (const [id, entry] of [...timers.entries()]) {
      timers.delete(id);
      entry.fn();
    }
  };
  return { document, held: local.map, sessionHeld: tab.map, told, screen, timers, interact, flushTimers };
};
const record = (advertising: string, version = "2") => ({ [CONSENT_KEY]: JSON.stringify({ version, advertising, at: "" }) });

describe("startConsent", () => {
  it("lets Google store nothing, analytics included, unless advertising is granted", () => {
    expect(denied).toEqual({ ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "denied" });
  });

  it("stays hidden until first trusted interaction + delay, then shows and stores the answer", async () => {
    const { document, held, sessionHeld, told, screen, timers, interact, flushTimers } = await start();
    expect(told).toEqual([["consent", "update", denied]]);
    expect([screen!.bar.hidden, screen!.open.hidden]).toEqual([true, false]);
    expect(document.body.firstElementChild).toBe(screen!.bar);

    // Untrusted script events never trigger the banner.
    interact(false);
    expect(timers.size).toBe(0);
    expect([screen!.bar.hidden, screen!.open.hidden]).toEqual([true, false]);

    // First trusted interaction schedules with delay, leaving banner hidden until timer fires.
    interact(true);
    expect(timers.size).toBe(1);
    expect([...timers.values()][0].ms).toBe(CONSENT_SHOW_DELAY_MS);
    expect([screen!.bar.hidden, screen!.open.hidden]).toEqual([true, false]);

    flushTimers();
    expect([screen!.bar.hidden, screen!.open.hidden]).toEqual([false, true]);
    const [reject, accept] = [...screen!.bar.querySelectorAll("button[data-consent]")];
    expect([reject.textContent, accept.textContent]).toEqual(["Reject", "Accept"]);
    expect(screen!.bar.querySelector("a")!.getAttribute("href")).toBe("https://shop.example/privacy");

    sessionHeld.set(CONSENT_DISMISSED_KEY, "2");
    accept.click();
    expect(told.at(-1)).toEqual(["consent", "update", granted]);
    expect(JSON.parse(held.get(CONSENT_KEY)!)).toEqual({ version: "2", advertising: "granted", at: "2026-11-22T00:00:00.000Z" });
    expect(sessionHeld.has(CONSENT_DISMISSED_KEY)).toBe(false);
    expect([screen!.bar.hidden, screen!.open.hidden]).toEqual([true, false]);

    screen!.open.click();
    expect(screen!.bar.hidden).toBe(false);
    expect(accept.getAttribute("aria-pressed")).toBe("true");
    reject.click();
    expect(told.at(-1)).toEqual(["consent", "update", denied]);
  });

  it("never prompts a reader who answered until a new policy version", async () => {
    const rejected = await start({ stored: record("denied") });
    expect(rejected.told).toEqual([["consent", "update", denied]]);
    rejected.interact(true);
    rejected.flushTimers();
    expect([rejected.screen!.bar.hidden, rejected.screen!.open.hidden]).toEqual([true, false]);

    const accepted = await start({ stored: record("granted") });
    expect(accepted.told).toEqual([["consent", "update", granted]]);
    accepted.interact(true);
    accepted.flushTimers();
    expect(accepted.screen!.bar.hidden).toBe(true);

    const bumped = await start({ stored: record("granted", "1") });
    expect(bumped.told).toEqual([["consent", "update", denied]]);
    bumped.interact(true);
    bumped.flushTimers();
    expect(bumped.screen!.bar.hidden).toBe(false);
  });

  it("takes Global Privacy Control as a Reject, without showing the bar", async () => {
    const { told, screen, timers, interact, flushTimers } = await start({ gpc: true });
    expect(told).toEqual([["consent", "update", denied]]);
    interact(true);
    flushTimers();
    expect(timers.size).toBe(0);
    expect([screen!.bar.hidden, screen!.open.hidden]).toEqual([true, false]);
  });

  // Global Privacy Control is a standing default; a reader who accepted on this
  // site has answered for it, as California's rules let a site honour.
  it("lets an explicit Accept stand under Global Privacy Control", async () => {
    const { told } = await start({ gpc: true, stored: record("granted") });
    expect(told).toEqual([["consent", "update", signalsOf("granted")]]);
  });

  it("asks nobody under mode none, and states what it declares", async () => {
    for (const advertising of ["denied", "granted"]) {
      const { document, told, screen } = await start({ consent: { ...bar, mode: "none", none: { advertising } } });
      expect(screen).toBe(null);
      expect(told).toEqual([["consent", "update", signalsOf(advertising)]]);
      expect(document.querySelector(".shell-consent, .shell-consent-open")).toBe(null);
    }
  });

  it("draws nothing on a host no tag sends from, and still states the signals", async () => {
    const { document, told, screen } = await start({ hostname: "localhost" });
    expect(screen).toBe(null);
    expect(told).toEqual([["consent", "update", denied]]);
    expect(document.querySelector(".shell-consent")).toBe(null);
  });

  it("persists dismissal for the browser tab via × or Escape without storing a choice, and cancels scheduled timers when shield opens", async () => {
    const first = await start();
    first.interact(true);
    expect(first.timers.size).toBe(1);
    first.screen!.open.click();
    expect(first.timers.size).toBe(0);
    expect([first.screen!.bar.hidden, first.screen!.open.hidden]).toEqual([false, true]);

    first.screen!.close.click();
    expect([first.screen!.bar.hidden, first.screen!.open.hidden]).toEqual([true, false]);
    expect(first.held.has(CONSENT_KEY)).toBe(false);
    expect(first.sessionHeld.get(CONSENT_DISMISSED_KEY)).toBe("2");
    expect(first.told).toEqual([["consent", "update", denied]]);

    // Reloading in the same tab keeps the bar suppressed even after interaction.
    const sameTab = await start({ session: Object.fromEntries(first.sessionHeld) });
    sameTab.interact(true);
    sameTab.flushTimers();
    expect([sameTab.screen!.bar.hidden, sameTab.screen!.open.hidden]).toEqual([true, false]);

    // Opening via the shield still works and Escape re-dismisses for the tab.
    sameTab.screen!.open.click();
    expect(sameTab.screen!.bar.hidden).toBe(false);
    const esc = sameTab.document.createEvent("Event");
    esc.initEvent("keydown", true, true);
    (esc as unknown as { key: string }).key = "Escape";
    sameTab.screen!.bar.dispatchEvent(esc);
    expect([sameTab.screen!.bar.hidden, sameTab.screen!.open.hidden]).toEqual([true, false]);
    expect(sameTab.sessionHeld.get(CONSENT_DISMISSED_KEY)).toBe("2");

    // Bumping the policy version re-enables the prompt on interaction.
    const bumpedTab = await start({
      consent: { ...bar, policy: { url: bar.policy.url, version: "3" } },
      session: { [CONSENT_DISMISSED_KEY]: "2" },
    });
    bumpedTab.interact(true);
    bumpedTab.flushTimers();
    expect(bumpedTab.screen!.bar.hidden).toBe(false);
  });
});
