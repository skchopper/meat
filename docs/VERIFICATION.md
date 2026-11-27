# VERIFICATION — INDEPENDENT review of MEAT

Verifier: independent verifier teammate (`verifier`), not an author of any module under test.
Date: 2026-10-25 (Asia/Hong_Kong). Host: Windows, Node **v22.18.0**, DSH file sandbox
`workspace-write`, **no network**, no Alpaca credentials installed.
Package: `packages/automaton-trading` (`@local/automaton-trading`).

Scope of the verifier: read `docs/ARCHITECTURE.md`, `docs/CONTRACTS.md`,
`docs/RUNBOOK.md`, every module in `src/`, `index.js`/`client.js` and the three builder test
suites, then write **only** `test/integration.test.js`, `test/security.test.js` and this file.
No module under test was edited by the verifier; defects were reported with file:line and a
minimal repro and are listed with their fix status in §4.

This document is the verification record: what was checked, how to reproduce it, the exact
results, the defects that were found (and their fix status), and what remains **unverified**.
It is written to be re-runnable; every claim below maps to a test in
`test/integration.test.js` or `test/security.test.js` (verifier-owned) or to one of the three
builder suites (`test/mortality.test.js`, `test/market.test.js`, `test/plugin.test.js`).

---

## 1. Reproduce

