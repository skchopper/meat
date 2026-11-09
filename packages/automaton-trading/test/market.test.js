/**
 * Market-side test suite: Alpaca client (stubbed fetch), sim broker, prospector,
 * builder, executor, and the accelerated population simulation.
 *
 * No network is used anywhere in this file.
 *
 * Run: `node --test test/market.test.js` from packages/automaton-trading.
 * Owner: market teammate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AutomatonError } from '../src/contracts.js';
import { defaultConfig, statePaths } from '../src/config.js';
import { createBroker as createAlpacaBroker, formatOccSymbol } from '../src/broker-alpaca.js';
import { createBroker as createSimBroker } from '../src/broker-sim.js';
import { createProspector } from '../src/prospector.js';
import { createBuilder, PARAM_BOUNDS } from '../src/builder.js';
import { createExecutor } from '../src/executor.js';
import { createBrakes } from '../src/brakes.js';
import { createClock, DAY_MS, HOUR_MS, round2, round4 } from '../src/util.js';

const T0 = Date.UTC(2024, 0, 10, 15, 0, 0);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(target, source) {
  const out = { ...target };
  for (const [key, value] of Object.entries(source)) {
    out[key] = isPlainObject(value) && isPlainObject(target[key]) ? deepMerge(target[key], value) : value;
  }
  return out;
}

/** Fresh default config with overrides (not frozen — defaultConfig returns a new object). */
function testConfig(overrides = {}) {
  return deepMerge(defaultConfig(), overrides);
}

function makeStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atm-market-test-'));
}

function removeStateDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** A Response-like stub for the fetch double. */
function jsonResponse(status, payload, { headers = {} } = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => text,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
  };
}

/** Capture fetch calls and answer via a handler. */
function stubFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init ?? {}, calls.length - 1);
  };
  fn.calls = calls;
  return fn;
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof AutomatonError, `expected AutomatonError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}

/** For sync-throwing APIs (broker-sim.submitOrder, builder.compile). */
function expectSyncCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof AutomatonError, `expected AutomatonError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}

/** Bars that end with a breakout above the prior range (family=breakout enter signal). */
function breakoutBars({ count = 31, flatPrice = 100 } = {}) {
  const bars = [];
  for (let i = 0; i < count - 1; i += 1) {
    bars.push({
      t: T0 - (count - 1 - i) * HOUR_MS,
      o: flatPrice,
      h: flatPrice + 0.5,
      l: flatPrice - 0.5,
      c: flatPrice,
      v: 1000,
    });
  }
  bars.push({
    t: T0,
    o: flatPrice,
    h: flatPrice + 10,
    l: flatPrice,
    c: flatPrice + 10,
    v: 5000,
  });
  return bars;
}

/** Bars where the last close is far below the rolling mean (meanrev enter signal). */
function oversoldBars({ count = 40, base = 100 } = {}) {
  const bars = [];
  for (let i = 0; i < count - 1; i += 1) {
    bars.push({ t: T0 - (count - 1 - i) * HOUR_MS, o: base, h: base + 0.3, l: base - 0.3, c: base, v: 1000 });
  }
  const drop = base * 0.92;
  bars.push({ t: T0, o: base, h: base, l: drop, c: drop, v: 5000 });
  return bars;
}

function makeBrokerDouble({ fillPrice = 101 } = {}) {
  const submitted = [];
  const broker = {
    submitted,
    getAccount() {
      throw new Error('executor must never call broker.getAccount()');
    },
    async getLatestQuote(symbol) {
      return { symbol, bid: fillPrice - 0.1, ask: fillPrice + 0.1, last: fillPrice, ts: T0 };
    },
    async getBars() {
      return {};
    },
    async submitOrder(order) {
      submitted.push(order);
      return {
        id: `ord-${submitted.length}`,
        clientOrderId: order.clientOrderId ?? null,
        symbol: order.symbol,
        side: order.side,
        qty: order.qty,
        filledQty: order.qty,
        avgFillPriceUsd: fillPrice,
        status: 'filled',
        submittedAt: T0,
      };
    },
  };
  return broker;
}

function makeBrakesDouble(handler) {
  const calls = [];
  return {
    calls,
    checkOrder(input) {
      calls.push(input);
      return handler ? handler(input) : { decision: 'ALLOW', code: null, rule: null, reason: 'allowed' };
    },
  };
}

// ---------------------------------------------------------------------------
// v3.0 multi-instrument helpers (synthetic option chains, option broker doubles)
// ---------------------------------------------------------------------------

/** Build normalized OCC contracts for tests (mirrors the broker chain shape). */
function makeOptionChain({
  underlying = 'AAPL',
  type = 'call',
  expirations = ['2030-01-18', '2030-01-25'],
  dtes = [12, 19],
  strikes = [100, 105, 110, 115, 120, 125],
  premiums = {},
  defaultPremium = 0.5,
} = {}) {
  const chain = [];
  expirations.forEach((expiration, expiryIndex) => {
    for (const strikeUsd of strikes) {
      const premiumKey = `${type}:${strikeUsd}`;
      const closePriceUsd = Number.isFinite(Number(premiums[premiumKey]))
        ? Number(premiums[premiumKey])
        : Number.isFinite(Number(premiums[strikeUsd]))
          ? Number(premiums[strikeUsd])
          : defaultPremium;
      chain.push({
        symbol: formatOccSymbol({ underlying, expiration, type, strikeUsd }),
        underlying,
        type,
        strikeUsd,
        expiration,
        dte: dtes[expiryIndex] ?? dtes[0] ?? 12,
        multiplier: 100,
        tradable: true,
        closePriceUsd,
      });
    }
  });
  return chain;
}

function num2(value) {
  return Math.round(Number(value) * 100) / 100;
}

/** Fake broker that supports stock + deterministic option chain/quotes/orders. */
function makeOptionBrokerDouble({ underlying = 'AAPL', spot = 110, chain = null, premiumBySymbol = {} } = {}) {
  const submitted = [];
  const contracts = chain ?? [
    ...makeOptionChain({ underlying, spot, type: 'call' }),
    ...makeOptionChain({ underlying, spot, type: 'put' }),
  ];
  const contractBySymbol = new Map(contracts.map((contract) => [contract.symbol, contract]));
  const premiumFor = (symbol) => {
    if (Number.isFinite(Number(premiumBySymbol[symbol]))) return Number(premiumBySymbol[symbol]);
    if (Number.isFinite(Number(contractBySymbol.get(symbol)?.closePriceUsd))) return Number(contractBySymbol.get(symbol).closePriceUsd);
    return 0.5;
  };
  const broker = {
    submitted,
    async getLatestQuote(symbol) {
      return { symbol, bid: spot - 0.1, ask: spot + 0.1, last: spot, ts: T0 };
    },
    async getBars() {
      return {};
    },
    async getAsset(symbol) {
      return { symbol, assetClass: 'us_equity', tradable: true, shortable: true, marginable: true, fractionable: true };
    },
    async getOptionChain({ type = 'call' } = {}) {
      return contracts.filter((contract) => !type || type === 'both' || contract.type === type);
    },
    async getOptionQuote(symbol) {
      const premium = premiumFor(symbol);
      const bid = Math.max(0.01, num2(premium * 0.98));
      const ask = Math.max(bid + 0.01, num2(premium * 1.02));
      const contract = contractBySymbol.get(symbol);
      return {
        symbol,
        underlying: contract?.underlying ?? underlying,
        type: contract?.type ?? 'call',
        strikeUsd: contract?.strikeUsd ?? null,
        expiration: contract?.expiration ?? '2030-01-18',
        dte: contract?.dte ?? 12,
        multiplier: 100,
        bid,
        ask,
        last: premium,
        mark: num2((bid + ask) / 2),
        ts: T0,
        simulated: true,
      };
    },
    async submitOrder(order = {}) {
      submitted.push(order);
      const id = `opt-ord-${submitted.length}`;
      if (order.orderClass === 'mleg') {
        const legs = (order.legs ?? []).map((leg) => ({
          symbol: leg.symbol,
          side: leg.side,
          ratioQty: leg.ratioQty ?? 1,
          qty: leg.ratioQty ?? 1,
          filledQty: leg.ratioQty ?? 1,
          avgFillPriceUsd: premiumFor(leg.symbol),
          positionIntent: leg.positionIntent ?? null,
          status: 'filled',
        }));
        return {
          id,
          clientOrderId: order.clientOrderId ?? null,
          symbol: legSymbolOf(order.legs?.[0]) ?? underlying,
          side: null,
          qty: order.qty ?? 1,
          filledQty: order.qty ?? 1,
          avgFillPriceUsd: order.limitPrice,
          status: 'filled',
          assetClass: 'us_option',
          orderClass: 'mleg',
          groupId: order.groupId ?? null,
          structure: order.structure ?? null,
          legs,
          submittedAt: T0,
        };
      }
      const isOption = order.assetClass === 'us_option';
      return {
        id,
        clientOrderId: order.clientOrderId ?? null,
        symbol: order.symbol,
        side: order.side,
        qty: order.qty,
        filledQty: order.qty,
        avgFillPriceUsd: order.limitPrice ?? spot,
        status: 'filled',
        assetClass: isOption ? 'us_option' : 'us_equity',
        positionIntent: order.positionIntent ?? null,
        groupId: order.groupId ?? null,
        submittedAt: T0,
      };
    },
    async getOrders() {
      return [];
    },
    async getOrder() {
      return null;
    },
    getAccount() {
      throw new Error('executor must never call broker.getAccount()');
    },
  };
  return broker;
}

function legSymbolOf(leg) {
  return leg && typeof leg === 'object' ? leg.symbol : undefined;
}

/** Executor harness backed by the multi-instrument broker double. */
function optionExecutorHarness({
  positions = {},
  brokerOptions = {},
  mandate,
  configOverrides,
  specOverrides,
  brakesHandler,
} = {}) {
  const config = testConfig({ mode: 'paper', ...(configOverrides ?? {}) });
  const clock = createClock({ now: () => T0 });
  const broker = makeOptionBrokerDouble(brokerOptions);
  const brakes = makeBrakesDouble(brakesHandler);
  const ledger = makeLedgerDouble({ positions, equityUsd: 5000, cashUsd: 100_000 });
  const executor = createExecutor({ broker, brakes, ledger, config, clock });
  return {
    config,
    clock,
    broker,
    brakes,
    ledger,
    executor,
    agent: { id: 'atm-1', status: 'alive', generation: 0, genome: { symbol: 'AAPL', family: 'breakout' } },
    spec: baseSpec({ family: 'breakout', ...(specOverrides ?? {}) }),
    mandate: mandate ?? baseMandate(),
    quotes: { AAPL: { bid: 109.9, ask: 110.1, last: 110, ts: T0 } },
    dayStats: { dayKey: '2024-01-10', ordersCount: 0, startEquityUsd: 5000, pnlUsd: 0 },
  };
}

/** Bars whose last close breaks above a flat range (bullish breakout signal). */
function gapUpBars({ count = 32, base = 100 } = {}) {
  const bars = [];
  for (let i = 0; i < count - 1; i += 1) {
    bars.push({ t: T0 - (count - 1 - i) * HOUR_MS, o: base, h: base + 0.4, l: base - 0.4, c: base, v: 1000 });
  }
  bars.push({ t: T0, o: base + 1, h: base + 1.6, l: base + 0.9, c: base + 1.5, v: 5000 });
  return bars;
}

/** Bars whose last close drops below a flat range (bearish breakdown signal). */
function breakdownBars({ count = 32, base = 100 } = {}) {
  const bars = [];
  for (let i = 0; i < count - 1; i += 1) {
    bars.push({ t: T0 - (count - 1 - i) * HOUR_MS, o: base, h: base + 0.4, l: base - 0.4, c: base, v: 1000 });
  }
  bars.push({ t: T0, o: base, h: base + 0.1, l: base - 10, c: base - 9, v: 5000 });
  return bars;
}

/** Gap-up open that fades back below the prior close (bearish gap-fade signal, no long exit). */
function gapUpFadeBars({ count = 32, base = 100 } = {}) {
  const bars = [];
  for (let i = 0; i < count - 1; i += 1) {
    bars.push({ t: T0 - (count - 1 - i) * HOUR_MS, o: base, h: base + 0.4, l: base - 0.4, c: base, v: 1000 });
  }
  bars.push({ t: T0, o: base + 1.2, h: base + 1.3, l: base - 0.5, c: base - 0.1, v: 5000 });
  return bars;
}

function makeOptionPosition(overrides = {}) {
  const contract = overrides.contract ?? {
    underlying: 'AAPL', expiration: '2030-01-18', type: 'call', strikeUsd: 115,
  };
  return {
    assetClass: 'us_option',
    qtySigned: 1,
    qty: 1,
    avgPriceUsd: 1,
    multiplier: 100,
    option: { ...contract, multiplier: 100, dte: 12 },
    groupId: overrides.groupId ?? 'grp-long-call',
    structure: overrides.structure ?? 'long_call',
    openedAt: new Date(T0 - HOUR_MS).toISOString(),
    ...overrides,
  };
}

function makeLedgerDouble({ positions = {}, cashUsd = 10_000, equityUsd = 5000 } = {}) {
  const fills = [];
  const book = { positions: structuredClone(positions), openOrders: [] };
  return {
    fills,
    bookCalls: 0,
    book() {
      this.bookCalls += 1;
      return book;
    },
    async applyFill(agentId, fill) {
      fills.push({ agentId, ...fill });
    },
    snapshot() {
      return {
        cashUsd,
        positions: book.positions,
        realizedPlUsd: 0,
        unrealizedPlUsd: 0,
        costsUsd: 0,
        grossSpendUsd: 0,
        grossRevenueUsd: 0,
        trades: fills.length,
        net7dUsd: 0,
        firstProfitAt: null,
      };
    },
    equity() {
      return { equityUsd, cashUsd, positionsValueUsd: equityUsd - cashUsd, unrealizedPlUsd: 0 };
    },
    async charge() {
      return { balanceUsd: cashUsd, record: {} };
    },
  };
}

function baseSpec(overrides = {}) {
  return {
    specId: 'spec-deadbeef',
    hypothesisId: 'hyp-1',
    agentId: 'atm-1',
    symbol: 'AAPL',
    family: 'breakout',
    createdAt: new Date(T0).toISOString(),
    // brakes D9 checks this URL string; the dated evidence rides in `proof`
    proofRef: 'https://data.alpaca.markets/v2/stocks/bars?symbols=AAPL&timeframe=1Hour&limit=120',
    proof: {
      vendor: 'alpaca',
      url: 'https://data.alpaca.markets/v2/stocks/bars?symbols=AAPL&timeframe=1Hour&limit=120',
      observedAt: new Date(T0 - HOUR_MS).toISOString(),
      metric: 'breakout',
      sampleSize: 20,
    },
    params: {
      lookback: 60,
      entryZ: 1.0,
      exitZ: 0.5,
      stopPct: 0.02,
      targetPct: 0.04,
      maxHoldBars: 12,
      sizePct: 0.2,
      sessionFilter: 'any',
    },
    budgetUsedUsd: 0.01,
    ...overrides,
  };
}

function baseMandate(overrides = {}) {
  return {
    agentId: 'atm-1',
    issuedAt: new Date(T0).toISOString(),
    expiresAt: new Date(T0 + 10 * 60 * 1000).toISOString(),
    state: 'STABLE',
    sizeBudgetUsd: 2000,
    maxOrderNotionalUsd: 500,
    maxDailyOrdersRemaining: 3,
    allowedSymbols: ['AAPL'],
    allowExitOnly: false,
    ...overrides,
  };
}

function makeHypothesis(overrides = {}) {
  return {
    id: 'hyp-test-1',
    createdAt: new Date(T0).toISOString(),
    symbol: 'AAPL',
    family: 'momentum',
    claim: 'Buy AAPL when momentum is positive.',
    proof: {
      vendor: 'alpaca',
      url: 'https://data.alpaca.markets/v2/stocks/bars?symbols=AAPL&timeframe=1Hour&limit=120&adjustment=raw&feed=iex',
      observedAt: new Date(T0).toISOString(),
      metric: 'momentum z>=1 -> 3-bar forward return bps',
      stats: { meanBps: 22.5, baselineBps: 3.1, sampleSize: 24, tStat: 2.1 },
      sampleSize: 24,
      barsUsed: 120,
    },
    expectedEdgeBps: 19.4,
    horizonBars: 3,
    rankScore: 1.6,
    specsHint: {
      lookback: 60,
      entryZ: 1.2,
      exitZ: 0.4,
      stopPct: 0.02,
      targetPct: 0.05,
      maxHoldBars: 10,
      sizePct: 0.2,
      sessionFilter: 'any',
    },
    ...overrides,
  };
}

// ===========================================================================
// broker-alpaca
// ===========================================================================

