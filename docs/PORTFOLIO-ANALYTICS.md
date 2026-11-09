# MEAT v3.2 — MULTI-SYMBOL PORTFOLIO BOTS + REAL-TIME ANALYTICS (contract)

> **Status:** implemented (v3.2): strategyMix/portfolio config, 70/30 genesis + one-time migrations,
> registry baskets/specIds, per-symbol spec compilation, portfolio executor, broker getSnapshots,
> engine.marketView + Host `GET /automaton/market`, Google-Analytics-style live dashboard.
> Tests: 346/346 across 10 suites (mortality 76, market 50, plugin 46, integration 53, security 58,
> research 13, rankings 16, control 18, bot-agent 9, instruments 7).

User request: bots are too inactive; some/all should manage **multiple company stocks** instead of one
symbol; **70% of the population day/short-term**; and the plugin UI should become a **Google-Analytics
-like, interactive dashboard with instant prices/P&L**.

## 1. Strategy mix: 70% day / 30% swing

- Config: `strategyMix: { dayPct: 0.7 }` (validated 0.1..0.9). Day families = breakout, gapfade
  (1-minute lane, 60 s cadence/5 min reviews); swing families = momentum, meanrev (1-hour lane,
  hourly reviews).
- Genesis `targetFamilyForIndex(index,count,dayPct)` must produce `round(count*dayPct)` day slots
  (families breakout/gapfade alternating blocks) and the rest swing (momentum/meanrev blocks),
  keeping each (symbol,family) pair unique for the basket assignment.
- Migration `balanceStrategyMixV32()` (marker `automaton-data/portfolio-v32.json`): if the live mix is
  more than 5 percentage points away from the target, reassign families deterministically, clear old
  specs, refresh strategy-derived names, tier = family category. Ids/ledgers/positions untouched.
- Status `strategyMix` continues to expose counts/families; UI tabs show Day/Swing with target 70/30.

## 2. Multi-symbol portfolio per bot

### Genome / registry
- `agent.genome.symbols`: array of 2–5 unique uppercase symbols, `symbol` remains the primary
  (first entry) for naming/back-compat.
- Registry `normalizeAgent` preserves `symbols` (derived from `agent.symbols ?? genome.symbols ??
  genome.symbol`), and `specIds`: object mapping symbol → specId (legacy `specId` kept as primary).
- Config `portfolio` block:
  ```js
  portfolio: {
    basketSizeDay: 4,        // day bots manage 4 symbols
    basketSizeSwing: 3,      // swing bots manage 3
    maxOpenPositionsDay: 5,
    maxOpenPositionsSwing: 3,
    maxOrdersPerCycle: 2,    // entries+exits per bot per engine cycle
  }
  ```
  `risk.maxOpenPositions` raised to 6 (brake ceiling); executor enforces the tier-specific cap.
- Basket selection (genesis & migration): rotate through `config.symbols` so baskets overlap but every
  bot gets its own combination, e.g. `symbols[i..i+size-1]` wrap-around. Primary = first.
- Migration `assignBasketsV32()` (marker above): for each living agent set genome.symbols from its
  index, clear `specIds`/`specId`; keep primary name (append ` +N` only
  if the name already exists). Persist.
- Replication: child inherits the parent basket; the single mutation may change one symbol inside the
  basket (still one mutation). Child `symbols` normalized and primary updated.

### Specs / builder
- Orchestrator `ensureSpecs(agent, hypotheses, budget, usedPairs)`:
  - considers only hypotheses whose family equals the bot family and symbol is in the basket;
  - compiles/reuses one spec per symbol (`specIds[symbol]`), requiring exact genome/param match
    (existing coherence rule);
  - returns `{specs, primary}`; `specs` may be empty if no proven symbol this cycle (skip);
  - persists `specIds` + primary `specId`; clears stale/mismatched entries.
- Status/agent row adds `symbols` (basket), `specs: [{symbol,specId,family,params}]`, `spec` = primary.

### Executor
- `executor.run({ ..., spec, specs, portfolio })` accepts BOTH:
  - legacy single `spec` (existing tests/calls), and
  - `specs` array (basket). `portfolio = {maxOpenPositions, maxOrdersPerCycle}` supplied by caller.
- Portfolio behavior (market teammate):
  - Build `specsBySymbol`; exits iterate **all held positions** and use the matching symbol spec
    (fallback primary) for stop/target/max-hold rules; options/spreads keep their group exits.
  - Entries iterate basket specs; evaluate each signal independently; skip symbols already held;
    respect tier max open positions, max orders per run, mandate/order caps and existing
    research/policy gates. One order per symbol per run.
  - Aggregate actions/orders/denied/spentUsd exactly like today; `detail` entries include symbol.
  - No new order path; brakes first for every order (extended input unchanged).
- Orchestrator passes `specs` + tier caps; riskOnly passes still manage **all** positions.
- Risk/treasury: mandate still one size budget per bot; per-position sizing from `sizePct * budget`;
  ledger cash/position caps already enforced; `maxOpenPositions` limit moves into the executor (brake
  D5 remains the absolute ceiling).

### Bot-agent prompt
- `BASKET`, `POSITIONS` (all symbols), `WATCH` basket included; policy applies to the whole basket.
- Instrument context/account capabilities unchanged (fractional stock, no short/margin while broker
  restricted). The bot can prefer a symbol? v1 no — executor trades all basket signals; prompt says
  it manages a basket and may set exitPressure/stance for all.

