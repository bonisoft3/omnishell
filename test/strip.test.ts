// A guest the app offers no sign-in to gets no strip: signing out only mints
// another. A provider is a sign-in as much as a passkey is: counting only the
// passkey took the strip, and the only way to sign in, from an app whose one
// route signs in through Google.
import { describe, expect, it } from "@test/harness";
import { hasStrip } from "../interpreter/chrome.js";

const routes = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `/r${i}`, nav: {} }));
const guest = { user: { guest: true } };

describe("hasStrip", () => {
  it("leaves a guest no strip when there is nothing to gain", () => {
    expect(hasStrip({ routes: routes(1), auth: {} }, guest)).toBe(false);
  });
  it("gives a guest the strip for a passkey or a provider", () => {
    expect(hasStrip({ routes: routes(1), auth: { promote: true } }, guest)).toBe(true);
    expect(hasStrip({ routes: routes(1), auth: { providers: ["google"] } }, guest)).toBe(true);
    expect(hasStrip({ routes: routes(1), auth: { providers: ["google"] } }, null, true)).toBe(true);
  });
  it("always shows a person who they are, and two links as a choice", () => {
    expect(hasStrip({ routes: routes(1), auth: {} }, { user: { guest: false } })).toBe(true);
    expect(hasStrip({ routes: routes(2), auth: {} }, null)).toBe(true);
  });
});
