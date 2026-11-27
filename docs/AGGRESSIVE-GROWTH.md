# MEAT v3.4–v3.5 — AGGRESSIVE GROWTH, RETURN TARGET, SIZING AND ACTIVITY FIXES (contract)

User request (2026-11-23): trading is too slow; make some bots more aggressive; target a **minimum 50%+
annual return on account capital**. This document is the authoritative v3.4 contract.

**Reality check:** 50%/year is an ambitious target, not a promise. Long-only paper trading with no margin
and tight position caps may not reach it; v3.4 increases opportunity and capital efficiency for a
dedicated aggressive cohort while keeping every hard brake. Reward/risk must be operator-tunable.

## 0. Root cause of the current inactivity (must fix)

The live paper engine has been **halted since 2026-11-17** with `reconciliation_mismatch`; every tick
does `executions:0, orders:0`. The reconciliation delta $50.39 exactly equals **$50.64 of cumulative
virtual metabolism costs** (hosting/inference/data/research/agent reviews) that the virtual ledger
deducted but the paper broker account never paid. The one-time anchor at 2026-10-24 set virtual total =
broker equity; costs then drift the virtual total below the broker with no allowance, so the halt is
permanent until the drift is recognised.

**Fix:** reconciliation must add back **virtual costs since the anchor**. These are simulated operating
expenses funded externally (paper account), not trading losses. Do NOT mint agent capital and do NOT
hide real fill mismatches.

Ledger (`src/ledger.js`):
- Persist `anchorCostsUsd` (set in `anchorToBrokerEquity`; normalize missing to 0).
- `totalCostsUsd()` = sum of `costsUsd` across all agent records + treasury record.
- `costsSinceAnchor()` = max(0, totalCostsUsd() - anchorCostsUsd) (round2).
- No broker/order/transfer surface; no P&L effect.

Treasurer (`src/treasurer.js`):
- Reconciliation: `expectedVirtualUsd = allocatedAll + pool.poolUsd + costsSinceAnchor`; `deltaUsd =
  accountEquityUsd - expectedVirtualUsd`; tolerance unchanged; expose
  `reconciliation.costsSinceAnchorUsd` and `virtualTotalUsd`.
- A positive costs allowance must never mask negative delta/real unbooked fills; tolerance still
  symmetrically applies.
- Tests: synthetic cumulative costs no longer halt; real fill mismatch beyond tolerance still halts;
  anchor captures baseline; live-state copy clears the existing halt on first tick (read-only dry run).

This fix alone unblocks ~23 open positions and 30 bots on restart.

## 1. Aggression profiles (`config.aggression`)

Code default is **`enabled: false`** for backward compatibility (older configs/tests keep v3.3 balanced
behavior); the live profile sets `enabled: true`. When enabled, defaults:
```json
{
  "enabled": true,
  "aggressivePct": 0.40,
  "balancedPct": 0.45,
  "capitalMultiplier": 1.35,
  "profiles": {
    "aggressive":  { "basketSizeDay":6, "basketSizeSwing":4, "maxOpenPositionsDay":8, "maxOpenPositionsSwing":5,
                     "maxOrdersPerCycle":4, "entryZMultiplier":0.70, "sizePctMultiplier":1.35,
                     "stopPctMultiplier":0.80, "targetPctMultiplier":1.20, "maxHoldBarsMultiplier":0.75,
                     "policySizeFloor":0.80, "respectStandDown":false },
    "balanced":    { "basketSizeDay":4, "basketSizeSwing":3, "maxOpenPositionsDay":5, "maxOpenPositionsSwing":3,
                     "maxOrdersPerCycle":2, "entryZMultiplier":1.00, "sizePctMultiplier":1.00,
                     "stopPctMultiplier":1.00, "targetPctMultiplier":1.00, "maxHoldBarsMultiplier":1.00,
                     "policySizeFloor":0.00, "respectStandDown":true },
    "conservative":{ "basketSizeDay":3, "basketSizeSwing":2, "maxOpenPositionsDay":3, "maxOpenPositionsSwing":2,
                     "maxOrdersPerCycle":1, "entryZMultiplier":1.15, "sizePctMultiplier":0.80,
                     "stopPctMultiplier":1.00, "targetPctMultiplier":0.90, "maxHoldBarsMultiplier":1.00,
                     "policySizeFloor":0.00, "respectStandDown":true }
  }
}
```

