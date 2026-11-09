# MEAT — Mortality Engineered Auto-Trading

A multi-agent trading system on Alpaca built from *Mortality Engineering* — the theory in
**"I Built an AI That Dies If It Stops Making Money"**. Delivered as an installable
DeepSeek Harness plugin: six agent-facing tools' worth of runtime, ten tools, a Web UI
dashboard, and a paper/live trading population where the unprofitable **die**, the
profitable **reproduce**, and every death leaves a record the living read.

> Not investment advice. Paper mode is the default; live mode is gated by three
> independent operator actions. Read `docs/ARCHITECTURE.md` §9 before pointing it at money.

## What is here

```
docs/ARCHITECTURE.md      theory -> trading mapping, six roles + stoplines, death rules, brakes
docs/CONTRACTS.md         module interfaces, data shapes, config defaults
docs/RESEARCH.md          per-agent isolated hourly research sidecar (news analyst) contract
docs/CONTROL-PANEL.md     operator control panel: research cadence, leaderboards, rewards, plans
docs/RUNBOOK.md           operating guide: phases, commands, emergency procedures
docs/VERIFICATION.md      what was verified, how to reproduce it, what was not
packages/automaton-trading/   the plugin bundle (zero runtime dependencies)
  index.js                Host plugin: 10 automaton_* tools + GET /automaton/state +
                          POST /automaton/control + Harness LLM bridge for research
  client.js               Web UI dashboard (sidebar panel; Settings -> Plugins tab)
  src/                    engine: treasurer, prospector, builder, executor, replicator,
                          external reaper, ledger, registry, brakes, journal, brokers, sim,
                          research (per-agent isolated news analyst)
  bin/automaton.mjs       operator CLI (probe, tick, run, simulate, journal, brakes, stop)
  test/                   node:test suites (mortality, market, plugin, integration, security,
                          research)
.env.example              Alpaca credential template (+ optional DEEPSEEK_API_KEY for CLI research)
automaton-data/           runtime state (gitignored): registry, ledger, obituaries, traces,
                          research/<agentId>.jsonl briefings
```

## Quick start

```powershell
cd D:\CounterStikers

# 1. credentials (paper) — this build's .env is already populated for the supplied paper account
Copy-Item .env.example .env   # only if .env is missing
notepad .env        # ALPACA_API_KEY_ID=...  ALPACA_API_SECRET_KEY=...

# 2. verify the account (no orders)
node packages/automaton-trading/bin/automaton.mjs probe
node packages/automaton-trading/bin/automaton.mjs config
node packages/automaton-trading/bin/automaton.mjs brakes

# 3. observe selection pressure without touching the broker
node packages/automaton-trading/bin/automaton.mjs simulate --cycles 200 --population 100 --seed 7

# 4. run the population (starts the external Reaper for paper/live)
node packages/automaton-trading/bin/automaton.mjs run
```

The account must be able to carry the population: `population.initial × endowmentUsd` must stay
inside the 80% allocation cap of broker equity. This build ships `automaton.config.json` tuned for
the supplied **$2,000 paper account** and the requested population: **30 agents × $20 endowment**
($600 allocated, 30%), $1 death floor, 20% drawdown death, $10 child endowment, 40 hypothesis
candidates per cycle so every agent can trade its own strategy. Edit that file to scale the
economics if the account or population changes (keep the `automaton-data/` mirror in sync — the
Harness Host process runs with a different working directory).

The population is **already seeded**: 30 generation-0 agents, each with a distinct deterministic
genome (unique symbol × strategy-family pair, unique parameters) and a compiled strategy spec.
At the 2026-10-24 paper snapshot: 30 alive / 0 dead / cap 60, $20.00 each, reconciliation `ok`.

