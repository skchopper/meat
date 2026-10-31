/**
 * test/bot-agent.test.js — Lead-owned verification for the per-bot agent brain (docs/BOT-AGENTS.md).
 *
 * Asserts:
 *  - strict isolation: one bot's review prompt never contains another bot's id/name/book/journal
 *  - schema normalization/clamping and malformed-reply containment (repair+retry once)
 *  - cadence: day-tier bots review every reviewIntervalDaySec, swing-tier bots hourly
 *  - each successful review is charged to that bot's ledger (category agent, role executor)
 *  - policy freshness/staleness semantics used by the Executor, plus persistence across instances
 *  - disabled / unconfigured brain never changes behaviour
 *
 * Run directly (the sandbox blocks `node --test <file>`):
 *   cd packages/automaton-trading && node test/bot-agent.test.js
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, statePaths } from '../src/config.js';
import { createRegistry } from '../src/registry.js';
import { createLedger } from '../src/ledger.js';
import { createBotAgents, normalizePolicy } from '../src/bot-agent.js';

const HOUR = 60 * 60 * 1000;

function makeClock(startMs = Date.parse('2026-10-30T14:00:00Z')) {
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

function policyJson(overrides = {}) {
  return JSON.stringify({
    stance: 'trade',
    sizeMultiplier: 0.8,
    riskMultiplier: 1,
    exitPressure: 'none',
    confidence: 0.6,
    thesis: 'Fixture thesis for this bot.',
    plan: ['hold until the next review'],
    watch: ['AAPL'],
    ...overrides,
  });
}

function makeAgent(id, name, family, symbol) {
  return {
    id,
    name,
    generation: 0,
    bornAt: '2026-10-30T13:00:00.000Z',
    status: 'alive',
    endowmentUsd: 20,
    genome: { family, symbol, lookback: 24, entryZ: 1.2, exitZ: 0.4, stopPct: 0.02, targetPct: 0.04, maxHoldBars: 12, sizePct: 0.2, sessionFilter: 'any' },
  };
}

describe('per-bot agent brain', () => {
  let dir;
  let clock;
  let config;
  let paths;
  let registry;
  let ledger;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-bot-agent-'));
    clock = makeClock();
    config = loadConfig({
      configFile: path.join(dir, 'missing.config.json'),
      envFile: path.join(dir, 'missing.env'),
      overrides: {
        mode: 'sim',
        paths: { stateDir: dir },
        population: { initial: 2, cap: 10 },
        agents: {
          enabled: true,
          reviewIntervalDaySec: 60,
          reviewIntervalSwingSec: 3600,
          maxReviewsPerCycle: 4,
          costPerReviewUsd: 0.001,
          maxAgeSec: 7200,
        },
      },
    }).config;
    paths = statePaths(config);
    fs.mkdirSync(paths.stateDir, { recursive: true });
    registry = createRegistry({ paths, config, clock });
    ledger = createLedger({ paths, config, clock });
    for (const agent of [
      makeAgent('atm-day00001', 'Breakout AAPL', 'breakout', 'AAPL'),
      makeAgent('atm-swing002', 'Momentum MSFT', 'momentum', 'MSFT'),
    ]) {
      registry.register(agent);
      ledger.ensureAgent(agent.id, { endowmentUsd: 20 });
      ledger.grant(agent.id, 20, { reason: 'endowment' });
    }
    registry.save();
    ledger.save();
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeBrain({ generate, overrides = {} } = {}) {
    const prompts = [];
    const generator = generate ?? (async ({ user }) => {
      prompts.push(user);
      return { text: policyJson({ watch: [user.includes('Breakout AAPL') ? 'AAPL' : 'MSFT'] }), provider: 'fake', model: 'fake-model', usage: { inputTokens: 10, outputTokens: 20 } };
    });
    const brain = createBotAgents({
      config: { ...config, agents: { ...config.agents, ...overrides } },
      paths,
      clock,
      registry,
      ledger,
      researcher: { latestAny: () => ({ verdict: 'HOLD', sentiment: 0.1, confidence: 0.5, stale: false, at: new Date(clock.now()).toISOString() }) },
      generate: generator,
      specFor: () => null,
    });
    return { brain, prompts };
  }

  it('normalizes and clamps the policy schema', () => {
    const policy = normalizePolicy({ stance: 'CAUTIOUS', sizeMultiplier: 5, riskMultiplier: 3, confidence: 2, thesis: 'x', plan: ['a', 'b'], watch: ['aapl', 'bad symbol!'] }, { nowMs: clock.now(), reviewSec: 300 });
    assert.equal(policy.stance, 'cautious');
    assert.equal(policy.sizeMultiplier, 1, 'size multiplier never exceeds 1');
    assert.equal(policy.riskMultiplier, 1.5);
    assert.equal(policy.confidence, 1);
    assert.deepEqual(policy.watch, ['AAPL', 'BAD SYMBOL!']);
    assert.throws(() => normalizePolicy({ stance: 'moon', confidence: 0.5 }, { nowMs: clock.now() }), /stance/);
    assert.throws(() => normalizePolicy({ stance: 'trade' }, { nowMs: clock.now() }), /confidence/);
  });

  it('keeps each review prompt strictly isolated to one bot', async () => {
    const { brain, prompts } = makeBrain();
    const run = await brain.tick({ market: { prices: { AAPL: 200, MSFT: 400 }, quotes: { AAPL: { bid: 199.9, ask: 200.1, ts: clock.now() }, MSFT: { bid: 399.9, ask: 400.1, ts: clock.now() } }, marketOpen: true } });
    assert.equal(run.reviewed.length, 2);
    assert.equal(prompts.length, 2);
    const dayPrompt = prompts.find((prompt) => prompt.includes('Breakout AAPL'));
    const swingPrompt = prompts.find((prompt) => prompt.includes('Momentum MSFT'));
    assert.ok(dayPrompt && swingPrompt);
    assert.ok(dayPrompt.includes('atm-day00001'));
    assert.equal(dayPrompt.includes('Momentum MSFT'), false);
    assert.equal(dayPrompt.includes('atm-swing002'), false);
    assert.equal(dayPrompt.includes('400'), false, "the day bot must not see the other bot's symbol price");
    assert.equal(swingPrompt.includes('Breakout AAPL'), false);
    assert.equal(swingPrompt.includes('atm-day00001'), false);
  });

  it('stores a policy and charges it to the bot ledger', async () => {
    clock.advance(60_000);
    const { brain } = makeBrain({ overrides: {} });
    const before = ledger.snapshot('atm-day00001').costsUsd;
    await brain.tick({ market: { prices: { AAPL: 200 }, quotes: {}, marketOpen: true } });
    const after = ledger.snapshot('atm-day00001').costsUsd;
    assert.ok(after - before >= 0.001 - 1e-9, 'review cost charged to the bot');
    const policy = brain.policy('atm-day00001');
    assert.ok(policy);
    assert.equal(policy.stale, false);
    assert.equal(policy.stance, 'trade');
    assert.equal(policy.sizeMultiplier, 0.8);
    const journal = fs.readFileSync(path.join(paths.stateDir, 'agents', 'atm-day00001.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(journal.length >= 1);
    assert.equal(journal[journal.length - 1].agentId, 'atm-day00001');
    assert.equal(brain.status('atm-day00001').reviewCount >= 1, true);
  });

  it('runs day bots every minute and swing bots hourly', async () => {
    clock.set(Date.parse('2026-10-30T15:00:00Z'));
    const { brain } = makeBrain();
    const first = await brain.tick({ market: { prices: {}, quotes: {}, marketOpen: true } });
    assert.equal(first.reviewed.length, 2, 'cold start reviews both tiers');
    clock.advance(60_000);
    const second = await brain.tick({ market: { prices: {}, quotes: {}, marketOpen: true } });
    assert.equal(second.reviewed.length, 1, 'only the day bot is due after a minute');
    assert.equal(second.reviewed[0].agentId, 'atm-day00001');
    clock.advance(3_540_000);
    const third = await brain.tick({ market: { prices: {}, quotes: {}, marketOpen: true } });
    assert.equal(third.reviewed.length, 2, 'day and swing bots are both due after an hour');
    assert.equal(third.reviewed.some((entry) => entry.agentId === 'atm-swing002'), true);
  });

  it('contains malformed replies: no policy, no charge, error logged', async () => {
    const { brain } = makeBrain({ generate: async () => ({ text: 'the stock will moon', provider: 'fake', model: 'fake-model' }) });
    clock.advance(3_600_000);
    const before = ledger.snapshot('atm-day00001').costsUsd;
    const run = await brain.tick({ market: { prices: {}, quotes: {}, marketOpen: true } });
    assert.equal(run.reviewed.every((entry) => Boolean(entry.error)), true);
    assert.equal(ledger.snapshot('atm-day00001').costsUsd, before, 'failed reviews are not charged');
    const journalFile = path.join(paths.stateDir, 'agents', 'atm-day00001.jsonl');
    assert.equal(fs.existsSync(journalFile), true);
  });

  it('expires stale policies for the Executor but keeps them for the dashboard', async () => {
    clock.set(Date.parse('2026-10-30T18:00:00Z'));
    const { brain } = makeBrain({ overrides: { maxAgeSec: 600 } });
    await brain.tick({ market: { prices: {}, quotes: {}, marketOpen: true } });
    assert.ok(brain.policy('atm-day00001'));
    clock.advance(601_000);
    assert.equal(brain.policy('atm-day00001'), null);
    const status = brain.status('atm-day00001');
    assert.ok(status && status.stale === true);
  });

  it('persists policies across brain instances', async () => {
    const { brain } = makeBrain({ overrides: { maxAgeSec: 7200 } });
    clock.set(Date.parse('2026-10-30T19:00:00Z'));
    await brain.tick({ market: { prices: {}, quotes: {}, marketOpen: true } });
    const reloaded = makeBrain().brain;
    await reloaded.init();
    assert.ok(reloaded.policy('atm-day00001'), 'a reloaded brain must see the persisted policy');
    assert.equal(reloaded.status('atm-day00001').reviewCount >= 1, true);
  });

  it('is inert when disabled or unconfigured', async () => {
    const disabled = createBotAgents({
      config: { ...config, agents: { ...config.agents, enabled: false } },
      paths,
      clock,
      registry,
      ledger,
      generate: async () => ({ text: policyJson(), provider: 'fake', model: 'fake-model' }),
    });
    const disabledRun = await disabled.tick({ market: {} });
    assert.equal(disabledRun.enabled, false);
    assert.equal(disabledRun.reviewed.length, 0);
    await disabled.init();
    assert.equal(disabled.policy('atm-day00001'), null, 'a disabled brain exposes no policy');
    const unconfigured = createBotAgents({ config, paths, clock, registry, ledger, generate: null });
    const unconfiguredRun = await unconfigured.tick({ market: {} });
    assert.equal(unconfiguredRun.configured, false);
    assert.equal(unconfiguredRun.reviewed.length, 0);
    assert.equal(unconfigured.policy('atm-day00001'), null);
  });

  it('tells the bot that long stock is fractional, shows its budget, and hides unavailable broker capabilities', () => {
    const { brain } = makeBrain();
    const agent = makeAgent('atm-day00001', 'Breakout AAPL', 'breakout', 'AAPL');
    const prompt = brain._internals.buildUserPrompt({
      agent,
      snapshot: { cashUsd: 50, equityUsd: 50, positions: {}, trades: 0, realizedPlUsd: 0, unrealizedPlUsd: 0, marginDebtUsd: 0 },
      spec: null,
      prior: [],
      market: { prices: { AAPL: 500 }, quotes: {}, marketOpen: true },
      researchBriefing: null,
      account: { shortingEnabled: false, marginMultiplier: 1, optionsBuyingPowerUsd: 1999, optionsTradingLevel: 3 },
    });
    assert.match(prompt, /TRADING_RULES:/, 'mandate/risk rules must be visible to the bot');
    assert.match(prompt, /"fractionalLongStock":true/, 'fractional long stock capability must be explicit');
    assert.match(prompt, /"sizeBudgetUsd":/, 'the bot must see its dollar sizing budget, not only equity');
    assert.doesNotMatch(prompt, /"allowedStructures":\[[^\]]*covered_call/, 'credit/covered structures hidden while margin is unavailable');
    assert.match(prompt, /"shortStock":false/, 'short stock capability must reflect the broker restriction');
    assert.match(prompt, /"margin":false/, 'margin capability must reflect the broker restriction');
  });
});
