# MEAT v3.3 — FAIR P&L, CAPITAL-ONLY REWARDS, AND PERFORMANCE REWARD RULES (contract)

> **Status:** implemented (v3.3) and independently verified: ledger capital accounting + migration,
> trading-only rankings, performance-gated capital rewards, status/API, plugin UI + reward history, and
> 404/404 tests across 10 suites (integration 78, security 63, mortality 88, market 50, plugin 49,
> research 13, rankings 29, control 18, bot-agent 9, instruments 7). Live Host still needs a restart to
> load v3.3; the migration dry-run on a copy of the real paper state produced 30/30 capitalVersion2,
> $129.18 lifetime rewards across 6 bots and GapFade META trading P&L −$1.70 (not +$56.86).

User request (2026-11-22): improve/optimise population-agent management rules; define/recommend the best
reward rules for profitable agents; assign more capital to them to enlarge profits; **reward capital must
never count as profit** — only trading profits count; the plugin UI must show each bot's correct trading
P&L, lifetime rewards received, and reward history in the agent detail page.

This document is the authoritative contract for v3.3. It is implemented by the Lead, mortality-core
(ledger), market-exec (rankings/rewards), plugin-packager (UI/README) and independently verified.

---

## 1. Why (current defect)

v3.2 P&L is `equityUsd - endowmentUsd` and rankings compare equity. A reward payout is a treasury →
agent cash transfer, so it instantly raises "P&L", rank and the next reward. Live example (2026-11-22):
`atm-483016bc` GapFade META has $106.86 cash, a $20 ledger endowment and $58.56 of W44 rewards; raw
equity-based P&L would call the reward profit, and the next reward would compound it again. The live
rewards also pay `5/3/2 % of account cash` on raw equity ranks, not on trading performance, and the
allocation cap ($24 remaining) silently scales payouts.

**Fix: track capital contributed separately from equity. Trading P&L = equity − capital contributed.
Reward payouts are capital contributions, excluded from trading P&L and from reward ranking.**

## 2. Definitions (single source of truth)

| Term | Definition |
|---|---|
| Total equity | cash + marked positions (already includes reward capital). |
| Capital contributed | base endowment + capital top-ups + credits + treasury transfers in, including **reward capital**. Ledger field `capitalContributionsUsd`. |
| Base capital | the agent's declared/top-up capital before rewards: registry `endowmentUsd`, or the ledger's migrated base. |
| Reward capital (lifetime) | subset of capital contributed that came from reward payouts. Field `rewardCapitalUsd`. |
| **Trading P&L (lifetime)** | `equity − capitalContributionsUsd`. Trading only; reward transfers leave it unchanged. |
| Return on capital | `tradingPnlUsd / capitalContributionsUsd` (0 when capital is 0). |
| Period/day/week trading P&L | change in trading P&L since that period/day baseline. Reward payouts do not change it. |
| Lifetime rewards | sum of all reward payouts to the agent; equal to ledger `rewardCapitalUsd` after migration. |

Rules:
- `equityUsd` remains total account equity (what can be traded). Reward capital increases buying power
  and order sizing but not P&L or rank.
- `tradingPnlUsd` includes realized + unrealized − costs (the existing ledger P&L identity).
- A reward transfer must increment `capitalContributionsUsd` and `rewardCapitalUsd` by the same amount;
  it must not touch realized/unrealized P&L. A transfer out to the treasury is a capital withdrawal
  (reduces capital contributed, not P&L).
- P&L shown anywhere in the operator UI (agent table, detail, leaderboards, day P&L) is trading P&L.
  Total equity is always labelled "equity"/"total equity", not "P&L".

## 3. Ledger changes (mortality-core; `src/ledger.js`)

Persisted per-agent record adds:
- `capitalContributionsUsd`: finite, ≥0, round2 (sum of all capital in, minus capital withdrawals).
- `rewardCapitalUsd`: finite, ≥0, subset of the above.
- `capitalVersion`: integer 2 once the v3.3 accounting is active (migration marker aid).

Normalization for old records (fallback only): `capitalContributionsUsd = declaredEndowmentUsd + creditsUsd`,
`rewardCapitalUsd = 0`, `capitalVersion = 1`. The orchestrator migration (§7) replaces this with the exact
fair basis.

