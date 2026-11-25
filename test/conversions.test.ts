import { describe, expect, it } from "@test/harness";
import { CONVERSION_PENDING_KEY, promotedAccount, startConversions } from "../interpreter/conversions.js";

const SIGNUP = "AW-11407991574/BAXrCP28w78dEJbG4L8q";
const guest = { token: "g", user: { id: "u1", handle: "mango-capybara-0001", guest: true }, committed: true };
const person = { token: "p", user: { id: "u1", handle: "davi-0001" } };
const other = { token: "o", user: { id: "u2", handle: "ana-0002" } };

const start = (conversions: Record<string, string> = { signup: SIGNUP }, held: Record<string, string> = {}) => {
  const map = new Map(Object.entries(held));
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
  const told: unknown[][] = [];
  const tracker = startConversions({ conversions, gtag: (...args: unknown[]) => told.push(args), storage });
  return { tracker, told, map };
};

describe("conversions", () => {
  it("reports signup once when a guest becomes a person, its send_to and its account's id", () => {
    const { tracker, told } = start();
    tracker.signedIn(guest, person);
    expect(told).toEqual([["event", "conversion", { send_to: SIGNUP, transaction_id: "u1" }]]);
    // The promoted page reloading, or its next boot taking the account up
    // again, is the person it already was.
    tracker.signedIn(person, person);
    expect(told.length).toBe(1);
  });

  it("reports no signup for a returning sign-in, a guest minted or switched from, or a sign-out", () => {
    const { tracker, told } = start();
    // A guest whose passkey or provider was another account's reaches that
    // account: an existing person, under another id.
    tracker.signedIn(guest, other);
    tracker.signedIn(null, other);
    tracker.signedIn(other, person);
    tracker.signedIn(null, guest);
    tracker.signedIn(person, guest);
    tracker.signedIn(person, null);
    expect(told).toEqual([]);
    expect([promotedAccount(guest, other), promotedAccount(undefined, person), promotedAccount(guest, guest)]).toEqual([null, null, null]);
  });

  // A required app's ceremony reloads the page at once, which takes the tag
  // frame down with the message it was posted before it could send it.
  it("hands a promotion the page reloads after to the page that follows, which reports it once", () => {
    const before = start();
    before.tracker.signedIn(guest, person, true);
    expect(before.told).toEqual([]);
    expect(before.map.get(CONVERSION_PENDING_KEY)).toBe("u1");

    const after = start({ signup: SIGNUP }, Object.fromEntries(before.map));
    expect(after.told).toEqual([["event", "conversion", { send_to: SIGNUP, transaction_id: "u1" }]]);
    expect(after.map.has(CONVERSION_PENDING_KEY)).toBe(false);
    expect(start({ signup: SIGNUP }, Object.fromEntries(after.map)).told).toEqual([]);
  });

  it("reports an account a sign-in gate made with no guest before it", () => {
    const { tracker, told } = start();
    tracker.made(other);
    expect(told).toEqual([["event", "conversion", { send_to: SIGNUP, transaction_id: "u2" }]]);
  });

  it("reports nothing an app does not declare, and refuses a name it does not know", () => {
    const { tracker, told } = start({});
    tracker.signedIn(guest, person);
    expect(told).toEqual([]);
    // A program compiled by a newer pronto than this terminal knows would
    // otherwise lose its conversion with no word.
    expect(() => start({ purchase: "AW-1/x" })).toThrow("the terminal reports no conversion named purchase");
  });
});
