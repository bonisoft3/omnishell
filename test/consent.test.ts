import { describe, expect, it } from "@test/harness";
import { parseHTML } from "npm:linkedom@0.18.4";
import { CONSENT_KEY, signalsOf, startConsent } from "../interpreter/consent.js";
import { chromeText } from "../interpreter/chrome.js";

const bar = { mode: "bar", policy: { url: "https://shop.example/privacy", version: "2" }, hosts: ["shop.example"] };
const granted = signalsOf("granted");
const denied = signalsOf("denied");

const start = async ({ consent = bar as Record<string, unknown>, stored = {} as Record<string, string>, gpc = false, hostname = "shop.example" } = {}) => {
  const { document } = parseHTML("<!doctype html><html><body><nav></nav><main></main></body></html>");
  const held = new Map(Object.entries(stored));
  const storage = { getItem: (k: string) => held.get(k) ?? null, setItem: (k: string, v: string) => void held.set(k, v) };
  const told: unknown[][] = [];
  const screen = await startConsent({
    consent,
    doc: document,
    storage,
    navigator: gpc ? { globalPrivacyControl: true } : {},
    location: { hostname },
    gtag: (...args: unknown[]) => told.push(args),
    text: (key: string) => chromeText(key, { messages: {}, locale: "en" }),
    ready: Promise.resolve(),
    now: () => Date.UTC(2026, 10, 22),
  });
  return { document, held, told, screen };
};
const record = (advertising: string, version = "2") => ({ [CONSENT_KEY]: JSON.stringify({ version, advertising, at: "" }) });

describe("startConsent", () => {
  it("lets Google store nothing, analytics included, unless advertising is granted", () => {
    expect(denied).toEqual({ ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "denied" });
  });

  it("states denied and shows the bar to a reader who has not answered, and stores and states the answer", async () => {
    const { document, held, told, screen } = await start();
    expect(told).toEqual([["consent", "update", denied]]);
    expect([screen!.bar.hidden, screen!.open.hidden]).toEqual([false, true]);
    expect(document.body.firstElementChild).toBe(screen!.bar);
    const [reject, accept] = [...screen!.bar.querySelectorAll("button[data-consent]")];
    expect([reject.textContent, accept.textContent]).toEqual(["Reject", "Accept"]);
    expect(screen!.bar.querySelector("a")!.getAttribute("href")).toBe("https://shop.example/privacy");

    accept.click();
    expect(told.at(-1)).toEqual(["consent", "update", granted]);
    expect(JSON.parse(held.get(CONSENT_KEY)!)).toEqual({ version: "2", advertising: "granted", at: "2026-11-22T00:00:00.000Z" });
    expect([screen!.bar.hidden, screen!.open.hidden]).toEqual([true, false]);

    screen!.open.click();
    expect(screen!.bar.hidden).toBe(false);
    expect(accept.getAttribute("aria-pressed")).toBe("true");
    reject.click();
    expect(told.at(-1)).toEqual(["consent", "update", denied]);
  });

  it("asks a reader who ignored the bar on the next view, and never one who answered, until a new policy version", async () => {
    expect((await start()).screen!.bar.hidden).toBe(false);
    const rejected = await start({ stored: record("denied") });
    expect(rejected.told).toEqual([["consent", "update", denied]]);
    expect([rejected.screen!.bar.hidden, rejected.screen!.open.hidden]).toEqual([true, false]);
    const accepted = await start({ stored: record("granted") });
    expect(accepted.told).toEqual([["consent", "update", granted]]);
    expect(accepted.screen!.bar.hidden).toBe(true);
    const bumped = await start({ stored: record("granted", "1") });
    expect(bumped.told).toEqual([["consent", "update", denied]]);
    expect(bumped.screen!.bar.hidden).toBe(false);
  });

  it("takes Global Privacy Control as a Reject, without the bar", async () => {
    const { told, screen } = await start({ gpc: true });
    expect(told).toEqual([["consent", "update", denied]]);
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
});
