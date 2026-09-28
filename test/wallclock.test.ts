// The adapter in the cage it ships to: evaluated through evaluateRole("adapter"),
// so the endowment is the one the terminal gives it and nothing else is in
// scope. São Paulo has no DST today and Berlin does, which is what makes the
// gap and the overlap reachable.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { ensureSes, evaluateRole } from "../interpreter/jessie.js";

const SOURCE = await Deno.readTextFile(new URL("../components/wallclock.js", import.meta.url));
await ensureSes();
const wallclock = await evaluateRole(SOURCE, "adapter") as {
  format: (value: unknown, params: { zone: string }) => string;
  parse: (text: unknown, params: { zone: string }) => string;
};

const SP = { zone: "America/Sao_Paulo" };
const BERLIN = { zone: "Europe/Berlin" };

Deno.test("an instant becomes the reader's wall time, seconds kept", () => {
  assertEquals(wallclock.format("2026-09-22T13:38:10.983076Z", SP), "2026-09-22T10:38:10");
  assertEquals(wallclock.format("2026-09-22T13:38:10.000000Z", BERLIN), "2026-09-22T15:38:10");
  // Berlin in January is +01:00, in July +02:00 — one zone, two offsets.
  assertEquals(wallclock.format("2026-01-15T12:00:00.000000Z", BERLIN), "2026-01-15T13:00:00");
  assertEquals(wallclock.format(null, SP), "");
  assertEquals(wallclock.format("", SP), "");
});

Deno.test("the wall time the reader typed becomes the instant", () => {
  assertEquals(wallclock.parse("2026-09-22T10:38:10", SP), "2026-09-22T13:38:10.000000Z");
  // The control omits seconds unless it is asked for them.
  assertEquals(wallclock.parse("2026-09-22T10:38", SP), "2026-09-22T13:38:00.000000Z");
  assertEquals(wallclock.parse("2026-01-15T13:00:00", BERLIN), "2026-01-15T12:00:00.000000Z");
});

Deno.test("a round trip is a fixed point on both sides of a transition", () => {
  for (const instant of [
    "2026-03-29T00:59:00.000000Z", // Berlin, one minute before the spring gap
    "2026-03-29T01:00:00.000000Z", // the instant the clock jumps to 03:00
    "2026-10-25T00:30:00.000000Z", // inside the autumn overlap's first hour
    "2026-07-01T09:00:00.000000Z",
  ]) {
    assertEquals(wallclock.parse(wallclock.format(instant, BERLIN), BERLIN), instant, instant);
  }
});

Deno.test("a wall time that does not exist is refused, not slid", () => {
  // 02:30 on 2026-03-29 in Berlin: the clock goes 01:59:59 → 03:00:00.
  assertThrows(
    () => wallclock.parse("2026-03-29T02:30:00", BERLIN),
    Error,
    "does not exist",
  );
});

Deno.test("a wall time the clock reads twice takes the earlier instant", () => {
  // 02:30 on 2026-10-25 in Berlin happens at 00:30Z (+02:00) and 01:30Z (+01:00).
  assertEquals(wallclock.parse("2026-10-25T02:30:00", BERLIN), "2026-10-25T00:30:00.000000Z");
});

Deno.test("a field the calendar does not have is refused, not carried", () => {
  // The digits parse; the dates do not exist. A module that refuses the wall
  // time a spring-forward swallows may not invent the 31st of February.
  for (const wall of ["2026-02-31T10:00", "2026-13-01T10:00", "2026-01-01T25:99", "2026-00-00T00:00", "2024-12-31T23:59:60"]) {
    assertThrows(() => wallclock.parse(wall, BERLIN), Error, "is not a date and a time", wall);
  }
  assertThrows(() => wallclock.format("2026-13-45T99:99:99.000000Z", BERLIN), Error, "is not a date and a time");
  // The leap day itself is a date, and the following year's is not.
  assertEquals(wallclock.parse("2024-02-29T12:00:00", { zone: "UTC" }), "2024-02-29T12:00:00.000000Z");
  assertThrows(() => wallclock.parse("2025-02-29T12:00:00", { zone: "UTC" }), Error, "is not a date and a time");
});