New/changed methods:
- `ensureAgent(agentId,{endowmentUsd})`: if the record is new/empty, set `capitalContributionsUsd = endowmentUsd`.
- `grant(agentId, amount, {reason, category})`: cash in + capital contribution (initial endowment/treasury
  grant). `reason/category === 'reward'` also increments rewardCapital.
- `credit(agentId, amount, {category, reason})`: existing credits + capital contribution; `category === 'reward'`
  marks reward capital.
- `transfer(fromId, toId, amount, {reason, category})`:
  - treasury → agent: capital contribution (+ reward capital when `category === 'reward'` or reason matches
    `/reward/i`); this is the rewards path.
  - agent → treasury: capital withdrawal (reduce `capitalContributionsUsd`, and `rewardCapitalUsd` by at most
    the amount if the withdrawal exceeds non-reward capital); never P&L.
  - other directions: cash only (not capital), as today.
- `equity(agentId, prices)` adds:
  `capitalContributionsUsd`, `baseCapitalUsd = capital − reward`, `rewardCapitalUsd`, `tradingPnlUsd`,
  `tradingPnlPct` (all round2; pct fraction or null when capital 0).
- `snapshot(agentId)` adds the same fields plus `capitalVersion`.
- `setCapitalBasis(agentId, {baseCapitalUsd, rewardCapitalUsd, reason, at})`: migration-only setter:
  `rewardCapitalUsd = max(0,reward)`, `capitalContributionsUsd = max(0,base)+reward`, `capitalVersion = 2`,
  append a `capital-basis` event `{kind:'capital-basis', amountUsd, rewardUsd, reason, atMs}` (not cash/P&L).