The sandbox blocks `node --test test/` (the runner's child-process isolation hits spawn EPERM), so
every suite is run **directly in a fresh Node process** from the package root:

```powershell
cd D:\CounterStikers\packages\automaton-trading

node test/mortality.test.js      # mortality core (builder-owned)
node test/market.test.js         # market side (builder-owned)
node test/plugin.test.js         # Host plugin + client registration (builder-owned)
node test/integration.test.js    # verifier: end-to-end sim + paper-mode death ownership + engine facade
node test/security.test.js       # verifier: adversarial live gating / D1-D14 / secrets / reaper / cap
```

The Lead's fix-verification script was also run independently and passes 15/15:

```powershell
cd D:\CounterStikers
node scripts/verify-fixes.mjs
```

> **Important on "authority":** the already-installed Harness plugin process caches the old JS
> modules until the DSH app is restarted, so a live GUI/tool call can still execute pre-fix code.
> The suites above run in fresh Node processes against the workspace sources and are therefore
> the authoritative test of the fixed code. Nothing in the Harness profile was modified by the
> verifier.

---

## 2. Result table (exact counts, fresh runs)

| # | Suite | Tests | Pass | Fail | TODO | Wall clock | Verdict |
|---|-------|------:|-----:|-----:|-----:|-----------|---------|
| 1 | `test/mortality.test.js` | 55 | 55 | 0 | 0 | 0.31 s | **PASS** |
| 2 | `test/market.test.js` | 21 | 21 | 0 | 0 | 0.20 s | **PASS** |
| 3 | `test/plugin.test.js` | 12 | 12 | 0 | 0 | 0.17 s | **PASS** |
| 4 | `test/integration.test.js` (verifier) | 21 | 20 | 0 | 1 | 0.51 s | **PASS (1 known gap documented)** |
| 5 | `test/security.test.js` (verifier) | 41 | 41 | 0 | 0 | 0.35 s | **PASS** |
| | **Total** | **150** | **149** | **0** | **1** | ~1.6 s | |

`TODO` is `node:test`'s expected-failure marker: the single TODO is a real residual gap
(§6 R1), not a flaky/ignored test. All five processes exit with code 0.

### 2.1 Verifier integration suite — per-test results

| Test (file `test/integration.test.js`) | Result |
|---|---|
| end-to-end (mode=sim): seeds genesis population from config (3 alive, gen 0, deterministic genomes, funded) | PASS |
| end-to-end (mode=sim): charges metabolism every cycle, attributes by role, burn matches formula | PASS |
| end-to-end (mode=sim): Treasurer mandates, runway, reconciliation, cycle budget, no halt | PASS |
| end-to-end (mode=sim): records executions and places orders through the brake wall with attributable ids | PASS |
| end-to-end (mode=sim): verdict + in-process sim execution + schema-valid generation-0 obituary | PASS |
| end-to-end (mode=sim): persists trace + state.json every cycle and durable registry/ledger/journal | PASS |
| end-to-end (mode=sim): ledger invariants (no negative cash, cash+positions=equity, broker agreement) | PASS |
| end-to-end (mode=sim): status surface honest; brake dry-run traverses the chain (D9 proof included) | PASS |
| end-to-end (mode=sim): replication gate, exactly one mutation, gen+1, inherited lessons, no money creation | PASS |
| end-to-end (mode=sim): kill switch blocks the cycle/orders; Reaper still closes risk; gate-vs-drawdown finding | PASS |
| end-to-end (mode=sim): no engine-side Reaper control surface; no in-engine death outside sim | PASS |
| death ownership (mode=paper): engine never executes the verdict and does not trust `deaths.json` | PASS |
| death ownership (mode=paper): independent Reaper (fresh state instances) executes and persists the death | PASS |
| death ownership (mode=paper): engine re-syncs from disk; killed agent never traded again, no duplicate obituary | PASS |
| daily_loss_limit: fires from real P&L (not hardcoded zero) | PASS |
| daily_loss_limit: KNOWN GAP — a daily_loss_limit death is frozen; Reaper only re-derives equity causes | **TODO (R1)** |
| engine facade: status/configView/brakesView/obituaries never construct the engine or start trading | PASS |
| engine facade: no way to stop/disable/re-arm the external Reaper | PASS |
| engine facade: probe reads account/clock without starting the population or leaking secrets | PASS |
| engine facade: tick() runs one cycle, leaves loop stopped, status ticks immediately correct | PASS |
| engine facade: emergencyStop arms kill switch, next cycle refused, clear removes it | PASS |

### 2.2 Verifier security suite — per-test results

| Test (file `test/security.test.js`) | Result |
|---|---|
| live gating: refuses live without mode=live + allowLive + LIVE_ARMED | PASS |
| live gating: live endpoint only when fully armed; paper never consumes live keys/endpoint | PASS |
| live gating: brokers send traffic to their own mode endpoint; keys only in headers | PASS |
| live gating: unarmed live broker performs no network request at all | PASS |
| live gating: engine.start refuses to launch live until armed | PASS |
| live gating: plugin `automaton_start` refuses live without LIVE_ARMED | PASS |
| broker D1: neither broker exposes transfer/withdraw/ACH/wire/crypto/account-config methods | PASS |
| broker D1: the Alpaca client has exactly one write endpoint family (order create/cancel) | PASS |
| broker D1: client source implements no transfer/withdrawal/ACH/crypto endpoint | PASS |
| secrets: env-file credentials absent from engine status/configView/probe/brakes/obituaries | PASS |
| secrets: `publicConfig` redacts secret-looking keys and nested secret containers | PASS |
| secrets: plugin tools + HTTP route scrub credential-shaped data and error messages | PASS |
| kill switch: brakes deny with KILL_SWITCH, before any other rule; assertKillSwitchClear throws | PASS |
| kill switch: calling the Executor directly places nothing | PASS |
| kill switch: whole automaton cycle halted before spending | PASS |
| Reaper D12: no engine facade/tool can stop/disable the Reaper | PASS |
| Reaper D12: CLI accepts only `--state-dir`/`--once`/`--help` | PASS |
| Reaper D12: reaper-process refuses a sim-mode state dir (no wrong-venue kills) | PASS |
| Reaper D12: kill durable across fresh load (no resurrection), idempotent, only `sweep()` exists | PASS |
| Reaper D12: no config flag disables the Reaper | PASS |
| D14: registry API/module exports contain no revival path | PASS |
| D14: markDead irreversible; no status patch; dead agent cannot be updated; survives reload | PASS |
| D10: registry refuses registration at the cap (living only); death frees a slot | PASS |
| D10: replicator refuses a birth at the cap even with an open Treasurer gate | PASS |
| D10: running engine never exceeds the configured cap | PASS |
| D10: config validation rejects initial > cap | PASS |
| D1 TRANSFER_FORBIDDEN | PASS |
| D2 MARGIN_FORBIDDEN | PASS |
| D3 MARKET_CLOSED | PASS |
| D4 INSTRUMENT_FORBIDDEN | PASS |
| D5 SIZE_FORBIDDEN | PASS |
| D6 RATE_FORBIDDEN | PASS |
| D7 LOSS_LIMIT (fatal, not a pause; enforced as Treasurer death verdicts) | PASS |
| D8 LIVE_NOT_ARMED / MODE_FORBIDDEN | PASS |
| D9 NO_PROOF / PROOF_STALE | PASS |
| D10 REPLICATION_FORBIDDEN / POPULATION_CAP | PASS |
| D11 KILL_SWITCH | PASS |
| D12 REAPER_ISOLATED | PASS |
| D13 ALLOCATION_FORBIDDEN | PASS |
| D14 RESURRECTION_FORBIDDEN | PASS |
| catalogue is exactly the 14 documented brakes with unique ids/codes | PASS |

---

## 3. What was actually verified (by claim)

### 3.1 Metabolism, runway, death
- Genesis population is seeded from `population.initial`, generation 0, deterministic genomes
  (`symbols[0..2]` × `momentum/meanrev/breakout`), each funded with `endowmentUsd` through
  `grant` (declared ≠ funded; cash really exists). Test: *seeds the genesis population*.
- Every cycle charges hosting/data/inference, **attributed by role** (`prospector`, `builder`,
  `executor`, `treasurer`) and the per-cycle debit now equals the burn formula
  `inference + data + hosting*(cycleInterval/3600)` to 1e-6 (`0.03508333/cycle` with the test
  config). Tests: *charges metabolism…*, *burn matches formula*.
- Equity decomposes exactly: `equity − endowment = realized + unrealized − costs` (± $0.05
  rounding). Runway is reported as hours from `(equity − floor)/burn`, never raw balance.
- Treasurer issues one mandate per living agent (expiry, size budget, allowed symbols,
  daily-order remainder), computes portfolio burn/runway/cycle budget ($0.08 STABLE),
  reconciliation against broker equity (ok, delta = ledger-only cycle costs), and stays
  un-halted and non-replicating while unhealthy. Test: *Treasurer prices the population*.
- Death is a **verdict request**: the engine writes `deaths.json`, marks the agent condemned and
  stops charging/trading it. The Reaper independently re-derives death, liquidates, sweeps the
  residual, marks dead, writes one obituary. In `mode=sim` (demo only) the engine executes the
  verdict in-process and reports `deathsExecuted`; in `mode=paper` the engine must not execute
  and does not (verified with a separate Reaper built on freshly-loaded state modules, i.e. the
  way the external process sees the world). Tests: *verdict + in-process sim execution*,
  *death ownership (mode=paper)* ×3.
- Obituary satisfies `validateObituary` and the documented 20 fields, including
  `firstProfitAt: null`, correct endowment/final equity/`netPlUsd`, generation 0 (fixed), and
  `lessonsFor(genome)` returns at least one lesson. Journal statistics aggregate causes/rates.

### 3.2 The six roles and the stoplines
- Execution attributes every fill via `client_order_id = atm:<agentId>:<specId>:<seq>`; the
  broker order count equals the sum of per-cycle trace orders; every referenced spec file exists.
- Executor never reads account equity: exercised through the real modules in the integration
  happy path and by the brake wall tests; `broker.getAccount` is only called by Treasurer/Reaper.
- Prospector supplies dated proof (URL + observedAt + measured stats); Builder compiles without
  choosing symbol/family and stores `proofRef`; D9 order-time check requires the proof.
- Replicator: birth only when the Treasurer gate is open, exactly **one** genome field mutates,
  the child gets `generation = parent+1` (genesis 0 → child 1 after the fix), genome inherited
  plus one mutation, and `lessonsFor(childGenome)` from the journal (the child's `notes` contain
  the prior death lesson). Endowment is transferred from the parent's cash only; the virtual
  total does not increase (no money creation). Tests: *replication…*.

### 3.3 Durability and the external Reaper (the critical defect area)
- After the fixes, a Reaper kill is persisted (`registry.json` status `dead`, `ledger.json` cash
  swept to 0, obituary JSONL appended) and **survives a fresh load** — no resurrection. The
  external process entry also saves after each sweep. Test: *kill durable across fresh load*.
- The engine re-syncs `registry.load()`/`ledger.load()` at the start of every cycle, prunes the
  condemned set for agents now dead on disk, and therefore cannot keep charging, trading or
  funding a Reaper-executed agent. Verified in the paper-mode world: the third tick after the
  external kill shows the dead agent absent from executions and the obituary count still 1 (no
  duplicate).
- `reaper-process.js --once` refuses a `mode=sim` state dir (logged `event:"refused"`, exit 0)
  so a synthetic-broker process cannot kill for the wrong reason. Test spawns the real Node
  process (`stdio: 'ignore'`, as the sandbox blocks piped stdio).

### 3.4 Brakes (D1–D14)
Each rule was attacked at its real enforcement site with a minimal constructed context (see the
14 PASS rows in §2.2). D1/D12/D14 are *architectural* brakes and were verified structurally:
- D1: no money-movement/account-config method on either broker (runtime property scan **and**
  source scan); the only write endpoints in the Alpaca client are `POST /v2/orders` and
  `DELETE /v2/orders/:id`; endpoint allowlist asserted on a stubbed fetch surface.
- D12: the Reaper has no engine method, no tool, no config flag; it is a standalone entry that
  refuses sim; its module exposes only `sweep()`; the engine facade exposes a read-only
  `reaper` status getter and nothing callable.
- D14: no `markAlive`/`revive` anywhere in the API or module exports; `markDead` twice throws
  `AGENT_DEAD`; dead agents cannot be patched/updated; the death survives reload.
- D7: the two loss limits are **death verdicts** (`drawdown_limit`, `daily_loss_limit`), not
  pauses — verified on the Treasurer directly and through the engine.

### 3.5 Live gating and secrets
- Live requires all of `mode=live`, `allowLive=true` and the `LIVE_ARMED` marker; any missing
  leg throws `LIVE_NOT_ARMED` and the unarmed broker performs **zero** HTTP requests.
- Paper resolves `paper-api.alpaca.markets` and ignores live-named keys; live resolves
  `api.alpaca.markets`. Credentials travel only in `APCA-*` headers, never URLs.
- Env-file secrets never appear in engine `status`/`probe`/`configView`/`brakesView`/
  `obituaries`, plugin tool JSON, or `/automaton/state`; the plugin also scrubs
  credential-shaped strings out of error messages (`AKIA…`, `secret=…`).
- The engine facade never auto-starts trading: read-only calls leave `engine.automaton === null`,
  no `state.json` is written, and `tick()` does not start the timer loop.

### 3.6 Population cap, kill switch
- Cap is enforced in the registry (living agents only), in the replicator (even with an open
  Treasurer gate), and end-to-end in a running engine whose population never grows past `cap`.
- Kill switch: checked before anything spends/trades; denies with `KILL_SWITCH` before every
  other rule; a whole cycle returns `halted/haltReasons: ["KILL_SWITCH"]` with no charges and no
  broker orders; the Executor cannot bypass it when called directly; the Reaper keeps liquidating
  by design (operator emergency stop leaves the Reaper running).

---

## 4. Defects found by this verification and their fix status

All seven were reported to the Lead with file:line and minimal repro. They are now fixed in the
workspace and re-verified by the tests named below (`docs/VERIFICATION.md` keeps them because
finding + fixing them is the value of the independent pass).

| # | Sev | Defect (pre-fix) | Fix location (current) | Re-verified by |
|---|-----|------------------|------------------------|----------------|
| F1 | **CRITICAL** | Reaper never persisted its kills: `killAgent`/`settleDeadAgent` marked dead and swept in memory only, and `reaper-process.js` never saved after a sweep. Because the Reaper is a separate process, the engine (which had loaded state once at init) never learned of the death, kept charging/trading the agent, and a process restart **resurrected** the dead agent while the journal already held its obituary. | `src/reaper.js:206-210,250-251`; `src/reaper-process.js:198-205`; engine propagation: `src/orchestrator.js:396-407` (per-cycle re-sync + condemned pruning) | integration *death ownership (mode=paper)* ×3; security *kill durable across fresh load*; `scripts/verify-fixes.mjs` checks 1-4 |
| F2 | HIGH | `automaton_brakes` dry-run could never ALLOW: `preTradeCheck` passed a `{specId}` stub as the spec, so D9 always denied `NO_PROOF`. The advertised "operator dry-run through the real brakes chain" was decorative. | `src/orchestrator.js:799-810` (full compiled spec from `state.specs`) | integration *status surface honest + dry-run traverses the chain*; `verify-fixes.mjs` check 10 |
| F3 | MEDIUM | `daily_loss_limit` death was unreachable: `dayStatsFor()` hardcoded `pnlUsd: 0`, so the Treasurer could never see a day loss in the real engine loop. | `src/orchestrator.js:173-187,437-451` (real P&L each cycle) | integration *daily_loss_limit fires from real P&L*; `verify-fixes.mjs` check 11 |
| F4 | MEDIUM | Generation numbers corrupted by truthiness: `Number(agent.generation) \|\| 1` relabelled genesis gen-0 as gen-1 in obituaries, and `(parent.generation \|\| 1) + 1` made children of genesis parents gen-2 (gen-1 skipped) — corrupting the gen-1 vs gen-3 survival dataset. | `src/reaper.js:154-155`; `src/replicator.js:206-207` (`Number.isFinite` guards) | integration *obituary generation-0* + *child gen+1*; security *kill durable…* (generation 0); `verify-fixes.mjs` checks 5/13 |
| F5 | LOW | Status lied: `state.ticks` was incremented after writing `state.json` (status lagged one tick); `population.total` was the alive count (`total ≠ alive+dead`); dead agents were reported as `"condemned"` forever because `state.condemned` was never cleared after execution. | `src/orchestrator.js:408,406,650-658,706-713` | integration *persists trace/state.json*, *status surface honest*; `verify-fixes.mjs` checks 6-9 |
| F6 | LOW | Per-cycle cost attribution rounded each role charge to 2dp before deducting: a run charged ~$0.04/cycle instead of the configured $0.035 (data $0.005→$0.01, inference slices rounded up) and hosting rounded to zero, so actual burn diverged from the runway formula by ~14%. | `src/ledger.js:122-130,202,214-216` (8dp money); tested against `expectedBurnPerCycle()` | integration *burn matches formula*; `verify-fixes.mjs` check 9 |
| F7 | GAP | `mode=sim` had no death execution path at all (engine comment claimed an in-process simulation existed; the orchestrator never killed, so sim condemned agents lingered forever and no obituary was ever written by an engine loop), and the external Reaper could be pointed at a sim state dir where its synthetic-broker account differs from the engine's. | `src/orchestrator.js:476-497` (sim-only in-process Reaper + `deathsExecuted`); `src/engine.js:185-196`; `src/reaper-process.js:124-135` (refuses sim) | integration *verdict + in-process sim execution*; security *reaper-process refuses sim-mode dir*; `verify-fixes.mjs` checks 2/15 |

Minimal repros used (all were run before the fixes, then re-run after):

1. **F1 resurrection** — seed an under-funded agent (`endowment 5000`, grant `100`), `save()`;
   construct a *second* registry/ledger pair and `.load()` it (the external Reaper's view);
   `createReaper(...).sweep()` kills it and writes the obituary; read `state/registry.json`:
   pre-fix `"status":"alive"`; a new `createRegistry().load()` -> `"alive"` while the journal
   said dead. Post-fix: disk `"dead"`, reload `"dead"`, ledger cash `0`.
2. **F2** — after one tick: `automaton.preTradeCheck({agentId: <alive>, symbol:
   <genome.symbol>, side: 'buy', notionalUsd: 100})` -> pre-fix `{decision:'DENY',
   code:'NO_PROOF', brakeId:'D9'}`; post-fix `{decision:'ALLOW'}`.
3. **F3** — after one tick, `state/day-stats.json` entries had no `pnlUsd`; post-fix the
   Treasurer receives `pnlUsd = equity − startEquityUsd` and a −$300 cycle produces a
   `daily_loss_limit` verdict.
4. **F4** — kill a genesis agent: pre-fix `journal.list()[0].generation === 1` while
   `registry.get(id).generation === 0`; child of a gen-0 parent was gen-2. Post-fix: 0 and 1.
5. **F5** — 9 successful ticks then `status()`: pre-fix `engine.ticks === 8`,
   `population.total === alive` with `dead > 0`, executed agent row `"condemned"`. Post-fix
   9 / `total = 3 = 2 alive + 1 dead` / `"dead"`.
6. **F6** — `ledger.charge(agent, 0.0075)` deducted $0.01 pre-fix; a 3-cycle run charged $0.12
   vs the $0.10525 formula. Post-fix the run charges exactly the formula.
7. **F7** — `node src/reaper-process.js --state-dir <sim-state> --once` pre-fix started sweeping
   a simulated account from a separate process; post-fix exits 0 and logs
   `event:"refused"` without touching state.

---

## 5. Residual findings (OPEN — not fixed, reported to the Lead)

| # | Sev | Finding | Evidence / repro |
|---|-----|---------|------------------|
| R1 | MEDIUM | **A `daily_loss_limit` death is not executable by the Reaper.** The rule now fires (F3 fixed), but `reaper.sweep()` re-derives death only from equity (insufficient funds / drawdown) and never reads day P&L, so a daily-loss condemned agent is *frozen alive forever*: the engine stops charging/trading it (`condemned`), but it never receives an obituary and keeps its population slot. Same structural limitation applies to the system-level causes (`account_not_active`, `reconciliation_mismatch`, `risk_breach`) if they are ever emitted as death verdicts — the Reaper deliberately ignores the verdict file. | `src/reaper.js:309-319` (death derivation: `insufficient_funds`, `drawdown_limit`, `systemDead` only) + integration TODO test *“daily_loss_limit death is frozen”*, whose expected `dead`/obituary assertions fail while the observed state stays `alive` / `journal.count() === 0` after the cycle. |
| R2 | MEDIUM | **The replication gate does not account for the drawdown death rule.** `replicator.spawn` requires `parentEquity − childEndowment >= 2 × deathFloor` (`src/replicator.js:163`), but the drawdown rule kills at `endowment × (1 − maxDrawdownPct)` (`src/treasurer.js:269-272`). With the default economics a parent can pass the gate, fund the child, and immediately fall below its drawdown threshold — i.e. a successful birth at the cost of the parent's life, contradicting D10's wording. | Integration test *kill switch … gate-vs-drawdown finding*: after the forced birth the independent Reaper kills **two** agents — the intended `insufficient_funds` child and the **parent with cause `drawdown_limit`** (final equity $3,100.12 < $3,750 threshold). Deterministic with `seed 6`, parent equity ≈ $5,600 → child endowment $2,500. |
| R3 | LOW | `state/day-stats.json` does not persist `pnlUsd` (only `ordersCount`/`startEquityUsd`); the daily-loss rule works because the engine computes live P&L every cycle, but an external observer of the file cannot see the P&L that killed an agent. | `src/orchestrator.js:437-451` (computed into the `dayStats` argument) vs `saveDayStats()`/`state.dayStats` (`:169-171`) which keeps only the persisted shape; observed in `state/day-stats.json` after ticks. |
| R4 | MEDIUM | **Two writers, no lock.** The engine and the external Reaper both write `registry.json`/`ledger.json` (atomic file rename, but no locking or version check). The per-cycle re-sync (F1) narrows the stale window, but an engine in-memory save can still overwrite a Reaper save that happened mid-cycle (lost update), and vice versa. | `src/orchestrator.js:396-407,434,585`; `src/reaper.js:209-210,250-251`; `src/reaper-process.js:201-202`. Not reproduced under real concurrency (see NOT verified). Recovery path: next Reaper sweep re-settles the agent (`settleDeadAgent`), so it is self-healing but can double-sweep / temporarily show a zombie. |
| R5 | LOW | The kill switch is an **execution-path wall**, not a broker freeze: any code that holds the broker object can still call `broker.submitOrder()` directly (the Reaper does exactly this deliberately to close risk). Only the Executor path and the cycle loop consult the marker. This matches the architecture ("agents never hold the broker"), but it is not a process-wide interlock. | Brakes/executor tests; `src/brakes.js:112-118,185-187`; reaper never checks the kill switch (integration *kill switch … Reaper still closes risk*). |
| R6 | LOW | Reconciliation tolerance (2% of account equity, default $2,000) masks ledger-only drift. Deliberate in the docs (per-agent equity is bookkeeping), but it means a $599 ledger-only “profit” used to force the replication gate in testing passes reconciliation. Do not read `deltaUsd ≈ 0` as proof the virtual ledger equals the broker. | integration *replication…*: after a ledger-only +$600 round trip, `reconciliation.deltaUsd = −599.44`, `ok: true`. |

---

## 6. NOT verified

Explicitly out of scope or impossible in this environment; do **not** read the green table above as
evidence for these:

1. **Live trading / real money.** No Alpaca keys are installed, no network is available, and live
   mode was never armed. What *is* verified: live refuses without the full arming chain and makes
   no request while unarmed; endpoint selection with stubbed fetch; the operator must create
   `LIVE_ARMED`. Actual armed live order submission, broker permissions, buying-power behavior,
   and real fills are **not** verified.
2. **Paper-mode connectivity against Alpaca.** All HTTP is a stub double (`fetchImpl`); TLS, auth,
   rate limits, `/v2/clock` reality and partial fills are not exercised against the vendor.
3. **The external Reaper running as a detached, long-lived OS process against a real broker.**
   Verified: the entry is a standalone Node process, its CLI parses only documented flags, it
   refuses `mode=sim`, and its kill/sweep logic (with the same modules) executes and persists the
   death durably. **Not** verified: `engine.start()` spawning it for paper/live and retrying
   (needs credentials), continuous `reaperIntervalSec` sweeping, SIGINT/SIGTERM shutdown, and
   multi-process write interleaving with the engine (R4).
4. **Browser rendering of the dashboard panel.** The verifier did not run a browser/screenshot.
   The Lead separately verified `GET /automaton/state` returns 200 and the client registers both
   slots (`settings.plugins.tab`, `conversation.composer.dock`); client rendering, layout, polling
   cadence, locale switching and the installed profile’s cached-module behavior were not verified
   here.
5. **Real market-closed behavior.** All runs use a fixed synthetic clock at Mon 10:00 ET; the D3
   session tests use constructed timestamps. The real market was closed during verification; no
   test depends on it, and no live-session behavior was observed.
6. **Adversarial agents in a real environment.** The six roles are deterministic code, not LLM
   agents under adversarial prompt injection; "agents can't" claims are checked structurally
   (API surface, brakes) but no real autonomous agent tried to evade the walls. The threat model
   is code-path discipline, not a compromised model.
7. **Long-run population behavior.** Tests run 1–12 cycles (minutes of simulated time, ~$0.3 of
   costs); no multi-day selection, gen-3 drift, journal growth/performance, long-horizon
   overfitting, or population collapse statistics were verified. `automaton_simulate` /
   `src/simulate.js` was exercised only by the builders' short test (`cycles: 6`), not by a long
   mortality run in this verification.
8. **Multi-agent concurrency / process crashes.** No kill -9 mid-write, no two engine instances,
   no crashed-Reaper recovery beyond the unit path (`settleDeadAgent`) already covered by the
   builders' suite.
9. **Harness integration end-to-end.** The ten `automaton_*` tools are live in the installed
   profile, but this verification runs the plugin contract in-process with fake Cordis
   contexts/engines (as the builders' `plugin.test.js` does); actual tool dispatch through the
   running Harness, the panel fetch loop, and module caching after a code change (see banner at
   the top) were not exercised by the verifier.

---

## 7. Verdict (does the delivered system match the article's architecture?)

Yes in substance, with the caveats above. The role/stopline separation is real code, not theatre:
the Treasurer is the only account-equity reader, the Executor trades only inside a mandate and
never sees balance, the Prospector cannot size/order, the Builder cannot move symbol/family and
must carry dated proof, the Replicator cannot decide its own birth, and the Reaper is a separate
process entry that the engine cannot stop. The brakes are real denials at the point where the
broker is called, not prompt text. The obituary dataset exists and is validated/deduped, children
inherit the journal digest plus exactly one mutation (generation numbering now correct), and
`firstProfitAt: null` is preserved. The two implementation gaps that keep it from being *fully*
the article's system are (R1) a death cause that is declared fatal but cannot be executed by the
Reaper, and (R2) a replication gate that checks the death floor but not the drawdown death rule,
so a birth can kill the parent; the external-process durability flaw that would have turned the
whole death mechanism into theatre (F1) was found, reported, fixed, and re-verified here. The
system is genuinely mortality-engineered — but it is a paper/sim trading system: no live/real-money
behavior is verified, and the "agents are AI" framing is not part of what was tested.

---

## 8. Lead addendum — post-verification fixes (2026-10-25)

The Lead fixed the residual findings R1–R3 after this verification was written, and re-ran
everything. This section is owned by the Lead, not the verifier; the verifier's findings above
remain the record of what was found.

| Finding | Status | What changed |
|---|---|---|
| **R1** `daily_loss_limit` not executable by the Reaper | **FIXED** | `src/orchestrator.js` persists `pnlUsd` into `state/day-stats.json`; `src/reaper.js` reads that record and re-derives `daily_loss_limit` (`-pnl/startEquity >= maxDailyLossPct`), and re-derives `account_not_active` from the broker account status. A daily-loss death is now executed and leaves an obituary. |
| **R2** replication gate ignored the drawdown rule | **FIXED** | `src/replicator.js` now requires `parentEquity - childEndowment > max(2 x deathFloor, endowment x (1 - maxDrawdownPct))`, so a birth that would push the parent under the drawdown threshold is refused (`REPLICATION_DENIED`). |
| **R3** day P&L not persisted | **FIXED** | `pnlUsd` and `dayKey` are stored in `state/day-stats.json` for every living agent each cycle. |
| **R4** dual writers, no lock | **OPEN (accepted)** | Narrowed by the per-cycle re-sync and the Reaper's immediate persist; self-healing via `settleDeadAgent` on the next sweep. A real file lock is future work; it needs a cross-process lock primitive the Host does not provide. |
| **R5** kill switch is an execution wall, not a broker freeze | **OPEN (by design)** | The broker object is never held by agents; the Reaper deliberately bypasses the marker to close risk. Documented in `docs/ARCHITECTURE.md` §5. |
| **R6** reconciliation tolerance can mask ledger drift | **OPEN (documented)** | Deliberate: per-agent equity is bookkeeping on a shared Alpaca account. Do not read `ok: true` as proof of ledger/broker equality. |

Final re-run after the fixes (fresh Node processes, direct execution):
`mortality 55/55`, `market 21/21`, `plugin 12/12`, `integration 21/21`, `security 41/41` —
**150 tests, 150 pass, 0 fail**, and `scripts/verify-fixes.mjs` **18/18 checks pass**
(reaper persistence across reload, no resurrection, gen 0/1, exact burn accounting, in-process
sim death, external-Reaper refusal for sim, daily-loss execution + obituary, replication
drawdown refusal).

Note on the accelerated simulation preset: after the corrected R2 gate, a birth is only
possible for a parent that has actually grown. On the random-walk sim market most agents only
drain, so a 200-cycle demo run typically shows mortality and survival (25 dead / 75 alive,
seed 7) but **no** reproduction; reproduction is covered deterministically by the test suites
(funded-parent scenarios) and will happen in paper/live only when an agent's equity genuinely
supports it. This is the honest behaviour of a no-edge market, not a missing feature.

### Paper-account verification (2026-10-24, after Alpaca paper keys were supplied)

What was run against the **real paper endpoint** (`https://paper-api.alpaca.markets`), from the
fixed code in fresh Node processes:

| Check | Command | Result |
|---|---|---|
| Credentials + account | `bin/automaton.mjs probe` | equity **$2,000**, cash **$2,000**, buying power $8,000, status **ACTIVE**, `market open: false` |
| One read-only cycle | `bin/automaton.mjs tick` (and `scripts/paper-verify.mjs`) | 10 symbols, **1,172 real hourly bars**, 10 quotes, 3 dated-proof hypotheses, 2 compiled specs, **0 orders**, 0 errors |
| D3 wall with the broker clock | `scripts/paper-verify.mjs` | `DENY MARKET_CLOSED — market is closed (broker clock)` |
| Independent broker state | Alpaca `/v2/orders`, `/v2/positions` | **0 orders, 0 positions** |
| Detached external Reaper | `scripts/reaper-spawn-verify.mjs` | engine spawned pid alive; reaper swept the real account (`checked=2 killed=0`); `engine.stop()` left it running by design; stopped manually as operator |
| Reconciliation | status | `ok`, delta $0.20 (tolerance $40) |

The account cannot carry the repo defaults (2 × $500 endowments fit the 80% cap of $2,000; the
default 3 × $5,000 does not), so `automaton.config.json` now carries account-scaled economics:
2 agents, $500 endowment, $25 death floor, $250 child endowment, 100 bps spread ceiling for IEX
data.

**Defects found only by testing against the vendor (all fixed):**

| Finding | Status | Fix |
|---|---|---|
| `GET /v2/stocks/bars` returns **no bars** when the window is omitted, returns the **oldest** bars when unsorted, and paginates multi-symbol requests **one symbol per page** (so a multi-symbol call silently returned one symbol) | **FIXED** | `src/broker-alpaca.js#getBars` issues one bounded-window request per symbol (`start`/`end`, `sort=desc`), sorts ascending defensively; market test updated to assert per-symbol requests + window |
| D3 only enforced the weekday time window; a Saturday signal would have been submitted to a closed market | **FIXED** | orchestrator reads `broker.getClock()` each cycle and forwards `marketOpen`/`marketClock` through the executor into `brakes.checkOrder()`; verified `DENY MARKET_CLOSED` against the real clock |
| Weekend IEX quotes are gross (spread ≈ 1,000 bps for AAPL), so a 25 bps ceiling would block every paper entry even during the week | **TUNED** | paper config `risk.maxSpreadBps = 100`; D4 still denies genuinely illiquid quotes (verified denying the weekend quote before the D3 context was forwarded) |

**Still not verified:** actual paper fills (the market was closed for the entire build; the next
open is Monday 09:30 ET), live-mode order flow, and browser rendering of the panel. These remain
the honest boundaries of this delivery.

### 30-agent population + control panel (2026-10-24, second request)

The user asked for **30 agents with $20 each and their own strategy**, plus a tracker UI.

| Check | Result |
|---|---|
| Population seeded | **30 gen-0 agents**, $20.00 each, $600 allocated of $2,000 (30%), cap 60, reconciliation `ok` |
| Distinct strategies | 30 unique deterministic genomes (10 symbols × momentum/meanrev/breakout, randomized lookback/entryZ/exitZ/stop/target/hold/size/session); 22 distinct proven symbol×family pairs (the rest trade their family on the nearest proven symbol — the Builder refuses unproven combinations); **30 distinct compiled specs**, all persisted (`registry.json` specIds) |
| Metabolism scaled for $20 | $0.00025/cycle burn, $1 death floor, 20% drawdown death, $10 child endowment; runway 6,312 h at genesis; 30 agents × 1 cycle = 0.006% account drag |
| Real paper cycle with 30 agents | 1,172 real bars, 22 hypotheses, 30 builds, 30 executions, **0 orders** (market closed), 0 broker orders/positions, D3 `MARKET_CLOSED` on the wall check |
| Test suites after the change | mortality 55, market 21, plugin 20, integration 21, security 41 → **158/158 pass**; `scripts/verify-fixes.mjs` 18/18 |
| Control panel client half | Live: `shell.overlay` has an active `automaton-trading` occupant (inspected through the Client Slots provider); settings tab and composer strip register through the same shared component |
| Control route | Implemented + unit-tested (`POST /automaton/control`: loopback 403, start/stop/emergency mapping, confirm required, 400/405/409); **needs one app restart** — a fresh Host boot activated the plugin before `webServer` mounted, so the Host half now late-binds its routes |
| 30-agent table mapping | Unit-tested in `test/plugin.test.js` via exported pure helpers: rows, sort, filter, summary, generations, obituaries, $20 endowment P&L fallback; unknown fields render '—' |

**Known limitation found during this change (fixed):** the Host plugin originally captured
`ctx.get('webServer')` once at activation. If the plugin activates before the web server service is
mounted (fresh app boot), both routes are silently skipped while the tools still register — the
panel then polls 404s. `index.js` now polls for the service for up to 60 s inside a disposable
effect, so routes register as soon as the server exists. A restart is required to load the new
Host module generation.

**Still not verified:** visual rendering of the panel (structurally verified only), the Start
button driving a live loop for a full market session, and actual paper fills.

### Sidebar UI, strategy names, holdings drill-down, Reaper hardening (2026-10-25, third request)

The user asked for: sidebar instead of a floating panel, memorable strategy-derived agent names,
and click-through holdings/activity per agent.

| Check | Result |
|---|---|
| Agent names | 30 unique strategy names persisted in `registry.json` (`Momentum AAPL`, `Momentum MSFT`, … `MeanRev …`, `Breakout …`); name is displayed primary, `atm-xxxxxxxx` id secondary; obituaries carry the name |
| Holdings + activity data | status rows now include `positions` (qty, avg/last price, market value, unrealized P&L, opened-at), `recentTrades` (newest-first fills: side, qty, price, notional, realized P&L, time), `tradesCount`, `realizedPlUsd`, `unrealizedPlUsd`, `firstProfitAt`, and the compiled `spec` (genome-vs-trading distinction) |
| Sidebar registration (live) | Client slot inspector: `sidebar.panellist` occupant `automaton-trading` (order 30, active) **and** keyed `main` occupant `automaton-trading` (active) — clicking the sidebar entry selects the dashboard in the central column; the old `shell.overlay` occupant is gone |
| Plugin tests | 28/28 (names, genome-vs-spec, holdings/activity mapping + empty states, slots `sidebar.panellist` + `main` + settings tab, control route incl. `reaper-stop` confirm/missing-pid/EPERM/kill-escalation, 10 tools) |
| Full suite | mortality 55, market 21, plugin 28, integration 21, security 41 → **166/166 pass**; `scripts/verify-fixes.mjs` 18/18 |
| Reaper hardening | new Reaper reloads registry/ledger before every sweep and writes `reaper.heartbeat.json` v2; `engine.start()` refuses to reuse a Reaper without a matching heartbeat; `engine.status().engine.reaper` now reports pid/alive/heartbeat/sweeps read from disk; the engine still has **no** Reaper control method (D12 tests still pass) |

**Incident found during this change (hardened, one residual manual step):** a Reaper left over
from the previous app generation (pid 24452, pre-heartbeat code) kept saving its process-start
snapshot of `registry.json`/`ledger.json` every 30 s, reverting agent names and costs. A sandboxed
shell cannot signal a process owned by the Host (EPERM), so the operator must clear it once:
after the app restart, the panel shows the stale-generation Reaper row and an operator-only
**Stop Reaper** action (`POST /automaton/control {"action":"reaper-stop","confirm":"STOP"}`,
Host-side kill), or run
`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*reaper-process.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`
in a normal terminal. New Reapers cannot recur the bug (reload-before-sweep + heartbeat).

**Still not verified:** visual rendering of the sidebar/dashboard (slot registration is verified
live; pixels are not), the Start button driving a full market session, and actual paper fills.

### First live paper session — async-fill bug found and fixed (2026-10-26)

First real paper session: the loop ran 519 ticks with the market closed (0 orders, D3
`MARKET_CLOSED` denials by design — the session window starts 09:35 ET), the external Reaper
v2 stayed healthy (pid/heartbeat/sweeps), 30 agents and names persisted, reconciliation `ok`.
At **09:39 ET** the first live order was placed and filled: `MeanRev AAPL` bought
`0.0068 AAPL @ $343.922` ($2.33 notional, `client_order_id atm:atm-72e7db49:spec-64e8f7c4:1`).

**Defect found by that fill:** Alpaca returns a market order as `accepted` before it fills, with
`filledQty = 0`; the executor used `numberOrNull(filledQty) ?? orderQty`, and since `0` is not
nullish it attempted to book a 0-qty fill — the ledger rejected it (`fill qty must be > 0`), the
real fill never reached the virtual ledger, and the panel showed no holding. Found by comparing
the broker position against `ledger.json` after the order.

**Fix (executor):** (a) fill delta is computed against already-booked qty per `orderId` (handles
partials), (b) after submitting, the executor briefly polls the broker for the fill and books the
actual `filledQty`/`avgFillPrice`, (c) every cycle reconciles recent filled broker orders for that
agent whose `client_order_id` starts with `atm:<agentId>:` and books anything the ledger has not
seen yet. The missed fill was backfilled with `scripts/reconcile-fills.mjs`
(`MeanRev AAPL`: cash 17.53 + AAPL 0.0068 @ 343.922, trades 1).

Also hardened in the same change: atomic JSON writes retry transient Windows `EPERM/EACCES/EBUSY`
rename races (engine + Reaper both save `registry.json`/`ledger.json`), and a successful cycle
clears a stale `lastError` instead of leaving it sticky forever (one transient file-lock error had
been shown persistently). Full suite after the fixes: **166/166 pass**, `scripts/verify-fixes.mjs`
18/18. The running Host must be restarted to load these engine fixes; the loop was stopped before
the fix so no further unbooked fills could accumulate.

### Per-agent research sidecar (2026-10-26, user-requested upgrade)

The user asked whether the population members are separate Harness agents (they are not — 30
deterministic strategy instances in one engine) and asked for **per-agent isolation plus hourly
research of company/internet news about each agent's holdings**. Chosen design: **A2 now** (one
isolated stateless LLM analyst per agent with a private briefing journal; designed so a bot can
later be promoted to its own Harness agent), **live influence from day one**, light budget
($0.001/briefing charged to the agent's ledger). Contract: `docs/RESEARCH.md`.

| Check | Result |
|---|---|
| Research unit suite | `test/research.test.js` **9/9**: prompt isolation (no other agent id/name/book/journal), schema clamp/validation, malformed-reply containment (no briefing, no charge, error logged), per-agent ledger charge (category `research`, role `prospector`), hourly scheduling (due → skipped → due), stale expiry (`maxAgeSec`) with dashboard still showing stale briefings, empty-news neutral HOLD with no LLM call, HTTP fallback generator absent without key / mapped with key |
| Composition smoke | `scripts/research-smoke.mjs` **10/10** on the real `createAutomaton` + sim broker: research runs for due agents, `engine.research` configured, every agent row carries its own briefing, per-agent journals on disk, each briefing charged to its own ledger, second cycle does not re-run, next hour due again |
| Executor influence | market suite **27/27** (21 + 6 new): fresh AVOID/ALERT/sentiment/risk veto → `skip research_veto` (never a denial), size scaling can only shrink and respects caps, `research_alert` exit, stale/disabled/malformed/missing = byte-for-byte baseline |
| Broker news | Alpaca `GET /v1beta1/news` verified live against the paper keys (HTTP 200 with headlines/summaries/urls); mapping/filters/outage in market tests; sim broker has a deterministic synthetic feed. Alpaca returns `[]` on `BROKER_ERROR` so a news outage can never break a trading cycle; auth/rate-limit/config errors still surface |
| Plugin bridge + dashboard | plugin suite **36/36**: `createResearchBridge` provider resolution (agentDefaultModel → first provider/model, row/nested overrides), stream concatenation/usage, clean scrubbed errors, engine factory receives the bridge, GET state passes `engine.research` and per-agent `research`, client mapping helpers (badge HOLD/AVOID/ALERT/stale/none, detail catalysts/risks/sources sanitization, shadow/influence/disabled banners). Real-engine sim smoke with a fake Host llm: `configured:true`, provider/model resolved from the bridge |
| Full suite | mortality 55 + market 27 + plugin 36 + integration 21 + security 41 + research 9 = **189/189 pass**; `scripts/verify-fixes.mjs` 18/18 |
| Scheduling safety | `research.maxRunsPerCycle` (default 3) caps LLM work per trading cycle so an hourly batch can never stall order placement for minutes; `staggerSec` (120 for 30 agents) spreads the hourly load |
| Cost | `$0.001` per successful briefing charged to that agent's ledger; malformed/failed replies are free. Treasury burn formula intentionally unchanged (research is an actual ledger charge, not modelled burn) |

**Not yet verified:** the live Harness-LLM bridge against real model calls (needs the app restart
that loads the new Host `index.js`) and therefore real briefings appearing in the panel; the paper
loop is running the previous Host code until restart.

### Live research bridge — first real dispatch defect, found and fixed (2026-10-26)

After the restart that loaded the research sidecar, the engine reported
`engine.research.configured:true, provider:deepseek-account, model:deepseek-flash, errors:1` with
`lastError: "llm: deepseek-account/deepseek-flash: prepared LLM call config changed before adapter
dispatch"` and zero briefings. Cause (read from the installed `@deepseek-ai/dsh-llm` bundle): the
Host `prepareCall(config)` returns a frozen, fully resolved call config (adapter defaults such as
`reasoningEffort` are materialised at preparation time), and `prepared.stream(options)` rejects any
options that do not compare equal field-by-field to that config (`INVALID_PREPARED_CALL`). The
bridge re-sent only `{provider, model, maxTokens, temperature}`, so every dispatch was rejected
**before any provider request** (no tokens spent); trading was unaffected.

Fix: the bridge spreads `prepared.config` into the stream options and adds only the `system` /
`messages` prompt fields the equality check ignores. Regression test: the fake Host `llm` in
`test/plugin.test.js` materialises an adapter default (`reasoningEffort: high`) and asserts the exact
frozen config is echoed back (plugin 36/36). Research output budget raised 700 → 1200 tokens so a
reasoning model cannot consume the whole budget and return empty content. Research 9/9, full suite
189 green. One more Host restart loads the corrected bridge; the real provider dispatch is then
re-verified live.

**Decision recorded:** Alpaca news outages return an empty feed at the broker adapter (advisory
data must never break a cycle); real LLM failures are logged by the researcher and never charged.

### Research sidecar LIVE verification + hardening (2026-10-26, after restart)

After the restart that loaded the corrected bridge, the sidecar ran real LLM calls against the
Harness `llm` service (provider `deepseek-account`, model `deepseek-flash`):

- **5 briefings** in the first two cycles (max 3 per cycle), each persisted per agent with the real
  news it read (e.g. NVDA: Meta $145B capex, Honeywell+NVIDIA launch; AAPL: iPad mini OLED, foldable
  sold out, Jefferies note), `verdict` HOLD/AVOID, `sentiment` -0.55..0.3, `confidence`, `catalysts`,
  `risks`, linked `sources`, real token usage (~2.1–2.4k tokens) and **$0.001 charged to the acting
  agent** (`category: research`, `role: prospector`). `GET /automaton/state` exposed the briefings on
  5 agent rows (age/stale/verdict/sentiment/sources) for the dashboard.
- **LLM reply quality:** 4/5 valid JSON, 1 malformed (truncated array) → the agent stayed due and
  would be retried next cycle. Hardened: `extractJsonObject` now repairs fences / smart quotes /
  trailing commas / unterminated strings and containers, and the researcher retries **exactly once**
  with a "reply with one compact valid JSON object" instruction before counting a failure (no charge
  on failure). Research was also moved **after** the executor pass so a slow provider batch (~50 s
  for 3 calls) can never delay entries/exits; briefings apply on the next cycle and stay fresh 2 h.
- **Second real defect found live:** the external Reaper saved `registry.json`/`ledger.json`
  unconditionally every 30 s even when it killed nobody. It reloads at sweep start, so a sweep could
  overwrite the engine's newer write — observed: **3 of 5 research charges vanished from disk** (the
  broker position was intact). Fix: the Reaper now persists **only when a sweep actually killed an
  agent**; the engine is the primary writer. The running Reaper process predates the fix, so one more
  app restart + `Start` (which spawns a fresh Reaper) activates it;
  `scripts/reconcile-research-charges.mjs` (idempotent, run while the loop is stopped) re-books any
  briefing charge missing from the ledger.
- **Tests:** plugin 36/36 (bridge + prepared-config echo + provider/model), research **12/12**
  (repair, retry-once, give-up-no-charge, isolation, scheduling, charge, stale), market 27/27,
  mortality 55/55, integration 21/21, security 41/41 = **192 tests**; research smoke 10/10;
  verify-fixes 18/18. Committed locally; full-session live verification continues after the next
  restart.

### Research gate 100%-veto incident — "plugin not doing much" (2026-10-28)

User asked why the population barely trades. Diagnosis from the live trace/journal dataset:

- The loop was healthy (465 ticks, Reaper pid 27976 heartbeat v2, 0 engine errors, reconciliation ok)
  but only **4 broker orders** had ever been placed, all on the first session (Monday 2026-10-26).
- Trace aggregation over the last three days: **328 `research_veto` skips** versus 2 entries.
- Journal analysis over **1,025 briefings**: 819 HOLD / 206 AVOID, average **3.72 risks** per
  briefing, and **1,024/1,025 (99.9%) carried `risks >= 2`**. The executor vetoed any briefing with
  `risks >= 2`, so research blocked essentially **every entry** whenever a fresh briefing existed.
  Overnight cycles additionally hit the expected `MARKET_CLOSED` brake (236).
- Secondary issue: the DeepSeek API balance ran out (last successful briefing 2026-10-28T02:45Z;
  **206 `Insufficient Balance` errors**), so the analyst is currently paused by stale-freshness and
  would stop vetoing — but the gate still needed fixing before a top-up.

Fixes (committed, requires Host restart to activate):

1. **Veto thresholds softened and made configurable:** veto only on an explicit `AVOID`/`ALERT`
   verdict or `sentiment <= vetoSentiment` (-0.6); a long risk list no longer vetoes — it multiplies
   the order size by `riskPenalty` (0.6) instead. `exitSentiment` (-0.5) still drives
   `research_alert` exits; `vetoMinRisks` (5) is effectively unreachable with the 4-risk schema cap.
2. **Provider-error backoff:** LLM/news failures pause further attempts for `errorCooldownSec`
   (900 s; one hour for fatal errors such as an exhausted balance), so the engine stops retrying the
   API every cycle. Successful briefings clear the pause. Stale briefings are ignored by the
   executor, so trading keeps baseline behaviour while paused.
3. New knobs live in `research` config (`vetoSentiment`, `exitSentiment`, `vetoMinRisks`,
   `riskPenalty`, `errorCooldownSec`) with validation + focused tests (market 27/27, research 13/13).

Remaining operator actions: top up the DeepSeek balance (or run research in shadow / disabled until
then) and restart the Harness app (Host modules are ESM-cached), then Start. Expected effect: entries
are no longer mass-vetoed; the first live `research_veto`/`research_alert` should now be a genuine
signal rather than a schema artefact.

### Operator control panel: research cadence, leaderboards, rewards, richer agent detail (2026-10-29)

User request: set the research interval from the UI (1h/3h/6h/24h, before/after market close),
explain each agent's strategy + plan/next step + order/transaction records in its detail page, add
daily/weekly/monthly bot rankings, and a rewards panel where the top 3 get +5%/+3%/+2% of the
account's cash (configurable interval and amounts). Contract: `docs/CONTROL-PANEL.md`.

| Area | Implemented + verified |
|---|---|
| Research cadence | `research.scheduleMode` = interval / pre-open / post-close / pre-open+post-close (± configurable minute offsets); `intervalSec` options 1h/3h/6h/24h; per-agent staggering kept; event windows derive from the live broker clock (close-transition detection for post-close). Live `reconfigure()` (no restart) + persisted operator overlay `automaton-data/settings.json`. Tests: interval due-once, pre-open window, post-close window served once, live reconfigure, overlay persistence + rollback on invalid values. |
| Settings controls | `POST /automaton/control` actions `set-research-settings` and `set-reward-settings` (loopback-only, allow-listed modes/intervals/periods/percentages, unknown keys rejected, 400 `INVALID_SETTINGS`, old engine 501). Engine validates the same allow-list and writes the overlay before applying live. No new agent tools (still 10). |
| Leaderboards | `src/rankings.js`: UTC daily / ISO-week / UTC-month baselines (start-of-period return, previous close carried), sorted by P&L% → P&L$ → name, missing baselines last, persisted `rankings.json`; status `rankings.periods` + per-agent `rankings`/`pnl`. Tests: 16 (period keys incl. ISO edge cases, baselines/rollover, sorting/ties, missing baseline, persistence/corruption). |
| Rewards | `src/rewards.js`: top-3 of the completed period; amounts = rankPercents × **broker account cash** (defaults 5/3/2%), proportionally scaled down by treasury pool / allocation-cap remaining / maxPerPeriodUsd, floored to cents; virtual `ledger.transfer('__treasury__'→agent)` only (no broker transfer surface), once-per-period (persisted anchor), history 50, `rewards.json`; status includes last winners/history/next boundary/cash/pool/cap. Tests: 16 (default payout, caps/scaling, once-per-period, skipped, null P&L, weekly/monthly, history reload, disabled, reconfigure). |
| Period-boundary wiring | Boundary tick ranks the **completed** period before recording the new baseline (uses `rankings.compute({atMs: periodKeyEndMs-1, stored:true})`), pays, then records; engine refresh writes the snapshot so the panel sees live settings changes immediately. Integration test asserts payout at a simulated day boundary, cap binding, leaderboard refresh, fresh cash/equity after the mid-tick payout, and no double payout on the next tick. |
| Agent detail | `src/strategy-explain.js` derives (from genome/spec + virtual book + last prices) a strategy summary, exact entry rule per family (momentum/meanrev/breakout/gapfade), exit rules (signal/stop/target/time/research), risk rule, plan + **next step**, trigger grid, current position plan (stop/target/bars held/max), next research time, research verdict; status adds full `orders` fill history and `pnl` per agent. Tests: plan shape for every agent, transactions array, plan/triggers/position/empty-state mappings in the plugin suite. |
| Full suite | mortality 55 + market 27 + plugin 40 + integration 21 + security 41 + research 13 + rankings 16 + control 7 = **220/220 pass**; `research-smoke` 10/10; `verify-fixes` 18/18. |

**Safety invariants preserved:** rewards are virtual bookkeeping (`sum(agent equity) + pool` constant;
reconciliation unaffected), the broker client still has no transfer/withdraw methods, all orders
still pass the 14 brakes, settings actions are operator-only loopback routes (never agent tools), and
reward/settings changes are validated + persisted before applying.

**Live state at delivery:** current Host process still runs the previous engine build, so the panel
shows the new controls with empty/optional states; a Host restart loads the new engine + panel and is
required for live cadence/rewards/leaderboards. Research LLM calls remain paused while the DeepSeek
account balance is exhausted (a separate operator top-up; stale briefings are ignored by trading).

---

## 9. v3.0 multi-instrument paper trading — independent verification (2026-10-30)

Task-17. Scope: `test/integration.test.js`, `test/security.test.js`, this document (no `src/**` edits;
the verifier read `docs/INSTRUMENTS.md`, `docs/RUNBOOK.md` §8d and the landed v3 code, then attacked
the real composition — real brakes + real executor + real treasurer/reaper against the **sim broker**
and a fixed clock — not the builders' fake-brake/fake-broker harnesses).

### 9.1 Reproduce (all suites run directly; the sandbox blocks `node --test` with spawn EPERM)

```powershell
cd D:\CounterStikers\packages\automaton-trading
node test/mortality.test.js    # 70
node test/market.test.js       # 43
node test/research.test.js     # 13
node test/rankings.test.js     # 16
node test/control.test.js      # 16
node test/instruments.test.js  # 7
node test/plugin.test.js       # 42
node test/bot-agent.test.js    # 8
node test/integration.test.js  # 34  (verifier-owned; +13 v3 tests)
node test/security.test.js     # 53  (verifier-owned; +6 v3 tests)

cd D:\CounterStikers
node scripts/verify-fixes.mjs  # 17/17 PASS
```

The already-installed Harness plugin process still caches the old ESM modules until the app is
restarted; those fresh Node processes are the authoritative test of the v3 code, and the live GUI may
serve the pre-v3 build until a restart.

### 9.2 Results (fresh runs, 2026-10-30; every process exit code 0)

| Suite | Tests | Pass | Fail | TODO | wall |
|---|---:|---:|---:|---:|---:|
| mortality.test.js | 70 | 70 | 0 | 0 | 0.41 s |
| market.test.js | 43 | 43 | 0 | 0 | 0.26 s |
| research.test.js | 13 | 13 | 0 | 0 | 0.22 s |
| rankings.test.js | 16 | 16 | 0 | 0 | 0.27 s |
| control.test.js | 16 | 16 | 0 | 0 | 0.59 s |
| instruments.test.js | 7 | 7 | 0 | 0 | 0.07 s |
| plugin.test.js | 42 | 42 | 0 | 0 | 0.92 s |
| bot-agent.test.js | 8 | 8 | 0 | 0 | 0.17 s |
| **integration.test.js (verifier)** | **34** | **34** | 0 | 0 | 0.90 s |
| **security.test.js (verifier)** | **53** | **53** | 0 | 0 | 0.45 s |
| **Total** | **302** | **302** | **0** | **0** | ~4 s |

`scripts/verify-fixes.mjs`: **17/17 PASS** (re-run by the verifier).

v3 verifier integration tests: sim broker v3 surface (assets/chain/quotes/short/option positions);
short-stock round trip through executor+real brakes (open/mark/cover/realized); long-call round trip
through executor (multiplier 100, premium flow, realized; D-V3-1 regression); covered call (real brakes
deny without 100 shares, allow with, executor sells premium against held shares); D15-D18 in real
context (naked options, non-shortable/fractional/oversized shorts, mixed-expiry spreads, defined-risk
debit spread with reported `maxLossUsd`, DTE open guard + sell-to-close, margin cap); all four verticals
open/close as one mleg each (`groupId`, two legs, defined width, realized P&L); margin within cap
(negative cash) and cap denial without money creation; DTE auto-close through the executor; treasurer
option marks/reconciliation coherent (D-V3-2 regression); multi-instrument death (short + long call +
both spread legs liquidated, residual settled, schema-valid obituary, idempotent second sweep);
orchestrator status (`engine.instruments` caps/structures/playbooks/account facts, per-agent
`instrumentPermissions`/`playbook`, SHORT and CALL positions with strike/expiry/multiplier); paper
default + `instruments.enabled=false` long-only fallback + live gate on v3 instruments; kill switch
blocks short/option/spread orders too.

v3 verifier security tests: config rejects naked short options and unsafe instrument limits
(allowNakedShortOptions true, maxDTE < minDTE, autoCloseDTE > minDTE, unknown feed, maxContracts 0) both
via `validateConfig` and `loadConfig`; option/spread symbols cannot bypass the **underlying** whitelist
(D4); ledger margin invariants (no margin permission → `MARGIN_LIMIT`; over-cap refused with no cash /
position / pool change; allowed borrowing produces margin debt = −cash and equity unchanged); ledger
invariants after short/option/margin fills (`equity = cash + Σ signed marks`, closings at the same marks
return exactly the starting equity, `pool.totalUsd` unchanged → no money creation); the live-mode gate
applies to v3 instruments (paper-config live claim → `MODE_FORBIDDEN`; live config without `LIVE_ARMED`
→ `LIVE_NOT_ARMED` for short and option orders); the v3 broker additions expose no money-movement
methods (`getAsset`/`getOptionChain`/`getOptionQuote` only) and v3 `status.engine.instruments` stays
secret-free through the tools and `/automaton/state`.

### 9.3 Defects found by this verification (all fixed and regression-tested)

| # | Sev | Defect (pre-fix) | Fix location | Regression evidence |
|---|-----|------------------|--------------|---------------------|
| D-V3-1 | **HIGH** | Every single-leg option order sent the **underlying** as `order.symbol` to the brake wall, so D16 denied all long calls/puts, covered-call entries and **all option exits** (incl. DTE auto-close) with `OPTION_FORBIDDEN: symbol "META" is not a valid OCC option symbol`. Options could not trade at all through the engine. | `src/executor.js:1414-1418` (`symbol: isMultiLeg ? displaySymbol : isOptionOrder ? ticker : displaySymbol`) | integration *long-call round trip…* and *covered call…*; the option order now reaches the broker as `assetClass:'us_option'` with the OCC symbol |
| D-V3-2 | **HIGH** | `treasurer.marksFromPositions()` marked option positions as `marketValue / qty` without dividing by the option multiplier while `ledger.equity` multiplies again → option equity **100×**, reconciliation delta ≈ −$46k and `halted: reconciliation_mismatch` on every cycle holding an option. | `src/treasurer.js:202-213` (mark = \|marketValue\| / (\|qtySigned\| × multiplier); option multiplier default 100) | integration *an option position does not corrupt the Treasurer…*; view equity stays ≈$5k, delta ≈ 0, positionsValue < $1000 |
| D-V3-3 | **MEDIUM (sim fidelity)** | `broker-sim.optionPremiumUsd()` added `spot × moneyness × 0.10` to time value, so further-OTM contracts were priced **higher** than nearer ones; every vertical netted the wrong way and `executor.buildOptionPlan` returned `null` for all four spread structures (no defined-risk spread could open in sim). | `src/broker-sim.js:141-148` (time value decays with OTM distance: `atmTimeValue × exp(-4 × otmDistance)`) | integration *all four defined-risk verticals open and close…*; each opens one mleg order and closes cleanly |

Repro used before the fixes (kept for the record): real `createBrakes`+`createExecutor`, $5,000 sim
account, bullish/bearish momentum bars, `policy {instrument:{prefer:'long_call'}}` → denied
`OPTION_FORBIDDEN`; one META call held via broker+ledger then `treasurer.tick()` → view equity $51,323
vs $5,000, delta −46,332, halted; `getOptionChain({underlying:'META'})` → calls increasing in premium
with strike above spot.

### 9.4 Remaining gaps (explicit — NOT verified)

1. **No live paper option/short/margin fills were placed.** Every broker interaction in these tests is
   the deterministic sim broker or a stubbed `fetch`; no Alpaca paper order for an option, mleg spread,
   short sale or margin debit was submitted (no network/keys in the verification environment). The
   vendor payload mapping is covered by `market.test.js` with a stubbed fetch, not by a real fill. The
   account facts in `docs/INSTRUMENTS.md` (options level 3, shorting enabled, margin ×4) came from the
   operator's earlier probe, not from this run.
2. **Panel rendering is not browser-verified.** The verifier checked the HTTP/tool JSON
   (`/automaton/state`, `automaton_status`) and the client slot-registration tests; no browser rendered
   the LONG/SHORT/CALL/PUT badges, strike/expiry/DTE columns or the margin-debt row.
3. **Assignment / early exercise / expiry settlement are not modelled.** Covered calls and spreads rely
   on the DTE guard (`autoCloseDTE`) and sell/buy-to-close orders; there is no assignment simulation, no
   early exercise, no pin risk, no dividend/interest/borrow-fee accounting. The DTE auto-close test is
   synthetic.
4. **The sim option market is a deterministic stand-in.** Immediate full fills, only two synthetic
   expiries, synthetic premiums and 2% bid/ask; no partial fills, no real NBBO, no option
   commissions/regulatory fees (the live broker adapter maps the real payloads but was not exercised
   against the vendor here).
5. **Margin call / maintenance-margin waterfall is not simulated.** Caps (`maxMarginPctEquity`,
   `maxMarginUsd`, mandate cap) are enforced at order time and in the ledger; intraday maintenance
   margin, forced liquidation and broker margin-call behavior are outside these tests. Short-sale
   locate/HTB availability is just the static `asset.shortable/marginable` metadata.
6. **Multi-day population behavior with options/shorts is untested.** The suites run seconds of simulated
   time; no gen-3 survival comparison, no long-horizon option-overfit study, no journal growth/performance
   under a full v3 population.
7. **Real external-Reaper-vs-Alpaca-paper run:** the Reaper's multi-instrument liquidation, persistence
   and idempotence are verified against the sim broker and fresh state instances; the detached process
   against the real paper account was not exercised (needs keys + open market).
8. **Live Harness module cache:** the running plugin process serves the previous (pre-v3) build until a
   restart; the operator-visible panel/tools may not reflect v3 code until then. The fresh-process suite
   runs above are authoritative for the workspace code.

### 9.5 Verdict (v3.0)

The multi-instrument expansion is real and walled, not a config-only claim: short stock round-trips
through the real executor and brakes with signed ledger positions and realized P&L; long calls trade with
multiplier-100 premium cash flow; covered calls are denied without 100 long shares and permitted (and
premium-credited) with them; all four defined-risk verticals open and close as single `mleg` orders with a
shared `groupId` and a defined max loss; margin allows capped negative cash and refuses over-cap debt in
both the ledger and D17; DTE opens below `minDTE` are denied and held options auto-close through the
executor; the Reaper liquidates a mixed short/option/spread estate, settles it and writes a schema-valid
obituary exactly once; and the Treasurer's option marks/reconciliation are coherent. Three real defects
(one of which made every option order impossible, one of which would have halted the population whenever
an option was held) were found, reported with file:line + repro, fixed, and re-verified here; two of the
three would have been invisible to the builders' fake-brake harnesses. The remaining risk is
environmental: no live paper option fills, no assignment/early-exercise modelling, and no browser-verified
panel. **Verified as a paper/sim capability expansion with a hard brake wall; live/realmoney option
behavior remains unverified.**

---

## 10. v3.2 multi-symbol portfolio bots, 70/30 mix and live analytics — independent verification (2026-11-09)

Task-22. Scope: `test/integration.test.js`, `test/security.test.js`, this document (no `src/**` or other
test-suite edits). Read `docs/PORTFOLIO-ANALYTICS.md`, the README v3.2 section and `docs/RUNBOOK.md` §8f,
then the landed code (`orchestrator` genesis/migrations/ensureSpecs/executor wiring/status, `registry`
basket fields, `executor` portfolio mode, `broker-*` `getSnapshots`, `engine.marketView`, `index.js`
`/automaton/market`, registry/strategy-types helpers) and probed the real composition with deterministic
sim worlds before writing tests.

The Lead's v3.2 integration edits were reviewed and are **kept (not weakened)**: mleg orders carry their
side on the legs rather than a top-level side, OCC option symbols are matched with a 21+ char shape and
D4 whitelisting uses the OCC UNDERLYING, and the one-mutation audit was extended so that a changed
`symbol` plus the derived `symbols` reorder counts as ONE logical mutation with a child-basket-size
assertion. The verifier additionally added an engine-level basket-trade test and a marker-present
50/50→70/30 mix-change test.

### 10.1 Reproduce

```powershell
cd D:\CounterStikers\packages\automaton-trading
node test/mortality.test.js    # 76
node test/market.test.js       # 50
node test/research.test.js     # 13
node test/rankings.test.js     # 16
node test/control.test.js      # 18
node test/instruments.test.js  # 7
node test/plugin.test.js       # 46
node test/bot-agent.test.js    # 9
node test/integration.test.js  # 53  (verifier-owned; 34 v3.0/v3.1 + 19 v3.2)
node test/security.test.js     # 58  (verifier-owned; 53 + 5 v3.2)

cd D:\CounterStikers
node scripts/verify-fixes.mjs  # 17/17 PASS
node scripts/research-smoke.mjs # 10/10 PASS
```

`node --test` still hits the sandbox spawn EPERM; run each file directly. The installed Harness plugin
process caches the old ESM modules until the app is restarted, so these fresh-process results are the
authoritative test of the workspace code.

Extra check — migration dry-run on a **copy of the real live paper state** (the live `automaton-data`
directory was read-only; only `config.json`, `registry.json`, `ledger.json`, `day-stats.json`,
`deaths.json`, `treasury.json` were copied to an OS temp dir and booted with the v3.2 code in `mode:"sim"`
against the sim broker, so no Alpaca request and no write to live state): 30 alive agents in a legacy
50/50 mix (families 8/7/8/7) migrated to **21 day / 9 swing**, basket sizes **{day:{4:21}, swing:{3:9}}**,
all 30 ids preserved, all legacy `specId`/`specIds` cleared, `portfolio-v32.json`
`{version:1, changed:30}` written, target `dayPct 0.7`. This is the exact state the operator will get
after restarting the Host.

### 10.2 Results (fresh runs, every process exit code 0)

| Suite | Tests | Pass | Fail | TODO |
|---|---:|---:|---:|---:|
| mortality.test.js | 76 | 76 | 0 | 0 |
| market.test.js | 50 | 50 | 0 | 0 |
| research.test.js | 13 | 13 | 0 | 0 |
| rankings.test.js | 16 | 16 | 0 | 0 |
| control.test.js | 18 | 18 | 0 | 0 |
| instruments.test.js | 7 | 7 | 0 | 0 |
| plugin.test.js | 46 | 46 | 0 | 0 |
| bot-agent.test.js | 9 | 9 | 0 | 0 |
| **integration.test.js (verifier)** | **53** | **53** | 0 | 0 |
| **security.test.js (verifier)** | **58** | **58** | 0 | 0 |
| **Total** | **346** | **346** | **0** | **0** |

v3.2 verifier integration tests: fresh 70/30 genesis (21 day / 9 swing, families 5/4/11/10, 4/3-symbol
baskets, unique primary strategy pairs, unique baskets, `portfolio-v32.json` marker, status
`engine.portfolio` and `strategyMix.target {dayPct:.7,dayCount:21,swingCount:9}`, $50 ledger grants);
pre-v3.2 50/50 population migration (ids/endowment/cash/equity preserved per agent, families/tiers
rebalanced to 70/30, baskets re-derived to 4/3, legacy `specId`/`specIds` cleared, marker written,
second boot idempotent); 50/50→70/30 mix change on an already-migrated v3.2 state (marker present)
re-derives baskets without rewriting the marker; replication basket inheritance across 13 RNG seeds
(child keeps parent basket size, `symbol` mutation replaces the primary slot / moves an inherited symbol
to the front, only one MUTABLE field changes and only `symbols` may co-vary, tier follows the mutated
family, child endowment from parent cash); multi-symbol executor entries across basket symbols with
one order per symbol, shared per-cycle cap, per-symbol stop exits with no cross-symbol corruption, tier
`maxOpenPositions` cap, exit/entry shared order budget, kill-switch brakes-first denial of every basket
order and recovery after removal, legacy single-`spec` mode unchanged (one entry symbol, one exit per
run, all held positions managed over runs), options still opening through the real brake wall in
basket mode; end-to-end engine trading only basket symbols (7 fills across 3 basket symbols in 15 sim
cycles, zero out-of-basket fill/action symbols, every held position's underlying inside its bot basket);
status coherence (`engine.portfolio`, `strategyMix.target`, per-agent `symbols`/`tier`/`specs`/`specIds`/
primary `spec`, build traces carrying basket+spec lists); restricted paper account effective-capability
gating (permissions remain, `effective.shortStock/margin/creditOptions` false, credit structures
removed) while long calls remain; `engine.marketView` full shape (14 quotes, 14 sparklines, portfolio,
agents with baskets, equity history, engine block), 2 s cache, no credential-shaped text, no trading,
last-good-view+error fallback on broker clock/snapshot/bars failures, `{ok:false,error}` instead of a
throw when the broker cannot be constructed, and stopped/never-started engines still serving status and
market views; halted recovery (broker_unavailable halt visible in trace/status and cleared by the next
successful tick, no auto-reward) and CRITICAL treasury not permanently halting trading (budget 0.01 ->
funding -> STABLE 0.08, no deaths).

v3.2 verifier security tests: `/automaton/market` route registration beside `/automaton/state` and
`/automaton/control`; loopback 200 with `route`/`loopbackOnly`/`mode` fields and analytics payload;
secret-named fields injected into the view are redacted to `***` and never appear raw in the body;
remote and address-less requests get 403 (`FORBIDDEN`, fail-closed); POST gets 405
(`METHOD_NOT_ALLOWED`); HEAD 200 bodyless; structured 503 for an engine without `marketView`,
`marketView()` returning undefined, returning `ok:false`, or throwing (the 503 body scrubs
credential-shaped text); registry basket/specIds sanitization (uppercase, dedupe, ticker pattern,
8-symbol cap, legacy `genome.symbols` fallback, sanitized values persisted through reload); no new
agent tools (still exactly 10, no market/portfolio/basket/snapshot tool) and no new broker surface
(`getSnapshots` is a read; no transfer/withdraw/ACH/account-config methods on either broker).

### 10.3 Defects found by this verification (all fixed and regression-tested)

| # | Sev | Defect (pre-fix) | Fix location | Regression evidence |
|---|-----|------------------|--------------|---------------------|
| D-V32-1 | MEDIUM | The replicator's `symbol` mutation APPENDED the new symbol to the inherited basket, growing a 4-symbol day basket to 5 (and a 3-symbol swing basket to 4); the child no longer matched `portfolio.basketSize*`, and the genome diff showed `symbol`+`symbols` for one logical mutation. | `src/replicator.js` basket assembly (primary slot replaced / inherited symbol moved to the front; size preserved) | integration *replicator: child inherits the parent basket…*; seeds 0-12 including the `symbol` mutation keep size and one logical mutation |
| D-V32-2 | MEDIUM | `rebalanceStrategyMix()` reassigned families/tiers but left `genome.symbols`/`agent.symbols` alone, and `assignBasketsV32()` is one-time (`portfolio-v32.json`); a later 50/50→70/30 mix change left 6 of 21 day bots with 3-symbol swing baskets. | `src/orchestrator.js:592-629` (re-derives `basketForAgent(config,index,newTier,primary)` and updates `symbols`/`genome.symbols` together) | integration *pre-v3.2 50/50 migration…* and *a 50/50 -> 70/30 mix change on an EXISTING v3.2 state…* (day sizes {4:21}, swing {3:9}, marker unchanged) |
| D-V32-3 | LOW | Genesis baskets were not unique: `start = index*3 % symbols.length` plus `primary = index % symbols.length` gave two same-tier bots whose index differed by the universe size the identical basket (26 unique/30 in a 30-bot 70/30 genesis), contrary to "every bot gets its own combination". | `src/orchestrator.js` basket rotation (stride 5 + per-lap offset) | integration *genesis gives every bot its own basket combination* (30 unique) |
| D-V32-4 | LOW/MEDIUM | `engine.marketView()` threw (`CONFIG_INVALID: missing Alpaca credentials`) when `makeBroker()` failed in paper/live without credentials — its construction sat outside the defensive try/catch, violating the "on broker failure return last good view + error (never throw 500)" contract (the Host route caught it, but direct callers did not). | `src/engine.js` marketView (broker construction + load/status wrapped; returns last good view + error or `{ok:false,error}`) | integration *marketView returns an error object instead of throwing when the broker cannot be constructed*; broker-error fallback test |
| D-V32-5 | MEDIUM (pre-existing v3.0) | With `instruments.enabled=false`, `resolveInstrumentPermissions` returned `longStock:false`, so the executor's permission intersection denied EVERY stock entry (`instrument_not_permitted`) — the documented RUNBOOK §8d "v2 long-stock-only behaviour" was actually "no trading at all". | `src/instruments.js` resolveInstrumentPermissions (`longStock: true`; `enabled` gates only short/options/margin) | the v3.0/v3.1 integration option/gating tests plus this run's full suite; direct repro from the interim report now returns ALLOW |
| D-V32-6 | LOW (docs) | README.md pointed operators to `docs/RUNBOOK.md` §8f for v3.2, but RUNBOOK had no §8f and no v3.2 content (headings stopped at §8e/§10). | `docs/RUNBOOK.md` §8f added (multi-symbol/70-30/live feed/halt recovery) | route/ops docs reviewed; README reference resolves |

Repro used before the fixes: fresh 30-bot genesis (4 duplicate baskets); boot 50/50 then 70/30 on the
same state dir (basket sizes `{day:{3:6,4:15}}`); `createReplicator` with `mulberry32(7)` from a
4-symbol parent (child had 5 symbols); `createEngine({mode:'paper', no keys}).marketView()` rejected;
`instruments.enabled=false` + bullish bars executor run (`instrument_not_permitted`, 0 orders).

### 10.4 Remaining gaps (explicit — NOT verified)

1. **No live paper network activity.** Nothing in this round hit Alpaca: the market analytics endpoint
   is tested through the deterministic sim broker plus the documented `brokerFactory` test seam, and the
   Host route through a fake Cordis context. Real `GET /v2/stocks/snapshots` mapping is covered only by
   the stubbed-fetch market suite, not by a live paper request; the 2 s/15 s caches and the row shape are
   verified, the vendor payload is not.
2. **Browser/visual verification of the analytics dashboard was not performed.** The verifier verified
   the `/automaton/market` JSON, redaction and status semantics; the Google-Analytics-style panel
   (KPI cards, equity area chart, market tape flashes/sparklines, tabs, polling fallback) is covered by
   the plugin suite's pure-helper tests, not by a browser/screenshot. The installed Host also needs a
   restart before the new client bundle is served.
3. **No long-run population behaviour.** The engine-level basket trade test runs 15 sim cycles; no
   multi-day 70/30 survival/selection study, no long-horizon mix drift or basket-overlap effect on
   replication was measured.
4. **Assignment / early exercise / expiry settlement remain unmodelled** (carried over from v3.0): the
   covered-call/spread/DTE paths are close-order based, with no assignment simulation, pin risk,
   dividends, borrow fees or option commissions.
5. **Margin call / maintenance-margin waterfall and short-locate/HTB behaviour are not simulated**; the
   effective-capability gating test only proves the UI/status intersection with the account fields.
6. **Halted/degraded observability:** a `broker_unavailable` halt is visible as
   `halted`/`haltReasons` and clears on the next successful tick, but `state.engine.lastError` stays
   `null` during the outage (treasury degraded-tick errors are not copied into the engine error field).
   The Lead accepted this as a minor observability gap for a later pass.
7. **Docs/code detail mismatches (no behavioural effect):** `PORTFOLIO-ANALYTICS.md` §2 says
   `assignBasketsV32()` adds a registry note `basket-v32`; the code updates the basket/genome/spec
   fields but adds no such note. `README.md`'s "Status (this build)" count (322) predates the +19/+5
   verifier tests (now 346). Replication family mutations keep the inherited basket size by design, so a
   swing→day family mutation can leave a day bot with a 3-symbol basket until the next mix/basket
   migration — accepted inheritance semantics, not covered by a behavioural guard.
8. **Real external Reaper + live Host route:** the Reaper multi-instrument tests carry over from §9 and
   use the sim broker/fresh state instances; the live Host route was verified only as a handler with a
   fake Cordis ctx, not against the running `dsh web` server.
9. **The running Host process is still pre-v3.2:** the live `automaton-data` at verification time held 30
   alive agents in the old 50/50 mix (families 8/7/8/7), no `symbols`/baskets on any agent and no
   `portfolio-v32.json` marker; only a restart loads the new modules and runs the migration. The
   dry-run above proves a copy of that state migrates correctly, but the live process itself (and its
   analytics panel/market feed) has not yet executed the v3.2 code.

### 10.5 Verdict (v3.2)

The multi-symbol/70-30 release is real, not a presentation layer over the old single-symbol engine:
bots are seeded and migrated into 4/3-symbol baskets with unique primary strategies, the 70/30 day/swing
mix is generated and repaired on existing state (including a later mix change), the per-symbol specs are
compiled/persisted/plumbed through the executor, one bot demonstrably trades several basket symbols with
per-symbol exits and tier/order caps behind the real 18-brake wall, replication preserves the basket with
exactly one logical mutation, the status payload exposes baskets/specs/portfolio/mix targets, and
`engine.marketView` + the loopback `/automaton/market` route deliver a cached, secret-free analytics view
that degrades to last-known data on broker errors instead of throwing. Five behavioural defects found in
this round (basket-growing symbol mutation, stale basket sizes after a mix change, duplicate genesis
baskets, marketView throwing on broker-construction failure, and the pre-existing "instruments disabled
= no long stock" bug) were fixed and re-verified; a sixth (missing RUNBOOK §8f) is a docs fix. The
remaining risk is environmental/visual: no live paper market-data or option fills, no browser-rendered
dashboard verification, no long-run population study, and no assignment/margin-call modelling.
**Verified as a paper/sim multi-symbol capability with a real 70/30 mix and a read-only analytics feed;
live vendor behavior and the visual dashboard remain unverified.**

---

## 11. v3.3 fair P&L + capital-only performance rewards — independent verification (2026-11-22)

Verifier: independent verifier teammate (`verifier-v33`), not an author of any module under test.
Contract: `docs/FAIR-PNL-REWARDS.md` (read first). Host: Windows, Node **v22.18.0**, DSH file
sandbox `workspace-write`, **no network**, no Alpaca credentials installed. Scope: verifier wrote
**only** `test/integration.test.js`, `test/security.test.js` and this section; one behavioural defect
was reported to the Lead (with a minimal repro) and fixed by the Lead in `src/engine.js`; no other
module under test was edited by the verifier.

What v3.3 changes: **Trading P&L = equity − capital contributed** (`capitalContributionsUsd`), so
reward payouts are capital contributions, never profit; rewards are paid on measured weekly **trading
performance** (return on contributed capital), not equity; one-time idempotent migration
(`stateDir/capital-v33.json`) gives every legacy ledger record the exact fair basis (registry endowment
+ lifetime rewards from `rewards.json` history).

### 11.1 Reproduce

The sandbox blocks `node --test test/`, so every suite runs **directly** in a fresh Node process from
`D:\CounterStikers\packages\automaton-trading`:

```powershell
cd D:\CounterStikers\packages\automaton-trading

node test/integration.test.js    # verifier: v3.3 fair P&L, migration, rewards, payout, dayStats, status
node test/security.test.js       # verifier: v3.3 reward virtual-only surface, history whitelist, secrets
node test/mortality.test.js      # builder-owned
node test/market.test.js         # builder-owned
node test/plugin.test.js         # builder-owned (UI helpers; 49 green per builder)
node test/rankings.test.js       # builder-owned
node test/control.test.js        # builder-owned
node test/research.test.js       # builder-owned
node test/bot-agent.test.js      # builder-owned
node test/instruments.test.js    # builder-owned
```

Real-live-state migration dry run (temp copy of the REAL `automaton-data`, deterministic **sim**
broker, no network/credentials). Save as a throwaway file in the package root and delete afterwards:

```js
// packages/automaton-trading/.v33-dryrun.mjs   (throwaway; sim broker; no credentials)
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { loadConfig, statePaths } from './src/config.js';
import { createBroker } from './src/broker-sim.js';
import { createAutomaton } from './src/orchestrator.js';
const LIVE = 'D:\\CounterStikers\\automaton-data';
const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'v33-dryrun-'));
for (const f of ['config.json','settings.json','registry.json','ledger.json','rewards.json',
  'rankings.json','day-stats.json','state.json','treasury.json','deaths.json',
  'instruments-v3-symbols.json','portfolio-v32.json','automaton.config.json']) {
  if (fs.existsSync(path.join(LIVE, f))) fs.copyFileSync(path.join(LIVE, f), path.join(copy, f));
}
for (const d of ['specs','research','agents']) {
  if (fs.existsSync(path.join(LIVE, d))) fs.cpSync(path.join(LIVE, d), path.join(copy, d), { recursive: true });
}
const { config } = loadConfig({ cwd: copy, env: {}, configFile: path.join(copy, 'config.json'),
  overrides: { mode: 'sim', paths: { stateDir: copy, envFile: path.join(copy, '.env') } } });
const clock = { now: () => Date.UTC(2026, 10, 22, 15), iso: () => new Date(Date.UTC(2026, 10, 22, 15)).toISOString() };
const broker = createBroker(config, { seed: 7, accountEquityUsd: 100000, clock });
const a1 = await createAutomaton({ config, paths: statePaths(config), broker, clock }); await a1.init();
const gap = (await a1.status()).agents.find((row) => row.id === 'atm-483016bc');
console.log(JSON.stringify({ marker: JSON.parse(fs.readFileSync(path.join(copy, 'capital-v33.json'), 'utf8')),
  gapCapital: gap.capital.contributedUsd, gapReward: gap.capital.rewardCapitalUsd,
  gapTradingPnl: gap.tradingPnlUsd, rewardedAgents: (await a1.status()).engine.capitalAccounting.rewardedAgents,
  lifetime: (await a1.status()).engine.capitalAccounting.rewardsLifetimeTotalUsd }));
// idempotent restart (fresh instances, same state dir):
const a2 = await createAutomaton({ config, paths: statePaths(config),
  broker: createBroker(config, { seed: 7, accountEquityUsd: 100000, clock }), clock }); await a2.init();
const e2 = a2._internals.ledger.equity('atm-483016bc', {});
console.log(JSON.stringify({ secondInitCapital: e2.capitalContributionsUsd,
  secondInitReward: e2.rewardCapitalUsd, secondInitTradingPnl: e2.tradingPnlUsd }));
```

### 11.2 Results (fresh runs, 2026-11-22; all processes exit 0)

| suite | tests | pass | fail | notes |
|---|---:|---:|---:|---|
| `test/integration.test.js` (verifier) | **78** | **78** | 0 | 53 pre-existing + 25 new v3.3 tests (L1-L5 + 1 mandate-growth test) |
| `test/security.test.js` (verifier) | **63** | **63** | 0 | 58 pre-existing + 5 new v3.3 tests (§M reward surface, §N market view) |
| `test/mortality.test.js` | 88 | 88 | 0 | builder-owned, unchanged |
| `test/market.test.js` | 50 | 50 | 0 | builder-owned, unchanged |
| `test/plugin.test.js` | 49 | 49 | 0 | builder-owned UI suite, unchanged |
| `test/rankings.test.js` | 29 | 29 | 0 | builder-owned, unchanged |
| `test/control.test.js` | 18 | 18 | 0 | builder-owned, unchanged |
| `test/research.test.js` | 13 | 13 | 0 | builder-owned, unchanged |
| `test/bot-agent.test.js` | 9 | 9 | 0 | builder-owned, unchanged |
| `test/instruments.test.js` | 7 | 7 | 0 | builder-owned, unchanged |
| **total** | **404** | **404** | **0** | verifier additions only; no existing assertion weakened |

Runtimes on this host: integration ≈ 2.6 s, security ≈ 0.6 s. An independent throwaway probe pass over
ledger fairness (14 checks), rankings/rewards rules (22 checks), a scripted sim e2e payout world
(17 checks) and the real live-state migration dry run (13 checks) was also green.

Real-live-state migration dry-run output (the exact live state at verification time: 30 alive agents,
21/9 strategy mix, ledger declared-endowment $20 vs registry $50, W44/W45 rewards history):

```text
PASS migration marker capital-v33.json written version 2
PASS all 30 registry agents capitalVersion 2
PASS lifetime rewards W44/W45 = 129.18 across 6 agents
PASS GapFade META fair P&L: equity 106.86, capital 108.56, trading -1.70, reward 58.56
PASS non-reward agents: capital = registry endowment 50, reward 0
PASS cash/treasury/ids/fills/positions preserved (no money created by migration)
PASS pool total conserved by migration (reclassification only)
PASS persisted ledger records carry v3.3 capital fields
PASS status agents[] capital/pnl/rewards/tradingPnlUsd
PASS status engine.rewards rules/budget/lifetime + engine.capitalAccounting
PASS second init is idempotent: no double count, same fair P&L
PASS second init persists no duplicate capital-basis events
PASS marker loss alone does not double count (capitalVersion gate)
SUMMARY pass=13 fail=0
```

### 11.3 Verified behaviour (what the new tests prove)

1. **Ledger fairness (`src/ledger.js`).** `ensureAgent(endowment)+grant(endowment)` counts the basis
   once; a treasury→agent reward transfer raises cash, `capitalContributionsUsd` and
   `rewardCapitalUsd` by the same amount and leaves `tradingPnlUsd` exactly unchanged (also when the
   classification comes from a `/reward/i` reason without a category); an agent→treasury transfer is a
   capital withdrawal (reduces capital, never P&L); a realized fill profit moves only trading P&L and
   `tradingPnlPct` is a fraction (0.01 = +1%); `setCapitalBasis` is a cash-free, idempotent
   reclassification and later grants add capital to the migrated basis; `pool().totalUsd` is conserved
   (moved, never created); legacy persisted records without capital fields load as
   `capitalContributionsUsd = declaredEndowment + credits`, `rewardCapitalUsd = 0`,
   `capitalVersion = 1`.
2. **Real-state migration (`src/orchestrator.js`).** On the copied live state: 30/30 agents get
   `capitalVersion 2` with base = registry `$50` (the ledger's declared `$20` is not reused), exactly
   **$129.18** lifetime reward capital across the 6 historical winners, id/cash/fill/position survival,
   unchanged pool total, the contract's GapFade META example (`106.86 − 108.56 = −1.70`), a version-2
   marker, and idempotence: a second init does no migration and adds no capital-basis event; deleting
   the marker alone re-runs with `migrated: 0` and no double count (`capitalVersion` is the gate).
   `status.agents[].capital/pnl/rewards/tradingPnlUsd` and
   `engine.rewards.rules/budgetUsd/lifetimeTotalUsd` + `engine.capitalAccounting` match the contract,
   with fractions for `tradingPnlPct`/`pnl.tradingPct` and percent points (0..100) for
   `capital.rewardSharePct`.
3. **Rankings (`src/rankings.js`).** Period trading baseline/last, carry-forward into a new period and
   archived `previousBaseline/previousLast` all expose `tradingPnlUsd/tradingPnlPct` (fraction),
   `baselineCapitalUsd/baselineTradingPlUsd` and `periodTrades`; a completed period is still rankable
   after the boundary roll (`stored: true`); legacy equity-only observations produce `null` trading
   fields (never fabricated).
4. **Rewards (`src/rewards.js`).** Eligibility gates (no measured baseline, profit ≤ `$0.05`, return
   ≤ 0, `periodTrades` < 3, drawdown > 20%) all record a `skipped` payout with zero transfers; ranking
   is by period trading **return** (not dollars); budget = 10% of pool capped by `maxPerPeriodUsd`,
   allocation-cap remaining and the pool itself; top-3 **50/30/20**; per-agent **50% of contributed
   capital** cap; proportional scaling when shares over-allocate; cents floor; no pool → skip; one
   payout per periodKey (`already_applied` on replay); `lifetimeForAgent`/`historyForAgent` and the
   persisted history/lifetime map; new settings win and deprecated `rankPercents`/`account-cash` are
   mapped away (basis is always `trading-performance`).
5. **End-to-end payout (deterministic sim, zero burn, no orders between cycles).** Two real round-trip
   fills per agent (periodTrades = 4) across a weekly boundary produce a `$100` budget payout of
   **50/30/20** to the three ranked agents; each winner's equity and contributed/reward capital rise by
   exactly the payout, base capital and **trading P&L do not change at all**, the treasury pool total is
   conserved, a second tick in the new period does not pay again, a replay is rejected, the mandate /
   order-size budget grows by 50% of the paid capital while measured P&L stays trading-only, and the
   status contract above is served by a stopped (never trading) engine and by `marketView`.
6. **Day P&L / daily loss.** With `risk.maxDailyLossPct = 0.001`, a +$500 reward payout does **not**
   appear as a daily gain, a −$500 **capital withdrawal does not appear as a daily loss** (an
   equity-based rule would have killed the bot), while a real −$50 trading loss produces the
   `daily_loss_limit` verdict from the persisted trading day P&L and the sim demo Reaper executes it on
   the next cycle (obituary cause `daily_loss_limit`). Persisted day-stats carry
   `startTradingPlUsd`/`pnlUsd` trading-only.
7. **Reward risk gate.** A higher-period-return bot whose equity is reward-inflated is still rejected
   when its **trading** drawdown relative to contributed capital exceeds 20% (`riskByAgent.drawdownPct`
   = max(equity drawdown, trading loss / contributed capital)); the eligible bot is paid instead.
8. **Security (adversarial).** `rewards.js` imports no broker/network/child-process module and its only
   economy write is `ledger.transfer(TREASURY_ID, …)`; an adversarial ledger proxy proves a payout calls
   **only** `transfer` (category `reward`, reason `reward:<key>`) and that money is moved not created; a
   sim broker's `getAccount()` JSON is byte-identical before/after a payout (no broker/order/transfer
   surface); reward history is a documented field whitelist (persisted `apiSecret`/`credentials` junk is
   dropped by normalization and never reaches status/tools); `TOOL_NAMES` is still 10 with no
   reward/payout/transfer tool; `/automaton/market` (`GET`/`HEAD`, loopback) exposes the fair trading day
   P&L as a **fraction** and leaks no credential loaded from the env file.

### 11.4 Defects found in this round

1. **D-V33-1 (behavioural, fixed) — `engine.marketView().portfolio.dayPnlPct`/`tradingDayPnlPct` were
   100× too large.** `src/engine.js` computed `Math.round((dayPnlUsd / dayCapitalUsd) * 1000000) /
   10000`, i.e. percent points, while the v3.3 contract, per-agent `agents[].tradingDayPct` (rankings
   fraction) and the UI `pctPoints()` helper all expect a **fraction**. Repro: sim state with
   `tradingDayPnlUsd −28` over `$15,600` contributed capital returned `tradingDayPnlPct −0.1795`
   (i.e. −17.95 points) instead of `−0.001794`; the panel then rendered 100× for any |return| < 1%.
   Reported to the Lead with the expression and repro; fixed by the Lead in `src/engine.js`
   (`Math.round((dayPnlUsd / dayCapitalUsd) * 1000000) / 1000000`, both aliases) and re-verified by the
   new integration L4 + security §N regressions (fraction bound, alias equality, and
   `pct = usd / Σ contributed capital` to 1e-6).
2. **Docs (reported, fixed — no behavioural effect).** `docs/CONTROL-PANEL.md` contained stale v3.2
   snippets that contradicted the v3.3 rules in the same file: the `settings.json` example (lines
   ~20-27) used `rankPercents`/`basis:'account-cash'`, the `set-reward-settings` example (line ~50)
   listed only the old fields, the panel section described "three percentage inputs" with a
   "1st = 5% × cash" preview, and the "Tests" section said "default winners/amounts from cash". All of
   these were reported to the Lead and are **fixed** on the current tree (new `rankShares`/
   `rewardBudgetPctOfPool`/caps/min-profit/trades/drawdown fields; trading P&L vs equity; reward history;
   fair payout tests); only the historical 2026-10-29 request paragraph at the top still quotes the old
   5/3/2-of-cash idea as the original operator request. `docs/FAIR-PNL-REWARDS.md`, RUNBOOK §8g,
   ARCHITECTURE, README and CHANGELOG were already correct.

No other behavioural defect was found; the pre-existing suites were not modified and no assertion was
weakened.

### 11.5 Remaining gaps (explicit — NOT verified)

1. **Live Alpaca network behaviour is unverified** (no credentials/network in this session): the reward
   path is ledger-only by construction and no broker method is reachable from `rewards.js`, but the
   real paper account reconciliation after a live payout, and the real `/v2/stocks` data used to rank a
   live week, were not exercised.
2. **Browser/visual UI verification was not performed.** The builder reports the plugin suite 49/49
   green (re-run green here) and this round verified the JSON contract and percent scales it consumes,
   but the rendered Trading-P&L/Rewards columns, detail reward-history table and Rewards tab were not
   checked in a browser; the installed Host needs a restart to serve the v3.3 bundle and to run the live
   migration.
3. **The running Host has not executed the migration.** This round proves a **copy** of the live
   `automaton-data` migrates correctly and idempotently; the live process itself was not restarted, so
   the live state dir is (at verification time) still pre-v3.3. On the first v3.3 start the completed
   period will be ranked with pre-v3.3 equity-only baselines and correctly skipped
   (`no_measured_trading_baseline`); the first fair payout needs one period measured with trading
   baselines.
4. **No long-run population / reward-distribution study.** One weekly payout is verified end-to-end in
   a deterministic sim world; no multi-week compounding/selection effect of repeated 10%-of-pool
   payouts on population survival, drawdown or treasury runway was measured. The live profile also
   raises `account.allocationCapPct` 0.8 → 0.9 (documented risk increase in RUNBOOK §8g) which was not
   stress-tested against the reconciliation halt thresholds.
5. **The drawdown reward gate uses `max(equity drawdown vs endowment, trading loss / contributed
   capital)`** (per the Lead's fix). Its interaction with the Treasurer's own death thresholds was
   verified only for the constructed 20%-vs-contributed-capital case; the exact boundary where the gate
   and the death rules meet over many periods is not characterized.
6. **Assignment/early-exercise, margin-call waterfall, borrow/locate and option settlement remain
   unmodelled** (carried over from §9/§10); v3.3 changes no instrument math.
7. **Synthetic `__treasury__` ledger record** is not a registry agent and therefore stays
   `capitalVersion 1` after migration (contract §7 migrates registry agents only). It is never ranked,
   rewarded or exposed; its cash is counted only through `ledger.pool()`. Observation, not a defect.
8. **Payout measurement granularity.** The completed period is ranked from the last stored observation
   before the boundary (one tick cadence), so trades/P&L during the final partial tick interval are
   included at the next observation only; acceptable per the ranking design but not tested at sub-cycle
   granularity.

### 11.6 Verdict (v3.3)

The fair-P&L/capital-only-reward model is real and enforced end-to-end, not a UI relabel: the ledger
separates contributed capital from equity and rewards are classified as capital with exact conservation
and no P&L effect; rankings and the scheduler use measured period **trading return**; the real live
state migrates to the documented fair basis (30/30 agents, $129.18 lifetime, GapFade META −$1.70)
idempotently; payouts are 10%-of-pool, 50/30/20, capped, transfer-only virtual capital that raises
buying power/mandate size and never P&L; daily-loss/day-stats are trading-based (a reward or a capital
withdrawal cannot look like P&L); status/marketView expose the fair numbers with consistent fraction vs
percent-point scales; and the reward module adds no broker/transfer/order/tool surface and leaks no
secrets. One behavioural defect was found and fixed this round (D-V33-1, marketView portfolio percent
scale, 100×), and one documentation inconsistency was reported (builder-owned CONTROL-PANEL snippets).
**Verified as a paper/sim fair-P&L and performance-reward capability; live broker/UI visual behaviour,
the live-process migration and long-run reward effects remain unverified.**

---

## 12. v3.4 aggressive growth cohort, 50% annual target and the reconciliation-burn fix — independent verification (2026-11-23)

Verifier: independent verifier teammate (`verifier-v34`), not an author of any module under test.
Contract read first: `docs/AGGRESSIVE-GROWTH.md`. Host: Windows, Node **v22.18.0**, DSH file sandbox
`workspace-write`, **no network**, no Alpaca credentials used. Scope: verifier wrote **only**
`test/integration.test.js`, `test/security.test.js` and this section; **no `src/**`, `client.js`,
config or builder-owned test was edited by the verifier**. Five behavioural/contract defects were
reported to the Lead with minimal repros; the Lead fixed them in `src/orchestrator.js`,
`src/executor.js` and `docs/AGGRESSIVE-GROWTH.md` and froze the tree before the final runs.

What v3.4 changes: (a) the live paper engine had been halted since 2026-11-17 on
`reconciliation_mismatch` because the virtual ledger deducted ~$50.6 of metabolism costs the paper
broker never paid; reconciliation now adds `costsSinceAnchor()` to the expected virtual total without
minting capital or hiding fill gaps; (b) a deterministic day-first cohort (40% aggressive / 45%
balanced / 15% conservative) with larger baskets/position caps/order caps, scaled entry/size/stop/
target/hold parameters, a policy-size floor and stand-down conversion; (c) a one-time, pool-funded
aggressive **capital** top-up toward 1.35× base endowment, recorded as contributed capital, never P&L
or reward; (d) an informational 50%-annual-return target with baseline, required daily pace, annualized
trading return, progress and on-track flag; (e) a UI target card + profile badges/limits/activity and
the aggressive-capital (contributed) split.

### 12.1 Reproduce

The sandbox blocks `node --test test/`, so every suite runs **directly** in a fresh Node process from
`D:\CounterStikers\packages\automaton-trading`:

```powershell
cd D:\CounterStikers\packages\automaton-trading

node test/integration.test.js    # verifier: reconciliation fix, cohort, builder/executor profile, target/status
node test/security.test.js       # verifier: allowance cannot hide fills/mint, no new surface, brakes/secrets/reward fairness
node test/mortality.test.js      # builder-owned
node test/market.test.js         # builder-owned
node test/plugin.test.js         # builder-owned UI suite (52 green; also contains a live-copy recon dry run)
node test/rankings.test.js       # builder-owned
node test/control.test.js        # builder-owned
node test/research.test.js       # builder-owned
node test/bot-agent.test.js      # builder-owned
node test/instruments.test.js    # builder-owned
```

Real-live-state dry run (read-only copy of the REAL `automaton-data`; fake broker with the live
account equity; **no network/credentials**; the live files are only read/copied). Save as a throwaway
file in the package root, run, then delete:

```js
// packages/automaton-trading/.v34-dryrun.mjs  (throwaway; never writes automaton-data)
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { loadConfig, statePaths } from './src/config.js';
import { createAutomaton } from './src/orchestrator.js';
const REPO = path.resolve('.', '..', '..'); const LIVE = path.join(REPO, 'automaton-data');
const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'v34-dryrun-'));
for (const f of ['settings.json','registry.json','ledger.json','rewards.json','rankings.json',
  'day-stats.json','state.json','treasury.json','deaths.json','capital-v33.json','portfolio-v32.json',
  'instruments-v3-symbols.json']) if (fs.existsSync(path.join(LIVE,f))) fs.copyFileSync(path.join(LIVE,f), path.join(copy,f));
for (const d of ['specs','research','agents']) if (fs.existsSync(path.join(LIVE,d))) fs.cpSync(path.join(LIVE,d), path.join(copy,d), { recursive: true });
const { config } = loadConfig({ cwd: REPO, env: {}, configFile: path.join(REPO,'automaton.config.json'),
  overrides: { paths: { stateDir: copy, envFile: path.join(copy,'.env') } } });
const live = JSON.parse(fs.readFileSync(path.join(copy,'state.json'),'utf8'));
const equity = Number(live.account.equityUsd);
const broker = { async getAccount(){ return { equityUsd: equity, cashUsd: equity, status:'ACTIVE', marginMultiplier:1, shortingEnabled:false, optionsTradingLevel:3 }; },
  async getPositions(){ return []; }, async getClock(){ return { isOpen:true }; },
  async getBars(){ return {}; }, async getLatestQuote(){ return null; },
  async submitOrder(){ throw new Error('dry run must not order'); } };
const clock = { now: () => Date.now(), iso: () => new Date().toISOString() };
const a = await createAutomaton({ config, paths: statePaths(config), broker, clock }); await a.init();
const s1 = await a.status(); const t1 = await a.tick();
const treasury = a._internals.state.lastTreasury;
console.log(JSON.stringify({ counts: s1.engine.aggression.counts,
  aggressiveEndowments: s1.agents.filter(x=>x.aggression==='aggressive').map(x=>x.endowmentUsd).slice(0,3),
  aggressiveCapital: s1.agents.find(x=>x.aggression==='aggressive')?.capital.aggressiveCapitalUsd,
  halted: treasury.halted, reconciliation: treasury.reconciliation,
  legacyDelta: Math.round((treasury.account.equityUsd - (treasury.reconciliation.virtualTotalUsd - treasury.reconciliation.costsSinceAnchorUsd))*100)/100,
  performance: s1.engine.performance, pool: a._internals.ledger.pool() }, null, 1));
// idempotent restart: a second init on the same copy must not top up again
const a2 = await createAutomaton({ config, paths: statePaths(config), broker, clock }); await a2.init();
console.log(JSON.stringify({ secondInitPool: a2._internals.ledger.pool() }));
fs.rmSync(copy, { recursive: true, force: true });
```

### 12.2 Results (fresh runs, 2026-11-23, tree frozen at `orchestrator.js` 23:06; every process exit code 0)

| # | Suite | Tests | Pass | Fail | TODO | Notes |
|---|-------|------:|-----:|-----:|-----:|-------|
| 1 | `test/integration.test.js` (verifier) | **99** | **99** | 0 | 0 | 78 pre-existing + **21 new v3.4 tests** |
| 2 | `test/security.test.js` (verifier) | **71** | **71** | 0 | 0 | 63 pre-existing + **8 new v3.4 tests** |
| 3 | `test/mortality.test.js` | 91 | 91 | 0 | 0 | builder-owned (incl. its own live-copy recon test; may skip on a torn copy) |
| 4 | `test/market.test.js` | 56 | 56 | 0 | 0 | builder-owned |
| 5 | `test/plugin.test.js` | 52 | 52 | 0 | 0 | builder-owned UI/plugin suite |
| 6 | `test/rankings.test.js` | 29 | 29 | 0 | 0 | builder-owned |
| 7 | `test/control.test.js` | 19 | 19 | 0 | 0 | builder-owned |
| 8 | `test/research.test.js` | 13 | 13 | 0 | 0 | builder-owned |
| 9 | `test/bot-agent.test.js` | 9 | 9 | 0 | 0 | builder-owned |
| 10 | `test/instruments.test.js` | 7 | 7 | 0 | 0 | builder-owned |
| | **Total** | **446** | **446** | **0** | **0** | baseline was 417/417 before verifier additions |

Runtimes on this host: integration ≈ 3.0 s, security ≈ 0.7 s, plugin ≈ 0.9 s, mortality ≈ 0.7 s; all
ten processes exit 0. Verifier additions only: no existing assertion was weakened and no builder-owned
file was modified by the verifier.

Independent live-state dry-run result (**37/37 checks PASS**, read-only copy, live files untouched):

```text
PASS pre-migration halt reproduced (legacy delta > tolerance) :: legacy delta 50.62 vs tolerance 39.93
PASS costs since anchor ~= legacy delta (> 40) :: costs 50.85, legacy delta 50.62
PASS profile counts 12/13/5 :: {"aggressive":12,"balanced":13,"conservative":5}
PASS all 12 aggressive agents are day tier
PASS aggressive day baskets are 6 symbols; balanced day 4 / swing 3; conservative swing 2
PASS held agents keep their opening spec; entry basket follows the profile :: 10/10 held agents
PASS flat agents had their cached specs cleared :: 20/20
PASS aggressive top-up funded from treasury pool :: pool 370.82 -> 160.82, credited 210
PASS marker records per-agent allocations (12 x $17.50); endowments 50 -> 67.5; non-aggressive stay 50
PASS top-up counted as contributed capital (no reward capital) and created no trading P&L
PASS pool + allocated conserved across the top-up :: before 1945.94 after 1945.94
PASS top-up respected the allocation cap (allocated 1785.12 <= cap 1836.84)
PASS growth-v34 baseline recorded on first start (equity 1996.56)
PASS target math: 50% target, required daily pace 0.111148%/day, short-history nulls
PASS first tick clears the reconciliation halt
PASS reconciliation delta is inside tolerance after the cost add-back :: delta -0.24, tolerance 39.93, costs 50.86
PASS pre-fix expectation was short by exactly the costs since the anchor (50.62)
PASS conservation: virtualTotal + delta == broker equity (1996.80 - 0.24 = 1996.56)
PASS first tick: paper-mode no-death rule and no trading without hypotheses
PASS restart is idempotent (no second top-up, same profiles, markers not rewritten, same baseline)
PASS live registry/treasury files were never written by the dry run
SUMMARY pass=37 fail=0
```

Independently re-run probe for the five defects (13/13 checks PASS after the Lead's fixes) confirmed:
disabled aggression passes the operator `config.portfolio` limits + neutral executor profile and writes
no markers; enabling aggression later (even over an old `{skipped:true}` marker) migrates + tops up;
converted stand-down entries size at the 0.8 floor (not at the bot's 1.0); and a costs-only engine tick
calls no money-creating ledger operation.

### 12.3 Verified behaviour (what the new tests prove)

1. **Reconciliation root cause + fix (`src/ledger.js`, `src/treasurer.js`).** A virtual cost booked
   after the one-time anchor no longer halts: with a 0.0001% tolerance, $5 of synthetic metabolism
   costs pushed the pre-fix expectation (allocated + pool) $5 below broker equity — the old permanent
   halt — while `costsSinceAnchor()` puts the delta back inside tolerance. `reconciliation` exposes
   `deltaUsd`, `toleranceUsd`, `costsSinceAnchorUsd`, `virtualTotalUsd`, and the identity
   `broker equity = allocated + pool + costsSinceAnchor + delta` holds to the cent.
2. **Genuine fill mismatches still halt, symmetrically.** Broker equity offset by +$5 or −$5 with the
   same allowed-back costs produces `halted: true` with `reconciliation_mismatch` and a delta exposing
   exactly the fill (the allowance masks neither sign); a +$0.02 disagreement stays inside tolerance.
   An allowance of $5 does not hide a $5 fill mismatch.
3. **The allowance is reconciliation-only.** After costs: agent `capitalContributionsUsd`,
   `rewardCapitalUsd`, registry `endowmentUsd`, treasury pool and cash are unchanged except the booked
   charge itself; a costs-only tick calls no `grant`/`credit`/`transfer`; and a $1 allocation cap still
   halts with `allocation_cap` (the allowance never inflates allocated capital or the cap).
4. **Anchor baseline / legacy normalisation.** `anchorToBrokerEquity` captures `anchorCostsUsd` (costs
   booked before the anchor are not allowed back; post-anchor costs are), re-anchoring is a no-op,
   persisted baselines survive reload, a legacy anchored ledger without the field normalises to 0 so
   every recorded cost counts, and a baseline larger than booked costs clamps to 0 (never negative).
   The live state is exactly that legacy shape (`anchored` 2026-10-24, no `anchorCostsUsd`), which is
   why the add-back of all ~$50.8 works on the first post-restart tick.
5. **Real live-state copy dry run.** On a read-only copy of the actual `automaton-data` (30 alive agents,
   21/9 day/swing mix, 23 open positions, $1,996.56 broker equity implied by the live status): the
   legacy delta is $50.62 > $39.93 tolerance, matched by $50.85 of costs since the anchor; the first
   tick after the v3.4 migration reports `halted: false`, `deltaUsd −0.24`, `costsSinceAnchorUsd 50.86`
   (all inside tolerance). The live files were never opened for writing (verified by size/mtime and a
   temp-dir copy only).
6. **Cohort assignment/migration.** 30 agents → `{aggressive:12, balanced:13, conservative:5}`,
   deterministic and day-first (all 12 aggressive day; 9 balanced day + 4 balanced swing + 5
   conservative swing), baskets 6/4 aggressive, 4/3 balanced, 3/2 conservative; 5 agents → 2/2/1 with
   the aggressive cohort day-only. Aggression disabled keeps v3.3 balanced genomes and 4/3 baskets and
   writes no v3.4 markers; it passes the operator `config.portfolio` limits and a neutral executor
   profile. Profiles/funding are one-time markers (`aggression-v34.json`, `aggression-capital-v34.json`,
   `growth-v34.json`); restart and stale skipped markers are idempotent/no double top-up. Migration keeps
   held positions' opening `specId` (and their position) while the profile entry basket applies; flat
   agents lose the stale cached spec so the builder recompiles with profile multipliers.
7. **Aggressive capital funding.** The top-up ($17.50 × 12 = $210 toward 1.35 × $50 = $67.50 per
   aggressive bot) moves cash only from the unallocated treasury pool (`pool 370.82 → 160.82` on the
   live copy), respects the 92% allocation cap, never mints (pool + allocated conserved exactly), is
   recorded as a `v3.4 aggressive capital allocation` transfer (contributed capital), never reward
   capital and never P&L; accepted only for the aggressive cohort; the marker records per-agent
   allocations; `registry.endowmentUsd` becomes the funded basis. Status exposes
   `capital.aggressiveCapitalUsd` (17.5) so the UI can show the contributed amount.
8. **Builder/executor profile (`src/builder.js`, `src/executor.js`).** Builder applies entryZ ×0.70,
   sizePct ×1.35, stopPct ×0.80, targetPct ×1.20, maxHoldBars ×0.75 **after** hint/genome values and
   **before** the hard `PARAM_BOUNDS` clamp (over-bound values clamp; balanced/unknown profiles compile
   byte-identical v3.3 params and the same `specId`; unknown names never guess; symbol/family/lookback/
   exitZ are untouched). Executor aggressive floor raises a cautious 0.2 factor to 0.8 (a $100 bid
   becomes $400 on the test mandate); balanced/conservative keep legacy sizing; `respectStandDown:false`
   turns a `stand_down` stance into a floored cautious entry while `true`/absent keeps the legacy block;
   a converted stand-down with the bot-agent default `sizeMultiplier: 1` is still capped at the 0.8
   floor (not a full-size entry); research ALERT still vetoes a converted entry and the D6 daily-order
   brake still denies it (the aggressive profile is a policy/multiplier, never a brake bypass).
9. **Annual-return target (`src/orchestrator.js` status).** `targetAnnualReturnPct 0.50`,
   `requiredDailyReturnPct = (1.5)^(1/365)−1 = 0.00111148` (~0.111%/day), one-time
   `growth-v34.json` baseline (broker equity + trading P&L at first start), `baselineAt`,
   `daysElapsed`, `tradingPnlSinceBaselineUsd`, annualized trading return, `targetProgressPct` in
   **percent points (100 = on target)** and informational `onTrack` were verified with crafted
   baselines: +$1,000 over 30 days on $100k = 12.1667%/yr = 24.33 points `onTrack:false`; +$5,000 =
   `121.67` points `onTrack:true`; a <1-day history keeps annualized/progress/onTrack `null` (never
   fabricated) while trading P&L since baseline is still reported. `accountEquityUsd`,
   `accountCapitalBase` (Σ contributed capital + treasury pool) and `tradingPnlTotalUsd` are exposed on
   both `engine.performance` and top-level `performance`.
10. **Status/activity contract + UI JSON.** `engine.aggression` (enabled/percentages/multiplier/
    profiles/counts), `engine.activity` (ordersToday, tradesTotal, positionsTotal, last-cycle
    executions/orders, activeProfiles, haltReasons, halted) and per-agent `aggression`,
    `aggressionProfile` limits, `activity {ordersToday,trades,positions}` and
    `capital.aggressiveCapitalUsd` are present, consistent and served by a **stopped** engine and by
    `marketView`; the target is status-only (the mandate is still min(`maxOrderNotionalUsd`,
    `maxOrderPctOfEquity` × equity) with a target far behind, and a source scan shows no sizing/trading
    module reads the target).
11. **Security (adversarial).** The v3.4 path adds **no broker/order/transfer/tool surface**: the
    top-up is a virtual `ledger.transfer` from the treasury record, `TOOL_NAMES` is still 10 with no
    capital/aggression/target/transfer tool, no broker order is submitted during migration, and the
    costs allowance mints nothing. The kill switch still denies a converted aggressive entry before any
    broker call (D11), the daily-order cap still denies it (D6 `RATE_FORBIDDEN`), `brakes.js`/`ledger.js`/
    `treasurer.js`/`rewards.js`/`rankings.js`/brokers still contain no aggression execution override,
    the reward basis remains `trading-performance` with 0 reward capital and 0 P&L from the top-up, and
    the v3.4 status/`marketView` fields carry no credential values.
12. **Docs.** `docs/AGGRESSIVE-GROWTH.md` (counts 12/13/5 including the conservative rounding note,
    percent-point progress, opt-in/disabled default, capital top-up from pool/cap, risk caps, 50% as
    target not guarantee, held-spec vs entry-basket wording), `docs/RUNBOOK.md` §8h (live numbers:
    ~$261 headroom, $210 top-up, pool → ~$160), `README.md` and `CHANGELOG.md` v3.4.0 are consistent
    with the code verified here (one doc-code mismatch — §6 held baskets — was reported and fixed by
    the Lead before the freeze).

### 12.4 Defects found by this verification

All five were reported to the Lead with repros; the Lead fixed them in `src/orchestrator.js` /
`src/executor.js` / `docs/AGGRESSIVE-GROWTH.md` **before the code freeze**, and each now has a
regression test in the verifier suites (all green).

1. **D-V34-1 (behavioural, fixed) — disabled aggression ignored the operator portfolio limits.**
   With `aggression.enabled=false` and `portfolio {maxOpenPositionsDay:2, maxOpenPositionsSwing:1,
   maxOrdersPerCycle:1}`, the orchestrator passed the balanced **profile** limits
   (`maxOpenPositions:5`, `maxOrdersPerCycle:2`) to `executor.run` instead of `config.portfolio`
   (captured by wrapping `executor.run`), contradicting the "disabled keeps v3.3 behaviour" intent.
   Repro was a 3-agent sim tick; fixed: disabled now passes `config.portfolio` limits and a neutral
   profile `{aggression:'balanced', policySizeFloor:0, respectStandDown:true}`. Regression: integration
   "disabled aggression passes the OPERATOR portfolio limits…".
2. **D-V34-2 (behavioural, fixed) — a disabled first run permanently blocked later enablement.**
   With the code-default disabled config the migration wrote `aggression-v34.json` /
   `aggression-capital-v34.json` as `{version:1, skipped:true}`; a later start with
   `aggression.enabled=true` short-circuited on `already?.version === 1`, so the population stayed
   0/3/0 balanced and no top-up ever ran (operator would have had to delete markers manually,
   undocumented). Repro: two successive inits on the same state dir; fixed: disabled runs write no
   markers and stale skipped markers are ignored/overwritten by a real migration, with no double
   top-up. Regression: integration "a skipped-marker legacy state can still be migrated…".
3. **D-V34-3 (behavioural, fixed) — converted stand-down sized above the floor.** Executor profile
   `{aggression:'aggressive', policySizeFloor:0.8, respectStandDown:false}` with the bot policy
   `{stance:'stand_down', sizeMultiplier:1}` produced a **full-size** entry ($500.25 on the test
   mandate) instead of the contract's "cautious at the floor" $400, because it used
   `max(policyFactor, floor)`. This is reachable because `bot-agent.js` stores `sizeMultiplier: 1`
   when the model omits it. Fixed: a converted stand-down sizes exactly at the floor (0.8; floor 0
   falls back to the bot multiplier capped at 1); regular trade/cautious still use the max. Regression:
   integration "executor converts stand_down at the floor…" (sizeMultiplier 1 case).
4. **D-V34-4 (UI contract, fixed) — aggressive capital was never exposed to the UI.** `status.agents[]`
   carried no aggressive-capital amount, while `client.js` renders the "Aggressive capital
   (contributed)" row only when `capital.aggressiveCapitalUsd`/fallbacks exist — so that classification
   row could never render (contract §5 / CHANGELOG claim "aggressive capital shown as contributed
   capital"). The aggregate `contributedUsd` was already correct and it was never reward/P&L. Fixed:
   the top-up is recorded per agent in the genome and exposed in status `capital.aggressiveCapitalUsd`
   (verified: 17.5 per aggressive bot; marker writes `allocations`). Regression: integration cohort
   funding test + security top-up surface test.
5. **D-V34-5 (docs, fixed) — AGGRESSIVE-GROWTH §6 contradicted the code on held baskets.** §6 said
   "basket sizes updated to profile sizes (flat agents)", but the migration (deliberately) gives every
   agent the profile ENTRY basket while held positions keep their opening spec/exits. Repro: live-copy
   migration had four held agents grow 4→6-symbol baskets with their opening `specId` retained. Fixed
   by updating §6 (and the internal balance formula wording to match the implemented conservative
   rounding). No code change needed.

No other behavioural defect was found after the fixes; no assertion was weakened.

### 12.5 Remaining gaps (explicit — NOT verified)

1. **Live Alpaca was not restarted.** This round proves the halt fix and the full v3.4 migration on a
   **read-only copy** of `automaton-data` (fake broker with the live account equity, no network). At
   verification time the running Host is still pre-v3.4 and the live state dir has no `aggression-v34.json`/
   `growth-v34.json`; real order placement, real Alpaca fills and the real post-restart reconciliation
   were not exercised. The first live tick must be operator-checked against RUNBOOK §8h.
2. **Browser/visual UI not verified.** The builder-owned plugin suite is 52/52 green (re-run here) and
   this round verified the JSON contract, the scaling (progress points vs UI fractions) and the
   fallback/caveat hooks (`performanceLegacyNote`, `annualTargetNotGuarantee`, `aggressionCapitalNote`
   exist; `capital.aggressiveCapitalUsd` is served); the rendered target card/badges/filters/detail
   rows were not inspected in a browser, and the installed Host needs a restart to serve the v3.4
   bundle.
3. **Aggressive capital consumes treasury/reward headroom.** The top-up moved the live-copy pool from
   ~$370.82 to ~$160.82. Weekly reward budget is `10%` of the pool, so reward capital shrinks until
   winners rebuild it; the interaction between the smaller pool, reward payouts, replication surplus
   gates and the 92% allocation cap was not measured over time.
4. **Drawdown / 50%-annual target are not guaranteed.** Aggressive bots use 1.35× size with 0.80×
   stops and up to 8 open positions; the target is explicitly informational and its 50%/yr ambition is
   not a promise. No market-regime or multi-day drawdown study was performed, and the target/`onTrack`
   fields never force risk (verified structure, not performance).
5. **No long-run cohort/selection study.** One deterministic cohort assignment, one top-up, one
   restart are verified; the multi-week effect of the cohort mix on mortality, replication, capital
   rotation and reward distribution was not simulated or measured.
6. **Legacy baseline residual.** The live ledger is a legacy anchored ledger with no `anchorCostsUsd`,
   so the fix allows back **all** recorded costs, including any pre-anchor costs that the original
   anchor had already folded into the pool seed. On the live copy this residual is −$0.24 (inside the
   $39.93 tolerance and stable), but a hypothetical legacy ledger with large pre-anchor costs (>2% of
   equity) could halt with a negative delta; no such state exists here and the field is persisted
   normally going forward.
7. **Reconciliation tolerance is unchanged (2% of equity).** A real unbooked fill smaller than ~$40 on
   the ~$2k live account is inside tolerance (pre-existing behaviour, not introduced or worsened by
   the costs allowance; the allowance itself was proven not to hide >tolerance mismatches).
8. **Costs of synthetic/untracked ledger records.** `totalCostsUsd()` sums every ledger record
   (including `__treasury__` and dead agents), while the reconciliation's allocated total covers
   `registry.all()`; today the treasury record books no costs and every ledger record belongs to a
   registry agent, so no divergence exists, but a future charge to an untracked record would
   over-credit the expectation.
9. **First-start assumptions.** The top-up scales down permanently if the pool/allocation headroom is
   short at the first v3.4 start (live headroom is ample: ~$261 vs $210); if the account is restricted
   or the broker unavailable at that moment, `init` fails and the migration retries on the next start
   (correct but not exercised against real Alpaca).
10. **Option-path profile sizing.** Executor profile tests use stock-only worlds for deterministic
   notional comparisons; the option/spread sizing path multiplies the same size factors and remains
   under the unchanged D2/D15–D18 walls, but its floored notional was not exercised.
11. **`marketView`/plugin tool contract only.** No new tool/route was added for v3.4 (TOOL_NAMES 10,
   route and control paths unchanged); this round verified the JSON they expose, not every render
   branch (see gap 2).

### 12.6 Verdict (v3.4)

The reconciliation fix is real and correct on the actual live state: the six-day
`reconciliation_mismatch` halt is explained by $50.8 of virtual metabolism costs the paper broker
never paid (legacy delta $50.62 vs $39.93 tolerance) and clears on the first tick of a read-only live
copy (`halted: false`, delta −$0.24, `costsSinceAnchorUsd 50.86`) while genuine ±fill mismatches still
halt, no cash or capital is minted, the allocation cap is untouched and the conservation identity
holds to the cent. The aggressive cohort is deterministic and day-first (30 → 12/13/5; baskets 6/4,
4/3, 3/2; profile multipliers applied before hard bounds with balanced byte-compatible), funded by a
one-time **$210 contributed-capital** transfer from the treasury pool (endowments 50 → 67.5, pool
370.82 → 160.82, exactly conserved, never P&L/reward, idempotent across restarts, held positions keep
their opening specs). Executor floors/stand-down conversion are deterministic and cannot exceed
mandate/portfolio caps or bypass research/brake gates; the kill switch and D6 still deny converted
aggressive entries. The 50%-annual target is honest and informational (0.111148%/day required pace,
percent-point progress with 100 = on target, nulls under one day, no sizing path). Five defects were
found this round — disabled-aggression portfolio limits, skipped-marker gating, over-floor stand-down
conversion, missing aggressive-capital status field and a doc/code held-basket mismatch — all fixed by
the Lead before the freeze and re-verified; 446/446 tests pass (integration 99, security 71) and the
independent live-copy dry run is 37/37. **Verified as a paper/sim v3.4 capability; the running live
process has not yet executed the migration/restart, browser rendering is unverified, and the 50% target
and the aggressive cohort's drawdown/reward trade-off remain expectations, not guarantees.**

## 13. v3.5 meaningful position sizing + idle-aggressive fallback — independent verification (2026-11-27)

This round verifies `docs/AGGRESSIVE-GROWTH.md` §7 (the v3.5 changes): `risk.sizePctMultiplier`
(default 1, live 3.0, `maxOrderNotionalUsd` 120) and the aggressive-only opportunistic proven
fallback (`aggression.profiles.aggressive.allowOpportunisticFallback`). The verifier did **not** edit
`src/`, config, orchestrator, executor or client; the only changed files are
`test/integration.test.js`, `test/security.test.js` and this section. Two real defects found during
the round were fixed by the Lead while verification was in progress (tree re-frozen at
`orchestrator.js` 2026-11-27 21:05 local) and re-verified here; the fixes are covered by pass-only
regression tests.

### 13.1 Reproduce

```powershell
cd packages/automaton-trading
node test/integration.test.js
node test/security.test.js
node test/mortality.test.js      # live-copy proof remains env-gated (set AUTOMATON_LIVE_DRY_RUN=1)
node test/market.test.js
node test/plugin.test.js
node test/research.test.js
node test/rankings.test.js
node test/control.test.js
node test/bot-agent.test.js
node test/instruments.test.js
```
The sandbox still blocks `node --test <file>` (spawn EPERM), so files run directly. The v3.5 fallback
tests drive the **real** tick path (`ensureSpecs` → builder → executor → brakes → registry/status);
because `ensureSpecs` is a closure that is not exported, the tests replace
`automaton._internals.prospector.run()` with a deterministic hypothesis queue (test-only seam — see
gap 13.6.8). Sizing tests drive the real executor/brakes/ledger with a stock-only instrument world and
a mandate built by the real live formula `min(risk.maxOrderNotionalUsd, risk.maxOrderPctOfEquity ×
equity)`.

### 13.2 Results (fresh runs, 2026-11-27; every process exit code 0)

| suite | tests | pass | skip | fail |
| --- | --- | --- | --- | --- |
| integration (`test/integration.test.js`) | 110 | 110 | 0 | 0 |
| security (`test/security.test.js`) | 76 | 76 | 0 | 0 |
| mortality (`test/mortality.test.js`) | 91 | 90 | 1 | 0 |
| market (`test/market.test.js`) | 56 | 56 | 0 | 0 |
| plugin (`test/plugin.test.js`) | 52 | 52 | 0 | 0 |
| research (`test/research.test.js`) | 13 | 13 | 0 | 0 |
| rankings (`test/rankings.test.js`) | 29 | 29 | 0 | 0 |
| control (`test/control.test.js`) | 19 | 19 | 0 | 0 |
| bot-agent (`test/bot-agent.test.js`) | 9 | 9 | 0 | 0 |
| instruments (`test/instruments.test.js`) | 7 | 7 | 0 | 0 |
| **total** | **462** | **461** | **1** | **0** |

The pre-existing 446-test baseline (before this verifier's additions) was reproduced exactly at the
start of the round: 445 pass + 1 env-gated live-copy skip, 0 fail (integration 99, security 71,
mortality 90p/1s, market 56, plugin 52, research 13, rankings 29, control 19, bot-agent 9,
instruments 7). This round adds **16 pass-only tests** (11 integration, 5 security); nothing is
`todo`/skipped except the unchanged `AUTOMATON_LIVE_DRY_RUN` mortality live-copy gate.

### 13.3 Sizing verification (executor, live-shaped caps)

The mandate cap at these bot sizes is `min(120, 0.5 × equity)`: **$25** on a $50 bot, **$33.75** on
$67.5, **$63** on $126. The executor order is `min(1, spec.sizePct × multiplier) × mandate cap` before
the mandate/hard/equity/cash/D5/brake caps. Measured on the real executor (entry notional, rounding
tolerance ±$0.06; 3x entries include the 4-decimal qty rounding):

| sizePct | 1x (v3.4) | 3x (v3.5 live) |
| --- | --- | --- |
| 0.12 | $3.00 / $4.05 / $7.56 → **6.0%** of equity | $9.00 / $12.16 / $22.68 → **18.0%** |
| 0.20 | $5.00 / $6.75 / $12.60 → **10.0%** | $15.00 / $20.26 / $37.80 → **30.0%** |
| 0.40 | $10.00 / $13.50 / $25.20 → **20.0%** | $25.00 / $33.77 / $63.00 → **50.0%** (percent clamp at 1) |

Per-bot sizes computed with the live config/genomes/equity (market closed, so not executed):
**aggressive 12 bots: $19.65–$61.03 = 27.9%–50.0% of equity** (the documented "$65 aggressive bot
$20–$33" holds: live $65 aggressive bots project $19.65–$32.70), **balanced 13: $12.79–$29.21 =
26.5%–48.8%**, **conservative 5: $7.58–$16.32 = 15.7%–33.8%**.

Verified claims:
- **Default compatibility:** `defaultConfig().risk.sizePctMultiplier === 1`; an executor whose config
  omits the field produces the *identical* order as an explicit 1 (both = `sizePct × cap`). No
  v3.4/v3.3 assertion was weakened; balanced/legacy builder byte-compatibility tests still pass.
- **Caps:** mandate max-order $10 → order $10.01; at $500 equity the $120 hard/equity cap binds
  ($119.8–$120.1); with only $2 virtual cash the order is $2.00 and cash never goes negative; a
  50%-equity order under the default `maxPositionPct` 0.25 is **denied (D5 `SIZE_FORBIDDEN`, not
  silently clamped)** — the live `maxPositionPct` 0.6 is safely above the 50% maximum order (documented
  caveat); the daily-order brake still denies `RATE_FORBIDDEN`.
- **No resize of existing positions:** a risk-only pass over a seeded tiny position leaves its qty
  untouched (only new entries use the larger size; exits follow their own rules).
- **No negative cash, no cap bypass:** covered above and by the security round.

### 13.4 Idle-aggressive fallback verification

Through the real tick path (3-bot world: one aggressive `Breakout NVDA`, endowment $50 → $67.5 after
the v3.4 top-up; two balanced bots):

- **Compiles the measured setup and trades it:** queue `gapfade:NVDA` with no own-family hypothesis →
  spec `family: gapfade`, `fallback: true`, `genomeFamily: breakout`, `symbol: NVDA`,
  `proofRef` = the hypothesis proof URL, and the **hypothesis-family parameters** (`lookback 30,
  entryZ 0.70, exitZ 0.50, stopPct 0.012, targetPct 0.03, maxHoldBars 5, sizePct 0.27` = gapfade
  defaults/hint × aggression profile multipliers), not the breakout genome values. The executor
  placed exactly one order attributed to that spec, **40.5% of the bot's equity**, with 0 brake
  denials/errors, non-negative cash and no spec/proof/fallback metadata on the broker order.
- **Primary/status contract:** because the fallback spec is on the *primary genome symbol*, status
  `spec`/`specId` show it and flag `fallback: true`/`genomeFamily: breakout`; a **basket-sibling**
  spec never becomes the primary spec (`specId`/`spec` stay null, exactly v3.2), while it remains in
  `specIds`/`specs` and the executor still trades it (D-V35-1 regression).
- **Balanced/conservative:** given a proven other-family hypothesis on a symbol in their baskets they
  stayed `no_matching_hypothesis`, zero specs, zero orders; no non-aggressive status row ever carries
  a fallback spec/flag.
- **Disabled switch A/B:** with `allowOpportunisticFallback: false` the same queue leaves the
  aggressive bot idle (skip reason `no_matching_hypothesis`, no spec, no order); coverage falls from
  11/12 to 6/12 aggressive bots in the deterministic 30-bot cohort test.
- **Proof/freshness (D9) still binds:** an 8-day-old hypothesis is rejected by the Builder
  (`PROOF_STALE`), an unproven one by `NO_PROOF`; no spec is persisted, no order is placed. A
  fallback-marked spec with missing proof is denied by the executor (`NO_PROOF`) and one with stale
  proof by the brake wall (`PROOF_STALE`); the broker is never called.
- **Rank/freshness selection:** the exact own-family hypothesis wins even at a lower rank; for a
  symbol with no compilable own family, the builder tries the other-family candidates in rank order —
  a stale rank-0.95 top candidate was rejected and the fresh rank-0.90 candidate compiled (D-V35-2
  regression), with the lower-ranked meanrev candidate not used.
- **Cache:** a second cycle reuses `specIds`, keeps `fallback`/`genomeFamily`, and does not fork a
  duplicate spec file.
- **Narrow-queue cohort (30 bots, 12/13/5 profiles):** with only `gapfade:SOFI` + `breakout:AMZN`
  proven, fallback-enabled coverage exceeds fallback-disabled (11/12 vs 6/12 in the deterministic
  test; every aggressive bot whose basket contained either pair compiled, consumed partly by 5
  fallback specs). Balanced/conservative remain family-coherent (no fallback specs).

**Live-state root-cause evidence (read-only):** the last open-market trace in
`automaton-data/traces.jsonl` is **2026-11-25T20:59:14.244Z, halted: true** (reconciliation),
`prospector: null`, all 30 `builds` skipped `no_matching_hypothesis`, 0 executions. The hypothesis
queue file has 200 entries across **24 positive-edge family:symbol pairs, all observed
2026-11-17 (9.8 days old)**, and the Builder rejects the latest one at today's clock with
`PROOF_STALE (9.80 days > maxProofAgeDays 7)`; a fresh copy of the same hypothesis compiles. The
v3.4 restart cleared the halt (`state.json`: halted false, 311 ticks, last tick 13:09:57Z) but there
has been **no open-market cycle since 11/25** (Thanksgiving 11/26, premarket 11/27: last trace
`marketOpen: false, tradingSkipped: true`), so no fresh hypotheses exist yet. Idle aggressive bots
today are therefore expected, not a fallback failure. If the fresh queue were the narrow two-pair
queue, fallback would cover **7/8 currently idle aggressive bots and 10/12 aggressive bots overall**
(own-family-only: 6/12); `GapFade AMD` (basket has neither SOFI nor AMZN) would correctly stay flat.

**Live config/status:** `automaton.config.json` loads as `risk.sizePctMultiplier: 3`,
`risk.maxOrderNotionalUsd: 120`, `risk.maxOrderPctOfEquity: 0.5`, `risk.maxPositionPct: 0.6`, and the
aggressive profile defaults to `allowOpportunisticFallback: true`; code default multiplier is 1.
`publicConfig`/`engine.configView` expose the scaler and the fallback switch without credentials.
The **running engine process still predates v3.5** (latest `state.json` at 13:09:58Z has no
`allowOpportunisticFallback` in the status profile and no `fallback` fields on spec rows), so the
v3.5 sizing/fallback are not live until a Host restart. The plugin suite is 52/52 green, but
`client.js` renders neither a fallback badge nor `risk.sizePctMultiplier` (only the v3.4 profile
`sizePctMultiplier` e.g. ×1.35) — UI gap, not a blocker.

### 13.5 Defects found this round (fixed by the Lead, re-verified)

1. **D-V35-1 (status/UI contract, medium) — aggressive primary-spec drift.** The first v3.5 diff set
   `agent.specId` to `genomeSpec ?? specs[0]` for every aggressive bot, so a basket-**sibling**
   own-family spec became the primary `spec` (unflagged) even when the genome symbol had no spec.
   Repro (fixed-code regression now in integration): `Breakout NVDA` with only `breakout:F` → status
   `spec` was `F/breakout`, `fallback:false`; v3.2 requires the primary spec to stay on the genome
   symbol. Fixed: `specId` is genome-symbol-only again; a sibling still trades via `specIds`/`specs`,
   and a fallback **on the primary symbol** is shown and flagged. Re-verified by
   `a basket-sibling spec never becomes the primary spec` and the fallback e2e test.
2. **D-V35-2 (fallback selection, low-medium) — a stale top candidate masked a fresh proven one.**
   The first v3.5 diff picked only the top-ranked any-family hypothesis; if it failed D9 the symbol
   was aborted instead of trying the next candidate. Repro: `[gapfade:NVDA rank 2.0 stale,
   meanrev:NVDA rank 0.4 fresh]` → `PROOF_STALE`, no spec/no order; control with only the fresh
   hypothesis compiled. Fixed: exact-family first, then other-family candidates for the same symbol in
   rank order, each attempted until the Builder accepts one. Re-verified by
   `own-family specs win over fallback and a stale top fallback cannot mask a fresh lower one`.
3. **D-V35-3 (fallback semantics, low-medium) — measured edge was traded with the wrong parameters.**
   The first diff passed the bot's whole genome into `builder.compile` for a cross-family fallback, so
   a `gapfade` proof compiled with the breakout genome's `lookback/entryZ/stopPct` (genome precedence
   over `specsHint`): the proven setup and the traded setup differed. Fixed: cross-family fallback
   passes only `{aggression, symbol}` (hypothesis-family defaults/hint + profile multipliers), while
   own-family specs keep the inherited genome parameters exactly. Re-verified by the fallback e2e
   parameter assertions (gapfade family defaults, not breakout genome) and the own-family test.

No behavioural defect was found after those fixes; the sizing arithmetic, cap ordering and brake wall
behaved exactly as documented, and no assertion was weakened.

### 13.6 Remaining gaps (explicit — NOT verified)

1. **The live Host has not been restarted with v3.5.** The running process is pre-v3.5 (status lacks
   the new fields) and the market has been closed since 11/25. Real paper sizing (15–50% orders),
   real Prospector freshness, real fallback compilation and real fills were not exercised. The first
   live tick needs operator checks per RUNBOOK §8i.
2. **Fresh hypothesis availability is unmeasured.** The current queue is 100% stale (all 11/17); how
   many positive-edge families/symbols the next open-market Prospector run produces — and therefore
   how much fallback is actually needed — cannot be known until it runs. The two-pair coverage numbers
   above are a what-if using the documented narrow queue.
3. **UI fallback visibility is missing.** `spec.fallback`/`genomeFamily` and
   `risk.sizePctMultiplier` are served in status/config but not rendered by `client.js`; the browser
   view was not verified (plugin suite only).
4. **Fallback strategy drift risk is real and unmeasured.** A proven other-family setup is executed by
   a bot of a different tier/family (day-vs-swing timeframe, hold/exit management, bot policy); the
   measured edge may not survive. Only the status flag surfaces it; no multi-day attribution study.
5. **The 15–50% target is not guaranteed.** It depends on signal frequency, cash/position caps,
   existing positions (a bot with several open positions may be capped by D5/cash before reaching
   50%), and on the option path — `sizePctMultiplier` scales **stock** entries only; option/spread
   entries remain capped by `maxOptionPremiumUsd`/pct (not exercised as raised sizes).
6. **Existing tiny positions are not force-resized (by design).** The account's gross exposure rises
   only from new entries after exits; no live evidence of the expected exposure lift yet.
7. **Short-stock sizing not exercised** (same expression, but whole-share truncation can still skip a
   sub-price-cap short) and option/spread sizing is outside the multiplier path.
8. **`ensureSpecs` is not exported.** Fallback selection is verified through the full tick with a
   monkey-patched Prospector queue; there is no direct unit seam for the selection closure. A future
   pure helper would make this testable without patching.
9. **`maxPositionPct` interaction at larger equity** was not run live: below $240 equity the mandate
   cap is 50% of equity; at larger equity the $120 hard cap dominates (max order 120/equity shrinks).
   The D5-denial caveat if an operator lowers `maxPositionPct` is documented and tested, not lived.
10. **No multi-day cohort/performance study** of 3x sizing or fallback: mortality, drawdown,
    replication, reward rotation and the 50%-annual target effect remain expectations.
11. **Docs residual inconsistencies (minor):** `docs/AGGRESSIVE-GROWTH.md` title still says
    "MEAT v3.4" and §8's last acceptance bullet still cites RUNBOOK §8h / CHANGELOG v3.4 (v3.5 lives
    in §7 / RUNBOOK §8i / CHANGELOG v3.5). §7's idle root-cause sentence still says "current live
    hypotheses had only gapfade:SOFI and breakout:AMZN" while the same section later (correctly)
    says 24 stale pairs — the queue file has 24 positive-edge pairs, so two-pair wording appears in
    §7, README, RUNBOOK §8i and CHANGELOG and should be reworded (the *narrow-queue* coverage
    analysis remains valid as a what-if).
12. **Mortality live-copy proof stays env-gated** (`AUTOMATON_LIVE_DRY_RUN=1`); v3.5 does not touch
    reconciliation, and the 1-skip total is unchanged from the baseline.

### 13.7 Verdict (v3.5)

The v3.5 sizing change is real and behaves exactly as documented in the executor: with the live
multiplier 3.0 every new stock entry is `min(1, sizePct × 3) × min($120, 50% equity)` — 18%/30%/50%
of a $50/$67.5/$126 bot's equity for sizePct 0.12/0.2/0.4 instead of the old 6%/10%/20% — while the
default multiplier 1 is byte-compatible with v3.4 and every mandate/order/equity/cash/position/budget/
daily-order/kill-switch cap still binds (D5 can deny rather than clamp, documented). The
aggressive-only opportunistic fallback compiles, flags and executes a dated-proof other-family
hypothesis on an exact basket symbol with the *measured* family parameters, only when the bot's own
family has no compilable hypothesis; balanced/conservative never cross families; stale/unproven
hypotheses are rejected by Builder D9 (no spec persisted, no order); own-family and rank order are
preserved; specs are cached and reused; the narrow-queue cohort test shows a real coverage gain
(11/12 vs 6/12 aggressive bots). Three defects found by this verification (primary-spec drift, stale
top candidate masking, and fallback-parameter mismatch) were fixed by the Lead and re-verified with
pass-only regressions: **462 tests, 461 pass, 1 skip (env-gated live-copy), 0 fail; integration 110,
security 76, plugin 52.** **Verified as a paper/sim v3.5 capability: the running live process still
predates v3.5 (restart pending), the market has been closed since 11/25 so no fresh hypotheses/sizing
have fired live, the UI does not render the fallback flag, and fallback strategy drift, the 15–50%
order target and the 50%-annual return remain measured expectations, not guarantees.**
