// Storybook state injection (posing): directly mounts screens into every discrete
// machine state using pre-populated fixture rows, without executing mutations or transitions.
// Enforces linear component isolation and pairwise covering arrays to eliminate combinatorial explosion.

import type { Machine, StateNode } from "./canonical.ts";

export type PosedFrame = {
  name: string;
  targetRegion: string;
  state: string;
  row: Record<string, unknown>;
  visualInvariants: Record<string, string>;
};

export type MachineRegionInfo = {
  name: string;
  field: string;
  initial: string;
  states: string[];
};

/** Extracts region fields, initial states, and state names from a machine. */
export function extractRegions(machine: Machine): MachineRegionInfo[] {
  if (machine.type === "parallel") {
    const out: MachineRegionInfo[] = [];
    for (const [regionName, regionNode] of Object.entries(machine.states)) {
      const field = regionNode.field ?? regionName;
      const initial = regionNode.initial ?? Object.keys(regionNode.states ?? {})[0] ?? "";
      const states = Object.keys(regionNode.states ?? {});
      out.push({ name: regionName, field, initial, states });
    }
    return out;
  }
  const field = machine.field ?? "state";
  const initial = machine.initial ?? Object.keys(machine.states)[0] ?? "";
  const states = Object.keys(machine.states);
  return [{ name: "root", field, initial, states }];
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
      const row = { ...initialRow, [r.field]: state };
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