- `hasCapitalAccounting(agentId)`: true when `capitalVersion >= 2`.
- `capitalOf(agentId)`: `{capitalContributionsUsd, rewardCapitalUsd, baseCapitalUsd, tradingPnlUsd, capitalVersion}`
  (equity-based trading P&L may use the record's stored marks, like `snapshot`).
- Ledger conservation (`pool()`) is unchanged: reward transfers move cash pool→agent, total unchanged.
- No broker methods, no new order surface, no credentials.

## 4. Rankings changes (market-exec; `src/rankings.js`)

Observations (`record({atMs,equityByAgent})`) accept extra per-agent fields:
`{name, equityUsd, trades, tradingPlUsd, capitalUsd}`; all optional for backward compatibility.
Stored baseline/last (and archived `previousBaseline/previousLast`) add
`tradingPlUsd` and `capitalUsd` alongside `equityUsd`.

`compute()` rows add:
- `tradingPnlUsd`: change in trading P&L since the period baseline (null without baseline).
- `tradingPnlPct`: `tradingPnlUsd / baselineCapitalUsd` (null when baseline capital is absent/0).
- `baselineCapitalUsd`, `baselineTradingPlUsd`, `periodTrades`: last−baseline trades.
- Existing `pnlUsd`/`pnlPct` (equity delta) remain for compatibility but UI/rewards use the trading fields.

Archived completed-period rows must expose the trading fields so the reward scheduler can rank the period
that just ended (`stored: true`).

## 5. Reward rules (market-exec `src/rewards.js`, Lead wiring)

**Recommended defaults (implemented):**
- Period: `weekly` (operator-configurable daily/weekly/monthly).
- Basis: **Trading performance only** (`basis: 'trading-performance'`).
- Eligibility (all must hold):
  - `periodTradingPnlUsd > minTradingProfitUsd` (default **$0.05**);
  - `periodTradingPnlPct > 0` (return on period-start capital);
  - `periodTrades >= minTrades` (default **3** round trips);
  - drawdown gate: `drawdownPct <= maxDrawdownPct` (default **0.20** = 20%; passed from agent views);
  - a measured trading baseline exists (no fabricated reward).
- Ranking: highest **period trading return** first, tie-break by period trading P&L dollars.
- Budget: `rewardBudgetPctOfPool` (default **0.10** = 10% of the available treasury pool),
  optionally capped by `maxPerPeriodUsd`; never exceeds the pool or allocation-cap remaining.
- Top-3 allocation shares: `rankShares: [0.5, 0.3, 0.2]` of the reward budget (top-1 gets half).
- Per-agent cap: a single reward ≤ `maxRewardPerAgentPctOfCapital` (default **0.50**) of the agent's
  current contributed capital; scale all winners proportionally if needed; floor to cents.
- No eligible winners/pool/budget → record `skipped`, no transfer.
- Payout is a **capital contribution** (`category:'reward'`, reason `reward:<periodKey>`); the ledger marks
  it as reward capital. It increases buying power and mandate sizing, never P&L or rank.
- Reward history: every applied payout records `{period, periodKey, at, basis, budgetUsd,
  winners:[{rank, agentId, name, amountUsd, share, periodTradingPnlUsd, periodTradingPnlPct,
  capitalUsd, periodTrades}]}`. Expose history (last 50 periods) and per-agent history.
- Persist a `lifetime` map in rewards state for convenience; ledger `rewardCapitalUsd` is authoritative.
- Config (validated in `src/config.js`):
  `enabled, period, basis:'trading-performance', rankShares:[3], rewardBudgetPctOfPool, maxPerPeriodUsd, maxRewardPerAgentPctOfCapital, minTradingProfitUsd, minTrades, maxDrawdownPct`.
  `rankPercents`/`basis:'account-cash'` remain accepted only as deprecated legacy settings (mapped away);
  new settings are `rankShares`/`basis:'trading-performance'`.
- Control action/settings overlay must accept only the new reward fields (UI sends new names).

**Why these rules:** reward capital follows demonstrated risk-adjusted trading returns rather than
account size; thresholds strip noise; drawdown gating avoids rewarding lucky high-variance bots;
half the budget to #1 concentrates capital on the best performer since order sizing scales with equity;
per-agent cap and pool/allocation caps stop one bot from absorbing the treasury; no negative-P&L rewards.

## 6. Status/API contract (Lead; used by plugin)

`status.agents[]` adds:
- `capital: {contributedUsd, baseUsd, rewardCapitalUsd, rewardSharePct, capitalVersion}`.
  `rewardSharePct` is PERCENT POINTS (0..100).
- `pnl`: `{tradingUsd, tradingPct, tradingRealizedUsd, tradingUnrealizedUsd, rewardsUsd, netUsd (= tradingUsd legacy alias), dayPct, weekPct, monthPct}` where `tradingPct` and the period pct fields are **fractions** (0.0157 = +1.57%) of contributed capital, sourced from trading P&L (not equity).
- `rewards: {lifetimeUsd, count, lastAt, history:[{period,periodKey,at,rank,amountUsd,share,periodTradingPnlUsd,periodTradingPnlPct}]}` from rewards state.
- `rankings`: add `tradingDayPct/tradingWeekPct/tradingMonthPct` and `tradingDayUsd/...`; legacy `dayPct` etc are now trading fractions for clarity (keep numeric fields but sourced fairly).
- `equityUsd` remains total equity; add explicit `tradingPnlUsd` and `tradingPnlPct` (fraction) at agent top level for easy UI use.

`status.engine.rewards` adds:
- `rules`: resolved settings above + human-readable `explain[]`.
- `budgetUsd` preview for the next payout (pool*Pct, capped), `poolUsd`, `lifetimeTotalUsd`, history.
- `explain[]` describes the basis/eligibility/shares/pointers.

`status.engine.capitalAccounting`: `{version:2, migrationMarker, rewardedAgents, tradingPnlTotalUsd, rewardsLifetimeTotalUsd}`.

`dayStats` and daily-loss metadata: daily loss uses **trading P&L** change, not equity change (reward capital
must not look like a loss/profit). The risk daily-loss brake keeps its cap but compares trading P&L.
`dayStatsFor` exposes `startTradingPlUsd` and `pnlUsd` on the trading basis; legacy entries are anchored
at the current trading P&L on the first v3.3 load (never counting reward capital).

## 7. Migration (Lead; orchestrator init, marker `capital-v33.json`)

On first v3.3 start:
1. Load registry, ledger, rewards history.
2. Lifetime rewards per agent = sum of all `rewards.history[].winners[].amountUsd` for that agent (plus
   `lastWinners` if not already in history; dedupe by periodKey+agent).
3. For every registry agent (alive+dead) with a ledger record and `hasCapitalAccounting() === false`:
   - base capital = registry `agent.endowmentUsd` (fallback ledger `declaredEndowmentUsd`; ≥0);
   - `setCapitalBasis(agentId,{baseCapitalUsd:base,rewardCapitalUsd:lifetimeRewards,reason:'v3.3 capital migration'})`.
   - Existing top-ups are represented by the registry endowment (e.g. $50), so they are not added again.
4. Write `{version:2, at, migrated, lifetimeRewardsUsd}` to `stateDir/capital-v33.json`; idempotent
   (skip agents already `capitalVersion>=2`).
5. Rebuild status: rewarded agents now show fair trading P&L (e.g. $106.86 equity − ($50+$58.56) = −$1.70
   for GapFade META) and lifetime rewards $58.56.
6. Rewards settings migration: update runtime settings/config to `rankShares [0.5,0.3,0.2]`,
   `rewardBudgetPctOfPool 0.10`, min profit $0.05, min trades 3, max drawdown 20%, basis trading-performance.
   (No retroactive re-payment or clawback of W44/W45; they are now correctly classified as reward capital.)
7. Allocation cap note: current `account.allocationCapPct` 0.8 leaves ~$24 of agent allocation headroom;
   to let reward capital reach winners, the live profile raises it to **0.9** (still leaves a 10% cash
   reserve) and adds a treasury pool reserve. This is a risk decision documented in RUNBOOK §8g; no broker
   transfer surface.

## 8. UI requirements (plugin-packager; `client.js`, tests, README)

Agent table/detail:
- P&L column = **Trading P&L** (lifetime $ and %, tooltip "excludes reward capital").
- New **Rewards** column = lifetime rewards USD (never added into P&L).
- Detail P&L card: Total equity; Capital contributed; of which reward capital; Trading P&L; Return on
  capital; Lifetime rewards; reward count/last reward date. Explicit note: "Rewards are trading capital,
  not profit; P&L only counts trading results."
- Detail new **Reward history** section/table: period (weekly W44…), date, rank, reward USD, share of
  budget, period trading P&L / return; empty state "no rewards yet"; totals row lifetime.
- Rewards tab/card: rule summary (basis trading performance, eligibility min profit/trades/drawdown,
  weekly budget = % pool, rank shares 50/30/20, per-agent cap); current reward pool/budget; ranked
  candidates with eligibility reason; history table; leaderboards on trading P&L.
- KPI cards: portfolio equity (total), **trading P&L** (lifetime and/or day), rewards distributed/lifetime,
  cash, exposure, population, trades, win rate, treasury. Do not label equity delta as P&L if rewards moved.
- Agent live rows from `/automaton/market`: live equity is total equity; day P&L must use trading P&L.
- Keep all existing controls/tabs/detail sections; polling/fallback unchanged.
- Pure helpers exported for tests: e.g. `agentPnlView`, `rewardsHistoryRows`, `rewardRuleSummary`,
  `capitalBreakdown`, `rewardsEligibility`.

## 9. Tests/acceptance

- Ledger: capital/reward classification, reward transfer leaves trading P&L unchanged, transfer-out is
  capital withdrawal, setCapitalBasis idempotent/migration, snapshots, conservation, no P&L in capital events.
- Rankings: trading baseline/archive/carry, periodTrades, legacy observations still work, stored payout rows
  expose trading fields.
- Rewards: eligibility thresholds/negative/no-baseline/drawdown, ranking by trading return, budget shares
  50/30/20, pool/allocation/per-agent caps, skipped history, reward transfers classified as capital, lifetime
  map/history per agent, settings validation/deprecation.
- Orchestrator/API: migration on real-state copy (30 agents, 21/9, lifetime rewards from history, fair P&L),
  agent/status fields, day P&L trading based, reward payout end-to-end, idempotent restart.
- UI/plugin: P&L excludes reward capital; rewards lifetime/history; table/detail/tab mappings; rule text;
  live fallback; no secrets.
- Security: rewards still virtual only, no new tools/broker/order/transfer surface; ledger conservation;
  status/route redaction.
- Docs: this contract, CONTROL-PANEL rewards/P&L, RUNBOOK §8g, README, CHANGELOG v3.3.

## 10. Non-goals

- No real-money transfers/withdrawals, no broker transfer surface, no live activation.
- No retroactive clawback/negative rewards; historical payouts are reclassified only.
- No assignment/early-exercise/margin-call modelling changes.
- No guarantee of profit; higher capital to winners increases both upside and drawdown risk.