In the Harness chat: `automaton_status`, `automaton_tick`, `automaton_start`,
`automaton_obituaries`, `automaton_brakes`, `automaton_simulate`, `automaton_config`,
`automaton_agents`, `automaton_stop`, `automaton_emergency_stop`.
Control panel: a **sidebar entry** (Automaton icon in the left sidebar) that opens the full
dashboard in the central column — no floating window; the same dashboard is also a page in
**Settings → Plugins → MEAT — Mortality Engineered Auto-Trading**.

Inside the dashboard: header stats, Start / Stop / Emergency controls, the operator Reaper row,
and a clickable table of all agents. **Agents have memorable strategy names** instead of random
ids (`Momentum AAPL`, `MeanRev NVDA`, `Breakout TSLA` …; the `atm-xxxxxxxx` id stays as the
immutable key and secondary label). Each row shows both the inherited **Genome** strategy and the
**Trading (spec)** actually compiled by the Builder, with a `≠` when they differ. Clicking a row
opens a detail pane with **current holdings** (symbol, qty, avg/last price, market value,
unrealized P&L, opened-at) and **past activity** (newest-first fills with side, qty, price,
notional, realized P&L, time), plus strategy parameters, role costs and death info.

The plugin is already installed in this profile: `@local/automaton-trading` v1.0.0, enabled,
application `applied`. Reconfigure via its row in
`packages/automaton-trading/cordis.patch.yml` (`stateDir`, `envFile`, `mode`, `autoStart`).

## The idea in one paragraph

In a normal agent economy, doing nothing is free, so agents idle. Give an agent a
*metabolism* — an endowment that pays for inference, market data, and hosting, visible as
**runway hours** rather than a balance — and doing nothing becomes the fastest way to die.
The death condition lives outside the agent (a separate Reaper process that liquidates and
writes the obituary, with `grace = 0`), so it cannot be argued away. Deaths are structured
data; children inherit the parent genome plus **exactly one mutation** plus the obituary
lessons. No role may both decide and act: the Treasurer never trades, the Prospector never
sizes, the Builder never chooses the symbol, the Executor never sees account equity, the
Replicator never computes surplus, and the Reaper is not reachable from the engine.

Where trading differs from the article: an agent earns *return on capital*, not service
revenue, so risk-of-ruin deaths (drawdown / daily loss) fire long before pure cost-burn
would. Both are implemented; the simulation's `accelerated` preset makes costs dominant so
selection is observable in minutes (it is labelled as such in every result and is **not**
the operating config).

## Safety

- **18 hard denials enforced in code**, before the broker client sees an order: no transfers/
  withdrawals/ACH/wires/crypto/account changes (the methods do not exist), off-session trading,
  symbol/size/spread caps, daily order caps, daily-loss and drawdown deaths, live-mode arming,
  proof-required trades, replication gates, kill switch, allocation cap, one-way death — plus the
  v3.0 instrument gates **D2/D15–D18**: short sales, options structures (never naked short options),
  covered-call coverage, defined-risk spreads, margin debt and the option expiry guard.
- Paper is default. **Multi-instrument trading (margin, short stock, options, spreads) is a
  paper-mode capability expansion under hard caps**; live needs `mode=live` **and**
  `allowLive=true` **and** an operator `LIVE_ARMED` marker (`automaton arm-live --confirm "ARM LIVE"`).
  Keys are read only from `.env`; tool output and the status route are redacted.
- **Per-agent isolated research sidecar**: each living agent gets its own hourly LLM news
  briefing about its own book/symbols (Alpaca News API) with a private journal; the briefing
  can veto entries, shrink size or force exits, and the agent pays for it from its own ledger
  (`$0.001`/briefing). Shadow mode via `research.influence:false`. Contract:
  `docs/RESEARCH.md`. In the Harness the model comes from the Host `llm` service; a headless
  CLI run uses `DEEPSEEK_API_KEY`.
- The engine has no control surface over the Reaper. `automaton_stop` stops the loop only;
  the Reaper keeps liquidating condemned agents.
