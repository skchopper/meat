# MEAT — Mortality Engineered Auto-Trading

> Package id: `@local/automaton-trading` (kept for compatibility with the installed Harness
> profile, plugin state and tools; the product/app/plugin name is **MEAT**).

DeepSeek Harness plugin bundle for **MEAT** — a mortality-engineered
multi-agent trading system on Alpaca. The plugin owns the Harness shell only: the
engine, roles, brakes, and journal live in `src/` (Lead-owned) and are reached through
one facade (`src/engine.js`).

The theory is simple: a trading strategy is not a task, it is a **life with a runway**.
The unprofitable die, the profitable reproduce, and every death leaves a structured
obituary the living read.

## What this package adds

| Surface | Detail |
|---|---|
| 10 agent tools | `automaton_status`, `automaton_start`, `automaton_stop`, `automaton_tick`, `automaton_agents`, `automaton_obituaries`, `automaton_brakes`, `automaton_simulate`, `automaton_config`, `automaton_emergency_stop` |
| Sidebar entry | `sidebar.panellist`: one "Automaton" entry in the sidebar's global panel list (strategy/skull glyph, localized label) |
| Control panel | `main` keyed panel `automaton-trading`: the full dashboard opened from the sidebar in the central column — header stats, operator controls, the 30-agent table, per-agent drill-down, generation rollup and obituary feed |
| Settings page | Settings → Built-in plugins → **MEAT — Mortality Engineered Auto-Trading** (`settings.plugins.tab`): the same dashboard as a full page |
| State route | `GET /automaton/state` — the redacted JSON every dashboard surface polls every 5 s (auto-refresh with pause) |
| Market route | `GET /automaton/market` — loopback-only, GET-only redacted live view from `engine.marketView()` (quotes, sparklines, portfolio, live agent P&L, equity history); soft 503 when the engine has no market view |
| Live analytics dashboard | Google-Analytics-style UI: top bar (brand/mode/running/market clock/refresh/pause), KPI cards, inline-SVG equity chart + sparklines + 70/30 strategy mix, live market tape with up/down flash, filterable agent table with live P&L, and tabs Overview / Agents / Markets / Research / Rewards / Settings |
| Control route | `POST /automaton/control` — loopback-only operator controls used by the panel's buttons (including the operator-only Reaper stop and the research/reward settings actions) |
| Research sidecar | Host-side Harness-LLM bridge for the engine's per-agent isolated hourly analyst; briefings surface in the agent table and detail pane |
| Operator settings | Research cadence (1h/3h/6h/24h, before open, after close, both), winner rewards (period + 1st/2nd/3rd % of account cash + caps) and daily/weekly/monthly leaderboards, all applied through loopback-only control actions |
| Richer agent detail | Strategy & plan (summary, entry/exit/risk rules, next step, triggers, position plan, next research), full transaction history, ranking badges, day/week/month P&L |
| Strategy taxonomy | Per-bot **strategy type** + **estimated trading interval** columns, category tabs (All / Swing · mid-long / Day · intraday with counts) and category-coloured chips |
| Per-bot agent brains | Each bot has its own agent brain (isolated per-bot reviews): a **Bot agent** section (stance, size/risk multipliers, confidence, thesis, plan, watch list, review count, last/next review, stale warning) plus a small engine-level bridge line |
| Multi-instrument v3.0 | Margin, short selling, long options, defined-risk spreads and covered calls: LONG/SHORT/CALL/PUT position rendering (strike, expiry, DTE, contracts, spread group), per-bot Instruments badges, Instrument playbook, policy instrument plan, and an engine header instruments/exposure line |
| Trade diagnostics | "Last cycle" line (market state, executions/orders/errors, top-3 skip reasons, bot reviews) plus a restricted-broker capability warning (shorting/margin unavailable, account facts) that explains why bots are or are not trading |

Everything is dependency-free ESM with no build step; the browser module is loaded as
plain JavaScript (`./client`). `dsh.client.inject` orders the client half after the real
installed client plugins that own the slots: `@deepseek-ai/dsh-client-ui-layout` (the
`main` keyed panel) and `@deepseek-ai/dsh-client-ui-sidebar` (`sidebar.panellist`), plus
`@deepseek-ai/dsh-client-locale`.

## The control panel (30 agents at $20)

The engine runs a **30-agent population with a $20 endowment per agent**. Every agent has
a **strategy-derived name** (e.g. `Momentum AAPL`, `MeanRev NVDA`, `Breakout TSLA`); the
short random id is shown underneath as the secondary, machine-facing label. Search,
sorting and the obituary feed use the name first.

