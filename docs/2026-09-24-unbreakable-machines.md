# Unbreakable Machines: Closed Effects, Statechart Lifecycles, and Model-Derived Proofs

Written on 2026-09-24 from the architecture conversation on extending omnishell
machines into a comprehensive, formally verified interaction model. Grounded in
[`2026-08-30-machines-not-widgets.md`](2026-08-30-machines-not-widgets.md) (the
XState-JSON data subset in CUE),
[`../../pronto/docs/2026-08-31-one-ladder-one-grammar.md`](../../pronto/docs/2026-08-31-one-ladder-one-grammar.md)
(the durability ladder, IVM, and derived events), and
[`2026-08-27-the-row-that-changed.md`](2026-08-27-the-row-that-changed.md)
(bounded transitions and commands in the return).

The forcing consumer is the favorite counter and pill toggle in
`apps/realworld` (and sibling flags across the 10 apps), whose current
implementation requires a probe region, two separate `<form>` tags, and sibling
CSS hacks to simulate a lifecycle the runtime never directly modeled.

---

## 1. Scope: Machines Now, Cortex Tomorrow

- **The Immediate Scope (Omnishell Machines)**:
  Extend the existing `#Machine` grammar in omnishell so that machines author the
  *complete* interaction and mutation lifecycle: user gestures, optimistic
  transitions, typed mutation effects, timeouts, conflict refusals, and CDC sync
  acknowledgments. No forms, no CSS probe hacks, no unmodeled transitions.
  Everything is verifiable and testable by construction.

- **The Horizon (Cortex)**:
  The macro machine substrate. The insight that **Statecharts + TEA + IVM +
  Streaming Joins + MapReduce** is the universal model for application
  computation. Spanning from frontend DOM gesture aggregation (joining a submit
  click with box text to reduce lowercase) to distributed backend compute (TF-IDF
  vectorization, stateful LLM reasoning nodes, and sharded TanStack DB nodes
  synced via Electric with polyglot streaming joins). The macro system that
  orchestrates these multi-node distributed statecharts will be named **Cortex**.
  The client-side execution unit within omnishell retains its focused name:
  **machines**.

---

## 2. Facts Not to Re-Derive

Measured from the codebase on 2026-09-24:

1. **The Form/Probe Contortion**: `apps/realworld/screens_pills.cue` and
   `plugins/omnishell/components/toggle-flag.cue` implement a toggle by emitting
   a read probe (`data-live="favorite"`), followed by two separate `<form>` tags
   (`when-unset` and `when-set`), toggled via sibling CSS
   (`.fav-probe:not(:empty) ~ .when-unset { display: none; }`). The actual state
   of the toggle exists in no single place—it is split across DOM markup, CSS
   rules, TanStack DB collections, and async CDC.
2. **Machines Were Artificially Restricted**: `2026-08-30-machines-not-widgets.md`
   restricted machine actions to "write the target state name into one field of
   the region's row" via `put`. Mutations affecting database tables were
   forbidden from machines and forced into `<form data-action="...">`.
3. **Purity Under SES**: Omnishell handlers run inside SES compartments with zero
   ambient authority (`terminal.cue`). No `fetch`, no timers, no `window`.
4. **Cascades are Depth-Bounded**: `screen.js` depth-bounds `then:` and `raise`
   delays centrally. The terminal owns the clock (`?tempo=`, `?clock=manual`).
5. **The Ladder Has One Write Algebra**:
   `{key, insert|update|delete, value|patch}` applies across Postgres, TanStack DB,
   and DOM reconciliation (`2026-08-31-one-ladder-one-grammar.md`).

---

## 3. The Core Unification: Machines and Mutations

### Why the Form/Machine Split Failed
Forms were initially chosen as the sole mutation path because progressive
enhancement HTML forms require zero JS. But for rich reactive UI (toggles,
optimistic counters, multistep wizards), a form is a blunt instrument:
- It has only two implicit states: idle and submitting (`data-submitting`).
- It cannot model timeouts (`after:`).
- It cannot coordinate optimistic rollbacks when CDC conflicts arrive.
- It cannot be verified by a model checker.

### The Resolution: A Form is Just a Machine; A Mutation is Just an Effect
In The Elm Architecture (TEA) and Harel Statecharts:
1. **A Form is a machine**: its context holds input values, its event is
   `input` or `submit`, and its transition emits a mutation effect.