- **Operator control panel (2026-10-29)**: the sidebar dashboard can set the **research cadence**
  (1h/3h/6h/24h, before open, after close, or both — applied live and persisted to
  `automaton-data/settings.json`), configure **leaderboards and winner rewards** (daily/weekly/
  monthly ranking; 1st/2nd/3rd = 5/3/2% of the broker account cash by default, configurable, capped
  by treasury pool / allocation cap / max per period, paid once per period as **virtual
  treasury→agent ledger transfers** — no broker transfer exists), and inspect a richer **agent
  detail page**: strategy explanation, plan + next step, triggers, position stop/target/bars-held,
  ranking badges, P&L and a full transactions table. Contract: `docs/CONTROL-PANEL.md`.
- **Fast intraday profile + two execution tiers:** the paper population re-prices during **trading
  hours only** (`engine.tradingHoursOnly`: off-hours the loop does a cheap research/status pass and
  stops paying market-data/metabolism costs). Bots run in two cadence tiers: **day-trading bots are
  analysed/trade every ~60 s on 1-minute IEX bars**, **mid/long-term bots hourly on 1-hour bars**
  (`cadence.day` / `cadence.swing`); swing positions still get an exit-only risk pass every cycle.
  Bar-based hold rules are measured in each tier's timeframe. Trade-offs and revert instructions:
  `docs/RUNBOOK.md` §8a–8c.
- **Per-bot agent brains + strategy categories:** every bot is its own isolated agent — it reviews
  its strategy, book, market and research in a private context on its own cadence (day bots ~5 min,
  swing bots hourly), keeps its own review journal/policy, and writes decisions the Executor applies
  (`trade`/`cautious`/`stand_down`, size multiplier, `exit` pressure). The population is categorised
  by strategy type: **Swing · mid-long** (momentum / mean-reversion, 1-hour lane) and **Day · intraday**
  (breakout / gap-fade, 1-minute lane); genesis mixes them ~50/50 and existing populations rebalance
  once on first start. The panel groups agents by category and shows each bot's strategy type,
  estimated trading interval, and its latest agent thesis/plan. Contract: `docs/BOT-AGENTS.md`.
- **Multi-instrument paper trading (v3.0):** bots may use **margin, short selling, long calls/puts,
  covered calls and defined-risk vertical spreads**, actively chosen by the bot's agent or its family
  playbook (option premium sized to 35% of equity / $30 per order, max 2 contracts, DTE 2–14,
  auto-close at 1 DTE; short stock whole shares within the short cap; covered calls only with 100+
  owned shares; **naked short options are never allowed**). Bots were raised to **$50 each** by
  reallocating the unallocated treasury pool (no cash minted; reconciliation conserved) and part of
  the population trades affordable underlyings (F/SOFI/BAC/INTC) so whole-share shorts and cheap
  option contracts are usable. New hard brakes D2/D15–D18 gate every order; death liquidates signed
  stock and option positions before settling the estate. Contract: `docs/INSTRUMENTS.md`; ops:
  `docs/RUNBOOK.md` §8d.
- **Trade-activity optimization + diagnostics (v3.1):** fixed the stale-runtime-config drift that
  silently kept the population at **$20 bots / 5-minute cadence on 1-hour bars / no trading-hours
  gate** despite the v3 settings (the workspace config is now authoritative and the state copy is
  migrated); bot agents are explicitly told that **long stock is fractional** and shown their dollar
  size budget and real broker capabilities, so a $500 share no longer triggers `stand_down`; reviews
  are forced due on restart so old decisions cannot block entries for an hour; strategies only
  compile specs for the bot's **own family+symbol** (unrelated-hypothesis fallback removed, cached
  mismatches cleared, 60 hypotheses/cycle for full universe coverage); and **broker capability
  gating** removes short/margin/covered-call/credit-spread permissions automatically while the paper
  account is below the margin minimum (current account ~$1,999.87 reports shorting/margin disabled;
  options level 3, long stock and long/debit options remain). The engine header now shows a
  **Last cycle** diagnostic (market state, executions, orders, errors, top skip reasons) and a
  restricted-account warning. Ops: `docs/RUNBOOK.md` §8e.