The dashboard shows, per agent: name, generation, **Genome** (`family symbol` inherited
from the parent, e.g. `Momentum AAPL`) and **Trading (spec)** (the compiled hypothesis the
Builder actually trades — it can differ from the genome, shown with a `≠` marker), the
**Strategy type** chip (`Momentum swing` / `Mean-reversion swing` / `Intraday breakout` /
`Day-trade gap fade`, colour-coded by category), the **Est. interval** (`~30s` / `~5m` /
`~1h` …), a compact **Instruments** badge (`Stk` / `Short` / `Opt` / `Spreads` /
`Margin`, tooltip lists the allowed structures), research badge, equity, USD/percent P&L,
day P&L, net-7d, a runway bar, treasury state, alive/dead/condemned status plus cause, and
a positions/trades count.

Above the table, **category tabs** filter the population by strategy class:
`All (n) / Swing · mid-long (n) / Day · intraday (n)` — counts come from
`status.strategyMix` (falling back to the agent rows), and they compose with the
alive/dead filter, search and sorting.

**Click any agent row** to open the inline detail pane (right-hand side on wide screens,
stacked below on narrow ones; `Esc` or the × closes it):

- header: name, status, generation, born/died, cause, note, parent/mutation, equity,
  cash, positions value, endowment, day/net-7d P&L, realized/unrealized P&L, runway,
  drawdown, first-profit time, compiled-spec timestamp;
- **Current holdings** table: LONG/SHORT stock and CALL/PUT option rows — side chip, qty
  (contracts for options), avg/premium, market value, unrealized P&L, option strike,
  expiry + DTE, spread-group tag, and a totals line with gross/net exposure and margin
  debt when reported (empty state "No open positions.");
- **Past activity**: the last fills newest-first — side, symbol, qty, price, notional,
  realized P&L, time (empty state "No trades yet · market closed.");
- **Strategy parameters** for both the inherited **genome** and the compiled **spec**
  (lookback / entryZ / exitZ / stop / target / max-hold / size / session), with a warning
  when the compiled spec differs, and a note when an agent has no compiled spec yet;
- **Strategy & plan**, **Transactions**, **ranking badges**, the **Bot agent** section
  (including the chosen instrument plan), the **Instrument playbook** block and the
  research section — see the “Agent detail”, “Strategy types & per-bot agent brains” and
  “Multi-instrument paper trading (v3.0)” sections below;
- **Role costs** per role (treasurer / prospector / builder / executor / replicator /
  reaper).

Plus:

- **Sort** by clicking the Agent, Gen, Equity, P&L, Day %, Runway or Status headers.
- **Filter** by category tabs (All / Swing · mid-long / Day · intraday with counts),
  status All / Alive / Dead (plus Condemned when any exist) and free-text search across
  name, id, symbol, family and parent name.
- **Generations** summarises born/alive/dead per generation; **Obituaries** lists the
  last 8 deaths (name, cause, lifespan, net P&L, first-profit time).
- **Auto-refresh**: 3 s, with an explicit Pause/Resume toggle shared by every surface.
  A request is never issued while the previous one is in flight; timers/listeners are
  cleaned up on unmount.
- **Controls**: `Start` (disabled while running or while the kill switch is armed),
  `Stop` (disabled while stopped), `Emergency Stop` (two-step: first click arms a red
  `CONFIRM STOP`, second click sends `{action:"emergency-stop", confirm:"STOP"}`).
  In-flight and error states are shown inline; the kill-switch indicator turns red once
  the marker file exists (`REAPER_UNAVAILABLE` from `Start` is shown when a stale Reaper
  refuses to be reused).

### Operator Reaper row (important after an app restart)

The dashboard header shows the external Reaper read fresh from disk by the engine:
`Reaper — pid 24452 · alive · heartbeat 3s ago (v2) · 51 sweeps`, or
`Reaper — pid 24452 · alive · no heartbeat (stale generation)` when it belongs to a
previous app generation. Only a **stale-generation** Reaper gets the two-step
**Operator: stop Reaper** button (first click arms `CONFIRM STOP REAPER`, second sends
`{action:"reaper-stop", confirm:"STOP"}`); it terminates the orphan by pid from the Host
process and removes `reaper.pid`. A fresh generation (`heartbeat v2`) is the mortality
enforcer for the running population, so the panel shows "operator stop not required"
instead of a stop button.

> Agents cannot stop the Reaper — this is a deliberate operator-only control.
> The Reaper has no engine control surface (brake D12); the Host plugin only signals the
> external OS process, exactly like `kill` from a terminal. It is never exposed as an
> agent tool.

**Startup priority after an app restart:**

1. **Stop Reaper** — if the row shows a stale generation (`alive` without heartbeat v2),
   click it, then `CONFIRM STOP REAPER`. The engine refuses to start while a stale
   generation is alive (`REAPER_UNAVAILABLE` with an operator hint).
2. **Start** — once the Reaper row shows `not running` (a fresh Reaper is spawned by
   `engine.start()` for paper/live), press `Start`.

### Strategy types & per-bot agent brains

Each bot's genome family maps to a strategy class (contract `docs/BOT-AGENTS.md`):

