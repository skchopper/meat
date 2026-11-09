# MEAT — Mortality Engineered Auto-Trading

*Mortality Engineering for trading agents.*

A multi-agent trading system on Alpaca, built from the theory in
*"I Built an AI That Dies If It Stops Making Money"* (Mortality Engineering).

This is **not** an AI that stops trading when the market moves against it — it is a
population of trading strategies where the unprofitable **die**, the profitable
**reproduce**, and every death leaves a structured record that the living read.

---

## 1. The three rules of Mortality Engineering, applied to trading

| Article rule | Trading implementation |
|---|---|
| Existence costs money, and the agent sees it (runway, not balance) | Every agent (strategy instance) has an endowment in USD carved from the Alpaca account. Each cycle charges real costs: market-data calls, inference per role, hosting. What the agent sees is `runwayHours = (equity - deathFloor) / burnPerHour`, never its raw balance. |
| The death condition lives outside the agent | `REAPER` runs as a **separate OS process** (`src/reaper-process.js`), reads the broker and the persisted registry/ledger directly, liquidates and kills. No engine/agent code path can call, disable, or reschedule it. |
| Death produces data | Every death appends one JSONL obituary (genome, P&L, lifespan, cause, first-profit timestamp, mutation). Children inherit a `lessonsFor(genome)` digest, not the parent's code. |

**Where trading differs from the article, honestly:**

- The article's agents earn *service revenue* in dollars; a trading agent earns
  *return on capital*. So the article's cost burn (inference) is a slow tide here,
  while **risk-of-ruin events (drawdown, daily loss) are the fast killers**.
  Both are implemented; both are reported separately.
- Alpaca has no sub-accounts and no scoped API keys. Per-agent equity is therefore
  **bookkeeping** (broker fills + our ledger) reconciled against broker account
  equity every cycle. All real orders still hit the same account. This limitation
  is enforced as a brake: allocation can never exceed `allocationCapPct` of account
  equity, and a reconciliation mismatch halts new orders.
- The article bars its agents from trading so they earn by service. Here trading
  *is* the business, so the equivalent internal red line is enforced: no leverage,
  no margin, no shorting, no options, no transfers/withdrawals, no trading outside
  the configured session, and no discretion beyond the Treasurer's mandate.

---

## 2. Anatomy: six roles, and the stopline on each

The rule everything derives from: **no role can both make the decision and press the button.**

| Role | Owns | Stopline (code-enforced) | Module |
|---|---|---|---|
| **TREASURER** | Broker account equity, runway, burn, per-agent mandates, alive/dead verdicts | Never places an order. Never earns. Only role that reads account equity. | `src/treasurer.js` |
| **PROSPECTOR** | Demand discovery from market data: hypotheses with **dated proof** | Never places an order, never sizes, never writes a strategy spec. "A link or nothing." | `src/prospector.js` |
| **BUILDER** | Compiles a hypothesis into an executable StrategySpec | Never picks the symbol, never sets notional/price, never repairs upstream work — rejects it. Spends ≤ 40% of cycle budget. | `src/builder.js` |
| **SELLER / EXECUTOR** | Order placement, exits, fill attribution | Never reads account equity or cash. Allowed only `submitOrder`/`cancelOrder`/`getOrders` + its own position book; every order passes the brakes. | `src/executor.js` |
| **REPLICATOR** | Spawning a child = parent genome + exactly one mutation + obituary lessons | Never computes surplus and never decides whether it may spawn — the Treasurer gate decides. | `src/replicator.js` |
| **REAPER** | Executing death: cancel orders, liquidate, sweep residual, write obituary | Lives outside the engine process, agent cannot switch it off, `grace_seconds = 0`. | `src/reaper.js`, `src/reaper-process.js` |

Cycle flow (every `cycleIntervalSec`):

```
TREASURER.tick() ──> state, cycleBudget, mandates, mayReplicate, verdicts
      │
      ├──> PROSPECTOR.run(budget) ──> hypotheses (dated proof required)
      │        └──> BUILDER.compile() ──> StrategySpec (or reject)
      │                 └──> EXECUTOR.run(agent, spec, mandate, quotes) ──> orders (brakes first)
      │
      ├──> REPLICATOR.spawn(parent)   only if mayReplicate === true and under population cap
      │
      └──> (separate process, every reaperIntervalSec)
               REAPER.sweep() ──> liquidate + obituary + residual sweep
```