Deno.test("an offset with seconds, and a year below four digits", () => {
  // Africa/Monrovia kept GMT-00:44:30 until 1972; the offset lookup answers in
  // seconds, so the formatter must admit them.
  assertEquals(wallclock.format("1971-06-01T12:00:00.000000Z", { zone: "Africa/Monrovia" }), "1971-06-01T11:15:30");
  assertEquals(wallclock.parse("1971-06-01T11:15:30", { zone: "Africa/Monrovia" }), "1971-06-01T12:00:00.000000Z");
  // A year is four digits on both sides, or the type's own pattern refuses
  // what this wrote.
  assertEquals(wallclock.format("0999-01-01T00:00:00.000000Z", { zone: "UTC" }), "0999-01-01T00:00:00");
  assertEquals(wallclock.parse("0999-01-01T00:00:00", { zone: "UTC" }), "0999-01-01T00:00:00.000000Z");
  assertThrows(() => wallclock.format("9999-12-31T23:59:59.000000Z", { zone: "Asia/Tokyo" }), Error, "leaves the year range");
});

Deno.test("the zone is data: no zone, no answer", () => {
  assertThrows(() => wallclock.format("2026-09-22T13:38:10.000000Z", { zone: "" }), Error, "zone is required");
  assertThrows(() => wallclock.parse("2026-09-22T10:38", { zone: "" }), Error, "zone is required");
});

Deno.test("what is not the control's spelling, or the type's, is refused", () => {
  assertThrows(() => wallclock.parse("22/09/2026 10:38", SP), Error, "not a local date and time");
  assertThrows(() => wallclock.format("2026-09-22 13:38:10+00", SP), Error, "not a timestamp");
  assertThrows(() => wallclock.format("2026-09-22T13:38:10Z", SP), Error, "not a timestamp");
});

Deno.test("the cage holds Intl, and what Intl does not give it", async () => {
  const probe = await evaluateRole(
    `harden({
      format: () => Object.getOwnPropertyNames(Intl).sort().join(","),
      parse: () => {
        // An unknown global is undefined in the cage rather than a throw, so
        // absence is read with typeof; the clock is present and refuses.
        const absent = ["localStorage", "sessionStorage", "indexedDB", "caches", "fetch", "navigator", "document"]
          .filter((name) => typeof (0, eval)(name) !== "undefined");
        let clock = "reached";
        try { Date.now(); } catch (e) { clock = "refused"; }
        return JSON.stringify({ absent, clock });
      },
    })`,
    "adapter",
  ) as { format: () => string; parse: () => string };
  // The whole namespace, as an author knows it: nothing in it is reachable by
  // the data an adapter is handed, so nothing is withheld.
  assertEquals(
    probe.format(),
    "Collator,DateTimeFormat,DisplayNames,DurationFormat,ListFormat,Locale,NumberFormat,PluralRules,RelativeTimeFormat,Segmenter,getCanonicalLocales,supportedValuesOf",
  );
  assertEquals(probe.parse(), JSON.stringify({ absent: [], clock: "refused" }));

  // Every other role runs where this tz database is not: goja at the container
  // tier, plv8 in the database.
  for (const role of ["handler", "renderer", "validation"]) {
    const module = await evaluateRole(`(() => typeof Intl)`, role) as () => string;
    assertEquals(module(), "undefined", `${role} is endowed with no Intl`);
  }
});

// Every ambient reading Intl offers is a default the host fills in, and each
// one is closed by making the argument mandatory
// (plugins/omnishell/REFERENCE.md#adapters).
Deno.test("the host's defaults are refused, so no clock and no ambient zone", async () => {
  const probe = await evaluateRole(
    `harden({
      format: () => {
        const refusals = {};
        const say = (name, call) => {
          try { call(); refusals[name] = "reached"; } catch (e) { refusals[name] = String(e.message).split(":")[1].trim(); }
        };
        say("no locale", () => new Intl.NumberFormat());
        say("no zone", () => new Intl.DateTimeFormat("en-US"));
        say("no instant", () => new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).format());
        say("no instant in parts", () => new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).formatToParts());
        return JSON.stringify(refusals);
      },
      parse: () => {
        // Stated in full, a formatter still works, and answers about the zone
        // it was given rather than the one the host runs in.
        const stated = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", timeStyle: "short" });
        return stated.format(new Date(0)) + " / " + stated.resolvedOptions().timeZone;
      },
    })`,
    "adapter",
  ) as { format: () => string; parse: () => string };
  assertEquals(
    JSON.parse(probe.format()),
    {
      "no locale": "name the locale — the cage has no default",
      "no zone": "name the timeZone — the cage has no default",
      "no instant": "name the instant — a formatter with no argument reads the clock",
      "no instant in parts": "name the instant — a formatter with no argument reads the clock",
    },
  );
  // The space before AM is ICU's narrow no-break one, which is the reason a
  // formatter's text belongs on a screen and never in a column.
  assertEquals(probe.parse().replace(/[\u202f\u00a0]/g, " "), "9:00 AM / Asia/Tokyo");
});