| Genome family | Strategy type | Category | Timeframe | Est. interval |
|---|---|---|---|---|
| `momentum` | Momentum swing | Swing · mid-long | 1Hour | ~1h |
| `meanrev` | Mean-reversion swing | Swing · mid-long | 1Hour | ~1h |
| `breakout` | Intraday breakout | Day · intraday | 1Min | ~5m |
| `gapfade` | Day-trade gap fade | Day · intraday | 1Min | ~5m |

The table's **Strategy type** chip uses `agent.strategy.typeLabel` (the client falls back
to the genome family when the engine has not added `agent.strategy` yet) and
**Est. interval** formats `strategy.estimatedIntervalSec` (`<120s → ~Xs`,
`<3600s → ~Xm`, else `~Xh`), falling back to `agent.cadence`. The header shows a small
engine-level bridge line from `status.engine.agents` (enabled/configured, provider/model,
day/swing cadence, runs/errors, next due); it degrades to
"bot-agent bridge not configured yet" when the engine has no per-bot layer.

Each bot also has its own **isolated agent brain**, reviewed on its category cadence (day
bots every few minutes, swing bots hourly; ~200 reviews/hour for 30 bots). The detail
pane's **Bot agent** section renders from `agent.policy`: stance badge
(`TRADE` / `CAUTIOUS` / `STAND DOWN`), size/risk multipliers, confidence, exit pressure,
thesis, plan list, watch symbols, review count, last/next review time and a **stale**
warning (the executor then falls back to the last valid policy or the baseline). Empty
state: "bot agent has not reviewed yet (first review pending)". `GET /automaton/state`
carries `strategyMix`, `engine.agents`, each agent's `strategy` and `policy`; every new
field is optional so the panel still renders on older engine builds.

### Multi-instrument paper trading (v3.0)

The bots may use **margin, short selling, long options, defined-risk spreads and covered
calls** in paper trading (live is still triple-gated; the **18 hard brakes (D1–D18)** —
including the instrument gates D2/D15–D18 — remain authoritative and run first). Structures: single-leg
`long_call`/`long_put`, `covered_call` (needs ≥100 long shares), and two-leg vertical
spreads (`call_credit_spread`, `put_credit_spread`, `bull_call_spread`,
`bear_put_spread`) submitted as one mleg order and linked by an internal `groupId`.
Naked short options are never allowed; `minDTE ≥ 1` (default window 2–14, auto-close at
≤1 DTE).

- **Positions**: the detail holdings table renders LONG/SHORT stock (SHORT in a warning
  tone with negative qty) and CALL/PUT options with strike, expiry, DTE, contracts,
  multiplier-marked market value, and the spread group tag. A totals line aggregates
  stock/option counts, spread groups, gross/net exposure and margin debt when the engine
  reports them.
- **Instruments badge**: each agent row shows `Stk · Short · Opt · Spreads · Margin`
  derived from `agent.instrumentPermissions` (or `agent.instruments`), with the allowed
  structures in the tooltip and the playbook hint when present.
- **Instrument playbook**: the detail pane shows the family playbook
  (`agent.playbook`): bullish / bearish / neutral structures plus the full structure list
  (unknown structure keys render raw).
- **Policy instrument plan**: the Bot agent section shows the chosen plan
  (`agent.policy.instrument`): prefer (`auto` or a structure label), max premium, max
  contracts and the DTE window.
- **Engine header**: a small instruments line from `status.instruments` —
  `Options L3 · Short · Margin 4x · caps: options ≤25% eq · short ≤100% eq · max contracts
  3 · DTE 2–14` — plus account options buying power, margin debt and gross/net exposure
  when available; a soft "instrument status not reported yet" note otherwise.
- **Status fields**: `GET /automaton/state` passes `instruments` through, and agent
  positions may carry `assetClass`, `side` (LONG/SHORT/CALL/PUT), `qtySigned`, `option
  {underlying,strikeUsd,expiration,dte,type}`, `multiplier` and `groupId`; the account may
  carry `optionsBuyingPowerUsd`, `marginMultiplier`, `shortingEnabled`,
  `optionsTradingLevel`, `marginDebtUsd`, `grossExposureUsd`, `netExposureUsd`. Every new
  field is optional, so older snapshots render the empty states.

### Trade diagnostics: last cycle & restricted broker

Two diagnostic rows under the engine header answer **"why are the bots (not) trading?"**:

- **Last cycle** (`engine.lastCycle`): market state (open / closed / off-hours skip),
  executions, orders, denied and error counts, the **top-3 skip reasons** with counts
  (e.g. `inside_range 27 · gap 2bps 12 · no_proof 3`) and the bot-review counters
  (`reviewed/due`, deferred, paused, budget note). When `engine.lastCycle` is absent the
  panel shows a soft "no cycle data yet".
- **Broker capability warning**: when `engine.instruments.effective.shortStock === false`
  or `.margin === false` (e.g. the paper account is below the $2k margin minimum) an
  informational warning row explains that **shorting/margin are unavailable while long
  stock and long options remain available**, quoting the account facts
  (`shortingEnabled`, `marginMultiplier`, `optionsTradingLevel`). If `effective` is absent
  no warning is shown — the panel never invents restrictions.
