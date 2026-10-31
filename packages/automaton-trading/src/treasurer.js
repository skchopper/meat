/**
 * treasurer.js — the metabolism.
 *
 * The Treasurer owns the only read of broker account equity. It never places an order
 * and never earns: it measures burn, computes runway (never raw balance), issues
 * cycle budgets and per-agent mandates, and writes death verdicts. The Reaper is the
 * only role that executes a death, and it re-derives the death independently.
 *
 * Death rules (evaluated here, executed elsewhere):
 *   1. insufficient_funds    equity <= effective death floor (the article's rule)
 *   2. drawdown_limit        equity <= endowment * (1 - maxDrawdownPct)
 *   3. daily_loss_limit      day P&L <= -maxDailyLossPct * day-start equity
 * System-level halts (no new orders, exits still allowed): account_not_active,
 * reconciliation_mismatch, allocation_cap, broker_unavailable.
 *
 * Owned by mortality-core. Contract: docs/CONTRACTS.md ("Mortality modules").
 */

import { AutomatonError, EXPIRY_MS, TREASURY_STATES, fail } from './contracts.js';
import { errorInfo, round2, round4, sum, SYSTEM_CLOCK, writeJsonAtomic } from './util.js';
import { statePaths } from './config.js';
import { TREASURY_ID } from './ledger.js';

const MONTHLY_HOURS = 730;
const EPSILON = 1e-9;

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Configured cycle rate used as "cycles last hour" (deterministic, not measured). */
export function cyclesLastHour(config) {
  const seconds = Number(config?.cycleIntervalSec);
  return 3600 / Math.max(1, Number.isFinite(seconds) && seconds > 0 ? seconds : 300);
}

/**
 * The architecture's burn formula for one agent:
 *   hostingPerHour + (inferencePerCycle + dataPerCycle) * cyclesLastHour + committedMonthly/730
 * A population multiplies it (each agent pays its own inference; hosting is charged per
 * agent so the per-agent runway stays conservative).
 *
 * Research cost is NOT amortised into this formula: the isolated analyst is charged to the
 * agent's ledger per successful briefing (category 'research'), so it reduces equity/runway
 * as an actual cost instead of a modelled one.
 *
 * @returns {number} rounded to 4dp (sub-cent burns must not round to zero)
 */
export function burnPerHour(config, population = 1) {
  const burn = config?.burn ?? {};
  const perCycle = Number(burn.inferencePerCycleUsd ?? 0) + Number(burn.dataPerCycleUsd ?? 0);
  const perAgent =
    Number(burn.hostingPerHourUsd ?? 0) +
    perCycle * cyclesLastHour(config) +
    Number(burn.committedMonthlyUsd ?? 0) / MONTHLY_HOURS;
  const count = Number.isFinite(Number(population)) ? Math.max(1, Math.trunc(Number(population))) : 1;
  return round4(perAgent * count);
}

/** The cost of the next step: max(absolute floor, pct of this agent's endowment). */
export function effectiveDeathFloor(config, endowmentUsd) {
  const absolute = Number(config?.deathFloorUsd ?? 0);
  const pct = Number(config?.deathFloorPct ?? 0);
  const endowment = Number.isFinite(Number(endowmentUsd)) ? Number(endowmentUsd) : Number(config?.endowmentUsd ?? 0);
  return round2(Math.max(Number.isFinite(absolute) ? absolute : 0, (Number.isFinite(pct) ? pct : 0) * endowment));
}

/** Runway hours = max(0, (equity - floor) / burn). Burn of zero means effectively forever. */
export function computeRunwayHours(equityUsd, floorUsd, burnPerHourUsd) {
  const headroom = Number(equityUsd) - Number(floorUsd);
  if (!Number.isFinite(headroom)) return 0;
  const burn = Number(burnPerHourUsd);
  if (!(burn > 0)) return headroom > 0 ? 1e9 : 0;
  return round2(Math.max(0, headroom / burn));
}

