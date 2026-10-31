# MEAT — PER-BOT AGENTS, STRATEGY TAXONOMY & PANEL (contract, 2026-10-30)

> **Status:** implemented in v2.3.0 (`src/strategy-types.js`, `src/bot-agent.js`, executor policy
> consumption, status contract, control panel). Tests: `test/bot-agent.test.js`,
> `test/control.test.js`, `test/market.test.js`, `test/plugin.test.js`.

User request: "upgrade the plugin system, make each agent bot a real agent, not controlled by one
agent"; adjust population so some bots are mid/long-term and some are day/short-term; categorize the
population by strategy type in the control panel and list **strategy type** and **estimated trading
interval** in the agent table.

Chosen architecture (user-approved): **Hybrid** — each population bot has its own isolated *agent
brain* (own persona/context, own memory/policy journal, own decisions) reviewed on its cadence, while
a per-bot execution layer acts inside that policy and the 18 hard brakes (D1–D18). Review budget: **~200
reviews/hour** (swing bots hourly; day bots every 5 minutes).

## Strategy taxonomy (`src/strategy-types.js`, Lead)

Family → strategy class:

| Genome family | Strategy type label | Class | Cadence tier | Timeframe | Est. trading interval |
|---|---|---|---|---|---|
| `momentum` | Momentum swing | swing | swing | 1Hour | ~1 h decisions |
| `meanrev` | Mean-reversion swing | swing | swing | 1Hour | ~1 h decisions |
| `breakout` | Intraday breakout | day | day | 1Min | ~1–5 min reactions |
| `gapfade` | Day-trade gap fade | day | day | 1Min | ~1–5 min reactions |

Exports:
- `STRATEGY_TYPES` (catalog) and `familyOf(agent)`.
- `resolveStrategyType({ family, tier, cadence })` → `{ family, category:'swing'|'day', tier,
  typeLabel, className, description, estimatedIntervalSec, timeframe }`.
- `strategyMix()` for the UI legend (category counts).
- `targetFamilyForIndex(index)` for genesis/backfill mix (balanced ~50/50 swing/day).

Genesis/backfill: tier is derived from the **family** (not alternating index). Existing populations
are backfilled: `tier` set from family, `strategyType` persisted on the registry record; agents whose
family is absent from the target mix keep their family (no forced genome rewrite) but are always
categorised correctly. Replication inherits tier from the **child** genome's family.

Status additions per agent:
```js
strategy: { family, category, tier, typeLabel, className, description,
            estimatedIntervalSec, timeframe }
```

## Per-bot agent brain (`src/bot-agent.js`, Lead)

```js
createBotAgents({ config, paths, clock, registry, ledger, broker, researcher, generate })
  .tick({ marketClock })
  //   -> { due, reviewed:[{agentId, stance, sizeMultiplier, confidence, costUsd, error?}], skipped }
  .policy(agentId)        // { at, atMs, stance:'trade'|'cautious'|'stand_down',
                          //   sizeMultiplier, riskMultiplier, exitPressure:'none'|'exit',
                          //   confidence, thesis, plan:[string], watch:[], reviewSec, stale }
  .status(agentId)        // dashboard view incl. lastReviewAt, nextReviewAt, reviewCount
  .schedule()             // { enabled, configured, provider/model, intervalDaySec, intervalSwingSec, lastReviewAt, nextDueAt, runs, errors }
```

- **Isolation:** each review prompt contains ONLY that bot's id/name/genome/spec, its own book,
  current snapshot (quotes/bars summary), its own prior reviews/tests, and its assigned research
  briefing. Never another bot's data or the operator's context. Journals are per-agent files under
  `stateDir/agents/<agentId>.jsonl`; cache in `stateDir/agents/state.json`.
- **Cadence:** `strategy.category === 'day'` → `agents.reviewIntervalDaySec` (default 300 s);
  `'swing'` → `agents.reviewIntervalSwingSec` (default 3600 s). Due agents only; max
  `agents.maxReviewsPerCycle` (default 4) per engine cycle.
- **LLM seam:** same `generate({system,user,maxTokens})` callback the research sidecar uses (Harness
  llm bridge or CLI DeepSeek fallback). Strict JSON reply validated/clamped:
  ```js
  { stance:'trade'|'cautious'|'stand_down', sizeMultiplier:0.2..1, riskMultiplier:0.5..1.5,
    exitPressure:'none'|'exit', confidence:0..1, thesis:string<=300,
    plan:[<=4 strings], watch:[<=4 symbols] }
  ```
  Malformed replies are contained (repair+retry once like research, no policy stored, no charge);
  failed bots stay due for a later cycle.
- **Cost:** `agents.costPerReviewUsd` (default $0.001) charged to that bot's ledger; no charge on
  failure.
