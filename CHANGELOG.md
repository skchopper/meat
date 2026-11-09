# MEAT — Mortality Engineered Auto-Trading

**Changelog / release notes.** Paper trading by default; live trading is triple-gated.
Not investment advice.

Machine identifiers (`@local/automaton-trading`, plugin id `automaton-trading`, the
`automaton_*` tools, `automaton-data/`, `automaton.config.json`, `.env`, `bin/automaton.mjs`)
are intentionally unchanged in this release so the installed plugin, the running paper loop and
existing state migrate with **zero** data changes.

---

---

## v3.2.0 — 2026-11-09 — multi-symbol portfolio bots, 70% day mix and live analytics dashboard

The population now trades **baskets of companies** instead of one ticker, the live profile is
**70% day/short-term / 30% swing**, and the control panel became a real-time analytics dashboard.

- **Multi-symbol portfolio bots.** Every bot's genome carries a `symbols` basket (4 symbols for day
  bots, 3 for swing bots, configurable via `portfolio.basketSizeDay/Swing`). The orchestrator compiles
  and caches **one strategy spec per basket symbol** (`agent.specIds`), the executor evaluates every
  basket symbol independently, manages all held positions with the matching per-symbol rules, and
  enforces tier caps (`portfolio.maxOpenPositionsDay/Swing`, `portfolio.maxOrdersPerCycle`) while the
  18-brake wall remains the ceiling. Legacy single-spec calls stay byte-compatible. One bot can now
  hold and trade several companies at once.
- **70% day-trading population.** Config `strategyMix.dayPct` (live profile **0.7**) drives genesis
  and an automatic one-time migration of an existing population (plus a second migration assigning
  baskets); the tier/family mix is exposed as `strategyMix.counts` + `strategyMix.target`. At 30 bots
  this is **21 day bots (breakout/gapfade, 1-minute lane)** and **9 swing bots (momentum/meanrev,
  1-hour lane)**.
- **Real-time market and portfolio feed.** Broker `getSnapshots()` (Alpaca multi-symbol snapshots,
  2 s cache) and engine `marketView()` deliver quotes (price/bid/ask/change/open/high/low/prev close/
  volume/stale), 1-minute sparklines, portfolio equity/cash/exposure/day P&L and per-agent live
  values; an in-memory equity history powers the chart. Host adds loopback-only
  `GET /automaton/market` (GET/HEAD, redacted, structured 503 fallback, no new tools/actions).
- **Google-Analytics-style dashboard.** The panel now has an analytics layout: top bar with
  brand/mode/running/halted/kill/live-feed/market clock, manual refresh and pause; eight KPI cards;
  inline-SVG portfolio equity chart, sparklines and **Day-vs-Swing 70/30** bars with the target
  marker; a live market tape with 2-second **green/red price-flash animation**, change $/% and
  closed-market “last close” state; a filterable/sortable agents table with basket, live equity, day
  P&L, positions, stance and trend sparkline (row click keeps the full detail drawer); and
  Overview/Agents/Markets/Research/Rewards/Settings tabs preserving every previous control,
  leaderboard, reward setting and bot-agent/research section. State polls at 5 s and market at 2 s
  with pause-on-hidden, manual refresh and a graceful state-only fallback for older Hosts.
- **Status contract additions.** Agents expose `symbols`, `specs[]` and a primary `spec`;
  `status.engine.portfolio` and `strategyMix.target` expose the v3.2 mix/caps; `engine.marketView()`
  and `GET /automaton/market` expose the live view without secrets.
- **Tests:** 10 suites, **346 tests**, all passing (mortality 76, market 50, plugin 46, integration
  53, security 58, research 13, rankings 16, control 18, bot-agent 9, instruments 7), including new
  coverage for baskets/specIds registry round-trips, 70/30 genesis/baskets, multi-symbol executor
  entries/exits/caps, snapshot mapping/cache, engine market view, market route security/fallback and
  the analytics mappings.
- **Compatibility:** baskets and the 70/30 mix migrate once on first start (ids, ledgers and
  histories untouched; old single-symbol agents gain baskets and recompiled per-symbol specs). The
  paper default, 18 brakes, instrument capability gating and live triple-gate are unchanged.

## v3.1.0 — 2026-11-01 — trade-activity diagnosis, fractional-aware bots, coherent strategies