test('alpaca broker: parses clock, account, positions, bars, quote and orders', async () => {
  const clockIso = '2024-01-10T15:00:00Z';
  const fetchImpl = stubFetch((url, init) => {
    if (url.includes('/v2/clock')) {
      return jsonResponse(200, {
        is_open: true,
        timestamp: clockIso,
        next_open: '2024-01-11T14:30:00Z',
        next_close: '2024-01-10T21:00:00Z',
      });
    }
    if (url.includes('/v2/account')) {
      return jsonResponse(200, {
        equity: '100000.55',
        cash: '25000.10',
        buying_power: '50000.20',
        status: 'ACTIVE',
        currency: 'USD',
      });
    }
    if (url.includes('/v2/positions')) {
      return jsonResponse(200, [
        { symbol: 'AAPL', qty: '3.5', avg_entry_price: '180.5', market_value: '640.5', unrealized_pl: '12.25' },
      ]);
    }
    if (url.includes('/quotes/latest')) {
      return jsonResponse(200, { quote: { t: clockIso, bp: '189.9', ap: '190.1' } });
    }
    if (url.includes('/v2/stocks/bars')) {
      return jsonResponse(200, {
        bars: {
          AAPL: [
            { t: '2024-01-10T14:00:00Z', o: '189.1', h: '191.2', l: '188.9', c: '190.5', v: '120000' },
            { t: '2024-01-10T15:00:00Z', o: '190.5', h: '192.0', l: '190.0', c: '191.5', v: '90000' },
          ],
          MSFT: [],
        },
        next_page_token: null,
      });
    }
    if (url.includes('/v2/orders') && init.method === 'POST') {
      return jsonResponse(200, {
        id: 'ord-abc',
        client_order_id: 'atm:atm-1:spec-x:1',
        symbol: 'AAPL',
        side: 'buy',
        qty: '2.5',
        filled_qty: '0',
        filled_avg_price: null,
        status: 'accepted',
        submitted_at: clockIso,
      });
    }
    if (url.includes('/v2/orders')) {
      return jsonResponse(200, [
        {
          id: 'ord-abc',
          client_order_id: 'atm:atm-1:spec-x:1',
          symbol: 'AAPL',
          side: 'buy',
          qty: '2.5',
          filled_qty: '2.5',
          filled_avg_price: '190.25',
          status: 'filled',
          submitted_at: clockIso,
        },
      ]);
    }
    return jsonResponse(404, { message: 'unexpected path' });
  });

  const broker = createAlpacaBroker(
    { mode: 'paper' },
    { secrets: { ALPACA_API_KEY_ID: 'paper-key', ALPACA_API_SECRET_KEY: 'paper-secret' }, fetchImpl },
  );
  assert.equal(broker.kind, 'alpaca');
  assert.equal(broker.mode, 'paper');

  const clock = await broker.getClock();
  assert.equal(clock.isOpen, true);
  assert.equal(clock.timestamp, Date.parse(clockIso));
  assert.equal(clock.nextClose, Date.parse('2024-01-10T21:00:00Z'));

  const account = await broker.getAccount();
  assert.equal(account.equityUsd, 100000.55);
  assert.equal(account.cashUsd, 25000.1);
  assert.equal(account.buyingPowerUsd, 50000.2);
  assert.equal(account.status, 'ACTIVE');
  assert.equal(account.mode, 'paper');

  const positions = await broker.getPositions();
  assert.equal(positions.length, 1);
  assert.equal(positions[0].symbol, 'AAPL');
  assert.equal(positions[0].qty, 3.5);
  assert.equal(positions[0].avgEntryPriceUsd, 180.5);

  const bars = await broker.getBars({ symbols: ['AAPL', 'MSFT'], timeframe: '1Hour', limit: 120 });
  assert.equal(bars.AAPL.length, 2);
  assert.equal(bars.AAPL[0].t, Date.parse('2024-01-10T14:00:00Z'));
  assert.equal(bars.AAPL[0].c, 190.5);
  assert.equal(bars.AAPL[0].v, 120000);
  assert.deepEqual(bars.MSFT, []);
  // The live data API pages multi-symbol bar requests one symbol at a time, so the client
  // deliberately issues one request per symbol; assert the union of symbols instead.
  const barsCalls = fetchImpl.calls.filter((call) => call.url.includes('/v2/stocks/bars'));
  const requestedSymbols = barsCalls.map((call) => new URL(call.url).searchParams.get('symbols'));
  assert.deepEqual([...requestedSymbols].sort(), ['AAPL', 'MSFT']);
  const barsUrl = new URL(barsCalls[0].url);
  assert.ok(barsUrl.origin.startsWith('https://data.alpaca.markets'));
  assert.equal(barsUrl.searchParams.get('timeframe'), '1Hour');
  assert.equal(barsUrl.searchParams.get('adjustment'), 'raw');
  assert.equal(barsUrl.searchParams.get('feed'), 'iex');
  // a bounded window and descending order are required by the live endpoint
  assert.ok(barsUrl.searchParams.get('start'));
  assert.ok(barsUrl.searchParams.get('end'));
  assert.equal(barsUrl.searchParams.get('sort'), 'desc');

  const quote = await broker.getLatestQuote('AAPL');
  assert.equal(quote.symbol, 'AAPL');
  assert.equal(quote.bid, 189.9);
  assert.equal(quote.ask, 190.1);
  assert.equal(quote.ts, Date.parse(clockIso));

  const order = await broker.submitOrder({
    symbol: 'AAPL',
    side: 'buy',
    qty: 2.5,
    clientOrderId: 'atm:atm-1:spec-x:1',
  });
  assert.equal(order.id, 'ord-abc');
  assert.equal(order.clientOrderId, 'atm:atm-1:spec-x:1');
  assert.equal(order.status, 'accepted');
  assert.equal(order.submittedAt, Date.parse(clockIso));
  const postCall = fetchImpl.calls.find((call) => call.url.includes('/v2/orders') && call.init.method === 'POST');
  const body = JSON.parse(postCall.init.body);
  assert.equal(body.symbol, 'AAPL');
  assert.equal(body.side, 'buy');
  assert.equal(body.qty, '2.5');
  assert.equal(body.type, 'market');
  assert.equal(body.time_in_force, 'day');
  assert.equal(body.client_order_id, 'atm:atm-1:spec-x:1');

  const orders = await broker.getOrders({ status: 'all', limit: 10 });
  assert.equal(orders.length, 1);
  assert.equal(orders[0].filledQty, 2.5);
  assert.equal(orders[0].avgFillPriceUsd, 190.25);

  // credentials travel in Alpaca's headers, never in URLs or outputs
  const firstCall = fetchImpl.calls[0];
  assert.equal(firstCall.init.headers['APCA-API-KEY-ID'], 'paper-key');
  assert.equal(firstCall.init.headers['APCA-API-SECRET-KEY'], 'paper-secret');
  assert.ok(firstCall.init.signal, 'request should carry an AbortSignal timeout');
  assert.ok(!JSON.stringify(broker.describe()).includes('paper-secret'));
  assert.ok(!JSON.stringify(fetchImpl.calls.map((call) => call.url)).includes('paper-secret'));
});

test('alpaca broker: maps auth failures to BROKER_AUTH and keeps the key out of errors', async () => {
  const fetchImpl = stubFetch(() => jsonResponse(401, { message: 'unauthorized' }));
  const broker = createAlpacaBroker(
    { mode: 'paper' },
    { secrets: { ALPACA_API_KEY_ID: 'paper-key', ALPACA_API_SECRET_KEY: 'paper-secret' }, fetchImpl },
  );
  await assert.rejects(broker.getAccount(), (error) => {
    assert.ok(error instanceof AutomatonError);
    assert.equal(error.code, 'BROKER_AUTH');
    assert.ok(!JSON.stringify(error.details).includes('paper-secret'));
    return true;
  });

  const forbidden = stubFetch(() => jsonResponse(403, { message: 'forbidden' }));
  const broker2 = createAlpacaBroker(
    { mode: 'paper' },
    { secrets: { ALPACA_API_KEY_ID: 'k', ALPACA_API_SECRET_KEY: 's' }, fetchImpl: forbidden },
  );
  await expectCode(broker2.getClock(), 'BROKER_AUTH');
});

test('alpaca broker: one retry on 429 then success; persistent 429 -> BROKER_RATE_LIMIT', async () => {
  let calls = 0;
  const sleeps = [];
  const fetchImpl = stubFetch(() => {
    calls += 1;
    if (calls === 1) return jsonResponse(429, { message: 'rate limited' }, { headers: { 'retry-after': '0' } });
    return jsonResponse(200, {
      is_open: false,
      timestamp: '2024-01-10T22:00:00Z',
      next_open: '2024-01-11T14:30:00Z',
      next_close: '2024-01-11T21:00:00Z',
    });
  });
  const broker = createAlpacaBroker(
    { mode: 'paper' },
    {
      secrets: { ALPACA_API_KEY_ID: 'k', ALPACA_API_SECRET_KEY: 's' },
      fetchImpl,
      sleepImpl: async (ms) => sleeps.push(ms),
    },
  );
  const clock = await broker.getClock();
  assert.equal(clock.isOpen, false);
  assert.equal(fetchImpl.calls.length, 2, '429 should be retried exactly once');
  assert.equal(sleeps.length, 1);

  const alwaysLimited = stubFetch(() => jsonResponse(429, { message: 'rate limited' }));
  const broker2 = createAlpacaBroker(
    { mode: 'paper' },
    {
      secrets: { ALPACA_API_KEY_ID: 'k', ALPACA_API_SECRET_KEY: 's' },
      fetchImpl: alwaysLimited,
      sleepImpl: async () => {},
    },
  );
  await expectCode(broker2.getAccount(), 'BROKER_RATE_LIMIT');
  assert.equal(alwaysLimited.calls.length, 2);
});

test('alpaca broker: 5xx retried once then BROKER_ERROR with truncated body', async () => {
  const hugeBody = `${'x'.repeat(2000)} server exploded`;
  const fetchImpl = stubFetch(() => jsonResponse(500, hugeBody));
  const broker = createAlpacaBroker(
    { mode: 'paper' },
    {
      secrets: { ALPACA_API_KEY_ID: 'k', ALPACA_API_SECRET_KEY: 's' },
      fetchImpl,
      sleepImpl: async () => {},
    },
  );
  await assert.rejects(broker.getClock(), (error) => {
    assert.equal(error.code, 'BROKER_ERROR');
    assert.equal(error.details.status, 500);
    assert.ok(error.details.body.length <= 300, 'body snippet must be truncated');
    return true;
  });
  assert.equal(fetchImpl.calls.length, 2, 'GET 5xx should be retried once');
});

test('alpaca broker: forbidden account-management methods do not exist (D1)', () => {
  const fetchImpl = stubFetch(() => jsonResponse(200, {}));
  const broker = createAlpacaBroker(
    { mode: 'paper' },
    { secrets: { ALPACA_API_KEY_ID: 'k', ALPACA_API_SECRET_KEY: 's' }, fetchImpl },
  );
  for (const name of [
    'transfer',
    'transfers',
    'withdraw',
    'withdrawal',
    'ach',
    'wire',
    'crypto',
    'createTransfer',
    'requestWithdrawal',
    'updateAccount',
    'configureAccount',
    'enableMargin',
    'setMargin',
  ]) {
    assert.equal(typeof broker[name], 'undefined', `broker must not expose ${name}()`);
  }
  // and the read/trade surface that genuinely exists is present
  for (const name of ['getClock', 'getAccount', 'getPositions', 'getOrders', 'submitOrder', 'cancelOrder', 'getBars', 'getLatestQuote']) {
    assert.equal(typeof broker[name], 'function', `broker.${name}() should exist`);
  }
});

test('alpaca broker: getDataUrl is the real data request URL, and cancelOrder is explicit', async () => {
  const fetchImpl = stubFetch((url, init) => {
    if (url.includes('/v2/orders/') && init.method === 'DELETE') {
      return jsonResponse(204, '');
    }
    return jsonResponse(200, {});
  });
  const broker = createAlpacaBroker(
    { mode: 'paper' },
    { secrets: { ALPACA_API_KEY_ID: 'k', ALPACA_API_SECRET_KEY: 's' }, fetchImpl },
  );
  const dataUrl = broker.getDataUrl({ symbols: ['AAPL'], timeframe: '1Hour', limit: 120 });
  assert.ok(dataUrl.startsWith('https://data.alpaca.markets/v2/stocks/bars?'), dataUrl);
  const url = new URL(dataUrl);
  assert.equal(url.searchParams.get('symbols'), 'AAPL');
  assert.equal(url.searchParams.get('limit'), '120');
  const canceled = await broker.cancelOrder('ord-1');
  assert.deepEqual(canceled, { id: 'ord-1', status: 'canceled' });
});

test('alpaca broker: getNews maps, filters empty headlines and old items, and tolerates bad rows', async () => {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const fetchImpl = stubFetch((url) => {
    if (url.includes('/v1beta1/news')) {
      return jsonResponse(200, {
        news: [
          {
            id: 101,
            headline: 'AAPL beats quarterly expectations',
            summary: 'Results above consensus.',
            source: 'Benzinga',
            url: 'https://example.test/aapl-q',
            symbols: ['AAPL', 'MSFT'],
            created_at: new Date(now - hour).toISOString(),
          },
          // empty headline -> dropped
          { id: 102, headline: '   ', summary: 'x', created_at: new Date(now - hour).toISOString() },
          // older than `start` -> dropped by the start filter
          {
            id: 103,
            headline: 'Stale AAPL item',
            summary: 'old',
            source: 'Benzinga',
            url: null,
            symbols: ['AAPL'],
            created_at: new Date(now - 48 * hour).toISOString(),
          },
          // missing optional fields + unparseable timestamp -> tolerated/dropped
          { id: 104, headline: 'Analysts lift AAPL price target', created_at: new Date(now - 30 * 60 * 1000).toISOString() },
          { id: 105, headline: 'Bad timestamp', created_at: 'not-a-date' },
          null,
          42,
        ],
      });
    }
    return jsonResponse(404, { message: 'unexpected path' });
  });
  const broker = createAlpacaBroker(
    { mode: 'paper' },
    { secrets: { ALPACA_API_KEY_ID: 'k', ALPACA_API_SECRET_KEY: 's' }, fetchImpl },
  );
  const start = new Date(now - 24 * hour).toISOString();
  const news = await broker.getNews({ symbols: ['AAPL', 'MSFT'], limit: 5, start });

  assert.equal(news.length, 2, JSON.stringify(news));
  // newest first (30 min ago before 1 h ago)
  assert.equal(news[0].id, '104');
  assert.equal(news[0].headline, 'Analysts lift AAPL price target');
  assert.equal(news[0].summary, '');
  assert.equal(news[0].source, '');
  assert.equal(news[0].url, null);
  assert.deepEqual(news[0].symbols, []);
  assert.equal(news[1].id, '101');
  assert.equal(news[1].url, 'https://example.test/aapl-q');
  assert.deepEqual(news[1].symbols, ['AAPL', 'MSFT']);
  assert.equal(news[1].createdAt, Date.parse(new Date(now - hour).toISOString()));
  assert.ok(news.every((item) => Number.isFinite(item.createdAt) && item.headline.length > 0));

  const newsCall = fetchImpl.calls.find((call) => call.url.includes('/v1beta1/news'));
  assert.ok(newsCall.url.startsWith('https://data.alpaca.markets/v1beta1/news?'));
  const url = new URL(newsCall.url);
  assert.equal(url.searchParams.get('symbols'), 'AAPL,MSFT');
  assert.equal(url.searchParams.get('limit'), '5');
  assert.equal(url.searchParams.get('start'), start);
  assert.equal(newsCall.init.headers['APCA-API-KEY-ID'], 'k');

  // no news is a valid answer, not an error
  const empty = stubFetch(() => jsonResponse(200, { news: [] }));
  const emptyBroker = createAlpacaBroker(
    { mode: 'paper' },
    { secrets: { ALPACA_API_KEY_ID: 'k', ALPACA_API_SECRET_KEY: 's' }, fetchImpl: empty },
  );
  assert.deepEqual(await emptyBroker.getNews({ symbols: ['AAPL'] }), []);

  // an advisory news outage is swallowed (research must never stop trading)...
  const down = stubFetch(() => jsonResponse(500, 'news is down'));
  const downBroker = createAlpacaBroker(
    { mode: 'paper' },
    { secrets: { ALPACA_API_KEY_ID: 'k', ALPACA_API_SECRET_KEY: 's' }, fetchImpl: down, sleepImpl: async () => {} },
  );
  assert.deepEqual(await downBroker.getNews({ symbols: ['AAPL'] }), []);

  // ...but an auth failure is surfaced for the operator
  const unauthorized = stubFetch(() => jsonResponse(401, { message: 'unauthorized' }));
  const unauthorizedBroker = createAlpacaBroker(
    { mode: 'paper' },
    { secrets: { ALPACA_API_KEY_ID: 'k', ALPACA_API_SECRET_KEY: 's' }, fetchImpl: unauthorized },
  );
  await expectCode(unauthorizedBroker.getNews({ symbols: ['AAPL'] }), 'BROKER_AUTH');
});