- **Persistence:** policy state survives restarts (`agents/state.json`); when missing the executor
  behaves exactly as before (no policy = neutral).
- `stale`: policy older than its cadence × 2 is ignored by the executor but still shown.

## Executor policy consumption (market teammate)

`executor.run({..., policy})` — optional. Only when `agents.enabled` and policy fresh:
- `stand_down` → no entries (skip reason `agent_stand_down`), exits still evaluated.
- `cautious` / `sizeMultiplier < 1` → multiply entry notional by `sizeMultiplier` (never increase;
  all existing caps still apply).
- `exitPressure === 'exit'` → exit any held position in the exit pass (reason `agent_exit_pressure`)
  before mechanical exits.
- `riskMultiplier` may tighten (never loosen) stop distance? v1: ignore except documentation.
- `trade` with `sizeMultiplier` 1 = no behaviour change. Missing/stale/disabled policy = exactly
  today's behaviour. Record applied policy on actions (`policy:{stance,sizeMultiplier,applied}`).
- Never bypass brakes, never create orders outside the mandate.

## Orchestrator / engine (Lead)

### v3.1 prompt/context hardening

- The review prompt now carries `TRADING_RULES` (fractional long stock allowed, min order notional,
  dollar `sizeBudgetUsd`, whole-share-only shorts, broker `shortingEnabled`/`marginMultiplier`) and an
  account-adjusted `INSTRUMENT_CONTEXT` (credit/covered structures hidden while margin is unavailable).
- The system prompt explicitly forbids `stand_down` merely because one whole share/contract is
  unaffordable, a quote is stale, or the market is closed; the executor sizes entries from the mandate
  and falls back to fractional stock when options do not fit. Stand-down is reserved for weak or
  conflicting evidence / unacceptable risk.
- Policies persist for the dashboard, but every process start marks reviews due (`lastReviewAt=0`) so
  an old stand-down decision cannot silently block entries for up to an hour after a restart.
- Bot reviews run after the executor pass on trading cycles only; the fallback remains deterministic
  when no policy is fresh (missing/stale policy = neutral, auto playbook).

## Orchestrator / engine (Lead)

- Create the bot-agent brain alongside the researcher; `createAutomaton` accepts
  `agentGenerate` (same bridge as researchGenerate by default).
- Tick: after the executor pass (so policies apply next cycle) run `botAgents.tick({marketClock})`;
  trace `agents.reviewed`. Pass `botAgents.policy(agent.id)` into `executor.run`.
- Status: `status.engine.agents = botAgents.schedule()`; `status.agents[].policy = botAgents.status(id)`
  (null when never reviewed); `status.agents[].strategy` from the taxonomy.
- Config block (validated, settings overlay friendly):
  ```js
  agents: {
    enabled: true,
    reviewIntervalDaySec: 300,
    reviewIntervalSwingSec: 3600,
    maxReviewsPerCycle: 4,
    costPerReviewUsd: 0.001,
    maxAgeSec: 7200,
    logLimit: 120,
    maxInputChars: 8000,
    maxOutputTokens: 700,
  }
  ```
- Genesis mix: target ~15 swing (momentum/meanrev) + ~15 day (breakout/gapfade) for new populations;
  existing population keeps genomes, tier/type are assigned by family. Report exact counts in status
  `strategyMix`.

## Control panel (plugin teammate)

- Agent table: add **Strategy type** column (e.g. "Momentum swing", "Day-trade gap fade") and
  **Est. interval** column (`~1 h` / `~1–5 min`, from `agent.strategy.estimatedIntervalSec`).
- Category tabs/filter above the table: **All / Swing (mid-long) / Day (intraday)** with counts from
  `status.strategyMix`.
- Agent detail: header badge for category; new "Bot agent" section: stance, size multiplier,
  confidence, thesis, plan list, watch symbols, last/next review time, review count, staleness;
  empty state "bot agent has not reviewed yet (first review pending)".
- Engine header: small bot-agent bridge status (configured / runs / errors / cadence).
- Pure mapping helpers exported for tests; optional fields guarded (older Host renders empty states).

## Tests

- Lead: `strategy-types` mapping + mix; bot-agent suite (new `test/bot-agent.test.js`): isolation
  (no other agent data in prompts), schema validation/clamp, malformed containment, schedule day vs
  swing, policy expiry, per-agent ledger charge, persistence/reload.
- market: executor policy effects (stand_down/cautious/size/exitPressure), stale/missing policy
  baseline equivalence, brakes still first.
- control: status integration (agent.strategy/policy, engine.agents), genesis mix counts, policy
  passed into executor (trace detail).
- plugin: UI mapping for category tabs, type/interval columns, bot-agent detail, empty states.