2. **A Mutation is a pure effect descriptor**: a transition does not call an
   imperative API. It yields data:
   `{ op: "upsert", entity: "favorite", values: { ... } }`.
3. **CDC and Sync are incoming events**: the return path from Postgres (Electric
   LSN delta, write acknowledgment, or 409 unique constraint refusal) is
   delivered back to the machine as first-class events: `sync_ack`, `refused`.

---

## 4. The Safety Spectrum: Algebraic Properties of Effects

Arbitrary JavaScript callbacks `(params) => { ... }` cannot be verified,
rolled back, or safely replayed. Instead, effects are categorized into a **Safety
Spectrum** governed by algebraic axioms:

```
Purity / Safety ────────────────────────────────────────────────────────► Risk / Overhead
Level 0             Level 1              Level 2               Level 3              Level 4
Pure Projection     Ephemeral Store      Compensable Mutation  Non-Compensable WAL  Exterior World
(DOM attributes)    (Tab Memory)         (TanStack DB / RLS)   (Append-only sync)   (Stripe, gRPC)
```

| Level | Name | Mathematical Structure | Algebraic Guarantee | Runtime & Testing Consequence |
|---|---|---|---|---|
| **0** | **Pure Projection** | Category $\mathbf{Set}$ Morphisms | Determinism: $x_1 = x_2 \implies f(x_1) = f(x_2)$, $\Delta \text{World} = \emptyset$ | Evaluated synchronously in $O(1)$. 100% testable via property-based fuzzing. Zero mocks. |
| **1** | **Ephemeral State** | Monoid Action on Row | Bounded Depth: $k \le 1$. $\mathbf{AF}_{\le T}(\text{settled})$ | Local tab state. Fast LinkeDOM test coverage; verified deadlock-free. |
| **2** | **Compensable Mutation** | Optimistic Speculation + IVM Re-Fold | Monotonic Outbox: Speculative row dropped on `refused` | **Multi-user Safe Optimistic UI**. Rollback never uses blind local arithmetic ($e^{-1}$); it evicts the speculative outbox item and re-folds from TanStack DB. |
| **3** | **Distributed Sync** | Bounded Join-Semilattice $\langle S, \sqcup, \bot \rangle$ | CALM Theorem: Associative, Commutative, Idempotent ($a \sqcup a = a$) | **Coordination-Free Eventual Consistency**. Replaying outbox or out-of-order CDC streams converges deterministically. |
| **4** | **Exterior World** | Idempotency Space: $E \times \text{UUID} \to \text{Task}$ | At-least-once with exactly-once execution: $\text{exec}(e, \tau)^n = \text{exec}(e, \tau)$ | Requires idempotency tokens and explicit Saga compensation paths (no silent rollback). |

---

## 5. Statecharts vs. TEA: The "In-Between" Guarantees

Full Statecharts (SCXML) risk infinite livelocks via run-to-quiescence cascades
and undecidable termination via unbounded context. Pure TEA lacks explicit state
hierarchies, model-checking, and automatic lifecycle cancellation.

Omnishell adopts the **In-Between: Bounded Statecharts**:
1. **No Run-to-Quiescence**: internal event cascades (`raise`) are depth-bounded
   by the terminal (depth $\le 1$). Every step terminates in $O(1)$ time.
2. **Context is Closed Over the Row**: machine context *is* the row's schema.
   No unbounded heap allocations.
3. **Eliminating the Late-Ack Zombie via Hierarchical Pending States**:
   A local timer (`after: 3000`) **never rolls back a mutation**—that is a
   distributed systems fallacy. Only the server (`refused`) or the user (`cancel`)
   can terminate an inflight mutation.
   Instead, `after:` transitions to a nested substate: `favoriting.delayed`.
   The UI displays a degraded sync badge, but the parent state (`favoriting`)
   continues listening for `sync_ack`. When the late ACK arrives at 5200ms, it is
   caught cleanly.
4. **Sequence Clocks ($\tau$) for User Abort**:
   If the user explicitly clicks `cancel` while in `delayed`, the client mints a
   new generation $\tau + 1$. Any delayed response for $\tau$ arriving later is
   silently dropped by the sequence clock.
5. **Lifecycle-Bound Invocations**: exiting an intermediate state automatically
   aborts in-flight timers and speculative handlers.