Deno.test("no walk out of Intl reaches a service that answers without arguments", async () => {
  // The guard is composition and not a subclass for this reason: `class W
  // extends Service` publishes the untamed Service as getPrototypeOf(W), and
  // one `new` on it answers with the machine's zone, locale and clock.
  const probe = await evaluateRole(
    `harden({
      format: () => {
        const escapes = [];
        const tryBuild = (where, fn) => {
          if (typeof fn !== "function") return;
          let made;
          try { made = new fn(); } catch (e) { return; }
          // Object itself is on every prototype chain and is not a service.
          const isService = made !== null && made !== undefined &&
            ["resolvedOptions", "format", "compare", "select", "of", "segment"].some((k) => typeof made[k] === "function");
          if (isService) escapes.push(where);
        };
        for (const name of Object.getOwnPropertyNames(Intl)) {
          const member = Intl[name];
          if (typeof member !== "function") continue;
          tryBuild(name + " itself", member);
          tryBuild("getPrototypeOf(" + name + ")", Object.getPrototypeOf(member));
          const shape = member.prototype;
          if (shape === undefined || shape === null) continue;
          tryBuild("getPrototypeOf(" + name + ".prototype).constructor", Object.getPrototypeOf(shape) && Object.getPrototypeOf(shape).constructor);
        }
        return JSON.stringify(escapes);
      },
      parse: () => {
        // The same walk from a formatter built the legal way, for the raw
        // accessor that would format the unnamed instant.
        const made = new Intl.DateTimeFormat("en-US", { timeZone: "UTC" });
        const walked = [];
        for (let shape = Object.getPrototypeOf(made); shape !== null; shape = Object.getPrototypeOf(shape)) {
          const held = Object.getOwnPropertyDescriptor(shape, "format");
          if (held === undefined) continue;
          const call = held.get === undefined ? held.value : held.get.call(made);
          try { walked.push(String(call())); } catch (e) { walked.push("refused"); }
        }
        return JSON.stringify(walked);
      },
    })`,
    "adapter",
  ) as { format: () => string; parse: () => string };
  assertEquals(JSON.parse(probe.format()), [], "nothing constructible without arguments is reachable from Intl");
  assertEquals(JSON.parse(probe.parse()), ["refused"], "the only `format` on the chain is the guarded one");
});

Deno.test("a locale the host lacks is refused, not answered with the host's", async () => {
  const probe = await evaluateRole(
    `harden({
      format: () => {
        const locale = (asked) => {
          try { return new Intl.DateTimeFormat(asked, { timeZone: "UTC" }).resolvedOptions().locale; }
          catch (e) { return "refused"; }
        };
        return JSON.stringify({
          stated: locale("pt-BR"),
          unsupported: locale("xx-YY"),
          undetermined: locale("und"),
          empty: locale([]),
        });
      },
      parse: () => 0,
    })`,
    "adapter",
  ) as { format: () => string };
  // Resolution falls back to the host's own locale, which would be its last
  // way of answering instead of the module's arguments.
  assertEquals(JSON.parse(probe.format()), {
    stated: "pt-BR",
    unsupported: "refused",
    undetermined: "refused",
    empty: "refused",
  });
});

Deno.test("a fold cannot reach it either", async () => {
  const fold = await evaluateRole(
    `export const empty = () => ({});
     export const step = () => typeof Intl;
     export const combine = (a) => a;
     export const result = (a) => a;`,
    "fold",
  ) as { step: () => string };
  assertEquals(fold.step(), "undefined");
});