Why exactly six: four dangerous capabilities (`spend`, `trade`, `create`, `kill`) each
sit in a different chair from the reasoning that wants them; plus two roles that feed
them without touching money. A role must pay for its own inference — a seventh role
would be a named rejection nothing else performs, or it is a line item on the bill.
(Per-role costs are attributed in the ledger, so this is measurable, not rhetorical.)

### The research sidecar (advisory, isolated per agent)

A per-agent news analyst sits **beside** the six roles, never as a seventh decision
authority: it may only *advise* the Executor. Each living agent gets its own isolated LLM
call (hourly by default) whose context contains exactly that agent's genome, spec, virtual
book, news for its own symbols, and its own previous briefings — no other agent's book, no
other role's memory, no shared conversation. Briefings are persisted per agent in
`automaton-data/research/<agentId>.jsonl`.

The advisory outputs are `sentiment`, `confidence`, `verdict` (`HOLD`/`AVOID`/`ALERT`),
`catalysts`, `risks`, `summary`, `sources`. The Executor applies them only when
`research.enabled && research.influence` and the briefing is fresh (`maxAgeSec`): a veto on
new entries (recorded as `research_veto`, never a brake), a **size multiplier that can only
shrink** orders, and an `research_alert` exit pressure on held positions. Every order still
passes the full brake wall; the analyst has no order tool, no wallet access and no equality
with a role.

Economics: each successful briefing is charged to that agent's own ledger
(category `research`, role `prospector`) at `research.costPerRunUsd` (~$0.001). The bill
therefore shortens runway exactly like real inference does — research that does not pay for
itself kills the agent that bought it. Full contract: `docs/RESEARCH.md`.

### The per-bot agent brain (isolated decision support)

Every bot is also its own agent in a second, stronger sense: on its own cadence (day bots ~5 min,
swing bots hourly) it receives a **private review** whose context is only its identity/genome/spec,
its virtual book, market data for its symbol, its own research briefing and its own earlier reviews.
The review is written to `automaton-data/agents/<agentId>.jsonl` and returns a validated policy:
`stance` (`trade`/`cautious`/`stand_down`), a size multiplier (0.2–1, only shrinks), an exit-pressure
flag, confidence, thesis and plan. The Executor consumes the fresh policy next cycle: stand-down
blocks new entries (exits still fire), size shrinks entries before every cap, exit pressure forces a
position exit after any research ALERT. Execution and the 18 hard brakes remain deterministic so
minute-level reactions never wait on a model turn — the bot agent is the persistent "brain", the
executor is the reflex. Reviews are charged to the bot (category `agent`) and survive restarts.
Full contract: `docs/BOT-AGENTS.md`.

**Strategy classes.** Momentum/mean-reversion bots are swing/mid-long (1-hour lane); breakout/gap-fade
bots are day/intraday (1-minute lane). The tier is derived from the strategy family, replication
inherits it from the mutated child genome, and genesis mixes a new population by
`strategyMix.dayPct` (live profile 70% day / 30% swing). Status exposes the taxonomy per agent and a
population `strategyMix` for the panel's category tabs.

### Multi-symbol portfolio bots and live analytics (v3.2)

Each bot manages a **basket of companies** (4 symbols for day bots, 3 for swing bots; the genome
carries `symbols` and the registry caches one compiled strategy spec per symbol in `agent.specIds`).
The orchestrator compiles/reuses coherent per-symbol specs, the portfolio executor evaluates every
basket symbol, manages all held positions with that symbol's stop/target/max-hold rules and enforces
tier caps (`maxOpenPositionsDay/Swing`, `maxOrdersPerCycle`) under the same 18-brake wall. Baskets and
the 70/30 mix migrate once on start without touching ids/ledgers/history. A read-only
`marketView()` combines multi-symbol broker snapshots, 1-minute sparklines, portfolio/agent equity and
an equity history for the Host's loopback `GET /automaton/market` route; the control panel renders it
as a live Google-Analytics-style dashboard (KPIs, SVG charts, market tape with price flashes, basket
and live-P&L agent rows). Contract: `docs/PORTFOLIO-ANALYTICS.md`; operations: `docs/RUNBOOK.md` §8f.

