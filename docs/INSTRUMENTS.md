# MEAT v3.0 — MULTI-INSTRUMENT TRADING CONTRACT (2026-10-30)

> **Status:** implemented (v3.0): `src/instruments.js`, multi-asset `ledger.js`, `brakes.js` D2/D15–D18,
> `treasurer.js` mandates, `broker-alpaca.js`/`broker-sim.js`, multi-instrument `executor.js`,
> `reaper.js`/`simulate.js` liquidation, bot-agent instrument policy, status/panel and docs.
> Tests: **346 total across 10 suites**, all passing (v3.2): mortality 76, market 50, plugin 46,
> integration 53, security 58, research 13, rankings 16, control 18, bot-agent 9, instruments 7.

Goal: every bot may use **margin, short selling, long options, defined-risk option spreads, and
covered calls**, and uses them actively when its strategy sees an edge. Paper trading by default;
the hard brake wall stays authoritative.

User decisions: **raise bots to $50** (one-time +$30 reallocated from the unallocated treasury pool; 30 × $50 = $1,500 ≤
80% of the ~$2,000 paper account); option scope = **long options + defined-risk spreads + covered
calls** (no naked short options).

Account facts (probed live, paper): options level 3, shorting_enabled=true, margin_multiplier=4 on 2026-10-30,
options_buying_power≈cash, assets AAPL/F/SPY/TSLA shortable+marginable, option chain + indicative
snapshots work (`/v1beta1/options/snapshots/{UNDERLYING}`), cheap OTM contracts exist (e.g. F 13C at
$0.04 = $4/contract). **v3.1 account note:** the paper account later fell to ~$1,999.87 and reports
`shorting_enabled:false` with no margin buying power (below the broker margin minimum), so the engine
now gates short/margin/covered-call/credit-spread permissions on the broker facts; long stock, long
options and debit verticals remain available and permissions re-enable automatically if the account
recovers.

## Strategy → instrument playbooks (`src/instruments.js`, Lead)

| Family | Tier | Default playbook (bullish / bearish / neutral) |
|---|---|---|
| momentum | swing | long stock or long call / short stock or long put / hold |
| meanrev | swing | long stock or bull put spread / short stock or bear call spread / hold |
| breakout | day | long call (leverage) or long stock / long put / hold |
| gapfade | day | covered call (only if ≥100 shares) or long put / short stock or bull put spread / hold |

The bot's own agent policy may override with `instrumentPlan`; otherwise the deterministic playbook
picks the structure. Options are chosen only when the premium is affordable under the caps; otherwise
the bot falls back to stock/short.

## Options structures (v1)

- `long_call`, `long_put` — single-leg debit; exit on stop/target/DTE/research ALERT.
- `covered_call` — sell-to-open call only when the bot holds ≥100 whole shares of the underlying;
  executor closes it at 50% profit, stop, or DTE guard (never lets it expire).
- `call_credit_spread`, `put_credit_spread`, `bull_call_spread`, `bear_put_spread` — two-leg
  defined-risk vertical, submitted as **one `order_class:"mleg"` order**, both legs linked by an
  internal `groupId`, opened and closed together. Naked short options are never allowed.
- No 0DTE: `minDTE ≥ 1`, default DTE window 2–14, auto-close at ≤1 DTE.

## Broker interface (`src/broker-alpaca.js` + `src/broker-sim.js`, market teammate)

```js
getAccount() // may include: buyingPowerUsd, optionsBuyingPowerUsd, marginMultiplier,
             // shortingEnabled, optionsTradingLevel (already partially exists)
getAsset(symbol) // {symbol, assetClass, tradable, shortable, marginable, fractionable, maintenanceMarginPct}
getOptionChain({underlying, type='call', expirationGte, expirationLte, strikeGte, strikeLte, limit})
  // -> [{symbol, underlying, type, strikeUsd, expiration, dte, multiplier, tradable, closePriceUsd}]
getOptionQuote(contractSymbol) // -> {symbol, bid, ask, last, mark, ts} via chain snapshot
submitOrder({ symbol, assetClass='us_equity', side, qty, type='market'|'limit', limitPrice,
              timeInForce='day'|'gtc', positionIntent=null, orderClass='simple'|'mleg',
              legs=[{symbol, side, ratioQty, positionIntent}], clientOrderId })
  // stocks: short sales are plain sell orders without position_intent.
  // options: positionIntent = buy_to_open|sell_to_open|buy_to_close|sell_to_close;
  //          qty = integer contracts; price = premium per share ($).
getPositions() // normalized [{symbol, assetClass, qtySigned, avgEntryPriceUsd, marketValueUsd, side}]
getOrders({status}) / getOrder(id) // must include filled_qty/filled_avg_price for option + stock orders
```