### Status/UI
- Agent rows: `symbols`, `specs`, positions across basket, basket label (`Momentum · F,SOFI,BAC,INTC`).
- Agent table shows basket (truncated) and links detail; Positions table already supports multiple
  symbols/options.

## 3. Real-time market endpoint (Host + engine)

### Broker (market teammate)
- `getSnapshots(symbols, { feed = 'iex' })` → `Promise<Record<symbol, {
    symbol, priceUsd, bid, ask, changeUsd, changePct, openUsd, highUsd, lowUsd, prevCloseUsd,
    volume, ts, stale }>>` using Alpaca `GET /v2/stocks/snapshots?symbols=A,B&feed=iex`
  (`latestTrade`, `latestQuote`, `minuteBar`, `dailyBar`, `prevDailyBar`); sim broker returns
  deterministic snapshots for the same symbols. No new order surface. Cache 2 s on the broker.

### Engine facade
- `engine.marketView()` → `Promise<{ ok, at, marketOpen, quotes, sparklines, portfolio, agents,
  engine, equityHistory }>`:
  - `quotes`: snapshots above for `config.symbols` (redacted, no keys);
  - `sparklines`: last ~60 1-minute closes per symbol (one multi-symbol `getBars` call, cached 15 s);
  - `portfolio`: `{equityUsd,cashUsd,buyingPowerUsd,dayPnlUsd,dayPnlPct,grossExposureUsd,
    netExposureUsd,positions}` from latest status;
  - `agents`: `[{id,name,tier,strategy,basket,equityUsd,dayPnlPct,positions,stance}]`;
  - `equityHistory`: in-memory ring of `{at,equityUsd,cashUsd}` sampled ≤1/s (240 points);
  - `engine`: `{running,marketOpen,lastCycle,research,agents}` (no secrets).
  - Cache whole view ≤2 s; on broker failure return last good view + `error` (never throw 500).

### Host route
- `GET /automaton/market` (loopback-only, GET only, redacted JSON) next to `/automaton/state`;
  delegates to `engine.marketView()` defensively; 403 non-loopback; 400/405 structured errors.
- No new agent tools; no new control actions.

### Client UI (plugin teammate)
A Google-Analytics-style analytics dashboard, responsive, theme-token only, no external chart deps:
- **Top bar**: MEAT brand, paper/live + running badges, market open/closed + clock, auto-refresh
  toggle (2 s market, 5 s state), Start/Stop/Emergency controls unchanged.
- **KPI cards**: Account equity (live delta arrow), Day P&L $/%, Cash/Buying power, Gross exposure,
  Population alive/total, Trades today, Win rate, Treasury runway/state.
- **Charts (inline SVG)**: portfolio equity area chart from `equityHistory`; day P&L sparkline;
  market watchlist sparklines (60 × 1 m); strategy mix donut/bars (Day 70% / Swing 30% target).
- **Live market tape/table**: symbol, last price, change $/%, bid/ask, sparkline, up/down flash
  animation and color; "market closed · last close" state when closed.
- **Agents panel**: filterable/sortable table with name, strategy, basket, tier, equity, live
  day P&L, positions, stance, sparkline; click opens the existing detail drawer (holdings,
  transactions, plan, bot agent policy, instrument playbook, research, rankings).
- **Tabs**: Overview / Agents / Markets / Research / Rewards / Settings (reuse existing sections).
- **Interactions**: hover tooltips on charts, sortable headers, search, status filters, pause,
  manual refresh, selected agent persisted, keyboard Esc close.
- Poll `/automaton/market` every 2 s and `/automaton/state` every 5 s while running; pause when tab
  hidden; timers cleaned; guarded fields for old Hosts (fallback to state-only rendering).
- Pure mapping helpers exported for tests: marketTapeRows, kpiCards, equityChartPoints,
  sparklinePath, agentTableRows, strategyMixBreakdown, liveView mapping; tests cover up/down,
  closed market, empty/bare payload, sorting/filtering.

## 4. Config/wake-up fixes
- Live state currently: engine stopped/halted `broker_unavailable`, treasury CRITICAL because the
  weekly reward payouts pushed allocation to ~$1,587 of the $1,599.89 cap and one API read failed.
  On start the next successful tick must clear the halt; do not auto-reward at startup. Ensure the UI
  Start control + status clearly shows halted/why (`haltReasons`, lastError).
- `risk.maxOpenPositions` 6 and portfolio caps as above; day cadence 60 s, swing 3600 s; 70% mix.
- Keep all existing instruments capabilities (account still reports shorting/margin disabled; the
  engine gates them and options/long stock remain).

## 5. Tests
- market: broker `getSnapshots` mapping + sim; executor basket entries across symbols, exits for all
  positions, max open positions/orders, legacy single-spec compatibility, brakes-first.
- mortality: registry basket/specIds normalization + persistence; mandate unchanged.
- control/integration: 70/30 genesis+migration, basket assignment, multi-spec compilation, status
  fields, engine.marketView shape/no secrets, host route; halted state recovery.
- plugin: market tape/KPI/charts/live mapping, tabs, polling fallback, existing controls/detail.
- verifier: independent end-to-end (multi-symbol round trips, 70/30, market route, halted recovery).
