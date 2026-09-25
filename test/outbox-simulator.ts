// Outbox simulation for mutation lifecycle testing: immediate ACKs, offline accumulation,
// server conflict refusals, and delayed acknowledgments.

export type OutboxMutation = {
  id: string;
  token: string;
  op: "insert" | "update" | "delete" | "upsert";
  entity: string;
  values: Record<string, unknown>;
  status: "pending" | "acked" | "refused";
  createdAt: number;
};

export type OutboxMode = "immediate" | "offline" | "refuse" | "delayed";

export type OutboxEvent =
  | { type: "sync_ack"; token: string; entity: string; id: string }
  | { type: "refused"; token: string; entity: string; id: string; reason: string };

export class OutboxSimulator {
  private queue: OutboxMutation[] = [];
  private tokenSeq = 0;
  private mode: OutboxMode = "immediate";
  private listeners = new Set<(event: OutboxEvent) => void>();

  constructor(initialMode: OutboxMode = "immediate") {
    this.mode = initialMode;
  }

  setMode(mode: OutboxMode): void {
    this.mode = mode;
  }

  getMode(): OutboxMode {
    return this.mode;
  }

  subscribe(listener: (event: OutboxEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private dispatch(event: OutboxEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  enqueue(op: OutboxMutation["op"], entity: string, values: Record<string, unknown>, id?: string): OutboxMutation {
    const mutationId = id ?? (values.id as string) ?? `mut-${++this.tokenSeq}`;
    const token = `tau-${++this.tokenSeq}`;
    const mutation: OutboxMutation = {
      id: mutationId,
      token,
      op,
      entity,
      values: { ...values },
      status: "pending",
      createdAt: Date.now(),
    };
    this.queue.push(mutation);

    if (this.mode === "immediate") {
      mutation.status = "acked";
      this.dispatch({ type: "sync_ack", token, entity, id: mutationId });
    } else if (this.mode === "refuse") {
      mutation.status = "refused";
      this.dispatch({ type: "refused", token, entity, id: mutationId, reason: "simulated_conflict" });
    }
    // "offline" and "delayed" keep status as "pending" until explicitly drained

    return mutation;
  }

  reconnect(): OutboxEvent[] {
    const events: OutboxEvent[] = [];
    for (const mutation of this.queue) {
      if (mutation.status === "pending") {
        mutation.status = "acked";
        const evt: OutboxEvent = { type: "sync_ack", token: mutation.token, entity: mutation.entity, id: mutation.id };
        events.push(evt);
        this.dispatch(evt);
      }
    }
    return events;
  }

  refusePending(reason = "server_refusal"): OutboxEvent[] {
    const events: OutboxEvent[] = [];
    for (const mutation of this.queue) {
      if (mutation.status === "pending") {
        mutation.status = "refused";
        const evt: OutboxEvent = { type: "refused", token: mutation.token, entity: mutation.entity, id: mutation.id, reason };
        events.push(evt);
        this.dispatch(evt);
      }
    }
    return events;
  }

  get pending(): readonly OutboxMutation[] {
    return this.queue.filter((m) => m.status === "pending");
  }

  get all(): readonly OutboxMutation[] {
    return this.queue;
  }

  clear(): void {
    this.queue.length = 0;
  }
}