## Ledger (`src/ledger.js`, mortality teammate)

Generic signed positions keyed by symbol; stock ticker or OCC option symbol.

- `applyFill(agentId, {symbol, assetClass='us_equity', side:'buy'|'sell', qty, priceUsd,
  multiplier=1, option=null, groupId=null, orderId, at})`:
  - **stock**: buy adds/increases long, sell reduces long or opens/increases short (signed qty);
    whole shares required to short; long can stay fractional.
  - **option**: integer contracts; buy adds long contracts (cash debit), sell reduces long or opens
    short contracts (cash credit); **multiplier 100**.
  - cashUsd += sellProceeds − buyCost; cost basis per position; realized P&L on closing using signed
    entry; `groupId` links spread legs; option metadata persisted
    `{underlying, expiration, type, strikeUsd, multiplier, groupId, structure}`.
  - closing a leg/whole position removes it; `realizedPlUsd` returned and recorded in trade history.
- **Margin**: cash may go negative only when `config.instruments.allowMargin` and resulting debt
  (`max(0,-cash)`) stays ≤ `maxMarginPctEquity × equityUsd`; otherwise fail `MARGIN_LIMIT`.
- `equity(agentId, prices)` must mark stocks `qtySigned × price` and options
  `contracts × premium × 100`; `cash + Σ marketValues`; include `marginDebtUsd`, `grossExposureUsd`,
  `netExposureUsd`, `longSharesOf(agentId, symbol)` helper for covered-call checks.
- `transfer('__treasury__', agentId, amountUsd, {reason})` is used for the one-time $30 top-up so
  aggregate ledger equity is conserved (no cash minted; the Treasurer reconciliation stays valid).
- `snapshot(agentId)` positions enriched with `side: LONG|SHORT|CALL|PUT`, `assetClass`,
  `option{strikeUsd,expiration,type,dte}`, `multiplier`, `groupId`.
- USD rounding, invariants: equity = cash + Σ marks; no money creation except credit/charge/transfer.

## Brakes (`src/brakes.js`, mortality teammate) — authoritative, still first

Extend the order input:
`{assetClass, asset:{shortable,marginable,tradable}, option:{...}, structure, groupId, legs,
 marginRequiredUsd, mandate.instruments:{longStock,shortStock,longOptions,shortOptions,coveredCalls,
 spreads,margin,allowedStructures:[],maxShortNotionalUsd,maxOptionPremiumUsd,maxContracts,
 maxMarginUsd}}`

- **D2 is replaced**: no longer "no margin/short/options"; it becomes the instrument-permission gate.
- New hard rules:
  - **D15 short sale**: shorting enabled, asset shortable+marginable, integer shares, mandate allows
    shortStock, notional ≤ maxShortNotionalUsd; no shorting outside the whitelist.
  - **D16 options**: options enabled + mandate allows the structure; OCC symbol valid; contracts
    integer 1..maxContracts; premium notional ≤ maxOptionPremiumUsd and ≤
    `instruments.maxOptionPremiumPctEquity × equity`; DTE within min/max; covered calls require
    ≥100 long shares at order time; spreads require exactly 2 legs, opposite sides, same underlying,
    same expiry, defined max loss, and allowed structure; **naked short options always denied**.
  - **D17 margin**: order creating negative cash must keep debt ≤ `maxMarginUsd` (and ≤
    `maxMarginPctEquity × equity`); buying power from mandate; account equity is never read by the
    Executor.
  - **D18 expiry/assignment guard**: opening order with DTE < minDTE denied; executor must close
    options by autoCloseDTE; selling-to-close always permitted for risk reduction.
- D1–D14 keep their meaning (D2 is now the instrument gate); D15–D18 are the v3.0 instrument walls. Break wall order
  stays: D11 kill switch → mode/live → D3 market → instrument gates → D4 whitelist/price/spread →
  D9 proof/spec → sizing/daily-loss/allocation.

## Treasurer mandates (`src/treasurer.js`, mortality teammate)

Each mandate additionally carries:
```js
instruments: {
  longStock: true, shortStock: config.instruments.allowShort,
  longOptions: config.instruments.allowOptions,
  shortOptions: allowOptions && (coveredCalls || spreads),
  coveredCalls, spreads, margin: config.instruments.allowMargin,
  allowedStructures: [...],
  maxShortNotionalUsd, maxOptionPremiumUsd, maxContracts, maxMarginUsd,
}
```
Caps derive from config + agent equity (e.g. maxShortNotionalUsd = min(config cap,
maxShortPctEquity × view.equityUsd)); halt/death still force `allowExitOnly`. Account equity only as
today for D13; never account cash.