This release fixes why most bots appeared inactive in v3.0 and hardens the trading loop around the
real broker capabilities.

- **Stale runtime configuration fixed.** The installed Host had continued loading an old state-dir
  config (bots at $20, 5-minute ticks on 1-hour bars, `tradingHoursOnly:false`), so the v3 settings
  were not actually active. The Host now prefers the workspace-level `automaton.config.json`
  (`configFile` derived from the state directory) and the legacy state copy was migrated. The running
  profile now really uses **$50 bots, day bots every 60 s on 1-minute bars, swing bots hourly on
  1-hour bars, trading-hours-only monitoring, 20 orders/day, $40 order cap and 60 hypotheses/cycle**.
- **Capital top-up conserves broker equity.** The one-time $20→$50 raise now **reallocates the
  unallocated treasury pool** instead of minting ledger cash, so sum(bot equity) + pool still equals
  broker equity and the Treasurer reconciliation cannot halt from the migration; the bot's endowment
  basis is raised so the transfer is not counted as trading P&L.
- **Bot agents no longer stand down over share price.** The prompt now carries `TRADING_RULES`
  (fractional long stock allowed, minimum order notional, dollar `sizeBudgetUsd`, whole-share-only
  shorts, broker `shortingEnabled`/`marginMultiplier`) and an account-adjusted instrument menu. Agents
  are explicitly told that a high share price, stale quote or closed market is **not** a reason to
  stand down — stand-down is reserved for weak/conflicting evidence or unacceptable risk. Policies
  survive for the dashboard, but every process start forces reviews due so an old stand-down decision
  cannot block entries for up to an hour after a restart.
- **Strategy/spec coherence.** Bots only compile a spec whose **family and symbol match their own
  genome** (exact pair, then the same family on another symbol); the old unrelated-hypothesis fallback
  that made “Momentum F” trade an AMD breakout is removed, cached mismatched specs are cleared on
  start, and the default Prospector budget covers all 14 symbols × 4 families.
- **Broker capability gating.** When the paper account is restricted (currently ~$1,999.87, below the
  margin minimum → `shorting_enabled:false`, no margin buying power), mandate permissions, the bot
  prompt and status no longer offer shorting, margin, covered calls or credit spreads; long stock,
  long calls/puts and debit verticals remain. Permissions re-enable automatically when the broker
  reports margin/shorting again. The engine never constructs orders the account cannot place.
- **Trade-activity diagnostics.** `status.engine.lastCycle` now reports the last cycle's market state,
  executions, orders, denials, errors, top skip reasons and bot-review counters;
  `status.engine.instruments.effective` reports what the broker can actually do. The panel header
  shows a **Last cycle** line with the top-3 skip reasons (e.g. `inside_range`, `gap 4bps`,
  `no_matching_hypothesis`) and an informational warning when shorting/margin are restricted.
- **Option sizing tuned for $50 bots.** Premium cap raised to 35% of equity / $30 per order with max
  2 contracts so cheap OTM contracts are actually reachable; DTE window, auto-close, covered-share
  requirement and never-naked rules are unchanged.
- **Tests:** 10 suites, **305 tests**, all passing (mortality 70, market 43, plugin 43, integration 34,
  security 53, research 13, rankings 16, control 17, bot-agent 9, instruments 7), plus research and
  defect-regression smoke checks. New coverage: fractional-aware bot context, broker capability
  gating, spec/genome coherence, treasury-funded top-up conservation and the last-cycle diagnostics.
- **Known external constraint:** the Alpaca paper account itself currently reports shorting/margin
  disabled below the broker margin minimum. Options level 3, long stock and long/debit options remain
  available; the new capability warning makes this explicit instead of letting orders fail at the
  broker.

## v3.0.0 — 2026-10-30 — multi-instrument paper trading (margin, shorts, options, spreads)

The population may now use margin, short selling, long calls/puts, covered calls and defined-risk
vertical spreads, and actively chooses them when its strategy and economics fit. This is a **paper
account capability expansion**: live trading remains triple-gated by D8, and every order still passes
the hard brake wall first.

- **Capital and coverage.** Bots were raised from $20 to **$50** each (one-time +$30 capital top-up
  per living bot, bounded by the account allocation cap and recorded as capital rather than trading
  P&L; 30 × $50 = $1,500 of the ~$2,000 paper account). Part of the population is re-pointed once at
  affordable underlyings (**F/SOFI/BAC/INTC**, alongside the existing 10 symbols) so whole-share
  shorts and sub-$25 option contracts are actually tradable; specs recompile and strategy-derived
  names refresh without touching ids, ledgers or open positions.