/** Map equity/floor/runway onto the four treasury states. */
export function classifyTreasuryState({ equityUsd, floorUsd, runwayHours }) {
  const equity = Number(equityUsd);
  const floor = Number(floorUsd);
  if (!Number.isFinite(equity) || !Number.isFinite(floor)) return 'CRITICAL';
  if (equity <= floor) return 'DEAD';
  const runway = Number(runwayHours);
  if (!Number.isFinite(runway)) return 'CRITICAL';
  if (runway >= 24) return 'STABLE';
  if (runway >= 6) return 'TIGHT';
  return 'CRITICAL';
}

function positiveOrInfinity(value, fallback = Infinity) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Derive an agent's per-mandate instrument permissions and caps from
 * `config.instruments` and the agent's current equity (docs/INSTRUMENTS.md).
 *
 * Missing `config.instruments` = v2 behaviour: long stock only, no short/options/margin.
 *
 * @param {object} config
 * @param {number} equityUsd
 * @returns {{ longStock: boolean, shortStock: boolean, longOptions: boolean,
 *   shortOptions: boolean, coveredCalls: boolean, spreads: boolean, margin: boolean,
 *   allowedStructures: string[], maxShortNotionalUsd: number, maxOptionPremiumUsd: number,
 *   maxContracts: number, maxMarginUsd: number }}
 */
export function deriveInstrumentPermissions(config, equityUsd = 0, account = null) {
  const raw = config?.instruments ?? {};
  const enabled = raw.enabled !== false;
  const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  const equity = Math.max(0, Number(equityUsd) || 0);
  // Broker capability facts intersect the config: a paper account below the margin minimum (or
  // with shorting switched off) must not receive short/margin/short-option permissions, otherwise
  // the executor would keep constructing orders the broker rejects.
  const brokerShortDisabled = account ? account.shortingEnabled === false : false;
  const brokerMarginMultiplier = account ? Number(account.marginMultiplier) : NaN;
  const brokerMarginDisabled = account && Number.isFinite(brokerMarginMultiplier) && brokerMarginMultiplier <= 1;
  const allowShort = enabled && raw.allowShort === true && !brokerShortDisabled;
  const allowMargin = enabled && raw.allowMargin === true && !brokerMarginDisabled;
  const allowOptions = enabled && raw.allowOptions === true;
  const allowCoveredCalls = allowOptions && raw.allowCoveredCalls !== false && !brokerMarginDisabled;
  // Debit verticals are long-option structures and need no margin; credit verticals do.
  const allowCreditSpreads = allowOptions && raw.allowSpreads !== false && !brokerMarginDisabled;
  const allowDebitSpreads = allowOptions && raw.allowSpreads !== false;
  const allowSpreads = allowDebitSpreads || allowCreditSpreads;

  const allowedStructures = [];
  if (allowOptions) allowedStructures.push('long_call', 'long_put');
  if (allowCoveredCalls) allowedStructures.push('covered_call');
  if (allowDebitSpreads) allowedStructures.push('bull_call_spread', 'bear_put_spread');
  if (allowCreditSpreads) allowedStructures.push('call_credit_spread', 'put_credit_spread');

  const maxShortNotionalUsd = round2(
    Math.min(
      positiveOrInfinity(raw.maxShortNotionalUsd),
      num(raw.maxShortPctEquity, 1) * equity,
    ),
  );
  const maxOptionPremiumUsd = round2(
    Math.min(
      positiveOrInfinity(raw.maxOptionPremiumUsd),
      num(raw.maxOptionPremiumPctEquity, 0.25) * equity,
    ),
  );
  const maxMarginUsd = round2(
    Math.min(
      positiveOrInfinity(raw.maxMarginUsd),
      num(raw.maxMarginPctEquity, 1) * equity,
    ),
  );
  const maxContractsRaw = Number(raw.maxContracts);
  const maxContracts = allowOptions && Number.isFinite(maxContractsRaw) && maxContractsRaw > 0
    ? Math.floor(maxContractsRaw)
    : 0;

  return {
    longStock: true,
    shortStock: allowShort,
    longOptions: allowOptions,
    shortOptions: allowOptions && (allowCoveredCalls || allowSpreads),
    coveredCalls: allowCoveredCalls,
    spreads: allowSpreads,
    margin: allowMargin,
    allowedStructures,
    maxShortNotionalUsd: allowShort ? maxShortNotionalUsd : 0,
    maxOptionPremiumUsd: allowOptions ? maxOptionPremiumUsd : 0,
    maxContracts,
    maxMarginUsd: allowMargin ? maxMarginUsd : 0,
  };
}