## Executor (`src/executor.js`, market teammate)

- `computeSignal` exposes `longEntry` and `shortEntry` (z direction / family semantics); executor
  picks direction = bot policy plan or playbook.
- Active instrument selection: if options enabled & affordable and plan/playbook says option, fetch
  chain → choose expiry (DTE window) and strike by family rule (calls 2–5% OTM for momentum/breakout,
  puts 2–5% OTM for puts; spreads share width) → contracts = floor(budget / (premium×100)); 0 → fall
  back to stock/short.
- Orders: long stock / short stock / long option / covered call / vertical spread (mleg).
  Every order goes through `brakes.checkOrder` first; no bypass.
- Exit management for options (premium stop/target, DTE guard, research ALERT, close group mleg),
  short stock (stop/target/max-hold/signal → buy-to-cover), covered calls (50% premium profit, DTE
  guard).
- Async fill reconciliation must handle short and option orders (per-orderId book delta), including
  mleg parent orders; `reconcileBrokerFills` extended.
- Risk-only passes (non-due swing bots with positions) must manage short/option exits too.
- `describe()` reports enabled instruments and structures.

## Bot agent (`src/bot-agent.js`, Lead)

Policy adds:
```js
instrument: {
  prefer: 'auto'|'stock'|'short_stock'|'long_call'|'long_put'|'covered_call'
        | 'call_credit_spread'|'put_credit_spread'|'bull_call_spread'|'bear_put_spread',
  maxPremiumUsd, maxContracts, dteMin, dteMax
}
```
The prompt lists the bot's allowed instruments/caps and its family playbook, and asks it to choose
the structure that best fits its edge (or `auto`). Validation clamps to allowed structures and caps.
`auto` = deterministic playbook.

## Config (`src/config.js`, Lead)

```js
population: { initial: 30, cap: 60 },
endowmentUsd: 50,
instruments: {
  enabled: true, allowMargin: true, maxMarginPctEquity: 1.0,
  allowShort: true, maxShortPctEquity: 1.0, maxShortNotionalUsd: 25, shortableOnly: true,
  allowOptions: true, allowCoveredCalls: true, allowSpreads: true,
  maxOptionPremiumPctEquity: 0.35, maxOptionPremiumUsd: 30, maxContracts: 2,
  minDTE: 2, maxDTE: 14, autoCloseDTE: 1, allowNakedShortOptions: false,
  optionDataFeed: 'indicative'
},
risk: { maxOrderNotionalUsd: 40, maxOrderPctOfEquity: 0.5, maxDailyOrders: 20, ...existing }
```
Validation allowlists structures; capital migration: alive agents with initial $20 (endowment < 50)
receive one-time +$30 transferred from the unallocated treasury pool and their endowment basis is
raised to 50 (the transfer is not P&L; total ledger equity is conserved); endowmentUsd in config is 50
for new agents.
Paper-only permission expansion: live still triple-gated by D8.

## Status/panel (Lead + plugin teammate)

- `status.instruments`: enabled flags, caps, account options/short/margin fields (from last account
  read), and per-strategy playbooks.
- Agent rows add `instrumentPermissions`, `playbook`, `policy.instrument`, positions with
  `assetClass/side/option{strikeUsd,expiration,dte}/multiplier`.
- Panel: positions show LONG/SHORT/CALL/PUT badges + strike/expiry/DTE; account row shows margin
  debt and options buying power; Bot agent section shows chosen instrument plan; engine header shows
  instruments enabled + caps.
- Host passes through `instruments` and account fields; no new tools/control actions.

## Tests

mortality: ledger shorts, options debit/credit/close/realized, margin limit, spread cost, cash/equity
marks, top-up; brakes new D2/D15-D18 + existing wall; treasurer instrument mandates; security still
refuses unauthorized/live/naked.
market: broker option chain/order payloads (mleg legs), short stock submission, executor long
call/put, covered call guard, spread open/close, short stock entry/exit, margin order, fallbacks,
brakes-first.
bot-agent: instrument policy validation/clamps/auto fallback.
integration/control: end-to-end short and option round-trip in sim, status/playbook/instrument
permissions, top-up migration.
plugin: UI mappings for instrument badges/strike/expiry/DTE/margin/plan + bare payload fallbacks.