- Profile assignment: deterministic, **day agents first**, then swing. `aggressiveCount =
  round(alive*aggressivePct)`, `conservativeCount = round(alive*(1-aggressivePct-balancedPct))`,
  balanced takes the rest. For 30 agents: **12 aggressive (day), 13 balanced (9 day + 4 swing), 5
  conservative swing**. The conservative rounding uses an epsilon so 15% of 30 is 5, not 4.
- Genome gets `aggression: 'aggressive'|'balanced'|'conservative'` (inherited by replication; broker/risk
  systems ignore unknown genome fields).
- **Aggressive capital:** one-time top-up of each aggressive agent from the treasury pool toward
  `config.endowmentUsd * aggression.capitalMultiplier`, funded only from available pool and
  allocation-cap headroom (never minted), recorded as a **capital contribution** transfer
  (`reason:'v3.4 aggressive capital allocation'`), not P&L/reward. Marker `aggression-capital-v34.json`.
  Registry `endowmentUsd` becomes the funded target. Scale down if pool/cap is short; never exceed
  account allocation cap. Live profile: allocation cap 0.92, headroom ~$261, desired top-up ~$210 (fits);
  the treasury pool drops from ~$370 to ~$160, so the weekly reward budget becomes smaller.
- Aggressive bots keep all 18 brakes and the account-level risk caps; no live mode change. Live risk
  ceilings are raised to `maxOpenPositions:10`, `maxOrderNotionalUsd:60`, `maxDailyOrders:40`,
  `maxPositionPct:0.6`; aggressive profile caps (8/5 positions, 4 orders/cycle) remain below them.
- **This is a target-seeking allocation, not a guarantee.** The cohort gets more opportunity and
  capital, but losses/drawdowns scale too; 50%/year is not promised and may not be achievable
  long-only in paper with the current caps.

## 2. Execution changes

Builder (`src/builder.js`, market-owned):
- `compile({..., genome})`: profile = `config.aggression.profiles[genome.aggression]`; apply
  `entryZ *= entryZMultiplier`, `sizePct *= sizePctMultiplier`, `stopPct *= stopPctMultiplier`,
  `targetPct *= targetPctMultiplier`, `maxHoldBars *= maxHoldBarsMultiplier` **after** genome values and
  **before** the existing hard bounds clamp. Balanced/conservative multipliers preserve current behaviour.
- Tests: aggressive spec lower entryZ/maxHold, larger size, adjusted stops/targets within bounds;
  balanced byte-compatible.

Executor (`src/executor.js`, market-owned):
- `run({..., portfolio, profile})` already supports `portfolio.maxOpenPositions/maxOrdersPerCycle`;
  add optional `profile:{aggression, policySizeFloor, respectStandDown}`:
  - normal policy size factor remains binding; aggressive uses
    `sizeFactor = max(policySizeFactor, profile.policySizeFloor)` for trade/cautious;
  - if `respectStandDown === false` and stance === 'stand_down', treat it as cautious at the floor
    instead of blocking entries (research ALERT/risk gates still veto); if true, unchanged block.
  - no brake bypass; profile limits are ceilings only, D5/order/cash caps still apply.
- Tests: aggressive floor/stand-down conversion, balanced/conservative unchanged, brakes still deny,
  profile order cap respected.

Orchestrator (Lead):
- Assign/expose genome aggression; use profile basket sizes at genesis/migration; pass profile portfolio
  limits and `profile` to executor; aggressive top-up; status.
- Global risk caps raised for the live profile: `risk.maxOpenPositions:10`,
  `risk.maxOrderNotionalUsd:60`, `risk.maxDailyOrders:40`, `risk.maxPositionPct:0.6`. Profile/basket
  caps remain below these. All brakes still enforce.

