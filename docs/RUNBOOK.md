# RUNBOOK — operating MEAT

Everything below runs from `D:\CounterStikers\packages\automaton-trading` unless stated.

## 0. What you are operating

A population of virtual trading agents sharing one Alpaca account. Each agent has an
endowment, pays its own cost of existence (inference/data/hosting per cycle), and is
killed by an **external Reaper process** when its equity hits the death floor, its
drawdown limit, or its daily loss limit. Profitable agents reproduce with one mutation;
dead agents leave obituaries that children inherit. Paper is the default; live is gated.

## 1. Prerequisites

- Node ≥ 22 (this machine: `C:\Program Files\nodejs\node.exe` or the DSH bundled runtime).
- Alpaca **paper** account + API keys. Put them in `D:\CounterStikers\.env`:

  ```dotenv
  ALPACA_API_KEY_ID=PK...
  ALPACA_API_SECRET_KEY=...
  AUTOMATON_MODE=paper
  ```

  Keys never enter the plugin package, the profile config, or tool output; only the
  engine and the external Reaper read `.env`.

- Workspace state lives in `D:\CounterStikers\automaton-data\` (registry, ledger,
  obituaries.jsonl, traces.jsonl, specs/, KILL_SWITCH, reaper.pid, reaper.log).

## 2. Verify connectivity (no orders)

```powershell
node bin/automaton.mjs probe
node bin/automaton.mjs config
node bin/automaton.mjs brakes
```

`probe` must print account equity/cash/status and `market open: true|false`.
If it prints `BROKER_AUTH`, the keys are wrong or live keys are used against paper.

This build is tuned for the supplied **$2,000 paper account** and the requested population in
`automaton.config.json`: **30 agents × $20 endowment** ($600 allocated, 30% of equity), $1 death
floor, 20% drawdown death, $10 child endowment, 40 hypothesis candidates/cycle, spread ceiling
100 bps for IEX data. The invariant is
`population.initial × endowmentUsd <= 80% × account equity`; edit that file to scale up if the
paper account balance or population changes. The population is already seeded (30 gen-0 agents,
unique strategies, one compiled spec each). While the market is closed a cycle still reads real
data and prices the population, but every order is denied with `MARKET_CLOSED` (D3, broker clock)
and nothing is sent to Alpaca.

## 3. Phase 1 — metabolism, no earning (recommended first run)

The article's Phase 1: confirm costs are accounted and death fires exactly on time.
Cheapest and safest is the offline accelerated simulation:

```powershell
node bin/automaton.mjs simulate --cycles 240 --population 120 --seed 7
```

Then a single paper cycle with the real account (orders may be placed if the market is
open and the brakes allow — start with a small population):

```powershell
node bin/automaton.mjs tick
node bin/automaton.mjs status
```

Check in `status`: treasury state, runway hours, reconciliation `ok`, agents' equity and
per-cycle burn. `automaton-data/traces.jsonl` contains one trace per cycle.

## 4. Phase 2 — earning, no replication

Run the loop:

```powershell
node bin/automaton.mjs run
```

- The engine loops every `cycleIntervalSec` (default 300 s).
- It spawns the external Reaper automatically for paper/live, and refuses to start the
  population if the Reaper cannot run.
- In `mode=sim` there is no separate Reaper process: the engine executes death verdicts
  in-process (the synthetic broker is in-process), and `reaper-process.js` refuses a sim
  state directory. Paper/live always use the external process.
- Ctrl+C stops the loop **only**; the Reaper keeps running by design. Its pid is in
  `automaton-data/reaper.pid`, its log in `automaton-data/reaper.log`.
- Stop the Reaper only as the operator: `Stop-Process -Id (Get-Content automaton-data\reaper.pid | ConvertFrom-Json).pid`.
- After changing any plugin/engine source file, **restart the Harness app**: the Host
  process caches the plugin's module graph. CLI and test runs are fresh processes and are
  unaffected.

Watch `status` and `journal` for the first profitable cycle. If nothing earns over
several days, the niche/universe is wrong (article: "the problem is the niche, not the
architecture"), not the mortality rule.

## 5. Phase 3 — replication under a cap

Replication is automatic when the Treasurer gate passes (`mayReplicate: true`):
7-day surplus ≥ `replication.surplus7dUsd`, runway ≥ 72 h, population < cap, and the
parent can fund the child endowment while staying above twice the death floor.

Check `status` → `population`, `journal` → generation survival. If gen-2/gen-3 survival
does not improve on gen-1, the mutation vector is not teaching the population anything.

## 6. Harness control panel

The same engine is available inside the DeepSeek Harness Web UI:

- Agent tools: `automaton_status`, `automaton_start`, `automaton_stop`, `automaton_tick`,
  `automaton_agents`, `automaton_obituaries`, `automaton_brakes`, `automaton_simulate`,
  `automaton_config`, `automaton_emergency_stop`.
- **Control panel**: a **sidebar entry** (Automaton icon in the left sidebar) that opens the
  full dashboard in the central column; the same dashboard is also a page in
  **Settings → Plugins → MEAT — Mortality Engineered Auto-Trading**. The dashboard has header stats (equity, cash,
  population, runway, burn, allocated-vs-cap, last tick, kill switch, obituaries), the
  operator Reaper row, **Start / Stop / Emergency Stop** buttons, and the sortable/filterable
  table of all 30 agents with **strategy names** (`Momentum AAPL`, …), genome-vs-trading-spec,
  equity, P&L, runway, status/cause. **Click an agent** to open its drill-down: current
  holdings (symbol/qty/avg/last/market value/unrealized/opened), past activity (newest-first
  fills), strategy parameters, role costs and death info. Auto-refresh every 3 s with pause.
- **Operator controls (2026-10-29 feature set, docs/CONTROL-PANEL.md)**:
  - **Research cadence** — segmented control: every 1 h / 3 h / 6 h / 24 h, **before market open**,
    **after market close**, or both. Applies live through `POST /automaton/control`
    `{action:'set-research-settings', settings:{mode, intervalSec?, enabled?, influence?}}`; the
    choice is persisted to `automaton-data/settings.json` (operator overlay applied on every config
    load) so it survives restarts. Edit the same file to change it without the panel.
  - **Rewards** — enable toggle, period (daily/weekly/monthly), 1st/2nd/3rd percentages of the
    broker account's **cash** (defaults 5/3/2 %), optional max per period, live preview against the
    treasury pool and allocation-cap remaining. Persisted via `set-reward-settings`. Payouts are
    **virtual treasury → agent ledger transfers at period boundaries only** (no broker transfer
    exists); they are once-per-period, floored to cents, proportionally scaled if the pool/allocation
    cap/max would be exceeded, and recorded in `automaton-data/rewards.json` (history 50). Virtual
    `sum(agent equity) + pool` is unchanged, so reconciliation still holds.
  - **Leaderboards** — daily / weekly / monthly tabs ranked by period P&L %; top 3 get medals and
    can be clicked to open that agent. Period keys are UTC day, ISO week, UTC month.
  - **Agent detail** — the drill-down now explains the bot: strategy summary, entry rule, exit rules
    (stop/target/time/signal), risk rule, plan + next step, triggers table, current position plan
    (stop/target/bars held), next research time, ranking badges, P&L (realized/unrealized/day/week/
    month) and a full **Transactions** table with every fill (order id, side, qty, price, notional,
    realized P&L, time).
- Controls call `POST /automaton/control` (loopback only) with
  `{action:'start'|'stop'|'emergency-stop'|'reaper-stop'|'set-research-settings'|'set-reward-settings'}`;
  destructive actions need `confirm:'STOP'`. Data comes from `GET /automaton/state` (redacted JSON,
  no secrets). Settings actions are operator-only and are never exposed as agent tools; invalid
  settings are rejected with `400 INVALID_SETTINGS` (the Host also validates the same allow-list the
  engine does). `reaper-stop` is operator-only (Host-side) and is never exposed as an agent tool.
- A fresh Host boot can activate the plugin before the web-server service mounts; the Host
  half late-binds its routes (polls up to 60 s), so **restart the app once** after updating
  the plugin. After a restart: if the Reaper row shows a **stale generation** banner, press
  **Operator: stop Reaper**, then Start. If the Host cannot signal the old process, run the
  terminal command in §7.

The plugin row config is in `packages/automaton-trading/cordis.patch.yml`
(`stateDir`, `envFile`, `mode`, `autoStart`). `autoStart` is `false`; the engine starts
idle and never trades until the panel's Start button / `automaton_start` / CLI `run` is used.

## 6a. Research sidecar (per-agent, hourly)

Each living agent gets its own **isolated** hourly news briefing (`docs/RESEARCH.md`).

- **How it runs**: inside the engine loop — once per cycle the researcher runs only for agents
  whose hourly slot is due (`research.intervalSec`, staggered by `research.staggerSec`). In the
  Harness the LLM comes from the Host `llm` service (the same DeepSeek account, no extra key);
  a headless CLI run uses `DEEPSEEK_API_KEY` from `.env` (optional, `DEEPSEEK_MODEL` ~
  `deepseek-chat`). Without either, `engine.research.configured=false`: trading continues
  unchanged and the panel shows "research disabled: no LLM bridge / key".
- **What the model sees**: only that agent's genome/spec, its own cash/positions/P&L, news for
  its own symbols (Alpaca News API) and its own last ≤5 briefings. No other agent's data and no
  shared conversation — this is enforced by construction and asserted in `test/research.test.js`.
- **What it can do**: advise the Executor only. `AVOID`/`ALERT`/negative-sentiment/2+ risks veto
  a *new entry* (`research_veto`); positive sentiment scales the order size down (never up);
  `ALERT`/strong negative sentiment pushes an exit (`research_alert`). Every order still passes
  the 18 hard brakes. Set `research.influence:false` for shadow mode (briefings logged, no effect).
- **What it costs**: `research.costPerRunUsd` (default $0.001) is charged to **that agent's**
  ledger per successful briefing (category `research`, role `prospector`), so research shortens
  the agent's runway. Malformed/absent LLM answers are logged with no charge.
- **Where to look**: panel → agent drill-down "Research — isolated hourly analyst" (verdict,
  sentiment, confidence, summary, catalysts/risks, sources); raw data in
  `automaton-data/research/<agentId>.jsonl` and `automaton-data/research/state.json`;
  latest cycle summary in the tick trace (`trace.research`). `engine.status().engine.research`
  reports `enabled/configured/influence/lastRunAt/nextDueAt/provider/model/runs/errors`.
- **Disable / tune**: edit `research` in `automaton.config.json`
  (`enabled`, `influence`, `intervalSec`, `staggerSec`, `costPerRunUsd`, `maxAgeSec`,
  `maxNewsPerAgent`, `maxOutputTokens`) and restart the Host (engine modules load on boot).
  Advisory thresholds are also configurable: `vetoSentiment` (-0.6), `exitSentiment` (-0.5),
  `vetoMinRisks` (5, effectively off), `riskPenalty` (0.6 size multiplier when risks >= 2) and
  `errorCooldownSec` (900 s pause after provider errors; 1 h for fatal ones such as an empty API
  balance). Do not veto on risk count alone — a live tuning mistake did exactly that and blocked
  ~100% of entries for two sessions (see docs/VERIFICATION.md, 2026-10-28).
- **Provider balance**: the Harness `llm` service bills your DeepSeek account. If the balance is
  exhausted the analyst pauses (errors + stale briefings), and **trading continues without
  research influence** because stale briefings are ignored. Top up at platform.deepseek.com, then
  the next hourly slot resumes automatically (or restart after changing config).
- **Failure behaviour**: news outage → no news → neutral HOLD (no LLM call, no charge);
  LLM error → logged, no briefing/charge, trading unaffected; stale briefing (> `maxAgeSec`)
  → ignored by the Executor but still shown (marked stale) in the panel.


## 7. Safety and emergency procedures

| Situation | Action |
|---|---|
| Something looks wrong | `node bin/automaton.mjs emergency-stop` (or `automaton_emergency_stop` tool with `confirm:"STOP"`) — arms `KILL_SWITCH`, stops the loop; the Reaper keeps liquidating condemned agents. |
| Resume after stop | `node bin/automaton.mjs clear-kill`, then `run` again. The loop is not resurrected automatically. |
| Inspect what the wall blocks | `node bin/automaton.mjs brakes --symbol AAPL --notional 500` — prints the decision + rule that would fire. |
| Account/keys compromised | Stop the loop, stop the Reaper process, revoke the keys in the Alpaca dashboard. The plugin does not store keys. |
| Going live | Edit `automaton.config.json` or env: `mode=live`, `allowLive=true`, then `node bin/automaton.mjs arm-live --confirm "ARM LIVE"` (creates `LIVE_ARMED`). Then start. All 18 hard brakes still apply, including the v3.0 instrument gates D2/D15–D18 (paper-only shorting/options/margin; live remains triple-gated). |
| Disarm live | Delete `automaton-data/LIVE_ARMED`, set `mode=paper` (or stop the loop first). |
| Stale/orphaned Reaper after an app upgrade | The control panel shows the Reaper row (pid, alive, heartbeat). A Reaper without a matching heartbeat is from an older generation and `Start` refuses to reuse it: press **Operator: stop Reaper** (two-step confirm) in the panel, then Start again. If the Host cannot signal it, run this once in your own terminal: `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*reaper-process.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }` |

The **agent** has no tool, IPC, or config write that can stop or reconfigure the Reaper: it is a
separate process with its own credentials path and schedule. The only stop surface is the
loopback-only operator control in the panel/Host (`POST /automaton/control`
`{"action":"reaper-stop","confirm":"STOP"}`) — it lives in the Harness Host, not in the engine,
and it is deliberately not exposed as an agent tool. A new Reaper reloads `registry.json` /
`ledger.json` before every sweep and writes a heartbeat, so an old non-reloading generation can
never silently overwrite newer state again.

## 8. Configuration

Effective config = defaults ← `automaton.config.json` (workspace root; the CLI reads it first)
← `automaton-data/automaton.config.json` (the plugin Host process runs with a different cwd, so
keep this mirror in sync) ← environment (`AUTOMATON_*`). `node bin/automaton.mjs config` shows the
redacted result and resolved paths. Key knobs:

| Field | Default | Meaning |
|---|---|---|
| `mode` | paper | sim / paper / live |
| `population.initial` / `.cap` | 3 / 10 | genesis size and population cap (this build: **30 / 60**) |
| `endowmentUsd` | 5000 | capital allocated per agent (virtual sub-ledger; this build: **$50**) |
| `deathFloorUsd` / `deathFloorPct` | 250 / 5% | equity at which death fires (this build: **$1 / 5%**) |
| `maxDrawdownPct` | 25% | risk-of-ruin death (this build: **20%**) |
| `burn.inferencePerCycleUsd` | 0.03 | per-agent inference cost per cycle (this build: **0.0002**) |
| `burn.dataPerCycleUsd` | 0.005 | per-agent market-data cost per cycle (this build: **0.00005**) |
| `cycleBudget` | 0.08/0.03/0.01 | STABLE/TIGHT/CRITICAL thinking budget |
| `replication.*` | 150 USD / 72 h / 2500 USD | breeding gate + child endowment (this build: **$3 / 72 h / $25**) |
| `data.maxHypothesesPerCycle` | 60 | proven hypotheses per cycle (so 30 agents can each trade their own strategy family/symbol) |
| `risk.*` | see `src/config.js` | max position %, order caps, daily orders, loss limits, session window, symbol whitelist |

## 8a. Minute monitoring / fast intraday profile

The engine evaluates the population once per `cycleIntervalSec`. This build runs a **fast intraday
profile** (activate by restarting the Host so the engine reloads the config):

```json
"cycleIntervalSec": 60,
"data": { "timeframe": "1Min", "feed": "iex", "lookbackBars": 120 },
"risk": { "maxDailyOrders": 12 }
```

What this means in practice:

- **Every ~60 s** the engine: fetches the shared market snapshot (1-minute IEX bars + latest IEX
  quotes for the 10 symbols), runs the Treasurer, then the Executor evaluates each bot's signal on
  the 1-minute bar series (momentum z-score, mean-reversion z, breakout vs prior 20-bar high, gap
  fade), checks all 18 hard brakes, and places at most one order per bot per cycle. `maxDailyOrders: 12`
  caps how often a bot may trade per day.
- **Bar-based rules stay correct:** every rule expressed in bars (`maxHoldBars`) is now measured in
  *1-minute bars* (e.g. a 12-bar time stop = 12 minutes). The agent plan on the dashboard states the
  bar duration explicitly (e.g. "Time stop after 12 bars (~1 min each)").
- **Data reality check:** `feed: "iex"` is real-time during US regular trading hours, but IEX is a
  single venue and has sparse/no data outside RTH (pre-market/post-close). `feed: "sip"` gives
  consolidated data but is **15 minutes delayed** on the free Alpaca plan. Truly instant reaction
  needs an Alpaca real-time data subscription; with the free plan the bots react to IEX real-time
  prices during the session.
- **Costs/cadence:** burn per cycle is charged to each bot; 60 s cycles multiply cycle costs ~5× vs
  the previous 5-minute loop (still cents/day for $20 bots). Research cadence is unaffected (hourly /
  pre-open / post-close as configured in the panel).
- **Signal quality:** the existing compiled specs were derived on hourly bars, so their parameters
  are now applied to much noisier 1-minute data — expect more frequent, smaller trades and more
  false signals. For a calmer first step use `"timeframe": "5Min"` or `"15Min"` (and
  `cycleIntervalSec: 60` still refreshes quotes every minute); revert to `"1Hour"` + `300` for the
  original behaviour. The engine validates the timeframe/feed allow-list (`1Min|5Min|15Min|30Min|
  1Hour|2Hour|4Hour|1Day`, feed `iex|sip`) at startup.
- **Rate limits:** each cycle issues roughly 10 bar requests + 10 quote requests (+ fill
  reconciliation); at 60 s this is well under Alpaca's 200 requests/minute, but do not add more
  symbols/population without checking it.

## 8b. Tiered cadence and trading-hours-only monitoring

The running paper profile now separates **when each bot is analysed** from how often prices refresh:

```json
"cycleIntervalSec": 60,
"cadence": {
  "day":   { "intervalSec": 60,   "timeframe": "1Min"  },
  "swing": { "intervalSec": 3600, "timeframe": "1Hour" }
},
"engine": { "tradingHoursOnly": true, "offHoursIntervalSec": 300 }
```

- **Price monitoring only during trading hours.** The engine reads the broker clock every cycle.
  When `engine.tradingHoursOnly` is true and the market is closed, the loop runs a *cheap
  maintenance pass*: no market-data fetch, no prospector/builder/executor, no per-cycle charges —
  only the research sidecar (so pre-open/post-close briefings still fire) and a status snapshot.
  It then sleeps `offHoursIntervalSec` (default 300 s) instead of the trading cycle. Orders were
  already blocked outside the session window by brake D3; this change also stops paying for data
  and metabolism while nothing can trade.
- **Two execution tiers.** Genesis assigns alternating `tier: "day"` / `"swing"` to the population;
  children inherit their parent's tier (the birth mutation never changes the cadence class).
  Each cycle, a bot is **fully analysed** (prospector spec + entries + exits) only when its tier's
  `intervalSec` is due: day bots every minute on the 1-minute bar lane, swing bots every hour on the
  1-hour bar lane. Non-due swing bots **with an open position** still get an **exit-only risk pass**
  every cycle (stop/target/max-hold/research-ALERT), so a mid/long-term position is never left
  unwatched between hourly decisions; no new position is opened outside the bot's cadence.
- **Dashboard**: each agent row now includes `tier` and `cadence {intervalSec, timeframe,
  lastAnalysisAt, nextAnalysisAt}`; its plan/exits state the bar duration of its own timeframe.
- **Tuning**: set `cadence.day/second/timeframe` as needed (validated allow-lists). To restore the
  old single-cadence behaviour, remove the `cadence` block (both tiers then evaluate every cycle);
  set `engine.tradingHoursOnly: false` to keep analysing 24/7 again. Restart the Host after config
  changes (engine modules load on boot).

## 8c. Per-bot agent brains (hybrid architecture)

Every population bot now has its own isolated agent review on top of the deterministic executor
(contract: `docs/BOT-AGENTS.md`). The review never places orders; it produces a policy the Executor
applies next cycle, so minute-level reactions never wait on a model turn.

```json
"agents": {
  "enabled": true,
  "reviewIntervalDaySec": 300,
  "reviewIntervalSwingSec": 3600,
  "maxReviewsPerCycle": 4,
  "costPerReviewUsd": 0.001,
  "maxAgeSec": 7200,
  "logLimit": 120,
  "maxInputChars": 8000,
  "maxOutputTokens": 700,
  "errorCooldownSec": 900
}
```

- **Isolation**: one prompt per bot containing only its own identity/genome/spec/book, market data
  for its symbol, its own research briefing and its own prior reviews. Journal per bot under
  `automaton-data/agents/<agentId>.jsonl`, shared cache `agents/state.json` (reloaded on restart).
- **Cadence**: day bots every `reviewIntervalDaySec` (~5 min), swing bots every
  `reviewIntervalSwingSec` (1 h); at most `maxReviewsPerCycle` reviews per engine cycle; cold starts
  spread naturally. Failure of one bot never blocks others; malformed JSON is repaired/retried once,
  no policy and no charge. Provider errors pause reviews with a cooldown (1 h on fatal/billing).
- **Policy effects (Executor)**: `stand_down` skips new entries (exits still fire), `sizeMultiplier`
  shrinks entries only (0.2–1, before every cap), `exitPressure: "exit"` forces a position exit after
  research ALERT and before stop/target/max-hold/signal. Stale policies (> `maxAgeSec`) or missing
  LLM bridge → exactly the previous behaviour.
- **Cost**: each successful review charges the bot `costPerReviewUsd` (category `agent`, role
  `executor`), so slower/larger bots pay for their own thinking.
- **Panel**: agents table columns Strategy type + Est. interval; category tabs; Bot agent section in
  the drill-down; engine header bot-agent bridge line. Disable with `agents.enabled: false` (reviews
  stop, existing policies become stale and ignored after `maxAgeSec`).
- **Strategy categories**: momentum/mean-reversion = Swing · mid-long (1-hour lane), breakout/gap-fade
  = Day · intraday (1-minute lane). Genesis mixes a new population by strategyMix.dayPct (live 70/30, v3.2); existing populations are
  rebalanced once on first start (genome family + strategy name refreshed, specs recompiled; ids,
  ledgers, positions and trade history are never touched).

## 8d. Multi-instrument paper trading (v3.0)

The population may now use margin, short selling, long calls/puts, defined-risk vertical spreads and
covered calls. **Paper only**: live trading remains triple-gated by D8. The hard brake wall still runs
before every order; the expansion changed D2 from a blanket denial into an instrument-permission gate
plus new hard rules D15–D18.

```json
"population": { "initial": 30, "cap": 60 },
"endowmentUsd": 50,
"instruments": {
  "enabled": true,
  "allowMargin": true, "maxMarginPctEquity": 1,
  "allowShort": true, "maxShortPctEquity": 1, "maxShortNotionalUsd": 25, "shortableOnly": true,
  "allowOptions": true, "allowCoveredCalls": true, "allowSpreads": true,
  "maxOptionPremiumPctEquity": 0.35, "maxOptionPremiumUsd": 30, "maxContracts": 2,
  "minDTE": 2, "maxDTE": 14, "autoCloseDTE": 1,
  "allowNakedShortOptions": false, "optionDataFeed": "indicative"
}
```

- **Capital**: bots were raised from $20 to $50 (one-time +$30 per alive bot, funded by **reallocating
  the unallocated treasury pool**, not by minting cash, and updating the bot's endowment basis so the
  top-up is not counted as trading profit). Sum(bot equity) + pool remains equal to broker equity, so
  reconciliation does not halt. 30 × $50 = $1,500 of the ~$2,000 paper account.
- **Instruments**:
  - *Long stock* — as before.
  - *Short stock* — whole shares only, shortable+marginable assets, mandate short cap; buy-to-cover on
    stop/target/max-hold/signal. Fractional shorts are rejected.
  - *Long call/put* — debit premium, integer contracts, DTE window; exits on premium stop/target,
    research ALERT, or the DTE auto-close.
  - *Covered call* — sell-to-open only when the bot already holds ≥100 whole shares; closed at 50%
    premium profit, stop, or the DTE guard. At $50/bot this is rare by design (100 shares of a typical
    stock costs far more), and the brake denies it without the shares.
  - *Vertical spreads* — bull-call, bear-put, bear-call credit and bull-put credit, two legs, same
    underlying/expiry, defined maximum loss, submitted as one multi-leg order and closed together.
  - **Naked short options are never allowed** (config validation rejects them).
- **Active use**: every family has a bullish/bearish/neutral instrument playbook (momentum/meanrev
  swing: stock or calls/puts, short or credit spreads; breakout day: calls/puts for leverage; gapfade
  day: shorts/puts/premium selling). The bot's own agent may choose the structure explicitly via
  `policy.instrument`; otherwise the playbook picks the first affordable structure and falls back to
  stock/short when option premium cannot fit the cap. Option selection: nearest expiry inside the DTE
  window, OTM strikes 2–5%, contracts = floor(option budget / premium×100), budget =
  min(35% equity, $30/order, mandate cap) minus open option premium.
- **Data/account facts (paper)**: options trading level 3. Option contracts come from
  `/v2/options/contracts`, marks/quotes from `/v1beta1/options/snapshots/{underlying}?feed=indicative`,
  orders use `position_intent` and mleg `order_class` for spreads. The account exposes `buying_power`,
  `options_buying_power`, `shorting_enabled`, `options_trading_level`. **Broker capability gating**:
  when the paper account is restricted (e.g. equity below the $2,000 margin minimum → `shorting_enabled:
  false`, no margin buying power), the Treasurer removes short, margin, covered-call and credit-spread
  permissions from mandates, bot prompts and status; long stock, long calls/puts and debit verticals
  remain available. Fact: this paper account currently sits at ~$1,999.87 and reports shorting/margin
  disabled; options level 3 is still enabled.
- **Risk rules**: D15 short sale (shorting enabled, shortable+marginable asset, whole shares, mandate
  notional cap); D16 options (enabled structure, integer contracts ≤ maxContracts, premium ≤
  maxOptionPremiumPctEquity×equity and ≤ per-order cap, DTE window; covered calls require 100+ shares;
  spreads exactly 2 defined-risk legs; naked shorts denied); D17 margin (debt after order ≤ mandate and
  ≤ maxMarginPctEquity×equity); D18 expiry guard (no opening below minDTE; close by autoCloseDTE;
  sell-to-close always allowed). D1–D14 keep their meaning (D2 is the instrument gate); D4 skips equity price/spread ceilings for
  option orders (premium caps replace them) while keeping the underlying whitelist.
- **Death**: the Reaper liquidates signed stock and option positions (including spread groups) before
  transferring residual cash and writing the obituary; shorts are bought back, options closed
  sell/buy-to-close. Death is still outside the engine.
- **Disable**: set `instruments.enabled: false` (v2 long-stock-only behaviour; short/options/margin
  denied). Individual flags (`allowShort`, `allowOptions`, `allowSpreads`, `allowCoveredCalls`,
  `allowMargin`) can be turned off independently. Restart the Host after config changes.
- **Operator risk warning**: this is a capability expansion in a paper account. Margin, short selling
  and short-dated options can lose more than the bot's cash in a real account; keep `mode=paper`,
  `allowLive=false`, and treat the configured caps as hard limits. Live trading is not enabled by this
  change.

## 8e. "Most bots are not trading" — diagnostic checklist (v3.1)

Run this before assuming a bug. The panel shows the same data via `engine.lastCycle` and the
restricted-account warning; `GET /automaton/state` exposes it programmatically.

1. **Is the market open?** With `engine.tradingHoursOnly: true`, the engine only fetches prices,
   evaluates strategies and trades during the regular session (09:35–15:50 ET). Off-hours cycles are
   cheap maintenance passes (`engine.lastCycle.tradingSkipped: true`) and **no trades are expected**
   overnight or at weekends. The last real session ends Friday 16:00 ET.
2. **Did the runtime config actually load v3.1?** The Host derives the config path from the state
   directory and prefers the workspace-level `automaton.config.json`; `automaton-data/automaton.config.json`
   is a migrated fallback. Check `config.endowmentUsd === 50`, `cadence.day = {intervalSec:60,
   timeframe:"1Min"}`, `cadence.swing = {intervalSec:3600, timeframe:"1Hour"}`,
   `engine.tradingHoursOnly === true`, `data.maxHypothesesPerCycle === 60`, and
   `risk.maxDailyOrders === 20`. A stale state-dir config (endowment 20, cadence null, trading hours
   false) was the root cause of the v3.0 inactivity; it is now migrated and the workspace file wins.
3. **What are the bot agents deciding?** Each bot has its own review. Check `agents[].policy.stance`:
   `stand_down` blocks new entries (exits still run). v3.1 explicitly tells agents that **long stock
   can be fractional** and to stand down only for weak/conflicting evidence — not because one whole
   share or contract is unaffordable. Reviews are forced due on process start so old decisions do not
   linger for an hour. `engine.lastCycle.botReviews` shows how many were reviewed/deferred.
4. **Is there a coherent hypothesis?** Bots only compile specs for their **own family+symbol** (or the
   same family on another symbol); the old unrelated-hypothesis fallback is gone. A
   `no_matching_hypothesis` build skip means the Prospector did not prove that bot's strategy this
   cycle — waiting is correct. `data.maxHypothesesPerCycle: 60` covers the 14 symbols × 4 families.
   Cached unrelated specs are cleared on start.
5. **Is the broker account restricted?** Paper accounts below the broker's margin minimum lose
   shorting/margin; this account (~$1,999.87) currently reports `shortingEnabled:false`,
   `marginMultiplier:1`. The engine then removes short/margin/covered-call/credit-spread permissions
   automatically (status `engine.instruments.effective`, agent tooltips). Options level 3 and long
   stock/long options remain available. Restoring shorting/margin requires the Alpaca paper account
   to be funded/reset above the margin minimum; the engine re-enables those permissions automatically
   on the next cycle once the broker reports them.
6. **What did the last cycle skip?** `engine.lastCycle.topSkipReasons` shows the dominant reasons:
   `inside_range`, `gap <x>bps`, `momentum z=<x>`, `meanrev z=<x>`, `max_orders_per_cycle`,
   `no_matching_hypothesis`. Quiet markets legitimately produce few entries; day bots evaluate every
   60 seconds on 1-minute bars, swing bots hourly on 1-hour bars.
7. **Costs vs progress**: bots pay metabolism each trading cycle (inference/data/hosting). Off-hours
   gating stops weekend burn. A bot with equity ≈ $19.4 after the old $20 era is topped up to $50 by
   the one-time treasury reallocation on the first v3.1 start; check `limits.endowmentUsd`/agents.

## 8f. Multi-symbol portfolios, 70/30 mix and the live analytics dashboard (v3.2)

```json
"strategyMix": { "dayPct": 0.7 },
"portfolio": {
  "basketSizeDay": 4,
  "basketSizeSwing": 3,
  "maxOpenPositionsDay": 5,
  "maxOpenPositionsSwing": 3,
  "maxOrdersPerCycle": 2
},
"risk": { "maxOpenPositions": 6, "maxOrdersPerCycle": 2 }
```

- **Baskets:** every bot trades a basket of symbols. Day bots use 4 symbols, swing bots 3 (config
  `portfolio.basketSize*`); the genome carries `symbols` and the registry caches one compiled spec per
  symbol in `agent.specIds` (primary `specId` stays tied to the primary symbol). The executor
  evaluates every basket symbol, manages every held position with the matching per-symbol spec and
  enforces the tier caps; the 18-brake wall remains the absolute ceiling. One order per symbol per
  cycle; `maxOrdersPerCycle` covers exits+entries.
- **70/30 mix:** `strategyMix.dayPct` (live 0.7) sets the genesis/migration split. Existing
  populations migrate once on start: families/tiers are rebalanced to the target, each alive bot is
  given a basket, and its old single-symbol spec is cleared so per-symbol specs recompile. Ids,
  ledgers, positions and history are untouched. Baskets are assigned by rotating the configured
  universe; overlapping baskets mean several bots can watch the same company.
- **Status:** `agents[].symbols` (basket), `agents[].specs[]` (per-symbol specs) and primary
  `agents[].spec`; `status.engine.portfolio` and `strategyMix.target` expose the caps/target. The panel
  shows the basket in the agent table and detail drawer.
- **Live analytics feed:** engine `marketView()` (2 s cache) combines broker snapshots, 1-minute
  sparklines (15 s cache), the latest status snapshot and a 240-point portfolio equity history. Host
  exposes **loopback `GET /automaton/market`** (GET/HEAD only; redacted; structured 503 when the view
  is unavailable; no new tools/control actions). Data is read-only and secret-free.
- **Dashboard:** the panel is now a Google-Analytics-style dashboard: top bar (mode/running/halted/
  kill/live feed/market clock/manual refresh/pause + Start/Stop/Emergency), eight KPI cards, inline
  SVG equity chart + sparklines + Day-vs-Swing 70/30 bars, live tape with 2 s green/red flashes and a
  “market closed · last close” state, filterable/sortable agents table with basket/live P&L/positions/
  stance/sparkline and the existing detail drawer, plus Overview/Agents/Markets/Research/Rewards/
  Settings tabs. State polls every 5 s, market every 2 s; polling pauses when the tab is hidden or the
  pause toggle is on, and manual refresh pulls both. Missing market feed → state-only fallback.
- **Starting from a stopped/halted engine:** the panel Start control starts the loop; a
  `broker_unavailable` halt clears on the next successful broker tick. The market feed still renders
  the last quotes/status while paused/stopped, labelled accordingly.
- **Stale states in this deployment:** the last recorded tick was 2026-11-07 with a transient
  `broker_unavailable` halt and treasury CRITICAL (allocation nearly at cap after weekly reward
  payouts). Restart the Host, then press Start; the first successful tick should recover the
  treasury and the new migrations (70/30, baskets) run once on startup.

## 9. Troubleshooting

- `CONFIG_INVALID: missing Alpaca credentials` → create/fix `.env`; check `--env-file`.
- `LIVE_NOT_ARMED` → mode=live requires `allowLive=true` and `LIVE_ARMED`.
- `refusing to start ... external Reaper unavailable` → check `automaton-data/reaper.log`,
  `AUTOMATON_NODE_BIN` (Node executable for the detached Reaper), and write access to the
  state dir. This is deliberate: no Reaper, no paper/live population.
- `reconciliation` mismatch in status → the virtual ledger and the broker disagree beyond
  tolerance; the Treasurer halts new orders. Inspect `ledger.json` vs Alpaca positions.
- Orders denied with `MARKET_CLOSED`/`OUTSIDE_WINDOW` → expected outside RTH; the executor
  only opens positions inside the configured window.
- All agents `CONDEMNED` but still `alive` → the Reaper process is not running; start it
  (`node src/reaper-process.js --state-dir ..\..\automaton-data`) or restart the engine.

## 10. Single-writer rule (ledger/registry)

The engine is the primary writer of `registry.json`/`ledger.json`. The external Reaper reloads both
before every sweep and now persists them **only when a sweep actually kills an agent** — an earlier
unconditional save overwrote newer engine writes (observed live: three small research charges
vanished). If you suspect drift after a crash or a manual experiment: **stop the loop**, then run the
idempotent repairs `node scripts/reconcile-fills.mjs` (broker fills → virtual ledger) and
`node scripts/reconcile-research-charges.mjs` (research charges), then Start again.

Never run the CLI `tick`/`run` while the engine loop is already running: two engine writers will race
the same state files. Use the panel/control route to start/stop the one writer.