- **Instruments.**
  - *Short stock* — whole shares, shortable+marginable assets, mandate cap; buy-to-cover on
    stop/target/max-hold/signal.
  - *Long calls/puts* — integer contracts with premium sizing, DTE window, premium stop/target,
    research-ALERT exit and DTE auto-close.
  - *Covered calls* — sell-to-open only against ≥100 owned shares (rare at $50/bot; denied otherwise),
    closed at 50% premium profit/stop/DTE guard.
  - *Defined-risk verticals* — bull-call, bear-put, bear-call credit and bull-put credit submitted as
    one multi-leg order, linked by a spread group and closed together.
  - *Margin* — debt allowed within the mandate and configured equity cap; the ledger supports negative
    cash with a hard `MARGIN_LIMIT`.
  - **Naked short options are never constructed and are denied by the brake wall.**
- **Active selection.** Each strategy family has bullish/bearish/neutral instrument playbooks
  (momentum/meanrev: stock or calls/puts, short or credit spreads; breakout: calls/puts for leverage;
  gapfade: shorts/puts/premium selling). The bot's own agent may override with
  `policy.instrument` (structure + premium/contracts/DTE caps); otherwise the playbook picks the first
  affordable structure and falls back to stock/short when option premium cannot fit. Option strikes
  are 2–5% OTM, expiry is nearest inside the DTE window, contracts = floor(budget / premium×100).
- **Risk wall.** D2 is now the instrument-permission gate (was a blanket no-margin/short/options
  denial). New hard brakes **D15 SHORT_FORBIDDEN**, **D16 OPTION_FORBIDDEN** (structure, integer
  contracts/caps, premium caps, covered-share requirement, defined-risk spreads, never naked),
  **D17 MARGIN_LIMIT**, **D18 EXPIRY_GUARD** (sell-to-close always allowed). D1–D14 keep their
  meaning; D4 skips equity price/spread ceilings for option orders while retaining the underlying
  whitelist. The catalogue is **18 hard brakes (D1–D18)**.
- **Ledger and death.** Signed stock positions, option positions with 100× multiplier and spread
  groupIds, cash/equity marks including margin debt, gross/net exposure and realized P&L for long and
  short closes; enriched snapshots and position lists. On death the Reaper liquidates signed stock,
  long/short options and spread legs (sell/buy-to-close, groupId preserved), absorbs margined estate
  debt from the treasury and writes the obituary.
- **Control panel and status.** Positions render as LONG/SHORT stock or CALL/PUT options with
  strike/expiry/DTE/contracts and spread-group tags; totals show gross/net exposure and margin debt.
  Agents gain an Instruments badge, an Instrument playbook block and the bot's Instrument plan; the
  engine header shows options level, shorting, margin multiplier, caps and account options buying
  power/margin debt. Status adds `instruments` (flags, caps, account, playbooks) and per-agent
  `instrumentPermissions`, `playbook` and `policy.instrument`.
- **Config.** New validated `instruments` block (margin/short/options/covered-call/spread flags,
  equity-percentage and absolute caps, contracts, DTE window/auto-close, option data feed); naked
  short options are rejected at config load. Paper remains the default mode.
- **Tests:** 10 suites, **302 tests** — mortality 70, market 43, plugin 42, integration 34,
  security 53, research 13, rankings 16, control 16, bot-agent 8, instruments 7 — plus research and
  defect-regression smoke checks, all passing. Independent verification found and re-verified three
  real v3 defects before release: single-leg option orders were denied because the executor sent the
  underlying instead of the OCC symbol; Treasurer option marks inflated equity 100× and halted
  reconciliation; the sim option chain priced further-OTM contracts higher and blocked verticals.
  All three are fixed and covered by end-to-end regression tests.

## v2.3.0 — 2026-10-30 — per-bot agents, strategy categories and a richer panel

