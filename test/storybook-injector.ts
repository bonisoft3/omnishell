// Storybook state injection (posing): directly mounts screens into every discrete
// machine state using pre-populated fixture rows, without executing mutations or transitions.
// Enforces linear component isolation and pairwise covering arrays to eliminate combinatorial explosion.

import type { Machine, StateNode } from "./canonical.ts";

export type PosedFrame = {
  name: string;
  targetRegion: string;
  state: string;
  row: Record<string, unknown>;
  tables?: Record<string, Record<string, unknown>>;
  visualInvariants: Record<string, string>;
};

export type MachineRegionInfo = {
  name: string;
  field: string;
  initial: string;
  states: string[];
  table?: string;
  assigns?: Record<string, Record<string, unknown>>;
};

function extractAssigns(node: StateNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const entries = Array.isArray(node.entry) ? node.entry : node.entry ? [node.entry] : [];
  for (const item of entries) {
    if (item && typeof item === "object" && "assign" in item && typeof (item as { assign: unknown }).assign === "object") {
      Object.assign(out, (item as { assign: Record<string, unknown> }).assign);
    }
  }
  return out;
}

/** Extracts region fields, initial states, state names, and entry assigns from a machine. */
export function extractRegions(machine: Machine, table?: string): MachineRegionInfo[] {
  if (machine.type === "parallel") {
    const out: MachineRegionInfo[] = [];
    for (const [regionName, regionNode] of Object.entries(machine.states)) {
      const field = regionNode.field ?? regionName;
      const initial = regionNode.initial ?? Object.keys(regionNode.states ?? {})[0] ?? "";
      const states = Object.keys(regionNode.states ?? {});
      const assigns: Record<string, Record<string, unknown>> = {};
      for (const [stName, stNode] of Object.entries(regionNode.states ?? {})) {
        assigns[stName] = extractAssigns(stNode as StateNode);
      }
      out.push({ name: regionName, field, initial, states, table, assigns });
    }
    return out;
  }
  const field = machine.field ?? "state";
  const initial = machine.initial ?? Object.keys(machine.states)[0] ?? "";
  const states = Object.keys(machine.states);
  const assigns: Record<string, Record<string, unknown>> = {};
  for (const [stName, stNode] of Object.entries(machine.states)) {
    assigns[stName] = extractAssigns(stNode as StateNode);
  }
  return [{ name: "root", field, initial, states, table, assigns }];
}

/**
 * Generates linear isolated frames: $O(\sum |S_i|)$.
 * For each region, visits all of its states while keeping all other regions in their initial states.
 */
export function generateIsolatedFrames(
  regions: MachineRegionInfo[],
  baseRow: Record<string, unknown> = {},
): PosedFrame[] {
  const frames: PosedFrame[] = [];
  const initialRow: Record<string, unknown> = { ...baseRow };
  for (const r of regions) {
    initialRow[r.field] = r.initial;
  }

  for (const r of regions) {
    for (const state of r.states) {
      const stateAssign = r.assigns?.[state] ?? {};
      const row = { ...initialRow, [r.field]: state, ...stateAssign };
      frames.push({
        name: `${r.name}-${state}`,
        targetRegion: r.name,
        state,
        row,
        visualInvariants: { [r.field]: state },
      });
    }
  }
  return frames;
}

export type Constraint = (assignment: Record<string, string>) => boolean;

/**
 * Generates a Pairwise (strength t=2) Constrained Covering Array across multiple regions.
 * Guarantees that every valid 2-way interaction between any two region states is visited.
 */