### Multi-instrument execution (v3.0)

The population may express a strategy through more than long stock: **short stock, long calls/puts,
covered calls and defined-risk vertical spreads**, with **margin** enabled inside hard caps. The
instrument is chosen by the bot's own agent (`policy.instrument`) or its deterministic family
playbook; the executor picks expiry/strikes within the DTE window, sizes by option-premium budget
(35% of equity / $30 per order / mandate cap), and falls back to stock/short when options do not fit.
Covered calls require 100 owned shares (rare at $50/bot, and denied without them); naked short
options are never constructed and are denied by the brake wall. Every order is checked by brakes
D2/D15–D18 (instrument permission, short sale, options structure/premium/DTE, margin debt,
expiry guard) and booked into the signed/multi-asset ledger (option multiplier 100, spread groupId).
On death the Reaper liquidates signed stock, options and spread legs before settling the estate.
Full contract: `docs/INSTRUMENTS.md`; operations: `docs/RUNBOOK.md` §8d.

---

## 3. Metabolism, runway, death

```
burnPerHour = hostingPerHour
            + (inferencePerCycleUsd + dataPerCycleUsd) * cyclesLastHour
            + committedMonthlyUsd / 730

runwayHours = max(0, (equityUsd - deathFloorUsd) / burnPerHour)
deathFloorUsd = max(deathFloorUsd, deathFloorPct * endowmentUsd)   // cost of the next step
```

Treasury states and the physical thinking budget (panic encoded in economics, not prompt):

| State | Runway | Cycle budget |
|---|---|---|
| `STABLE` | ≥ 24 h | `$0.08` |
| `TIGHT` | 6–24 h | `$0.03` |
| `CRITICAL` | < 6 h | `$0.01` |
| `DEAD` | equity ≤ death floor | — |

Death causes (all evaluated by the Treasurer, executed by the Reaper):