- **Every bot is now its own agent.** On its own cadence each bot gets a private LLM review whose
  context contains only its identity, strategy genome/spec, virtual book, market data for its symbol,
  its own research briefing and its own earlier reviews. Nothing is shared with other bots or the
  operator, and no other bot's data can appear in the prompt. Reviews are stored per bot
  (`agents/<agentId>.jsonl` + `agents/state.json`) and survive restarts.
  - Review cadence: **day bots every 5 minutes**, **swing bots every hour** (~200 reviews/hour for a
    30-bot population); a per-cycle cap spreads the cold start without blocking execution.
  - Each review returns a validated, clamped policy: `stance` (`trade` / `cautious` / `stand_down`),
    `sizeMultiplier` (0.2–1, only shrinks), `exitPressure` (`none` / `exit`), `confidence`, `thesis`,
    `plan`, `watch`. Malformed replies are contained (JSON repair + one retry, no policy, no charge)
    and failures never stall the trading loop.
  - Reviews are charged to the bot's own ledger (category `agent`); missing/stale/disabled policies
    leave the Executor byte-for-byte at its previous behaviour.
- **Strategy taxonomy and population mix.** Momentum and mean-reversion are **Swing · mid-long**
  strategies on the 1-hour lane; breakout and gap-fade are **Day · intraday** strategies on the
  1-minute lane. Genesis mixes a new population roughly 50/50 across the two classes (8/7/8/7 for 30
  bots over 10 symbols, keeping every symbol/family pair unique). The execution tier is derived from
  the strategy family, and children derive their tier from the mutated genome. Populations seeded
  before the taxonomy are rebalanced once on first start (genome family refreshed, spec recompiled,
  strategy-derived name updated; ids, ledgers, positions and history untouched).
- **Executor policy consumption (hybrid architecture).** Execution and the 18 hard brakes stay
  deterministic so minute-level reactions never wait on a model turn: `stand_down` blocks new
  entries (risk-reducing exits still fire), `sizeMultiplier` shrinks entry notional before every
  existing cap (never grows), `exitPressure: exit` forces a position exit after any research ALERT
  and before mechanical rules. Every order still passes the brake wall.
- **Control panel.** Agents are grouped by trading category with **All / Swing · mid-long / Day ·
  intraday** tabs; the agent table gains **Strategy type** and **Est. interval** columns. Each agent's
  detail page gains a **Bot agent** section (stance, size, confidence, exit pressure, thesis, plan,
  watch list, last/next review, review count and a stale warning) plus a category header chip, and
  the engine header shows the bot-agent bridge status (provider/model, cadences, runs/errors, next
  review). Older snapshots render genome-derived fallbacks and empty states.
- **Status contract.** `status.strategyMix` (swing/day counts and families), `status.engine.agents`
  (enabled/configured, provider/model, day+swing cadences, last/next review, runs, errors) and per
  agent `strategy` + `policy` views. `status.engine.agents.configured` is false without an LLM bridge
  (heads-up only; trading continues).
- **Tests:** 9 suites, **244 tests** (mortality 55, market 34, plugin 41, integration 21, security 41,
  research 13, rankings 16, control 15, bot-agent 8), all passing.
- **Compatibility:** new optional config block `agents` (enabled, review intervals, per-cycle cap,
  cost, max age, journal limits, cooldown) with defaults; no new tools, settings/control actions
  unchanged; paper remains the default mode.

## v2.2.0 — 2026-10-29 — trading-hours monitoring + two execution tiers

- **Price monitoring now runs only during trading hours.** `engine.tradingHoursOnly: true` makes the
  loop read the broker clock every cycle; outside RTH it runs a cheap maintenance pass (no market
  data, no prospector/builder/executor, no per-cycle charges) and only the research sidecar + status
  snapshot, then sleeps `engine.offHoursIntervalSec` (default 300 s) instead of the 60 s trading
  tick. Orders were already blocked off-hours by brake D3; this also stops paying data/metabolism
  costs while nothing can trade.
- **Two per-bot execution tiers.** Genesis assigns alternating `tier: day|swing`; children inherit
  their parent's tier (never mutated by a birth). `cadence.day` (default every 60 s on 1-minute
  bars) fully analyses/trades day-trading bots; `cadence.swing` (default every 3600 s on 1-hour
  bars) runs mid/long-term bots. Each tier evaluates bar-based rules on its own timeframe lane.
- **Safety between swing decisions:** a non-due swing bot that holds a position still gets an
  **exit-only risk pass** every cycle (stop/target/max-hold/research-ALERT), so positions are never
  left unmanaged for an hour; it cannot open new positions outside its cadence.