- **Per-agent badges** honor the same restrictions: when an agent's
  `instrumentPermissions.shortStock`/`margin` is `false` the Short/Margin badge is omitted
  and the tooltip says "disabled by broker account" (the remaining structures stay).
- The pure helpers `lastCycleMapping`, `instrumentsCapabilityWarning` and
  `effectiveInstrumentBadges` back these rows and are exported for tests; every field is
  optional and a bare/older snapshot renders the empty states.

### Live analytics dashboard (v3.2)

The panel is a Google-Analytics-style live dashboard (theme-token only, no external chart
dependencies) while every existing control and detail view stays available:

- **Top bar** — MEAT brand, paper/live badge, running/stopped + kill switch, live-feed
  pill, market session + local clock (1 s tick), **manual refresh**, auto-refresh
  pause/resume, and the unchanged Start / Stop / Emergency Stop controls underneath.
- **KPI cards** — account equity with a live ▲/▼ delta, day P&L $/%, cash / buying
  power, gross exposure (net in the sub-line), population alive/total, trades today,
  win rate and treasury runway/state.
- **Charts (inline SVG, hover tooltips)** — portfolio equity area chart from
  `equityHistory`, sparkline paths for the watchlist and per-agent trends, and a
  **Day vs Swing** mix with actual bars against the **70/30 target** (`targetDayPct`).
- **Live market tape** — symbol, last, change $/%, bid/ask and sparkline; up/down rows
  flash green/red on a price change, stale quotes are marked, and a closed market shows
  “market closed · last close”.
- **Agents** — search, sort, status/category filters; basket, strategy type, stance
  badges, live day P&L and sparkline; clicking a row opens the existing detail drawer
  (holdings/transactions/plan/bot-agent/research/playbook/rankings) and the selection
  persists across polling.
- **Tabs** — Overview (KPIs, charts, watchlist, agents), Agents, Markets (full tape +
  instruments/last-cycle diagnostics), Research (coverage + cadence control), Rewards
  (rewards card + leaderboards) and Settings (operator controls, Reaper row, diagnostics).
- **Polling** — `GET /automaton/state` every **5 s** and `GET /automaton/market` every
  **2 s** while the tab is visible; the pause toggle stops both, a hidden tab pauses
  polling, manual refresh pulls both immediately, and timers/subscriptions are cleaned up.
  If the market route is missing or fails (old Host), the UI shows
  “live feed unavailable — state-only” and keeps rendering KPIs/agents from state; charts
  and the tape show empty states instead of breaking.
- **Pure helpers** (exported for tests): `marketTapeRows`, `kpiCards`,
  `equityChartPoints` / `sparklinePath`, `agentTableRows`, `strategyMixBreakdown`,
  `marketSession`, `liveViewMapping`, `changeDirection` / `marketChangePctText`.

`GET /automaton/market` is loopback-only, GET/HEAD only, redacted (never secrets), and
delegates to `engine.marketView()`. A missing/failing engine view returns
`503 {"ok":false,"error":{"code":"MARKET_UNAVAILABLE",…}}`; a non-loopback request gets
`403 FORBIDDEN` and a non-GET method `405 METHOD_NOT_ALLOWED`. No new agent tools and no
new control actions were added.

### Research sidecar — isolated hourly analyst