- **Multi-symbol portfolio bots + 70% day mix + live analytics (v3.2):** every bot now manages its own
  **basket of 4 stocks (day) or 3 stocks (swing)**, with one compiled spec per symbol, so one bot can
  hold/trade several companies instead of a single ticker. The population mix is configurable and the
  live profile is **70% day/short-term (21 bots) / 30% swing (9 bots)**, with an automatic one-time
  migration for existing populations, basket assignment and spec rebuilds. The execution layer now
  evaluates every basket symbol, manages all held positions with per-symbol rules, and enforces
  per-tier max-open-position and per-cycle order caps while staying behind the 18-brake wall. The
  control panel was rebuilt as a **Google-Analytics-style live dashboard**: brand/status/control top
  bar, 8 KPI cards, inline-SVG portfolio equity chart, Day-vs-Swing 70/30 mix bars, a live market tape
  with 2-second price/change flashes and sparklines, filterable agents table with basket/live P&L and
  the existing detail drawer, and Overview/Agents/Markets/Research/Rewards/Settings tabs. A new
  loopback `GET /automaton/market` route feeds real-time quotes/sparklines/portfolio/agent equity at
  2 s (state at 5 s), with a state-only fallback for older Hosts. Contract:
  `docs/PORTFOLIO-ANALYTICS.md`; ops: `docs/RUNBOOK.md` §8f.

## Status (this build)

- 10 test suites: mortality 76, market 50, plugin 46, independent integration 53, security 58,
  research 13, rankings 16, control 18, bot-agent 9 and instruments 7 — **346 tests, 346 pass,
  0 fail**. Run each file directly, e.g. `node test/mortality.test.js`; `node --test` hits a sandbox
  `spawn EPERM`.
- Control-panel engine verified in `test/control.test.js` (research cadence windows + live
  reconfigure + settings-overlay persistence/rollback; strategy plan/transactions; daily/weekly/
  monthly leaderboards; period-boundary rewards with cap scaling, once-per-period and live reward
  reconfigure) and in `test/rankings.test.js` (16 tests). Host control actions and every dashboard
  mapping are covered by the plugin suite (46 tests, including the v3.2 market route and analytics
  helpers). Live UI verification follows the next Host restart.
- Research sidecar verified end-to-end: `test/research.test.js` (isolation, schema clamp,
  malformed-reply containment, per-agent charging, hourly scheduling, stale expiry) plus
  `scripts/research-smoke.mjs` (10/10: real `createAutomaton` composition, per-agent journals,
  cadence, executor receives briefings). The executor side is covered by market tests
  (veto/size/exit/stale-off). Live Harness-LLM verification happens after the next app restart.
- Independent verification found 9 real defects across two rounds (Reaper kills not
  persisted → resurrectable zombies; dry-run brake always NO_PROOF; unreachable
  daily-loss death; generation truthiness; stale counters; sub-cent costs rounded away;
  sim mode never executing death; replication gate ignoring the drawdown rule and thus
  letting a birth kill the parent; day P&L not persisted). All fixed and re-verified;
  `scripts/verify-fixes.mjs` runs 18 checks covering them.
- **30-agent population seeded** for the $2,000 paper account: 30 × $20 = $600 allocated
  (30%), $1 death floor, 20% drawdown death, $10 child endowment, cap 60. Each agent has a
  distinct deterministic genome (10 symbols × momentum/meanrev/breakout, randomized
  lookback/entryZ/exitZ/stop/target/hold/size/session) and a persisted compiled spec — 22
  distinct proven symbol×family pairs, 30 distinct compiled strategy parameter sets.