- **Config/status:** new `cadence` block + `engine.tradingHoursOnly/offHoursIntervalSec`
  validation; status adds per-agent `tier` and `cadence {intervalSec, timeframe, lastAnalysisAt,
  nextAnalysisAt}` plus `engine.cadence/tradingHoursOnly`. Existing agents are backfilled
  alternating tiers on first start; removing the `cadence` block restores legacy single-cadence
  behaviour.
- Tests: `control` +3 (cadence config validation, day-vs-swing scheduling with cold start/hour
  boundary, closed-market maintenance pass asserting no executions and no cycle charges) →
  **227 tests across 8 suites**.
- Docs: `docs/RUNBOOK.md` §8b (tiered cadence + trading-hours gate, tuning and revert), README.

## v2.1.0 — 2026-10-29 — fast intraday profile (minute monitoring)

- **1-minute decision loop for the paper population:** `cycleIntervalSec: 60`, `data.timeframe: "1Min"`,
  `data.feed: "iex"`, `lookbackBars: 120`, `risk.maxDailyOrders: 12`. The engine now re-prices the whole
  population every minute during the session instead of every 5 minutes.
- **Hold rules are timeframe-correct:** `maxHoldBars` is measured in bars of the configured timeframe
  (1-minute bars = minutes), so a 12-bar time stop is 12 minutes on the fast profile. The dashboard agent
  plan states the bar duration; the previous code always treated a bar as one hour.
- **Data feed is configurable and validated:** `data.feed` is `iex` (real-time during RTH, free) or
  `sip` (consolidated, 15-min delayed on the free plan); `data.timeframe` is allow-listed. Bars and
  quotes for the orchestrator, executor and prospector all use the configured feed.
- **Trade-offs documented in `docs/RUNBOOK.md` §8a:** IEX is a single venue and sparse outside regular
  hours; minute bars are noisier for strategy specs originally compiled on hourly data; cycle costs
  scale ~5x with the faster loop; the free plan cannot provide true real-time SIP reaction. Revert to
  `1Hour` + `300` for the previous cadence.
- Tests: `control` suite +4 (timeframe→bar math, config allow-list, timeframe-aware hold/plan, 1-minute
  profile boot) → **224 tests across 8 suites**.

## v2.0.0 — 2026-10-29

First public release after the initial code upload. Renamed the project, app and plugin to
**MEAT — Mortality Engineered Auto-Trading**, and added the full operator control plane and the
per-agent research analyst on top of the mortality engine.

### Renamed to MEAT
- Project/app/plugin display name is now **MEAT — Mortality Engineered Auto-Trading**
  (Harness plugin title and locale, sidebar panel header, README, docs, CLI banner).
- GitHub repository renamed to [`skchopper/meat`](https://github.com/skchopper/meat) (the old
  `automaton-trading` URL redirects).
- Internal ids stay stable for zero-downtime upgrade (see note above); the package version is
  bumped to **2.0.0**.

### New: per-agent isolated research analyst (hourly news → trading decisions)
- Each living bot gets its **own** LLM briefing about **its own** holdings and news from the
  Alpaca News API, with a private journal — no other bot's book, no other role's memory.
- Briefing schema: sentiment, confidence, verdict (`HOLD`/`AVOID`/`ALERT`), catalysts, risks,
  summary, timestamped sources; stored per agent in `automaton-data/research/<agentId>.jsonl`.
- **Live influence (advisory only):** fresh briefings can veto a new entry (`research_veto`),
  shrink the order size (never increase it), or force an exit (`research_alert`). Every order
  still passes all 14 hard brakes; the analyst has no order or wallet access.
- **Agent-paid:** `$0.001` per successful briefing is charged to that bot's ledger
  (category `research`), so research shortens its own runway. Failed/malformed replies are free.
- **Cadence is operator-selectable from the panel:** every 1 h / 3 h / 6 h / 24 h,
  **before market open**, **after market close**, or both. Applies live
  (`POST /automaton/control {action:'set-research-settings'}`) and is persisted in
  `automaton-data/settings.json` so it survives restarts.
- Hardened after live incidents: JSON repair + one retry for malformed model replies, provider
  error backoff (15 min, 1 h for fatal errors such as an exhausted API balance), stale briefings
  ignored by trading, and a corrected veto rule so risk lists shrink orders instead of blocking
  every entry.

