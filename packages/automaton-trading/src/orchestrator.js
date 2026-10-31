/**
 * Orchestrator: composes the six roles into one cycle loop.
 * Owned by the Lead.
 *
 * The loop is deliberately boring: read the market once, let the Treasurer price the
 * population, let the Prospector/BUILDER produce executable specs, let the Executor
 * trade inside the mandate, let the Replicator breed, and record verdicts. Death
 * itself is NOT executed here — the external Reaper does that from its own process.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { statePaths, liveArmed } from './config.js';
import { HYPOTHESIS_FAMILIES } from './contracts.js';
import {
  createLogger,
  createClock,
  ensureDir,
  errorInfo,
  mulberry32,
  newId,
  readJson,
  round2,
  round4,
  safeJson,
  dayKey,
  writeJsonAtomic,
  appendJsonl,
} from './util.js';
import { createJournal } from './journal.js';
import { createRegistry } from './registry.js';
import { createLedger } from './ledger.js';
import { createBrakes } from './brakes.js';
import { createTreasurer } from './treasurer.js';
import { createReplicator } from './replicator.js';
import { createProspector } from './prospector.js';
import { createBuilder } from './builder.js';
import { createExecutor } from './executor.js';
import { createBotAgents } from './bot-agent.js';
import { createRankings, periodKeyEndMs } from './rankings.js';
import { createReaper } from './reaper.js';
import { createResearcher } from './research.js';
import { createRewards } from './rewards.js';
import { explainAgentPlan } from './strategy-explain.js';
import { resolveStrategyType, strategyMix as computeStrategyMix, targetFamilyForIndex, tierForFamily } from './strategy-types.js';
import {
  agentInstrumentPermissions,
  playbookForFamily,
  playbookView,
  resolveInstrumentPermissions,
} from './instruments.js';
import { nextAgentName, usedNames } from './naming.js';

const log = createLogger('automaton');

const DEFAULT_GENOME = {
  family: 'momentum',
  lookback: 20,
  entryZ: 1.2,
  exitZ: 0.3,
  stopPct: 0.02,
  targetPct: 0.04,
  maxHoldBars: 8,
  sizePct: 0.15,
  sessionFilter: 'any',
};

const GENOME_LOOKBACKS = [10, 15, 20, 30, 40, 60];
const GENOME_HOLDS = [4, 6, 8, 12, 24];
const GENOME_SESSIONS = ['any', 'morning', 'afternoon'];

/**
 * Build a distinct, deterministic genome for each genesis agent.
 * - the (symbol, family) pair is unique for the first symbols x families agents, so with
 *   30 agents on 10 symbols every agent inherits a different strategy family/symbol;
 * - the numeric parameters are seeded-random within live-tradeable bounds, so no two
 *   agents are clones even when a later generation re-uses a pair;
 * - deterministic in (config.engine.seed, index): restarting the engine never reshuffles
 *   the population's genes.
 */
function genesisGenome(config, index) {
  const symbols = config.symbols.length > 0 ? config.symbols : ['SPY'];
  const seed = Number(config.engine?.seed ?? 7) >>> 0;
  const rng = mulberry32((seed * 2654435761 + index * 40503 + 1) >>> 0);
  // Balanced population mix (docs/BOT-AGENTS.md): half swing (momentum/meanrev, 1-hour lane) and
  // half day (breakout/gapfade, 1-minute lane); the tier is implied by the family.
  const family = targetFamilyForIndex(index, Math.max(1, Number(config.population?.initial) || 30));
  const symbol = symbols[index % symbols.length];
  const round = (value, digits) => {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  };
  return {
    ...DEFAULT_GENOME,
    symbol,
    family,
    lookback: GENOME_LOOKBACKS[Math.floor(rng() * GENOME_LOOKBACKS.length)],
    entryZ: round(0.8 + rng() * 1.4, 2),
    exitZ: round(0.1 + rng() * 0.7, 2),
    stopPct: round(0.01 + rng() * 0.03, 4),
    targetPct: round(0.02 + rng() * 0.06, 4),
    maxHoldBars: GENOME_HOLDS[Math.floor(rng() * GENOME_HOLDS.length)],
    // Never below 0.12: with a $20 endowment the mandate cap is ~$10, and a $1 minimum
    // notional means a smaller sizePct would round the order away.
    sizePct: round(0.12 + rng() * 0.23, 3),
    sessionFilter: GENOME_SESSIONS[Math.floor(rng() * GENOME_SESSIONS.length)],
  };
}

/** Last close (or last/ask fallback) per symbol, used for marking positions. */
function pricesFromBars(bars) {
  const prices = {};
  for (const [symbol, series] of Object.entries(bars ?? {})) {
    const last = Array.isArray(series) && series.length > 0 ? series[series.length - 1] : null;
    if (last && Number.isFinite(Number(last.c))) prices[symbol] = Number(last.c);
  }
  return prices;
}

/**
 * Resolve the per-tier execution cadence. With `cadence: null` (the default) both tiers fall back
 * to the legacy single cadence (`cycleIntervalSec` + `data.timeframe`) so existing tests and CLI
 * runs keep evaluating every agent every cycle. A configured cadence gives 'day' bots an intraday
 * lane and 'swing' bots a slower mid/long-term lane.
 */
function resolveExecutionCadence(config) {
  const legacy = {
    intervalSec: Math.max(5, Number(config.cycleIntervalSec) || 300),
    timeframe: config.data?.timeframe ?? '1Hour',
  };
  const cadence = config.cadence && typeof config.cadence === 'object' ? config.cadence : null;
  if (!cadence) return { day: { ...legacy }, swing: { ...legacy } };
  return {
    day: {
      intervalSec: Math.max(5, Number(cadence.day?.intervalSec) || legacy.intervalSec),
      timeframe: cadence.day?.timeframe ?? legacy.timeframe,
    },
    swing: {
      intervalSec: Math.max(5, Number(cadence.swing?.intervalSec) || 3600),
      timeframe: cadence.swing?.timeframe ?? legacy.timeframe,
    },
  };
}

/** Quotes for the executor: real bid/ask when the broker has them, otherwise a tight synthetic spread. */
async function readQuotes(broker, symbols, prices, feed) {
  const quotes = {};
  await Promise.all(
    symbols.map(async (symbol) => {
      const last = prices[symbol];
      try {
        const quote = await broker.getLatestQuote(symbol, feed ? { feed } : undefined);
        if (quote && Number.isFinite(Number(quote.ask)) && Number.isFinite(Number(quote.bid)) && Number(quote.ask) > 0) {
          quotes[symbol] = {
            bid: round2(Number(quote.bid)),
            ask: round2(Number(quote.ask)),
            last: round2(Number(quote.last) || last || Number(quote.ask)),
            ts: quote.ts ?? null,
          };
          return;
        }
      } catch {
        /* fall back to bar close */
      }
      if (Number.isFinite(last) && last > 0) {
        const half = Math.max(0.005, last * 0.00005); // ~1bp synthetic spread for marking/brake context
        quotes[symbol] = {
          bid: round2(last - half),
          ask: round2(last + half),
          last: round2(last),
          ts: null,
          synthetic: true,
        };
      }
    }),
  );
  return quotes;
}

/**
 * Compose the population engine.
 * @param {{
 *   config: object,
 *   paths?: object,
 *   broker: object,
 *   clock?: { now: () => number, iso: () => string },
 *   logger?: object,
 * }} options
 */