/** Operator/status summary of the instrument regime (no secrets; account fields pass through). */
export function instrumentSummary(config, account = null) {
  const raw = config?.instruments ?? {};
  const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  const accountView = {};
  for (const key of [
    'buyingPowerUsd',
    'optionsBuyingPowerUsd',
    'marginMultiplier',
    'shortingEnabled',
    'optionsTradingLevel',
    'marginDebtUsd',
    'regtBuyingPowerUsd',
  ]) {
    if (account && account[key] !== undefined && account[key] !== null) {
      accountView[key] = typeof account[key] === 'boolean' ? account[key] : round2(account[key]);
    }
  }
  return {
    enabled: raw.enabled !== false,
    allowMargin: raw.allowMargin === true,
    allowShort: raw.allowShort === true,
    allowOptions: raw.allowOptions === true,
    allowCoveredCalls: raw.allowCoveredCalls !== false,
    allowSpreads: raw.allowSpreads !== false,
    maxMarginPctEquity: num(raw.maxMarginPctEquity, 1),
    maxShortPctEquity: num(raw.maxShortPctEquity, 1),
    maxOptionPremiumPctEquity: num(raw.maxOptionPremiumPctEquity, 0.25),
    maxContracts: Number.isFinite(Number(raw.maxContracts)) ? Math.floor(Number(raw.maxContracts)) : 0,
    minDTE: num(raw.minDTE, 2),
    maxDTE: num(raw.maxDTE, 14),
    autoCloseDTE: num(raw.autoCloseDTE, 1),
    optionDataFeed: raw.optionDataFeed ?? 'indicative',
    allowNakedShortOptions: false,
    account: accountView,
  };
}

/** Position marks derived from broker positions (marketValue/qty/multiplier), overridden by quotes. */
function marksFromPositions(brokerPositions, prices = {}) {
  const marks = isPlainObject(prices) ? { ...prices } : {};
  for (const position of brokerPositions ?? []) {
    const symbol = String(position?.symbol ?? '').toUpperCase();
    if (symbol === '') continue;
    const qty = Number(position?.qtySigned ?? position?.qty);
    const multiplier = position?.assetClass === 'us_option' ? Number(position?.multiplier) || 100 : 1;
    const marketValue = Number(position?.marketValueUsd);
    if (Number.isFinite(qty) && qty !== 0 && Number.isFinite(marketValue) && marketValue !== 0) {
      // Options are quoted per share but valued at contracts × premium × 100; normalize by both so
      // a $4.68 call never marks as $468 (the 100x equity inflation that halted reconciliation).
      marks[symbol] = round4(Math.abs(marketValue / (qty * multiplier)));
    }
  }
  return marks;
}

/**
 * @param {{ broker: object, ledger: object, registry: object, journal?: object, config: object,
 *   paths?: object, clock?: object }} options
 */