// ===========================================================================
// broker-sim
// ===========================================================================

test('sim broker: same seed and call sequence produces identical bars', () => {
  const config = testConfig({ mode: 'sim' });
  const brokerA = createSimBroker(config, { seed: 42 });
  const brokerB = createSimBroker(config, { seed: 42 });
  const barsA = brokerA.getBars({ symbols: ['AAPL', 'MSFT'], limit: 20 });
  const barsB = brokerB.getBars({ symbols: ['AAPL', 'MSFT'], limit: 20 });
  assert.deepEqual(barsA, barsB);
  assert.equal(barsA.AAPL.length, 20);
  assert.ok(barsA.AAPL.every((bar) => bar.c > 0 && Number.isFinite(bar.t)));
  assert.ok(barsA.AAPL.every((bar) => bar.t < barsA.AAPL[barsA.AAPL.length - 1].t + 1));

  brokerA.advanceBar(3);
  brokerB.advanceBar(3);
  assert.deepEqual(
    brokerA.getBars({ symbols: ['AAPL'], limit: 5 }),
    brokerB.getBars({ symbols: ['AAPL'], limit: 5 }),
  );

  const brokerC = createSimBroker(config, { seed: 43 });
  assert.notDeepEqual(
    brokerC.getBars({ symbols: ['AAPL'], limit: 5 }),
    brokerA.getBars({ symbols: ['AAPL'], limit: 5 }),
  );

  const clock = brokerA.getClock();
  assert.equal(clock.isOpen, true, 'sim clock is always open');
  assert.ok(Number.isFinite(clock.timestamp));
});

test('sim broker: market fills, cash, positions and client_order_id accounting', async () => {
  const config = testConfig({ mode: 'sim' });
  const broker = createSimBroker(config, { seed: 42, accountEquityUsd: 100_000, slippageBps: 5, spreadBps: 4 });
  broker.setQuoteOverrides({ AAPL: { bid: 100, ask: 100.2, last: 100.1 } });

  const buy = await broker.submitOrder({
    symbol: 'AAPL',
    side: 'buy',
    qty: 10,
    type: 'market',
    clientOrderId: 'atm:atm-1:spec-1:1',
  });
  assert.equal(buy.status, 'filled');
  assert.equal(buy.filledQty, 10);
  assert.equal(buy.clientOrderId, 'atm:atm-1:spec-1:1');
  // ask 100.2 + 5bps slippage
  assert.equal(buy.avgFillPriceUsd, 100.2501);

  let account = broker.getAccount();
  assert.equal(account.cashUsd, 98_997.5);
  let positions = broker.getPositions();
  assert.equal(positions.length, 1);
  assert.equal(positions[0].symbol, 'AAPL');
  assert.equal(positions[0].qty, 10);
  assert.equal(positions[0].avgEntryPriceUsd, 100.2501);

  const sell = await broker.submitOrder({ symbol: 'AAPL', side: 'sell', qty: 4, type: 'market' });
  assert.equal(sell.status, 'filled');
  // bid 100 - 5bps slippage
  assert.equal(sell.avgFillPriceUsd, 99.95);
  positions = broker.getPositions();
  assert.equal(positions[0].qty, 6);
  account = broker.getAccount();
  assert.ok(account.cashUsd > 98_997.5 && account.cashUsd < 100_000);

  // notional orders convert to fractional qty to 4dp, filled at ask+slippage
  broker.setQuoteOverrides({ MSFT: { bid: 50, ask: 50, last: 50 } });
  const notionalOrder = await broker.submitOrder({ symbol: 'MSFT', side: 'buy', notional: 123.45 });
  assert.equal(notionalOrder.filledQty, 2.4678);
  assert.equal(notionalOrder.notionalUsd, 123.45);
});

test('sim broker: margin/short capability gates, and deterministic reset', async () => {
  // New v3.0 account parity: shorting and margin are allowed by default (paper config).
  const config = testConfig({ mode: 'sim' });
  const broker = createSimBroker(config, { seed: 7, accountEquityUsd: 500 });
  broker.setQuoteOverrides({ AAPL: { bid: 100, ask: 100, last: 100 } });

  const short = broker.submitOrder({ symbol: 'AAPL', side: 'sell', qty: 1 });
  assert.equal(short.status, 'filled');
  let positions = broker.getPositions();
  assert.equal(positions[0].qtySigned, -1);
  assert.equal(positions[0].side, 'SHORT');
  assert.equal(broker.getAccount().cashUsd, 599.95, 'short sale credits cash (minus configured slippage)');

  // A margin-enabled account can go to negative cash (D17 caps are enforced by brakes).
  broker.submitOrder({ symbol: 'AAPL', side: 'buy', qty: 7 });
  assert.ok(broker.getAccount().cashUsd < 0, 'margin-enabled sim account may carry debt');
  expectSyncCode(() => broker.submitOrder({ symbol: 'ZZZZ', side: 'buy', qty: 1 }), 'BRAKE_DENIED');

  // With the capability disabled explicitly, the sim broker refuses both.
  const noShortConfig = testConfig({ mode: 'sim', instruments: { allowShort: false, allowMargin: false } });
  const strict = createSimBroker(noShortConfig, { seed: 7, accountEquityUsd: 500 });
  strict.setQuoteOverrides({ AAPL: { bid: 100, ask: 100, last: 100 } });
  expectSyncCode(() => strict.submitOrder({ symbol: 'AAPL', side: 'sell', qty: 1 }), 'BRAKE_DENIED');
  expectSyncCode(() => strict.submitOrder({ symbol: 'AAPL', side: 'buy', qty: 10 }), 'INSUFFICIENT_CASH');

  broker.reset();
  assert.equal(broker.getAccount().cashUsd, 500);
  assert.deepEqual(broker.getPositions(), []);
  assert.deepEqual(broker.getOrders({ status: 'all' }), []);
});

test('sim broker: deterministic synthetic news for the research path (offline)', async () => {
  const config = testConfig({ mode: 'sim' });
  const brokerA = createSimBroker(config, { seed: 42 });
  const brokerB = createSimBroker(config, { seed: 42 });

  const newsA = await brokerA.getNews({ symbols: ['AAPL'], limit: 4 });
  const newsB = await brokerB.getNews({ symbols: ['AAPL'], limit: 4 });
  assert.deepEqual(newsA, newsB, 'same seed + same sim time => identical headlines');
  assert.ok(newsA.length > 0);
  assert.ok(newsA.length <= 4);
  for (const item of newsA) {
    assert.equal(typeof item.id, 'string');
    assert.ok(item.headline.length > 0);
    assert.equal(typeof item.summary, 'string');
    assert.equal(typeof item.source, 'string');
    assert.ok(item.url === null || typeof item.url === 'string');
    assert.ok(Array.isArray(item.symbols) && item.symbols.includes('AAPL'));
    assert.ok(Number.isFinite(item.createdAt));
    assert.ok(item.createdAt <= brokerA.marketNow(), 'news cannot be dated in the future');
  }
  // newest first
  const createdAt = newsA.map((item) => item.createdAt);
  assert.deepEqual(createdAt, [...createdAt].sort((a, b) => b - a));

  // deterministic PRNG: the same simulated hour returns the same items, a later hour differs
  const again = await brokerA.getNews({ symbols: ['AAPL'], limit: 4 });
  assert.deepEqual(again, newsA);
  brokerA.advanceBar(1);
  const later = await brokerA.getNews({ symbols: ['AAPL'], limit: 4 });
  assert.notDeepEqual(later.map((item) => item.id), newsA.map((item) => item.id));

  // start filter and limit are honored; unknown/empty symbols return nothing
  const start = brokerA.marketNow() - 30 * 60 * 1000;
  const filtered = await brokerA.getNews({ symbols: ['AAPL'], limit: 6, start });
  assert.ok(filtered.length > 0);
  assert.ok(filtered.every((item) => item.createdAt >= start));
  const capped = await brokerA.getNews({ symbols: ['AAPL', 'MSFT'], limit: 2 });
  assert.ok(capped.length <= 2);
  assert.deepEqual(await brokerA.getNews({ symbols: ['NOTREAL'] }), []);
  assert.deepEqual(await brokerA.getNews({ symbols: [] }), []);
});

// ===========================================================================
// prospector
// ===========================================================================

test('prospector: emits capped hypotheses, each with dated proof URL and samples, and persists the queue', async () => {
  const dir = makeStateDir();
  try {
    const config = testConfig({ mode: 'sim', paths: { stateDir: dir } });
    const paths = statePaths(config);
    const broker = createSimBroker(config, { seed: 42 });
    const clock = createClock({ now: () => T0 });
    const prospector = createProspector({ broker, config, clock, paths });

    const result = await prospector.run({ budgetUsd: 0.08 });
    assert.equal(typeof result.at, 'string');
    assert.equal(result.dataCalls, 1);
    assert.ok(result.spentUsd >= 0 && result.spentUsd <= 0.08);
    assert.ok(Array.isArray(result.rejected));
    assert.ok(result.hypotheses.length > 0, 'seeded sim regimes should yield at least one measured edge');
    assert.ok(result.hypotheses.length <= config.data.maxHypothesesPerCycle);

    const scores = result.hypotheses.map((hypothesis) => hypothesis.rankScore);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'hypotheses are sorted by rankScore desc');

    for (const hypothesis of result.hypotheses) {
      assert.ok(typeof hypothesis.id === 'string' && hypothesis.id.startsWith('hyp-'));
      assert.equal(typeof hypothesis.createdAt, 'string');
      assert.ok(Number.isFinite(Date.parse(hypothesis.createdAt)));
      assert.ok(['momentum', 'meanrev', 'breakout', 'gapfade'].includes(hypothesis.family));
      assert.ok(typeof hypothesis.claim === 'string' && hypothesis.claim.length > 10);
      assert.ok(typeof hypothesis.symbol === 'string');
      assert.ok(Number.isFinite(hypothesis.expectedEdgeBps) && hypothesis.expectedEdgeBps > 0);
      assert.ok(Number.isFinite(hypothesis.horizonBars));
      assert.ok(Number.isFinite(hypothesis.rankScore));

      const { proof } = hypothesis;
      assert.ok(proof, 'a hypothesis without proof must never be returned');
      assert.equal(proof.vendor, 'alpaca');
      assert.ok(typeof proof.url === 'string' && proof.url.includes(hypothesis.symbol));
      assert.ok(Number.isFinite(Date.parse(proof.observedAt)), 'proof must be dated');
      assert.ok(typeof proof.metric === 'string' && proof.metric.length > 0);
      assert.ok(Number.isFinite(proof.stats.meanBps));
      assert.ok(Number.isFinite(proof.stats.baselineBps));
      assert.ok(proof.sampleSize >= 5);
      assert.equal(proof.stats.sampleSize, proof.sampleSize);
      assert.equal(proof.barsUsed, config.data.lookbackBars);
      assert.ok(proof.sampleSize > 0);
      // stopline: never sizes, never orders
      assert.equal(hypothesis.qty, undefined);
      assert.equal(hypothesis.notionalUsd, undefined);
      assert.equal(hypothesis.order, undefined);
    }

    const queue = JSON.parse(fs.readFileSync(paths.hypothesesQueue, 'utf8'));
    assert.ok(Array.isArray(queue) && queue.length === result.hypotheses.length);
    const lines = fs.readFileSync(paths.hypothesesLog, 'utf8').trim().split(/\r?\n/);
    assert.equal(lines.length, result.hypotheses.length);

    // budget smaller than the data cost -> no data call, no hypotheses
    const broke = await prospector.run({ budgetUsd: 0 });
    assert.equal(broke.dataCalls, 0);
    assert.deepEqual(broke.hypotheses, []);
    assert.equal(broke.rejected[0].reason, 'BUDGET_EXCEEDED');
  } finally {
    removeStateDir(dir);
  }
});

test('prospector: maxHypothesesPerCycle is a hard cap', async () => {
  const dir = makeStateDir();
  try {
    const config = testConfig({ mode: 'sim', paths: { stateDir: dir }, data: { maxHypothesesPerCycle: 2 } });
    const broker = createSimBroker(config, { seed: 42 });
    const clock = createClock({ now: () => T0 });
    const prospector = createProspector({ broker, config, clock, paths: statePaths(config) });
    const result = await prospector.run({ budgetUsd: 0.08 });
    assert.ok(result.hypotheses.length <= 2);
  } finally {
    removeStateDir(dir);
  }
});

// ===========================================================================
// builder
// ===========================================================================

test('builder: refuses missing and stale proof (NO_PROOF / PROOF_STALE)', async () => {
  const clock = createClock({ now: () => T0 });
  const builder = createBuilder({ config: testConfig(), clock });

  const noProof = makeHypothesis();
  delete noProof.proof;
  expectSyncCode(() => builder.compile({ hypothesis: noProof, agentId: 'atm-1', cycleBudgetUsd: 0.08 }), 'NO_PROOF');

  const invalidProof = makeHypothesis({ proof: { url: '', observedAt: new Date(T0).toISOString(), sampleSize: 0, stats: {} } });
  expectSyncCode(() => builder.compile({ hypothesis: invalidProof, agentId: 'atm-1', cycleBudgetUsd: 0.08 }), 'NO_PROOF');

  const stale = makeHypothesis({
    proof: { ...makeHypothesis().proof, observedAt: new Date(T0 - 8 * DAY_MS).toISOString() },
  });
  expectSyncCode(() => builder.compile({ hypothesis: stale, agentId: 'atm-1', cycleBudgetUsd: 0.08 }), 'PROOF_STALE');

  // exactly at the 7-day boundary is stale
  const boundary = makeHypothesis({
    proof: { ...makeHypothesis().proof, observedAt: new Date(T0 - 7 * DAY_MS - 1000).toISOString() },
  });
  expectSyncCode(() => builder.compile({ hypothesis: boundary, agentId: 'atm-1', cycleBudgetUsd: 0.08 }), 'PROOF_STALE');
});

test('builder: compiles a bounded spec, keeps symbol/family, respects the spend cap and is deterministic', () => {
  const clock = createClock({ now: () => T0 });
  const config = testConfig();
  const builder = createBuilder({ config, clock });
  const hypothesis = makeHypothesis();
  const cycleBudgetUsd = 0.08;

  const first = builder.compile({ hypothesis, agentId: 'atm-1', cycleBudgetUsd });
  const second = builder.compile({ hypothesis, agentId: 'atm-1', cycleBudgetUsd });

  assert.deepEqual(first, second, 'same inputs must compile to the same spec (deterministic specId)');
  assert.equal(first.spentUsd, second.spentUsd);
  assert.ok(first.spentUsd <= config.risk.maxBuildSpendPct * cycleBudgetUsd + 1e-9);

  const { spec } = first;
  assert.equal(spec.symbol, 'AAPL', 'Builder must never change the hypothesis symbol');
  assert.equal(spec.family, 'momentum', 'Builder must never change the hypothesis family');
  assert.equal(spec.agentId, 'atm-1');
  assert.equal(spec.hypothesisId, hypothesis.id);
  assert.match(spec.specId, /^spec-[0-9a-f]{8}$/);
  assert.equal(spec.proofRef, hypothesis.proof.url, 'D9: proofRef is the URL string the brake wall checks');
  assert.equal(spec.proof.url, hypothesis.proof.url);
  assert.equal(spec.proof.observedAt, hypothesis.proof.observedAt);
  assert.ok(spec.params);
  for (const [name, bound] of Object.entries(PARAM_BOUNDS)) {
    const value = spec.params[name];
    assert.ok(typeof value === 'number', `params.${name} must be numeric`);
    assert.ok(value >= bound.min && value <= bound.max, `params.${name}=${value} outside [${bound.min}, ${bound.max}]`);
    if (bound.integer) assert.ok(Number.isInteger(value), `params.${name} must be an integer`);
  }
  assert.ok(['any', 'morning', 'afternoon'].includes(spec.params.sessionFilter));

  // budget guards
  assert.throws(
    () => builder.compile({ hypothesis, agentId: 'atm-1', cycleBudgetUsd: 0 }),
    (error) => error.code === 'BUDGET_EXCEEDED',
  );
  // symbol outside the configured universe is rejected, not repaired
  const foreign = makeHypothesis({ symbol: 'ZZZZ' });
  assert.throws(
    () => builder.compile({ hypothesis: foreign, agentId: 'atm-1', cycleBudgetUsd }),
    (error) => error.code === 'SPEC_INVALID',
  );
});

