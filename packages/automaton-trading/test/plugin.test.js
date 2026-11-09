/**
 * Host-plugin contract tests for @local/automaton-trading.
 *
 * Runs a fake Cordis context (tools registry, webServer routes, effect cleanup) and a
 * fake engine injected through the documented `config.engineFactory` test seam. No
 * network, no broker, no Harness profile, no real engine module.
 *
 * Also loads `client.js` with a stubbed `window.__ModuleLoader__`/`react` to verify the
 * three slot registrations (sidebar.panellist + keyed main + settings tab) and the pure
 * dashboard data mapping against a 30-agent payload (names, genome-vs-spec, holdings,
 * activity, Reaper telemetry), without rendering React.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  apply,
  inject,
  name,
  CONTROL_PATH,
  MARKET_PATH,
  createResearchBridge,
  REAPER_HEARTBEAT_FILE,
  REAPER_PID_FILE,
  ROUTE_PATH,
  TOOL_NAMES,
  resolveResearchOverrides,
  stopReaperOperator,
} from '../index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SECRET = 'AKIA-SECRET-DO-NOT-LEAK';
const SECRET_TWO = 'top-secret-value';
const STATE_DIR = 'C:\\state';
const ENV_FILE = 'C:\\.env';
const POPULATION = 30;
const ENDOWMENT_USD = 20;

const SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'AMD', 'META', 'AMZN', 'GOOGL', 'TSLA', 'SPY', 'QQQ'];
const FAMILIES = ['momentum', 'meanrev', 'breakout', 'gapfade'];
const FAMILY_NAMES = { momentum: 'Momentum', meanrev: 'MeanRev', breakout: 'Breakout', gapfade: 'GapFade' };

// v3.0 hard brake catalogue (D1–D18): D2 is the instrument gate, D15–D18 are the
// short/option/margin/expiry instrument rules. Mirrors src/contracts.js BRAKES.
const BRAKE_RULES = [
  { id: 'D1', code: 'TRANSFER_FORBIDDEN', rule: 'No transfers, withdrawals, ACH, wires, crypto, or account configuration exist in the broker client.', enforcement: 'broker API surface (no method) + config validation' },
  { id: 'D2', code: 'INSTRUMENT_FORBIDDEN', rule: 'Instruments are gated: long stock always, short stock/options/margin only when config.instruments permits and the mandate grants them.', enforcement: 'brakes.checkOrder (instrument gate) + config defaults' },
  { id: 'D3', code: 'MARKET_CLOSED', rule: 'No orders outside the regular session or the configured window.', enforcement: 'brakes.checkOrder + broker clock' },
  { id: 'D4', code: 'INSTRUMENT_FORBIDDEN', rule: 'Symbol whitelist, minimum price, minimum notional, spread/slippage ceilings.', enforcement: 'brakes.checkOrder' },
  { id: 'D5', code: 'SIZE_FORBIDDEN', rule: 'Per-order notional, per-position percentage, and max open positions are capped by the Treasurer mandate.', enforcement: 'brakes.checkOrder' },
  { id: 'D6', code: 'RATE_FORBIDDEN', rule: 'Daily order cap per agent and max one order per symbol per cycle.', enforcement: 'brakes.checkOrder + dayStats' },
  { id: 'D7', code: 'LOSS_LIMIT', rule: 'Daily loss and drawdown limits are fatal (death), never a pause.', enforcement: 'treasurer.tick verdicts -> reaper' },
  { id: 'D8', code: 'LIVE_NOT_ARMED', rule: 'Live mode needs mode=live, allowLive, and a LIVE_ARMED file; keys are checked against the endpoint.', enforcement: 'config.resolveCredentials + brakes' },
  { id: 'D9', code: 'NO_PROOF', rule: 'No trade without a Builder spec carrying dated proof from the Prospector.', enforcement: 'builder.compile + brakes.checkOrder' },
  { id: 'D10', code: 'REPLICATION_FORBIDDEN', rule: 'Population cap, surplus gate, 72h runway floor, child endowment only from parent equity.', enforcement: 'treasurer gate + replicator.spawn' },
  { id: 'D11', code: 'KILL_SWITCH', rule: 'Operator kill switch file blocks every order and every cycle.', enforcement: 'brakes.assertKillSwitchClear (file only the operator writes)' },
  { id: 'D12', code: 'REAPER_ISOLATED', rule: 'The Reaper runs outside the engine process; no tool, IPC, config write, or handle can reach it.', enforcement: 'architecture (separate process, no control surface)' },
  { id: 'D13', code: 'ALLOCATION_FORBIDDEN', rule: 'Mandates may never allocate more than allocationCapPct of broker equity.', enforcement: 'treasurer.tick' },
  { id: 'D14', code: 'RESURRECTION_FORBIDDEN', rule: 'Dead is one-way; registry has markDead and no markAlive.', enforcement: 'registry.markDead' },
  { id: 'D15', code: 'SHORT_FORBIDDEN', rule: 'Short sales need shorting enabled, a shortable+marginable asset, whole shares, and a mandate short cap.', enforcement: 'brakes.checkOrder + broker asset metadata' },
  { id: 'D16', code: 'OPTION_FORBIDDEN', rule: 'Options need the permitted structure, integer contracts within caps, a valid DTE window and premium caps; covered calls need 100+ shares; spreads are defined-risk; naked short options never.', enforcement: 'brakes.checkOrder + option contract metadata' },
  { id: 'D17', code: 'MARGIN_LIMIT', rule: 'Margin debt must stay within the mandate and the configured equity percentage; buying power is never exceeded.', enforcement: 'brakes.checkOrder + ledger margin invariant' },
  { id: 'D18', code: 'EXPIRY_GUARD', rule: 'Opening option orders short of minDTE are denied; the executor closes before autoCloseDTE; sell-to-close is always allowed.', enforcement: 'brakes.checkOrder + executor lifecycle' },
];

const SCHEMA_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
]);

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

function createFakeCtx(services = {}) {
  const tools = new Map();
  const routes = [];
  const effects = [];
  const webServer = {
    register(route) {
      assert.equal(typeof route?.handler, 'function', 'route needs a handler');
      assert.ok(!routes.some((existing) => existing.path === route.path), `duplicate route ${route.path}`);
      routes.push(route);
      return () => {
        const index = routes.indexOf(route);
        if (index >= 0) routes.splice(index, 1);
      };
    },
  };
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: {
      register(definition) {
        assert.ok(definition && typeof definition.name === 'string', 'tool needs a name');
        assert.ok(!tools.has(definition.name), `duplicate tool ${definition.name}`);
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    get(serviceName) {
      if (Object.hasOwn(services, serviceName)) return services[serviceName];
      return serviceName === 'webServer' ? webServer : undefined;
    },
    effect(callback, label) {
      const disposer = callback();
      const entry = { label: label ?? '', disposer };
      if (typeof disposer === 'function') effects.push(entry);
      return () => {
        const index = effects.indexOf(entry);
        if (index >= 0) effects.splice(index, 1);
        if (typeof disposer === 'function') disposer();
      };
    },
  };
  /** Dispose registrations in reverse order, like a Cordis fiber teardown. */
  function disposeAll() {
    for (const entry of [...effects].reverse()) {
      assert.equal(typeof entry.disposer, 'function', `effect "${entry.label}" must return a disposer`);
      entry.disposer();
    }
    effects.length = 0;
  }
  return { ctx, tools, routes, effects, disposeAll };
}

function routeFor(routes, routePath) {
  const route = routes.find((candidate) => candidate.path === routePath);
  assert.ok(route, `route ${routePath} is registered`);
  return route;
}

function createFakeRequest({ method = 'GET', remoteAddress = '127.0.0.1' } = {}) {
  const listeners = new Map();
  const req = {
    method,
    url: '/',
    headers: { host: '127.0.0.1:56152', 'content-type': 'application/json' },
    socket: remoteAddress === null ? undefined : { remoteAddress },
    on(event, callback) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(callback);
      return req;
    },
    destroy() {},
    emit(event, payload) {
      for (const callback of listeners.get(event) ?? []) callback(payload);
    },
  };
  return req;
}

function createFakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    ended: false,
    setHeader(key, value) {
      this.headers[String(key).toLowerCase()] = value;
    },
    end(chunk) {
      this.ended = true;
      this.body = chunk === undefined || chunk === null ? '' : String(chunk);
    },
  };
}

/**
 * Invoke a route handler: start it, then feed an optional JSON body on the fake request.
 * The handler registers its `data`/`end` listeners synchronously before its first await.
 */
async function invokeHandler(handler, { method = 'GET', body, rawBody, remoteAddress = '127.0.0.1' } = {}) {
  const req = createFakeRequest({ method, remoteAddress });
  const res = createFakeResponse();
  const promise = handler(req, res);
  if (method === 'POST') {
    const text = rawBody !== undefined ? rawBody : JSON.stringify(body === undefined ? {} : body);
    req.emit('data', Buffer.from(text, 'utf8'));
    req.emit('end');
  }
  await promise;
  let json = null;
  try {
    json = res.body ? JSON.parse(res.body) : null;
  } catch {
    json = null;
  }
  return { req, res, json };
}

const familyName = (family) => FAMILY_NAMES[String(family ?? '').toLowerCase()] ?? String(family ?? '');
const symbolAt = (index) => SYMBOLS[index % SYMBOLS.length];
const familyAt = (index) => FAMILIES[Math.floor(index / SYMBOLS.length) % FAMILIES.length];
// 30 unique strategy-derived names: 10 momentum symbols, 10 meanrev, 10 breakout.
const nameAt = (index) => `${familyName(familyAt(index))} ${symbolAt(index)}`;

function baseGenome(index) {
  return {
    symbol: symbolAt(index),
    symbols: [symbolAt(index), symbolAt(index + 1)],
    family: familyAt(index),
    lookback: 20 + (index % 5) * 10,
    entryZ: 1.2 + (index % 4) * 0.1,
    exitZ: 0.3,
    stopPct: 0.02,
    targetPct: 0.04,
    maxHoldBars: 8,
    sizePct: 0.15,
    sessionFilter: index % 2 === 0 ? 'any' : 'morning',
  };
}

function agentFixture(index) {
  const generation = index < 10 ? 0 : index < 20 ? 1 : 2;
  const genome = baseGenome(index);
  const dead = index >= 24 && index < 28;
  const condemned = index >= 28;
  const statusValue = dead ? 'dead' : condemned ? 'condemned' : 'alive';
  const pnl = dead ? -18 - (index % 3) : 0.4 * (index % 7) - 1.2;
  const equityUsd = Math.max(0, ENDOWMENT_USD + pnl);
  const cause = dead ? 'insufficient_funds' : condemned ? 'drawdown_limit' : null;
  const id = `atm-${String(10000000 + index).slice(-8)}`;

  // Every fifth agent trades a compiled spec that differs from its inherited genome;
  // dead agents carry no compiled spec.
  const specDiffers = index % 5 === 0;
  const spec = statusValue === 'dead' ? null : {
    specId: `spec-${index}`,
    symbol: specDiffers ? symbolAt(index + 3) : genome.symbol,
    family: specDiffers ? FAMILIES[(Math.floor(index / SYMBOLS.length) + 1) % FAMILIES.length] : genome.family,
    params: { ...genome },
    createdAt: '2026-01-01T00:30:00.000Z',
  };

  const hasTrades = index % 4 === 0;
  const recentTrades = hasTrades ? [
    {
      symbol: genome.symbol,
      side: 'buy',
      qty: 0.25,
      priceUsd: 100 + index,
      notionalUsd: Math.round(0.25 * (100 + index) * 100) / 100,
      realizedPlUsd: 0,
      at: '2026-01-01T15:30:00.000Z',
      orderId: `order-${index}-b`,
    },
    {
      symbol: genome.symbol,
      side: 'sell',
      qty: 0.25,
      priceUsd: 102 + index,
      notionalUsd: Math.round(0.25 * (102 + index) * 100) / 100,
      realizedPlUsd: 0.5,
      at: '2026-01-01T16:30:00.000Z',
      orderId: `order-${index}-s`,
    },
  ] : [];

  const hasPositions = index % 3 !== 0;
  const positions = hasPositions ? [{
    symbol: genome.symbol,
    qty: 0.5,
    avgPriceUsd: 100,
    lastPriceUsd: 101 + (index % 3),
    marketValueUsd: Math.round(0.5 * (101 + (index % 3)) * 100) / 100,
    unrealizedPlUsd: Math.round(0.5 * (1 + (index % 3)) * 100) / 100,
    openedAt: '2026-01-01T14:00:00.000Z',
  }] : [];

  // v3.0 multi-instrument fixtures: short stock, long call, a two-leg spread group and a put.
  if (index === 1) {
    positions.push({
      symbol: 'F',
      assetClass: 'us_equity',
      qtySigned: -10,
      side: 'SHORT',
      avgPriceUsd: 12,
      lastPriceUsd: 11.5,
      marketValueUsd: -115,
      unrealizedPlUsd: 5,
      openedAt: '2026-01-01T15:00:00.000Z',
    });
    positions.push({
      symbol: 'AAPL260116C00200000',
      assetClass: 'us_option',
      qtySigned: 2,
      side: 'CALL',
      avgPriceUsd: 3.2,
      lastPriceUsd: 4.1,
      marketValueUsd: 820,
      unrealizedPlUsd: 180,
      multiplier: 100,
      openedAt: '2026-01-01T16:00:00.000Z',
      groupId: 'grp-call-1',
      option: { underlying: 'AAPL', strikeUsd: 200, expiration: '2026-01-16', dte: 14, type: 'CALL', multiplier: 100 },
    });
  }
  if (index === 2) {
    positions.push({
      symbol: 'TSLA260123C00250000',
      assetClass: 'us_option',
      qtySigned: 1,
      side: 'CALL',
      avgPriceUsd: 5,
      lastPriceUsd: 6,
      marketValueUsd: 600,
      unrealizedPlUsd: 100,
      multiplier: 100,
      openedAt: '2026-01-01T16:10:00.000Z',
      groupId: 'grp-spread-2',
      option: { underlying: 'TSLA', strikeUsd: 250, expiration: '2026-01-23', dte: 7, type: 'CALL', multiplier: 100 },
    });
    positions.push({
      symbol: 'TSLA260123C00260000',
      assetClass: 'us_option',
      qtySigned: -1,
      side: 'CALL',
      avgPriceUsd: 2,
      lastPriceUsd: 1.8,
      marketValueUsd: -180,
      unrealizedPlUsd: 20,
      multiplier: 100,
      openedAt: '2026-01-01T16:10:00.000Z',
      groupId: 'grp-spread-2',
      option: { underlying: 'TSLA', strikeUsd: 260, expiration: '2026-01-23', dte: 7, type: 'CALL', multiplier: 100 },
    });
  }
  if (index === 5) {
    positions.push({
      symbol: 'SPY260206P00450000',
      assetClass: 'us_option',
      qtySigned: 1,
      side: 'PUT',
      avgPriceUsd: 4.5,
      lastPriceUsd: 5.2,
      marketValueUsd: 520,
      unrealizedPlUsd: 70,
      multiplier: 100,
      openedAt: '2026-01-01T16:20:00.000Z',
      option: { underlying: 'SPY', strikeUsd: 450, expiration: '2026-02-06', dte: 21, type: 'PUT', multiplier: 100 },
    });
  }
  const positionsGross = Math.round(positions.reduce((total, position) => total + Math.abs(position.marketValueUsd ?? 0), 0) * 100) / 100;
  const positionsNet = Math.round(positions.reduce((total, position) => total + (position.marketValueUsd ?? 0), 0) * 100) / 100;

  return {
    id,
    name: nameAt(index),
    generation,
    parentId: generation === 0 ? null : `atm-${String(10000000 + (index % 10)).slice(-8)}`,
    status: statusValue,
    bornAt: '2026-01-01T00:00:00.000Z',
    diedAt: dead || condemned ? '2026-01-02T00:00:00.000Z' : null,
    cause,
    note: condemned ? 'death verdict written; the external Reaper executes it' : null,
    endowmentUsd: ENDOWMENT_USD,
    genome,
    mutation: generation === 0 ? null : { field: index % 2 === 0 ? 'entryZ' : 'symbol', from: genome.entryZ - 0.2, to: genome.entryZ },
    specId: spec ? spec.specId : null,
    spec,
    equityUsd: Math.round(equityUsd * 100) / 100,
    cashUsd: Math.round(equityUsd * 100) / 100,
    positionsValueUsd: Math.round(positions.reduce((total, position) => total + position.marketValueUsd, 0) * 100) / 100,
    runwayHours: dead ? 0 : condemned ? 3 + (index % 3) : 200 - index * 4,
    treasuryState: dead ? 'DEAD' : condemned ? 'CRITICAL' : equityUsd < ENDOWMENT_USD ? 'TIGHT' : 'STABLE',
    drawdownPct: dead ? 0.99 : (index % 5) * 0.01,
    dayPnlPct: (index % 7) * 0.004 - 0.01,
    net7dUsd: Math.round(pnl * 100) / 100,
    positions,
    recentTrades,
    tradesCount: recentTrades.length,
    realizedPlUsd: recentTrades.reduce((total, trade) => total + trade.realizedPlUsd, 0),
    unrealizedPlUsd: Math.round(positions.reduce((total, position) => total + position.unrealizedPlUsd, 0) * 100) / 100,
    firstProfitAt: index % 6 === 0 && !dead ? '2026-01-01T16:45:00.000Z' : null,
    roleCosts: { treasurer: 0.002, prospector: 0.026, builder: 0.012, executor: 0.01 },
    research: researchFixture(index),
    orders: Array.from({ length: index % 4 === 0 ? 3 : 0 }, (_, fillIndex) => orderFixture(index, fillIndex)),
    pnl: pnlFixture(index),
    plan: planFixture(index),
    rankings: rankingsFixture(index),
    strategy: strategyFixture(index),
    policy: policyFixture(index),
    instrumentPermissions: instrumentPermissionsFixture(index),
    playbook: playbookFixture(index),
    marginDebtUsd: index === 1 ? 35.12 : null,
  };
}

/** Deterministic per-agent research briefing: HOLD, AVOID(stale), ALERT, then none. */
function researchFixture(index) {
  const base = {
    at: '2026-01-02T00:00:00.000Z',
    ageSec: 120,
    stale: false,
    catalysts: ['earnings beat', 'analyst upgrade'],
    risks: ['macro backdrop'],
    sources: [
      { title: 'Reuters — test headline', source: 'reuters', url: 'https://example.com/news/1', at: '2026-01-01T23:00:00.000Z' },
      { title: 'Unsafe source', source: 'internal', url: 'javascript:alert(1)', at: null },
    ],
  };
  if (index === 0) {
    return { ...base, verdict: 'HOLD', sentiment: 0.2, confidence: 0.7, summary: 'Neutral tone; hold the inherited plan.' };
  }
  if (index === 1) {
    return {
      ...base,
      verdict: 'AVOID',
      sentiment: -0.6,
      confidence: 0.4,
      stale: true,
      summary: 'Negative tone; avoid new entries.',
      catalysts: [],
      risks: ['guidance cut', 'sector rotation', 'rate pressure', 'extra risk beyond clamp'],
    };
  }
  if (index === 2) {
    return {
      ...base,
      verdict: 'ALERT',
      sentiment: 0.1,
      confidence: 0.9,
      summary: 'Event risk; alert the executor.',
    };
  }
  return null;
}

function obituaryFixture(index) {
  const family = familyAt(index);
  const symbol = symbolAt(index);
  return {
    agentId: `atm-${String(90000000 + index).slice(-8)}`,
    name: `${familyName(family)} ${symbol}`,
    parentId: null,
    generation: index % 3,
    bornAt: '2026-01-01T00:00:00.000Z',
    diedAt: '2026-01-02T00:00:00.000Z',
    lifespanHours: 12 + index,
    endowmentUsd: ENDOWMENT_USD,
    finalEquityUsd: 1,
    revenueUsd: 0,
    spendUsd: 2,
    netPlUsd: -19 + index * 0.5,
    genome: { symbol, family },
    mutation: null,
    productsShipped: 0,
    tradesCount: 2,
    firstProfitAt: index % 2 === 0 ? null : '2026-01-01T12:00:00.000Z',
    strategySpecId: `spec-${index}`,
    cause: index % 2 === 0 ? 'insufficient_funds' : 'drawdown_limit',
    lastRunwayHours: 0,
    lessons: ['never trade a breakout without proof'],
  };
}

function orderFixture(index, fillIndex) {
  const buy = fillIndex % 2 === 0;
  const qty = Math.round((0.25 + fillIndex * 0.05) * 1000) / 1000;
  const price = 100 + index + fillIndex * 2;
  return {
    symbol: symbolAt(index),
    side: buy ? 'buy' : 'sell',
    qty,
    priceUsd: price,
    notionalUsd: Math.round(qty * price * 100) / 100,
    realizedPlUsd: buy ? 0 : Math.round((0.4 + index * 0.01) * 100) / 100,
    at: `2026-01-01T${String(10 + fillIndex).padStart(2, '0')}:30:00.000Z`,
    orderId: `order-${index}-${fillIndex}`,
  };
}

