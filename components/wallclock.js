// wallclock: <input type="datetime-local"> ←→ the `timestamp` type.
//
// The control holds local wall time with no zone (`2026-09-22T10:00:30`); the
// column holds an instant in UTC with six fractional digits. The reader's zone
// arrives as a parameter, and the tz database through `Intl.DateTimeFormat` —
// what is read out of it is the OFFSET, a number, never the formatter's text
// (plugins/omnishell/REFERENCE.md#adapters).
//
// A wall time is not always one instant. In a spring-forward gap it is none,
// and this refuses rather than sliding the reader's choice into the next hour.
// In a fall-back overlap it is two, and this takes the earlier — the first time
// the clock reads what the reader typed.

const p2 = (n) => (n < 10 ? `0${n}` : `${n}`);

const daysFromCivil = (y0, m, d) => {
  const y = y0 - (m <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
};

const civilFromDays = (z0) => {
  const z = z0 + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return [y + (m <= 2 ? 1 : 0), m, d];
};

/** Seconds of a Y-M-D h:m:s read as if UTC — a civil reading, not an instant. */
const leap = (y) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
const monthLength = (y, mo) => [31, leap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];

/** The digits a control or a carrier spells are not yet a date: 2026-02-31 and
 * 25:99 both parse and neither exists. A module that refuses the wall time a
 * DST gap swallows may not invent one here. */
const civilSeconds = (y, mo, d, h, mi, s, said) => {
  const wrong = y < 1 || y > 9999 || mo < 1 || mo > 12 || d < 1 || d > monthLength(y, mo) ||
    h > 23 || mi > 59 || s > 59;
  if (wrong) throw new Error(`wallclock: ${said} is not a date and a time`);
  return daysFromCivil(y, mo, d) * 86400 + h * 3600 + mi * 60 + s;
};

const parts = (seconds) => {
  const day = Math.floor(seconds / 86400);
  const rest = seconds - day * 86400;
  const [y, mo, d] = civilFromDays(day);
  return [y, mo, d, Math.floor(rest / 3600), Math.floor(rest / 60) % 60, rest % 60];
};

// The offset in force in a zone at an instant, in seconds. `longOffset` spells
// it `GMT-03:00`, and plain `GMT` is UTC.
const zoneFormats = new Map();
const offsetAt = (zone, epochSeconds) => {
  let format = zoneFormats.get(zone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" });
    zoneFormats.set(zone, format);
  }
  const named = format.formatToParts(new Date(epochSeconds * 1000)).find((part) => part.type === "timeZoneName");
  // An offset before standard time was kept carries seconds: Africa/Monrovia
  // ran GMT-00:44:30 until 1972.
  const found = /^GMT(?:([+-])(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(named === undefined ? "" : named.value);
  if (found === null) throw new Error(`wallclock: ${zone} answered ${named === undefined ? "nothing" : named.value}`);
  if (found[1] === undefined) return 0;
  const seconds = Number(found[2]) * 3600 + Number(found[3]) * 60 + Number(found[4] ?? 0);
  return (found[1] === "-" ? -1 : 1) * seconds;
};

const zoneOf = (params) => {
  const zone = params && params.zone;
  if (typeof zone !== "string" || zone === "") throw new Error("wallclock: the reader's zone is required");
  return zone;
};

/** An instant becomes the wall time the control shows. */
const format = (value, params) => {
  if (value === null || value === undefined || value === "") return "";
  const found = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/.exec(String(value));
  if (found === null) throw new Error(`wallclock: ${JSON.stringify(String(value))} is not a timestamp`);
  const utc = civilSeconds(
    Number(found[1]),
    Number(found[2]),
    Number(found[3]),
    Number(found[4]),
    Number(found[5]),
    Number(found[6]),
    String(value),
  );
  const [y, mo, d, h, mi, s] = parts(utc + offsetAt(zoneOf(params), utc));
  if (y < 1 || y > 9999) throw new Error(`wallclock: ${String(value)} leaves the year range in ${zoneOf(params)}`);
  // Seconds are shown so a round trip keeps them; the control needs step="1"
  // to let the reader edit them, and drops them from its own value otherwise.
  return `${String(y).padStart(4, "0")}-${p2(mo)}-${p2(d)}T${p2(h)}:${p2(mi)}:${p2(s)}`;
};

/** The wall time the reader typed becomes the instant the column holds. */
const parse = (text, params) => {
  const found = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(text));
  if (found === null) throw new Error(`wallclock: ${JSON.stringify(String(text))} is not a local date and time`);
  const zone = zoneOf(params);
  const civil = civilSeconds(
    Number(found[1]),
    Number(found[2]),
    Number(found[3]),
    Number(found[4]),
    Number(found[5]),
    Number(found[6] ?? 0),
    String(text),
  );
  // The offsets in force a day either side bracket any transition between
  // them, so the instant this wall time names is among these two candidates
  // — and is one of them exactly when the zone agrees at the instant itself.
  const candidates = [];
  for (const offset of [offsetAt(zone, civil - 86400), offsetAt(zone, civil + 86400)]) {
    const instant = civil - offset;
    if (offsetAt(zone, instant) === offset && !candidates.includes(instant)) candidates.push(instant);
  }
  if (candidates.length === 0) {
    throw new Error(`wallclock: ${String(text)} does not exist in ${zone} — the clock moves forward over it`);
  }
  const [y, mo, d, h, mi, s] = parts(Math.min(...candidates));
  if (y < 1 || y > 9999) throw new Error(`wallclock: ${String(text)} leaves the year range in ${zone}`);
  return `${String(y).padStart(4, "0")}-${p2(mo)}-${p2(d)}T${p2(h)}:${p2(mi)}:${p2(s)}.000000Z`;
};

// The loader takes the last top-level expression as the module's value, and an
// adapter's is its map of pure functions (pronto/jessie.ts).
({ format, parse });
