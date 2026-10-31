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
    "rankPercents": [0.05, 0.03, 0.02],
    "basis": "account-cash",
    "maxPerPeriodUsd": null
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
{action:'set-reward-settings', settings:{enabled?:boolean, period?:'daily'|'weekly'|'monthly', rankPercents?:number[], maxPerPeriodUsd?:number|null}}
```

- `settings` required object; unknown keys rejected; values validated (intervalSec must be one of
  `[3600,10800,21600,86400]` for interval mode; rankPercents must be 3 numbers 0..0.5, descending not
  required; maxPerPeriodUsd null or 0..1_000_000).
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
    enabled, period, rankPercents, basis:'account-cash',
    accountCashUsd, poolUsd, allocationCapRemainingUsd,
    lastRunAt, nextRunAt, lastWinners:[{rank, agentId, name, percent, amountUsd, periodKey, at}]
  },
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
  total
},
agents: [{
  ...existing,
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
  pnl: { realizedUsd, unrealizedUsd, netUsd, dayPct, weekPct, monthPct },
  plan: {
    summary: string,           // 2-4 sentence strategy explanation
    entryRule: string,         // e.g. "Buy AAPL when mean-reversion z <= -1.20"
    exitRules: string[],       // stop / target / max hold / signal
    riskRule: string,          // size + stop distance + caps
    nextStep: string,          // what this bot does next, human sentence
    triggers: {family, symbol, entryZ, exitZ, stopPct, targetPct, maxHoldBars, sizePct, sessionFilter},
    position: {symbol, qty, avgPriceUsd, stopPriceUsd, targetPriceUsd, barsHeld, maxHoldBars} | null,
    nextResearchAt: ISO string | null
  },
  rankings: {dayRank, weekRank, monthRank, dayPct, weekPct, monthPct} | null
}],
rankings: {
  asOf: ISO,
  periods: {
    daily:   [{rank, agentId, name, pnlUsd, pnlPct, equityUsd, baselineEquityUsd, trades}],
    weekly:  [...],
    monthly: [...]
  }
},
rewards: { ...engine.rewards, history: [{periodKey, period, at, winners:[{rank, agentId, name, percent, amountUsd}]}] }
```

## Rankings module (market teammate, `src/rankings.js`)

Pure + persisted (`stateDir/rankings.json`):

- `createRankings({paths, config, clock})` with `load()`, `save()`,
  `record({atMs, equityByAgent: {id: {name, equityUsd, trades}}})` — stores per-agent per-period baselines:
  `{daily: {date: equity}, weekly: {isoWeek: equity}, monthly: {yyyy-mm: equity}}` (first observation in the
  period is the baseline; a rollover starts a new baseline).
- `compute({atMs, equityByAgent})` returns `{asOf, periods:{daily,weekly,monthly}}` sorted by
  `pnlPct desc, pnlUsd desc, name asc`; entries include `pnlUsd = equity - baseline`, `pnlPct`,
  `equityUsd`, `baselineEquityUsd`, `trades`. Periods with no baseline omit pnl (null) and sort last.
- Period keys: `daily = YYYY-MM-DD` (UTC), `weekly = YYYY-Www` (ISO week), `monthly = YYYY-MM`.
- Deterministic: no Date.now/Math.random; uses `clock`.

## Rewards module (market teammate, `src/rewards.js`)

Pure scheduler + state (`stateDir/rewards.json`):

- `createRewards({paths, config, clock})` with `load()`, `save()`, `duePeriod(nowMs)` →
  `{period, periodKey}` of the **just-completed** period or null; `apply({due, rankings, accountCashUsd,
  poolUsd, allocationCapRemainingUsd, ledger})`:
  - winners = top 3 alive agents of the completed period ranking (skip agents with null pnlPct);
  - amounts = `rankPercents[i] * accountCashUsd`, then capped by available pool and allocation cap
    remaining, and by `maxPerPeriodUsd`; record the applied (possibly capped) amount;
  - `ledger.transfer('__treasury__', agentId, amountUsd, {reason:'reward', at:nowMs})`;
  - append history entry `{period, periodKey, at, winners:[{rank, agentId, name, percent, amountUsd}]}`,
    keep last 50; `lastWinners` = newest entry winners; `lastRunAt`/`nextRunAt`;
  - insufficient pool/cap → pay a proportionally scaled amount; if 0 pay nobody and record `skipped`.
- Defaults: enabled true, period 'daily', rankPercents `[0.05, 0.03, 0.02]`, basis 'account-cash',
  maxPerPeriodUsd null. Config validation: period enum, 3 percentages 0..0.5, maxPerPeriodUsd null or
  0..1e6.
- Rewards are **not** paid more than once per periodKey (persisted `lastPeriodKey`).

## Panel (plugin teammate)

One control-panel section above the agent table:

- **Research cadence**: segmented control (`Every 1h / 3h / 6h / 24h / Before open / After close /
  Before open + after close`) + enabled/influence switches + "Apply" → `set-research-settings`;
  shows current mode, `nextDueAt`, provider/model, paused reason. Keep existing read-only research
  status visible per agent.
- **Rewards**: enable toggle, period selector (daily/weekly/monthly), three percentage inputs
  (1st/2nd/3rd), optional max per period, preview ("1st = 5% × cash $2,000 ≈ $100 · pool available
  $X"), Apply → `set-reward-settings`; "Pay now" is not offered (payouts are period-boundary only);
  show last winners and history table.
- **Leaderboards**: tabs Daily / Weekly / Monthly, table rank/name/P&L%/$/trades; top 3 highlighted
  with medal words; show period key + as-of; clicking a row opens that agent's detail.
- **Agent detail**: keep existing holdings/activity, add: "Strategy & plan" (summary, entry rule, exit
  rules, risk rule, next step, triggers grid), "Transactions" full order/fill table (side, symbol,
  qty, price, notional, realized P&L, order id, time), rankings badge if present, research section
  (already exists), and next research time.
- Controls remain loopback-only, theme tokens, 3 s poll with pause, no data mutation client-side.

## Tests

- rankings: baselines per period, rollover, sorting, ties, missing baseline.
- rewards: default winners/amounts from cash, capping by pool/allocation/max, once-per-period,
  insufficient-pool skip, persistence/history.
- research schedule: interval vs pre-open/post-close windows via marketClock, reconfigure live.
- engine: status additions + updateResearchSettings/updateRewardSettings persist overlay and apply.
- plugin: control actions validation + loopback/confirm, UI mapping helpers for cadence, rewards
  preview, leaderboards, plan/transactions, empty states.
- integration/security: no broker transfer methods used, reconciliation stays ok after a reward payout,
  allocation cap respected.