export async function createAutomaton(options = {}) {
  const { config, broker } = options;
  if (!config) throw new Error('createAutomaton requires config');
  if (!broker) throw new Error('createAutomaton requires a broker');
  const paths = options.paths ?? statePaths(config);
  const clock = options.clock ?? createClock();

  const journal = createJournal({ paths, config });
  const registry = createRegistry({ paths, config });
  const ledger = createLedger({ paths, config, clock });
  const brakes = createBrakes({ config, paths, clock });
  const treasurer = createTreasurer({ broker, ledger, registry, journal, config, paths, clock });
  const replicator = createReplicator({ treasurer, registry, ledger, journal, config, clock });
  const prospector = createProspector({ broker, config, journal, clock, paths });
  const builder = createBuilder({ config, brakes, clock });
  const executor = createExecutor({ broker, brakes, ledger, config, clock });

  const state = {
    initialized: false,
    running: false,
    ticking: false,
    ticks: 0,
    errors: 0,
    lastTickAt: null,
    lastError: null,
    lastTrace: null,
    lastTreasury: null,
    lastQuotes: null,
    lastPrices: null,
    lastMarketOpen: null,
    lastMarketClock: null,
    specs: new Map(),
    condemned: new Set(),
    inProcessReaper: null,
    // Per-agent last FULL analysis time (ms) for the two execution tiers. In-memory only: after a
    // restart every bot is analysed once immediately, which is the safe behaviour.
    lastAnalysisAt: new Map(),
    dayStats: { dayKey: null, agents: {} },
    timer: null,
  };

  // Per-agent isolated research sidecar (docs/RESEARCH.md). `generate` is injected by the
  // Harness plugin (LLM bridge) or the CLI HTTP fallback; without it research is disabled and
  // trading behaves exactly as before.
  const researchGenerate = options.researchGenerate ?? options.generate ?? null;
  const researcher = createResearcher({
    broker,
    registry,
    ledger,
    config,
    paths,
    clock,
    generate: typeof researchGenerate === 'function' ? researchGenerate : undefined,
    specFor: (agentId) => {
      const agent = registry.get(agentId);
      return agent?.specId ? state.specs.get(agent.specId) ?? null : null;
    },
  });

  // Period leaderboards + operator-configured virtual cash rewards (docs/CONTROL-PANEL.md).
  const rankings = createRankings({ paths, config, clock });
  let operatorRewardsConfig = { ...(config.rewards ?? {}) };
  let rewards = createRewards({ paths, config: { ...config, rewards: operatorRewardsConfig }, clock });

  // Per-bot agent brain (docs/BOT-AGENTS.md): each living bot gets its own isolated LLM review on
  // its cadence and writes a policy the Executor consumes. Same LLM seam as the research sidecar.
  const agentGenerate = options.agentGenerate ?? options.researchGenerate ?? options.generate ?? null;
  const specLookup = (agentId) => {
    const agent = registry.get(agentId);
    return agent?.specId ? state.specs.get(agent.specId) ?? null : null;
  };
  const botAgents = createBotAgents({
    config,
    paths,
    clock,
    registry,
    ledger,
    broker,
    researcher,
    generate: typeof agentGenerate === 'function' ? agentGenerate : undefined,
    specFor: specLookup,
  });

  // -------------------------------------------------------------------------
  // persistence helpers
  // -------------------------------------------------------------------------

  async function loadDayStats(nowMs) {
    const saved = await readJson(paths.dayStats, null);
    const today = dayKey(nowMs, config.timeZone);
    if (saved && saved.dayKey === today && saved.agents) {
      state.dayStats = saved;
    } else {
      state.dayStats = { dayKey: today, agents: {} };
    }
    return state.dayStats;
  }

  async function saveDayStats() {
    await writeJsonAtomic(paths.dayStats, state.dayStats);
  }

  function dayStatsFor(agentId) {
    const entry = state.dayStats.agents[agentId] ?? { ordersCount: 0, startEquityUsd: null };
    const view = (state.lastTreasury?.agentViews ?? []).find((item) => item.agentId === agentId);
    const startEquityUsd = entry.startEquityUsd ?? view?.equityUsd ?? null;
    const pnlUsd =
      Number.isFinite(Number(view?.equityUsd)) && Number.isFinite(Number(startEquityUsd))
        ? Number(view.equityUsd) - Number(startEquityUsd)
        : 0;
    return {
      dayKey: state.dayStats.dayKey,
      ordersCount: entry.ordersCount ?? 0,
      startEquityUsd,
      pnlUsd: round2(pnlUsd),
    };
  }

  async function writeStateFile(snapshot) {
    await writeJsonAtomic(paths.stateFile, snapshot);
  }

  async function appendTrace(trace) {
    await appendJsonl(paths.traces, trace);
  }

  function genomeForSpec(agent) {
    return agent?.genome ?? null;
  }

  /**
   * Choose the hypothesis this agent will trade this cycle.
   * Preference chain keeps the population diverse instead of collapsing every agent
   * onto the single highest-ranked hypothesis:
   *   1. exact symbol+family match for the agent's inherited genome
   *   2. same family (genome's strategy family), any symbol
   *   3. a hypothesis no other agent is already using this cycle
   *   4. the top-ranked hypothesis
   */
  async function ensureSpec(agent, hypotheses, cycleBudgetUsd, usedPairs = new Set()) {
    const cached = agent.specId ? state.specs.get(agent.specId) : null;
    const genome = genomeForSpec(agent);
    const specMatchesGenome = (candidate) => Boolean(
      candidate && (!genome || (candidate.symbol === genome.symbol && candidate.family === genome.family)),
    );
    if (cached) {
      // A spec is executable only while its proof is fresh. Recompile from this cycle's
      // hypotheses when the proof has aged past half of maxProofAgeDays, but never
      // mid-position: exits must use the spec that opened the trade.
      const proofAgeMs = clock.now() - (Date.parse(cached.createdAt ?? '') || 0);
      const maxSpecAgeMs = Math.min(
        ((Number(config.data?.maxProofAgeDays) || 7) * 24 * 60 * 60 * 1000) / 2,
        12 * 60 * 60 * 1000,
      );
      const book = ledger.book?.(agent.id);
      const hasPosition = Boolean(book && Object.keys(book.positions ?? {}).length > 0);
      // A cached spec compiled from an unrelated family/symbol is not this bot's strategy: drop it
      // and recompile from the genome unless a position opened under it still needs managing.
      if (specMatchesGenome(cached) || hasPosition) {
        if (!Number.isFinite(proofAgeMs) || proofAgeMs <= maxSpecAgeMs || hasPosition) {
          return { spec: cached, cached: true };
        }
      }
    }
    const ranked = [...(hypotheses ?? [])].sort((a, b) => (b.rankScore ?? 0) - (a.rankScore ?? 0));
    if (ranked.length === 0) return null;
    const pairKey = (hypothesis) => `${hypothesis.symbol}:${hypothesis.family}`;
    const exact = ranked.find((h) => h.symbol === genome?.symbol && h.family === genome?.family);
    // Stay coherent with the agent's inherited strategy: exact genome pair first, then another
    // symbol of the SAME family. Never compile an unrelated strategy into this bot (the old
    // "unused pair"/"top ranked" fallbacks caused Momentum F to trade AMD breakout setups).
    const sameFamilyUnused = ranked.find((h) => h.family === genome?.family && !usedPairs.has(pairKey(h)));
    const sameFamily = ranked.find((h) => h.family === genome?.family);
    const match = exact ?? sameFamilyUnused ?? sameFamily ?? null;
    if (!match) return { __noMatch: true };
    usedPairs.add(pairKey(match));
    try {
      const compiled = await builder.compile({
        hypothesis: match,
        agentId: agent.id,
        cycleBudgetUsd,
        genome,
      });
      const spec = compiled?.spec ?? compiled;
      if (!spec || !spec.specId) return null;
      // Builder may still derive from the hypothesis; reject unrelated results rather than
      // silently trading a different strategy.
      if (!specMatchesGenome(spec)) return { __noMatch: true };
      await ensureDir(paths.specsDir);
      await writeJsonAtomic(path.join(paths.specsDir, `${spec.specId}.json`), spec);
      state.specs.set(spec.specId, spec);
      await registry.update(agent.id, { specId: spec.specId });
      return { spec, cached: false };
    } catch (error) {
      return { __compileError: errorInfo(error), hypothesisId: match?.id };
    }
  }

  /** Charge one cycle of metabolism to one agent, attributed by role. */
  async function chargeCycleCosts(agent) {
    const cycleHours = config.cycleIntervalSec / 3600;
    const hostingUsd = (config.burn.hostingPerHourUsd + config.burn.committedMonthlyUsd / 730) * cycleHours;
    const inference = config.burn.inferencePerCycleUsd;
    const data = config.burn.dataPerCycleUsd;
    const charges = [
      { amount: hostingUsd, category: 'hosting', role: 'treasurer' },
      { amount: data, category: 'data', role: 'prospector' },
      { amount: inference * 0.4, category: 'inference', role: 'prospector' },
      { amount: inference * 0.25, category: 'inference', role: 'builder' },
      { amount: inference * 0.3, category: 'inference', role: 'executor' },
      { amount: inference * 0.05, category: 'inference', role: 'treasurer' },
    ];
    for (const charge of charges) {
      if (!(charge.amount > 0)) continue;
      try {
        await ledger.charge(agent.id, charge.amount, {
          category: charge.category,
          role: charge.role,
          ref: `cycle:${state.ticks + 1}`,
          at: clock.now(),
        });
      } catch (error) {
        if (error?.code === 'INSUFFICIENT_CASH') {
          // The metabolism cannot be paid — the Treasurer will declare death this cycle.
          return;
        }
        throw error;
      }
    }
  }

  // -------------------------------------------------------------------------
  // init / seed
  // -------------------------------------------------------------------------

  async function seedGenesis(accountEquityUsd) {
    if (registry.population() > 0) return;
    const count = Math.max(0, Number(config.population.initial) || 0);
    const required = count * config.endowmentUsd;
    const cap = accountEquityUsd * config.account.allocationCapPct;
    if (required > cap) {
      const error = new Error(
        `initial population needs ${round2(required)} USD but the allocation cap is ${round2(cap)} USD ` +
          `(account ${round2(accountEquityUsd)} x ${config.account.allocationCapPct}). ` +
          'Lower population.initial, endowmentUsd, or raise account.allocationCapPct.',
      );
      error.code = 'CONFIG_INVALID';
      throw error;
    }
    for (let i = 0; i < count; i += 1) {
      const genome = genesisGenome(config, i);
      const agent = await registry.register({
        id: registry.nextId(),
        name: nextAgentName(genome, usedNames(registry.all())),
        parentId: null,
        generation: 0,
        bornAt: clock.iso(),
        status: 'alive',
        endowmentUsd: config.endowmentUsd,
        genome,
        mutation: null,
        specId: null,
        // Split the genesis population across the two execution tiers (docs/CONTROL-PANEL.md):
        // 'day' bots are evaluated on the intraday cadence (default 1 min), 'swing' bots on the
        // mid/long-term cadence (default 1 h). Children inherit their parent's tier.
        // Tier is implied by the strategy family: swing families (momentum/meanrev) trade the
        // 1-hour lane, day families (breakout/gapfade) the intraday lane.
        tier: tierForFamily(genome.family),
        notes: ['genesis'],
      });
      await ledger.ensureAgent(agent.id, { endowmentUsd: config.endowmentUsd, at: clock.now() });
      await treasurer.grantInitial(agent.id, config.endowmentUsd);
      state.dayStats.agents[agent.id] = { ordersCount: 0, startEquityUsd: config.endowmentUsd };
    }
    await registry.save();
    await ledger.save();
    log.info('genesis population seeded', { count, endowmentUsd: config.endowmentUsd });
  }

  /**
   * Operators see strategy-derived names, not random ids. Agents created before naming
   * existed are backfilled deterministically (living agents only; dead records are immutable
   * and their name is optional).
   */
  async function backfillAgentNames() {
    const agents = registry.all().filter((agent) => agent.status === 'alive' && !agent.name);
    if (agents.length === 0) return;
    const taken = usedNames(registry.all());
    let changed = 0;
    for (const agent of agents) {
      const name = nextAgentName(agent.genome ?? {}, [...taken]);
      taken.push(name);
      try {
        await registry.update(agent.id, { name });
        changed += 1;
      } catch {
        /* a dead/immutable record keeps its id as its label */
      }
    }
    if (changed > 0) {
      await registry.save();
      log.info('agent names backfilled', { count: changed });
    }
  }

  /**
   * Backfill the execution tier for agents created before tiers existed. The tier is derived from
   * the strategy family (swing: momentum/meanrev, day: breakout/gapfade) so the population is
   * always categorised by its real strategy type.
   */
  async function backfillAgentTiers() {
    const agents = registry.alive().filter((agent) => {
      const expected = tierForFamily(agent?.genome?.family);
      return agent.tier !== expected;
    });
    if (agents.length === 0) return;
    let changed = 0;
    for (const agent of agents) {
      try {
        await registry.update(agent.id, { tier: tierForFamily(agent?.genome?.family) });
        changed += 1;
      } catch {
        /* dead/immutable records keep their default tier */
      }
    }
    if (changed > 0) {
      await registry.save();
      log.info('agent tiers aligned to strategy family', { count: changed });
    }
  }

  /**
   * One-time strategy-mix adjustment for a population seeded before the taxonomy existed: if the
   * living population is lopsided (e.g. all momentum/meanrev), deterministically reassign genomes so
   * roughly half the bots trade swing strategies and half trade day strategies. Specs are cleared
   * and strategy-derived names refreshed; ids, ledgers, positions and history are untouched.
   */
  async function rebalanceStrategyMix() {
    const alive = registry.alive();
    if (alive.length < 8) return;
    const counts = { swing: 0, day: 0 };
    for (const agent of alive) counts[tierForFamily(agent?.genome?.family)] += 1;
    const swingRatio = counts.swing / alive.length;
    if (swingRatio >= 0.4 && swingRatio <= 0.6) return;
    let changed = 0;
    for (let index = 0; index < alive.length; index += 1) {
      const agent = alive[index];
      const target = targetFamilyForIndex(index, alive.length);
      if ((agent?.genome?.family ?? null) === target) continue;
      const genome = { ...(agent.genome ?? {}), family: target };
      const patch = { genome, tier: tierForFamily(target), specId: null };
      try {
        if (agent.name) {
          const taken = usedNames(registry.all().filter((candidate) => candidate.id !== agent.id));
          patch.name = nextAgentName(genome, taken);
        }
        await registry.update(agent.id, patch);
        changed += 1;
      } catch {
        /* immutable/dead records are skipped */
      }
    }
    if (changed > 0) {
      await registry.save();
      log.info('strategy mix rebalanced', { changed, population: alive.length, before: counts });
    }
  }

  /**
   * One-time v3.0 symbol-coverage migration: dashboards and the option/short playbooks are more
   * useful when part of the population trades affordable underlyings (whole-share shorts and
   * sub-$25 option contracts). Every third living bot (up to two per affordable symbol) is
   * re-pointed at F/SOFI/BAC/INTC; specs recompile and strategy-derived names refresh, while ids,
   * ledgers and existing positions are untouched (positions keep being managed by the exit pass).
   * A state-dir marker makes this idempotent.
   */
  async function introduceAffordableSymbols() {
    if (config.instruments?.enabled !== true) return;
    const affordable = ['F', 'SOFI', 'BAC', 'INTC'].filter((symbol) => config.symbols.includes(symbol));
    if (!affordable.length) return;
    const marker = path.join(paths.stateDir, 'instruments-v3-symbols.json');
    const already = await readJson(marker, null);
    if (already?.version === 1) return;
    const alive = registry.alive();
    if (alive.length < 6) return;
    const target = Math.min(affordable.length * 2, Math.floor(alive.length / 3));
    let assigned = 0;
    for (let index = 0; index < alive.length && assigned < target; index += 1) {
      const agent = alive[index];
      if (index % 3 !== 0) continue;
      const symbol = affordable[assigned % affordable.length];
      if ((agent?.genome?.symbol ?? null) === symbol) {
        assigned += 1;
        continue;
      }
      const genome = { ...(agent.genome ?? {}), symbol };
      try {
        const taken = usedNames(registry.all().filter((candidate) => candidate.id !== agent.id));
        await registry.update(agent.id, {
          genome,
          specId: null,
          name: nextAgentName(genome, taken),
        });
        assigned += 1;
      } catch {
        /* immutable/dead records are skipped */
      }
    }
    if (assigned > 0) {
      await registry.save();
      await writeJsonAtomic(marker, { version: 1, at: clock.iso(), assigned });
      log.info('affordable instrument symbols introduced', { assigned, symbols: affordable });
    }
  }

  /**
   * One-time capital top-up when the operator raises `endowmentUsd` (v3: bots moved from $20 to
   * $50 so short/option/margin tools are usable). The extra capital is REALLOCATED from the
   * unallocated treasury pool, never created: sum(bot equity) + pool must stay equal to broker
   * equity or the Treasurer's reconciliation halts the population. Updates the bot's endowment
   * basis too (so the top-up is not counted as trading profit). Idempotent: no deficit → no move.
   */
  async function capitalizePopulation(accountEquityUsd) {
    const target = Math.max(0, Number(config.endowmentUsd) || 0);
    const alive = registry.alive();
    if (!alive.length || !(target > 0)) return;
    const deficits = alive
      .map((agent) => ({ agent, deficit: round2(target - (Number(agent.endowmentUsd) || 0)) }))
      .filter((entry) => entry.deficit > 0.009);
    if (!deficits.length) return;
    if (typeof ledger.transfer !== 'function' || typeof ledger.anchorToBrokerEquity !== 'function') {
      log.warn('capital top-up skipped: ledger transfer/anchor API not available');
      return;
    }
    const accountEquity = Math.max(0, Number(accountEquityUsd) || 0);
    if (!(accountEquity > 0)) return;
    // The pool only exists after the broker-equity anchor; do it here so the top-up can move money
    // from the unallocated side instead of minting virtual cash.
    if (typeof ledger.isAnchored === 'function' && !ledger.isAnchored()) {
      try {
        ledger.anchorToBrokerEquity(accountEquity);
      } catch {
        /* fall through: pool() returns zero and no top-up happens */
      }
    }
    const cap = accountEquity * Number(config.account?.allocationCapPct ?? 0.8);
    const pool = typeof ledger.pool === 'function' ? ledger.pool() : { poolUsd: 0, allocatedUsd: 0 };
    const totalDeficit = deficits.reduce((sum, entry) => sum + entry.deficit, 0);
    const available = Math.max(0, Math.min(cap - Number(pool.allocatedUsd || 0), Number(pool.poolUsd || 0)));
    const budget = Math.min(totalDeficit, available);
    if (!(budget > 0)) return;
    const scale = budget / totalDeficit;
    let credited = 0;
    let changed = 0;
    for (const { agent, deficit } of deficits) {
      const amount = round2(deficit * scale);
      if (!(amount > 0)) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        ledger.transfer('__treasury__', agent.id, amount, {
          reason: 'v3.0 capital top-up',
          at: clock.now(),
        });
        // eslint-disable-next-line no-await-in-loop
        await registry.update(agent.id, { endowmentUsd: round2((Number(agent.endowmentUsd) || 0) + amount) });
        credited = round2(credited + amount);
        changed += 1;
      } catch (error) {
        log.warn('capital top-up failed', { agentId: agent.id, error: String(error?.message ?? error) });
      }
    }
    if (changed > 0) {
      await ledger.save();
      await registry.save();
      log.info('capital reallocated from treasury pool', { agents: changed, creditedUsd: credited, targetEndowmentUsd: target });
    }
  }

  /**
   * One-time v3.1 cleanup: bots whose cached spec was compiled from an unrelated family/symbol
   * (the old builder fallback could put "Momentum F" on an AMD breakout spec) get their specId
   * cleared so the next due evaluation recompiles a coherent strategy. Agents holding a position
   * keep their opening spec so the exit rules continue to match the trade.
   */
  async function alignSpecsToGenomes() {
    const alive = registry.alive();
    let changed = 0;
    for (const agent of alive) {
      if (!agent.specId) continue;
      const spec = state.specs.get(agent.specId);
      const genome = agent.genome;
      if (!spec || !genome) continue;
      if (spec.symbol === genome.symbol && spec.family === genome.family) continue;
      let hasPosition = false;
      try {
        const book = ledger.book?.(agent.id);
        hasPosition = Boolean(book && Object.keys(book.positions ?? {}).length > 0);
      } catch {
        hasPosition = false;
      }
      if (hasPosition) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await registry.update(agent.id, { specId: null });
        changed += 1;
      } catch {
        /* immutable/dead record */
      }
    }
    if (changed > 0) {
      await registry.save();
      log.info('misaligned strategy specs cleared', { count: changed });
    }
  }

  async function init() {
    if (state.initialized) return;
    await ensureDir(paths.stateDir);
    await ensureDir(paths.specsDir);
    await registry.load();
    await ledger.load();
    await loadDayStats(clock.now());
    await researcher.init();
    await botAgents.init();
    await rankings.load();
    await rewards.load();
    // Reload compiled specs from disk so a restart does not silently drop strategies.
    try {
      const specFiles = (await fsp.readdir(paths.specsDir)).filter((file) => file.endsWith('.json'));
      for (const file of specFiles) {
        const spec = await readJson(path.join(paths.specsDir, file), null);
        if (spec && spec.specId) state.specs.set(spec.specId, spec);
      }
    } catch {
      /* specs dir may be missing on a first run */
    }
    const account = await broker.getAccount();
    await seedGenesis(Number(account?.equityUsd) || 0);
    await backfillAgentNames();
    await backfillAgentTiers();
    await rebalanceStrategyMix();
    await introduceAffordableSymbols();
    await capitalizePopulation(Number(account?.equityUsd) || 0);
    await alignSpecsToGenomes();
    state.initialized = true;
    const snapshot = await buildSnapshot({ account, treasury: null, halted: false, haltReasons: [] });
    await writeStateFile(snapshot);
    log.info('automaton ready', {
      mode: config.mode,
      population: registry.population(),
      accountEquityUsd: round2(Number(account?.equityUsd) || 0),
    });
  }

  // -------------------------------------------------------------------------
  // the cycle
  // -------------------------------------------------------------------------

  /**
   * Run the isolated research sidecar for one cycle (cheap; also used by the off-hours
   * maintenance pass so pre-open/post-close briefings still fire when trading is paused).
   */
  async function runResearchPhase(trace, marketClock, halted = false) {
    if (halted) return;
    try {
      const researchRun = await researcher.tick({ marketClock });
      trace.research = {
        enabled: researchRun.enabled,
        configured: researchRun.configured,
        due: researchRun.due,
        ran: researchRun.ran.length,
        deferred: researchRun.deferred ?? 0,
        skipped: researchRun.skipped,
        errors: researchRun.ran.filter((entry) => entry.error).length,
        budgetUsd: round4(researchRun.ran.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0)),
      };
      if (!researchRun.enabled || !researchRun.configured) {
        trace.research.note = !researchRun.enabled ? 'disabled by config' : 'no LLM generator configured';
      }
      if (researchRun.paused) {
        trace.research.paused = true;
        trace.research.pausedUntil = researchRun.pausedUntil ?? null;
        trace.research.note = researchRun.note ?? 'paused after provider error';
      }
      if ((researchRun.ran ?? []).some((entry) => entry.costUsd > 0)) await ledger.save();
    } catch (error) {
      trace.errors.push({ role: 'research', ...errorInfo(error) });
    }
  }

  async function tick() {
    if (state.ticking) return state.lastTrace ?? { skipped: 'tick_in_progress' };
    state.ticking = true;
    const startedAt = clock.now();
    const tickId = newId('tick');
    const trace = {
      tickId,
      at: new Date(startedAt).toISOString(),
      mode: config.mode,
      durationMs: 0,
      halted: false,
      haltReasons: [],
      account: null,
      treasury: null,
      market: { symbols: 0, bars: 0, quotes: 0 },
      prospector: null,
      research: null,
      builds: [],
      executions: [],
      replication: null,
      rewards: null,
      deaths: [],
      errors: [],
    };
    try {
      if (!state.initialized) await init();

      // D11 kill switch: checked before anything can spend or trade.
      try {
        brakes.assertKillSwitchClear();
      } catch (error) {
        trace.halted = true;
        trace.haltReasons.push(errorInfo(error).code ?? 'KILL_SWITCH');
        state.lastTrace = trace;
        return trace;
      }

      // Re-sync with disk before spending or trading: the external Reaper may have killed
      // agents and swept their residual cash since the last cycle. Disk is the truth; this
      // in-memory population must never keep trading an agent the Reaper has executed.
      try {
        await registry.load();
        await ledger.load();
      } catch (error) {
        trace.errors.push({ role: 'store', ...errorInfo(error) });
      }
      for (const agentId of [...state.condemned]) {
        if (registry.get(agentId)?.status === 'dead') state.condemned.delete(agentId);
      }
      state.ticks += 1;

      // 1. market snapshot (one data read for the whole population).
      // The broker clock is authoritative for D3: a weekday time-window check alone would
      // happily trade on a Saturday. A clock failure is not fatal (sim has none) but it
      // leaves marketOpen unknown, and the brakes then fall back to the window check.
      let marketClock = null;
      try {
        marketClock = await broker.getClock?.();
      } catch (error) {
        trace.errors.push({ role: 'clock', ...errorInfo(error) });
      }
      const marketOpen = marketClock && typeof marketClock.isOpen === 'boolean' ? marketClock.isOpen : null;
      state.lastMarketClock = marketClock;
      state.lastMarketOpen = marketOpen;
      trace.marketOpen = marketOpen;
      if (marketOpen === false) {
        // Still price the population and record exits, but no new entries: the brakes get
        // marketOpen=false and deny every order with D3.
        trace.marketClosed = true;
      }
      const tradingHoursOnly = config.engine?.tradingHoursOnly === true;
      if (tradingHoursOnly && marketOpen === false) {
        // Off-hours maintenance pass (docs/RUNBOOK §8b): no market-data fetch, no per-cycle
        // charges, no prospector/builder/executor/replication — only the research sidecar
        // (so pre-open/post-close briefings still fire) and a status snapshot. This keeps the
        // price-monitoring loop inside trading hours while the engine stays warm.
        trace.tradingSkipped = true;
        trace.market = { symbols: 0, bars: 0, quotes: 0, skipped: true };
        await runResearchPhase(trace, marketClock, false);
        state.lastTickAt = new Date(clock.now()).toISOString();
        state.lastTrace = trace;
        state.lastError = null;
        let account = null;
        try {
          account = await broker.getAccount?.();
        } catch {
          account = null;
        }
        const snapshot = await buildSnapshot({
          account,
          treasury: state.lastTreasury,
          halted: false,
          haltReasons: [],
        });
        await writeStateFile(snapshot);
        trace.durationMs = clock.now() - startedAt;
        await appendTrace(trace);
        return trace;
      }
      // In sim mode the synthetic market only moves when advanced, so each cycle is a
      // new bar — otherwise every cycle would see identical signals and never trade.
      if (config.mode === 'sim' && typeof broker.advanceBar === 'function') {
        broker.advanceBar(1);
      }
      // One bars fetch per timeframe lane (day/swing); identical timeframes share one fetch.
      const cadence = resolveExecutionCadence(config);
      const laneTimeframes = [...new Set([cadence.day.timeframe, cadence.swing.timeframe, config.data.timeframe])];
      const barsByTimeframe = new Map();
      for (const laneTimeframe of laneTimeframes) {
        // eslint-disable-next-line no-await-in-loop
        const laneBars = await broker.getBars({
          symbols: config.symbols,
          timeframe: laneTimeframe,
          feed: config.data.feed ?? 'iex',
          limit: Math.min(Number(config.data.lookbackBars) || 60, 500),
        });
        barsByTimeframe.set(laneTimeframe, laneBars ?? {});
      }
      const bars = barsByTimeframe.get(config.data.timeframe) ?? barsByTimeframe.get(cadence.day.timeframe) ?? {};
      const prices = pricesFromBars(bars);
      const quotes = await readQuotes(broker, config.symbols, prices, config.data.feed ?? 'iex');
      trace.market = {
        symbols: Object.keys(prices).length,
        bars: Object.values(bars ?? {}).reduce((n, series) => n + (Array.isArray(series) ? series.length : 0), 0),
        quotes: Object.keys(quotes).length,
        cadence: { day: cadence.day, swing: cadence.swing },
      };
      state.lastPrices = prices;
      state.lastQuotes = quotes;

      // 2. metabolism: charge every living, non-condemned agent for this cycle
      const aliveAgents = registry.alive().filter((agent) => !state.condemned.has(agent.id));
      for (const agent of aliveAgents) await chargeCycleCosts(agent);
      await ledger.save();

      // 3. TREASURER prices the population, issues mandates and verdicts
      const dayStats = {};
      for (const agent of aliveAgents) {
        const eq = ledger.equity(agent.id, prices);
        const stored = state.dayStats.agents[agent.id] ?? { ordersCount: 0, startEquityUsd: null };
        if (stored.startEquityUsd == null) stored.startEquityUsd = round2(eq.equityUsd);
        state.dayStats.agents[agent.id] = stored;
        dayStats[agent.id] = {
          dayKey: state.dayStats.dayKey,
          ordersCount: stored.ordersCount ?? 0,
          startEquityUsd: round2(stored.startEquityUsd),
          // The daily-loss death rule needs real P&L, not a hardcoded zero.
          pnlUsd: round2(eq.equityUsd - stored.startEquityUsd),
        };
        // Persist the P&L too: the external Reaper re-derives daily_loss_limit from this
        // file, so a fatal verdict must be executable outside the engine.
        stored.pnlUsd = dayStats[agent.id].pnlUsd;
        stored.dayKey = state.dayStats.dayKey;
      }
      const treasuryView = await treasurer.tick({ prices, dayStats });
      state.lastTreasury = treasuryView;
      trace.account = treasuryView.account;
      trace.treasury = {
        state: treasuryView.state,
        runwayHours: treasuryView.runwayHours,
        burnPerHourUsd: treasuryView.burnPerHourUsd,
        cycleBudgetUsd: treasuryView.cycleBudgetUsd,
        surplus7dUsd: treasuryView.surplus7dUsd,
        mayReplicate: treasuryView.mayReplicate,
        allocatedUsd: treasuryView.allocatedUsd,
        reconciliation: treasuryView.reconciliation,
        halted: treasuryView.halted,
      };
      trace.halted = Boolean(treasuryView.halted);
      trace.haltReasons = treasuryView.haltReasons ?? [];

      for (const verdict of treasuryView.verdicts ?? []) {
        state.condemned.add(verdict.agentId);
        trace.deaths.push({ agentId: verdict.agentId, cause: verdict.cause, finalEquityUsd: verdict.finalEquityUsd });
      }
      if ((treasuryView.verdicts ?? []).length > 0) {
        await writeJsonAtomic(paths.deaths, { at: clock.iso(), verdicts: treasuryView.verdicts });
      }

      // In sim mode there is no separate broker process to share: the engine executes its
      // own verdicts in-process (DEMO MODE ONLY). Paper/live never take this path — their
      // deaths are executed by the external Reaper process from persisted state.
      if (config.mode === 'sim') {
        try {
          state.inProcessReaper = state.inProcessReaper
            ?? createReaper({ broker, registry, ledger, journal, config, paths, clock });
          const swept = await state.inProcessReaper.sweep({ prices });
          trace.deathsExecuted = (swept.killed ?? []).map((entry) => ({
            agentId: entry.agentId,
            cause: entry.cause,
            liquidated: (entry.liquidated ?? []).length,
            sweptUsd: entry.sweptUsd ?? 0,
          }));
          for (const killedAgent of swept.killed ?? []) state.condemned.delete(killedAgent.agentId);
          if ((swept.skipped ?? []).some((entry) => String(entry.reason ?? '').startsWith('kill_failed'))) {
            trace.errors.push({ role: 'reaper', code: 'KILL_SETTLE', message: 'one or more sim kills failed to settle' });
          }
        } catch (error) {
          trace.errors.push({ role: 'reaper', ...errorInfo(error) });
        }
      }

      // 4. PROSPECTOR: dated-proof hypotheses (skipped entirely while halted)
      let hypotheses = [];
      if (!treasuryView.halted) {
        try {
          const prospected = await prospector.run({ budgetUsd: treasuryView.cycleBudgetUsd });
          hypotheses = prospected?.hypotheses ?? [];
          trace.prospector = {
            hypotheses: hypotheses.length,
            spentUsd: prospected?.spentUsd ?? 0,
            dataCalls: prospected?.dataCalls ?? 0,
            rejected: (prospected?.rejected ?? []).length,
          };
        } catch (error) {
          trace.errors.push({ role: 'prospector', ...errorInfo(error) });
        }
      }

      // 5. BUILDER + EXECUTOR per living agent, inside the Treasurer mandate.
      //    Each bot belongs to an execution tier (docs/RUNBOOK §8b):
      //      day   — full analysis on the intraday cadence (default every 60 s)
      //      swing — full analysis on the mid/long-term cadence (default every hour)
      //    Non-due swing bots with an open position still get an exit-only risk pass every cycle,
      //    so stops/targets/research ALERT are honoured even between their hourly decisions.
      const agentViews = new Map((treasuryView.agentViews ?? []).map((view) => [view.agentId, view]));
      const usedPairs = new Set();
      const cadenceNowMs = clock.now();
      for (const agent of registry.alive()) {
        if (state.condemned.has(agent.id)) continue;
        const mandate = treasuryView.mandates?.[agent.id];
        const view = agentViews.get(agent.id);
        if (!mandate || !view) continue;
        if (treasuryView.halted && !mandate.allowExitOnly) continue;

        const tier = agent.tier === 'swing' ? 'swing' : 'day';
        const tierCadence = cadence[tier];
        // When no cadence block is configured the legacy behaviour is preserved: every agent is
        // analysed every cycle (tests/CLI/sim compatibility). Tier scheduling activates only with
        // an explicit `cadence` config (the running paper profile sets one).
        const cadenceConfigured = Boolean(config.cadence);
        const lastAnalysisMs = state.lastAnalysisAt.get(agent.id) ?? 0;
        const due = !cadenceConfigured
          || lastAnalysisMs === 0
          || cadenceNowMs - lastAnalysisMs >= tierCadence.intervalSec * 1000;
        const agentBook = ledger.snapshot(agent.id);
        const hasPosition = Object.keys(agentBook?.positions ?? {}).length > 0;
        if (!due && !hasPosition) {
          trace.executions.push({
            agentId: agent.id,
            tier,
            skipped: 'cadence_wait',
            nextInSec: Math.max(1, Math.ceil((tierCadence.intervalSec * 1000 - (cadenceNowMs - lastAnalysisMs)) / 1000)),
            detail: [{ type: 'cadence_wait' }],
          });
          continue;
        }
        const riskOnly = !due && hasPosition;

        let spec = null;
        let built = null;
        if (due) {
          built = await ensureSpec(agent, hypotheses, treasuryView.cycleBudgetUsd, usedPairs);
          if (!built) {
            trace.builds.push({ agentId: agent.id, specId: null, skipped: 'no_hypothesis' });
            continue;
          }
          if (built.__noMatch) {
            // No hypothesis for this bot's own strategy family/symbol this cycle. Wait for a
            // coherent setup instead of trading a different bot's strategy.
            trace.builds.push({ agentId: agent.id, specId: null, skipped: 'no_matching_hypothesis' });
            continue;
          }
          if (built.__compileError) {
            trace.builds.push({ agentId: agent.id, specId: null, error: built.__compileError.code, hypothesisId: built.hypothesisId });
            continue;
          }
          spec = built.spec;
        } else {
          // Risk-only pass: reuse the spec that opened the position (never mid-position rebuild).
          spec = agent.specId ? state.specs.get(agent.specId) ?? null : null;
          if (!spec) {
            trace.executions.push({ agentId: agent.id, tier, skipped: 'no_spec_risk_pass', detail: [{ type: 'cadence_wait' }] });
            continue;
          }
        }

        trace.builds.push({
          agentId: agent.id,
          specId: spec.specId,
          symbol: spec.symbol,
          family: spec.family,
          compiled: built ? !built.cached : false,
          tier,
          riskOnly,
        });
        try {
          const result = await executor.run({
            agent,
            spec,
            mandate,
            quotes,
            // One market read per cycle per timeframe lane: the whole population shares it.
            // Each cadence tier evaluates bar-based rules on its own timeframe lane.
            bars: barsByTimeframe.get(tierCadence.timeframe) ?? bars,
            timeframe: tierCadence.timeframe,
            riskOnly,
            dayStats: dayStats[agent.id],
            now: startedAt,
            marketOpen,
            marketClock,
            // Fresh per-agent briefing (null when missing/stale/disabled); the executor may
            // veto entries, scale size or force an exit — it can never place orders itself.
            research: researcher.latest(agent.id),
            // The bot's own agent policy (stance/size/exit pressure); null when missing/stale.
            policy: botAgents.policy(agent.id),
          });
          if (due) state.lastAnalysisAt.set(agent.id, cadenceNowMs);
          trace.executions.push({
            agentId: agent.id,
            specId: spec.specId,
            tier,
            riskOnly,
            actions: result?.actions?.length ?? 0,
            orders: result?.orders?.length ?? 0,
            denied: result?.denied?.length ?? 0,
            spentUsd: result?.spentUsd ?? 0,
            detail: (result?.actions ?? []).slice(0, 4).map((action) => ({
              type: action.type,
              symbol: action.symbol,
              reason: action.reason,
            })),
          });
          const statsEntry = state.dayStats.agents[agent.id] ?? { ordersCount: 0, startEquityUsd: view.equityUsd };
          statsEntry.ordersCount = (statsEntry.ordersCount ?? 0) + (result?.orders?.length ?? 0);
          statsEntry.startEquityUsd = statsEntry.startEquityUsd ?? round2(view.equityUsd);
          state.dayStats.agents[agent.id] = statsEntry;
          if (result?.denied?.length) {
            for (const denial of result.denied.slice(0, 5)) {
              trace.errors.push({
                role: 'executor',
                agentId: agent.id,
                code: denial.code,
                message: denial.reason ?? 'brake denied',
              });
            }
          }
        } catch (error) {
          trace.errors.push({ role: 'executor', agentId: agent.id, ...errorInfo(error) });
        }
      }
      await saveDayStats();
      // Persist spec assignments: ensureSpec() updated the registry in memory; without this
      // save a restart (and the next cycle's disk re-sync) would forget every agent's spec.
      await registry.save();
      await ledger.save();

      // 6. RANKINGS + REWARDS: period leaderboards and operator-configured payouts.
      // Rankings are bookkeeping snapshots (no trades). Rewards move virtual cash from the
      // treasury pool to the top-3 agents at period boundaries; no broker transfer exists.
      let rankingsView = null;
      try {
        const nowMs = clock.now();
        const equityByAgent = {};
        for (const agent of registry.all()) {
          const view = agentViews.get(agent.id);
          const snapshot = ledger.snapshot ? ledger.snapshot(agent.id) : null;
          equityByAgent[agent.id] = {
            name: agent.name ?? agent.id,
            equityUsd: Number(view?.equityUsd) || 0,
            trades: Number(snapshot?.trades) || 0,
          };
        }
        // Payout for a completed period must be ranked BEFORE this tick records the new
        // period's baselines. Probe an instant inside the completed period so the stored
        // baselines/last observations of that period are still in scope.
        const due = operatorRewardsConfig.enabled === true ? rewards.duePeriod(nowMs) : null;
        if (due) {
          let payoutRankings = null;
          try {
            const completedEndMs = periodKeyEndMs(due.period, due.periodKey);
            payoutRankings = rankings.compute({
              atMs: Number.isFinite(completedEndMs) ? completedEndMs - 1 : nowMs - 1,
              stored: true,
            });
          } catch {
            payoutRankings = rankings.compute({ atMs: nowMs, equityByAgent });
          }
          const account = treasuryView.account ?? {};
          const pool = typeof ledger.pool === 'function' ? ledger.pool() : { poolUsd: 0, allocatedUsd: 0 };
          const allocationCapUsd = Number(account.equityUsd || 0) * Number(config.account?.allocationCapPct ?? 0.8);
          const allocationCapRemainingUsd = Math.max(0, allocationCapUsd - Number(pool.allocatedUsd || 0));
          const payout = await rewards.apply({
            due,
            rankings: payoutRankings,
            accountCashUsd: Number(account.cashUsd ?? pool.poolUsd ?? 0),
            poolUsd: Number(pool.poolUsd || 0),
            allocationCapRemainingUsd,
            ledger,
            nowMs,
          });
          await rewards.save();
          if (payout?.applied) await ledger.save();
          trace.rewards = {
            period: due.period,
            periodKey: due.periodKey,
            winners: payout?.winners ?? [],
            skipped: payout?.skipped ?? false,
          };
        } else {
          trace.rewards = { period: operatorRewardsConfig.period ?? null, due: false };
        }
        await rankings.record({ atMs: nowMs, equityByAgent });
        rankingsView = rankings.compute({ atMs: nowMs, equityByAgent });
        await rankings.save();
      } catch (error) {
        trace.errors.push({ role: 'rewards', ...errorInfo(error) });
      }

      // 7. RESEARCH: per-agent isolated hourly news briefing (docs/RESEARCH.md).
      // Runs AFTER entries/exits so LLM latency (up to ~1 min for a batch) can never delay an
      // order; a due briefing becomes visible to the next cycle's executor (briefings stay
      // fresh for maxAgeSec = 2 h, so a 5-minute lag is irrelevant for hourly news).
      // It never trades, never reads another agent's book, and each briefing is paid for by
      // the agent's own ledger. Halted treasuries skip research (no spend while reconciling).
      await runResearchPhase(trace, marketClock, treasuryView.halted);

      // 7b. BOT AGENTS: each due bot reviews its own strategy in isolation and writes a policy the
      // Executor applies on the next cycle. Runs after execution (no order waits on a model turn)
      // and after research (the review sees this cycle's briefing). Cost is paid by the bot itself.
      try {
        const agentRun = await botAgents.tick({
          market: { prices: state.lastPrices ?? {}, quotes: state.lastQuotes ?? {}, marketOpen },
          // Broker capability facts: the bot agent needs to know fractional long stock is always
          // allowed and that shorts/margin may be disabled by the paper account itself.
          account: treasuryView?.account ?? null,
        });
        trace.agents = {
          enabled: agentRun.enabled,
          configured: agentRun.configured,
          due: agentRun.due,
          reviewed: agentRun.reviewed.length,
          deferred: agentRun.deferred ?? 0,
          skipped: agentRun.skipped,
          errors: agentRun.reviewed.filter((entry) => entry.error).length,
          budgetUsd: round4(agentRun.reviewed.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0)),
        };
        if (!agentRun.enabled || !agentRun.configured) {
          trace.agents.note = !agentRun.enabled ? 'disabled by config' : 'no LLM generator configured';
        }
        if (agentRun.paused) {
          trace.agents.paused = true;
          trace.agents.note = agentRun.note ?? 'paused after provider error';
        }
        if ((agentRun.reviewed ?? []).some((entry) => entry.costUsd > 0)) await ledger.save();
      } catch (error) {
        trace.errors.push({ role: 'agents', ...errorInfo(error) });
      }

      // 8. REPLICATOR: only when the Treasurer's gate says so, one mutation, cap enforced
      if (treasuryView.mayReplicate && !treasuryView.halted) {
        const candidates = registry
          .alive()
          .filter((agent) => !state.condemned.has(agent.id))
          .map((agent) => ({ agent, view: agentViews.get(agent.id) }))
          .filter((entry) => entry.view && Number(entry.view.equityUsd) > 0)
          .sort((a, b) => (b.view.net7dUsd ?? 0) - (a.view.net7dUsd ?? 0));
        for (const candidate of candidates) {
          try {
            const spawned = await replicator.spawn(candidate.agent.id, treasuryView);
            trace.replication = {
              childId: spawned?.child?.id ?? spawned?.childId ?? null,
              parentId: candidate.agent.id,
              mutation: spawned?.mutation ?? null,
              lessons: spawned?.lessonCount ?? 0,
            };
            break;
          } catch (error) {
            const info = errorInfo(error);
            if (info.code === 'POPULATION_CAP' || info.code === 'REPLICATION_DENIED') {
              trace.replication = { blocked: info.code, message: info.message };
              break;
            }
            trace.errors.push({ role: 'replicator', ...info });
          }
        }
      }

      // 7. snapshot + trace
      // Mark completion BEFORE the snapshot: the persisted state.json (what the panel and
      // `automaton_status` read) must show this tick, not the previous one. A successful
      // cycle also clears a transient lastError (e.g. a one-off Windows file-lock retry), so
      // the panel does not keep showing a stale failure forever.
      state.lastTickAt = new Date(clock.now()).toISOString();
      state.lastTrace = trace;
      state.lastError = null;
      const snapshot = await buildSnapshot({
        account: treasuryView.account,
        treasury: treasuryView,
        halted: treasuryView.halted,
        haltReasons: treasuryView.haltReasons,
      });
      await writeStateFile(snapshot);
      trace.durationMs = clock.now() - startedAt;
      await appendTrace(trace);
      return trace;
    } catch (error) {
      state.errors += 1;
      state.lastError = errorInfo(error);
      trace.errors.push({ role: 'orchestrator', ...errorInfo(error) });
      trace.durationMs = clock.now() - startedAt;
      state.lastTrace = trace;
      log.error('tick failed', state.lastError);
      throw error;
    } finally {
      state.ticking = false;
    }
  }

  // -------------------------------------------------------------------------
  // snapshot for UI / tools
  // -------------------------------------------------------------------------

  async function buildSnapshot({ account, treasury, halted, haltReasons }) {
    const alive = registry.alive();
    const dead = registry.dead();
    const views = new Map((treasury?.agentViews ?? []).map((view) => [view.agentId, view]));
    const marks = state.lastPrices && typeof state.lastPrices === 'object' ? state.lastPrices : {};
    // Execution cadence for the two tiers (dashboard: per-agent timeframe/cadence/next analysis).
    const cadence = resolveExecutionCadence(config);
    const snapshotNowMs = clock.now();

    // Period leaderboards + rewards view for the control panel (bookkeeping only).
    const equityByAgent = {};
    for (const agent of registry.all()) {
      const view = views.get(agent.id) ?? null;
      let bookSnapshot = null;
      try {
        bookSnapshot = ledger.snapshot(agent.id);
      } catch {
        bookSnapshot = null;
      }
      equityByAgent[agent.id] = {
        name: agent.name ?? agent.id,
        equityUsd: Number(view?.equityUsd) || 0,
        trades: Number(bookSnapshot?.trades) || 0,
      };
    }
    const asOfMs = clock.now();
    let rankingsView = null;
    try {
      rankingsView = await rankings.compute({ atMs: asOfMs, equityByAgent });
    } catch {
      rankingsView = null;
    }
    const rankingMaps = {};
    for (const period of ['daily', 'weekly', 'monthly']) {
      rankingMaps[period] = new Map((rankingsView?.periods?.[period] ?? []).map((row) => [row.agentId, row]));
    }
    const ledgerPool = typeof ledger.pool === 'function' ? ledger.pool() : { poolUsd: 0, allocatedUsd: 0 };
    const allocationCapUsd = Number(account?.equityUsd || 0) * Number(config.account?.allocationCapPct ?? 0.8);
    let rewardsStatus = null;
    let rewardsHistory = [];
    try {
      rewardsStatus = rewards.status();
      rewardsHistory = (rewards.getState()?.history ?? []).slice(-8);
    } catch {
      rewardsStatus = null;
    }
    const rewardsView = rewardsStatus
      ? {
          ...rewardsStatus,
          basis: operatorRewardsConfig.basis ?? 'account-cash',
          accountCashUsd: account?.cashUsd ?? null,
          poolUsd: round2(ledgerPool.poolUsd ?? 0),
          allocatedUsd: round2(ledgerPool.allocatedUsd ?? 0),
          allocationCapRemainingUsd: round2(Math.max(0, allocationCapUsd - Number(ledgerPool.allocatedUsd || 0))),
          history: rewardsHistory,
        }
      : null;
    const agents = registry.all().map((agent) => {
      const view = views.get(agent.id) ?? null;
      const isDead = agent.status === 'dead';
      const isCondemned = !isDead && state.condemned.has(agent.id);
      // Holdings + activity for the control panel's per-agent drill-down. Bookkeeping only:
      // no broker call, no account equity, no secrets.
      let book = null;
      try {
        book = ledger.snapshot(agent.id);
      } catch {
        book = null;
      }
      let recentTrades = [];
      try {
        recentTrades = typeof ledger.history === 'function' ? ledger.history(agent.id, { limit: 12 }) : [];
      } catch {
        recentTrades = [];
      }
      const positions = Object.entries(book?.positions ?? {}).map(([symbol, position]) => {
        const qty = Number(position?.qty) || 0;
        const avgPriceUsd = Number(position?.avgPriceUsd) || 0;
        const assetClass = position?.assetClass === 'us_option' ? 'us_option' : 'us_equity';
        const multiplier = assetClass === 'us_option' ? Number(position?.multiplier) || 100 : 1;
        const option = position?.option ?? null;
        const markCandidate = Number(position?.markPriceUsd ?? position?.lastPriceUsd);
        const lastPriceUsd = Number(marks[symbol]) > 0
          ? Number(marks[symbol])
          : Number.isFinite(markCandidate) && markCandidate > 0
            ? markCandidate
            : avgPriceUsd;
        const marketValueUsd = round2(qty * lastPriceUsd * multiplier);
        const side = assetClass === 'us_option'
          ? String(option?.type ?? 'option').toUpperCase()
          : qty < 0 ? 'SHORT' : 'LONG';
        return {
          symbol,
          assetClass,
          side,
          qty,
          qtySigned: qty,
          multiplier,
          option,
          groupId: position?.groupId ?? null,
          avgPriceUsd: round4(avgPriceUsd),
          lastPriceUsd: round4(lastPriceUsd),
          marketValueUsd,
          unrealizedPlUsd: round2((lastPriceUsd - avgPriceUsd) * qty * multiplier),
          openedAt: position?.openedAt ?? null,
        };
      });
      const spec = agent.specId ? state.specs.get(agent.specId) ?? null : null;
      // Rewards payouts happen mid-tick after the treasury views were computed, so prefer a
      // FRESH ledger mark for equity/cash here; fall back to the treasury view when unavailable.
      let freshEquity = null;
      try {
        freshEquity = typeof ledger.equity === 'function' ? ledger.equity(agent.id, marks) : null;
      } catch {
        freshEquity = null;
      }
      return {
        id: agent.id,
        name: agent.name ?? agent.id,
        parentId: agent.parentId,
        generation: agent.generation,
        status: isDead ? 'dead' : isCondemned ? 'condemned' : agent.status,
        bornAt: agent.bornAt,
        diedAt: agent.diedAt,
        cause: agent.cause,
        endowmentUsd: agent.endowmentUsd,
        genome: agent.genome,
        mutation: agent.mutation,
        specId: agent.specId,
        spec: spec
          ? {
              specId: spec.specId,
              symbol: spec.symbol,
              family: spec.family,
              params: spec.params ?? {},
              createdAt: spec.createdAt ?? null,
            }
          : null,
        equityUsd: freshEquity?.equityUsd ?? view?.equityUsd ?? null,
        cashUsd: freshEquity?.cashUsd ?? book?.cashUsd ?? view?.cashUsd ?? null,
        marginDebtUsd: freshEquity?.marginDebtUsd ?? view?.marginDebtUsd ?? null,
        grossExposureUsd: view?.grossExposureUsd ?? freshEquity?.grossExposureUsd ?? null,
        netExposureUsd: view?.netExposureUsd ?? freshEquity?.netExposureUsd ?? null,
        positionsValueUsd: freshEquity?.positionsValueUsd ?? view?.positionsValueUsd ?? null,
        runwayHours: view?.runwayHours ?? null,
        treasuryState: view?.state ?? null,
        drawdownPct: view?.drawdownPct ?? null,
        dayPnlPct: view?.dayPnlPct ?? null,
        net7dUsd: view?.net7dUsd ?? null,
        positions,
        recentTrades,
        tradesCount: Number(book?.trades) || 0,
        realizedPlUsd: book?.realizedPlUsd ?? null,
        unrealizedPlUsd: book?.unrealizedPlUsd ?? null,
        firstProfitAt: book?.firstProfitAt ?? null,
        roleCosts: view?.roleCosts ?? {},
        // Isolated per-agent research briefing (fresh or stale, for the dashboard).
        research: researcher.latestAny(agent.id),
        // Full fill history for the drill-down "Transactions" table.
        orders: (() => {
          try {
            return typeof ledger.history === 'function' ? ledger.history(agent.id, { limit: 200 }) : [];
          } catch {
            return [];
          }
        })(),
        pnl: {
          realizedUsd: book?.realizedPlUsd ?? null,
          unrealizedUsd: book?.unrealizedPlUsd ?? null,
          netUsd: view?.equityUsd !== undefined && view?.equityUsd !== null
            ? round2(Number(view.equityUsd) - Number(agent.endowmentUsd ?? 0))
            : null,
          dayPct: view?.dayPnlPct ?? null,
          weekPct: rankingMaps.weekly.get(agent.id)?.pnlPct ?? null,
          monthPct: rankingMaps.monthly.get(agent.id)?.pnlPct ?? null,
        },
        rankings: {
          dayRank: rankingMaps.daily.get(agent.id)?.rank ?? null,
          weekRank: rankingMaps.weekly.get(agent.id)?.rank ?? null,
          monthRank: rankingMaps.monthly.get(agent.id)?.rank ?? null,
          dayPct: rankingMaps.daily.get(agent.id)?.pnlPct ?? null,
          weekPct: rankingMaps.weekly.get(agent.id)?.pnlPct ?? null,
          monthPct: rankingMaps.monthly.get(agent.id)?.pnlPct ?? null,
        },
        // Execution tier + cadence (day = intraday lane, swing = mid/long-term lane).
        tier: (agent.tier === 'swing' ? 'swing' : 'day'),
        cadence: (() => {
          const resolvedTier = agent.tier === 'swing' ? 'swing' : 'day';
          const tierCadence = cadence[resolvedTier];
          const lastMs = state.lastAnalysisAt.get(agent.id) ?? 0;
          const nextMs = lastMs > 0 ? lastMs + tierCadence.intervalSec * 1000 : snapshotNowMs;
          return {
            intervalSec: tierCadence.intervalSec,
            timeframe: tierCadence.timeframe,
            lastAnalysisAt: lastMs > 0 ? new Date(lastMs).toISOString() : null,
            nextAnalysisAt: new Date(nextMs).toISOString(),
          };
        })(),
        // Strategy taxonomy (type + category + estimated trading interval for the panel table).
        strategy: resolveStrategyType({
          family: agent?.genome?.family,
          tier: agent.tier,
          cadence,
        }),
        // Instrument permissions + family playbook (multi-instrument paper trading, v3.0).
        instrumentPermissions: { ...agentInstrumentPermissions(config, agent), ...(view?.instruments ?? {}) },
        playbook: playbookView(
          agent?.genome?.family,
          { ...agentInstrumentPermissions(config, agent), ...(view?.instruments ?? {}) },
        ),
        // This bot's own agent brain: latest review policy, review count, next review time.
        policy: botAgents.status(agent.id),
        // Strategy explanation + current plan/next step for the detail page.
        plan: explainAgentPlan({
          agent,
          spec,
          book,
          prices: marks,
          nowMs: asOfMs,
          research: researcher.latestAny(agent.id),
          nextResearchAt: typeof researcher.nextFor === 'function' ? researcher.nextFor(agent.id) : null,
          timeframe: (agent.tier === 'swing' ? cadence.swing : cadence.day).timeframe,
        }),
        note: isCondemned ? 'death verdict written; the external Reaper executes it' : null,
      };
    });
    const strategyMixView = computeStrategyMix(agents.map((row) => ({ genome: row.genome, strategy: row.strategy })));
    const obituaryStats = journal.stats ? await journal.stats() : null;
    return {
      at: new Date(clock.now()).toISOString(),
      mode: config.mode,
      engine: {
        running: state.running,
        ticks: state.ticks,
        errors: state.errors,
        lastTickAt: state.lastTickAt,
        lastError: state.lastError,
        killSwitch: brakes.isKillSwitchActive?.(),
        liveArmed: liveArmed(config),
        research: {
          ...researcher.schedule(),
          configurable: {
            scheduleModes: ['interval', 'pre-open', 'post-close', 'pre-open+post-close'],
            intervalOptionsSec: [3600, 10800, 21600, 86400],
          },
        },
        agents: botAgents.schedule(),
        instruments: (() => {
          const permissions = resolveInstrumentPermissions(config);
          const acct = account ?? {};
          const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
          const t = treasury ?? {};
          return {
            ...permissions,
            enabled: config.instruments.enabled === true,
            caps: {
              maxMarginPctEquity: config.instruments.maxMarginPctEquity,
              maxShortPctEquity: config.instruments.maxShortPctEquity,
              maxShortNotionalUsd: config.instruments.maxShortNotionalUsd,
              maxOptionPremiumPctEquity: config.instruments.maxOptionPremiumPctEquity,
              maxOptionPremiumUsd: config.instruments.maxOptionPremiumUsd,
              maxContracts: config.instruments.maxContracts,
              minDTE: config.instruments.minDTE,
              maxDTE: config.instruments.maxDTE,
              autoCloseDTE: config.instruments.autoCloseDTE,
            },
            optionDataFeed: config.instruments.optionDataFeed,
            account: account || treasury
              ? {
                  buyingPowerUsd: num(acct.buyingPowerUsd ?? acct.buying_power),
                  optionsBuyingPowerUsd: num(acct.optionsBuyingPowerUsd ?? acct.options_buying_power),
                  marginMultiplier: num(acct.marginMultiplier ?? acct.margin_multiplier),
                  shortingEnabled: acct.shortingEnabled ?? acct.shorting_enabled ?? null,
                  optionsTradingLevel: num(acct.optionsTradingLevel ?? acct.options_trading_level),
                  marginDebtUsd: num(acct.marginDebtUsd) ?? num(t.marginDebtUsd),
                  grossExposureUsd: num(acct.grossExposureUsd) ?? num(t.grossExposureUsd),
                  netExposureUsd: num(acct.netExposureUsd) ?? num(t.netExposureUsd),
                }
              : null,
            treasury: t.instruments ?? null,
            // What the broker can actually do right now (the paper account can be restricted below
            // the margin minimum; mandates already intersect with these facts).
            effective: (() => {
              const shorting = acct.shortingEnabled ?? acct.shorting_enabled ?? null;
              const marginMultiplier = num(acct.marginMultiplier ?? acct.margin_multiplier);
              const marginUnavailable = marginMultiplier !== null && marginMultiplier <= 1;
              const creditStructures = ['covered_call', 'call_credit_spread', 'put_credit_spread'];
              return {
                longStock: true,
                shortStock: permissions.shortStock && shorting !== false,
                margin: permissions.margin && !marginUnavailable,
                creditOptions: permissions.shortOptions && !marginUnavailable,
                structures: permissions.allowedStructures.filter((structure) => (
                  !marginUnavailable || !creditStructures.includes(structure)
                )),
              };
            })(),
            playbooks: Object.fromEntries(
              ['momentum', 'meanrev', 'breakout', 'gapfade'].map((family) => [family, playbookView(family, permissions)]),
            ),
          };
        })(),
        lastCycle: (() => {
          const trace = state.lastTrace;
          if (!trace) return null;
          const executions = trace.executions ?? [];
          const reasons = {};
          for (const execution of executions) {
            for (const detail of execution.detail ?? []) {
              if (detail.reason) reasons[detail.reason] = (reasons[detail.reason] ?? 0) + 1;
            }
            if (execution.skipped) reasons[`skipped:${execution.skipped}`] = (reasons[`skipped:${execution.skipped}`] ?? 0) + 1;
          }
          return {
            at: trace.at ?? state.lastTickAt,
            marketOpen: trace.marketOpen ?? null,
            tradingSkipped: trace.tradingSkipped === true,
            executions: executions.length,
            orders: executions.reduce((sum, entry) => sum + (entry.orders ?? 0), 0),
            denied: executions.reduce((sum, entry) => sum + (entry.denied ?? 0), 0),
            errors: (trace.errors ?? []).length,
            topSkipReasons: Object.fromEntries(
              Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 10),
            ),
            botReviews: trace.agents ?? null,
            research: trace.research ?? null,
          };
        })(),
        rewards: rewardsView,
        cadence,
        tradingHoursOnly: config.engine?.tradingHoursOnly === true,
        offHoursIntervalSec: Number(config.engine?.offHoursIntervalSec) || 300,
      },
      account: account ?? null,
      treasury: treasury
        ? {
            state: treasury.state,
            runwayHours: treasury.runwayHours,
            burnPerHourUsd: treasury.burnPerHourUsd,
            cycleBudgetUsd: treasury.cycleBudgetUsd,
            surplus7dUsd: treasury.surplus7dUsd,
            mayReplicate: treasury.mayReplicate,
            allocatedUsd: treasury.allocatedUsd,
            poolUsd: treasury.poolUsd,
            marginDebtUsd: treasury.marginDebtUsd ?? null,
            grossExposureUsd: treasury.grossExposureUsd ?? null,
            netExposureUsd: treasury.netExposureUsd ?? null,
            instruments: treasury.instruments ?? null,
            reconciliation: treasury.reconciliation,
          }
        : null,
      population: {
        total: registry.all().length,
        alive: alive.length,
        dead: dead.length,
        condemned: state.condemned.size,
        cap: config.population.cap,
        byGeneration: registry.generationStats ? registry.generationStats() : {},
      },
      agents,
      strategyMix: strategyMixView,
      rankings: rankingsView,
      rewards: rewardsView,
      obituaries: obituaryStats,
      halted: Boolean(halted),
      haltReasons: haltReasons ?? [],
      config: {
        cycleIntervalSec: config.cycleIntervalSec,
        deathFloorUsd: Math.max(config.deathFloorUsd, config.deathFloorPct * config.endowmentUsd),
        endowmentUsd: config.endowmentUsd,
        symbols: config.symbols,
      },
    };
  }

  async function status() {
    const snapshot = await readJson(paths.stateFile, null);
    if (!snapshot) {
      return {
        at: new Date(clock.now()).toISOString(),
        mode: config.mode,
        engine: {
          running: state.running,
          ticks: state.ticks,
          errors: state.errors,
          lastTickAt: state.lastTickAt,
          lastError: state.lastError,
          killSwitch: brakes.isKillSwitchActive?.(),
          liveArmed: liveArmed(config),
          initialized: state.initialized,
        },
        account: null,
        treasury: null,
        population: { total: 0, alive: 0, dead: 0, condemned: 0, cap: config.population.cap, byGeneration: {} },
        agents: [],
        obituaries: journal.stats ? await journal.stats() : null,
        halted: false,
        haltReasons: [],
        config: {
          cycleIntervalSec: config.cycleIntervalSec,
          deathFloorUsd: Math.max(config.deathFloorUsd, config.deathFloorPct * config.endowmentUsd),
          endowmentUsd: config.endowmentUsd,
          symbols: config.symbols,
        },
      };
    }
    return {
      ...snapshot,
      engine: { ...snapshot.engine, running: state.running, initialized: state.initialized },
    };
  }

  async function start() {
    if (state.running) return status();
    await init();
    state.running = true;
    const cycleMs = Math.max(1000, Number(config.cycleIntervalSec) * 1000);
    const offHoursMs = Math.max(30, Number(config.engine?.offHoursIntervalSec) || 300) * 1000;
    const tradingHoursOnly = config.engine?.tradingHoursOnly === true;
    const loop = async () => {
      if (!state.running) return;
      let delayMs = cycleMs;
      try {
        const trace = await tick();
        // Outside trading hours the loop only runs the cheap maintenance pass, so it can
        // sleep longer; inside a tiered profile it still wakes every cycle for the day tier.
        if (tradingHoursOnly && trace && trace.marketOpen === false) delayMs = offHoursMs;
      } catch (error) {
        log.error('loop tick failed', errorInfo(error));
      }
      if (state.running) {
        state.timer = setTimeout(loop, delayMs);
        if (typeof state.timer.unref === 'function') state.timer.unref();
      }
    };
    loop();
    return status();
  }

  async function stop() {
    state.running = false;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    return status();
  }

  function isRunning() {
    return state.running;
  }

  /** Operator-only dry-run pre-trade check (used by the automaton_brakes tool). */
  async function preTradeCheck({ agentId, symbol, side = 'buy', notionalUsd, priceUsd } = {}) {
    const market = { prices: state.lastPrices, quotes: state.lastQuotes };
    const treasuryView = state.lastTreasury;
    const agentView = (treasuryView?.agentViews ?? []).find((view) => view.agentId === agentId);
    const mandate = treasuryView?.mandates?.[agentId];
    const agent = registry.get(agentId);
    const quote = market.quotes?.[symbol] ?? null;
    const price = Number(priceUsd) || Number(quote?.ask) || Number(market.prices?.[symbol]) || 0;
    const notional = Number(notionalUsd) || (price > 0 ? price : 0);
    // The dry run must traverse the SAME proof check a real order would: load the agent's
    // full compiled spec (with proofRef) instead of a stub, or D9 always denies NO_PROOF.
    const spec = agent?.specId ? state.specs.get(agent.specId) ?? null : null;
    return brakes.checkOrder({
      mode: config.mode,
      now: clock.now(),
      agentId,
      dayStats: agentView ? dayStatsFor(agentId) : undefined,
      quote,
      order: { symbol, side, qty: price > 0 ? notional / price : 0, priceUsd: price, notionalUsd: notional },
      equityUsd: agentView?.equityUsd ?? 0,
      positions: agentView?.positions ?? [],
      mandate,
      spec,
      accountEquityUsd: treasuryView?.account?.equityUsd ?? 0,
      allocatedEquityUsd: treasuryView?.allocatedUsd ?? 0,
      spreadBps: quote && quote.bid > 0 ? ((quote.ask - quote.bid) / quote.bid) * 10000 : 0,
      // D3 with the broker's authoritative session state, not just the weekday window.
      marketOpen: state.lastMarketOpen ?? null,
      marketClock: state.lastMarketClock ?? null,
    });
  }

  /** Rebuild + persist the status snapshot (used after live settings changes). */
  async function refreshSnapshot() {
    await init();
    const treasuryView = state.lastTreasury;
    const snapshot = await buildSnapshot({
      account: treasuryView?.account ?? null,
      treasury: treasuryView,
      halted: treasuryView?.halted ?? false,
      haltReasons: treasuryView?.haltReasons ?? [],
    });
    await writeStateFile(snapshot);
    return snapshot;
  }

  /** Operator control panel: live research schedule change (persisted by the engine overlay). */
  async function updateResearchSettings(settings = {}) {
    const schedule = researcher.reconfigure(settings);
    await refreshSnapshot();
    return {
      settings: {
        scheduleMode: schedule.scheduleMode,
        intervalSec: schedule.intervalSec,
        preMarketOffsetMin: schedule.preMarketOffsetMin,
        postCloseOffsetMin: schedule.postCloseOffsetMin,
      },
      schedule,
    };
  }

  /** Operator control panel: live rewards change (settings re-resolved; history preserved). */
  async function updateRewardSettings(settings = {}) {
    operatorRewardsConfig = { ...operatorRewardsConfig, ...settings };
    if (typeof rewards.reconfigure === 'function') {
      const status = rewards.reconfigure({ ...config, rewards: operatorRewardsConfig });
      await rewards.save();
      await refreshSnapshot();
      return { settings: operatorRewardsConfig, status };
    }
    const previous = (() => {
      try {
        return rewards.getState?.() ?? null;
      } catch {
        return null;
      }
    })();
    rewards = createRewards({ paths, config: { ...config, rewards: operatorRewardsConfig }, clock });
    await rewards.load();
    if (previous && typeof rewards.hydrate === 'function') rewards.hydrate(previous);
    return { settings: operatorRewardsConfig, status: rewards.status() };
  }

  return {
    // lifecycle
    init,
    tick,
    start,
    stop,
    isRunning,
    status,
    refreshSnapshot,
    updateResearchSettings,
    updateRewardSettings,
    // views
    obituaries: async ({ limit = 50, offset = 0 } = {}) => ({
      stats: journal.stats ? await journal.stats() : null,
      items: await journal.list({ limit, offset }),
    }),
    brakesView: () => ({
      rules: brakes.describe(),
      killSwitch: Boolean(brakes.isKillSwitchActive?.()),
      liveArmed: liveArmed(config),
      mode: config.mode,
    }),
    preTradeCheck,
    // internals exposed for tests/tools (documented as operator surface, not agent surface)
    _internals: { registry, ledger, journal, treasurer, replicator, prospector, builder, executor, brakes, state },
    config,
    paths,
    broker,
  };
}

export { genesisGenome, pricesFromBars, readQuotes, safeJson };
