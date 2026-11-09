/**
 * test/mortality.test.js — the mortality engine's acceptance suite.
 *
 * Pure node:test, zero dependencies, no network. Uses fake brokers and an injected
 * clock so every death, runway and mutation is deterministic.
 *
 * Run from packages/automaton-trading:
 *   node --test test/mortality.test.js
 * (In a restricted sandbox where the test runner's child-process isolation is denied,
 *  use `node --test --experimental-test-isolation=none test/mortality.test.js` or
 *  `node test/mortality.test.js`; the assertions are identical.)
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AutomatonError, BRAKES, DEATH_CAUSES } from '../src/contracts.js';
import { loadConfig, statePaths } from '../src/config.js';
import { createClock, DAY_MS, HOUR_MS, mulberry32, round2, round4 } from '../src/util.js';
import { createJournal, OBITUARY_INVALID, validateObituary } from '../src/journal.js';
import { createLedger, TREASURY_ID } from '../src/ledger.js';
import { basketOf, createRegistry, MAX_BASKET_SYMBOLS, sanitizeBasket, sanitizeSpecIds } from '../src/registry.js';
import { createBrakes } from '../src/brakes.js';
import { burnPerHour, createTreasurer, effectiveDeathFloor } from '../src/treasurer.js';
import { createReplicator, MUTABLE, MUTABLE_FIELDS } from '../src/replicator.js';
import { createReaper } from '../src/reaper.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2026, 0, 5, 15, 0, 0); // Mon 10:00 America/New_York (inside 09:35-15:50)

/**
 * Deterministic instrument regimes for tests. The default v3.0 config shipped by the
 * Lead enables short/options/margin; tests pin both regimes so behaviour never depends
 * on which config layer happens to be merged in.
 */
const LEGACY_INSTRUMENTS = Object.freeze({
  enabled: true,
  allowMargin: false,
  maxMarginPctEquity: 1,
  maxMarginUsd: 0,
  allowShort: false,
  maxShortPctEquity: 1,
  maxShortNotionalUsd: 0,
  shortableOnly: true,
  allowOptions: false,
  allowCoveredCalls: false,
  allowSpreads: false,
  maxOptionPremiumPctEquity: 0.25,
  maxOptionPremiumUsd: 0,
  maxContracts: 3,
  minDTE: 2,
  maxDTE: 14,
  autoCloseDTE: 1,
  allowNakedShortOptions: false,
  optionDataFeed: 'indicative',
});

const V3_INSTRUMENTS = Object.freeze({
  enabled: true,
  allowMargin: true,
  maxMarginPctEquity: 1,
  maxMarginUsd: 0,
  allowShort: true,
  maxShortPctEquity: 1,
  maxShortNotionalUsd: 25,
  shortableOnly: true,
  allowOptions: true,
  allowCoveredCalls: true,
  allowSpreads: true,
  maxOptionPremiumPctEquity: 0.25,
  maxOptionPremiumUsd: 25,
  maxContracts: 3,
  minDTE: 2,
  maxDTE: 14,
  autoCloseDTE: 1,
  allowNakedShortOptions: false,
  optionDataFeed: 'indicative',
});

/** Bump a "YYYY-MM-DD" date by N days (test helper for option expiries). */
function datePlusDays(days) {
  return new Date(T0 + days * DAY_MS).toISOString().slice(0, 10);
}

/** Build an OCC option symbol for underlying/strike/type/expiry. */
function occSymbol(underlying, strikeUsd, type, expirationIso) {
  const compact = expirationIso.slice(2).replace(/-/g, '');
  const strike = String(Math.round(strikeUsd * 1000)).padStart(8, '0');
  return `${underlying}${compact}${type === 'put' ? 'P' : 'C'}${strike}`;
}

/** Full v3 instrument permissions (what the Treasurer derives when everything is on). */
function fullInstrumentPermissions(overrides = {}) {
  return {
    longStock: true,
    shortStock: true,
    longOptions: true,
    shortOptions: true,
    coveredCalls: true,
    spreads: true,
    margin: true,
    allowedStructures: [
      'long_call',
      'long_put',
      'covered_call',
      'call_credit_spread',
      'put_credit_spread',
      'bull_call_spread',
      'bear_put_spread',
    ],
    maxShortNotionalUsd: 1_000_000,
    maxOptionPremiumUsd: 1_000_000,
    maxContracts: 10,
    maxMarginUsd: 1_000_000,
    ...overrides,
  };
}

const createdDirs = [];

after(() => {
  for (const dir of createdDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
  }
});

/** Fresh temp state dir + validated config. Paper mode by default (brake wall active). */
function makeEnv(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-mortality-'));
  createdDirs.push(dir);
  const { config } = loadConfig({
    cwd: dir,
    env: {},
    configFile: path.join(dir, 'no-such-config.json'),
    overrides: {
      mode: 'paper',
      paths: { stateDir: path.join(dir, 'state'), envFile: path.join(dir, '.env') },
      // v2-safe default: the pre-v3 wall. Feature tests override with V3_INSTRUMENTS.
      instruments: LEGACY_INSTRUMENTS,
      ...overrides,
    },
  });
  return { dir, config, paths: statePaths(config) };
}

/** Deterministic, advanceable clock (no Date.now in domain logic under test). */
function makeClock(startMs = T0) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    iso: () => new Date(nowMs).toISOString(),
    advance: (ms) => {
      nowMs += ms;
    },
    set: (ms) => {
      nowMs = ms;
    },
  };
}

function makeObituary(overrides = {}) {
  return {
    agentId: 'atm-00000001',
    parentId: null,
    generation: 1,
    bornAt: new Date(T0 - 24 * HOUR_MS).toISOString(),
    diedAt: new Date(T0).toISOString(),
    lifespanHours: 24,
    endowmentUsd: 5000,
    finalEquityUsd: 200,
    revenueUsd: 0,
    spendUsd: 4800,
    netPlUsd: -4800,
    genome: {
      symbol: 'AAPL',
      family: 'momentum',
      lookback: 120,
      entryZ: 1.5,
      exitZ: 0.2,
      stopPct: 0.02,
      targetPct: 0.04,
      maxHoldBars: 8,
      sizePct: 0.15,
      sessionFilter: 'any',
    },
    mutation: null,
    productsShipped: 0,
    tradesCount: 2,
    firstProfitAt: null,
    strategySpecId: 'spec-1',
    cause: 'insufficient_funds',
    lastRunwayHours: 0,
    lessons: [],
    ...overrides,
  };
}

/**
 * Fake broker double. Async on purpose: production brokers are async, so the modules
 * are exercised through the same await paths. Records submits/cancels for assertions.
 */
function createFakeBroker(options = {}) {
  const state = {
    equityUsd: options.equityUsd ?? 100_000,
    cashUsd: options.cashUsd ?? options.equityUsd ?? 100_000,
    status: options.status ?? 'ACTIVE',
    positions: (options.positions ?? []).map((position) => ({ ...position })),
    openOrders: (options.openOrders ?? []).map((order) => ({ ...order })),
    marketOpen: options.marketOpen ?? true,
    submitted: [],
    canceled: [],
    accountReads: 0,
    failAccount: options.failAccount === true,
  };
  return {
    state,
    async getAccount() {
      state.accountReads += 1;
      if (state.failAccount) throw new AutomatonError('BROKER_ERROR', 'fake account outage');
      return {
        equityUsd: state.equityUsd,
        cashUsd: state.cashUsd,
        buyingPowerUsd: round2(state.cashUsd * 2),
        status: state.status,
        currency: 'USD',
        mode: 'paper',
      };
    },
    async getPositions() {
      return state.positions.map((position) => ({ ...position }));
    },
    async getClock() {
      return {
        isOpen: state.marketOpen,
        timestamp: new Date(T0).toISOString(),
        nextOpen: null,
        nextClose: null,
      };
    },
    async getOrders({ status = 'all' } = {}) {
      const terminal = new Set(['filled', 'canceled', 'cancelled', 'expired', 'rejected', 'done_for_day']);
      return state.openOrders
        .filter((order) =>
          status === 'all'
            ? true
            : status === 'open'
              ? !terminal.has(String(order.status))
              : order.status === status,
        )
        .map((order) => ({ ...order }));
    },
    async submitOrder(order) {
      state.submitted.push({ ...order });
      const position = state.positions.find((entry) => entry.symbol === order.symbol);
      let fillPrice = 0;
      if (position) {
        const heldQty = Number(position.qtySigned ?? position.qty) || 0;
        const multiplier = Number(position.multiplier) > 0
          ? Number(position.multiplier)
          : position.assetClass === 'us_option'
            ? 100
            : 1;
        const marketValue = Number(position.marketValueUsd);
        if (Number.isFinite(marketValue) && marketValue !== 0 && heldQty !== 0) {
          fillPrice = Math.abs(marketValue) / (Math.abs(heldQty) * multiplier);
        } else {
          fillPrice = Number(position.avgEntryPriceUsd ?? position.avgPriceUsd) || Number(order.priceUsd) || 0;
        }
        const delta = order.side === 'buy' ? Number(order.qty) : -Number(order.qty);
        const nextQty = round4(heldQty + delta);
        position.qtySigned = nextQty;
        position.qty = nextQty;
        position.marketValueUsd = round2(nextQty * fillPrice * multiplier);
        if (nextQty === 0) state.positions = state.positions.filter((entry) => entry !== position);
      }
      return {
        id: `ord-${state.submitted.length}`,
        clientOrderId: order.clientOrderId ?? null,
        symbol: order.symbol,
        side: order.side,
        qty: order.qty,
        filledQty: order.qty,
        avgFillPriceUsd: round4(fillPrice),
        status: 'filled',
        submittedAt: new Date(T0).toISOString(),
      };
    },
    async cancelOrder(id) {
      state.canceled.push(id);
      const order = state.openOrders.find((entry) => entry.id === id);
      if (order) order.status = 'canceled';
      return { id, status: 'canceled' };
    },
  };
}

/** Register + (optionally) genesis-fund agents in a fresh registry/ledger pair. */
function seedPopulation({ env, clock, agents }) {
  const registry = createRegistry({ paths: env.paths, config: env.config, clock });
  const ledger = createLedger({ paths: env.paths, config: env.config, clock });
  for (const spec of agents) {
    registry.register({
      id: spec.id,
      parentId: spec.parentId ?? null,
      generation: spec.generation ?? 1,
      bornAt: spec.bornAt ?? new Date(T0 - 24 * HOUR_MS).toISOString(),
      status: 'alive',
      endowmentUsd: spec.endowmentUsd ?? env.config.endowmentUsd,
      genome: spec.genome ?? { symbol: 'AAPL', family: 'momentum', lookback: 120 },
      mutation: null,
      specId: null,
      notes: [],
    });
    ledger.ensureAgent(spec.id, {
      endowmentUsd: spec.endowmentUsd ?? env.config.endowmentUsd,
      at: clock.iso(),
    });
    if (spec.grant !== false) {
      ledger.grant(spec.id, spec.endowmentUsd ?? env.config.endowmentUsd, {
        reason: 'genesis-endowment',
        at: clock.iso(),
      });
    }
  }
  return { registry, ledger };
}

// ---------------------------------------------------------------------------
// journal.js
// ---------------------------------------------------------------------------

describe('journal.js — obituaries and the lessons digest', () => {
  it('appends a validated obituary as JSONL and reads it back', () => {
    const env = makeEnv();
    const journal = createJournal({ paths: env.paths, config: env.config });
    assert.equal(journal.count(), 0);
    assert.equal(journal.append(makeObituary()), undefined);
    assert.equal(journal.count(), 1);
    const lines = fs.readFileSync(env.paths.journal, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const listed = journal.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].agentId, 'atm-00000001');
    assert.equal(journal.has('atm-00000001'), true);
    assert.equal(journal.has('atm-nope'), false);
  });

  it('rejects malformed obituaries with a stable code', () => {
    const env = makeEnv();
    const journal = createJournal({ paths: env.paths, config: env.config });
    const schemaBroken = () => {
      const bad = makeObituary();
      delete bad.productsShipped;
      journal.append(bad);
    };
    assert.throws(schemaBroken, (error) => error instanceof AutomatonError && error.code === OBITUARY_INVALID);
    assert.throws(
      () => journal.append(makeObituary({ cause: 'boredom' })),
      (error) => error.code === OBITUARY_INVALID,
    );
    assert.throws(
      () => journal.append(makeObituary({ lessons: 'not-an-array' })),
      (error) => error.code === OBITUARY_INVALID,
    );
    assert.throws(
      () => journal.append(makeObituary({ lifespanHours: -1 })),
      (error) => error.code === OBITUARY_INVALID,
    );
    assert.throws(
      () => validateObituary({ agentId: 'x' }),
      (error) => error.code === OBITUARY_INVALID,
    );
    const sample = makeObituary();
    assert.equal(validateObituary(sample), sample);
    assert.equal(journal.count(), 0);
  });

  it('lists newest first with limit/offset paging', () => {
    const env = makeEnv();
    const journal = createJournal({ paths: env.paths, config: env.config });
    journal.append(makeObituary({ agentId: 'old', diedAt: new Date(T0 - 2 * HOUR_MS).toISOString() }));
    journal.append(makeObituary({ agentId: 'new', diedAt: new Date(T0).toISOString() }));
    assert.deepEqual(journal.list().map((row) => row.agentId), ['new', 'old']);
    assert.deepEqual(journal.list({ limit: 1 }).map((row) => row.agentId), ['new']);
    assert.deepEqual(journal.list({ limit: 1, offset: 1 }).map((row) => row.agentId), ['old']);
  });

  it('aggregates causes and population statistics', () => {
    const env = makeEnv();
    const clock = makeClock();
    const registry = createRegistry({ paths: env.paths, config: env.config, clock });
    registry.register({ id: 'atm-alive', generation: 1, endowmentUsd: 5000, genome: {} });
    registry.save();
    const journal = createJournal({ paths: env.paths, config: env.config });
    journal.append(
      makeObituary({
        agentId: 'a',
        generation: 1,
        lifespanHours: 10,
        firstProfitAt: new Date(T0 - 5 * HOUR_MS).toISOString(),
        cause: 'insufficient_funds',
        lessons: ['Never average down'],
      }),
    );
    journal.append(
      makeObituary({
        agentId: 'b',
        generation: 3,
        lifespanHours: 30,
        revenueUsd: 120,
        cause: 'drawdown_limit',
        lessons: ['Never average down', 'Cut losers sooner'],
      }),
    );
    const stats = journal.stats();
    assert.equal(stats.total, 2);
    assert.equal(stats.alive, 1);
    assert.equal(stats.medianLifespanHours, 20);
    assert.equal(stats.meanLifespanHours, 20);
    assert.equal(stats.firstProfitRate, 0.5);
    assert.equal(stats.revenuePositiveRate, 0.5);
    assert.equal(stats.medianGeneration, 2);
    assert.equal(stats.mostCommonCause, 'drawdown_limit'); // tie broken deterministically
    assert.equal(stats.mostCommonLine, 'Never average down');
    assert.deepEqual(journal.causes(), { insufficient_funds: 1, drawdown_limit: 1 });
  });

  it('derives lessons for similar genomes, best match first and limit-bounded', () => {
    const env = makeEnv();
    const journal = createJournal({ paths: env.paths, config: env.config });
    journal.append(
      makeObituary({
        agentId: 'momentum-aapl',
        genome: { symbol: 'AAPL', family: 'momentum', lookback: 120 },
        cause: 'drawdown_limit',
        netPlUsd: -1200,
        lessons: ['Momentum dies in chop'],
      }),
    );
    journal.append(
      makeObituary({
        agentId: 'meanrev-tsla',
        genome: { symbol: 'TSLA', family: 'meanrev', lookback: 20 },
        cause: 'insufficient_funds',
        netPlUsd: -300,
      }),
    );
    const lessons = journal.lessonsFor({ symbol: 'AAPL', family: 'momentum', lookback: 120 }, { limit: 5 });
    assert.ok(Array.isArray(lessons));
    assert.ok(lessons.length > 0 && lessons.length <= 5);
    assert.ok(lessons.every((line) => typeof line === 'string' && line.length > 0));
    assert.match(lessons[0], /AAPL momentum/);
    assert.ok(lessons.includes('Momentum dies in chop'));
    assert.equal(journal.lessonsFor({}, { limit: 1 }).length, 1);
    const other = makeEnv();
    const freshJournal = createJournal({ paths: other.paths, config: other.config });
    assert.deepEqual(freshJournal.lessonsFor({}), []);
  });
});