6. **Parallel Regions & Disjoint Column Ownership**:
   `type: "parallel"` decomposes compound states into orthogonal sub-machines
   over the same entity row (e.g. concurrent hand progression and shout/hush
   negotiations in `apps/truco`). The interpreter unwraps parallel regions into
   independent statecharts sharing the row. `parallelLint` statically verifies
   that parallel regions hold mutually disjoint write columns, eliminating
   write-write races by construction.
7. **Final States & `onDone` Lifecycle Chaining**:
   Compound states declare `type: "final"`. Transitioning into a final state
   triggers the enclosing compound state's `onDone` transition, chaining
   lifecycles (such as hand completion triggering the round's next phase)
   without manual event dispatch.
8. **Relative Target Addressing**:
   Targets prefixed with `.` (e.g. `.v1` from within `phase`) resolve relative
   to their parent compound state, preserving local sub-chart encapsulation.

---

## 6. Model-Based Test Generation (Leaf-Scoped)

To prevent combinatorial state explosion ($S_1 \times S_2 \times \dots \times S_n$),
model-based testing is applied **strictly to isolated leaf machines** ($<10$ states),
where full Eulerian path traversal is guaranteed to complete in sub-millisecond time.

```
      Statechart Graph (CUE/JSON)
                 │
                 ▼
 ┌───────────────────────────────┐
 │ Graph Traversal Engine        │
 │ (Chinese Postman Algorithm)   │
 └───────────────┬───────────────┘
                 │
   ┌─────────────┼─────────────┐
   ▼             ▼             ▼
LinkeDOM    Playwright    Full-Stack
Unit Suite  Visual/Timer  CDC Sync
```

1. **States as Invariants**: Each vertex $v \in V$ defines verifiable DOM and
   row invariants (e.g. `data-state="favorited"` $\iff$ heart is solid, count is
   $N+1$).
2. **Chinese Postman Walk**: The walker (`test/walker.ts`) computes an Eulerian
   tour covering every transition edge, every refusal branch, and every timeout edge.
   Parallel statecharts are unwrapped into independent walkable projections, and
   `type: "final"` nodes chain automatically into parent `onDone` targets during traversal.
3. **Negative Edge Verification**: For every state, all unhandled events are
   fired to verify that state and rows remain strictly unmodified.
4. **Three Execution Tiers**:
   - **Tier 1 (LinkeDOM)**: Pure in-memory traversal with mocked effects. 100%
     branch coverage in $<50$ms.
   - **Tier 2 (Playwright / Storybook)**: Real browser timers, gesture cadence,
     and visual token verification.
   - **Tier 3 (Full-Stack)**: End-to-end integration through Postgres, Electric WAL
     streaming, and client LSN reconciliation.

---

## 7. Formal Verification (SPARK / SMT / Z3)

Because state is purely relational (no pointer aliasing) and handlers run under
SES without ambient IO, formal methods from **SPARK (Ada)** and **Dafny** are
directly practical using an SMT solver (Z3 via WASM):

1. **Inductive Invariant Checking**: Prove that an invariant (e.g.,
   `favorite_count >= 0`) holds across all reachable states and transitions
   under any permutation of clicks and refusals.
2. **Dead-Code / Contradiction Elimination**: Prove that all guard conditions
   $g(state, event)$ are satisfiable (`SAT`). Any guard proved `UNSAT` is flagged
   as a vet error.
3. **Guard Disjointness and Completeness**: Prove that ordered guard candidates
   cover the entire input domain without unintended fall-through.

---

## 8. Case Study: The Unbreakable Favorite Counter

### Unified CUE Machine Definition
```cue
#FavoriteMachine: {
	field:   "state"
	initial: "unfavorited"
	context: {
		count:     int
		favorited: bool
		token:     string
	}
	states: {
		unfavorited: {
			on: {
				click: {
					target: "favoriting"
					assign: {count: "inc", favorited: true, token: "uuid"}
					effect: {
						level:  2
						op:     "upsert"
						entity: "favorite"
						token:  "{token}"
						values: {article_id: "{id}", deleted_at: null}
					}
				}
			}
		}
		favoriting: {
			initial: "inflight"
			on: {
				sync_ack: {target: "favorited"}
				refused: {
					// Speculative row dropped; IVM re-folds authoritative count from TanStack DB
					target: "unfavorited"
				}
			}
			states: {
				inflight: {
					after: {
						3000: "delayed"
					}
				}
				delayed: {
					// Heart stays filled; data-delayed applied for subtle pulse/spinner
					on: {
						cancel: {
							// State exit bumps sequence generation; inflight mutation is aborted
							target: "#FavoriteMachine.unfavorited"
						}
					}
				}
			}
		}
		favorited: {
			on: {
				click: {
					target: "unfavoriting"
					assign: {count: "dec", favorited: false, token: "uuid"}
					effect: {
						level:  2
						op:     "upsert"
						entity: "favorite"
						token:  "{token}"
						values: {article_id: "{id}", deleted_at: "{now}"}
					}
				}
			}
		}
		unfavoriting: {
			initial: "inflight"
			on: {
				sync_ack: {target: "unfavorited"}
				refused: {
					target: "favorited"
				}
			}
			states: {
				inflight: {
					after: {
						3000: "delayed"
					}
				}
				delayed: {
					on: {
						cancel: {
							target: "#FavoriteMachine.favorited"
						}
					}
				}
			}
		}
	}
}
```

### Emitted Markup
Replaces the read probe and two `<form>` tags with a single semantic button:
```html
<button class="pill role-meta-sm"
        data-live="favorite"
        data-filter="article_id=eq.{id}"
        data-machine='{"field":"state", ...}'
        data-state="{state}">
  <span class="heart" aria-hidden="true">{state == 'favorited' ? '♥' : '♡'}</span>
  <span class="count" data-text="{count}">0</span>
</button>
```

---

## 9. Phased Task List

### Phase 1: Machine Grammar & Interpreter Extensions
- [x] **Extend `#Machine` in `plugins/omnishell/machine.cue`**:
  - [x] Add nested hierarchical states (`states:` inside a state).
  - [x] Add parallel statecharts (`type: "parallel"`) with orthogonal sub-regions.
  - [x] Add final states (`type: "final"`) and compound `onDone` transitions.
  - [x] Add root-level transitions (`always`, `after`, `onDone`, `entry`, `exit`).
  - [x] Add relative sub-state target resolution (`.substate`).
  - [ ] Add `effect:` to transition candidate grammar (Level 1–4 schema).
  - [ ] Add generation tokens $\tau$ (`token: string`) to machine context.
- [x] **Static Verification & Linting (`check-machines.ts`, `interpreter/lint.ts`)**:
  - [x] Unroll parallel statecharts into orthogonal region projections.
  - [x] Implement `parallelLint` ensuring parallel regions hold mutually disjoint write columns.
- [x] **Model-Based Traversal (`test/walker.ts`)**:
  - [x] Eulerian Chinese Postman tour covering compound hierarchies, relative targets, and `onDone` edges.
- [ ] **Update Omnishell Interpreter (`plugins/omnishell/interpreter/screen.js`)**:
  - Intercept transition `effect:` objects and execute them through the terminal's
    existing `store` / `executeMutation` pipeline with outbox tokens.
  - Listen for store write outcomes and inject `sync_ack` or `refused` events
    back into the region's active machine state.
  - Implement IVM re-fold upon `refused` (evicting the speculative outbox item
    and allowing the region to re-read authoritative state from TanStack DB).

### Phase 2: Component & Screen Migrations
- [ ] **Refactor `plugins/omnishell/components/toggle-flag.cue`**:
  - Replace probe + dual `<form>` markup emission with the `#ToggleMachine`.
- [ ] **Migrate `apps/realworld`**:
  - Update `apps/realworld/screens_pills.cue` to use the unified machine.
  - Remove `.fav-probe ~ .when-unset` sibling selectors from CSS.
  - Verify zero visual or functional regression across all 10 RealWorld screens.

### Phase 3: Model-Based Test Generator (Leaf-Scoped)
- [ ] **Build `plugins/omnishell/test/mbt-generator.ts`**:
  - Read declared machine JSON from screen markup or CUE specs.
  - Compute Eulerian trails visiting all leaf states, transitions, refusals, and timeouts.
  - Emit Deno test cases targeting `LinkeDOM` harness.
- [ ] **Wire into `just sayt -d apps/realworld integrate`**:
  - Ensure the auto-derived test suite runs during integration and validates 100%
    branch coverage of all leaf statecharts.

### Phase 4: SMT Verification (Z3 Checker)
- [ ] **Create `plugins/omnishell/verify/machine-prover.ts`**:
  - Encode machine transitions, guards, and invariants into SMT-LIB constraints.
  - Run Z3 to statically prove absence of dead transitions, guard exhaustiveness,
    and inductive invariant preservation.

---

## 10. Cortex: Backend IVM, Sharding, and Placement Substrate

Cortex extends the same mathematical model (Statecharts + TEA + IVM) from the UI
rung to backend distributed streaming computations (e.g. TF-IDF, live aggregates,
and stateful reasoning nodes).

### Dapr Placement Infrastructure Analysis
- **Does `dapr-placement` require Redis? NO.**
  The Dapr placement service is a standalone Go daemon that maintains its consistent
  hash ring via an **internal in-memory Raft consensus group** (using HashiCorp Raft).
  It requires zero external storage backends.
- **What if Dapr needs state?**
  If Dapr actor reminders, locks, or workflow metadata require persistence, Dapr
  has first-class native support for **PostgreSQL** (`state.postgresql`). Since
  Postgres is already our primary cluster database, no Redis is introduced.
- **Alternatives to Dapr for Shard Placement**:
  1. **Postgres Advisory Leases (Zero Extra Infra)**: Worker pods claim leases on
     shard IDs via `pg_try_advisory_xact_lock(shard_id)` on a heartbeat table. If a
     pod dies, the lock releases instantly and a peer claims the shard.
  2. **K8s StatefulSet Ordinals**: Pods receive deterministic ordinals (`shard-0`,
     `shard-1`) with a headless service, using Jump Consistent Hashing.
  3. **Caddy Reverse Proxy Hashing**: Caddy (already vendored in Pronto) supports
     `lb_policy consistent_hashing {header.X-Partition-Key}` for L7 request routing.

### The Backend Shard Node
1. **Co-located Streaming Joins**:
   Both sides of a join ($R \bowtie S$) are partitioned by the join key `k`
   (`hash(k) % N == p`). Shard $p$ subscribes to Electric shapes filtered by
   `where: "hash(k) % N = p"`. Because all records for key `k` reside on the same
   shard, streaming joins run **100% locally in RAM** inside TanStack DB / d2ts
   without cross-node network shuffles.
2. **Operationally Stateless**:
   Nodes maintain state in memory during runtime, but do not manage persistent
   disks. On crash or re-placement, a replacement node connects to Electric and
   replays from the last acknowledged LSN.

---

## 11. Adversarial Critique: The 4 Backend Pitfalls

While the local IVM model is elegant, moving to distributed backend streaming
introduces four well-known physical hazards that must be designed for:

### 1. The Cold-Start / Resharding Snapshot Problem
- **The Pitfall**: An in-memory IVM node cannot replay 3 years of raw WAL deltas
  from LSN 0 when spinning up or when scaling from $N$ to $N+1$ shards.
- **The Defense**: Electric's hybrid bootstrap. A new shard does not stream from
  time zero; it receives a point-in-time relational table snapshot (from Postgres)
  at LSN $L_0$, initializes its in-memory TanStack DB collection, and then streams
  LSN deltas starting from $L_0$.

### 2. The Skewed Hotspot Trap ("The Justin Bieber Problem")
- **The Pitfall**: In partition-by-join-key hashing, if a single entity (a viral
  article or high-frequency user) receives 90% of all activity, that key hashes to
  a single shard. That shard OOMs and saturates CPU, while other shards sit idle.
- **The Defense**: Two-phase commutative aggregation. Additive operations (counts,
  sums, TF-IDF term frequencies) form abelian groups. Shards perform local
  pre-aggregation over arbitrary micro-batches, and a downstream combiner joins
  the reduced partial sums.

### 3. RAM Ceilings and Out-of-Core Memory Pressure
- **The Pitfall**: Browser TanStack DB holds megabytes. A backend table with 200
  million rows will exceed node RAM and crash with an OOM killer.
- **The Defense**: Tiered backing stores. For small live working sets, d2ts runs
  in-memory. For large tables, d2ts must back onto a page-buffered local engine
  (e.g., embedded DuckDB or RocksDB paging, identical to Feldera's design) to
  spill cold historical relations to local NVMe storage.

### 4. CDC Backpressure and Postgres Replication Slot Bloat
- **The Pitfall**: If a shard pauses (heavy GC pause or slow external gRPC call),
  it stops reading the Electric stream. Postgres WAL replication slots retain
  unconsumed transaction logs, rapidly consuming host disk space.
- **The Defense**: Non-blocking stream buffers and dead-letter outboxes. If an
  outbound effect slows down, the IVM engine decouples ingestion from effect
  dispatch, preventing slow consumers from blocking Postgres WAL truncation.
