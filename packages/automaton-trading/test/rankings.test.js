/**
 * test/rankings.test.js — v3.3 rankings (fair period trading performance) + rewards
 * (capital payouts on trading return).
 *
 * What is asserted (docs/FAIR-PNL-REWARDS.md §4/§5):
 *   - period keys are UTC daily / ISO weekly / UTC monthly and are clock-driven
 *     (a fake clock in 1999 must not produce 2026 keys: no wall-clock/random reads);
 *   - a period's first observation is its baseline; a rollover carries the previous
 *     period's last observation (equity, trades, trading P&L and capital) forward;
 *   - observations may omit the v3.3 `tradingPlUsd`/`capitalUsd` fields and v3.2
 *     persisted state loads cleanly: the legacy equity delta (pnlUsd/pnlPct) survives,
 *     the trading fields stay null (never fabricated);
 *   - `stored: true` ranks the archived close of the just-completed period and exposes
 *     its trading fields so the rewards scheduler can rank the period that just ended;
 *   - reward capital (a treasury -> agent payout) never counts as trading profit: the
 *     trading fields are unchanged by an equity jump caused by a capital contribution;
 *   - rewards rank on period TRADING RETURN, pay a budget share of the treasury pool
 *     (not account cash) with rank shares 50/30/20, per-agent capital caps, max-per-
 *     period and allocation-cap ceilings, floor to cents, and proportional scaling;
 *   - eligibility requires a measured trading baseline, period trading profit above the
 *     minimum, a positive trading return, enough period trades and an acceptable
 *     drawdown; legacy equity-only rows are skipped, never rewarded;
 *   - skipped periods record `skipped` history with no transfer; lifetime map and
 *     per-agent history are persisted, `historyForAgent` is chronological;
 *   - payouts are `ledger.transfer('__treasury__', agent, {reason:'reward:<key>',
 *     category:'reward'})` so the ledger marks reward capital; the treasury pool is
 *     conserved and old v3.2 `rankPercents`/`account-cash` settings map away.
 *
 * The rewards suite uses a stub ledger implementing only `transfer()` + `pool()`, so it
 * is independent of the real ledger's v3.3 capital accounting (owned by another task).
 *
 * Run directly (the sandbox blocks `node --test <file>`):
 *   cd packages/automaton-trading && node test/rankings.test.js
 *
 * Owner: market teammate.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, statePaths } from '../src/config.js';
import {
  createRankings,
  isoWeekKey,
  nextPeriodStartMs,
  periodKeyFor,
  periodKeys,
} from '../src/rankings.js';
import {
  createRewards,
  resolveRewardSettings,
  REWARD_DEFAULTS,
  REWARD_HISTORY_LIMIT,
} from '../src/rewards.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Thursday 2026-10-29 12:00 UTC — ISO week 2026-W44, month 2026-10. */
const T1 = Date.parse('2026-10-29T12:00:00Z');
/** Friday 2026-10-30 00:05 UTC — the next daily boundary has just passed. */
const T2 = Date.parse('2026-10-30T00:05:00Z');
/** The daily boundary instant itself: the completed period ended here. */
const DAY_END = Date.parse('2026-10-30T00:00:00Z');
/** Saturday 2026-10-31 00:05 UTC — the next daily boundary has just passed. */
const T3 = Date.parse('2026-10-31T00:05:00Z');
const TREASURY = '__treasury__';

/** The v3.3 recommended defaults (docs/FAIR-PNL-REWARDS.md §5). */
const EXPECTED_DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  period: 'weekly',
  basis: 'trading-performance',
  rankShares: [0.5, 0.3, 0.2],
  rewardBudgetPctOfPool: 0.1,
  maxPerPeriodUsd: null,
  maxRewardPerAgentPctOfCapital: 0.5,
  minTradingProfitUsd: 0.05,
  minTrades: 3,
  maxDrawdownPct: 0.2,
});

const tempDirs = [];

function makeTempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `automaton-${label}-`));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Controllable clock (no Date.now in domain logic under test). */
function makeClock(startMs = T1) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    iso: () => new Date(nowMs).toISOString(),
    advance: (byMs) => {
      nowMs += byMs;
      return nowMs;
    },
    set: (ms) => {
      nowMs = ms;
    },
    startMs,
  };
}

function makeConfig(dir, overrides = {}) {
  const { config } = loadConfig({
    configFile: path.join(dir, 'missing.config.json'),
    envFile: path.join(dir, 'missing.env'),
    overrides: {
      mode: 'sim',
      paths: { stateDir: dir },
      ...overrides,
    },
  });
  return config;
}

function agentsById(rows) {
  return Object.fromEntries(rows.map((row) => [row.agentId, row]));
}

function snapshotJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function makeRankingsEnv(label, { clockStart = T1 } = {}) {
  const dir = makeTempDir(label);
  const clock = makeClock(clockStart);
  const config = makeConfig(dir);
  const paths = statePaths(config);
  const rankings = createRankings({ paths, config, clock });
  return { dir, clock, config, paths, rankings };
}

// ===========================================================================
// rankings
// ===========================================================================