// ---------------------------------------------------------------------------
// ledger.js
// ---------------------------------------------------------------------------

describe('ledger.js — virtual USD book', () => {
  it('ensureAgent declares an endowment without adding cash; grant is the funding path', () => {
    const env = makeEnv();
    const clock = makeClock();
    const ledger = createLedger({ paths: env.paths, config: env.config, clock });
    const agent = ledger.ensureAgent('atm-1', { endowmentUsd: 5000, at: clock.iso() });
    assert.equal(agent.cashUsd, 0);
    assert.equal(agent.declaredEndowmentUsd, 5000);
    assert.equal(ledger.equity('atm-1', {}).equityUsd, 0);
    ledger.grant('atm-1', 5000, { reason: 'genesis', at: clock.iso() });
    assert.equal(ledger.snapshot('atm-1').cashUsd, 5000);
    assert.throws(
      () => ledger.get('atm-unknown'),
      (error) => error.code === 'UNKNOWN_AGENT',
    );
  });

  it('books fills, realizes P&L, and preserves cash + positionsValue = equity', () => {
    const env = makeEnv();
    const clock = makeClock();
    const ledger = createLedger({ paths: env.paths, config: env.config, clock });
    ledger.ensureAgent('atm-1', { endowmentUsd: 5000, at: clock.iso() });
    ledger.grant('atm-1', 5000, { reason: 'genesis', at: clock.iso() });

    const buy = ledger.applyFill('atm-1', {
      symbol: 'AAPL',
      side: 'buy',
      qty: 10,
      priceUsd: 100,
      at: clock.iso(),
      orderId: 'o1',
    });
    assert.equal(buy.realizedPlUsd, 0);
    assert.equal(buy.position.qty, 10);
    assert.equal(buy.position.avgPriceUsd, 100);
    assert.equal(ledger.snapshot('atm-1').cashUsd, 4000);

    const marked = ledger.equity('atm-1', { AAPL: 110 });
    assert.equal(marked.positionsValueUsd, 1100);
    assert.equal(marked.unrealizedPlUsd, 100);
    assert.equal(marked.equityUsd, 5100);
    assert.equal(round2(marked.cashUsd + marked.positionsValueUsd), marked.equityUsd);

    const sell = ledger.applyFill('atm-1', {
      symbol: 'AAPL',
      side: 'sell',
      qty: 4,
      priceUsd: 120,
      at: clock.iso(),
      orderId: 'o2',
    });
    assert.equal(sell.realizedPlUsd, 80);
    assert.equal(sell.position.qty, 6);
    assert.equal(ledger.snapshot('atm-1').cashUsd, 4480);
    assert.equal(ledger.snapshot('atm-1').realizedPlUsd, 80);
    const after = ledger.equity('atm-1', { AAPL: 120 });
    assert.equal(after.equityUsd, 5200);
    assert.equal(round2(after.cashUsd + after.positionsValueUsd), after.equityUsd);
  });

  it('refuses borrowing when margin is disabled (no negative cash by default)', () => {
    const env = makeEnv();
    const clock = makeClock();
    const ledger = createLedger({ paths: env.paths, config: env.config, clock });
    ledger.ensureAgent('atm-1', { endowmentUsd: 1000, at: clock.iso() });
    ledger.grant('atm-1', 1000, { reason: 'genesis', at: clock.iso() });
    assert.throws(
      () => ledger.applyFill('atm-1', { symbol: 'AAPL', side: 'buy', qty: 100, priceUsd: 100, at: clock.iso() }),
      (error) => error.code === 'MARGIN_LIMIT',
    );
    assert.equal(ledger.snapshot('atm-1').cashUsd, 1000);
    assert.equal(ledger.snapshot('atm-1').positionsValueUsd, 0);
    assert.equal(ledger.snapshot('atm-1').marginDebtUsd, 0);
  });

  it('attributes costs by role and refuses costs it cannot pay', () => {
    const env = makeEnv();
    const clock = makeClock();
    const ledger = createLedger({ paths: env.paths, config: env.config, clock });
    ledger.ensureAgent('atm-1', { endowmentUsd: 10, at: clock.iso() });
    ledger.grant('atm-1', 10, { reason: 'genesis', at: clock.iso() });
    const charge = ledger.charge('atm-1', 0.4, { category: 'inference', role: 'prospector', at: clock.iso() });
    assert.equal(charge.balanceUsd, 9.6);
    ledger.charge('atm-1', 0.25, { category: 'inference', role: 'builder', at: clock.iso() });
    assert.deepEqual(ledger.roleCosts('atm-1'), { prospector: 0.4, builder: 0.25 });
    assert.equal(ledger.snapshot('atm-1').costsUsd, 0.65);
    assert.throws(
      () => ledger.charge('atm-1', 100, { category: 'inference', role: 'executor' }),
      (error) => error.code === 'INSUFFICIENT_CASH',
    );
  });

  it('transfers between accounts, sweeps to __treasury__, and reports the pool', () => {
    const env = makeEnv();
    const clock = makeClock();
    const ledger = createLedger({ paths: env.paths, config: env.config, clock });
    ledger.ensureAgent('atm-1', { endowmentUsd: 5000, at: clock.iso() });
    ledger.grant('atm-1', 5000, { reason: 'genesis', at: clock.iso() });
    ledger.ensureAgent('atm-2', { endowmentUsd: 0, at: clock.iso() });

    ledger.transfer('atm-1', 'atm-2', 2500, { reason: 'child-endowment', at: clock.iso() });
    assert.equal(ledger.snapshot('atm-1').cashUsd, 2500);
    assert.equal(ledger.snapshot('atm-2').cashUsd, 2500);

    ledger.transfer('atm-1', TREASURY_ID, 500, { reason: 'death_sweep', at: clock.iso() });
    const pool = ledger.pool();
    assert.equal(pool.poolUsd, 500);
    assert.equal(pool.allocatedUsd, 4500);
    assert.equal(pool.totalUsd, 5000);
    assert.equal(ledger.has(TREASURY_ID), true);

    assert.throws(
      () => ledger.transfer('atm-2', 'atm-1', 99999, { reason: 'too much', at: clock.iso() }),
      (error) => error.code === 'INSUFFICIENT_CASH',
    );
    // grant/transfer auto-create records so init order does not matter
    ledger.grant('atm-ghost', 7, { reason: 'issuance', at: clock.iso() });
    assert.equal(ledger.snapshot('atm-ghost').cashUsd, 7);
  });

  it('computes net7d over a trailing window and records firstProfitAt', () => {
    const env = makeEnv();
    const clock = makeClock();
    const ledger = createLedger({ paths: env.paths, config: env.config, clock });
    ledger.ensureAgent('atm-1', { endowmentUsd: 5000, at: clock.iso() });
    ledger.grant('atm-1', 5000, { reason: 'genesis', at: clock.iso() });
    ledger.charge('atm-1', 10, { category: 'inference', role: 'executor', at: clock.iso() });
    clock.advance(8 * DAY_MS);
    ledger.charge('atm-1', 5, { category: 'inference', role: 'executor', at: clock.iso() });
    assert.equal(ledger.snapshot('atm-1').net7dUsd, -5); // the 8-day-old cost rolled out

    const env2 = makeEnv();
    const clock2 = makeClock();
    const ledger2 = createLedger({ paths: env2.paths, config: env2.config, clock: clock2 });
    ledger2.ensureAgent('atm-2', { endowmentUsd: 5000, at: clock2.iso() });
    ledger2.grant('atm-2', 5000, { reason: 'genesis', at: clock2.iso() });
    ledger2.applyFill('atm-2', { symbol: 'AAPL', side: 'buy', qty: 10, priceUsd: 100, at: clock2.iso() });
    ledger2.equity('atm-2', { AAPL: 130 });
    assert.equal(typeof ledger2.snapshot('atm-2').firstProfitAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(ledger2.snapshot('atm-2').firstProfitAt)));
  });

  it('persists atomically and anchors to broker equity once', () => {
    const env = makeEnv();
    const clock = makeClock();
    const ledger = createLedger({ paths: env.paths, config: env.config, clock });
    ledger.ensureAgent('atm-1', { endowmentUsd: 5000, at: clock.iso() });
    ledger.grant('atm-1', 5000, { reason: 'genesis', at: clock.iso() });
    ledger.ensureAgent('atm-2', { endowmentUsd: 5000, at: clock.iso() });
    ledger.grant('atm-2', 5000, { reason: 'genesis', at: clock.iso() });
    assert.equal(ledger.isAnchored(), false);
    const anchor = ledger.anchorToBrokerEquity(100_000);
    assert.equal(anchor.anchored, true);
    assert.equal(ledger.pool().poolUsd, 90_000);
    assert.equal(ledger.anchorToBrokerEquity(100_000).anchored, false); // one-time
    ledger.save();

    const reloaded = createLedger({ paths: env.paths, config: env.config, clock });
    reloaded.load();
    assert.equal(reloaded.snapshot('atm-1').cashUsd, 5000);
    assert.equal(reloaded.pool().poolUsd, 90_000);
    assert.equal(reloaded.isAnchored(), true);
  });
});

// ---------------------------------------------------------------------------
// registry.js
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ledger.js v3 — shorts, options, spreads, margin
// ---------------------------------------------------------------------------

function makeV3Ledger({ cashUsd = 50, instruments = {} } = {}) {
  const env = makeEnv({ instruments: { ...V3_INSTRUMENTS, ...instruments } });
  const clock = makeClock();
  const ledger = createLedger({ paths: env.paths, config: env.config, clock });
  ledger.ensureAgent('atm-v3', { endowmentUsd: cashUsd, at: clock.iso() });
  ledger.grant('atm-v3', cashUsd, { reason: 'genesis', at: clock.iso() });
  return { env, clock, ledger };
}

