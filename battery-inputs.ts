import fc from "npm:fast-check@3.23.2";

export type PropertyFor<T> = (predicate: (input: T) => boolean) => fc.IProperty<[T]>;

class DeferredShrink {
  constructor(readonly random: fc.Random, readonly runId: number | undefined) {}
}

// Battery predicates clone inputs. Keep draws and their RNG positions;
// reconstruct the larger shrink context only when a predicate fails.
export function sharedInputs<T>(inputs: fc.Arbitrary<T>): PropertyFor<T> {
  const draws = new Map<string, fc.Value<[T]>>();
  return (predicate) => {
    const property = fc.property(inputs, predicate);
    return {
      isAsync: () => false,
      generate: (random, runId) => {
        const state = random.getState();
        if (state === undefined) throw new Error("battery input reuse requires a reproducible random generator");
        const key = JSON.stringify([state, runId]);
        let draw = draws.get(key);
        if (draw === undefined) {
          const context = new DeferredShrink(random.clone(), runId);
          draw = new fc.Value(property.generate(random, runId).value_, context);
          draws.set(key, draw);
        }
        return new fc.Value(draw.value_, draw.context);
      },
      shrink: (value) => property.shrink(value.context instanceof DeferredShrink
        ? property.generate(value.context.random.clone(), value.context.runId)
        : value),
      run: (value, withoutHooks) => property.run(value, withoutHooks),
      runBeforeEach: () => property.runBeforeEach?.(),
      runAfterEach: () => property.runAfterEach?.(),
    };
  };
}