describe('rankings: period keys, baselines, rollover, sorting, persistence', () => {
  it('computes UTC daily / ISO weekly / UTC monthly keys from the clock, not wall time', async () => {
    assert.deepEqual(periodKeys(T1), { daily: '2026-10-29', weekly: '2026-W44', monthly: '2026-10' });
    // Year-boundary correctness for the ISO week (Dec 29 2025 is Monday of 2026-W01).
    assert.equal(isoWeekKey(Date.parse('2025-12-29T00:00:00Z')), '2026-W01');
    assert.equal(isoWeekKey(Date.parse('2026-01-01T00:00:00Z')), '2026-W01');
    assert.deepEqual(periodKeys(Date.parse('2025-12-29T00:00:00Z')), {
      daily: '2025-12-29',
      weekly: '2026-W01',
      monthly: '2025-12',
    });
    assert.equal(periodKeyFor('daily', T1), '2026-10-29');
    assert.equal(periodKeyFor('weekly', T1), '2026-W44');
    assert.equal(periodKeyFor('monthly', T1), '2026-10');

    // next boundaries (used for rewards.nextRunAt)
    assert.equal(nextPeriodStartMs('daily', T1), Date.parse('2026-10-30T00:00:00Z'));
    assert.equal(nextPeriodStartMs('weekly', T1), Date.parse('2026-11-02T00:00:00Z'));
    assert.equal(nextPeriodStartMs('monthly', T1), Date.parse('2026-11-01T00:00:00Z'));

    // Clock-driven: a fake 1999 clock must produce 1999 keys, proving no Date.now().
    const oldEnv = makeRankingsEnv('rankings-1999', { clockStart: Date.parse('1999-12-31T12:00:00Z') });
    await oldEnv.rankings.load();
    await oldEnv.rankings.record({
      atMs: Date.parse('1999-12-31T12:00:00Z'),
      equityByAgent: { a: { name: 'Alpha', equityUsd: 100, trades: 0 } },
    });
    const oldState = oldEnv.rankings.getState();
    assert.equal(oldState.agents.a.baseline.daily.key, '1999-12-31');
    assert.equal(oldState.agents.a.baseline.weekly.key, '1999-W52');
    assert.equal(oldState.agents.a.baseline.monthly.key, '1999-12');
  });

  it('records equity baselines and keeps the legacy equity-delta fields working without trading data', async () => {
    const env = makeRankingsEnv('rankings-legacy');
    await env.rankings.load();

    await env.rankings.record({
      atMs: T1,
      equityByAgent: {
        a: { name: 'Alpha', equityUsd: 100, trades: 2 },
        b: { name: 'Beta', equityUsd: 200, trades: 5 },
        c: { name: 'Gamma', equityUsd: 50, trades: 0 },
      },
    });
    await env.rankings.record({
      atMs: T1 + HOUR,
      equityByAgent: {
        a: { name: 'Alpha', equityUsd: 110, trades: 3 },
        b: { name: 'Beta', equityUsd: 190, trades: 6 },
        c: { name: 'Gamma', equityUsd: 55, trades: 1 },
      },
    });

    const current = {
      a: { name: 'Alpha', equityUsd: 110, trades: 3 },
      b: { name: 'Beta', equityUsd: 190, trades: 6 },
      c: { name: 'Gamma', equityUsd: 55, trades: 1 },
    };
    const snapshot = env.rankings.compute({ atMs: T1 + 2 * HOUR, equityByAgent: current });
    assert.equal(snapshot.asOf, new Date(T1 + 2 * HOUR).toISOString());
    assert.deepEqual(snapshot.periodKeys, { daily: '2026-10-29', weekly: '2026-W44', monthly: '2026-10' });

    // daily: Alpha +10%/+$10, Gamma +10%/+$5 (tie on pct -> USD desc), Beta -5%/-$10.
    // Legacy observations have no trading marks: trading fields stay null, periodTrades
    // is still measured from the recorded trade counts (1 here).
    assert.deepEqual(snapshot.periods.daily[0], {
      rank: 1,
      agentId: 'a',
      name: 'Alpha',
      equityUsd: 110,
      baselineEquityUsd: 100,
      pnlUsd: 10,
      pnlPct: 0.1,
      trades: 3,
      tradingPlUsd: null,
      capitalUsd: null,
      baselineTradingPlUsd: null,
      baselineCapitalUsd: null,
      tradingPnlUsd: null,
      tradingPnlPct: null,
      periodTrades: 1,
    });
    assert.equal(snapshot.periods.daily[1].agentId, 'c');
    assert.equal(snapshot.periods.daily[1].rank, 2);
    assert.equal(snapshot.periods.daily[1].pnlPct, 0.1);
    assert.equal(snapshot.periods.daily[1].pnlUsd, 5);
    assert.equal(snapshot.periods.daily[2].agentId, 'b');
    assert.equal(snapshot.periods.daily[2].pnlPct, -0.05);
    assert.deepEqual(
      snapshot.periods.daily.map((row) => row.rank),
      [1, 2, 3],
    );
    // weekly/monthly baselines are the same first observation (same period as T1).
    assert.equal(snapshot.periods.weekly[0].baselineEquityUsd, 100);
    assert.equal(snapshot.periods.monthly[0].baselineEquityUsd, 100);
    assert.equal(snapshot.periods.weekly[0].periodTrades, 1);
    // The stored baseline also records the period-start trade counter.
    assert.equal(env.rankings.getState().agents.a.baseline.daily.trades, 2);
    assert.equal(env.rankings.getState().agents.a.last.daily.tradingPlUsd, null);

    // percent is rounded to 6 decimals (a 2dp USD move on a $3.00 baseline:
    // 3.01/3.00 - 1 = 0.003333...)
    await env.rankings.record({
      atMs: T1 + 3 * HOUR,
      equityByAgent: { e: { name: 'Epsilon', equityUsd: 3, trades: 0 } },
    });
    await env.rankings.record({
      atMs: T1 + 4 * HOUR,
      equityByAgent: { e: { name: 'Epsilon', equityUsd: 3.01, trades: 1 } },
    });
    const rounded = env.rankings.compute({
      atMs: T1 + 4 * HOUR,
      equityByAgent: { e: { name: 'Epsilon', equityUsd: 3.01, trades: 1 } },
    });
    assert.equal(rounded.periods.daily[0].pnlPct, 0.003333);
  });

  it('tracks trading P&L baselines and never counts reward capital as trading profit or return', async () => {
    const env = makeRankingsEnv('rankings-trading');
    await env.rankings.load();
    await env.rankings.record({
      atMs: T1,
      equityByAgent: {
        // GapFade receives a $20 reward-capital payout: equity and capital both +20.
        gap: { name: 'GapFade', equityUsd: 100, trades: 2, tradingPlUsd: 0, capitalUsd: 100 },
        // Trader grows trading P&L from 0 to 6 (and withdraws 20 capital: 100 -> 80).
        trader: { name: 'Trader', equityUsd: 100, trades: 2, tradingPlUsd: 0, capitalUsd: 100 },
      },
    });
    const traded = {
      gap: { name: 'GapFade', equityUsd: 120, trades: 2, tradingPlUsd: 0, capitalUsd: 120 },
      trader: { name: 'Trader', equityUsd: 86, trades: 5, tradingPlUsd: 6, capitalUsd: 80 },
    };
    await env.rankings.record({ atMs: T1 + 2 * HOUR, equityByAgent: traded });
    const snapshot = env.rankings.compute({ atMs: T1 + 3 * HOUR, equityByAgent: traded });
    const rows = agentsById(snapshot.periods.daily);

    // Legacy equity delta still sees the reward payout as +20 ...
    assert.equal(rows.gap.pnlUsd, 20);
    assert.equal(rows.gap.pnlPct, 0.2);
    // ... but fair trading P&L is unchanged (reward capital is NOT profit).
    assert.equal(rows.gap.tradingPlUsd, 0);
    assert.equal(rows.gap.capitalUsd, 120);
    assert.equal(rows.gap.tradingPnlUsd, 0);
    assert.equal(rows.gap.tradingPnlPct, 0);
    assert.equal(rows.gap.baselineTradingPlUsd, 0);
    assert.equal(rows.gap.baselineCapitalUsd, 100);
    assert.equal(rows.gap.periodTrades, 0);

    // The real trader: +$6 trading P&L on period-start capital $100 = +6% (not 6/80).
    assert.equal(rows.trader.tradingPnlUsd, 6);
    assert.equal(rows.trader.tradingPnlPct, 0.06);
    assert.equal(rows.trader.baselineCapitalUsd, 100);
    assert.equal(rows.trader.capitalUsd, 80);
    assert.equal(rows.trader.periodTrades, 3);

    // Stored baselines/last keep the trading/capital marks for archiving.
    const state = env.rankings.getState();
    assert.equal(state.agents.gap.baseline.daily.tradingPlUsd, 0);
    assert.equal(state.agents.gap.baseline.daily.capitalUsd, 100);
    assert.equal(state.agents.gap.last.daily.tradingPlUsd, 0);
    assert.equal(state.agents.gap.last.daily.capitalUsd, 120);
    assert.equal(state.agents.trader.last.daily.tradingPlUsd, 6);
    assert.equal(state.agents.trader.last.daily.capitalUsd, 80);

    // Leaderboard ordering still uses the legacy equity return (compatibility); the fair
    // reward ordering happens in rewards.js on tradingPnlPct.
    assert.deepEqual(snapshot.periods.daily.map((row) => row.agentId), ['gap', 'trader']);
  });

  it('carries trading marks across a rollover and archives the completed period for stored ranking', async () => {
    const env = makeRankingsEnv('rankings-roll');
    await env.rankings.load();
    await env.rankings.record({
      atMs: T1,
      equityByAgent: { a: { name: 'Alpha', equityUsd: 100, trades: 1, tradingPlUsd: 0, capitalUsd: 100 } },
    });
    await env.rankings.record({
      atMs: T1 + HOUR,
      equityByAgent: { a: { name: 'Alpha', equityUsd: 108, trades: 4, tradingPlUsd: 8, capitalUsd: 100 } },
    });

    // Day 2 (Fri 2026-10-30): the new daily baseline is Friday's carried close, including
    // the trading P&L / capital / trades marks.
    env.clock.set(T2);
    await env.rankings.record({
      atMs: T2,
      equityByAgent: { a: { name: 'Alpha', equityUsd: 112, trades: 7, tradingPlUsd: 12, capitalUsd: 100 } },
    });
    const state = env.rankings.getState();
    assert.deepEqual(state.agents.a.baseline.daily, {
      key: '2026-10-30',
      equityUsd: 108,
      trades: 4,
      tradingPlUsd: 8,
      capitalUsd: 100,
    });
    assert.deepEqual(state.agents.a.previousBaseline.daily, {
      key: '2026-10-29',
      equityUsd: 100,
      trades: 1,
      tradingPlUsd: 0,
      capitalUsd: 100,
    });
    assert.equal(state.agents.a.previousLast.daily.equityUsd, 108);
    assert.equal(state.agents.a.previousLast.daily.tradingPlUsd, 8);
    assert.equal(state.agents.a.previousLast.daily.capitalUsd, 100);
    assert.equal(state.agents.a.previousLast.daily.trades, 4);

    const day2 = env.rankings.compute({
      atMs: T2 + HOUR,
      equityByAgent: { a: { name: 'Alpha', equityUsd: 112, trades: 7, tradingPlUsd: 12, capitalUsd: 100 } },
    });
    assert.equal(day2.periodKeys.daily, '2026-10-30');
    assert.equal(day2.periods.daily[0].baselineEquityUsd, 108);
    assert.equal(day2.periods.daily[0].pnlUsd, 4);
    assert.equal(day2.periods.daily[0].baselineTradingPlUsd, 8);
    assert.equal(day2.periods.daily[0].tradingPnlUsd, 4);
    assert.equal(day2.periods.daily[0].tradingPnlPct, 0.04);
    assert.equal(day2.periods.daily[0].periodTrades, 3);
    // Friday is still the same ISO week / UTC month: those baselines stay at day 1.
    assert.equal(day2.periods.weekly[0].baselineTradingPlUsd, 0);
    assert.equal(day2.periods.weekly[0].tradingPnlUsd, 12);
    assert.equal(day2.periods.weekly[0].tradingPnlPct, 0.12);
    assert.equal(day2.periods.weekly[0].periodTrades, 6);
    assert.equal(day2.periods.monthly[0].tradingPnlUsd, 12);

    // stored:true at the last instant of day 1 ranks the ARCHIVED close of the completed
    // period and exposes its trading fields for the reward scheduler.
    const archived = env.rankings.compute({ atMs: DAY_END - 1, stored: true });
    assert.deepEqual(archived.periods.daily[0], {
      rank: 1,
      agentId: 'a',
      name: 'Alpha',
      equityUsd: 108,
      baselineEquityUsd: 100,
      pnlUsd: 8,
      pnlPct: 0.08,
      trades: 4,
      tradingPlUsd: 8,
      capitalUsd: 100,
      baselineTradingPlUsd: 0,
      baselineCapitalUsd: 100,
      tradingPnlUsd: 8,
      tradingPnlPct: 0.08,
      periodTrades: 3,
    });

    // At the new period, stored:true shows the current period only.
    const current = env.rankings.compute({ atMs: T2 + HOUR, stored: true });
    assert.equal(current.periods.daily.length, 1);
    assert.equal(current.periods.daily[0].tradingPnlUsd, 4);
    assert.equal(current.periods.daily[0].periodTrades, 3);
  });

  it('normalizes legacy v3.2 rankings.json without fabricating trading baselines', async () => {
    const env = makeRankingsEnv('rankings-normalize');
    const T_MINUS_1 = Date.parse('2026-10-28T12:00:00Z');
    const legacyJson = {
      version: 1,
      updatedAt: '2026-10-29T00:00:00.000Z',
      agents: {
        a: {
          name: 'Alpha',
          baseline: {
            daily: { key: '2026-10-29', equityUsd: 100 },
            weekly: { key: '2026-W44', equityUsd: 100 },
            monthly: { key: '2026-10', equityUsd: 100 },
          },
          last: {
            daily: { key: '2026-10-29', equityUsd: 110, trades: 4, atMs: T1 },
            weekly: { key: '2026-W44', equityUsd: 110, trades: 4, atMs: T1 },
            monthly: { key: '2026-10', equityUsd: 110, trades: 4, atMs: T1 },
          },
          previousBaseline: { daily: { key: '2026-10-28', equityUsd: 90 } },
          previousLast: { daily: { key: '2026-10-28', equityUsd: 95, trades: 2, atMs: T_MINUS_1 } },
        },
      },
    };
    fs.mkdirSync(env.paths.stateDir, { recursive: true });
    fs.writeFileSync(env.paths.rankings, JSON.stringify(legacyJson), 'utf8');
    await env.rankings.load();
    const state = env.rankings.getState();
    assert.equal(state.version, 2);
    assert.deepEqual(state.agents.a.baseline.daily, {
      key: '2026-10-29',
      equityUsd: 100,
      trades: null,
      tradingPlUsd: null,
      capitalUsd: null,
    });
    assert.deepEqual(state.agents.a.last.daily, {
      key: '2026-10-29',
      equityUsd: 110,
      trades: 4,
      tradingPlUsd: null,
      capitalUsd: null,
      atMs: T1,
    });
    assert.equal(state.agents.a.previousBaseline.daily.trades, null);
    assert.equal(state.agents.a.previousLast.daily.capitalUsd, null);

    // Legacy equity P&L still works; trading performance stays null (unmeasured).
    const current = env.rankings.compute({
      atMs: T1 + HOUR,
      equityByAgent: { a: { name: 'Alpha', equityUsd: 110, trades: 4 } },
    });
    assert.equal(current.periods.daily[0].pnlUsd, 10);
    assert.equal(current.periods.daily[0].pnlPct, 0.1);
    assert.equal(current.periods.daily[0].tradingPnlUsd, null);
    assert.equal(current.periods.daily[0].tradingPnlPct, null);
    assert.equal(current.periods.daily[0].periodTrades, null);
    assert.equal(current.periods.daily[0].baselineTradingPlUsd, null);
    assert.equal(current.periods.daily[0].baselineCapitalUsd, null);

    // A legacy archived period also stays trading-unmeasured (never a fabricated number).
    const archived = env.rankings.compute({ atMs: T_MINUS_1, stored: true });
    assert.equal(archived.periods.daily[0].equityUsd, 95);
    assert.equal(archived.periods.daily[0].pnlUsd, 5);
    assert.equal(archived.periods.daily[0].tradingPnlUsd, null);
    assert.equal(archived.periods.daily[0].periodTrades, null);
  });

  it('breaks exact ties by name (then agentId) deterministically', async () => {
    const env = makeRankingsEnv('rankings-ties');
    await env.rankings.load();
    await env.rankings.record({
      atMs: T1,
      equityByAgent: {
        x: { name: 'Zed', equityUsd: 100, trades: 0 },
        y: { name: 'Amy', equityUsd: 100, trades: 0 },
      },
    });
    const equal = {
      x: { name: 'Zed', equityUsd: 110, trades: 0 },
      y: { name: 'Amy', equityUsd: 110, trades: 0 },
    };
    const snapshot = env.rankings.compute({ atMs: T1 + HOUR, equityByAgent: equal });
    assert.deepEqual(
      snapshot.periods.daily.map((row) => row.name),
      ['Amy', 'Zed'],
    );
    assert.deepEqual(
      snapshot.periods.daily.map((row) => row.rank),
      [1, 2],
    );
  });

  it('lists an agent without a current-period baseline last with null P&L; empty input is empty arrays', async () => {
    const env = makeRankingsEnv('rankings-newcomer');
    await env.rankings.load();
    await env.rankings.record({
      atMs: T1,
      equityByAgent: { a: { name: 'Alpha', equityUsd: 100, trades: 2 } },
    });
    const current = {
      a: { name: 'Alpha', equityUsd: 120, trades: 4 },
      newcomer: { name: 'Newcomer', equityUsd: 500, trades: 0 },
      marked: { name: 'Marked', equityUsd: 500, trades: 2, tradingPlUsd: 25, capitalUsd: 400 },
    };
    const snapshot = env.rankings.compute({ atMs: T1 + 4 * HOUR, equityByAgent: current });
    const daily = agentsById(snapshot.periods.daily);
    assert.equal(daily.a.rank, 1);
    assert.equal(daily.newcomer.rank, 3);
    assert.equal(daily.newcomer.pnlPct, null);
    assert.equal(daily.newcomer.pnlUsd, null);
    assert.equal(daily.newcomer.baselineEquityUsd, null);
    assert.equal(daily.newcomer.equityUsd, 500);
    assert.equal(daily.newcomer.tradingPnlUsd, null);
    assert.equal(daily.newcomer.tradingPnlPct, null);
    assert.equal(daily.newcomer.baselineTradingPlUsd, null);
    assert.equal(daily.newcomer.periodTrades, null);
    // A trading reading without a baseline is NOT a period measurement (but is exposed).
    assert.equal(daily.marked.tradingPlUsd, 25);
    assert.equal(daily.marked.capitalUsd, 400);
    assert.equal(daily.marked.tradingPnlUsd, null);
    assert.equal(daily.marked.baselineTradingPlUsd, null);

    const empty = env.rankings.compute({ equityByAgent: {} });
    assert.deepEqual(empty.periods, { daily: [], weekly: [], monthly: [] });
    assert.deepEqual(env.rankings.compute().periods, { daily: [], weekly: [], monthly: [] });
  });

  it('persists to stateDir/rankings.json, reloads, and tolerates a corrupt file', async () => {
    const env = makeRankingsEnv('rankings-persist');
    await env.rankings.load();
    await env.rankings.record({
      atMs: T1,
      equityByAgent: { a: { name: 'Alpha', equityUsd: 100, trades: 1, tradingPlUsd: 0, capitalUsd: 100 } },
    });
    await env.rankings.record({
      atMs: T1 + HOUR,
      equityByAgent: { a: { name: 'Alpha', equityUsd: 108, trades: 4, tradingPlUsd: 8, capitalUsd: 100 } },
    });
    assert.ok(fs.existsSync(env.paths.rankings), 'record() must persist rankings.json');
    const raw = snapshotJson(JSON.parse(fs.readFileSync(env.paths.rankings, 'utf8')));
    assert.equal(raw.version, 2);
    assert.equal(raw.agents.a.baseline.daily.tradingPlUsd, 0);
    assert.equal(raw.agents.a.baseline.daily.capitalUsd, 100);
    assert.equal(raw.agents.a.last.daily.tradingPlUsd, 8);
    assert.equal(raw.agents.a.last.daily.capitalUsd, 100);

    // Reload in a fresh instance: baselines and computed trading performance survive.
    const reloaded = createRankings({ paths: env.paths, config: env.config, clock: env.clock });
    await reloaded.load();
    const observation = { a: { name: 'Alpha', equityUsd: 108, trades: 4, tradingPlUsd: 8, capitalUsd: 100 } };
    const before = env.rankings.compute({ atMs: T1 + 2 * HOUR, equityByAgent: observation });
    const after = reloaded.compute({ atMs: T1 + 2 * HOUR, equityByAgent: observation });
    assert.deepEqual(after, before);
    assert.equal(after.periods.daily[0].tradingPnlUsd, 8);

    // Corrupted state is not fatal: no history means null baselines, never a throw.
    const corruptEnv = makeRankingsEnv('rankings-corrupt');
    fs.mkdirSync(corruptEnv.paths.stateDir, { recursive: true });
    fs.writeFileSync(corruptEnv.paths.rankings, '{ this is not json', 'utf8');
    const corrupt = createRankings({ paths: corruptEnv.paths, config: corruptEnv.config, clock: corruptEnv.clock });
    const loaded = await corrupt.load();
    assert.deepEqual(loaded.agents, {});
    const corruptSnapshot = corrupt.compute({
      atMs: T1,
      equityByAgent: { a: { name: 'Alpha', equityUsd: 100, trades: 0 } },
    });
    assert.equal(corruptSnapshot.periods.daily[0].pnlPct, null);
    assert.equal(corruptSnapshot.periods.daily[0].tradingPnlPct, null);
  });
});