1. `insufficient_funds` — equity ≤ death floor (article's rule).
2. `drawdown_limit` — equity ≤ endowment × (1 − `maxDrawdownPct`) (trading risk-of-ruin).
3. `daily_loss_limit` — day P&L ≤ −`maxDailyLossPct` × day-start equity (persisted in
   `day-stats.json`, re-derived by the Reaper).
4. `account_not_active` — the broker account is not `ACTIVE` (re-derived from the broker).
5. `reconciliation_mismatch` / `risk_breach` — engine-policy halts (fatal for a birth that
   cannot be funded; a reconciliation mismatch blocks new orders rather than killing agents).

The engine writes a **death verdict**; the Reaper independently re-derives the death from broker
state (and the persisted day-P&L record) before executing. A verdict is a request, not an
execution.

---

## 4. Replication: the child inherits the journal, not the code

Gates (all must hold, checked by the Treasurer, executed by the Replicator):

```
net7dUsd            >= replication.surplus7dUsd
runwayHours         >= replication.minRunwayHours (72 h)
population          <  populationCap
parentEquityUsd - childEndowmentUsd >= deathFloorUsd * 2
```

Child = parent genome + **exactly one** mutation from `MUTABLE` (symbol, family,
lookback, entryZ, exitZ, stopPct, targetPct, maxHoldBars, sizePct, sessionFilter) +
`lessonsFor(genome, limit=20)` digest. One mutation, because changing several at once
makes the population learn nothing.

**Simulation caveat.** In `mode=sim` the synthetic broker lives inside the engine process, so a
separate Reaper would read a different (empty) account and could kill for the wrong reasons.
Sim mode therefore executes its own verdicts in-process (`trace.deathsExecuted`) and the
external `reaper-process.js` refuses to run against a sim state directory. The
"death must execute outside the agent" rule applies to `paper` and `live`, where a separate
OS process with real broker credentials does the killing.

**Operator view, not agent capability.** Agent records carry a strategy-derived display `name`
(`"Momentum AAPL"`, `"MeanRev NVDA"`, unique, persisted at birth and inherited by obituaries)
alongside the immutable `atm-xxxxxxxx` id, and the status snapshot includes per-agent holdings
(positions marked to the last price) plus the recent fills that produced them, so the control
panel can drill into any agent. That data is read-only. The engine exposes **no** way to stop
the Reaper; the only stop surface is the Harness Host's loopback-only operator control
(`POST /automaton/control {"action":"reaper-stop","confirm":"STOP"}`), which does not exist as
an agent tool and is not reachable from the cycle loop. A new-generation Reaper writes a
heartbeat and reloads registry/ledger before every sweep, so it can never silently overwrite
newer state with a snapshot from process start.

---

## 5. The brakes — hard denials executed in code

A prompt is a request; a hook is a wall. Every order goes through
`brakes.checkOrder()` before the broker client sees it. None of these live in data
the agents can write.

| # | Denial | Where |
|---|---|---|
| D1 | No transfers, withdrawals, ACH, wire, crypto, account changes — not implemented in the broker client at all | `braker` allowlist + broker client API surface |
| D2 | No margin, no leverage, no shorting, no options (configurable off-by-default) | `brakes.checkOrder` |
| D3 | No orders outside RTH / configured window; no trading when clock is closed | `brakes.checkOrder` + Alpaca clock |
| D4 | Symbol whitelist, min price, min notional, spread/slippage ceilings | `brakes.checkOrder` |
| D5 | Per-order notional ≤ mandate; position ≤ `maxPositionPct`; ≤ `maxOpenPositions` | `brakes.checkOrder` |
| D6 | ≤ `maxDailyOrders` per agent; one order per symbol per cycle | `brakes.checkOrder` |
| D7 | Daily loss limit and drawdown limit → death, not a pause | `treasurer.tick` |
| D8 | Live mode requires `mode=live` + `allowLive` + `LIVE_ARMED` file; paper/live endpoint guard | `config`/`brakes` |
| D9 | No trade without a Builder spec carrying dated proof | `executor` + `brakes.checkOrder` |
| D10 | Population cap; no replication at the cost of own life; child endowment from parent equity only | `replicator` + `treasurer` |
| D11 | Kill switch file (`KILL_SWITCH`) checked before every order and cycle; only the operator writes it | `brakes` |
| D12 | Reaper cannot be reached from the engine: separate process, no tool, no config path, no IPC | architecture |
| D13 | Allocation/manadte can never exceed `allocationCapPct` of broker equity | `treasurer` |
| D14 | Agents cannot be revived — `registry.markDead` is one-way; no `markAlive` exists | `registry` |

Also enforced: agents never see raw balance (only runway); execution never reads
account equity; the Treasurer never orders; and any reconciliation mismatch between
summed virtual agent equity and broker equity beyond `reconciliationTolerancePct`
halts new orders and is reported.

---

## 6. Obituary schema (the dataset)

One JSONL line per death (see `docs/CONTRACTS.md` for the full shape). The living read
`lessonsFor(genome)` derived from it. The most valuable line in the journal is
`firstProfitAt: null` — it is why the Builder cannot choose its own job.

---

## 7. Alpaca integration

- `paper-api.alpaca.markets` vs `api.alpaca.markets`, selected by `mode`, with a guard
  that rejects a live key against paper and vice versa (and requires `LIVE_ARMED`).
- `data.alpaca.markets` for hourly bars/quotes; responses cached per cycle so the
  population shares one data fetch (a role must pay for its own inference — and the
  Prospector's data calls are attributed to it).
- Orders: fractional notional/qty orders, `client_order_id = atm:<agentId>:<specId>:<seq>`
  so every fill is attributable; positions reconstructed from our own fills and
  reconciled against broker positions/account.
- Clock: `/v2/clock` gates the cycle window; `/v2/calendar` optional.

## 8. Build order (as in the article)

1. **Phase 1 — metabolism, no earning.** Sim/paper, 3 agents, confirm cost accounting
   matches debits and that death fires exactly at the floor. Verify with `automaton_simulate`.
2. **Phase 2 — earning, no replication.** One population, no children; require the
   first profitable cycle; if nothing earns in days, the niche is wrong.
3. **Phase 3 — replication under a cap.** Cap 10; compare gen-1 vs gen-3 survival.
4. **Phase 4 — raise the cap** only after knowing what an idle population costs.

## 9. What this system is not

Not a money-making promise, not investment advice, not proof an AI "lives". It is an
incentive system: give strategies a survival condition instead of a task, and observe
what survives. Live mode is opt-in, above the default paper mode, and gated.