export function createTreasurer({ broker, ledger, registry, journal, config, paths, clock } = {}) {
  if (!broker || !ledger || !registry || !config) {
    throw new AutomatonError(
      'CONFIG_INVALID',
      'createTreasurer requires { broker, ledger, registry, config }',
      { hasBroker: Boolean(broker), hasLedger: Boolean(ledger), hasRegistry: Boolean(registry) },
    );
  }
  void journal; // the Treasurer produces verdicts; only the Reaper writes obituaries
  const currentClock = clock && typeof clock.now === 'function' ? clock : SYSTEM_CLOCK;
  const resolved = { ...statePaths(config), ...(paths ?? {}) };

  let lastTick = null;
  let cachedAccount = null;
  /** @type {Record<string, object>} */
  let mandates = {};

  function isoAt(ms) {
    return new Date(ms).toISOString();
  }

  function mapAccount(account) {
    const view = {
      equityUsd: round2(Number(account?.equityUsd) || 0),
      cashUsd: round2(Number(account?.cashUsd) || 0),
      buyingPowerUsd: round2(Number(account?.buyingPowerUsd) || 0),
      status: String(account?.status ?? 'UNKNOWN'),
    };
    // v3: options/short/margin account facts (pass-through only, never invented).
    for (const key of ['optionsBuyingPowerUsd', 'regtBuyingPowerUsd']) {
      if (account && Number.isFinite(Number(account[key]))) view[key] = round2(Number(account[key]));
    }
    if (account && Number.isFinite(Number(account.marginMultiplier))) view.marginMultiplier = Number(account.marginMultiplier);
    if (account && typeof account.shortingEnabled === 'boolean') view.shortingEnabled = account.shortingEnabled;
    if (account && Number.isFinite(Number(account.optionsTradingLevel))) view.optionsTradingLevel = Number(account.optionsTradingLevel);
    if (account && Number.isFinite(Number(account.marginDebtUsd))) view.marginDebtUsd = round2(Number(account.marginDebtUsd));
    if (account && typeof account.currency === 'string') view.currency = account.currency;
    return view;
  }

  async function fetchBrokerState() {
    const errors = [];
    let account = null;
    let positions = [];
    try {
      account = await broker.getAccount();
    } catch (error) {
      errors.push({ scope: 'account', error: errorInfo(error) });
    }
    if (account) {
      try {
        positions = (await broker.getPositions?.()) ?? [];
      } catch (error) {
        errors.push({ scope: 'positions', error: errorInfo(error) });
      }
    }
    return { account, positions, errors };
  }

  function ensureLedgerRecord(agent, atIso) {
    if (ledger.has(agent.id)) return;
    ledger.ensureAgent(agent.id, {
      endowmentUsd: Number(agent.endowmentUsd ?? config.endowmentUsd ?? 0),
      at: atIso,
    });
  }

  function sizeCapFor(equityUsd) {
    const absolute = Number(config.risk?.maxOrderNotionalUsd);
    const pctCap = Number(config.risk?.maxOrderPctOfEquity ?? 0) * Number(equityUsd);
    const candidates = [];
    if (Number.isFinite(absolute) && absolute > 0) candidates.push(absolute);
    if (Number.isFinite(pctCap) && pctCap > 0) candidates.push(pctCap);
    return candidates.length === 0 ? 0 : round2(Math.min(...candidates));
  }

  function buildMandate(view, { allowExitOnly, at, atMs, ordersToday, accountEquityUsd, allocatedEquityUsd, account = null }) {
    const cap = sizeCapFor(view.equityUsd);
    const instruments = deriveInstrumentPermissions(config, view.equityUsd, account);
    return {
      agentId: view.agentId,
      issuedAt: at,
      expiresAt: isoAt(atMs + EXPIRY_MS.mandate),
      state: view.state,
      // Executor/brakes need a positive size budget to traverse the exit path; new
      // entries are blocked by `allowExitOnly`, not by a zero budget.
      sizeBudgetUsd: cap,
      maxOrderNotionalUsd: cap,
      maxDailyOrdersRemaining: Math.max(0, Number(config.risk?.maxDailyOrders ?? 0) - ordersToday),
      allowedSymbols: [...(config.symbols ?? [])],
      allowExitOnly,
      // Account-level context for the D13 order-time allocation wall (never account cash).
      accountEquityUsd: Number.isFinite(accountEquityUsd) ? round2(accountEquityUsd) : null,
      allocatedEquityUsd: Number.isFinite(allocatedEquityUsd) ? round2(allocatedEquityUsd) : null,
      // v3: the agent's own equity (executor sizing) + instrument permissions/caps.
      equityUsd: round2(view.equityUsd),
      instruments,
    };
  }

  function degradedTick(at, atMs, errors) {
    const aliveCount = registry.population();
    const pool = ledger.pool();
    return {
      at,
      mode: config.mode,
      account: mapAccount(cachedAccount ?? {}),
      state: 'CRITICAL',
      burnPerHourUsd: burnPerHour(config, aliveCount),
      runwayHours: 0,
      cycleBudgetUsd: 0,
      surplus7dUsd: 0,
      mayReplicate: false,
      populationCapRemaining: Math.max(0, registry.cap - aliveCount),
      allocatedUsd: pool.allocatedUsd,
      poolUsd: pool.poolUsd,
      reconciliation: { ok: false, deltaUsd: 0, toleranceUsd: 0 },
      mandates: {},
      agentViews: [],
      verdicts: [],
      halted: true,
      haltReasons: ['broker_unavailable'],
      replication: { surplusOk: false, runwayOk: false, populationOk: false, allocationOk: false },
      instruments: instrumentSummary(config, cachedAccount ?? null),
      marginDebtUsd: 0,
      grossExposureUsd: 0,
      netExposureUsd: 0,
      errors,
    };
  }

  /**
   * Run the metabolism for one cycle: read broker account equity, mark every agent,
   * derive verdicts, issue mandates, persist verdicts, report halt state.
   *
   * @param {{ prices?: Record<string, number>, dayStats?: Record<string, object> }} [options]
   * @returns {Promise<object>} the treasury snapshot documented in CONTRACTS.md
   */
  async function tick({ prices = {}, dayStats = {} } = {}) {
    const atMs = currentClock.now();
    const at = isoAt(atMs);
    const { account, positions: brokerPositions, errors } = await fetchBrokerState();
    if (!account) return degradedTick(at, atMs, errors);
    cachedAccount = account;

    const marks = marksFromPositions(brokerPositions, prices);

    // Anchor the virtual ledger to broker capital exactly once, on the first real read.
    if (!ledger.isAnchored()) {
      try {
        ledger.anchorToBrokerEquity(account.equityUsd);
      } catch (error) {
        errors.push({ scope: 'anchor', error: errorInfo(error) });
      }
    }

    const aliveAgents = registry.alive();
    const allAgents = registry.all();
    const perAgentBurn = burnPerHour(config, 1);
    const agentViews = [];
    const verdicts = [];
    /** @type {Map<string, number>} */
    const floorsById = new Map();

    for (const agent of aliveAgents) {
      const id = agent.id;
      try {
        ensureLedgerRecord(agent, at);
        const eq = ledger.equity(id, marks);
        const snapshot = ledger.snapshot(id);
        const book = ledger.book(id);
        const endowment =
          Number(agent.endowmentUsd ?? config.endowmentUsd) ||
          Number(config.endowmentUsd) ||
          0;
        const floor = effectiveDeathFloor(config, endowment);
        floorsById.set(id, floor);
        const dayStat = (isPlainObject(dayStats) ? dayStats[id] : null) ?? {};
        const startEquityUsd = Number(dayStat.startEquityUsd);
        const dayPnlUsd = Number(dayStat.pnlUsd) || 0;
        const dayPnlPct =
          Number.isFinite(startEquityUsd) && startEquityUsd > 0 ? round4(dayPnlUsd / startEquityUsd) : 0;
        const ordersToday = Number(dayStat.ordersCount) || 0;

        const drawdownThreshold = round2(endowment * (1 - Number(config.maxDrawdownPct ?? 0)));
        let cause = null;
        if (eq.equityUsd <= floor) cause = 'insufficient_funds';
        else if (eq.equityUsd <= drawdownThreshold) cause = 'drawdown_limit';
        else if (
          Number.isFinite(startEquityUsd) &&
          startEquityUsd > 0 &&
          dayPnlUsd <= -Number(config.risk?.maxDailyLossPct ?? 0) * startEquityUsd
        ) {
          cause = 'daily_loss_limit';
        }
        if (cause) verdicts.push({ agentId: id, cause, finalEquityUsd: eq.equityUsd, at });

        const runwayHours = computeRunwayHours(eq.equityUsd, floor, perAgentBurn);
        const state = cause
          ? 'DEAD'
          : classifyTreasuryState({ equityUsd: eq.equityUsd, floorUsd: floor, runwayHours });
        agentViews.push({
          agentId: id,
          generation: Number(agent.generation) || 1,
          equityUsd: eq.equityUsd,
          cashUsd: eq.cashUsd,
          positionsValueUsd: eq.positionsValueUsd,
          runwayHours,
          state,
          drawdownPct: endowment > 0 ? round4(Math.max(0, (endowment - eq.equityUsd) / endowment)) : 0,
          dayPnlPct,
          net7dUsd: snapshot.net7dUsd,
          ordersToday,
          roleCosts: ledger.roleCosts(id),
          positions: book.positions,
          // v3: exposure/margin + the instrument permissions this agent would receive.
          marginDebtUsd: eq.marginDebtUsd ?? 0,
          grossExposureUsd: eq.grossExposureUsd ?? 0,
          netExposureUsd: eq.netExposureUsd ?? 0,
          instruments: deriveInstrumentPermissions(config, eq.equityUsd, account),
        });
      } catch (error) {
        errors.push({ scope: 'agent', agentId: id, error: errorInfo(error) });
      }
    }

    // Reconciliation: sum(virtual equity) + treasury pool vs broker account equity.
    let allocatedAll = 0;
    for (const agent of allAgents) {
      if (agent.id === TREASURY_ID) continue;
      if (!ledger.has(agent.id)) continue;
      try {
        allocatedAll += ledger.equity(agent.id, marks).equityUsd;
      } catch {
        /* an unreadable record is reported by the recon delta itself */
      }
    }
    allocatedAll = round2(allocatedAll);
    const poolInfo = ledger.pool();
    const accountEquityUsd = round2(Number(account.equityUsd) || 0);
    const deltaUsd = round2(accountEquityUsd - (allocatedAll + poolInfo.poolUsd));
    const toleranceUsd = round2(
      Number(config.account?.reconciliationTolerancePct ?? 0.02) * Math.max(1, accountEquityUsd),
    );
    const reconciliation = {
      ok: Math.abs(deltaUsd) <= toleranceUsd + EPSILON,
      deltaUsd,
      toleranceUsd,
    };

    // System-level halts: new orders are blocked, exits stay available.
    const haltReasons = [];
    if (String(account.status ?? '').toUpperCase() !== 'ACTIVE') haltReasons.push('account_not_active');
    if (!reconciliation.ok) haltReasons.push('reconciliation_mismatch');
    const allocationCapUsd = round2(
      Number(config.account?.allocationCapPct ?? 0) * Math.max(0, accountEquityUsd),
    );
    if (allocatedAll > allocationCapUsd + EPSILON) haltReasons.push('allocation_cap');
    const halted = haltReasons.length > 0;

    // Portfolio-level metabolism.
    const aliveEquityUsd = round2(sum(agentViews.map((view) => view.equityUsd)));
    const aliveFloorUsd = round2(sum(agentViews.map((view) => floorsById.get(view.agentId) ?? 0)));
    const burnGlobal = burnPerHour(config, Math.max(1, agentViews.length));
    const runwayHours = computeRunwayHours(aliveEquityUsd, aliveFloorUsd, burnGlobal);
    const state =
      agentViews.length === 0
        ? 'DEAD'
        : classifyTreasuryState({ equityUsd: aliveEquityUsd, floorUsd: aliveFloorUsd, runwayHours });
    const cycleBudgetUsd =
      state === 'DEAD' ? 0 : round2(Number(config.cycleBudget?.[state] ?? 0));

    const surplus7dUsd = round2(sum(agentViews.map((view) => Number(view.net7dUsd) || 0)));
    const populationCapRemaining = Math.max(0, registry.cap - registry.population());
    const childEndowmentUsd = Number(config.replication?.childEndowmentUsd ?? 0);
    const replication = {
      surplusOk: surplus7dUsd >= Number(config.replication?.surplus7dUsd ?? 0),
      runwayOk: runwayHours >= Number(config.replication?.minRunwayHours ?? 0),
      populationOk: populationCapRemaining > 0,
      allocationOk: allocatedAll + childEndowmentUsd <= allocationCapUsd + EPSILON,
      healthy: !halted,
    };
    const mayReplicate =
      replication.surplusOk && replication.runwayOk && replication.populationOk && replication.allocationOk && !halted;

    // Per-agent mandates (exit-only for halted treasury and dying agents).
    mandates = {};
    for (const view of agentViews) {
      const allowExitOnly = halted || view.state === 'DEAD';
      mandates[view.agentId] = buildMandate(view, {
        allowExitOnly,
        at,
        atMs,
        ordersToday: view.ordersToday,
        accountEquityUsd,
        allocatedEquityUsd: allocatedAll,
        account,
      });
    }

    // Persist the death verdicts for the external Reaper's log (it re-derives them).
    try {
      await writeJsonAtomic(resolved.deaths, { at, verdicts: verdicts.map((verdict) => ({ ...verdict })) });
    } catch (error) {
      errors.push({ scope: 'persist-deaths', error: errorInfo(error) });
    }
    try {
      await writeJsonAtomic(resolved.treasuryState, {
        at,
        mode: config.mode,
        state,
        burnPerHourUsd: burnGlobal,
        runwayHours,
        cycleBudgetUsd,
        allocatedUsd: allocatedAll,
        poolUsd: poolInfo.poolUsd,
        reconciliation,
        verdicts,
        halted,
        haltReasons,
        instruments: instrumentSummary(config, account),
      });
    } catch (error) {
      errors.push({ scope: 'persist-treasury', error: errorInfo(error) });
    }

    const marginDebtUsd = round2(sum(agentViews.map((view) => Number(view.marginDebtUsd) || 0)));
    const grossExposureUsd = round2(sum(agentViews.map((view) => Number(view.grossExposureUsd) || 0)));
    const netExposureUsd = round2(sum(agentViews.map((view) => Number(view.netExposureUsd) || 0)));

    const result = {
      at,
      mode: config.mode,
      account: mapAccount(account),
      state,
      burnPerHourUsd: burnGlobal,
      runwayHours,
      cycleBudgetUsd,
      surplus7dUsd,
      mayReplicate,
      populationCapRemaining,
      allocatedUsd: allocatedAll,
      poolUsd: poolInfo.poolUsd,
      reconciliation,
      mandates,
      agentViews,
      verdicts,
      halted,
      haltReasons,
      // extras (not part of the documented shape; useful to the engine/UI/tests)
      replication,
      population: registry.population(),
      marks,
      instruments: instrumentSummary(config, account),
      marginDebtUsd,
      grossExposureUsd,
      netExposureUsd,
      errors,
    };
    lastTick = result;
    return result;
  }

  /** Update a single mandate after a funding change (if mandates already exist). */
  function touchMandate(agentId) {
    const existing = mandates[agentId];
    if (!existing) return;
    try {
      const agent = registry.get(agentId);
      if (!agent || agent.status !== 'alive') return;
      const equity = ledger.equity(agentId, {});
      const view = { agentId, equityUsd: equity.equityUsd, state: existing.state };
      mandates[agentId] = buildMandate(view, {
        allowExitOnly: existing.allowExitOnly === true,
        at: currentClock.iso(),
        atMs: currentClock.now(),
        ordersToday: 0,
        accountEquityUsd: lastTick?.account?.equityUsd,
        allocatedEquityUsd: lastTick?.allocatedUsd,
        account: cachedAccount ?? lastTick?.account ?? null,
      });
    } catch {
      /* a stale mandate is safer than a crash during genesis funding */
    }
  }

  /** Genesis funding: creates the agent's endowment cash (orchestrator calls this once). */
  function grantInitial(agentId, amountUsd) {
    const amount = round2(Number(amountUsd));
    if (!Number.isFinite(amount) || amount <= 0) {
      fail('CONFIG_INVALID', 'grantInitial requires a positive finite amountUsd', { agentId, amountUsd });
    }
    const at = currentClock.iso();
    ledger.ensureAgent(agentId, { endowmentUsd: amount, at });
    ledger.grant(agentId, amount, { reason: 'genesis-endowment', at });
    touchMandate(agentId);
  }

  /**
   * Fund a child from its parent's equity only (D10). Refuses rather than going negative;
   * the Replicator turns a refusal into a logged non-birth.
   */
  function fundChild(parentId, childId, amountUsd) {
    const amount = round2(Number(amountUsd));
    if (!Number.isFinite(amount) || amount <= 0) {
      fail('REPLICATION_DENIED', 'fundChild requires a positive finite amountUsd', { parentId, childId, amountUsd });
    }
    if (parentId === childId) fail('REPLICATION_DENIED', 'a parent cannot fund itself', { parentId, childId });
    const parent = registry.get(parentId);
    if (!parent) fail('UNKNOWN_AGENT', `unknown parent "${parentId}"`, { parentId });
    if (parent.status !== 'alive') {
      fail('AGENT_DEAD', `parent "${parentId}" is dead and cannot fund a child`, { parentId });
    }
    const at = currentClock.iso();
    ledger.ensureAgent(childId, { endowmentUsd: amount, at });
    const parentEquity = ledger.equity(parentId, {}).equityUsd;
    const floor = effectiveDeathFloor(config, parent.endowmentUsd ?? config.endowmentUsd);
    if (parentEquity - amount < floor * 2) {
      fail('REPLICATION_DENIED', 'child endowment would leave the parent below 2x its death floor', {
        parentId,
        childId,
        parentEquityUsd: parentEquity,
        childEndowmentUsd: amount,
        floorUsd: floor,
      });
    }
    ledger.transfer(parentId, childId, amount, { reason: 'child-endowment', at });
    touchMandate(parentId);
    touchMandate(childId);
  }

  /** Fetch account + positions and measure the current reconciliation delta. */
  async function reconcile() {
    const at = currentClock.iso();
    const { account, positions, errors } = await fetchBrokerState();
    if (!account) {
      return { ok: false, deltaUsd: null, toleranceUsd: null, at, errors };
    }
    cachedAccount = account;
    const marks = marksFromPositions(positions, {});
    if (!ledger.isAnchored()) ledger.anchorToBrokerEquity(account.equityUsd);
    let allocatedUsd = 0;
    for (const agent of registry.all()) {
      if (agent.id === TREASURY_ID || !ledger.has(agent.id)) continue;
      try {
        allocatedUsd += ledger.equity(agent.id, marks).equityUsd;
      } catch {
        /* ignore unreadable record; the delta reports it */
      }
    }
    allocatedUsd = round2(allocatedUsd);
    const pool = ledger.pool();
    const accountEquityUsd = round2(Number(account.equityUsd) || 0);
    const deltaUsd = round2(accountEquityUsd - (allocatedUsd + pool.poolUsd));
    const toleranceUsd = round2(
      Number(config.account?.reconciliationTolerancePct ?? 0.02) * Math.max(1, accountEquityUsd),
    );
    return {
      ok: Math.abs(deltaUsd) <= toleranceUsd + EPSILON,
      deltaUsd,
      toleranceUsd,
      allocatedUsd,
      poolUsd: pool.poolUsd,
      accountEquityUsd,
      at,
    };
  }

  return {
    tick,
    grantInitial,
    fundChild,
    reconcile,
    /** @returns {object|null} the most recent tick result */
    get lastTick() {
      return lastTick;
    },
    /** @returns {Record<string, object>} the latest issued mandates */
    get mandates() {
      return mandates;
    },
    /** @returns {string[]} the valid treasury states */
    get states() {
      return [...TREASURY_STATES];
    },
  };
}