// ===========================================================================
// rewards — stub ledger (only transfer()/pool(): independent of the real ledger)
// ===========================================================================

/**
 * Minimal ledger used by the rewards suite. It moves REAL virtual cash between the
 * treasury and agents and records the transfers, so pool conservation and transfer
 * metadata can be asserted without importing the (separately owned) ledger module.
 */
function makeStubLedger({ startingPoolUsd = 0 } = {}) {
  const cash = new Map();
  let treasuryUsd = round2(startingPoolUsd);
  const transfers = [];
  return {
    transfers,
    fund(agentId, amountUsd) {
      cash.set(agentId, round2((cash.get(agentId) ?? 0) + amountUsd));
    },
    cashOf(agentId) {
      return round2(cash.get(agentId) ?? 0);
    },
    pool() {
      const allocatedUsd = [...cash.values()].reduce((sum, value) => sum + value, 0);
      return {
        poolUsd: round2(treasuryUsd),
        allocatedUsd: round2(allocatedUsd),
        totalUsd: round2(treasuryUsd + allocatedUsd),
      };
    },
    totalUsd() {
      return this.pool().totalUsd;
    },
    transfer(fromId, toId, amountUsd, meta = {}) {
      if (fromId !== TREASURY) throw new Error(`unexpected transfer source "${fromId}"`);
      const amount = round2(amountUsd);
      if (!(amount > 0)) {
        const error = new Error('transfer amount must be positive');
        error.code = 'CONFIG_INVALID';
        throw error;
      }
      if (amount > treasuryUsd + 1e-9) {
        const error = new Error(`treasury pool cannot fund ${amount.toFixed(2)}: has ${treasuryUsd.toFixed(2)}`);
        error.code = 'INSUFFICIENT_CASH';
        throw error;
      }
      treasuryUsd = round2(treasuryUsd - amount);
      cash.set(toId, round2((cash.get(toId) ?? 0) + amount));
      transfers.push({ fromId, toId, amountUsd: amount, ...meta });
    },
  };
}

async function makeRewardsEnv({ settings = { period: 'daily' }, poolUsd = 1000, clockStart = T1 } = {}) {
  const dir = makeTempDir('rewards');
  const clock = makeClock(clockStart);
  const rewardsFile = path.join(dir, 'rewards.json');
  const config = { rewards: { ...settings } };
  const rewards = createRewards({ paths: { rewardsFile }, config, clock });
  await rewards.load();
  const ledger = makeStubLedger({ startingPoolUsd: poolUsd });
  return { dir, clock, config, rewardsFile, rewards, ledger };
}

/** One rankings row as computed by rankings.js (fair trading fields provided). */
function tradingRow({
  agentId,
  name = agentId,
  tradingPnlPct,
  tradingPnlUsd,
  capitalUsd = 100,
  periodTrades = 5,
  baselineTradingPlUsd = 0,
  drawdownPct = null,
}) {
  return {
    rank: 0,
    agentId,
    name,
    equityUsd: round2(capitalUsd + tradingPnlUsd),
    baselineEquityUsd: capitalUsd,
    pnlUsd: tradingPnlUsd,
    pnlPct: tradingPnlPct,
    trades: periodTrades + 2,
    tradingPlUsd: round2(baselineTradingPlUsd + tradingPnlUsd),
    capitalUsd,
    baselineTradingPlUsd,
    baselineCapitalUsd: capitalUsd,
    tradingPnlUsd,
    tradingPnlPct,
    periodTrades,
    drawdownPct,
  };
}

/** A v3.2-style equity-only row: no measured trading baseline. */
function legacyRow({ agentId, name = agentId, pnlPct = 0.2, pnlUsd = 20 }) {
  return {
    rank: 0,
    agentId,
    name,
    equityUsd: 100 + pnlUsd,
    baselineEquityUsd: 100,
    pnlUsd,
    pnlPct,
    trades: 5,
    tradingPlUsd: null,
    capitalUsd: null,
    baselineTradingPlUsd: null,
    baselineCapitalUsd: null,
    tradingPnlUsd: null,
    tradingPnlPct: null,
    periodTrades: null,
    drawdownPct: null,
  };
}

function standardRows() {
  return [
    tradingRow({ agentId: 'a', name: 'Alpha', tradingPnlPct: 0.08, tradingPnlUsd: 8 }),
    tradingRow({ agentId: 'b', name: 'Beta', tradingPnlPct: 0.05, tradingPnlUsd: 5 }),
    tradingRow({ agentId: 'c', name: 'Gamma', tradingPnlPct: 0.03, tradingPnlUsd: 3 }),
    tradingRow({ agentId: 'd', name: 'Delta', tradingPnlPct: 0.02, tradingPnlUsd: 2 }),
  ];
}