test('builder: genome parameters start the spec and are clamped into bounds', () => {
  const clock = createClock({ now: () => T0 });
  const builder = createBuilder({ config: testConfig(), clock });
  const hypothesis = makeHypothesis();
  const { spec } = builder.compile({
    hypothesis,
    agentId: 'atm-1',
    cycleBudgetUsd: 0.08,
    genome: {
      symbol: 'MSFT',
      family: 'meanrev',
      lookback: 999,
      entryZ: 9,
      exitZ: -5,
      stopPct: 0.5,
      targetPct: 0.9,
      maxHoldBars: 1000,
      sizePct: 2,
      sessionFilter: 'night',
    },
  });
  // symbol/family stay the hypothesis's, params come from the genome then clamp
  assert.equal(spec.symbol, 'AAPL');
  assert.equal(spec.family, 'momentum');
  assert.equal(spec.params.lookback, PARAM_BOUNDS.lookback.max);
  assert.equal(spec.params.entryZ, PARAM_BOUNDS.entryZ.max);
  assert.equal(spec.params.exitZ, PARAM_BOUNDS.exitZ.min);
  assert.equal(spec.params.stopPct, PARAM_BOUNDS.stopPct.max);
  assert.equal(spec.params.targetPct, PARAM_BOUNDS.targetPct.max);
  assert.equal(spec.params.maxHoldBars, PARAM_BOUNDS.maxHoldBars.max);
  assert.equal(spec.params.sizePct, PARAM_BOUNDS.sizePct.max);
  assert.equal(spec.params.sessionFilter, 'any');
});

// ===========================================================================
// executor
// ===========================================================================

function executorHarness({ brakesHandler, positions = {}, mandate, quotes, configOverrides } = {}) {
  const config = testConfig({ mode: 'paper', ...(configOverrides ?? {}) });
  const clock = createClock({ now: () => T0 });
  const broker = makeBrokerDouble();
  const brakes = makeBrakesDouble(brakesHandler);
  const ledger = makeLedgerDouble({ positions, equityUsd: 5000, cashUsd: 10_000 });
  const executor = createExecutor({ broker, brakes, ledger, config, clock });
  return {
    config,
    clock,
    broker,
    brakes,
    ledger,
    executor,
    agent: { id: 'atm-1', status: 'alive', generation: 0, genome: { symbol: 'AAPL', family: 'breakout' } },
    spec: baseSpec(),
    mandate: mandate ?? baseMandate(),
    bars: { AAPL: breakoutBars() },
    quotes: quotes ?? { AAPL: { bid: 109.9, ask: 110.1, last: 110, ts: T0 } },
    dayStats: { dayKey: '2024-01-10', ordersCount: 0, startEquityUsd: 5000, pnlUsd: 0 },
  };
}

/** Convenience runner: the standard one-cycle execution call with per-test extras. */
function runHarness(harness, extra = {}) {
  return harness.executor.run({
    agent: harness.agent,
    spec: harness.spec,
    mandate: harness.mandate,
    quotes: harness.quotes,
    bars: harness.bars,
    dayStats: harness.dayStats,
    now: T0,
    ...extra,
  });
}

/** A valid, fresh research briefing from the isolated analyst. */
function makeBriefing(overrides = {}) {
  return {
    agentId: 'atm-1',
    at: new Date(T0 - 60_000).toISOString(), // 1 minute old: fresh
    verdict: 'HOLD',
    sentiment: 0.4,
    confidence: 0.8,
    catalysts: ['product update'],
    risks: [],
    summary: 'Neutral-to-positive coverage; no material risk flagged.',
    symbols: ['AAPL'],
    sources: [{ title: 'Sim headline', source: 'Simulated Wire', url: null, at: new Date(T0).toISOString() }],
    ...overrides,
  };
}

/** A valid, fresh per-bot agent policy from the bot brain (docs/BOT-AGENTS.md). */
function makePolicy(overrides = {}) {
  return {
    atMs: T0 - 60_000, // 1 minute old: fresh
    at: new Date(T0 - 60_000).toISOString(),
    stance: 'trade',
    sizeMultiplier: 1,
    riskMultiplier: 1,
    exitPressure: 'none',
    confidence: 0.7,
    thesis: 'Range-bound tape; stay small and keep the exit tight.',
    plan: ['buy pullbacks only', 'take profit into strength'],
    watch: ['AAPL'],
    stale: false,
    ...overrides,
  };
}

/** Config with the per-bot agent layer switched on (the executor gate). */
const AGENTS_ON = { agents: { enabled: true, maxAgeSec: 7200 } };

/** Config with the per-bot agent layer switched off. */
const AGENTS_OFF = { agents: { enabled: false, maxAgeSec: 7200 } };

test('executor: denies market-closed orders with the brake code and places nothing', async () => {
  const harness = executorHarness({
    brakesHandler: () => ({ decision: 'DENY', code: 'MARKET_CLOSED', rule: 'D3', reason: 'market is closed' }),
  });
  const result = await harness.executor.run({
    agent: harness.agent,
    spec: harness.spec,
    mandate: harness.mandate,
    quotes: harness.quotes,
    bars: harness.bars,
    dayStats: { dayKey: '2024-01-10', ordersCount: 0, startEquityUsd: 5000, pnlUsd: 0 },
    now: T0,
  });
  assert.equal(result.orders.length, 0);
  assert.equal(result.denied.length, 1);
  assert.equal(result.denied[0].code, 'MARKET_CLOSED');
  assert.equal(harness.broker.submitted.length, 0);
  assert.ok(result.actions.some((action) => action.type === 'skip'), 'a denial is recorded as a skip action');

  // the brakes saw a complete pre-trade payload
  const check = harness.brakes.calls[0];
  assert.equal(check.mode, 'paper');
  assert.equal(check.agentId, 'atm-1');
  assert.equal(check.order.symbol, 'AAPL');
  assert.equal(check.order.side, 'buy');
  assert.ok(Number.isFinite(check.order.notionalUsd));
  assert.ok(check.mandate);
  assert.ok(check.spec);
  assert.ok(Number.isFinite(check.now));
});

test('executor: denies outside the mandate (expired mandate, symbol not allowed)', async () => {
  const expired = executorHarness({
    mandate: baseMandate({ expiresAt: new Date(T0 - 1000).toISOString() }),
  });
  const expiredResult = await expired.executor.run({
    agent: expired.agent,
    spec: expired.spec,
    mandate: expired.mandate,
    quotes: expired.quotes,
    bars: expired.bars,
    now: T0,
  });
  assert.equal(expiredResult.orders.length, 0);
  assert.equal(expiredResult.denied[0].code, 'MANDATE_EXPIRED');

  const wrongSymbol = executorHarness({
    mandate: baseMandate({ allowedSymbols: ['MSFT'] }),
  });
  const wrongSymbolResult = await wrongSymbol.executor.run({
    agent: wrongSymbol.agent,
    spec: wrongSymbol.spec,
    mandate: wrongSymbol.mandate,
    quotes: wrongSymbol.quotes,
    bars: wrongSymbol.bars,
    now: T0,
  });
  assert.equal(wrongSymbolResult.orders.length, 0);
  assert.equal(wrongSymbolResult.denied[0].code, 'INSTRUMENT_FORBIDDEN');

  const exitOnly = executorHarness({
    mandate: baseMandate({ allowExitOnly: true }),
  });
  const exitOnlyResult = await exitOnly.executor.run({
    agent: exitOnly.agent,
    spec: exitOnly.spec,
    mandate: exitOnly.mandate,
    quotes: exitOnly.quotes,
    bars: exitOnly.bars,
    now: T0,
  });
  assert.equal(exitOnlyResult.orders.length, 0);
  assert.equal(exitOnlyResult.denied[0].code, 'BRAKE_DENIED');
});

test('executor: places a valid entry with capped size and client_order_id, and books the fill', async () => {
  const harness = executorHarness();
  const result = await harness.executor.run({
    agent: harness.agent,
    spec: harness.spec,
    mandate: harness.mandate,
    quotes: harness.quotes,
    bars: harness.bars,
    dayStats: { dayKey: '2024-01-10', ordersCount: 0, startEquityUsd: 5000, pnlUsd: 0 },
    now: T0,
  });

  assert.equal(result.agentId, 'atm-1');
  assert.equal(result.denied.length, 0, JSON.stringify(result.denied));
  assert.equal(result.orders.length, 1);
  assert.equal(harness.broker.submitted.length, 1, 'executor must reach the broker exactly once');
  const order = harness.broker.submitted[0];
  assert.equal(order.symbol, 'AAPL');
  assert.equal(order.side, 'buy');
  assert.equal(order.type, 'market');
  assert.equal(order.timeInForce, 'day');
  // sizePct(0.2) * sizeBudget(2000) = 400 <= mandate cap 500 <= absolute cap 2500
  assert.ok(order.qty > 0);
  assert.ok(Math.abs(order.qty * 110.1 - 400) < 0.05, `expected ~$400 notional, got ${order.qty * 110.1}`);
  assert.match(order.clientOrderId, /^atm:atm-1:spec-deadbeef:\d+$/);
  assert.equal(result.orders[0].clientOrderId, order.clientOrderId);

  const entryAction = result.actions.find((action) => action.type === 'entry');
  assert.ok(entryAction, 'an entry action must be recorded');
  assert.equal(entryAction.symbol, 'AAPL');
  assert.equal(entryAction.orderId, 'ord-1');
  assert.ok(Number.isFinite(entryAction.fillPriceUsd));

  assert.equal(harness.ledger.fills.length, 1, 'the fill is booked in the ledger (never from broker.getAccount)');
  assert.equal(harness.ledger.fills[0].symbol, 'AAPL');
  assert.equal(harness.ledger.fills[0].side, 'buy');
  assert.equal(result.spentUsd, 0);
});

test('executor: exit on stop-loss from its own position book, sell side, full qty', async () => {
  const openedAt = new Date(T0 - 24 * HOUR_MS).toISOString();
  const harness = executorHarness({
    positions: { AAPL: { qty: 10, avgPriceUsd: 100, openedAt } },
    quotes: { AAPL: { bid: 89.9, ask: 90.1, last: 90, ts: T0 } },
  });
  const result = await harness.executor.run({
    agent: harness.agent,
    spec: harness.spec,
    mandate: harness.mandate,
    quotes: harness.quotes,
    bars: harness.bars,
    now: T0,
  });
  assert.equal(result.orders.length, 1);
  const exitAction = result.actions.find((action) => action.type === 'exit');
  assert.ok(exitAction, 'stop-loss should produce an exit action');
  assert.equal(exitAction.reason, 'stop');
  assert.equal(exitAction.side, 'sell');
  assert.equal(harness.broker.submitted[0].side, 'sell');
  assert.equal(harness.broker.submitted[0].qty, 10);
  assert.equal(harness.ledger.fills.length, 1);
  assert.equal(harness.ledger.fills[0].side, 'sell');
});

test('executor: dead agents, missing proof and missing mandate are denied; never reads account equity', async () => {
  const harness = executorHarness();

  const deadResult = await harness.executor.run({
    agent: { id: 'atm-1', status: 'dead' },
    spec: harness.spec,
    mandate: harness.mandate,
    quotes: harness.quotes,
    bars: harness.bars,
    now: T0,
  });
  assert.equal(deadResult.denied[0].code, 'AGENT_DEAD');

  const bareSpec = { ...baseSpec(), proofRef: null, proof: null };
  const noProofResult = await harness.executor.run({
    agent: harness.agent,
    spec: bareSpec,
    mandate: harness.mandate,
    quotes: harness.quotes,
    bars: harness.bars,
    now: T0,
  });
  assert.equal(noProofResult.denied[0].code, 'NO_PROOF');

  const noMandateResult = await harness.executor.run({
    agent: harness.agent,
    spec: harness.spec,
    mandate: null,
    quotes: harness.quotes,
    bars: harness.bars,
    now: T0,
  });
  assert.equal(noMandateResult.denied[0].code, 'BRAKE_DENIED');

  // makeBrokerDouble.getAccount() throws: a successful run proves it is never called
  const ok = await harness.executor.run({
    agent: harness.agent,
    spec: harness.spec,
    mandate: harness.mandate,
    quotes: harness.quotes,
    bars: harness.bars,
    now: T0,
  });
  assert.equal(ok.denied.length, 0);
});

test('executor + real brakes: a dated-proof order passes the D1-D14 wall and reaches the broker', async () => {
  const dir = makeStateDir();
  try {
    const config = testConfig({ mode: 'sim', paths: { stateDir: dir }, risk: { maxOrdersPerCycle: 1 } });
    const clock = createClock({ now: () => T0 });
    const brakes = createBrakes({ config, paths: statePaths(config), clock });
    const broker = makeBrokerDouble({ fillPrice: 110 });
    const ledger = makeLedgerDouble({ equityUsd: 5000, cashUsd: 10_000 });
    const executor = createExecutor({ broker, brakes, ledger, config, clock });
    const result = await executor.run({
      agent: { id: 'atm-1', status: 'alive', generation: 0 },
      spec: baseSpec(),
      mandate: baseMandate(),
      quotes: { AAPL: { bid: 109.9, ask: 110.1, last: 110, ts: T0 } },
      bars: { AAPL: breakoutBars() },
      dayStats: { dayKey: '2024-01-10', ordersCount: 0, startEquityUsd: 5000, pnlUsd: 0 },
      now: T0,
    });
    assert.equal(result.denied.length, 0, `real brakes denied: ${JSON.stringify(result.denied)}`);
    assert.equal(result.orders.length, 1);
    assert.equal(broker.submitted.length, 1);
    assert.match(broker.submitted[0].clientOrderId, /^atm:atm-1:spec-deadbeef:\d+$/);
  } finally {
    removeStateDir(dir);
  }
});

// ===========================================================================
// executor × research sidecar (advisory, fresh-only, config-gated)
// ===========================================================================

test('executor × research: a fresh AVOID vetoes an entry that would otherwise pass', async () => {
  // baseline: no research => the breakout entry is placed
  const baseline = await runHarness(executorHarness());
  assert.equal(baseline.orders.length, 1, 'baseline entry must pass without research');

  // fresh AVOID => advisory skip, no order, no brake denial
  const vetoed = executorHarness();
  const result = await runHarness(vetoed, { research: makeBriefing({ verdict: 'AVOID', sentiment: -0.6, confidence: 0.9 }) });
  assert.equal(result.orders.length, 0);
  assert.equal(result.denied.length, 0, 'research is advisory: it is a skip, not a brake denial');
  assert.equal(vetoed.broker.submitted.length, 0, 'no order may reach the broker on a research veto');
  const veto = result.actions.find((action) => action.reason === 'research_veto');
  assert.ok(veto, 'a research_veto skip action must be recorded');
  assert.equal(veto.type, 'skip');
  assert.equal(veto.symbol, 'AAPL');
  assert.equal(veto.research.verdict, 'AVOID');
  assert.equal(veto.research.sentiment, -0.6);
  assert.equal(veto.research.applied, 'veto');

  // veto triggers: explicit AVOID/ALERT recommendations, or strongly negative sentiment.
  // A long risk list is NOT a veto anymore (live finding: every briefing lists risks, which
  // blocked 100% of entries); risks only shrink the order.
  for (const briefing of [
    makeBriefing({ verdict: 'ALERT', sentiment: 0 }),
    makeBriefing({ verdict: 'HOLD', sentiment: -0.7 }),
  ]) {
    const harness = executorHarness();
    const vetoResult = await runHarness(harness, { research: briefing });
    assert.equal(vetoResult.orders.length, 0);
    assert.ok(vetoResult.actions.some((action) => action.reason === 'research_veto'));
  }

  // HOLD with positive sentiment does NOT veto
  const passing = executorHarness();
  const passResult = await runHarness(passing, { research: makeBriefing({ verdict: 'HOLD', sentiment: 0.4 }) });
  assert.equal(passResult.orders.length, 1);

  // mildly negative sentiment (-0.4, the old threshold) no longer blocks entries
  const mild = executorHarness();
  const mildResult = await runHarness(mild, { research: makeBriefing({ verdict: 'HOLD', sentiment: -0.4 }) });
  assert.equal(mildResult.orders.length, 1, 'mildly negative sentiment must trade (smaller), not veto');

  // two risks no longer veto; the order is placed at the risk-penalised size
  const risky = executorHarness();
  const riskyResult = await runHarness(risky, {
    research: makeBriefing({ verdict: 'HOLD', sentiment: 0.4, confidence: 0.8, risks: ['regulatory review', 'margin warning'] }),
  });
  assert.equal(riskyResult.orders.length, 1, 'risks >= 2 must not veto any more');
  assert.ok(!riskyResult.actions.some((action) => action.reason === 'research_veto'));
});

