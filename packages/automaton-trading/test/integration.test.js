/**
 * test/integration.test.js — INDEPENDENT end-to-end verification (verifier-owned).
 *
 * This suite deliberately does not reuse the builders' fixtures. It drives the real
 * composition (`createAutomaton`) against the deterministic SIM broker with a fixed,
 * advanceable clock in a throwaway state directory, then checks the system's claims:
 *
 *   - a genesis population is seeded and pays its own metabolism every cycle
 *   - the Treasurer issues mandates, computes runway/reconciliation, and writes death
 *     VERDICTS; in mode=sim only, the engine executes those verdicts in-process (demo),
 *     while in mode=paper the engine must never execute a death (the external Reaper owns it)
 *   - the Reaper's kill is durable: it persists registry/ledger so a fresh load cannot
 *     resurrect the agent, and the engine re-syncs from disk at the start of every cycle
 *   - the Executor really places orders through the brake wall with client_order_id
 *     attribution; the ledger keeps cash + positions = equity with no negative cash
 *   - replication opens only on the Treasurer gate, mutates exactly one genome field,
 *     keeps generation numbering correct (genesis = 0) and hands the child journal lessons
 *   - the operator kill switch blocks a whole cycle, and the engine facade
 *     (status/probe/obituaries/brakesView/configView) never trades, auto-starts or leaks
 *
 * Behaviour learned during this verification is encoded as assertions. Defects that were
 * found and fixed are re-verified here (they must stay fixed); the one residual gap
 * (a daily_loss_limit verdict is not executable by the Reaper, which only re-derives
 * equity-based causes) is encoded as a `todo` test and documented in docs/VERIFICATION.md.
 *
 * Run (the sandbox blocks `node --test <file>`, so run the file directly):
 *   cd packages/automaton-trading
 *   node test/integration.test.js
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, statePaths, defaultConfig, publicConfig } from '../src/config.js';
import { createBroker as createSimBroker } from '../src/broker-sim.js';
import { createAutomaton, genesisGenome } from '../src/orchestrator.js';
import { createReaper } from '../src/reaper.js';
import { createEngine } from '../src/engine.js';
import { createJournal } from '../src/journal.js';
import { createLedger, TREASURY_ID } from '../src/ledger.js';
import { createRankings } from '../src/rankings.js';
import { createRewards, resolveRewardSettings } from '../src/rewards.js';
import { createRegistry } from '../src/registry.js';
import { OBITUARY_FIELDS, validateObituary } from '../src/journal.js';
import { burnPerHour, createTreasurer, deriveInstrumentPermissions } from '../src/treasurer.js';
import { createBrakes } from '../src/brakes.js';
import { createExecutor } from '../src/executor.js';
import { createReplicator, MUTABLE, MUTABLE_FIELDS } from '../src/replicator.js';
import { createClock, mulberry32, round2 } from '../src/util.js';
import { targetFamilyForIndex, tierForFamily } from '../src/strategy-types.js';
import { resolveInstrumentPermissions } from '../src/instruments.js';
import { DEATH_CAUSES } from '../src/contracts.js';
import { createBuilder, PARAM_BOUNDS } from '../src/builder.js';

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T0 = Date.UTC(2026, 0, 5, 15, 0, 0); // Mon 10:00 America/New_York (inside 09:35-15:50)
const CYCLE_MS = 5 * 60 * 1000;
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

/** Fresh sim state dir + validated layered config (small population, cap 4). */
function makeEnv(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-integration-'));
  createdDirs.push(dir);
  const { config } = loadConfig({
    cwd: dir,
    env: {},
    configFile: path.join(dir, 'no-such-config.json'),
    overrides: {
      mode: 'sim',
      paths: { stateDir: path.join(dir, 'state'), envFile: path.join(dir, '.env') },
      population: { initial: 3, cap: 4 },
      endowmentUsd: 5000,
      ...overrides,
    },
  });
  return { dir, config, paths: statePaths(config) };
}

/** Deterministic advanceable clock: no wall-clock reads in domain logic under test. */
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

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonlLines(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

function assertNoSecrets(value, secrets, where) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) {
    assert.equal(text.includes(secret), false, `${where} leaked credential material (${secret.slice(0, 4)}…)`);
  }
}

function expectedBurnPerCycle(config) {
  const cycleHours = Number(config.cycleIntervalSec) / 3600;
  return (
    Number(config.burn.inferencePerCycleUsd) +
    Number(config.burn.dataPerCycleUsd) +
    Number(config.burn.hostingPerHourUsd) * cycleHours +
    (Number(config.burn.committedMonthlyUsd) / 730) * cycleHours
  );
}

// ===========================================================================
// Main end-to-end world — mode=sim: engine executes sim verdicts in-process
// ===========================================================================

describe('end-to-end (mode=sim): population, metabolism, orders, demo death, persistence, replication', () => {
  const world = {};

  before(async () => {
    const env = makeEnv();
    world.env = env;
    world.config = env.config;
    world.paths = env.paths;
    world.clock = makeClock(T0);
    world.broker = createSimBroker(env.config, {
      seed: 6, // chosen deterministically: the sim population trades within a few cycles
      accountEquityUsd: 100000,
      clock: world.clock,
    });
    world.automaton = await createAutomaton({
      config: env.config,
      paths: env.paths,
      broker: world.broker,
      clock: world.clock,
    });
    await world.automaton.init();
    world.internals = world.automaton._internals;
    world.registry = world.internals.registry;
    world.ledger = world.internals.ledger;
    world.journal = world.internals.journal;

    // Snapshot the genesis population BEFORE anything mutates it.
    world.genesis = {
      population: world.registry.population(),
      cap: world.registry.cap,
      agents: world.registry.alive().map((agent) => ({
        id: agent.id,
        generation: agent.generation,
        status: agent.status,
        endowmentUsd: agent.endowmentUsd,
        genome: { ...agent.genome },
        parentId: agent.parentId,
      })),
      cashById: Object.fromEntries(
        world.registry.alive().map((agent) => [agent.id, world.ledger.snapshot(agent.id).cashUsd]),
      ),
      accountEquityUsd: world.broker.getAccount().equityUsd,
    };
    world.initStatus = await world.automaton.status();

    // Deliberately under-fund one agent: the Treasurer must write a verdict this cycle.
    world.victim = world.registry.alive()[0];
    const victimCash = world.ledger.snapshot(world.victim.id).cashUsd;
    world.ledger.charge(world.victim.id, victimCash, {
      category: 'inference',
      role: 'executor',
      at: world.clock.now(),
    });
    world.ledger.save();
    world.clock.advance(CYCLE_MS);
    world.verdictTick = await world.automaton.tick();
    world.deathsFileAfterVerdict = readJsonFile(world.paths.deaths);
    world.obituary = world.journal.list({ limit: 1 })[0] ?? null;

    // Several more full cycles with the remaining population.
    world.ticks = [world.verdictTick];
    for (let cycle = 0; cycle < 8; cycle += 1) {
      world.clock.advance(CYCLE_MS);
      world.ticks.push(await world.automaton.tick());
    }
    world.successfulTicks = world.ticks.length; // = 9
    world.statusAfterTicks = await world.automaton.status();
    world.lastTreasury = world.internals.treasurer.lastTick;
    world.lastPrices = world.internals.state.lastPrices;
    world.ordersAfterTicks = world.broker.getOrders({ status: 'all', limit: 500 });
    world.totalOrders = world.ticks.reduce(
      (total, trace) => total + trace.executions.reduce((n, execution) => n + execution.orders, 0),
      0,
    );
    world.roleCostsAfterTicks = Object.fromEntries(
      world.registry.alive().map((agent) => [agent.id, world.ledger.roleCosts(agent.id)]),
    );
    world.costsPerAgent = Object.fromEntries(
      world.registry.alive().map((agent) => [agent.id, world.ledger.snapshot(agent.id).costsUsd]),
    );
  });

  it('seeds the genesis population from config: 3 alive, generation 0, distinct deterministic strategies, funded', () => {
    const { genesis, config } = world;
    assert.equal(genesis.population, 3, 'population.initial agents must be seeded');
    assert.equal(genesis.cap, 4, 'registry cap comes from config.population.cap');
    assert.equal(genesis.agents.length, 3);
    const symbols = genesis.agents.map((agent) => agent.genome.symbol);
    const families = genesis.agents.map((agent) => agent.genome.family);
    // symbols rotate per index; families follow the balanced swing/day genesis mix
    // (docs/BOT-AGENTS.md): momentum/meanrev blocks then breakout/gapfade blocks.
    assert.deepEqual(symbols, [config.symbols[0], config.symbols[1], config.symbols[2]]);
    const expectedFamilies = genesis.agents.map((_, index) => targetFamilyForIndex(index, config.population.initial));
    assert.deepEqual(families, expectedFamilies);
    // deterministic AND distinct: same config+index always yields the same genome, and a
    // population of 30 over 10 symbols x 4 families has no duplicate strategy
    const fullConfig = { ...config, population: { ...config.population, initial: 30 } };
    const populationSize = Math.min(30, config.symbols.length * 4);
    const genomes = Array.from({ length: populationSize }, (_, index) => genesisGenome(fullConfig, index));
    assert.deepEqual(genesisGenome(config, 0), genesisGenome(config, 0), 'genesis genomes must be deterministic');
    const pairs = new Set(genomes.map((genome) => `${genome.symbol}:${genome.family}`));
    assert.equal(pairs.size, populationSize, 'every genesis agent must have its own strategy');
    for (const genome of genomes) {
      assert.ok(genome.entryZ >= 0.8 && genome.entryZ <= 2.2, `entryZ out of bounds: ${genome.entryZ}`);
      assert.ok(genome.sizePct >= 0.12 && genome.sizePct <= 0.35, `sizePct out of bounds: ${genome.sizePct}`);
      assert.ok(['any', 'morning', 'afternoon'].includes(genome.sessionFilter));
    }
    for (const agent of genesis.agents) {
      assert.equal(agent.generation, 0, 'genesis is generation 0, not 1');
      assert.equal(agent.status, 'alive');
      assert.equal(agent.parentId, null);
      assert.equal(agent.endowmentUsd, config.endowmentUsd);
      assert.equal(genesis.cashById[agent.id], config.endowmentUsd, 'genesis cash must be granted, not just declared');
      assert.match(agent.id, /^atm-[0-9a-f]{8}$/);
    }
    assert.equal(genesis.accountEquityUsd, 100000);
    assert.equal(world.initStatus.population.alive, 3);
    assert.equal(world.initStatus.population.dead, 0);
    assert.ok(
      genesis.population * config.endowmentUsd <= genesis.accountEquityUsd * config.account.allocationCapPct,
      'genesis endowment must fit inside allocationCapPct of broker equity',
    );
  });

  it('charges metabolism every cycle, attributes it by role, and the deducted burn matches the formula', () => {
    const { roleCostsAfterTicks, costsPerAgent, registry, ledger, config } = world;
    const cycles = world.successfulTicks;
    const configuredPerCycle = expectedBurnPerCycle(config);
    assert.ok(registry.alive().length >= 1, 'at least one agent should survive to measure costs');
    for (const agent of registry.alive()) {
      const roles = roleCostsAfterTicks[agent.id];
      const total = Object.values(roles).reduce((sum, value) => sum + Number(value || 0), 0);
      assert.ok(total > 0, `agent ${agent.id} paid nothing: ${JSON.stringify(roles)}`);
      assert.equal(roles.prospector > 0, true, 'the Prospector must pay for its own data/inference');
      assert.equal(roles.builder > 0, true, 'the Builder must pay for its own inference');
      assert.equal(roles.executor > 0, true, 'the Executor must pay for its own inference');
      assert.ok(Number.isFinite(Number(roles.treasurer)), 'treasurer cost line must be present');
      assert.ok(
        Math.abs(total - costsPerAgent[agent.id]) < 1e-6,
        `roleCosts ${total} must sum to the ledger costsUsd ${costsPerAgent[agent.id]}`,
      );
      // The deducted per-cycle burn must match the configured formula (regression: it used
      // to be rounded up to ~0.04/cycle and hosting used to round to zero).
      const measuredPerCycle = costsPerAgent[agent.id] / cycles;
      assert.ok(
        Math.abs(measuredPerCycle - configuredPerCycle) < 1e-6,
        `agent ${agent.id}: measured ${measuredPerCycle}/cycle vs configured ${configuredPerCycle}/cycle`,
      );
      // Equity decomposition: equity - endowment = realized + unrealized - costs.
      const equity = ledger.equity(agent.id, world.lastPrices);
      const snapshot = ledger.snapshot(agent.id);
      const expectedDelta = snapshot.realizedPlUsd + snapshot.unrealizedPlUsd - snapshot.costsUsd;
      assert.ok(
        Math.abs(round2(equity.equityUsd - config.endowmentUsd) - round2(expectedDelta)) <= 0.05,
        `metabolism accounting mismatch for ${agent.id}: delta ${round2(equity.equityUsd - config.endowmentUsd)} vs P&L ${round2(expectedDelta)}`,
      );
    }
  });

  it('Treasurer prices the population: mandates, runway, reconciliation, cycle budget, no halt', () => {
    const tick = world.lastTreasury;
    const { registry, config } = world;
    assert.ok(tick, 'treasurer.tick() result must be available after cycles');
    assert.equal(tick.mode, 'sim');
    assert.equal(tick.halted, false);
    assert.deepEqual(tick.haltReasons, []);
    assert.equal(tick.state, 'STABLE');
    assert.equal(tick.cycleBudgetUsd, config.cycleBudget.STABLE);
    assert.equal(tick.account.status, 'ACTIVE');
    assert.equal(tick.reconciliation.ok, true, JSON.stringify(tick.reconciliation));
    assert.equal(
      tick.reconciliation.toleranceUsd,
      round2(config.account.reconciliationTolerancePct * tick.account.equityUsd),
    );
    assert.equal(tick.agentViews.length, registry.alive().length);
    assert.equal(tick.burnPerHourUsd, burnPerHour(config, registry.alive().length));
    const aliveIds = registry.alive().map((agent) => agent.id).sort();
    assert.deepEqual(Object.keys(tick.mandates).sort(), aliveIds, 'one mandate per living agent');
    for (const agentId of aliveIds) {
      const mandate = tick.mandates[agentId];
      assert.equal(mandate.agentId, agentId);
      assert.ok(Date.parse(mandate.expiresAt) > Date.parse(mandate.issuedAt), 'mandate must expire after issue');
      assert.deepEqual(mandate.allowedSymbols, [...config.symbols]);
      assert.equal(mandate.allowExitOnly, false);
      assert.equal(mandate.sizeBudgetUsd, mandate.maxOrderNotionalUsd);
      assert.ok(mandate.sizeBudgetUsd > 0);
      assert.ok(Number.isFinite(mandate.maxDailyOrdersRemaining));
    }
    for (const view of tick.agentViews) {
      assert.ok(view.runwayHours > 0 && Number.isFinite(view.runwayHours), 'runway must be computed, not balance');
      assert.notEqual(view.state, 'DEAD', 'living agents must not be marked DEAD');
      assert.equal(round2(view.cashUsd + view.positionsValueUsd), view.equityUsd);
      assert.ok(view.roleCosts && typeof view.roleCosts === 'object');
    }
    assert.equal(tick.mayReplicate, false);
    assert.ok(tick.surplus7dUsd < config.replication.surplus7dUsd);
  });

  it('records executions and really places orders through the brake wall with attributable ids', () => {
    const { ticks, totalOrders, ordersAfterTicks, broker, registry, config } = world;
    assert.ok(ticks.every((trace) => trace.halted === false), 'no cycle may be halted in the happy path');
    assert.ok(
      ticks.every((trace) => Array.isArray(trace.executions) && trace.executions.length >= 1),
      'every cycle must report per-agent execution results',
    );
    const actionCount = ticks
      .flatMap((trace) => trace.executions)
      .reduce((total, execution) => total + execution.actions, 0);
    assert.ok(actionCount > 0, 'executor must record actions (hold/entry/exit/skip)');
    assert.ok(totalOrders >= 1, `the sim population should place at least one order; traces reported ${totalOrders}`);
    assert.equal(ordersAfterTicks.length, totalOrders, 'broker order count must equal the orders the traces claim');
    const agentIds = new Set(registry.all().map((agent) => agent.id));
    for (const order of ordersAfterTicks) {
      assert.match(
        String(order.clientOrderId),
        /^atm:atm-[0-9a-f]{8}:spec-[0-9a-f]{8}:\d+$/,
        'client_order_id must attribute the fill to agent + spec',
      );
      const [, orderAgent] = String(order.clientOrderId).split(':');
      assert.equal(agentIds.has(orderAgent), true, `order attribution ${orderAgent} is not a registered agent`);
      // v3.2 basket bots can open defined-risk verticals as one mleg order; those carry the
      // buy/sell direction on their legs rather than a single top-level side.
      const mleg = order.orderClass === 'mleg' || (Array.isArray(order.legs) && order.legs.length >= 2);
      if (mleg) {
        assert.ok(order.legs.length >= 2);
        for (const leg of order.legs) assert.ok(['buy', 'sell'].includes(leg.side));
      } else {
        assert.ok(['buy', 'sell'].includes(order.side));
      }
      assert.equal(order.status, 'filled');
      assert.match(String(order.symbol ?? order.legs?.[0]?.symbol), /^[A-Z][A-Z0-9.]{0,20}$/);
    }
    // Slippage/spread and marks move the account only slightly in this tiny sample.
    const accountDrift = Math.abs(broker.getAccount().equityUsd - 100000);
    assert.ok(accountDrift < 1000, `sim broker account drifted unexpectedly: ${accountDrift}`);
    // the built specs were persisted and are the same ids the orders reference
    const specIds = new Set(ticks.flatMap((trace) => trace.builds.map((build) => build.specId)).filter(Boolean));
    assert.ok(specIds.size >= 1, 'at least one StrategySpec must be compiled');
    const specFiles = fs.readdirSync(world.paths.specsDir).filter((file) => file.endsWith('.json'));
    assert.ok(specFiles.length >= specIds.size, 'every built spec must be persisted to the specs dir');
    for (const order of ordersAfterTicks) {
      const specId = String(order.clientOrderId).split(':')[2];
      assert.match(specId, /^spec-[0-9a-f]{8}$/);
      assert.equal(fs.existsSync(path.join(world.paths.specsDir, `${specId}.json`)), true, `spec ${specId} must be on disk`);
    }
    for (const order of ordersAfterTicks) {
      // v3.2 basket bots can trade option contracts; the D4 whitelist applies to the UNDERLYING.
      const underlying = String(order.symbol ?? order.legs?.[0]?.symbol ?? '').match(/^([A-Z]+)\d{6}/)?.[1]
        ?? order.underlying
        ?? order.symbol;
      assert.ok(config.symbols.includes(underlying), `${underlying} outside universe`);
    }
    for (const trace of ticks) {
      const fatal = trace.errors.filter((error) => error.code && error.code !== 'BRAKE_DENIED');
      assert.deepEqual(fatal, [], `unexpected cycle error: ${JSON.stringify(fatal)}`);
    }
  });

  it('writes a death verdict and executes it in-process ONLY because mode=sim, with a schema-valid generation-0 obituary', () => {
    const { verdictTick, victim, registry, journal, internals, config } = world;
    // 1) the Treasurer wrote the request (and the verdict file is durable)
    assert.equal(verdictTick.deaths.length, 1, 'the Treasurer must emit one death verdict for the underfunded agent');
    assert.equal(verdictTick.deaths[0].agentId, victim.id);
    assert.equal(verdictTick.deaths[0].cause, 'insufficient_funds');
    assert.equal(verdictTick.deaths[0].finalEquityUsd, 0);
    assert.equal(world.deathsFileAfterVerdict.verdicts.length, 1);
    assert.equal(world.deathsFileAfterVerdict.verdicts[0].agentId, victim.id);
    // 2) only the sim (demo) path executes the verdict inside the engine
    assert.ok(Array.isArray(verdictTick.deathsExecuted), 'sim mode must report in-process death execution');
    assert.equal(verdictTick.deathsExecuted.length, 1);
    assert.equal(verdictTick.deathsExecuted[0].agentId, victim.id);
    assert.equal(registry.get(victim.id).status, 'dead', 'sim mode executes the verdict in-process');
    assert.equal(registry.get(victim.id).cause, 'insufficient_funds');
    assert.equal(registry.population(), 2);
    assert.equal(internals.ledger.snapshot(victim.id).cashUsd, 0, 'residual cash must be swept to the treasury pool');
    assert.equal(internals.state.condemned.has(victim.id), false, 'a dead agent must not remain condemned');

    // 3) the obituary is schema-valid; generation 0 stayed 0 (regression: truthiness used to make it 1)
    const obituary = world.obituary;
    assert.ok(obituary, 'a death without an obituary is a bug');
    assert.equal(validateObituary(obituary), obituary, 'obituary must satisfy the documented schema');
    for (const field of OBITUARY_FIELDS) assert.ok(Object.hasOwn(obituary, field), `missing obituary field ${field}`);
    assert.equal(obituary.agentId, victim.id);
    assert.equal(obituary.cause, 'insufficient_funds');
    assert.equal(obituary.generation, 0, 'genesis generation 0 must survive into the dataset');
    assert.equal(obituary.endowmentUsd, config.endowmentUsd);
    assert.equal(obituary.finalEquityUsd, 0);
    assert.equal(obituary.netPlUsd, -config.endowmentUsd);
    assert.equal(obituary.firstProfitAt, null, 'firstProfitAt=null is the most valuable line in the journal');
    assert.equal(obituary.productsShipped, 0);
    assert.equal(obituary.tradesCount, 0);
    assert.equal(obituary.lessons.length, 0);
    assert.ok(Number.isFinite(Date.parse(obituary.bornAt)));
    assert.ok(Number.isFinite(Date.parse(obituary.diedAt)));
    assert.ok(obituary.lifespanHours >= 0);
    assert.equal(obituary.lastRunwayHours, 0);
    assert.ok(obituary.genome && typeof obituary.genome === 'object' && obituary.genome.symbol);
    assert.deepEqual(readJsonlLines(world.paths.journal).map((row) => row.agentId), [victim.id]);
    assert.equal(journal.stats().total, 1);
    assert.equal(journal.stats().mostCommonCause, 'insufficient_funds');
    assert.ok(journal.lessonsFor(obituary.genome, { limit: 5 }).length >= 1);
  });

  it('persists a trace and state.json every cycle plus the durable registry/ledger/journal', () => {
    const { paths, successfulTicks } = world;
    assert.equal(fs.existsSync(paths.traces), true);
    const traces = readJsonlLines(paths.traces);
    assert.equal(traces.length, successfulTicks, 'one trace line per completed cycle');
    for (const trace of traces) {
      assert.match(String(trace.tickId), /^tick-[0-9a-f]{8}$/);
      assert.ok(Number.isFinite(Date.parse(trace.at)));
      assert.equal(trace.mode, 'sim');
      assert.ok(trace.treasury && typeof trace.treasury.state === 'string');
      assert.ok(Array.isArray(trace.executions));
      assert.ok(Array.isArray(trace.builds));
    }
    const state = readJsonFile(paths.stateFile);
    assert.equal(state.mode, 'sim');
    assert.ok(Number.isFinite(Date.parse(state.at)));
    assert.equal(state.agents.length, 3, 'state.json must include dead agents in the graveyard');
    assert.equal(state.population.alive, 2);
    assert.equal(state.population.dead, 1);
    assert.equal(state.population.total, 3, 'population.total must count alive + dead');
    assert.equal(state.population.condemned, 0);
    assert.equal(state.engine.ticks, successfulTicks, 'the persisted snapshot must reflect the completed cycle');
    assert.equal(state.engine.running, false, 'a tick must not start the loop');
    assert.equal(world.statusAfterTicks.engine.initialized, true);
    const victimRow = state.agents.find((agent) => agent.id === world.victim.id);
    assert.equal(victimRow.status, 'dead', 'an executed agent must be reported dead, not condemned');
    // durable modules
    const registryFile = readJsonFile(paths.registry);
    assert.equal(Object.keys(registryFile.agents).length, 3);
    assert.equal(registryFile.agents[world.victim.id].status, 'dead');
    const ledgerFile = readJsonFile(paths.ledger);
    assert.equal(typeof ledgerFile.agents[world.victim.id].cashUsd, 'number');
    assert.equal(ledgerFile.agents[world.victim.id].cashUsd, 0);
    assert.equal(readJsonlLines(paths.journal).length, 1);
    const dayStats = readJsonFile(paths.dayStats);
    assert.equal(dayStats.dayKey, '2026-01-05');
    assert.ok(Object.keys(dayStats.agents).length >= 2);
    for (const entry of Object.values(dayStats.agents)) {
      assert.ok(Number.isFinite(entry.startEquityUsd), 'daily-loss rule needs a day-start equity');
    }
    const treasuryState = readJsonFile(paths.treasuryState);
    assert.equal(treasuryState.mode, 'sim');
    assert.equal(treasuryState.halted, false);
  });

  it('keeps ledger invariants: no negative cash, cash+positions=equity, broker agreement', () => {
    const { ledger, registry, broker, lastPrices, lastTreasury } = world;
    const allIds = ledger.ids().filter((agentId) => agentId !== '__treasury__');
    assert.ok(allIds.length >= 2);
    const brokerPositions = Object.fromEntries(
      broker.getPositions().map((position) => [position.symbol, position.qty]),
    );
    const ledgerPositions = {};
    for (const agentId of allIds) {
      const snapshot = ledger.snapshot(agentId);
      assert.ok(snapshot.cashUsd >= 0, `negative cash for ${agentId}: ${snapshot.cashUsd}`);
      const equity = ledger.equity(agentId, lastPrices);
      assert.equal(
        round2(equity.cashUsd + equity.positionsValueUsd),
        equity.equityUsd,
        `cash+positions != equity for ${agentId}`,
      );
      assert.ok(equity.equityUsd >= 0, `negative equity for ${agentId}`);
      for (const [symbol, position] of Object.entries(snapshot.positions)) {
        ledgerPositions[symbol] = round2((ledgerPositions[symbol] ?? 0) + Number(position.qty || 0));
      }
      if (registry.get(agentId)?.status === 'dead') assert.equal(snapshot.cashUsd, 0, 'the Reaper must sweep a dead estate');
    }
    for (const [symbol, qty] of Object.entries(brokerPositions)) {
      assert.equal(
        round2(qty),
        round2(ledgerPositions[symbol] ?? 0),
        `broker holds ${qty} ${symbol} but the agent ledgers sum to ${ledgerPositions[symbol] ?? 0}`,
      );
    }
    const pool = ledger.pool();
    const account = broker.getAccount();
    assert.ok(account.cashUsd >= 0, 'broker cash must never go negative');
    const delta = round2(account.equityUsd - pool.totalUsd);
    assert.equal(lastTreasury.reconciliation.ok, true);
    assert.ok(
      Math.abs(delta) <= lastTreasury.reconciliation.toleranceUsd,
      `virtual ${pool.totalUsd} vs broker ${account.equityUsd} delta ${delta} beyond tolerance`,
    );
    // the only expected drift is ledger-only cycle cost bookkeeping; it must stay small
    assert.ok(Math.abs(delta) <= 10, `unexpected bookkeeping drift of ${delta} USD`);
  });

  it('status surface is honest and the brake dry-run actually traverses the chain (D9 proof included)', async () => {
    const { automaton, broker, registry } = world;
    const status = world.statusAfterTicks;
    assert.equal(status.engine.running, false);
    assert.equal(status.engine.killSwitch, false);
    assert.equal(status.engine.liveArmed, false);
    assert.equal(status.engine.ticks, world.successfulTicks, 'status.engine.ticks must not lag the loop');
    assert.equal(status.mode, 'sim');
    assert.ok(Array.isArray(status.agents));
    assert.equal(status.obituaries.total, 1);
    assert.equal(status.population.total, status.population.alive + status.population.dead);
    assert.equal(status.population.condemned, 0, 'no condemned agent should be left behind');
    assert.equal(status.agents.find((agent) => agent.id === world.victim.id).status, 'dead');
    assert.equal(automaton.isRunning(), false);

    // Reads must not trade or mutate the population.
    const ordersBefore = broker.getOrders({ status: 'all', limit: 500 }).length;
    const populationBefore = registry.population();
    await automaton.status();
    await automaton.obituaries({ limit: 5 });
    automaton.brakesView();
    assert.equal(broker.getOrders({ status: 'all', limit: 500 }).length, ordersBefore);
    assert.equal(registry.population(), populationBefore);

    // A dry run on a real agent with a compiled spec must be able to ALLOW (regression:
    // it used to pass a {specId} stub and always deny NO_PROOF).
    const alive = registry.alive()[0];
    const decision = await automaton.preTradeCheck({
      agentId: alive.id,
      symbol: alive.genome.symbol,
      side: 'buy',
      notionalUsd: 100,
      priceUsd: world.lastPrices[alive.genome.symbol],
    });
    assert.equal(decision.decision, 'ALLOW', JSON.stringify(decision));
    assert.equal(decision.brakeId, null);
    // ...and it must still apply the whitelist brake truthfully.
    const bad = await automaton.preTradeCheck({ agentId: alive.id, symbol: 'ZZZZ', side: 'buy', notionalUsd: 100, priceUsd: 100 });
    assert.equal(bad.decision, 'DENY');
    assert.equal(bad.code, 'INSTRUMENT_FORBIDDEN');
    assert.equal(bad.brakeId, 'D4');
    assert.equal(broker.getOrders({ status: 'all', limit: 500 }).length, ordersBefore, 'dry runs must not place orders');
  });

  it('replication opens only when the Treasurer gate is funded: one mutation, gen+1, inherited lessons, no money creation', async () => {
    const { registry, ledger, journal, automaton, clock, config, internals } = world;
    assert.equal(journal.count(), 1, 'the journal must already contain a death for lessons to inherit');
    const parent = registry.alive()[0];
    const populationBefore = registry.population();
    const parentGenomeBefore = { ...parent.genome };
    const surplusBefore = ledger.snapshot(parent.id).net7dUsd;
    // Artificially fund the parent: realize +600 through the virtual book (the broker does
    // not know about this ledger-only trade; it stays inside the reconciliation tolerance).
    ledger.applyFill(parent.id, { symbol: 'SPY', side: 'buy', qty: 25, priceUsd: 100, at: clock.now() });
    ledger.applyFill(parent.id, { symbol: 'SPY', side: 'sell', qty: 25, priceUsd: 160, at: clock.now() });
    ledger.save();
    // The funding is ledger-only but already inside the virtual economy: capture the virtual
    // total AFTER it so "no money creation" measures the birth, not the injected profit.
    const totalBefore = ledger.pool().totalUsd;
    const funded = await internals.treasurer.tick({ prices: world.lastPrices, dayStats: {} });
    assert.equal(funded.mayReplicate, true, JSON.stringify(funded.replication));
    assert.equal(funded.halted, false);
    assert.ok(funded.surplus7dUsd > surplusBefore);
    assert.ok(funded.surplus7dUsd >= config.replication.surplus7dUsd);

    world.clock.advance(CYCLE_MS);
    const trace = await automaton.tick();
    world.replicationTick = trace;
    const replication = trace.replication;
    assert.ok(replication && replication.childId, `expected a child, got ${JSON.stringify(replication)}`);
    assert.equal(replication.parentId, parent.id);
    const child = registry.get(replication.childId);
    assert.ok(child, 'the spawned child must be registered');
    world.childId = child.id; // expose early so later tests can use the child even if a check below fails
    assert.equal(child.parentId, parent.id);
    assert.equal(child.status, 'alive');
    assert.equal(child.generation, parent.generation + 1, 'child generation must be parent + 1 (gen-0 parent -> gen-1)');
    assert.equal(registry.population(), populationBefore + 1);
    assert.ok(registry.population() <= registry.cap, 'replication must respect the population cap');

    // exactly ONE genome field mutates (deep equality: inherited arrays such as `symbols`
    // are cloned by the registry, so reference comparison would mis-count them as mutations).
    // A `symbol` mutation also reorders the inherited basket; that is one logical mutation.
    const symbolMutated = parentGenomeBefore.symbol !== child.genome.symbol;
    const changed = Object.keys({ ...parentGenomeBefore, ...child.genome }).filter(
      (field) => {
        if (field === 'symbols' && symbolMutated) return false;
        return JSON.stringify(parentGenomeBefore[field]) !== JSON.stringify(child.genome[field]);
      },
    );
    assert.equal(changed.length, 1, `expected exactly one mutation, changed: ${JSON.stringify(changed)}`);
    const field = changed[0];
    assert.equal(MUTABLE_FIELDS.includes(field), true, `${field} is not in the MUTABLE catalogue`);
    // v3.2: the mutation must not grow the inherited multi-symbol basket.
    if (Array.isArray(parent.symbols) && parent.symbols.length > 0) {
      assert.equal(child.symbols.length, parent.symbols.length, 'child basket keeps the parent basket size');
    }
    assert.deepEqual(child.mutation, { field, from: parentGenomeBefore[field], to: child.genome[field] });
    assert.deepEqual(replication.mutation, child.mutation);
    assert.notEqual(child.mutation.from, child.mutation.to, 'a mutation must actually change the value');

    // the child inherits the journal digest, not the parent's code
    assert.ok(replication.lessons >= 1, 'child must inherit lessons from the journal');
    assert.ok(Array.isArray(child.notes) && child.notes.length >= 1);
    assert.ok(child.notes.every((note) => typeof note === 'string' && note.length > 0));
    assert.ok(
      child.notes.some((note) => note.includes('insufficient_funds')),
      `child notes should carry the journal lesson; got ${JSON.stringify(child.notes)}`,
    );

    // child endowment is funded from the parent's cash only — no money is created
    assert.equal(child.endowmentUsd, config.replication.childEndowmentUsd);
    assert.equal(ledger.snapshot(child.id).cashUsd, config.replication.childEndowmentUsd);
    const totalAfter = ledger.pool().totalUsd;
    assert.ok(totalAfter <= totalBefore + 0.01, 'replication must not create money');
    assert.ok(totalBefore - totalAfter < 1, 'the only shrinkage may be this cycle\'s costs');
    assert.equal(fs.existsSync(world.paths.registry), true);
  });

  it('kill switch blocks the whole cycle and every order, and the Reaper still closes risk by design', async () => {
    const { automaton, internals, registry, ledger, journal, broker, paths, clock } = world;
    const target = registry.get(world.childId);
    assert.ok(target, 'the spawned child should still be alive');
    assert.deepEqual(ledger.book(target.id).positions, {}, 'fresh child must have no positions for a clean kill');
    fs.writeFileSync(paths.killSwitch, JSON.stringify({ armedAt: clock.iso(), reason: 'verifier test' }), 'utf8');
    assert.equal(internals.brakes.isKillSwitchActive(), true);
    const alive = registry.alive();
    const ordersBefore = broker.getOrders({ status: 'all', limit: 500 }).length;
    const cashBefore = alive.map((agent) => ledger.snapshot(agent.id).cashUsd);

    world.clock.advance(CYCLE_MS);
    const trace = await automaton.tick();
    assert.equal(trace.halted, true);
    assert.deepEqual(trace.haltReasons, ['KILL_SWITCH']);
    assert.equal(broker.getOrders({ status: 'all', limit: 500 }).length, ordersBefore, 'no order may reach the broker');
    assert.equal(trace.executions.length, 0, 'a killed cycle must not execute');
    assert.equal(trace.builds.length, 0, 'a killed cycle must not build');
    assert.deepEqual(alive.map((agent) => ledger.snapshot(agent.id).cashUsd), cashBefore, 'no metabolism may be charged');
    assert.throws(
      () => internals.brakes.assertKillSwitchClear(),
      (error) => error.code === 'KILL_SWITCH',
    );

    // The Reaper is not stopped by the kill switch: it keeps closing risk.
    const targetCash = ledger.snapshot(target.id).cashUsd;
    ledger.charge(target.id, targetCash, { category: 'inference', role: 'executor', at: clock.now() });
    ledger.save();
    const externalReaper = createReaper({
      broker,
      registry,
      ledger,
      journal,
      config: world.config,
      paths,
      clock,
    });
    const sweep = await externalReaper.sweep({});
    const targetKill = sweep.killed.find((entry) => entry.agentId === target.id);
    assert.ok(targetKill, `the Reaper must still liquidate the dead agent under the kill switch; got ${JSON.stringify(sweep.killed)}`);
    assert.equal(targetKill.cause, 'insufficient_funds');
    assert.equal(registry.get(target.id).status, 'dead');
    // FINDING: paying the child's endowment put the parent below its drawdown death
    // threshold (endowment * (1 - maxDrawdownPct)), so the independent Reaper also kills the
    // PARENT as drawdown_limit. The replication gate only checks 2 x deathFloor, not the
    // drawdown rule (see docs/VERIFICATION.md, residual findings).
    const parentId = world.replicationTick.replication.parentId;
    const parentKill = sweep.killed.find((entry) => entry.agentId === parentId);
    assert.equal(sweep.killed.length, parentKill ? 2 : 1, JSON.stringify(sweep.killed));
    if (parentKill) {
      assert.equal(parentKill.cause, 'drawdown_limit');
      assert.ok(parentKill.finalEquityUsd < world.config.endowmentUsd * (1 - world.config.maxDrawdownPct));
    }
    assert.equal(journal.count(), 1 + sweep.killed.length, 'one obituary per executed death, no duplicates');

    fs.rmSync(paths.killSwitch, { force: true });
    assert.equal(internals.brakes.isKillSwitchActive(), false);
    assert.doesNotThrow(() => internals.brakes.assertKillSwitchClear());
  });

  it('has no engine-side control surface over the Reaper, and in paper/live the engine never executes a death', () => {
    const { automaton } = world;
    // D12/editorial: the only in-engine death path is the sim demo branch; the Engine facade
    // that spawns the external Reaper exposes no stop/disable method.
    const orchestratorSource = fs.readFileSync(path.join(PKG_ROOT, 'src', 'orchestrator.js'), 'utf8');
    assert.match(
      orchestratorSource,
      /config\.mode === 'sim'[\s\S]{0,400}createReaper/,
      'the in-process Reaper may only exist behind the sim-mode guard',
    );
    assert.equal(/child_process/.test(orchestratorSource), false, 'the cycle loop must not spawn processes');
    // The separately-verified paper-mode world proves no in-engine death execution without sim.
    assert.equal(Object.hasOwn(automaton._internals, 'reaper'), false);
    for (const key of Object.keys(automaton)) {
      assert.equal(/reaper|killswitch|kill-switch/i.test(key), false, `engine exposes "${key}"`);
    }
    const brakesView = automaton.brakesView();
    // v3.0: the wall is now D1-D18 (D15 short sale, D16 options, D17 margin, D18 expiry guard).
    assert.equal(brakesView.rules.length, 18);
    assert.deepEqual(brakesView.rules.map((rule) => rule.id), [
      'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12', 'D13', 'D14', 'D15', 'D16', 'D17', 'D18',
    ]);
  });
});

// ===========================================================================
// mode=paper: the engine writes a verdict; only the external Reaper executes it,
// durably, and the engine re-syncs from disk so it cannot keep trading a dead agent
// ===========================================================================

describe('death ownership (mode=paper): engine writes verdicts, external Reaper executes + persists', () => {
  const world = {};

  before(async () => {
    const env = makeEnv({ mode: 'paper' });
    world.env = env;
    world.config = env.config;
    world.paths = env.paths;
    world.clock = makeClock(T0);
    world.broker = createSimBroker(env.config, { seed: 6, accountEquityUsd: 100000, clock: world.clock });
    world.automaton = await createAutomaton({
      config: env.config,
      paths: env.paths,
      broker: world.broker,
      clock: world.clock,
    });
    await world.automaton.init();
    world.internals = world.automaton._internals;
    world.registry = world.internals.registry;
    world.ledger = world.internals.ledger;
    world.journal = world.internals.journal;

    // deliberately under-fund one agent
    world.victim = world.registry.alive()[0];
    world.ledger.charge(world.victim.id, world.ledger.snapshot(world.victim.id).cashUsd, {
      category: 'inference',
      role: 'executor',
      at: world.clock.now(),
    });
    world.ledger.save();
    world.clock.advance(CYCLE_MS);
    world.verdictTick = await world.automaton.tick();
    world.clock.advance(CYCLE_MS);
    world.secondTick = await world.automaton.tick();
  });

  it('the engine never executes the verdict in paper mode and does not trust a verdict file as death', () => {
    const { verdictTick, secondTick, registry, journal, automaton, paths } = world;
    assert.equal(verdictTick.deaths.length, 1);
    assert.equal(verdictTick.deaths[0].cause, 'insufficient_funds');
    assert.equal(Object.hasOwn(verdictTick, 'deathsExecuted'), false, 'paper/live must never execute deaths in-process');
    assert.equal(Object.hasOwn(secondTick, 'deathsExecuted'), false);
    assert.equal(registry.get(world.victim.id).status, 'alive', 'a verdict is a request, not an execution');
    assert.equal(automaton._internals.state.condemned.has(world.victim.id), true, 'the agent is condemned, not dead');
    assert.equal(journal.count(), 0, 'no obituary may be written by the engine');
    // The verdict is persisted as a request, and the engine stopped charging the condemned agent.
    const verdictFile = readJsonFile(paths.deaths);
    assert.equal(verdictFile.verdicts.length, 1);
    assert.equal(verdictFile.verdicts[0].agentId, world.victim.id);
  });

  it('an independent Reaper (fresh state instances, as the external process loads them) executes and persists the death', async () => {
    const { paths, config, broker, clock, victim } = world;
    // Fresh module instances = exactly what reaper-process.js does in its own OS process:
    // it loads state from disk and never shares the engine's memory.
    const reaperRegistry = createRegistry({ paths, config, clock });
    await reaperRegistry.load();
    const reaperLedger = createLedger({ paths, config, clock });
    await reaperLedger.load();
    const reaperJournal = createJournal({ paths, config });
    const reaper = createReaper({
      broker,
      registry: reaperRegistry,
      ledger: reaperLedger,
      journal: reaperJournal,
      config,
      paths,
      clock,
    });
    const swept = await reaper.sweep({ prices: world.internals.state.lastPrices });
    assert.equal(swept.killed.length, 1, JSON.stringify(swept.skipped));
    assert.equal(swept.killed[0].agentId, victim.id);
    assert.equal(swept.killed[0].cause, 'insufficient_funds');

    // Durability: the kill must be on disk, not only in the Reaper's memory (this was the
    // critical defect — the death used to resurrect on reload).
    const persistedRegistry = readJsonFile(paths.registry);
    assert.equal(persistedRegistry.agents[victim.id].status, 'dead');
    const persistedLedger = readJsonFile(paths.ledger);
    assert.equal(persistedLedger.agents[victim.id].cashUsd, 0);
    const reloaded = createRegistry({ paths, config, clock });
    await reloaded.load();
    assert.equal(reloaded.get(victim.id).status, 'dead', 'a fresh load must not resurrect the agent');
    const reloadedLedger = createLedger({ paths, config, clock });
    await reloadedLedger.load();
    assert.equal(reloadedLedger.snapshot(victim.id).cashUsd, 0);
    const obituary = reaperJournal.list()[0];
    assert.ok(obituary);
    assert.equal(validateObituary(obituary), obituary);
    assert.equal(obituary.generation, 0, 'genesis generation 0 must not be relabelled as 1');
    assert.equal(reaperJournal.count(), 1);

    // Idempotence: a second sweep must not duplicate the death.
    const second = await reaper.sweep({ prices: world.internals.state.lastPrices });
    assert.equal(second.killed.length, 0);
    assert.equal(reaperJournal.count(), 1);
    world.reaperJournal = reaperJournal;
  });

  it('the engine re-syncs from disk: killed agents are never charged/traded again and the death is not duplicated', async () => {
    const { automaton, registry, journal, ledger, broker, clock, config, paths } = world;
    world.clock.advance(CYCLE_MS);
    const trace = await automaton.tick();
    // The engine loaded registry/ledger from disk at the start of the cycle.
    assert.equal(registry.get(world.victim.id).status, 'dead');
    assert.equal(automaton._internals.state.condemned.has(world.victim.id), false, 'dead agents are pruned from the condemned set');
    assert.ok(!trace.executions.some((execution) => execution.agentId === world.victim.id), 'a dead agent must not be traded');
    assert.equal(journal.count(), 1, 'the engine must not duplicate the external obituary');
    const status = await automaton.status();
    assert.equal(status.population.alive, 2);
    assert.equal(status.population.dead, 1);
    assert.equal(status.population.total, 3);
    assert.equal(status.population.condemned, 0);
    assert.equal(status.agents.find((agent) => agent.id === world.victim.id).status, 'dead');
    // broker cash/positions remain consistent with the survivor ledgers
    const account = broker.getAccount();
    assert.ok(account.cashUsd >= 0);
    assert.ok(Number.isFinite(account.equityUsd));
    void ledger;
    void config;
    void paths;
  });
});

// ===========================================================================
// daily_loss_limit: the real day P&L now reaches the Treasurer (fixed)
// ===========================================================================

describe('daily_loss_limit death rule receives real day P&L (fixed), but the Reaper cannot execute it (residual gap)', () => {
  const world = {};

  before(async () => {
    const env = makeEnv({ population: { initial: 1, cap: 2 } });
    world.env = env;
    world.config = env.config;
    world.paths = env.paths;
    world.clock = makeClock(T0);
    world.broker = createSimBroker(env.config, { seed: 11, accountEquityUsd: 100000, clock: world.clock });
    world.automaton = await createAutomaton({
      config: env.config,
      paths: env.paths,
      broker: world.broker,
      clock: world.clock,
    });
    await world.automaton.init();
    world.internals = world.automaton._internals;
    world.agent = world.internals.registry.alive()[0];
    world.clock.advance(CYCLE_MS);
    await world.automaton.tick(); // records the day-start equity
    // Lose > maxDailyLossPct (5% of 5000 = 250) in one cycle, but stay above the drawdown
    // floor (25% = 1250) and the death floor (250), so only the daily-loss rule can fire.
    world.internals.ledger.charge(world.agent.id, 300, { category: 'inference', role: 'executor', at: world.clock.now() });
    world.internals.ledger.save();
    world.clock.advance(CYCLE_MS);
    world.trace = await world.automaton.tick();
  });

  it('fires the daily_loss_limit verdict from real P&L (not a hardcoded zero)', () => {
    const { trace, internals, agent, config } = world;
    assert.ok(trace.deaths.length >= 1, `expected a death verdict, got ${JSON.stringify(trace.deaths)}`);
    assert.equal(trace.deaths[0].agentId, agent.id);
    assert.equal(trace.deaths[0].cause, 'daily_loss_limit');
    assert.equal(internals.state.condemned.has(agent.id), true);
    assert.equal(internals.registry.get(agent.id).status, 'alive', 'the verdict is a request, not the execution');
    assert.equal(internals.journal.count(), 0);
    // the day P&L that produced it is the real equity change, not a constant
    assert.ok(config.risk.maxDailyLossPct * config.endowmentUsd >= 250);
  });

  it('daily_loss_limit is executable: the next sweep re-derives it from the persisted day record', async () => {
    const { internals, automaton, clock } = world;
    world.clock.advance(CYCLE_MS);
    const trace = await automaton.tick();
    assert.equal(internals.registry.get(world.agent.id).status, 'dead', 'the Reaper executes the verdict');
    const journal = createJournal({ paths: world.paths, config: world.config });
    const obituaries = await journal.list({ limit: 5 });
    assert.equal(obituaries.length, 1);
    assert.equal(obituaries[0].cause, 'daily_loss_limit');
    assert.ok(trace.deathsExecuted?.some((entry) => entry.agentId === world.agent.id && entry.cause === 'daily_loss_limit'));
  });
});

// ===========================================================================
// Engine facade (what the Harness plugin and the CLI talk to)
// ===========================================================================

describe('engine.js facade: read-only views, no secrets, never auto-starts trading', () => {
  const world = {};

  before(() => {
    const env = makeEnv();
    world.env = env;
    world.secretKeyId = 'PK-ENGINE-PROBE-KEY-9f3a2b';
    world.secretKey = 'ENGINE-PROBE-SECRET-9f3a2b';
    fs.writeFileSync(
      path.join(env.dir, '.env'),
      `ALPACA_API_KEY_ID=${world.secretKeyId}\nALPACA_API_SECRET_KEY=${world.secretKey}\n`,
      'utf8',
    );
    world.simPaths = statePaths(env.config);
    world.engine = createEngine({
      cwd: env.dir,
      configFile: path.join(env.dir, 'no-such-config.json'),
      envFile: path.join(env.dir, '.env'),
      overrides: {
        stateDir: path.join(env.dir, 'state'),
        mode: 'sim',
        seed: 6,
        accountEquityUsd: 100000,
      },
    });
    world.secrets = [world.secretKeyId, world.secretKey];
  });

  it('status/configView/brakesView/obituaries work without constructing the engine or starting trading', async () => {
    const { engine, secrets, simPaths } = world;
    const status = await engine.status();
    assert.equal(status.mode, 'sim');
    assert.equal(status.engine.running, false);
    assert.equal(engine.automaton, null, 'a read must not construct the trading automaton');
    assert.equal(engine.isRunning(), false);
    assert.equal(fs.existsSync(simPaths.stateFile), false, 'reading status must not write a trading snapshot');
    assertNoSecrets(status, secrets, 'engine.status()');

    const configView = engine.configView();
    assert.equal(configView.config.mode, 'sim');
    assert.equal(configView.config.allowLive, false);
    assert.equal(configView.summary.mode, 'sim');
    assert.ok(Array.isArray(configView.sources) && configView.sources.includes('defaults'));
    assert.equal(path.resolve(configView.stateDir), path.resolve(simPaths.stateDir));
    assertNoSecrets(configView, secrets, 'engine.configView()');

    const brakesView = await engine.brakesView();
    assert.equal(brakesView.rules.length, 18);
    assert.equal(brakesView.killSwitch, false);
    assert.equal(brakesView.liveArmed, false);
    assert.equal(brakesView.mode, 'sim');
    assertNoSecrets(brakesView, secrets, 'engine.brakesView()');

    const obituaries = await engine.obituaries({ limit: 5 });
    assert.equal(obituaries.stats.total, 0);
    assert.deepEqual(obituaries.items, []);
    assertNoSecrets(obituaries, secrets, 'engine.obituaries()');

    assert.equal(engine.automaton, null, 'read-only facade methods must never auto-start trading');
    assert.equal(engine.isRunning(), false);
  });

  it('exposes no way to stop, disable or re-arm the external Reaper (read-only status only)', () => {
    const { engine } = world;
    const reaperishKeys = Object.getOwnPropertyNames(engine).filter((key) => /reaper/i.test(key));
    assert.deepEqual(reaperishKeys, ['reaper'], 'the only Reaper surface is a read-only status getter');
    for (const method of [
      'stopReaper',
      'killReaper',
      'disableReaper',
      'terminateReaper',
      'pauseReaper',
      'reaperStop',
      'signalReaper',
      'restartReaper',
    ]) {
      assert.equal(typeof engine[method], 'undefined', `engine.${method} must not exist`);
    }
    const reaperStatus = engine.reaper;
    assert.ok(reaperStatus && typeof reaperStatus === 'object');
    for (const [key, value] of Object.entries(reaperStatus)) {
      assert.equal(typeof value !== 'function', true, `engine.reaper.${key} must not be callable`);
    }
  });

  it('probe checks the broker account/clock without starting the population or leaking secrets', async () => {
    const { engine } = world;
    const probe = await engine.probe();
    assert.equal(probe.mode, 'sim');
    assert.equal(probe.hasCredentials, true);
    assert.equal(probe.liveArmed, false);
    assert.equal(probe.error, null);
    assert.ok(probe.account, 'probe must read the broker account');
    assert.equal(probe.account.equityUsd, 100000);
    assert.equal(probe.account.status, 'ACTIVE');
    assert.ok(probe.clock && probe.clock.isOpen === true);
    assert.equal(engine.automaton, null, 'probe must not construct the trading automaton');
    assert.equal(engine.isRunning(), false);
    assertNoSecrets(probe, world.secrets, 'engine.probe()');
  });

  it('tick() initialises and runs one full cycle but leaves the loop stopped', async () => {
    const { engine, simPaths } = world;
    const result = await engine.tick();
    assert.match(String(result.trace.tickId), /^tick-[0-9a-f]{8}$/);
    assert.equal(result.trace.halted, false);
    assert.equal(result.status.population.alive, 3);
    assert.equal(result.status.engine.ticks, 1, 'status must reflect the completed tick immediately');
    assert.equal(fs.existsSync(simPaths.stateFile), true);
    assert.equal(engine.automaton === null, false);
    assert.equal(engine.isRunning(), false, 'tick must not start the recurring loop');
    assertNoSecrets(result, world.secrets, 'engine.tick()');
  });

  it('emergencyStop arms the kill switch, refuses the next cycle, and clear removes it', async () => {
    const { engine, simPaths } = world;
    const armed = await engine.emergencyStop();
    assert.equal(armed.killSwitch, true);
    assert.equal(fs.existsSync(simPaths.killSwitch), true);
    const view = await engine.brakesView();
    assert.equal(view.killSwitch, true);
    const refused = await engine.tick();
    assert.equal(refused.trace.halted, true);
    assert.deepEqual(refused.trace.haltReasons, ['KILL_SWITCH']);
    const cleared = await engine.clearEmergencyStop();
    assert.equal(cleared.killSwitch, false);
    assert.equal(fs.existsSync(simPaths.killSwitch), false);
    assert.equal(engine.isRunning(), false);
  });
});

// ===========================================================================
// v3.0 multi-instrument: real brakes + real executor + deterministic sim broker
// ===========================================================================

/**
 * Multi-instrument test world: real brakes/executor/ledger/registry and the sim broker,
 * which implements getAsset/getOptionChain/getOptionQuote, short stock and mleg orders.
 * The broker shares the test clock so its synthetic expiries line up with ledger DTE.
 */
function makeInstrumentWorld({ seed = 7, symbol = 'META', endowmentUsd = 5000, overrides = {} } = {}) {
  const env = makeEnv({
    population: { initial: 0, cap: 10 },
    endowmentUsd,
    replication: {
      childEndowmentUsd: Math.max(1, Math.floor(endowmentUsd / 2)),
      surplus7dUsd: 150,
      minRunwayHours: 72,
    },
    instruments: {
      maxOptionPremiumPctEquity: 0.5,
      maxOptionPremiumUsd: 2500,
      maxShortNotionalUsd: 2500,
      maxMarginPctEquity: 0.5,
    },
    risk: { maxOrderPctOfEquity: 0.5, maxOrderNotionalUsd: 2500, maxOpenPositions: 8, maxPositionPct: 0.8 },
    ...overrides,
  });
  const clock = makeClock(T0);
  const broker = createSimBroker(env.config, { seed, accountEquityUsd: 100000, clock });
  const registry = createRegistry({ paths: env.paths, config: env.config, clock });
  const ledger = createLedger({ paths: env.paths, config: env.config, clock });
  const brakes = createBrakes({ config: env.config, paths: env.paths, clock });
  const executor = createExecutor({ broker, brakes, ledger, config: env.config, clock });
  const id = 'atm-0000beef';
  registry.register({
    id,
    generation: 0,
    bornAt: clock.iso(),
    status: 'alive',
    endowmentUsd,
    genome: { symbol, family: 'momentum' },
    mutation: null,
    specId: 'spec-v3',
    notes: [],
  });
  ledger.ensureAgent(id, { endowmentUsd, at: clock.iso() });
  ledger.grant(id, endowmentUsd, { reason: 'genesis-endowment', at: clock.iso() });
  ledger.anchorToBrokerEquity(100000);
  const permissions = deriveInstrumentPermissions(env.config, endowmentUsd);
  const mandate = {
    agentId: id,
    issuedAt: clock.iso(),
    expiresAt: new Date(T0 + 10 * 60 * 1000).toISOString(),
    state: 'STABLE',
    sizeBudgetUsd: 2500,
    maxOrderNotionalUsd: 2500,
    maxDailyOrdersRemaining: 12,
    allowedSymbols: [...env.config.symbols],
    allowExitOnly: false,
    instruments: permissions,
    accountEquityUsd: 100000,
    allocatedEquityUsd: endowmentUsd,
    buyingPowerUsd: 100000,
  };
  return {
    env,
    config: env.config,
    paths: env.paths,
    clock,
    broker,
    registry,
    ledger,
    brakes,
    executor,
    id,
    symbol,
    endowmentUsd,
    permissions,
    mandate,
    quote: broker.getLatestQuote(symbol),
  };
}

function instrumentSpec(world, overrides = {}) {
  return {
    specId: 'spec-deadbeef',
    hypothesisId: 'hyp-v3',
    agentId: world.id,
    symbol: world.symbol,
    family: 'momentum',
    createdAt: world.clock.iso(),
    proofRef: 'https://data.alpaca.markets/v2/stocks/bars?symbols=' + world.symbol,
    proof: { observedAt: new Date(world.clock.now() - 60 * 60 * 1000).toISOString(), sampleSize: 20 },
    params: {
      lookback: 60,
      entryZ: 1,
      exitZ: 0.5,
      stopPct: 0.02,
      targetPct: 0.04,
      maxHoldBars: 12,
      sizePct: 0.2,
      sessionFilter: 'any',
    },
    ...overrides,
  };
}

function instrumentPolicy(world, prefer, extra = {}) {
  return {
    stance: 'trade',
    atMs: world.clock.now(),
    sizeMultiplier: 1,
    instrument: { prefer },
    ...extra,
  };
}

/** 35 flat bars then a 5-bar trend: momentum z is strongly bullish (dir=1) or bearish (dir=-1). */
function instrumentBars(last, direction = 1) {
  const bars = [];
  for (let i = 0; i < 35; i += 1) {
    const c = last * 0.97;
    bars.push({ t: T0 - (40 - i) * 60 * 60 * 1000, o: c, h: c * 1.005, l: c * 0.995, c, v: 1000 });
  }
  for (let i = 35; i < 40; i += 1) {
    const c = last * (1 + direction * 0.01 * (i - 34));
    bars.push({ t: T0 - (40 - i) * 60 * 60 * 1000, o: c, h: c * 1.005, l: c * 0.995, c, v: 1000 });
  }
  return bars;
}

async function runInstrumentExecutor(world, { policy = null, direction = 1, dayStats = null, spec = null, bars = null, profile = null, research = null, mandate = null } = {}) {
  const quote = world.broker.getLatestQuote(world.symbol);
  return world.executor.run({
    agent: world.registry.get(world.id),
    spec: spec ?? instrumentSpec(world),
    mandate: mandate ?? {
      ...world.mandate,
      issuedAt: world.clock.iso(),
      expiresAt: new Date(world.clock.now() + 10 * 60 * 1000).toISOString(),
    },
    quotes: { [world.symbol]: quote },
    bars: { [world.symbol]: bars ?? instrumentBars(quote.last, direction) },
    dayStats: dayStats ?? { dayKey: '2026-01-05', ordersCount: 0, startEquityUsd: world.endowmentUsd, pnlUsd: 0 },
    now: world.clock.now(),
    policy,
    profile,
    research,
  });
}

/** Submit one order through the sim broker and mirror the fill into the virtual ledger. */
function brokerFill(world, { side, symbol = world.symbol, assetClass = 'us_equity', qty = 1, option = null, groupId = null, structure = null, positionIntent = null }) {
  const quote = assetClass === 'us_option' ? world.broker.getOptionQuote(symbol) : world.broker.getLatestQuote(symbol);
  assert.ok(quote, `sim broker must quote ${symbol}`);
  const price = side === 'buy' ? quote.ask : quote.bid;
  const order = world.broker.submitOrder({
    symbol,
    assetClass,
    side,
    qty,
    type: assetClass === 'us_option' ? 'limit' : 'market',
    ...(assetClass === 'us_option' ? { limitPrice: price, positionIntent: positionIntent ?? undefined } : {}),
  });
  world.ledger.applyFill(world.id, {
    symbol,
    assetClass,
    side,
    qty: order.filledQty,
    priceUsd: order.avgFillPriceUsd,
    multiplier: assetClass === 'us_option' ? 100 : 1,
    option,
    groupId,
    structure,
    at: world.clock.now(),
    orderId: order.id,
  });
  return order;
}

/** Real brake wall with the world's mandate; mutate() builds the order context. */
function instrumentBrakeCheck(world, mutate) {
  const quote = world.broker.getLatestQuote(world.symbol);
  const input = {
    mode: world.config.mode,
    now: world.clock.now(),
    agentId: world.id,
    dayStats: { dayKey: '2026-01-05', ordersCount: 0, startEquityUsd: world.endowmentUsd, pnlUsd: 0 },
    quote,
    order: { symbol: world.symbol, side: 'buy', qty: 1, priceUsd: quote.ask, notionalUsd: round2(quote.ask) },
    equityUsd: world.endowmentUsd,
    positions: [],
    mandate: JSON.parse(JSON.stringify(world.mandate)),
    spec: instrumentSpec(world),
    accountEquityUsd: 100000,
    allocatedEquityUsd: world.endowmentUsd,
    marginDebtUsd: 0,
    buyingPowerUsd: 100000,
    spreadBps: 2,
  };
  if (typeof mutate === 'function') mutate(input);
  return world.brakes.checkOrder(input);
}

/** Synthetic OCC option symbol for an expiry `days` after T0. */
function testOcc(underlying, strikeUsd, type, days) {
  const iso = new Date(T0 + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const datePart = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}`;
  return `${underlying}${datePart}${type === 'put' ? 'P' : 'C'}${String(Math.round(strikeUsd * 1000)).padStart(8, '0')}`;
}

function optionContract(world, { type = 'call', days = null } = {}) {
  const chain = world.broker.getOptionChain({ underlying: world.symbol, type, limit: 250 });
  assert.ok(chain.length > 0, 'sim option chain must not be empty');
  const inWindow = chain.filter((c) => c.dte >= world.config.instruments.minDTE && c.dte <= world.config.instruments.maxDTE);
  const pool = days === null ? (inWindow.length > 0 ? inWindow : chain) : chain.filter((c) => c.expiration === new Date(T0 + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  const sorted = [...pool].sort((a, b) => a.strikeUsd - b.strikeUsd);
  assert.ok(sorted.length > 0, 'no contracts in the requested expiry/window');
  return sorted[Math.floor(sorted.length / 2)];
}

function optionMeta(world, contract, { groupId = null, structure = null } = {}) {
  return {
    underlying: world.symbol,
    expiration: contract.expiration,
    type: contract.type,
    strikeUsd: contract.strikeUsd,
    multiplier: 100,
    groupId,
    structure,
  };
}

describe('v3.0 multi-instrument: broker surface, short stock, long options, spreads, margin, DTE, death', () => {
  it('sim broker v3 surface: assets, deterministic option chain/quotes, short stock and option positions', () => {
    const world = makeInstrumentWorld();
    const asset = world.broker.getAsset(world.symbol);
    assert.equal(asset.tradable, true);
    assert.equal(asset.shortable, true);
    assert.equal(asset.marginable, true);

    const chain = world.broker.getOptionChain({ underlying: world.symbol, type: 'call', limit: 250 });
    assert.ok(chain.length >= 4, 'the deterministic chain must offer contracts');
    for (const contract of chain) {
      assert.match(contract.symbol, /^[A-Z]{1,6}\d{6}[CP]\d{8}$/, 'contracts use OCC symbols');
      assert.equal(contract.underlying, world.symbol);
      assert.equal(contract.type, 'call');
      assert.equal(contract.multiplier, 100, 'one contract covers 100 shares');
      assert.ok(contract.strikeUsd > 0);
      assert.ok(Number.isFinite(contract.dte) && contract.dte >= 0);
      assert.ok(contract.closePriceUsd > 0);
    }
    const inWindow = chain.filter(
      (contract) => contract.dte >= world.config.instruments.minDTE && contract.dte <= world.config.instruments.maxDTE,
    );
    assert.ok(inWindow.length > 0, 'chain contains contracts inside minDTE..maxDTE');
    const contract = inWindow[0];
    const quote = world.broker.getOptionQuote(contract.symbol);
    assert.ok(quote.bid > 0 && quote.ask >= quote.bid && quote.mark > 0);
    assert.equal(quote.multiplier, 100);

    // signed stock: short sell and buy-to-cover through the broker
    const short = world.broker.submitOrder({ symbol: world.symbol, side: 'sell', qty: 2, type: 'market' });
    assert.equal(short.status, 'filled');
    let positions = world.broker.getPositions();
    assert.equal(positions.find((position) => position.symbol === world.symbol).qtySigned, -2);
    assert.equal(positions.find((position) => position.symbol === world.symbol).side, 'SHORT');
    world.broker.submitOrder({ symbol: world.symbol, side: 'buy', qty: 2, type: 'market' });
    positions = world.broker.getPositions();
    assert.equal(positions.some((position) => position.symbol === world.symbol), false);

    // option contract buy and sell-to-close through the broker
    const buy = world.broker.submitOrder({
      symbol: contract.symbol,
      assetClass: 'us_option',
      side: 'buy',
      qty: 1,
      type: 'limit',
      limitPrice: quote.ask,
      positionIntent: 'buy_to_open',
    });
    assert.equal(buy.status, 'filled');
    const optionPosition = world.broker.getPositions().find((position) => position.symbol === contract.symbol);
    assert.equal(optionPosition.assetClass, 'us_option');
    assert.equal(optionPosition.qtySigned, 1);
    assert.equal(optionPosition.multiplier, 100);
    assert.equal(optionPosition.option.type, 'call');
    assert.equal(optionPosition.option.strikeUsd, contract.strikeUsd);
    const sell = world.broker.submitOrder({
      symbol: contract.symbol,
      assetClass: 'us_option',
      side: 'sell',
      qty: 1,
      type: 'limit',
      limitPrice: quote.bid,
      positionIntent: 'sell_to_close',
    });
    assert.equal(sell.status, 'filled');
    assert.equal(world.broker.getPositions().some((position) => position.symbol === contract.symbol), false);

    const account = world.broker.getAccount();
    assert.equal(account.shortingEnabled, true);
    assert.equal(account.optionsTradingLevel, 3);
    assert.ok(Number(account.marginMultiplier) >= 1);
    assert.equal(world.broker.describe().instruments.options, true);
  });

  it('short-stock round trip through the executor and the real brake wall: open, mark, cover, realized P&L', async () => {
    const world = makeInstrumentWorld();
    const open = await runInstrumentExecutor(world, {
      policy: instrumentPolicy(world, 'short_stock'),
      direction: -1,
    });
    assert.deepEqual(open.denied, [], 'a compliant short must pass D1-D18');
    assert.equal(open.orders.length, 1);
    const shortOrder = open.orders[0];
    assert.equal(shortOrder.side, 'sell');
    assert.equal(shortOrder.assetClass, 'us_equity');
    assert.equal(shortOrder.status, 'filled');
    assert.ok(shortOrder.filledQty > 0 && Number.isInteger(shortOrder.filledQty), 'short stock is whole shares');
    assert.equal(open.actions.some((action) => action.type === 'entry' && action.side === 'sell'), true);

    const position = world.ledger.snapshot(world.id).positionsList.find((entry) => entry.symbol === world.symbol);
    assert.ok(position, 'the short must be booked in the virtual ledger');
    assert.ok(position.qtySigned < 0);
    assert.equal(position.side, 'SHORT');
    const brokerPosition = world.broker.getPositions().find((entry) => entry.symbol === world.symbol);
    assert.equal(brokerPosition.qtySigned, position.qtySigned);
    const cashAfterOpen = world.ledger.snapshot(world.id).cashUsd;
    assert.equal(round2(cashAfterOpen), round2(world.endowmentUsd + shortOrder.notionalUsd));
    const mark = world.broker.getLatestQuote(world.symbol).last;
    const marked = world.ledger.equity(world.id, { [world.symbol]: mark });
    assert.equal(marked.positionsValueUsd, round2(position.qtySigned * mark));
    assert.equal(marked.equityUsd, round2(cashAfterOpen + marked.positionsValueUsd));
    assert.equal(marked.marginDebtUsd, 0);

    const cover = await runInstrumentExecutor(world, {
      policy: { stance: 'trade', atMs: world.clock.now(), exitPressure: 'exit' },
      direction: -1,
    });
    assert.deepEqual(cover.denied, []);
    assert.equal(cover.orders.length, 1);
    const coverOrder = cover.orders[0];
    assert.equal(coverOrder.side, 'buy');
    assert.equal(coverOrder.filledQty, shortOrder.filledQty);
    const realized = world.ledger.snapshot(world.id).realizedPlUsd;
    assert.equal(realized, round2((shortOrder.avgFillPriceUsd - coverOrder.avgFillPriceUsd) * shortOrder.filledQty));
    assert.deepEqual(world.ledger.snapshot(world.id).positionsList, []);
    assert.equal(round2(world.ledger.snapshot(world.id).cashUsd), round2(world.endowmentUsd + realized));
    assert.equal(world.ledger.equity(world.id, {}).equityUsd, world.ledger.snapshot(world.id).cashUsd);
    assert.equal(world.broker.getPositions().some((entry) => entry.symbol === world.symbol), false);
    for (const order of [shortOrder, coverOrder]) {
      assert.match(String(order.clientOrderId), /^atm:atm-[0-9a-f]{8}:spec-[0-9a-f]{8}:\d+$/);
    }
  });

  it('long-call round trip through the executor: multiplier 100, premium cash flow, realized P&L (D-V3-1 regression)', async () => {
    const world = makeInstrumentWorld();
    const open = await runInstrumentExecutor(world, { policy: instrumentPolicy(world, 'long_call'), direction: 1 });
    assert.deepEqual(open.denied, [], 'a long call must pass D1-D18 (contract symbol reaches the brake wall)');
    assert.equal(open.orders.length, 1);
    const buyOrder = open.orders[0];
    assert.equal(buyOrder.assetClass, 'us_option');
    assert.match(String(buyOrder.symbol), /^[A-Z]{1,6}\d{6}[CP]\d{8}$/, 'the option order symbol must be the OCC contract');
    assert.equal(buyOrder.side, 'buy');
    assert.equal(buyOrder.status, 'filled');
    assert.ok(Number.isInteger(buyOrder.filledQty) && buyOrder.filledQty >= 1);
    assert.deepEqual(open.actions.find((action) => action.type === 'entry')?.instrument, 'long_call');

    const position = world.ledger.snapshot(world.id).positionsList[0];
    assert.ok(position);
    assert.equal(position.assetClass, 'us_option');
    assert.equal(position.symbol, buyOrder.symbol);
    assert.equal(position.multiplier, 100);
    assert.equal(position.qtySigned, buyOrder.filledQty);
    assert.equal(position.option.underlying, world.symbol);
    assert.equal(position.option.type, 'call');
    assert.ok(position.option.strikeUsd > 0);
    assert.ok(position.dte >= world.config.instruments.autoCloseDTE);
    const premiumDebit = round2(buyOrder.filledQty * buyOrder.avgFillPriceUsd * 100);
    assert.equal(position.marketValueUsd, premiumDebit);
    assert.equal(round2(world.ledger.snapshot(world.id).cashUsd), round2(world.endowmentUsd - premiumDebit));
    const brokerPosition = world.broker.getPositions().find((entry) => entry.symbol === buyOrder.symbol);
    assert.equal(brokerPosition.qtySigned, buyOrder.filledQty);
    assert.equal(brokerPosition.multiplier, 100);

    const close = await runInstrumentExecutor(world, {
      policy: { stance: 'trade', atMs: world.clock.now(), exitPressure: 'exit' },
      direction: 1,
    });
    assert.deepEqual(close.denied, []);
    assert.equal(close.orders.length, 1);
    const sellOrder = close.orders[0];
    assert.equal(sellOrder.symbol, buyOrder.symbol);
    assert.equal(sellOrder.side, 'sell');
    assert.equal(sellOrder.filledQty, buyOrder.filledQty);
    const realized = round2((sellOrder.avgFillPriceUsd - buyOrder.avgFillPriceUsd) * buyOrder.filledQty * 100);
    assert.equal(world.ledger.snapshot(world.id).realizedPlUsd, realized);
    assert.deepEqual(world.ledger.snapshot(world.id).positionsList, []);
    assert.equal(round2(world.ledger.snapshot(world.id).cashUsd), round2(world.endowmentUsd + realized));
    assert.equal(world.ledger.equity(world.id, {}).equityUsd, world.ledger.snapshot(world.id).cashUsd);
    assert.equal(world.broker.getPositions().some((entry) => entry.symbol === buyOrder.symbol), false);
  });
});

// ---------------------------------------------------------------------------
// v3.0 covered calls, D15-D18 integration context, the four verticals, margin and DTE
// ---------------------------------------------------------------------------

describe('v3.0 multi-instrument: covered calls, D15-D18 wall, defined-risk verticals, margin, DTE', () => {
  it('covered call: real brakes deny without 100 shares and allow with shares; executor sells premium against held shares', async () => {
    const world = makeInstrumentWorld();
    const contract = optionContract(world, { type: 'call' });
    const quote = world.broker.getOptionQuote(contract.symbol);
    const order = {
      symbol: contract.symbol,
      assetClass: 'us_option',
      side: 'sell',
      qty: 1,
      priceUsd: quote.bid,
      notionalUsd: round2(quote.bid * 100),
      structure: 'covered_call',
      option: {
        underlying: world.symbol,
        expiration: contract.expiration,
        type: 'call',
        strikeUsd: contract.strikeUsd,
        multiplier: 100,
        dte: contract.dte,
      },
    };
    const naked = instrumentBrakeCheck(world, (input) => {
      input.quote = null;
      input.order = order;
    });
    assert.equal(naked.decision, 'DENY');
    assert.equal(naked.code, 'OPTION_FORBIDDEN');
    assert.equal(naked.brakeId, 'D16');
    assert.match(naked.reason, /covered call requires .*long shares|naked short options/i);

    const covered = instrumentBrakeCheck(world, (input) => {
      input.quote = null;
      input.order = order;
      input.positions = [{
        symbol: world.symbol,
        qty: 100,
        qtySigned: 100,
        assetClass: 'us_equity',
        marketValueUsd: round2(100 * world.quote.last),
        avgPriceUsd: world.quote.last,
      }];
    });
    assert.equal(covered.decision, 'ALLOW', JSON.stringify(covered));
    assert.equal(covered.structure, 'covered_call');

    // executor: acquire 100 shares, then sell one covered call against them
    brokerFill(world, { side: 'buy', qty: 100 });
    const shares = world.ledger.book(world.id).positions[world.symbol];
    assert.equal(shares.qtySigned, 100);
    const cashBefore = world.ledger.snapshot(world.id).cashUsd;
    const run = await runInstrumentExecutor(world, { policy: instrumentPolicy(world, 'covered_call') });
    assert.deepEqual(run.denied, [], 'a covered call with 100 shares must pass D1-D18');
    assert.equal(run.orders.length, 1);
    const callOrder = run.orders[0];
    assert.equal(callOrder.assetClass, 'us_option');
    assert.equal(callOrder.side, 'sell');
    assert.match(String(callOrder.symbol), /^[A-Z]{1,6}\d{6}[CP]\d{8}$/);
    assert.equal(callOrder.filledQty, 1);
    const premium = round2(callOrder.filledQty * callOrder.avgFillPriceUsd * 100);
    const callPosition = world.ledger.snapshot(world.id).positionsList.find((position) => position.symbol === callOrder.symbol);
    assert.ok(callPosition, 'the short call leg is booked');
    assert.ok(callPosition.qtySigned < 0);
    assert.equal(callPosition.assetClass, 'us_option');
    assert.equal(round2(world.ledger.snapshot(world.id).cashUsd), round2(cashBefore + premium));
    assert.equal(world.ledger.snapshot(world.id).positionsList.length, 2, '100 shares + short call');

    // buy-to-close a covered call is risk-reducing and must be allowed by D16/D18
    const closeAllowed = instrumentBrakeCheck(world, (input) => {
      input.quote = null;
      input.order = {
        symbol: callOrder.symbol,
        assetClass: 'us_option',
        side: 'buy',
        qty: 1,
        priceUsd: quote.ask,
        notionalUsd: round2(quote.ask * 100),
        positionIntent: 'buy_to_close',
        structure: 'covered_call',
        option: {
          underlying: world.symbol,
          expiration: contract.expiration,
          type: 'call',
          strikeUsd: contract.strikeUsd,
          multiplier: 100,
          dte: contract.dte,
        },
      };
      input.positions = world.ledger.snapshot(world.id).positionsList;
    });
    assert.equal(closeAllowed.decision, 'ALLOW', JSON.stringify(closeAllowed));
  });

  it('D15-D18 in real integration context: naked shorts/options, non-shortable assets, mixed-expiry spreads, DTE and margin', () => {
    const world = makeInstrumentWorld();
    const spot = world.quote.last;

    // --- D15 short sale -----------------------------------------------------
    const shortOrder = (mutate = () => {}) => (input) => {
      input.order = {
        symbol: world.symbol,
        side: 'sell',
        qty: 3,
        priceUsd: spot,
        notionalUsd: round2(3 * spot),
        asset: { shortable: true, marginable: true, tradable: true },
      };
      mutate(input);
    };
    assert.equal(instrumentBrakeCheck(world, shortOrder()).decision, 'ALLOW');
    const notShortable = instrumentBrakeCheck(world, shortOrder((input) => {
      input.order.asset = { shortable: false, marginable: true };
    }));
    assert.equal(notShortable.code, 'SHORT_FORBIDDEN');
    assert.equal(notShortable.brakeId, 'D15');
    assert.equal(instrumentBrakeCheck(world, shortOrder((input) => {
      input.order.qty = 1.5;
      input.order.notionalUsd = round2(1.5 * spot);
    })).code, 'SHORT_FORBIDDEN', 'fractional shorts are rejected');
    assert.equal(instrumentBrakeCheck(world, shortOrder((input) => {
      input.order.qty = 100;
      input.order.notionalUsd = round2(100 * spot);
    })).code, 'SHORT_FORBIDDEN', 'short notional must respect the mandate cap');

    // --- D16 options: naked sold options are never legal ---------------------
    const chain = world.broker.getOptionChain({ underlying: world.symbol, type: 'call', limit: 250 });
    const inWindow = chain.filter((contract) => contract.dte >= world.config.instruments.minDTE && contract.dte <= world.config.instruments.maxDTE);
    assert.ok(inWindow.length >= 4);
    const expiry = inWindow[0].expiration;
    const sameExpiry = inWindow.filter((contract) => contract.expiration === expiry).sort((a, b) => a.strikeUsd - b.strikeUsd);
    assert.ok(sameExpiry.length >= 3);
    const lower = sameExpiry[Math.floor(sameExpiry.length / 2) - 1] ?? sameExpiry[0];
    const upper = sameExpiry[Math.floor(sameExpiry.length / 2)] ?? sameExpiry[sameExpiry.length - 1];
    assert.notEqual(lower.symbol, upper.symbol);
    const lowerQuote = world.broker.getOptionQuote(lower.symbol);
    const upperQuote = world.broker.getOptionQuote(upper.symbol);
    const optionOrder = (contract, quote, { side = 'buy', structure = 'long_call', intent = 'buy_to_open' } = {}) => (input) => {
      input.quote = null;
      input.order = {
        symbol: contract.symbol,
        assetClass: 'us_option',
        side,
        qty: 1,
        priceUsd: side === 'buy' ? quote.ask : quote.bid,
        notionalUsd: round2((side === 'buy' ? quote.ask : quote.bid) * 100),
        positionIntent: intent,
        structure,
        option: {
          underlying: world.symbol,
          expiration: contract.expiration,
          type: contract.type,
          strikeUsd: contract.strikeUsd,
          multiplier: 100,
          dte: contract.dte,
        },
      };
    };
    const nakedCall = instrumentBrakeCheck(world, optionOrder(lower, lowerQuote, { side: 'sell', structure: 'covered_call', intent: 'sell_to_open' }));
    assert.equal(nakedCall.code, 'OPTION_FORBIDDEN');
    assert.equal(nakedCall.brakeId, 'D16');
    assert.match(nakedCall.reason, /covered call requires .*long shares|naked short options/i);
    const longCall = instrumentBrakeCheck(world, optionOrder(lower, lowerQuote));
    assert.equal(longCall.decision, 'ALLOW', JSON.stringify(longCall));
    assert.equal(longCall.structure, 'long_call');

    // mixed-expiry vertical is not defined risk
    const otherExpiry = inWindow.find((contract) => contract.expiration !== expiry);
    assert.ok(otherExpiry, 'need a second expiry for the mixed-expiry check');
    const mixed = instrumentBrakeCheck(world, (input) => {
      input.quote = null;
      input.order = {
        symbol: world.symbol,
        side: 'buy',
        qty: 1,
        priceUsd: 0.2,
        notionalUsd: 20,
        structure: 'bull_call_spread',
        legs: [
          { symbol: lower.symbol, side: 'buy', ratioQty: 1 },
          { symbol: otherExpiry.symbol, side: 'sell', ratioQty: 1 },
        ],
      };
    });
    assert.equal(mixed.code, 'OPTION_FORBIDDEN');
    assert.match(mixed.reason, /same expiration/i);

    // a genuinely defined-risk debit vertical ALLOWs and reports a defined max loss
    const netDebit = round2(lowerQuote.ask - upperQuote.bid);
    assert.ok(netDebit > 0, `defined-risk debit spread must net a debit (premium inversion regression): ${netDebit}`);
    const spread = instrumentBrakeCheck(world, (input) => {
      input.quote = null;
      input.order = {
        symbol: world.symbol,
        side: 'buy',
        qty: 1,
        priceUsd: netDebit,
        notionalUsd: round2(netDebit * 100),
        structure: 'bull_call_spread',
        legs: [
          { symbol: lower.symbol, side: 'buy', ratioQty: 1, priceUsd: lowerQuote.ask },
          { symbol: upper.symbol, side: 'sell', ratioQty: 1, priceUsd: upperQuote.bid },
        ],
      };
    });
    assert.equal(spread.decision, 'ALLOW', JSON.stringify(spread));
    assert.equal(spread.maxLossUsd, round2(Math.abs(lower.strikeUsd - upper.strikeUsd) * 100));
    assert.equal(spread.spreadBps !== null, true);

    // --- D18 expiry guard: opening at 1 DTE denied; sell-to-close allowed ----
    const expiringSymbol = testOcc(world.symbol, lower.strikeUsd, 'call', 1);
    const expiringQuote = world.broker.getOptionQuote(expiringSymbol);
    assert.ok(expiringQuote && expiringQuote.dte <= 1);
    const expiringOrder = (input) => {
      input.quote = null;
      input.order = {
        symbol: expiringSymbol,
        assetClass: 'us_option',
        side: 'buy',
        qty: 1,
        priceUsd: expiringQuote.ask,
        notionalUsd: round2(expiringQuote.ask * 100),
        structure: 'long_call',
        option: {
          underlying: world.symbol,
          expiration: new Date(T0 + 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
          type: 'call',
          strikeUsd: lower.strikeUsd,
          multiplier: 100,
          dte: 1,
        },
      };
    };
    const tooSoon = instrumentBrakeCheck(world, expiringOrder);
    assert.equal(tooSoon.code, 'EXPIRY_GUARD');
    assert.equal(tooSoon.brakeId, 'D18');
    const closeSoon = instrumentBrakeCheck(world, (input) => {
      expiringOrder(input);
      input.order.side = 'sell';
      input.order.priceUsd = expiringQuote.bid;
      input.order.notionalUsd = round2(expiringQuote.bid * 100);
      input.order.positionIntent = 'sell_to_close';
      input.order.option.dte = 0;
      input.positions = [{
        symbol: expiringSymbol,
        qty: 1,
        qtySigned: 1,
        assetClass: 'us_option',
        avgPriceUsd: expiringQuote.ask,
        marketValueUsd: round2(expiringQuote.ask * 100),
        option: { underlying: world.symbol, expiration: input.order.option.expiration, type: 'call', strikeUsd: lower.strikeUsd, multiplier: 100 },
      }];
    });
    assert.equal(closeSoon.decision, 'ALLOW', 'sell-to-close is always permitted by D18');

    // --- D17 margin: over the cap denied, within the cap allowed -------------
    const marginOrder = (marginRequiredUsd) => (input) => {
      input.order = { symbol: world.symbol, side: 'buy', qty: 1, priceUsd: spot, notionalUsd: round2(spot) };
      input.order.marginRequiredUsd = marginRequiredUsd;
    };
    const overMargin = instrumentBrakeCheck(world, marginOrder(6000));
    assert.equal(overMargin.code, 'MARGIN_LIMIT');
    assert.equal(overMargin.brakeId, 'D17');
    const underMargin = instrumentBrakeCheck(world, marginOrder(1000));
    assert.equal(underMargin.decision, 'ALLOW', JSON.stringify(underMargin));
  });

  it('all four defined-risk verticals open and close through the executor as one mleg order each', async () => {
    const cases = [
      ['bull_call_spread', 1],
      ['put_credit_spread', 1],
      ['bear_put_spread', -1],
      ['call_credit_spread', -1],
    ];
    for (const [structure, direction] of cases) {
      const world = makeInstrumentWorld();
      const open = await runInstrumentExecutor(world, { policy: instrumentPolicy(world, structure), direction });
      assert.deepEqual(open.denied, [], `${structure} must pass D1-D18`);
      assert.equal(open.orders.length, 1, `${structure} opens exactly one mleg order`);
      const order = open.orders[0];
      assert.equal(order.orderClass, 'mleg', `${structure} is submitted as one multi-leg order`);
      assert.equal(order.legs.length, 2, `${structure} has two legs`);
      assert.ok(order.groupId, `${structure} legs share a group id`);
      assert.ok(open.actions.some((action) => action.type === 'entry' && action.structure === structure));

      const positions = world.ledger.snapshot(world.id).positionsList;
      assert.equal(positions.length, 2, `${structure}: both legs are booked`);
      assert.equal(positions.every((position) => position.assetClass === 'us_option'), true);
      assert.equal(positions.every((position) => position.groupId === order.groupId), true);
      assert.equal(positions[0].structure, structure);
      assert.equal(positions.some((position) => position.qtySigned > 0), true);
      assert.equal(positions.some((position) => position.qtySigned < 0), true);
      assert.equal(positions[0].option.expiration, positions[1].option.expiration);
      assert.notEqual(positions[0].option.strikeUsd, positions[1].option.strikeUsd);
      const widthUsd = round2(Math.abs(positions[0].option.strikeUsd - positions[1].option.strikeUsd) * 100 * Math.abs(positions[0].qtySigned));
      assert.ok(widthUsd > 0, 'the vertical has a defined width (max loss)');

      const groups = world.ledger.snapshot(world.id).groups;
      assert.equal(groups.length, 1);
      assert.equal(groups[0].structure, structure);
      assert.equal(groups[0].legs.length, 2);
      assert.equal(groups[0].openContracts, 2 * Math.abs(positions[0].qtySigned));

      const cashAfterOpen = world.ledger.snapshot(world.id).cashUsd;
      const cost = positions.reduce((sum, position) => sum + position.qtySigned * position.avgPriceUsd * 100, 0);
      assert.equal(round2(cashAfterOpen), round2(world.endowmentUsd - cost), `${structure}: premium cash flow is exactly the leg notional`);

      const close = await runInstrumentExecutor(world, {
        policy: { stance: 'trade', atMs: world.clock.now(), exitPressure: 'exit' },
        direction,
      });
      assert.deepEqual(close.denied, [], `${structure} closes through the wall`);
      assert.equal(close.orders.length, 1, `${structure} closes with one mleg order`);
      assert.equal(close.orders[0].orderClass, 'mleg');
      assert.equal(close.orders[0].legs.length, 2);
      assert.deepEqual(world.ledger.snapshot(world.id).positionsList, []);
      const closedGroups = world.ledger.snapshot(world.id).groups;
      assert.equal(closedGroups[0].openContracts, 0);
      const cashAfterClose = world.ledger.snapshot(world.id).cashUsd;
      const realized = world.ledger.snapshot(world.id).realizedPlUsd;
      assert.equal(realized, round2(cashAfterClose - world.endowmentUsd));
      assert.ok(realized < 0 && realized > -200, `${structure}: closing crosses the bid/ask, realized ${realized}`);
      assert.equal(world.ledger.equity(world.id, {}).equityUsd, cashAfterClose);
      assert.equal(world.broker.getPositions().length, 0, `${structure}: no broker position may remain`);
    }
  });

  it('margin: negative cash is allowed within the cap and denied beyond it, without creating money on denial', () => {
    const world = makeInstrumentWorld({ overrides: { instruments: { allowMargin: true, maxMarginPctEquity: 0.5 } } });
    const price = world.quote.last;
    const qty = Math.floor(((world.endowmentUsd + 2000) / price) * 100) / 100;
    const first = world.ledger.applyFill(world.id, { symbol: world.symbol, side: 'buy', qty, priceUsd: price, at: world.clock.now() });
    assert.ok(first.cashUsd < 0, 'a margin order may make virtual cash negative');
    assert.ok(first.marginDebtUsd <= round2(0.5 * world.endowmentUsd) + 1, 'debt stays inside maxMarginPctEquity');
    const marked = world.ledger.equity(world.id, { [world.symbol]: price });
    assert.equal(marked.equityUsd, round2(first.cashUsd + marked.positionsValueUsd));
    assert.ok(Math.abs(marked.equityUsd - world.endowmentUsd) <= 0.05, 'margin does not change equity at the fill price');
    assert.equal(marked.marginDebtUsd, round2(-first.cashUsd));

    const before = {
      cashUsd: world.ledger.get(world.id).cashUsd,
      qty: world.ledger.book(world.id).positions[world.symbol].qtySigned,
    };
    assert.throws(
      () => world.ledger.applyFill(world.id, { symbol: world.symbol, side: 'buy', qty: 60, priceUsd: price, at: world.clock.now() }),
      (error) => error.code === 'MARGIN_LIMIT',
      'debt beyond the margin cap must be refused',
    );
    assert.equal(world.ledger.get(world.id).cashUsd, before.cashUsd, 'a refused margin fill must not move cash');
    assert.equal(world.ledger.book(world.id).positions[world.symbol].qtySigned, before.qty, 'a refused margin fill must not move the position');

    const noMargin = makeInstrumentWorld({ overrides: { instruments: { allowMargin: false } } });
    assert.throws(
      () => noMargin.ledger.applyFill(noMargin.id, {
        symbol: noMargin.symbol,
        side: 'buy',
        qty: Math.ceil((noMargin.endowmentUsd / noMargin.quote.last) * 2),
        priceUsd: noMargin.quote.last,
        at: T0,
      }),
      (error) => error.code === 'MARGIN_LIMIT' && /no margin permission/i.test(error.message),
      'without margin permission any borrowing is refused',
    );
  });

  it('DTE guard: no opening below minDTE; a held option auto-closes at <= autoCloseDTE through the executor', async () => {
    const world = makeInstrumentWorld();
    const spot = world.quote.last;
    const expirationTomorrow = new Date(T0 + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const strikeUsd = Math.round(spot);
    const symbol = testOcc(world.symbol, strikeUsd, 'call', 1);
    const quote = world.broker.getOptionQuote(symbol);
    assert.ok(quote && quote.dte <= world.config.instruments.autoCloseDTE);
    const openDenied = instrumentBrakeCheck(world, (input) => {
      input.quote = null;
      input.order = {
        symbol,
        assetClass: 'us_option',
        side: 'buy',
        qty: 1,
        priceUsd: quote.ask,
        notionalUsd: round2(quote.ask * 100),
        structure: 'long_call',
        option: { underlying: world.symbol, expiration: expirationTomorrow, type: 'call', strikeUsd, multiplier: 100, dte: 1 },
      };
    });
    assert.equal(openDenied.code, 'EXPIRY_GUARD');
    assert.equal(openDenied.brakeId, 'D18');

    const buyOrder = brokerFill(world, {
      side: 'buy',
      symbol,
      assetClass: 'us_option',
      qty: 1,
      option: { underlying: world.symbol, expiration: expirationTomorrow, type: 'call', strikeUsd, multiplier: 100 },
    });
    assert.equal(world.ledger.snapshot(world.id).positionsList[0].dte, 1);
    const close = await runInstrumentExecutor(world, {});
    assert.deepEqual(close.denied, []);
    assert.equal(close.orders.length, 1);
    assert.equal(close.orders[0].symbol, symbol);
    assert.equal(close.orders[0].side, 'sell');
    assert.ok(close.actions.some((action) => action.type === 'exit' && action.reason === 'dte_auto_close'));
    assert.deepEqual(world.ledger.snapshot(world.id).positionsList, []);
    assert.equal(
      world.ledger.snapshot(world.id).realizedPlUsd,
      round2((close.orders[0].avgFillPriceUsd - buyOrder.avgFillPriceUsd) * 100),
    );
    assert.equal(
      round2(world.ledger.snapshot(world.id).cashUsd),
      round2(world.endowmentUsd + world.ledger.snapshot(world.id).realizedPlUsd),
    );
  });

  it('an option position does not corrupt the Treasurer: marks, equity and reconciliation stay coherent (D-V3-2 regression)', async () => {
    const world = makeInstrumentWorld();
    const open = await runInstrumentExecutor(world, { policy: instrumentPolicy(world, 'long_call'), direction: 1 });
    assert.equal(open.orders.length, 1);
    const position = world.ledger.snapshot(world.id).positionsList[0];
    assert.equal(position.assetClass, 'us_option');
    const treasurer = createTreasurer({
      broker: world.broker,
      ledger: world.ledger,
      registry: world.registry,
      journal: createJournal({ paths: world.paths, config: world.config }),
      config: world.config,
      paths: world.paths,
      clock: world.clock,
    });
    const tick = await treasurer.tick({ prices: { [world.symbol]: world.quote.last } });
    assert.equal(tick.halted, false, `holding an option must not halt the treasury: ${JSON.stringify(tick.haltReasons)}`);
    assert.deepEqual(tick.haltReasons, []);
    assert.equal(tick.reconciliation.ok, true, JSON.stringify(tick.reconciliation));
    assert.ok(Math.abs(tick.reconciliation.deltaUsd) <= 1, `reconciliation delta ${tick.reconciliation.deltaUsd}`);
    const view = tick.agentViews.find((entry) => entry.agentId === world.id);
    assert.ok(view);
    const brokerPosition = world.broker.getPositions().find((entry) => entry.symbol === position.symbol);
    const brokerMark = Math.abs(brokerPosition.marketValueUsd) / (Math.abs(brokerPosition.qtySigned) * 100);
    const expectedEquity = round2(view.cashUsd + position.qtySigned * brokerMark * 100);
    assert.ok(Math.abs(view.equityUsd - expectedEquity) <= 0.05, `equity ${view.equityUsd} vs marked ${expectedEquity}`);
    assert.ok(view.positionsValueUsd < 1000, 'option marks are premium x 100 x contracts, not 100x inflated');
    assert.ok(view.equityUsd > 4000 && view.equityUsd < 6000, `equity ${view.equityUsd} must stay near the endowment`);
    assert.equal(round2(view.cashUsd + view.positionsValueUsd), view.equityUsd);
    assert.ok(view.runwayHours > 0, 'runway is still computed after an option fill');
  });
});

// ---------------------------------------------------------------------------
// v3.0 death liquidation, orchestrator status, paper default/gating, kill switch
// ---------------------------------------------------------------------------

describe('v3.0 multi-instrument: death liquidation, status surface, paper default and gating', () => {
  it('multi-instrument death: the Reaper closes short stock, long option and both spread legs, then writes the obituary', async () => {
    const world = makeInstrumentWorld();
    const spot = world.quote.last;
    // short stock
    brokerFill(world, { side: 'sell', qty: 5 });
    // long call on one contract; a separate bull-call spread on two other contracts
    const chain = world.broker.getOptionChain({ underlying: world.symbol, type: 'call', limit: 250 });
    const expiry = chain.filter(
      (contract) => contract.dte >= world.config.instruments.minDTE && contract.dte <= world.config.instruments.maxDTE,
    )[0].expiration;
    const sameExpiry = chain.filter((contract) => contract.expiration === expiry).sort((a, b) => a.strikeUsd - b.strikeUsd);
    assert.ok(sameExpiry.length >= 3);
    const bySymbol = new Map(sameExpiry.map((contract) => [contract.symbol, contract]));
    const longCallContract = sameExpiry[0];
    const lower = sameExpiry[1];
    const upper = sameExpiry[2];
    brokerFill(world, {
      side: 'buy',
      symbol: longCallContract.symbol,
      assetClass: 'us_option',
      qty: 1,
      option: optionMeta(world, longCallContract),
    });
    const lowerQuote = world.broker.getOptionQuote(lower.symbol);
    const upperQuote = world.broker.getOptionQuote(upper.symbol);
    const netDebit = round2(Math.max(0.01, lowerQuote.ask - upperQuote.bid));
    const mleg = world.broker.submitOrder({
      orderClass: 'mleg',
      type: 'limit',
      qty: 1,
      groupId: 'grp-death',
      structure: 'bull_call_spread',
      limitPrice: netDebit,
      legs: [
        { symbol: lower.symbol, side: 'buy', ratioQty: 1, positionIntent: 'buy_to_open' },
        { symbol: upper.symbol, side: 'sell', ratioQty: 1, positionIntent: 'sell_to_open' },
      ],
    });
    for (const leg of mleg.legs) {
      const contract = bySymbol.get(leg.symbol);
      assert.ok(contract, `spread leg ${leg.symbol} must be from the chain`);
      world.ledger.applyFill(world.id, {
        symbol: leg.symbol,
        assetClass: 'us_option',
        side: leg.side,
        qty: leg.qty,
        priceUsd: leg.avgFillPriceUsd,
        multiplier: 100,
        option: optionMeta(world, contract, { groupId: 'grp-death', structure: 'bull_call_spread' }),
        groupId: 'grp-death',
        structure: 'bull_call_spread',
        at: world.clock.now(),
        orderId: mleg.id,
      });
    }
    const positionsBefore = Object.keys(world.ledger.book(world.id).positions).sort();
    assert.equal(positionsBefore.length, 4, 'short stock + long call + two spread legs');
    const creditSpread = world.ledger.snapshot(world.id).groups.find((group) => group.groupId === 'grp-death');
    assert.equal(creditSpread.legs.length, 2);

    // Under-fund the agent: charging all cash leaves only the (small/negative) position marks,
    // which is below the drawdown/death floor — so the Reaper must execute the death.
    const cash = world.ledger.get(world.id).cashUsd;
    assert.ok(cash > 0);
    world.ledger.charge(world.id, cash, { category: 'inference', role: 'executor', at: world.clock.now() });
    const equityAtDeath = world.ledger.equity(world.id, { [world.symbol]: spot });
    const floorUsd = Math.max(world.config.deathFloorUsd, world.config.deathFloorPct * world.endowmentUsd);
    const drawdownUsd = world.endowmentUsd * (1 - world.config.maxDrawdownPct);
    assert.ok(equityAtDeath.equityUsd <= drawdownUsd + 0.01, `equity ${equityAtDeath.equityUsd} must be below the drawdown floor`);
    assert.ok(equityAtDeath.equityUsd <= floorUsd + 1000, 'equity must be in lethal territory');
    world.registry.save();
    world.ledger.save();
    const journal = createJournal({ paths: world.paths, config: world.config });
    const reaper = createReaper({
      broker: world.broker,
      registry: world.registry,
      ledger: world.ledger,
      journal,
      config: world.config,
      paths: world.paths,
      clock: world.clock,
    });
    const sweep = await reaper.sweep({ prices: { [world.symbol]: spot } });
    assert.deepEqual(sweep.errors ?? [], [], JSON.stringify(sweep.errors));
    assert.equal(sweep.killed.length, 1);
    const killed = sweep.killed[0];
    assert.equal(killed.agentId, world.id);
    assert.ok(DEATH_CAUSES.includes(killed.cause));
    assert.ok(['insufficient_funds', 'drawdown_limit'].includes(killed.cause));
    const closedSymbols = killed.liquidated.map((entry) => entry.symbol).sort();
    assert.deepEqual(closedSymbols, positionsBefore, 'every position (short, long call, both spread legs) must be closed');
    assert.equal(killed.liquidated.every((entry) => entry.status === 'filled'), true, JSON.stringify(killed.liquidated));
    const stockClose = killed.liquidated.find((entry) => entry.symbol === world.symbol);
    assert.equal(stockClose.side, 'buy', 'a short is bought back');
    assert.equal(stockClose.assetClass, 'us_equity');
    for (const entry of killed.liquidated.filter((row) => row.assetClass === 'us_option')) {
      assert.match(entry.symbol, /^[A-Z]{1,6}\d{6}[CP]\d{8}$/);
      assert.ok(['sell_to_close', 'buy_to_close'].includes(entry.positionIntent));
    }
    assert.equal(world.broker.getPositions().length, 0, 'the broker account must be flat after liquidation');
    assert.deepEqual(world.ledger.book(world.id).positions, {});
    assert.equal(world.ledger.get(world.id).cashUsd, 0, 'residual cash/debt is settled');
    assert.equal(world.registry.get(world.id).status, 'dead');
    assert.equal(journal.count(), 1);
    const obituary = journal.list()[0];
    assert.equal(validateObituary(obituary), obituary);
    assert.equal(obituary.cause, killed.cause);
    assert.equal(obituary.agentId, world.id);
    assert.ok(obituary.tradesCount >= 4, 'the multi-instrument trade history is in the obituary');
    assert.equal(obituary.finalEquityUsd, killed.finalEquityUsd);

    const second = await reaper.sweep({ prices: { [world.symbol]: spot } });
    assert.equal(second.killed.length, 0);
    assert.equal(journal.count(), 1, 'a second sweep must not duplicate the obituary');
    assert.ok(second.skipped.some((entry) => entry.agentId === world.id && entry.reason === 'already_dead'));
  });

  it('orchestrator status exposes engine.instruments, per-agent permissions/playbook and signed/option positions', async () => {
    const env = makeEnv({
      mode: 'paper',
      population: { initial: 1, cap: 2 },
      instruments: { maxOptionPremiumPctEquity: 0.5, maxOptionPremiumUsd: 2500 },
    });
    const clock = makeClock(T0);
    const broker = createSimBroker(env.config, { seed: 7, accountEquityUsd: 100000, clock });
    const automaton = await createAutomaton({ config: env.config, paths: env.paths, broker, clock });
    await automaton.init();
    const internals = automaton._internals;
    const agent = internals.registry.alive()[0];
    const symbol = agent.genome.symbol;
    const quote = broker.getLatestQuote(symbol);
    // signed stock position: short 2 shares (paper mode: the engine never executes death itself)
    const short = broker.submitOrder({ symbol, side: 'sell', qty: 2, type: 'market' });
    internals.ledger.applyFill(agent.id, {
      symbol, side: 'sell', qty: 2, priceUsd: short.avgFillPriceUsd, at: clock.now(), orderId: short.id,
    });
    // long option position
    const chain = broker
      .getOptionChain({ underlying: symbol, type: 'call', limit: 250 })
      .filter((contract) => contract.dte >= env.config.instruments.minDTE && contract.dte <= env.config.instruments.maxDTE);
    assert.ok(chain.length > 0);
    const contract = chain[Math.floor(chain.length / 2)];
    const optionQuote = broker.getOptionQuote(contract.symbol);
    const optionBuy = broker.submitOrder({
      symbol: contract.symbol, assetClass: 'us_option', side: 'buy', qty: 1, type: 'limit',
      limitPrice: optionQuote.ask, positionIntent: 'buy_to_open',
    });
    internals.ledger.applyFill(agent.id, {
      symbol: contract.symbol, assetClass: 'us_option', side: 'buy', qty: 1,
      priceUsd: optionBuy.avgFillPriceUsd, multiplier: 100,
      option: { underlying: symbol, expiration: contract.expiration, type: 'call', strikeUsd: contract.strikeUsd, multiplier: 100 },
      at: clock.now(), orderId: optionBuy.id,
    });
    // drain cash so the agent is condemned (paper mode: no in-process death execution),
    // which freezes the positions for the status snapshot without the executor touching them
    const cash = internals.ledger.get(agent.id).cashUsd;
    if (cash > 0) internals.ledger.charge(agent.id, cash, { category: 'inference', role: 'executor', at: clock.now() });
    internals.ledger.save();
    clock.advance(CYCLE_MS);
    const trace = await automaton.tick();
    assert.equal(trace.halted, false, JSON.stringify(trace.haltReasons));
    assert.equal(trace.deaths.length, 1, 'the drained agent must be condemned by a death verdict');
    const status = await automaton.status();

    assert.equal(status.mode, 'paper');
    assert.ok(status.engine.instruments, 'status.engine.instruments must exist');
    assert.equal(status.engine.instruments.enabled, true);
    assert.equal(status.engine.instruments.caps.minDTE, env.config.instruments.minDTE);
    assert.equal(status.engine.instruments.caps.maxDTE, env.config.instruments.maxDTE);
    assert.ok(status.engine.instruments.caps.maxContracts >= 1);
    assert.ok(status.engine.instruments.allowedStructures.includes('long_call'));
    assert.ok(status.engine.instruments.allowedStructures.includes('bull_call_spread'));
    assert.equal(Object.keys(status.engine.instruments.playbooks).length >= 4, true);
    assert.equal(status.engine.instruments.account.shortingEnabled, true);
    assert.equal(status.engine.instruments.account.optionsTradingLevel, 3);

    const row = status.agents.find((entry) => entry.id === agent.id);
    assert.ok(row);
    assert.equal(row.instrumentPermissions.enabled, true);
    assert.equal(row.instrumentPermissions.longOptions, true);
    assert.equal(row.instrumentPermissions.shortStock, true);
    assert.equal(row.instrumentPermissions.spreads, true);
    assert.ok(row.playbook && typeof row.playbook.family === 'string');
    assert.ok(Array.isArray(row.playbook.structures) && row.playbook.structures.includes('long_call'));
    const stockRow = row.positions.find((position) => position.symbol === symbol);
    assert.ok(stockRow, JSON.stringify(row.positions));
    assert.equal(stockRow.assetClass, 'us_equity');
    assert.equal(stockRow.side, 'SHORT');
    assert.equal(stockRow.qtySigned, -2);
    const optionRow = row.positions.find((position) => position.symbol === contract.symbol);
    assert.ok(optionRow, JSON.stringify(row.positions));
    assert.equal(optionRow.assetClass, 'us_option');
    assert.equal(optionRow.side, 'CALL');
    assert.equal(optionRow.multiplier, 100);
    assert.equal(optionRow.qtySigned, 1);
    assert.ok(optionRow.option.strikeUsd > 0);
    assert.ok(optionRow.option.expiration);
    assert.equal(status.population.condemned >= 1, true);
  });

  it('paper is the default and instruments never bypass the paper/live gates', () => {
    const defaults = defaultConfig();
    assert.equal(defaults.mode, 'paper');
    assert.equal(defaults.allowLive, false);
    assert.equal(defaults.instruments.enabled, true);
    assert.equal(defaults.instruments.allowNakedShortOptions, false);
    const permissions = resolveInstrumentPermissions(defaults);
    assert.equal(permissions.shortStock, true);
    assert.equal(permissions.longOptions, true);
    assert.equal(permissions.coveredCalls, true);
    assert.equal(permissions.spreads, true);
    assert.equal(permissions.margin, true);

    // instruments.enabled=false is the documented fallback to long-stock-only (v2)
    const disabled = makeInstrumentWorld({ overrides: { instruments: { enabled: false } } });
    const stockBuy = instrumentBrakeCheck(disabled, (input) => {
      input.order = { symbol: disabled.symbol, side: 'buy', qty: 1, priceUsd: disabled.quote.ask, notionalUsd: round2(disabled.quote.ask) };
    });
    assert.equal(stockBuy.decision, 'ALLOW');
    const stockShort = instrumentBrakeCheck(disabled, (input) => {
      input.order = {
        symbol: disabled.symbol, side: 'sell', qty: 2, priceUsd: disabled.quote.last,
        notionalUsd: round2(2 * disabled.quote.last), asset: { shortable: true, marginable: true },
      };
    });
    assert.equal(stockShort.code, 'SHORT_FORBIDDEN');
    const disabledOption = optionContract(disabled);
    const disabledQuote = disabled.broker.getOptionQuote(disabledOption.symbol);
    const optionBuy = instrumentBrakeCheck(disabled, (input) => {
      input.quote = null;
      input.order = {
        symbol: disabledOption.symbol, assetClass: 'us_option', side: 'buy', qty: 1,
        priceUsd: disabledQuote.ask, notionalUsd: round2(disabledQuote.ask * 100), structure: 'long_call',
        option: {
          underlying: disabled.symbol, expiration: disabledOption.expiration, type: 'call',
          strikeUsd: disabledOption.strikeUsd, multiplier: 100, dte: disabledOption.dte,
        },
      };
    });
    assert.equal(optionBuy.code, 'OPTION_FORBIDDEN');

    // a paper-configured wall refuses an order that claims live mode (D8, before D15/D16)
    const paper = makeInstrumentWorld();
    const liveClaim = instrumentBrakeCheck(paper, (input) => {
      input.mode = 'live';
      input.order = {
        symbol: paper.symbol, side: 'sell', qty: 2, priceUsd: paper.quote.last,
        notionalUsd: round2(2 * paper.quote.last), asset: { shortable: true, marginable: true },
      };
    });
    assert.equal(liveClaim.code, 'MODE_FORBIDDEN');
    assert.equal(liveClaim.brakeId, 'D8');

    // a live-configured wall without LIVE_ARMED refuses v3 instruments with LIVE_NOT_ARMED
    const liveEnv = makeEnv({ mode: 'live', allowLive: true, instruments: { enabled: true, allowShort: true, allowOptions: true } });
    const liveClock = makeClock(T0);
    const liveBrakes = createBrakes({ config: liveEnv.config, paths: liveEnv.paths, clock: liveClock });
    assert.equal(liveBrakes.isLiveArmed(), false);
    const liveMandate = {
      agentId: 'atm-live',
      issuedAt: liveClock.iso(),
      expiresAt: new Date(liveClock.now() + 10 * 60 * 1000).toISOString(),
      sizeBudgetUsd: 2500,
      maxOrderNotionalUsd: 2500,
      maxDailyOrdersRemaining: 6,
      allowedSymbols: [...liveEnv.config.symbols],
      allowExitOnly: false,
      instruments: deriveInstrumentPermissions(liveEnv.config, 5000),
    };
    const liveOrder = {
      mode: 'live',
      now: liveClock.now(),
      agentId: 'atm-live',
      dayStats: { dayKey: '2026-01-05', ordersCount: 0, startEquityUsd: 5000, pnlUsd: 0 },
      quote: { symbol: 'META', bid: 29, ask: 29.01 },
      order: {
        symbol: 'META', side: 'sell', qty: 2, priceUsd: 29, notionalUsd: 58,
        asset: { shortable: true, marginable: true },
      },
      equityUsd: 5000,
      positions: [],
      mandate: liveMandate,
      spec: { specId: 'spec-live', proofRef: 'https://data.alpaca.markets/x', proof: { observedAt: new Date(T0 - 60 * 60 * 1000).toISOString() } },
      accountEquityUsd: 100000,
      allocatedEquityUsd: 5000,
      marginDebtUsd: 0,
      buyingPowerUsd: 100000,
    };
    assert.equal(liveBrakes.checkOrder(liveOrder).code, 'LIVE_NOT_ARMED');
  });

  it('the kill switch blocks shorts, options and spreads too (v3 instruments are not privileged)', async () => {
    const world = makeInstrumentWorld();
    fs.mkdirSync(path.dirname(world.paths.killSwitch), { recursive: true });
    fs.writeFileSync(world.paths.killSwitch, JSON.stringify({ armedAt: new Date(T0).toISOString(), reason: 'verifier' }), 'utf8');
    const contract = optionContract(world);
    const quote = world.broker.getOptionQuote(contract.symbol);
    const shortDecision = instrumentBrakeCheck(world, (input) => {
      input.order = {
        symbol: world.symbol, side: 'sell', qty: 2, priceUsd: world.quote.last,
        notionalUsd: round2(2 * world.quote.last), asset: { shortable: true, marginable: true },
      };
    });
    assert.equal(shortDecision.code, 'KILL_SWITCH');
    assert.equal(shortDecision.brakeId, 'D11');
    const optionDecision = instrumentBrakeCheck(world, (input) => {
      input.quote = null;
      input.order = {
        symbol: contract.symbol, assetClass: 'us_option', side: 'buy', qty: 1,
        priceUsd: quote.ask, notionalUsd: round2(quote.ask * 100), structure: 'long_call',
        option: {
          underlying: world.symbol, expiration: contract.expiration, type: 'call',
          strikeUsd: contract.strikeUsd, multiplier: 100, dte: contract.dte,
        },
      };
    });
    assert.equal(optionDecision.code, 'KILL_SWITCH');
    const spreadDecision = instrumentBrakeCheck(world, (input) => {
      input.quote = null;
      input.order = {
        symbol: world.symbol, side: 'buy', qty: 1, priceUsd: 0.2, notionalUsd: 20,
        structure: 'bull_call_spread',
        legs: [
          { symbol: contract.symbol, side: 'buy', ratioQty: 1 },
          { symbol: testOcc(world.symbol, contract.strikeUsd + 1, 'call', 5), side: 'sell', ratioQty: 1 },
        ],
      };
    });
    assert.equal(spreadDecision.code, 'KILL_SWITCH');

    // a directly-called executor cannot open the short either
    const run = await runInstrumentExecutor(world, { policy: instrumentPolicy(world, 'short_stock'), direction: -1 });
    assert.equal(run.orders.length, 0);
    assert.equal(run.denied.length >= 1, true);
    assert.equal(run.denied.every((denial) => denial.code === 'KILL_SWITCH'), true, JSON.stringify(run.denied));
    assert.throws(() => world.brakes.assertKillSwitchClear(), (error) => error.code === 'KILL_SWITCH');

    fs.rmSync(world.paths.killSwitch, { force: true });
    assert.equal(world.brakes.assertKillSwitchClear(), undefined);
    const allowedAgain = instrumentBrakeCheck(world, (input) => {
      input.order = {
        symbol: world.symbol, side: 'sell', qty: 2, priceUsd: world.quote.last,
        notionalUsd: round2(2 * world.quote.last), asset: { shortable: true, marginable: true },
      };
    });
    assert.equal(allowedAgain.decision, 'ALLOW', JSON.stringify(allowedAgain));
  });
});

// ===========================================================================
// v3.2: multi-symbol portfolio bots and the 70/30 day/swing mix
// ===========================================================================

/** Config for the v3.2 population/migration tests (30 bots at $50 on a $100k sim account). */
function makeV32Env(overrides = {}) {
  return makeEnv({
    population: { initial: 30, cap: 60 },
    endowmentUsd: 50,
    deathFloorUsd: 1,
    deathFloorPct: 0,
    maxDrawdownPct: 0.9,
    risk: { maxDailyLossPct: 1 },
    replication: { childEndowmentUsd: 20, surplus7dUsd: 2, minRunwayHours: 24 },
    strategyMix: { dayPct: 0.7 },
    // Isolate the portfolio/mix mechanics from the v3 instrument-symbol migration.
    instruments: { enabled: false },
    ...overrides,
  });
}

function v32Boot(env, { seed = 7 } = {}) {
  const clock = makeClock(T0);
  const broker = createSimBroker(env.config, { seed, accountEquityUsd: 100000, clock });
  return { clock, broker };
}

/**
 * Seed a pre-v3.2 registry/ledger: 30 agents in a legacy 50/50 mix (15 swing, 15 day),
 * one primary symbol each, legacy single spec + specIds, no portfolio-v32 marker.
 */
async function seedLegacyPopulation(env, clock) {
  const registry = createRegistry({ paths: env.paths, config: env.config, clock });
  const ledger = createLedger({ paths: env.paths, config: env.config, clock });
  const agents = [];
  for (let index = 0; index < 30; index += 1) {
    const family = index < 8 ? 'momentum' : index < 15 ? 'meanrev' : index < 23 ? 'breakout' : 'gapfade';
    const id = `atm-legacy-${String(index).padStart(2, '0')}`;
    const symbol = env.config.symbols[index % env.config.symbols.length];
    const genome = {
      symbol,
      family,
      lookback: 60,
      entryZ: 1.2,
      exitZ: 0.3,
      stopPct: 0.02,
      targetPct: 0.04,
      maxHoldBars: 8,
      sizePct: 0.15,
      sessionFilter: 'any',
    };
    await registry.register({
      id,
      name: `Legacy ${index}`,
      generation: 0,
      bornAt: clock.iso(),
      status: 'alive',
      endowmentUsd: 50,
      genome,
      symbols: [symbol],
      specId: `spec-legacy-${index}`,
      specIds: { [symbol]: `spec-legacy-${index}` },
      mutation: null,
      tier: tierForFamily(family),
      notes: ['legacy'],
    });
    ledger.ensureAgent(id, { endowmentUsd: 50, at: clock.iso() });
    ledger.grant(id, 50, { reason: 'genesis', at: clock.iso() });
    agents.push({ id, family, symbol });
  }
  await registry.save();
  await ledger.save();
  return { registry, ledger, agents };
}

describe('v3.2 multi-symbol portfolio: 70/30 genesis, migration and basket inheritance', () => {
  it('fresh 70/30 genesis: 21 day / 9 swing, 4/3-symbol baskets, unique strategies, marker + status targets', async () => {
    const env = makeV32Env();
    const { clock, broker } = v32Boot(env);
    const automaton = await createAutomaton({ config: env.config, paths: env.paths, broker, clock });
    await automaton.init();
    const registry = automaton._internals.registry;
    const ledger = automaton._internals.ledger;
    const agents = registry.alive();

    assert.equal(agents.length, 30);
    const tiers = { day: 0, swing: 0 };
    const families = {};
    for (const agent of agents) {
      const tier = tierForFamily(agent.genome.family);
      tiers[tier] += 1;
      families[agent.genome.family] = (families[agent.genome.family] ?? 0) + 1;
      assert.equal(agent.tier, tier, `${agent.id}: tier must follow the strategy family`);
      assert.ok(Array.isArray(agent.symbols), `${agent.id}: registry must carry the basket`);
      assert.deepEqual(agent.genome.symbols, agent.symbols, `${agent.id}: genome basket and registry basket must agree`);
      assert.equal(agent.symbols[0], agent.genome.symbol, `${agent.id}: primary symbol is the first basket entry`);
      const expectedSize = tier === 'day'
        ? env.config.portfolio.basketSizeDay
        : env.config.portfolio.basketSizeSwing;
      assert.equal(agent.symbols.length, expectedSize, `${agent.id}: ${tier} basket size`);
      assert.equal(new Set(agent.symbols).size, agent.symbols.length, `${agent.id}: basket symbols must be unique`);
      for (const symbol of agent.symbols) {
        assert.ok(env.config.symbols.includes(symbol), `${agent.id}: ${symbol} must be in the configured universe`);
      }
      assert.equal(agent.specId, null, `${agent.id}: no spec should be assigned before a tick`);
      assert.deepEqual(agent.specIds, {});
      assert.equal(agent.endowmentUsd, 50);
      assert.equal(ledger.snapshot(agent.id).cashUsd, 50, `${agent.id}: genesis cash is granted`);
      assert.equal(ledger.equity(agent.id, {}).equityUsd, 50);
    }
    assert.deepEqual(tiers, { day: 21, swing: 9 }, '70% of 30 bots are day/short-term');
    assert.deepEqual(families, { momentum: 5, meanrev: 4, breakout: 11, gapfade: 10 });
    assert.equal(registry.cap, 60);
    // the genesis claim: every (primary symbol, family) strategy is unique for 30 bots on 14 symbols
    const pairs = new Set(agents.map((agent) => `${agent.genome.symbol}:${agent.genome.family}`));
    assert.equal(pairs.size, 30, 'every bot has a unique primary symbol+family strategy');

    const marker = JSON.parse(fs.readFileSync(path.join(env.paths.stateDir, 'portfolio-v32.json'), 'utf8'));
    assert.equal(marker.version, 1);
    assert.equal(marker.changed, 30);

    const status = await automaton.status();
    assert.equal(status.mode, 'sim');
    assert.deepEqual(status.engine.portfolio, { ...env.config.portfolio, strategyMix: { dayPct: 0.7 } });
    assert.deepEqual(status.strategyMix.target, { dayPct: 0.7, dayCount: 21, swingCount: 9 });
    assert.equal(status.strategyMix.day.count, 21);
    assert.equal(status.strategyMix.swing.count, 9);
    assert.equal(status.agents.length, 30);
    for (const row of status.agents) {
      assert.ok(Array.isArray(row.symbols) && row.symbols.length > 0);
      assert.ok(Array.isArray(row.specs));
      assert.equal(row.tier, tierForFamily(row.genome.family));
    }
  });

  it('genesis gives every bot its own basket combination (no duplicate 4/3-symbol baskets)', async () => {
    const env = makeV32Env();
    const { clock, broker } = v32Boot(env);
    const automaton = await createAutomaton({ config: env.config, paths: env.paths, broker, clock });
    await automaton.init();
    const baskets = automaton._internals.registry.alive().map((agent) => agent.symbols.join(','));
    assert.equal(new Set(baskets).size, baskets.length, `duplicate baskets: ${JSON.stringify(baskets)}`);
  });

  it('pre-v3.2 50/50 population migrates to 70/30 with baskets, preserving ids/ledgers and clearing specs (idempotent)', async () => {
    const env = makeV32Env();
    const { clock, broker } = v32Boot(env);
    const seeded = await seedLegacyPopulation(env, clock);
    const before = Object.fromEntries(
      seeded.registry.all().map((agent) => [agent.id, {
        endowmentUsd: agent.endowmentUsd,
        genomeSymbol: agent.genome.symbol,
        cashUsd: seeded.ledger.snapshot(agent.id).cashUsd,
        equityUsd: seeded.ledger.equity(agent.id, {}).equityUsd,
      }]),
    );
    assert.equal(before['atm-legacy-00'].cashUsd, 50);

    const automaton = await createAutomaton({ config: env.config, paths: env.paths, broker, clock });
    await automaton.init();
    const registry = automaton._internals.registry;
    const ledger = automaton._internals.ledger;
    const agents = registry.alive();
    assert.equal(agents.length, 30);
    const tiers = { day: 0, swing: 0 };
    for (const agent of agents) {
      const tier = tierForFamily(agent.genome.family);
      tiers[tier] += 1;
      const previous = before[agent.id];
      assert.ok(previous, `${agent.id}: the migration must preserve ids`);
      assert.equal(agent.endowmentUsd, previous.endowmentUsd);
      assert.equal(ledger.snapshot(agent.id).cashUsd, previous.cashUsd, `${agent.id}: ledger cash untouched`);
      assert.equal(ledger.equity(agent.id, {}).equityUsd, previous.equityUsd);
      assert.equal(agent.tier, tier, `${agent.id}: tier follows the migrated family`);
      assert.equal(agent.specId, null, `${agent.id}: legacy specs are cleared`);
      assert.deepEqual(agent.specIds, {}, `${agent.id}: legacy per-symbol specs are cleared`);
      assert.equal(agent.symbols.length, tier === 'day' ? 4 : 3, `${agent.id}: basket matches its NEW tier`);
      assert.equal(agent.symbols[0], agent.genome.symbol, `${agent.id}: primary is the first basket entry`);
      assert.deepEqual(agent.genome.symbols, agent.symbols);
    }
    assert.deepEqual(tiers, { day: 21, swing: 9 }, '50/50 -> 70/30 migration');
    const marker = JSON.parse(fs.readFileSync(path.join(env.paths.stateDir, 'portfolio-v32.json'), 'utf8'));
    assert.equal(marker.version, 1);
    assert.equal(marker.changed, 30);

    // Idempotence: a second boot with the same target changes nothing further.
    const snapshotAfterFirst = agents
      .map((agent) => [agent.id, agent.genome.family, agent.symbols.join(',')])
      .sort();
    const automaton2 = await createAutomaton({ config: env.config, paths: env.paths, broker, clock });
    await automaton2.init();
    const agents2 = automaton2._internals.registry.alive();
    const snapshotAfterSecond = agents2
      .map((agent) => [agent.id, agent.genome.family, agent.symbols.join(',')])
      .sort();
    assert.deepEqual(snapshotAfterSecond, snapshotAfterFirst, 'the migration must be idempotent');
    const markerAgain = JSON.parse(fs.readFileSync(path.join(env.paths.stateDir, 'portfolio-v32.json'), 'utf8'));
    assert.equal(markerAgain.at, marker.at, 'the marker is not rewritten by a no-op boot');
  });

  it('a 50/50 -> 70/30 mix change on an EXISTING v3.2 state (portfolio marker present) also re-derives baskets', async () => {
    const env = makeV32Env({ strategyMix: { dayPct: 0.5 } });
    const { clock, broker } = v32Boot(env);
    const automaton50 = await createAutomaton({ config: env.config, paths: env.paths, broker, clock });
    await automaton50.init();
    const markerBefore = JSON.parse(fs.readFileSync(path.join(env.paths.stateDir, 'portfolio-v32.json'), 'utf8'));
    const tiersBefore = automaton50._internals.registry.alive().reduce((counts, agent) => {
      const tier = tierForFamily(agent.genome.family);
      counts[tier] = (counts[tier] ?? 0) + 1;
      return counts;
    }, {});
    assert.deepEqual(tiersBefore, { day: 15, swing: 15 }, 'the first boot is the legacy 50/50 population');

    // Operator changes strategyMix.dayPct to 0.7: load a new config for the SAME state dir.
    const { config: config70 } = loadConfig({
      cwd: env.dir,
      env: {},
      configFile: path.join(env.dir, 'no-such-config.json'),
      overrides: {
        mode: 'sim',
        paths: { stateDir: env.paths.stateDir, envFile: env.paths.envFile },
        population: { initial: 30, cap: 60 },
        endowmentUsd: 50,
        deathFloorUsd: 1,
        deathFloorPct: 0,
        maxDrawdownPct: 0.9,
        risk: { maxDailyLossPct: 1 },
        replication: { childEndowmentUsd: 20, surplus7dUsd: 2, minRunwayHours: 24 },
        strategyMix: { dayPct: 0.7 },
        instruments: { enabled: false },
      },
    });
    const clock70 = makeClock(T0);
    const broker70 = createSimBroker(config70, { seed: 7, accountEquityUsd: 100000, clock: clock70 });
    const automaton70 = await createAutomaton({ config: config70, paths: statePaths(config70), broker: broker70, clock: clock70 });
    await automaton70.init();
    const agents = automaton70._internals.registry.alive();
    const tiersAfter = { day: 0, swing: 0 };
    const basketSizes = { day: {}, swing: {} };
    for (const agent of agents) {
      const tier = tierForFamily(agent.genome.family);
      tiersAfter[tier] += 1;
      basketSizes[tier][agent.symbols.length] = (basketSizes[tier][agent.symbols.length] ?? 0) + 1;
      assert.equal(agent.tier, tier);
    }
    assert.deepEqual(tiersAfter, { day: 21, swing: 9 });
    assert.deepEqual(basketSizes.day, { 4: 21 }, 'rebalanced day bots must have 4-symbol baskets');
    assert.deepEqual(basketSizes.swing, { 3: 9 }, 'swing bots must have 3-symbol baskets');
    const markerAfter = JSON.parse(fs.readFileSync(path.join(env.paths.stateDir, 'portfolio-v32.json'), 'utf8'));
    assert.equal(markerAfter.at, markerBefore.at, 'the one-time basket marker is not rewritten');
  });

  it('replicator: child inherits the parent basket, keeps its size, and has exactly one logical genome mutation', async () => {
    const seeds = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const seenFields = new Set();
    for (const seed of seeds) {
      const env = makeV32Env({
        population: { initial: 0, cap: 100 },
        endowmentUsd: 5000,
        replication: { childEndowmentUsd: 2500, surplus7dUsd: 2, minRunwayHours: 24 },
        instruments: { enabled: false },
      });
      const { clock } = v32Boot(env);
      const registry = createRegistry({ paths: env.paths, config: env.config, clock });
      const ledger = createLedger({ paths: env.paths, config: env.config, clock });
      const journal = createJournal({ paths: env.paths, config: env.config });
      const parentId = `atm-parent-${seed}`;
      const parentBasket = ['F', 'SOFI', 'BAC', 'INTC'];
      const parentGenome = {
        symbol: parentBasket[0],
        symbols: [...parentBasket],
        family: 'momentum',
        lookback: 60,
        entryZ: 1.2,
        exitZ: 0.3,
        stopPct: 0.02,
        targetPct: 0.04,
        maxHoldBars: 8,
        sizePct: 0.15,
        sessionFilter: 'any',
      };
      await registry.register({
        id: parentId,
        generation: 0,
        bornAt: clock.iso(),
        status: 'alive',
        endowmentUsd: 5000,
        genome: parentGenome,
        symbols: [...parentBasket],
        specIds: {},
        mutation: null,
        specId: null,
        tier: 'day',
      });
      ledger.ensureAgent(parentId, { endowmentUsd: 5000, at: clock.iso() });
      ledger.grant(parentId, 5000, { reason: 'genesis', at: clock.iso() });
      const treasurer = {
        fundChild(parentID, childId, amountUsd) {
          ledger.transfer(parentID, childId, amountUsd, { reason: 'child-endowment', at: clock.iso() });
        },
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
      const gate = { mayReplicate: true, surplus7dUsd: 1000, runwayHours: 1000, agentViews: [{ agentId: parentId, equityUsd: 5000 }] };
      const spawned = await replicator.spawn(parentId, gate);
      const { child, mutation } = spawned;
      seenFields.add(mutation.field);

      // Exactly one MUTABLE-catalogue field changes (arrays compared deeply, per v3.2).
      const changedMutable = MUTABLE_FIELDS.filter(
        (field) => JSON.stringify(parentGenome[field]) !== JSON.stringify(child.genome[field]),
      );
      assert.deepEqual(changedMutable, [mutation.field], `seed ${seed}: exactly one logical mutation`);
      assert.equal(child.mutation.from, parentGenome[mutation.field] ?? null);
      assert.equal(child.mutation.to, child.genome[mutation.field]);

      // v3.2 basket inheritance: the child keeps the parent's basket SIZE (never grows it).
      assert.equal(child.symbols.length, parentBasket.length, `seed ${seed} (${mutation.field}): basket must not grow`);
      assert.equal(child.genome.symbols.length, parentBasket.length);
      assert.deepEqual(child.genome.symbols, child.symbols, 'genome basket and registry basket agree');
      assert.equal(child.genome.symbol, child.symbols[0]);
      if (mutation.field === 'symbol') {
        assert.equal(child.symbols[0], mutation.to, 'the mutated symbol becomes the basket primary');
        const retained = parentBasket.includes(mutation.to)
          ? parentBasket.filter((symbol) => symbol !== mutation.to)
          : parentBasket.slice(1);
        assert.deepEqual(child.symbols.slice(1), retained, 'the rest of the inherited basket is retained in order');
      } else {
        assert.deepEqual(child.symbols, parentBasket, 'non-symbol mutations leave the inherited basket untouched');
        assert.deepEqual(child.genome.symbols, parentBasket);
      }
      assert.equal(child.tier, tierForFamily(child.genome.family), 'tier follows the mutated family');
      assert.equal(ledger.snapshot(child.id).cashUsd, env.config.replication.childEndowmentUsd);
    }
    assert.equal(seenFields.size >= 4, true, `mutation sweep should cover several fields, got ${JSON.stringify([...seenFields])}`);
    assert.equal(seenFields.has('symbol'), true, 'the seed sweep must cover the symbol mutation');
  });
});

// ---------------------------------------------------------------------------
// v3.2 executor: basket entries/exits, tier caps, brakes-first, legacy mode
// ---------------------------------------------------------------------------

const V32_HOUR_MS = 60 * 60 * 1000;

/** Executor world with a multi-symbol basket; options disabled so playbooks fall back to long stock. */
function makeV32PortfolioWorld({ endowmentUsd = 5000, basket = ['AAPL', 'MSFT', 'NVDA', 'AMD'] } = {}) {
  const env = makeEnv({
    population: { initial: 0, cap: 20 },
    endowmentUsd,
    deathFloorUsd: 1,
    deathFloorPct: 0,
    maxDrawdownPct: 0.9,
    risk: { maxDailyLossPct: 1, maxOpenPositions: 6, maxOrdersPerCycle: 1 },
    strategyMix: { dayPct: 0.7 },
    instruments: { enabled: true, allowOptions: false, allowSpreads: false, allowCoveredCalls: false, allowShort: true },
  });
  const clock = makeClock(T0);
  const broker = createSimBroker(env.config, { seed: 7, accountEquityUsd: 100000, clock });
  const registry = createRegistry({ paths: env.paths, config: env.config, clock });
  const ledger = createLedger({ paths: env.paths, config: env.config, clock });
  const brakes = createBrakes({ config: env.config, paths: env.paths, clock });
  const executor = createExecutor({ broker, brakes, ledger, config: env.config, clock });
  const id = 'atm-v32port';
  registry.register({
    id,
    generation: 0,
    bornAt: clock.iso(),
    status: 'alive',
    endowmentUsd,
    genome: {
      symbol: basket[0],
      symbols: [...basket],
      family: 'breakout',
      lookback: 60,
      entryZ: 1,
      exitZ: 0.5,
      stopPct: 0.02,
      targetPct: 0.04,
      maxHoldBars: 12,
      sizePct: 0.2,
      sessionFilter: 'any',
    },
    symbols: [...basket],
    specIds: {},
    mutation: null,
    specId: null,
    tier: 'day',
  });
  ledger.ensureAgent(id, { endowmentUsd, at: clock.iso() });
  ledger.grant(id, endowmentUsd, { reason: 'genesis', at: clock.iso() });
  ledger.anchorToBrokerEquity(100000);
  const mandate = {
    agentId: id,
    issuedAt: clock.iso(),
    expiresAt: new Date(T0 + 10 * 60 * 1000).toISOString(),
    state: 'STABLE',
    sizeBudgetUsd: 1000,
    maxOrderNotionalUsd: 1000,
    maxDailyOrdersRemaining: 12,
    allowedSymbols: [...env.config.symbols],
    allowExitOnly: false,
    instruments: deriveInstrumentPermissions(env.config, endowmentUsd),
    accountEquityUsd: 100000,
    allocatedEquityUsd: endowmentUsd,
    buyingPowerUsd: 100000,
  };
  return { env, config: env.config, paths: env.paths, clock, broker, registry, ledger, brakes, executor, id, mandate, basket, endowmentUsd };
}

function v32Spec(world, symbol, { family = 'breakout', params = {} } = {}) {
  return {
    specId: `spec-${String(symbol).toLowerCase()}`,
    hypothesisId: `hyp-${symbol}`,
    agentId: world.id,
    symbol,
    family,
    createdAt: new Date(T0).toISOString(),
    proofRef: `https://data.alpaca.markets/v2/stocks/bars?symbols=${symbol}`,
    proof: { observedAt: new Date(T0 - V32_HOUR_MS).toISOString(), sampleSize: 20 },
    params: {
      lookback: 60,
      entryZ: 1,
      exitZ: 0.5,
      stopPct: 0.02,
      targetPct: 0.04,
      maxHoldBars: 12,
      sizePct: 0.2,
      sessionFilter: 'any',
      ...params,
    },
  };
}

/** Bars whose last close breaks above the prior range: a bullish breakout signal. */
function v32BreakoutBars(last) {
  const bars = [];
  for (let i = 0; i < 39; i += 1) {
    bars.push({ t: T0 - (40 - i) * V32_HOUR_MS, o: last, h: last + 0.4, l: last - 0.4, c: last, v: 1000 });
  }
  bars.push({ t: T0, o: last + 1, h: last + 2, l: last + 0.9, c: last * 1.05, v: 5000 });
  return bars;
}

function v32Market(world, symbols) {
  const quotes = {};
  const bars = {};
  for (const symbol of symbols) {
    const quote = world.broker.getLatestQuote(symbol);
    quotes[symbol] = quote;
    bars[symbol] = v32BreakoutBars(quote.last);
  }
  return { quotes, bars };
}

function v32DayStats(world) {
  return { dayKey: '2026-01-05', ordersCount: 0, startEquityUsd: world.endowmentUsd, pnlUsd: 0 };
}

async function v32Run(world, { specs, portfolio, quotes, bars, policy = null, dayStats = null } = {}) {
  return world.executor.run({
    agent: world.registry.get(world.id),
    spec: specs?.[0] ?? null,
    specs,
    portfolio,
    mandate: {
      ...world.mandate,
      issuedAt: world.clock.iso(),
      expiresAt: new Date(T0 + 10 * 60 * 1000).toISOString(),
    },
    quotes,
    bars,
    dayStats: dayStats ?? v32DayStats(world),
    now: T0,
    policy,
  });
}

/** Seed one long stock position through the sim broker and mirror it into the ledger. */
function v32SeedPosition(world, symbol, qty = 1) {
  const order = world.broker.submitOrder({ symbol, side: 'buy', qty, type: 'market' });
  world.ledger.applyFill(world.id, {
    symbol,
    side: 'buy',
    qty: order.filledQty,
    priceUsd: order.avgFillPriceUsd,
    at: world.clock.iso(),
    orderId: order.id,
  });
  return order;
}

describe('v3.2 multi-symbol executor: basket entries/exits, caps, brakes-first, legacy mode', () => {
  it('opens entries across several basket symbols with one order per symbol and the shared per-cycle cap', async () => {
    const world = makeV32PortfolioWorld();
    const symbols = world.basket.slice(0, 3);
    const specs = symbols.map((symbol) => v32Spec(world, symbol));
    const { quotes, bars } = v32Market(world, symbols);
    const result = await v32Run(world, { specs, portfolio: { maxOpenPositions: 5, maxOrdersPerCycle: 2 }, quotes, bars });
    assert.deepEqual(result.denied, [], JSON.stringify(result.denied));
    assert.equal(result.orders.length, 2, 'the shared maxOrdersPerCycle cap applies across symbols');
    const orderedSymbols = result.orders.map((order) => order.symbol);
    assert.equal(new Set(orderedSymbols).size, 2, 'one order per symbol');
    for (const order of result.orders) {
      assert.equal(order.side, 'buy');
      assert.equal(order.status, 'filled');
      const specId = specs.find((spec) => spec.symbol === order.symbol).specId;
      assert.match(String(order.clientOrderId), new RegExp(`^atm:${world.id}:${specId}:\\d+$`), 'each order is attributed to that symbol\'s spec');
    }
    assert.equal(Object.keys(world.ledger.book(world.id).positions).length, 2, 'two distinct positions are open');
    assert.equal(result.actions.filter((action) => action.type === 'entry').length, 2);
    assert.ok(result.actions.some((action) => action.type === 'skip' && action.reason === 'max_orders_per_cycle'));
  });

  it('per-symbol exits: only the symbol whose stop is hit is sold; other basket positions are untouched', async () => {
    const world = makeV32PortfolioWorld();
    const symbols = ['AAPL', 'MSFT'];
    const specs = symbols.map((symbol) => v32Spec(world, symbol));
    v32SeedPosition(world, 'AAPL');
    v32SeedPosition(world, 'MSFT');
    const msftQuote = world.broker.getLatestQuote('MSFT');
    const quotes = {
      AAPL: { symbol: 'AAPL', bid: world.ledger.snapshot(world.id).positions.AAPL.avgPriceUsd * 0.9, ask: world.ledger.snapshot(world.id).positions.AAPL.avgPriceUsd * 0.9, last: world.ledger.snapshot(world.id).positions.AAPL.avgPriceUsd * 0.9 },
      MSFT: msftQuote,
    };
    const bars = { AAPL: v32BreakoutBars(quotes.AAPL.last), MSFT: v32BreakoutBars(msftQuote.last) };
    const result = await v32Run(world, { specs, portfolio: { maxOpenPositions: 5, maxOrdersPerCycle: 3 }, quotes, bars });
    assert.deepEqual(result.denied, []);
    assert.equal(result.orders.length, 1, 'only the stopped symbol may be sold');
    assert.equal(result.orders[0].symbol, 'AAPL');
    assert.equal(result.orders[0].side, 'sell');
    assert.ok(result.actions.some((action) => action.type === 'exit' && action.symbol === 'AAPL' && action.reason === 'stop'));
    const positions = world.ledger.book(world.id).positions;
    assert.equal(positions.AAPL, undefined, 'the stopped position is closed');
    assert.ok(positions.MSFT, 'the other basket position must be untouched');
    assert.equal(positions.MSFT.qtySigned, 1);
    // the remaining position can still be exited on the next run (no cross-symbol corruption);
    // the shared order budget is 1 so the exit cannot be followed by a re-entry in the same run
    const close = await v32Run(world, {
      specs,
      portfolio: { maxOpenPositions: 5, maxOrdersPerCycle: 1 },
      quotes: { AAPL: quotes.AAPL, MSFT: msftQuote },
      bars,
      policy: { stance: 'trade', atMs: T0, exitPressure: 'exit' },
    });
    assert.deepEqual(close.denied, []);
    assert.deepEqual(close.orders.map((order) => order.symbol), ['MSFT']);
    assert.deepEqual(world.ledger.book(world.id).positions, {});
  });

  it('enforces the tier maxOpenPositions cap and shares the order budget between exits and entries', async () => {
    // 1) tier position cap: three bullish symbols, cap = 1 -> a single entry
    const capped = makeV32PortfolioWorld();
    const cappedSymbols = capped.basket.slice(0, 3);
    const cappedSpecs = cappedSymbols.map((symbol) => v32Spec(capped, symbol));
    const cappedMarket = v32Market(capped, cappedSymbols);
    const first = await v32Run(capped, {
      specs: cappedSpecs,
      portfolio: { maxOpenPositions: 1, maxOrdersPerCycle: 3 },
      quotes: cappedMarket.quotes,
      bars: cappedMarket.bars,
    });
    assert.deepEqual(first.denied, []);
    assert.equal(first.orders.length, 1, 'maxOpenPositions=1 allows only one entry in the run');
    assert.equal(Object.keys(capped.ledger.book(capped.id).positions).length, 1);
    assert.equal(
      first.actions.filter((action) => action.type === 'skip' && action.reason === 'max_open_positions').length,
      2,
    );

    // 2) shared budget: an exit consumes the only order slot, so no entry is placed in the same run
    const shared = makeV32PortfolioWorld();
    v32SeedPosition(shared, 'AAPL');
    const aaplAvg = shared.ledger.snapshot(shared.id).positions.AAPL.avgPriceUsd;
    const stalledQuote = { symbol: 'AAPL', bid: aaplAvg * 0.9, ask: aaplAvg * 0.9, last: aaplAvg * 0.9 };
    const otherSymbols = shared.basket.slice(1, 3);
    const otherQuotes = Object.fromEntries(otherSymbols.map((symbol) => [symbol, shared.broker.getLatestQuote(symbol)]));
    const sharedSpecs = ['AAPL', ...otherSymbols].map((symbol) => v32Spec(shared, symbol));
    const sharedResult = await v32Run(shared, {
      specs: sharedSpecs,
      portfolio: { maxOpenPositions: 5, maxOrdersPerCycle: 1 },
      quotes: { AAPL: stalledQuote, ...otherQuotes },
      bars: {
        AAPL: v32BreakoutBars(stalledQuote.last),
        ...Object.fromEntries(otherSymbols.map((symbol) => [symbol, v32BreakoutBars(otherQuotes[symbol].last)])),
      },
    });
    assert.deepEqual(sharedResult.denied, []);
    assert.equal(sharedResult.orders.length, 1, 'the shared order budget is one');
    assert.equal(sharedResult.orders[0].symbol, 'AAPL');
    assert.equal(sharedResult.orders[0].side, 'sell');
    assert.deepEqual(shared.ledger.book(shared.id).positions, {}, 'no entry may follow the exit in the same run');

    // 3) brakes-first: the kill switch denies every basket order, then removal allows them again
    const armed = makeV32PortfolioWorld();
    const armedSymbols = armed.basket.slice(0, 2);
    const armedSpecs = armedSymbols.map((symbol) => v32Spec(armed, symbol));
    const armedMarket = v32Market(armed, armedSymbols);
    fs.mkdirSync(path.dirname(armed.paths.killSwitch), { recursive: true });
    fs.writeFileSync(armed.paths.killSwitch, JSON.stringify({ armedAt: new Date(T0).toISOString(), reason: 'verifier' }), 'utf8');
    const blocked = await v32Run(armed, {
      specs: armedSpecs,
      portfolio: { maxOpenPositions: 5, maxOrdersPerCycle: 2 },
      quotes: armedMarket.quotes,
      bars: armedMarket.bars,
    });
    assert.equal(blocked.orders.length, 0);
    assert.ok(blocked.denied.length >= 1);
    assert.equal(blocked.denied.every((denial) => denial.code === 'KILL_SWITCH'), true, JSON.stringify(blocked.denied));
    fs.rmSync(armed.paths.killSwitch, { force: true });
    const allowed = await v32Run(armed, {
      specs: armedSpecs,
      portfolio: { maxOpenPositions: 5, maxOrdersPerCycle: 2 },
      quotes: armedMarket.quotes,
      bars: armedMarket.bars,
    });
    assert.deepEqual(allowed.denied, []);
    assert.equal(allowed.orders.length >= 1, true);
  });

  it('legacy single-spec mode is unchanged: one symbol for entries, every held position for exits', async () => {
    const world = makeV32PortfolioWorld();
    const specs = ['AAPL', 'MSFT'].map((symbol) => v32Spec(world, symbol));
    const { quotes, bars } = v32Market(world, ['AAPL', 'MSFT']);
    // legacy: only `spec` (no `specs`, no `portfolio`) -> old single-symbol entry path
    const legacy = await world.executor.run({
      agent: world.registry.get(world.id),
      spec: specs[0],
      mandate: world.mandate,
      quotes,
      bars,
      dayStats: v32DayStats(world),
      now: T0,
    });
    assert.deepEqual(legacy.denied, []);
    assert.equal(legacy.orders.length, 1, 'legacy risk.maxOrdersPerCycle is still 1');
    assert.equal(legacy.orders[0].symbol, 'AAPL', 'legacy entries only use the single spec symbol');
    // basket mode on a fresh market places up to two orders (one per symbol)
    const basketWorld = makeV32PortfolioWorld();
    const basketSpecs = ['AAPL', 'MSFT'].map((symbol) => v32Spec(basketWorld, symbol));
    const basketMarket = v32Market(basketWorld, ['AAPL', 'MSFT']);
    const basket = await v32Run(basketWorld, {
      specs: basketSpecs,
      portfolio: { maxOpenPositions: 5, maxOrdersPerCycle: 2 },
      quotes: basketMarket.quotes,
      bars: basketMarket.bars,
    });
    assert.deepEqual(basket.denied, []);
    assert.equal(basket.orders.length, 2);
    // legacy exits still manage every held position (policy exit pressure); one order per run
    v32SeedPosition(world, 'MSFT');
    assert.equal(Object.keys(world.ledger.book(world.id).positions).length, 2);
    const close = await world.executor.run({
      agent: world.registry.get(world.id),
      spec: specs[0],
      mandate: world.mandate,
      quotes,
      bars,
      dayStats: v32DayStats(world),
      now: T0,
      policy: { stance: 'trade', atMs: T0, exitPressure: 'exit' },
    });
    assert.deepEqual(close.denied, []);
    assert.equal(close.orders.length, 1, 'legacy risk.maxOrdersPerCycle still bounds each run (1 exit)');
    assert.equal(Object.keys(world.ledger.book(world.id).positions).length, 1, 'one position remains for the next run');
    const closeSecond = await world.executor.run({
      agent: world.registry.get(world.id),
      spec: specs[0],
      mandate: world.mandate,
      quotes,
      bars,
      dayStats: v32DayStats(world),
      now: T0,
      policy: { stance: 'trade', atMs: T0, exitPressure: 'exit' },
    });
    assert.deepEqual(closeSecond.denied, []);
    assert.equal(closeSecond.orders.length, 1, 'the second legacy run closes the remaining position');
    assert.equal([...close.orders, ...closeSecond.orders].every((order) => order.side === 'sell'), true);
    assert.deepEqual(world.ledger.book(world.id).positions, {});
  });

  it('options still trade in basket/portfolio mode through the real brake wall', async () => {
    const world = makeInstrumentWorld();
    const primary = instrumentSpec(world, { symbol: world.symbol });
    const secondSymbol = world.config.symbols.find((symbol) => symbol !== world.symbol);
    const secondary = instrumentSpec(world, { symbol: secondSymbol, specId: 'spec-second' });
    const primaryQuote = world.broker.getLatestQuote(world.symbol);
    const secondQuote = world.broker.getLatestQuote(secondSymbol);
    const result = await world.executor.run({
      agent: world.registry.get(world.id),
      spec: primary,
      specs: [primary, secondary],
      portfolio: { maxOpenPositions: 5, maxOrdersPerCycle: 1 },
      mandate: world.mandate,
      quotes: { [world.symbol]: primaryQuote, [secondSymbol]: secondQuote },
      bars: {
        [world.symbol]: instrumentBars(primaryQuote.last, 1),
        [secondSymbol]: instrumentBars(secondQuote.last, 1),
      },
      dayStats: { dayKey: '2026-01-05', ordersCount: 0, startEquityUsd: world.endowmentUsd, pnlUsd: 0 },
      now: T0,
      policy: instrumentPolicy(world, 'long_call'),
    });
    assert.deepEqual(result.denied, [], JSON.stringify(result.denied));
    assert.equal(result.orders.length, 1, 'the shared order cap is one');
    const order = result.orders[0];
    assert.equal(order.assetClass, 'us_option', 'the instrument playbook still opens options in basket mode');
    assert.match(String(order.symbol), /^[A-Z]{1,6}\d{6}[CP]\d{8}$/);
    const optionPosition = world.ledger.snapshot(world.id).positionsList.find((position) => position.assetClass === 'us_option');
    assert.ok(optionPosition);
    assert.equal(optionPosition.symbol, order.symbol);
    assert.equal(optionPosition.multiplier, 100);
  });
});

// ---------------------------------------------------------------------------
// v3.2 status surface, engine.marketView analytics, halted/CRITICAL recovery
// ---------------------------------------------------------------------------

describe('v3.2 status + analytics: portfolio/strategyMix, spec coherence, effective capabilities, marketView', () => {
  it('orchestrator status exposes portfolio/strategyMix.target and coherent per-agent symbols/specs/specIds', async () => {
    const env = makeEnv({
      population: { initial: 6, cap: 20 },
      endowmentUsd: 50,
      deathFloorUsd: 1,
      deathFloorPct: 0,
      maxDrawdownPct: 0.9,
      risk: { maxDailyLossPct: 1 },
      replication: { childEndowmentUsd: 20, surplus7dUsd: 2, minRunwayHours: 24 },
      strategyMix: { dayPct: 0.7 },
      instruments: { enabled: false },
    });
    const { clock, broker } = v32Boot(env);
    const automaton = await createAutomaton({ config: env.config, paths: env.paths, broker, clock });
    await automaton.init();
    for (let cycle = 0; cycle < 2; cycle += 1) {
      clock.advance(60 * 1000);
      // eslint-disable-next-line no-await-in-loop
      const trace = await automaton.tick();
      assert.equal(trace.halted, false);
    }
    const status = await automaton.status();
    const registry = automaton._internals.registry;
    const state = automaton._internals.state;
    assert.deepEqual(status.engine.portfolio, { ...env.config.portfolio, strategyMix: { dayPct: 0.7 } });
    assert.deepEqual(status.strategyMix.target, { dayPct: 0.7, dayCount: 4, swingCount: 2 });
    assert.equal(status.strategyMix.total, 6);
    let agentsWithSpecs = 0;
    for (const row of status.agents) {
      const agent = registry.get(row.id);
      assert.deepEqual(row.symbols, agent.symbols);
      assert.equal(row.tier, tierForFamily(agent.genome.family));
      assert.equal(row.symbols.length, row.tier === 'day' ? 4 : 3);
      assert.equal(new Set(row.symbols).size, row.symbols.length);
      for (const spec of row.specs) {
        assert.ok(row.symbols.includes(spec.symbol), `${row.id}: only basket symbols may get specs`);
        assert.equal(spec.family, agent.genome.family);
        assert.match(String(spec.specId), /^spec-/);
        const compiled = state.specs.get(spec.specId);
        assert.ok(compiled, `${row.id}: spec ${spec.specId} must be loaded in memory`);
        assert.equal(compiled.symbol, spec.symbol);
      }
      const specIds = agent.specIds ?? {};
      for (const [symbol, specId] of Object.entries(specIds)) {
        const rowSpec = row.specs.find((spec) => spec.symbol === symbol);
        assert.ok(rowSpec, `${row.id}: specIds entry ${symbol} must be in the status specs`);
        assert.equal(rowSpec.specId, specId);
      }
      if (row.spec !== null) {
        assert.equal(row.spec.symbol, agent.genome.symbol, 'the primary spec belongs to the primary symbol');
        assert.equal(row.spec.specId, agent.specId);
      }
      if (row.specs.length > 0) agentsWithSpecs += 1;
    }
    assert.ok(agentsWithSpecs >= 1, 'at least one bot must have compiled basket specs after two cycles');
    const lastTrace = state.lastTrace;
    const build = lastTrace.builds.find((entry) => Array.isArray(entry.specs) && entry.specs.length > 0);
    assert.ok(build, 'a build trace must carry the compiled basket specs list');
    assert.ok(Array.isArray(build.basket) && build.basket.length > 0);
    assert.ok(build.specs.every((entry) => typeof entry === 'string' && entry.includes(':')));
  });

  it('restricted paper account: effective instrument capabilities are gated while permissions remain', async () => {
    const env = makeEnv({
      population: { initial: 3, cap: 10 },
      endowmentUsd: 50,
      deathFloorUsd: 1,
      deathFloorPct: 0,
      maxDrawdownPct: 0.9,
      risk: { maxDailyLossPct: 1 },
      replication: { childEndowmentUsd: 20, surplus7dUsd: 2, minRunwayHours: 24 },
      strategyMix: { dayPct: 0.7 },
    });
    const clock = makeClock(T0);
    const sim = createSimBroker(env.config, { seed: 7, accountEquityUsd: 100000, clock });
    const restricted = {
      ...sim,
      async getAccount() {
        const account = await sim.getAccount();
        return { ...account, shortingEnabled: false, marginMultiplier: 1, optionsTradingLevel: 3 };
      },
    };
    const automaton = await createAutomaton({ config: env.config, paths: env.paths, broker: restricted, clock });
    await automaton.init();
    clock.advance(60 * 1000);
    await automaton.tick();
    const status = await automaton.status();
    const instruments = status.engine.instruments;
    assert.equal(instruments.enabled, true);
    assert.equal(instruments.shortStock, true, 'the granted permission still exists');
    assert.equal(instruments.effective.shortStock, false, 'but the broker account cannot short right now');
    assert.equal(instruments.effective.margin, false);
    assert.equal(instruments.effective.creditOptions, false);
    assert.ok(instruments.effective.structures.includes('long_call'));
    assert.equal(instruments.effective.structures.includes('covered_call'), false);
    assert.equal(instruments.effective.structures.includes('call_credit_spread'), false);
    assert.equal(instruments.account.shortingEnabled, false);
    assert.equal(instruments.account.marginMultiplier, 1);
  });
});

describe('v3.2 engine.marketView analytics and halted/CRITICAL recovery', () => {
  it('marketView: full analytics shape from the sim broker, cached, no secrets, never trades', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-v32mv-'));
    createdDirs.push(dir);
    const clock = makeClock(T0);
    const engine = createEngine({
      cwd: dir,
      configFile: path.join(dir, 'no-such-config.json'),
      envFile: path.join(dir, '.env'),
      clock,
      overrides: { stateDir: path.join(dir, 'state'), mode: 'sim', seed: 7, accountEquityUsd: 100000 },
    });
    const ticked = await engine.tick();
    assert.equal(ticked.trace.halted, false);
    const view = await engine.marketView();
    assert.equal(view.ok, true);
    assert.ok(Number.isFinite(Date.parse(view.at)));
    assert.equal(typeof view.marketOpen, 'boolean');
    const symbols = engine.config.symbols;
    assert.equal(Object.keys(view.quotes).length, symbols.length, 'the tape covers the configured universe');
    for (const symbol of symbols) {
      const quote = view.quotes[symbol];
      assert.ok(quote, `missing quote for ${symbol}`);
      assert.ok(Number.isFinite(quote.priceUsd) && quote.priceUsd > 0);
      assert.ok(Number.isFinite(quote.bid) && Number.isFinite(quote.ask));
    }
    assert.equal(Object.keys(view.sparklines).length, symbols.length);
    for (const symbol of symbols) {
      assert.ok(Array.isArray(view.sparklines[symbol]), `sparkline ${symbol}`);
      assert.ok(view.sparklines[symbol].length > 0);
      assert.ok(view.sparklines[symbol].every((value) => Number.isFinite(value)));
    }
    for (const key of ['equityUsd', 'cashUsd', 'buyingPowerUsd', 'dayPnlUsd', 'dayPnlPct', 'grossExposureUsd', 'netExposureUsd', 'positions']) {
      assert.ok(Object.hasOwn(view.portfolio, key), `portfolio.${key}`);
    }
    assert.ok(Number.isFinite(view.portfolio.equityUsd));
    assert.ok(Array.isArray(view.agents));
    assert.equal(view.agents.length, 3);
    for (const agent of view.agents) {
      assert.equal(typeof agent.id, 'string');
      assert.ok(Array.isArray(agent.basket) && agent.basket.length > 0, 'agent rows carry the v3.2 basket');
      assert.ok(['day', 'swing'].includes(agent.tier));
    }
    assert.ok(Array.isArray(view.equityHistory) && view.equityHistory.length >= 1);
    for (const point of view.equityHistory) {
      assert.ok(Number.isFinite(Date.parse(point.at)));
      assert.ok(Number.isFinite(point.equityUsd));
      assert.ok(Number.isFinite(point.cashUsd));
    }
    assert.equal(view.engine.running, false);
    assert.equal(view.error, null);
    const text = JSON.stringify(view);
    for (const pattern of [/AKIA/, /secret/i, /password/i, /api[_-]?key/i, /token/i]) {
      assert.equal(pattern.test(text), false, `marketView leaked ${pattern}`);
    }
    assert.equal(engine.isRunning(), false, 'a read-only view must not start the loop');
    const again = await engine.marketView();
    assert.equal(again, view, 'the whole view is cached for 2 s');
    clock.advance(5000);
    const fresh = await engine.marketView();
    assert.ok(Date.parse(fresh.at) >= Date.parse(view.at));
    assert.equal(fresh.ok, true);
  });

  it('marketView on broker errors returns the last good view + error and never throws', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-v32mvf-'));
    createdDirs.push(dir);
    const clock = makeClock(T0);
    let failing = false;
    const engine = createEngine({
      cwd: dir,
      configFile: path.join(dir, 'no-such-config.json'),
      envFile: path.join(dir, '.env'),
      clock,
      overrides: { stateDir: path.join(dir, 'state'), mode: 'sim', seed: 7, accountEquityUsd: 100000 },
      brokerFactory: (mode, config) => {
        const sim = createSimBroker(config, { seed: 7, accountEquityUsd: 100000, clock });
        return {
          ...sim,
          async getClock() {
            if (failing) throw new Error('simulated clock outage');
            return sim.getClock();
          },
          async getSnapshots(...args) {
            if (failing) throw new Error('simulated snapshot outage');
            return sim.getSnapshots(...args);
          },
          async getBars(...args) {
            if (failing) throw new Error('simulated bars outage');
            return sim.getBars(...args);
          },
        };
      },
    });
    await engine.tick();
    const first = await engine.marketView();
    assert.equal(first.ok, true);
    assert.ok(Object.keys(first.quotes).length > 0);
    assert.equal(first.error, null);
    clock.advance(20000);
    failing = true;
    const failingView = await engine.marketView();
    assert.equal(failingView.ok, true, 'a transient broker error must not fail the whole view');
    assert.ok(failingView.error, 'the error is surfaced in the view');
    assert.ok(failingView.quotes && Object.keys(failingView.quotes).length > 0, 'the last known quotes are kept');
    assert.deepEqual(Object.keys(failingView.quotes).sort(), Object.keys(first.quotes).sort());
    failing = false;
    clock.advance(20000);
    const recovered = await engine.marketView();
    assert.equal(recovered.ok, true);
    assert.equal(recovered.error, null, 'the next successful view clears the error');
  });

  it('marketView returns an error object instead of throwing when the broker cannot be constructed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-v32mvn-'));
    createdDirs.push(dir);
    const clock = makeClock(T0);
    // paper mode without credentials: makeBroker() throws CONFIG_INVALID if marketView is not defensive
    const engine = createEngine({
      cwd: dir,
      configFile: path.join(dir, 'no-such-config.json'),
      envFile: path.join(dir, '.env'),
      clock,
      overrides: { stateDir: path.join(dir, 'state'), mode: 'paper' },
    });
    let threw = null;
    let view = null;
    try {
      view = await engine.marketView();
    } catch (error) {
      threw = error;
    }
    assert.equal(threw, null, `marketView must not throw: ${threw?.code} ${threw?.message}`);
    assert.ok(view && typeof view === 'object');
    assert.equal(view.ok, false, 'no last good view exists, so the view reports failure');
    assert.ok(view.error && (view.error.code || view.error.message), 'the construction error is reported');
  });

  it('a broker_unavailable halt is reported and cleared by the next successful tick (no auto-reward)', async () => {
    const env = makeEnv({
      population: { initial: 3, cap: 10 },
      endowmentUsd: 50,
      deathFloorUsd: 1,
      deathFloorPct: 0,
      maxDrawdownPct: 0.9,
      risk: { maxDailyLossPct: 1 },
      replication: { childEndowmentUsd: 20, surplus7dUsd: 2, minRunwayHours: 24 },
      strategyMix: { dayPct: 0.7 },
      instruments: { enabled: false },
    });
    const clock = makeClock(T0);
    const sim = createSimBroker(env.config, { seed: 7, accountEquityUsd: 100000, clock });
    let fail = false;
    const flaky = {
      ...sim,
      async getAccount() {
        if (fail) throw new Error('simulated broker outage');
        return sim.getAccount();
      },
      async getPositions() {
        if (fail) throw new Error('simulated broker outage');
        return sim.getPositions();
      },
    };
    const automaton = await createAutomaton({ config: env.config, paths: env.paths, broker: flaky, clock });
    await automaton.init();
    clock.advance(60 * 1000);
    const healthy = await automaton.tick();
    assert.equal(healthy.halted, false);
    fail = true;
    clock.advance(60 * 1000);
    const halted = await automaton.tick();
    assert.equal(halted.halted, true);
    assert.ok(halted.haltReasons.includes('broker_unavailable'), JSON.stringify(halted.haltReasons));
    const haltedStatus = await automaton.status();
    assert.equal(haltedStatus.halted, true);
    assert.ok(haltedStatus.haltReasons.includes('broker_unavailable'));
    fail = false;
    clock.advance(60 * 1000);
    const recovered = await automaton.tick();
    assert.equal(recovered.halted, false, 'the next successful tick must clear the halt');
    const recoveredStatus = await automaton.status();
    assert.equal(recoveredStatus.halted, false);
    assert.deepEqual(recoveredStatus.haltReasons, []);
    assert.equal(recoveredStatus.engine.lastError, null);
  });

  it('treasury CRITICAL does not permanently stop trading, and funding restores STABLE', async () => {
    const env = makeEnv({
      population: { initial: 3, cap: 10 },
      endowmentUsd: 5000,
      maxDrawdownPct: 0.99,
      risk: { maxDailyLossPct: 1 },
      strategyMix: { dayPct: 0.7 },
      instruments: { enabled: false },
    });
    const clock = makeClock(T0);
    const broker = createSimBroker(env.config, { seed: 7, accountEquityUsd: 100000, clock });
    const automaton = await createAutomaton({ config: env.config, paths: env.paths, broker, clock });
    await automaton.init();
    const { ledger, registry } = automaton._internals;
    for (const agent of registry.alive()) {
      const cash = ledger.get(agent.id).cashUsd;
      ledger.charge(agent.id, cash - 251, { category: 'inference', role: 'executor', at: clock.now() });
    }
    ledger.save();
    clock.advance(60 * 1000);
    const critical = await automaton.tick();
    assert.equal(critical.halted, false, 'CRITICAL is a warning state, not a halt');
    assert.equal(critical.treasury.state, 'CRITICAL');
    assert.equal(critical.treasury.cycleBudgetUsd, env.config.cycleBudget.CRITICAL);
    assert.equal(critical.deaths.length, 0, 'CRITICAL must not kill the population');
    const criticalStatus = await automaton.status();
    assert.equal(criticalStatus.halted, false);
    assert.equal(criticalStatus.treasury.state, 'CRITICAL');
    for (const agent of registry.alive()) {
      ledger.transfer('__treasury__', agent.id, 1000, { reason: 'verifier refill', at: clock.now() });
    }
    ledger.save();
    clock.advance(60 * 1000);
    const recovered = await automaton.tick();
    assert.equal(recovered.halted, false);
    assert.equal(recovered.treasury.state, 'STABLE', 'funding must restore a healthy treasury');
    assert.equal(recovered.treasury.cycleBudgetUsd, env.config.cycleBudget.STABLE);
    assert.equal(recovered.deaths.length, 0);
  });

  it('the engine actually trades multiple basket symbols end-to-end; every fill stays inside the bot basket', async () => {
    const env = makeEnv({
      population: { initial: 6, cap: 20 },
      endowmentUsd: 50,
      deathFloorUsd: 1,
      deathFloorPct: 0,
      maxDrawdownPct: 0.9,
      risk: { maxDailyLossPct: 1 },
      replication: { childEndowmentUsd: 20, surplus7dUsd: 2, minRunwayHours: 24 },
      strategyMix: { dayPct: 0.7 },
      instruments: { enabled: true, allowOptions: false, allowSpreads: false, allowCoveredCalls: false, allowShort: true },
      data: { lookbackBars: 120 },
    });
    const { clock, broker } = v32Boot(env);
    const automaton = await createAutomaton({ config: env.config, paths: env.paths, broker, clock });
    await automaton.init();
    const registry = automaton._internals.registry;
    const violations = [];
    for (let cycle = 0; cycle < 15; cycle += 1) {
      clock.advance(60 * 1000);
      // eslint-disable-next-line no-await-in-loop
      const trace = await automaton.tick();
      for (const execution of trace.executions) {
        if (!(execution.orders > 0)) continue;
        const agent = registry.get(execution.agentId);
        for (const action of execution.detail ?? []) {
          if (!['entry', 'exit'].includes(action.type)) continue;
          if (!agent.symbols.includes(action.symbol)) violations.push([agent.id, action.symbol, agent.symbols]);
        }
      }
    }
    const tradedSymbols = new Set();
    let fills = 0;
    for (const agent of registry.alive()) {
      for (const fill of automaton._internals.ledger.history(agent.id, { limit: 100 })) {
        fills += 1;
        tradedSymbols.add(fill.symbol);
        if (!agent.symbols.includes(fill.symbol)) violations.push([agent.id, fill.symbol, agent.symbols]);
      }
    }
    assert.ok(fills >= 1, 'the sim population must trade within 15 cycles (deterministic seed)');
    assert.deepEqual(violations, [], 'no fill/detail may reference a symbol outside the bot basket');
    assert.ok(tradedSymbols.size >= 2, `the population should trade several basket symbols, got ${JSON.stringify([...tradedSymbols])}`);
    const status = await automaton.status();
    for (const row of status.agents) {
      for (const position of row.positions) {
        const underlying = String(position.option?.underlying ?? position.symbol).toUpperCase();
        assert.ok(row.symbols.includes(underlying), `${row.id}: position ${underlying} outside basket ${JSON.stringify(row.symbols)}`);
      }
    }
  });

  it('a stopped (or never-started) engine still serves status and market views safely', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-v32stop-'));
    createdDirs.push(dir);
    const clock = makeClock(T0);
    const engine = createEngine({
      cwd: dir,
      configFile: path.join(dir, 'no-such-config.json'),
      envFile: path.join(dir, '.env'),
      clock,
      overrides: { stateDir: path.join(dir, 'state'), mode: 'sim', seed: 7, accountEquityUsd: 100000 },
    });
    const beforeStart = await engine.marketView();
    assert.equal(beforeStart.ok, true, 'marketView works before the engine is started');
    assert.equal(beforeStart.engine.running, false);
    const statusBefore = await engine.status();
    assert.equal(statusBefore.engine.running, false);
    await engine.tick();
    await engine.stop();
    await engine.stop();
    assert.equal(engine.isRunning(), false);
    const stoppedView = await engine.marketView();
    assert.equal(stoppedView.ok, true);
    assert.equal(stoppedView.engine.running, false);
    const stoppedStatus = await engine.status();
    assert.equal(stoppedStatus.engine.running, false);
    assert.ok(Array.isArray(stoppedStatus.agents));
  });
});

// ===========================================================================
// L. v3.3 fair P&L, capital-only performance rewards and migration
//    (independent verification of docs/FAIR-PNL-REWARDS.md; verifier-owned)
// ===========================================================================

const REWARDED_LEGACY = Object.freeze({
  'atm-483016bc': 58.56, // GapFade META
  'atm-72e7db49': 35.13, // Breakout AAPL 2
  'atm-e0cd5998': 23.42, // Breakout F
  'atm-169e0921': 6.04, // Breakout AMD
  'atm-6d78cf8d': 3.62, // GapFade GOOGL
  'atm-5f4dc0e9': 2.41, // Breakout GOOGL 2
});

/** 30 real-shaped legacy v3.2 registry/ledger rows (ids, names, families, cash, costs, trades). */
const LEGACY_AGENTS = Object.freeze([
  ['atm-74c0d697', 'Momentum F', 'momentum', 'F', 48.48310775, 0, 1.51689225, 0],
  ['atm-ad7db998', 'Momentum MSFT', 'momentum', 'MSFT', 48.48410775, 0, 1.51589225, 0],
  ['atm-1b52d14c', 'Momentum NVDA', 'momentum', 'NVDA', 48.48610775, 0, 1.51389225, 0],
  ['atm-9dbdbc38', 'Momentum SOFI', 'momentum', 'SOFI', 48.46710775, -0.03, 1.50289225, 4],
  ['atm-3d4b951c', 'Momentum META', 'momentum', 'META', 48.43124651, -0.07, 1.51389225, 10],
  ['atm-5385d942', 'MeanRev AMZN', 'meanrev', 'AMZN', 43.32610775, -0.03, 1.51389225, 10],
  ['atm-9168aab4', 'MeanRev BAC', 'meanrev', 'BAC', 48.48210775, -0.01, 1.50789225, 2],
  ['atm-0af7fa29', 'MeanRev TSLA', 'meanrev', 'TSLA', 43.38354599, 0.05, 1.50989225, 12],
  ['atm-c4d00d9a', 'MeanRev SPY 2', 'meanrev', 'SPY', 48.49310775, 0, 1.50689225, 0],
  ['atm-a1aae193', 'Breakout INTC 2', 'breakout', 'INTC', 41.51010775, 0.02, 1.69989225, 23],
  ['atm-72e7db49', 'Breakout AAPL 2', 'breakout', 'AAPL', 74.03154267, 0.04, 1.69989225, 24],
  ['atm-a6f0c033', 'Breakout MSFT', 'breakout', 'MSFT', 43.25210775, 0.01, 1.69789225, 20],
  ['atm-e0cd5998', 'Breakout F', 'breakout', 'F', 71.71110775, 0, 1.69889225, 22],
  ['atm-169e0921', 'Breakout AMD', 'breakout', 'AMD', 48.58623655, -0.12, 1.68289225, 23],
  ['atm-1c441f0b', 'Breakout META', 'breakout', 'META', 43.23410775, 0.03, 1.69589225, 22],
  ['atm-182df876', 'Breakout SOFI', 'breakout', 'SOFI', 46.028165, 0.06, 1.79589225, 42],
  ['atm-5f4dc0e9', 'Breakout GOOGL 2', 'breakout', 'GOOGL', 47.46610775, 0.08, 1.80389225, 40],
  ['atm-93650747', 'Breakout TSLA 2', 'breakout', 'TSLA', 48.16341915, 0, 1.80289225, 42],
  ['atm-66de927f', 'Breakout BAC', 'breakout', 'BAC', 48.16410775, -0.05, 1.78589225, 40],
  ['atm-b788dce4', 'Breakout QQQ 2', 'breakout', 'QQQ', 42.66010775, -0.19, 1.77989225, 41],
  ['atm-74888551', 'GapFade AAPL', 'gapfade', 'AAPL', 48.20610775, -0.01, 1.78389225, 6],
  ['atm-0a7678bd', 'GapFade INTC', 'gapfade', 'INTC', 48.20610775, -0.01, 1.78389225, 36],
  ['atm-8ecc828c', 'GapFade NVDA', 'gapfade', 'NVDA', 48.20610775, 0.01, 1.78389225, 22],
  ['atm-6e6729fa', 'GapFade AMD', 'gapfade', 'AMD', 48.22610775, 0, 1.78389225, 4],
  ['atm-483016bc', 'GapFade META', 'gapfade', 'META', 106.86016832, 0.07, 1.78389225, 18],
  ['atm-231cc090', 'GapFade AMZN', 'gapfade', 'AMZN', 48.21710775, 0, 1.78289225, 0],
  ['atm-6d78cf8d', 'GapFade GOOGL', 'gapfade', 'GOOGL', 51.781165, -0.06, 1.78189225, 2],
  ['atm-d022131b', 'GapFade TSLA', 'gapfade', 'TSLA', 48.21810775, 0, 1.78189225, 0],
  ['atm-3f96d08c', 'GapFade SPY', 'gapfade', 'SPY', 48.21610775, 0, 1.78389225, 0],
  ['atm-48a1c1d4', 'GapFade QQQ', 'gapfade', 'QQQ', 48.24810775, 0.05, 1.78189225, 16],
]);

/** The real v3.2 live rewards journal shape (two paid weeks, one skipped week, legacy `percent`). */
const LEGACY_REWARDS = Object.freeze({
  version: 1,
  lastPeriodKey: '2026-W47',
  lastRunAt: '2026-11-16T09:10:36.948Z',
  lastWinners: [],
  history: [
    { period: 'weekly', periodKey: '2026-W44', at: '2026-11-02T14:34:44.813Z', winners: [
      { rank: 1, agentId: 'atm-483016bc', name: 'GapFade META', percent: 0.05, amountUsd: 58.56 },
      { rank: 2, agentId: 'atm-72e7db49', name: 'Breakout AAPL 2', percent: 0.03, amountUsd: 35.13 },
      { rank: 3, agentId: 'atm-e0cd5998', name: 'Breakout F', percent: 0.02, amountUsd: 23.42 },
    ] },
    { period: 'weekly', periodKey: '2026-W45', at: '2026-11-11T14:35:39.515Z', winners: [
      { rank: 1, agentId: 'atm-169e0921', name: 'Breakout AMD', percent: 0.05, amountUsd: 6.04 },
      { rank: 2, agentId: 'atm-6d78cf8d', name: 'GapFade GOOGL', percent: 0.03, amountUsd: 3.62 },
      { rank: 3, agentId: 'atm-5f4dc0e9', name: 'Breakout GOOGL 2', percent: 0.02, amountUsd: 2.41 },
    ] },
    { period: 'weekly', periodKey: '2026-W46', at: '2026-11-16T09:10:36.948Z', winners: [], skipped: true },
  ],
  nextRunAt: '2026-11-23T00:00:00.000Z',
  updatedAt: '2026-11-16T09:10:36.948Z',
});

/**
 * Write a REAL-shaped v3.2 state dir (30 legacy ledger records with no v3.3 capital fields,
 * registry endowments $50 while the ledger declared $20, live rewards history) and return the
 * layered sim config that points at it. Used for the migration dry run below.
 */
function writeLegacyV32State(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-v33-migration-'));
  createdDirs.push(dir);
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const at = '2026-11-22T09:00:00.000Z';
  const agents = {};
  const ledgerAgents = {};
  for (const [id, name, family, symbol, cash, realized, costs, trades] of LEGACY_AGENTS) {
    agents[id] = {
      id,
      name,
      parentId: null,
      generation: 0,
      bornAt: '2026-10-26T13:31:00.000Z',
      status: 'alive',
      endowmentUsd: 50,
      genome: { symbol, family },
      symbols: [symbol],
      specIds: {},
      mutation: null,
      specId: null,
      tier: family === 'momentum' || family === 'meanrev' ? 'swing' : 'day',
      notes: [],
    };
    ledgerAgents[id] = {
      agentId: id,
      cashUsd: cash,
      positions: {},
      realizedPlUsd: realized,
      costsUsd: costs,
      costsByRole: {},
      grossSpendUsd: 0,
      grossRevenueUsd: 0,
      creditsUsd: 0,
      trades,
      firstProfitAt: null,
      // v3.2 records declared $20 and have NO v3.3 capital fields at all.
      declaredEndowmentUsd: 20,
      startedAt: '2026-10-26T13:31:00.000Z',
      fills: [],
      events: [],
      markPrices: {},
      lastUnrealizedUsd: 0,
      lastMarginDebtUsd: 0,
      lastGrossExposureUsd: 0,
      lastNetExposureUsd: 0,
      updatedAt: at,
    };
  }
  ledgerAgents.__treasury__ = {
    agentId: '__treasury__', cashUsd: 370.82, positions: {}, realizedPlUsd: 0, costsUsd: 0,
    costsByRole: {}, grossSpendUsd: 0, grossRevenueUsd: 0, creditsUsd: 0, trades: 0,
    firstProfitAt: null, declaredEndowmentUsd: 0, startedAt: '2026-10-26T13:31:00.000Z',
    fills: [], events: [], markPrices: {}, lastUnrealizedUsd: 0, lastMarginDebtUsd: 0,
    lastGrossExposureUsd: 0, lastNetExposureUsd: 0, updatedAt: at,
  };
  fs.writeFileSync(path.join(stateDir, 'registry.json'), JSON.stringify({ version: 2, cap: 60, agents }));
  fs.writeFileSync(path.join(stateDir, 'ledger.json'), JSON.stringify({ version: 3, anchored: true, anchoredAt: at, agents: ledgerAgents }));
  fs.writeFileSync(path.join(stateDir, 'rewards.json'), JSON.stringify(LEGACY_REWARDS));
  // Legacy v3.2 rankings state for one agent: no trading/capital marks at all.
  fs.writeFileSync(path.join(stateDir, 'rankings.json'), JSON.stringify({
    version: 1,
    updatedAt: '2026-11-20T20:00:00.000Z',
    agents: {
      'atm-483016bc': {
        name: 'GapFade META',
        baseline: { daily: { key: '2026-11-20', equityUsd: 160.3 }, weekly: { key: '2026-W47', equityUsd: 160.3 }, monthly: { key: '2026-11', equityUsd: 160.3 } },
        last: { daily: { key: '2026-11-20', equityUsd: 160.3, trades: 18, atMs: T0 }, weekly: { key: '2026-W47', equityUsd: 160.3, trades: 18, atMs: T0 }, monthly: { key: '2026-11', equityUsd: 160.3, trades: 18, atMs: T0 } },
        previousBaseline: {},
        previousLast: {},
      },
    },
  }));
  // Legacy day-stats without the trading baseline (loadDayStats must anchor it fairly).
  fs.writeFileSync(path.join(stateDir, 'day-stats.json'), JSON.stringify({
    dayKey: '2026-11-20',
    agents: Object.fromEntries(LEGACY_AGENTS.map(([id]) => [id, { ordersCount: 0, startEquityUsd: 50, pnlUsd: 0 }])),
  }));
  // Markers so unrelated one-time migrations do not mutate the copied state.
  fs.writeFileSync(path.join(stateDir, 'instruments-v3-symbols.json'), JSON.stringify({ version: 1, at, assigned: 10 }));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    mode: 'sim',
    population: { initial: 30, cap: 60 },
    endowmentUsd: 50,
    // The live profile endowments are $50, so the child endowment must stay under 2x that.
    replication: { childEndowmentUsd: 25 },
    account: { allocationCapPct: 0.9 },
    ...overrides.config,
  }));
  const { config } = loadConfig({
    cwd: dir,
    env: {},
    configFile,
    overrides: {
      mode: 'sim',
      paths: { stateDir, envFile: path.join(dir, '.env') },
      rewards: { maxPerPeriodUsd: 100 },
      ...(overrides.overrides ?? {}),
    },
  });
  return { dir, stateDir, config, paths: statePaths(config) };
}

function legacyLedgerTotal() {
  let total = 370.82;
  for (const [, , , , cash] of LEGACY_AGENTS) total += cash;
  return Math.round(total * 100) / 100;
}

/** The exact sum `ledger.pool().totalUsd` returns for the legacy state (round2 per record). */
function legacyPoolTotal() {
  let allocated = 0;
  for (const [, , , , cash] of LEGACY_AGENTS) allocated += Math.round(cash * 100) / 100;
  return Math.round((Math.round(370.82 * 100) / 100 + Math.round(allocated * 100) / 100) * 100) / 100;
}

// ---------------------------------------------------------------------------
// L1. ledger fairness: capital vs trading P&L
// ---------------------------------------------------------------------------
describe('v3.3 ledger fairness: capital contributions are never trading P&L', () => {
  function makeLedger(dir, clock) {
    const { config } = loadConfig({
      cwd: dir,
      env: {},
      configFile: path.join(dir, 'no-such-config.json'),
      overrides: { mode: 'sim', paths: { stateDir: path.join(dir, 'state'), envFile: path.join(dir, '.env') } },
    });
    return createLedger({ paths: statePaths(config), config, clock });
  }

  it('genesis capital is counted once; a reward raises cash/capital/reward but not trading P&L', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-v33-ledger-'));
    createdDirs.push(dir);
    const clock = makeClock(T0);
    const ledger = makeLedger(dir, clock);
    ledger.ensureAgent('a1', { endowmentUsd: 5000, at: clock.now() });
    ledger.grant('a1', 5000, { reason: 'genesis-endowment', at: clock.now() });
    let view = ledger.equity('a1', {});
    assert.equal(view.cashUsd, 5000);
    assert.equal(view.capitalContributionsUsd, 5000, 'genesis endowment must not be counted twice');
    assert.equal(view.rewardCapitalUsd, 0);
    assert.equal(view.baseCapitalUsd, 5000);
    assert.equal(view.tradingPnlUsd, 0);

    ledger.ensureAgent('__treasury__', { endowmentUsd: 0 });
    ledger.grant('__treasury__', 10000, { reason: 'pool' });
    ledger.transfer('__treasury__', 'a1', 250, { reason: 'reward:2026-W44', category: 'reward', at: clock.now() });
    view = ledger.equity('a1', {});
    assert.equal(view.cashUsd, 5250);
    assert.equal(view.capitalContributionsUsd, 5250, 'reward payout is contributed capital');
    assert.equal(view.rewardCapitalUsd, 250, 'reward capital is tracked separately');
    assert.equal(view.baseCapitalUsd, 5000);
    assert.equal(view.tradingPnlUsd, 0, 'a reward must never be trading profit');
    // A /reward/i reason with no category is classified the same way (documented fallback).
    ledger.transfer('__treasury__', 'a1', 50, { reason: 'weekly reward 2026-W45', at: clock.now() });
    assert.equal(ledger.equity('a1', {}).rewardCapitalUsd, 300);
    assert.equal(ledger.equity('a1', {}).tradingPnlUsd, 0);
  });

  it('realized fill profit moves trading P&L only; the trading return is a fraction', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-v33-ledger-'));
    createdDirs.push(dir);
    const clock = makeClock(T0);
    const ledger = makeLedger(dir, clock);
    ledger.ensureAgent('a2', { endowmentUsd: 1000, at: clock.now() });
    ledger.grant('a2', 1000, { reason: 'genesis-endowment', at: clock.now() });
    ledger.applyFill('a2', { symbol: 'AAPL', side: 'buy', qty: 1, priceUsd: 100, at: clock.now() });
    ledger.applyFill('a2', { symbol: 'AAPL', side: 'sell', qty: 1, priceUsd: 110, at: clock.now() });
    const view = ledger.equity('a2', {});
    assert.equal(view.capitalContributionsUsd, 1000, 'fills never change capital');
    assert.equal(view.tradingPnlUsd, 10);
    assert.equal(view.tradingPnlPct, 0.01, 'tradingPnlPct is a FRACTION (0.01 = +1%)');
  });

  it('a treasury transfer out is a capital withdrawal, never trading P&L', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-v33-ledger-'));
    createdDirs.push(dir);
    const clock = makeClock(T0);
    const ledger = makeLedger(dir, clock);
    ledger.ensureAgent('a3', { endowmentUsd: 1000, at: clock.now() });
    ledger.grant('a3', 1000, { reason: 'genesis-endowment', at: clock.now() });
    ledger.ensureAgent('__treasury__', { endowmentUsd: 0 });
    ledger.applyFill('a3', { symbol: 'AAPL', side: 'buy', qty: 1, priceUsd: 100, at: clock.now() });
    ledger.applyFill('a3', { symbol: 'AAPL', side: 'sell', qty: 1, priceUsd: 110, at: clock.now() });
    ledger.transfer('a3', '__treasury__', 600, { reason: 'capital withdrawal', at: clock.now() });
    const view = ledger.equity('a3', {});
    assert.equal(view.capitalContributionsUsd, 400, 'withdrawal reduces capital');
    assert.equal(view.rewardCapitalUsd, 0);
    assert.equal(view.tradingPnlUsd, 10, 'withdrawal must not look like a trading loss');
  });

  it('setCapitalBasis is a reclassification: idempotent, no cash/P&L movement, later grants add capital', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-v33-ledger-'));
    createdDirs.push(dir);
    const clock = makeClock(T0);
    const ledger = makeLedger(dir, clock);
    ledger.ensureAgent('legacy', { endowmentUsd: 20, at: clock.now() });
    ledger.grant('legacy', 20, { reason: 'genesis-endowment' });
    const cashBefore = ledger.snapshot('legacy').cashUsd;
    ledger.setCapitalBasis('legacy', { baseCapitalUsd: 50, rewardCapitalUsd: 30, reason: 'v3.3 migration', at: clock.now() });
    const first = ledger.capitalOf('legacy');
    ledger.setCapitalBasis('legacy', { baseCapitalUsd: 50, rewardCapitalUsd: 30, reason: 'v3.3 migration', at: clock.now() });
    const second = ledger.capitalOf('legacy');
    assert.equal(first.capitalContributionsUsd, 80);
    assert.equal(first.rewardCapitalUsd, 30);
    assert.equal(first.baseCapitalUsd, 50);
    assert.equal(second.capitalContributionsUsd, 80, 'basis setter is idempotent');
    assert.equal(ledger.snapshot('legacy').cashUsd, cashBefore, 'a basis reclassification never moves cash');
    assert.equal(first.tradingPnlUsd, 20 - 80, 'trading P&L is measured against the migrated basis');
    ledger.grant('legacy', 10, { reason: 'top-up' });
    const after = ledger.capitalOf('legacy');
    assert.equal(after.capitalContributionsUsd, 90, 'a later grant adds capital to the migrated basis');
    assert.equal(after.rewardCapitalUsd, 30);
  });

  it('the treasury pool is conserved by reward payouts (money is moved, not created)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-v33-ledger-'));
    createdDirs.push(dir);
    const clock = makeClock(T0);
    const ledger = makeLedger(dir, clock);
    ledger.ensureAgent('__treasury__', { endowmentUsd: 0 });
    ledger.grant('__treasury__', 10000, { reason: 'pool-anchor' });
    ledger.ensureAgent('p1', { endowmentUsd: 5000, at: clock.now() });
    ledger.grant('p1', 5000, { reason: 'genesis-endowment', at: clock.now() });
    const before = ledger.pool();
    const treasuryBefore = ledger.snapshot('__treasury__').cashUsd;
    ledger.transfer('__treasury__', 'p1', 100, { reason: 'reward:2026-W44', category: 'reward', at: clock.now() });
    const after = ledger.pool();
    assert.equal(after.totalUsd, before.totalUsd, 'the virtual economy neither created nor destroyed money');
    assert.equal(ledger.snapshot('__treasury__').cashUsd, treasuryBefore - 100);
    assert.equal(ledger.snapshot('p1').cashUsd, 5100);
  });

  it('legacy persisted records without capital fields load with the documented fallback (version 1)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-v33-ledger-'));
    createdDirs.push(dir);
    const clock = makeClock(T0);
    const ledgerPath = path.join(dir, 'ledger.json');
    fs.writeFileSync(ledgerPath, JSON.stringify({
      version: 3, anchored: true, anchoredAt: null,
      agents: {
        'old-1': {
          agentId: 'old-1', cashUsd: 42.5, positions: {}, realizedPlUsd: 2.5, costsUsd: 0,
          costsByRole: {}, grossSpendUsd: 0, grossRevenueUsd: 0, creditsUsd: 7.5, trades: 3,
          firstProfitAt: null, declaredEndowmentUsd: 40, startedAt: T0,
          fills: [], events: [], markPrices: {}, lastUnrealizedUsd: 0,
          lastMarginDebtUsd: 0, lastGrossExposureUsd: 0, lastNetExposureUsd: 0,
        },
      },
    }));
    const { config } = loadConfig({
      cwd: dir, env: {}, configFile: path.join(dir, 'no-such-config.json'),
      overrides: { mode: 'sim', paths: { stateDir: dir, envFile: path.join(dir, '.env') } },
    });
    const legacyLedger = createLedger({ paths: { ledger: ledgerPath }, config, clock });
    await legacyLedger.load();
    const view = legacyLedger.snapshot('old-1');
    assert.equal(view.capitalContributionsUsd, 47.5, 'fallback = declaredEndowment + credits');
    assert.equal(view.rewardCapitalUsd, 0);
    assert.equal(view.capitalVersion, 1);
    assert.equal(view.tradingPnlUsd, -5, 'trading P&L is measured against the fallback basis');
    assert.equal(legacyLedger.hasCapitalAccounting('old-1'), false);
  });
});

// ---------------------------------------------------------------------------
// L2. migration: real-shaped v3.2 live state -> fair capital basis (idempotent)
// ---------------------------------------------------------------------------
describe('v3.3 migration: real-shaped v3.2 live state gets a fair capital basis (idempotent)', () => {
  it('migrates 30/30 legacy agents, classifies lifetime rewards and computes fair trading P&L', async () => {
    const world = writeLegacyV32State();
    const clock = makeClock(Date.UTC(2026, 10, 22, 15, 0, 0));
    const broker = createSimBroker(world.config, { seed: 7, accountEquityUsd: legacyLedgerTotal(), clock });
    const automaton = await createAutomaton({ config: world.config, paths: world.paths, broker, clock });
    await automaton.init();
    const { ledger, registry } = automaton._internals;

    const marker = readJsonFile(path.join(world.stateDir, 'capital-v33.json'));
    assert.equal(marker.version, 2);
    assert.equal(marker.migrated, 30, 'all 30 legacy agents migrated');
    assert.equal(round2(marker.lifetimeRewardsUsd), 129.18, 'W44+W45 lifetime rewards');

    assert.equal(registry.all().length, 30);
    for (const agent of registry.all()) {
      const capital = ledger.capitalOf(agent.id);
      assert.equal(capital.capitalVersion, 2, `${agent.id} capitalVersion 2`);
      assert.equal(capital.baseCapitalUsd, 50, `${agent.id} base = registry endowment ($50, the $20 ledger declared basis is not reused)`);
      assert.equal(capital.rewardCapitalUsd, REWARDED_LEGACY[agent.id] ?? 0, `${agent.id} reward capital`);
      assert.equal(capital.capitalContributionsUsd, round2(50 + (REWARDED_LEGACY[agent.id] ?? 0)));
    }
    // The live example from the contract: equity 106.86 - (50 + 58.56) = -1.70 fair trading P&L.
    const gap = ledger.equity('atm-483016bc', {});
    assert.equal(gap.equityUsd, 106.86);
    assert.equal(gap.capitalContributionsUsd, 108.56);
    assert.equal(gap.rewardCapitalUsd, 58.56);
    assert.equal(gap.baseCapitalUsd, 50);
    assert.equal(gap.tradingPnlUsd, -1.7);
    assert.equal(gap.tradingPnlPct, -0.0157, 'ledger trading return is a 4dp fraction');
    // Money and trade history are untouched: migration is a reclassification.
    for (const agent of registry.all()) {
      const raw = JSON.parse(fs.readFileSync(path.join(world.stateDir, 'ledger.json'), 'utf8')).agents[agent.id];
      const expected = LEGACY_AGENTS.find(([id]) => id === agent.id);
      assert.equal(raw.cashUsd, expected[4], `${agent.id} cash preserved`);
      assert.equal(raw.capitalVersion, 2, `${agent.id} persisted capitalVersion`);
    }
    const pool = ledger.pool();
    assert.equal(pool.totalUsd, legacyPoolTotal(), 'pool total is unchanged by the reclassification');

    // Status contract on the migrated state.
    const status = await automaton.status();
    const row = status.agents.find((agent) => agent.id === 'atm-483016bc');
    assert.equal(row.tradingPnlUsd, -1.7);
    assert.equal(row.capital.contributedUsd, 108.56);
    assert.equal(row.capital.baseUsd, 50);
    assert.equal(row.capital.rewardCapitalUsd, 58.56);
    assert.equal(row.capital.capitalVersion, 2);
    assert.equal(row.capital.rewardSharePct, Math.round((58.56 / 108.56) * 10000) / 100, 'rewardSharePct is percent points');
    assert.ok(Math.abs(row.capital.rewardSharePct) > 1, 'percent points, not a fraction');
    assert.equal(row.pnl.tradingUsd, -1.7);
    assert.equal(row.pnl.tradingPct, Math.round((-1.7 / 108.56) * 1000000) / 1000000, 'pnl.tradingPct is a fraction');
    assert.equal(row.pnl.rewardsUsd, 58.56);
    assert.equal(row.pnl.netUsd, -1.7, 'legacy netUsd alias now means trading P&L');
    assert.equal(row.rewards.lifetimeUsd, 58.56);
    assert.equal(row.rewards.count, 1);
    const historyRow = row.rewards.history[0];
    assert.equal(historyRow.periodKey, '2026-W44');
    assert.equal(historyRow.rank, 1);
    assert.equal(historyRow.amountUsd, 58.56);

    const accounting = status.engine.capitalAccounting;
    assert.equal(accounting.version, 2);
    assert.equal(accounting.rewardedAgents, 6);
    assert.equal(round2(accounting.rewardsLifetimeTotalUsd), 129.18);
    assert.equal(round2(status.engine.rewards.lifetimeTotalUsd), 129.18);
    assert.equal(status.engine.rewards.rules.basis, 'trading-performance');
    assert.deepEqual(status.engine.rewards.rules.rankShares, [0.5, 0.3, 0.2]);
    assert.equal(status.engine.rewards.rules.rewardBudgetPctOfPool, 0.1);
    assert.equal(status.engine.rewards.rules.minTrades, 3);
    assert.equal(status.engine.rewards.rules.minTradingProfitUsd, 0.05);
  });

  it('is idempotent: a second init (and a lost marker) never counts the basis or rewards twice', async () => {
    const world = writeLegacyV32State();
    const clock = makeClock(Date.UTC(2026, 10, 22, 15, 0, 0));
    const broker = createSimBroker(world.config, { seed: 7, accountEquityUsd: legacyLedgerTotal(), clock });
    const first = await createAutomaton({ config: world.config, paths: world.paths, broker, clock });
    await first.init();
    const markerAt = readJsonFile(path.join(world.stateDir, 'capital-v33.json')).at;

    const broker2 = createSimBroker(world.config, { seed: 7, accountEquityUsd: legacyLedgerTotal(), clock });
    const second = await createAutomaton({ config: world.config, paths: world.paths, broker: broker2, clock });
    await second.init();
    const view = second._internals.ledger.equity('atm-483016bc', {});
    assert.equal(view.capitalContributionsUsd, 108.56, 'no double count on restart');
    assert.equal(view.rewardCapitalUsd, 58.56);
    assert.equal(view.tradingPnlUsd, -1.7);
    const marker = readJsonFile(path.join(world.stateDir, 'capital-v33.json'));
    assert.equal(marker.at, markerAt, 'an idempotent restart leaves the marker untouched');
    const record = readJsonFile(path.join(world.stateDir, 'ledger.json')).agents['atm-483016bc'];
    assert.equal(record.events.filter((event) => event.kind === 'capital-basis').length, 1, 'one capital-basis event per agent');

    // Losing the marker file alone must NOT re-baseline: `capitalVersion` is the gate.
    fs.rmSync(path.join(world.stateDir, 'capital-v33.json'));
    const broker3 = createSimBroker(world.config, { seed: 7, accountEquityUsd: legacyLedgerTotal(), clock });
    const third = await createAutomaton({ config: world.config, paths: world.paths, broker: broker3, clock });
    await third.init();
    const thirdView = third._internals.ledger.equity('atm-483016bc', {});
    assert.equal(thirdView.capitalContributionsUsd, 108.56, 'a lost marker must not double count');
    assert.equal(thirdView.tradingPnlUsd, -1.7);
    const rewritten = readJsonFile(path.join(world.stateDir, 'capital-v33.json'));
    assert.equal(rewritten.version, 2);
    assert.equal(rewritten.migrated, 0, 'no agent needed re-migration');
  });
});

// ---------------------------------------------------------------------------
// L3. rankings + rewards rules (fair eligibility, shares, caps, archived payout)
// ---------------------------------------------------------------------------
describe('v3.3 rankings/rewards rules: trading baselines, eligibility, shares, caps, lifetime', () => {
  function makeRankings(dir, clock) {
    return createRankings({ paths: { rankings: path.join(dir, 'rankings.json') }, config: { paths: { stateDir: dir } }, clock });
  }
  function makeRewardsInstance(dir, clock, rewardsOverrides = {}) {
    return createRewards({
      paths: { rewardsFile: path.join(dir, 'rewards.json') },
      config: { paths: { stateDir: dir }, rewards: { maxPerPeriodUsd: 100, ...rewardsOverrides } },
      clock,
    });
  }
  function rewardRow(overrides = {}) {
    return {
      agentId: 'a', name: 'A', tradingPnlUsd: 10, baselineTradingPlUsd: 0, tradingPnlPct: 0.01,
      capitalUsd: 5000, baselineCapitalUsd: 5000, periodTrades: 5, ...overrides,
    };
  }
  function captureLedger() {
    const calls = [];
    const ledger = { transfer: async (from, to, amount, options) => { calls.push({ from, to, amount, options }); return {}; } };
    return { calls, ledger };
  }

  it('rankings track the period trading baseline, carry it forward and archive the completed period', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-v33-rank-'));
    createdDirs.push(dir);
    let now = Date.UTC(2026, 10, 16, 12, 0, 0); // Mon 2026-11-16 (2026-W47)
    const clock = { now: () => now, iso: () => new Date(now).toISOString() };
    const rankings = makeRankings(dir, clock);
    await rankings.load();
    await rankings.record({ atMs: now, equityByAgent: {
      a: { name: 'A', equityUsd: 5000, trades: 10, tradingPlUsd: 100, capitalUsd: 5000 },
      b: { name: 'B', equityUsd: 5000, trades: 20, tradingPlUsd: 0, capitalUsd: 5000 },
    } });
    now += 60_000;
    await rankings.record({ atMs: now, equityByAgent: {
      a: { name: 'A', equityUsd: 5200, trades: 14, tradingPlUsd: 200, capitalUsd: 5000 },
      b: { name: 'B', equityUsd: 4950, trades: 22, tradingPlUsd: -50, capitalUsd: 5000 },
    } });
    const row = rankings.compute({ atMs: now, stored: true }).periods.weekly.find((entry) => entry.agentId === 'a');
    assert.equal(row.tradingPnlUsd, 100);
    assert.equal(row.tradingPnlPct, 0.02, 'tradingPnlPct is a fraction');
    assert.equal(row.periodTrades, 4);
    assert.equal(row.baselineTradingPlUsd, 100);
    assert.equal(row.baselineCapitalUsd, 5000);
    // Roll into the next week: W47 is archived and must still rank for the rewards scheduler.
    now = Date.UTC(2026, 10, 23, 12, 0, 0); // Mon 2026-11-23 (2026-W48)
    await rankings.record({ atMs: now, equityByAgent: {
      a: { name: 'A', equityUsd: 5300, trades: 16, tradingPlUsd: 300, capitalUsd: 5100 },
      b: { name: 'B', equityUsd: 4900, trades: 24, tradingPlUsd: -100, capitalUsd: 5000 },
    } });
    const archived = rankings.compute({ atMs: Date.UTC(2026, 10, 22, 23, 0, 0), stored: true })
      .periods.weekly.find((entry) => entry.agentId === 'a');
    assert.equal(archived.tradingPnlUsd, 100, 'the completed period keeps its trading P&L');
    assert.equal(archived.tradingPnlPct, 0.02);
    assert.equal(archived.periodTrades, 4);
    const carried = rankings.compute({ atMs: now, stored: true }).periods.weekly.find((entry) => entry.agentId === 'a');
    assert.equal(carried.baselineTradingPlUsd, 200, 'the previous last observation is carried forward');
    assert.equal(carried.tradingPnlUsd, 100);
    // A legacy observation without trading fields must never fabricate a trading P&L.
    await rankings.record({ atMs: now + 60_000, equityByAgent: { legacy: { name: 'Legacy', equityUsd: 1000, trades: 5 } } });
    const legacy = rankings.compute({ atMs: now + 60_000, stored: true }).periods.weekly.find((entry) => entry.agentId === 'legacy');
    assert.equal(legacy.tradingPnlUsd, null);
    assert.equal(legacy.tradingPnlPct, null);
  });

  it('pays top-3 by period trading RETURN with 50/30/20 shares of a 10% pool budget', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-v33-rewards-'));
    createdDirs.push(dir);
    const clock = makeClock(Date.UTC(2026, 10, 18, 12, 0, 0));
    const rewards = makeRewardsInstance(dir, clock);
    await rewards.load();
    const { calls, ledger } = captureLedger();
    const result = await rewards.apply({
      due: { period: 'weekly', periodKey: '2026-W47', completed: true, currentPeriodKey: '2026-W48' },
      rankings: { periods: { weekly: [
        rewardRow({ agentId: 'a', name: 'A', tradingPnlUsd: 50, tradingPnlPct: 0.01 }),
        rewardRow({ agentId: 'b', name: 'B', tradingPnlUsd: 30, tradingPnlPct: 0.03 }), // best return
        rewardRow({ agentId: 'c', name: 'C', tradingPnlUsd: 40, tradingPnlPct: 0.02 }),
      ] } },
      poolUsd: 1000,
      ledger,
    });
    assert.equal(result.applied, true);
    assert.equal(result.budgetUsd, 100, 'budget = 10% of the pool');
    assert.deepEqual(result.winners.map((winner) => winner.agentId), ['b', 'c', 'a'], 'ranked by trading return');
    assert.deepEqual(result.winners.map((winner) => winner.amountUsd), [50, 30, 20]);
    assert.deepEqual(result.winners.map((winner) => winner.share), [0.5, 0.3, 0.2]);
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(call.from, '__treasury__');
      assert.equal(call.options.category, 'reward');
      assert.match(call.options.reason, /^reward:/);
    }
    assert.equal(rewards.lifetimeForAgent('b'), 50);
    assert.equal(rewards.status().lifetimeTotalUsd, 100);
    const history = rewards.historyForAgent('b');
    assert.equal(history.length, 1);
    assert.equal(history[0].periodTradingPnlPct, 0.03);
    assert.equal(history[0].periodTrades, 5);
  });

  it('rejects every ineligible candidate without moving money', async () => {
    const cases = [
      ['no_measured_trading_baseline', rewardRow({ tradingPnlUsd: null })],
      ['no_measured_trading_baseline', rewardRow({ baselineTradingPlUsd: null })],
      ['no_eligible_agents', rewardRow({ tradingPnlUsd: 0.01 })],
      ['no_eligible_agents', rewardRow({ tradingPnlPct: 0 })],
      ['no_eligible_agents', rewardRow({ periodTrades: 2 })],
      ['no_eligible_agents', rewardRow({ drawdownPct: 0.5 })],
    ];
    for (const [reason, candidate] of cases) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-v33-rewards-'));
      createdDirs.push(dir);
      const clock = makeClock(Date.UTC(2026, 10, 18, 12, 0, 0));
      const rewards = makeRewardsInstance(dir, clock);
      await rewards.load();
      const { calls, ledger } = captureLedger();
      const result = await rewards.apply({
        due: { period: 'weekly', periodKey: '2026-W47', completed: true, currentPeriodKey: '2026-W48' },
        rankings: { periods: { weekly: [candidate] } },
        poolUsd: 1000,
        ledger,
      });
      assert.equal(result.skipped, true, reason);
      assert.equal(result.applied, true, `${reason}: a skip is recorded`);
      assert.equal(result.eligibleCount, 0, reason);
      assert.equal(result.reason, reason, reason);
      assert.equal(calls.length, 0, `${reason}: no transfer`);
      assert.equal(result.winners.length, 0, reason);
    }
    // Explicit drawdown gate via the risk views (scalar or object form).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-v33-rewards-'));
    createdDirs.push(dir);
    const clock = makeClock(Date.UTC(2026, 10, 18, 12, 0, 0));
    const rewards = makeRewardsInstance(dir, clock);
    await rewards.load();
    const { calls, ledger } = captureLedger();
    const gated = await rewards.apply({
      due: { period: 'weekly', periodKey: '2026-W47', completed: true, currentPeriodKey: '2026-W48' },
      rankings: { periods: { weekly: [rewardRow({ drawdownPct: 0.01 })] } },
      poolUsd: 1000,
      riskByAgent: { a: 0.25 },
      ledger,
    });
    assert.equal(gated.eligibleCount, 0, 'riskByAgent drawdown above the 20% gate rejects');
    assert.equal(calls.length, 0);
  });

  it('caps the budget (allocation headroom, maxPerPeriod), the per-agent capital cap, and floors to cents', async () => {
    const clock = makeClock(Date.UTC(2026, 10, 18, 12, 0, 0));
    const cases = [
      // [overrides, applyOpts, expectedBudget, expectedAmounts]
      [{ maxPerPeriodUsd: null, rewardBudgetPctOfPool: 0.1 }, { poolUsd: 1000, allocationCapRemainingUsd: 12.34 }, 12.34, [6.17, 3.7, 2.46]],
      [{ maxPerPeriodUsd: 7.77 }, { poolUsd: 1000 }, 7.77, [3.88, 2.33, 1.55]],
    ];
    for (const [overrides, applyOpts, expectedBudget, expectedAmounts] of cases) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-v33-rewards-'));
      createdDirs.push(dir);
      const rewards = makeRewardsInstance(dir, clock, overrides);
      await rewards.load();
      const { calls, ledger } = captureLedger();
      const result = await rewards.apply({
        due: { period: 'weekly', periodKey: '2026-W47', completed: true, currentPeriodKey: '2026-W48' },
        rankings: { periods: { weekly: [
          rewardRow({ agentId: 'a', tradingPnlPct: 0.03 }),
          rewardRow({ agentId: 'b', tradingPnlPct: 0.02 }),
          rewardRow({ agentId: 'c', tradingPnlPct: 0.01 }),
        ] } },
        ledger,
        ...applyOpts,
      });
      assert.equal(result.budgetUsd, expectedBudget);
      assert.deepEqual(result.winners.map((winner) => winner.amountUsd), expectedAmounts);
      for (const winner of result.winners) assert.equal(winner.amountUsd, Math.floor(winner.amountUsd * 100) / 100, 'cents only');
      assert.ok(result.winners.reduce((sum, winner) => sum + winner.amountUsd, 0) <= result.budgetUsd);
      assert.equal(calls.length, result.winners.length);
    }
    // Per-agent cap: 50% of contributed capital, never above the rank share.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-v33-rewards-'));
    createdDirs.push(dir);
    const rewards = makeRewardsInstance(dir, clock);
    await rewards.load();
    const { ledger } = captureLedger();
    const capped = await rewards.apply({
      due: { period: 'weekly', periodKey: '2026-W47', completed: true, currentPeriodKey: '2026-W48' },
      rankings: { periods: { weekly: [
        rewardRow({ agentId: 'small', tradingPnlPct: 0.05, capitalUsd: 40, baselineCapitalUsd: 40 }), // cap 20
        rewardRow({ agentId: 'big', tradingPnlPct: 0.04, capitalUsd: 100000 }),
      ] } },
      poolUsd: 1000,
      ledger,
    });
    const small = capped.winners.find((winner) => winner.agentId === 'small');
    assert.equal(small.amountUsd, 20, 'single reward capped at 50% of contributed capital');
    assert.ok(small.amountUsd <= 40 * 0.5);
    const big = capped.winners.find((winner) => winner.agentId === 'big');
    assert.equal(big.amountUsd, 30, 'uncapped winner still gets its 30% share');
    // Over-allocating rank shares are scaled back to the budget.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-v33-rewards-'));
    createdDirs.push(dir2);
    const rewards2 = makeRewardsInstance(dir2, clock, { rankShares: [0.8, 0.8, 0.8] });
    await rewards2.load();
    const scaled = await rewards2.apply({
      due: { period: 'weekly', periodKey: '2026-W47', completed: true, currentPeriodKey: '2026-W48' },
      rankings: { periods: { weekly: [
        rewardRow({ agentId: 'a', tradingPnlPct: 0.03 }),
        rewardRow({ agentId: 'b', tradingPnlPct: 0.02 }),
        rewardRow({ agentId: 'c', tradingPnlPct: 0.01 }),
      ] } },
      poolUsd: 1000,
      ledger: captureLedger().ledger,
    });
    const paid = scaled.winners.reduce((sum, winner) => sum + winner.amountUsd, 0);
    assert.ok(paid <= scaled.budgetUsd, 'scaled shares never exceed the budget');
    assert.equal(paid, 99.99, 'floor to cents');
  });

  it('records skips, pays a period at most once, and never pays without a pool', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-v33-rewards-'));
    createdDirs.push(dir);
    const clock = makeClock(Date.UTC(2026, 10, 18, 12, 0, 0));
    const rewards = makeRewardsInstance(dir, clock);
    await rewards.load();
    const { calls, ledger } = captureLedger();
    const empty = await rewards.apply({
      due: { period: 'weekly', periodKey: '2026-W47', completed: true, currentPeriodKey: '2026-W48' },
      rankings: { periods: { weekly: [] } },
      poolUsd: 1000,
      ledger,
    });
    assert.equal(empty.skipped, true);
    assert.equal(empty.reason, 'no_candidates');
    assert.equal(calls.length, 0);

    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-v33-rewards-'));
    createdDirs.push(dir2);
    const rewards2 = makeRewardsInstance(dir2, clock);
    await rewards2.load();
    const noPool = await rewards2.apply({
      due: { period: 'weekly', periodKey: '2026-W47', completed: true, currentPeriodKey: '2026-W48' },
      rankings: { periods: { weekly: [rewardRow()] } },
      poolUsd: 0,
      ledger: captureLedger().ledger,
    });
    assert.equal(noPool.skipped, true);
    assert.equal(noPool.reason, 'no_budget');
    assert.equal(noPool.budgetUsd, 0);

    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-v33-rewards-'));
    createdDirs.push(dir3);
    const rewards3 = makeRewardsInstance(dir3, clock);
    await rewards3.load();
    const first = captureLedger();
    const applyArgs = {
      due: { period: 'weekly', periodKey: '2026-W47', completed: true, currentPeriodKey: '2026-W48' },
      rankings: { periods: { weekly: [rewardRow({ tradingPnlPct: 0.05 })] } },
      poolUsd: 1000,
    };
    const once = await rewards3.apply({ ...applyArgs, ledger: first.ledger });
    const replay = await rewards3.apply({ ...applyArgs, ledger: first.ledger });
    assert.equal(once.winners.length, 1);
    assert.equal(first.calls.length, 1);
    assert.equal(replay.applied, false, 'a completed period is payable once');
    assert.equal(replay.reason, 'already_applied');
    assert.equal(first.calls.length, 1, 'no duplicate transfer');
    assert.equal(rewards3.getState().history.filter((entry) => entry.periodKey === '2026-W47').length, 1);
  });

  it('resolves only the v3.3 reward settings (legacy account-cash names are mapped away)', () => {
    const resolved = resolveRewardSettings({ rewards: {
      basis: 'account-cash', rankPercents: [0.05, 0.03, 0.02], rankShares: [0.5, 0.3, 0.2],
      rewardBudgetPctOfPool: 0.25, maxRewardPerAgentPctOfCapital: 0.4,
      minTradingProfitUsd: 0.5, minTrades: 4, maxDrawdownPct: 0.15, maxPerPeriodUsd: 12,
    } });
    assert.equal(resolved.basis, 'trading-performance', 'account-cash can never be selected again');
    assert.deepEqual(resolved.rankShares, [0.5, 0.3, 0.2]);
    assert.equal(resolved.rewardBudgetPctOfPool, 0.25);
    assert.equal(resolved.maxRewardPerAgentPctOfCapital, 0.4);
    assert.equal(resolved.minTradingProfitUsd, 0.5);
    assert.equal(resolved.minTrades, 4);
    assert.equal(resolved.maxDrawdownPct, 0.15);
    assert.equal(resolved.maxPerPeriodUsd, 12);
    const legacyOnly = resolveRewardSettings({ rewards: { basis: 'account-cash', rankPercents: [0.05, 0.03, 0.02] } });
    assert.equal(legacyOnly.basis, 'trading-performance');
    assert.equal(legacyOnly.minTrades, 3, 'documented default');
    assert.equal(legacyOnly.rewardBudgetPctOfPool, 0.1, 'documented default');
  });
});

// ---------------------------------------------------------------------------
// L4. end-to-end: a reward becomes CAPITAL, never P&L (deterministic sim world)
// ---------------------------------------------------------------------------
describe('v3.3 end-to-end: rewards pay capital, not P&L (deterministic sim, no network)', () => {
  const world = {};

  before(async () => {
    const env = makeEnv({
      population: { initial: 3, cap: 6 },
      burn: { inferencePerCycleUsd: 0, dataPerCycleUsd: 0, hostingPerHourUsd: 0, committedMonthlyUsd: 0 },
      // Big cadence + explicit analysis stamps => the payout ticks cannot trade; burn is zero,
      // so trading P&L can only move through the ledger fills the test injects.
      cadence: { day: { intervalSec: 86400, timeframe: '1Min' }, swing: { intervalSec: 86400, timeframe: '1Hour' } },
      rewards: { maxPerPeriodUsd: 100 },
      // Large absolute order cap so the mandate size is the % of equity: reward capital then
      // visibly grows the order-sizing budget (buying power), while P&L stays trading-only.
      risk: { maxOrderNotionalUsd: 10000, maxOrderPctOfEquity: 0.5 },
    });
    const clock = makeClock(Date.UTC(2026, 10, 21, 2, 0, 0)); // Sat 02:00Z -> weekly 2026-W47
    const broker = createSimBroker(env.config, { seed: 7, accountEquityUsd: 100000, clock });
    world.env = env;
    world.clock = clock;
    world.broker = broker;
    world.automaton = await createAutomaton({ config: env.config, paths: env.paths, broker, clock });
    await world.automaton.init();
    world.internals = world.automaton._internals;
    world.ledger = world.internals.ledger;
    world.registry = world.internals.registry;
    world.agents = world.registry.alive();
    for (const agent of world.agents) world.internals.state.lastAnalysisAt.set(agent.id, clock.now());
    clock.advance(CYCLE_MS);
    world.tick1 = await world.automaton.tick();
    // Real trading results + trade counts through the ledger fill path (round trips at a profit).
    for (const [index, profit] of [[0, 111], [1, 61], [2, 31]]) {
      const agentId = world.agents[index].id;
      world.ledger.applyFill(agentId, { symbol: 'AAPL', side: 'buy', qty: profit / 10, priceUsd: 100, at: clock.now() });
      world.ledger.applyFill(agentId, { symbol: 'AAPL', side: 'sell', qty: profit / 10, priceUsd: 110, at: clock.now() });
    }
    for (const agent of world.agents) {
      world.ledger.applyFill(agent.id, { symbol: 'MSFT', side: 'buy', qty: 1, priceUsd: 50, at: clock.now() });
      world.ledger.applyFill(agent.id, { symbol: 'MSFT', side: 'sell', qty: 1, priceUsd: 50.5, at: clock.now() });
    }
    await world.ledger.save();
    clock.advance(CYCLE_MS);
    world.tick2 = await world.automaton.tick();
    world.weekRows = (await world.automaton.status()).rankings.periods.weekly;
    // Cross the weekly boundary; stamp analysis so the payout tick cannot trade.
    clock.set(Date.UTC(2026, 10, 23, 0, 1, 0)); // Mon 2026-11-23 -> 2026-W48
    for (const agent of world.agents) world.internals.state.lastAnalysisAt.set(agent.id, clock.now());
    world.before = world.agents.map((agent) => ({
      id: agent.id,
      equity: world.ledger.equity(agent.id, {}),
      capital: world.ledger.capitalOf(agent.id),
    }));
    world.poolBefore = world.ledger.pool();
    world.tick3 = await world.automaton.tick();
    world.payout = world.tick3.rewards;
    world.after = world.agents.map((agent) => ({
      id: agent.id,
      equity: world.ledger.equity(agent.id, {}),
      capital: world.ledger.capitalOf(agent.id),
    }));
    world.poolAfter = world.ledger.pool();
    // Treasury mandate sizing: tick3 saw the pre-payout equities; tick4 prices the reward capital.
    world.mandatesBefore = structuredClone(world.internals.state.lastTreasury?.mandates ?? {});
    world.mandateViewsBefore = structuredClone(world.internals.state.lastTreasury?.agentViews ?? []);
    clock.advance(CYCLE_MS);
    for (const agent of world.agents) world.internals.state.lastAnalysisAt.set(agent.id, clock.now());
    world.tick4 = await world.automaton.tick();
    world.mandatesAfter = structuredClone(world.internals.state.lastTreasury?.mandates ?? {});
    world.mandateViewsAfter = structuredClone(world.internals.state.lastTreasury?.agentViews ?? []);
    // A small trading loss AFTER the payout gives the market view a non-zero daily P&L, which is
    // what makes the UI percent-scale regression meaningful (a fraction, never 100x).
    world.ledger.applyFill(world.agents[0].id, { symbol: 'AAPL', side: 'buy', qty: 2, priceUsd: 100, at: clock.now() });
    world.ledger.applyFill(world.agents[0].id, { symbol: 'AAPL', side: 'sell', qty: 2, priceUsd: 90, at: clock.now() });
    await world.ledger.save();
    clock.advance(CYCLE_MS);
    for (const agent of world.agents) world.internals.state.lastAnalysisAt.set(agent.id, clock.now());
    world.tick5 = await world.automaton.tick();
    world.final = world.agents.map((agent) => ({
      id: agent.id,
      equity: world.ledger.equity(agent.id, {}),
      capital: world.ledger.capitalOf(agent.id),
    }));
    world.rewardsState = createRewards({ paths: env.paths, config: env.config, clock });
    await world.rewardsState.load();
    world.status = await world.automaton.status();
  });

  it('measures a trading baseline first and never rewards an unmeasured period', () => {
    assert.equal(world.tick1.rewards?.due, false, 'the first cycle anchors the period, it cannot pay');
    assert.equal((world.tick1.rewards?.winners?.length ?? 0), 0);
    assert.equal(world.weekRows.length, 3);
    for (const row of world.weekRows) {
      assert.ok(row.tradingPnlUsd > 30, `measured period trading P&L, got ${row.tradingPnlUsd}`);
      assert.ok(row.tradingPnlPct > 0 && row.tradingPnlPct < 0.1, `fraction return, got ${row.tradingPnlPct}`);
      assert.equal(row.periodTrades, 4, 'period trades are measured');
      assert.equal(row.baselineTradingPlUsd, 0);
      assert.equal(row.baselineCapitalUsd, 5000);
    }
    assert.deepEqual(world.weekRows.map((row) => row.agentId), world.agents.map((agent) => agent.id), 'ranked by trading return');
  });

  it('pays the top-3 50/30/20 of the $100 budget as reward capital on a new period', () => {
    assert.equal(world.payout.periodKey, '2026-W47');
    assert.equal(world.payout.basis, 'trading-performance');
    assert.equal(world.payout.budgetUsd, 100);
    assert.deepEqual(world.payout.winners.map((winner) => winner.amountUsd), [50, 30, 20]);
    assert.deepEqual(world.payout.winners.map((winner) => winner.agentId), world.agents.map((agent) => agent.id));
    assert.deepEqual(world.payout.winners.map((winner) => winner.share), [0.5, 0.3, 0.2]);
    for (const winner of world.payout.winners) {
      assert.equal(winner.capitalUsd, 5000);
      assert.ok(winner.periodTradingPnlUsd > 0 && winner.periodTradingPnlUsd < 200);
      assert.ok(winner.periodTradingPnlPct > 0);
      assert.equal(winner.periodTrades, 4);
    }
  });

  it('increases equity and contributed/reward capital by the payout while trading P&L stays EXACTLY unchanged', () => {
    for (let index = 0; index < world.agents.length; index += 1) {
      const before = world.before[index];
      const after = world.after[index];
      const amount = world.payout.winners[index].amountUsd;
      assert.equal(after.capital.capitalContributionsUsd, before.capital.capitalContributionsUsd + amount, 'capital contribution');
      assert.equal(after.capital.rewardCapitalUsd, before.capital.rewardCapitalUsd + amount, 'reward capital');
      assert.equal(after.capital.baseCapitalUsd, before.capital.baseCapitalUsd, 'base capital unchanged');
      assert.equal(after.equity.equityUsd, before.equity.equityUsd + amount, 'total equity rises by the capital');
      assert.equal(after.equity.tradingPnlUsd, before.equity.tradingPnlUsd, 'trading P&L must NOT change');
      assert.equal(after.equity.equityUsd - after.equity.capitalContributionsUsd, after.equity.tradingPnlUsd, 'fair identity');
    }
    const executed = world.tick3.executions.reduce((sum, entry) => sum + (entry.orders ?? 0), 0);
    assert.equal(executed, 0, 'the payout tick placed no order (isolated reward effect)');
  });

  it('reward capital raises buying power and the mandate/order-size budget, never measured P&L', () => {
    for (let index = 0; index < world.agents.length; index += 1) {
      const agentId = world.agents[index].id;
      const amount = world.payout.winners[index].amountUsd;
      const viewBefore = world.mandateViewsBefore.find((view) => view.agentId === agentId);
      const viewAfter = world.mandateViewsAfter.find((view) => view.agentId === agentId);
      assert.ok(viewBefore && viewAfter, 'treasury priced the agent');
      assert.equal(round2(viewAfter.equityUsd - viewBefore.equityUsd), amount, 'the reward raises buying power by its amount');
      const mandateBefore = world.mandatesBefore[agentId];
      const mandateAfter = world.mandatesAfter[agentId];
      assert.ok(mandateBefore && mandateAfter, 'mandate issued');
      assert.ok(mandateAfter.sizeBudgetUsd > mandateBefore.sizeBudgetUsd, 'mandate/order sizing can grow with reward capital');
      assert.equal(round2(mandateAfter.sizeBudgetUsd - mandateBefore.sizeBudgetUsd), round2(amount * 0.5), 'size follows the % of equity');
      assert.equal(mandateAfter.sizeBudgetUsd, round2(0.5 * viewAfter.equityUsd), 'size budget = 50% of post-reward equity');
    }
  });

  it('conserves the treasury pool and never pays the same period twice', () => {
    assert.equal(world.poolAfter.totalUsd, world.poolBefore.totalUsd, 'money moved, not created');
    assert.equal(world.poolAfter.poolUsd, round2(world.poolBefore.poolUsd - 100), 'unallocated pool paid out');
    assert.equal(world.tick4.rewards?.due, false, 'the next tick in the new period does not pay');
    assert.equal(world.tick4.rewards?.winners?.length ?? 0, 0);
  });

  it('persists reward history/lifetime and refuses a replayed payout', async () => {
    const stateRewards = world.rewardsState.getState();
    const entry = stateRewards.history.find((item) => item.periodKey === '2026-W47');
    assert.ok(entry);
    assert.equal(entry.budgetUsd, 100);
    assert.equal(entry.basis, 'trading-performance');
    assert.equal(entry.winners.length, 3);
    assert.equal(entry.winners[0].share, 0.5);
    assert.ok(entry.winners[0].periodTradingPnlPct > 0);
    assert.equal(entry.winners[0].periodTrades, 4);
    assert.equal(world.rewardsState.lifetimeForAgent(world.agents[0].id), 50);
    assert.equal(world.rewardsState.lifetimeForAgent(world.agents[1].id), 30);
    assert.equal(world.rewardsState.lifetimeForAgent(world.agents[2].id), 20);
    assert.equal(world.rewardsState.status().lifetimeTotalUsd, 100);
    const replay = await world.rewardsState.apply({
      due: { period: 'weekly', periodKey: '2026-W47', completed: true, currentPeriodKey: '2026-W48' },
      rankings: { periods: { weekly: [] } },
      poolUsd: 1000,
      ledger: world.ledger,
    });
    assert.equal(replay.applied, false);
    assert.equal(replay.reason, 'already_applied');
    assert.equal(world.rewardsState.getState().history.filter((item) => item.periodKey === '2026-W47').length, 1);
  });

  it('exposes the v3.3 status contract with consistent percent scales', () => {
    const status = world.status;
    assert.equal(status.engine.capitalAccounting.version, 2);
    assert.equal(status.engine.capitalAccounting.rewardedAgents, 3);
    assert.equal(round2(status.engine.capitalAccounting.rewardsLifetimeTotalUsd), 100);
    assert.equal(status.engine.rewards.rules.basis, 'trading-performance');
    assert.deepEqual(status.engine.rewards.rules.rankShares, [0.5, 0.3, 0.2]);
    assert.ok(Array.isArray(status.engine.rewards.rules.explain) && status.engine.rewards.rules.explain.length >= 4);
    assert.equal(status.engine.rewards.budgetUsd, 100, 'next-period budget preview (maxPerPeriodUsd cap)');
    assert.equal(round2(status.engine.rewards.lifetimeTotalUsd), 100);
    assert.equal(status.engine.rewards.history.length, 1);
    for (let index = 0; index < world.agents.length; index += 1) {
      const amount = world.payout.winners[index].amountUsd;
      const row = status.agents.find((agent) => agent.id === world.agents[index].id);
      assert.equal(row.capital.contributedUsd, 5000 + amount);
      assert.equal(row.capital.baseUsd, 5000);
      assert.equal(row.capital.rewardCapitalUsd, amount);
      assert.equal(row.capital.capitalVersion, 2);
      assert.equal(row.capital.rewardSharePct, Math.round((amount / (5000 + amount)) * 10000) / 100, 'rewardSharePct = percent points');
      assert.ok(row.capital.rewardSharePct > 0 && row.capital.rewardSharePct <= 100);
      assert.equal(row.rewards.lifetimeUsd, amount);
      assert.equal(row.rewards.count, 1);
      assert.equal(row.rewards.history.length, 1);
      assert.equal(row.rewards.history[0].periodKey, '2026-W47');
      assert.equal(row.rewards.history[0].amountUsd, amount);
      assert.equal(row.tradingPnlUsd, world.final[index].equity.tradingPnlUsd);
      assert.equal(row.pnl.tradingUsd, row.tradingPnlUsd);
      assert.equal(row.pnl.tradingPct, row.tradingPnlPct);
      assert.equal(row.tradingPnlPct, Math.round((row.tradingPnlUsd / world.final[index].capital.capitalContributionsUsd) * 1000000) / 1000000, 'fraction');
      assert.ok(Math.abs(row.tradingPnlPct) < 1, 'tradingPnlPct must be a fraction');
      assert.equal(row.pnl.netUsd, row.tradingPnlUsd, 'legacy netUsd alias means trading P&L');
      assert.equal(row.pnl.rewardsUsd, amount);
    }
  });

  it('serves status and marketView for a stopped (never trading) engine without a 100x percent bug', async () => {
    const status = await world.automaton.status();
    assert.equal(status.engine.running, false);
    const stoppedEngine = createEngine({
      cwd: world.env.dir,
      envFile: path.join(world.env.dir, '.env'),
      clock: world.clock,
      overrides: { stateDir: world.env.paths.stateDir, mode: 'sim', accountEquityUsd: 100000 },
    });
    const engineStatus = await stoppedEngine.status();
    assert.equal(engineStatus.engine.running, false);
    assert.equal(engineStatus.engine.capitalAccounting.version, 2);
    assert.equal(engineStatus.engine.rewards.rules.basis, 'trading-performance');
    const view = await stoppedEngine.marketView();
    assert.equal(view.ok, true);
    const portfolio = view.portfolio;
    assert.equal(typeof portfolio.tradingDayPnlUsd, 'number');
    assert.equal(portfolio.dayPnlUsd, portfolio.tradingDayPnlUsd, 'fair trading alias');
    assert.equal(portfolio.dayPnlPct, portfolio.tradingDayPnlPct, 'fair trading alias');
    assert.ok(Math.abs(portfolio.tradingDayPnlPct) < 1, `portfolio tradingDayPnlPct must be a FRACTION, got ${portfolio.tradingDayPnlPct}`);
    const totalCapital = view.agents.reduce((sum, agent) => sum + (Number(agent.capitalUsd) || 0), 0);
    assert.ok(totalCapital > 0);
    assert.equal(
      portfolio.tradingDayPnlPct,
      Math.round((portfolio.tradingDayPnlUsd / totalCapital) * 1000000) / 1000000,
      'portfolio pct = trading day P&L / contributed capital (fraction)',
    );
    const dayUsdSum = view.agents.reduce((sum, agent) => sum + (Number(agent.tradingDayPnlUsd) || 0), 0);
    assert.equal(portfolio.tradingDayPnlUsd, round2(dayUsdSum), 'portfolio day P&L is the per-agent trading sum');
  });
});

// ---------------------------------------------------------------------------
// L5. daily loss is measured on trading P&L only (reward/withdrawal cannot look like P&L)
// ---------------------------------------------------------------------------
describe('v3.3 daily loss uses trading P&L, not equity or capital moves', () => {
  const world = {};

  before(async () => {
    const env = makeEnv({
      population: { initial: 3, cap: 6 },
      burn: { inferencePerCycleUsd: 0, dataPerCycleUsd: 0, hostingPerHourUsd: 0, committedMonthlyUsd: 0 },
      cadence: { day: { intervalSec: 86400, timeframe: '1Min' }, swing: { intervalSec: 86400, timeframe: '1Hour' } },
      // 0.1% of day-start equity = $5: a -$50 trading loss is fatal, a -$500 CAPITAL move is not.
      risk: { maxDailyLossPct: 0.001 },
    });
    const clock = makeClock(Date.UTC(2026, 10, 21, 2, 0, 0));
    const broker = createSimBroker(env.config, { seed: 7, accountEquityUsd: 100000, clock });
    world.env = env;
    world.clock = clock;
    world.automaton = await createAutomaton({ config: env.config, paths: env.paths, broker, clock });
    await world.automaton.init();
    world.internals = world.automaton._internals;
    world.ledger = world.internals.ledger;
    world.registry = world.internals.registry;
    world.agents = world.registry.alive();
    for (const agent of world.agents) world.internals.state.lastAnalysisAt.set(agent.id, clock.now());
    clock.advance(CYCLE_MS);
    await world.automaton.tick();
    world.day0 = readJsonFile(env.paths.dayStats).agents[world.agents[0].id];
    // A reward payout raises equity by $500 but not trading P&L -> no daily gain/loss.
    world.ledger.transfer('__treasury__', world.agents[0].id, 500, { reason: 'reward:2026-W47', category: 'reward', at: clock.now() });
    await world.ledger.save();
    clock.advance(CYCLE_MS);
    for (const agent of world.agents) world.internals.state.lastAnalysisAt.set(agent.id, clock.now());
    world.rewardTick = await world.automaton.tick();
    world.day1 = readJsonFile(env.paths.dayStats).agents[world.agents[0].id];
    // A capital WITHDRAWAL drops equity by $500 (equity-based daily loss would be -$500 = fatal at
    // a 0.1% cap) but trading P&L is unchanged -> must NOT trigger the rule.
    world.ledger.transfer(world.agents[0].id, '__treasury__', 500, { reason: 'capital withdrawal', at: clock.now() });
    await world.ledger.save();
    clock.advance(CYCLE_MS);
    for (const agent of world.agents) world.internals.state.lastAnalysisAt.set(agent.id, clock.now());
    world.withdrawTick = await world.automaton.tick();
    world.day2 = readJsonFile(env.paths.dayStats).agents[world.agents[0].id];
    // A real -$50 trading loss IS a daily loss and must produce the daily_loss_limit verdict.
    const loser = world.agents[1].id;
    world.ledger.applyFill(loser, { symbol: 'AAPL', side: 'buy', qty: 10, priceUsd: 100, at: clock.now() });
    world.ledger.applyFill(loser, { symbol: 'AAPL', side: 'sell', qty: 10, priceUsd: 95, at: clock.now() });
    await world.ledger.save();
    clock.advance(CYCLE_MS);
    for (const agent of world.agents) world.internals.state.lastAnalysisAt.set(agent.id, clock.now());
    world.lossTick = await world.automaton.tick();
    world.day3 = readJsonFile(env.paths.dayStats).agents[loser];
    // The sim demo reaper executes the verdict on the next cycle from the persisted day record.
    clock.advance(CYCLE_MS);
    for (const agent of world.agents) world.internals.state.lastAnalysisAt.set(agent.id, clock.now());
    world.executeTick = await world.automaton.tick();
    world.journal = createJournal({ paths: env.paths, config: env.config });
  });

  it('a reward payout does not look like a daily gain (day P&L unchanged, trading baseline kept)', () => {
    assert.equal(world.day0.pnlUsd, 0);
    assert.equal(world.rewardTick.deaths.filter((death) => death.agentId === world.agents[0].id).length, 0);
    assert.equal(world.registry.get(world.agents[0].id).status, 'alive');
    assert.equal(world.day1.startTradingPlUsd, world.day0.startTradingPlUsd);
    assert.equal(world.day1.pnlUsd, world.day0.pnlUsd, 'reward capital must not be counted as daily profit or loss');
    assert.ok('startTradingPlUsd' in world.day1, 'day-stats persist the trading baseline');
  });

  it('a capital withdrawal does not look like a daily loss', () => {
    assert.equal(world.withdrawTick.deaths.filter((death) => death.agentId === world.agents[0].id).length, 0, 'no daily_loss_limit for moving capital out');
    assert.equal(world.registry.get(world.agents[0].id).status, 'alive');
    assert.equal(world.day2.pnlUsd, world.day1.pnlUsd);
    assert.equal(world.day2.startTradingPlUsd, world.day1.startTradingPlUsd);
  });

  it('a real trading loss reaches the daily-loss rule (daily_loss_limit verdict)', async () => {
    assert.equal(round2(world.day3.pnlUsd), -50, 'the persisted day P&L is the trading loss');
    const verdict = world.lossTick.deaths.find((death) => death.agentId === world.agents[1].id);
    assert.ok(verdict, 'daily-loss verdict must fire on a trading loss');
    assert.equal(verdict.cause, 'daily_loss_limit');
    assert.equal(world.registry.get(world.agents[1].id).status, 'dead', 'the demo Reaper executed the verdict');
    const obituaries = await world.journal.list({ limit: 5 });
    assert.equal(obituaries.length, 1, 'one obituary');
    assert.equal(obituaries[0].agentId, world.agents[1].id);
    assert.equal(obituaries[0].cause, 'daily_loss_limit');
    assert.ok(world.executeTick.deathsExecuted?.some((entry) => entry.agentId === world.agents[1].id));
  });
});

// ===========================================================================
// v3.4 part 1 — reconciliation costs allowance (docs/AGGRESSIVE-GROWTH.md §0)
// The live paper account never pays virtual metabolism costs, so reconciliation
// must expect them back — without minting capital and without hiding fill gaps.
// ===========================================================================

/** Fake broker for deterministic Treasury worlds: fixed equity + test-only equity offset. */
function v34FakeBroker({ equityUsd = 100000 } = {}) {
  const state = { equityUsd: round2(equityUsd), offsetUsd: 0 };
  return {
    state,
    setEquityOffset(value) {
      state.offsetUsd = Number(value) || 0;
    },
    async getAccount() {
      const equity = round2(state.equityUsd + state.offsetUsd);
      return {
        equityUsd: equity,
        cashUsd: equity,
        buyingPowerUsd: equity,
        status: 'ACTIVE',
        currency: 'USD',
        marginMultiplier: 1,
        shortingEnabled: false,
        optionsTradingLevel: 3,
      };
    },
    async getPositions() {
      return [];
    },
    async getClock() {
      return { isOpen: true, timestamp: T0, nextOpen: null, nextClose: T0 + 6 * 60 * 60 * 1000 };
    },
    async getBars() {
      return {};
    },
    async getLatestQuote() {
      return null;
    },
    async submitOrder() {
      throw new Error('the v3.4 reconciliation world must never trade');
    },
    async getOrders() {
      return [];
    },
  };
}

/** Sim-mode automaton over a data-less fake broker: no hypotheses, no orders, only metabolism. */
async function v34ReconWorld(overrides = {}) {
  const env = makeEnv({
    population: { initial: 2, cap: 4 },
    endowmentUsd: 5000,
    // Tight tolerance so a few dollars of drift is a real halt in these tests.
    account: { reconciliationTolerancePct: 0.000001 },
    ...overrides,
  });
  const clock = makeClock(T0);
  const broker = v34FakeBroker();
  const automaton = await createAutomaton({ config: env.config, paths: env.paths, broker, clock });
  await automaton.init();
  return {
    env,
    config: env.config,
    paths: env.paths,
    clock,
    broker,
    automaton,
    ledger: automaton._internals.ledger,
    registry: automaton._internals.registry,
  };
}

function v34Treasury(world) {
  return world.automaton._internals.state.lastTreasury;
}

function v34WriteGrowthMarker(world, marker) {
  fs.writeFileSync(path.join(world.paths.stateDir, 'growth-v34.json'), JSON.stringify(marker), 'utf8');
}

describe('v3.4 reconciliation: virtual metabolism costs are an allowance, not capital', () => {
  it('cumulative virtual costs since the anchor clear the halt with no capital/cap effect', async () => {
    const world = await v34ReconWorld();
    // First tick anchors the virtual ledger to broker equity (the one-time anchor).
    await world.automaton.tick();
    assert.equal(v34Treasury(world).halted, false, 'the anchored first tick must be clean');
    const agent = world.registry.alive()[0];
    const capitalBefore = world.ledger.snapshot(agent.id).capitalContributionsUsd;
    const rewardCapitalBefore = world.ledger.snapshot(agent.id).rewardCapitalUsd;
    const endowmentBefore = world.registry.get(agent.id).endowmentUsd;
    const poolBefore = world.ledger.pool().poolUsd;

    // A week of virtual metabolism costs, booked after the anchor (the live-state failure mode).
    const virtualCostUsd = 5;
    world.ledger.charge(agent.id, virtualCostUsd, { category: 'hosting', role: 'hosting', at: world.clock.now() });
    // The engine re-syncs ledger/registry from disk at the start of every tick, so persist the charge.
    await world.ledger.save();
    world.clock.advance(CYCLE_MS);
    const tick = await world.automaton.tick();
    const treasury = v34Treasury(world);
    const reconciliation = treasury.reconciliation;

    assert.equal(tick.treasury.halted, false, `halted: ${JSON.stringify(tick.treasury.haltReasons)}`);
    assert.equal(reconciliation.ok, true);
    assert.ok(Math.abs(reconciliation.deltaUsd) <= reconciliation.toleranceUsd,
      `delta ${reconciliation.deltaUsd} must be inside tolerance ${reconciliation.toleranceUsd}`);
    assert.ok(reconciliation.costsSinceAnchorUsd >= virtualCostUsd,
      `costsSinceAnchor ${reconciliation.costsSinceAnchorUsd} must include the booked $${virtualCostUsd}`);
    // Pre-fix expectation (allocated + pool) is short by ~the costs: that WAS the permanent halt.
    const preFixDelta = round2(treasury.account.equityUsd - (treasury.allocatedUsd + treasury.poolUsd));
    assert.ok(preFixDelta > reconciliation.toleranceUsd,
      `pre-fix delta ${preFixDelta} must have exceeded the tolerance (a halt before v3.4)`);
    // The allowance is reconciliation-only: no capital, no cash, no reward classification.
    assert.equal(world.ledger.snapshot(agent.id).capitalContributionsUsd, capitalBefore);
    assert.equal(world.ledger.snapshot(agent.id).rewardCapitalUsd, rewardCapitalBefore);
    assert.equal(world.registry.get(agent.id).endowmentUsd, endowmentBefore);
    assert.equal(world.ledger.pool().poolUsd, poolBefore);
    // Conservation: broker equity = allocated + pool + virtual costs + residual delta.
    assert.equal(
      round2(treasury.account.equityUsd),
      round2(treasury.allocatedUsd + treasury.poolUsd + reconciliation.costsSinceAnchorUsd + reconciliation.deltaUsd),
      'reconciliation identity must be exact after the allowance',
    );
    assert.equal(reconciliation.virtualTotalUsd, round2(treasury.allocatedUsd + treasury.poolUsd + reconciliation.costsSinceAnchorUsd));
  });

  it('a genuine unbooked fill mismatch beyond tolerance still halts, in both directions', async () => {
    const world = await v34ReconWorld();
    await world.automaton.tick(); // anchor
    // Costs are already covered by the allowance; now the broker disagrees by a real fill amount.
    world.ledger.charge(world.registry.alive()[0].id, 5, { category: 'inference', role: 'executor', at: world.clock.now() });
    await world.ledger.save();

    world.broker.setEquityOffset(5);
    world.clock.advance(CYCLE_MS);
    await world.automaton.tick();
    const positive = v34Treasury(world);
    assert.equal(positive.halted, true, 'a +$5 unbooked fill must halt the engine');
    assert.ok(positive.haltReasons.includes('reconciliation_mismatch'));
    assert.ok(Math.abs(positive.reconciliation.deltaUsd - 5) < 0.05,
      `delta ${positive.reconciliation.deltaUsd} must expose the +$5 fill`);
    assert.ok(positive.reconciliation.costsSinceAnchorUsd >= 5, 'the +$5 cost allowance must not mask it');

    world.broker.setEquityOffset(-5);
    world.clock.advance(CYCLE_MS);
    await world.automaton.tick();
    const negative = v34Treasury(world);
    assert.equal(negative.halted, true, 'a -$5 unbooked fill must halt the engine too');
    assert.ok(negative.haltReasons.includes('reconciliation_mismatch'));
    assert.ok(Math.abs(negative.reconciliation.deltaUsd + 5) < 0.05,
      `delta ${negative.reconciliation.deltaUsd} must expose the -$5 fill`);

    // Sub-tolerance noise still passes (the allowance is symmetric, not one-sided).
    world.broker.setEquityOffset(0.02);
    world.clock.advance(CYCLE_MS);
    await world.automaton.tick();
    const noise = v34Treasury(world);
    assert.equal(noise.halted, false, `$${noise.reconciliation.deltaUsd} is inside tolerance`);
    assert.equal(noise.reconciliation.ok, true);
  });

  it('the allowance never lifts the allocation-cap wall (no cap inflation)', async () => {
    // Treasurer-level world (no engine tick re-sync): two funded agents against a $1 allocation cap.
    const env = makeEnv({
      population: { initial: 0, cap: 4 },
      endowmentUsd: 5000,
      account: { reconciliationTolerancePct: 0.000001, allocationCapPct: 0.00001 },
    });
    const clock = makeClock(T0);
    const broker = v34FakeBroker();
    const registry = createRegistry({ paths: env.paths, config: env.config, clock });
    const ledger = createLedger({ paths: env.paths, config: env.config, clock });
    const ids = ['atm-cap-1', 'atm-cap-2'];
    for (const id of ids) {
      await registry.register({ id, generation: 0, bornAt: clock.iso(), status: 'alive', endowmentUsd: 5000, genome: { symbol: 'AAPL', family: 'momentum' } });
      ledger.ensureAgent(id, { endowmentUsd: 5000, at: clock.iso() });
      ledger.grant(id, 5000, { reason: 'genesis-endowment', at: clock.iso() });
    }
    const treasurer = createTreasurer({
      broker,
      ledger,
      registry,
      journal: createJournal({ paths: env.paths, config: env.config }),
      config: env.config,
      paths: env.paths,
      clock,
    });
    await treasurer.tick({ prices: {} }); // one-time anchor
    // Virtual costs booked after the anchor are allowed back for reconciliation...
    ledger.charge(ids[0], 5, { category: 'research', role: 'research', at: clock.now() });
    const treasury = await treasurer.tick({ prices: {} });
    // ...but the allocation cap is measured on allocated equity and is not relaxed by the allowance.
    assert.equal(treasury.reconciliation.ok, true, JSON.stringify(treasury.reconciliation));
    assert.equal(treasury.halted, true);
    assert.deepEqual(treasury.haltReasons, ['allocation_cap'], JSON.stringify(treasury.haltReasons));
    assert.ok(treasury.allocatedUsd > round2(treasury.account.equityUsd * 0.00001),
      'allocated capital must not be reduced by the costs allowance');
    assert.equal(treasury.reconciliation.costsSinceAnchorUsd, 5);
    assert.equal(ledger.snapshot(ids[0]).capitalContributionsUsd, 5000, 'no capital minted');
  });

  it('anchored legacy ledgers normalise the missing baseline to 0; the anchor captures the baseline', () => {
    const env = makeEnv({ population: { initial: 0, cap: 2 } });
    const clock = makeClock(T0);
    const ledger = createLedger({ paths: env.paths, config: env.config, clock });
    ledger.ensureAgent('atm-anchor', { endowmentUsd: 5000, at: clock.iso() });
    ledger.grant('atm-anchor', 5000, { reason: 'genesis-endowment', at: clock.iso() });
    ledger.charge('atm-anchor', 2, { category: 'inference', role: 'executor', at: clock.iso() });
    const anchor = ledger.anchorToBrokerEquity(5000);
    assert.equal(anchor.anchored, true);
    assert.equal(anchor.anchorCostsUsd, 2, 'the anchor captures costs booked before it');
    assert.equal(ledger.costsSinceAnchor(), 0, 'only post-anchor costs explain broker drift');
    ledger.charge('atm-anchor', 0.3, { category: 'data', role: 'prospector', at: clock.iso() });
    assert.equal(ledger.costsSinceAnchor(), 0.3);
    // Re-anchoring is a no-op and keeps the captured baseline.
    const again = ledger.anchorToBrokerEquity(4000);
    assert.equal(again.anchored, false);
    assert.equal(again.anchorCostsUsd, 2);

    ledger.save();
    const reloaded = createLedger({ paths: env.paths, config: env.config, clock });
    reloaded.load();
    assert.equal(reloaded.anchorCostsUsd, 2);
    assert.equal(reloaded.costsSinceAnchor(), 0.3);
    assert.equal(reloaded.totalCostsUsd(), 2.3);

    // A legacy anchored ledger (the live state before v3.4) has no anchorCostsUsd field: normalise
    // the baseline to 0 so every recorded cost counts and the first tick can clear the halt.
    const raw = readJsonFile(env.paths.ledger);
    const legacy = { ...raw, anchored: true, anchoredAt: raw.anchoredAt ?? clock.iso() };
    delete legacy.anchorCostsUsd;
    fs.writeFileSync(env.paths.ledger, JSON.stringify(legacy), 'utf8');
    const normalised = createLedger({ paths: env.paths, config: env.config, clock });
    normalised.load();
    assert.equal(normalised.anchorCostsUsd, 0);
    assert.equal(normalised.costsSinceAnchor(), 2.3, 'legacy normalisation counts every recorded cost');
    // A persisted baseline larger than the booked costs must clamp to 0, never negative.
    fs.writeFileSync(env.paths.ledger, JSON.stringify({ ...raw, anchored: true, anchorCostsUsd: 999 }), 'utf8');
    const clamped = createLedger({ paths: env.paths, config: env.config, clock });
    clamped.load();
    assert.equal(clamped.costsSinceAnchor(), 0);
  });
});

// ===========================================================================
// v3.4 part 2 — aggressive growth cohort: assignment, funding, idempotence
// ===========================================================================

function v34CohortEnv({ initial = 30, cap = 60, overrides = {} } = {}) {
  return makeEnv({
    population: { initial, cap },
    endowmentUsd: 50,
    // The cohort runs at a $50 base endowment; the default child endowment ($2,500) would not
    // fit that basis, so use a scaled one (same ratio as the live profile).
    replication: { childEndowmentUsd: 25 },
    strategyMix: { dayPct: 0.7 },
    aggression: { enabled: true },
    // The live profile's raised global caps (all 18 brakes still enforce them).
    risk: { maxOpenPositions: 10, maxOrderNotionalUsd: 60, maxDailyOrders: 40, maxPositionPct: 0.6 },
    account: { allocationCapPct: 0.92 },
    ...overrides,
  });
}

async function v34CohortWorld({ initial = 30, cap = 60, overrides = {} } = {}) {
  const env = v34CohortEnv({ initial, cap, overrides });
  const clock = makeClock(T0);
  const broker = createSimBroker(env.config, { seed: 7, accountEquityUsd: 100000, clock });
  const automaton = await createAutomaton({ config: env.config, paths: env.paths, broker, clock });
  await automaton.init();
  return {
    env,
    config: env.config,
    paths: env.paths,
    clock,
    broker,
    automaton,
    ledger: automaton._internals.ledger,
    registry: automaton._internals.registry,
  };
}

const V34_BASKET_SIZES = {
  aggressive: { day: 6, swing: 4 },
  balanced: { day: 4, swing: 3 },
  conservative: { day: 3, swing: 2 },
};

describe('v3.4 aggressive growth cohort: assignment, capital funding, idempotence', () => {
  it('30 agents get deterministic day-first 12/13/5 profiles, profile baskets and markers', async () => {
    const world = await v34CohortWorld();
    const status = await world.automaton.status();
    const counts = status.engine.aggression.counts;
    assert.deepEqual(counts, { aggressive: 12, balanced: 13, conservative: 5 });
    assert.equal(status.engine.aggression.enabled, true);
    assert.equal(status.engine.aggression.capitalMultiplier, 1.35);
    const agents = status.agents;
    assert.equal(agents.length, 30);
    const aggressive = agents.filter((agent) => agent.aggression === 'aggressive');
    assert.equal(aggressive.length, 12);
    assert.ok(aggressive.every((agent) => agent.tier === 'day'), 'aggressive cohort is day-first');
    // Deterministic: re-deriving the same assignment from the same registry gives the same names.
    const second = await world.automaton.status();
    assert.deepEqual(second.engine.aggression.counts, counts);
    for (const agent of agents) {
      assert.deepEqual(agent.aggressionProfile.name, agent.aggression);
      assert.equal(agent.symbols.length, V34_BASKET_SIZES[agent.aggression][agent.tier],
        `${agent.aggression}/${agent.tier} basket`);
      assert.equal(agent.activity.trades, 0);
      assert.equal(agent.activity.positions, 0);
    }
    // Day-first ordering: all 12 aggressive are day bots, balanced fills the remaining day bots.
    const dayAgents = agents.filter((agent) => agent.tier === 'day');
    assert.equal(dayAgents.filter((agent) => agent.aggression === 'balanced').length, 9);
    assert.equal(agents.filter((agent) => agent.tier === 'swing' && agent.aggression === 'balanced').length, 4);
    assert.equal(agents.filter((agent) => agent.tier === 'swing' && agent.aggression === 'conservative').length, 5);
    // Markers are versioned and idempotent.
    const profileMarker = readJsonFile(path.join(world.paths.stateDir, 'aggression-v34.json'));
    assert.equal(profileMarker.version, 1);
    assert.deepEqual(profileMarker.profiles, counts);
    assert.equal(profileMarker.changed, 30);
    const capitalMarker = readJsonFile(path.join(world.paths.stateDir, 'aggression-capital-v34.json'));
    assert.equal(capitalMarker.version, 1);
    assert.equal(capitalMarker.targetCapitalUsd, 67.5);
    assert.equal(capitalMarker.creditedUsd, 210);
    assert.equal(Object.keys(capitalMarker.allocations).length, 12);
    assert.equal(readJsonFile(path.join(world.paths.stateDir, 'growth-v34.json')).version, 1);
  });

  it('small populations keep the documented day-first proportions', async () => {
    const world = await v34CohortWorld({ initial: 5, cap: 8 });
    const status = await world.automaton.status();
    assert.deepEqual(status.engine.aggression.counts, { aggressive: 2, balanced: 2, conservative: 1 });
    const agents = status.agents;
    assert.ok(agents.filter((agent) => agent.aggression === 'aggressive').every((agent) => agent.tier === 'day'));
    assert.ok(agents.filter((agent) => agent.aggression === 'conservative').every((agent) => agent.tier === 'swing'));
    for (const agent of agents) {
      assert.equal(agent.symbols.length, V34_BASKET_SIZES[agent.aggression][agent.tier]);
    }
  });

  it('aggression disabled keeps v3.3 balanced genomes, 4/3 baskets and no v3.4 profile markers', async () => {
    const env = makeEnv({ population: { initial: 3, cap: 4 } });
    assert.equal(env.config.aggression.enabled, false, 'the code default is opt-out for compatibility');
    const clock = makeClock(T0);
    const broker = createSimBroker(env.config, { seed: 7, accountEquityUsd: 100000, clock });
    const automaton = await createAutomaton({ config: env.config, paths: env.paths, broker, clock });
    await automaton.init();
    const status = await automaton.status();
    assert.deepEqual(status.engine.aggression.counts, { aggressive: 0, balanced: 3, conservative: 0 });
    for (const agent of status.agents) {
      assert.equal(agent.genome.aggression, 'balanced');
      assert.equal(agent.symbols.length, agent.tier === 'day' ? 4 : 3, 'v3.3 4/3 baskets');
      assert.equal(agent.aggressionProfile.policySizeFloor, 0);
      assert.equal(agent.aggressionProfile.respectStandDown, true);
    }
    assert.equal(fs.existsSync(path.join(env.paths.stateDir, 'aggression-v34.json')), false);
    assert.equal(fs.existsSync(path.join(env.paths.stateDir, 'aggression-capital-v34.json')), false);
  });

  it('disabled aggression passes the OPERATOR portfolio limits and a neutral executor profile', async () => {
    const env = makeEnv({
      population: { initial: 3, cap: 6 },
      portfolio: { maxOpenPositionsDay: 2, maxOpenPositionsSwing: 1, maxOrdersPerCycle: 1 },
    });
    const clock = makeClock(T0);
    const broker = createSimBroker(env.config, { seed: 6, accountEquityUsd: 100000, clock });
    const automaton = await createAutomaton({ config: env.config, paths: env.paths, broker, clock });
    await automaton.init();
    const captured = [];
    const originalRun = automaton._internals.executor.run.bind(automaton._internals.executor);
    automaton._internals.executor.run = async (args) => {
      captured.push(args);
      return originalRun(args);
    };
    for (const agent of automaton._internals.registry.alive()) {
      automaton._internals.state.lastAnalysisAt.set(agent.id, 0);
    }
    clock.advance(CYCLE_MS);
    await automaton.tick();
    assert.ok(captured.length > 0, 'the executor must be reached in a deterministic sim cycle');
    for (const args of captured) {
      const tier = args.agent.tier === 'day' ? 'day' : 'swing';
      assert.equal(args.portfolio.maxOpenPositions, env.config.portfolio[`maxOpenPositions${tier === 'day' ? 'Day' : 'Swing'}`],
        `${tier} open cap must come from config.portfolio when aggression is disabled`);
      assert.equal(args.portfolio.maxOrdersPerCycle, env.config.portfolio.maxOrdersPerCycle);
      assert.deepEqual(args.profile, { aggression: 'balanced', policySizeFloor: 0, respectStandDown: true },
        'a disabled cohort is neutral, not a hidden balanced profile');
    }
    assert.equal(fs.existsSync(path.join(env.paths.stateDir, 'aggression-v34.json')), false);
  });

  it('aggressive capital is a one-time pool-funded capital contribution, never P&L/reward', async () => {
    const world = await v34CohortWorld();
    const status = await world.automaton.status();
    const pool = world.ledger.pool();
    assert.equal(pool.poolUsd, 98290, 'pool falls by the $210 top-up only');
    assert.equal(pool.allocatedUsd, 1710, '12 x 67.5 + 18 x 50 allocated');
    assert.equal(round2(pool.poolUsd + pool.allocatedUsd), 100000, 'capital moved, never minted');
    for (const agent of status.agents) {
      const ledger = world.ledger.snapshot(agent.id);
      if (agent.aggression === 'aggressive') {
        assert.equal(agent.endowmentUsd, 67.5);
        assert.equal(agent.capital.aggressiveCapitalUsd, 17.5, 'the contributed top-up is exposed for the UI');
        assert.equal(ledger.capitalContributionsUsd, 67.5);
        assert.equal(ledger.tradingPnlUsd, 0, 'the top-up must not be P&L');
        assert.equal(agent.capital.rewardCapitalUsd, 0, 'the top-up is not reward capital');
        assert.equal(agent.rewards.lifetimeUsd, 0);
        const transfers = world.ledger.get(agent.id).events
          .filter((event) => event.kind === 'transfer-in' && event.reason === 'v3.4 aggressive capital allocation');
        assert.equal(transfers.length, 1, 'exactly one capital-contribution transfer');
        assert.equal(transfers[0].amountUsd, 17.5);
      } else {
        assert.equal(agent.endowmentUsd, 50);
        assert.equal(agent.capital.aggressiveCapitalUsd, 0);
        assert.equal(ledger.capitalContributionsUsd, 50);
      }
    }
    // The top-up came from the treasury pool, not from an external grant.
    const treasuryTransfers = world.ledger.get(TREASURY_ID).events
      .filter((event) => event.kind === 'transfer-out' && event.reason === 'v3.4 aggressive capital allocation');
    assert.equal(treasuryTransfers.length, 12);
    assert.equal(round2(treasuryTransfers.reduce((sum, event) => sum + Number(event.amountUsd || 0), 0)), 210);
    // Allocation cap was respected by construction.
    assert.ok(pool.allocatedUsd <= 100000 * 0.92);
  });

  it('restart is idempotent: no second top-up, no profile drift, markers untouched', async () => {
    const world = await v34CohortWorld();
    const statusBefore = await world.automaton.status();
    const markerBefore = fs.readFileSync(path.join(world.paths.stateDir, 'aggression-v34.json'), 'utf8');
    const capitalMarkerBefore = fs.readFileSync(path.join(world.paths.stateDir, 'aggression-capital-v34.json'), 'utf8');
    const endowmentsBefore = Object.fromEntries(statusBefore.agents.map((agent) => [agent.id, agent.endowmentUsd]));
    const poolBefore = world.ledger.pool().poolUsd;

    const clock2 = makeClock(T0 + CYCLE_MS);
    const broker2 = createSimBroker(world.config, { seed: 7, accountEquityUsd: 100000, clock: clock2 });
    const restarted = await createAutomaton({ config: world.config, paths: world.paths, broker: broker2, clock: clock2 });
    await restarted.init();
    const statusAfter = await restarted.status();
    assert.deepEqual(statusAfter.engine.aggression.counts, statusBefore.engine.aggression.counts);
    assert.equal(restarted._internals.ledger.pool().poolUsd, poolBefore, 'no second top-up');
    for (const agent of statusAfter.agents) {
      assert.equal(agent.endowmentUsd, endowmentsBefore[agent.id]);
      assert.equal(agent.capital.aggressiveCapitalUsd, statusBefore.agents.find((row) => row.id === agent.id).capital.aggressiveCapitalUsd);
    }
    assert.equal(fs.readFileSync(path.join(world.paths.stateDir, 'aggression-v34.json'), 'utf8'), markerBefore);
    assert.equal(fs.readFileSync(path.join(world.paths.stateDir, 'aggression-capital-v34.json'), 'utf8'), capitalMarkerBefore);
    assert.equal(statusAfter.engine.performance.baselineAt, statusBefore.engine.performance.baselineAt,
      'the growth baseline is one-time');
  });

  it('a skipped-marker legacy state can still be migrated when aggression is enabled later', async () => {
    // Simulate a state dir whose old build wrote the v3.4 markers as skipped.
    const env = makeEnv({
      population: { initial: 3, cap: 6 },
      endowmentUsd: 50,
      replication: { childEndowmentUsd: 25 },
      strategyMix: { dayPct: 0.7 },
    });
    const clock = makeClock(T0);
    const first = await createAutomaton({
      config: env.config,
      paths: env.paths,
      broker: createSimBroker(env.config, { seed: 7, accountEquityUsd: 100000, clock }),
      clock,
    });
    await first.init();
    fs.writeFileSync(path.join(env.paths.stateDir, 'aggression-v34.json'),
      JSON.stringify({ version: 1, skipped: true, reason: 'aggression disabled' }), 'utf8');
    fs.writeFileSync(path.join(env.paths.stateDir, 'aggression-capital-v34.json'),
      JSON.stringify({ version: 1, skipped: true, reason: 'aggression disabled' }), 'utf8');
    const enabled = loadConfig({
      cwd: env.dir,
      env: {},
      configFile: path.join(env.dir, 'no-such-config.json'),
      overrides: {
        mode: 'sim',
        population: { initial: 3, cap: 6 },
        endowmentUsd: env.config.endowmentUsd,
        replication: { childEndowmentUsd: 25 },
        paths: { stateDir: env.paths.stateDir, envFile: path.join(env.paths.stateDir, '.env') },
        aggression: { enabled: true },
      },
    }).config;
    const clock2 = makeClock(T0 + CYCLE_MS);
    const second = await createAutomaton({
      config: enabled,
      paths: statePaths(enabled),
      broker: createSimBroker(enabled, { seed: 7, accountEquityUsd: 100000, clock: clock2 }),
      clock: clock2,
    });
    await second.init();
    const status = await second.status();
    const counts = status.engine.aggression.counts;
    assert.ok(counts.aggressive > 0, `a stale skipped marker must not block the migration: ${JSON.stringify(counts)}`);
    const marker = readJsonFile(path.join(env.paths.stateDir, 'aggression-v34.json'));
    assert.notEqual(marker.skipped, true, 'the skipped marker is overwritten by the real migration');
    const capitalMarker = readJsonFile(path.join(env.paths.stateDir, 'aggression-capital-v34.json'));
    assert.ok(Number(capitalMarker.creditedUsd) > 0);
    const aggressive = second._internals.registry.alive().filter((agent) => agent.genome.aggression === 'aggressive');
    assert.ok(aggressive.every((agent) => agent.endowmentUsd <= 50 * 1.35 + 0.01), 'no double top-up on re-run');
  });

  it('migration keeps held positions on their opening spec while the entry basket follows the profile', async () => {
    const env = makeEnv({ population: { initial: 2, cap: 4 }, endowmentUsd: 5000 });
    const clock = makeClock(T0);
    const broker = createSimBroker(env.config, { seed: 7, accountEquityUsd: 100000, clock });
    const first = await createAutomaton({ config: env.config, paths: env.paths, broker, clock });
    await first.init();
    const registry = first._internals.registry;
    const ledger = first._internals.ledger;
    const dayAgent = registry.alive().find((agent) => agent.tier === 'day');
    const swingAgent = registry.alive().find((agent) => agent.tier === 'swing');
    assert.ok(dayAgent && swingAgent);
    await registry.update(dayAgent.id, { specId: 'spec-held-opening' });
    await registry.update(swingAgent.id, { specId: 'spec-flat-stale' });
    await registry.save();
    ledger.applyFill(dayAgent.id, { symbol: dayAgent.genome.symbol, side: 'buy', qty: 1, priceUsd: 100, at: clock.now() });
    await ledger.save();

    const enabled = loadConfig({
      cwd: env.dir,
      env: {},
      configFile: path.join(env.dir, 'no-such-config.json'),
      overrides: {
        mode: 'sim',
        population: { initial: 2, cap: 4 },
        endowmentUsd: 5000,
        paths: { stateDir: env.paths.stateDir, envFile: path.join(env.paths.stateDir, '.env') },
        aggression: { enabled: true },
      },
    }).config;
    const clock2 = makeClock(T0 + CYCLE_MS);
    const second = await createAutomaton({
      config: enabled,
      paths: statePaths(enabled),
      broker: createSimBroker(enabled, { seed: 7, accountEquityUsd: 100000, clock: clock2 }),
      clock: clock2,
    });
    await second.init();
    const held = second._internals.registry.get(dayAgent.id);
    const flat = second._internals.registry.get(swingAgent.id);
    assert.equal(held.specId, 'spec-held-opening', 'held positions keep their opening spec for safe exits');
    assert.equal(Object.keys(second._internals.ledger.snapshot(dayAgent.id).positions).length, 1, 'the position itself survives');
    assert.equal(held.genome.aggression, 'aggressive');
    assert.equal(held.symbols.length, V34_BASKET_SIZES.aggressive[held.tier], 'entry basket follows the profile');
    assert.equal(flat.specId, null, 'flat agents lose the stale cached spec so the builder recompiles');
    assert.equal(flat.genome.aggression, 'balanced');
    assert.equal(flat.symbols.length, V34_BASKET_SIZES.balanced[flat.tier]);
  });

  it('replication inherits the aggression profile with exactly one genome mutation', async () => {
    const env = makeV32Env({
      population: { initial: 0, cap: 100 },
      endowmentUsd: 5000,
      replication: { childEndowmentUsd: 2500, surplus7dUsd: 2, minRunwayHours: 24 },
    });
    const { clock } = v32Boot(env);
    const registry = createRegistry({ paths: env.paths, config: env.config, clock });
    const ledger = createLedger({ paths: env.paths, config: env.config, clock });
    const journal = createJournal({ paths: env.paths, config: env.config });
    const parentBasket = ['F', 'AAPL', 'MSFT', 'BAC'];
    const parentGenome = {
      symbol: parentBasket[0],
      symbols: [...parentBasket],
      family: 'momentum',
      lookback: 60,
      entryZ: 1.2,
      exitZ: 0.3,
      stopPct: 0.02,
      targetPct: 0.04,
      maxHoldBars: 8,
      sizePct: 0.15,
      sessionFilter: 'any',
      aggression: 'aggressive',
      aggressionCapitalUsd: 17.5,
    };
    const parentId = 'atm-v34-parent';
    await registry.register({
      id: parentId,
      generation: 0,
      bornAt: clock.iso(),
      status: 'alive',
      endowmentUsd: 5000,
      genome: parentGenome,
      symbols: [...parentBasket],
      specIds: {},
      mutation: null,
      specId: null,
      tier: 'day',
    });
    ledger.ensureAgent(parentId, { endowmentUsd: 5000, at: clock.iso() });
    ledger.grant(parentId, 5000, { reason: 'genesis', at: clock.iso() });
    const treasurer = {
      fundChild(parentID, childId, amountUsd) {
        ledger.transfer(parentID, childId, amountUsd, { reason: 'child-endowment', at: clock.iso() });
      },
    };
    const replicator = createReplicator({ treasurer, registry, ledger, journal, config: env.config, clock, rng: mulberry32(7) });
    const gate = { mayReplicate: true, surplus7dUsd: 1000, runwayHours: 1000, agentViews: [{ agentId: parentId, equityUsd: 5000 }] };
    const { child, mutation } = await replicator.spawn(parentId, gate);
    assert.equal(child.genome.aggression, 'aggressive', 'the child inherits the cohort profile');
    assert.equal(child.genome.aggressionCapitalUsd, 17.5, 'the inherited top-up classification travels with the genome');
    const changedMutable = MUTABLE_FIELDS.filter(
      (field) => JSON.stringify(parentGenome[field]) !== JSON.stringify(child.genome[field]),
    );
    assert.deepEqual(changedMutable, [mutation.field], 'exactly one MUTABLE-catalogue mutation');
    // The profile is not a mutable axis: it is never the field that mutates.
    assert.notEqual(mutation.field, 'aggression');
    const nonMutableChanges = Object.keys(parentGenome).filter((field) => {
      if (field === mutation.field || field === 'symbols') return false;
      return JSON.stringify(parentGenome[field]) !== JSON.stringify(child.genome[field]);
    });
    assert.deepEqual(nonMutableChanges, [], 'no unheritable re-specialisation');
  });
});

// ===========================================================================
// v3.4 part 3 — builder + executor aggression profile behaviour
// ===========================================================================

/** Stock-only instrument world: deterministic notional comparisons without option playbooks. */
function v34StockWorld() {
  return makeInstrumentWorld({
    overrides: {
      instruments: { enabled: true, allowOptions: false, allowSpreads: false, allowCoveredCalls: false, allowShort: false, allowMargin: false },
    },
  });
}

const V34_AGGRESSIVE_PROFILE = Object.freeze({ aggression: 'aggressive', policySizeFloor: 0.8, respectStandDown: false });
const V34_BALANCED_PROFILE = Object.freeze({ aggression: 'balanced', policySizeFloor: 0, respectStandDown: true });

function v34BuilderHypothesis({ symbol = 'AAPL', family = 'momentum', specsHint = null } = {}) {
  return {
    id: 'hyp-v34',
    symbol,
    family,
    proof: {
      vendor: 'alpaca',
      url: `https://data.alpaca.markets/v2/stocks/bars?symbols=${symbol}`,
      observedAt: new Date(T0 - 60 * 60 * 1000).toISOString(),
      metric: 'meanBps',
      sampleSize: 30,
      stats: { meanBps: 42 },
    },
    ...(specsHint ? { specsHint } : {}),
  };
}

function v34Compile(config, genome, hypothesis = v34BuilderHypothesis()) {
  const clock = makeClock(T0);
  const builder = createBuilder({ config, clock });
  return builder.compile({ hypothesis, agentId: 'atm-v34', cycleBudgetUsd: 100, genome });
}

const V34_MOMENTUM_GENOME = Object.freeze({
  symbol: 'AAPL',
  family: 'momentum',
  lookback: 60,
  entryZ: 1.2,
  exitZ: 0.5,
  stopPct: 0.02,
  targetPct: 0.04,
  maxHoldBars: 12,
  sizePct: 0.2,
  sessionFilter: 'any',
});

describe('v3.4 builder/executor aggression profiles', () => {
  it('builder applies the profile multipliers after genome/hint values and before hard bounds', () => {
    const env = makeEnv();
    const balanced = v34Compile(env.config, { ...V34_MOMENTUM_GENOME, aggression: 'balanced' }).spec;
    const aggressive = v34Compile(env.config, { ...V34_MOMENTUM_GENOME, aggression: 'aggressive' }).spec;
    const conservative = v34Compile(env.config, { ...V34_MOMENTUM_GENOME, aggression: 'conservative' }).spec;
    assert.equal(aggressive.params.entryZ, 1.2 * 0.7);
    assert.equal(aggressive.params.sizePct, 0.2 * 1.35);
    assert.equal(aggressive.params.stopPct, 0.02 * 0.8);
    assert.equal(aggressive.params.targetPct, 0.04 * 1.2);
    assert.equal(aggressive.params.maxHoldBars, 9, '12 x 0.75 rounded to an integer bar count');
    assert.equal(aggressive.params.lookback, 60, 'lookback is not a profile axis');
    assert.equal(aggressive.params.exitZ, 0.5, 'exitZ is not a profile axis');
    assert.equal(aggressive.symbol, 'AAPL');
    assert.equal(aggressive.family, 'momentum');
    assert.equal(aggressive.profile.aggression, 'aggressive');
    assert.equal(conservative.params.entryZ, 1.2 * 1.15);
    assert.equal(conservative.params.sizePct, 0.2 * 0.8);
    assert.equal(conservative.params.stopPct, 0.02);
    assert.equal(conservative.params.targetPct, 0.04 * 0.9);
    assert.equal(balanced.params.entryZ, 1.2);
    // Profile scaling happens BEFORE the clamp: an aggressive over-bound value is clamped, not scaled.
    const clamped = v34Compile(env.config, {
      ...V34_MOMENTUM_GENOME,
      aggression: 'aggressive',
      entryZ: 3,
      stopPct: 0.005,
      targetPct: 0.12,
      maxHoldBars: 48,
      sizePct: 0.4,
    }).spec;
    assert.equal(clamped.params.entryZ, 3 * 0.7);
    assert.equal(clamped.params.stopPct, PARAM_BOUNDS.stopPct.min, '0.005 x 0.8 clamps at the 0.005 floor');
    assert.equal(clamped.params.targetPct, PARAM_BOUNDS.targetPct.max, '0.12 x 1.2 clamps at the 0.12 ceiling');
    assert.equal(clamped.params.sizePct, PARAM_BOUNDS.sizePct.max, '0.4 x 1.35 clamps at the 0.4 ceiling');
    for (const spec of [aggressive, conservative, balanced]) {
      for (const [name, bound] of Object.entries(PARAM_BOUNDS)) {
        assert.ok(spec.params[name] >= bound.min && spec.params[name] <= bound.max, `${spec.profile.aggression}.${name} in bounds`);
      }
    }
  });

  it('balanced and legacy genomes compile byte-compatible v3.3 specs', () => {
    const env = makeEnv();
    const legacy = v34Compile(env.config, { ...V34_MOMENTUM_GENOME }).spec;
    const balanced = v34Compile(env.config, { ...V34_MOMENTUM_GENOME, aggression: 'balanced' }).spec;
    const unknown = v34Compile(env.config, { ...V34_MOMENTUM_GENOME, aggression: 'reckless' }).spec;
    assert.equal(legacy.profile, undefined, 'no aggression field means the legacy spec shape');
    assert.equal(unknown.profile, undefined, 'unknown names never guess a profile');
    assert.deepEqual(balanced.params, legacy.params);
    assert.equal(balanced.specId, legacy.specId, 'balanced params hash exactly as v3.3 did');
    assert.deepEqual(unknown.params, legacy.params);
    assert.equal(unknown.specId, legacy.specId);
    assert.equal(balanced.profile.aggression, 'balanced');
    assert.equal(balanced.profile.entryZMultiplier, 1);
    // deterministic: same inputs -> identical spec (no randomness in the profile path)
    assert.deepEqual(v34Compile(env.config, { ...V34_MOMENTUM_GENOME, aggression: 'aggressive' }),
      v34Compile(env.config, { ...V34_MOMENTUM_GENOME, aggression: 'aggressive' }));
  });

  it('executor aggressive floor raises cautious entries; balanced keeps legacy sizing', async () => {
    const cautiousPolicy = (clock) => ({ stance: 'cautious', atMs: clock.now(), sizeMultiplier: 0.2 });
    const baselineWorld = v34StockWorld();
    const baseline = await runInstrumentExecutor(baselineWorld, { policy: cautiousPolicy(baselineWorld.clock) });
    assert.equal(baseline.orders.length, 1);
    // sizePct 0.2 x mandate.sizeBudgetUsd 2500 x cautious 0.2 = $100
    assert.ok(Math.abs(round2(baseline.orders[0].qty * baseline.orders[0].avgFillPriceUsd) - 100) < 1.5,
      'cautious sizing without a profile is the v3.3 $100');
    assert.deepEqual(baseline.actions.find((action) => action.type === 'entry').policy, {
      stance: 'cautious', sizeMultiplier: 0.2, applied: 'size',
    });
    const floorWorld = v34StockWorld();
    const floored = await runInstrumentExecutor(floorWorld, {
      policy: cautiousPolicy(floorWorld.clock),
      profile: V34_AGGRESSIVE_PROFILE,
    });
    assert.ok(Math.abs(round2(floored.orders[0].qty * floored.orders[0].avgFillPriceUsd) - 400) < 1.5,
      'aggressive floor: max(0.2, 0.8) x $500 = $400');
    const flooredEntry = floored.actions.find((action) => action.type === 'entry');
    assert.equal(flooredEntry.policy.profile, 'aggressive');
    assert.equal(flooredEntry.policy.policyFloor, 0.8);
    assert.equal(flooredEntry.policy.effectiveSizeMultiplier, 0.8);
    // Balanced profile with floor 0 is exactly the legacy run.
    const balancedWorld = v34StockWorld();
    const balanced = await runInstrumentExecutor(balancedWorld, {
      policy: cautiousPolicy(balancedWorld.clock),
      profile: V34_BALANCED_PROFILE,
    });
    assert.ok(Math.abs(round2(balanced.orders[0].qty * balanced.orders[0].avgFillPriceUsd) - 100) < 1.5);
    assert.deepEqual(balanced.actions.find((action) => action.type === 'entry').policy, {
      stance: 'cautious', sizeMultiplier: 0.2, applied: 'size',
    });
  });

  it('executor converts stand_down at the floor only when respectStandDown=false', async () => {
    const world = v34StockWorld();
    const blocked = await runInstrumentExecutor(world, {
      policy: { stance: 'stand_down', atMs: world.clock.now(), sizeMultiplier: 0.4 },
      profile: V34_BALANCED_PROFILE,
    });
    assert.equal(blocked.orders.length, 0);
    assert.ok(blocked.actions.some((action) => action.reason === 'agent_stand_down'));

    const convertedWorld = v34StockWorld();
    const converted = await runInstrumentExecutor(convertedWorld, {
      policy: { stance: 'stand_down', atMs: convertedWorld.clock.now(), sizeMultiplier: 0.4 },
      profile: V34_AGGRESSIVE_PROFILE,
    });
    assert.equal(converted.orders.length, 1);
    const entry = converted.actions.find((action) => action.type === 'entry');
    assert.equal(entry.policy.converted, true);
    assert.equal(entry.policy.convertedFrom, 'stand_down');
    assert.equal(entry.policy.stance, 'cautious');
    assert.equal(entry.policy.effectiveSizeMultiplier, 0.8);
    assert.ok(Math.abs(round2(converted.orders[0].qty * converted.orders[0].avgFillPriceUsd) - 400) < 1.5, 'converted notional=' + round2(converted.orders[0]?.qty * converted.orders[0]?.avgFillPriceUsd) + ' orders=' + converted.orders.length + ' entries=' + JSON.stringify(converted.actions.map((a) => ({ type: a.type, reason: a.reason, policy: a.policy }))));

    // Regression D-V34-3: bot-agent stores sizeMultiplier 1 when the model omits it; the
    // converted stance must still size AT the floor, not at the bot's 1x factor.
    const fullSizeWorld = v34StockWorld();
    const fullSize = await runInstrumentExecutor(fullSizeWorld, {
      policy: { stance: 'stand_down', atMs: fullSizeWorld.clock.now(), sizeMultiplier: 1 },
      profile: V34_AGGRESSIVE_PROFILE,
    });
    assert.equal(fullSize.orders.length, 1);
    assert.ok(Math.abs(round2(fullSize.orders[0].qty * fullSize.orders[0].avgFillPriceUsd) - 400) < 1.5,
      'a converted stand-down is capped at the 0.8 floor, never a full-size entry');
    assert.equal(fullSize.actions.find((action) => action.type === 'entry').policy.effectiveSizeMultiplier, 0.8);
  });

  it('research ALERT and the brake wall still veto a converted aggressive entry', async () => {
    const researchWorld = v34StockWorld();
    const vetoed = await runInstrumentExecutor(researchWorld, {
      policy: { stance: 'stand_down', atMs: researchWorld.clock.now(), sizeMultiplier: 0.4 },
      profile: V34_AGGRESSIVE_PROFILE,
      research: { verdict: 'ALERT', sentiment: -0.8, confidence: 0.9, risks: ['gap risk'], atMs: researchWorld.clock.now() },
    });
    assert.equal(vetoed.orders.length, 0, 'research ALERT still wins over the converted stance');
    assert.equal(vetoed.denied.length, 0, 'a research veto is an advisory skip, not a brake denial');
    assert.ok(vetoed.actions.some((action) => action.reason === 'research_veto'));

    const brakeWorld = v34StockWorld();
    const denied = await runInstrumentExecutor(brakeWorld, {
      policy: { stance: 'stand_down', atMs: brakeWorld.clock.now(), sizeMultiplier: 1 },
      profile: V34_AGGRESSIVE_PROFILE,
      mandate: { ...brakeWorld.mandate, maxDailyOrdersRemaining: 0 },
    });
    assert.equal(denied.orders.length, 0, 'the aggressive profile cannot bypass the D6 daily-order brake');
    assert.equal(denied.denied[0].code, 'RATE_FORBIDDEN');
    assert.equal(brakeWorld.broker.getOrders({ status: 'all', limit: 50 }).length, 0);
  });
});

// ===========================================================================
// v3.4 part 4 — annual-return target / performance + activity status
// ===========================================================================

describe('v3.4 annual-return target and activity status', () => {
  it('target math: required daily pace, annualized return, progress points and onTrack', async () => {
    const world = await v34ReconWorld();
    world.clock.advance(CYCLE_MS);
    await world.automaton.tick(); // anchors + populates the account snapshot
    const baseStatus = await world.automaton.status();
    const baseline = baseStatus.engine.performance;
    assert.equal(baseline.enabled, true);
    assert.equal(baseline.targetAnnualReturnPct, 0.5);
    assert.equal(baseline.requiredDailyReturnPct, Math.pow(1.5, 1 / 365) - 1);
    assert.ok(Math.abs(baseline.requiredDailyReturnPct * 100 - 0.11115) < 0.0001, '~0.111%/day');
    assert.ok(baseline.baselineAt, 'one-time growth baseline written on first start');
    assert.equal(baseline.baselineAccountEquityUsd, 100000);
    assert.ok(baseline.daysElapsed < 1, 'short history within the first day');
    assert.equal(baseline.annualizedReturnPct, null, 'never fabricate an annualized return in short history');
    assert.equal(baseline.targetProgressPct, null);
    assert.equal(baseline.onTrack, null);
    assert.deepEqual(baseStatus.performance, baseStatus.engine.performance);
    const pnlTotal = baseline.tradingPnlTotalUsd;
    const markerAt = (msAgo) => new Date(world.clock.now() - msAgo).toISOString();

    // A 30-day history with +$1,000 trading P&L: 1% x 365/30 = 12.17%/yr = 24.33% of the 50% target.
    v34WriteGrowthMarker(world, {
      version: 1,
      at: markerAt(30 * 86_400_000),
      baselineAccountEquityUsd: 100000,
      baselineTradingPnlUsd: pnlTotal - 1000,
      targetAnnualReturnPct: 0.5,
    });
    const below = await world.automaton.refreshSnapshot();
    const belowPerf = below.engine.performance;
    assert.equal(belowPerf.daysElapsed, 30);
    assert.equal(belowPerf.tradingPnlSinceBaselineUsd, 1000);
    assert.equal(belowPerf.annualizedReturnPct, Math.round((1000 / 100000) * (365 / 30) * 1e6) / 1e6);
    assert.ok(Math.abs(belowPerf.annualizedReturnPct - 0.121667) < 1e-6);
    assert.equal(belowPerf.targetProgressPct, 24.33, 'points: 100 = on target');
    assert.equal(belowPerf.onTrack, false, 'onTrack is informational only');
    assert.equal(belowPerf.accountEquityUsd, 100000);

    // +$5,000: 60.83%/yr = 121.67 points -> on pace.
    v34WriteGrowthMarker(world, {
      version: 1,
      at: markerAt(30 * 86_400_000),
      baselineAccountEquityUsd: 100000,
      baselineTradingPnlUsd: pnlTotal - 5000,
      targetAnnualReturnPct: 0.5,
    });
    const above = await world.automaton.refreshSnapshot();
    const abovePerf = above.engine.performance;
    assert.equal(abovePerf.targetProgressPct, 121.67);
    assert.equal(abovePerf.onTrack, true);
    assert.ok(abovePerf.annualizedReturnPct >= 0.5);

    // Short history (< 1 elapsed day) hides annualized/progress/onTrack even with measured P&L.
    v34WriteGrowthMarker(world, {
      version: 1,
      at: markerAt(12 * 60 * 60 * 1000),
      baselineAccountEquityUsd: 100000,
      baselineTradingPnlUsd: pnlTotal - 100,
      targetAnnualReturnPct: 0.5,
    });
    const short = await world.automaton.refreshSnapshot();
    assert.equal(short.engine.performance.daysElapsed, 0.5);
    assert.equal(short.engine.performance.tradingPnlSinceBaselineUsd, 100);
    assert.equal(short.engine.performance.annualizedReturnPct, null);
    assert.equal(short.engine.performance.targetProgressPct, null);
    assert.equal(short.engine.performance.onTrack, null);
    // Capital base / equity are reported alongside for the UI card.
    const capitalFromAgents = short.agents.reduce((sum, agent) => sum + Number(agent.capital?.contributedUsd || 0), 0);
    assert.equal(short.engine.performance.accountCapitalBase, round2(capitalFromAgents + world.ledger.pool().poolUsd));
  });

  it('status exposes the v3.4 performance/aggression/activity contract on a stopped engine', async () => {
    const world = await v34CohortWorld({ initial: 5, cap: 8 });
    const status = await world.automaton.status();
    assert.equal(world.automaton.isRunning(), false, 'status is served by a stopped engine');
    assert.deepEqual(status.performance, status.engine.performance);
    assert.deepEqual(status.aggression, status.engine.aggression);
    assert.deepEqual(status.activity, status.engine.activity);
    assert.equal(typeof status.engine.performance.requiredDailyReturnPct, 'number');
    for (const key of [
      'targetAnnualReturnPct', 'requiredDailyReturnPct', 'baselineAt', 'baselineAccountEquityUsd',
      'baselineTradingPnlUsd', 'daysElapsed', 'tradingPnlSinceBaselineUsd', 'annualizedReturnPct',
      'targetProgressPct', 'onTrack', 'accountEquityUsd', 'accountCapitalBase', 'tradingPnlTotalUsd',
    ]) {
      assert.ok(key in status.engine.performance, `performance.${key} is part of the UI contract`);
    }
    assert.deepEqual(Object.keys(status.engine.aggression).sort(),
      ['aggressivePct', 'balancedPct', 'capitalMultiplier', 'counts', 'enabled', 'profiles'].sort());
    for (const key of ['ordersToday', 'tradesTotal', 'positionsTotal', 'lastCycleExecutions', 'lastCycleOrders',
      'activeProfiles', 'haltReasons', 'halted']) {
      assert.ok(key in status.engine.activity, `activity.${key} is part of the UI contract`);
    }
    for (const agent of status.agents) {
      assert.ok(['aggressive', 'balanced', 'conservative'].includes(agent.aggression));
      assert.equal(agent.aggressionProfile.name, agent.aggression);
      for (const key of ['basketSizeDay', 'basketSizeSwing', 'maxOpenPositionsDay', 'maxOpenPositionsSwing',
        'maxOrdersPerCycle', 'entryZMultiplier', 'sizePctMultiplier', 'stopPctMultiplier',
        'targetPctMultiplier', 'maxHoldBarsMultiplier', 'policySizeFloor', 'respectStandDown']) {
        assert.ok(key in agent.aggressionProfile, `aggressionProfile.${key}`);
      }
      for (const key of ['ordersToday', 'trades', 'positions']) {
        assert.ok(key in agent.activity, `activity.${key}`);
      }
    }
    // The UI needs the aggressive capital split; it is contributed capital, never reward/P&L.
    const aggressive = status.agents.filter((agent) => agent.aggression === 'aggressive');
    assert.ok(aggressive.length > 0);
    assert.ok(aggressive.every((agent) => agent.capital.aggressiveCapitalUsd === 17.5));
    assert.ok(aggressive.every((agent) => agent.capital.rewardCapitalUsd === 0));
  });

  it('the 50% target never drives order sizing (status-only wiring)', async () => {
    const world = await v34ReconWorld();
    world.clock.advance(CYCLE_MS);
    await world.automaton.tick();
    const agentId = world.registry.alive()[0].id;
    const mandateBefore = v34Treasury(world).mandates[agentId];
    assert.ok(mandateBefore);
    assert.equal(JSON.stringify(mandateBefore).includes('target'), false);
    assert.equal(JSON.stringify(mandateBefore).includes('performance'), false);
    const pnlTotal = (await world.automaton.status()).engine.performance.tradingPnlTotalUsd;
    // Hide the target far behind: if any engine path sized orders from progress, these mandates would change.
    v34WriteGrowthMarker(world, {
      version: 1,
      at: new Date(T0 - 30 * 86_400_000).toISOString(),
      baselineAccountEquityUsd: 100000,
      baselineTradingPnlUsd: pnlTotal + 1_000_000,
      targetAnnualReturnPct: 0.5,
    });
    world.clock.advance(CYCLE_MS);
    await world.automaton.tick();
    const status = await world.automaton.status();
    assert.equal(status.engine.performance.onTrack, false);
    const mandateAfter = v34Treasury(world).mandates[agentId];
    assert.ok(Math.abs(mandateAfter.sizeBudgetUsd - mandateBefore.sizeBudgetUsd) <= 0.02, 'sizeBudget before ' + mandateBefore.sizeBudgetUsd + ' after ' + mandateAfter.sizeBudgetUsd);
    assert.ok(Math.abs(mandateAfter.maxOrderNotionalUsd - mandateBefore.maxOrderNotionalUsd) <= 0.02);
    // The mandate cap is still the configured risk formula, not a performance/target number.
    const expectedCap = round2(Math.min(
      Number(world.config.risk.maxOrderNotionalUsd),
      Number(world.config.risk.maxOrderPctOfEquity) * mandateAfter.equityUsd,
    ));
    assert.ok(Math.abs(mandateAfter.sizeBudgetUsd - expectedCap) <= 0.01, 'sizeBudget ' + mandateAfter.sizeBudgetUsd + ' expectedCap ' + expectedCap + ' equity ' + mandateAfter.equityUsd);
  });
});

// ===========================================================================
// v3.5 — meaningful position sizing and the opportunistic proven fallback
// (docs/AGGRESSIVE-GROWTH.md §7). Independent regression coverage:
//   * the sizing multiplier scales spec.sizePct before every mandate/order/
//     equity/cash/brake cap; the default 1 is exactly the v3.4 formula
//   * a 3x entry on the live-shaped $50/$67.5/$126 bots is ~18-50% of equity
//   * fallback compiles/marks/caches a proven cross-family hypothesis only for
//     aggressive bots whose own family/symbol has no compilable hypothesis, uses
//     the measured (hypothesis-family) parameters, and executes under brakes
//   * stale/unproven candidates are rejected (D9); balanced/conservative never
//     cross families; primary `spec` stays tied to the genome symbol
//   * the narrow-queue coverage gain is measured on a 30-bot cohort (12/13/5)
//
// The tick-level tests use one TEST-ONLY seam: `_internals.prospector.run()` is
// replaced with a deterministic hypothesis list because `ensureSpecs()` is a
// closure that is not exported (docs/VERIFICATION.md §13 records this gap).
// ===========================================================================

const V35_LIVE_RISK = Object.freeze({
  maxOrderNotionalUsd: 120,
  maxOrderPctOfEquity: 0.5,
  maxOpenPositions: 10,
  maxDailyOrders: 40,
  maxPositionPct: 0.6,
  maxSpreadBps: 100,
  sizePctMultiplier: 3,
});

const V35_STOCK_ONLY = Object.freeze({
  enabled: true,
  allowOptions: false,
  allowSpreads: false,
  allowCoveredCalls: false,
  allowShort: false,
  allowMargin: false,
});

/** Layered config at the live v3.5 risk shape, with a 3-bot deterministic population. */
function v35Env({ risk = {}, aggression = {}, instruments = {}, ...overrides } = {}) {
  return makeEnv({
    population: { initial: 3, cap: 4 },
    endowmentUsd: 50,
    deathFloorUsd: 1,
    deathFloorPct: 0.05,
    replication: { childEndowmentUsd: 25, surplus7dUsd: 3, minRunwayHours: 72 },
    aggression: { enabled: true, ...aggression },
    risk: { ...V35_LIVE_RISK, ...risk },
    account: { allocationCapPct: 0.92 },
    instruments: { ...V35_STOCK_ONLY, ...instruments },
    ...overrides,
  });
}

/** Dated-proof (or deliberately unproven) hypothesis for the patched Prospector. */
function v35Hypothesis(symbol, family, { ageHours = 1, rank = 0.5, proof = true, specsHint = { sizePct: 0.2 } } = {}) {
  const hypothesis = {
    id: 'hyp-v35-' + family + '-' + symbol + '-' + String(rank).replace('.', '_') + '-' + ageHours,
    symbol,
    family,
    rankScore: rank,
    specsHint,
  };
  if (proof) {
    hypothesis.proof = {
      vendor: 'alpaca',
      url: 'https://data.alpaca.markets/v2/stocks/bars?symbols=' + symbol,
      observedAt: new Date(T0 - ageHours * 60 * 60 * 1000).toISOString(),
      metric: 'meanBps',
      sampleSize: 20,
      stats: { meanBps: 25 },
    };
  }
  return hypothesis;
}

/** Full automaton world with a patched Prospector queue (test-only seam, see header). */
async function v35MarketWorld({ hypotheses = [], risk = {}, aggression = {} } = {}) {
  const env = v35Env({ risk, aggression });
  const clock = makeClock(T0);
  const broker = createSimBroker(env.config, { seed: 6, accountEquityUsd: 100000, clock });
  const automaton = await createAutomaton({ config: env.config, paths: env.paths, broker, clock });
  await automaton.init();
  const internals = automaton._internals;
  internals.prospector.run = async () => ({ hypotheses, spentUsd: 0, dataCalls: 0, rejected: [] });
  const agents = internals.registry.alive();
  return {
    env,
    config: env.config,
    paths: env.paths,
    clock,
    broker,
    automaton,
    internals,
    agents,
    aggressive: agents.find((agent) => agent.genome.aggression === 'aggressive') ?? null,
    nonAggressive: agents.filter((agent) => agent.genome.aggression !== 'aggressive'),
  };
}

/** Flat bars then a -1% opening gap: gapfade longEntry, deterministic last close. */
function v35GapDownBars(basePrice, { count = 40 } = {}) {
  const bars = [];
  for (let i = 0; i < count - 1; i += 1) {
    bars.push({
      t: T0 - (count - i) * 60 * 60 * 1000,
      o: basePrice,
      h: basePrice * 1.001,
      l: basePrice * 0.999,
      c: basePrice,
      v: 1000,
    });
  }
  bars.push({
    t: T0,
    o: basePrice * 0.99,
    h: basePrice * 1.001,
    l: basePrice * 0.985,
    c: basePrice * 0.999,
    v: 5000,
  });
  return bars;
}

/** Pin one symbol's bars + quote so a spec has a deterministic entry signal. */
function v35PinMarket(broker, symbol, basePrice, barsOverride = null) {
  const originalGetBars = broker.getBars.bind(broker);
  broker.getBars = async (args = {}) => {
    const out = await originalGetBars(args);
    const requested = (args.symbols ?? []).map((value) => String(value).toUpperCase());
    if (requested.includes(symbol)) out[symbol] = barsOverride ?? v35GapDownBars(basePrice);
    return out;
  };
  const originalGetQuote = broker.getLatestQuote.bind(broker);
  broker.getLatestQuote = async (requested, ...rest) => {
    const quote = await originalGetQuote(requested, ...rest);
    if (String(requested).toUpperCase() !== symbol) return quote;
    return {
      ...quote,
      bid: round2(basePrice * 0.999),
      ask: round2(basePrice),
      last: round2(basePrice * 0.999),
      ts: quote?.ts ?? null,
    };
  };
}

/** Flat bars then a close above the prior range: breakout longEntry. */
function v35BreakoutBars(basePrice, { count = 40 } = {}) {
  const bars = [];
  for (let i = 0; i < count - 1; i += 1) {
    bars.push({
      t: T0 - (count - i) * 60 * 60 * 1000,
      o: basePrice,
      h: basePrice * 1.001,
      l: basePrice * 0.999,
      c: basePrice,
      v: 1000,
    });
  }
  bars.push({
    t: T0,
    o: basePrice,
    h: basePrice * 1.06,
    l: basePrice,
    c: basePrice * 1.05,
    v: 5000,
  });
  return bars;
}

/**
 * Stock-only executor world whose mandate is built with the REAL live risk formula
 * (`min(maxOrderNotionalUsd, maxOrderPctOfEquity * equity)`) for a small bot.
 */
function v35SizingWorld({ equityUsd = 67.5, multiplier = 3, risk = {}, cashCharge = 0 } = {}) {
  const world = makeInstrumentWorld({
    endowmentUsd: equityUsd,
    overrides: {
      risk: { ...V35_LIVE_RISK, ...(multiplier === null ? {} : { sizePctMultiplier: multiplier }), ...risk },
      instruments: { ...V35_STOCK_ONLY },
    },
  });
  if (cashCharge > 0) {
    world.ledger.charge(world.id, cashCharge, { category: 'hosting', role: 'treasurer', at: world.clock.iso() });
  }
  const cap = round2(Math.min(
    Number(world.config.risk.maxOrderNotionalUsd),
    Number(world.config.risk.maxOrderPctOfEquity) * equityUsd,
  ));
  const mandate = {
    ...world.mandate,
    sizeBudgetUsd: cap,
    maxOrderNotionalUsd: cap,
    equityUsd,
    allocatedEquityUsd: equityUsd,
    issuedAt: world.clock.iso(),
    expiresAt: new Date(world.clock.now() + 10 * 60 * 1000).toISOString(),
  };
  return { world, cap, mandate };
}

function v35SizingSpec(world, sizePct) {
  return instrumentSpec(world, {
    params: {
      lookback: 60,
      entryZ: 1,
      exitZ: 0.5,
      stopPct: 0.02,
      targetPct: 0.04,
      maxHoldBars: 12,
      sizePct,
      sessionFilter: 'any',
    },
  });
}

/** Run one momentum-long entry and return the resulting order/notional (null when denied). */
async function v35Enter(worldInfo, sizePct, { overrides = {} } = {}) {
  const { world, mandate } = worldInfo;
  const quote = world.broker.getLatestQuote(world.symbol);
  const result = await world.executor.run({
    agent: world.registry.get(world.id),
    spec: v35SizingSpec(world, sizePct),
    mandate,
    quotes: { [world.symbol]: quote },
    bars: { [world.symbol]: instrumentBars(quote.last, 1) },
    dayStats: { dayKey: '2026-01-05', ordersCount: 0, startEquityUsd: world.endowmentUsd, pnlUsd: 0 },
    now: world.clock.now(),
    ...overrides,
  });
  const order = result.orders[0] ?? null;
  return { result, order, notional: order ? round2(order.qty * order.avgFillPriceUsd) : null, quote };
}

describe('v3.5 meaningful position sizing (executor, live-shaped caps)', () => {
  it('default risk.sizePctMultiplier is 1 and reproduces the v3.4 order size exactly', async () => {
    assert.equal(defaultConfig().risk.sizePctMultiplier, 1, 'code default must stay legacy-compatible');
    for (const sizePct of [0.12, 0.2, 0.4]) {
      const explicit = await v35SizingWorld({ equityUsd: 67.5, multiplier: 1 });
      assert.equal(explicit.world.config.risk.sizePctMultiplier, 1);
      const run = await v35Enter(explicit, sizePct);
      assert.equal(run.result.denied.length, 0, JSON.stringify(run.result.denied));
      assert.ok(run.order, 'a 1x sizing spec must still enter: ' + JSON.stringify(run.result.actions));
      assert.ok(
        Math.abs(run.notional - round2(sizePct * explicit.cap)) <= 0.06,
        'sizePct ' + sizePct + ': ' + run.notional + ' vs legacy ' + round2(sizePct * explicit.cap),
      );
    }
    // An executor whose config omits the field behaves identically: absent multiplier == explicit 1.
    const absent = await v35SizingWorld({ equityUsd: 67.5, multiplier: 1 });
    const configWithoutKey = { ...absent.world.config, risk: { ...absent.world.config.risk } };
    delete configWithoutKey.risk.sizePctMultiplier;
    absent.world.executor = createExecutor({
      broker: absent.world.broker,
      brakes: absent.world.brakes,
      ledger: absent.world.ledger,
      config: configWithoutKey,
      clock: absent.world.clock,
    });
    const legacyRun = await v35Enter(absent, 0.2);
    const explicitRun = await v35Enter(await v35SizingWorld({ equityUsd: 67.5, multiplier: 1 }), 0.2);
    assert.ok(legacyRun.order && explicitRun.order);
    assert.equal(legacyRun.notional, explicitRun.notional, 'absent multiplier == explicit 1');
  });

  it('3x sizing produces ~18-50% orders on $50/$67.5/$126 bots (legacy 6-20%)', async () => {
    const rows = [];
    for (const equityUsd of [50, 67.5, 126]) {
      const cap = round2(Math.min(120, 0.5 * equityUsd));
      for (const sizePct of [0.12, 0.2, 0.4]) {
        const legacy = await v35Enter(await v35SizingWorld({ equityUsd, multiplier: 1 }), sizePct);
        const live = await v35Enter(await v35SizingWorld({ equityUsd, multiplier: 3 }), sizePct);
        assert.equal(live.result.denied.length, 0, JSON.stringify(live.result.denied));
        assert.ok(legacy.order && live.order, 'both runs must enter');
        const legacyPct = legacy.notional / equityUsd;
        const livePct = live.notional / equityUsd;
        assert.ok(
          Math.abs(legacy.notional - round2(sizePct * cap)) <= 0.06,
          'legacy $' + equityUsd + ' sizePct ' + sizePct + ': ' + legacy.notional,
        );
        assert.ok(
          Math.abs(live.notional - round2(Math.min(1, sizePct * 3) * cap)) <= 0.06,
          'live $' + equityUsd + ' sizePct ' + sizePct + ': ' + live.notional,
        );
        assert.ok(
          livePct >= 0.17 && livePct <= 0.51,
          'live order must be meaningful, not tiny: $' + equityUsd + ' sizePct ' + sizePct + ' -> ' + round2(livePct * 100) + '%',
        );
        assert.ok(legacyPct <= 0.21, 'legacy orders stay tiny: ' + round2(legacyPct * 100) + '%');
        rows.push({ equityUsd, sizePct, legacyPct, livePct });
      }
    }
    // The documented band and the 50%-equity clamp, across all three bot sizes.
    assert.ok(rows.every((row) => row.livePct >= 0.17 && row.livePct <= 0.51));
    assert.ok(rows.every((row) => Math.abs(row.livePct - Math.min(1, row.sizePct * 3) * 0.5) <= 0.012));
    assert.ok(rows.some((row) => row.sizePct === 0.4 && row.livePct >= 0.49), 'largest spec clamps at 50% of equity');
  });

  it('the multiplier is applied before every cap: mandate/order/equity/cash and D5 still bind', async () => {
    // Mandate / order-notional cap: the real mandate is min(maxOrderNotional, 50% equity).
    const tiny = await v35SizingWorld({ equityUsd: 67.5, multiplier: 3, risk: { maxOrderNotionalUsd: 10 } });
    assert.equal(tiny.cap, 10);
    const tinyRun = await v35Enter(tiny, 0.4);
    assert.ok(tinyRun.notional <= 10.05, 'mandate cap: ' + tinyRun.notional);

    // Hard account cap: at $500 equity the 120 hard max binds before 50% ($250).
    const big = await v35SizingWorld({ equityUsd: 500, multiplier: 3 });
    assert.equal(big.cap, 120);
    const bigRun = await v35Enter(big, 0.4);
    assert.ok(bigRun.notional <= 120.1 && bigRun.notional >= 119.8, 'hard cap: ' + bigRun.notional);

    // Cash cap: only $2 of virtual cash left, so the fill is <= $2 and cash never goes negative.
    const poor = await v35SizingWorld({ equityUsd: 67.5, multiplier: 3, cashCharge: 65.5 });
    const poorRun = await v35Enter(poor, 0.4);
    assert.ok(poorRun.order && poorRun.notional <= 2.05, 'cash cap: ' + poorRun.notional);
    const cashAfter = poor.world.ledger.snapshot(poor.world.id).cashUsd;
    assert.ok(cashAfter >= 0, 'cash must never go negative: ' + cashAfter);

    // D5 position cap: a >25%-equity order with the default cap is DENIED (a brake, not a clamp),
    // which is why the live profile raises maxPositionPct to 0.6 (documented caveat).
    const tight = await v35SizingWorld({ equityUsd: 67.5, multiplier: 3, risk: { maxPositionPct: 0.25 } });
    const tightRun = await v35Enter(tight, 0.4);
    assert.equal(tightRun.result.orders.length, 0);
    assert.equal(tightRun.result.denied[0].code, 'SIZE_FORBIDDEN', JSON.stringify(tightRun.result.denied));
    assert.ok(tightRun.result.denied[0].reason.includes('0.25'), JSON.stringify(tightRun.result.denied[0]));
    assert.equal(tight.world.ledger.snapshot(tight.world.id).cashUsd, 67.5, 'a denied order books no cash');

    // The daily-order brake still binds regardless of size.
    const rate = await v35SizingWorld({ equityUsd: 67.5, multiplier: 3 });
    const rateRun = await v35Enter(rate, 0.4, { overrides: { mandate: { ...rate.mandate, maxDailyOrdersRemaining: 0 } } });
    assert.equal(rateRun.result.orders.length, 0);
    assert.equal(rateRun.result.denied[0].code, 'RATE_FORBIDDEN', JSON.stringify(rateRun.result.denied));
  });

  it('existing tiny positions are not force-resized; only new entries use the larger size', async () => {
    const worldInfo = await v35SizingWorld({ equityUsd: 67.5, multiplier: 3 });
    brokerFill(worldInfo.world, { side: 'buy', qty: 0.01 });
    const symbol = worldInfo.world.symbol;
    const before = worldInfo.world.ledger.snapshot(worldInfo.world.id).positions[symbol].qty;
    assert.ok(before > 0 && before < 0.5, 'seeded a tiny existing position: ' + before);
    const quote = worldInfo.world.broker.getLatestQuote(symbol);
    const result = await worldInfo.world.executor.run({
      agent: worldInfo.world.registry.get(worldInfo.world.id),
      spec: v35SizingSpec(worldInfo.world, 0.2),
      mandate: worldInfo.mandate,
      quotes: { [symbol]: quote },
      bars: { [symbol]: instrumentBars(quote.last, 1) },
      dayStats: { dayKey: '2026-01-05', ordersCount: 0, startEquityUsd: 67.5, pnlUsd: 0 },
      now: worldInfo.world.clock.now(),
      riskOnly: true,
    });
    assert.equal(result.orders.length, 0, 'risk-only passes never size or resize a position');
    const after = worldInfo.world.ledger.snapshot(worldInfo.world.id).positions[symbol].qty;
    assert.equal(after, before, 'an existing position is left alone (no forced resize)');
  });
});

describe('v3.5 aggressive opportunistic fallback (proven cross-family specs)', () => {
  it('aggressive fallback compiles the measured cross-family setup, flags it, and trades it under brakes', async () => {
    const world = await v35MarketWorld({
      hypotheses: [
        v35Hypothesis('MSFT', 'gapfade', { rank: 0.6 }),
        v35Hypothesis('NVDA', 'gapfade', { rank: 0.9 }),
      ],
    });
    assert.ok(world.aggressive, 'the cohort must contain one aggressive bot');
    assert.equal(world.aggressive.genome.family, 'breakout', 'genesis index 2 is the aggressive breakout bot');
    assert.equal(world.aggressive.genome.symbol, 'NVDA');
    const quote = world.broker.getLatestQuote('NVDA');
    v35PinMarket(world.broker, 'NVDA', round2(Number(quote.ask) || Number(quote.last)));

    const trace = await world.automaton.tick();
    assert.equal(trace.halted, false, JSON.stringify(trace.haltReasons));
    const build = trace.builds.find((entry) => entry.agentId === world.aggressive.id);
    assert.ok(build && build.specId, JSON.stringify(trace.builds));
    assert.equal(build.family, 'gapfade', 'fallback uses the other proven family');
    assert.equal(build.symbol, 'NVDA', 'fallback stays on an EXACT basket symbol');
    assert.equal(build.basket.includes('NVDA'), true);

    // Balanced bots had a gapfade hypothesis on MSFT in their baskets but must not cross families.
    for (const agent of world.nonAggressive) {
      const row = trace.builds.find((entry) => entry.agentId === agent.id);
      assert.ok(!row || row.skipped === 'no_matching_hypothesis', agent.name + ': ' + JSON.stringify(row));
    }

    const status = await world.automaton.status();
    const row = status.agents.find((agent) => agent.id === world.aggressive.id);
    assert.equal(row.specId, build.specId, 'a fallback spec on the PRIMARY genome symbol is the primary spec');
    assert.ok(row.spec);
    assert.equal(row.spec.fallback, true);
    assert.equal(row.spec.genomeFamily, 'breakout');
    assert.equal(row.spec.family, 'gapfade');
    assert.equal(row.spec.symbol, 'NVDA');
    // The measured setup: hypothesis-family defaults + hint + aggression multipliers, NOT the
    // breakout genome's lookback/entryZ/stop values.
    assert.equal(row.spec.params.lookback, 30, 'gapfade family default lookback');
    assert.equal(row.spec.params.entryZ, 0.7, 'gapfade default 1.0 x 0.70');
    assert.equal(row.spec.params.exitZ, 0.5);
    assert.equal(row.spec.params.stopPct, 0.012, 'gapfade 0.015 x 0.80');
    assert.equal(row.spec.params.targetPct, 0.03, 'gapfade 0.025 x 1.20');
    assert.equal(row.spec.params.maxHoldBars, 5, 'gapfade 6 x 0.75 rounded');
    assert.equal(row.spec.params.sizePct, 0.27, 'hint 0.2 x 1.35 profile');
    assert.equal(row.aggressionProfile.allowOpportunisticFallback, true);

    const specFile = readJsonFile(path.join(world.paths.specsDir, build.specId + '.json'));
    assert.equal(specFile.hypothesisId, 'hyp-v35-gapfade-NVDA-0_9-1');
    assert.equal(specFile.proofRef, 'https://data.alpaca.markets/v2/stocks/bars?symbols=NVDA');
    assert.equal(specFile.fallback, true);
    assert.equal(specFile.genomeFamily, 'breakout');

    // Executor: same profile/brakes, meaningful size, attribution to the fallback spec.
    const execution = trace.executions.find((entry) => entry.agentId === world.aggressive.id);
    assert.ok(execution, JSON.stringify(trace.executions));
    assert.equal(execution.specId, build.specId);
    assert.equal(execution.orders, 1, JSON.stringify(execution));
    assert.equal(execution.denied, 0, JSON.stringify(execution.denied));
    const orders = world.broker.getOrders({ status: 'all', limit: 50 });
    assert.equal(orders.length, 1);
    const order = orders[0];
    assert.equal(order.clientOrderId.includes(build.specId), true);
    const notional = round2(order.filledQty * order.avgFillPriceUsd);
    assert.ok(
      notional >= 0.3 * row.equityUsd && notional <= 0.51 * row.equityUsd,
      'fallback order $' + notional + ' vs equity $' + row.equityUsd,
    );
    // No new order surface: the broker order carries no spec/fallback/proof metadata.
    for (const forbidden of ['fallback', 'genomeFamily', 'proofRef', 'proof', 'hypothesisId', 'spec']) {
      assert.equal(Object.prototype.hasOwnProperty.call(order, forbidden), false, 'order must not carry ' + forbidden);
    }
    const book = world.internals.ledger.snapshot(world.aggressive.id);
    assert.equal(Object.keys(book.positions).includes('NVDA'), true);
    assert.ok(book.cashUsd >= 0, 'cash after entry: ' + book.cashUsd);
    assert.deepEqual(trace.errors, [], JSON.stringify(trace.errors));

    // Cached fallback reuse: a second cycle with the same fresh queue reuses the specIds cache,
    // keeps the fallback/genomeFamily markers, and does not fork a duplicate spec.
    const specCountAfterFirst = fs.readdirSync(world.paths.specsDir).length;
    world.clock.advance(CYCLE_MS);
    const secondTrace = await world.automaton.tick();
    const secondStatus = await world.automaton.status();
    const secondRow = secondStatus.agents.find((agent) => agent.id === world.aggressive.id);
    assert.equal(secondRow.specId, build.specId, 'cached primary fallback spec is reused');
    assert.equal(secondRow.spec.fallback, true);
    assert.equal(secondRow.spec.genomeFamily, 'breakout');
    assert.equal(fs.readdirSync(world.paths.specsDir).length, specCountAfterFirst, 'no duplicate spec on cache reuse');
    assert.equal(secondTrace.halted, false);
    assert.equal(secondTrace.errors.length, 0, JSON.stringify(secondTrace.errors));

    // Balanced/conservative status rows never carry fallback specs or the flag.
    for (const agent of status.agents.filter((entry) => entry.aggression !== 'aggressive')) {
      for (const spec of agent.specs) assert.equal(spec.fallback, false);
      assert.equal(agent.aggressionProfile.allowOpportunisticFallback, false);
    }
    assert.equal(status.engine.aggression.profiles.aggressive.allowOpportunisticFallback, true);
  });

  it('a basket-sibling spec never becomes the primary spec (v3.2 primary coherence preserved)', async () => {
    // D-V35-1 regression: the aggressive fallback change must not point agent.specId / status
    // `spec` at an own-family SIBLING basket spec. The sibling still trades via specIds/specs.
    const world = await v35MarketWorld({ hypotheses: [v35Hypothesis('F', 'breakout', { rank: 0.8 })] });
    assert.equal(world.aggressive.genome.symbol, 'NVDA', 'primary symbol has no hypothesis');
    assert.equal(world.aggressive.symbols.includes('F'), true, 'F is a basket sibling');
    const quote = world.broker.getLatestQuote('F');
    const base = round2(Number(quote.ask) || Number(quote.last));
    v35PinMarket(world.broker, 'F', base, v35BreakoutBars(base));
    const trace = await world.automaton.tick();
    assert.equal(trace.halted, false);
    const status = await world.automaton.status();
    const row = status.agents.find((agent) => agent.id === world.aggressive.id);
    assert.equal(row.specId, null, 'no spec on the genome symbol -> no primary specId');
    assert.equal(row.spec, null, 'status spec stays tied to the primary genome symbol');
    const sibling = row.specs.find((spec) => spec.symbol === 'F');
    assert.ok(sibling, JSON.stringify(row.specs));
    assert.equal(sibling.family, 'breakout', 'the sibling is the own family, not a fallback');
    assert.equal(sibling.fallback, false);
    const registryAgent = world.internals.registry.get(world.aggressive.id);
    assert.equal(registryAgent.specId, null);
    assert.equal(registryAgent.specIds.F, sibling.specId, 'the sibling spec is still cached and tradable');
    const execution = trace.executions.find((entry) => entry.agentId === world.aggressive.id);
    assert.ok(execution && execution.orders === 1, 'the executor still trades the sibling spec: ' + JSON.stringify(execution));
    assert.equal(execution.specId, sibling.specId);
    assert.equal(world.broker.getOrders({ status: 'all', limit: 50 })[0].symbol, 'F');
  });

  it('disabling allowOpportunisticFallback leaves aggressive bots idle on the same queue', async () => {
    const world = await v35MarketWorld({
      hypotheses: [v35Hypothesis('NVDA', 'gapfade', { rank: 0.9 })],
      aggression: { profiles: { aggressive: { allowOpportunisticFallback: false } } },
    });
    const quote = world.broker.getLatestQuote('NVDA');
    v35PinMarket(world.broker, 'NVDA', round2(Number(quote.ask) || Number(quote.last)));
    const trace = await world.automaton.tick();
    const build = trace.builds.find((entry) => entry.agentId === world.aggressive.id);
    assert.ok(build && build.skipped === 'no_matching_hypothesis', JSON.stringify(build));
    assert.equal(trace.executions.some((entry) => entry.agentId === world.aggressive.id), false);
    const status = await world.automaton.status();
    const row = status.agents.find((agent) => agent.id === world.aggressive.id);
    assert.equal(row.specs.length, 0);
    assert.equal(row.spec, null);
    assert.equal(row.aggressionProfile.allowOpportunisticFallback, false);
    assert.equal(status.engine.aggression.profiles.aggressive.allowOpportunisticFallback, false);
    assert.equal(world.broker.getOrders({ status: 'all', limit: 50 }).length, 0);
    for (const agent of status.agents.filter((entry) => entry.aggression !== 'aggressive')) {
      assert.equal(agent.specs.length, 0, 'balanced bots never fall back: ' + agent.name);
    }
  });

  it('fallback never trades a stale or unproven hypothesis (Builder D9 still binds)', async () => {
    const stale = await v35MarketWorld({ hypotheses: [v35Hypothesis('NVDA', 'gapfade', { ageHours: 8 * 24 })] });
    const staleTrace = await stale.automaton.tick();
    const staleBuild = staleTrace.builds.find((entry) => entry.agentId === stale.aggressive.id);
    assert.equal(staleBuild.error, 'PROOF_STALE', JSON.stringify(staleBuild));
    const staleStatus = await stale.automaton.status();
    const staleRow = staleStatus.agents.find((agent) => agent.id === stale.aggressive.id);
    assert.equal(staleRow.specs.length, 0);
    assert.equal(staleRow.spec, null);
    assert.equal(stale.broker.getOrders({ status: 'all', limit: 50 }).length, 0);
    assert.equal(fs.readdirSync(stale.paths.specsDir).length, 0, 'no spec may be persisted for a stale proof');

    const unproven = await v35MarketWorld({ hypotheses: [v35Hypothesis('NVDA', 'gapfade', { proof: false })] });
    const unprovenTrace = await unproven.automaton.tick();
    const unprovenBuild = unprovenTrace.builds.find((entry) => entry.agentId === unproven.aggressive.id);
    assert.equal(unprovenBuild.error, 'NO_PROOF', JSON.stringify(unprovenBuild));
    assert.equal(unproven.broker.getOrders({ status: 'all', limit: 50 }).length, 0);
    assert.equal(fs.readdirSync(unproven.paths.specsDir).length, 0, 'no spec may be persisted for an unproven hypothesis');
  });

  it('own-family specs win over fallback and a stale top fallback cannot mask a fresh lower one', async () => {
    const world = await v35MarketWorld({
      hypotheses: [
        v35Hypothesis('NVDA', 'breakout', { rank: 0.2 }), // own family, lower rank: still preferred
        v35Hypothesis('F', 'gapfade', { rank: 0.95, ageHours: 8 * 24 }), // stale top fallback candidate
        v35Hypothesis('F', 'gapfade', { rank: 0.9 }), // fresh same-family lower-ranked candidate
        v35Hypothesis('F', 'meanrev', { rank: 0.5 }), // other family, lower rank
      ],
    });
    const trace = await world.automaton.tick();
    const status = await world.automaton.status();
    const row = status.agents.find((agent) => agent.id === world.aggressive.id);
    assert.ok(row.spec, JSON.stringify(row));
    assert.equal(row.spec.symbol, 'NVDA', 'primary spec stays tied to the genome symbol');
    assert.equal(row.spec.family, 'breakout');
    assert.equal(row.spec.fallback, false, 'own-family specs are not flagged as fallback');
    assert.equal(row.specId, row.spec.specId);
    const fSpec = row.specs.find((spec) => spec.symbol === 'F');
    assert.ok(fSpec, JSON.stringify(row.specs));
    assert.equal(fSpec.family, 'gapfade', 'highest-ranked FRESH other-family candidate is used');
    assert.equal(fSpec.fallback, true);
    assert.equal(fSpec.genomeFamily, 'breakout');
    const fFile = readJsonFile(path.join(world.paths.specsDir, fSpec.specId + '.json'));
    assert.equal(fFile.hypothesisId, 'hyp-v35-gapfade-F-0_9-1');
    const execution = trace.executions.find((entry) => entry.agentId === world.aggressive.id);
    assert.ok(execution && execution.specs === 2, JSON.stringify(execution));
    assert.equal(trace.builds.some((entry) => entry.error === 'PROOF_STALE'), false, JSON.stringify(trace.builds));
  });

  it('narrow proven-edge queue: fallback covers most aggressive bots, balanced/conservative stay coherent', async () => {
    async function coverageWorld(allowFallback) {
      const env = v35Env({
        population: { initial: 30, cap: 60 },
        strategyMix: { dayPct: 0.7 },
        aggression: allowFallback
          ? { enabled: true }
          : { enabled: true, profiles: { aggressive: { allowOpportunisticFallback: false } } },
      });
      const clock = makeClock(T0);
      const broker = createSimBroker(env.config, { seed: 7, accountEquityUsd: 100000, clock });
      const automaton = await createAutomaton({ config: env.config, paths: env.paths, broker, clock });
      await automaton.init();
      automaton._internals.prospector.run = async () => ({
        hypotheses: [v35Hypothesis('SOFI', 'gapfade', { rank: 1 }), v35Hypothesis('AMZN', 'breakout', { rank: 0.4 })],
        spentUsd: 0,
        dataCalls: 0,
        rejected: [],
      });
      const trace = await automaton.tick();
      const status = await automaton.status();
      const aggressive = status.agents.filter((agent) => agent.aggression === 'aggressive');
      return {
        trace,
        status,
        aggressive,
        covered: aggressive.filter((agent) => agent.specs.length > 0),
        expectedCovered: aggressive.filter((agent) => agent.symbols.includes('SOFI') || agent.symbols.includes('AMZN')),
      };
    }

    const enabled = await coverageWorld(true);
    assert.equal(enabled.trace.halted, false);
    assert.equal(enabled.aggressive.length, 12);
    assert.deepEqual(enabled.status.engine.aggression.counts, { aggressive: 12, balanced: 13, conservative: 5 });
    assert.deepEqual(
      enabled.covered.map((agent) => agent.name).sort(),
      enabled.expectedCovered.map((agent) => agent.name).sort(),
      'every aggressive bot with a proven setup on a basket symbol gets a spec',
    );
    assert.ok(
      enabled.covered.some((agent) => agent.specs.some((spec) => spec.fallback)),
      'the narrow queue is covered partly by cross-family fallback specs',
    );
    for (const agent of enabled.status.agents.filter((entry) => entry.aggression !== 'aggressive')) {
      for (const spec of agent.specs) {
        assert.equal(spec.family, agent.genome.family, agent.name + ' must not cross families');
        assert.equal(spec.fallback, false);
      }
    }

    const disabled = await coverageWorld(false);
    const disabledExpected = disabled.covered.filter((agent) => (
      agent.genome.family === 'gapfade'
        ? agent.symbols.includes('SOFI')
        : agent.symbols.includes('AMZN')
    ));
    assert.deepEqual(
      disabled.covered.map((agent) => agent.name).sort(),
      disabledExpected.map((agent) => agent.name).sort(),
      'without fallback only own-family matches compile',
    );
    assert.equal(disabled.covered.some((agent) => agent.specs.some((spec) => spec.fallback)), false);
    assert.ok(
      enabled.covered.length > disabled.covered.length,
      'fallback coverage ' + enabled.covered.length + ' must exceed ' + disabled.covered.length,
    );
    assert.equal(disabled.status.engine.aggression.profiles.aggressive.allowOpportunisticFallback, false);
    assert.equal(enabled.status.engine.aggression.profiles.aggressive.allowOpportunisticFallback, true);
  });

  it('v3.5 status/config contract exposes the sizing scaler and fallback flags (no secrets)', async () => {
    const world = await v35MarketWorld({ hypotheses: [] });
    const status = await world.automaton.status();
    assert.equal(status.engine.aggression.profiles.aggressive.allowOpportunisticFallback, true);
    assert.equal(status.engine.aggression.profiles.balanced.allowOpportunisticFallback, undefined);
    assert.equal(status.engine.aggression.profiles.conservative.allowOpportunisticFallback, undefined);
    for (const agent of status.agents) {
      assert.equal(typeof agent.aggressionProfile.allowOpportunisticFallback, 'boolean');
      assert.equal(Array.isArray(agent.specs), true);
    }
    const view = publicConfig(world.config);
    assert.equal(view.risk.sizePctMultiplier, 3);
    assert.equal(view.risk.maxOrderNotionalUsd, 120);
    assert.equal(view.aggression.profiles.aggressive.allowOpportunisticFallback, true);
    assert.equal(JSON.stringify(view).includes('ALPACA_API_SECRET_KEY'), false);
  });
});





