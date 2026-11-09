/**
 * test/control.test.js — Lead-owned verification for the operator control-panel engine work:
 * research schedule modes + live reconfigure, settings overlay persistence, leaderboards, rewards
 * payouts (period boundary, once-per-period, caps), strategy plans, transactions and engine status.
 *
 * Run directly (the sandbox blocks `node --test <file>`):
 *   cd packages/automaton-trading && node test/control.test.js
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, statePaths } from '../src/config.js';
import { timeframeToMs } from '../src/util.js';
import { explainAgentPlan } from '../src/strategy-explain.js';
import { createBroker as createSimBroker } from '../src/broker-sim.js';
import { createAutomaton } from '../src/orchestrator.js';
import { createResearcher } from '../src/research.js';
import { createEngine } from '../src/engine.js';
import { createLedger } from '../src/ledger.js';
import { createRegistry } from '../src/registry.js';

const HOUR = 60 * 60 * 1000;

function makeClock(startMs) {
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
  };
}

function tempConfig(dir, overrides = {}) {
  return loadConfig({
    configFile: path.join(dir, 'missing.config.json'),
    envFile: path.join(dir, 'missing.env'),
    overrides: {
      mode: 'sim',
      paths: { stateDir: dir },
      population: { initial: 3, cap: 10 },
      ...overrides,
    },
  }).config;
}

const RESEARCH_JSON = JSON.stringify({
  sentiment: 0.2,
  confidence: 0.6,
  verdict: 'HOLD',
  catalysts: ['fixture catalyst'],
  risks: [],
  summary: 'Fixture briefing.',
  symbols: [],
  sources: [],
});

function fakeGenerate() {
  return async () => ({ text: RESEARCH_JSON, provider: 'fake', model: 'fake-model', usage: { inputTokens: 5, outputTokens: 5 } });
}

// ---------------------------------------------------------------------------
// research schedule modes
// ---------------------------------------------------------------------------

describe('research schedule modes (operator-selectable cadence)', () => {
  let dir;
  let config;
  let paths;
  let registry;
  let ledger;
  let clock;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-control-research-'));
    clock = makeClock(Date.parse('2026-10-29T14:00:00Z'));
    config = tempConfig(dir, {
      research: { enabled: true, influence: false, intervalSec: 3600, staggerSec: 0, maxRunsPerCycle: 3 },
      rewards: { enabled: false, period: 'daily', rankPercents: [0.05, 0.03, 0.02], maxPerPeriodUsd: null },
    });
    paths = statePaths(config);
    fs.mkdirSync(paths.stateDir, { recursive: true });
    registry = createRegistry({ paths, config, clock });
    ledger = createLedger({ paths, config, clock });
    for (let index = 0; index < 3; index += 1) {
      registry.register({
        id: `atm-agent-${index}`,
        name: `Agent ${index}`,
        generation: 0,
        status: 'alive',
        bornAt: new Date(clock.now()).toISOString(),
        endowmentUsd: 20,
        genome: { family: 'meanrev', symbol: ['AAPL', 'MSFT', 'NVDA'][index], entryZ: 1.2 },
      });
      ledger.ensureAgent(`atm-agent-${index}`, { endowmentUsd: 20 });
      ledger.grant(`atm-agent-${index}`, 20, { reason: 'endowment' });
    }
    registry.save();
    ledger.save();
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeResearcher(overrides = {}) {
    return createResearcher({
      broker: { async getNews() { return []; } },
      registry,
      ledger,
      config: { ...config, research: { ...config.research, ...overrides } },
      paths,
      clock,
      generate: fakeGenerate(),
    });
  }

  it('interval mode is due once per interval; reconfigure to pre-open switches to the window', async () => {
    const researcher = makeResearcher();
    const first = await researcher.tick();
    assert.equal(first.due, 3);
    const second = await researcher.tick();
    assert.equal(second.due, 0, 'same interval: not due again');
    // Live reconfigure to a pre-open window 10 minutes before the next open.
    const schedule = researcher.reconfigure({ scheduleMode: 'pre-open', preMarketOffsetMin: 30 });
    assert.equal(schedule.scheduleMode, 'pre-open');
    const nextOpen = clock.now() + 10 * 60 * 1000;
    const marketClock = { isOpen: false, nextOpen, nextClose: clock.now() + 5 * HOUR };
    const beforeWindow = await researcher.tick({ marketClock: { isOpen: false, nextOpen: clock.now() + 3 * HOUR, nextClose: clock.now() + 9 * HOUR } });
    assert.equal(beforeWindow.due, 0, 'outside the pre-open window nothing is due');
    const inWindow = await researcher.tick({ marketClock });
    assert.equal(inWindow.due, 3, 'pre-open window makes all agents due');
    assert.equal(inWindow.ran.length, 3);
  });

  it('post-close window opens when the market closes and is served once', async () => {
    const researcher = makeResearcher({ scheduleMode: 'post-close', postCloseOffsetMin: 30 });
    const openClock = { isOpen: true, nextOpen: clock.now() - HOUR, nextClose: clock.now() + 2 * HOUR };
    await researcher.tick({ marketClock: openClock });
    clock.advance(2 * HOUR + 5 * 60 * 1000); // session closed a few minutes ago
    const closedClock = { isOpen: false, nextOpen: clock.now() + 16 * HOUR, nextClose: clock.now() + 22 * HOUR };
    const due = await researcher.tick({ marketClock: closedClock });
    assert.ok(due.due > 0, 'post-close window should be due right after the close');
    const again = await researcher.tick({ marketClock: closedClock });
    assert.equal(again.due, 0, 'the post-close window is served once per close');
  });

  it('engine persists research schedule to the settings overlay and exposes configurable options', async () => {
    const engineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-control-engine-'));
    try {
      const engine = createEngine({
        cwd: engineDir,
        configFile: path.join(engineDir, 'missing.config.json'),
        envFile: path.join(engineDir, 'missing.env'),
        overrides: {
          mode: 'sim',
          stateDir: path.join(engineDir, 'state'),
          config: {
            population: { initial: 2, cap: 5 },
            research: { enabled: true, influence: false },
            rewards: { enabled: false, period: 'daily', rankPercents: [0.05, 0.03, 0.02], maxPerPeriodUsd: null },
          },
        },
      });
      const result = await engine.updateResearchSettings({ mode: 'pre-open', preMarketOffsetMin: 20 });
      assert.equal(result.settings.scheduleMode, 'pre-open');
      assert.equal(result.settings.preMarketOffsetMin, 20);
      const settingsPath = path.join(engineDir, 'state', 'settings.json');
      assert.equal(fs.existsSync(settingsPath), true);
      const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.equal(saved.research.scheduleMode, 'pre-open');
      // A fresh engine (restart equivalent) reads the overlay back.
      const reread = createEngine({
        cwd: engineDir,
        configFile: path.join(engineDir, 'missing.config.json'),
        envFile: path.join(engineDir, 'missing.env'),
        overrides: {
          mode: 'sim',
          stateDir: path.join(engineDir, 'state'),
          config: {
            population: { initial: 2, cap: 5 },
            research: { enabled: true, influence: false },
            rewards: { enabled: false, period: 'daily', rankPercents: [0.05, 0.03, 0.02], maxPerPeriodUsd: null },
          },
        },
      });
      const view = reread.configView();
      assert.equal(view.summary.research.scheduleMode, 'pre-open');
      assert.equal(view.summary.research.preMarketOffsetMin, 20);
      // Invalid values are rejected and the overlay is rolled back.
      await assert.rejects(() => engine.updateResearchSettings({ intervalSec: 12345 }), /CONFIG_INVALID|intervalSec/);
      const afterInvalid = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.equal(afterInvalid.research.scheduleMode, 'pre-open');
    } finally {
      fs.rmSync(engineDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// orchestrator: plan, transactions, rankings, rewards, status
// ---------------------------------------------------------------------------

describe('control-panel status + leaderboards + rewards payouts', () => {
  let dir;
  let config;
  let broker;
  let clock;
  let automaton;
  let paths;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-control-rewards-'));
    clock = makeClock(Date.parse('2026-10-28T15:00:00Z'));
    config = tempConfig(dir, {
      population: { initial: 3, cap: 10 },
      research: { enabled: true, influence: false, intervalSec: 3600, staggerSec: 0 },
      rewards: { enabled: true, period: 'daily', rankPercents: [0.05, 0.03, 0.02], maxPerPeriodUsd: 300 },
    });
    paths = statePaths(config);
    broker = createSimBroker(config, { seed: 11, accountEquityUsd: 100000 });
    automaton = await createAutomaton({ config, broker, clock, generate: fakeGenerate() });
    await automaton.init();
    await automaton.tick();
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exposes strategy plan, transactions and P&L per agent', async () => {
    const status = await automaton.status();
    assert.ok(status.agents.length >= 3);
    for (const agent of status.agents) {
      assert.ok(agent.plan, `${agent.name} should have a plan`);
      assert.equal(typeof agent.plan.summary, 'string');
      assert.ok(agent.plan.summary.length > 20);
      assert.ok(agent.plan.entryRule.length > 10);
      assert.ok(Array.isArray(agent.plan.exitRules) && agent.plan.exitRules.length >= 3);
      assert.ok(agent.plan.nextStep.length > 20);
      assert.ok(agent.plan.triggers && typeof agent.plan.triggers.family === 'string');
      assert.ok(Array.isArray(agent.orders));
      assert.ok(agent.pnl && typeof agent.pnl === 'object');
      assert.ok(agent.rankings && typeof agent.rankings.dayRank === 'number');
    }
  });

  it('exposes leaderboards for daily, weekly and monthly periods', async () => {
    const status = await automaton.status();
    assert.ok(status.rankings);
    for (const period of ['daily', 'weekly', 'monthly']) {
      const rows = status.rankings.periods[period];
      assert.ok(Array.isArray(rows) && rows.length >= 3, `${period} ranking rows`);
      assert.equal(rows[0].rank, 1);
      assert.ok(typeof rows[0].pnlUsd === 'number');
      assert.ok(status.rankings.periodKeys[period]);
    }
    assert.equal(status.engine.rewards.enabled, true);
    assert.deepEqual(status.engine.rewards.rankPercents, [0.05, 0.03, 0.02]);
    assert.equal(status.engine.research.scheduleMode, 'interval');
    assert.ok(Array.isArray(status.engine.research.configurable.intervalOptionsSec));
    assert.deepEqual(status.engine.research.configurable.intervalOptionsSec, [3600, 10800, 21600, 86400]);
  });

  it('pays the top-3 once when a period completes, capped and reconciling', async () => {
    const before = await automaton.status();
    const poolBefore = before.engine.rewards.poolUsd;
    const ledgerBefore = automaton._internals.ledger;
    const cashBefore = Object.fromEntries(before.agents.map((agent) => [agent.id, agent.cashUsd]));
    clock.advance(24 * HOUR); // cross the daily boundary
    const trace = await automaton.tick();
    assert.ok(trace.rewards && trace.rewards.winners.length === 3, JSON.stringify(trace.rewards));
    const totalPaid = trace.rewards.winners.reduce((sum, winner) => sum + winner.amountUsd, 0);
    assert.ok(Math.abs(totalPaid - 300) < 0.5, `maxPerPeriodUsd cap should bound the payout, got ${totalPaid}`);
    const status = await automaton.status();
    assert.equal(status.engine.rewards.lastWinners.length, 3);
    assert.ok(status.engine.rewards.poolUsd < poolBefore + 1e-9);
    for (const winner of trace.rewards.winners) {
      assert.ok(status.agents.find((agent) => agent.id === winner.agentId));
      assert.ok(winner.amountUsd > 0);
    }
    const newCash = Object.fromEntries(status.agents.map((agent) => [agent.id, agent.cashUsd]));
    const increased = Object.keys(cashBefore).filter((id) => newCash[id] > cashBefore[id] + 1e-9);
    assert.ok(increased.length >= 1, 'at least one agent must have received a reward');
    assert.ok(ledgerBefore.pool().poolUsd < poolBefore + 1e-9);
    // The next tick must not pay the same period again.
    const again = await automaton.tick();
    assert.equal((again.rewards?.winners ?? []).length, 0);
  });

  it('live reward settings apply immediately and are reflected in status', async () => {
    const result = await automaton.updateRewardSettings({ period: 'weekly', rankPercents: [0.02, 0.01, 0.005], maxPerPeriodUsd: 50 });
    assert.equal(result.settings.period, 'weekly');
    const status = await automaton.status();
    assert.equal(status.engine.rewards.period, 'weekly');
    assert.deepEqual(status.engine.rewards.rankPercents, [0.02, 0.01, 0.005]);
  });
});

// ---------------------------------------------------------------------------
// fast intraday profile / minute monitoring
// ---------------------------------------------------------------------------

describe('fast intraday profile (minute monitoring)', () => {
  it('maps Alpaca timeframe strings to bar durations', () => {
    assert.equal(timeframeToMs('1Min'), 60_000);
    assert.equal(timeframeToMs('5Min'), 5 * 60_000);
    assert.equal(timeframeToMs('15Min'), 15 * 60_000);
    assert.equal(timeframeToMs('1Hour'), 60 * 60_000);
    assert.equal(timeframeToMs('garbage'), 60 * 60_000, 'unknown timeframe falls back to 1 hour');
  });

  it('rejects unsupported data timeframe / feed values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-control-fastcfg-'));
    try {
      assert.throws(
        () => loadConfig({ configFile: path.join(dir, 'missing.config.json'), envFile: path.join(dir, 'missing.env'), overrides: { data: { timeframe: '3Min' } } }),
        /data\.timeframe/,
      );
      assert.throws(
        () => loadConfig({ configFile: path.join(dir, 'missing.config.json'), envFile: path.join(dir, 'missing.env'), overrides: { data: { feed: 'nasdaq' } } }),
        /data\.feed/,
      );
      const config = loadConfig({
        configFile: path.join(dir, 'missing.config.json'),
        envFile: path.join(dir, 'missing.env'),
        overrides: { cycleIntervalSec: 60, data: { timeframe: '1Min', feed: 'iex', lookbackBars: 120 } },
      }).config;
      assert.equal(config.cycleIntervalSec, 60);
      assert.equal(config.data.timeframe, '1Min');
      assert.equal(config.data.feed, 'iex');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('measures held bars with the configured timeframe, not always hours', () => {
    const openedAt = new Date(Date.parse('2026-10-29T13:30:00Z')).toISOString();
    const plan = explainAgentPlan({
      agent: { id: 'atm-fast', name: 'Fast AAPL', genome: { family: 'momentum', symbol: 'AAPL' } },
      spec: { family: 'momentum', symbol: 'AAPL', params: { entryZ: 1.1, exitZ: 0.4, stopPct: 0.01, targetPct: 0.02, maxHoldBars: 12, sizePct: 0.2 } },
      book: { positions: { AAPL: { qty: 0.01, avgPriceUsd: 100, openedAt } } },
      prices: { AAPL: 100.5 },
      nowMs: Date.parse('2026-10-29T14:00:00Z'), // 30 minutes held
      timeframe: '5Min',
    });
    assert.equal(plan.position.barsHeld, 6, '30 minutes = 6 bars of 5 minutes');
    assert.ok(plan.exitRules.some((rule) => rule.includes('~5 min each')));
    assert.ok(plan.exitRules.every((rule) => !rule.includes('(hours)')));
  });

  it('boots a 1-minute profile and exposes minute-aware plans', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-control-fastrun-'));
    try {
      const clock = makeClock(Date.parse('2026-10-29T14:00:00Z'));
      const config = loadConfig({
        configFile: path.join(dir, 'missing.config.json'),
        envFile: path.join(dir, 'missing.env'),
        overrides: {
          mode: 'sim',
          cycleIntervalSec: 60,
          paths: { stateDir: dir },
          population: { initial: 2, cap: 5 },
          data: { timeframe: '1Min', feed: 'iex', lookbackBars: 120 },
          research: { enabled: false },
          rewards: { enabled: false, period: 'daily', rankPercents: [0.05, 0.03, 0.02], maxPerPeriodUsd: null },
        },
      }).config;
      const broker = createSimBroker(config, { seed: 3, accountEquityUsd: 100000 });
      const fast = await createAutomaton({ config, broker, clock });
      await fast.init();
      const trace = await fast.tick();
      assert.equal(trace.errors.filter((entry) => entry.role === 'orchestrator').length, 0);
      const status = await fast.status();
      assert.ok(status.agents.length >= 2);
      for (const agent of status.agents) {
        assert.ok(agent.plan, 'every agent has a plan in fast mode');
        assert.ok(agent.plan.exitRules.some((rule) => rule.includes('~1 min each')), 'exit rules must state the 1-minute bar duration');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// tiered execution cadence + trading-hours gate
// ---------------------------------------------------------------------------

describe('tiered cadence (day every minute, swing every hour) and trading-hours gate', () => {
  it('validates cadence overrides', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-control-cadencecfg-'));
    try {
      const config = loadConfig({
        configFile: path.join(dir, 'missing.config.json'),
        envFile: path.join(dir, 'missing.env'),
        overrides: { cadence: { day: { intervalSec: 60, timeframe: '1Min' }, swing: { intervalSec: 3600, timeframe: '1Hour' } } },
      }).config;
      assert.equal(config.cadence.day.intervalSec, 60);
      assert.throws(
        () => loadConfig({ configFile: path.join(dir, 'missing.config.json'), envFile: path.join(dir, 'missing.env'), overrides: { cadence: { day: { intervalSec: 60, timeframe: 'nope' }, swing: { intervalSec: 3600, timeframe: '1Hour' } } } }),
        /cadence\.day\.timeframe/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs day bots every cycle and swing bots only when their hour is due', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-control-cadence-'));
    try {
      const clock = makeClock(Date.parse('2026-10-29T14:00:00Z'));
      const config = loadConfig({
        configFile: path.join(dir, 'missing.config.json'),
        envFile: path.join(dir, 'missing.env'),
        overrides: {
          mode: 'sim',
          cycleIntervalSec: 60,
          paths: { stateDir: dir },
          population: { initial: 2, cap: 5 },
          // Two symbols whose simulated edges cover this population's strategy families
          // (the coherent-spec rule now waits instead of trading another bot's hypothesis).
          symbols: ['SOFI', 'BAC'],
          data: { timeframe: '1Min', feed: 'iex', lookbackBars: 120, maxHypothesesPerCycle: 60 },
          cadence: { day: { intervalSec: 60, timeframe: '1Min' }, swing: { intervalSec: 3600, timeframe: '1Hour' } },
          research: { enabled: false },
          rewards: { enabled: false, period: 'daily', rankPercents: [0.05, 0.03, 0.02], maxPerPeriodUsd: null },
        },
      }).config;
      const broker = createSimBroker(config, { seed: 5, accountEquityUsd: 100000 });
      const automaton = await createAutomaton({ config, broker, clock });
      await automaton.init();
      const status0 = await automaton.status();
      assert.equal(status0.agents.length, 2);
      const tiers = status0.agents.map((agent) => agent.tier).sort();
      assert.deepEqual(tiers, ['day', 'swing'], 'genesis splits agents across the two cadence tiers');
      const dayAgent = status0.agents.find((agent) => agent.tier === 'day');
      const swingAgent = status0.agents.find((agent) => agent.tier === 'swing');
      assert.equal(dayAgent.cadence.intervalSec, 60);
      assert.equal(dayAgent.cadence.timeframe, '1Min');
      assert.equal(swingAgent.cadence.intervalSec, 3600);
      assert.equal(swingAgent.cadence.timeframe, '1Hour');

      // First cycle: both tiers due (cold start).
      const first = await automaton.tick();
      const firstExec = first.executions.filter((entry) => entry.tier);
      assert.equal(firstExec.length, 2);
      assert.equal(firstExec.some((entry) => entry.skipped === 'cadence_wait'), false);

      // +60 s: the day bot is due again, the swing bot is skipped with cadence_wait.
      clock.advance(60_000);
      const second = await automaton.tick();
      const daySecond = second.executions.find((entry) => entry.agentId === dayAgent.id);
      const swingSecond = second.executions.find((entry) => entry.agentId === swingAgent.id);
      assert.ok(daySecond && daySecond.skipped !== 'cadence_wait', 'day bot must be analysed every minute');
      assert.equal(swingSecond?.skipped, 'cadence_wait', 'swing bot must wait between hourly decisions');
      assert.ok(Number(swingSecond.nextInSec) > 0);

      // +1 h total: the swing bot is due again.
      clock.advance(3_540_000);
      const third = await automaton.tick();
      const swingThird = third.executions.find((entry) => entry.agentId === swingAgent.id);
      assert.ok(swingThird && swingThird.skipped !== 'cadence_wait', 'swing bot must run on its hourly cadence');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips market-data/execution entirely while the market is closed when tradingHoursOnly is set', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-control-closed-'));
    try {
      const clock = makeClock(Date.parse('2026-10-29T22:00:00Z')); // 18:00 ET, closed
      const config = loadConfig({
        configFile: path.join(dir, 'missing.config.json'),
        envFile: path.join(dir, 'missing.env'),
        overrides: {
          mode: 'sim',
          cycleIntervalSec: 60,
          paths: { stateDir: dir },
          population: { initial: 2, cap: 5 },
          engine: { tradingHoursOnly: true, offHoursIntervalSec: 300 },
          research: { enabled: false },
          rewards: { enabled: false, period: 'daily', rankPercents: [0.05, 0.03, 0.02], maxPerPeriodUsd: null },
        },
      }).config;
      const simBroker = createSimBroker(config, { seed: 9, accountEquityUsd: 100000 });
      const closedBroker = Object.create(simBroker);
      closedBroker.getClock = async () => ({ isOpen: false, nextOpen: clock.now() + 3_600_000, nextClose: clock.now() + 7_200_000 });
      const automaton = await createAutomaton({ config, broker: closedBroker, clock });
      await automaton.init();
      const snapshot = await automaton.status();
      const agentId = snapshot.agents[0].id;
      const costsBefore = automaton._internals.ledger.snapshot(agentId).costsUsd;
      const trace = await automaton.tick();
      assert.equal(trace.marketOpen, false);
      assert.equal(trace.marketClosed, true);
      assert.equal(trace.tradingSkipped, true);
      assert.equal(trace.market.skipped, true);
      assert.equal((trace.executions ?? []).length, 0, 'no bot is analysed while the market is closed');
      const costsAfter = automaton._internals.ledger.snapshot(agentId).costsUsd;
      assert.equal(costsAfter, costsBefore, 'no per-cycle charges outside trading hours');
      const status = await automaton.status();
      assert.equal(status.engine.tradingHoursOnly, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// strategy taxonomy + per-bot agent brain (docs/BOT-AGENTS.md)
// ---------------------------------------------------------------------------

describe('strategy categories and per-bot agent status', () => {
  it('splits a new population across swing/day strategy types and exposes bot-agent policies', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-control-agents-'));
    try {
      const clock = makeClock(Date.parse('2026-10-29T14:00:00Z'));
      const config = loadConfig({
        configFile: path.join(dir, 'missing.config.json'),
        envFile: path.join(dir, 'missing.env'),
        overrides: {
          mode: 'sim',
          cycleIntervalSec: 60,
          paths: { stateDir: dir },
          population: { initial: 4, cap: 8 },
          research: { enabled: false },
          rewards: { enabled: false, period: 'daily', rankPercents: [0.05, 0.03, 0.02], maxPerPeriodUsd: null },
          agents: { enabled: true, reviewIntervalDaySec: 300, reviewIntervalSwingSec: 3600, maxReviewsPerCycle: 4, costPerReviewUsd: 0.001 },
        },
      }).config;
      const broker = createSimBroker(config, { seed: 11, accountEquityUsd: 100000 });
      const agentGenerate = async () => ({
        text: JSON.stringify({
          stance: 'cautious',
          sizeMultiplier: 0.5,
          riskMultiplier: 1,
          exitPressure: 'none',
          confidence: 0.55,
          thesis: 'Fixture bot-agent thesis.',
          plan: ['wait for confirmation'],
          watch: ['AAPL'],
          instrument: { prefer: 'long_call', maxContracts: 99, dteMin: 0, dteMax: 99 },
        }),
        provider: 'fake',
        model: 'fake-agent-model',
        usage: { inputTokens: 10, outputTokens: 20 },
      });
      const automaton = await createAutomaton({ config, broker, clock, agentGenerate });
      await automaton.init();
      const before = await automaton.status();
      assert.equal(before.strategyMix.total, 4);
      assert.equal(before.strategyMix.swing.count, 2);
      assert.equal(before.strategyMix.day.count, 2);
      const families = before.agents.map((agent) => agent.strategy.family);
      assert.equal(new Set(families).size, 4, 'a small genesis population covers all four strategy families');
      assert.equal(before.engine.agents.configured, true);
      assert.equal(before.engine.instruments.enabled, true);
      assert.equal(before.engine.instruments.longOptions, true);
      assert.equal(before.engine.instruments.shortStock, true);
      assert.equal(before.engine.instruments.margin, true);
      for (const structure of ['long_call', 'long_put', 'covered_call', 'call_credit_spread', 'put_credit_spread']) {
        assert.ok(before.engine.instruments.allowedStructures.includes(structure), `instruments expose ${structure}`);
      }
      assert.equal(before.engine.instruments.allowedStructures.includes('naked_short_call'), false);
      for (const family of ['momentum', 'meanrev', 'breakout', 'gapfade']) {
        assert.ok(before.engine.instruments.playbooks[family].bullish.length > 0);
      }
      for (const agent of before.agents) {
        assert.ok(agent.instrumentPermissions, 'every agent exposes instrument permissions');
        assert.equal(agent.instrumentPermissions.shortStock, true);
        assert.ok(agent.playbook && agent.playbook.family === agent.genome.family);
        assert.ok(agent.playbook.bullish.length > 0);
      }

      await automaton.tick();
      const status = await automaton.status();
      for (const agent of status.agents) {
        assert.ok(agent.strategy, 'every agent has a strategy taxonomy view');
        assert.equal(agent.strategy.category, agent.tier);
        assert.ok(agent.strategy.typeLabel.length > 0);
        assert.ok(agent.strategy.estimatedIntervalSec >= 60);
        assert.ok(['1Min', '1Hour'].includes(agent.strategy.timeframe));
        assert.equal(agent.strategy.family, agent.genome.family);
        // v3.1: a compiled spec must always match the bot's own genome family+symbol; the old
        // unrelated-hypothesis fallback (e.g. Momentum F trading AMD breakout) is gone.
        if (agent.spec) {
          assert.equal(agent.spec.family, agent.genome.family, `${agent.name} spec family must match genome`);
          assert.equal(agent.spec.symbol, agent.genome.symbol, `${agent.name} spec symbol must match genome`);
        }
      }
      const reviewed = status.agents.filter((agent) => agent.policy && agent.policy.at);
      assert.equal(reviewed.length >= 1, true, 'bot reviews run after the execution pass');
      const sample = reviewed[0].policy;
      assert.equal(sample.stance, 'cautious');
      assert.equal(sample.sizeMultiplier, 0.5);
      assert.equal(sample.confidence, 0.55);
      assert.ok(Array.isArray(sample.plan));
      assert.equal(sample.instrument.prefer, 'long_call');
      assert.equal(sample.instrument.maxContracts, config.instruments.maxContracts);
      assert.equal(sample.instrument.dteMin, config.instruments.minDTE);
      assert.equal(sample.instrument.dteMax, config.instruments.maxDTE);
      assert.equal(status.engine.agents.enabled, true);
      assert.equal(status.engine.agents.configured, true);
      assert.equal(status.engine.agents.provider, 'fake');
      assert.equal(status.engine.agents.runs >= 1, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// v3.1 broker capability gating: restricted paper account (no margin/shorting)
// ---------------------------------------------------------------------------

describe('broker capability gating', () => {
  it('removes short/margin/credit-option permissions when the paper account is restricted', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-control-capability-'));
    try {
      const clock = makeClock(Date.parse('2026-10-30T15:00:00Z'));
      const config = loadConfig({
        configFile: path.join(dir, 'missing.config.json'),
        envFile: path.join(dir, 'missing.env'),
        overrides: {
          mode: 'sim',
          cycleIntervalSec: 60,
          paths: { stateDir: dir },
          population: { initial: 2, cap: 5 },
          symbols: ['SOFI', 'BAC'],
          data: { timeframe: '1Min', feed: 'iex', lookbackBars: 120, maxHypothesesPerCycle: 60 },
          research: { enabled: false },
          rewards: { enabled: false, period: 'daily', rankPercents: [0.05, 0.03, 0.02], maxPerPeriodUsd: null },
          agents: { enabled: false },
        },
      }).config;
      const baseBroker = createSimBroker(config, { seed: 17, accountEquityUsd: 100000 });
      const restrictedBroker = Object.create(baseBroker);
      restrictedBroker.getAccount = async () => ({
        ...(await baseBroker.getAccount()),
        buyingPowerUsd: 100000,
        shortingEnabled: false,
        marginMultiplier: 1,
      });
      const automaton = await createAutomaton({ config, broker: restrictedBroker, clock });
      await automaton.init();
      await automaton.tick();
      const status = await automaton.status();
      assert.equal(status.engine.instruments.effective.shortStock, false);
      assert.equal(status.engine.instruments.effective.margin, false);
      assert.equal(status.engine.instruments.effective.structures.includes('covered_call'), false);
      assert.equal(status.engine.instruments.effective.structures.includes('call_credit_spread'), false);
      assert.equal(status.engine.instruments.effective.structures.includes('long_call'), true);
      for (const agent of status.agents) {
        assert.equal(agent.instrumentPermissions.shortStock, false, 'no short permission on a restricted account');
        assert.equal(agent.instrumentPermissions.margin, false, 'no margin permission on a restricted account');
        assert.equal(agent.instrumentPermissions.allowedStructures.includes('covered_call'), false);
        assert.equal(agent.instrumentPermissions.allowedStructures.includes('call_credit_spread'), false);
        assert.equal(agent.instrumentPermissions.allowedStructures.includes('long_call'), true);
        assert.equal(agent.playbook.structures.includes('covered_call'), false);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// v3.0 capital migration ($20 -> $50 per bot, one-time, idempotent)
// ---------------------------------------------------------------------------

describe('capital top-up for multi-instrument paper trading', () => {
  it('credits legacy $20 bots to the configured $50 endowment', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-control-topup-'));
    try {
      const clock = makeClock(Date.parse('2026-10-30T15:00:00Z'));
      const config = loadConfig({
        configFile: path.join(dir, 'missing.config.json'),
        envFile: path.join(dir, 'missing.env'),
        overrides: {
          mode: 'sim',
          cycleIntervalSec: 60,
          paths: { stateDir: dir },
          population: { initial: 2, cap: 5 },
          endowmentUsd: 50,
          replication: { surplus7dUsd: 3, minRunwayHours: 72, childEndowmentUsd: 25 },
          research: { enabled: false },
          rewards: { enabled: false, period: 'daily', rankPercents: [0.05, 0.03, 0.02], maxPerPeriodUsd: null },
          agents: { enabled: false },
        },
      }).config;
      const paths = statePaths(config);
      fs.mkdirSync(paths.stateDir, { recursive: true });
      const registry = createRegistry({ paths, config, clock });
      const ledger = createLedger({ paths, config, clock });
      for (const [index, symbol] of ['AAPL', 'MSFT'].entries()) {
        const agentId = `atm-topup000${index + 1}`;
        const genome = {
          symbol,
          family: index === 0 ? 'momentum' : 'meanrev',
          lookback: 24,
          entryZ: 1.2,
          exitZ: 0.4,
          stopPct: 0.02,
          targetPct: 0.04,
          maxHoldBars: 12,
          sizePct: 0.2,
          sessionFilter: 'any',
        };
        registry.register({
          id: agentId,
          name: index === 0 ? 'Momentum AAPL' : 'MeanRev MSFT',
          parentId: null,
          generation: 0,
          bornAt: clock.iso(),
          status: 'alive',
          endowmentUsd: 20,
          genome,
          mutation: null,
          specId: null,
          notes: ['genesis'],
        });
        ledger.ensureAgent(agentId, { endowmentUsd: 20 });
        ledger.credit(agentId, 20, { category: 'endowment', reason: 'seed', at: clock.now() });
      }
      registry.save();
      ledger.save();
      const broker = createSimBroker(config, { seed: 3, accountEquityUsd: 100000 });
      const automaton = await createAutomaton({ config, broker, clock });
      await automaton.init();
      const status = await automaton.status();
      assert.equal(status.agents.length, 2);
      for (const agent of status.agents) {
        assert.equal(agent.endowmentUsd, 50, 'endowment basis raised to the configured amount');
        assert.equal(agent.cashUsd, 50, 'one-time $30 top-up credited');
        assert.equal(agent.equityUsd, 50);
      }
      const snapshot = automaton._internals.ledger.snapshot('atm-topup0001');
      assert.equal(snapshot.cashUsd, 50);
      assert.equal(snapshot.marginDebtUsd, 0);
      // The +$30 came from the unallocated treasury pool (reallocation), not newly minted cash:
      // total ledger equity must still equal broker equity.
      const pool = automaton._internals.ledger.pool();
      assert.equal(Math.abs(pool.totalUsd - 100000) <= 0.01, true, `top-up must conserve account equity (total ${pool.totalUsd})`);
      assert.equal(snapshot.creditsUsd, 20, 'only the seeded credit was minted; the top-up is a transfer');
      assert.equal(snapshot.realizedPlUsd, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// v3.2: 70/30 day/swing population + multi-symbol baskets
// ---------------------------------------------------------------------------

describe('v3.2 strategy mix and basket portfolios', () => {
  it('seeds 70% day bots with multi-symbol baskets and per-symbol specs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-control-v32mix-'));
    try {
      const clock = makeClock(Date.parse('2026-10-30T15:00:00Z'));
      const config = loadConfig({
        configFile: path.join(dir, 'missing.config.json'),
        envFile: path.join(dir, 'missing.env'),
        overrides: {
          mode: 'sim',
          cycleIntervalSec: 60,
          paths: { stateDir: dir },
          population: { initial: 10, cap: 20 },
          strategyMix: { dayPct: 0.7 },
          portfolio: { basketSizeDay: 4, basketSizeSwing: 3, maxOpenPositionsDay: 5, maxOpenPositionsSwing: 3, maxOrdersPerCycle: 2 },
          risk: { maxOpenPositions: 6 },
          data: { timeframe: '1Min', feed: 'iex', lookbackBars: 120, maxHypothesesPerCycle: 60 },
          research: { enabled: false },
          rewards: { enabled: false, period: 'daily', rankPercents: [0.05, 0.03, 0.02], maxPerPeriodUsd: null },
          agents: { enabled: false },
        },
      }).config;
      const broker = createSimBroker(config, { seed: 23, accountEquityUsd: 100000 });
      const automaton = await createAutomaton({ config, broker, clock });
      await automaton.init();
      const status = await automaton.status();
      assert.equal(status.strategyMix.total, 10);
      assert.equal(status.strategyMix.day.count, 7, '70% of 10 bots should be day/intraday');
      assert.equal(status.strategyMix.swing.count, 3);
      assert.equal(status.strategyMix.target.dayPct, 0.7);
      const day = status.agents.filter((agent) => agent.tier === 'day');
      const swing = status.agents.filter((agent) => agent.tier === 'swing');
      assert.equal(day.length, 7);
      assert.equal(swing.length, 3);
      for (const agent of day) {
        assert.equal(agent.symbols.length, 4, 'day bots manage a 4-symbol basket');
        assert.equal(new Set(agent.symbols).size, agent.symbols.length, 'basket symbols are unique');
        for (const symbol of agent.symbols) assert.ok(config.symbols.includes(symbol));
      }
      for (const agent of swing) {
        assert.equal(agent.symbols.length, 3, 'swing bots manage a 3-symbol basket');
      }
      assert.equal(status.engine.portfolio.strategyMix.dayPct, 0.7);
      assert.equal(status.engine.portfolio.basketSizeDay, 4);

      await automaton.tick();
      const after = await automaton.status();
      const withSpecs = after.agents.filter((agent) => (agent.specs ?? []).length > 0);
      assert.ok(withSpecs.length >= 1, 'at least one basket spec should compile from the proven hypotheses');
      for (const agent of after.agents) {
        for (const spec of agent.specs ?? []) {
          assert.equal(spec.family, agent.genome.family, 'every basket spec uses the bot family');
          assert.ok(agent.symbols.includes(spec.symbol), 'every spec symbol belongs to the basket');
        }
        if (agent.spec) {
          assert.equal(agent.spec.family, agent.genome.family);
          assert.equal(agent.spec.symbol, agent.genome.symbol, 'primary spec view stays tied to the primary symbol');
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