### New: operator control panel (Harness sidebar)
- **Research cadence** controls (above), collection/influence toggles, next-due time,
  provider/model and pause reason.
- **Rewards control:** enable toggle, period (daily/weekly/monthly), and 1st/2nd/3rd percentages
  of the broker account's **cash** — defaults **+5% / +3% / +2%** — optional per-period maximum,
  live preview against the treasury pool and allocation-cap headroom, last winners and history.
  Payouts are **virtual treasury→agent ledger transfers** at period boundaries only, once per
  period, floored to cents and proportionally capped by pool / allocation cap / max. No broker
  transfer surface exists, so reconciliation is unchanged.
- **Leaderboards:** daily, weekly and monthly rankings of all bots by period P&L %, medals for the
  top 3, click-through to the agent detail.
- **Richer agent detail page:** strategy explanation, exact entry rule, exit rules (stop/target/
  time/signal), risk rule, plan + next step, trigger grid, current position plan (stop/target/bars
  held), P&L (realized/unrealized/day/week/month), ranking badges, next research time, research
  briefing, and a full **transactions** table (time/side/symbol/qty/price/notional/realized/order id).
- Both settings are validated with an allow-list in the Host (500-level errors kept structured,
  `400 INVALID_SETTINGS` on bad input), are loopback-only operator routes, and are **never**
  exposed as agent tools.

### Reliability and correctness fixes since the initial upload
- **Async Alpaca fills:** market orders return `accepted` before filling; the executor now polls
  briefly for the real fill and reconciles every filled broker order per agent, so a fill can no
  longer be lost or booked as a 0-qty ledger rejection.
- **State persistence:** atomic JSON writes retry transient Windows file-lock races; a successful
  cycle clears a stale `lastError`; the external Reaper now persists registry/ledger **only when a
  sweep kills an agent** (single-writer discipline), fixing lost-update races.
- **Harness LLM bridge:** dispatch now echoes the prepared frozen call config (adapter defaults
  included), fixing `INVALID_PREPARED_CALL`; provider/model are recorded per briefing; the research
  output budget is 1200 tokens.
- Research-gate tuning: veto only on explicit `AVOID`/`ALERT` or sentiment ≤ −0.6; risk lists apply
  a size penalty instead of vetoing (a live mis-tune had vetoed 100% of entries).
- Paper loop now runs 30 bots × $20 on the $2,000 Alpaca paper account, with an external Reaper
  enforcing death, replication with exactly one mutation, and obituaries as inherited data.

### Documentation & verification
- New docs: `docs/RESEARCH.md` (research sidecar contract), `docs/CONTROL-PANEL.md`
  (operator panel / rankings / rewards contract); updated `docs/ARCHITECTURE.md`,
  `docs/CONTRACTS.md`, `docs/RUNBOOK.md`, `docs/VERIFICATION.md`.
- **8 test suites, 220 tests, all passing:** mortality 55, market 27, plugin 40, integration 21,
  security 41, research 13, rankings 16, control 7 — plus `scripts/research-smoke.mjs` 10/10 and
  `scripts/verify-fixes.mjs` 18/18.
- Safety invariants covered by the security suite: no transfer/withdraw surface, live gating
  (`mode`+`allowLive`+`LIVE_ARMED`), kill switch, one-way death, hard population cap, and no engine
  control over the Reaper.

### Upgrade notes
1. Restart the DeepSeek Harness app to load the new Host engine + panel (Host plugin modules are
   ESM-cached). The sidebar panel will show the MEAT title, cadence control, rewards card,
   leaderboards and expanded agent detail.
2. The paper loop does not auto-start (`engine.autoStart: false`): press **Start** in the panel.
3. Research needs LLM credit in the Harness-configured DeepSeek account (top up if it is empty);
   without it, research pauses and trading continues without research influence.
4. Run `node packages/automaton-trading/bin/automaton.mjs probe` after any config change to verify
   Alpaca connectivity without placing orders.

### Known limitations
- The panel is operator-only and requires the Harness app to be running; research/trading stop when
  the PC/app is off (no cloud deployment).
- Reward percentages are capped by the shared treasury pool and the 80% allocation cap; on a
  $2,000 account the default 5/3/2% daily schedule is intentionally generous and will hit those
  caps over time — lower the percentages or choose weekly/monthly for longevity.
- Live UI verification of the new panel happens after the Host restart (engine tests and plugin
  mapping tests are green before it).