## 3. Return target and activity reporting (`config.targets`)

```json
{ "enabled": true, "annualReturnPct": 0.50 }
```

Status (`engine.performance` and top-level `performance`):
- `targetAnnualReturnPct` (0.50), `requiredDailyReturnPct = (1+target)^(1/365)-1`.
- `baselineAt` (one-time `growth-v34.json`/performance baseline), `baselineAccountEquityUsd`,
  `baselineTradingPnlUsd`, `daysElapsed`, `tradingPnlSinceBaselineUsd`.
- `annualizedReturnPct` = trading P&L since baseline / baseline account equity × 365/days (null when
  <1 day; fraction), `targetProgressPct` = **percent points vs target (100 = exactly on target)**,
  `onTrack` boolean (informational only).
- `accountEquityUsd`, `accountCapitalBase` and `tradingPnlTotalUsd`.
- Activity: `engine.aggression` config summary; `engine.activity` = today's orders, trades since start,
  executions/orders in last cycle, active profiles, halt reasons. Agent rows expose
  `aggression`, `aggressionProfile` limits, and `activity {ordersToday,trades,positions}`.
- **Target is not an order override**: no engine path increases risk simply because the target is behind.
  Aggression is a fixed cohort/config; brakes and caps remain.

## 4. Bot-agent prompt (Lead)

Aggressive bots get an explicit growth mandate in the isolated review prompt: prefer taking valid
setups, avoid `stand_down` unless the briefing has a material risk alert, and use the size range
(floor applied deterministically). Balanced/conservative keep the current conservative prompt. The
deterministic executor enforces the profile regardless of model output.

## 5. UI (`client.js`, plugin-owned)

- Header/KPI: **Annual return target 50%** card with current annualized trading return, target progress,
  trading P&L since baseline, account equity, and required daily pace; clear "target, not guarantee".
- Agent table: **profile badge** (Aggressive/Balanced/Conservative) and filter; sortable by aggression;
  show profile limits/activity in detail.
- Detail: aggression profile + limits (basket, open positions, orders/cycle, size/entry multipliers,
  policy floor), activity stats, capital/top-ups classification.
- Existing fair P&L/rewards UI retained; aggressive capital shows as contributed capital, not profit.
- Empty/legacy fallbacks; no secrets.

## 6. Migration/order of operations (Lead)

On first v3.4 start, after registry/ledger/rewards/reconciliation load:
1. `assignAggressionProfilesV34()`: deterministic profile assignment (day first) into genome; marker;
   every agent takes the profile's entry basket (held positions are unaffected because exits are managed
   from the book/opening spec), clear `specIds/specId` only for **flat** agents so new entries compile
   with the profile multipliers; held positions keep their opening spec.
2. `capitalizePopulation` (existing $50 baseline) then `allocateAggressiveCapitalV34()` from pool/cap;
   marker, ledger capital contribution; no P&L.
3. `growth-v34.json` performance baseline (account equity, trading P&L, at) one-time. The baseline is
   informational; the first day's annualized pace is volatile and shown with a short-history caveat.
4. Reconcile costs fix clears the halt on first tick. Verified on a read-only live-state copy by the
   mortality owner and independent verifier: legacy delta ~50.4 → costsSinceAnchor ~50.7 → fixed delta
   inside tolerance → halted false, 30 agent views.

## 7. v3.5 sizing and idle-aggressive fixes

**Why orders were tiny.** A new entry was `spec.sizePct × mandate.sizeBudgetUsd`, where the mandate cap
is `min(maxOrderNotional, maxOrderPctOfEquity × equity)`. With genome sizePct 0.12–0.40 and a $50–$67.5
bot, typical orders were **$2–$10 (4–15% of capital)**; the live account's gross exposure was only
~$50 (2.5% of equity).

**v3.5 sizing changes:**
- `config.risk.sizePctMultiplier` (code default **1.0**, live profile **3.0**) multiplies
  `spec.sizePct` in the executor, then clamps the effective percentage to ≤1 **before** every
  mandate/max-order/equity/cash/position/brake cap. Live `risk.maxOrderNotionalUsd` is **$120**.