describe('ledger.js — v3 multi-instrument book', () => {
  it('opens and covers a short stock: signed qty, cash, realized P&L', () => {
    const { clock, ledger } = makeV3Ledger();
    const short = ledger.applyFill('atm-v3', {
      symbol: 'AAPL',
      side: 'sell',
      qty: 2,
      priceUsd: 10,
      at: clock.iso(),
    });
    assert.equal(short.realizedPlUsd, 0);
    assert.equal(short.position.qty, -2);
    assert.equal(short.position.side, 'SHORT');
    assert.equal(ledger.snapshot('atm-v3').cashUsd, 70); // 50 + 20 proceeds
    const marked = ledger.equity('atm-v3', { AAPL: 10 });
    assert.equal(marked.equityUsd, 50);
    assert.equal(marked.netExposureUsd, -20);
    assert.equal(marked.grossExposureUsd, 20);

    const cover = ledger.applyFill('atm-v3', {
      symbol: 'AAPL',
      side: 'buy',
      qty: 2,
      priceUsd: 8,
      at: clock.iso(),
    });
    assert.equal(cover.realizedPlUsd, 4); // short 10, covered 8
    assert.equal(cover.position, null);
    assert.equal(ledger.snapshot('atm-v3').cashUsd, 54);
    assert.equal(ledger.snapshot('atm-v3').realizedPlUsd, 4);
    assert.equal(ledger.equity('atm-v3', { AAPL: 8 }).equityUsd, 54);

    // fractional shorts are not allowed (whole shares required)
    assert.throws(
      () => ledger.applyFill('atm-v3', { symbol: 'AAPL', side: 'sell', qty: 1.5, priceUsd: 10, at: clock.iso() }),
      (error) => error.code === 'CONFIG_INVALID',
    );
  });

  it('trades options with the 100x multiplier: debit, credit and realized P&L', () => {
    const { clock, ledger } = makeV3Ledger();
    const contract = occSymbol('AAPL', 150, 'call', datePlusDays(11));
    const buy = ledger.applyFill('atm-v3', {
      symbol: contract,
      assetClass: 'us_option',
      side: 'buy',
      qty: 1,
      priceUsd: 0.4,
      at: clock.iso(),
    });
    assert.equal(buy.realizedPlUsd, 0);
    assert.equal(buy.position.qty, 1);
    assert.equal(buy.position.assetClass, 'us_option');
    assert.equal(buy.position.multiplier, 100);
    assert.equal(buy.position.option.underlying, 'AAPL');
    assert.equal(buy.position.option.type, 'call');
    assert.equal(buy.position.option.strikeUsd, 150);
    assert.equal(buy.position.side, 'CALL');
    assert.equal(ledger.snapshot('atm-v3').cashUsd, 10); // 50 - 1*0.4*100

    const marked = ledger.equity('atm-v3', { [contract]: 0.9 });
    assert.equal(marked.positionsValueUsd, 90);
    assert.equal(marked.equityUsd, 100);
    assert.equal(marked.unrealizedPlUsd, 50);

    const sell = ledger.applyFill('atm-v3', {
      symbol: contract,
      assetClass: 'us_option',
      side: 'sell',
      qty: 1,
      priceUsd: 0.9,
      at: clock.iso(),
    });
    assert.equal(sell.realizedPlUsd, 50); // (0.9 - 0.4) * 1 * 100
    assert.equal(ledger.snapshot('atm-v3').cashUsd, 100);
    assert.equal(ledger.snapshot('atm-v3').realizedPlUsd, 50);
    assert.equal(ledger.snapshot('atm-v3').positionsValueUsd, 0);

    // whole contracts only
    assert.throws(
      () => ledger.applyFill('atm-v3', { symbol: contract, assetClass: 'us_option', side: 'buy', qty: 1.5, priceUsd: 0.4, at: clock.iso() }),
      (error) => error.code === 'CONFIG_INVALID',
    );
  });

  it('links spread legs by groupId and reports per-group P&L', () => {
    const { clock, ledger } = makeV3Ledger();
    const longLeg = occSymbol('AAPL', 150, 'call', datePlusDays(11));
    const shortLeg = occSymbol('AAPL', 155, 'call', datePlusDays(11));
    ledger.applyFill('atm-v3', {
      symbol: longLeg,
      assetClass: 'us_option',
      side: 'buy',
      qty: 1,
      priceUsd: 0.5,
      groupId: 'spread-1',
      structure: 'bull_call_spread',
      at: clock.iso(),
    });
    ledger.applyFill('atm-v3', {
      symbol: shortLeg,
      assetClass: 'us_option',
      side: 'sell',
      qty: 1,
      priceUsd: 0.2,
      groupId: 'spread-1',
      structure: 'bull_call_spread',
      at: clock.iso(),
    });
    assert.equal(ledger.snapshot('atm-v3').cashUsd, 20); // 50 - 50 + 20
    let groups = ledger.groups('atm-v3');
    assert.equal(groups.length, 1);
    assert.equal(groups[0].groupId, 'spread-1');
    assert.equal(groups[0].structure, 'bull_call_spread');
    assert.deepEqual([...groups[0].legs].sort(), [longLeg, shortLeg].sort());
    assert.equal(groups[0].openContracts, 2);

    // close both legs: +0.2 on the long, +0.1 on the short → +30 realized
    ledger.applyFill('atm-v3', {
      symbol: longLeg,
      assetClass: 'us_option',
      side: 'sell',
      qty: 1,
      priceUsd: 0.7,
      groupId: 'spread-1',
      at: clock.iso(),
    });
    ledger.applyFill('atm-v3', {
      symbol: shortLeg,
      assetClass: 'us_option',
      side: 'buy',
      qty: 1,
      priceUsd: 0.1,
      groupId: 'spread-1',
      at: clock.iso(),
    });
    groups = ledger.groups('atm-v3');
    assert.equal(groups[0].realizedPlUsd, 30);
    assert.equal(groups[0].openContracts, 0);
    const snapshot = ledger.snapshot('atm-v3');
    assert.equal(snapshot.realizedPlUsd, 30);
    assert.equal(snapshot.cashUsd, 80);
    assert.equal(snapshot.groups[0].realizedPlUsd, 30);
  });

  it('allows margin within the cap and refuses debt beyond it (MARGIN_LIMIT)', () => {
    const { clock, ledger } = makeV3Ledger({ cashUsd: 50 });
    ledger.applyFill('atm-v3', { symbol: 'AAPL', side: 'buy', qty: 6, priceUsd: 10, at: clock.iso() });
    const after = ledger.snapshot('atm-v3');
    assert.equal(after.cashUsd, -10);
    assert.equal(after.marginDebtUsd, 10);
    assert.equal(after.positionsValueUsd, 60);
    assert.equal(ledger.equity('atm-v3', { AAPL: 10 }).equityUsd, 50);
    assert.throws(
      () => ledger.applyFill('atm-v3', { symbol: 'AAPL', side: 'buy', qty: 40, priceUsd: 10, at: clock.iso() }),
      (error) => error.code === 'MARGIN_LIMIT',
    );

    // margin disabled: even a small borrowing is refused
    const legacy = makeEnv();
    const legacyClock = makeClock();
    const legacyLedger = createLedger({ paths: legacy.paths, config: legacy.config, clock: legacyClock });
    legacyLedger.ensureAgent('atm-legacy', { endowmentUsd: 50, at: legacyClock.iso() });
    legacyLedger.grant('atm-legacy', 50, { reason: 'genesis', at: legacyClock.iso() });
    assert.throws(
      () => legacyLedger.applyFill('atm-legacy', { symbol: 'AAPL', side: 'buy', qty: 6, priceUsd: 10, at: legacyClock.iso() }),
      (error) => error.code === 'MARGIN_LIMIT',
    );
  });

  it('snapshot marks long/short/option positions with side, assetClass, DTE and exposure', () => {
    const { env, clock, ledger } = makeV3Ledger({ cashUsd: 500 });
    const contract = occSymbol('AAPL', 150, 'put', datePlusDays(7));
    ledger.applyFill('atm-v3', {
      symbol: 'MSFT',
      side: 'sell',
      qty: 2,
      priceUsd: 50,
      at: clock.iso(),
    }); // short 2 MSFT
    ledger.applyFill('atm-v3', {
      symbol: contract,
      assetClass: 'us_option',
      side: 'buy',
      qty: 1,
      priceUsd: 0.5,
      option: { underlying: 'AAPL', expiration: datePlusDays(7), type: 'put', strikeUsd: 150, dte: 7 },
      at: clock.iso(),
    });
    assert.ok(env.config.instruments.allowShort);
    const snapshot = ledger.snapshot('atm-v3');
    const stock = snapshot.positionsList.find((position) => position.symbol === 'MSFT');
    const option = snapshot.positionsList.find((position) => position.assetClass === 'us_option');
    assert.equal(stock.side, 'SHORT');
    assert.equal(stock.assetClass, 'us_equity');
    assert.equal(option.side, 'PUT');
    assert.equal(option.direction, 'LONG');
    assert.equal(option.multiplier, 100);
    assert.equal(option.option.strikeUsd, 150);
    assert.equal(option.option.dte, 7);
    assert.equal(snapshot.longShares.MSFT, 0);
    assert.equal(ledger.longSharesOf('atm-v3', 'MSFT'), 0);
    assert.ok(snapshot.grossExposureUsd > 0);
    assert.equal(snapshot.netExposureUsd, round2(-100 + 50)); // short MSFT 2*50, long put 1*0.5*100
    assert.equal(ledger.optionContractsOf('atm-v3', contract), 1);
  });

  it('credit() is a one-time capital top-up that is not trading P&L', () => {
    const { env, clock, ledger } = makeV3Ledger({ cashUsd: 20 });
    ledger.credit('atm-v3', 30, { category: 'capital', reason: 'v3-migration', at: clock.iso() });
    const snapshot = ledger.snapshot('atm-v3');
    assert.equal(snapshot.cashUsd, 50);
    assert.equal(snapshot.creditsUsd, 30);
    assert.equal(snapshot.realizedPlUsd, 0);
    assert.equal(snapshot.net7dUsd, 0);
    assert.ok(env.config.instruments.allowMargin);
    ledger.save();
  });
});

describe('registry.js — population and the one-way door', () => {
  it('registers agents, reports population, and serves defensive copies', () => {
    const env = makeEnv();
    const clock = makeClock();
    const registry = createRegistry({ paths: env.paths, config: env.config, clock });
    const agent = registry.register({
      id: 'atm-1',
      generation: 1,
      endowmentUsd: 5000,
      genome: { symbol: 'AAPL' },
    });
    assert.equal(agent.status, 'alive');
    assert.equal(agent.notes.length, 0);
    assert.equal(registry.population(), 1);
    assert.equal(registry.cap, env.config.population.cap);
    agent.status = 'dead';
    assert.equal(registry.get('atm-1').status, 'alive'); // defensive copy
    assert.equal(registry.alive().length, 1);
    assert.equal(registry.dead().length, 0);
    assert.equal(registry.get('missing'), null);
  });

  it('enforces the population cap on living agents only', () => {
    const env = makeEnv({ population: { initial: 0, cap: 2 } });
    const clock = makeClock();
    const registry = createRegistry({ paths: env.paths, config: env.config, clock });
    registry.register({ id: 'atm-1', generation: 1 });
    registry.register({ id: 'atm-2', generation: 1 });
    assert.throws(
      () => registry.register({ id: 'atm-3', generation: 1 }),
      (error) => error.code === 'POPULATION_CAP',
    );
    registry.markDead('atm-1', { cause: 'insufficient_funds', at: clock.iso(), finalEquityUsd: 0 });
    const third = registry.register({ id: 'atm-3', generation: 1 });
    assert.equal(third.status, 'alive');
    assert.equal(registry.population(), 2);
  });

  it('markDead is one-way: no revival exists and repeated death throws AGENT_DEAD', () => {
    const env = makeEnv();
    const clock = makeClock();
    const registry = createRegistry({ paths: env.paths, config: env.config, clock });
    registry.register({ id: 'atm-1', generation: 1 });
    const dead = registry.markDead('atm-1', {
      cause: 'drawdown_limit',
      at: clock.iso(),
      finalEquityUsd: 1200,
    });
    assert.equal(dead.status, 'dead');
    assert.equal(dead.cause, 'drawdown_limit');
    assert.equal(dead.diedAt, clock.iso());
    assert.equal(registry.markAlive, undefined);
    assert.throws(
      () => registry.markDead('atm-1', { cause: 'insufficient_funds', at: clock.iso(), finalEquityUsd: 0 }),
      (error) => error.code === 'AGENT_DEAD',
    );
    assert.throws(
      () => registry.update('atm-1', { notes: ['tamper'] }),
      (error) => error.code === 'AGENT_DEAD',
    );
    registry.register({ id: 'atm-2', generation: 1 });
    assert.throws(
      () => registry.update('atm-2', { status: 'dead' }),
      (error) => error.code === 'CONFIG_INVALID',
    );
    assert.equal(registry.get('atm-2').status, 'alive');
    assert.throws(
      () => registry.markDead('atm-1', { cause: 'boredom', at: clock.iso() }),
      (error) => error.code === 'AGENT_DEAD',
    );
  });

  it('computes generation statistics and unique ids', () => {
    const env = makeEnv();
    const clock = makeClock();
    const registry = createRegistry({ paths: env.paths, config: env.config, clock });
    registry.register({ id: 'atm-g0-a', generation: 0, bornAt: new Date(T0 - 10 * HOUR_MS).toISOString() });
    registry.register({ id: 'atm-g0-b', generation: 0, bornAt: new Date(T0 - 10 * HOUR_MS).toISOString() });
    registry.markDead('atm-g0-b', {
      cause: 'insufficient_funds',
      at: clock.iso(),
      finalEquityUsd: 0,
    });
    registry.register({ id: 'atm-g1-a', generation: 1 });
    const stats = registry.generationStats();
    assert.deepEqual(stats[0], {
      born: 2,
      alive: 1,
      dead: 1,
      survivalRate: 0.5,
      medianLifespanHours: 10,
    });
    assert.equal(stats[1].born, 1);
    assert.equal(stats[1].survivalRate, 1);
    const id = registry.nextId();
    assert.match(id, /^atm-[0-9a-f]{8}$/);
    assert.equal(registry.get(id), null);
  });

  it('persists and reloads the graveyard', () => {
    const env = makeEnv();
    const clock = makeClock();
    const registry = createRegistry({ paths: env.paths, config: env.config, clock });
    registry.register({ id: 'atm-1', generation: 1 });
    registry.register({ id: 'atm-2', generation: 1 });
    registry.markDead('atm-2', { cause: 'daily_loss_limit', at: clock.iso(), finalEquityUsd: 0 });
    registry.save();

    const reloaded = createRegistry({ paths: env.paths, config: env.config, clock });
    reloaded.load();
    assert.equal(reloaded.all().length, 2);
    assert.equal(reloaded.population(), 1);
    assert.equal(reloaded.get('atm-2').status, 'dead');
  });
});

// ---------------------------------------------------------------------------
// registry.js v3.2 — multi-symbol baskets + per-symbol spec maps
// ---------------------------------------------------------------------------

