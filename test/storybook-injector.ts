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
  dynamicAssigns?: Record<string, string[]>;
};

function splitAssignRecord(
  assignObj: Record<string, unknown>,
  literals: Record<string, unknown>,
  dynamic: Set<string>,
) {
  for (const [k, v] of Object.entries(assignObj)) {
    if (v !== null && typeof v === "object") {
      dynamic.add(k);
    } else if (!(k in literals)) {
      literals[k] = v;
    }
  }
}

function collectActionAssigns(
  raw: unknown,
  literals: Record<string, unknown>,
  dynamic: Set<string>,
) {
  const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const a = (item as { assign?: unknown }).assign;
    if (a && typeof a === "object") {
      splitAssignRecord(a as Record<string, unknown>, literals, dynamic);
    }
    const actions = (item as { actions?: unknown }).actions;
    if (actions) collectActionAssigns(actions, literals, dynamic);
  }
}

function extractRegionAssigns(
  containerNode: { on?: Record<string, unknown>; states?: Record<string, StateNode> },
): {
  assigns: Record<string, Record<string, unknown>>;
  dynamicAssigns: Record<string, string[]>;
} {
  const assigns: Record<string, Record<string, unknown>> = {};
  const dynamicSets: Record<string, Set<string>> = {};
  const states = containerNode.states ?? {};

  for (const [stName, stNode] of Object.entries(states)) {
    assigns[stName] = {};
    dynamicSets[stName] = new Set<string>();
    collectActionAssigns(stNode.entry, assigns[stName], dynamicSets[stName]);
  }

  const collectTransitions = (onMap?: Record<string, unknown>) => {
    if (!onMap || typeof onMap !== "object") return;
    for (const raw of Object.values(onMap)) {
      const list = Array.isArray(raw) ? raw : [raw];
      for (const t of list) {
        if (!t || typeof t !== "object") continue;
        const target = typeof (t as { target?: unknown }).target === "string"
          ? ((t as { target: string }).target.split(".").pop() ?? "")
          : "";
        if (target && target in assigns) {
          collectActionAssigns(t, assigns[target], dynamicSets[target]);
        }
      }
    }
  };

  collectTransitions(containerNode.on);
  for (const stNode of Object.values(states)) {
    collectTransitions(stNode.on);
  }

  const dynamicAssigns: Record<string, string[]> = {};
  for (const [stName, set] of Object.entries(dynamicSets)) {
    if (set.size > 0) dynamicAssigns[stName] = [...set];
  }
  return { assigns, dynamicAssigns };
}

export function extractRegions(machine: Machine, table?: string): MachineRegionInfo[] {
  if (machine.type === "parallel") {
    const out: MachineRegionInfo[] = [];
    for (const [regionName, regionNode] of Object.entries(machine.states)) {
      const field = regionNode.field ?? regionName;
      const initial = regionNode.initial ?? Object.keys(regionNode.states ?? {})[0] ?? "";
      const states = Object.keys(regionNode.states ?? {});
      const { assigns, dynamicAssigns } = extractRegionAssigns(regionNode);
      out.push({ name: regionName, field, initial, states, table, assigns, dynamicAssigns });
    }
    return out;
  }
  const field = machine.field ?? "state";
  const initial = machine.initial ?? Object.keys(machine.states)[0] ?? "";
  const states = Object.keys(machine.states);
  const { assigns, dynamicAssigns } = extractRegionAssigns(machine);
  return [{ name: "root", field, initial, states, table, assigns, dynamicAssigns }];
}

export type Constraint = (assignment: Record<string, string>) => boolean;

/**
 * When a region's transitions pin another region's field to a literal in some states
 * and delegate that field to a dynamic handler in others, the literal values partition
 * the two regions' valid state combinations.
 */