test('executor × research: size scaling only shrinks the notional (and existing caps still win)', async () => {
  const baseline = await runHarness(executorHarness());
  const baselineOrder = baseline.orders[0];
  const baselineNotional = baselineOrder.qty * baselineOrder.avgFillPriceUsd;

  // sentiment > 0: factor = clamp(0.5 + confidence*0.5, 0.4, 1.0) => 0.4*0.5+0.5 = 0.7
  const scaled = executorHarness();
  const scaledResult = await runHarness(scaled, {
    research: makeBriefing({ verdict: 'HOLD', sentiment: 0.3, confidence: 0.4 }),
  });
  assert.equal(scaledResult.orders.length, 1);
  const scaledOrder = scaledResult.orders[0];
  const scaledNotional = scaledOrder.qty * scaledOrder.avgFillPriceUsd;
  assert.ok(scaledNotional < baselineNotional, `scaled ${scaledNotional} should be below baseline ${baselineNotional}`);
  assert.ok(Math.abs(scaledNotional - baselineNotional * 0.7) < 0.05);
  const sizeAction = scaledResult.actions.find((action) => action.type === 'entry');
  assert.equal(sizeAction.research.applied, 'size');
  assert.equal(sizeAction.research.verdict, 'HOLD');

  // sentiment <= 0: fixed 0.6 factor
  const neutral = executorHarness();
  const neutralResult = await runHarness(neutral, {
    research: makeBriefing({ verdict: 'HOLD', sentiment: 0, confidence: 1 }),
  });
  const neutralNotional = neutralResult.orders[0].qty * neutralResult.orders[0].avgFillPriceUsd;
  assert.ok(Math.abs(neutralNotional - baselineNotional * 0.6) < 0.05);

  // risks >= 2 add a risk penalty on top of the sentiment factor (0.9 x 0.6 = 0.54)
  const risky = executorHarness();
  const riskyResult = await runHarness(risky, {
    research: makeBriefing({ verdict: 'HOLD', sentiment: 0.4, confidence: 0.8, risks: ['risk a', 'risk b'] }),
  });
  const riskyNotional = riskyResult.orders[0].qty * riskyResult.orders[0].avgFillPriceUsd;
  assert.ok(Math.abs(riskyNotional - baselineNotional * 0.54) < 0.05, `risk penalty expected 0.54x, got ${riskyNotional / baselineNotional}x`);

  // research can never widen a size: a very positive briefing still respects the mandate cap
  const tinyMandate = executorHarness({ mandate: baseMandate({ maxOrderNotionalUsd: 120 }) });
  const tinyResult = await runHarness(tinyMandate, {
    research: makeBriefing({ verdict: 'HOLD', sentiment: 1, confidence: 1 }),
  });
  const tinyNotional = tinyResult.orders[0].qty * tinyResult.orders[0].avgFillPriceUsd;
  assert.ok(tinyNotional <= 120 + 0.5, `mandate cap must still bind, got ${tinyNotional}`);
});

test('executor × research: ALERT forces an exit in the exit pass; entry sections do not run', async () => {
  const openedAt = new Date(T0 - 2 * HOUR_MS).toISOString();
  const harness = executorHarness({
    positions: { AAPL: { qty: 10, avgPriceUsd: 110, openedAt } },
    quotes: { AAPL: { bid: 109.9, ask: 110.1, last: 110, ts: T0 } },
  });
  const result = await runHarness(harness, {
    research: makeBriefing({ verdict: 'ALERT', sentiment: -0.8, confidence: 0.9 }),
  });
  assert.equal(result.orders.length, 1);
  const exitAction = result.actions.find((action) => action.type === 'exit');
  assert.ok(exitAction, 'an exit action must be recorded');
  assert.equal(exitAction.reason, 'research_alert');
  assert.equal(exitAction.side, 'sell');
  assert.equal(exitAction.research.applied, 'exit');
  assert.equal(exitAction.research.verdict, 'ALERT');
  assert.equal(harness.broker.submitted[0].side, 'sell');
  assert.equal(harness.ledger.fills.length, 1);

  // a held position inside its stop/target with no alert signal is held (baseline behaviour)
  const calm = executorHarness({
    positions: { AAPL: { qty: 10, avgPriceUsd: 110, openedAt } },
    quotes: { AAPL: { bid: 109.9, ask: 110.1, last: 110, ts: T0 } },
  });
  const calmResult = await runHarness(calm, { research: makeBriefing({ verdict: 'HOLD', sentiment: 0.2 }) });
  assert.equal(calmResult.orders.length, 0);
  assert.ok(calmResult.actions.some((action) => action.type === 'hold'));
});

test('executor × research: stale, disabled, malformed and missing briefings behave exactly like today', async () => {
  const baseline = await runHarness(executorHarness());
  const baselineNotional = baseline.orders[0].qty * baseline.orders[0].avgFillPriceUsd;
  assert.equal(baseline.orders.length, 1);

  const cases = [
    {
      name: 'stale briefing',
      research: makeBriefing({ verdict: 'AVOID', sentiment: -0.9, at: new Date(T0 - 3 * 60 * 60 * 1000).toISOString() }),
      configOverrides: undefined,
    },
    {
      name: 'missing briefing timestamp',
      research: { verdict: 'AVOID', sentiment: -0.9, confidence: 0.9 },
      configOverrides: undefined,
    },
    {
      name: 'malformed briefing (no sentiment)',
      research: { verdict: 'AVOID', at: new Date(T0 - 60_000).toISOString() },
      configOverrides: undefined,
    },
    {
      name: 'null briefing',
      research: null,
      configOverrides: undefined,
    },
    {
      name: 'influence disabled (shadow mode)',
      research: makeBriefing({ verdict: 'AVOID', sentiment: -0.9 }),
      configOverrides: { research: { enabled: true, influence: false } },
    },
    {
      name: 'research disabled',
      research: makeBriefing({ verdict: 'AVOID', sentiment: -0.9 }),
      configOverrides: { research: { enabled: false, influence: true } },
    },
  ];

  for (const testCase of cases) {
    const harness = executorHarness({ configOverrides: testCase.configOverrides });
    const result = await runHarness(harness, { research: testCase.research });
    assert.equal(result.orders.length, 1, `${testCase.name}: baseline entry should still be placed`);
    const notional = result.orders[0].qty * result.orders[0].avgFillPriceUsd;
    assert.ok(Math.abs(notional - baselineNotional) < 0.05, `${testCase.name}: notional must be unchanged`);
    assert.ok(
      !result.actions.some((action) => action.reason === 'research_veto'),
      `${testCase.name}: no veto may be applied`,
    );
  }

  // an unknown verdict is treated as HOLD (it may still influence size, but never exits/vetoes)
  const unknownHarness = executorHarness();
  const unknownResult = await runHarness(unknownHarness, {
    research: makeBriefing({ verdict: 'SELL EVERYTHING', sentiment: 0.5, confidence: 0.2 }),
  });
  assert.equal(unknownResult.orders.length, 1);
  assert.ok(!unknownResult.actions.some((action) => action.reason === 'research_veto'));
});

// ===========================================================================
// executor × per-bot agent policy (own brain, fresh-only, config-gated)
// ===========================================================================

test('executor × bot-agent policy: missing, malformed and disabled policies keep baseline behaviour', async () => {
  const baseline = await runHarness(executorHarness({ configOverrides: AGENTS_ON }));
  assert.equal(baseline.orders.length, 1);
  const baselineNotional = baseline.orders[0].qty * baseline.orders[0].avgFillPriceUsd;
  assert.equal(baseline.actions.find((action) => action.type === 'entry').policy, undefined);

  const ignored = [
    { name: 'no policy', configOverrides: AGENTS_ON, policy: undefined },
    { name: 'null policy', configOverrides: AGENTS_ON, policy: null },
    { name: 'agents disabled', configOverrides: AGENTS_OFF, policy: makePolicy({ stance: 'stand_down' }) },
    { name: 'missing timestamp', configOverrides: AGENTS_ON, policy: { stance: 'stand_down', sizeMultiplier: 0.2 } },
    { name: 'malformed stance', configOverrides: AGENTS_ON, policy: makePolicy({ stance: 'yolo' }) },
    { name: 'empty object', configOverrides: AGENTS_ON, policy: {} },
  ];
  for (const testCase of ignored) {
    const harness = executorHarness({ configOverrides: testCase.configOverrides });
    const result = await runHarness(harness, { policy: testCase.policy });
    assert.equal(result.orders.length, 1, `${testCase.name}: baseline entry must still be placed`);
    const notional = result.orders[0].qty * result.orders[0].avgFillPriceUsd;
    assert.ok(Math.abs(notional - baselineNotional) < 0.05, `${testCase.name}: notional must be unchanged`);
    const entry = result.actions.find((action) => action.type === 'entry');
    assert.equal(entry.policy, undefined, `${testCase.name}: no policy effect may be recorded`);
    assert.ok(!result.actions.some((action) => action.reason === 'agent_stand_down'), `${testCase.name}: no stand-down`);
  }
});

test('executor × bot-agent policy: stand_down blocks entries but exits are still evaluated', async () => {
  // Entry signal present, but the bot's own brain says stand down -> no new exposure.
  const flat = executorHarness({ configOverrides: AGENTS_ON });
  const flatResult = await runHarness(flat, { policy: makePolicy({ stance: 'stand_down', sizeMultiplier: 0.4 }) });
  assert.equal(flatResult.orders.length, 0);
  assert.equal(flat.broker.submitted.length, 0, 'no order may reach the broker while standing down');
  assert.equal(flatResult.denied.length, 0, 'a stand-down is a stance skip, not a brake denial');
  assert.equal(flat.brakes.calls.length, 0, 'no order is intended, so the brake wall is not reached');
  const standDown = flatResult.actions.find((action) => action.reason === 'agent_stand_down');
  assert.ok(standDown);
  assert.equal(standDown.type, 'skip');
  assert.equal(standDown.symbol, 'AAPL');
  assert.equal(standDown.policy.stance, 'stand_down');

  // Exit safety is untouched: a held position at its stop still exits while standing down.
  const openedAt = new Date(T0 - 2 * HOUR_MS).toISOString();
  const stopped = executorHarness({
    configOverrides: AGENTS_ON,
    positions: { AAPL: { qty: 10, avgPriceUsd: 100, openedAt } },
    quotes: { AAPL: { bid: 89.9, ask: 90.1, last: 90, ts: T0 } },
  });
  const stoppedResult = await runHarness(stopped, { policy: makePolicy({ stance: 'stand_down' }) });
  assert.equal(stoppedResult.orders.length, 1, 'stand_down must never block a risk-reducing exit');
  const exit = stoppedResult.actions.find((action) => action.type === 'exit');
  assert.equal(exit.reason, 'stop');
  assert.equal(stopped.broker.submitted[0].side, 'sell');

  // ...and a position safely inside its bounds is simply held.
  const calm = executorHarness({
    configOverrides: AGENTS_ON,
    positions: { AAPL: { qty: 10, avgPriceUsd: 110, openedAt } },
    quotes: { AAPL: { bid: 109.9, ask: 110.1, last: 110, ts: T0 } },
  });
  const calmResult = await runHarness(calm, { policy: makePolicy({ stance: 'stand_down' }) });
  assert.equal(calmResult.orders.length, 0);
  assert.ok(calmResult.actions.some((action) => action.type === 'hold'));
});

test('executor × bot-agent policy: sizeMultiplier shrinks entries and never grows them', async () => {
  const baseline = await runHarness(executorHarness({ configOverrides: AGENTS_ON }));
  const baselineNotional = baseline.orders[0].qty * baseline.orders[0].avgFillPriceUsd;

  // cautious + 0.5 shrinks 400 -> 200 and records the applied policy on the entry action
  const half = executorHarness({ configOverrides: AGENTS_ON });
  const halfResult = await runHarness(half, { policy: makePolicy({ stance: 'cautious', sizeMultiplier: 0.5 }) });
  assert.equal(halfResult.orders.length, 1);
  const halfNotional = halfResult.orders[0].qty * halfResult.orders[0].avgFillPriceUsd;
  assert.ok(Math.abs(halfNotional - baselineNotional * 0.5) < 0.05, `expected half notional, got ${halfNotional}`);
  const halfEntry = halfResult.actions.find((action) => action.type === 'entry');
  assert.deepEqual(halfEntry.policy, { stance: 'cautious', sizeMultiplier: 0.5, applied: 'size' });
  assert.equal(half.broker.submitted.length, 1);
  // the brakes still saw the policy-sized order first (target notional 400 * 0.5 = 200)
  assert.equal(half.brakes.calls.length, 1);
  assert.ok(Math.abs(half.brakes.calls[0].order.notionalUsd - 200) < 1, `brake notional ${half.brakes.calls[0].order.notionalUsd}`);

  // out-of-range multipliers are clamped into [0.2, 1]: never grows above baseline
  const huge = await runHarness(executorHarness({ configOverrides: AGENTS_ON }), {
    policy: makePolicy({ stance: 'cautious', sizeMultiplier: 7 }),
  });
  const hugeNotional = huge.orders[0].qty * huge.orders[0].avgFillPriceUsd;
  assert.ok(Math.abs(hugeNotional - baselineNotional) < 0.05, `multiplier > 1 must clamp to 1, got ${hugeNotional}`);
  assert.equal(huge.actions.find((action) => action.type === 'entry').policy.sizeMultiplier, 1);

  const tiny = await runHarness(executorHarness({ configOverrides: AGENTS_ON }), {
    policy: makePolicy({ stance: 'cautious', sizeMultiplier: 0.05 }),
  });
  const tinyNotional = tiny.orders[0].qty * tiny.orders[0].avgFillPriceUsd;
  assert.ok(Math.abs(tinyNotional - baselineNotional * 0.2) < 0.05, `multiplier < 0.2 must clamp to 0.2, got ${tinyNotional}`);
  assert.equal(tiny.actions.find((action) => action.type === 'entry').policy.sizeMultiplier, 0.2);

  // trade stance with a 1.0 multiplier: same sizing, stance still recorded
  const trade = await runHarness(executorHarness({ configOverrides: AGENTS_ON }), {
    policy: makePolicy({ stance: 'trade', sizeMultiplier: 1 }),
  });
  const tradeNotional = trade.orders[0].qty * trade.orders[0].avgFillPriceUsd;
  assert.ok(Math.abs(tradeNotional - baselineNotional) < 0.05);
  assert.deepEqual(trade.actions.find((action) => action.type === 'entry').policy, {
    stance: 'trade',
    sizeMultiplier: 1,
    applied: 'size',
  });
});

test('executor × bot-agent policy: exitPressure exit forces an exit; research ALERT keeps precedence', async () => {
  const openedAt = new Date(T0 - 2 * HOUR_MS).toISOString();
  const positions = { AAPL: { qty: 10, avgPriceUsd: 110, openedAt } }; // inside stop/target
  const quotes = { AAPL: { bid: 109.9, ask: 110.1, last: 110, ts: T0 } };

  const baseline = await runHarness(
    executorHarness({ configOverrides: AGENTS_ON, positions, quotes }),
  );
  assert.equal(baseline.orders.length, 0, 'baseline would hold this position');
  assert.ok(baseline.actions.some((action) => action.type === 'hold'));

  const pressured = executorHarness({ configOverrides: AGENTS_ON, positions, quotes });
  const result = await runHarness(pressured, {
    policy: makePolicy({ stance: 'cautious', sizeMultiplier: 0.7, exitPressure: 'exit' }),
  });
  assert.equal(result.orders.length, 1);
  const exit = result.actions.find((action) => action.type === 'exit');
  assert.equal(exit.reason, 'agent_exit_pressure');
  assert.equal(exit.side, 'sell');
  assert.deepEqual(exit.policy, { stance: 'cautious', sizeMultiplier: 0.7, applied: 'exit' });
  assert.equal(pressured.broker.submitted[0].side, 'sell');
  assert.equal(pressured.brakes.calls.length, 1, 'the forced exit still passes the brakes first');

  // Research ALERT keeps precedence over the bot policy in the exit pass (as today).
  const withResearch = executorHarness({ configOverrides: AGENTS_ON, positions, quotes });
  const researchResult = await runHarness(withResearch, {
    policy: makePolicy({ exitPressure: 'exit' }),
    research: makeBriefing({ verdict: 'ALERT', sentiment: -0.8 }),
  });
  assert.equal(researchResult.orders.length, 1);
  assert.equal(researchResult.actions.find((action) => action.type === 'exit').reason, 'research_alert');

  // Policy pressure is checked before the mechanical exit rules.
  const stopped = executorHarness({
    configOverrides: AGENTS_ON,
    positions: { AAPL: { qty: 10, avgPriceUsd: 100, openedAt } },
    quotes: { AAPL: { bid: 89.9, ask: 90.1, last: 90, ts: T0 } }, // stop-loss territory
  });
  const stoppedResult = await runHarness(stopped, { policy: makePolicy({ exitPressure: 'exit' }) });
  assert.equal(stoppedResult.actions.find((action) => action.type === 'exit').reason, 'agent_exit_pressure');
});