describe('registry.js — multi-symbol baskets and spec maps (v3.2)', () => {
  it('back-compat: derives symbols from genome.symbol/genome.symbols and specIds={} for legacy records', () => {
    const env = makeEnv();
    const clock = makeClock();
    const registry = createRegistry({ paths: env.paths, config: env.config, clock });
    registry.register({ id: 'atm-legacy', generation: 0, genome: { symbol: 'AAPL', family: 'momentum' } });
    const legacy = registry.get('atm-legacy');
    assert.deepEqual(legacy.symbols, ['AAPL']);
    assert.deepEqual(legacy.specIds, {});
    assert.equal(legacy.specId, null);
    assert.deepEqual(basketOf(legacy), ['AAPL'], 'basketOf helper mirrors the normalized field');

    // genome.symbols wins over genome.symbol and is sanitized
    registry.register({ id: 'atm-genome-basket', genome: { symbol: 'AAPL', symbols: ['msft', 'NVDA', 'msft'] } });
    assert.deepEqual(registry.get('atm-genome-basket').symbols, ['MSFT', 'NVDA']);

    // no genome at all → empty basket (never throws)
    registry.register({ id: 'atm-empty' });
    assert.deepEqual(registry.get('atm-empty').symbols, []);
    assert.deepEqual(registry.get('atm-empty').specIds, {});
    assert.deepEqual(basketOf({}), []);
  });

  it('sanitizes baskets: uppercase, unique, invalid dropped, order preserved, capped at 8', () => {
    assert.deepEqual(sanitizeBasket(['aapl', ' AAPL ', 'msft', 'msft', '', 42, null, 'bad!!', 'brk.b']), [
      'AAPL',
      'MSFT',
      'BRK.B',
    ]);
    assert.equal(MAX_BASKET_SYMBOLS, 8);
    assert.equal(sanitizeBasket(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']).length, 8);
    assert.deepEqual(sanitizeBasket('tsla'), ['TSLA']);
    assert.deepEqual(sanitizeBasket(undefined), []);
    assert.deepEqual(sanitizeBasket(null), []);
    assert.deepEqual(sanitizeBasket({ nope: true }), []);
    assert.deepEqual(sanitizeSpecIds({ aapl: 'spec-a', ' MSFT ': ' spec-m ', bad: '', 'bad!!': 'x', 42: 'spec-42' }), {
      AAPL: 'spec-a',
      MSFT: 'spec-m',
    });
    assert.deepEqual(sanitizeSpecIds(null), {});
    assert.deepEqual(sanitizeSpecIds(['AAPL']), {});
  });

  it('register/save/load round-trips symbols and specIds while legacy specId stays primary', () => {
    const env = makeEnv();
    const clock = makeClock();
    const registry = createRegistry({ paths: env.paths, config: env.config, clock });
    registry.register({
      id: 'atm-basket',
      generation: 1,
      name: 'Momentum AAPL',
      genome: { symbol: 'AAPL', family: 'momentum', symbols: ['AAPL', 'MSFT', 'NVDA'] },
      // deliberately messy basket + spec map: the registry sanitizes, never trusts
      symbols: ['aapl', 'MSFT', 'nvda', 'aapl', 'bad!!'],
      specId: 'spec-primary',
      specIds: { aapl: 'spec-a', 'MSFT': 'spec-m', bad: '', '!!': 'spec-bad' },
    });
    const agent = registry.get('atm-basket');
    assert.deepEqual(agent.symbols, ['AAPL', 'MSFT', 'NVDA']);
    assert.deepEqual(agent.specIds, { AAPL: 'spec-a', MSFT: 'spec-m' });
    assert.equal(agent.specId, 'spec-primary');
    assert.equal(agent.name, 'Momentum AAPL');

    registry.save();
    const reloaded = createRegistry({ paths: env.paths, config: env.config, clock });
    reloaded.load();
    const loaded = reloaded.get('atm-basket');
    assert.deepEqual(loaded.symbols, ['AAPL', 'MSFT', 'NVDA']);
    assert.deepEqual(loaded.specIds, { AAPL: 'spec-a', MSFT: 'spec-m' });
    assert.equal(loaded.specId, 'spec-primary');
    assert.equal(loaded.genome.symbol, 'AAPL');
  });

  it('loads an old registry file (no symbols/specIds fields) cleanly and derives the basket', () => {
    const env = makeEnv();
    const clock = makeClock();
    fs.mkdirSync(path.dirname(env.paths.registry), { recursive: true });
    fs.writeFileSync(
      env.paths.registry,
      JSON.stringify({
        version: 1,
        cap: 10,
        agents: {
          'atm-old': {
            id: 'atm-old',
            generation: 0,
            bornAt: new Date(T0).toISOString(),
            status: 'alive',
            endowmentUsd: 5000,
            genome: { symbol: 'SPY', family: 'momentum' },
            specId: 'spec-legacy',
            notes: [],
          },
        },
      }),
      'utf8',
    );
    const registry = createRegistry({ paths: env.paths, config: env.config, clock });
    registry.load();
    const old = registry.get('atm-old');
    assert.deepEqual(old.symbols, ['SPY']);
    assert.deepEqual(old.specIds, {});
    assert.equal(old.specId, 'spec-legacy');
  });

  it('update preserves symbols/specIds when omitted and accepts sanitized replacements', () => {
    const env = makeEnv();
    const clock = makeClock();
    const registry = createRegistry({ paths: env.paths, config: env.config, clock });
    registry.register({
      id: 'atm-updatable',
      generation: 1,
      genome: { symbol: 'AAPL', symbols: ['AAPL', 'MSFT'] },
      specIds: { AAPL: 'spec-a', MSFT: 'spec-m' },
    });
    const before = registry.get('atm-updatable');
    const untouched = registry.update('atm-updatable', { lastCycleAt: clock.iso() });
    assert.deepEqual(untouched.symbols, before.symbols);
    assert.deepEqual(untouched.specIds, before.specIds);
    assert.deepEqual(registry.update('atm-updatable', {}).symbols, before.symbols);

    const replaced = registry.update('atm-updatable', {
      symbols: ['tsla', 'TSLA', 'amd'],
      specIds: { TSLA: 'spec-t', amd: 'spec-d' },
    });
    assert.deepEqual(replaced.symbols, ['TSLA', 'AMD']);
    assert.deepEqual(replaced.specIds, { TSLA: 'spec-t', AMD: 'spec-d' });
    assert.equal(replaced.id, 'atm-updatable');
    assert.equal(replaced.status, 'alive');
    // a later patch without the fields keeps the replacements
    const later = registry.update('atm-updatable', { notes: ['reviewed'] });
    assert.deepEqual(later.symbols, ['TSLA', 'AMD']);
    assert.deepEqual(later.specIds, { TSLA: 'spec-t', AMD: 'spec-d' });
  });

  it('dead records keep their basket across death and reload, and stay immutable', () => {
    const env = makeEnv();
    const clock = makeClock();
    const registry = createRegistry({ paths: env.paths, config: env.config, clock });
    registry.register({
      id: 'atm-dead-basket',
      generation: 1,
      genome: { symbol: 'AAPL', symbols: ['AAPL', 'NVDA', 'SPY'] },
      specIds: { AAPL: 'spec-a', NVDA: 'spec-n', SPY: 'spec-s' },
    });
    registry.markDead('atm-dead-basket', { cause: 'drawdown_limit', at: clock.iso(), finalEquityUsd: 1200 });
    const dead = registry.get('atm-dead-basket');
    assert.deepEqual(dead.symbols, ['AAPL', 'NVDA', 'SPY']);
    assert.deepEqual(dead.specIds, { AAPL: 'spec-a', NVDA: 'spec-n', SPY: 'spec-s' });
    assert.throws(
      () => registry.update('atm-dead-basket', { symbols: ['TSLA'] }),
      (error) => error.code === 'AGENT_DEAD',
    );
    registry.save();
    const reloaded = createRegistry({ paths: env.paths, config: env.config, clock });
    reloaded.load();
    const reloadedDead = reloaded.get('atm-dead-basket');
    assert.deepEqual(reloadedDead.symbols, ['AAPL', 'NVDA', 'SPY']);
    assert.deepEqual(reloadedDead.specIds, { AAPL: 'spec-a', NVDA: 'spec-n', SPY: 'spec-s' });
  });
});

// ---------------------------------------------------------------------------
// brakes.js
// ---------------------------------------------------------------------------

function makeBrakeHarness(overrides = {}) {
  const env = makeEnv(overrides);
  const clock = makeClock();
  const brakes = createBrakes({ config: env.config, paths: env.paths, clock });
  const base = () => ({
    mode: env.config.mode,
    now: clock.now(),
    agentId: 'atm-1',
    dayStats: { dayKey: '2026-01-05', ordersCount: 0, startEquityUsd: 5000, pnlUsd: 0 },
    quote: { symbol: 'AAPL', bid: 100, ask: 100.1, ts: clock.now() },
    order: { symbol: 'AAPL', side: 'buy', qty: 1, priceUsd: 100.05, notionalUsd: 100.05 },
    equityUsd: 5000,
    positions: [],
    mandate: {
      agentId: 'atm-1',
      issuedAt: clock.iso(),
      expiresAt: new Date(clock.now() + 10 * 60 * 1000).toISOString(),
      state: 'STABLE',
      sizeBudgetUsd: 1250,
      maxOrderNotionalUsd: 1250,
      maxDailyOrdersRemaining: 6,
      allowedSymbols: ['AAPL', 'MSFT', 'NVDA', 'SPY', 'QQQ'],
      allowExitOnly: false,
    },
    spec: {
      specId: 'spec-1',
      proofRef: 'https://data.alpaca.markets/v2/stocks/bars?symbols=AAPL',
      proof: { observedAt: new Date(clock.now() - HOUR_MS).toISOString() },
    },
    accountEquityUsd: 100_000,
    allocatedEquityUsd: 10_000,
    spreadBps: 5,
  });
  const check = (mutate) => {
    const input = base();
    if (typeof mutate === 'function') mutate(input);
    return brakes.checkOrder(input);
  };
  return { env, clock, brakes, base, check };
}

/**
 * Brake harness with the v3 instrument regime fully enabled and a mandate that grants
 * every instrument. Individual tests revoke permissions/config flags to probe denials.
 */
function makeV3BrakeHarness(overrides = {}) {
  const env = makeEnv({ instruments: { ...V3_INSTRUMENTS, ...(overrides.instruments ?? {}) } });
  const clock = makeClock();
  const brakes = createBrakes({ config: env.config, paths: env.paths, clock });
  const base = () => ({
    mode: env.config.mode,
    now: clock.now(),
    agentId: 'atm-1',
    dayStats: { dayKey: '2026-01-05', ordersCount: 0, startEquityUsd: 5000, pnlUsd: 0 },
    quote: { symbol: 'AAPL', bid: 100, ask: 100.1, ts: clock.now() },
    order: { symbol: 'AAPL', side: 'buy', qty: 1, priceUsd: 100.05, notionalUsd: 100.05 },
    equityUsd: 5000,
    positions: overrides.positions ?? [],
    mandate: {
      agentId: 'atm-1',
      issuedAt: clock.iso(),
      expiresAt: new Date(clock.now() + 10 * 60 * 1000).toISOString(),
      state: 'STABLE',
      sizeBudgetUsd: 1250,
      maxOrderNotionalUsd: 1250,
      maxDailyOrdersRemaining: 12,
      allowedSymbols: ['AAPL', 'MSFT', 'NVDA', 'SPY', 'QQQ'],
      allowExitOnly: false,
      instruments: fullInstrumentPermissions(overrides.mandateInstruments ?? {}),
    },
    spec: {
      specId: 'spec-1',
      proofRef: 'https://data.alpaca.markets/v2/stocks/bars?symbols=AAPL',
      proof: { observedAt: new Date(clock.now() - HOUR_MS).toISOString() },
    },
    accountEquityUsd: 100_000,
    allocatedEquityUsd: 10_000,
    spreadBps: 5,
    marginDebtUsd: 0,
  });
  const check = (mutate, extra = {}) => {
    const input = { ...base(), ...extra };
    if (typeof mutate === 'function') mutate(input);
    return brakes.checkOrder(input);
  };
  return { env, clock, brakes, base, check };
}

describe('brakes.js — the hard order wall (D1-D18)', () => {
  it('describes the full D1-D18 catalogue and allows a clean mandate order', () => {
    const { brakes, check } = makeBrakeHarness();
    const catalogue = brakes.describe();
    assert.equal(catalogue.length, 18);
    const ids = catalogue.map((row) => row.id);
    assert.deepEqual(ids, ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12', 'D13', 'D14', 'D15', 'D16', 'D17', 'D18']);
    assert.deepEqual(ids, BRAKES.map((brake) => brake.id));
    assert.equal(new Set(ids).size, 18);
    for (const rule of catalogue) {
      assert.ok(typeof rule.code === 'string' && rule.code.length > 0);
      assert.ok(typeof rule.enforcement === 'string' && rule.enforcement.length > 0);
    }
    assert.equal(brakes.isLiveArmed(), false);
    assert.equal(brakes.isKillSwitchActive(), false);
    const decision = check();
    assert.equal(decision.decision, 'ALLOW', JSON.stringify(decision));
    assert.equal(decision.code, null);
  });

  it('D1 denies non-trade sides (transfers/withdrawals never reach the broker)', () => {
    const { check } = makeBrakeHarness();
    const decision = check((input) => {
      input.order.side = 'transfer';
    });
    assert.equal(decision.decision, 'DENY');
    assert.equal(decision.code, 'TRANSFER_FORBIDDEN');
  });

  it('D2 is the instrument-permission gate (unknown asset class / revoked long stock)', () => {
    const { check } = makeBrakeHarness();
    assert.equal(check((input) => { input.order.assetClass = 'us_future'; }).code, 'INSTRUMENT_FORBIDDEN');
    const revoked = check((input) => {
      input.mandate.instruments = fullInstrumentPermissions({
        longStock: false,
        shortStock: false,
        longOptions: false,
        shortOptions: false,
        coveredCalls: false,
        spreads: false,
        margin: false,
      });
    });
    assert.equal(revoked.decision, 'DENY');
    assert.equal(revoked.code, 'INSTRUMENT_FORBIDDEN');
    assert.equal(revoked.brakeId, 'D2');
  });

  it('D3 denies a closed market, outside-window clocks and extended hours', () => {
    const { check, clock } = makeBrakeHarness();
    assert.equal(check((input) => { input.marketOpen = false; }).code, 'MARKET_CLOSED');
    assert.equal(check((input) => { input.now = Date.UTC(2026, 0, 5, 3, 0, 0); }).code, 'MARKET_CLOSED');
    assert.equal(check((input) => { input.order.extendedHours = true; }).code, 'MARKET_CLOSED');
    clock.advance(0); // clock is deterministic; nothing depends on wall time
  });

  it('D4 denies off-whitelist symbols, cheap prices, wide spreads and dust notional', () => {
    const { check } = makeBrakeHarness();
    assert.equal(check((input) => {
      input.order.symbol = 'ZZZZ';
      input.quote = { bid: 100, ask: 100.1 };
    }).code, 'INSTRUMENT_FORBIDDEN');
    assert.equal(check((input) => {
      input.order.priceUsd = 2;
      input.order.notionalUsd = 2;
      input.quote = { bid: 2, ask: 2.01 };
    }).code, 'INSTRUMENT_FORBIDDEN');
    assert.equal(check((input) => { input.spreadBps = 50; }).code, 'INSTRUMENT_FORBIDDEN');
    assert.equal(check((input) => {
      input.order.qty = 0.001;
      input.order.notionalUsd = 0.1;
    }).code, 'INSTRUMENT_FORBIDDEN');
  });

  it('D9 denies a spec without dated proof and stale proof', () => {
    const { check } = makeBrakeHarness();
    assert.equal(check((input) => { input.spec = null; }).code, 'NO_PROOF');
    assert.equal(check((input) => { input.spec = { specId: 'spec-1' }; }).code, 'NO_PROOF');
    // a proof URL alone satisfies D9 (the dated proof object only adds staleness checking)
    const proofOnly = check((input) => {
      input.spec = { specId: 'spec-1', proofRef: 'https://data.alpaca.markets/x' };
    });
    assert.equal(proofOnly.decision, 'ALLOW');
    assert.equal(
      check((input) => {
        input.spec = {
          specId: 'spec-1',
          proofRef: 'https://data.alpaca.markets/x',
          proof: { observedAt: new Date(T0 - 8 * DAY_MS).toISOString() },
        };
      }).code,
      'PROOF_STALE',
    );
  });

  it('D7 denies missing, expired and exit-only mandates for new exposure', () => {
    const { check } = makeBrakeHarness();
    assert.equal(check((input) => { input.mandate = null; }).code, 'BRAKE_DENIED');
    assert.equal(check((input) => {
      input.mandate.expiresAt = new Date(T0 - 1000).toISOString();
    }).code, 'BRAKE_DENIED');
    assert.equal(check((input) => { input.mandate.allowExitOnly = true; }).code, 'BRAKE_DENIED');
    // exits remain allowed under an exit-only mandate
    const exit = check((input) => {
      input.mandate.allowExitOnly = true;
      input.order.side = 'sell';
      input.positions = [{ symbol: 'AAPL', qty: 1, marketValueUsd: 100.05 }];
    });
    assert.equal(exit.decision, 'ALLOW', JSON.stringify(exit));
  });

  it('D5 caps order notional, position concentration and open positions', () => {
    const { check } = makeBrakeHarness();
    assert.equal(check((input) => {
      input.order.notionalUsd = 2000;
      input.order.qty = 20;
    }).code, 'SIZE_FORBIDDEN');
    assert.equal(check((input) => {
      input.order.notionalUsd = 200;
      input.order.qty = 2;
      input.positions = [{ symbol: 'AAPL', qty: 12, marketValueUsd: 1200, avgEntryPriceUsd: 100 }];
    }).code, 'SIZE_FORBIDDEN');
    assert.equal(check((input) => {
      input.positions = [
        { symbol: 'MSFT', qty: 1, marketValueUsd: 100, avgEntryPriceUsd: 100 },
        { symbol: 'NVDA', qty: 1, marketValueUsd: 100, avgEntryPriceUsd: 100 },
        { symbol: 'QQQ', qty: 1, marketValueUsd: 100, avgEntryPriceUsd: 100 },
      ];
      input.order.symbol = 'SPY';
      input.order.qty = 1;
      input.order.notionalUsd = 100.05;
    }).code, 'SIZE_FORBIDDEN');
  });

  it('D6 caps daily orders and one order per symbol per cycle', () => {
    const { check } = makeBrakeHarness();
    assert.equal(check((input) => { input.dayStats.ordersCount = 6; }).code, 'RATE_FORBIDDEN');
    assert.equal(check((input) => {
      input.mandate.maxDailyOrdersRemaining = 0;
    }).code, 'RATE_FORBIDDEN');
    assert.equal(check((input) => { input.dayStats.symbolsThisCycle = ['AAPL']; }).code, 'RATE_FORBIDDEN');
    assert.equal(check((input) => { input.dayStats.ordersThisCycle = 1; }).code, 'RATE_FORBIDDEN');
  });

  it('D8 denies live mode that is not armed and detached modes', () => {
    const paperHarness = makeBrakeHarness();
    assert.equal(paperHarness.check((input) => { input.mode = 'live'; }).code, 'MODE_FORBIDDEN');
    assert.equal(paperHarness.check((input) => { input.mode = 'chaos'; }).code, 'MODE_FORBIDDEN');

    const liveHarness = makeBrakeHarness({ mode: 'live', allowLive: true });
    assert.equal(liveHarness.brakes.isLiveArmed(), false);
    assert.equal(liveHarness.check((input) => { input.mode = 'live'; }).code, 'LIVE_NOT_ARMED');
  });

  it('D11 arms the operator kill switch before every other check', () => {
    const { env, brakes, check } = makeBrakeHarness();
    fs.mkdirSync(path.dirname(env.paths.killSwitch), { recursive: true });
    fs.writeFileSync(env.paths.killSwitch, 'stop', 'utf8');
    assert.equal(brakes.isKillSwitchActive(), true);
    assert.equal(check().code, 'KILL_SWITCH');
    assert.throws(() => brakes.assertKillSwitchClear(), (error) => error.code === 'KILL_SWITCH');
    fs.rmSync(env.paths.killSwitch, { force: true });
    assert.equal(brakes.isKillSwitchActive(), false);
    assert.equal(check().decision, 'ALLOW');
  });

  it('D13 denies new exposure when allocated capital would breach the account cap', () => {
    const { check } = makeBrakeHarness();
    const decision = check((input) => {
      input.accountEquityUsd = 100_000;
      input.allocatedEquityUsd = 79_950;
    });
    assert.equal(decision.decision, 'DENY');
    assert.equal(decision.code, 'ALLOCATION_FORBIDDEN');
  });
});

describe('brakes.js — v3 instrument wall (D15-D18)', () => {
  const asset = { shortable: true, marginable: true, tradable: true };

  it('D15 permits a compliant short and denies every illegal short sale', () => {
    const harness = makeV3BrakeHarness();
    const shortOrder = (mutate = () => {}) => (input) => {
      input.order = { symbol: 'AAPL', side: 'sell', qty: 2, priceUsd: 10, notionalUsd: 20, asset };
      input.quote = { symbol: 'AAPL', bid: 10, ask: 10.02 };
      mutate(input);
    };
    const allowed = harness.check(shortOrder());
    assert.equal(allowed.decision, 'ALLOW', JSON.stringify(allowed));
    assert.equal(allowed.shortNotionalUsd, 20);

    const disabled = makeV3BrakeHarness({ instruments: { allowShort: false } });
    assert.equal(disabled.check(shortOrder()).code, 'SHORT_FORBIDDEN');
    assert.equal(
      harness.check(shortOrder((input) => {
        input.mandate.instruments = fullInstrumentPermissions({ shortStock: false });
      })).code,
      'SHORT_FORBIDDEN',
    );
    assert.equal(
      harness.check(shortOrder((input) => { input.order.asset = { shortable: false, marginable: true }; })).code,
      'SHORT_FORBIDDEN',
    );
    assert.equal(
      harness.check(shortOrder((input) => { input.order.qty = 1.5; })).code,
      'SHORT_FORBIDDEN',
    );
    // config short cap is 25 USD; a 30 USD short is refused
    assert.equal(
      harness.check(shortOrder((input) => { input.order.qty = 3; input.order.notionalUsd = 30; })).code,
      'SHORT_FORBIDDEN',
    );

    // selling only what is held is an exit, not a short
    const covered = harness.check((input) => {
      input.order = { symbol: 'AAPL', side: 'sell', qty: 2, priceUsd: 100.05, notionalUsd: 200.1 };
      input.positions = [{ symbol: 'AAPL', qty: 2, marketValueUsd: 200.1, avgEntryPriceUsd: 100 }];
    });
    assert.equal(covered.decision, 'ALLOW', JSON.stringify(covered));
  });

  it('D16 permits long options and covered calls but always denies naked short options', () => {
    const call = occSymbol('AAPL', 150, 'call', datePlusDays(11));
    const put = occSymbol('AAPL', 145, 'put', datePlusDays(11));
    const optionMeta = (type, strike) => ({
      underlying: 'AAPL',
      expiration: datePlusDays(11),
      type,
      strikeUsd: strike,
      multiplier: 100,
    });
    const longCall = (input) => {
      input.order = {
        symbol: call,
        assetClass: 'us_option',
        side: 'buy',
        qty: 1,
        priceUsd: 0.04,
        notionalUsd: 4,
        option: optionMeta('call', 150),
      };
      input.quote = { symbol: call, bid: 0.03, ask: 0.05 };
    };
    const harness = makeV3BrakeHarness();
    const allowed = harness.check(longCall);
    assert.equal(allowed.decision, 'ALLOW', JSON.stringify(allowed));
    assert.equal(allowed.structure, 'long_call');
    assert.equal(allowed.premiumNotionalUsd, 4);
    assert.equal(allowed.contracts, 1);
    assert.equal(allowed.dte, 11);

    const noOptions = makeV3BrakeHarness({ instruments: { allowOptions: false } });
    assert.equal(noOptions.check(longCall).code, 'OPTION_FORBIDDEN');
    assert.equal(
      harness.check((input) => {
        longCall(input);
        input.mandate.instruments = fullInstrumentPermissions({ longOptions: false });
      }).code,
      'OPTION_FORBIDDEN',
    );
    // contracts cap (config maxContracts = 3)
    assert.equal(
      harness.check((input) => { longCall(input); input.order.qty = 4; input.order.notionalUsd = 16; }).code,
      'OPTION_FORBIDDEN',
    );
    // whole contracts only
    assert.equal(
      harness.check((input) => { longCall(input); input.order.qty = 1.5; }).code,
      'OPTION_FORBIDDEN',
    );

    // naked short options are always denied, even with shortOptions granted
    const nakedCall = harness.check((input) => {
      input.order = {
        symbol: call,
        assetClass: 'us_option',
        side: 'sell',
        qty: 1,
        priceUsd: 0.04,
        notionalUsd: 4,
        option: optionMeta('call', 150),
      };
    });
    assert.equal(nakedCall.code, 'OPTION_FORBIDDEN');
    assert.match(nakedCall.reason, /covered call requires|naked short options/i);
    const nakedPut = harness.check((input) => {
      input.order = {
        symbol: put,
        assetClass: 'us_option',
        side: 'sell',
        qty: 1,
        priceUsd: 0.04,
        notionalUsd: 4,
        option: optionMeta('put', 145),
      };
    });
    assert.equal(nakedPut.code, 'OPTION_FORBIDDEN');
    assert.match(nakedPut.reason, /naked short options/i);

    // covered call requires 100 long shares at order time
    const coveredOrder = (input) => {
      input.order = {
        symbol: call,
        assetClass: 'us_option',
        side: 'sell',
        qty: 1,
        priceUsd: 0.04,
        notionalUsd: 4,
        structure: 'covered_call',
        option: optionMeta('call', 150),
      };
      input.quote = { symbol: call, bid: 0.03, ask: 0.05 };
    };
    const uncovered = harness.check(coveredOrder);
    assert.equal(uncovered.code, 'OPTION_FORBIDDEN');
    assert.match(uncovered.reason, /covered call requires/i);

    const covered = makeV3BrakeHarness({
      positions: [{ symbol: 'AAPL', qty: 100, marketValueUsd: 10_000, avgEntryPriceUsd: 100 }],
    });
    const coveredAllowed = covered.check(coveredOrder);
    assert.equal(coveredAllowed.decision, 'ALLOW', JSON.stringify(coveredAllowed));
    assert.equal(coveredAllowed.structure, 'covered_call');

    // premium cap by the agent's equity (25% of 5000 = 1250; mandate/config cap 25 USD)
    assert.equal(
      harness.check((input) => { longCall(input); input.order.notionalUsd = 40; }).code,
      'OPTION_FORBIDDEN',
    );
  });

  it('D16 spread rules: defined-risk 2-leg verticals pass; mixed expiry, same-side and unknown structures fail', () => {
    const harness = makeV3BrakeHarness();
    const longCall = occSymbol('AAPL', 150, 'call', datePlusDays(11));
    const shortCall = occSymbol('AAPL', 155, 'call', datePlusDays(11));
    const spread = (a, b, structure = 'bull_call_spread') => (input) => {
      input.order = {
        symbol: a,
        side: 'buy',
        qty: 1,
        priceUsd: 0.12,
        notionalUsd: 12,
        structure,
        legs: [{ symbol: a, side: 'buy', ratioQty: 1 }, { symbol: b, side: 'sell', ratioQty: 1 }],
      };
      input.quote = { symbol: a, bid: 0.11, ask: 0.13 };
    };
    const allowed = harness.check(spread(longCall, shortCall));
    assert.equal(allowed.decision, 'ALLOW', JSON.stringify(allowed));
    assert.equal(allowed.structure, 'bull_call_spread');
    assert.equal(allowed.maxLossUsd, 500); // width 5 × 100 × 1
    assert.equal(allowed.contracts, 1);

    // mixed expiry: not defined risk
    assert.equal(harness.check(spread(longCall, occSymbol('AAPL', 155, 'call', datePlusDays(18)))).code, 'OPTION_FORBIDDEN');
    // different underlying
    assert.equal(harness.check(spread(longCall, occSymbol('MSFT', 155, 'call', datePlusDays(11)))).code, 'OPTION_FORBIDDEN');
    // both legs long = not a defined-risk vertical
    assert.equal(
      harness.check((input) => {
        input.order = {
          symbol: longCall,
          side: 'buy',
          qty: 1,
          priceUsd: 0.12,
          notionalUsd: 12,
          legs: [{ symbol: longCall, side: 'buy' }, { symbol: shortCall, side: 'buy' }],
        };
      }).code,
      'OPTION_FORBIDDEN',
    );
    // unknown structure
    assert.equal(harness.check(spread(longCall, shortCall, 'iron_condor')).code, 'OPTION_FORBIDDEN');
    // spreads disabled in config
    const noSpreads = makeV3BrakeHarness({ instruments: { allowSpreads: false } });
    assert.equal(noSpreads.check(spread(longCall, shortCall)).code, 'OPTION_FORBIDDEN');
    // spreads not granted by the mandate
    assert.equal(
      harness.check((input) => {
        spread(longCall, shortCall)(input);
        input.mandate.instruments = fullInstrumentPermissions({ spreads: false, shortOptions: false });
      }).code,
      'OPTION_FORBIDDEN',
    );
  });

  it('D17 caps margin debt and refuses margin when disabled', () => {
    const harness = makeV3BrakeHarness();
    const over = harness.check((input) => {
      input.order.marginRequiredUsd = 200;
      input.mandate.instruments = fullInstrumentPermissions({ maxMarginUsd: 100 });
    });
    assert.equal(over.code, 'MARGIN_LIMIT');
    assert.equal(over.brakeId, 'D17');

    const within = harness.check((input) => {
      input.order.marginRequiredUsd = 50;
      input.mandate.instruments = fullInstrumentPermissions({ maxMarginUsd: 100 });
    });
    assert.equal(within.decision, 'ALLOW', JSON.stringify(within));

    const noMargin = makeV3BrakeHarness({ instruments: { allowMargin: false } });
    assert.equal(noMargin.check((input) => { input.order.marginRequiredUsd = 50; }).code, 'MARGIN_LIMIT');

    const noMandateMargin = harness.check((input) => {
      input.order.marginRequiredUsd = 50;
      input.mandate.instruments = fullInstrumentPermissions({ margin: false });
    });
    assert.equal(noMandateMargin.code, 'MARGIN_LIMIT');
  });

  it('D18 expiry guard blocks short-DTE openings but sell-to-close is always allowed', () => {
    const harness = makeV3BrakeHarness();
    const soon = occSymbol('AAPL', 150, 'call', datePlusDays(1));
    const shortDte = harness.check((input) => {
      input.order = {
        symbol: soon,
        assetClass: 'us_option',
        side: 'buy',
        qty: 1,
        priceUsd: 0.04,
        notionalUsd: 4,
        option: { underlying: 'AAPL', expiration: datePlusDays(1), type: 'call', strikeUsd: 150, multiplier: 100 },
      };
    });
    assert.equal(shortDte.code, 'EXPIRY_GUARD');
    assert.equal(shortDte.brakeId, 'D18');
    assert.equal(shortDte.dte, 1);

    const far = occSymbol('AAPL', 150, 'call', datePlusDays(20));
    assert.equal(
      harness.check((input) => {
        input.order = {
          symbol: far,
          assetClass: 'us_option',
          side: 'buy',
          qty: 1,
          priceUsd: 0.04,
          notionalUsd: 4,
          option: { underlying: 'AAPL', expiration: datePlusDays(20), type: 'call', strikeUsd: 150, multiplier: 100 },
        };
      }).code,
      'OPTION_FORBIDDEN',
    );

    const expiring = occSymbol('AAPL', 150, 'call', datePlusDays(0));
    const closing = makeV3BrakeHarness({
      positions: [{ symbol: expiring, qty: 1, assetClass: 'us_option', avgPriceUsd: 0.04, marketValueUsd: 4 }],
    });
    const allowed = closing.check((input) => {
      input.order = {
        symbol: expiring,
        assetClass: 'us_option',
        side: 'sell',
        qty: 1,
        priceUsd: 0.04,
        notionalUsd: 4,
        positionIntent: 'sell_to_close',
        option: { underlying: 'AAPL', expiration: datePlusDays(0), type: 'call', strikeUsd: 150, multiplier: 100 },
      };
    });
    assert.equal(allowed.decision, 'ALLOW', JSON.stringify(allowed));
  });
});

// ---------------------------------------------------------------------------
// treasurer.js
// ---------------------------------------------------------------------------

function makeTreasuryWorld(options = {}) {
  const env = options.env ?? makeEnv();
  const clock = options.clock ?? makeClock();
  const agentSpecs = options.agents ?? [
    { id: 'atm-a', endowmentUsd: 5000 },
    { id: 'atm-b', endowmentUsd: 5000 },
  ];
  const { registry, ledger } = seedPopulation({ env, clock, agents: agentSpecs });
  for (const [agentId, amountUsd] of Object.entries(options.charges ?? {})) {
    ledger.charge(agentId, amountUsd, { category: 'inference', role: 'executor', at: clock.iso() });
  }
  const broker = options.broker ?? createFakeBroker({ equityUsd: options.accountEquityUsd ?? 100_000 });
  const journal = createJournal({ paths: env.paths, config: env.config });
  const treasurer = createTreasurer({
    broker,
    ledger,
    registry,
    journal,
    config: env.config,
    paths: env.paths,
    clock,
  });
  return { env, clock, registry, ledger, broker, journal, treasurer, agents: agentSpecs };
}

describe('treasurer.js — metabolism, runway and death verdicts', () => {
  it('anchors the ledger, prices the population and issues mandates', async () => {
    const world = makeTreasuryWorld();
    const tick = await world.treasurer.tick({ prices: {} });
    assert.equal(tick.mode, 'paper');
    assert.equal(tick.account.equityUsd, 100_000);
    assert.equal(tick.account.status, 'ACTIVE');
    assert.equal(tick.reconciliation.ok, true);
    assert.equal(tick.reconciliation.deltaUsd, 0);
    assert.equal(tick.state, 'STABLE');
    assert.equal(tick.cycleBudgetUsd, 0.08);
    assert.equal(tick.agentViews.length, 2);
    assert.equal(tick.mandates['atm-a'].allowExitOnly, false);
    assert.equal(tick.mandates['atm-a'].sizeBudgetUsd, 1250);
    assert.ok(tick.mandates['atm-a'].expiresAt > tick.mandates['atm-a'].issuedAt);
    assert.deepEqual(tick.mandates['atm-a'].allowedSymbols, [...world.env.config.symbols]);
    assert.equal(tick.mandates['atm-a'].accountEquityUsd, 100_000);
    assert.equal(tick.mandates['atm-a'].allocatedEquityUsd, 10_000);
    assert.equal(tick.mayReplicate, false);
    assert.equal(tick.surplus7dUsd, 0);
    assert.equal(tick.populationCapRemaining, world.env.config.population.cap - 2);
    assert.equal(tick.halted, false);
  });

  it('issues per-agent instrument mandates derived from config.instruments + equity', async () => {
    const v3Env = makeEnv({ instruments: { ...V3_INSTRUMENTS } });
    const v3World = makeTreasuryWorld({ env: v3Env });
    const tick = await v3World.treasurer.tick({ prices: {} });
    const mandate = tick.mandates['atm-a'];
    assert.equal(mandate.instruments.longStock, true);
    assert.equal(mandate.instruments.shortStock, true);
    assert.equal(mandate.instruments.longOptions, true);
    assert.equal(mandate.instruments.shortOptions, true);
    assert.equal(mandate.instruments.coveredCalls, true);
    assert.equal(mandate.instruments.spreads, true);
    assert.equal(mandate.instruments.margin, true);
    assert.ok(mandate.instruments.allowedStructures.includes('bull_call_spread'));
    assert.equal(mandate.instruments.maxContracts, 3);
    assert.equal(mandate.instruments.maxShortNotionalUsd, 25); // min(config 25, 1.0 × 5000 equity)
    assert.equal(mandate.instruments.maxOptionPremiumUsd, 25); // min(config 25, 0.25 × 5000 equity)
    assert.equal(mandate.equityUsd, 5000);
    const view = tick.agentViews.find((agentView) => agentView.agentId === 'atm-a');
    assert.equal(view.instruments.shortStock, true);
    assert.equal(view.marginDebtUsd, 0);
    assert.equal(view.grossExposureUsd, 0);
    assert.equal(tick.instruments.allowOptions, true);
    assert.equal(tick.instruments.minDTE, 2);
    assert.equal(tick.instruments.autoCloseDTE, 1);
    assert.equal(tick.marginDebtUsd, 0);
    assert.equal(tick.grossExposureUsd, 0);

    // legacy config keeps the v2 wall: no short/options/margin permissions are issued
    const legacyWorld = makeTreasuryWorld();
    const legacyTick = await legacyWorld.treasurer.tick({ prices: {} });
    const legacyMandate = legacyTick.mandates['atm-a'];
    assert.equal(legacyMandate.instruments.longStock, true);
    assert.equal(legacyMandate.instruments.shortStock, false);
    assert.equal(legacyMandate.instruments.longOptions, false);
    assert.equal(legacyMandate.instruments.margin, false);
    assert.equal(legacyMandate.instruments.maxContracts, 0);
    assert.equal(legacyTick.instruments.allowOptions, false);
  });

  it('computes runway from (equity - death floor) / burn, never raw balance', async () => {
    const world = makeTreasuryWorld();
    const perAgentBurn = burnPerHour(world.env.config, 1);
    assert.equal(perAgentBurn, 0.421);
    const expectedRunway = round2((5000 - 250) / perAgentBurn);
    const tick = await world.treasurer.tick({ prices: {} });
    for (const view of tick.agentViews) {
      assert.equal(view.equityUsd, 5000);
      assert.equal(view.cashUsd, 5000);
      assert.equal(view.runwayHours, expectedRunway);
      assert.equal(view.state, 'STABLE');
      assert.equal(view.drawdownPct, 0);
      assert.equal(view.net7dUsd, 0);
    }
    assert.equal(tick.burnPerHourUsd, burnPerHour(world.env.config, 2));
    assert.equal(
      tick.runwayHours,
      round2((10_000 - 2 * effectiveDeathFloor(world.env.config, 5000)) / burnPerHour(world.env.config, 2)),
    );

    const env = makeEnv();
    const clock = makeClock();
    const single = makeTreasuryWorld({
      env,
      clock,
      agents: [{ id: 'atm-solo', endowmentUsd: 5000 }],
      charges: { 'atm-solo': 1000 },
      accountEquityUsd: 5000,
    });
    const soloTick = await single.treasurer.tick({ prices: {} });
    assert.equal(soloTick.agentViews[0].equityUsd, 4000);
    assert.equal(soloTick.agentViews[0].runwayHours, round2((4000 - 250) / perAgentBurn));
  });

  it('fires insufficient_funds exactly at the death floor (and not one cent above)', async () => {
    // maxDrawdownPct=1 isolates the floor rule from the drawdown rule (which would
    // otherwise fire first for any equity far below 75% of endowment).
    const floorEnv = makeEnv({ maxDrawdownPct: 1 });
    const world = makeTreasuryWorld({ env: floorEnv, charges: { 'atm-a': 4750 } }); // equity 250 == floor
    const tick = await world.treasurer.tick({ prices: {} });
    assert.equal(tick.verdicts.length, 1);
    assert.equal(tick.verdicts[0].agentId, 'atm-a');
    assert.equal(tick.verdicts[0].cause, 'insufficient_funds');
    assert.equal(tick.verdicts[0].finalEquityUsd, 250);
    const dying = tick.agentViews.find((view) => view.agentId === 'atm-a');
    assert.equal(dying.state, 'DEAD');
    assert.equal(dying.runwayHours, 0);
    assert.equal(tick.mandates['atm-a'].allowExitOnly, true);
    assert.equal(tick.mandates['atm-b'].allowExitOnly, false);

    const aboveEnv = makeEnv({ maxDrawdownPct: 1 });
    const above = makeTreasuryWorld({ env: aboveEnv, charges: { 'atm-a': 4749.99 } });
    const aboveTick = await above.treasurer.tick({ prices: {} });
    assert.equal(aboveTick.verdicts.length, 0);
    assert.equal(aboveTick.agentViews.find((view) => view.agentId === 'atm-a').equityUsd, 250.01);
  });

  it('fires drawdown_limit at endowment x (1 - maxDrawdownPct)', async () => {
    const atLimit = makeTreasuryWorld({ charges: { 'atm-a': 1250 } }); // equity 3750
    const tick = await atLimit.treasurer.tick({ prices: {} });
    assert.equal(tick.verdicts.length, 1);
    assert.equal(tick.verdicts[0].cause, 'drawdown_limit');
    assert.equal(tick.agentViews.find((view) => view.agentId === 'atm-a').state, 'DEAD');

    const above = makeTreasuryWorld({ charges: { 'atm-a': 1249.99 } }); // equity 3750.01
    const aboveTick = await above.treasurer.tick({ prices: {} });
    assert.equal(aboveTick.verdicts.length, 0);
  });

  it('fires daily_loss_limit at maxDailyLossPct of day-start equity', async () => {
    const world = makeTreasuryWorld({ charges: { 'atm-a': 250 } }); // equity 4750
    const dayStats = {
      'atm-a': { dayKey: '2026-01-05', ordersCount: 1, startEquityUsd: 5000, pnlUsd: -250 },
      'atm-b': { dayKey: '2026-01-05', ordersCount: 0, startEquityUsd: 5000, pnlUsd: 0 },
    };
    const tick = await world.treasurer.tick({ prices: {}, dayStats });
    assert.equal(tick.verdicts.length, 1);
    assert.equal(tick.verdicts[0].agentId, 'atm-a');
    assert.equal(tick.verdicts[0].cause, 'daily_loss_limit');

    const fine = makeTreasuryWorld({ charges: { 'atm-a': 249.99 } });
    const fineTick = await fine.treasurer.tick({
      prices: {},
      dayStats: { 'atm-a': { dayKey: '2026-01-05', startEquityUsd: 5000, pnlUsd: -249.99 } },
    });
    assert.equal(fineTick.verdicts.length, 0);
  });

  it('persists death verdicts to paths.deaths', async () => {
    const world = makeTreasuryWorld({ charges: { 'atm-a': 4750 } });
    await world.treasurer.tick({ prices: {} });
    const persisted = JSON.parse(fs.readFileSync(world.env.paths.deaths, 'utf8'));
    assert.ok(Array.isArray(persisted.verdicts));
    assert.equal(persisted.verdicts[0].cause, 'insufficient_funds');
    assert.equal(persisted.verdicts[0].agentId, 'atm-a');
  });

  it('halts on account_not_active and keeps exit-only mandates', async () => {
    const broker = createFakeBroker({ equityUsd: 10_000, status: 'ON_HOLD' });
    const world = makeTreasuryWorld({ broker });
    const tick = await world.treasurer.tick({ prices: {} });
    assert.equal(tick.halted, true);
    assert.ok(tick.haltReasons.includes('account_not_active'));
    assert.equal(tick.mandates['atm-a'].allowExitOnly, true);
    assert.equal(tick.cycleBudgetUsd, 0.08); // runway still healthy; halting is operational
  });

  it('halts on reconciliation mismatch beyond tolerance', async () => {
    const world = makeTreasuryWorld({ accountEquityUsd: 20_000 });
    const first = await world.treasurer.tick({ prices: {} });
    assert.equal(first.reconciliation.ok, true);
    world.ledger.charge('atm-b', 1000, { category: 'inference', role: 'executor', at: world.clock.iso() });
    const second = await world.treasurer.tick({ prices: {} });
    assert.equal(second.reconciliation.ok, false);
    assert.equal(second.reconciliation.deltaUsd, 1000);
    assert.ok(second.haltReasons.includes('reconciliation_mismatch'));
    assert.equal(second.halted, true);
    assert.ok(second.mandates['atm-a'].allowExitOnly);
  });

  it('halts when allocated capital would exceed allocationCapPct of the account', async () => {
    const world = makeTreasuryWorld({
      agents: [{ id: 'atm-a', endowmentUsd: 5000 }, { id: 'atm-b', endowmentUsd: 5000 }],
      accountEquityUsd: 1000, // only 800 of 10 000 virtual capital may be allocated
    });
    const tick = await world.treasurer.tick({ prices: {} });
    assert.ok(tick.haltReasons.includes('allocation_cap'));
    assert.equal(tick.halted, true);
  });

  it('grants genesis capital and funds a child from the parent only', () => {
    const env = makeEnv();
    const clock = makeClock();
    const registry = createRegistry({ paths: env.paths, config: env.config, clock });
    const ledger = createLedger({ paths: env.paths, config: env.config, clock });
    const broker = createFakeBroker({ equityUsd: 100_000 });
    const treasurer = createTreasurer({
      broker,
      ledger,
      registry,
      journal: createJournal({ paths: env.paths, config: env.config }),
      config: env.config,
      paths: env.paths,
      clock,
    });
    registry.register({ id: 'atm-parent', generation: 1, endowmentUsd: 5000 });
    treasurer.grantInitial('atm-parent', 5000);
    assert.equal(ledger.snapshot('atm-parent').cashUsd, 5000);

    registry.register({ id: 'atm-child', parentId: 'atm-parent', generation: 2, endowmentUsd: 2500 });
    ledger.ensureAgent('atm-child', { endowmentUsd: 2500, at: clock.iso() });
    treasurer.fundChild('atm-parent', 'atm-child', 2500);
    assert.equal(ledger.snapshot('atm-parent').cashUsd, 2500);
    assert.equal(ledger.snapshot('atm-child').cashUsd, 2500);

    assert.throws(
      () => treasurer.fundChild('atm-parent', 'atm-child', 2500),
      (error) => error.code === 'REPLICATION_DENIED' || error.code === 'INSUFFICIENT_CASH',
    );
  });

  it('opens the replication gate only on surplus, runway, population and allocation', async () => {
    const env = makeEnv();
    const clock = makeClock();
    const { registry, ledger } = seedPopulation({
      env,
      clock,
      agents: [
        { id: 'atm-a', endowmentUsd: 5000 },
        { id: 'atm-b', endowmentUsd: 5000 },
      ],
    });
    // Realize a 2000 USD trading surplus on atm-a: 10 shares bought at 100, sold at 300.
    ledger.applyFill('atm-a', { symbol: 'AAPL', side: 'buy', qty: 10, priceUsd: 100, at: clock.iso() });
    ledger.applyFill('atm-a', { symbol: 'AAPL', side: 'sell', qty: 10, priceUsd: 300, at: clock.iso() });
    const broker = createFakeBroker({ equityUsd: 102_000 });
    const treasurer = createTreasurer({
      broker,
      ledger,
      registry,
      journal: createJournal({ paths: env.paths, config: env.config }),
      config: env.config,
      paths: env.paths,
      clock,
    });
    const tick = await treasurer.tick({ prices: {} });
    assert.equal(tick.reconciliation.ok, true, JSON.stringify(tick.reconciliation));
    assert.equal(tick.surplus7dUsd, 2000);
    assert.equal(tick.replication.surplusOk, true);
    assert.equal(tick.replication.runwayOk, true);
    assert.equal(tick.replication.populationOk, true);
    assert.equal(tick.replication.allocationOk, true);
    assert.equal(tick.mayReplicate, true);
    const reconciled = await treasurer.reconcile();
    assert.equal(reconciled.ok, true);
    assert.equal(reconciled.deltaUsd, 0); // first tick anchors the pool after the profit
  });
});

// ---------------------------------------------------------------------------
// replicator.js
// ---------------------------------------------------------------------------

function makeReplicatorWorld({ seed = 42, env: providedEnv, gate: gateOverrides = {}, population = {} } = {}) {
  const env = providedEnv ?? makeEnv({ population });
  const clock = makeClock();
  const { registry, ledger } = seedPopulation({
    env,
    clock,
    agents: [
      {
        id: 'atm-parent',
        generation: 1,
        endowmentUsd: 5000,
        bornAt: new Date(T0 - 30 * HOUR_MS).toISOString(),
        genome: {
          symbol: 'AAPL',
          family: 'momentum',
          lookback: 120,
          entryZ: 1.5,
          exitZ: 0.2,
          stopPct: 0.02,
          targetPct: 0.04,
          maxHoldBars: 8,
          sizePct: 0.15,
          sessionFilter: 'any',
        },
      },
    ],
  });
  // Fund the parent above its drawdown death floor: a birth must not be able to kill it.
  ledger.grant('atm-parent', 4000, { reason: 'test-extra-capital', at: clock.iso() });
  const journal = createJournal({ paths: env.paths, config: env.config });
  journal.append(
    makeObituary({
      agentId: 'atm-ancestor',
      genome: { symbol: 'AAPL', family: 'momentum', lookback: 120 },
      cause: 'drawdown_limit',
      lessons: ['Momentum needs a regime filter'],
    }),
  );
  const treasurer = {
    funded: [],
    fundChild(parentId, childId, amountUsd) {
      ledger.transfer(parentId, childId, amountUsd, { reason: 'child-endowment', at: clock.iso() });
      this.funded.push({ parentId, childId, amountUsd });
    },
  };
  const gate = {
    mayReplicate: true,
    surplus7dUsd: 200,
    runwayHours: 500,
    populationCapRemaining: Math.max(0, registry.cap - registry.population()),
    accountEquityUsd: 100_000,
    allocatedUsd: 5000,
    agentViews: [{ agentId: 'atm-parent', equityUsd: 9000 }],
    ...gateOverrides,
  };
  const replicator = createReplicator({
    treasurer,
    registry,
    ledger,
    journal,
    config: env.config,
    clock,
    rng: mulberry32(seed),
  });
  return { env, clock, registry, ledger, journal, treasurer, gate, replicator, parent: registry.get('atm-parent') };
}

describe('replicator.js — one mutation, journal lessons, treasurer-gated birth', () => {
  it('spawns a child: generation + 1, exactly one mutation, inherited lessons', async () => {
    const world = makeReplicatorWorld();
    const result = await world.replicator.spawn('atm-parent', world.gate);
    assert.ok(result.child.id);
    assert.equal(result.child.parentId, 'atm-parent');
    assert.equal(result.child.generation, 2);
    assert.equal(result.child.status, 'alive');
    assert.equal(result.child.endowmentUsd, world.env.config.replication.childEndowmentUsd);
    assert.ok(MUTABLE_FIELDS.includes(result.mutation.field));
    assert.notDeepEqual(result.mutation.to, result.mutation.from);
    assert.equal(result.child.mutation.field, result.mutation.field);

    // exactly one genome field differs from the parent
    const parentGenome = world.parent.genome;
    const childGenome = result.child.genome;
    const changed = Object.keys({ ...parentGenome, ...childGenome }).filter(
      (key) => parentGenome[key] !== childGenome[key],
    );
    assert.deepEqual(changed, [result.mutation.field]);
    assert.equal(childGenome[result.mutation.field], result.mutation.to);

    assert.ok(result.lessonCount >= 1);
    assert.ok(result.child.notes.length >= 1);
    assert.ok(result.child.notes.every((note) => typeof note === 'string'));

    // the child is funded from the parent's cash only
    assert.equal(world.ledger.snapshot('atm-parent').cashUsd, 6500);
    assert.equal(world.ledger.snapshot(result.child.id).cashUsd, 2500);
    assert.equal(world.registry.population(), 2);
    assert.deepEqual(world.treasurer.funded, [
      { parentId: 'atm-parent', childId: result.child.id, amountUsd: 2500 },
    ]);
  });

  it('mutates exactly one field for any seed and never clones the parent', async () => {
    for (const seed of [0, 1, 2, 7, 42, 1234]) {
      const world = makeReplicatorWorld({ seed });
      const result = await world.replicator.spawn('atm-parent', world.gate);
      assert.ok(MUTABLE[result.mutation.field], `unknown mutable field ${result.mutation.field}`);
      const parentGenome = world.parent.genome;
      const childGenome = result.child.genome;
      const changed = Object.keys({ ...parentGenome, ...childGenome }).filter(
        (key) => parentGenome[key] !== childGenome[key],
      );
      assert.equal(changed.length, 1, `seed ${seed} changed ${JSON.stringify(changed)}`);
    }
  });

  it('refuses birth when the Treasurer gate is closed', async () => {
    const closed = makeReplicatorWorld({ gate: { mayReplicate: false } });
    await assert.rejects(
      () => closed.replicator.spawn('atm-parent', closed.gate),
      (error) => error.code === 'REPLICATION_DENIED',
    );
    const poor = makeReplicatorWorld({ gate: { surplus7dUsd: 10 } });
    await assert.rejects(
      () => poor.replicator.spawn('atm-parent', poor.gate),
      (error) => error.code === 'REPLICATION_DENIED',
    );
    const tight = makeReplicatorWorld({ gate: { runwayHours: 10 } });
    await assert.rejects(
      () => tight.replicator.spawn('atm-parent', tight.gate),
      (error) => error.code === 'REPLICATION_DENIED',
    );
    const noGate = makeReplicatorWorld();
    await assert.rejects(
      () => noGate.replicator.spawn('atm-parent', null),
      (error) => error.code === 'REPLICATION_DENIED',
    );
  });

  it('refuses birth at the parent\'s cost of life or without liquid cash', async () => {
    const thin = makeReplicatorWorld({ gate: { agentViews: [{ agentId: 'atm-parent', equityUsd: 2500 }] } });
    await assert.rejects(
      () => thin.replicator.spawn('atm-parent', thin.gate),
      (error) => error.code === 'REPLICATION_DENIED',
    );
    const illiquid = makeReplicatorWorld();
    illiquid.ledger.applyFill('atm-parent', {
      symbol: 'AAPL',
      side: 'buy',
      qty: 80,
      priceUsd: 100,
      at: illiquid.clock.iso(),
    });
    assert.equal(illiquid.ledger.snapshot('atm-parent').cashUsd, 1000);
    await assert.rejects(
      () => illiquid.replicator.spawn('atm-parent', illiquid.gate),
      (error) => error.code === 'REPLICATION_DENIED',
    );
  });

  it('refuses at the population cap and never spawns from a dead parent', async () => {
    const capped = makeReplicatorWorld({ population: { initial: 0, cap: 2 } });
    capped.registry.register({ id: 'atm-other', generation: 1, endowmentUsd: 5000 });
    capped.ledger.ensureAgent('atm-other', { endowmentUsd: 5000, at: capped.clock.iso() });
    await assert.rejects(
      () => capped.replicator.spawn('atm-parent', capped.gate),
      (error) => error.code === 'POPULATION_CAP',
    );

    const dead = makeReplicatorWorld();
    dead.registry.markDead('atm-parent', {
      cause: 'insufficient_funds',
      at: dead.clock.iso(),
      finalEquityUsd: 0,
    });
    await assert.rejects(
      () => dead.replicator.spawn('atm-parent', dead.gate),
      (error) => error.code === 'AGENT_DEAD',
    );
    const unknown = makeReplicatorWorld();
    await assert.rejects(
      () => unknown.replicator.spawn('atm-ghost', unknown.gate),
      (error) => error.code === 'UNKNOWN_AGENT',
    );
  });
});

// ---------------------------------------------------------------------------
// reaper.js
// ---------------------------------------------------------------------------

function makeReaperWorld(options = {}) {
  const env = makeEnv();
  const clock = makeClock();
  const agentId = options.agentId ?? 'atm-doomed';
  const { registry, ledger } = seedPopulation({
    env,
    clock,
    agents: [
      {
        id: agentId,
        generation: 1,
        endowmentUsd: options.endowmentUsd ?? 5000,
        bornAt: new Date(T0 - 3 * HOUR_MS).toISOString(),
        genome: { symbol: 'AAPL', family: 'momentum' },
      },
    ],
  });
  if (options.buildPosition !== false) {
    ledger.applyFill(agentId, { symbol: 'AAPL', side: 'buy', qty: 10, priceUsd: 100, at: clock.iso() });
    ledger.charge(agentId, (options.endowmentUsd ?? 5000) - 1100, {
      category: 'inference',
      role: 'executor',
      at: clock.iso(),
    }); // cash 100, position 10 @ 100
  }
  const broker = createFakeBroker(
    options.broker ?? {
      equityUsd: 50_000,
      positions: [
        { symbol: 'AAPL', qty: 10, avgEntryPriceUsd: 100, marketValueUsd: 100, unrealizedPlUsd: -900 },
      ],
      openOrders: [
        { id: 'o1', clientOrderId: `atm:${agentId}:spec-1:1`, symbol: 'AAPL', side: 'buy', status: 'new' },
        { id: 'o2', clientOrderId: 'unrelated-order', symbol: 'AAPL', side: 'buy', status: 'new' },
      ],
      ...(options.brokerOverrides ?? {}),
    },
  );
  const journal = createJournal({ paths: env.paths, config: env.config });
  const reaper = createReaper({ broker, registry, ledger, journal, config: env.config, paths: env.paths, clock });
  return { env, clock, registry, ledger, broker, journal, reaper, agentId };
}

describe('reaper.js — independent death execution', () => {
  it('re-derives death, cancels, liquidates, sweeps, marks dead and writes an obituary', async () => {
    const world = makeReaperWorld();
    const equityBefore = world.ledger.equity(world.agentId, { AAPL: 10 }).equityUsd;
    assert.equal(equityBefore, 200); // 100 cash + 100 of position at the broker's mark

    const result = await world.reaper.sweep({});
    assert.equal(result.checked, 1);
    assert.equal(result.killed.length, 1);
    const killed = result.killed[0];
    assert.equal(killed.agentId, world.agentId);
    assert.equal(killed.cause, 'insufficient_funds');
    assert.equal(killed.finalEquityUsd, 200);

    // only the agent's own order is cancelled
    assert.deepEqual(world.broker.state.canceled, ['o1']);
    // liquidation: one market sell for the whole position
    assert.equal(world.broker.state.submitted.length, 1);
    assert.equal(world.broker.state.submitted[0].symbol, 'AAPL');
    assert.equal(world.broker.state.submitted[0].side, 'sell');
    assert.equal(world.broker.state.submitted[0].qty, 10);
    assert.equal(world.broker.state.submitted[0].type, 'market');
    assert.equal(world.broker.state.submitted[0].timeInForce, 'day');

    // virtual book: position closed, residual swept to the treasury record
    assert.deepEqual(world.ledger.book(world.agentId).positions, {});
    assert.equal(world.ledger.snapshot(world.agentId).cashUsd, 0);
    const pool = world.ledger.pool();
    assert.equal(pool.poolUsd, 200);
    assert.equal(pool.allocatedUsd, 0);

    // registry is one-way dead
    assert.equal(world.registry.get(world.agentId).status, 'dead');
    assert.equal(world.registry.get(world.agentId).cause, 'insufficient_funds');
    assert.equal(world.registry.population(), 0);

    // exactly one schema-valid obituary
    assert.equal(world.journal.count(), 1);
    const obituary = world.journal.list()[0];
    assert.equal(validateObituary(obituary).agentId, world.agentId);
    assert.equal(obituary.cause, 'insufficient_funds');
    assert.equal(obituary.finalEquityUsd, 200);
    assert.equal(obituary.endowmentUsd, 5000);
    assert.equal(obituary.netPlUsd, -4800);
    assert.equal(obituary.revenueUsd, 100); // gross sell proceeds (10 shares at the $10 mark)
    assert.equal(obituary.tradesCount, 2);
    assert.equal(obituary.productsShipped, 0);
    assert.equal(obituary.firstProfitAt, null);
    assert.equal(obituary.lessons.length, 0);
    assert.ok(obituary.lifespanHours > 0);
    assert.equal(obituary.lastRunwayHours, 0);
  });

  it('is idempotent: a second sweep neither re-kills nor duplicates the obituary', async () => {
    const world = makeReaperWorld();
    const first = await world.reaper.sweep({});
    assert.equal(first.killed.length, 1);
    const second = await world.reaper.sweep({});
    assert.equal(second.killed.length, 0);
    assert.equal(world.journal.count(), 1);
    assert.equal(world.broker.state.submitted.length, 1);
    const skipped = second.skipped.find((entry) => entry.agentId === world.agentId);
    assert.equal(skipped.reason, 'already_dead');
  });

  it('never trusts deaths.json: a healthy agent named in a verdict file is not killed', async () => {
    const world = makeReaperWorld();
    world.registry.register({
      id: 'atm-healthy',
      generation: 1,
      endowmentUsd: 5000,
      genome: { symbol: 'MSFT', family: 'meanrev' },
    });
    world.ledger.ensureAgent('atm-healthy', { endowmentUsd: 5000, at: world.clock.iso() });
    world.ledger.grant('atm-healthy', 5000, { reason: 'genesis-endowment', at: world.clock.iso() });
    fs.mkdirSync(path.dirname(world.env.paths.deaths), { recursive: true });
    fs.writeFileSync(
      world.env.paths.deaths,
      JSON.stringify({
        at: world.clock.iso(),
        verdicts: [
          { agentId: 'atm-healthy', cause: 'reconciliation_mismatch', finalEquityUsd: 0, at: world.clock.iso() },
        ],
      }),
      'utf8',
    );
    const result = await world.reaper.sweep({});
    assert.equal(result.killed.some((entry) => entry.agentId === 'atm-healthy'), false);
    assert.equal(world.registry.get('atm-healthy').status, 'alive');
    assert.equal(world.journal.has('atm-healthy'), false);
  });

  it('re-derives drawdown death from ledger marks and broker equity', async () => {
    const world = makeReaperWorld({
      brokerOverrides: {
        positions: [
          { symbol: 'AAPL', qty: 10, avgEntryPriceUsd: 100, marketValueUsd: 2750, unrealizedPlUsd: 1750 },
        ],
      },
    });
    // equity = 100 cash + 2750 marked = 2850 <= 3750 (25% drawdown on 5000)
    const result = await world.reaper.sweep({});
    assert.equal(result.killed.length, 1);
    assert.equal(result.killed[0].cause, 'drawdown_limit');
  });

  it('queues liquidation with a day order when the market is closed but still kills', async () => {
    const world = makeReaperWorld({ broker: { equityUsd: 50_000, marketOpen: false, positions: [
      { symbol: 'AAPL', qty: 10, avgEntryPriceUsd: 100, marketValueUsd: 100, unrealizedPlUsd: -900 },
    ] } });
    const result = await world.reaper.sweep({});
    assert.equal(result.killed.length, 1);
    assert.equal(world.broker.state.submitted[0].timeInForce, 'day');
    assert.equal(result.killed[0].liquidated[0].queued, true);
    assert.equal(world.registry.get(world.agentId).status, 'dead');
  });

  it('kills the whole population when broker equity no longer covers collective floors', async () => {
    const env = makeEnv();
    const clock = makeClock();
    const { registry, ledger } = seedPopulation({
      env,
      clock,
      agents: [
        { id: 'atm-a', endowmentUsd: 5000 },
        { id: 'atm-b', endowmentUsd: 5000 },
      ],
    });
    const broker = createFakeBroker({ equityUsd: 100 }); // below 2 x 250 floors
    const reaper = createReaper({
      broker,
      registry,
      ledger,
      journal: createJournal({ paths: env.paths, config: env.config }),
      config: env.config,
      paths: env.paths,
      clock,
    });
    const result = await reaper.sweep({});
    assert.equal(result.killed.length, 2);
    assert.ok(result.killed.every((entry) => entry.cause === 'insufficient_funds'));
    assert.equal(registry.population(), 0);
  });

  it('finishes a crashed kill: settles residual cash and writes the missing obituary', async () => {
    const env = makeEnv();
    const clock = makeClock();
    const { registry, ledger } = seedPopulation({
      env,
      clock,
      agents: [{ id: 'atm-half-dead', endowmentUsd: 5000 }],
    });
    ledger.charge('atm-half-dead', 4000, { category: 'inference', role: 'executor', at: clock.iso() });
    registry.markDead('atm-half-dead', {
      cause: 'risk_breach',
      at: clock.iso(),
      finalEquityUsd: 1000,
    });
    const broker = createFakeBroker({ equityUsd: 50_000 });
    const journal = createJournal({ paths: env.paths, config: env.config });
    const reaper = createReaper({ broker, registry, ledger, journal, config: env.config, paths: env.paths, clock });
    const result = await reaper.sweep({});
    assert.equal(result.killed.length, 0);
    assert.equal(journal.count(), 1);
    assert.equal(journal.list()[0].cause, 'risk_breach');
    assert.equal(journal.list()[0].finalEquityUsd, 1000);
    assert.equal(ledger.snapshot('atm-half-dead').cashUsd, 0);
    assert.equal(ledger.pool().poolUsd, 1000);
    assert.ok(result.skipped.some((entry) => entry.agentId === 'atm-half-dead'));
  });

  it('does not kill on broker unavailability', async () => {
    const world = makeReaperWorld();
    world.broker.state.failAccount = true;
    const result = await world.reaper.sweep({});
    assert.equal(result.killed.length, 0);
    assert.equal(result.checked, 0);
    assert.equal(world.registry.get(world.agentId).status, 'alive');
    assert.match(result.skipped[0].reason, /broker_unavailable/);
  });

  it('liquidates a short stock position on death (buy-to-cover, not a long-only sell)', async () => {
    const env = makeEnv();
    const clock = makeClock();
    const { registry, ledger } = seedPopulation({
      env,
      clock,
      agents: [
        {
          id: 'atm-short',
          endowmentUsd: 5000,
          bornAt: new Date(T0 - 3 * HOUR_MS).toISOString(),
          genome: { symbol: 'AAPL', family: 'momentum' },
        },
      ],
    });
    ledger.applyFill('atm-short', { symbol: 'AAPL', side: 'sell', qty: 10, priceUsd: 100, at: clock.iso() });
    ledger.charge('atm-short', 4800, { category: 'inference', role: 'executor', at: clock.iso() });
    // cash 1200, short 10 @ mark 100 → equity 200 <= death floor 250
    const broker = createFakeBroker({
      equityUsd: 50_000,
      positions: [
        {
          symbol: 'AAPL',
          assetClass: 'us_equity',
          qtySigned: -10,
          qty: -10,
          avgEntryPriceUsd: 100,
          marketValueUsd: -1000,
        },
      ],
    });
    const journal = createJournal({ paths: env.paths, config: env.config });
    const reaper = createReaper({ broker, registry, ledger, journal, config: env.config, paths: env.paths, clock });

    const result = await reaper.sweep({});
    assert.equal(result.killed.length, 1);
    assert.equal(result.killed[0].cause, 'insufficient_funds');
    assert.equal(result.killed[0].finalEquityUsd, 200);
    // the liquidation order is a BUY to cover — not a sell
    assert.equal(broker.state.submitted.length, 1);
    assert.equal(broker.state.submitted[0].side, 'buy');
    assert.equal(broker.state.submitted[0].assetClass, 'us_equity');
    assert.equal(broker.state.submitted[0].qty, 10);
    assert.deepEqual(ledger.book('atm-short').positions, {});
    assert.equal(ledger.snapshot('atm-short').cashUsd, 0);
    assert.equal(ledger.pool().poolUsd, 200);
    assert.equal(registry.get('atm-short').status, 'dead');
    assert.equal(journal.count(), 1);
    const obituary = journal.list()[0];
    assert.equal(validateObituary(obituary).agentId, 'atm-short');
    assert.equal(obituary.finalEquityUsd, 200);
    assert.equal(obituary.netPlUsd, -4800);

    // idempotent: a second sweep neither re-liquidates nor duplicates the obituary
    const second = await reaper.sweep({});
    assert.equal(second.killed.length, 0);
    assert.equal(broker.state.submitted.length, 1);
    assert.equal(journal.count(), 1);
  });

  it('liquidates long options and a defined-risk spread group on death, booking realized P&L', async () => {
    const env = makeEnv();
    const clock = makeClock();
    const { registry, ledger } = seedPopulation({
      env,
      clock,
      agents: [
        {
          id: 'atm-optional',
          endowmentUsd: 500,
          bornAt: new Date(T0 - 3 * HOUR_MS).toISOString(),
          genome: { symbol: 'AAPL', family: 'momentum' },
        },
      ],
    });
    const longCall = occSymbol('AAPL', 150, 'call', datePlusDays(11));
    const spreadLong = occSymbol('AAPL', 160, 'call', datePlusDays(11));
    const spreadShort = occSymbol('AAPL', 165, 'call', datePlusDays(11));
    const longPut = occSymbol('AAPL', 145, 'put', datePlusDays(11));
    ledger.applyFill('atm-optional', { symbol: longCall, assetClass: 'us_option', side: 'buy', qty: 1, priceUsd: 0.4, at: clock.iso() });
    ledger.applyFill('atm-optional', {
      symbol: spreadLong,
      assetClass: 'us_option',
      side: 'buy',
      qty: 1,
      priceUsd: 0.5,
      groupId: 'spread-g1',
      structure: 'bull_call_spread',
      at: clock.iso(),
    });
    ledger.applyFill('atm-optional', {
      symbol: spreadShort,
      assetClass: 'us_option',
      side: 'sell',
      qty: 1,
      priceUsd: 0.2,
      groupId: 'spread-g1',
      structure: 'bull_call_spread',
      at: clock.iso(),
    });
    ledger.applyFill('atm-optional', { symbol: longPut, assetClass: 'us_option', side: 'buy', qty: 1, priceUsd: 0.3, at: clock.iso() });
    // cash after debits/credits: 500 - 40 - 50 + 20 - 30 = 400
    ledger.charge('atm-optional', 320, { category: 'inference', role: 'executor', at: clock.iso() });
    // broker marks: 0.60 / 0.70 / 0.10 / 0.35 → equity 235 <= floor 250
    const broker = createFakeBroker({
      equityUsd: 50_000,
      positions: [
        { symbol: longCall, assetClass: 'us_option', qtySigned: 1, multiplier: 100, avgEntryPriceUsd: 0.4, marketValueUsd: 60 },
        { symbol: spreadLong, assetClass: 'us_option', qtySigned: 1, multiplier: 100, avgEntryPriceUsd: 0.5, marketValueUsd: 70 },
        { symbol: spreadShort, assetClass: 'us_option', qtySigned: -1, multiplier: 100, avgEntryPriceUsd: 0.2, marketValueUsd: -10 },
        { symbol: longPut, assetClass: 'us_option', qtySigned: 1, multiplier: 100, avgEntryPriceUsd: 0.3, marketValueUsd: 35 },
      ],
    });
    const journal = createJournal({ paths: env.paths, config: env.config });
    const reaper = createReaper({ broker, registry, ledger, journal, config: env.config, paths: env.paths, clock });

    const result = await reaper.sweep({});
    assert.equal(result.killed.length, 1);
    assert.equal(result.killed[0].finalEquityUsd, 235);
    // four close orders: long legs sell_to_close, the short spread leg buy_to_close
    assert.equal(broker.state.submitted.length, 4);
    const intents = broker.state.submitted.map((order) => `${order.assetClass}:${order.side}:${order.positionIntent}`);
    assert.deepEqual(intents.sort(), [
      'us_option:buy:buy_to_close',
      'us_option:sell:sell_to_close',
      'us_option:sell:sell_to_close',
      'us_option:sell:sell_to_close',
    ]);
    assert.deepEqual(ledger.book('atm-optional').positions, {});
    assert.equal(ledger.snapshot('atm-optional').cashUsd, 0);
    assert.equal(ledger.pool().poolUsd, 235);
    // realized P&L booked on the closes: +20 +20 +10 +5 = 55 (actual marks vs cost)
    assert.equal(ledger.snapshot('atm-optional').realizedPlUsd, 55);
    // both spread legs were opened and then closed under the same internal groupId
    const groupFills = ledger.history('atm-optional', { limit: 10 }).filter((fill) => fill.groupId === 'spread-g1');
    assert.equal(groupFills.length, 4); // 2 opening legs + 2 closing legs
    assert.equal(groupFills.filter((fill) => fill.realizedPlUsd !== 0).length, 2);
    assert.equal(journal.count(), 1);
    assert.equal(validateObituary(journal.list()[0]).agentId, 'atm-optional');
    assert.equal(journal.list()[0].finalEquityUsd, 235);

    const second = await reaper.sweep({});
    assert.equal(second.killed.length, 0);
    assert.equal(broker.state.submitted.length, 4);
    assert.equal(journal.count(), 1);
  });

  it('recovery settles a dead agent holding a short position (no phantom position survives)', async () => {
    const env = makeEnv();
    const clock = makeClock();
    const { registry, ledger } = seedPopulation({
      env,
      clock,
      agents: [{ id: 'atm-half', endowmentUsd: 50 }],
    });
    ledger.applyFill('atm-half', { symbol: 'AAPL', side: 'sell', qty: 2, priceUsd: 10, at: clock.iso() });
    ledger.charge('atm-half', 20, { category: 'inference', role: 'executor', at: clock.iso() });
    registry.markDead('atm-half', { cause: 'risk_breach', at: clock.iso(), finalEquityUsd: 50 });
    const broker = createFakeBroker({
      equityUsd: 50_000,
      positions: [
        { symbol: 'AAPL', assetClass: 'us_equity', qtySigned: -2, qty: -2, avgEntryPriceUsd: 10, marketValueUsd: -20 },
      ],
    });
    const journal = createJournal({ paths: env.paths, config: env.config });
    const reaper = createReaper({ broker, registry, ledger, journal, config: env.config, paths: env.paths, clock });

    const result = await reaper.sweep({});
    assert.equal(result.killed.length, 0);
    assert.deepEqual(ledger.book('atm-half').positions, {});
    assert.equal(ledger.snapshot('atm-half').cashUsd, 0);
    assert.equal(journal.count(), 1);
    assert.equal(journal.list()[0].cause, 'risk_breach');
    assert.equal(broker.state.submitted.length, 1);
    assert.equal(broker.state.submitted[0].side, 'buy');
    assert.ok(result.skipped.some((entry) => entry.agentId === 'atm-half'));
  });
});

// ---------------------------------------------------------------------------
// cross-cutting invariants
// ---------------------------------------------------------------------------

describe('system invariants', () => {
  it('every death cause used by the engine is a documented DEATH_CAUSES value', () => {
    assert.deepEqual([...DEATH_CAUSES].sort(), [
      'account_not_active',
      'daily_loss_limit',
      'drawdown_limit',
      'insufficient_funds',
      'reconciliation_mismatch',
      'risk_breach',
    ]);
    for (const brake of BRAKES) {
      assert.match(brake.id, /^D\d+$/);
      assert.equal(typeof brake.code, 'string');
    }
  });

  it('ledger + registry + journal survive a full kill/persist/reload cycle', async () => {
    const env = makeEnv();
    const clock = makeClock();
    const { registry, ledger } = seedPopulation({
      env,
      clock,
      agents: [{ id: 'atm-cycle', endowmentUsd: 5000 }],
    });
    ledger.charge('atm-cycle', 4750, { category: 'inference', role: 'executor', at: clock.iso() });
    const broker = createFakeBroker({ equityUsd: 50_000 });
    const journal = createJournal({ paths: env.paths, config: env.config });
    const reaper = createReaper({ broker, registry, ledger, journal, config: env.config, paths: env.paths, clock });
    await reaper.sweep({});
    registry.save();
    ledger.save();

    const reloadedRegistry = createRegistry({ paths: env.paths, config: env.config, clock });
    reloadedRegistry.load();
    const reloadedLedger = createLedger({ paths: env.paths, config: env.config, clock });
    reloadedLedger.load();
    const reloadedJournal = createJournal({ paths: env.paths, config: env.config });
    assert.equal(reloadedRegistry.get('atm-cycle').status, 'dead');
    assert.equal(reloadedLedger.snapshot('atm-cycle').cashUsd, 0);
    assert.equal(reloadedLedger.pool().poolUsd, 250);
    assert.equal(reloadedJournal.count(), 1);
    assert.equal(reloadedJournal.stats().mostCommonCause, 'insufficient_funds');
  });
});