function snapshotOf(rows, period = 'daily') {
  const caps = { daily: [], weekly: [], monthly: [] };
  caps[period] = rows;
  return {
    asOf: new Date(DAY_END - 1).toISOString(),
    periodKeys: periodKeys(DAY_END - 1),
    periods: caps,
  };
}

/**
 * Apply the completed period (default: 2026-10-29) with the given rows. `accountCashUsd`
 * is deliberately huge: v3.3 must pay from the pool budget, never from a % of cash.
 */
async function applyDue(env, {
  rows = standardRows(),
  period = 'daily',
  nowMs = T2,
  riskByAgent,
  poolUsd,
  allocationCapRemainingUsd = 1_000_000,
} = {}) {
  const due = env.rewards.duePeriod(nowMs);
  assert.ok(due, 'a completed period must be due');
  return env.rewards.apply({
    due,
    rankings: snapshotOf(rows, period),
    accountCashUsd: 2_000_000,
    poolUsd: poolUsd ?? env.ledger.pool().poolUsd,
    allocationCapRemainingUsd,
    riskByAgent,
    ledger: env.ledger,
    nowMs,
  });
}

describe('rewards: v3.3 trading-performance capital payouts', () => {
  it('anchors the initial partial period and pays nothing before a boundary', async () => {
    const env = await makeRewardsEnv({ poolUsd: 1000 });
    assert.equal(env.rewards.duePeriod(T1 + HOUR), null, 'no payout inside the initial partial period');

    const status = env.rewards.status();
    assert.equal(status.enabled, true);
    assert.equal(status.period, 'daily');
    assert.deepEqual(status.rankShares, [0.5, 0.3, 0.2]);
    assert.deepEqual(status.rankPercents, [0.5, 0.3, 0.2], 'deprecated alias mirrors rankShares');
    assert.equal(status.basis, 'trading-performance');
    assert.equal(status.historyCount, 0);
    assert.equal(status.lastPeriodKey, '2026-10-29');
    assert.equal(status.nextRunAt, new Date(Date.parse('2026-10-30T00:00:00Z')).toISOString());

    // Once the boundary passes the scheduler *reports* the completed period as due; it
    // still pays nothing until apply() is called, and the initial anchor never shifts.
    const dueAfterBoundary = env.rewards.duePeriod(T2);
    assert.ok(dueAfterBoundary);
    assert.equal(dueAfterBoundary.periodKey, '2026-10-29');
    assert.equal(env.rewards.status().historyCount, 0);
    assert.equal(env.ledger.pool().poolUsd, 1000);
    assert.equal(env.ledger.transfers.length, 0);
  });

  it('pays rank shares of the pool budget (50/30/20) as reward capital, not a % of cash', async () => {
    const env = await makeRewardsEnv({ poolUsd: 1000 });
    const totalBefore = env.ledger.totalUsd();
    const due = env.rewards.duePeriod(T2);
    assert.deepEqual(due, {
      period: 'daily',
      periodKey: '2026-10-29',
      completed: true,
      currentPeriodKey: '2026-10-30',
    });
    const result = await env.rewards.apply({
      due,
      rankings: snapshotOf(standardRows()),
      accountCashUsd: 2_000_000, // ignored by v3.3: cash is not the payout basis
      poolUsd: env.ledger.pool().poolUsd,
      allocationCapRemainingUsd: 1_000_000,
      ledger: env.ledger,
      nowMs: T2,
    });

    assert.equal(result.applied, true);
    assert.equal(result.skipped, false);
    assert.equal(result.period, 'daily');
    assert.equal(result.periodKey, '2026-10-29');
    assert.equal(result.basis, 'trading-performance');
    assert.equal(result.budgetUsd, 100, '10% of the $1,000 pool — not 5% of account cash');
    assert.equal(result.eligibleCount, 4);
    assert.deepEqual(
      result.winners.map(({ rank, agentId, share, amountUsd }) => ({ rank, agentId, share, amountUsd })),
      [
        { rank: 1, agentId: 'a', share: 0.5, amountUsd: 50 },
        { rank: 2, agentId: 'b', share: 0.3, amountUsd: 30 },
        { rank: 3, agentId: 'c', share: 0.2, amountUsd: 20 },
      ],
    );
    // Winners carry the period trading metrics used for the decision.
    assert.deepEqual(
      result.winners.map((winner) => ({
        name: winner.name,
        tradingPnlUsd: winner.periodTradingPnlUsd,
        tradingPnlPct: winner.periodTradingPnlPct,
        capitalUsd: winner.capitalUsd,
        periodTrades: winner.periodTrades,
      })),
      [
        { name: 'Alpha', tradingPnlUsd: 8, tradingPnlPct: 0.08, capitalUsd: 100, periodTrades: 5 },
        { name: 'Beta', tradingPnlUsd: 5, tradingPnlPct: 0.05, capitalUsd: 100, periodTrades: 5 },
        { name: 'Gamma', tradingPnlUsd: 3, tradingPnlPct: 0.03, capitalUsd: 100, periodTrades: 5 },
      ],
    );

    // Exactly $100 of capital moved from the pool to the three agents; pool conserved.
    assert.equal(env.ledger.pool().poolUsd, 900);
    assert.equal(env.ledger.totalUsd(), totalBefore);
    assert.equal(env.ledger.cashOf('a'), 50);
    assert.equal(env.ledger.cashOf('b'), 30);
    assert.equal(env.ledger.cashOf('c'), 20);
    assert.equal(env.ledger.cashOf('d'), 0, '4th place is not paid');
    assert.equal(env.ledger.transfers.length, 3);
    assert.deepEqual(env.ledger.transfers[0], {
      fromId: TREASURY,
      toId: 'a',
      amountUsd: 50,
      reason: 'reward:2026-10-29',
      category: 'reward',
      at: T2,
    });
    // The ledger classifies the transfer as reward CAPITAL: rewards.js never touches P&L.
    assert.ok(env.ledger.transfers.every((entry) => entry.category === 'reward'));
    assert.ok(env.ledger.transfers.every((entry) => entry.reason === 'reward:2026-10-29'));

    // No double payment: the same key is never paid twice.
    assert.equal(env.rewards.duePeriod(T2), null, 'the anchor advanced to the new period');
    const again = await env.rewards.apply({
      due,
      rankings: snapshotOf(standardRows()),
      poolUsd: env.ledger.pool().poolUsd,
      allocationCapRemainingUsd: 1_000_000,
      ledger: env.ledger,
      nowMs: T2,
    });
    assert.equal(again.applied, false);
    assert.equal(again.reason, 'already_applied');
    assert.equal(again.winners.length, 0);
    assert.equal(env.ledger.pool().poolUsd, 900);
    assert.equal(env.rewards.status().historyCount, 1);

    const status = env.rewards.status();
    assert.equal(status.lastWinners.length, 3);
    assert.equal(status.lastWinners[0].periodKey, '2026-10-29');
    assert.equal(status.lastWinners[0].amountUsd, 50);
    assert.equal(status.lifetimeTotalUsd, 100);
    assert.equal(status.nextRunAt, new Date(Date.parse('2026-10-31T00:00:00Z')).toISOString());
  });

  it('enforces the eligibility thresholds: profit, positive return, trades, baseline', async () => {
    const env = await makeRewardsEnv({ poolUsd: 1000 });
    const rows = [
      tradingRow({ agentId: 'ok', name: 'OK', tradingPnlPct: 0.08, tradingPnlUsd: 8 }),
      tradingRow({ agentId: 'neg', name: 'Neg', tradingPnlPct: -0.02, tradingPnlUsd: -2 }),
      tradingRow({ agentId: 'flat', name: 'Flat', tradingPnlPct: 0, tradingPnlUsd: 5 }),
      tradingRow({ agentId: 'tiny', name: 'Tiny', tradingPnlPct: 0.0004, tradingPnlUsd: 0.04 }),
      tradingRow({ agentId: 'exact', name: 'Exact', tradingPnlPct: 0.0005, tradingPnlUsd: 0.05 }),
      tradingRow({ agentId: 'above', name: 'Above', tradingPnlPct: 0.0006, tradingPnlUsd: 0.06, periodTrades: 3 }),
      tradingRow({ agentId: 'few', name: 'Few', tradingPnlPct: 0.12, tradingPnlUsd: 12, periodTrades: 2 }),
      legacyRow({ agentId: 'legacy', name: 'Legacy' }),
    ];
    const result = await applyDue(env, { rows });
    assert.equal(result.skipped, false);
    assert.deepEqual(result.winners.map((winner) => winner.agentId), ['ok', 'above']);
    assert.deepEqual(result.winners.map((winner) => winner.amountUsd), [50, 30]);
    assert.equal(env.ledger.transfers.length, 2);
    assert.deepEqual(env.ledger.transfers.map((entry) => entry.toId), ['ok', 'above']);

    // The thresholds are settings (minTrades / minTradingProfitUsd), not hard-coded.
    const strict = await makeRewardsEnv({ poolUsd: 1000, settings: { period: 'daily', minTrades: 10 } });
    const strictResult = await applyDue(strict, { rows: standardRows() });
    assert.equal(strictResult.skipped, true);
    assert.equal(strictResult.reason, 'no_eligible_agents');

    const profit = await makeRewardsEnv({ poolUsd: 1000, settings: { period: 'daily', minTradingProfitUsd: 10 } });
    const profitResult = await applyDue(profit, { rows: standardRows() });
    assert.equal(profitResult.skipped, true);
    assert.equal(profitResult.reason, 'no_eligible_agents');
  });

  it('ranks by period trading RETURN (tie-break trading P&L dollars), not equity or size', async () => {
    const env = await makeRewardsEnv({ poolUsd: 1000 });
    const rows = [
      // $40 profit but only a 4% return ...
      tradingRow({ agentId: 'low', name: 'Low', tradingPnlPct: 0.04, tradingPnlUsd: 40, capitalUsd: 1000 }),
      // ... loses to a 10% return on a small book.
      tradingRow({ agentId: 'high', name: 'High', tradingPnlPct: 0.1, tradingPnlUsd: 100, capitalUsd: 1000 }),
      tradingRow({ agentId: 'mid', name: 'Mid', tradingPnlPct: 0.06, tradingPnlUsd: 60, capitalUsd: 1000 }),
    ];
    const result = await applyDue(env, { rows });
    assert.deepEqual(result.winners.map((winner) => winner.agentId), ['high', 'mid', 'low']);
    assert.deepEqual(result.winners.map((winner) => winner.rank), [1, 2, 3]);
    assert.deepEqual(result.winners.map((winner) => winner.amountUsd), [50, 30, 20]);

    // Exact return tie: higher period trading P&L dollars first (then deterministic name).
    const tieEnv = await makeRewardsEnv({ poolUsd: 1000 });
    const tieRows = [
      tradingRow({ agentId: 'x', name: 'Xavier', tradingPnlPct: 0.05, tradingPnlUsd: 30 }),
      tradingRow({ agentId: 'y', name: 'Yara', tradingPnlPct: 0.05, tradingPnlUsd: 50 }),
    ];
    const tie = await applyDue(tieEnv, { rows: tieRows });
    assert.deepEqual(tie.winners.map((winner) => winner.agentId), ['y', 'x']);
  });

  it('applies the drawdown gate from the risk views (row fallback), never rewarding high-variance luck', async () => {
    const env = await makeRewardsEnv({ poolUsd: 1000 });
    const rows = [
      tradingRow({ agentId: 'ok', name: 'OK', tradingPnlPct: 0.06, tradingPnlUsd: 6 }),
      // Row says fine, but the risk view says 25% drawdown -> ineligible.
      tradingRow({ agentId: 'riskfail', name: 'RiskFail', tradingPnlPct: 0.12, tradingPnlUsd: 12, drawdownPct: 0.1 }),
      // Row-level drawdown above the gate -> ineligible.
      tradingRow({ agentId: 'rowfail', name: 'RowFail', tradingPnlPct: 0.11, tradingPnlUsd: 11, drawdownPct: 0.25 }),
      // Exactly at the 20% gate -> eligible (<=).
      tradingRow({ agentId: 'edge', name: 'Edge', tradingPnlPct: 0.08, tradingPnlUsd: 8, drawdownPct: 0.2 }),
    ];
    const result = await applyDue(env, { rows, riskByAgent: { riskfail: { drawdownPct: 0.25 } } });
    assert.deepEqual(result.winners.map((winner) => winner.agentId), ['edge', 'ok']);
    assert.deepEqual(result.winners.map((winner) => winner.amountUsd), [50, 30]);

    // riskByAgent without a value falls back to the row's own drawdownPct.
    const fallbackEnv = await makeRewardsEnv({ poolUsd: 1000 });
    const fallbackRows = [
      tradingRow({ agentId: 'ok', name: 'OK', tradingPnlPct: 0.06, tradingPnlUsd: 6 }),
      tradingRow({ agentId: 'rowfail', name: 'RowFail', tradingPnlPct: 0.12, tradingPnlUsd: 12, drawdownPct: 0.25 }),
    ];
    const fallback = await applyDue(fallbackEnv, {
      rows: fallbackRows,
      riskByAgent: { rowfail: { drawdownPct: null } },
    });
    assert.deepEqual(fallback.winners.map((winner) => winner.agentId), ['ok']);

    // No drawdown measurement anywhere -> the gate is not applied.
    const openEnv = await makeRewardsEnv({ poolUsd: 1000 });
    const open = await applyDue(openEnv, {
      rows: [tradingRow({ agentId: 'ok', name: 'OK', tradingPnlPct: 0.06, tradingPnlUsd: 6, drawdownPct: null })],
    });
    assert.deepEqual(open.winners.map((winner) => winner.agentId), ['ok']);
  });

  it('skips equity-only rows as "no measured trading baseline" and never transfers', async () => {
    const env = await makeRewardsEnv({ poolUsd: 1000 });
    const result = await applyDue(env, {
      rows: [
        legacyRow({ agentId: 'atm-483016bc', name: 'GapFade META', pnlPct: 0.32, pnlUsd: 58.56 }),
        legacyRow({ agentId: 'old', name: 'Old Equities', pnlPct: 0.2, pnlUsd: 20 }),
      ],
    });
    assert.equal(result.applied, true);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'no_measured_trading_baseline');
    assert.equal(result.winners.length, 0);
    assert.equal(result.budgetUsd, 100);
    assert.equal(env.ledger.transfers.length, 0);
    assert.equal(env.ledger.pool().poolUsd, 1000);
    const history = env.rewards.getState().history;
    assert.equal(history.length, 1);
    assert.equal(history[0].skipped, true);
    assert.equal(history[0].reason, 'no_measured_trading_baseline');
    assert.equal(history[0].basis, 'trading-performance');
    assert.equal(history[0].budgetUsd, 100);
    assert.deepEqual(history[0].winners, []);
    // The period is consumed even when nothing was paid (no retry loop next tick).
    assert.equal(env.rewards.duePeriod(T2), null);
    assert.equal(env.rewards.status().lifetimeTotalUsd, 0);

    // Mixed measurable-but-ineligible vs empty leaderboard get distinct reasons.
    const measuredEnv = await makeRewardsEnv({ poolUsd: 1000 });
    const measured = await applyDue(measuredEnv, {
      rows: [tradingRow({ agentId: 'flat', name: 'Flat', tradingPnlPct: 0, tradingPnlUsd: 5 })],
    });
    assert.equal(measured.reason, 'no_eligible_agents');

    const emptyEnv = await makeRewardsEnv({ poolUsd: 1000 });
    const empty = await applyDue(emptyEnv, { rows: [] });
    assert.equal(empty.skipped, true);
    assert.equal(empty.reason, 'no_candidates');
    assert.equal(emptyEnv.ledger.transfers.length, 0);
  });

  it('skips with no_budget when the pool/allocation-cap/max-per-period allows nothing', async () => {
    const noPool = await makeRewardsEnv({ poolUsd: 0 });
    const noPoolResult = await applyDue(noPool, { rows: standardRows() });
    assert.equal(noPoolResult.applied, true);
    assert.equal(noPoolResult.skipped, true);
    assert.equal(noPoolResult.reason, 'no_budget');
    assert.equal(noPoolResult.budgetUsd, 0);
    assert.equal(noPoolResult.eligibleCount, 4, 'eligibility is reported even when the budget is empty');
    assert.equal(noPool.ledger.transfers.length, 0);
    assert.equal(noPool.rewards.getState().history[0].skipped, true);
    assert.equal(noPool.rewards.getState().history[0].reason, 'no_budget');

    const noAllocation = await makeRewardsEnv({ poolUsd: 1000 });
    const noAllocationResult = await applyDue(noAllocation, {
      rows: standardRows(),
      allocationCapRemainingUsd: 0,
    });
    assert.equal(noAllocationResult.skipped, true);
    assert.equal(noAllocationResult.reason, 'no_budget');
    assert.equal(noAllocation.ledger.transfers.length, 0);

    const noMax = await makeRewardsEnv({ poolUsd: 1000, settings: { period: 'daily', maxPerPeriodUsd: 0 } });
    const noMaxResult = await applyDue(noMax, { rows: standardRows() });
    assert.equal(noMaxResult.skipped, true);
    assert.equal(noMaxResult.reason, 'no_budget');
    assert.equal(noMaxResult.budgetUsd, 0);
  });

  it('caps the budget by pool share, maxPerPeriodUsd, allocation cap and the pool itself', async () => {
    const shortPool = await makeRewardsEnv({ poolUsd: 250 });
    const shortResult = await applyDue(shortPool, { rows: standardRows() });
    assert.equal(shortResult.budgetUsd, 25);
    assert.deepEqual(shortResult.winners.map((winner) => winner.amountUsd), [12.5, 7.5, 5]);
    assert.equal(shortPool.ledger.pool().poolUsd, 225);

    const perPeriod = await makeRewardsEnv({ poolUsd: 1000, settings: { period: 'daily', maxPerPeriodUsd: 40 } });
    const perPeriodResult = await applyDue(perPeriod, { rows: standardRows() });
    assert.equal(perPeriodResult.budgetUsd, 40);
    assert.deepEqual(perPeriodResult.winners.map((winner) => winner.amountUsd), [20, 12, 8]);
    assert.equal(perPeriod.ledger.pool().poolUsd, 960);

    const allocation = await makeRewardsEnv({ poolUsd: 1000 });
    const allocationResult = await applyDue(allocation, {
      rows: standardRows(),
      allocationCapRemainingUsd: 30,
    });
    assert.equal(allocationResult.budgetUsd, 30);
    assert.deepEqual(allocationResult.winners.map((winner) => winner.amountUsd), [15, 9, 6]);
    assert.equal(allocation.ledger.pool().poolUsd, 970);

    // Never exceeds the pool: 10% of $5 -> $0.50 budget, floored to cents per winner.
    const tinyPool = await makeRewardsEnv({ poolUsd: 5 });
    const tinyResult = await applyDue(tinyPool, { rows: standardRows() });
    assert.equal(tinyResult.budgetUsd, 0.5);
    assert.deepEqual(tinyResult.winners.map((winner) => winner.amountUsd), [0.25, 0.15, 0.1]);
    assert.equal(tinyPool.ledger.pool().poolUsd, 4.5);
  });

  it('caps a single reward at 50% of the agent capital and floors cents', async () => {
    const env = await makeRewardsEnv({ poolUsd: 1000 });
    const rows = [
      // $20 capital -> $10 per-agent cap, below its $50 rank share.
      tradingRow({ agentId: 'a', name: 'Alpha', tradingPnlPct: 0.1, tradingPnlUsd: 5, capitalUsd: 20 }),
      tradingRow({ agentId: 'b', name: 'Beta', tradingPnlPct: 0.08, tradingPnlUsd: 8, capitalUsd: 1000 }),
      tradingRow({ agentId: 'c', name: 'Gamma', tradingPnlPct: 0.06, tradingPnlUsd: 6, capitalUsd: 1000 }),
    ];
    const result = await applyDue(env, { rows });
    assert.equal(result.budgetUsd, 100);
    assert.deepEqual(result.winners.map((winner) => winner.amountUsd), [10, 30, 20]);
    // The cap leaves budget unspent (no redistribution); total never exceeds the budget.
    assert.equal(result.winners.reduce((sum, winner) => sum + winner.amountUsd, 0), 60);
    assert.equal(env.ledger.pool().poolUsd, 940);
    assert.equal(result.winners[0].capitalUsd, 20);
  });

  it('scales winners proportionally when shares would exceed the budget (legacy percentages)', async () => {
    // Deprecated v3.2 settings are mapped to rank shares; a legacy set may sum to > 1,
    // in which case the allocation is scaled down to the budget instead of overpaying.
    const env = await makeRewardsEnv({
      poolUsd: 1000,
      settings: { period: 'daily', basis: 'account-cash', rankPercents: [0.4, 0.4, 0.4] },
    });
    const rows = [
      tradingRow({ agentId: 'a', name: 'Alpha', tradingPnlPct: 0.1, tradingPnlUsd: 10, capitalUsd: 1000 }),
      tradingRow({ agentId: 'b', name: 'Beta', tradingPnlPct: 0.08, tradingPnlUsd: 8, capitalUsd: 1000 }),
      tradingRow({ agentId: 'c', name: 'Gamma', tradingPnlPct: 0.06, tradingPnlUsd: 6, capitalUsd: 1000 }),
    ];
    const result = await applyDue(env, { rows });
    assert.equal(result.budgetUsd, 100);
    assert.deepEqual(result.winners.map((winner) => winner.amountUsd), [33.33, 33.33, 33.33]);
    assert.ok(result.winners.reduce((sum, winner) => sum + winner.amountUsd, 0) <= result.budgetUsd);
    assert.equal(env.ledger.pool().poolUsd, 900.01);
    assert.deepEqual(result.winners.map((winner) => winner.share), [0.4, 0.4, 0.4]);

    // Scale first, then the per-agent capital cap.
    const cappedEnv = await makeRewardsEnv({
      poolUsd: 1000,
      settings: { period: 'daily', rankShares: [0.4, 0.4, 0.4] },
    });
    const cappedRows = [
      tradingRow({ agentId: 'a', name: 'Alpha', tradingPnlPct: 0.1, tradingPnlUsd: 5, capitalUsd: 40 }),
      tradingRow({ agentId: 'b', name: 'Beta', tradingPnlPct: 0.08, tradingPnlUsd: 8, capitalUsd: 1000 }),
      tradingRow({ agentId: 'c', name: 'Gamma', tradingPnlPct: 0.06, tradingPnlUsd: 6, capitalUsd: 1000 }),
    ];
    const capped = await applyDue(cappedEnv, { rows: cappedRows });
    // a: scaled 33.33 but capped at 50% of $40 = $20.
    assert.deepEqual(capped.winners.map((winner) => winner.amountUsd), [20, 33.33, 33.33]);
  });

  it('records history + lifetime and exposes per-agent chronological reward history', async () => {
    const env = await makeRewardsEnv({ poolUsd: 1000 });
    const first = await applyDue(env, { rows: standardRows() });
    assert.equal(first.skipped, false);

    const history = env.rewards.getState().history;
    assert.equal(history.length, 1);
    assert.equal(history[0].period, 'daily');
    assert.equal(history[0].periodKey, '2026-10-29');
    assert.equal(history[0].at, new Date(T2).toISOString());
    assert.equal(history[0].basis, 'trading-performance');
    assert.equal(history[0].budgetUsd, 100);
    assert.deepEqual(history[0].winners[0], {
      rank: 1,
      agentId: 'a',
      name: 'Alpha',
      amountUsd: 50,
      share: 0.5,
      periodTradingPnlUsd: 8,
      periodTradingPnlPct: 0.08,
      capitalUsd: 100,
      periodTrades: 5,
    });

    assert.equal(env.rewards.lifetimeForAgent('a'), 50);
    assert.equal(env.rewards.lifetimeForAgent('b'), 30);
    assert.equal(env.rewards.lifetimeForAgent('c'), 20);
    assert.equal(env.rewards.lifetimeForAgent('nobody'), 0);
    assert.equal(env.rewards.status().lifetimeTotalUsd, 100);
    assert.deepEqual(env.rewards.historyForAgent('a'), [{
      period: 'daily',
      periodKey: '2026-10-29',
      at: new Date(T2).toISOString(),
      rank: 1,
      amountUsd: 50,
      share: 0.5,
      periodTradingPnlUsd: 8,
      periodTradingPnlPct: 0.08,
      capitalUsd: 100,
      periodTrades: 5,
    }]);
    assert.deepEqual(env.rewards.historyForAgent('nobody'), []);

    // Second completed period: the pool shrank to $900, so the budget is $90 again paid
    // as 45/27/18; lifetime accumulates and history is chronological.
    env.clock.set(T3);
    const second = await applyDue(env, { rows: standardRows(), nowMs: T3 });
    assert.equal(second.periodKey, '2026-10-30');
    assert.equal(second.budgetUsd, 90);
    assert.deepEqual(second.winners.map((winner) => winner.amountUsd), [45, 27, 18]);
    assert.equal(env.rewards.lifetimeForAgent('a'), 95);
    assert.equal(env.rewards.lifetimeForAgent('b'), 57);
    assert.equal(env.rewards.lifetimeForAgent('c'), 38);
    assert.equal(env.rewards.status().lifetimeTotalUsd, 190);
    assert.equal(env.rewards.status().lastPeriodKey, '2026-10-31');
    const rowsForA = env.rewards.historyForAgent('a');
    assert.equal(rowsForA.length, 2);
    assert.deepEqual(rowsForA.map((row) => row.periodKey), ['2026-10-29', '2026-10-30']);
    assert.equal(rowsForA.at(-1).at, new Date(T3).toISOString());
    assert.equal(rowsForA.at(-1).amountUsd, 45);

    // Persisted state reloads with the same lifetime/history.
    const reloaded = createRewards({
      paths: { rewardsFile: env.rewardsFile },
      config: { rewards: { period: 'daily' } },
      clock: env.clock,
    });
    await reloaded.load();
    assert.equal(reloaded.status().historyCount, 2);
    assert.equal(reloaded.lifetimeForAgent('a'), 95);
    assert.equal(reloaded.status().lifetimeTotalUsd, 190);
    assert.deepEqual(reloaded.historyForAgent('a').map((row) => row.periodKey), ['2026-10-29', '2026-10-30']);
    const persisted = JSON.parse(fs.readFileSync(env.rewardsFile, 'utf8'));
    assert.equal(persisted.version, 2);
    assert.deepEqual(persisted.lifetime, { a: 95, b: 57, c: 38 });
  });

  it('seeds the lifetime map from legacy v3.2 history on load (live W44/W45 reward state)', async () => {
    const dir = makeTempDir('rewards-live');
    const rewardsFile = path.join(dir, 'rewards.json');
    const live = {
      version: 1,
      lastPeriodKey: '2026-W47',
      lastRunAt: '2026-11-20T00:00:00.000Z',
      nextRunAt: '2026-11-23T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
      lastWinners: [
        { rank: 1, agentId: 'atm-w45a', name: 'Wave', percent: 0.05, amountUsd: 6.04, periodKey: '2026-W45', at: '2026-11-13T00:00:00.000Z' },
        { rank: 2, agentId: 'atm-w45b', name: 'Rider', percent: 0.03, amountUsd: 3.62, periodKey: '2026-W45', at: '2026-11-13T00:00:00.000Z' },
        { rank: 3, agentId: 'atm-w45c', name: 'Drift', percent: 0.02, amountUsd: 2.41, periodKey: '2026-W45', at: '2026-11-13T00:00:00.000Z' },
      ],
      history: [
        {
          period: 'weekly',
          periodKey: '2026-W44',
          at: '2026-11-06T00:00:00.000Z',
          winners: [
            { rank: 1, agentId: 'atm-483016bc', name: 'GapFade META', percent: 0.05, amountUsd: 58.56 },
            { rank: 2, agentId: 'atm-w44b', name: 'Momentum NVDA', percent: 0.03, amountUsd: 35.13 },
            { rank: 3, agentId: 'atm-w44c', name: 'Breakout TSLA', percent: 0.02, amountUsd: 23.42 },
          ],
        },
        {
          period: 'weekly',
          periodKey: '2026-W45',
          at: '2026-11-13T00:00:00.000Z',
          winners: [
            { rank: 1, agentId: 'atm-w45a', name: 'Wave', percent: 0.05, amountUsd: 6.04 },
            { rank: 2, agentId: 'atm-w45b', name: 'Rider', percent: 0.03, amountUsd: 3.62 },
            { rank: 3, agentId: 'atm-w45c', name: 'Drift', percent: 0.02, amountUsd: 2.41 },
          ],
        },
      ],
    };
    fs.writeFileSync(rewardsFile, JSON.stringify(live), 'utf8');
    const clock = makeClock(Date.parse('2026-11-21T00:00:00Z')); // Saturday of ISO week 47
    const rewards = createRewards({
      paths: { rewardsFile },
      config: { rewards: { period: 'weekly' } },
      clock,
    });
    await rewards.load();

    assert.equal(rewards.status().lastPeriodKey, '2026-W47');
    assert.equal(rewards.status().nextRunAt, '2026-11-23T00:00:00.000Z');
    // Cumulative lifetime seeded from ALL retained history winners; lastWinners for W45
    // is not double-counted (deduped by periodKey+agent).
    assert.equal(rewards.lifetimeForAgent('atm-483016bc'), 58.56);
    assert.equal(rewards.lifetimeForAgent('atm-w44b'), 35.13);
    assert.equal(rewards.lifetimeForAgent('atm-w44c'), 23.42);
    assert.equal(rewards.lifetimeForAgent('atm-w45a'), 6.04);
    assert.equal(rewards.lifetimeForAgent('atm-w45b'), 3.62);
    assert.equal(rewards.lifetimeForAgent('atm-w45c'), 2.41);
    assert.equal(rewards.status().lifetimeTotalUsd, 129.18);
    assert.equal(rewards.getState().history.length, 2);
    // Legacy winners had `percent`: it is surfaced as `share`; trading metrics are null.
    assert.deepEqual(rewards.historyForAgent('atm-483016bc'), [{
      period: 'weekly',
      periodKey: '2026-W44',
      at: '2026-11-06T00:00:00.000Z',
      rank: 1,
      amountUsd: 58.56,
      share: 0.05,
      periodTradingPnlUsd: null,
      periodTradingPnlPct: null,
      capitalUsd: null,
      periodTrades: null,
    }]);

    // First v3.3 payout (W47) on legacy equity-only rankings: skipped, not rewarded on
    // equity, and the historical lifetime is untouched.
    clock.set(Date.parse('2026-11-23T00:05:00Z'));
    const due = rewards.duePeriod(clock.now());
    assert.deepEqual(due, {
      period: 'weekly',
      periodKey: '2026-W47',
      completed: true,
      currentPeriodKey: '2026-W48',
    });
    const ledger = makeStubLedger({ startingPoolUsd: 1000 });
    const result = await rewards.apply({
      due,
      rankings: snapshotOf([legacyRow({ agentId: 'atm-483016bc', name: 'GapFade META' })], 'weekly'),
      poolUsd: ledger.pool().poolUsd,
      allocationCapRemainingUsd: 1_000_000,
      ledger,
      nowMs: clock.now(),
    });
    assert.equal(result.applied, true);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'no_measured_trading_baseline');
    assert.equal(result.winners.length, 0);
    assert.equal(ledger.transfers.length, 0);
    assert.equal(rewards.lifetimeForAgent('atm-483016bc'), 58.56);
    const state = rewards.getState();
    assert.equal(state.history.length, 3);
    assert.equal(state.history[2].periodKey, '2026-W47');
    assert.equal(state.history[2].skipped, true);
    assert.equal(state.history[2].basis, 'trading-performance');
    assert.equal(state.history[2].budgetUsd, 100);
    // New fields persist (version 2 + lifetime map) so the next load keeps the totals.
    const persisted = JSON.parse(fs.readFileSync(rewardsFile, 'utf8'));
    assert.equal(persisted.version, 2);
    assert.equal(persisted.lifetime['atm-483016bc'], 58.56);
    assert.equal(persisted.lifetime['atm-w45c'], 2.41);

    // A persisted lifetime counter wins over the retained-history sum (history is capped).
    const overrideDir = makeTempDir('rewards-lifetime-override');
    const overrideFile = path.join(overrideDir, 'rewards.json');
    fs.writeFileSync(overrideFile, JSON.stringify({
      version: 2,
      lastPeriodKey: '2026-W44',
      history: [{ period: 'weekly', periodKey: '2026-W44', at: '2026-11-06T00:00:00.000Z', basis: 'trading-performance', budgetUsd: 100, winners: [{ rank: 1, agentId: 'atm-a', name: 'A', amountUsd: 10, share: 0.5 }] }],
      lifetime: { 'atm-a': 100 },
    }), 'utf8');
    const override = createRewards({ paths: { rewardsFile: overrideFile }, config: { rewards: { period: 'weekly' } }, clock: makeClock(T1) });
    await override.load();
    assert.equal(override.lifetimeForAgent('atm-a'), 100);
  });

  it('maps deprecated v3.2 settings and validates the v3.3 defaults', async () => {
    assert.deepEqual({ ...REWARD_DEFAULTS, rankShares: [...REWARD_DEFAULTS.rankShares] }, EXPECTED_DEFAULT_SETTINGS);
    assert.deepEqual(resolveRewardSettings({}), EXPECTED_DEFAULT_SETTINGS);
    // The shipped config defaults are the v3.3 recommended rules, and the deprecated
    // rankPercents default in config.js does not override the new rankShares.
    const dir = makeTempDir('rewards-config-defaults');
    assert.deepEqual(resolveRewardSettings(makeConfig(dir)), EXPECTED_DEFAULT_SETTINGS);

    // Deprecated names are accepted only as legacy input and mapped away.
    assert.deepEqual(
      resolveRewardSettings({ rewards: { rankPercents: [0.1, 0.05, 0.02], basis: 'account-cash', period: 'weekly' } }),
      { ...EXPECTED_DEFAULT_SETTINGS, rankShares: [0.1, 0.05, 0.02] },
    );
    // New names win when both are present.
    assert.deepEqual(
      resolveRewardSettings({
        rewards: { rankShares: [0.6, 0.25, 0.15], rankPercents: [0.1, 0.05, 0.02], basis: 'account-cash' },
      }),
      { ...EXPECTED_DEFAULT_SETTINGS, rankShares: [0.6, 0.25, 0.15] },
    );
    // Malformed values fall back rather than throwing (config validation is the Lead's).
    assert.deepEqual(
      resolveRewardSettings({
        rewards: {
          period: 'hourly',
          rankShares: [0.9],
          rankPercents: [0.9],
          basis: 'x',
          maxPerPeriodUsd: -1,
          minTrades: -2,
          minTradingProfitUsd: 'x',
          maxDrawdownPct: 2,
        },
      }),
      EXPECTED_DEFAULT_SETTINGS,
    );
    // Explicit v3.3 overrides resolve.
    assert.deepEqual(
      resolveRewardSettings({
        rewards: {
          minTrades: 5,
          minTradingProfitUsd: 1,
          maxDrawdownPct: 0.1,
          rewardBudgetPctOfPool: 0.25,
          maxRewardPerAgentPctOfCapital: 0.25,
          maxPerPeriodUsd: 50,
        },
      }),
      {
        ...EXPECTED_DEFAULT_SETTINGS,
        minTrades: 5,
        minTradingProfitUsd: 1,
        maxDrawdownPct: 0.1,
        rewardBudgetPctOfPool: 0.25,
        maxRewardPerAgentPctOfCapital: 0.25,
        maxPerPeriodUsd: 50,
      },
    );

    // Live reconfigure re-resolves and re-anchors instead of paying a partial period.
    const env = await makeRewardsEnv({ poolUsd: 1000 });
    const reconfigured = env.rewards.reconfigure({
      rewards: { period: 'weekly', rankShares: [0.6, 0.25, 0.15], maxPerPeriodUsd: 500 },
    });
    assert.equal(reconfigured.period, 'weekly');
    assert.deepEqual(reconfigured.rankShares, [0.6, 0.25, 0.15]);
    assert.equal(reconfigured.maxPerPeriodUsd, 500);
    assert.equal(reconfigured.lastPeriodKey, '2026-W44');
    assert.equal(env.rewards.duePeriod(T2), null, 'reconfiguring re-anchors instead of paying a partial period');
  });

  it('exposes status/rules/explain and a describe() view for the control panel', async () => {
    const env = await makeRewardsEnv({ poolUsd: 1000 });
    const status = env.rewards.status();
    assert.equal(status.enabled, true);
    assert.equal(status.period, 'daily');
    assert.equal(status.basis, 'trading-performance');
    assert.deepEqual(status.rankShares, [0.5, 0.3, 0.2]);
    assert.equal(status.rewardBudgetPctOfPool, 0.1);
    assert.equal(status.maxPerPeriodUsd, null);
    assert.equal(status.maxRewardPerAgentPctOfCapital, 0.5);
    assert.equal(status.minTradingProfitUsd, 0.05);
    assert.equal(status.minTrades, 3);
    assert.equal(status.maxDrawdownPct, 0.2);
    assert.deepEqual(status.rules.rankShares, [0.5, 0.3, 0.2]);
    assert.equal(status.rules.basis, 'trading-performance');
    assert.equal(status.rules.period, 'daily');
    assert.ok(Array.isArray(status.rules.explain));
    assert.ok(status.rules.explain.length >= 5);
    assert.ok(status.rules.explain.every((line) => typeof line === 'string' && line.length > 10));
    assert.deepEqual(status.explain, status.rules.explain);
    assert.equal(status.lifetimeTotalUsd, 0);

    const described = env.rewards.describe();
    assert.equal(described.role, 'rewards');
    assert.equal(described.version, 2);
    assert.deepEqual(described.rules.rankShares, [0.5, 0.3, 0.2]);
    assert.deepEqual(described.history, []);
    assert.deepEqual(described.lifetime, {});
    assert.ok(String(described.path).endsWith('rewards.json'));

    await applyDue(env, { rows: standardRows() });
    const after = env.rewards.status();
    assert.equal(after.lifetimeTotalUsd, 100);
    assert.equal(after.lastWinners.length, 3);
    assert.equal(after.lastWinners[0].periodKey, '2026-10-29');
    assert.equal(after.lastWinners[0].amountUsd, 50);
    assert.equal(env.rewards.describe().history.length, 1);
    assert.equal(env.rewards.describe().lifetime.a, 50);
  });

  it('keeps the last 50 history entries and preserves lifetime across reloads', async () => {
    const env = await makeRewardsEnv({ poolUsd: 1000 });
    await applyDue(env, { rows: standardRows() });
    assert.equal(env.rewards.status().historyCount, 1);
    assert.equal(env.rewards.lifetimeForAgent('a'), 50);
    let prevKey = env.rewards.status().lastPeriodKey;
    for (let i = 0; i < 55; i += 1) {
      const currentKey = `synthetic-${String(i).padStart(3, '0')}`;
      const due = { period: 'daily', periodKey: prevKey, completed: true, currentPeriodKey: currentKey };
      // Empty leaderboard: records skipped history without moving money.
      // eslint-disable-next-line no-await-in-loop
      const padded = await env.rewards.apply({
        due,
        rankings: snapshotOf([]),
        poolUsd: 1000,
        allocationCapRemainingUsd: 1_000_000,
        ledger: env.ledger,
        nowMs: T2 + (i + 1) * 1000,
      });
      assert.equal(padded.applied, true);
      assert.equal(padded.skipped, true);
      assert.equal(padded.reason, 'no_candidates');
      prevKey = currentKey;
    }
    assert.equal(env.rewards.status().historyCount, REWARD_HISTORY_LIMIT);
    assert.equal(env.rewards.getState().history.length, REWARD_HISTORY_LIMIT);
    // History entries record the COMPLETED key; the anchor is the current one.
    assert.equal(env.rewards.getState().history.at(-1).periodKey, 'synthetic-053');
    assert.equal(env.rewards.status().lastPeriodKey, 'synthetic-054');
    assert.equal(env.rewards.status().lastWinners.length, 0);
    // Lifetime survives even though the real payout aged out of the 50-entry history.
    assert.equal(env.rewards.lifetimeForAgent('a'), 50);
    assert.equal(env.rewards.status().lifetimeTotalUsd, 100);

    const persisted = JSON.parse(fs.readFileSync(env.rewardsFile, 'utf8'));
    assert.equal(persisted.history.length, REWARD_HISTORY_LIMIT);
    assert.equal(persisted.lifetime.a, 50);
    const reloaded = createRewards({
      paths: { rewardsFile: env.rewardsFile },
      config: { rewards: { period: 'daily' } },
      clock: env.clock,
    });
    await reloaded.load();
    assert.equal(reloaded.getState().history.length, REWARD_HISTORY_LIMIT);
    assert.equal(reloaded.lifetimeForAgent('a'), 50);
    assert.equal(reloaded.status().lifetimeTotalUsd, 100);
  });

  it('disabled rewards never pay, never report a due period and never touch the pool', async () => {
    const env = await makeRewardsEnv({ poolUsd: 1000, settings: { enabled: false } });
    env.clock.set(T2);
    assert.equal(env.rewards.duePeriod(T2), null);
    const status = env.rewards.status();
    assert.equal(status.enabled, false);
    const result = await env.rewards.apply({
      due: { period: 'daily', periodKey: '2026-10-29', completed: true, currentPeriodKey: '2026-10-30' },
      rankings: snapshotOf(standardRows()),
      poolUsd: 1000,
      allocationCapRemainingUsd: 1_000_000,
      ledger: env.ledger,
      nowMs: T2,
    });
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'disabled');
    assert.equal(result.skipped, true);
    assert.equal(result.basis, 'trading-performance');
    assert.equal(result.winners.length, 0);
    assert.equal(env.rewards.status().historyCount, 0);
    assert.equal(env.ledger.transfers.length, 0);
    assert.equal(env.ledger.pool().poolUsd, 1000);
  });

  it('weekly and monthly periods boundary on the ISO week / UTC month', async () => {
    const weeklyEnv = await makeRewardsEnv({ settings: { period: 'weekly' }, poolUsd: 1000 });
    assert.equal(weeklyEnv.rewards.status().lastPeriodKey, '2026-W44');
    assert.equal(weeklyEnv.rewards.status().nextRunAt, new Date(Date.parse('2026-11-02T00:00:00Z')).toISOString());
    // Thursday -> Friday is not a weekly boundary.
    weeklyEnv.clock.set(T2);
    assert.equal(weeklyEnv.rewards.duePeriod(T2), null);
    const monday = Date.parse('2026-11-02T00:05:00Z');
    weeklyEnv.clock.set(monday);
    const due = weeklyEnv.rewards.duePeriod(monday);
    assert.deepEqual(due, {
      period: 'weekly',
      periodKey: '2026-W44',
      completed: true,
      currentPeriodKey: '2026-W45',
    });
    const result = await weeklyEnv.rewards.apply({
      due,
      rankings: snapshotOf([tradingRow({ agentId: 'a', name: 'Alpha', tradingPnlPct: 0.08, tradingPnlUsd: 8 })], 'weekly'),
      poolUsd: weeklyEnv.ledger.pool().poolUsd,
      allocationCapRemainingUsd: 1_000_000,
      ledger: weeklyEnv.ledger,
      nowMs: monday,
    });
    assert.equal(result.period, 'weekly');
    assert.equal(result.periodKey, '2026-W44');
    assert.equal(result.budgetUsd, 100);
    assert.equal(result.winners.length, 1);
    assert.equal(result.winners[0].amountUsd, 50);
    assert.equal(weeklyEnv.rewards.status().nextRunAt, new Date(Date.parse('2026-11-09T00:00:00Z')).toISOString());

    // Monthly boundary: 2026-11-01T00:00Z.
    const monthlyEnv = await makeRewardsEnv({ settings: { period: 'monthly' }, poolUsd: 1000 });
    assert.equal(monthlyEnv.rewards.status().lastPeriodKey, '2026-10');
    assert.equal(monthlyEnv.rewards.status().nextRunAt, new Date(Date.parse('2026-11-01T00:00:00Z')).toISOString());
    monthlyEnv.clock.set(Date.parse('2026-11-01T00:05:00Z'));
    const monthlyDue = monthlyEnv.rewards.duePeriod(Date.parse('2026-11-01T00:05:00Z'));
    assert.equal(monthlyDue.period, 'monthly');
    assert.equal(monthlyDue.periodKey, '2026-10');
  });

  it('hydrate() adopts a swapped instance state so history/lifetime/anchor survive', async () => {
    const env = await makeRewardsEnv({ poolUsd: 1000 });
    await applyDue(env, { rows: standardRows() });
    const replacement = createRewards({
      paths: { rewardsFile: path.join(env.dir, 'rewards-replacement.json') },
      config: { rewards: { period: 'daily' } },
      clock: env.clock,
    });
    await replacement.load();
    assert.equal(replacement.status().historyCount, 0);
    replacement.hydrate(env.rewards.getState());
    assert.equal(replacement.status().historyCount, 1);
    assert.equal(replacement.lifetimeForAgent('a'), 50);
    assert.equal(replacement.status().lastPeriodKey, '2026-10-30');
    // A rewards instance is accepted too (orchestrator hand-off).
    const second = createRewards({
      paths: { rewardsFile: path.join(env.dir, 'rewards-second.json') },
      config: { rewards: { period: 'daily' } },
      clock: env.clock,
    });
    await second.load();
    second.hydrate(env.rewards);
    assert.equal(second.lifetimeForAgent('a'), 50);
    assert.equal(second.status().historyCount, 1);
  });

  it('pays the archived completed period from stored trading baselines after a rollover', async () => {
    async function makeStoredEnv() {
      const dir = makeTempDir('rewards-stored');
      const clock = makeClock(T1);
      const config = makeConfig(dir, { rewards: { period: 'daily' } });
      const paths = statePaths(config);
      const rankings = createRankings({ paths, config, clock });
      await rankings.load();
      await rankings.record({
        atMs: T1,
        equityByAgent: {
          a: { name: 'Alpha', equityUsd: 100, trades: 1, tradingPlUsd: 0, capitalUsd: 100 },
          b: { name: 'Beta', equityUsd: 100, trades: 1, tradingPlUsd: 0, capitalUsd: 100 },
        },
      });
      await rankings.record({
        atMs: T1 + 11 * HOUR,
        equityByAgent: {
          a: { name: 'Alpha', equityUsd: 108, trades: 5, tradingPlUsd: 8, capitalUsd: 100 },
          b: { name: 'Beta', equityUsd: 104, trades: 4, tradingPlUsd: 4, capitalUsd: 100 },
        },
      });
      const rewards = createRewards({ paths, config, clock });
      await rewards.load(); // anchors the initial partial day at 2026-10-29
      const ledger = makeStubLedger({ startingPoolUsd: 1000 });
      return { dir, clock, config, paths, rankings, rewards, ledger };
    }

    // (a) The new period was already recorded by a previous tick: the completed day is
    // archived; stored:true at its last instant exposes the archived trading fields.
    const env = await makeStoredEnv();
    env.clock.set(T2);
    await env.rankings.record({
      atMs: T2,
      equityByAgent: {
        a: { name: 'Alpha', equityUsd: 112, trades: 7, tradingPlUsd: 12, capitalUsd: 100 },
        b: { name: 'Beta', equityUsd: 106, trades: 5, tradingPlUsd: 5, capitalUsd: 100 },
      },
    });
    const completed = env.rankings.compute({ atMs: DAY_END - 1, stored: true });
    const completedById = agentsById(completed.periods.daily);
    assert.equal(completedById.a.tradingPnlUsd, 8);
    assert.equal(completedById.a.tradingPnlPct, 0.08);
    assert.equal(completedById.a.periodTrades, 4);
    assert.equal(completedById.a.baselineTradingPlUsd, 0);
    assert.equal(completedById.a.baselineCapitalUsd, 100);
    assert.equal(completedById.b.tradingPnlUsd, 4);
    assert.equal(completedById.b.periodTrades, 3);

    const due = env.rewards.duePeriod(T2);
    assert.deepEqual(due, {
      period: 'daily',
      periodKey: '2026-10-29',
      completed: true,
      currentPeriodKey: '2026-10-30',
    });
    // Passing the rankings MODULE makes rewards.js resolve the completed snapshot itself.
    const result = await env.rewards.apply({
      due,
      rankings: env.rankings,
      poolUsd: env.ledger.pool().poolUsd,
      allocationCapRemainingUsd: 1_000_000,
      ledger: env.ledger,
      nowMs: T2,
    });
    assert.equal(result.skipped, false);
    assert.equal(result.budgetUsd, 100);
    assert.deepEqual(result.winners.map((winner) => winner.agentId), ['a', 'b']);
    assert.deepEqual(result.winners.map((winner) => winner.amountUsd), [50, 30]);
    assert.deepEqual(result.winners.map((winner) => winner.periodTradingPnlUsd), [8, 4]);
    assert.deepEqual(result.winners.map((winner) => winner.periodTradingPnlPct), [0.08, 0.04]);
    assert.equal(env.ledger.pool().poolUsd, 920);
    assert.deepEqual(env.ledger.transfers.map((entry) => entry.reason), ['reward:2026-10-29', 'reward:2026-10-29']);

    // (b) The payout runs BEFORE the new period's first record (normal tick order): the
    // stored current-period baseline still measures the completed day.
    const preRollover = await makeStoredEnv();
    preRollover.clock.set(T2);
    const beforeRecordDue = preRollover.rewards.duePeriod(T2);
    const beforeRecord = await preRollover.rewards.apply({
      due: beforeRecordDue,
      rankings: preRollover.rankings,
      poolUsd: preRollover.ledger.pool().poolUsd,
      allocationCapRemainingUsd: 1_000_000,
      ledger: preRollover.ledger,
      nowMs: T2,
    });
    assert.equal(beforeRecord.skipped, false);
    assert.deepEqual(beforeRecord.winners.map((winner) => winner.agentId), ['a', 'b']);
    assert.deepEqual(beforeRecord.winners.map((winner) => winner.periodTradingPnlUsd), [8, 4]);
    assert.equal(preRollover.ledger.pool().poolUsd, 920);
  });

  it('skips the completed period end-to-end when the real rankings only has equity history', async () => {
    const dir = makeTempDir('rewards-legacy-rankings');
    const clock = makeClock(T1);
    const config = makeConfig(dir, { rewards: { period: 'daily' } });
    const paths = statePaths(config);
    const rankings = createRankings({ paths, config, clock });
    await rankings.load();
    // v3.2-style observations: an equity jump from a reward payout, no trading marks.
    await rankings.record({
      atMs: T1,
      equityByAgent: { a: { name: 'GapFade META', equityUsd: 48.3, trades: 5 } },
    });
    await rankings.record({
      atMs: T1 + 11 * HOUR,
      equityByAgent: { a: { name: 'GapFade META', equityUsd: 106.86, trades: 9 } },
    });
    const rewards = createRewards({ paths, config, clock });
    await rewards.load();
    const ledger = makeStubLedger({ startingPoolUsd: 1000 });
    clock.set(T2);
    const due = rewards.duePeriod(T2);
    const result = await rewards.apply({
      due,
      rankings,
      poolUsd: ledger.pool().poolUsd,
      allocationCapRemainingUsd: 1_000_000,
      ledger,
      nowMs: T2,
    });
    assert.equal(result.applied, true);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'no_measured_trading_baseline');
    assert.equal(result.winners.length, 0);
    assert.equal(ledger.transfers.length, 0);
    assert.equal(ledger.pool().poolUsd, 1000);
    const entry = rewards.getState().history.at(-1);
    assert.equal(entry.skipped, true);
    assert.equal(entry.reason, 'no_measured_trading_baseline');
    assert.equal(entry.winners.length, 0);
    assert.equal(rewards.status().lifetimeTotalUsd, 0);
  });

  it('rejects apply() without the due period or a transfer-capable ledger', async () => {
    const env = await makeRewardsEnv({ poolUsd: 1000 });
    await assert.rejects(
      env.rewards.apply({ due: null, rankings: snapshotOf(standardRows()), ledger: env.ledger, nowMs: T2 }),
      (error) => error.code === 'CONFIG_INVALID',
    );
    const due = env.rewards.duePeriod(T2);
    await assert.rejects(
      env.rewards.apply({ due, rankings: snapshotOf(standardRows()), poolUsd: 1000, nowMs: T2 }),
      (error) => error.code === 'CONFIG_INVALID',
    );
  });
});