Every living agent gets an **isolated** hourly LLM briefing about *its own* strategy and
book (its own symbols, positions and past briefings — never another agent's data, another
role's memory or a shared conversation). The reply is strict JSON: `sentiment` (-1..1),
`confidence` (0..1), `verdict` (`HOLD` | `AVOID` | `ALERT`), catalysts (≤4), risks (≤4),
a ≤400-char summary and dated sources. In **influence** mode the briefing can veto
entries, shrink size or force an exit; in **shadow** mode it is logged but never applied.
The agent pays ~`$0.001` per run from its own ledger (~$0.72/day for 30 hourly agents), so
research raises its burn exactly like any other inference cost.

- **Cadence**: per-agent `research.intervalSec` (default 3600 s = hourly) with
  `staggerSec` spreading the population inside the hour; briefings older than
  `research.maxAgeSec` are ignored by the executor.
- **Isolation**: one private LLM call per agent — no shared conversation, no order tool,
  no wallet access; the analyst only advises that agent's executor.
- **Harness bridge (no extra key needed)**: the plugin implements the `ResearchProvider`
  seam on the Host `llm` service. Provider/model resolve from
  `agentDefaultModel.currentSelection()` (fallback: first registered provider + its first
  model) and may be overridden by plugin-row `researchProvider` / `researchModel` (or
  nested `config.research.provider/model`). Calls stream through
  `llm.prepareCall(...)` + `prepared.stream(...)` at temperature 0.2 with bounded output
  tokens; provider failures are returned as clean errors for the researcher's log and
  never crash the plugin or engine.
- **No LLM bridge / key**: the plugin passes no generator, `engine.research.configured`
  becomes `false`, the dashboard shows "research disabled: no LLM bridge / key", briefings
  go stale and are ignored, and trading continues unchanged. The headless CLI (outside the
  Harness) instead uses `DEEPSEEK_API_KEY` against
  `https://api.deepseek.com/chat/completions`.
- **Dashboard display**: a compact table badge (`HOLD +0.2` / `AVOID -0.6` / `ALERT`,
  `—` when no briefing, dimmed when stale) and a **Research — isolated hourly analyst**
  section in the agent detail pane (briefing age, verdict, sentiment, confidence, summary,
  catalysts, risks, clickable sources, provider/model, run/error counters) plus a
  shadow-vs-influence line. `engine.research` (enabled/configured/influence/interval/
  lastRun/nextDue/provider/model/runs/errors) and each agent's `research` are carried by
  `GET /automaton/state`; no research control action or agent tool is added.

### Operator controls: research cadence, rewards, leaderboards

One operator section sits above the agent table (all loopback-only, applied through
`POST /automaton/control`; no new agent tools):

- **Research cadence** — segmented control `Every 1h / 3h / 6h / 24h`, `Before open`,
  `After close`, `Before open + after close`, plus collection/influence toggles and
  **Apply** → `set-research-settings`. Shows the current schedule, `nextDueAt`,
  provider/model and paused reason. Cadence applies live (researcher reconfigure).
- **Rewards** — enable toggle, period selector (daily/weekly/monthly), three percentage
  inputs for 1st/2nd/3rd (default `5/3/2` of the broker account's **cash**), optional
  max per period, a live preview (`5% × cash ≈ $…` with pool / allocation-cap / max
  capping shown) and **Apply** → `set-reward-settings`. Below it: last winners and the
  payout history (last 8 entries).
- **Leaderboards** — Daily / Weekly / Monthly tabs from `status.rankings`
  (rank / name / P&L% / P&L$ / equity / trades, 🥇🥈🥉 highlighted, as-of timestamp);
  clicking a row opens that agent's detail pane.

**Payout semantics:** rewards are **virtual ledger transfers** from the treasury pool
(`__treasury__`) to agents — the Alpaca client still has no transfer/withdraw surface.
They are paid **only at period boundaries** (no "pay now"), at most once per period key,
as `rankPercent × account cash`, proportionally scaled down when the available pool, the
remaining allocation cap, or `maxPerPeriodUsd` is smaller. `sum(agent equity) + pool`
stays constant, so reconciliation is unaffected; the rewards history keeps the last 50
entries.

### Agent detail: strategy & plan, transactions, rankings

Clicking an agent row keeps the existing holdings, activity and research sections and
adds:

- **Strategy & plan** (`agent.plan`): a plain-language summary, entry rule, exit rules,
  risk rule, the human "next step", a triggers grid (family/symbol/z-scores/stop/target/
  hold/size/session), the current position plan (symbol, qty, avg, stop, target, bars held
  vs max) and the next research time — with an empty state when the engine has no plan yet.
- **Transactions** (`agent.orders`): the full order/fill history table — time, side,
  symbol, qty, price, notional, realized P&L and order id — empty state "no transactions
  yet".
- **Ranking badges** for day/week/month ranks (medals for the top three) when
  `agent.rankings` is present, plus day/week/month P&L when `agent.pnl` is present.

### `POST /automaton/control`

Loopback-only operator surface: requests whose socket address is not loopback
(`127.0.0.0/8`, `::1`, IPv4-mapped variants) get `403 FORBIDDEN`, so a remote browser
session cannot drive the population.

```http
POST /automaton/control
Content-Type: application/json

{"action": "start"}
{"action": "stop"}
{"action": "emergency-stop", "confirm": "STOP"}
{"action": "reaper-stop", "confirm": "STOP"}
{"action": "set-research-settings", "settings": {"mode": "interval", "intervalSec": 10800, "enabled": true, "influence": true}}
{"action": "set-reward-settings", "settings": {"enabled": true, "period": "daily", "rankPercents": [0.05, 0.03, 0.02], "maxPerPeriodUsd": null}}
```

Settings actions are validated before they reach the engine (unknown keys and empty
patches are rejected):

| Action | `settings` fields | Validation |
|---|---|---|
| `set-research-settings` | `mode`, `intervalSec`, `enabled`, `influence` | `mode` ∈ `interval` / `pre-open` / `post-close` / `pre-open+post-close`; `intervalSec` ∈ `3600` / `10800` / `21600` / `86400`; booleans for `enabled`/`influence` |
| `set-reward-settings` | `enabled`, `period`, `rankPercents`, `maxPerPeriodUsd` | `period` ∈ `daily` / `weekly` / `monthly`; `rankPercents` exactly 3 numbers in `0..0.5`; `maxPerPeriodUsd` `null` or `0..1_000_000`; boolean `enabled` |

Success for both is `200 {"ok":true,"action":"…","result":{"settings":{…},"effective":{…}}}`.
They delegate to `engine.updateResearchSettings(settings)` /
`engine.updateRewardSettings(settings)`; an engine build without those methods returns
`501 NOT_IMPLEMENTED` instead of crashing, and the settings are never exposed as agent
tools.

| Response | Meaning |
|---|---|
| `200 {"ok":true,"action":"…","result":{…}}` | action accepted (`start`/`stop` result is the redacted engine view; `reaper-stop` result is `{stopped,pid,alive,reason?,signals?,heartbeat?}`) |
| `400` `BAD_ACTION` / `BAD_JSON` / `CONFIRM_REQUIRED` / `INVALID_SETTINGS` | malformed body, unknown action, `emergency-stop`/`reaper-stop` without `confirm: "STOP"`, or invalid settings patch |
| `403` `FORBIDDEN` | request did not arrive over a loopback connection |
| `405` `METHOD_NOT_ALLOWED` | not a `POST` |
| `409` `LIVE_NOT_ARMED` | `start` in live mode before the operator armed `LIVE_ARMED` |
| `409` `REAPER_UNAVAILABLE` | `start` refused because an alive Reaper has no version-2 heartbeat (stop it first) |
| `409` `EPERM` / `REAPER_STOP_FAILED` | the Host could not signal the Reaper process; the response carries `hint: "stop it from the operating system terminal"` |
| `5xx` | engine failure, as `{"ok":false,"isError":true,"error":{"code","message"}}` |

`reaper-stop` is implemented **entirely in this Host plugin**: it reads
`<stateDir>/reaper.pid` (plus `<stateDir>/reaper.heartbeat.json` for freshness), sends
`SIGTERM`, waits ~400 ms, escalates to `SIGKILL` if the process is still alive, and
removes the pid file. If there is no pid file or the process is not running it returns
`200 {"ok":true,"result":{"stopped":false,"reason":…}}` and cleans up a stale pid file.

## Install

The bundle is installed into the current Harness profile from its directory:

```
plugin_manager install_bundle { "target": "D:\\CounterStikers\\packages\\automaton-trading" }
```

The plugin installs with `autoStart: false`; the population starts only when you press
**Start** (or an agent calls `automaton_start`). After install (refresh/restart the app
so the new client module + routes load), verify:

1. The sidebar shows an **Automaton** entry; clicking it opens the dashboard in the
   central column (no floating window any more).
2. Settings → Built-in plugins → MEAT — Mortality Engineered Auto-Trading shows the same dashboard as a page.
3. Clicking an agent opens its holdings / past activity / genome-vs-spec detail pane.
4. The Reaper row is visible; if it shows a stale generation, **Stop Reaper** then **Start**.
5. `GET http://127.0.0.1:<port>/automaton/state` returns JSON with `"ok": true`, and a
   local `POST /automaton/control` with `{"action":"stop"}` returns `{"ok":true}`.
6. The tool list contains the ten `automaton_*` tools (the Reaper stop is intentionally
   **not** among them).
7. Research: the table shows research badges once the first hourly run lands (or a
   `—`), clicking an agent shows the briefing section, and a "research disabled" note
   appears instead when the Host has no LLM bridge. `GET /automaton/state` carries
   `engine.research` and `agents[].research`.
8. Operator controls: the research cadence segmented control applies a new schedule
   (`nextDueAt`/mode change in the panel), the rewards card previews 1st/2nd/3rd amounts
   and saves them, and the leaderboards tabs show daily/weekly/monthly ranks (rows open
   the agent detail). `POST /automaton/control` with
   `{"action":"set-research-settings","settings":{"mode":"pre-open"}}` and
   `{"action":"set-reward-settings","settings":{"period":"weekly"}}` return
   `{"ok":true,"result":{"settings":…,"effective":…}}`.
9. Agent detail: the "Strategy & plan" and "Transactions" sections render from
   `agents[].plan` / `agents[].orders`, and day/week/month ranking badges show when
   `agents[].rankings` exists.
10. Strategy taxonomy: the table shows a colour-coded **Strategy type** chip and an
    **Est. interval** for every bot; the category tabs show
    `All (30) / Swing · mid-long (n) / Day · intraday (n)` and filter the rows; the
    detail header shows the category chip and the "Bot agent" section shows the latest
    stance/thesis/plan (or the first-review-pending empty state).
11. Bot-agent bridge: the header line shows "Bot agents · configured · provider/model ·
    Day ~5m · Swing ~1h · runs/errors · next review" once `engine.agents` is present, and
    the generic "bot-agent bridge not configured yet" note otherwise.
12. Instruments: the header shows the multi-instrument line (Options level, Short, Margin
    multiplier, caps, options BP / margin debt / gross-net exposure) and each agent row
    shows the Instruments badge; the holdings table renders LONG/SHORT stock and CALL/PUT
    options with strike/expiry/DTE/contracts and spread-group tags, with the totals line
    for exposure/margin debt.
13. Instrument playbook + plan: a selected agent shows the family playbook
    (bullish/bearish/neutral structures) and the Bot agent section shows the chosen
    instrument plan (prefer + premium/contracts/DTE caps); with an engine that has no
    v3.0 fields yet the panel shows the soft "instrument status not reported yet" /
    "no instrument permissions yet" / "no instrument playbook" empty states.
14. Trade diagnostics: the header shows a **Last cycle** line (market state,
    executions/orders/errors, top-3 skip reasons, bot-review counters) and, when the paper
    account is restricted, a broker capability warning explaining that shorting/margin are
    unavailable while long stock/options remain; an agent whose permissions disable
    shorting/margin shows no Short/Margin badge and a "disabled by broker account"
    tooltip. With an older engine (no `lastCycle`/`effective`) the panel shows "no cycle
    data yet" and no warning.
15. Live analytics: the dashboard has the top bar (brand/mode/running/feed pill/market
    clock/manual refresh/pause), KPI cards, equity chart + strategy mix, a live market
    tape that flashes green/red, and the six tabs; `GET /automaton/market` returns
    `{ok:true,quotes,sparklines,portfolio,agents,equityHistory,…}` locally and 403 for a
    non-loopback caller. State polls every 5 s and the market feed every 2 s; pausing or
    hiding the tab stops both, and with an old engine (no `engine.marketView`) the panel
    shows "live feed unavailable — state-only" without breaking.

## Configuration

`cordis.patch.yml` inserts row `automaton-trading` with this config (edit it in your
profile patch to change paths; the row patch is the user's layer and survives upgrades):

```yaml
- insert:
    - id: automaton-trading
      name: '@local/automaton-trading'
      config:
        stateDir: 'D:\CounterStikers\automaton-data'
        envFile: 'D:\CounterStikers\.env'
        mode: paper          # sim | paper | live — paper is the default
        autoStart: false     # never auto-starts live; sim/paper only
        allowLive: false     # live additionally needs mode=live + LIVE_ARMED marker
```

Layering inside the engine is `defaults <- config file <- plugin row <- environment`
(`AUTOMATON_*`, `ALPACA_*`). Credentials are never stored in the config: they are read
from `envFile`/environment into a short-lived credentials object at broker construction.

Test seam: `config.engineFactory` may be supplied (function `(rowConfig, research) => engine`,
sync or async) to replace the real `createEngine`; the second argument is the Host-built
research bridge (or `null` when no LLM bridge exists). It exists for `node --test` and is
not a production configuration surface.

Research overrides (optional, plugin-row config): `researchProvider` / `researchModel`
take precedence over `agentDefaultModel.currentSelection()` and the first-registered
provider/model fallback; the same values may be supplied as nested
`config.research.provider` / `config.research.model`. The engine-side `research` config
(`enabled`, `influence`, `intervalSec`, `staggerSec`, `costPerRunUsd`, `maxAgeSec`, …)
stays in the engine's layered config.

## Tools

| Tool | Contract |
|---|---|
| `automaton_status` | Redacted snapshot: mode, account, treasury/runway, population, agents, recent obituaries, kill switch, last tick/error. Same JSON as the route. |
| `automaton_start` | Start the in-process cycle loop. Refuses **live** unless the operator armed `LIVE_ARMED`; never starts the external Reaper. |
| `automaton_stop` | Stop the cycle loop only. The external Reaper process is unaffected by design. |
| `automaton_tick` | Run exactly one cycle now; returns trace + refreshed status. |
| `automaton_agents` | Population rows with generation, equity, runway, state, cause; optional genomes. |
| `automaton_obituaries` | Newest-first death journal, `limit` (1–200) and `cause` filter. |
| `automaton_brakes` | The 18 hard brake rules (D1–D18), kill-switch/live-armed state, and an **operator dry-run** pre-trade check when `symbol` is given. Advisory only — places no order. |
| `automaton_simulate` | Accelerated deterministic mortality simulation (`cycles`, `population`, `seed`), no broker/network. |
| `automaton_config` | Effective redacted config + layer sources; no credential material. |
| `automaton_emergency_stop` | Requires `confirm: "STOP"`. Arms the `KILL_SWITCH` marker (checked before every order/cycle), stops the loop, leaves the Reaper running. |

All tools return one structured JSON envelope: `{"ok": true, ...}` on success or
`{"ok": false, "isError": true, "error": {"code": "...", "message": "..."}}` on failure.
Errors are mapped to stable codes (`LIVE_NOT_ARMED`, `CONFIRM_REQUIRED`,
`ENGINE_UNAVAILABLE`, ...), free-form messages are scrubbed, and responses are redacted.

## Safety notes

- **Paper is the default.** `mode: paper` uses `paper-api.alpaca.markets`; `sim` uses the
  deterministic in-process broker and needs no credentials.
- **Live is gated four ways:** `mode=live`, `allowLive=true`, the operator-written
  `LIVE_ARMED` marker file, and credentials matching the endpoint. `automaton_start`
  refuses live until all hold; `autoStart` is ignored for live entirely.
- **The Reaper is external.** It runs as a separate OS process, re-derives death from
  broker state, liquidates, and writes the obituary. There is **no engine control
  surface** over it (brake D12): no engine method, no IPC, no config write and no agent
  tool can stop it, and `automaton_stop`/`automaton_emergency_stop` stop trading loops
  only. The single exception is the **operator-only** `reaper-stop` action of this Host
  plugin, which signals the external pid from the Host process exactly like `kill` in a
  terminal — a deliberate operator escape hatch for orphaned stale-generation Reapers,
  never exposed to agents. An alive Reaper without a version-2 heartbeat makes
  `engine.start()` refuse with `REAPER_UNAVAILABLE` until the operator stops it.
- **18 hard brakes in code, not prompts.** No transfers/withdrawals (D1); instruments are
  gated by D2/D15–D18 (short sale, options incl. never naked short options, margin debt,
  expiry/assignment guard); session window, symbol/size/order caps, daily-loss and drawdown
  death rules, proof-or-nothing builds, population cap, kill switch, external Reaper
  isolation, allocation cap, and one-way death (no resurrection). See `docs/ARCHITECTURE.md`.
- **Controls are local-only.** `POST /automaton/control` is loopback-only and is the only
  write surface the UI has. `start`/`stop`/`emergency-stop` map exactly to
  `engine.start` / `engine.stop` / `engine.emergencyStop`; `emergency-stop` and the
  operator-only `reaper-stop` require `confirm: "STOP"`. `set-research-settings` /
  `set-reward-settings` only call the engine's validated settings updaters. No dashboard
  surface can clear the kill switch, place an order, or change the engine configuration
  directly.
- **Rewards are virtual ledger transfers.** Winner payouts move cash from the treasury
  pool (`__treasury__`) to agents; the broker client still has no transfer/withdraw
  surface (brake D1). Payouts happen only at period boundaries, at most once per period
  key, and are capped by the available pool, the remaining allocation cap and
  `maxPerPeriodUsd`; `sum(agent equity) + pool` stays constant so reconciliation is
  unaffected. The panel has no "pay now" action.
- **Kill switch:** `automaton_emergency_stop` (tool or control panel) writes
  `<stateDir>/KILL_SWITCH`; every order and cycle is denied while the file exists, and
  the panel's red indicator follows the marker file itself (not a possibly-stale engine
  snapshot). Clearing it is a deliberate operator action on the filesystem — no tool and
  no UI button can clear it.
- **Research is advisory.** The per-agent analyst has no order tool, no wallet access and
  no shared memory; its briefing can only veto/resize/exit through the agent's own
  executor, and every order still passes the 18 hard brakes. If the LLM is unavailable
  (`configured:false`) trading continues deterministically and stale briefings are ignored.
  Research cost is charged to the agent's own ledger like any other inference cost.
- **Multi-instrument expansion is paper-only and capped.** Margin, shorting, options,
  covered calls and defined-risk spreads are enabled in paper mode; live stays
  triple-gated. The brakes gate every instrument order first (D15 short sale, D16 options
  incl. no naked short options, D17 margin cap, D18 expiry/assignment guard), and the
  panel only displays the caps from `status.instruments` (e.g. options ≤25% of equity,
  shorting ≤100% of equity, max contracts 3, DTE 2–14) — it cannot place, size or modify an
  order. Short/option/margin figures shown are informational; the engine and the external
  Reaper remain the source of truth.
- **Secrets:** never returned by tools, the state route, or the dashboard. `configView`
  exposes only the env-file path and credential source signature. LLM failures are logged
  as scrubbed, structured errors — never credentials or full provider payloads.

## Development

```
node --check index.js && node --check client.js
node test/plugin.test.js
# or, when child-process spawning is allowed:
node --test --experimental-test-isolation=none test/plugin.test.js
```

The test suite uses a fake Cordis context and `config.engineFactory`; it never touches the
network, a broker, or the Harness profile. (Under the Windows DSH sandbox the default
`node --test <file>` runner cannot spawn its per-file worker — `spawn EPERM` — so run the
file in-process with `node test/plugin.test.js` or disable test isolation as shown.)

Layout: `index.js` (Host tools + state/market/control routes + engine lifecycle +
validator for research/reward settings + the operator-only Reaper stop helper; passes
`rankings`, `strategyMix`, `instruments`, `rewards` and `engine.agents` through from the
engine status, and proxies `engine.marketView()` on the market route), `client.js`
(shared dashboard: sidebar entry + keyed `main` panel + settings page, live analytics
components; names/genome-vs-spec/holdings/activity/research/cadence/rewards/leaderboards/
plan/transactions/strategy-type/bot-agent-policy/instrument-positions/playbook/last-cycle/
capability/market-tape/KPI/equity-chart/strategy-mix/live-view mapping are pure functions
exported as `helpers` for tests), `locale/{en,zh}.json` (plugin metadata), `icon.svg`,
`test/plugin.test.js`, `src/**` (engine implemented by the core project).

