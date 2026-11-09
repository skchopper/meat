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

import { loadConfig, statePaths, defaultConfig } from '../src/config.js';
import { createBroker as createSimBroker } from '../src/broker-sim.js';
import { createAutomaton, genesisGenome } from '../src/orchestrator.js';
import { createReaper } from '../src/reaper.js';
import { createEngine } from '../src/engine.js';
import { createJournal } from '../src/journal.js';
import { createLedger } from '../src/ledger.js';
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

async function runInstrumentExecutor(world, { policy = null, direction = 1, dayStats = null, spec = null, bars = null } = {}) {
  const quote = world.broker.getLatestQuote(world.symbol);
  return world.executor.run({
    agent: world.registry.get(world.id),
    spec: spec ?? instrumentSpec(world),
    mandate: {
      ...world.mandate,
      issuedAt: world.clock.iso(),
      expiresAt: new Date(world.clock.now() + 10 * 60 * 1000).toISOString(),
    },
    quotes: { [world.symbol]: quote },
    bars: { [world.symbol]: bars ?? instrumentBars(quote.last, direction) },
    dayStats: dayStats ?? { dayKey: '2026-01-05', ordersCount: 0, startEquityUsd: world.endowmentUsd, pnlUsd: 0 },
    now: world.clock.now(),
    policy,
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