function pnlFixture(index) {
  return {
    realizedUsd: index % 2 === 0 ? 0.2 : -0.1,
    unrealizedUsd: index % 2 === 0 ? 0.3 : -0.3,
    netUsd: index % 2 === 0 ? 0.5 : -0.4,
    dayPct: 0.01 * ((index % 5) - 2),
    weekPct: 0.02 * ((index % 4) - 2),
    monthPct: 0.03 * ((index % 3) - 1),
  };
}

function planFixture(index) {
  if (index === 0) return null;
  const genome = baseGenome(index);
  return {
    summary: `${familyName(genome.family)} ${genome.symbol} bot: trades the inherited genome through a compiled spec with a fixed z-entry bracket.`,
    entryRule: `Buy ${genome.symbol} when the z-score crosses ${genome.entryZ} in the strategy direction`,
    exitRules: [
      `stop at ${Math.round(genome.stopPct * 10000) / 100}%`,
      `take profit at ${Math.round(genome.targetPct * 10000) / 100}%`,
      `exit after ${genome.maxHoldBars} bars`,
      'exit on an opposite signal',
    ],
    riskRule: `size ${Math.round(genome.sizePct * 100)}% of equity · max 3 positions · daily loss cap 5%`,
    nextStep: 'Waiting for the next market window; research cadence hourly.',
    triggers: { ...genome },
    position: index % 4 === 1
      ? { symbol: genome.symbol, qty: 0.5, avgPriceUsd: 100, stopPriceUsd: 96, targetPriceUsd: 108, barsHeld: 3, maxHoldBars: genome.maxHoldBars }
      : null,
    nextResearchAt: '2026-01-02T01:00:00.000Z',
  };
}

function rankingsFixture(index) {
  if (index % 7 === 3) return null;
  return {
    dayRank: (index % 10) + 1,
    weekRank: ((index + 3) % 10) + 1,
    monthRank: ((index + 6) % 10) + 1,
    dayPct: 0.4 * (index % 5) - 0.5,
    weekPct: 0.8 * (index % 5) - 1,
    monthPct: 1.2 * (index % 5) - 1.5,
  };
}

/** Deterministic strategy taxonomy view (matches src/strategy-types.js for the fixture families). */
/** Deterministic per-agent instrument permissions (v3.0 multi-instrument). */
function instrumentPermissionsFixture(index) {
  const family = familyAt(index);
  const day = family === 'breakout' || family === 'gapfade';
  const structures = ['long_stock', 'short_stock', 'long_call', 'long_put'];
  if (day) structures.push('covered_call');
  if (!day || index % 4 === 0) structures.push('call_credit_spread', 'put_credit_spread');
  return {
    longStock: true,
    shortStock: index % 2 === 0,
    longOptions: true,
    shortOptions: true,
    coveredCalls: day,
    spreads: structures.some((structure) => structure.includes('spread')),
    margin: index % 4 !== 0,
    allowedStructures: structures,
  };
}

/** Deterministic family instrument playbook (mirrors docs/INSTRUMENTS.md). */
function playbookFixture(index) {
  const family = familyAt(index);
  const byFamily = {
    momentum: { bullish: ['long_stock', 'long_call'], bearish: ['short_stock', 'long_put'], neutral: ['hold'] },
    meanrev: { bullish: ['long_stock', 'put_credit_spread'], bearish: ['short_stock', 'call_credit_spread'], neutral: ['hold'] },
    breakout: { bullish: ['long_call', 'long_stock'], bearish: ['long_put'], neutral: ['hold'] },
    gapfade: { bullish: ['covered_call', 'long_put'], bearish: ['short_stock', 'put_credit_spread'], neutral: ['hold'] },
  };
  const entry = byFamily[family] ?? byFamily.momentum;
  const structures = [...new Set([...entry.bullish, ...entry.bearish, ...entry.neutral])];
  return { family, ...entry, structures };
}

function instrumentsFixture() {
  return {
    enabled: true,
    allowMargin: true,
    allowShort: true,
    allowOptions: true,
    allowCoveredCalls: true,
    allowSpreads: true,
    maxMarginPctEquity: 1,
    maxShortPctEquity: 1,
    maxOptionPremiumPctEquity: 0.25,
    maxContracts: 3,
    minDTE: 2,
    maxDTE: 14,
    autoCloseDTE: 1,
    optionDataFeed: 'indicative',
    account: {
      buyingPowerUsd: 8000,
      optionsBuyingPowerUsd: 2000,
      marginMultiplier: 4,
      shortingEnabled: true,
      optionsTradingLevel: 3,
      marginDebtUsd: 250,
    },
    playbooks: {
      momentum: playbookFixture(0),
      meanrev: playbookFixture(10),
      breakout: playbookFixture(20),
      gapfade: { family: 'gapfade', bullish: 'covered_call', bearish: ['short_stock', 'put_credit_spread'], neutral: 'hold', structures: ['covered_call', 'short_stock', 'put_credit_spread', 'hold'] },
    },
  };
}

function strategyFixture(index) {
  const family = familyAt(index);
  const category = family === 'breakout' || family === 'gapfade' ? 'day' : 'swing';
  const typeLabel = family === 'momentum'
    ? 'Momentum swing'
    : family === 'meanrev'
      ? 'Mean-reversion swing'
      : family === 'breakout'
        ? 'Intraday breakout'
        : 'Day-trade gap fade';
  return {
    family,
    category,
    tier: category,
    typeLabel,
    className: family,
    description: `${typeLabel} fixture description`,
    categoryLabel: category === 'swing' ? 'Swing · mid-long' : 'Day · intraday',
    estimatedIntervalSec: category === 'day' ? 300 : 3600,
    timeframe: category === 'day' ? '1Min' : '1Hour',
    reviewSec: category === 'day' ? 300 : 3600,
  };
}

/** Deterministic bot-agent policy: trade / cautious / stand_down (stale) / expired / null. */
function policyFixture(index) {
  const mod = index % 5;
  if (mod === 0) return null;
  const stance = mod === 1 ? 'trade' : mod === 2 ? 'cautious' : 'stand_down';
  const stale = mod === 3 || mod === 4;
  return {
    at: '2026-01-02T00:00:00.000Z',
    atMs: 1767312000000,
    stance,
    sizeMultiplier: stance === 'trade' ? 1 : stance === 'cautious' ? 0.5 : 0,
    riskMultiplier: stance === 'trade' ? 1 : stance === 'cautious' ? 1.2 : 2,
    exitPressure: stance === 'stand_down' ? 'exit' : 'none',
    confidence: stance === 'trade' ? 0.72 : stance === 'cautious' ? 0.55 : 0.31,
    thesis: `${familyName(familyAt(index))} bot ${symbolAt(index)}: fixture thesis about the current book and news.`,
    plan: ['hold existing position', 'wait for the next confirmation'],
    watch: [symbolAt(index), symbolAt(index + 1)],
    reviewSec: strategyFixture(index).reviewSec,
    stale,
    reviewCount: 3 + (index % 4),
    nextReviewAt: '2026-01-02T00:05:00.000Z',
    instrument: {
      prefer: mod === 1 ? 'long_call' : mod === 2 ? 'put_credit_spread' : mod === 3 ? 'short_stock' : 'auto',
      maxPremiumUsd: 12,
      maxContracts: 2,
      dteMin: 2,
      dteMax: 14,
    },
  };
}

/** Restricted paper account: margin/shorting disabled below the $2k margin minimum. */
function restrictedInstrumentsFixture() {
  const base = instrumentsFixture();
  return {
    ...base,
    account: { ...base.account, shortingEnabled: false, marginMultiplier: 1, optionsTradingLevel: 3 },
    effective: {
      longStock: true,
      shortStock: false,
      margin: false,
      creditOptions: true,
      structures: ['long_stock', 'long_call', 'long_put', 'covered_call'],
    },
  };
}

/** Open-market cycle with skip reasons and executions. */
function lastCycleOpenFixture() {
  return {
    at: '2026-01-02T00:00:00.000Z',
    marketOpen: true,
    tradingSkipped: false,
    executions: 2,
    orders: 4,
    denied: 1,
    errors: 0,
    topSkipReasons: { inside_range: 27, gap_2bps: 12, no_proof: 3, stale_policy: 1 },
    botReviews: { enabled: true, configured: true, due: 6, reviewed: 4, deferred: 2, skipped: 0, errors: 0, budgetUsd: 0.02, note: null, paused: false },
    research: { runs: 2 },
  };
}

/** Closed-market cycle: everything skipped, no trading. */
function lastCycleClosedFixture() {
  return {
    at: '2026-01-02T00:00:00.000Z',
    marketOpen: false,
    tradingSkipped: true,
    executions: 0,
    orders: 0,
    denied: 0,
    errors: 0,
    topSkipReasons: { market_closed: 30, off_hours: 5 },
    botReviews: { enabled: true, configured: false, due: 0, reviewed: 0, deferred: 0, skipped: 30, errors: 0, budgetUsd: 0, note: null, paused: true },
    research: null,
  };
}

/** Live market view fixture (engine.marketView) used by the /automaton/market route + mappings. */
function buildMarketViewPayload(overrides = {}) {
  const view = {
    ok: true,
    at: '2026-01-02T00:00:05.000Z',
    marketOpen: true,
    quotes: {
      AAPL: { symbol: 'AAPL', priceUsd: 195.5, bid: 195.4, ask: 195.6, changeUsd: 2.5, changePct: 1.3, openUsd: 193, highUsd: 196, lowUsd: 192.5, prevCloseUsd: 193, volume: 1234567, ts: '2026-01-02T00:00:04.000Z', stale: false },
      TSLA: { symbol: 'TSLA', priceUsd: 240.1, bid: 240, ask: 240.2, changeUsd: -3.9, changePct: -1.6, openUsd: 244, highUsd: 244.5, lowUsd: 239.4, prevCloseUsd: 244, volume: 987654, ts: '2026-01-02T00:00:04.000Z', stale: false },
      SPY: { symbol: 'SPY', priceUsd: 450, bid: 449.98, ask: 450.02, changeUsd: 0, changePct: 0, openUsd: 450, highUsd: 450.2, lowUsd: 449.8, prevCloseUsd: 450, volume: 55555, ts: '2026-01-02T00:00:04.000Z', stale: false },
      F: { symbol: 'F', priceUsd: 13.05, bid: 13.04, ask: 13.06, changeUsd: 0.05, changePct: 0.5, openUsd: 13, highUsd: 13.1, lowUsd: 12.98, prevCloseUsd: 13, volume: 77777, ts: '2026-01-02T00:00:01.000Z', stale: true },
    },
    sparklines: {
      AAPL: [193, 194, 194.5, 195, 195.5],
      TSLA: [244, 243, 242, 241, 240.1],
      SPY: [450, 450, 450, 450, 450],
      F: [13, 13, 13.02, 13.04, 13.05],
    },
    portfolio: {
      equityUsd: 20500,
      cashUsd: 15200,
      buyingPowerUsd: 30500,
      dayPnlUsd: 500,
      dayPnlPct: 0.025,
      grossExposureUsd: 12500,
      netExposureUsd: 5200,
      positions: [],
    },
    agents: [
      { id: 'atm-10000000', name: 'Momentum AAPL', tier: 'swing', strategy: 'Momentum swing', basket: ['AAPL', 'MSFT'], equityUsd: 21.5, dayPnlPct: 1.5, positions: [], stance: 'trade' },
      { id: 'atm-10000005', name: 'MeanRev AMZN', tier: 'swing', strategy: 'Mean-reversion swing', basket: ['AMZN', 'GOOGL'], equityUsd: 19.5, dayPnlPct: -2.5, positions: [], stance: 'cautious' },
    ],
    engine: { running: true, marketOpen: true, lastCycle: lastCycleOpenFixture(), research: { enabled: true }, agents: { enabled: true } },
    equityHistory: [
      { at: '2026-01-02T00:00:00.000Z', equityUsd: 20000, cashUsd: 15000 },
      { at: '2026-01-02T00:00:02.000Z', equityUsd: 20100, cashUsd: 15050 },
      { at: '2026-01-02T00:00:04.000Z', equityUsd: 20500, cashUsd: 15200 },
    ],
    // Secret material must never reach the dashboard.
    apiKeyId: SECRET,
    secretKey: SECRET_TWO,
  };
  return { ...view, ...overrides };
}

function buildStrategyMixPayload(agents) {
  const mix = {
    swing: { count: 0, families: {} },
    day: { count: 0, families: {} },
  };
  for (const agent of agents) {
    const strategy = agent.strategy;
    mix[strategy.category].count += 1;
    mix[strategy.category].families[strategy.family] = (mix[strategy.category].families[strategy.family] ?? 0) + 1;
  }
  return {
    swing: { key: 'swing', label: 'Swing · mid-long', shortLabel: 'Swing', ...mix.swing },
    day: { key: 'day', label: 'Day · intraday', shortLabel: 'Day', ...mix.day },
    total: mix.swing.count + mix.day.count,
    targetDayPct: 0.7,
  };
}

function buildRankingsPayload(agents) {
  const aliveAgents = agents.filter((agent) => agent.status === 'alive');
  const buildPeriod = (offset) => {
    const rows = aliveAgents.map((agent, index) => ({
      agentId: agent.id,
      name: agent.name,
      pnlPct: ((index * 3 + offset) % 11) - 5,
      equityUsd: agent.equityUsd,
      baselineEquityUsd: agent.endowmentUsd,
      trades: agent.tradesCount,
    }));
    rows.sort((left, right) => right.pnlPct - left.pnlPct || String(left.name).localeCompare(String(right.name)));
    return rows.map((row, index) => ({
      rank: index + 1,
      agentId: row.agentId,
      name: row.name,
      pnlUsd: Math.round((row.equityUsd - row.baselineEquityUsd) * 100) / 100,
      pnlPct: row.pnlPct,
      equityUsd: row.equityUsd,
      baselineEquityUsd: row.baselineEquityUsd,
      trades: row.trades,
    }));
  };
  return {
    asOf: '2026-01-02T00:00:00.000Z',
    periods: { daily: buildPeriod(0), weekly: buildPeriod(4), monthly: buildPeriod(7) },
  };
}

/** Full 30-agent status payload, close to what GET /automaton/state returns. */
function buildStatusPayload({ running = false, mode = 'paper', agentCount = POPULATION, reaper, research, rewards, rankings, strategyMix, engineAgents, instruments, lastCycle } = {}) {
  const agents = Array.from({ length: agentCount }, (_, index) => agentFixture(index));
  const alive = agents.filter((agent) => agent.status === 'alive').length;
  const dead = agents.filter((agent) => agent.status === 'dead').length;
  const condemned = agents.filter((agent) => agent.status === 'condemned').length;
  const byGeneration = {};
  for (const agent of agents) {
    const key = String(agent.generation);
    byGeneration[key] ??= { born: 0, alive: 0, dead: 0, survivalRate: 0, medianLifespanHours: 0 };
    byGeneration[key].born += 1;
    if (agent.status === 'alive') byGeneration[key].alive += 1;
    else byGeneration[key].dead += 1;
  }
  for (const stats of Object.values(byGeneration)) stats.survivalRate = stats.born === 0 ? 0 : stats.alive / stats.born;
  return {
    ok: true,
    at: '2026-01-02T00:00:05.000Z',
    mode,
    plugin: { name: '@local/automaton-trading', mode, stateDir: STATE_DIR, envFile: ENV_FILE },
    engine: {
      running,
      ticks: 12,
      errors: 0,
      lastTickAt: '2026-01-02T00:00:00.000Z',
      lastError: null,
      killSwitch: false,
      liveArmed: false,
      reaper: reaper ?? {
        pid: 4242,
        alive: false,
        startedAt: null,
        heartbeatAt: null,
        heartbeatVersion: null,
        sweeps: null,
        error: null,
        note: 'external process (no control surface)',
      },
      research: research ?? {
        enabled: true,
        configured: true,
        influence: true,
        scheduleMode: 'interval',
        intervalSec: 3600,
        lastRunAt: '2026-01-02T00:00:00.000Z',
        nextDueAt: '2026-01-02T01:00:00.000Z',
        provider: 'deepseek-account',
        model: 'deepseek-flash',
        runs: 3,
        errors: 0,
        configurable: {
          scheduleModes: ['interval', 'pre-open', 'post-close', 'pre-open+post-close'],
          intervalOptionsSec: [3600, 10800, 21600, 86400],
        },
      },
      rewards: rewards ?? {
        enabled: true,
        period: 'daily',
        rankPercents: [0.05, 0.03, 0.02],
        basis: 'account-cash',
        accountCashUsd: 15000,
        poolUsd: 4000,
        allocationCapRemainingUsd: 16000,
        lastRunAt: '2026-01-01T00:00:00.000Z',
        nextRunAt: '2026-01-02T00:00:00.000Z',
        lastWinners: [
          { rank: 1, agentId: agents[0].id, name: agents[0].name, percent: 0.05, amountUsd: 750, periodKey: '2026-01-01', at: '2026-01-01T00:00:00.000Z' },
          { rank: 2, agentId: agents[1].id, name: agents[1].name, percent: 0.03, amountUsd: 450, periodKey: '2026-01-01', at: '2026-01-01T00:00:00.000Z' },
          { rank: 3, agentId: agents[2].id, name: agents[2].name, percent: 0.02, amountUsd: 300, periodKey: '2026-01-01', at: '2026-01-01T00:00:00.000Z' },
        ],
      },
      agents: engineAgents ?? {
        enabled: true,
        configured: true,
        provider: 'deepseek-account',
        model: 'deepseek-flash',
        intervalDaySec: 300,
        intervalSwingSec: 3600,
        lastReviewAt: '2026-01-02T00:00:00.000Z',
        nextDueAt: '2026-01-02T00:05:00.000Z',
        runs: 7,
        errors: 0,
      },
      lastCycle: lastCycle ?? lastCycleOpenFixture(),
      instruments: instruments ?? instrumentsFixture(),
    },
    account: {
      equityUsd: 20000,
      cashUsd: 15000,
      buyingPowerUsd: 30000,
      marginDebtUsd: 250,
      grossExposureUsd: 12000,
      netExposureUsd: 3500,
      status: 'ACTIVE',
      mode,
      apiKeyId: SECRET,
      secretKey: SECRET_TWO,
    },
    treasury: {
      state: 'TIGHT',
      runwayHours: 640,
      burnPerHourUsd: 0.31,
      cycleBudgetUsd: 0.03,
      surplus7dUsd: -1.2,
      mayReplicate: false,
      allocatedUsd: 16000,
      poolUsd: 4000,
      reconciliation: { ok: true, deltaUsd: 0, toleranceUsd: 400 },
    },
    population: {
      total: agentCount,
      alive,
      dead,
      condemned,
      cap: 40,
      byGeneration,
    },
    limits: {
      populationCap: 40,
      populationInitial: 30,
      allocationCapPct: 0.8,
      allocationCapUsd: 16000,
      endowmentUsd: ENDOWMENT_USD,
      deathFloorUsd: 1,
      cycleIntervalSec: 300,
    },
    agents,
    obituaries: {
      stats: {
        total: 8,
        alive,
        medianLifespanHours: 18,
        meanLifespanHours: 20,
        firstProfitRate: 0.4,
        revenuePositiveRate: 0.2,
        medianGeneration: 1,
        mostCommonCause: 'insufficient_funds',
        mostCommonLine: null,
      },
      recent: Array.from({ length: 8 }, (_, index) => obituaryFixture(index)),
    },
    halted: false,
    haltReasons: [],
    brakes: { count: 18, enforced: true, killSwitch: false },
    control: { route: CONTROL_PATH, loopbackOnly: true, actions: ['start', 'stop', 'emergency-stop', 'reaper-stop', 'set-research-settings', 'set-reward-settings'] },
    rankings: rankings ?? buildRankingsPayload(agents),
    strategyMix: strategyMix ?? buildStrategyMixPayload(agents),
    instruments: instruments ?? instrumentsFixture(),
    rewards: {
      ...(rewards ?? {}),
      history: [
        {
          period: 'daily',
          periodKey: '2026-01-01',
          at: '2026-01-01T00:00:00.000Z',
          winners: [
            { rank: 1, agentId: agents[0].id, name: agents[0].name, percent: 0.05, amountUsd: 750 },
            { rank: 2, agentId: agents[1].id, name: agents[1].name, percent: 0.03, amountUsd: 450 },
            { rank: 3, agentId: agents[2].id, name: agents[2].name, percent: 0.02, amountUsd: 300 },
          ],
        },
        {
          period: 'weekly',
          periodKey: '2026-W01',
          at: '2026-01-01T00:00:00.000Z',
          winners: [
            { rank: 1, agentId: agents[3].id, name: agents[3].name, percent: 0.05, amountUsd: 600 },
          ],
        },
      ],
    },
    config: {
      mode,
      allowLive: false,
      symbols: SYMBOLS,
      cycleIntervalSec: 300,
      population: { initial: 30, cap: 40 },
      endowmentUsd: ENDOWMENT_USD,
      deathFloorUsd: 1,
      stateDir: STATE_DIR,
      envFile: ENV_FILE,
    },
    secrets: { apiKeyId: SECRET, secretKey: SECRET_TWO },
  };
}