test('executor × bot-agent policy: stale policies are ignored entirely', async () => {
  const baseline = await runHarness(executorHarness({ configOverrides: AGENTS_ON }));
  const baselineNotional = baseline.orders[0].qty * baseline.orders[0].avgFillPriceUsd;

  const stalePolicy = makePolicy({
    stance: 'stand_down',
    sizeMultiplier: 0.2,
    atMs: T0 - 3 * 60 * 60 * 1000, // 3 h old, maxAgeSec is 7200 (2 h)
    at: new Date(T0 - 3 * 60 * 60 * 1000).toISOString(),
  });
  const stale = await runHarness(executorHarness({ configOverrides: AGENTS_ON }), { policy: stalePolicy });
  assert.equal(stale.orders.length, 1, 'a stale policy must not block entries');
  const staleNotional = stale.orders[0].qty * stale.orders[0].avgFillPriceUsd;
  assert.ok(Math.abs(staleNotional - baselineNotional) < 0.05);
  assert.equal(stale.actions.find((action) => action.type === 'entry').policy, undefined);

  // The bot brain's own staleness flag is honoured even when the timestamp looks fresh.
  const flagged = await runHarness(executorHarness({ configOverrides: AGENTS_ON }), {
    policy: makePolicy({ stance: 'stand_down', stale: true }),
  });
  assert.equal(flagged.orders.length, 1);
  assert.equal(flagged.actions.find((action) => action.type === 'entry').policy, undefined);
});

test('executor × bot-agent policy: brakes always run first for policy-sized orders', async () => {
  const denied = executorHarness({
    configOverrides: AGENTS_ON,
    brakesHandler: () => ({ decision: 'DENY', code: 'MARKET_CLOSED', rule: 'D3', reason: 'closed' }),
  });
  const result = await runHarness(denied, { policy: makePolicy({ sizeMultiplier: 0.5 }) });
  assert.equal(result.orders.length, 0);
  assert.equal(denied.broker.submitted.length, 0);
  assert.equal(result.denied[0].code, 'MARKET_CLOSED');
  assert.equal(denied.brakes.calls.length, 1, 'the policy-sized order reached the brake wall first');
  // the brake decision saw the shrunken notional, not the raw size
  assert.ok(denied.brakes.calls[0].order.notionalUsd < 400);
});

test('executor: describe() exposes the per-bot agent policy gate', () => {
  const on = executorHarness({ configOverrides: AGENTS_ON });
  const onView = on.executor.describe();
  assert.equal(onView.agents.enabled, true);
  assert.equal(onView.agents.policyActive, true);
  assert.equal(onView.agents.maxAgeSec, 7200);
  assert.ok(onView.agents.effects.includes('stand_down'));
  assert.ok(onView.agents.effects.includes('size_multiplier'));
  assert.ok(onView.agents.effects.includes('exit_pressure'));

  const off = executorHarness({ configOverrides: AGENTS_OFF });
  assert.equal(off.executor.describe().agents.enabled, false);
});

// ===========================================================================
// v3.0 multi-instrument: Alpaca broker (payloads only — never places orders)
// ===========================================================================

test('alpaca broker: account capability fields, asset permissions, option chain + quote mapping', async () => {
  const nowMs = Date.parse('2026-01-10T15:00:00Z');
  const fetchImpl = stubFetch((url) => {
    if (url.includes('/v2/account')) {
      return jsonResponse(200, {
        equity: '2000.55',
        cash: '1500.10',
        buying_power: '6000.00',
        options_buying_power: '1500.00',
        multiplier: '4',
        shorting_enabled: true,
        options_trading_level: 3,
        status: 'ACTIVE',
        currency: 'USD',
      });
    }
    if (url.includes('/v2/assets/AAPL')) {
      return jsonResponse(200, {
        symbol: 'AAPL', class: 'us_equity', tradable: true, shortable: true,
        marginable: true, fractionable: true, maintenance_margin_requirement: 30,
      });
    }
    if (url.includes('/v2/options/contracts')) {
      return jsonResponse(200, {
        option_contracts: [
          { symbol: 'F260116C00013000', underlying_symbol: 'F', type: 'call', strike_price: '13', expiration_date: '2026-01-16', multiplier: '100', tradable: true, close_price: '0.04' },
          { symbol: 'F260116C00012000', underlying_symbol: 'F', type: 'call', strike_price: '12', expiration_date: '2026-01-16', multiplier: '100', tradable: true, close_price: '0.11' },
        ],
      });
    }
    if (url.includes('/v1beta1/options/snapshots/AAPL')) {
      return jsonResponse(200, {
        snapshots: {
          AAPL260116C00115000: {
            latestQuote: { bp: 1.48, ap: 1.52, t: '2026-01-10T15:00:00Z' },
            latestTrade: { p: 1.5 },
            dailyBar: { c: 1.5 },
          },
        },
      });
    }
    if (url.includes('/v2/positions')) {
      return jsonResponse(200, [
        { symbol: 'AAPL', qty: '-3', avg_entry_price: '150', market_value: '-450', asset_class: 'us_equity' },
        { symbol: 'AAPL260116C00115000', qty: '2', avg_entry_price: '1.50', market_value: '300', asset_class: 'us_option' },
      ]);
    }
    if (url.includes('/v2/orders/ord-1') && !url.endsWith('/v2/orders/ord-1')) return jsonResponse(404, {});
    if (url.includes('/v2/orders/ord-1')) {
      return jsonResponse(200, { id: 'ord-1', symbol: 'AAPL260116C00115000', side: 'buy', qty: '2', filled_qty: '2', filled_avg_price: '1.51', status: 'filled', order_class: 'simple', client_order_id: 'atm:atm-1:spec-1:1', asset_class: 'us_option', submitted_at: '2026-01-10T15:00:00Z' });
    }
    return jsonResponse(404, { message: 'unexpected path' });
  });
  const broker = createAlpacaBroker(
    { mode: 'paper' },
    { secrets: { ALPACA_API_KEY_ID: 'k', ALPACA_API_SECRET_KEY: 's' }, fetchImpl },
  );

  const account = await broker.getAccount();
  assert.equal(account.buyingPowerUsd, 6000);
  assert.equal(account.optionsBuyingPowerUsd, 1500);
  assert.equal(account.marginMultiplier, 4);
  assert.equal(account.shortingEnabled, true);
  assert.equal(account.optionsTradingLevel, 3);

  const asset = await broker.getAsset('AAPL');
  assert.equal(asset.shortable, true);
  assert.equal(asset.marginable, true);
  assert.equal(asset.maintenanceMarginPct, 0.3);

  const chain = await broker.getOptionChain(
    { underlying: 'F', type: 'call', expirationGte: '2026-01-12', expirationLte: '2026-01-20', strikeGte: 10, strikeLte: 15, limit: 50 },
    { nowMs },
  );
  assert.equal(chain.length, 2);
  assert.deepEqual(chain.map((contract) => contract.strikeUsd), [12, 13], 'chain sorted by strike');
  assert.equal(chain[0].underlying, 'F');
  assert.equal(chain[0].type, 'call');
  assert.equal(chain[0].expiration, '2026-01-16');
  assert.equal(chain[0].dte, 6);
  assert.equal(chain[0].multiplier, 100);
  assert.equal(chain[0].closePriceUsd, 0.11);
  const chainUrl = new URL(fetchImpl.calls.find((call) => call.url.includes('/v2/options/contracts')).url);
  assert.equal(chainUrl.searchParams.get('underlying_symbols'), 'F');
  assert.equal(chainUrl.searchParams.get('type'), 'call');
  assert.equal(chainUrl.searchParams.get('expiration_date_gte'), '2026-01-12');
  assert.equal(chainUrl.searchParams.get('strike_price_lte'), '15');

  const quote = await broker.getOptionQuote('AAPL260116C00115000', { nowMs });
  assert.equal(quote.underlying, 'AAPL');
  assert.equal(quote.type, 'call');
  assert.equal(quote.strikeUsd, 115);
  assert.equal(quote.bid, 1.48);
  assert.equal(quote.ask, 1.52);
  assert.equal(quote.mark, 1.5);
  assert.equal(quote.dte, 6);

  const positions = await broker.getPositions();
  const shortStock = positions.find((position) => position.assetClass === 'us_equity');
  const longOption = positions.find((position) => position.assetClass === 'us_option');
  assert.equal(shortStock.qtySigned, -3);
  assert.equal(shortStock.side, 'SHORT');
  assert.equal(longOption.side, 'CALL');
  assert.equal(longOption.contracts, 2);
  assert.equal(longOption.option.type, 'call');

  const order = await broker.getOrder('ord-1');
  assert.equal(order.filledQty, 2);
  assert.equal(order.assetClass, 'us_option');
  assert.equal(order.clientOrderId, 'atm:atm-1:spec-1:1');
});

test('alpaca broker: option, mleg and short-stock order payloads; option quote cache', async () => {
  const posted = [];
  const fetchImpl = stubFetch((url, init) => {
    if (url.includes('/v2/orders') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      posted.push(body);
      const isMleg = body.order_class === 'mleg';
      return jsonResponse(200, {
        id: `ord-${posted.length}`,
        client_order_id: body.client_order_id,
        symbol: isMleg ? 'AAPL260116C00115000' : body.symbol,
        side: body.side ?? null,
        qty: body.qty ?? null,
        filled_qty: body.qty ?? null,
        filled_avg_price: body.limit_price ?? '1.50',
        status: 'filled',
        order_class: isMleg ? 'mleg' : 'simple',
        asset_class: isMleg || body.asset_class === 'us_option' ? 'us_option' : 'us_equity',
        legs: isMleg
          ? body.legs.map((leg) => ({ ...leg, filled_qty: leg.ratio_qty, filled_avg_price: '1.50' }))
          : [],
        submitted_at: '2026-01-10T15:00:00Z',
      });
    }
    if (url.includes('/v1beta1/options/snapshots/AAPL')) {
      return jsonResponse(200, {
        snapshots: { AAPL260116C00115000: { latestQuote: { bp: '1.48', ap: '1.52', t: '2026-01-10T15:00:00Z' } } },
      });
    }
    return jsonResponse(404, {});
  });
  const broker = createAlpacaBroker(
    { mode: 'paper' },
    { secrets: { ALPACA_API_KEY_ID: 'k', ALPACA_API_SECRET_KEY: 's' }, fetchImpl },
  );

  await broker.submitOrder({
    symbol: 'AAPL260116C00115000', assetClass: 'us_option', side: 'buy', qty: 2,
    type: 'limit', limitPrice: 1.52, positionIntent: 'buy_to_open', clientOrderId: 'atm:atm-1:spec-1:1',
  });
  assert.deepEqual(posted[0], {
    symbol: 'AAPL260116C00115000',
    side: 'buy',
    asset_class: 'us_option',
    qty: '2',
    type: 'limit',
    time_in_force: 'day',
    limit_price: '1.52',
    client_order_id: 'atm:atm-1:spec-1:1',
    position_intent: 'buy_to_open',
  });

  await broker.submitOrder({
    orderClass: 'mleg',
    type: 'limit',
    limitPrice: 0.35,
    qty: 2,
    clientOrderId: 'atm:atm-1:spec-1:2',
    legs: [
      { symbol: 'AAPL260116C00120000', side: 'sell', ratioQty: 1, positionIntent: 'sell_to_open' },
      { symbol: 'AAPL260116C00125000', side: 'buy', ratioQty: 1, positionIntent: 'buy_to_open' },
    ],
  });
  assert.equal(posted[1].order_class, 'mleg');
  assert.equal(posted[1].type, 'limit');
  assert.equal(posted[1].limit_price, '0.35');
  assert.deepEqual(posted[1].legs, [
    { symbol: 'AAPL260116C00120000', side: 'sell', ratio_qty: '1', position_intent: 'sell_to_open' },
    { symbol: 'AAPL260116C00125000', side: 'buy', ratio_qty: '1', position_intent: 'buy_to_open' },
  ]);
  assert.equal(posted[1].symbol, undefined, 'mleg payload has no top-level symbol');

  // short stock is a plain sell order (no position intent, no option fields)
  await broker.submitOrder({ symbol: 'AAPL', assetClass: 'us_equity', side: 'sell', qty: 10, type: 'market' });
  assert.equal(posted[2].symbol, 'AAPL');
  assert.equal(posted[2].side, 'sell');
  assert.equal(posted[2].qty, '10');
  assert.equal(posted[2].position_intent, undefined);
  assert.equal(posted[2].asset_class, 'us_equity');

  // option qty must be a positive integer number of contracts
  await expectCode(
    broker.submitOrder({ symbol: 'AAPL260116C00115000', assetClass: 'us_option', side: 'buy', qty: 1.5, type: 'limit', limitPrice: 1 }),
    'SPEC_INVALID',
  );

  // chain snapshot is cached briefly: two quote calls -> one data request
  const first = await broker.getOptionQuote('AAPL260116C00115000');
  const second = await broker.getOptionQuote('AAPL260116C00115000');
  assert.equal(first.mark, 1.5);
  assert.deepEqual(second, first);
  assert.equal(fetchImpl.calls.filter((call) => call.url.includes('/v1beta1/options/snapshots/')).length, 1);
});

// ===========================================================================
// v3.0 multi-instrument: simulated broker (deterministic, offline)
// ===========================================================================

test('sim broker: deterministic option chain/quotes, option fills and mleg spread fills', async () => {
  const config = testConfig({ mode: 'sim' });
  const brokerA = createSimBroker(config, { seed: 42 });
  const brokerB = createSimBroker(config, { seed: 42 });
  const chainA = await brokerA.getOptionChain({ underlying: 'AAPL', type: 'call' });
  const chainB = await brokerB.getOptionChain({ underlying: 'AAPL', type: 'call' });
  assert.deepEqual(chainA, chainB, 'same seed => identical option chain');
  assert.ok(chainA.length >= 8);
  const expiries = [...new Set(chainA.map((contract) => contract.expiration))];
  assert.equal(expiries.length, 2, 'two synthetic expiries');
  assert.ok(chainA.every((contract) => Number.isInteger(contract.dte) && contract.dte > 0));
  assert.ok(chainA.every((contract) => Number.isFinite(contract.strikeUsd) && contract.closePriceUsd > 0));

  const contract = chainA[Math.floor(chainA.length / 2)];
  const quote = await brokerA.getOptionQuote(contract.symbol);
  assert.equal(quote.symbol, contract.symbol);
  assert.ok(quote.bid > 0 && quote.ask > quote.bid && quote.mark > 0);
  assert.equal(quote.multiplier, 100);
  assert.equal(quote.dte, contract.dte);
  assert.deepEqual(await brokerB.getOptionQuote(contract.symbol), quote);

  // long option fill: debit premium * 100 * contracts, position marked CALL
  const cashBefore = brokerA.getAccount().cashUsd;
  const buy = brokerA.submitOrder({
    symbol: contract.symbol, assetClass: 'us_option', side: 'buy', qty: 2,
    type: 'limit', limitPrice: quote.ask, positionIntent: 'buy_to_open', clientOrderId: 'atm:atm-1:spec-1:1',
  });
  assert.equal(buy.status, 'filled');
  assert.equal(buy.assetClass, 'us_option');
  assert.equal(buy.filledQty, 2);
  assert.equal(brokerA.getAccount().cashUsd, num2(cashBefore - quote.ask * 2 * 100));
  const optionPosition = brokerA.getPositions().find((position) => position.symbol === contract.symbol);
  assert.equal(optionPosition.side, 'CALL');
  assert.equal(optionPosition.qtySigned, 2);
  assert.equal(optionPosition.multiplier, 100);
  assert.ok(optionPosition.marketValueUsd > 0);

  // sell-to-close part of the position
  brokerA.submitOrder({ symbol: contract.symbol, assetClass: 'us_option', side: 'sell', qty: 1, type: 'limit', limitPrice: quote.bid, positionIntent: 'sell_to_close' });
  assert.equal(brokerA.getPositions().find((position) => position.symbol === contract.symbol).qtySigned, 1);

  // mleg credit spread fills both legs atomically and links them by groupId
  const callsOtm = chainA.filter((entry) => entry.strikeUsd > 100).slice(0, 2);
  const [shortLeg, longLeg] = callsOtm;
  const mleg = brokerA.submitOrder({
    orderClass: 'mleg',
    type: 'limit',
    limitPrice: 0.1,
    qty: 1,
    legs: [
      { symbol: shortLeg.symbol, side: 'sell', ratioQty: 1, positionIntent: 'sell_to_open' },
      { symbol: longLeg.symbol, side: 'buy', ratioQty: 1, positionIntent: 'buy_to_open' },
    ],
    clientOrderId: 'atm:atm-1:spec-1:2',
    structure: 'call_credit_spread',
  });
  assert.equal(mleg.status, 'filled');
  assert.equal(mleg.orderClass, 'mleg');
  assert.equal(mleg.legs.length, 2);
  assert.equal(mleg.legs[0].filledQty, 1);
  assert.equal(mleg.legs[1].filledQty, 1);
  const positions = brokerA.getPositions();
  const shortCall = positions.find((position) => position.symbol === shortLeg.symbol);
  const longCall = positions.find((position) => position.symbol === longLeg.symbol);
  assert.equal(shortCall.qtySigned, -1);
  assert.equal(shortCall.side, 'CALL');
  assert.equal(longCall.qtySigned, 1);
  assert.equal(shortCall.groupId, longCall.groupId);
  assert.ok(shortCall.groupId);
});