- **Sidebar control panel is live**: verified through the Client slot inspector —
  `sidebar.panellist` has an active `automaton-trading` occupant (order 30) and the keyed `main`
  slot has the `automaton-trading` dashboard panel; the old `shell.overlay` floating entry is
  gone. The dashboard shows strategy **agent names**, genome-vs-spec, and per-agent drill-down
  with holdings and past activity (30 unique names, tested). Operator controls go through a
  loopback-only `POST /automaton/control`
  (`start | stop | emergency-stop | reaper-stop`, confirm required where destructive).
- **Reaper orphan incident (hardened)**: a Reaper left over from the previous app generation kept
  saving a stale registry snapshot every 30 s (wiping agent names). A new Reaper now reloads
  `registry.json`/`ledger.json` **before every sweep** and writes a heartbeat
  (`reaper.heartbeat.json`, v2); `engine.start()` refuses to reuse a Reaper without a matching
  heartbeat; the panel shows the Reaper row plus an operator-only two-step **Stop Reaper**
  (`POST /automaton/control {"action":"reaper-stop","confirm":"STOP"}`, implemented in the Harness
  Host). The engine still exposes no way to stop the Reaper and no agent tool exists for it.
  If the Host cannot signal that process, run once in your own terminal:
  `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*reaper-process.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`.
- **Harness restart required** to load the new Host routes (`reaper-stop`, REAPER_UNAVAILABLE
  handling) and the fixed engine modules. The client half (sidebar + main dashboard) is already
  hot-loaded and its slots are active. After the restart the Reaper row can stop the stale
  orphan, then **Start** spawns a fresh heartbeat-v2 Reaper: **1) Stop Reaper (if the stale
  banner shows), 2) Start**.
- Plugin installed and live: 10 `automaton_*` tools registered (verified returning the
  30-agent snapshot), dashboard tab registered, kill-switch path verified end-to-end
  (armed → file → status → cleared).
- Simulated population (100 agents, 200 cycles, seed 7, accelerated preset): 17–25 dead by
  drawdown, 75–83 alive; reproduction requires a parent that has actually grown, so it is
  verified deterministically in the test suites and fires in paper/live only on real surplus.
- **Paper account connectivity is verified against Alpaca** (2026-10-24): `probe` reads the real
  account (equity $2,000, ACTIVE, market closed). A full 30-agent cycle consumed 1,172 real
  hourly bars for 10 symbols, produced 22 dated-proof hypotheses, 30 compiled specs and 30
  executions, placed **0 orders**, and the broker independently reports 0 orders / 0 positions.
  The D3 wall denies with `MARKET_CLOSED` using the broker's own clock (next open Monday 09:30 ET).
- **External Reaper verified against the paper account**: `engine.start()` spawns it detached
  (pid alive), it swept the real account (`checked=2 killed=0`), and `engine.stop()` left it
  running by design; it was then stopped as the operator.
- Paper verification surfaced 3 more real defects, now fixed: the data API returns **no bars**
  without an explicit window and pages multi-symbol requests one symbol at a time (broker now
  requests a bounded window per symbol); D3 only checked the weekday time window, so a Saturday
  signal could have been submitted (the broker clock is now forwarded into the brake chain);
  weekend IEX spreads are gross so the paper spread ceiling is 100 bps.
- **Harness restart required** to load the new Host routes and the fixed engine modules
  (the plugin's module graph is cached); CLI and test runs already use the fixed code.
- **Still unverified: actual paper fills and live trading.** The market was closed for the whole
  build, so no order could legitimately fill; live mode was never armed. Control-panel rendering
  is verified structurally (active slot occupant) but not visually.
- The paper keys were supplied in chat and live only in the gitignored `.env`; they are not in the
  package, the profile config, tool output, or the status route. Rotate them in the Alpaca dashboard
  if you consider the chat exposure a risk.