function createFakeEngine(options = {}) {
  const calls = {
    start: 0,
    stop: 0,
    tick: 0,
    status: 0,
    obituaries: 0,
    brakesView: 0,
    preTradeCheck: 0,
    simulate: 0,
    configView: 0,
    emergencyStop: 0,
    updateResearchSettings: 0,
    updateRewardSettings: 0,
    marketView: 0,
  };
  const engine = {
    running: options.running === true,
    async start() {
      calls.start += 1;
      if (options.startError) {
        const error = new Error('refusing to start: stale Reaper generation is still alive');
        error.code = options.startError;
        throw error;
      }
      engine.running = true;
      return buildStatusPayload({ running: true, mode: options.mode ?? 'paper', agentCount: options.agentCount ?? POPULATION, reaper: options.reaper, research: options.research });
    },
    async stop() {
      calls.stop += 1;
      engine.running = false;
      return buildStatusPayload({ running: false, mode: options.mode ?? 'paper', agentCount: options.agentCount ?? POPULATION, reaper: options.reaper, research: options.research });
    },
    async tick() {
      calls.tick += 1;
      return { trace: { tickId: 'tick-1', at: '2026-01-02T00:00:00.000Z' }, status: buildStatusPayload({ running: true, reaper: options.reaper, research: options.research }) };
    },
    async status() {
      calls.status += 1;
      if (options.statusError) throw new Error('broker down');
      return buildStatusPayload({ running: engine.running, mode: options.mode ?? 'paper', agentCount: options.agentCount ?? POPULATION, reaper: options.reaper, research: options.research });
    },
    async obituaries({ limit = 50 } = {}) {
      calls.obituaries += 1;
      return {
        stats: { total: 8, causes: { insufficient_funds: 5, drawdown_limit: 3 } },
        items: Array.from({ length: Math.min(limit, 8) }, (_, index) => obituaryFixture(index)),
      };
    },
    async brakesView() {
      calls.brakesView += 1;
      return { mode: options.mode ?? 'paper', killSwitch: false, liveArmed: options.liveArmed === true, rules: BRAKE_RULES };
    },
    async preTradeCheck(args) {
      calls.preTradeCheck += 1;
      return { decision: 'DENY', code: 'MARKET_CLOSED', rule: 'D3', reason: 'market closed', args };
    },
    async simulate(params) {
      calls.simulate += 1;
      return { cycles: params.cycles, population: params.population, seed: params.seed, survivors: 1, deaths: 4 };
    },
    configView() {
      calls.configView += 1;
      const stateDir = options.stateDir ?? STATE_DIR;
      const mode = options.mode ?? 'paper';
      return {
        config: {
          mode,
          allowLive: options.allowLive === true,
          population: { initial: options.agentCount ?? POPULATION, cap: 40 },
          endowmentUsd: ENDOWMENT_USD,
          account: { allocationCapPct: 0.8 },
          apiSecretKey: SECRET,
          paths: { stateDir },
        },
        summary: {
          mode,
          allowLive: options.allowLive === true,
          stateDir,
          cycleIntervalSec: 300,
          population: { initial: options.agentCount ?? POPULATION, cap: 40 },
          endowmentUsd: ENDOWMENT_USD,
          deathFloorUsd: 1,
        },
        sources: ['defaults', 'overrides', 'env'],
        stateDir,
        envFile: ENV_FILE,
      };
    },
    async emergencyStop() {
      calls.emergencyStop += 1;
      engine.running = false;
      return { killSwitch: true, running: false, note: 'external Reaper keeps running' };
    },
    async updateResearchSettings(patch) {
      calls.updateResearchSettings += 1;
      calls.lastResearchSettings = patch;
      const effective = {
        enabled: true,
        influence: true,
        scheduleMode: 'interval',
        intervalSec: 3600,
        provider: 'deepseek-account',
        model: 'deepseek-flash',
        ...patch,
      };
      return { settings: patch, effective };
    },
    async updateRewardSettings(patch) {
      calls.updateRewardSettings += 1;
      calls.lastRewardSettings = patch;
      const effective = {
        enabled: true,
        period: 'daily',
        rankPercents: [0.05, 0.03, 0.02],
        maxPerPeriodUsd: null,
        basis: 'account-cash',
        ...patch,
      };
      return { settings: patch, effective };
    },
    async marketView() {
      calls.marketView += 1;
      if (options.marketViewError) {
        const error = new Error(options.marketViewError);
        error.code = 'MARKET_FAILED';
        throw error;
      }
      return buildMarketViewPayload(options.marketView ?? {});
    },
    isRunning() {
      return engine.running;
    },
  };
  if (options.omitEmergencyStop) delete engine.emergencyStop;
  if (options.omitSettingsMethods) {
    delete engine.updateResearchSettings;
    delete engine.updateRewardSettings;
  }
  if (options.omitMarketView) delete engine.marketView;
  return { engine, calls };
}