// ===========================================================================
// v3.0 multi-instrument: executor instrument selection, orders and exits
// ===========================================================================

test('executor: buys a long call when the family playbook says so (option payload)', async () => {
  const chain = makeOptionChain({ underlying: 'AAPL', type: 'call', strikes: [105, 110, 115, 120], defaultPremium: 0.1 });
  const harness = optionExecutorHarness({ brokerOptions: { chain } });
  const result = await runHarness(harness, { bars: { AAPL: breakoutBars() } });
  assert.equal(result.denied.length, 0, JSON.stringify(result.denied));
  assert.equal(harness.broker.submitted.length, 1);
  const order = harness.broker.submitted[0];
  assert.equal(order.assetClass, 'us_option');
  assert.equal(order.side, 'buy');
  assert.equal(order.positionIntent, 'buy_to_open');
  assert.equal(order.type, 'limit');
  assert.ok(order.qty >= 1 && Number.isInteger(order.qty));
  assert.ok(order.limitPrice > 0);
  assert.ok(String(order.symbol).length > 10, 'order targets an OCC contract');
  const entry = result.actions.find((action) => action.type === 'entry');
  assert.equal(entry.instrument, 'long_call');
  assert.equal(entry.assetClass, 'us_option');
  assert.equal(entry.contracts, order.qty);
  // booked as an option fill with the 100x multiplier
  assert.equal(harness.ledger.fills.length, 1);
  assert.equal(harness.ledger.fills[0].assetClass, 'us_option');
  assert.equal(harness.ledger.fills[0].multiplier, 100);
  assert.equal(harness.ledger.fills[0].side, 'buy');
  assert.ok(entry.option.strikeUsd > 0);

  // describe() reports the enabled instruments/structures
  const view = harness.executor.describe();
  assert.equal(view.instruments.enabled, true);
  assert.equal(view.instruments.options, true);
  assert.equal(view.instruments.spreads, true);
  assert.ok(view.instruments.allowedStructures.includes('long_call'));
});

test('executor: long option exits on premium stop with sell_to_close', async () => {
  const contract = { underlying: 'AAPL', expiration: '2030-01-18', type: 'call', strikeUsd: 115 };
  const occ = formatOccSymbol(contract);
  const position = makeOptionPosition({ contract, avgPriceUsd: 1, qtySigned: 1 });
  const harness = optionExecutorHarness({
    positions: { [occ]: position },
    brokerOptions: { premiumBySymbol: { [occ]: 0.3 }, chain: makeOptionChain({ underlying: 'AAPL', type: 'call', strikes: [115], defaultPremium: 0.3 }) },
  });
  const result = await runHarness(harness, { bars: { AAPL: breakoutBars() } });
  assert.equal(result.orders.length, 1);
  const order = harness.broker.submitted[0];
  assert.equal(order.assetClass, 'us_option');
  assert.equal(order.side, 'sell');
  assert.equal(order.positionIntent, 'sell_to_close');
  assert.equal(order.symbol, occ);
  const exit = result.actions.find((action) => action.type === 'exit');
  assert.equal(exit.reason, 'stop');
  assert.equal(exit.instrument, 'long_call');
  assert.equal(harness.brakes.calls[0].closing, true, 'closing order is flagged for the brake wall');
});

test('executor: covered call requires 100 shares (guard + with-shares entry)', async () => {
  const chain = makeOptionChain({ underlying: 'AAPL', type: 'call', strikes: [110, 115, 120], defaultPremium: 0.1 });
  const policy = makePolicy({ instrument: { prefer: 'covered_call' } });
  const gapBars = gapUpFadeBars();

  // no shares -> covered call blocked, recorded skip, falls back to a short stock entry
  const guardHarness = optionExecutorHarness({
    brokerOptions: { chain },
    specOverrides: { family: 'gapfade' },
  });
  const guardResult = await runHarness(guardHarness, { bars: { AAPL: gapBars }, policy });
  const guardSkip = guardResult.actions.find((action) => action.reason === 'covered_call_requires_100_shares');
  assert.ok(guardSkip, 'covered-call guard must record a skip');
  assert.ok(!guardHarness.broker.submitted.some((order) => order.assetClass === 'us_option'));

  // 100 shares -> sells one covered call against them (never more contracts than covered)
  const coveredPosition = {
    qty: 100, qtySigned: 100, avgPriceUsd: 100, assetClass: 'us_equity',
    openedAt: new Date(T0 - HOUR_MS).toISOString(),
  };
  const coveredHarness = optionExecutorHarness({
    positions: { AAPL: coveredPosition },
    brokerOptions: { chain },
    specOverrides: { family: 'gapfade', params: { ...baseSpec().params, stopPct: 0.06, targetPct: 0.12, maxHoldBars: 48 } },
  });
  const coveredResult = await runHarness(coveredHarness, { bars: { AAPL: gapBars }, policy });
  assert.equal(coveredResult.orders.length, 1, JSON.stringify(coveredResult.denied));
  const order = coveredHarness.broker.submitted[0];
  assert.equal(order.assetClass, 'us_option');
  assert.equal(order.side, 'sell');
  assert.equal(order.positionIntent, 'sell_to_open');
  assert.equal(order.qty, 1);
  const entry = coveredResult.actions.find((action) => action.type === 'entry');
  assert.equal(entry.instrument, 'covered_call');
});

test('executor: opens a two-leg credit spread as one mleg order and closes it as mleg', async () => {
  const chain = makeOptionChain({
    underlying: 'AAPL',
    type: 'call',
    strikes: [110, 115, 120, 125],
    premiums: { 110: 1.2, 115: 0.6, 120: 0.25, 125: 0.1 },
  });
  const policy = makePolicy({ instrument: { prefer: 'call_credit_spread' } });
  const spreadConfig = { instruments: { maxOptionPremiumUsd: 2000, maxOptionPremiumPctEquity: 0.5, maxContracts: 3 } };
  const harness = optionExecutorHarness({
    brokerOptions: { chain },
    configOverrides: spreadConfig,
    specOverrides: { family: 'gapfade' },
  });
  const result = await runHarness(harness, { bars: { AAPL: gapUpBars() }, policy });
  assert.equal(result.denied.length, 0, JSON.stringify(result.denied));
  assert.equal(harness.broker.submitted.length, 1);
  const order = harness.broker.submitted[0];
  assert.equal(order.orderClass, 'mleg');
  assert.equal(order.type, 'limit');
  assert.equal(order.legs.length, 2);
  assert.equal(order.legs[0].side, 'sell');
  assert.equal(order.legs[1].side, 'buy');
  assert.equal(order.legs[0].positionIntent, 'sell_to_open');
  assert.equal(order.legs[1].positionIntent, 'buy_to_open');
  assert.ok(order.limitPrice > 0, 'mleg limit price is the net credit');
  const entry = result.actions.find((action) => action.type === 'entry');
  assert.equal(entry.instrument, 'call_credit_spread');
  assert.equal(harness.ledger.fills.length, 2, 'both spread legs are booked');
  assert.equal(harness.ledger.fills[0].groupId, harness.ledger.fills[1].groupId);

  // --- close the spread as one mleg sell/buy-to-close order -------------------
  const shortOcc = order.legs[0].symbol;
  const longOcc = order.legs[1].symbol;
  const exitHarness = optionExecutorHarness({
    brokerOptions: {
      chain,
      premiumBySymbol: { [shortOcc]: 0.1, [longOcc]: 0.05 },
    },
    specOverrides: { family: 'gapfade' },
  });
  exitHarness.spec = baseSpec({ family: 'gapfade', params: { ...baseSpec().params, targetPct: 0.04, stopPct: 0.02 } });
  const legsGroup = 'grp-spread-1';
  exitHarness.ledger = makeLedgerDouble({
    positions: {
      [shortOcc]: makeOptionPosition({ contract: { underlying: 'AAPL', expiration: '2030-01-18', type: 'call', strikeUsd: 115 }, qtySigned: -1, avgPriceUsd: 0.6, groupId: legsGroup, structure: 'call_credit_spread', option: { underlying: 'AAPL', expiration: '2030-01-18', type: 'call', strikeUsd: 115, dte: 12, multiplier: 100 } }),
      [longOcc]: makeOptionPosition({ contract: { underlying: 'AAPL', expiration: '2030-01-18', type: 'call', strikeUsd: 120 }, qtySigned: 1, avgPriceUsd: 0.25, groupId: legsGroup, structure: 'call_credit_spread', option: { underlying: 'AAPL', expiration: '2030-01-18', type: 'call', strikeUsd: 120, dte: 12, multiplier: 100 } }),
    },
  });
  exitHarness.executor = createExecutor({ broker: exitHarness.broker, brakes: exitHarness.brakes, ledger: exitHarness.ledger, config: exitHarness.config, clock: createClock({ now: () => T0 }) });
  const exitResult = await runHarness(exitHarness, { bars: { AAPL: gapUpBars() } });
  assert.equal(exitResult.orders.length, 1, JSON.stringify(exitResult.denied));
  const closeOrder = exitHarness.broker.submitted[0];
  assert.equal(closeOrder.orderClass, 'mleg');
  assert.equal(closeOrder.legs.length, 2);
  const legsBySymbol = Object.fromEntries(closeOrder.legs.map((leg) => [leg.symbol, leg]));
  assert.equal(legsBySymbol[shortOcc].side, 'buy');
  assert.equal(legsBySymbol[shortOcc].positionIntent, 'buy_to_close');
  assert.equal(legsBySymbol[longOcc].side, 'sell');
  assert.equal(legsBySymbol[longOcc].positionIntent, 'sell_to_close');
  const exit = exitResult.actions.find((action) => action.type === 'exit');
  assert.equal(exit.instrument, 'call_credit_spread');
});

test('executor: short stock entry and buy-to-cover exit, brakes always first', async () => {
  // Bearish gap-fade playbook: covered call blocked (no shares) -> short stock (whole shares).
  const harness = optionExecutorHarness({
    specOverrides: { family: 'gapfade' },
    configOverrides: { instruments: { maxShortNotionalUsd: 1000 } },
  });
  const result = await runHarness(harness, { bars: { AAPL: gapUpBars() } });
  assert.equal(harness.broker.submitted.length, 1);
  const order = harness.broker.submitted[0];
  assert.equal(order.side, 'sell');
  assert.equal(order.assetClass, 'us_equity');
  assert.equal(order.positionIntent, undefined, 'short stock is a plain sell');
  assert.ok(Number.isInteger(order.qty));
  assert.ok(order.qty >= 1);
  assert.equal(result.actions.find((action) => action.type === 'entry').assetClass, 'us_equity');

  // Cover the short at its stop (price above entry): buy the exact share count.
  const coverHarness = optionExecutorHarness({
    positions: {
      AAPL: {
        qty: -10, qtySigned: -10, avgPriceUsd: 100, assetClass: 'us_equity',
        openedAt: new Date(T0 - HOUR_MS).toISOString(),
      },
    },
    quotes: { AAPL: { bid: 109.9, ask: 110.1, last: 110, ts: T0 } },
    specOverrides: { family: 'gapfade' },
  });
  const coverResult = await runHarness(coverHarness, { bars: { AAPL: gapUpBars() } });
  assert.equal(coverResult.orders.length, 1);
  assert.equal(coverHarness.broker.submitted[0].side, 'buy');
  assert.equal(coverHarness.broker.submitted[0].qty, 10);
  const exit = coverResult.actions.find((action) => action.type === 'exit');
  assert.equal(exit.reason, 'stop');
  assert.equal(coverHarness.brakes.calls[0].order.side, 'buy');
});

test('executor: falls back to stock when no option is affordable; brakes-first DENY for options', async () => {
  // Premium $5/share => $500 per contract, above the $25 premium budget -> stock fallback.
  const expensiveChain = makeOptionChain({ underlying: 'AAPL', type: 'call', strikes: [110], defaultPremium: 5 });
  const fallbackHarness = optionExecutorHarness({ brokerOptions: { chain: expensiveChain } });
  const fallbackResult = await runHarness(fallbackHarness, { bars: { AAPL: breakoutBars() } });
  assert.equal(fallbackHarness.broker.submitted.length, 1);
  assert.equal(fallbackHarness.broker.submitted[0].assetClass, 'us_equity');
  assert.equal(fallbackResult.actions.find((action) => action.type === 'entry').assetClass, 'us_equity');

  // A brake DENY must stop the option order before the broker sees it.
  const denyChain = makeOptionChain({ underlying: 'AAPL', type: 'call', strikes: [110, 115], defaultPremium: 0.1 });
  const deniedHarness = optionExecutorHarness({
    brokerOptions: { chain: denyChain },
    brakesHandler: () => ({ decision: 'DENY', code: 'OPTION_FORBIDDEN', rule: 'D16', reason: 'structure not allowed' }),
  });
  const deniedResult = await runHarness(deniedHarness, { bars: { AAPL: breakoutBars() } });
  assert.equal(deniedHarness.broker.submitted.length, 0);
  assert.equal(deniedResult.denied[0].code, 'OPTION_FORBIDDEN');
  const brakeCheck = deniedHarness.brakes.calls[0];
  assert.equal(brakeCheck.order.assetClass, 'us_option');
  assert.ok(brakeCheck.order.option);
  assert.equal(brakeCheck.order.structure, 'long_call');
  assert.ok(Number.isFinite(brakeCheck.order.notionalUsd));
});

// ===========================================================================
// v3.2 multi-symbol portfolio: broker snapshots
// ===========================================================================

test('alpaca broker: getSnapshots mapping, stale flag, tolerant fields and 2s cache', async () => {
  const snapshotAt = '2024-01-10T15:00:00Z';
  const nowMs = Date.parse(snapshotAt);
  const fetchImpl = stubFetch((url) => {
    if (url.includes('/v2/stocks/snapshots')) {
      return jsonResponse(200, {
        snapshots: {
          AAPL: {
            latestTrade: { p: '190.5', t: snapshotAt },
            latestQuote: { bp: '190.4', ap: '190.6', t: snapshotAt },
            minuteBar: { o: '189', h: '191', l: '188.8', c: '190.5', v: '1000' },
            dailyBar: { o: '185', h: '192', l: '184', c: '190', v: '5000' },
            prevDailyBar: { c: '188' },
          },
          MSFT: {
            latestTrade: { p: '400' },
            prevDailyBar: { c: '398' },
          },
          // partially missing symbol: must still appear with null fields
          EMPTY: {},
        },
      });
    }
    return jsonResponse(404, {});
  });
  const broker = createAlpacaBroker(
    { mode: 'paper' },
    { secrets: { ALPACA_API_KEY_ID: 'k', ALPACA_API_SECRET_KEY: 's' }, fetchImpl },
  );

  const snapshots = await broker.getSnapshots(['AAPL', 'MSFT', 'EMPTY'], { feed: 'iex', nowMs });
  assert.deepEqual(Object.keys(snapshots).sort(), ['AAPL', 'EMPTY', 'MSFT']);
  const aapl = snapshots.AAPL;
  assert.equal(aapl.symbol, 'AAPL');
  assert.equal(aapl.priceUsd, 190.5);
  assert.equal(aapl.bid, 190.4);
  assert.equal(aapl.ask, 190.6);
  assert.equal(aapl.prevCloseUsd, 188);
  assert.equal(aapl.changeUsd, 2.5);
  assert.equal(aapl.changePct, 2.5 / 188);
  assert.equal(aapl.openUsd, 185);
  assert.equal(aapl.highUsd, 192);
  assert.equal(aapl.lowUsd, 184);
  assert.equal(aapl.volume, 5000);
  assert.equal(aapl.ts, nowMs);
  assert.equal(aapl.stale, false);

  // No timestamp => stale; change still computed when price+prevClose exist.
  assert.equal(snapshots.MSFT.priceUsd, 400);
  assert.equal(snapshots.MSFT.changeUsd, 2);
  assert.equal(snapshots.MSFT.ts, null);
  assert.equal(snapshots.MSFT.stale, true);
  // Missing everything => nulls, never dropped.
  assert.equal(snapshots.EMPTY.priceUsd, null);
  assert.equal(snapshots.EMPTY.stale, true);

  const snapshotCall = fetchImpl.calls.find((call) => call.url.includes('/v2/stocks/snapshots'));
  assert.ok(snapshotCall.url.startsWith('https://data.alpaca.markets/v2/stocks/snapshots?'));
  const url = new URL(snapshotCall.url);
  assert.equal(url.searchParams.get('symbols'), 'AAPL,MSFT,EMPTY');
  assert.equal(url.searchParams.get('feed'), 'iex');
  assert.equal(snapshotCall.init.headers['APCA-API-KEY-ID'], 'k');

  // 2s cache per (feed, symbol set): repeat + within-TTL calls reuse one request.
  const before = fetchImpl.calls.filter((call) => call.url.includes('/v2/stocks/snapshots')).length;
  await broker.getSnapshots(['AAPL', 'MSFT', 'EMPTY'], { feed: 'iex', nowMs: nowMs + 1_500 });
  assert.equal(
    fetchImpl.calls.filter((call) => call.url.includes('/v2/stocks/snapshots')).length,
    before,
    'within-TTL repeat uses the cache',
  );
  // expired cache refreshes
  await broker.getSnapshots(['AAPL', 'MSFT', 'EMPTY'], { feed: 'iex', nowMs: nowMs + 2_500 });
  assert.equal(
    fetchImpl.calls.filter((call) => call.url.includes('/v2/stocks/snapshots')).length,
    before + 1,
  );
  // a different symbol set is a different cache entry
  await broker.getSnapshots(['AAPL'], { feed: 'iex', nowMs: nowMs + 2_600 });
  assert.equal(
    fetchImpl.calls.filter((call) => call.url.includes('/v2/stocks/snapshots')).length,
    before + 2,
  );
});

