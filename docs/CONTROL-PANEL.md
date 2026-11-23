# MEAT — CONTROL PANEL / RANKINGS / REWARDS contract (2026-10-29)

Operator features requested: configurable research cadence (1h/3h/6h/24h, before open, after close),
richer per-agent detail (strategy explanation, plan + next step, full order/transaction records),
daily/weekly/monthly leaderboards, and configurable winner rewards (default 1st +5%, 2nd +3%,
3rd +2% of the broker account's **cash** balance) with an operator control panel.

All of this is **virtual money inside the ledger** (no Alpaca transfers, the broker client still has
no transfer/withdraw surface). Rewards move cash from the treasury pool (`__treasury__`) to agents, so
`sum(agent equity) + pool` stays constant and reconciliation is unaffected.

## Settings persistence (Lead)

`stateDir/settings.json` (default `automaton-data/settings.json`) is an operator overlay applied after
`automaton.config.json` in `loadConfig()`:

```json
{
  "research": { "scheduleMode": "interval|pre-open|post-close|pre-open+post-close", "intervalSec": 3600 },
  "rewards": {
    "enabled": true,
    "period": "daily|weekly|monthly",
    "basis": "trading-performance",
    "rankShares": [0.5, 0.3, 0.2],
    "rewardBudgetPctOfPool": 0.1,
    "maxPerPeriodUsd": null,
    "maxRewardPerAgentPctOfCapital": 0.5,
    "minTradingProfitUsd": 0.05,
    "minTrades": 3,
    "maxDrawdownPct": 0.2
  }
}
```

Overlay values are validated by `validateConfig` exactly like the base config. The engine exposes
`updateResearchSettings(patch)` and `updateRewardSettings(patch)` which validate, write the overlay,
apply live (researcher reconfigure / rewards scheduler) and return the effective settings.

### Research schedule modes (Lead, `src/research.js`)

- `interval` — every `intervalSec` per agent (UI options: 3600, 10800, 21600, 86400), staggered as now.
- `pre-open` — one briefing per agent inside the pre-open window
  `[nextOpen - preMarketOffsetMin, nextOpen)`, default offset 30 min.
- `post-close` — one briefing after the close, window `(close, close + postCloseOffsetMin]`, default 30 min.
- `pre-open+post-close` — both windows.
Market windows come from the broker clock (`marketClock` passed to `researcher.tick({marketClock})`).
`nextDueAt` reflects the mode. `scheduleMode`/`intervalSec` are live-updatable.

## Control actions (plugin teammate, `POST /automaton/control`, loopback only)

Existing: `start`, `stop`, `emergency-stop`, `reaper-stop` (unchanged shape). New:

```
{action:'set-research-settings', settings:{mode:'interval'|'pre-open'|'post-close'|'pre-open+post-close', intervalSec?:number, enabled?:boolean, influence?:boolean}}
{action:'set-reward-settings', settings:{enabled?:boolean, period?:'daily'|'weekly'|'monthly',
  basis?:'trading-performance', rankShares?:number[], rewardBudgetPctOfPool?:number,
  maxPerPeriodUsd?:number|null, maxRewardPerAgentPctOfCapital?:number,
  minTradingProfitUsd?:number, minTrades?:number, maxDrawdownPct?:number}}
```

- `settings` required object; unknown keys rejected; values validated (new v3.3 reward fields in §5 above;
  `rankShares` exactly 3 numbers 0..1 summing to ≤1; percentages 0..1; minTrades a non-negative integer;
  maxPerPeriodUsd null or 0..1_000_000). The deprecated v3.2 `rankPercents` key is still accepted by the
  API for compatibility but is ignored by the v3.3 scheduler; the UI sends only the new fields.
- Success `{ok:true, action, result:{settings, effective}}`; failures keep the existing
  `{ok:false, error:{code,message}}` shape (400/403/409 as today). Never expose these as agent tools.

## Engine status additions (Lead)

`status()` gains:

```js
engine: {
  research: { ...existing, scheduleMode, intervalSec, configurable: {
    scheduleModes: ['interval','pre-open','post-close','pre-open+post-close'],
    intervalOptionsSec: [3600, 10800, 21600, 86400]
  }},
  rewards: {
    enabled, period, basis:'trading-performance',
    rules:{rankShares:[.5,.3,.2], rewardBudgetPctOfPool, maxPerPeriodUsd,
           maxRewardPerAgentPctOfCapital, minTradingProfitUsd, minTrades, maxDrawdownPct,
           explain:[...]},
    poolUsd, budgetUsd, allocationCapRemainingUsd, lifetimeTotalUsd,
    lastRunAt, nextRunAt, lastWinners:[{rank, agentId, name, amountUsd, share,
      periodTradingPnlUsd, periodTradingPnlPct, capitalUsd, periodTrades, periodKey, at}],
    history:[...], // last 50 periods, each with winners + budget/basis
    rankPercents: deprecated alias (mirrors rankShares)  // v3.3
  },
  capitalAccounting: {version:2, migrationMarker, rewardedAgents,
                      tradingPnlTotalUsd, rewardsLifetimeTotalUsd}, // v3.3
  performance: {enabled, targetAnnualReturnPct, requiredDailyReturnPct, baselineAt,
                baselineAccountEquityUsd, baselineTradingPnlUsd, daysElapsed,
                tradingPnlSinceBaselineUsd, annualizedReturnPct, targetProgressPct,
                onTrack, accountEquityUsd, accountCapitalBase, tradingPnlTotalUsd}, // v3.4
  aggression: {enabled, aggressivePct, balancedPct, capitalMultiplier, profiles:{...},
               counts:{aggressive,balanced,conservative}}, // v3.4
  activity: {ordersToday, tradesTotal, positionsTotal, lastCycleExecutions, lastCycleOrders,
             activeProfiles:{...}, haltReasons, halted}, // v3.4
  agents: {
    enabled, configured, provider, model,
    intervalDaySec, intervalSwingSec, maxReviewsPerCycle,
    lastReviewAt, nextDueAt, pausedUntil, pauseReason, runs, errors, lastError, agents
  },
  instruments: {
    enabled, longStock, shortStock, longOptions, shortOptions, coveredCalls, spreads, margin,
    allowedStructures: ['long_call','long_put','covered_call','bull_call_spread','bear_put_spread',
                        'call_credit_spread','put_credit_spread'],
    caps: {maxMarginPctEquity, maxShortPctEquity, maxShortNotionalUsd,
           maxOptionPremiumPctEquity, maxOptionPremiumUsd, maxContracts,
           minDTE, maxDTE, autoCloseDTE},
    optionDataFeed: 'indicative',
    account: {buyingPowerUsd, optionsBuyingPowerUsd, marginMultiplier, shortingEnabled,
              optionsTradingLevel, marginDebtUsd, grossExposureUsd, netExposureUsd} | null,
    treasury: { ...instrument permissions/caps summary } | null,
    effective: {longStock:true, shortStock, margin, creditOptions,
                structures:[...]} | null,
    playbooks: {momentum:{family,tier,summary,bullish,bearish,neutral,structures}, meanrev, breakout, gapfade}
  },
  lastCycle: null | {
    at, marketOpen, tradingSkipped, executions, orders, denied, errors,
    topSkipReasons: {reason: count},
    botReviews: {enabled,configured,due,reviewed,deferred,skipped,errors,budgetUsd,note?,paused?} | null,
    research: object | null
  },
},
strategyMix: {
  swing: {label, count, families:{momentum, meanrev}},
  day:   {label, count, families:{breakout, gapfade}},
  total,
  target: {dayPct, dayCount, swingCount}   // v3.2 70/30 target
},
agents: [{
  ...existing,
  symbols: [SYMBOL, ...],                    // v3.2 multi-symbol basket
  specs: [{symbol, specId, family, params, createdAt}], // one spec per basket symbol
  spec: {symbol, specId, family, params} | null,       // primary-symbol spec only
  equityUsd,                                  // TOTAL equity (includes reward capital)
  tradingPnlUsd, tradingPnlPct,               // v3.3 trading-only P&L; pct is a fraction
  capital: {contributedUsd, baseUsd, rewardCapitalUsd, rewardSharePct, capitalVersion},
  aggression: 'aggressive'|'balanced'|'conservative', // v3.4
  aggressionProfile: {name, basketSizeDay, basketSizeSwing, maxOpenPositionsDay,
                      maxOpenPositionsSwing, maxOrdersPerCycle, entryZMultiplier,
                      sizePctMultiplier, stopPctMultiplier, targetPctMultiplier,
                      maxHoldBarsMultiplier, policySizeFloor, respectStandDown}, // v3.4
  activity: {ordersToday, trades, positions}, // v3.4
  rewards: {lifetimeUsd, count, lastAt, history:[{period, periodKey, at, rank, amountUsd,
            share, periodTradingPnlUsd, periodTradingPnlPct}]},  // v3.3
  pnl: {tradingUsd, tradingPct, tradingRealizedUsd, tradingUnrealizedUsd, rewardsUsd,
        netUsd (=tradingUsd legacy alias), equityChangeUsd, dayPct, weekPct, monthPct}, // pct = fractions
  rankings: {dayRank, weekRank, monthRank, dayPct, weekPct, monthPct,
             tradingDayPct, tradingWeekPct, tradingMonthPct,
             tradingDayUsd, tradingWeekUsd, tradingMonthUsd}, // v3.3 trading P&L
  strategy: {family, category, tier, typeLabel, className, description,
             categoryLabel, estimatedIntervalSec, timeframe, reviewSec},
  instrumentPermissions: {longStock, shortStock, longOptions, shortOptions, coveredCalls, spreads,
                          margin, allowedStructures:[...]},
  playbook: {family, tier, summary, bullish:[...], bearish:[...], neutral:[...], structures:[...]},
  positions: [{symbol, assetClass:'us_equity'|'us_option', side:'LONG'|'SHORT'|'CALL'|'PUT',
               qty, qtySigned, multiplier, groupId, option:{underlying,expiration,type,strikeUsd,dte}|null,
               avgPriceUsd, lastPriceUsd, marketValueUsd, unrealizedPlUsd, openedAt}],
  marginDebtUsd, grossExposureUsd, netExposureUsd,
  policy: null | {at, atMs, stance, sizeMultiplier, riskMultiplier, exitPressure, confidence,
                  thesis, plan:[string], watch:[symbol], instrument:{prefer,maxPremiumUsd,maxContracts,dteMin,dteMax},
                  reviewSec, stale, reviewCount, nextReviewAt},
  orders: [{symbol, assetClass, side, positionIntent, qty, priceUsd, notionalUsd, multiplier, option,
            groupId, realizedPlUsd, at, orderId}], // full fill history
  plan: {
    summary: string,           // 2-4 sentence strategy explanation
    entryRule: string,         // e.g. "Buy AAPL when mean-reversion z <= -1.20"
    exitRules: string[],       // stop / target / max hold / signal
    riskRule: string,          // size + stop distance + caps
    nextStep: string,          // what this bot does next, human sentence
    triggers: {family, symbol, entryZ, exitZ, stopPct, targetPct, maxHoldBars, sizePct, sessionFilter},
    position: {symbol, qty, avgPriceUsd, stopPriceUsd, targetPriceUsd, barsHeld, maxHoldBars} | null,
    nextResearchAt: ISO string | null
  }
}],
rankings: {
  asOf: ISO,
  periods: {
    daily:   [{rank, agentId, name,
               tradingPnlUsd, tradingPnlPct, baselineCapitalUsd, baselineTradingPlUsd,
               periodTrades, tradingPlUsd, capitalUsd, trades, equityUsd, baselineEquityUsd,
               pnlUsd, pnlPct}], // v3.3: trading fields are the fair/ranking ones; legacy pnl* kept
    weekly:  [...],
    monthly: [...]
  }
},
rewards: { ...engine.rewards, history: [{periodKey, period, at, basis, budgetUsd,
  winners:[{rank, agentId, name, amountUsd, share, periodTradingPnlUsd, periodTradingPnlPct,
            capitalUsd, periodTrades}]}] }
```

## Real-time market route (v3.2)

`engine.marketView()` backs a loopback-only **`GET /automaton/market`** route (GET/HEAD; redacted;
503 structured fallback when unavailable; no new tools/control actions):

```js
{
  ok, at, marketOpen,
  quotes: {SYM: {priceUsd, bid, ask, changeUsd, changePct, openUsd, highUsd, lowUsd,
                 prevCloseUsd, volume, ts, stale, simulated?}},
  sparklines: {SYM: [closes...]},            // last ~60 1-minute closes
  portfolio: {equityUsd, cashUsd, buyingPowerUsd, dayPnlUsd, dayPnlPct,
              grossExposureUsd, netExposureUsd, positions},
  agents: [{id, name, tier, strategy, basket, equityUsd, dayPnlPct, positions, stance}],
  engine: {running, marketOpen, lastCycle, research, agents, halted, haltReasons},
  equityHistory: [{at, equityUsd, cashUsd}],  // in-memory, up to 240 points
  error: null | {code, message}
}
```

`engine.portfolio` in the state snapshot carries the v3.2 config (`basketSize*`,
`maxOpenPositions*`, `maxOrdersPerCycle`, `strategyMix.dayPct`). The panel polls state every 5 s and
market every 2 s, pauses when hidden/paused, and falls back to state-only rendering when unavailable.

## Rankings module (market teammate, `src/rankings.js`)

Pure + persisted (`stateDir/rankings.json`):

- `createRankings({paths, config, clock})` with `load()`, `save()`,
  `record({atMs, equityByAgent: {id: {name, equityUsd, trades, tradingPlUsd, capitalUsd}}})` — stores
  per-agent per-period baselines for both equity and **trading P&L** (`tradingPlUsd`, `capitalUsd`)
  alongside `trades`; the first observation in the period is the baseline and a rollover starts a new one.
  Archived `previousBaseline`/`previousLast` keep the same fields so a completed period can be paid.
- `compute({atMs, equityByAgent})` returns `{asOf, periods:{daily,weekly,monthly}}`; entries include:
  - `tradingPnlUsd = last.tradingPl - baseline.tradingPl`, `tradingPnlPct = tradingPnlUsd / baselineCapitalUsd`
    (FRACTION, null without baseline), `baselineCapitalUsd`, `baselineTradingPlUsd`, `periodTrades`;
  - legacy `pnlUsd/pnlPct` (equity delta), `equityUsd`, `baselineEquityUsd`, `trades`, `rank`.
  Sorted by trading return/`tradingPnlUsd`; rows without a measured trading baseline sort last with nulls.
- Period keys: `daily = YYYY-MM-DD` (UTC), `weekly = YYYY-Www` (ISO week), `monthly = YYYY-MM`.
- Deterministic: no Date.now/Math.random; uses `clock`.

## Rewards module (v3.3; `src/rewards.js`)

Capital-only performance rewards (`stateDir/rewards.json`):

- `createRewards({paths, config, clock})` with `load()`, `save()`, `duePeriod(nowMs)` →
  `{period, periodKey}` of the just-completed period, `apply({due, rankings, poolUsd,
  allocationCapRemainingUsd, riskByAgent, ledger, nowMs})`, `status()`, `describe()`,
  `historyForAgent(agentId)`, `lifetimeForAgent(agentId)`, `reconfigure()`, `hydrate()`.
- **Eligibility:** measured trading baseline for the period; `tradingPnlUsd > minTradingProfitUsd`
  (default $0.05), `tradingPnlPct > 0`, `periodTrades >= minTrades` (default 3), and drawdown gate
  (`riskByAgent.drawdownPct <= maxDrawdownPct`, default 0.20). No baseline/negative/tiny/no-activity
  bots are skipped — never rewarded on equity noise.
- **Ranking:** highest period trading return (`tradingPnlPct`) first, tie by `tradingPnlUsd`.
- **Budget:** `min(poolUsd * rewardBudgetPctOfPool, maxPerPeriodUsd?, allocationCapRemainingUsd, poolUsd)`
  (default 10% of the treasury pool).
- **Shares:** top 3 receive `rankShares` (default `[0.5, 0.3, 0.2]`) of the budget; each reward is capped
  at `maxRewardPerAgentPctOfCapital * capitalUsd` (default 50%), scaled proportionally if needed, cents floor.
- **Payout:** `ledger.transfer('__treasury__', agentId, amountUsd, {reason:'reward:<periodKey>',
  category:'reward', at})` — the ledger classifies it as **reward capital** (capital contribution), never
  trading P&L. No eligible winners/pool/budget → `skipped` history with no transfer.
- **History/lifetime:** history entry `{period, periodKey, at, basis, budgetUsd, winners:[{rank, agentId,
  name, amountUsd, share, periodTradingPnlUsd, periodTradingPnlPct, capitalUsd, periodTrades}]}` (last 50),
  plus cumulative `lifetime` map per agent. Not paid twice per periodKey.
- Defaults/config: enabled true, period weekly, basis 'trading-performance', rankShares `[0.5,0.3,0.2]`,
  rewardBudgetPctOfPool 0.10, maxPerPeriodUsd null, maxRewardPerAgentPctOfCapital 0.50,
  minTradingProfitUsd 0.05, minTrades 3, maxDrawdownPct 0.20. Deprecated v3.2 `rankPercents`/`account-cash`
  are accepted and mapped away; config validation covers all new fields.
- **P&L fairness:** reward payouts raise equity/capital/rewardCapital but never `tradingPnlUsd`; reward
  capital is excluded from P&L, returns and reward ranking. See `docs/FAIR-PNL-REWARDS.md`.

## Panel (plugin teammate)

One control-panel section above the agent table:

- **Research cadence**: segmented control (`Every 1h / 3h / 6h / 24h / Before open / After close /
  Before open + after close`) + enabled/influence switches + "Apply" → `set-research-settings`;
  shows current mode, `nextDueAt`, provider/model, paused reason. Keep existing read-only research
  status visible per agent.
- **Rewards (v3.3)**: enable toggle, period selector (daily/weekly/monthly), **rank share** inputs
  (default 50/30/20 of the reward budget), reward budget % of pool, per-agent capital cap %, minimum
  trading profit, minimum period trades, max drawdown, optional max per period; preview shows the current
  pool, computed budget and the rule explain list, Apply → `set-reward-settings`. "Pay now" is not
  offered (payouts are period-boundary only). Show eligible candidates (ranked by period trading return
  with eligibility reasons), last winners and the payout history table. Rewards are paid as **capital**
  and never counted as P&L.
- **Trading P&L vs equity**: agent table/detail labels trading P&L separately from total equity; add
  the lifetime **Rewards** column, a capital breakdown, and a per-agent **reward history** table.
- **Leaderboards**: tabs Daily / Weekly / Monthly, table rank/name/**Trading P&L %/$**/trades/total
  equity; top 3 highlighted with medal words; show period key + as-of; clicking a row opens that agent's
  detail.
- **Agent detail**: keep existing holdings/activity, add: "Strategy & plan" (summary, entry rule, exit
  rules, risk rule, next step, triggers grid), "Transactions" full order/fill table (side, symbol,
  qty, price, notional, realized P&L, order id, time), rankings badge if present, research section
  (already exists), and next research time.
- Controls remain loopback-only, theme tokens, 3 s poll with pause, no data mutation client-side.

## Tests

- rankings: trading baselines/archives + periodTrades, rollover, sorting by trading return, ties,
  missing trading baseline never fabricates P&L.
- rewards: trading-performance eligibility (profit/trades/positive return/drawdown), ranking by trading
  return, rank shares 50/30/20 of the pool budget, capping by pool/allocation/maxPerPeriod/per-agent
  capital, once-per-period, skip/no-transfer, lifetime/history, payout classified as reward capital not
  P&L.
- research schedule: interval vs pre-open/post-close windows via marketClock, reconfigure live.
- engine: status additions + updateResearchSettings/updateRewardSettings persist overlay and apply;
  fair P&L/capital/reward-history fields; marketView portfolio day P&L fractions.
- plugin: control actions validation + loopback/confirm, UI mapping helpers for cadence, fair P&L,
  reward rules/candidates/history, leaderboards, plan/transactions, empty states.
- integration/security: no broker transfer methods used, reconciliation stays ok after a reward payout,
  reward cannot change trading P&L/rank, allocation cap respected, no secrets in reward history.
