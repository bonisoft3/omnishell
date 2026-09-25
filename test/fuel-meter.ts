// Deterministic fuel metering for automated tests, replacing wall-clock timeouts
// with machine-independent abstract operation cost accounting.

export type EffectLevel =
  | "projection"
  | "ephemeral"
  | "compensable"
  | "replicated"
  | "exterior"
  | 0
  | 1
  | 2
  | 3
  | 4;

export const LEVEL_FUEL_COST: Record<string | number, number> = {
  projection: 1,
  0: 1,
  ephemeral: 10,
  1: 10,
  compensable: 50,
  2: 50,
  replicated: 100,
  3: 100,
  exterior: 250,
  4: 250,
};

export type FuelBudget = {
  limit: number;
  fireCost?: number;
  transitionCost?: number;
  mutationCost?: number;
  waitMsCost?: number;
  jessieCost?: number;
};

export class FuelLimitExceededError extends RangeError {
  constructor(
    public readonly spent: number,
    public readonly limit: number,
    public readonly lastAction?: string,
  ) {
    super(`Test fuel limit exceeded: burned ${spent} steps (limit: ${limit})${lastAction ? ` — at ${lastAction}` : ""}`);
    this.name = "FuelLimitExceededError";
  }
}

export class FuelMeter {
  readonly limit: number;
  private spent = 0;
  private readonly costs: Required<Omit<FuelBudget, "limit">>;
  private readonly history: { action: string; cost: number; total: number; detail?: string }[] = [];

  constructor(budget: FuelBudget) {
    this.limit = budget.limit;
    this.costs = {
      fireCost: budget.fireCost ?? 10,
      transitionCost: budget.transitionCost ?? 50,
      mutationCost: budget.mutationCost ?? 50,
      waitMsCost: budget.waitMsCost ?? 1,
      jessieCost: budget.jessieCost ?? 1,
    };
  }

  spend(category: "fire" | "transition" | "mutation" | "wait" | "jessie", amount = 1, detail?: string): number {
    const unitCost = category === "fire"
      ? this.costs.fireCost
      : category === "transition"
      ? this.costs.transitionCost
      : category === "mutation"
      ? this.costs.mutationCost
      : category === "wait"
      ? this.costs.waitMsCost
      : this.costs.jessieCost;

    const cost = unitCost * amount;
    this.spent += cost;
    this.history.push({ action: category, cost, total: this.spent, detail });

    if (this.spent > this.limit) {
      const recent = this.history.slice(-3).map((h) => `${h.action}(+${h.cost})${h.detail ? `[${h.detail}]` : ""}`).join(" -> ");
      throw new FuelLimitExceededError(this.spent, this.limit, recent);
    }
    return this.spent;
  }

  spendEffect(level: EffectLevel, amount = 1, detail?: string): number {
    const unitCost = LEVEL_FUEL_COST[level] ?? this.costs.mutationCost;
    const cost = unitCost * amount;
    this.spent += cost;
    this.history.push({ action: `effect:${level}`, cost, total: this.spent, detail });

    if (this.spent > this.limit) {
      const recent = this.history.slice(-3).map((h) => `${h.action}(+${h.cost})${h.detail ? `[${h.detail}]` : ""}`).join(" -> ");
      throw new FuelLimitExceededError(this.spent, this.limit, recent);
    }
    return this.spent;
  }

  get current(): number {
    return this.spent;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.spent);
  }

  get log(): readonly { action: string; cost: number; total: number; detail?: string }[] {
    return this.history;
  }

  reset(): void {
    this.spent = 0;
    this.history.length = 0;
  }
}