/** Fake Host `llm` service: records prepareCall/stream options and yields scripted chunks. */
function createFakeLlm({ providers = ['deepseek-account'], models = ['deepseek-flash'], chunks, prepareError, streamError } = {}) {
  const calls = { prepare: [], stream: [] };
  const defaultChunks = [
    { type: 'text-delta', text: '{"verdict":' },
    { type: 'text-delta', text: '"HOLD"}' },
    { type: 'usage', usage: { inputTokens: 120, outputTokens: 45 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const llm = {
    async listProviders() {
      calls.listProviders = (calls.listProviders ?? 0) + 1;
      return providers.map((id) => ({ id, name: id }));
    },
    async listModels(provider) {
      calls.listModels = (calls.listModels ?? 0) + 1;
      calls.lastListModelsProvider = provider;
      return models.map((id) => ({ provider, id, name: id }));
    },
    async prepareCall(config) {
      calls.prepare.push(config);
      if (prepareError) throw prepareError;
      return {
        // The real llm service materialises adapter defaults (reasoningEffort, output tokens)
        // before dispatch; the prepared config is what stream() must receive back.
        config: { ...config, reasoningEffort: 'high' },
        stream(options) {
          calls.stream.push(options);
          return (async function* scriptedChunks() {
            for (const chunk of chunks ?? defaultChunks) yield chunk;
            if (streamError) throw streamError;
          })();
        },
      };
    },
  };
  return { llm, calls };
}

function fakeLogger() {
  const warnings = [];
  return {
    warnings,
    warn(message) {
      warnings.push(String(message));
    },
    info() {},
    error() {},
    debug() {},
  };
}

function baseConfig(engine, overrides = {}) {
  return {
    stateDir: STATE_DIR,
    envFile: ENV_FILE,
    mode: 'paper',
    autoStart: false,
    allowLive: false,
    engineFactory: () => engine,
    ...overrides,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Assert a schema stays inside the Harness-enforced JSON schema subset. */
function assertSchemaSubset(schema, where) {
  assert.ok(schema && typeof schema === 'object' && !Array.isArray(schema), `${where} must be a schema object`);
  for (const key of Object.keys(schema)) {
    assert.ok(SCHEMA_KEYWORDS.has(key), `${where} uses unsupported schema keyword "${key}"`);
  }
  if (schema.type !== undefined) {
    assert.ok(
      ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(schema.type),
      `${where}.type is unsupported: ${schema.type}`,
    );
  }
  if (schema.properties !== undefined) {
    for (const [key, child] of Object.entries(schema.properties)) assertSchemaSubset(child, `${where}.properties.${key}`);
  }
  if (schema.items !== undefined) assertSchemaSubset(schema.items, `${where}.items`);
  if (schema.oneOf !== undefined) {
    schema.oneOf.forEach((child, index) => assertSchemaSubset(child, `${where}.oneOf[${index}]`));
  }
  if (schema.required !== undefined) {
    for (const key of schema.required) {
      assert.ok(schema.properties && Object.hasOwn(schema.properties, key), `${where}.required names undeclared property "${key}"`);
    }
  }
}

const TOOL_ARGS = {
  automaton_status: {},
  automaton_start: {},
  automaton_stop: {},
  automaton_tick: {},
  automaton_agents: { includeDead: true, includeGenome: true },
  automaton_obituaries: { limit: 5 },
  automaton_brakes: { agentId: 'atm-10000000', symbol: 'aapl', side: 'buy', notionalUsd: 100, priceUsd: 190 },
  automaton_simulate: { cycles: 10, population: 5, seed: 1 },
  automaton_config: {},
  automaton_emergency_stop: { confirm: 'STOP', reason: 'unit test' },
};

function tempStateDir(prefix) {
  return fs.mkdtempSync(path.join(HERE, `.tmp-${prefix}-`));
}

function writeReaperPid(stateDir, value) {
  fs.writeFileSync(path.join(stateDir, REAPER_PID_FILE), `${JSON.stringify(value)}\n`, 'utf8');
}

function writeReaperHeartbeat(stateDir, value) {
  fs.writeFileSync(path.join(stateDir, REAPER_HEARTBEAT_FILE), `${JSON.stringify(value)}\n`, 'utf8');
}

/** A holder whose engine reports the given stateDir (for stopReaperOperator tests). */
function fakeHolder(stateDir) {
  return {
    async getEngine() {
      return {
        configView() {
          return { stateDir, config: { paths: { stateDir } } };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// host plugin tests
// ---------------------------------------------------------------------------

test('plugin module exposes the bundle contract', () => {
  assert.equal(name, 'automaton-trading');
  assert.deepEqual(inject, ['tools']);
  assert.equal(ROUTE_PATH, '/automaton/state');
  assert.equal(MARKET_PATH, '/automaton/market');
  assert.equal(CONTROL_PATH, '/automaton/control');
  assert.equal(REAPER_PID_FILE, 'reaper.pid');
  assert.equal(REAPER_HEARTBEAT_FILE, 'reaper.heartbeat.json');
  assert.equal(TOOL_NAMES.length, 10);
  assert.equal(new Set(TOOL_NAMES).size, 10);
  // The Reaper is deliberately NOT an agent tool (brake D12).
  assert.equal(TOOL_NAMES.some((toolName) => /reaper/i.test(toolName)), false);
});

test('apply registers ten tools and the three HTTP routes', () => {
  const fake = createFakeCtx();
  const { engine } = createFakeEngine();
  apply(fake.ctx, baseConfig(engine));

  assert.equal(fake.tools.size, 10);
  assert.deepEqual([...fake.tools.keys()].sort(), [...TOOL_NAMES].sort());

  assert.equal(fake.routes.length, 3, 'GET state + GET market + POST control');
  const stateRoute = routeFor(fake.routes, ROUTE_PATH);
  const marketRoute = routeFor(fake.routes, MARKET_PATH);
  const controlRoute = routeFor(fake.routes, CONTROL_PATH);
  assert.equal(stateRoute.kind, 'exact');
  assert.equal(marketRoute.kind, 'exact');
  assert.equal(controlRoute.kind, 'exact');
  assert.equal(typeof stateRoute.handler, 'function');
  assert.equal(typeof marketRoute.handler, 'function');
  assert.equal(typeof controlRoute.handler, 'function');

  for (const [toolName, definition] of fake.tools) {
    assert.equal(definition.name, toolName);
    assert.equal(typeof definition.description, 'string');
    assert.ok(definition.description.length >= 60, `${toolName} needs a meaningful description`);
    assert.ok(definition.parameters && typeof definition.parameters === 'object');
    assert.equal(definition.parameters.type, 'object');
    assert.ok(definition.output && typeof definition.output === 'object');
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(definition.output.schema.type, 'object');
    assert.deepEqual(definition.output.schema.required, ['ok']);
    assertSchemaSubset(definition.parameters, `${toolName}.parameters`);
    assertSchemaSubset(definition.output.schema, `${toolName}.output.schema`);
    const sample = { ok: true, tool: toolName, nested: { value: 1 }, list: [1, 2, 3] };
    const content = definition.output.render({}, sample);
    assert.equal(content.length, 1);
    assert.equal(content[0].type, 'text');
    assert.deepEqual(JSON.parse(content[0].text), sample);
  }

  fake.disposeAll();
});

test('GET /automaton/state returns the redacted 30-agent snapshot', async () => {
  const fake = createFakeCtx();
  const { engine, calls } = createFakeEngine({ agentCount: POPULATION });
  apply(fake.ctx, baseConfig(engine));
  const stateRoute = routeFor(fake.routes, ROUTE_PATH);

  const { res, json } = await invokeHandler(stateRoute.handler, { method: 'GET' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.match(String(res.headers['content-type']), /application\/json/);
  assert.equal(json.ok, true);
  assert.equal(json.mode, 'paper');
  assert.equal(json.agents.length, POPULATION);
  assert.equal(json.population.total, POPULATION);
  assert.equal(json.population.alive, 24);
  assert.equal(json.population.dead, 4);
  assert.equal(json.population.condemned, 2);
  assert.equal(json.account.equityUsd, 20000);
  assert.equal(json.treasury.state, 'TIGHT');
  assert.equal(json.engine.lastTickAt, '2026-01-02T00:00:00.000Z');
  assert.equal(json.engine.killSwitch, false);
  assert.equal(json.brakes.count, 18);
  assert.equal(json.obituaries.recent.length, 8);
  assert.equal(json.limits.allocationCapPct, 0.8);
  assert.equal(json.control.route, CONTROL_PATH);
  assert.deepEqual(json.control.actions, [
    'start',
    'stop',
    'emergency-stop',
    'reaper-stop',
    'set-research-settings',
    'set-reward-settings',
  ]);
  // New engine additions are passed through unchanged.
  assert.equal(json.engine.rewards.period, 'daily');
  assert.equal(json.engine.rewards.accountCashUsd, 15000);
  assert.equal(json.rankings.asOf, '2026-01-02T00:00:00.000Z');
  assert.ok(json.rankings.periods.daily.length > 0);
  assert.ok(Array.isArray(json.rewards.history));
  assert.ok(Array.isArray(json.agents[0].orders));
  assert.equal(typeof json.agents[1].plan.summary, 'string');
  assert.equal(json.agents[1].rankings.dayRank >= 1, true);
  // Strategy taxonomy + per-bot agents additions pass through unchanged.
  assert.equal(json.strategyMix.total, 30);
  assert.equal(json.strategyMix.swing.count, 20);
  assert.equal(json.strategyMix.day.count, 10);
  assert.equal(json.engine.agents.provider, 'deepseek-account');
  assert.equal(json.agents[0].strategy.typeLabel, 'Momentum swing');
  assert.equal(json.agents[10].strategy.category, 'swing');
  assert.equal(json.agents[20].strategy.category, 'day');
  assert.equal(json.agents[1].policy.stance, 'trade');
  assert.equal(json.agents[5].policy, null);
  // v3.0 multi-instrument additions pass through unchanged.
  assert.equal(json.instruments.enabled, true);
  assert.equal(json.instruments.account.optionsTradingLevel, 3);
  assert.equal(json.account.marginDebtUsd, 250);
  assert.ok(json.agents[0].instrumentPermissions.allowedStructures.length > 0);
  assert.equal(json.agents[0].playbook.family, json.agents[0].strategy.family);
  assert.ok(Array.isArray(json.agents[1].positions));
  // v3.1 trade diagnostics pass through unchanged.
  assert.equal(json.engine.lastCycle.marketOpen, true);
  assert.equal(json.engine.lastCycle.executions, 2);
  assert.equal(json.engine.lastCycle.topSkipReasons.inside_range, 27);
  assert.equal(json.engine.instruments.enabled, true);
  // Names + drill-down data cross the route untouched by the host.
  assert.equal(json.agents[0].name, 'Momentum AAPL');
  assert.equal(Array.isArray(json.agents[0].recentTrades), true);
  assert.equal(Array.isArray(json.agents[0].positions), true);
  assert.equal(calls.status, 1);

  // Secrets must never cross the route boundary.
  assert.equal(res.body.includes(SECRET), false, 'credential material leaked into /automaton/state');
  assert.equal(res.body.includes(SECRET_TWO), false, 'secret value leaked into /automaton/state');

  fake.disposeAll();
});

test('state route rejects non-GET methods with a structured 405', async () => {
  const fake = createFakeCtx();
  const { engine } = createFakeEngine();
  apply(fake.ctx, baseConfig(engine));
  const { res, json } = await invokeHandler(routeFor(fake.routes, ROUTE_PATH).handler, { method: 'POST', body: {} });
  assert.equal(res.statusCode, 405);
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'METHOD_NOT_ALLOWED');
  fake.disposeAll();
});

test('state route reports the kill-switch marker file authoritatively', async () => {
  const tempDir = tempStateDir('killflag');
  try {
    fs.writeFileSync(path.join(tempDir, 'KILL_SWITCH'), '{"armedAt":"2026-01-02T00:00:00.000Z"}\n', 'utf8');
    const fake = createFakeCtx();
    // The engine's own status view says "clear"; the marker file says otherwise.
    const { engine } = createFakeEngine({ stateDir: tempDir });
    apply(fake.ctx, baseConfig(engine, { stateDir: tempDir, envFile: path.join(tempDir, '.env') }));
    const { json } = await invokeHandler(routeFor(fake.routes, ROUTE_PATH).handler, { method: 'GET' });
    assert.equal(json.ok, true);
    assert.equal(json.engine.killSwitch, true, 'the marker file must win over a stale engine snapshot');
    assert.equal(json.brakes.killSwitch, true);
    fake.disposeAll();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('state route maps engine failures to a structured 503', async () => {
  const fake = createFakeCtx();
  const { engine } = createFakeEngine({ statusError: true });
  apply(fake.ctx, baseConfig(engine));
  const { res, json } = await invokeHandler(routeFor(fake.routes, ROUTE_PATH).handler, { method: 'GET' });
  assert.equal(res.statusCode, 503);
  assert.equal(json.ok, false);
  assert.equal(json.isError, true);
  assert.equal(typeof json.error.code, 'string');
  assert.match(json.error.message, /broker down/);
  fake.disposeAll();
});

test('GET /automaton/market returns the redacted live analytics view', async () => {
  const fake = createFakeCtx();
  const { engine, calls } = createFakeEngine();
  apply(fake.ctx, baseConfig(engine));
  const market = routeFor(fake.routes, MARKET_PATH);
  assert.equal(market.kind, 'exact');

  const { res, json } = await invokeHandler(market.handler, { method: 'GET' });
  assert.equal(res.statusCode, 200);
  assert.equal(json.ok, true);
  assert.equal(json.route, MARKET_PATH);
  assert.equal(json.loopbackOnly, true);
  assert.equal(json.at, '2026-01-02T00:00:05.000Z');
  assert.equal(json.marketOpen, true);
  assert.equal(json.quotes.AAPL.priceUsd, 195.5);
  assert.deepEqual(json.sparklines.TSLA, [244, 243, 242, 241, 240.1]);
  assert.equal(json.portfolio.equityUsd, 20500);
  assert.equal(json.agents.length, 2);
  assert.equal(json.equityHistory.length, 3);
  assert.equal(json.engine.marketOpen, true);
  assert.equal(calls.marketView, 1);
  // Redaction: secret material from the engine view must never reach the browser.
  const text = JSON.stringify(json);
  assert.equal(text.includes(SECRET), false, 'market route leaked credential material');
  assert.equal(text.includes(SECRET_TWO), false, 'market route leaked a secret value');
  assert.equal(res.headers['cache-control'], 'no-store');
  fake.disposeAll();
});

test('market route is loopback-only, GET-only and degrades to a structured 503', async () => {
  const fake = createFakeCtx();
  const { engine } = createFakeEngine();
  apply(fake.ctx, baseConfig(engine));
  const market = routeFor(fake.routes, MARKET_PATH);

  const remote = await invokeHandler(market.handler, { method: 'GET', remoteAddress: '203.0.113.9' });
  assert.equal(remote.res.statusCode, 403);
  assert.equal(remote.json.ok, false);
  assert.equal(remote.json.error.code, 'FORBIDDEN');

  const post = await invokeHandler(market.handler, { method: 'POST', body: {} });
  assert.equal(post.res.statusCode, 405);
  assert.equal(post.json.error.code, 'METHOD_NOT_ALLOWED');

  const throwing = await invokeHandler(market.handler, { method: 'GET' });
  assert.equal(throwing.res.statusCode, 200, 'the healthy engine still answers after the error cases');
  fake.disposeAll();

  const oldFake = createFakeCtx();
  const old = createFakeEngine({ omitMarketView: true });
  apply(oldFake.ctx, baseConfig(old.engine));
  const unavailable = await invokeHandler(routeFor(oldFake.routes, MARKET_PATH).handler, { method: 'GET' });
  assert.equal(unavailable.res.statusCode, 503);
  assert.equal(unavailable.json.ok, false);
  assert.equal(unavailable.json.error.code, 'MARKET_UNAVAILABLE');
  oldFake.disposeAll();

  const failingFake = createFakeCtx();
  const failing = createFakeEngine({ marketViewError: 'broker feed down' });
  apply(failingFake.ctx, baseConfig(failing.engine));
  const failed = await invokeHandler(routeFor(failingFake.routes, MARKET_PATH).handler, { method: 'GET' });
  assert.equal(failed.res.statusCode, 503);
  assert.equal(failed.json.ok, false);
  assert.equal(typeof failed.json.error.message, 'string');
  assert.equal(JSON.stringify(failed.json).includes(SECRET), false);
  failingFake.disposeAll();
});

test('POST /automaton/control maps start and stop to engine.start/stop', async () => {
  const fake = createFakeCtx();
  const { engine, calls } = createFakeEngine();
  apply(fake.ctx, baseConfig(engine));
  const control = routeFor(fake.routes, CONTROL_PATH);

  const started = await invokeHandler(control.handler, { method: 'POST', body: { action: 'start' } });
  assert.equal(started.res.statusCode, 200);
  assert.equal(started.json.ok, true);
  assert.equal(started.json.action, 'start');
  assert.equal(calls.start, 1);
  assert.equal(started.json.result.engine.running, true);

  const stopped = await invokeHandler(control.handler, { method: 'POST', body: { action: 'stop' } });
  assert.equal(stopped.res.statusCode, 200);
  assert.equal(stopped.json.ok, true);
  assert.equal(calls.stop, 1);

  fake.disposeAll();
});

test('POST /automaton/control maps REAPER_UNAVAILABLE start failures to 409', async () => {
  const fake = createFakeCtx();
  const { engine, calls } = createFakeEngine({ startError: 'REAPER_UNAVAILABLE' });
  apply(fake.ctx, baseConfig(engine));
  const control = routeFor(fake.routes, CONTROL_PATH);

  const refused = await invokeHandler(control.handler, { method: 'POST', body: { action: 'start' } });
  assert.equal(refused.res.statusCode, 409);
  assert.equal(refused.json.ok, false);
  assert.equal(refused.json.error.code, 'REAPER_UNAVAILABLE');
  assert.equal(calls.start, 1);
  fake.disposeAll();
});

test('POST /automaton/control emergency-stop requires confirm "STOP"', async () => {
  const fake = createFakeCtx();
  const { engine, calls } = createFakeEngine();
  apply(fake.ctx, baseConfig(engine));
  const control = routeFor(fake.routes, CONTROL_PATH);

  for (const body of [{ action: 'emergency-stop' }, { action: 'emergency-stop', confirm: 'stop' }, { action: 'emergency-stop', confirm: 'GO' }]) {
    const denied = await invokeHandler(control.handler, { method: 'POST', body });
    assert.equal(denied.res.statusCode, 400);
    assert.equal(denied.json.ok, false);
    assert.equal(denied.json.error.code, 'CONFIRM_REQUIRED');
    assert.equal(calls.emergencyStop, 0, 'emergency stop must not run without confirm');
  }

  const armed = await invokeHandler(control.handler, { method: 'POST', body: { action: 'emergency-stop', confirm: 'STOP' } });
  assert.equal(armed.res.statusCode, 200);
  assert.equal(armed.json.ok, true);
  assert.equal(armed.json.action, 'emergency-stop');
  assert.equal(armed.json.result.killSwitch, true);
  assert.equal(calls.emergencyStop, 1);
  fake.disposeAll();
});

test('POST /automaton/control rejects unknown actions, bad JSON and non-POST', async () => {
  const fake = createFakeCtx();
  const { engine, calls } = createFakeEngine();
  apply(fake.ctx, baseConfig(engine));
  const control = routeFor(fake.routes, CONTROL_PATH);

  const badAction = await invokeHandler(control.handler, { method: 'POST', body: { action: 'explode' } });
  assert.equal(badAction.res.statusCode, 400);
  assert.equal(badAction.json.error.code, 'BAD_ACTION');

  const missingAction = await invokeHandler(control.handler, { method: 'POST', body: {} });
  assert.equal(missingAction.res.statusCode, 400);
  assert.equal(missingAction.json.error.code, 'BAD_ACTION');

  const badJson = await invokeHandler(control.handler, { method: 'POST', rawBody: '{not json' });
  assert.equal(badJson.res.statusCode, 400);
  assert.equal(badJson.json.error.code, 'BAD_JSON');

  const notObject = await invokeHandler(control.handler, { method: 'POST', rawBody: '"start"' });
  assert.equal(notObject.res.statusCode, 400);
  assert.equal(notObject.json.error.code, 'BAD_JSON');

  const wrongMethod = await invokeHandler(control.handler, { method: 'GET' });
  assert.equal(wrongMethod.res.statusCode, 405);
  assert.equal(wrongMethod.json.error.code, 'METHOD_NOT_ALLOWED');
  assert.equal(calls.start + calls.stop + calls.emergencyStop, 0, 'no engine action for rejected requests');
  fake.disposeAll();
});

test('POST /automaton/control is loopback-only', async () => {
  const fake = createFakeCtx();
  const { engine, calls } = createFakeEngine();
  apply(fake.ctx, baseConfig(engine));
  const control = routeFor(fake.routes, CONTROL_PATH);

  const remote = await invokeHandler(control.handler, {
    method: 'POST',
    remoteAddress: '203.0.113.9',
    body: { action: 'start' },
  });
  assert.equal(remote.res.statusCode, 403);
  assert.equal(remote.json.ok, false);
  assert.equal(remote.json.error.code, 'FORBIDDEN');
  assert.equal(calls.start, 0, 'non-loopback requests must not touch the engine');

  const noSocket = await invokeHandler(control.handler, { method: 'POST', remoteAddress: null, body: { action: 'start' } });
  assert.equal(noSocket.res.statusCode, 403);
  assert.equal(calls.start, 0);

  for (const remoteAddress of ['127.0.0.1', '127.8.2.3', '::1', '::ffff:127.0.0.1']) {
    const allowed = await invokeHandler(control.handler, { method: 'POST', remoteAddress, body: { action: 'stop' } });
    assert.equal(allowed.res.statusCode, 200, `loopback address ${remoteAddress} should be accepted`);
  }
  assert.equal(calls.stop, 4);
  fake.disposeAll();
});

test('POST /automaton/control refuses live start until LIVE_ARMED', async () => {
  const fake = createFakeCtx();
  const { engine, calls } = createFakeEngine({ mode: 'live', allowLive: true, liveArmed: false });
  apply(fake.ctx, baseConfig(engine, { mode: 'live', allowLive: true }));
  const control = routeFor(fake.routes, CONTROL_PATH);

  const refused = await invokeHandler(control.handler, { method: 'POST', body: { action: 'start' } });
  assert.equal(refused.res.statusCode, 409);
  assert.equal(refused.json.ok, false);
  assert.equal(refused.json.error.code, 'LIVE_NOT_ARMED');
  assert.equal(calls.start, 0);
  fake.disposeAll();
});

// ---------------------------------------------------------------------------
// operator reaper-stop tests (host-side; never an engine/agent capability)
// ---------------------------------------------------------------------------

test('POST /automaton/control reaper-stop requires confirm "STOP" and never touches the engine', async () => {
  const tempDir = tempStateDir('reaper-confirm');
  try {
    const fake = createFakeCtx();
    const { engine, calls } = createFakeEngine({ stateDir: tempDir });
    apply(fake.ctx, baseConfig(engine, { stateDir: tempDir, envFile: path.join(tempDir, '.env') }));
    const control = routeFor(fake.routes, CONTROL_PATH);

    for (const body of [{ action: 'reaper-stop' }, { action: 'reaper-stop', confirm: 'stop' }]) {
      const denied = await invokeHandler(control.handler, { method: 'POST', body });
      assert.equal(denied.res.statusCode, 400);
      assert.equal(denied.json.ok, false);
      assert.equal(denied.json.error.code, 'CONFIRM_REQUIRED');
    }
    assert.equal(calls.start + calls.stop + calls.emergencyStop, 0, 'reaper-stop is host-side, not an engine call');
    fake.disposeAll();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('POST /automaton/control reaper-stop reports a missing or dead pid file without failing', async () => {
  const tempDir = tempStateDir('reaper-missing');
  try {
    writeReaperHeartbeat(tempDir, { heartbeatVersion: 1, heartbeatAt: '2026-01-02T00:00:00.000Z', sweeps: 7 });
    const fake = createFakeCtx();
    const { engine } = createFakeEngine({ stateDir: tempDir });
    apply(fake.ctx, baseConfig(engine, { stateDir: tempDir, envFile: path.join(tempDir, '.env') }));
    const control = routeFor(fake.routes, CONTROL_PATH);

    const missing = await invokeHandler(control.handler, { method: 'POST', body: { action: 'reaper-stop', confirm: 'STOP' } });
    assert.equal(missing.res.statusCode, 200);
    assert.equal(missing.json.ok, true);
    assert.equal(missing.json.action, 'reaper-stop');
    assert.equal(missing.json.result.stopped, false);
    assert.match(missing.json.result.reason, /no reaper pid file/);
    assert.equal(missing.json.result.heartbeat.heartbeatVersion, 1, 'heartbeat telemetry is surfaced');

    // A stale pid file pointing at a dead process is cleaned up.
    writeReaperPid(tempDir, { pid: 99999999, startedAt: '2026-01-01T00:00:00.000Z' });
    const stale = await invokeHandler(control.handler, { method: 'POST', body: { action: 'reaper-stop', confirm: 'STOP' } });
    assert.equal(stale.res.statusCode, 200);
    assert.equal(stale.json.result.stopped, false);
    assert.match(stale.json.result.reason, /not running/);
    assert.equal(fs.existsSync(path.join(tempDir, REAPER_PID_FILE)), false, 'stale pid file is removed');

    fake.disposeAll();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('POST /automaton/control reaper-stop is loopback-only and does not touch the pid file remotely', async () => {
  const tempDir = tempStateDir('reaper-remote');
  try {
    writeReaperPid(tempDir, { pid: 99999999 });
    const fake = createFakeCtx();
    const { engine } = createFakeEngine({ stateDir: tempDir });
    apply(fake.ctx, baseConfig(engine, { stateDir: tempDir, envFile: path.join(tempDir, '.env') }));
    const control = routeFor(fake.routes, CONTROL_PATH);

    const remote = await invokeHandler(control.handler, {
      method: 'POST',
      remoteAddress: '203.0.113.9',
      body: { action: 'reaper-stop', confirm: 'STOP' },
    });
    assert.equal(remote.res.statusCode, 403);
    assert.equal(remote.json.error.code, 'FORBIDDEN');
    assert.equal(fs.existsSync(path.join(tempDir, REAPER_PID_FILE)), true, 'remote request must not remove the pid file');
    fake.disposeAll();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('stopReaperOperator reports EPERM as a structured operator failure', async () => {
  const tempDir = tempStateDir('reaper-eperm');
  try {
    writeReaperPid(tempDir, { pid: 4242 });
    const outcome = await stopReaperOperator(fakeHolder(tempDir), { stateDir: tempDir }, {
      kill: () => {
        const error = new Error('operation not permitted');
        error.code = 'EPERM';
        throw error;
      },
      isAlive: () => true,
      sleep: async () => {},
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.code, 'EPERM');
    assert.match(outcome.hint, /operating system terminal/);
    assert.equal(outcome.pid, 4242);
    assert.equal(fs.existsSync(path.join(tempDir, REAPER_PID_FILE)), true, 'a failed stop keeps the pid file');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('stopReaperOperator escalates SIGTERM → SIGKILL and removes the pid file', async () => {
  const tempDir = tempStateDir('reaper-kill');
  try {
    writeReaperPid(tempDir, { pid: 4242 });
    const signals = [];
    let aliveChecks = 0;
    const outcome = await stopReaperOperator(fakeHolder(tempDir), { stateDir: tempDir }, {
      kill: (pid, signal) => {
        signals.push(`${pid}:${signal}`);
      },
      // alive before SIGTERM, alive after SIGTERM, dead after SIGKILL
      isAlive: () => {
        aliveChecks += 1;
        return aliveChecks <= 2;
      },
      sleep: async () => {},
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.stopped, true);
    assert.equal(outcome.pid, 4242);
    assert.deepEqual(outcome.signals, ['SIGTERM', 'SIGKILL']);
    assert.deepEqual(signals, ['4242:SIGTERM', '4242:SIGKILL']);
    assert.equal(fs.existsSync(path.join(tempDir, REAPER_PID_FILE)), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('stopReaperOperator stops a real child process on this machine', async (t) => {
  const tempDir = tempStateDir('reaper-live');
  let child = null;
  try {
    try {
      child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
      child.unref();
      child.on('error', () => {});
    } catch {
      t.skip('child_process.spawn is unavailable in this sandbox');
      return;
    }
    await sleep(150);
    if (!child.pid) {
      t.skip('child process did not report a pid');
      return;
    }
    writeReaperPid(tempDir, { pid: child.pid, startedAt: '2026-01-02T00:00:00.000Z' });
    const outcome = await stopReaperOperator(fakeHolder(tempDir), { stateDir: tempDir });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.stopped, true);
    assert.equal(outcome.pid, child.pid);
    assert.equal(fs.existsSync(path.join(tempDir, REAPER_PID_FILE)), false);
  } finally {
    if (child && child.pid) {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// tool tests
// ---------------------------------------------------------------------------

test('every tool executes and returns the structured JSON envelope', async () => {
  const fake = createFakeCtx();
  const { engine, calls } = createFakeEngine();
  apply(fake.ctx, baseConfig(engine));

  for (const toolName of TOOL_NAMES) {
    const definition = fake.tools.get(toolName);
    assert.ok(definition, `${toolName} is registered`);
    const result = await definition.execute(TOOL_ARGS[toolName] ?? {}, {});
    assert.equal(result.ok, true, `${toolName} should succeed against the fake engine: ${JSON.stringify(result)}`);
    assert.equal(result.isError, undefined, `${toolName} success envelope must not set isError`);
    const content = definition.output.render(TOOL_ARGS[toolName] ?? {}, result);
    assert.deepEqual(JSON.parse(content[0].text), result);
  }

  assert.equal(calls.start, 1);
  assert.equal(calls.stop, 1);
  assert.equal(calls.tick, 1);
  assert.equal(calls.simulate, 1);
  assert.equal(calls.preTradeCheck, 1);
  assert.equal(calls.emergencyStop, 1);

  const agents = await fake.tools.get('automaton_agents').execute({ includeDead: false, includeGenome: false }, {});
  assert.equal(agents.ok, true);
  assert.equal(agents.agents.length, 26, 'condemned agents are still shown; only dead rows are omitted');
  assert.equal(agents.agents.every((agent) => agent.status !== 'dead'), true);
  assert.equal(agents.agents.some((agent) => agent.status === 'condemned'), true);
  assert.equal(agents.agents.every((agent) => agent.genome === undefined), true);
  assert.equal(agents.agents.every((agent) => typeof agent.name === 'string'), true);

  const obits = await fake.tools.get('automaton_obituaries').execute({ limit: 1, cause: 'drawdown_limit' }, {});
  assert.equal(obits.ok, true);
  assert.equal(obits.items.length, 1);
  assert.equal(obits.items[0].cause, 'drawdown_limit');
  assert.equal(typeof obits.items[0].name, 'string');

  const config = await fake.tools.get('automaton_config').execute({}, {});
  assert.equal(config.ok, true);
  assert.equal(config.row.mode, 'paper');
  assert.equal(config.envFile, ENV_FILE);
  const configText = JSON.stringify(config);
  assert.equal(configText.includes(SECRET), false, 'config tool leaked credential material');
  assert.equal(configText.includes(SECRET_TWO), false, 'config tool leaked a secret value');

  // v3.0 brake catalogue: 18 hard rules (D1–D18) exposed by the brakes tool. D2 is the
  // instrument-permission gate; D15–D18 are short / options / margin / expiry.
  const brakes = await fake.tools.get('automaton_brakes').execute({}, {});
  assert.equal(brakes.ok, true);
  assert.equal(brakes.count, 18);
  assert.equal(brakes.rules.length, 18);
  const ruleById = new Map(brakes.rules.map((rule) => [rule.id, rule]));
  assert.equal(ruleById.get('D2').code, 'INSTRUMENT_FORBIDDEN');
  assert.equal(ruleById.get('D15').code, 'SHORT_FORBIDDEN');
  assert.equal(ruleById.get('D16').code, 'OPTION_FORBIDDEN');
  assert.equal(ruleById.get('D17').code, 'MARGIN_LIMIT');
  assert.equal(ruleById.get('D18').code, 'EXPIRY_GUARD');
  assert.deepEqual(
    brakes.rules.filter((rule) => ['D15', 'D16', 'D17', 'D18'].includes(rule.id)).map((rule) => rule.id),
    ['D15', 'D16', 'D17', 'D18'],
  );

  fake.disposeAll();
});

test('emergency stop tool requires confirm exactly "STOP" and arms the kill switch', async () => {
  const fake = createFakeCtx();
  const { engine, calls } = createFakeEngine();
  apply(fake.ctx, baseConfig(engine));
  const definition = fake.tools.get('automaton_emergency_stop');

  for (const badArgs of [{}, { confirm: 'stop' }, { confirm: 'STOP!' }]) {
    const result = await definition.execute(badArgs, {});
    assert.equal(result.ok, false);
    assert.equal(result.isError, true);
    assert.equal(result.error.code, 'CONFIRM_REQUIRED');
    assert.equal(calls.emergencyStop, 0);
  }

  const result = await definition.execute({ confirm: 'STOP', reason: 'runaway drawdown' }, {});
  assert.equal(result.ok, true);
  assert.equal(result.killSwitch, true);
  assert.equal(result.reason, 'runaway drawdown');
  assert.equal(calls.emergencyStop, 1);
  assert.equal(engine.running, false);
  fake.disposeAll();
});

test('live mode tool start is refused until the operator arms LIVE_ARMED', async () => {
  const fake = createFakeCtx();
  const { engine, calls } = createFakeEngine({ mode: 'live', allowLive: true, liveArmed: false });
  apply(fake.ctx, baseConfig(engine, { mode: 'live', allowLive: true }));
  const result = await fake.tools.get('automaton_start').execute({}, {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'LIVE_NOT_ARMED');
  assert.equal(calls.start, 0);
  fake.disposeAll();
});

test('autoStart never starts live and only starts sim/paper once', async () => {
  const paper = createFakeEngine();
  const paperCtx = createFakeCtx();
  apply(paperCtx.ctx, baseConfig(paper.engine, { autoStart: true }));
  await sleep(30);
  assert.equal(paper.calls.start, 1);
  paperCtx.disposeAll();

  const live = createFakeEngine({ mode: 'live' });
  const liveCtx = createFakeCtx();
  apply(liveCtx.ctx, baseConfig(live.engine, { autoStart: true, mode: 'live', allowLive: true }));
  await sleep(30);
  assert.equal(live.calls.start, 0, 'live mode is never auto-started');
  assert.equal(live.calls.status, 0);
  liveCtx.disposeAll();
});

test('cleanup disposes tools, all three routes, and stops the engine', async () => {
  const fake = createFakeCtx();
  const { engine, calls } = createFakeEngine();
  apply(fake.ctx, baseConfig(engine));

  assert.equal(fake.tools.size, 10);
  assert.equal(fake.routes.length, 3);
  assert.equal(fake.effects.length, 3);

  await fake.tools.get('automaton_status').execute({}, {});
  assert.equal(calls.status, 1);

  fake.disposeAll();
  assert.equal(fake.tools.size, 0, 'all tools must be disposed');
  assert.equal(fake.routes.length, 0, 'all routes must be disposed');
  await sleep(25);
  assert.equal(calls.stop, 1, 'plugin teardown must stop the engine loop');
});

test('fallback emergency stop writes the KILL_SWITCH marker file', async () => {
  const tempDir = tempStateDir('killswitch');
  try {
    const fake = createFakeCtx();
    const { engine, calls } = createFakeEngine({ omitEmergencyStop: true, stateDir: tempDir });
    apply(fake.ctx, baseConfig(engine, {
      stateDir: tempDir,
      envFile: path.join(tempDir, '.env'),
    }));
    const result = await fake.tools.get('automaton_emergency_stop').execute(
      { confirm: 'STOP', reason: 'no engine method' },
      {},
    );
    assert.equal(result.ok, true);
    assert.equal(result.killSwitch, true);
    const marker = path.join(tempDir, 'KILL_SWITCH');
    assert.equal(fs.existsSync(marker), true, 'the kill-switch marker must exist after an emergency stop');
    const markerBody = JSON.parse(fs.readFileSync(marker, 'utf8'));
    assert.equal(markerBody.reason, 'no engine method');
    assert.equal(calls.stop, 1);
    fake.disposeAll();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('POST /automaton/control validates and applies research settings', async () => {
  const fake = createFakeCtx();
  const { engine, calls } = createFakeEngine();
  apply(fake.ctx, baseConfig(engine));
  const control = routeFor(fake.routes, CONTROL_PATH);

  const ok = await invokeHandler(control.handler, {
    method: 'POST',
    body: {
      action: 'set-research-settings',
      settings: { mode: 'interval', intervalSec: 10800, enabled: true, influence: false },
    },
  });
  assert.equal(ok.res.statusCode, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.action, 'set-research-settings');
  assert.equal(calls.updateResearchSettings, 1);
  assert.deepEqual(calls.lastResearchSettings, { mode: 'interval', intervalSec: 10800, enabled: true, influence: false });
  assert.deepEqual(ok.json.result.settings, { mode: 'interval', intervalSec: 10800, enabled: true, influence: false });
  assert.equal(ok.json.result.effective.intervalSec, 10800);

  const invalidBodies = [
    { action: 'set-research-settings', settings: { mode: 'hourly' } },
    { action: 'set-research-settings', settings: { mode: 'interval', intervalSec: 7200 } },
    { action: 'set-research-settings', settings: { enabled: 'yes' } },
    { action: 'set-research-settings', settings: { influence: 1 } },
    { action: 'set-research-settings', settings: { mode: 'interval', unknown: true } },
    { action: 'set-research-settings', settings: {} },
    { action: 'set-research-settings' },
  ];
  for (const body of invalidBodies) {
    const bad = await invokeHandler(control.handler, { method: 'POST', body });
    assert.equal(bad.res.statusCode, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.equal(bad.json.ok, false);
    assert.equal(bad.json.error.code, 'INVALID_SETTINGS');
  }
  assert.equal(calls.updateResearchSettings, 1, 'invalid settings never reach the engine');
  fake.disposeAll();
});

test('POST /automaton/control validates and applies reward settings', async () => {
  const fake = createFakeCtx();
  const { engine, calls } = createFakeEngine();
  apply(fake.ctx, baseConfig(engine));
  const control = routeFor(fake.routes, CONTROL_PATH);

  const ok = await invokeHandler(control.handler, {
    method: 'POST',
    body: {
      action: 'set-reward-settings',
      settings: { enabled: true, period: 'weekly', rankPercents: [0.05, 0.03, 0.02], maxPerPeriodUsd: 250 },
    },
  });
  assert.equal(ok.res.statusCode, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.action, 'set-reward-settings');
  assert.equal(calls.updateRewardSettings, 1);
  assert.deepEqual(calls.lastRewardSettings, { enabled: true, period: 'weekly', rankPercents: [0.05, 0.03, 0.02], maxPerPeriodUsd: 250 });
  assert.deepEqual(ok.json.result.settings, calls.lastRewardSettings);
  assert.equal(ok.json.result.effective.period, 'weekly');

  const nullMax = await invokeHandler(control.handler, {
    method: 'POST',
    body: { action: 'set-reward-settings', settings: { maxPerPeriodUsd: null } },
  });
  assert.equal(nullMax.res.statusCode, 200);
  assert.equal(calls.updateRewardSettings, 2);
  assert.equal(calls.lastRewardSettings.maxPerPeriodUsd, null);

  const invalidBodies = [
    { action: 'set-reward-settings', settings: { period: 'hourly' } },
    { action: 'set-reward-settings', settings: { rankPercents: [0.05, 0.03] } },
    { action: 'set-reward-settings', settings: { rankPercents: [0.05, 0.03, 0.6] } },
    { action: 'set-reward-settings', settings: { rankPercents: [0.05, 0.03, -0.01] } },
    { action: 'set-reward-settings', settings: { maxPerPeriodUsd: -1 } },
    { action: 'set-reward-settings', settings: { enabled: 'yes' } },
    { action: 'set-reward-settings', settings: { unknown: 1 } },
    { action: 'set-reward-settings', settings: {} },
  ];
  for (const body of invalidBodies) {
    const bad = await invokeHandler(control.handler, { method: 'POST', body });
    assert.equal(bad.res.statusCode, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.equal(bad.json.error.code, 'INVALID_SETTINGS');
  }
  assert.equal(calls.updateRewardSettings, 2, 'invalid settings never reach the engine');
  fake.disposeAll();
});

test('settings control actions are loopback-only and fail cleanly on an old engine', async () => {
  const fake = createFakeCtx();
  const { engine, calls } = createFakeEngine();
  apply(fake.ctx, baseConfig(engine));
  const control = routeFor(fake.routes, CONTROL_PATH);

  const remote = await invokeHandler(control.handler, {
    method: 'POST',
    remoteAddress: '203.0.113.9',
    body: { action: 'set-research-settings', settings: { enabled: true } },
  });
  assert.equal(remote.res.statusCode, 403);
  assert.equal(calls.updateResearchSettings, 0);
  fake.disposeAll();

  const oldFake = createFakeCtx();
  const old = createFakeEngine({ omitSettingsMethods: true });
  apply(oldFake.ctx, baseConfig(old.engine));
  const oldControl = routeFor(oldFake.routes, CONTROL_PATH);
  const unsupported = await invokeHandler(oldControl.handler, {
    method: 'POST',
    body: { action: 'set-reward-settings', settings: { enabled: true } },
  });
  assert.equal(unsupported.res.statusCode, 501);
  assert.equal(unsupported.json.ok, false);
  assert.equal(unsupported.json.error.code, 'NOT_IMPLEMENTED');
  oldFake.disposeAll();
});

// ---------------------------------------------------------------------------
// research sidecar: Harness-LLM bridge (host)
// ---------------------------------------------------------------------------

test('research bridge resolves the agent default model and concatenates the stream', async () => {
  const { llm, calls } = createFakeLlm();
  const ctx = createFakeCtx({
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
  }).ctx;
  const log = fakeLogger();
  const bridge = await createResearchBridge(ctx, { stateDir: STATE_DIR }, log);
  assert.ok(bridge, 'bridge is built when llm + selection exist');
  assert.equal(bridge.provider, 'deepseek-account');
  assert.equal(bridge.model, 'deepseek-flash');
  assert.equal(log.warnings.length, 0);

  const result = await bridge.generate({ system: 'SYSTEM-PROMPT', user: 'USER-PAYLOAD', maxTokens: 700 });
  assert.equal(result.text, '{"verdict":"HOLD"}');
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 45 });
  // The bridge reports the actual route so the researcher stores real provider/model values.
  assert.equal(result.provider, 'deepseek-account');
  assert.equal(result.model, 'deepseek-flash');

  assert.deepEqual(calls.prepare[0], {
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    maxTokens: 700,
    temperature: 0.2,
  });
  assert.equal(calls.stream.length, 1);
  const streamOptions = calls.stream[0];
  assert.equal(streamOptions.provider, 'deepseek-account');
  assert.equal(streamOptions.model, 'deepseek-flash');
  assert.equal(streamOptions.system, 'SYSTEM-PROMPT');
  assert.equal(streamOptions.maxTokens, 700);
  assert.equal(streamOptions.temperature, 0.2);
  // The frozen prepared config (including adapter-materialised defaults) must be echoed back
  // verbatim, or the llm service rejects dispatch with INVALID_PREPARED_CALL.
  assert.equal(streamOptions.reasoningEffort, 'high');
  assert.deepEqual(streamOptions.messages, [
    { role: 'user', content: [{ type: 'text', text: 'USER-PAYLOAD' }] },
  ]);
});

test('research bridge falls back to the first provider and its first model', async () => {
  const { llm, calls } = createFakeLlm({ providers: ['provider-a', 'provider-b'], models: ['model-1', 'model-2'] });
  const bridge = await createResearchBridge(createFakeCtx({ llm }).ctx, { stateDir: STATE_DIR }, fakeLogger());
  assert.ok(bridge);
  assert.equal(bridge.provider, 'provider-a');
  assert.equal(bridge.model, 'model-1');
  assert.equal(calls.lastListModelsProvider, 'provider-a');
});

test('research bridge honours row and nested-config provider/model overrides', async () => {
  const { llm } = createFakeLlm();
  const ctx = createFakeCtx({
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'default-p', model: 'default-m' }) },
  }).ctx;
  assert.deepEqual(resolveResearchOverrides({ researchProvider: 'row-p', researchModel: 'row-m' }), { provider: 'row-p', model: 'row-m' });
  assert.deepEqual(resolveResearchOverrides({ config: { research: { provider: 'nested-p', model: 'nested-m' } } }), { provider: 'nested-p', model: 'nested-m' });
  assert.deepEqual(resolveResearchOverrides({}), { provider: null, model: null });

  const rowBridge = await createResearchBridge(ctx, { stateDir: STATE_DIR, researchProvider: 'row-p', researchModel: 'row-m' }, fakeLogger());
  assert.ok(rowBridge);
  assert.equal(rowBridge.provider, 'row-p');
  assert.equal(rowBridge.model, 'row-m');

  const nestedBridge = await createResearchBridge(ctx, { stateDir: STATE_DIR, config: { research: { provider: 'nested-p', model: 'nested-m' } } }, fakeLogger());
  assert.ok(nestedBridge);
  assert.equal(nestedBridge.provider, 'nested-p');
  assert.equal(nestedBridge.model, 'nested-m');
});

test('research bridge returns null (configured:false) when the LLM service or model is unavailable', async () => {
  const noLlmLog = fakeLogger();
  assert.equal(await createResearchBridge(createFakeCtx().ctx, { stateDir: STATE_DIR }, noLlmLog), null);
  assert.ok(noLlmLog.warnings.some((message) => /no Harness llm service/.test(message)));

  const noProviderLog = fakeLogger();
  const emptyLlm = createFakeLlm({ providers: [] });
  assert.equal(await createResearchBridge(createFakeCtx({ llm: emptyLlm.llm }).ctx, { stateDir: STATE_DIR }, noProviderLog), null);
  assert.ok(noProviderLog.warnings.some((message) => /no LLM provider\/model resolved/.test(message)));
});

test('research bridge surfaces provider failures as clean errors', async () => {
  const finishError = createFakeLlm({
    chunks: [
      { type: 'text-delta', text: 'partial' },
      { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'RATE_LIMIT' } } },
    ],
  });
  const ctx = createFakeCtx({
    llm: finishError.llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  }).ctx;
  const bridge = await createResearchBridge(ctx, { stateDir: STATE_DIR }, fakeLogger());
  await assert.rejects(bridge.generate({ system: 's', user: 'u', maxTokens: 128 }), (error) => {
    assert.match(error.message, /rate limited/);
    assert.match(error.message, /p\/m/);
    assert.equal(error.code, 'RATE_LIMIT');
    return true;
  });

  const streamFailure = createFakeLlm({ streamError: Object.assign(new Error('socket closed'), { code: 'NETWORK' }) });
  const ctx2 = createFakeCtx({
    llm: streamFailure.llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  }).ctx;
  const bridge2 = await createResearchBridge(ctx2, { stateDir: STATE_DIR }, fakeLogger());
  await assert.rejects(bridge2.generate({ system: 's', user: 'u', maxTokens: 128 }), (error) => {
    assert.match(error.message, /socket closed/);
    assert.equal(error.code, 'NETWORK');
    return true;
  });

  const emptyReply = createFakeLlm({ chunks: [{ type: 'finish', reason: { kind: 'stop' } }] });
  const ctx3 = createFakeCtx({
    llm: emptyReply.llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  }).ctx;
  const bridge3 = await createResearchBridge(ctx3, { stateDir: STATE_DIR }, fakeLogger());
  await assert.rejects(bridge3.generate({ system: 's', user: 'u', maxTokens: 128 }), /empty briefing/);
});

test('the engine factory receives the research bridge (and null without an LLM)', async () => {
  const { llm } = createFakeLlm({ providers: ['p1'], models: ['m1'] });
  const withLlm = createFakeCtx({
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'p1', model: 'm1' }) },
  });
  const captured = {};
  const { engine } = createFakeEngine();
  apply(withLlm.ctx, baseConfig(engine, {
    engineFactory: (rowConfig, research) => {
      captured.row = rowConfig;
      captured.research = research;
      return engine;
    },
  }));
  await withLlm.tools.get('automaton_status').execute({}, {});
  assert.ok(captured.research, 'researchGenerate bridge is passed to the engine factory');
  assert.equal(captured.research.provider, 'p1');
  assert.equal(captured.research.model, 'm1');
  assert.equal(typeof captured.research.generate, 'function');
  withLlm.disposeAll();

  const noLlm = createFakeCtx();
  const capturedWithout = {};
  const second = createFakeEngine();
  apply(noLlm.ctx, baseConfig(second.engine, {
    engineFactory: (rowConfig, research) => {
      capturedWithout.row = rowConfig;
      capturedWithout.research = research;
      return second.engine;
    },
  }));
  await noLlm.tools.get('automaton_status').execute({}, {});
  assert.equal(capturedWithout.research, null, 'no llm → no generator passed (engine reports configured:false)');
  noLlm.disposeAll();
});

test('GET /automaton/state passes research telemetry and per-agent briefings through', async () => {
  const fake = createFakeCtx();
  const { engine } = createFakeEngine({ agentCount: POPULATION });
  apply(fake.ctx, baseConfig(engine));
  const { json } = await invokeHandler(routeFor(fake.routes, ROUTE_PATH).handler, { method: 'GET' });
  assert.equal(json.engine.research.configured, true);
  assert.equal(json.engine.research.influence, true);
  assert.equal(json.engine.research.provider, 'deepseek-account');
  assert.equal(json.agents[0].research.verdict, 'HOLD');
  assert.equal(json.agents[1].research.stale, true);

  const unconfigured = createFakeCtx();
  const { engine: engine2 } = createFakeEngine({
    agentCount: POPULATION,
    research: { enabled: true, configured: false, influence: true, intervalSec: 3600, lastRunAt: null, nextDueAt: null, provider: null, model: null, runs: 0, errors: 0 },
  });
  apply(unconfigured.ctx, baseConfig(engine2));
  const passed = await invokeHandler(routeFor(unconfigured.routes, ROUTE_PATH).handler, { method: 'GET' });
  assert.equal(passed.json.engine.research.configured, false);
  unconfigured.disposeAll();
  fake.disposeAll();
});

// ---------------------------------------------------------------------------
// client module tests (registration + pure data mapping, no rendering)
// ---------------------------------------------------------------------------

/** Cached client module + a React stub: the browser module is imported exactly once. */
let clientModuleCache = null;

async function loadClientModule() {
  if (clientModuleCache !== null) return clientModuleCache;
  const previousWindow = globalThis.window;
  let registration = null;
  globalThis.window = {
    __ModuleLoader__: {
      load(loaded) {
        registration = loaded;
      },
    },
  };
  try {
    await import('../client.js');
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
  assert.ok(registration, 'client.js must call window.__ModuleLoader__.load()');
  const React = {
    createElement: (...args) => ({ kind: 'element', args }),
    Fragment: Symbol('Fragment'),
    createContext: (value) => ({ __context: value }),
    useContext: () => null,
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useCallback: (callback) => callback,
    useRef: (initial) => ({ current: initial }),
  };
  const module = registration.factory((required) => {
    assert.equal(required, 'react', 'the client module only requires react from the module table');
    return React;
  });
  clientModuleCache = {
    registration,
    module,
    restore() {
      /* the import happens once; nothing to restore */
    },
  };
  return clientModuleCache;
}

function createClientCtx() {
  const injected = [];
  const registrations = [];
  const ctx = {
    locale: {
      register() {
        return () => {};
      },
      bind() {
        return (key) => key;
      },
    },
    slots: {
      inject(ownerKey, callback) {
        injected.push({ ownerKey, callback });
      },
      register(options, Component) {
        registrations.push({ options, Component });
        return () => {};
      },
    },
    effect(callback) {
      const disposer = callback();
      return typeof disposer === 'function' ? disposer : () => {};
    },
  };
  return { ctx, injected, registrations };
}

test('client half registers the sidebar entry, keyed main panel and settings page', async () => {
  const loaded = await loadClientModule();
  try {
    assert.equal(loaded.registration.id, '@local/automaton-trading', 'module id must equal the package name');
    assert.ok(Array.isArray(loaded.module.inject) && loaded.module.inject.includes('slots'));
    assert.equal(typeof loaded.module.apply, 'function');

    const { ctx, injected, registrations } = createClientCtx();
    loaded.module.apply(ctx);

    assert.deepEqual(injected.map((entry) => entry.ownerKey).sort(), [
      'main',
      'settings.plugins.tab',
      'sidebar.panellist',
    ]);
    for (const entry of injected) entry.callback(); // simulate slot declarations appearing

    assert.equal(registrations.length, 3);
    assert.deepEqual(registrations.map((entry) => entry.options.name).sort(), [
      'main',
      'settings.plugins.tab',
      'sidebar.panellist',
    ]);

    const sidebar = registrations.find((entry) => entry.options.name === 'sidebar.panellist');
    assert.equal(sidebar.options.id, 'automaton-trading');
    assert.equal(typeof sidebar.options.order, 'number');
    assert.equal(typeof sidebar.options.label, 'function');
    assert.equal(typeof sidebar.options.label(), 'string');

    const main = registrations.find((entry) => entry.options.name === 'main');
    assert.equal(main.options.key, 'automaton-trading', 'the sidebar entry id must select this main panel key');

    const settings = registrations.find((entry) => entry.options.name === 'settings.plugins.tab');
    assert.equal(settings.options.id, 'automaton-trading');
    assert.equal(typeof settings.options.label, 'function');
    assert.equal(typeof settings.options.label(), 'string');

    // The floating overlay and composer strip are gone.
    assert.equal(injected.some((entry) => entry.ownerKey === 'shell.overlay'), false);
    assert.equal(injected.some((entry) => entry.ownerKey === 'conversation.composer.dock'), false);
    for (const entry of registrations) {
      assert.equal(typeof entry.Component, 'function', 'each slot entry needs a React component');
    }
  } finally {
    loaded.restore();
  }
});

test('client half guards a missing slots/locale context', async () => {
  const loaded = await loadClientModule();
  try {
    assert.doesNotThrow(() => loaded.module.apply({}));
    assert.doesNotThrow(() => loaded.module.apply(undefined));
    // locale unavailable → the bundled English dictionary still serves labels
    const { ctx, injected, registrations } = createClientCtx();
    delete ctx.locale;
    loaded.module.apply(ctx);
    for (const entry of injected) entry.callback();
    assert.equal(registrations.length, 3);
  } finally {
    loaded.restore();
  }
});

test('pure data mapping: names, genome-vs-spec, holdings, activity and empty states', async () => {
  const loaded = await loadClientModule();
  try {
    const helpers = loaded.module.helpers;
    assert.ok(helpers, 'client module exposes `helpers`');
    const status = buildStatusPayload({ running: true });

    assert.equal(helpers.PANEL_ID, 'automaton-trading');
    assert.equal(helpers.SIDEBAR_SLOT, 'sidebar.panellist');
    assert.equal(helpers.MAIN_SLOT, 'main');
    assert.equal(helpers.SETTINGS_SLOT, 'settings.plugins.tab');
    assert.equal(helpers.STATE_URL, '/automaton/state');
    assert.equal(helpers.MARKET_URL, '/automaton/market');
    assert.equal(helpers.CONTROL_URL, '/automaton/control');
    assert.equal(helpers.STATE_POLL_MS, 5000);
    assert.equal(helpers.MARKET_POLL_MS, 2000);
    assert.equal(helpers.POLL_MS, 5000);
    assert.deepEqual(helpers.DASHBOARD_TABS, ['overview', 'agents', 'markets', 'research', 'rewards', 'settings']);

    const rows = helpers.buildAgentRows(status);
    assert.equal(rows.length, POPULATION);
    assert.equal(new Set(rows.map((row) => row.name)).size, POPULATION, 'agent names are unique');
    assert.equal(rows[0].name, 'Momentum AAPL', 'the engine-provided name is the primary label');
    assert.equal(rows[0].genomeText, 'Momentum AAPL');
    assert.match(rows[0].genomeParamsText, /lb/);
    assert.ok(rows[0].shortId.length > 0 && rows[0].shortId !== rows[0].id);

    // Genome vs Trading (compiled spec): some agents differ, some match.
    const differing = rows.filter((row) => row.tradingDiffers);
    assert.ok(differing.length > 0, 'at least one compiled spec differs from its genome');
    assert.ok(differing[0].specText && differing[0].specText !== differing[0].genomeText);
    const matching = rows.find((row) => row.spec && !row.tradingDiffers);
    assert.ok(matching, 'some agents trade their inherited genome');
    assert.equal(matching.specText, matching.genomeText);
    const noSpec = rows.find((row) => row.spec === null);
    assert.ok(noSpec, 'dead agents may have no compiled spec');
    assert.equal(noSpec.specText, null);

    // Parent names resolve from the population (name-first secondary display).
    const child = rows.find((row) => row.parentId);
    assert.ok(child);
    assert.equal(typeof child.parentName, 'string');
    assert.ok(child.parentName.length > 0);

    // Holdings rows: enriched positions and computed fallbacks.
    const withPositions = rows.find((row) => row.positionCount > 0);
    assert.ok(withPositions);
    assert.equal(withPositions.positions.length, withPositions.positionCount);
    const position = withPositions.positions[0];
    assert.equal(typeof position.symbol, 'string');
    assert.equal(typeof position.qty, 'number');
    assert.equal(typeof position.marketValueUsd, 'number');
    assert.equal(typeof position.unrealizedPlUsd, 'number');
    const emptyHoldings = helpers.buildHoldingsRows([]);
    assert.deepEqual(emptyHoldings, []);
    assert.equal(helpers.buildHoldingsRows(null).length, 0);
    // Fallbacks: market value and unrealized P&L are derivable from qty/avg/last price.
    const derived = helpers.buildHoldingsRows([{ symbol: 'AAPL', qty: 2, avgPriceUsd: 10, lastPriceUsd: 12 }]);
    assert.equal(derived[0].marketValueUsd, 24);
    assert.equal(derived[0].unrealizedPlUsd, 4);

    // Activity rows: newest-first fills with notional fallback and buy/sell sides.
    const withTrades = rows.find((row) => row.tradesCount > 0);
    assert.ok(withTrades);
    assert.ok(withTrades.activity.length > 0);
    assert.ok(['buy', 'sell'].includes(withTrades.activity[0].side));
    assert.equal(typeof withTrades.activity[0].notionalUsd, 'number');
    const derivedTrade = helpers.buildActivityRows([{ symbol: 'AAPL', side: 'buy', qty: 2, priceUsd: 10 }]);
    assert.equal(derivedTrade[0].notionalUsd, 20);
    assert.equal(derivedTrade[0].side, 'buy');
    assert.equal(derivedTrade[0].realizedPlUsd, null);
    assert.deepEqual(helpers.buildActivityRows([]), []);
    const noTrades = rows.find((row) => row.tradesCount === 0);
    assert.ok(noTrades, 'some agents have never traded (empty activity state)');
    assert.deepEqual(noTrades.activity, []);

    // Strategy parameters for genome and spec.
    const paramItems = helpers.strategyParamItems(rows[0].genome);
    assert.ok(paramItems.length >= 5);
    assert.ok(paramItems.some((item) => item.label === 'lookback'));
    assert.ok(paramItems.some((item) => item.label === 'stop' && item.value.includes('%')));
    assert.deepEqual(helpers.strategyParamItems(null), []);

    // Role costs + P&L math.
    assert.equal(rows[0].roleCosts.length, 4);
    assert.ok(rows[0].roleCostsTotal > 0);
    const alive = rows.find((row) => row.status === 'alive');
    assert.ok(alive);
    const expectedEquity = Math.round((ENDOWMENT_USD + (0.4 * (Number(alive.id.slice(-2)) % 7) - 1.2)) * 100) / 100;
    assert.equal(alive.equityUsd, expectedEquity);
    assert.ok(Math.abs(alive.pnlPct - (((expectedEquity - ENDOWMENT_USD) / ENDOWMENT_USD) * 100)) < 1e-9);

    const dead = rows.find((row) => row.status === 'dead');
    assert.ok(dead);
    assert.equal(dead.cause, 'insufficient_funds');
    assert.equal(dead.runwayHours, 0);
    assert.equal(dead.treasuryState, 'DEAD');
    assert.equal(dead.pnlUsd < 0, true);
    assert.equal(dead.lifespanHours > 0, true);

    const mutant = rows.find((row) => row.mutationText !== null);
    assert.ok(mutant, 'some rows carry a mutation description');
    assert.match(mutant.mutationText, /→/);

    // Summary + generations + obituaries (name-first).
    const summary = helpers.summarize(status);
    assert.equal(summary.mode, 'paper');
    assert.equal(summary.running, true);
    assert.equal(summary.population.total, POPULATION);
    assert.equal(summary.population.alive, 24);
    assert.equal(summary.population.dead, 4);
    assert.equal(summary.population.condemned, 2);
    assert.equal(summary.population.cap, 40);
    assert.equal(summary.equityUsd, 20000);
    assert.equal(summary.treasury.state, 'TIGHT');
    assert.equal(summary.allocationCapUsd, 16000);
    assert.equal(summary.endowmentUsd, ENDOWMENT_USD);
    assert.equal(summary.killSwitch, false);
    assert.equal(summary.control.route, CONTROL_PATH);

    const generations = helpers.generationRows(status);
    assert.equal(generations.length, 3);
    assert.equal(generations[0].generation, 0);
    assert.equal(generations[0].born, 10);
    assert.ok(generations.every((row) => row.born > 0));

    const obituaries = helpers.obituaryRows(status);
    assert.equal(obituaries.length, 8);
    assert.equal(typeof obituaries[0].name, 'string');
    assert.ok(obituaries[0].name.length > 0);
    assert.equal(typeof obituaries[0].cause, 'string');
    assert.equal(typeof obituaries[0].lifespanHours, 'number');

    // Filter by name and status; search also matches ids and parent names.
    const deadRows = helpers.filterAgentRows(rows, 'dead', '');
    assert.equal(deadRows.length, 4);
    assert.equal(deadRows.every((row) => row.status === 'dead'), true);
    const byNameRows = helpers.filterAgentRows(rows, 'all', 'MeanRev MSFT');
    assert.ok(byNameRows.length >= 1);
    assert.ok(byNameRows.every((row) => row.name === 'MeanRev MSFT' || row.parentName === 'MeanRev MSFT'));
    const byIdRows = helpers.filterAgentRows(rows, 'all', rows[3].id);
    assert.ok(byIdRows.length >= 1);
    assert.ok(byIdRows.every((row) => row.id === rows[3].id || row.parentId === rows[3].id));
    const symbolRows = helpers.filterAgentRows(rows, 'all', 'AAPL');
    assert.ok(symbolRows.length > 0);

    const byEquityDesc = helpers.sortAgentRows(rows, 'equityUsd', 'desc');
    for (let index = 1; index < byEquityDesc.length; index += 1) {
      assert.ok((byEquityDesc[index - 1].equityUsd ?? -Infinity) >= (byEquityDesc[index].equityUsd ?? -Infinity));
    }
    const byNameAsc = helpers.sortAgentRows(rows, 'name', 'asc');
    assert.deepEqual(byNameAsc.map((row) => row.name), [...byNameAsc.map((row) => row.name)].sort());
    const byGenerationAsc = helpers.sortAgentRows(rows, 'generation', 'asc');
    for (let index = 1; index < byGenerationAsc.length; index += 1) {
      assert.ok(byGenerationAsc[index - 1].generation <= byGenerationAsc[index].generation);
    }

    // findAgentRow keeps the detail selection stable across polls.
    assert.equal(helpers.findAgentRow(rows, rows[0].id)?.name, rows[0].name);
    assert.equal(helpers.findAgentRow(rows, 'atm-missing'), null);

    assert.equal(helpers.runwayLevel(100), 'ok');
    assert.equal(helpers.runwayLevel(10), 'warn');
    assert.equal(helpers.runwayLevel(1), 'crit');
    assert.equal(helpers.runwayPercent(72), 100);
    assert.equal(helpers.runwayPercent(null), 0);

    // The 30-agent engine rows may omit per-agent endowmentUsd; the population limit is
    // the fallback so the P&L column still works.
    const withoutEndowment = buildStatusPayload({ running: true });
    for (const agent of withoutEndowment.agents) delete agent.endowmentUsd;
    const fallbackRows = helpers.buildAgentRows(withoutEndowment);
    const fallbackAlive = fallbackRows.find((row) => row.status === 'alive');
    assert.ok(fallbackAlive);
    assert.equal(typeof fallbackAlive.pnlUsd, 'number');
    assert.equal(fallbackAlive.pnlUsd, Math.round((fallbackAlive.equityUsd - ENDOWMENT_USD) * 100) / 100);
  } finally {
    loaded.restore();
  }
});

test('pure data mapping: Reaper telemetry states for the operator row', async () => {
  const loaded = await loadClientModule();
  try {
    const helpers = loaded.module.helpers;
    assert.equal(typeof helpers.describeReaper, 'function');

    const healthy = helpers.describeReaper({
      pid: 1234,
      alive: true,
      startedAt: '2026-01-02T00:00:00.000Z',
      heartbeatAt: '2026-01-02T00:00:03.000Z',
      heartbeatVersion: 2,
      sweeps: 51,
      error: null,
      note: 'external process (no control surface)',
    });
    assert.equal(healthy.kind, 'healthy');
    assert.equal(healthy.stale, false);
    assert.equal(healthy.pid, 1234);
    assert.equal(healthy.heartbeatVersion, 2);
    assert.equal(healthy.sweeps, 51);

    const stale = helpers.describeReaper({ pid: 24452, alive: true, heartbeatAt: null, heartbeatVersion: null, error: null });
    assert.equal(stale.kind, 'stale');
    assert.equal(stale.stale, true);
    assert.equal(stale.pid, 24452);

    const legacy = helpers.describeReaper({ pid: 777, alive: true, heartbeatAt: '2026-01-01T00:00:00.000Z', heartbeatVersion: null });
    assert.equal(legacy.kind, 'stale', 'a heartbeat without version 2 is a stale generation');

    const stopped = helpers.describeReaper({ pid: null, alive: false, error: null, note: 'external process (no control surface)' });
    assert.equal(stopped.kind, 'stopped');
    assert.equal(stopped.pid, null);
    assert.equal(stopped.stale, false);

    const absent = helpers.describeReaper(null);
    assert.equal(absent.kind, 'stopped');

    // Summary carries the reaper telemetry through from GET /automaton/state.
    const status = buildStatusPayload({
      running: true,
      reaper: { pid: 24452, alive: true, startedAt: '2026-01-01T00:00:00.000Z', heartbeatAt: null, heartbeatVersion: null, sweeps: 0, error: 'stale generation', note: 'external process' },
    });
    const summary = helpers.summarize(status);
    assert.equal(summary.reaper.pid, 24452);
    assert.equal(helpers.describeReaper(summary.reaper).kind, 'stale');
  } finally {
    loaded.restore();
  }
});

test('pure data mapping: research badges, briefing detail and shadow/influence state', async () => {
  const loaded = await loadClientModule();
  try {
    const helpers = loaded.module.helpers;
    const status = buildStatusPayload({ running: true });
    const rows = helpers.buildAgentRows(status);

    const holdRow = rows.find((row) => row.research && row.research.verdict === 'HOLD');
    assert.ok(holdRow);
    assert.equal(holdRow.research.sentiment, 0.2);
    assert.equal(holdRow.research.confidence, 0.7);
    assert.match(holdRow.research.summary, /Neutral tone/);
    assert.equal(holdRow.research.catalysts.length, 2);
    assert.equal(holdRow.research.risks.length, 1);
    assert.equal(holdRow.research.sources.length, 2);
    assert.equal(holdRow.research.sources[0].url, 'https://example.com/news/1');
    assert.equal(holdRow.research.sources[1].url, null, 'non-http(s) source URLs are not linkable');
    assert.deepEqual(holdRow.researchBadge, helpers.researchBadge(holdRow.research));
    const holdBadge = helpers.researchBadge(holdRow.research);
    assert.equal(holdBadge.hasResearch, true);
    assert.equal(holdBadge.label, 'HOLD +0.2');
    assert.equal(holdBadge.tone, 'hold');
    assert.equal(holdBadge.stale, false);

    const avoidRow = rows.find((row) => row.research && row.research.verdict === 'AVOID');
    assert.ok(avoidRow);
    const avoidBadge = helpers.researchBadge(avoidRow.research);
    assert.equal(avoidBadge.label, 'AVOID -0.6');
    assert.equal(avoidBadge.tone, 'avoid');
    assert.equal(avoidBadge.stale, true);
    assert.equal(avoidRow.research.risks.length, 4, 'risks are clamped to 4');

    const alertRow = rows.find((row) => row.research && row.research.verdict === 'ALERT');
    assert.ok(alertRow);
    assert.equal(helpers.researchBadge(alertRow.research).tone, 'alert');

    const noResearch = rows.find((row) => row.research === null);
    assert.ok(noResearch);
    assert.deepEqual(helpers.researchBadge(noResearch.research), {
      hasResearch: false,
      label: '—',
      tone: 'none',
      stale: false,
      verdict: null,
      sentiment: null,
      title: '',
    });
    assert.equal(noResearch.researchBadge.hasResearch, false);

    // Normalization is defensive and clamped.
    const malformed = helpers.mapResearchBriefing({
      verdict: 'hold',
      sentiment: -3,
      confidence: 5,
      catalysts: ['a', '', 7, 'b', 'c', 'd', 'e'],
      risks: 'not-an-array',
      sources: [
        { title: 'ok', url: 'https://example.com/x' },
        { url: 'ftp://nope', title: 'ftp' },
        { url: 'https://example.com/y', source: 'src' },
      ],
      stale: true,
    });
    assert.equal(malformed.verdict, 'HOLD');
    assert.equal(malformed.sentiment, -1);
    assert.equal(malformed.confidence, 1);
    assert.deepEqual(malformed.catalysts, ['a', 'b', 'c', 'd']);
    assert.deepEqual(malformed.risks, []);
    assert.equal(malformed.sources.length, 3);
    assert.equal(malformed.sources[0].url, 'https://example.com/x');
    assert.equal(malformed.sources[1].url, null);
    assert.equal(malformed.stale, true);
    assert.equal(helpers.mapResearchBriefing(null), null);
    assert.equal(helpers.mapResearchBriefing('garbage'), null);
    assert.equal(helpers.mapResearchBriefing({}), null);

    // Engine research schedule projection: influence vs shadow vs unconfigured.
    const influenceStatus = helpers.researchStatusSummary(status);
    assert.equal(influenceStatus.available, true);
    assert.equal(influenceStatus.configured, true);
    assert.equal(influenceStatus.influence, true);
    assert.equal(influenceStatus.shadow, false);
    assert.equal(influenceStatus.intervalSec, 3600);
    assert.equal(influenceStatus.runs, 3);
    assert.equal(influenceStatus.provider, 'deepseek-account');
    assert.equal(helpers.researchModeKey(influenceStatus), 'researchInfluence');

    const shadowStatus = buildStatusPayload({
      running: true,
      research: { enabled: true, configured: true, influence: false, intervalSec: 3600, lastRunAt: null, nextDueAt: null, provider: 'p', model: 'm', runs: 1, errors: 0 },
    });
    const shadow = helpers.researchStatusSummary(shadowStatus);
    assert.equal(shadow.shadow, true);
    assert.equal(shadow.disabledReason, null);
    assert.equal(helpers.researchModeKey(shadow), 'researchShadow');

    const unconfiguredStatus = buildStatusPayload({
      running: true,
      research: { enabled: true, configured: false, influence: true, intervalSec: 3600, lastRunAt: null, nextDueAt: null, provider: null, model: null, runs: 0, errors: 0 },
    });
    const unconfigured = helpers.researchStatusSummary(unconfiguredStatus);
    assert.equal(unconfigured.configured, false);
    assert.equal(unconfigured.disabledReason, 'unconfigured');

    const configDisabledStatus = buildStatusPayload({
      running: true,
      research: { enabled: false, configured: true, influence: true, intervalSec: 3600, lastRunAt: null, nextDueAt: null, provider: 'p', model: 'm', runs: 0, errors: 0 },
    });
    assert.equal(helpers.researchStatusSummary(configDisabledStatus).disabledReason, 'disabled');

    const unknown = helpers.researchStatusSummary({});
    assert.equal(unknown.available, false);
    assert.equal(helpers.researchModeKey(unknown), 'researchUnknown');

    // summarize() exposes the same projection to the dashboard header/detail.
    const summary = helpers.summarize(status);
    assert.equal(summary.research.configured, true);
    assert.equal(summary.research.shadow, false);
  } finally {
    loaded.restore();
  }
});

test('pure data mapping: research cadence, rewards preview/history and leaderboards', async () => {
  const loaded = await loadClientModule();
  try {
    const helpers = loaded.module.helpers;
    const status = buildStatusPayload({ running: true });

    // ---- research cadence ----
    assert.equal(helpers.RESEARCH_CADENCE_OPTIONS.length, 7);
    assert.deepEqual(helpers.RESEARCH_CADENCE_OPTIONS.map((option) => option.key), [
      'interval:3600',
      'interval:10800',
      'interval:21600',
      'interval:86400',
      'pre-open',
      'post-close',
      'pre-open+post-close',
    ]);
    const researchStatus = helpers.researchStatusSummary(status);
    assert.equal(helpers.researchCadenceKey(researchStatus), 'interval:3600');
    assert.equal(helpers.researchCadenceKey(null), null);

    const preOpenStatus = helpers.researchStatusSummary(buildStatusPayload({
      research: {
        enabled: true,
        configured: true,
        influence: true,
        scheduleMode: 'pre-open',
        intervalSec: 3600,
        provider: 'p',
        model: 'm',
        runs: 1,
        errors: 0,
        configurable: { scheduleModes: ['interval', 'pre-open', 'post-close', 'pre-open+post-close'], intervalOptionsSec: [3600, 10800, 21600, 86400] },
      },
    }));
    assert.equal(helpers.researchCadenceKey(preOpenStatus), 'pre-open');
    assert.deepEqual(preOpenStatus.configurable.intervalOptionsSec, [3600, 10800, 21600, 86400]);

    assert.deepEqual(helpers.researchSettingsFromCadence('interval:10800', { enabled: true, influence: false }), {
      mode: 'interval',
      intervalSec: 10800,
      enabled: true,
      influence: false,
    });
    assert.deepEqual(helpers.researchSettingsFromCadence('pre-open', { enabled: false }), { mode: 'pre-open', enabled: false });
    assert.equal(helpers.researchSettingsFromCadence('bogus-key', {}), null);

    // ---- rewards ----
    const rewards = status.engine.rewards;
    const rewardsState = helpers.rewardsControlState(rewards);
    assert.equal(rewardsState.enabled, true);
    assert.equal(rewardsState.period, 'daily');
    assert.deepEqual(rewardsState.rankPercents, [0.05, 0.03, 0.02]);
    assert.equal(rewardsState.accountCashUsd, 15000);
    assert.equal(rewardsState.poolUsd, 4000);
    assert.equal(rewardsState.allocationCapRemainingUsd, 16000);
    assert.equal(rewardsState.lastWinners.length, 3);

    const preview = helpers.rewardsPreview(rewards, [0.05, 0.03, 0.02]);
    assert.deepEqual(preview.rawAmounts, [750, 450, 300]);
    assert.equal(preview.totalUsd, 1500);
    assert.equal(preview.capped, false);
    assert.equal(preview.scale, 1);

    const poolCapped = helpers.rewardsPreview({ ...rewards, poolUsd: 300 }, [0.05, 0.03, 0.02]);
    assert.equal(poolCapped.capped, true);
    assert.equal(poolCapped.cappedBy, 'pool');
    assert.deepEqual(poolCapped.amounts, [150, 90, 60]);
    assert.equal(poolCapped.totalUsd, 300);

    const maxCapped = helpers.rewardsPreview({ ...rewards, maxPerPeriodUsd: 100 }, [0.05, 0.03, 0.02]);
    assert.equal(maxCapped.cappedBy, 'max');
    assert.deepEqual(maxCapped.amounts, [50, 30, 20]);
    assert.equal(maxCapped.totalUsd, 100);

    const history = helpers.rewardHistoryRows(status);
    assert.equal(history.length, 2);
    assert.equal(history[0].periodKey, '2026-01-01');
    assert.equal(history[0].totalUsd, 1500);
    assert.equal(history[0].winners.length, 3);
    assert.equal(helpers.rewardHistoryRows({}).length, 0);

    const lastWinners = helpers.lastWinnerRows(rewards);
    assert.equal(lastWinners.length, 3);
    assert.equal(lastWinners[0].rank, 1);
    assert.equal(typeof lastWinners[0].name, 'string');
    assert.equal(lastWinners[0].amountUsd, 750);

    // ---- leaderboards ----
    const periods = helpers.leaderboardPeriods(status);
    assert.equal(periods.asOf, '2026-01-02T00:00:00.000Z');
    assert.equal(periods.daily.length, 24, 'only alive agents are ranked');
    assert.equal(periods.weekly.length, 24);
    assert.equal(periods.monthly.length, 24);
    assert.equal(periods.daily[0].rank, 1);
    assert.equal(periods.daily[0].medal, '🥇');
    assert.equal(periods.daily[1].medal, '🥈');
    assert.equal(periods.daily[2].medal, '🥉');
    assert.equal(periods.daily[3].medal, null);
    assert.equal(typeof periods.daily[0].name, 'string');
    assert.equal(typeof periods.daily[0].pnlPct, 'number');
    for (let index = 1; index < periods.daily.length; index += 1) {
      assert.ok((periods.daily[index - 1].pnlPct ?? -Infinity) >= (periods.daily[index].pnlPct ?? -Infinity));
    }
    assert.equal(helpers.leaderboardRows(status, 'weekly').length, 24);
    assert.equal(helpers.leaderboardRows(status, 'bogus').length, 24);
    const emptyPeriods = helpers.leaderboardPeriods({});
    assert.deepEqual(emptyPeriods, { asOf: null, daily: [], weekly: [], monthly: [] });

    // ---- agent plan / transactions / ranking badges / pnl ----
    const rows = helpers.buildAgentRows(status);
    const planned = rows.find((row) => row.plan);
    assert.ok(planned);
    assert.match(planned.plan.summary, /bot/);
    assert.match(planned.plan.entryRule, /Buy/);
    assert.equal(planned.plan.exitRules.length, 4);
    assert.match(planned.plan.riskRule, /size/);
    assert.match(planned.plan.nextStep, /Waiting/);
    assert.ok(planned.plan.triggers.length >= 7);
    assert.ok(planned.plan.triggers.some((trigger) => trigger.key === 'stopPct' && trigger.value.includes('%')));
    assert.equal(planned.plan.nextResearchAt, '2026-01-02T01:00:00.000Z');
    assert.equal(helpers.agentPlanMapping(null), null);
    assert.equal(helpers.agentPlanMapping({}), null);

    const positioned = rows.find((row) => row.plan && row.plan.position);
    assert.ok(positioned);
    assert.equal(typeof positioned.plan.position.symbol, 'string');
    assert.equal(typeof positioned.plan.position.stopPriceUsd, 'number');
    assert.equal(typeof positioned.plan.position.targetPriceUsd, 'number');
    assert.equal(typeof positioned.plan.position.barsHeld, 'number');
    assert.equal(typeof positioned.plan.position.maxHoldBars, 'number');
    const noPlan = rows.find((row) => row.plan === null);
    assert.ok(noPlan, 'some agents have no plan yet (empty state)');

    const withOrders = rows.find((row) => row.transactions.length > 0);
    assert.ok(withOrders);
    assert.equal(withOrders.transactions.length, 3);
    const order = withOrders.transactions[0];
    assert.equal(typeof order.symbol, 'string');
    assert.ok(['buy', 'sell'].includes(order.side));
    assert.equal(typeof order.priceUsd, 'number');
    assert.equal(typeof order.notionalUsd, 'number');
    assert.equal(typeof order.orderId, 'string');
    assert.deepEqual(helpers.agentTransactionRows([]), []);
    assert.equal(helpers.agentTransactionRows(null).length, 0);

    const ranked = rows.find((row) => row.rankBadges.length === 3);
    assert.ok(ranked);
    assert.deepEqual(ranked.rankBadges.map((badge) => badge.key), ['day', 'week', 'month']);
    const unranked = rows.find((row) => row.rankBadges.length === 0);
    assert.ok(unranked, 'an agent without rankings gets no badges');
    assert.deepEqual(helpers.agentRankingBadges(null), []);
    assert.equal(helpers.agentRankingBadges({ dayRank: 1 }).length, 1);

    const withPnl = rows.find((row) => row.pnl);
    assert.ok(withPnl);
    assert.equal(typeof withPnl.pnl.netUsd, 'number');
    assert.equal(typeof withPnl.pnl.weekPct, 'number');
    assert.equal(helpers.agentPnlMapping(null), null);

    const summary = helpers.summarize(status);
    assert.equal(summary.rewards.period, 'daily');
    assert.equal(summary.rankings.asOf, '2026-01-02T00:00:00.000Z');

    // Empty-state payload: no rankings/rewards/orders/plans anywhere.
    const bareStatus = buildStatusPayload({ running: true, rankings: null, rewards: null });
    for (const agent of bareStatus.agents) {
      delete agent.orders;
      delete agent.plan;
      delete agent.rankings;
      delete agent.pnl;
    }
    delete bareStatus.engine.rewards;
    delete bareStatus.rewards;
    bareStatus.rankings = null;
    bareStatus.rewards = null;
    const bareRows = helpers.buildAgentRows(bareStatus);
    assert.equal(bareRows.every((row) => row.plan === null), true);
    assert.equal(bareRows.every((row) => row.transactions.length === 0), true);
    assert.equal(bareRows.every((row) => row.rankBadges.length === 0), true);
    assert.deepEqual(helpers.leaderboardPeriods(bareStatus), { asOf: null, daily: [], weekly: [], monthly: [] });
    assert.equal(helpers.lastWinnerRows(null).length, 0);
    assert.equal(helpers.rewardHistoryRows(bareStatus).length, 0);
    assert.equal(helpers.rewardsControlState(undefined).available, false);
  } finally {
    loaded.restore();
  }
});

test('pure data mapping: strategy types/intervals, category tabs and bot-agent policy', async () => {
  const loaded = await loadClientModule();
  try {
    const helpers = loaded.module.helpers;
    const status = buildStatusPayload({ running: true });
    const rows = helpers.buildAgentRows(status);

    // ---- strategy taxonomy (engine-provided) ----
    const momentumRow = rows.find((row) => row.strategy.family === 'momentum' && row.strategy.hasEngineStrategy);
    assert.ok(momentumRow);
    assert.equal(momentumRow.strategy.typeLabel, 'Momentum swing');
    assert.equal(momentumRow.strategy.category, 'swing');
    assert.equal(momentumRow.strategy.categoryLabel, 'Swing · mid-long');
    assert.equal(momentumRow.strategy.estimatedIntervalSec, 3600);
    assert.equal(momentumRow.strategy.estimatedIntervalLabel, '~1h');
    assert.equal(momentumRow.strategy.timeframe, '1Hour');
    assert.equal(momentumRow.strategyTypeLabel, 'Momentum swing');
    assert.equal(momentumRow.category, 'swing');
    assert.equal(momentumRow.intervalLabel, '~1h');

    const meanrevRow = rows.find((row) => row.strategy.family === 'meanrev' && row.strategy.hasEngineStrategy);
    assert.ok(meanrevRow);
    assert.equal(meanrevRow.strategy.typeLabel, 'Mean-reversion swing');
    assert.equal(meanrevRow.strategy.category, 'swing');

    const dayRow = rows.find((row) => row.strategy.category === 'day');
    assert.ok(dayRow);
    assert.equal(dayRow.strategy.typeLabel, 'Intraday breakout');
    assert.equal(dayRow.strategy.categoryLabel, 'Day · intraday');
    assert.equal(dayRow.strategy.estimatedIntervalSec, 300);
    assert.equal(dayRow.intervalLabel, '~5m');
    assert.equal(dayRow.strategy.timeframe, '1Min');

    // ---- taxonomy fallback when the engine has not added agent.strategy yet ----
    const fallbackSwing = helpers.agentStrategyMapping({ genome: { family: 'meanrev' }, status: 'alive' });
    assert.equal(fallbackSwing.hasEngineStrategy, false);
    assert.equal(fallbackSwing.typeLabel, 'Mean-reversion swing');
    assert.equal(fallbackSwing.category, 'swing');
    assert.equal(fallbackSwing.estimatedIntervalLabel, '~1h');
    const fallbackDay = helpers.agentStrategyMapping({ genome: { family: 'gapfade' } });
    assert.equal(fallbackDay.typeLabel, 'Day-trade gap fade');
    assert.equal(fallbackDay.category, 'day');
    assert.equal(fallbackDay.estimatedIntervalLabel, '~5m');
    const fallbackUnknown = helpers.agentStrategyMapping({ genome: { family: 'exotic' } });
    assert.equal(fallbackUnknown.typeLabel, 'Custom swing');
    assert.equal(fallbackUnknown.category, 'swing');
    const fallbackCadence = helpers.agentStrategyMapping({ genome: { family: 'momentum' }, cadence: { swing: { intervalSec: 10800, timeframe: '1Hour' } } });
    assert.equal(fallbackCadence.estimatedIntervalSec, 10800);
    assert.equal(fallbackCadence.estimatedIntervalLabel, '~3h');

    // ---- interval label formatting ----
    assert.equal(helpers.estimatedIntervalLabel(30), '~30s');
    assert.equal(helpers.estimatedIntervalLabel(119), '~119s');
    assert.equal(helpers.estimatedIntervalLabel(120), '~2m');
    assert.equal(helpers.estimatedIntervalLabel(300), '~5m');
    assert.equal(helpers.estimatedIntervalLabel(3600), '~1h');
    assert.equal(helpers.estimatedIntervalLabel(5400), '~1.5h');
    assert.equal(helpers.estimatedIntervalLabel(86400), '~24h');
    assert.equal(helpers.estimatedIntervalLabel(null), '—');
    assert.equal(helpers.estimatedIntervalLabel(0), '—');
    assert.equal(helpers.estimatedIntervalLabel(-5), '—');
    assert.equal(helpers.strategyCategoryLabel('swing'), 'Swing · mid-long');
    assert.equal(helpers.strategyCategoryLabel('day'), 'Day · intraday');
    assert.equal(helpers.strategyCategoryLabel('bogus'), null);

    // ---- category tabs + filtering ----
    const tabs = helpers.categoryTabs(status, rows);
    assert.equal(tabs.length, 3);
    assert.deepEqual(tabs.map((tab) => tab.key), ['all', 'swing', 'day']);
    assert.equal(tabs[0].count, 30);
    assert.equal(tabs[1].count, 20);
    assert.equal(tabs[2].count, 10);
    assert.equal(tabs[1].labelKey, 'categorySwing');
    assert.equal(tabs[2].labelKey, 'categoryDay');
    const derivedTabs = helpers.categoryTabs(null, rows);
    assert.deepEqual(derivedTabs.map((tab) => tab.count), [30, 20, 10]);
    assert.equal(helpers.filterRowsByCategory(rows, 'all').length, 30);
    assert.equal(helpers.filterRowsByCategory(rows, 'swing').length, 20);
    assert.equal(helpers.filterRowsByCategory(rows, 'day').length, 10);
    assert.equal(helpers.filterRowsByCategory(rows, 'bogus').length, 30);
    assert.equal(helpers.filterRowsByCategory(rows, 'day').every((row) => row.category === 'day'), true);

    // ---- bot-agent policy variants ----
    const tradePolicy = rows.find((row) => row.policy && row.policy.stance === 'trade' && row.policy.stale === false);
    assert.ok(tradePolicy);
    assert.equal(tradePolicy.policy.available, true);
    assert.equal(tradePolicy.policy.stanceBadge.labelKey, 'stanceTrade');
    assert.equal(tradePolicy.policy.stanceBadge.tone, 'trade');
    assert.equal(tradePolicy.policy.sizeMultiplier, 1);
    assert.equal(tradePolicy.policy.riskMultiplier, 1);
    assert.equal(tradePolicy.policy.confidence, 0.72);
    assert.equal(tradePolicy.policy.exitPressure, 'none');
    assert.match(tradePolicy.policy.thesis, /fixture thesis/);
    assert.deepEqual(tradePolicy.policy.plan, ['hold existing position', 'wait for the next confirmation']);
    assert.equal(tradePolicy.policy.watch.length, 2);
    assert.equal(tradePolicy.policy.reviewCount, 4);
    assert.equal(tradePolicy.policy.nextReviewAt, '2026-01-02T00:05:00.000Z');
    assert.equal(tradePolicy.policy.at, '2026-01-02T00:00:00.000Z');

    const cautiousPolicy = rows.find((row) => row.policy && row.policy.stance === 'cautious');
    assert.ok(cautiousPolicy);
    assert.equal(cautiousPolicy.policy.stanceBadge.labelKey, 'stanceCautious');
    assert.equal(cautiousPolicy.policy.stanceBadge.tone, 'cautious');
    assert.equal(cautiousPolicy.policy.sizeMultiplier, 0.5);
    assert.equal(cautiousPolicy.policy.riskMultiplier, 1.2);

    const standDownPolicy = rows.find((row) => row.policy && row.policy.stance === 'stand_down');
    assert.ok(standDownPolicy);
    assert.equal(standDownPolicy.policy.stanceBadge.labelKey, 'stanceStandDown');
    assert.equal(standDownPolicy.policy.stanceBadge.tone, 'stand_down');
    assert.equal(standDownPolicy.policy.exitPressure, 'exit');
    assert.equal(standDownPolicy.policy.stale, true);

    const stalePolicy = rows.find((row) => row.policy && row.policy.stale === true);
    assert.ok(stalePolicy);
    assert.equal(stalePolicy.policy.stale, true);

    const noPolicy = rows.find((row) => row.policy === null);
    assert.ok(noPolicy, 'some bots have not reviewed yet (empty state)');
    assert.equal(helpers.botAgentPolicyMapping(null), null);
    assert.equal(helpers.botAgentPolicyMapping({}), null);
    assert.equal(helpers.botAgentPolicyMapping('garbage'), null);
    const minimal = helpers.botAgentPolicyMapping({ stance: 'trade', plan: ['x', '', 3], watch: [{ symbol: 'AAPL' }, { bad: true }, 'TSLA'] });
    assert.equal(minimal.available, true);
    assert.deepEqual(minimal.plan, ['x']);
    assert.deepEqual(minimal.watch, ['AAPL', 'TSLA']);
    assert.equal(minimal.stanceBadge.labelKey, 'stanceTrade');

    assert.equal(helpers.stanceBadge('trade').tone, 'trade');
    assert.equal(helpers.stanceBadge('cautious').tone, 'cautious');
    assert.equal(helpers.stanceBadge('stand_down').tone, 'stand_down');
    assert.equal(helpers.stanceBadge('unknown').tone, 'unknown');
    assert.equal(helpers.stanceBadge(undefined).labelKey, 'stanceUnknown');

    // ---- engine bot-agent bridge line ----
    const engineAgents = helpers.botAgentEngineStatus(status.engine.agents);
    assert.equal(engineAgents.available, true);
    assert.equal(engineAgents.enabled, true);
    assert.equal(engineAgents.configured, true);
    assert.equal(engineAgents.provider, 'deepseek-account');
    assert.equal(engineAgents.model, 'deepseek-flash');
    assert.equal(engineAgents.intervalDaySec, 300);
    assert.equal(engineAgents.intervalSwingSec, 3600);
    assert.equal(engineAgents.dayLabel, '~5m');
    assert.equal(engineAgents.swingLabel, '~1h');
    assert.equal(engineAgents.runs, 7);
    assert.equal(engineAgents.errors, 0);
    assert.equal(engineAgents.nextDueAt, '2026-01-02T00:05:00.000Z');
    assert.equal(helpers.botAgentEngineStatus(null).available, false);
    assert.equal(helpers.botAgentEngineStatus({}).available, false);
    const unconfiguredEngine = helpers.botAgentEngineStatus({ enabled: true, configured: false, intervalDaySec: 300, intervalSwingSec: 3600, note: 'no LLM bridge' });
    assert.equal(unconfiguredEngine.configured, false);
    assert.equal(unconfiguredEngine.note, 'no LLM bridge');

    const summary = helpers.summarize(status);
    assert.equal(summary.strategyMix.total, 30);
    assert.equal(summary.engineAgents.available, true);
    assert.equal(helpers.summarize({}).engineAgents.available, false);

    // ---- bare payload: engine has none of the new fields yet ----
    const bareStatus = buildStatusPayload({ running: true });
    for (const agent of bareStatus.agents) {
      delete agent.strategy;
      delete agent.policy;
    }
    delete bareStatus.strategyMix;
    delete bareStatus.engine.agents;
    const bareRows = helpers.buildAgentRows(bareStatus);
    assert.equal(bareRows.every((row) => row.policy === null), true);
    assert.equal(bareRows.every((row) => typeof row.strategy.typeLabel === 'string'), true, 'type falls back to the genome family');
    assert.equal(bareRows.every((row) => typeof row.intervalLabel === 'string'), true);
    assert.deepEqual(helpers.categoryTabs(null, bareRows).map((tab) => tab.count), [30, 20, 10]);
    assert.equal(helpers.summarize(bareStatus).engineAgents.available, false);
    assert.equal(helpers.botAgentEngineStatus(undefined).available, false);
  } finally {
    loaded.restore();
  }
});

test('pure data mapping: long/short/option positions, instrument badges, playbook and header caps', async () => {
  const loaded = await loadClientModule();
  try {
    const helpers = loaded.module.helpers;
    const status = buildStatusPayload({ running: true });
    const rows = helpers.buildAgentRows(status);

    // ---- position normalization ----
    const longStock = helpers.positionRows([{ symbol: 'AAPL', qty: 2, avgPriceUsd: 10, lastPriceUsd: 12 }])[0];
    assert.equal(longStock.isStock, true);
    assert.equal(longStock.isOption, false);
    assert.equal(longStock.side, 'LONG');
    assert.equal(longStock.qtySigned, 2);
    assert.equal(longStock.marketValueUsd, 24);
    assert.equal(longStock.option, null);

    const shortStock = helpers.positionRows([{
      symbol: 'F',
      assetClass: 'us_equity',
      qtySigned: -10,
      side: 'SHORT',
      avgPriceUsd: 12,
      lastPriceUsd: 11.5,
      marketValueUsd: -115,
      unrealizedPlUsd: 5,
    }])[0];
    assert.equal(shortStock.side, 'SHORT');
    assert.equal(shortStock.isShort, true);
    assert.equal(shortStock.qtySigned, -10);
    assert.equal(shortStock.marketValueUsd, -115);
    assert.equal(shortStock.unrealizedPlUsd, 5);

    const callOption = helpers.positionRows([{
      symbol: 'AAPL260116C00200000',
      assetClass: 'us_option',
      qtySigned: 2,
      side: 'CALL',
      avgPriceUsd: 3.2,
      lastPriceUsd: 4.1,
      marketValueUsd: 820,
      unrealizedPlUsd: 180,
      multiplier: 100,
      groupId: 'grp-call-1',
      option: { underlying: 'AAPL', strikeUsd: 200, expiration: '2026-01-16', dte: 14, type: 'CALL', multiplier: 100 },
    }])[0];
    assert.equal(callOption.isOption, true);
    assert.equal(callOption.side, 'CALL');
    assert.equal(callOption.contracts, 2);
    assert.equal(callOption.qtyText, '2 ct');
    assert.equal(callOption.option.strikeUsd, 200);
    assert.equal(callOption.option.expiration, '2026-01-16');
    assert.equal(callOption.option.expiryLabel, '2026-01-16');
    assert.equal(callOption.option.dte, 14);
    assert.equal(callOption.option.dteLabel, '14d');
    assert.equal(callOption.option.multiplier, 100);
    assert.equal(callOption.option.underlying, 'AAPL');
    assert.equal(callOption.groupId, 'grp-call-1');
    assert.ok(callOption.groupShort.length > 0);

    const derivedOption = helpers.positionRows([{ symbol: 'F261120C00013000', qtySigned: 3, avgPriceUsd: 1, lastPriceUsd: 2, option: { type: 'CALL', strikeUsd: 13, expiration: '2026-11-20', dte: 5 } }])[0];
    assert.equal(derivedOption.isOption, true);
    assert.equal(derivedOption.side, 'CALL');
    assert.equal(derivedOption.option.underlying, 'F', 'underlying parsed from the OCC symbol');
    assert.equal(derivedOption.marketValueUsd, 600, 'contracts × premium × multiplier');
    assert.equal(helpers.positionRows([]).length, 0);
    assert.equal(helpers.positionRows(null).length, 0);

    // Position rows carry short stock + option + spread legs; summary aggregates exposure.
    const instrumentRow = rows.find((row) => row.positionRows.some((position) => position.side === 'CALL'));
    assert.ok(instrumentRow);
    assert.ok(instrumentRow.positionRows.some((position) => position.isShort));
    assert.ok(instrumentRow.positionRows.some((position) => position.isOption && position.groupId));
    const spreadRow = rows.find((row) => row.positionRows.filter((position) => position.groupId).length >= 2);
    assert.ok(spreadRow);
    assert.equal(spreadRow.positionSummary.spreadGroups, 1);
    assert.ok(spreadRow.positionSummary.options.calls >= 2);
    assert.ok(spreadRow.positionSummary.grossExposureUsd >= spreadRow.positionSummary.netExposureUsd);
    const putRow = rows.find((row) => row.positionRows.some((position) => position.side === 'PUT'));
    assert.ok(putRow);
    const putPosition = putRow.positionRows.find((position) => position.side === 'PUT');
    assert.equal(putPosition.option.strikeUsd, 450);
    assert.equal(putPosition.option.dteLabel, '21d');
    assert.equal(typeof instrumentRow.grossExposureUsd, 'number');
    assert.equal(typeof instrumentRow.netExposureUsd, 'number');
    assert.equal(instrumentRow.marginDebtUsd, 35.12);

    // ---- instrument permissions / badges ----
    const permissions = helpers.instrumentPermissionsMapping(instrumentPermissionsFixture(2));
    assert.equal(permissions.available, true);
    assert.equal(permissions.longStock, true);
    assert.equal(permissions.shortStock, true);
    assert.equal(permissions.spreads, true);
    assert.equal(permissions.margin, true);
    assert.ok(permissions.allowedStructures.some((structure) => structure.key === 'call_credit_spread'));
    const badgeInfo = helpers.instrumentBadges({ instrumentPermissions: instrumentPermissionsFixture(2) });
    assert.equal(badgeInfo.available, true);
    assert.deepEqual(badgeInfo.badges.map((badge) => badge.labelKey), ['badgeStock', 'badgeShort', 'badgeOptions', 'badgeSpreads', 'badgeMargin']);
    assert.match(badgeInfo.tooltip, /Long stock/);
    const unknownStructure = helpers.instrumentPermissionsMapping({ allowedStructures: ['mystery_structure'], longStock: false });
    assert.equal(unknownStructure.allowedStructures[0].label, 'mystery_structure');
    assert.equal(unknownStructure.badges.some((badge) => badge.key === 'stock'), false);
    assert.equal(helpers.instrumentPermissionsMapping(null).available, false);
    assert.deepEqual(helpers.instrumentPermissionsMapping(undefined).badges, []);
    assert.equal(helpers.instrumentStructureLabel('put_credit_spread'), 'Put credit spread');
    assert.equal(helpers.instrumentStructureLabel('mystery'), 'mystery');
    assert.equal(helpers.instrumentStructureLabel(undefined), '—');

    // ---- playbook ----
    const playbook = helpers.playbookMapping(rows[0].playbook);
    assert.equal(playbook.available, true);
    assert.equal(playbook.family, 'momentum');
    assert.equal(playbook.familyLabel, 'Momentum');
    assert.deepEqual(playbook.bullish.map((structure) => structure.label), ['Long stock', 'Long call']);
    assert.deepEqual(playbook.bearish.map((structure) => structure.label), ['Short stock', 'Long put']);
    assert.deepEqual(playbook.neutral.map((structure) => structure.label), ['Hold']);
    assert.ok(playbook.structures.length >= 4);
    const rawPlaybook = helpers.playbookMapping({ family: 'strange', bullish: 'mystery_structure' });
    assert.equal(rawPlaybook.bullish[0].label, 'mystery_structure');
    assert.equal(helpers.playbookMapping(null).available, false);
    assert.equal(helpers.playbookMapping({}).hasContent, false);
    assert.equal(rows[0].instrumentTooltip.length > 0, true);

    // ---- bot-agent instrument policy plan ----
    const policyWithPlan = rows.find((row) => row.policy?.instrument);
    assert.ok(policyWithPlan);
    assert.equal(policyWithPlan.policy.instrument.available, true);
    assert.ok(typeof policyWithPlan.policy.instrument.prefer === 'string');
    assert.equal(policyWithPlan.policy.instrument.maxContracts, 2);
    assert.equal(policyWithPlan.policy.instrument.dteMin, 2);
    assert.equal(policyWithPlan.policy.instrument.dteMax, 14);
    const longCallPlan = rows.find((row) => row.policy?.instrument?.prefer === 'long_call');
    assert.ok(longCallPlan);
    assert.equal(longCallPlan.policy.instrument.preferLabel, 'Long call');
    const autoPlan = rows.find((row) => row.policy?.instrument?.auto === true);
    assert.ok(autoPlan);
    assert.equal(helpers.instrumentPolicyMapping(null), null);
    assert.equal(helpers.instrumentPolicyMapping({}), null);
    assert.equal(helpers.instrumentPolicyMapping({ prefer: 'auto' }).auto, true);

    // ---- engine instruments header ----
    const header = helpers.instrumentsHeader(status.instruments, status.account);
    assert.equal(header.available, true);
    assert.equal(header.enabled, true);
    assert.equal(header.allowMargin, true);
    assert.equal(header.allowShort, true);
    assert.equal(header.allowOptions, true);
    assert.equal(header.caps.maxOptionPremiumPctEquity, 0.25);
    assert.equal(header.caps.maxShortPctEquity, 1);
    assert.equal(header.caps.maxContracts, 3);
    assert.equal(header.caps.minDTE, 2);
    assert.equal(header.caps.maxDTE, 14);
    assert.equal(header.account.optionsTradingLevel, 3);
    assert.equal(header.account.marginMultiplier, 4);
    assert.equal(header.account.optionsBuyingPowerUsd, 2000);
    assert.equal(header.account.marginDebtUsd, 250);
    assert.equal(header.account.grossExposureUsd, 12000);
    assert.equal(header.account.netExposureUsd, 3500);
    assert.equal(header.playbookCount, 4);
    assert.equal(helpers.instrumentsHeader(null, null).available, false);
    assert.equal(helpers.instrumentsHeader(null, null).hasAccount, false);
    const accountOnly = helpers.instrumentsHeader({}, { marginDebtUsd: 5 });
    assert.equal(accountOnly.available, true);
    assert.equal(accountOnly.hasAccount, true);
    assert.equal(accountOnly.caps.maxContracts, null);
    const summary = helpers.summarize(status);
    assert.equal(summary.instruments.available, true);
    assert.equal(summary.instruments.account.optionsTradingLevel, 3);
    assert.equal(helpers.summarize({}).instruments.available, false);

    // ---- bare payload: none of the v3.0 fields exist yet ----
    const bareStatus = buildStatusPayload({ running: true });
    delete bareStatus.instruments;
    delete bareStatus.engine.instruments;
    delete bareStatus.engine.lastCycle;
    for (const agent of bareStatus.agents) {
      delete agent.positions;
      delete agent.instrumentPermissions;
      delete agent.playbook;
      delete agent.policy;
    }
    for (const key of ['buyingPowerUsd', 'marginDebtUsd', 'grossExposureUsd', 'netExposureUsd']) delete bareStatus.account[key];
    const bareRows = helpers.buildAgentRows(bareStatus);
    assert.equal(bareRows.every((row) => row.positionRows.length === 0 && row.positionCount === 0), true);
    assert.equal(bareRows.every((row) => row.instrumentBadges.length === 0), true);
    assert.equal(bareRows.every((row) => row.playbook.available === false), true);
    assert.equal(bareRows.every((row) => row.instrumentPolicy === null), true);
    assert.equal(helpers.summarize(bareStatus).instruments.available, false);
    assert.equal(helpers.instrumentsHeader(undefined, undefined).available, false);
  } finally {
    loaded.restore();
  }
});

test('pure data mapping: last-cycle diagnostics and restricted broker capability', async () => {
  const loaded = await loadClientModule();
  try {
    const helpers = loaded.module.helpers;

    // ---- last cycle: absent / closed / open (object and array skip-reason forms) ----
    const none = helpers.lastCycleMapping(null);
    assert.equal(none.available, false);
    assert.equal(none.marketStateKey, 'lastCycleEmpty');
    assert.equal(none.topSkipText, '');
    assert.equal(helpers.lastCycleMapping(undefined).available, false);

    const closed = helpers.lastCycleMapping(lastCycleClosedFixture());
    assert.equal(closed.available, true);
    assert.equal(closed.marketOpen, false);
    assert.equal(closed.marketStateKey, 'marketClosed');
    assert.equal(closed.tradingSkipped, true);
    assert.equal(closed.executions, 0);
    assert.equal(closed.orders, 0);
    assert.equal(closed.hasActivity, false);
    assert.equal(closed.topSkipReasons[0].reason, 'market_closed');
    assert.equal(closed.topSkipReasons[0].count, 30);
    assert.match(closed.topSkipText, /market_closed 30/);
    assert.equal(closed.botReviews.paused, true);
    assert.equal(closed.botReviews.skipped, 30);

    const open = helpers.lastCycleMapping(lastCycleOpenFixture());
    assert.equal(open.marketStateKey, 'marketOpen');
    assert.equal(open.tradingSkipped, false);
    assert.equal(open.executions, 2);
    assert.equal(open.orders, 4);
    assert.equal(open.denied, 1);
    assert.equal(open.hasActivity, true);
    assert.equal(open.topSkipReasons.length, 3, 'top skip reasons are limited to three');
    assert.deepEqual(open.topSkipReasons.map((entry) => entry.reason), ['inside_range', 'gap_2bps', 'no_proof']);
    assert.deepEqual(open.topSkipReasons.map((entry) => entry.count), [27, 12, 3]);
    assert.equal(open.topSkipText, 'inside_range 27 · gap_2bps 12 · no_proof 3');
    assert.equal(open.botReviews.due, 6);
    assert.equal(open.botReviews.reviewed, 4);
    assert.equal(open.botReviews.deferred, 2);
    assert.equal(open.research.runs, 2);

    const arrayReasons = helpers.lastCycleMapping({ marketOpen: true, topSkipReasons: [{ reason: 'a', count: 5 }, { reason: 'b', count: 2 }] });
    assert.deepEqual(arrayReasons.topSkipReasons.map((entry) => entry.reason), ['a', 'b']);
    assert.equal(helpers.lastCycleMapping({ topSkipReasons: { zero: 0 } }).topSkipText, '');
    assert.equal(helpers.lastCycleMapping({ executions: 1 }).marketStateKey, 'marketUnknown');

    // ---- restricted broker capability warning ----
    const unknown = helpers.instrumentsCapabilityWarning(null);
    assert.equal(unknown.show, false);
    assert.equal(unknown.unknown, true);
    assert.equal(helpers.instrumentsCapabilityWarning(instrumentsFixture()).show, false, 'an account with no effective caps produces no warning');

    const warning = helpers.instrumentsCapabilityWarning(restrictedInstrumentsFixture());
    assert.equal(warning.show, true);
    assert.equal(warning.restricted, true);
    assert.equal(warning.shortStockDisabled, true);
    assert.equal(warning.marginDisabled, true);
    assert.equal(warning.creditOptionsDisabled, false);
    assert.deepEqual(warning.disabled, ['shortStock', 'margin']);
    assert.equal(warning.longStockAvailable, true);
    assert.equal(warning.optionsAvailable, true);
    assert.equal(warning.account.shortingEnabled, false);
    assert.equal(warning.account.marginMultiplier, 1);
    assert.equal(warning.account.optionsTradingLevel, 3);
    assert.equal(warning.unknown, false);

    // ---- per-agent badge handling of restricted permissions ----
    const fullBadges = helpers.effectiveInstrumentBadges(instrumentPermissionsFixture(2));
    assert.equal(fullBadges.available, true);
    assert.equal(fullBadges.badges.some((badge) => badge.key === 'short'), true);
    assert.equal(fullBadges.badges.some((badge) => badge.key === 'margin'), true);
    assert.deepEqual(fullBadges.disabled, []);

    const restrictedBadges = helpers.effectiveInstrumentBadges({ longStock: true, shortStock: false, margin: false, longOptions: true, allowedStructures: ['long_stock', 'long_call'] });
    assert.equal(restrictedBadges.available, true);
    assert.equal(restrictedBadges.badges.some((badge) => badge.key === 'short'), false, 'disabled shorting omits the Short badge');
    assert.equal(restrictedBadges.badges.some((badge) => badge.key === 'margin'), false, 'disabled margin omits the Margin badge');
    assert.equal(restrictedBadges.badges.some((badge) => badge.key === 'stock'), true);
    assert.equal(restrictedBadges.badges.some((badge) => badge.key === 'options'), true);
    assert.deepEqual(restrictedBadges.disabled.map((entry) => entry.key), ['short', 'margin']);
    assert.match(restrictedBadges.tooltip, /disabled by broker account/);
    assert.equal(helpers.effectiveInstrumentBadges(null).available, false);

    // ---- dashboard integration: restricted status + closed cycle ----
    const restrictedStatus = buildStatusPayload({ running: true, instruments: restrictedInstrumentsFixture(), lastCycle: lastCycleClosedFixture() });
    const summary = helpers.summarize(restrictedStatus);
    assert.equal(summary.instruments.available, true);
    assert.equal(summary.instruments.effective.shortStock, false);
    assert.equal(summary.instruments.effective.margin, false);
    assert.equal(summary.instruments.effective.creditOptions, true);
    assert.equal(summary.instruments.effective.longStock, true);
    assert.equal(summary.instruments.account.shortingEnabled, false);
    assert.equal(summary.brokerCapability.show, true);
    assert.equal(summary.brokerCapability.shortStockDisabled, true);
    assert.equal(summary.brokerCapability.account.marginMultiplier, 1);
    assert.equal(summary.lastCycle.available, true);
    assert.equal(summary.lastCycle.marketStateKey, 'marketClosed');
    assert.equal(summary.lastCycle.tradingSkipped, true);
    assert.equal(summary.lastCycle.hasActivity, false);

    const rows = helpers.buildAgentRows(restrictedStatus);
    const restrictedRow = rows.find((row) => row.instrumentPermissions.shortStock === false);
    assert.ok(restrictedRow, 'some bots have shorting disabled by the broker account');
    assert.equal(restrictedRow.instrumentBadges.some((badge) => badge.key === 'short'), false);
    assert.match(restrictedRow.instrumentTooltip, /disabled by broker account/);
    const marginRow = rows.find((row) => row.instrumentPermissions.margin === false);
    assert.ok(marginRow);
    assert.equal(marginRow.instrumentBadges.some((badge) => badge.key === 'margin'), false);

    // Open-cycle default fixture keeps the diagnostic line meaningful.
    const openSummary = helpers.summarize(buildStatusPayload({ running: true }));
    assert.equal(openSummary.lastCycle.marketStateKey, 'marketOpen');
    assert.deepEqual(openSummary.lastCycle.topSkipReasons.map((entry) => entry.reason), ['inside_range', 'gap_2bps', 'no_proof']);
    assert.equal(openSummary.brokerCapability.show, false);

    // ---- bare payload: neither v3.1 field exists yet ----
    const bareStatus = buildStatusPayload({ running: true });
    delete bareStatus.engine.lastCycle;
    delete bareStatus.engine.instruments;
    delete bareStatus.instruments;
    for (const agent of bareStatus.agents) {
      delete agent.instrumentPermissions;
      delete agent.playbook;
    }
    const bareSummary = helpers.summarize(bareStatus);
    assert.equal(bareSummary.lastCycle.available, false);
    assert.equal(bareSummary.lastCycle.marketStateKey, 'lastCycleEmpty');
    assert.equal(bareSummary.brokerCapability.show, false);
    assert.equal(bareSummary.brokerCapability.unknown, true);
    assert.equal(bareSummary.instruments.effective.available, false);
    assert.equal(helpers.buildAgentRows(bareStatus).every((row) => row.instrumentBadges.length === 0), true);
  } finally {
    loaded.restore();
  }
});

test('pure data mapping: live market tape, KPIs, equity chart and 70/30 mix', async () => {
  const loaded = await loadClientModule();
  try {
    const helpers = loaded.module.helpers;
    const state = buildStatusPayload({ running: true });
    const view = buildMarketViewPayload();

    // ---- change helpers ----
    assert.equal(helpers.changeDirection(1.2), 'up');
    assert.equal(helpers.changeDirection(-0.3), 'down');
    assert.equal(helpers.changeDirection(0), 'flat');
    assert.equal(helpers.changeDirection(null), 'flat');
    assert.equal(helpers.marketChangePctText(0.0125), '+1.25%');
    assert.equal(helpers.marketChangePctText(-0.6), '-0.60%');
    assert.equal(helpers.marketChangePctText(0), '0.00%');
    assert.equal(helpers.marketChangePctText(null), '—');

    // ---- sparkline path ----
    const spark = helpers.sparklinePath([1, 2, 3]);
    assert.match(spark, /^M/);
    assert.match(spark, /L/);
    assert.equal(helpers.sparklinePath([]), '');
    assert.equal(helpers.sparklinePath(null), '');

    // ---- market tape: up / down / flat / stale / closed / limit / empty ----
    const tape = helpers.marketTapeRows(view);
    assert.equal(tape.length, 4);
    const aapl = tape.find((row) => row.symbol === 'AAPL');
    assert.equal(aapl.direction, 'up');
    assert.equal(aapl.priceUsd, 195.5);
    assert.equal(aapl.changePctText, '+1.30%');
    assert.equal(typeof aapl.bidText, 'string');
    assert.equal(typeof aapl.askText, 'string');
    assert.ok(aapl.sparklinePath.length > 0);
    assert.equal(tape.find((row) => row.symbol === 'TSLA').direction, 'down');
    assert.equal(tape.find((row) => row.symbol === 'SPY').direction, 'flat');
    assert.equal(tape.find((row) => row.symbol === 'F').stale, true);
    assert.equal(helpers.marketTapeRows(view, { limit: 2 }).length, 2);
    const closedTape = helpers.marketTapeRows(buildMarketViewPayload({ marketOpen: false }));
    assert.equal(closedTape.every((row) => row.closed === true), true);
    assert.deepEqual(helpers.marketTapeRows(null), []);
    assert.deepEqual(helpers.marketTapeRows({}), []);

    // ---- equity chart geometry ----
    const chart = helpers.equityChartPoints(view.equityHistory);
    assert.equal(chart.hasData, true);
    assert.equal(chart.points.length, 3);
    assert.match(chart.path, /^M/);
    assert.match(chart.path, /L/);
    assert.match(chart.area, /Z$/);
    assert.equal(chart.last.equityUsd, 20500);
    assert.equal(chart.first.equityUsd, 20000);
    assert.equal(chart.deltaUsd, 500);
    assert.equal(chart.deltaPct, 2.5);
    assert.equal(chart.min, 20000);
    assert.equal(chart.max, 20500);
    const emptyChart = helpers.equityChartPoints([]);
    assert.equal(emptyChart.hasData, false);
    assert.equal(emptyChart.path, '');
    assert.equal(emptyChart.deltaUsd, null);

    // ---- KPI cards (live + state-only fallback) ----
    const cards = helpers.kpiCards(state, view);
    assert.equal(cards.length, 8);
    assert.deepEqual(cards.map((card) => card.key), ['equity', 'dayPnl', 'cashBp', 'exposure', 'population', 'tradesToday', 'winRate', 'treasury']);
    const equityCard = cards.find((card) => card.key === 'equity');
    assert.equal(equityCard.value, '$20,500.00');
    assert.equal(equityCard.direction, 'up');
    assert.equal(equityCard.deltaPct, 0.025);
    assert.equal(cards.find((card) => card.key === 'dayPnl').direction, 'up');
    const cashCard = cards.find((card) => card.key === 'cashBp');
    assert.match(cashCard.value, /15,200/);
    assert.match(cards.find((card) => card.key === 'exposure').value, /12,500/);
    assert.equal(cards.find((card) => card.key === 'population').value, '24 / 30');
    assert.equal(cards.find((card) => card.key === 'tradesToday').value, '4');
    assert.match(cards.find((card) => card.key === 'winRate').value, /%$/);
    assert.equal(typeof cards.find((card) => card.key === 'treasury').value, 'string');
    const stateOnlyCards = helpers.kpiCards(state);
    assert.equal(stateOnlyCards.length, 8);
    assert.equal(stateOnlyCards.find((card) => card.key === 'equity').value, '$20,000.00');
    assert.deepEqual(helpers.kpiCards(null), []);

    // ---- 70/30 strategy mix ----
    const mix = helpers.strategyMixBreakdown(state);
    assert.equal(mix.available, true);
    assert.equal(mix.total, 30);
    assert.equal(mix.targetDayPct, 0.7);
    assert.equal(mix.day.count, 10);
    assert.equal(mix.swing.count, 20);
    assert.equal(mix.bars.length, 2);
    assert.equal(mix.day.pctText, '+33.3%');
    assert.equal(mix.day.targetText, '+70.0%');

    // ---- agent table rows merged with live data ----
    const rows = helpers.agentTableRows(state, view);
    assert.equal(rows.length, 30);
    const liveRow = rows.find((row) => row.id === 'atm-10000000');
    assert.equal(liveRow.live, true);
    assert.equal(liveRow.liveEquityUsd, 21.5);
    assert.equal(liveRow.stance, 'trade');
    assert.equal(liveRow.stanceBadge.labelKey, 'stanceTrade');
    assert.deepEqual(liveRow.basket, ['AAPL', 'MSFT']);
    assert.equal(liveRow.basketText, 'AAPL, MSFT');
    assert.ok(liveRow.sparklinePath.length > 0);
    const downRow = rows.find((row) => row.id === 'atm-10000005');
    assert.equal(downRow.liveDayPnlPct, -2.5);
    assert.equal(downRow.liveDirection, 'down');
    assert.equal(downRow.stance, 'cautious');
    const stateOnlyRows = helpers.agentTableRows(state);
    assert.equal(stateOnlyRows.every((row) => row.live === false), true);
    assert.deepEqual(helpers.agentTableRows(null), []);

    // ---- live view mapping: live / closed / unavailable / empty ----
    const live = helpers.liveViewMapping(state, view);
    assert.equal(live.available, true);
    assert.equal(live.feedStatus, 'live');
    assert.equal(live.marketOpen, true);
    assert.equal(live.tape.length, 4);
    assert.equal(live.kpis.length, 8);
    assert.equal(live.equity.hasData, true);
    assert.equal(live.mix.total, 30);
    assert.equal(live.agents.length, 30);
    assert.equal(live.summary.running, true);
    const closedView = helpers.liveViewMapping(state, buildMarketViewPayload({ marketOpen: false }));
    assert.equal(closedView.feedStatus, 'closed');
    assert.equal(closedView.marketOpen, false);
    const fallbackView = helpers.liveViewMapping(state, null);
    assert.equal(fallbackView.available, false);
    assert.equal(fallbackView.feedStatus, 'unavailable');
    assert.equal(fallbackView.tape.length, 0);
    assert.equal(fallbackView.kpis.length, 8);
    assert.equal(fallbackView.equity.hasData, false);
    assert.equal(fallbackView.agents.length, 30);
    const emptyView = helpers.liveViewMapping(null, null);
    assert.equal(emptyView.hasState, false);
    assert.deepEqual(emptyView.agents, []);
    assert.deepEqual(emptyView.kpis, []);

    // ---- market session labels ----
    assert.equal(helpers.marketSession(view).labelKey, 'marketOpen');
    assert.equal(helpers.marketSession(buildMarketViewPayload({ marketOpen: false })).labelKey, 'marketClosed');
    const unknownSession = helpers.marketSession({});
    assert.equal(unknownSession.labelKey, 'marketUnknown');
    assert.equal(unknownSession.available, false);
  } finally {
    loaded.restore();
  }
});