function deriveAssignConstraint(regions: MachineRegionInfo[]): Constraint {
  type Rule = {
    sourceField: string;
    targetField: string;
    literalByState: Map<string, string>;
    dynamicStates: Set<string>;
    pinnedValues: Set<string>;
  };
  const rules: Rule[] = [];
  const regionFields = new Set(regions.map((r) => r.field));

  for (const r of regions) {
    for (const targetField of regionFields) {
      if (targetField === r.field) continue;
      const literalByState = new Map<string, string>();
      const dynamicStates = new Set<string>();
      const pinnedValues = new Set<string>();

      for (const st of r.states) {
        const lit = r.assigns?.[st]?.[targetField];
        if (lit !== undefined) {
          const str = String(lit);
          literalByState.set(st, str);
          pinnedValues.add(str);
        }
        if (r.dynamicAssigns?.[st]?.includes(targetField)) {
          dynamicStates.add(st);
        }
      }

      if (literalByState.size > 0 && dynamicStates.size > 0) {
        rules.push({ sourceField: r.field, targetField, literalByState, dynamicStates, pinnedValues });
      }
    }
  }

  if (rules.length === 0) return () => true;

  return (assignment: Record<string, string>) => {
    for (const rule of rules) {
      const sVal = assignment[rule.sourceField];
      const tVal = assignment[rule.targetField];
      if (sVal === undefined || tVal === undefined) continue;
      const requiredLiteral = rule.literalByState.get(sVal);
      if (requiredLiteral !== undefined && tVal !== requiredLiteral) return false;
      if (rule.dynamicStates.has(sVal) && rule.pinnedValues.has(tVal)) return false;
    }
    return true;
  };
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
  const valid = deriveAssignConstraint(regions);
  const initialStates: Record<string, string> = {};
  for (const r of regions) {
    initialStates[r.field] = r.initial;
  }

  for (const r of regions) {
    for (const state of r.states) {
      const stateAssign = r.assigns?.[state] ?? {};
      const row: Record<string, unknown> = { ...baseRow, ...initialStates, ...stateAssign, [r.field]: state };
      for (const other of regions) {
        if (other.field === r.field) continue;
        const curOther = String(row[other.field] ?? other.initial);
        if (!valid({ [r.field]: state, [other.field]: curOther })) {
          const compatible = other.states.find((s) => valid({ [r.field]: state, [other.field]: s }));
          if (compatible !== undefined) {
            Object.assign(row, other.assigns?.[compatible] ?? {}, stateAssign);
            row[other.field] = compatible;
            row[r.field] = state;
          }
        }
      }
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

  const derivedValid = deriveAssignConstraint(distinctRegions);
  const valid: Constraint = (a) => derivedValid(a) && isValid(a);

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
          if (valid({ [rA.field]: sA, [rB.field]: sB })) {
            uncoveredPairs.add(pairKey(rA.field, sA, rB.field, sB));
          }
        }
      }
    }
  }

  const frames: PosedFrame[] = [];

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
        if (!valid(candidate)) continue;

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
      const stateAssign = r.assigns?.[st];
      if (stateAssign) Object.assign(tables[table], stateAssign);
    }
    for (const r of distinctRegions) {
      const table = r.table ?? "item";
      const st = currentAssign[r.field];
      tables[table][r.field] = st;
      invariants[r.field] = st;
    }

    const primaryTable = distinctRegions[0].table ?? "item";
    frames.push({
      name: "",
      targetRegion: "all",
      state: distinctRegions.map((r) => `${r.field}:${currentAssign[r.field]}`).join(","),
      row: tables[primaryTable] ?? {},
      tables,
      visualInvariants: invariants,
    });
  }

  frames.sort((a, b) => {
    for (const r of distinctRegions) {
      const cmp = (a.visualInvariants[r.field] ?? "").localeCompare(b.visualInvariants[r.field] ?? "");
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
  for (let i = 0; i < frames.length; i++) {
    frames[i].name = `ca-frame-${i + 1}`;
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
