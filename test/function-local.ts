// A compiled database function run here as PLV8 runs it: the module pronto
// emitted (.pronto/functions.json), evaluated once in a hardened compartment,
// called per input with a fresh fuel budget over a detached, frozen argument,
// its answer refused unless plain JSON. An app's tests take the module and
// never the compiler.
import { evaluateCaged } from "../interpreter/jessie.js";
import { METER } from "../instrument.ts";

declare const harden: <T>(value: T) => T;

type Callable = {
  reset: (limit: number) => void;
  spent: () => number;
  fn: (input: unknown) => unknown;
};
const callables = new Map<string, Promise<Callable>>();

// What the engine's wrapper refuses of an answer, where it is not plain JSON.
function plain(value: unknown, where = "answer"): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw new TypeError(`${where} is not a finite number`);
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => plain(v, `${where}[${i}]`));
    return value;
  }
  if (typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    for (const [k, v] of Object.entries(value)) plain(v, `${where}.${k}`);
    return value;
  }
  throw new TypeError(`${where} is not JSON`);
}

/** The function's answer to `input`, and the steps the call spent of `fuel`. */
export async function executeFunction(source: string, fuel: number, input: unknown): Promise<{ answer: unknown; spent: number }> {
  let cached = callables.get(source);
  if (!cached) {
    let spent = 0;
    let limit = fuel;
    cached = evaluateCaged(source, {
      [METER]: () => {
        if (++spent > limit) throw new RangeError(`function: fuel exhausted (${limit} steps)`);
      },
    }).then((fn) => ({
      reset: (n: number) => {
        spent = 0;
        limit = n;
      },
      spent: () => spent,
      fn: fn as (input: unknown) => unknown,
    }));
    callables.set(source, cached);
  }
  const callable = await cached;
  callable.reset(fuel);
  const answer = plain(callable.fn(harden(JSON.parse(JSON.stringify(input)))));
  return { answer, spent: callable.spent() };
}