- Typical new entry sizes become **~18–50% of the bot's equity** (e.g. a $65 aggressive bot uses roughly
  $20–$33 per order; the smallest balanced spec still lands near 18%; the largest is capped at 50%).
  Every hard cap still applies (cash, D5 open positions, position %, order notional, daily orders,
  margin/options, kill switch). Default multiplier 1.0 is byte-compatible with v3.4.
- Existing tiny positions are **not force-resized**; they close on their rules, and new entries use the
  larger sizing. The account's gross exposure is expected to rise materially once signals fire.

**Why some aggressive bots were idle.** Three compounding causes: (1) the engine was halted six days, so
the Prospector was skipped and hypotheses went stale; (2) day families `breakout`/`gapfade` have sparse
proven edges (**for the day families only gapfade:SOFI and breakout:AMZN were proven**; the queue's 24
  positive-edge family:symbol pairs were all stale from 2026-11-17), so many aggressive day
bots had no exact family/symbol hypothesis and therefore no spec; (3) the market was closed/premarket
(Thanksgiving and the morning of 2026-11-27).

**v3.5 idle fix — opportunistic proven fallback (aggressive only):**
- `aggression.profiles.aggressive.allowOpportunisticFallback: true`. When a basket symbol has no
  compilable hypothesis for the bot's own genome family, the orchestrator tries the **rank-ordered
  proven hypotheses for that exact basket symbol** from other families until Builder D9 accepts one
  (a stale top-ranked candidate cannot mask a fresh lower one). The spec is marked `fallback: true` and
  `genomeFamily`, cached in `specIds`, and executed normally under the same profile/brakes. For a
  cross-family fallback the builder uses the **hypothesis family's default/specsHint parameters** (the
  measured setup), keeping only the aggression profile marker from the genome; own-family specs keep the
  inherited genome parameters.
- `specId`/status `spec` remain tied to the bot's **primary genome symbol**: a fallback spec on the
  primary symbol is shown (flagged); if only basket siblings have specs, the primary `spec` stays null
  while those specs still trade via `specIds`/`specs`.
- It is **not** a fabricated/synthetic setup: Builder D9 proof/freshness still applies. Balanced and
  conservative bots never cross families. Fallback specs are clearly flagged in status
  (`spec.fallback`, `spec.genomeFamily`) so the operator can see the opportunistic strategy drift; this
  is an explicit aggressive-cohort exception to the normal family/symbol coherence rule.
- Prospector still runs only when the engine is unhalted and market data is available; fresh hypotheses
  plus the fallback should give the aggressive day cohort tradable proven setups once the market opens.
  If no positive-edge/valid hypothesis exists anywhere in a bot's basket, it correctly stays flat.
  The last live hypothesis queue had **24 positive-edge family:symbol pairs but all dated 2026-11-17
  (9.8 days stale > maxProofAgeDays=7)**, which is why the halted engine had no compilable specs.

**Sizing caveat:** a single order larger than `risk.maxPositionPct × equity` is DENIED by D5 rather than
silently clamped. The live `maxPositionPct` is 0.6, safely above the 50%-equity maximum order; if you
lower it below the intended order size, entries will be denied.

## 8. Acceptance/tests

- Reconciliation: costsSinceAnchor clears the 6-day halt; real fill mismatch still halts; conservation.
- Profiles: 12/13/5 assignment, aggressive all day where possible; basket/limits/multipliers; capital
  top-up funded from pool only (allocation cap), classified capital; idempotent restart.
- Builder/executor profile changes (market tests); no brakes bypass; balanced unchanged.
- Status target math (annualized, required pace, progress, short-history nulls); activity; UI mappings.
- Target 50% documented as ambition; no guarantee; paper/live gates unchanged.
- Full suites + independent verifier; docs/AGGRESSIVE-GROWTH.md (§7 = v3.5 sizing/fallback), RUNBOOK §8i,
  README and CHANGELOG v3.4/v3.5.