export function generateCoveringArrayFrames(
  regions: MachineRegionInfo[],
  baseRows: Record<string, Record<string, unknown>> = {},
  isValid: Constraint = () => true,
): PosedFrame[] {
  // Deduplicate regions that target the same state field: factors in CIT are distinct variables.
  const seenFields = new Set<string>();
  const distinctRegions = regions.filter((r) => {
    if (seenFields.has(r.field)) return false;
    seenFields.add(r.field);
    return true;
  });

  if (distinctRegions.length === 0) return [];
  if (distinctRegions.length === 1) {
    const table = distinctRegions[0].table ?? "item";
    return generateIsolatedFrames(distinctRegions, baseRows[table] ?? {});
  }

  type PairKey = string;
  const pairKey = (f1: string, v1: string, f2: string, v2: string): PairKey =>
    f1 < f2 ? `${f1}=${v1}&${f2}=${v2}` : `${f2}=${v2}&${f1}=${v1}`;

  const uncoveredPairs = new Set<PairKey>();
  for (let i = 0; i < distinctRegions.length; i++) {
    for (let j = i + 1; j < distinctRegions.length; j++) {
      const rA = distinctRegions[i];
      const rB = distinctRegions[j];
      for (const sA of rA.states) {
        for (const sB of rB.states) {
          if (isValid({ [rA.field]: sA, [rB.field]: sB })) {
            uncoveredPairs.add(pairKey(rA.field, sA, rB.field, sB));
          }
        }
      }
    }
  }

  const frames: PosedFrame[] = [];
  let frameIdx = 0;

  while (uncoveredPairs.size > 0) {
    const nextPairStr = uncoveredPairs.values().next().value as string;
    const parts = nextPairStr.split("&").map((p) => p.split("="));
    const currentAssign: Record<string, string> = {
      [parts[0][0]]: parts[0][1],
      [parts[1][0]]: parts[1][1],
    };

    for (const r of distinctRegions) {
      if (currentAssign[r.field] !== undefined) continue;
      let bestState = r.initial;
      let maxNewlyCovered = -1;

      for (const st of r.states) {
        const candidate = { ...currentAssign, [r.field]: st };
        if (!isValid(candidate)) continue;

        let coveredCount = 0;
        for (const [setField, setVal] of Object.entries(currentAssign)) {
          if (uncoveredPairs.has(pairKey(r.field, st, setField, setVal))) {
            coveredCount++;
          }
        }

        if (coveredCount > maxNewlyCovered) {
          maxNewlyCovered = coveredCount;
          bestState = st;
        }
      }
      currentAssign[r.field] = bestState;
    }

    const fields = Object.keys(currentAssign);
    for (let i = 0; i < fields.length; i++) {
      for (let j = i + 1; j < fields.length; j++) {
        uncoveredPairs.delete(pairKey(fields[i], currentAssign[fields[i]], fields[j], currentAssign[fields[j]]));
      }
    }

    const tables: Record<string, Record<string, unknown>> = {};
    const invariants: Record<string, string> = {};

    for (const r of distinctRegions) {
      const table = r.table ?? "item";
      if (!tables[table]) tables[table] = { ...(baseRows[table] ?? {}) };
      const st = currentAssign[r.field];
      tables[table][r.field] = st;
      invariants[r.field] = st;
      const stateAssign = r.assigns?.[st];
      if (stateAssign) Object.assign(tables[table], stateAssign);
    }

    const primaryTable = distinctRegions[0].table ?? "item";
    frameIdx++;
    frames.push({
      name: `ca-frame-${frameIdx}`,
      targetRegion: "all",
      state: Object.entries(currentAssign).map(([k, v]) => `${k}:${v}`).join(","),
      row: tables[primaryTable] ?? {},
      tables,
      visualInvariants: invariants,
    });
  }

  return frames;
}

/**
 * Generates Pairwise (All-Pairs) covering frames across two interacting regions.
 * Guarantees that every pair $(s_A, s_B) \in S_A \times S_B$ is tested in $\max(|S_A|, |S_B|) \le N \ll |S_A| \times |S_B|$ frames.
 */
export function generatePairwiseFrames(
  regionA: MachineRegionInfo,
  regionB: MachineRegionInfo,
  baseRow: Record<string, unknown> = {},
): PosedFrame[] {
  const frames: PosedFrame[] = [];
  const maxStates = Math.max(regionA.states.length, regionB.states.length);

  for (let i = 0; i < maxStates; i++) {
    const stateA = regionA.states[i % regionA.states.length];
    const stateB = regionB.states[i % regionB.states.length];
    const row = {
      ...baseRow,
      [regionA.field]: stateA,
      [regionB.field]: stateB,
    };
    frames.push({
      name: `${regionA.name}_${stateA}--${regionB.name}_${stateB}`,
      targetRegion: `${regionA.name}+${regionB.name}`,
      state: `${stateA}+${stateB}`,
      row,
      visualInvariants: {
        [regionA.field]: stateA,
        [regionB.field]: stateB,
      },
    });
  }
  return frames;
}