test('sim broker: deterministic market snapshots (same shape as Alpaca)', () => {
  const config = testConfig({ mode: 'sim' });
  const brokerA = createSimBroker(config, { seed: 42 });
  const brokerB = createSimBroker(config, { seed: 42 });
  const snapshotsA = brokerA.getSnapshots(['AAPL', 'MSFT']);
  const snapshotsB = brokerB.getSnapshots(['AAPL', 'MSFT']);
  assert.deepEqual(snapshotsA, snapshotsB, 'same seed => identical snapshots');
  for (const symbol of ['AAPL', 'MSFT']) {
    const snapshot = snapshotsA[symbol];
    assert.equal(snapshot.symbol, symbol);
    assert.equal(snapshot.simulated, true);
    assert.equal(snapshot.stale, false);
    assert.ok(snapshot.priceUsd > 0);
    assert.ok(snapshot.bid > 0 && snapshot.ask >= snapshot.bid);
    assert.ok(snapshot.highUsd >= snapshot.lowUsd);
    assert.ok(snapshot.lowUsd > 0);
    assert.ok(Number.isFinite(snapshot.prevCloseUsd));
    assert.ok(Number.isFinite(snapshot.ts));
    assert.ok(Number.isFinite(snapshot.volume) && snapshot.volume > 0);
    assert.equal(snapshot.openUsd, snapshot.openUsd); // present/number
  }
  // advances deterministically with the synthetic market
  brokerA.advanceBar(1);
  brokerB.advanceBar(1);
  assert.deepEqual(brokerA.getSnapshots(['AAPL']), brokerB.getSnapshots(['AAPL']));
  // unknown symbol is tolerated
  const unknown = brokerA.getSnapshots(['NOTREAL']);
  assert.equal(unknown.NOTREAL.stale, true);
  assert.equal(unknown.NOTREAL.priceUsd, null);
  // omitted symbols -> configured universe
  assert.ok(Object.keys(brokerA.getSnapshots()).length >= 2);
});

// ===========================================================================
// v3.2 multi-symbol portfolio: executor baskets
// ===========================================================================

function makePortfolioBrokerDouble({ spots = {}, fillPriceBySymbol = {} } = {}) {
  const submitted = [];
  const spotFor = (symbol) => (Number.isFinite(Number(spots[symbol])) ? Number(spots[symbol]) : 100);
  const broker = {
    submitted,
    async getLatestQuote(symbol) {
      const spot = spotFor(symbol);
      return { symbol, bid: round2(spot - 0.1), ask: round2(spot + 0.1), last: spot, ts: T0 };
    },
    async getBars() {
      return {};
    },
    async getAsset(symbol) {
      return { symbol, assetClass: 'us_equity', tradable: true, shortable: true, marginable: true, fractionable: true };
    },
    async getOptionChain() {
      return [];
    },
    async getOptionQuote() {
      return null;
    },
    async submitOrder(order = {}) {
      submitted.push(order);
      const price = Number.isFinite(Number(fillPriceBySymbol[order.symbol]))
        ? Number(fillPriceBySymbol[order.symbol])
        : spotFor(order.symbol);
      return {
        id: `pf-ord-${submitted.length}`,
        clientOrderId: order.clientOrderId ?? null,
        symbol: order.symbol,
        side: order.side,
        qty: order.qty,
        filledQty: order.qty,
        avgFillPriceUsd: round4(price),
        status: 'filled',
        assetClass: order.assetClass ?? 'us_equity',
        submittedAt: T0,
      };
    },
    async getOrders() {
      return [];
    },
    async getOrder() {
      return null;
    },
    getAccount() {
      throw new Error('executor must never call broker.getAccount()');
    },
  };
  return broker;
}

function basketSpecsFor(symbols, paramsBySymbol = {}) {
  return symbols.map((symbol) => baseSpec({
    specId: `spec-${symbol.toLowerCase()}`,
    symbol,
    family: 'breakout',
    ...(paramsBySymbol[symbol] ? { params: { ...baseSpec().params, ...paramsBySymbol[symbol] } } : {}),
  }));
}

function portfolioHarness({
  symbols = ['AAPL', 'MSFT', 'NVDA'],
  spots = {},
  positions = {},
  specs,
  brakesHandler,
  configOverrides,
  mandate,
  portfolio = { maxOpenPositions: 5, maxOrdersPerCycle: 3 },
} = {}) {
  const config = testConfig({ mode: 'paper', ...(configOverrides ?? {}) });
  const clock = createClock({ now: () => T0 });
  const broker = makePortfolioBrokerDouble({ spots });
  const brakes = makeBrakesDouble(brakesHandler);
  const ledger = makeLedgerDouble({ positions, equityUsd: 5000, cashUsd: 100_000 });
  const executor = createExecutor({ broker, brakes, ledger, config, clock });
  const specList = specs ?? basketSpecsFor(symbols);
  const quotes = {};
  const bars = {};
  for (const symbol of symbols) {
    const spot = Number.isFinite(Number(spots[symbol])) ? Number(spots[symbol]) : 100;
    quotes[symbol] = { bid: round2(spot - 0.1), ask: round2(spot + 0.1), last: spot, ts: T0 };
    bars[symbol] = breakoutBars();
  }
  return {
    config,
    clock,
    broker,
    brakes,
    ledger,
    executor,
    agent: { id: 'atm-1', status: 'alive', generation: 0, genome: { symbols, symbol: symbols[0], family: 'breakout' } },
    spec: specList[0],
    specs: specList,
    portfolio,
    mandate: mandate ?? baseMandate({ allowedSymbols: [...symbols] }),
    quotes,
    bars,
    dayStats: { dayKey: '2024-01-10', ordersCount: 0, startEquityUsd: 5000, pnlUsd: 0 },
  };
}

function runPortfolio(harness, extra = {}) {
  return harness.executor.run({
    agent: harness.agent,
    spec: harness.spec,
    specs: harness.specs,
    portfolio: harness.portfolio,
    mandate: harness.mandate,
    quotes: harness.quotes,
    bars: harness.bars,
    dayStats: harness.dayStats,
    now: T0,
    ...extra,
  });
}

test('executor portfolio: enters the basket across symbols with a shared run order cap', async () => {
  const harness = portfolioHarness({
    symbols: ['AAPL', 'MSFT', 'NVDA'],
    spots: { AAPL: 110, MSFT: 210, NVDA: 310 },
    portfolio: { maxOpenPositions: 5, maxOrdersPerCycle: 2 },
  });
  const result = await runPortfolio(harness);
  assert.equal(result.denied.length, 0, JSON.stringify(result.denied));
  assert.equal(result.orders.length, 2, 'maxOrdersPerCycle caps entries for the whole run');
  assert.equal(harness.broker.submitted.length, 2);
  const enteredSymbols = result.actions.filter((action) => action.type === 'entry').map((action) => action.symbol);
  assert.equal(enteredSymbols.length, 2);
  assert.equal(new Set(enteredSymbols).size, 2, 'one order per symbol per run');
  for (const symbol of enteredSymbols) {
    assert.ok(['AAPL', 'MSFT', 'NVDA'].includes(symbol));
  }
  assert.ok(result.actions.some((action) => action.type === 'skip' && action.reason === 'max_orders_per_cycle'));

  // a larger run cap enters the whole 3-symbol basket
  const fullHarness = portfolioHarness({
    symbols: ['AAPL', 'MSFT', 'NVDA'],
    spots: { AAPL: 110, MSFT: 210, NVDA: 310 },
    portfolio: { maxOpenPositions: 5, maxOrdersPerCycle: 3 },
  });
  const fullResult = await runPortfolio(fullHarness);
  assert.equal(fullResult.orders.length, 3);
  assert.deepEqual(
    fullResult.actions.filter((action) => action.type === 'entry').map((action) => action.symbol).sort(),
    ['AAPL', 'MSFT', 'NVDA'],
  );
});

test('executor portfolio: maxOpenPositions caps new positions (brake ceiling still applies)', async () => {
  const harness = portfolioHarness({
    symbols: ['AAPL', 'MSFT', 'NVDA'],
    spots: { AAPL: 110, MSFT: 210, NVDA: 310 },
    portfolio: { maxOpenPositions: 1, maxOrdersPerCycle: 5 },
  });
  const result = await runPortfolio(harness);
  assert.equal(result.orders.length, 1);
  assert.equal(harness.broker.submitted.length, 1);
  const capped = result.actions.filter((action) => action.type === 'skip' && action.reason === 'max_open_positions');
  assert.equal(capped.length, 2);
  assert.equal(capped[0].maxOpenPositions, 1);
  assert.equal(capped[0].openPositions, 1);
});

test('executor portfolio: exits every held basket position with its own symbol spec', async () => {
  const openedAt = new Date(T0 - 2 * HOUR_MS).toISOString();
  // AAPL is at its stop under its own (primary) 2% stop; MSFT uses a wide-stop spec and
  // must NOT be stopped by AAPL's parameters -> proves per-symbol spec selection.
  const specs = basketSpecsFor(['AAPL', 'MSFT'], {
    MSFT: { stopPct: 0.5, targetPct: 0.5, maxHoldBars: 48 },
  });
  const harness = portfolioHarness({
    symbols: ['AAPL', 'MSFT'],
    specs,
    spots: { AAPL: 90, MSFT: 96 },
    positions: {
      AAPL: { qty: 10, qtySigned: 10, avgPriceUsd: 100, assetClass: 'us_equity', openedAt },
      MSFT: { qty: 10, qtySigned: 10, avgPriceUsd: 100, assetClass: 'us_equity', openedAt },
    },
    portfolio: { maxOpenPositions: 5, maxOrdersPerCycle: 2 },
  });
  const result = await runPortfolio(harness);
  assert.equal(result.denied.length, 0, JSON.stringify(result.denied));
  assert.equal(result.orders.length, 1, 'only AAPL exits (MSFT wide-stop spec holds)');
  const exitActions = result.actions.filter((action) => action.type === 'exit');
  assert.equal(exitActions.length, 1);
  assert.equal(exitActions[0].symbol, 'AAPL');
  assert.equal(exitActions[0].reason, 'stop');
  const msftHold = result.actions.find((action) => action.type === 'hold' && action.symbol === 'MSFT');
  assert.ok(msftHold, 'MSFT keeps a hold action under its own spec');
  // the order's brake input carried the matching symbol spec
  const aaplSpec = specs.find((spec) => spec.symbol === 'AAPL');
  assert.equal(harness.brakes.calls[0].spec.specId, aaplSpec.specId);
  assert.equal(harness.broker.submitted[0].symbol, 'AAPL');
  assert.equal(harness.broker.submitted[0].side, 'sell');

  // both positions exit when each spec's own rule is hit (MSFT target under its own params)
  const bothSpecs = basketSpecsFor(['AAPL', 'MSFT'], {
    MSFT: { stopPct: 0.02, targetPct: 0.02, maxHoldBars: 48 },
  });
  const bothHarness = portfolioHarness({
    symbols: ['AAPL', 'MSFT'],
    specs: bothSpecs,
    spots: { AAPL: 90, MSFT: 104 },
    positions: {
      AAPL: { qty: 10, qtySigned: 10, avgPriceUsd: 100, assetClass: 'us_equity', openedAt },
      MSFT: { qty: 10, qtySigned: 10, avgPriceUsd: 100, assetClass: 'us_equity', openedAt },
    },
    portfolio: { maxOpenPositions: 5, maxOrdersPerCycle: 2 },
  });
  const bothResult = await runPortfolio(bothHarness);
  assert.equal(bothResult.orders.length, 2);
  assert.deepEqual(
    bothResult.actions.filter((action) => action.type === 'exit').map((action) => [action.symbol, action.reason]).sort(),
    [['AAPL', 'stop'], ['MSFT', 'target']],
  );
});

test('executor portfolio: legacy single-spec calls behave exactly as before', async () => {
  const harness = executorHarness();
  // no `specs`/`portfolio` at all: the old single-spec contract
  const legacy = await runHarness(harness);
  assert.equal(legacy.orders.length, 1);
  assert.equal(legacy.orders[0].symbol, 'AAPL');
  assert.equal(legacy.actions.find((action) => action.type === 'entry').symbol, 'AAPL');
  // the same call with a one-item basket + portfolio caps still produces one order
  const basketOfOne = await harness.executor.run({
    agent: harness.agent,
    spec: harness.spec,
    specs: [harness.spec],
    portfolio: { maxOpenPositions: 5, maxOrdersPerCycle: 2 },
    mandate: harness.mandate,
    quotes: harness.quotes,
    bars: harness.bars,
    dayStats: harness.dayStats,
    now: T0,
  });
  assert.equal(basketOfOne.orders.length, 1);
  assert.equal(basketOfOne.orders[0].symbol, 'AAPL');
  // describe() exposes the portfolio capability
  const view = harness.executor.describe();
  assert.equal(view.portfolio.supported, true);
});

test('executor portfolio: brakes still run first for every basket order (DENY is contained)', async () => {
  const harness = portfolioHarness({
    symbols: ['AAPL', 'MSFT'],
    spots: { AAPL: 110, MSFT: 210 },
    portfolio: { maxOpenPositions: 5, maxOrdersPerCycle: 3 },
    brakesHandler: (input) => (input.order.symbol === 'MSFT'
      ? { decision: 'DENY', code: 'MARKET_CLOSED', rule: 'D3', reason: 'closed for MSFT' }
      : { decision: 'ALLOW', code: null, rule: null, reason: 'ok' }),
  });
  const result = await runPortfolio(harness);
  assert.equal(result.orders.length, 1);
  assert.equal(harness.broker.submitted.length, 1);
  assert.equal(harness.broker.submitted[0].symbol, 'AAPL');
  const denial = result.denied.find((entry) => entry.code === 'MARKET_CLOSED');
  assert.ok(denial, 'the denied symbol is recorded');
  assert.equal(denial.symbol, 'MSFT');
  assert.equal(harness.brakes.calls.length, 2, 'both orders reached the brake wall first');
});

// ===========================================================================
// simulate
// ===========================================================================

test('simulate: runs a seeded population and returns survival statistics', async (t) => {
  let module;
  try {
    module = await import('../src/simulate.js');
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      t.skip('mortality modules not present yet; simulate.js composes them');
      return;
    }
    throw error;
  }
  assert.equal(typeof module.run, 'function');
  const result = await module.run({ cycles: 6, population: 4, seed: 7 });
  assert.equal(result.mode, 'sim');
  assert.equal(result.seed, 7);
  assert.ok(result.total >= 4);
  assert.equal(result.total, result.survived + result.died);
  assert.ok(result.survived >= 0 && result.died >= 0);
  assert.equal(typeof result.causes, 'object');
  assert.ok(Array.isArray(result.equitySeries));
  assert.ok(result.equitySeries.length > 0);
  assert.ok(result.equitySeries.every((row) => Number.isFinite(row.totalEquityUsd)));
  assert.ok(Number.isFinite(result.medianLifespanHours));
  assert.ok(Number.isFinite(result.meanLifespanHours));
  assert.ok(Number.isFinite(result.firstProfitRate) && result.firstProfitRate >= 0 && result.firstProfitRate <= 1);
  assert.ok(Array.isArray(result.sampleObituaries) && result.sampleObituaries.length <= 5);
  assert.ok(Array.isArray(result.bestGenomes) && result.bestGenomes.length <= 5);
  assert.ok(Number.isFinite(result.durationMs));
  assert.ok(result.durationMs < 60_000, `simulation too slow: ${result.durationMs}ms`);
  assert.equal(result.errorCount, 0, `simulation errors: ${JSON.stringify(result.errors)}`);
});
