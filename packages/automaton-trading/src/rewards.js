/**
 * REWARDS — v3.3 fair performance rewards: pay CAPITAL from the treasury pool to the
 * agents with the best period TRADING return.
 *
 * Why (docs/FAIR-PNL-REWARDS.md §1/§5): v3.2 paid 5/3/2 % of account CASH on raw equity
 * ranks, so a reward payout instantly raised equity, P&L, rank and the next reward
 * (compounding). v3.3 ranks on period TRADING performance only and pays contributed
 * capital: a payout increases buying power and mandate sizing, never P&L or rank.
 *
 * Virtual money only: a reward is a
 * `ledger.transfer('__treasury__', agentId, amountUsd, {reason:'reward:<periodKey>',
 * category:'reward'})`. With the v3.3 ledger the destination marks the same amount as a
 * capital contribution (`rewardCapitalUsd`), not profit. The broker client still has no
 * transfer/withdraw surface (brake D1), and because the pool is part of
 * `sum(agent equity) + pool`, the treasurer's reconciliation is unaffected.
 *
 * Scheduler semantics (docs/CONTROL-PANEL.md § "Rewards module"):
 *   - the current period key (daily = UTC date, weekly = ISO week, monthly = UTC month)
 *     is anchored on first load, so the initial partial period is never paid;
 *   - when the current key differs from `lastPeriodKey`, one period has completed and
 *     `duePeriod()` returns it (at most once per key — `apply()` advances the anchor);
 *   - eligibility: a MEASURED period trading baseline, period trading profit above
 *     `minTradingProfitUsd`, positive period trading return, `periodTrades >= minTrades`,
 *     and (when supplied by the risk views) `drawdownPct <= maxDrawdownPct`;
 *   - ranking: period trading RETURN desc, tie-break by period trading P&L dollars;
 *   - budget: `rewardBudgetPctOfPool` of the available pool, capped by
 *     `maxPerPeriodUsd`, the remaining allocation cap and the pool itself;
 *   - shares: `rankShares` (default 50/30/20) of the budget, each reward capped at
 *     `maxRewardPerAgentPctOfCapital` of the agent's contributed capital, scaled
 *     proportionally when the shares would exceed the budget, floored to cents;
 *   - no eligible winners / pool / budget -> a `skipped` history entry, no transfer.
 *
 * Reward history keeps the last 50 periods; a persisted per-agent `lifetime` map is
 * seeded from all retained history winners on load (so the ledger migration can rely on
 * `lifetimeForAgent()`); the ledger's `rewardCapitalUsd` stays authoritative.
 *
 * Pure w.r.t. wall clock/randomness: time comes from the injected clock or explicit
 * `nowMs`. State persists atomically to `stateDir/rewards.json`.
 *
 * Contract: docs/FAIR-PNL-REWARDS.md §5. Owner: market teammate.
 *
 * @module rewards
 */

import path from 'node:path';
import { fail } from './contracts.js';
import { statePaths } from './config.js';
import { TREASURY_ID } from './ledger.js';
import { readJson, round2, SYSTEM_CLOCK, writeJsonAtomic } from './util.js';
import { nextPeriodStartMs, periodKeyEndMs, periodKeyFor, periodStartMs } from './rankings.js';

/** Periods the rewards scheduler can pay on. */
export const REWARD_PERIODS = Object.freeze(['daily', 'weekly', 'monthly']);

/** Configured history length (last 50 payouts). */
export const REWARD_HISTORY_LIMIT = 50;

/** v3.3: history entries carry basis/budget + trading metrics; state carries lifetime. */
export const REWARDS_VERSION = 2;

/** The only v3.3 payout basis; `account-cash` is accepted as a deprecated legacy value. */
export const REWARD_BASIS = 'trading-performance';

/** Fallbacks used when the passed config has no (or a malformed) `rewards` section. */
export const REWARD_DEFAULTS = Object.freeze({
  enabled: true,
  period: 'weekly',
  basis: REWARD_BASIS,
  rankShares: Object.freeze([0.5, 0.3, 0.2]),
  rewardBudgetPctOfPool: 0.1,
  maxPerPeriodUsd: null,
  maxRewardPerAgentPctOfCapital: 0.5,
  minTradingProfitUsd: 0.05,
  minTrades: 3,
  maxDrawdownPct: 0.2,
});

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Normalize an explicit timestamp / ISO string / Date; fall back to the clock. */
function normalizeAt(value, clock) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return clock.now();
}

function isoAt(ms) {
  return new Date(ms).toISOString();
}

/** Deep clone of plain JSON-safe state. */
function cloneState(state) {
  try {
    return structuredClone(state);
  } catch {
    return JSON.parse(JSON.stringify(state));
  }
}

/** Deterministic string comparison (no locale/ICU dependence). */
function compareText(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Finite number or null ('' / null / NaN / Infinity -> null). */
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A valid 3-entry fractional share row, or null. */
function validShares(raw) {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const parsed = raw.map((value) => numberOrNull(value));
  if (!parsed.every((value) => value !== null && value >= 0 && value <= 1)) return null;
  return parsed;
}

/** A fraction in [0,1] from config, else the fallback. */
function boundedFraction(value, fallback) {
  const n = numberOrNull(value);
  return n !== null && n >= 0 && n <= 1 ? n : fallback;
}

/** A non-negative number from config, else the fallback. */
function nonNegativeNumber(value, fallback) {
  const n = numberOrNull(value);
  return n !== null && n >= 0 ? n : fallback;
}

/** A non-negative integer from config, else the fallback. */
function nonNegativeInteger(value, fallback) {
  const n = numberOrNull(value);
  return n !== null && n >= 0 ? Math.max(0, Math.trunc(n)) : fallback;
}

/** A nullable non-negative money limit: null/absent means "no limit". */
function optionalMoney(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = numberOrNull(value);
  return n !== null && n >= 0 ? n : null;
}

/**
 * Resolve the v3.3 reward rules from `config.rewards` with local fallbacks, so the
 * module is usable even before/without the config schema.
 *
 * New names win: `rankShares` + `basis:'trading-performance'`. The deprecated v3.2
 * `rankPercents`/`basis:'account-cash'` settings are accepted only as legacy input and
 * mapped away — v3.3 NEVER pays on account cash again.
 *
 * @param {object} [config]
 * @returns {{enabled:boolean, period:'daily'|'weekly'|'monthly',
 *   basis:'trading-performance', rankShares:number[], rewardBudgetPctOfPool:number,
 *   maxPerPeriodUsd:number|null, maxRewardPerAgentPctOfCapital:number,
 *   minTradingProfitUsd:number, minTrades:number, maxDrawdownPct:number}}
 */
export function resolveRewardSettings(config) {
  const raw = config && isPlainObject(config.rewards) ? config.rewards : {};
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : REWARD_DEFAULTS.enabled;
  const period = REWARD_PERIODS.includes(raw.period) ? raw.period : REWARD_DEFAULTS.period;
  // v3.3 is trading-performance only; a legacy 'account-cash' value is mapped away.
  const basis = REWARD_BASIS;
  const rankShares = validShares(raw.rankShares)
    ?? validShares(raw.rankPercents)
    ?? [...REWARD_DEFAULTS.rankShares];
  return {
    enabled,
    period,
    basis,
    rankShares: [...rankShares],
    rewardBudgetPctOfPool: boundedFraction(raw.rewardBudgetPctOfPool, REWARD_DEFAULTS.rewardBudgetPctOfPool),
    maxPerPeriodUsd: optionalMoney(raw.maxPerPeriodUsd),
    maxRewardPerAgentPctOfCapital: boundedFraction(
      raw.maxRewardPerAgentPctOfCapital,
      REWARD_DEFAULTS.maxRewardPerAgentPctOfCapital,
    ),
    minTradingProfitUsd: nonNegativeNumber(raw.minTradingProfitUsd, REWARD_DEFAULTS.minTradingProfitUsd),
    minTrades: nonNegativeInteger(raw.minTrades, REWARD_DEFAULTS.minTrades),
    maxDrawdownPct: boundedFraction(raw.maxDrawdownPct, REWARD_DEFAULTS.maxDrawdownPct),
  };
}

/** The resolved rules as a plain status object (+ human-readable explanation). */
function rulesView(settings) {
  const pct = (value) => `${Math.round(Number(value) * 1000) / 10}%`;
  const explain = [
    'Basis: period TRADING performance only (period trading P&L ÷ period-start contributed capital); reward capital is never counted as P&L or rank.',
    `Eligibility: measured trading baseline, period trading profit > $${settings.minTradingProfitUsd.toFixed(2)}, positive trading return, at least ${settings.minTrades} period trades, and drawdown ≤ ${pct(settings.maxDrawdownPct)} when measured.`,
    `Budget: ${pct(settings.rewardBudgetPctOfPool)} of the available treasury pool${settings.maxPerPeriodUsd === null ? '' : `, capped at $${settings.maxPerPeriodUsd.toFixed(2)} per period`}, and never above the pool or the allocation-cap headroom.`,
    `Rank shares: #1 ${pct(settings.rankShares[0] ?? 0)}, #2 ${pct(settings.rankShares[1] ?? 0)}, #3 ${pct(settings.rankShares[2] ?? 0)} of the budget.`,
    `Per-agent cap: ${pct(settings.maxRewardPerAgentPctOfCapital)} of the agent's current contributed capital.`,
    'Payouts are capital contributions (category reward): they raise buying power and mandate sizing, never trading P&L or rank.',
  ];
  return {
    enabled: settings.enabled,
    period: settings.period,
    basis: settings.basis,
    rankShares: [...settings.rankShares],
    rewardBudgetPctOfPool: settings.rewardBudgetPctOfPool,
    maxPerPeriodUsd: settings.maxPerPeriodUsd,
    maxRewardPerAgentPctOfCapital: settings.maxRewardPerAgentPctOfCapital,
    minTradingProfitUsd: settings.minTradingProfitUsd,
    minTrades: settings.minTrades,
    maxDrawdownPct: settings.maxDrawdownPct,
    explain,
  };
}

/**
 * Normalize one persisted/computed history winner to the documented shape. Legacy v3.2
 * winners used `percent`; it is mapped to `share`. Unknown metrics stay null.
 * @returns {{rank:number, agentId:string, name:string, amountUsd:number, share:number|null,
 *            periodTradingPnlUsd:number|null, periodTradingPnlPct:number|null,
 *            capitalUsd:number|null, periodTrades:number|null}|null}
 */
function normalizeHistoryWinner(raw) {
  if (!isPlainObject(raw)) return null;
  const agentId = typeof raw.agentId === 'string' ? raw.agentId : '';
  if (!agentId) return null;
  const amountUsd = numberOrNull(raw.amountUsd);
  const share = numberOrNull(raw.share ?? raw.percent);
  return {
    rank: Math.max(0, Math.trunc(numberOrNull(raw.rank) ?? 0)),
    agentId,
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : agentId,
    amountUsd: round2(Math.max(0, amountUsd ?? 0)),
    share: share === null ? null : share,
    periodTradingPnlUsd: numberOrNull(raw.periodTradingPnlUsd),
    periodTradingPnlPct: numberOrNull(raw.periodTradingPnlPct),
    capitalUsd: numberOrNull(raw.capitalUsd),
    periodTrades: numberOrNull(raw.periodTrades),
  };
}

/** Normalize one persisted history entry (tolerant: a corrupt entry is dropped). */
function normalizeHistoryEntry(raw) {
  if (!isPlainObject(raw)) return null;
  const winners = (Array.isArray(raw.winners) ? raw.winners : []).map(normalizeHistoryWinner).filter(Boolean);
  /** @type {object} */
  const entry = {
    period: REWARD_PERIODS.includes(raw.period) ? raw.period : typeof raw.period === 'string' ? raw.period : null,
    periodKey: typeof raw.periodKey === 'string' && raw.periodKey !== '' ? raw.periodKey : null,
    at: typeof raw.at === 'string' ? raw.at : null,
    basis: typeof raw.basis === 'string' ? raw.basis : null,
    budgetUsd: round2(Math.max(0, numberOrNull(raw.budgetUsd) ?? 0)),
    winners,
  };
  if (raw.skipped === true) entry.skipped = true;
  if (typeof raw.reason === 'string' && raw.reason !== '') entry.reason = raw.reason;
  if (Array.isArray(raw.errors) && raw.errors.length > 0) entry.errors = raw.errors.filter(isPlainObject);
  return entry;
}

/** @returns {{version:number, lastPeriodKey:string|null, lastRunAt:string|null,
 *            lastWinners:Array<object>, history:Array<object>, lifetime:Record<string, number>,
 *            nextRunAt:string|null, updatedAt:string|null}} */
function emptyState() {
  return {
    version: REWARDS_VERSION,
    lastPeriodKey: null,
    lastRunAt: null,
    lastWinners: [],
    history: [],
    lifetime: {},
    nextRunAt: null,
    updatedAt: null,
  };
}

/**
 * Seed the cumulative per-agent lifetime map from every retained history winner (plus
 * `lastWinners` that are not yet in history, deduped by periodKey+agent). A persisted
 * counter, when present, wins over the retained-history sum (history is capped at 50).
 * @param {Array<object>} history
 * @param {Array<object>} lastWinners
 * @param {object} persisted
 * @returns {Record<string, number>}
 */
function seedLifetime(history, lastWinners, persisted) {
  const seeded = {};
  const seen = new Set();
  for (const entry of history) {
    const periodKey = typeof entry.periodKey === 'string' ? entry.periodKey : null;
    for (const winner of entry.winners) {
      if (!(winner.amountUsd > 0)) continue;
      seeded[winner.agentId] = round2((seeded[winner.agentId] ?? 0) + winner.amountUsd);
      if (periodKey) seen.add(`${periodKey}:${winner.agentId}`);
    }
  }
  for (const winner of lastWinners) {
    const periodKey = typeof winner.periodKey === 'string' ? winner.periodKey : null;
    if (periodKey && seen.has(`${periodKey}:${winner.agentId}`)) continue;
    if (!(winner.amountUsd > 0)) continue;
    seeded[winner.agentId] = round2((seeded[winner.agentId] ?? 0) + winner.amountUsd);
  }
  const lifetime = { ...seeded };
  if (isPlainObject(persisted)) {
    for (const [agentId, amount] of Object.entries(persisted)) {
      const n = numberOrNull(amount);
      if (!agentId || n === null || n < 0) continue;
      lifetime[agentId] = Math.max(round2(n), lifetime[agentId] ?? 0);
    }
  }
  return lifetime;
}

/** Tolerantly rebuild persisted state (a corrupt file means "no payouts yet"). */
function normalizeState(raw) {
  const state = emptyState();
  if (!isPlainObject(raw)) return state;
  state.lastPeriodKey = typeof raw.lastPeriodKey === 'string' && raw.lastPeriodKey !== '' ? raw.lastPeriodKey : null;
  state.lastRunAt = typeof raw.lastRunAt === 'string' ? raw.lastRunAt : null;
  state.nextRunAt = typeof raw.nextRunAt === 'string' ? raw.nextRunAt : null;
  state.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;
  state.lastWinners = (Array.isArray(raw.lastWinners) ? raw.lastWinners : [])
    .map((winner) => {
      const normalized = normalizeHistoryWinner(winner);
      if (!normalized) return null;
      return {
        ...normalized,
        periodKey: typeof winner.periodKey === 'string' && winner.periodKey !== '' ? winner.periodKey : null,
        at: typeof winner.at === 'string' ? winner.at : null,
      };
    })
    .filter(Boolean);
  const history = (Array.isArray(raw.history) ? raw.history : [])
    .map(normalizeHistoryEntry)
    .filter(Boolean);
  state.history = history.slice(-REWARD_HISTORY_LIMIT);
  state.lifetime = seedLifetime(state.history, state.lastWinners, raw.lifetime);
  return state;
}

/** Money helper: floor to cents so a scaled payout can never exceed its cap. */
function floorCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n * 100 + 1e-9) / 100;
}

/**
 * Eligibility of one rankings row under the v3.3 rules. A row wins only on a measured
 * period TRADING performance — never on equity change (reward capital is not profit).
 * @param {object|null} row
 * @param {object} settings
 * @param {object} [riskByAgent]
 * @returns {{eligible:boolean, reason?:string, agentId?:string, row?:object, name?:string,
 *            metrics?:{tradingPnlUsd:number, tradingPnlPct:number, capitalUsd:number|null,
 *            baselineCapitalUsd:number|null, periodTrades:number}}}
 */
function evaluateRow(row, settings, riskByAgent) {
  if (!isPlainObject(row)) return { eligible: false, reason: 'invalid_row' };
  const agentId = typeof row.agentId === 'string' ? row.agentId.trim() : '';
  if (!agentId) return { eligible: false, reason: 'invalid_row' };
  const tradingPnlUsd = numberOrNull(row.tradingPnlUsd);
  const baselineTradingPlUsd = numberOrNull(row.baselineTradingPlUsd);
  // A trading baseline is measured only when both the period start and the period end
  // carry a trading P&L reading; legacy equity-only rows are skipped, never fabricated.
  if (tradingPnlUsd === null || baselineTradingPlUsd === null) {
    return { eligible: false, reason: 'no_measured_trading_baseline' };
  }
  if (!(tradingPnlUsd > settings.minTradingProfitUsd)) {
    return { eligible: false, reason: 'trading_profit_below_minimum' };
  }
  const tradingPnlPct = numberOrNull(row.tradingPnlPct);
  if (tradingPnlPct === null || !(tradingPnlPct > 0)) {
    return { eligible: false, reason: 'trading_return_not_positive' };
  }
  const periodTrades = numberOrNull(row.periodTrades);
  if (periodTrades === null || periodTrades < settings.minTrades) {
    return { eligible: false, reason: 'too_few_trades' };
  }
  // Drawdown gate: the risk views are authoritative, a row-level value is the fallback.
  const risk = riskByAgent && isPlainObject(riskByAgent) ? riskByAgent[agentId] : null;
  const riskDrawdown = risk !== null && risk !== undefined
    ? (typeof risk === 'object' ? numberOrNull(risk.drawdownPct) : numberOrNull(risk))
    : null;
  const drawdownPct = riskDrawdown ?? numberOrNull(row.drawdownPct);
  if (drawdownPct !== null && drawdownPct > settings.maxDrawdownPct) {
    return { eligible: false, reason: 'drawdown_gate' };
  }
  return {
    eligible: true,
    agentId,
    row,
    name: typeof row.name === 'string' && row.name !== '' ? row.name : agentId,
    metrics: {
      tradingPnlUsd,
      tradingPnlPct,
      capitalUsd: numberOrNull(row.capitalUsd),
      baselineCapitalUsd: numberOrNull(row.baselineCapitalUsd),
      periodTrades,
    },
  };
}

/** Fair reward ordering: period trading return desc, then trading P&L desc, then name. */
function compareEligible(a, b) {
  if (b.metrics.tradingPnlPct !== a.metrics.tradingPnlPct) {
    return b.metrics.tradingPnlPct - a.metrics.tradingPnlPct;
  }
  if (b.metrics.tradingPnlUsd !== a.metrics.tradingPnlUsd) {
    return b.metrics.tradingPnlUsd - a.metrics.tradingPnlUsd;
  }
  return compareText(a.name, b.name) || compareText(a.agentId, b.agentId);
}

/**
 * The winner payload recorded in history and returned by `apply()`. `share` is the
 * configured rank share (e.g. 0.5 for #1) of the reward budget.
 * @param {{rank:number, agentId:string, name:string, amountUsd:number, share:number,
 *          metrics:object}} winner
 */
function winnerRecord({ rank, agentId, name, amountUsd, share, metrics }) {
  return {
    rank,
    agentId,
    name,
    amountUsd: round2(Math.max(0, amountUsd)),
    share,
    periodTradingPnlUsd: metrics.tradingPnlUsd,
    periodTradingPnlPct: metrics.tradingPnlPct,
    capitalUsd: metrics.capitalUsd,
    periodTrades: metrics.periodTrades,
  };
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

/**
 * Create the rewards scheduler/state.
 *
 * @param {{
 *   paths?: { rewardsFile?: string },
 *   config?: object,
 *   clock?: { now: () => number, iso: () => string },
 * }} deps `paths` is the object from `statePaths(config)`; `config` is a fallback.
 * @returns {{
 *   load: () => Promise<object>,
 *   save: () => Promise<string>,
 *   duePeriod: (nowMs?: number|string|Date) => ({period:string, periodKey:string,
 *              completed:true, currentPeriodKey:string}|null),
 *   apply: (input: object) => Promise<object>,
 *   status: () => object,
 *   getState: () => object,
 *   hydrate: (source: object) => object,
 *   reconfigure: (config?: object) => object,
 *   lifetimeForAgent: (agentId: string) => number,
 *   historyForAgent: (agentId: string, options?: {limit?: number}) => Array<object>,
 *   describe: () => object,
 *   path: string,
 * }}
 */
export function createRewards({ paths, config, clock } = {}) {
  const currentClock = clock ?? SYSTEM_CLOCK;
  const resolvedPaths = paths ?? (config ? statePaths(config) : null);
  const file = resolvedPaths?.rewardsFile
    ?? (config?.paths?.stateDir ? path.join(String(config.paths.stateDir), 'rewards.json') : null);
  if (!file) {
    fail('CONFIG_INVALID', 'createRewards requires paths.rewardsFile (from statePaths(config))');
  }
  const rewardsPath = String(file);

  let settings = resolveRewardSettings(config);
  /** @type {ReturnType<typeof emptyState>} */
  let state = emptyState();

  function anchor(nowMs) {
    state.lastPeriodKey = periodKeyFor(settings.period, nowMs);
    state.nextRunAt = isoAt(nextPeriodStartMs(settings.period, nowMs));
    return state.lastPeriodKey;
  }

  async function load() {
    const raw = await readJson(rewardsPath, null);
    state = normalizeState(raw);
    const nowMs = currentClock.now();
    if (state.lastPeriodKey === null) anchor(nowMs);
    else if (state.nextRunAt === null) state.nextRunAt = isoAt(nextPeriodStartMs(settings.period, nowMs));
    return getState();
  }

  async function save() {
    await writeJsonAtomic(rewardsPath, state);
    return rewardsPath;
  }

  function getState() {
    return cloneState(state);
  }

  /**
   * Adopt a previous state (or a previous rewards instance) verbatim, e.g. when the
   * orchestrator swaps instances on a live settings update. History/lifetime survive and
   * a missing anchor is restored from the current clock.
   * @param {object|null} source state object from `getState()` or a rewards instance
   * @returns {object} the hydrated state
   */
  function hydrate(source) {
    const raw = source && typeof source.getState === 'function' ? source.getState() : source;
    state = normalizeState(raw);
    const nowMs = currentClock.now();
    if (state.lastPeriodKey === null) anchor(nowMs);
    else if (state.nextRunAt === null) state.nextRunAt = isoAt(nextPeriodStartMs(settings.period, nowMs));
    state.updatedAt = isoAt(nowMs);
    return getState();
  }

  /**
   * The just-completed period, or null when no period boundary has been crossed.
   * Anchors `lastPeriodKey` on first use so the initial partial period is never paid.
   *
   * @param {number|string|Date} [nowMsInput]
   * @returns {{period:string, periodKey:string, completed:true, currentPeriodKey:string}|null}
   */
  function duePeriod(nowMsInput) {
    const nowMs = normalizeAt(nowMsInput, currentClock);
    const currentKey = periodKeyFor(settings.period, nowMs);
    if (state.lastPeriodKey === null) {
      anchor(nowMs);
      return null;
    }
    if (!settings.enabled) return null;
    if (state.lastPeriodKey === currentKey) return null;
    return {
      period: settings.period,
      periodKey: state.lastPeriodKey,
      completed: true,
      currentPeriodKey: currentKey,
    };
  }

  /**
   * Resolve the completed period's leaderboard snapshot. `rankings` may be a computed
   * snapshot (has `periods`) or the rankings module itself (has `compute()`); the module
   * is asked for the instant just before the completed boundary with `stored: true`, so
   * the archived trading baselines of the period that just ended are still in scope.
   */
  function resolveSnapshot(rankings, rankingPeriod, due, nowMs) {
    if (rankings && isPlainObject(rankings) && isPlainObject(rankings.periods)) return rankings;
    const completedEndMs = periodKeyEndMs(rankingPeriod, due.periodKey);
    const rankAtMs = (Number.isFinite(completedEndMs) ? completedEndMs : periodStartMs(rankingPeriod, nowMs)) - 1;
    if (rankings && typeof rankings.compute === 'function') {
      return rankings.compute({ atMs: Math.max(0, rankAtMs), stored: true });
    }
    if (typeof rankings === 'function') return rankings({ atMs: Math.max(0, rankAtMs), stored: true });
    return null;
  }

  /**
   * Pay the completed period's top eligible agents. Never pays the same periodKey twice.
   *
   * @param {{
   *   due: {period?:string, periodKey:string, currentPeriodKey?:string},
   *   rankings: object,
   *   accountCashUsd?: number,
   *   poolUsd?: number,
   *   allocationCapRemainingUsd?: number,
   *   riskByAgent?: Record<string, {drawdownPct?: number|null}>,
   *   ledger: { transfer: Function },
   *   nowMs?: number|string|Date,
   * }} input `accountCashUsd` is accepted for backward compatibility but never sets an
   *   amount (v3.3 pays capital from the pool budget, not a % of cash).
   * @returns {Promise<{applied:boolean, period:string, periodKey:string|null, at?:string,
   *           basis:string, budgetUsd:number, eligibleCount:number,
   *           winners:Array<object>, skipped:boolean, reason?:string,
   *           errors?:Array<object>, nextRunAt?:string}>}
   */
  async function apply({
    due,
    rankings,
    accountCashUsd: _accountCashUsd,
    poolUsd,
    allocationCapRemainingUsd,
    riskByAgent,
    ledger,
    nowMs: nowInput,
  } = {}) {
    const nowMs = normalizeAt(nowInput, currentClock);
    const at = isoAt(nowMs);
    const fallbackPeriod = settings.period;
    const basis = settings.basis;
    if (!settings.enabled) {
      return {
        applied: false,
        period: fallbackPeriod,
        periodKey: due?.periodKey ?? null,
        basis,
        budgetUsd: 0,
        eligibleCount: 0,
        winners: [],
        skipped: true,
        reason: 'disabled',
      };
    }
    if (!due || typeof due !== 'object' || typeof due.periodKey !== 'string' || due.periodKey === '') {
      fail('CONFIG_INVALID', 'rewards.apply requires the due period returned by duePeriod()', { due });
    }
    if (!ledger || typeof ledger.transfer !== 'function') {
      fail('CONFIG_INVALID', 'rewards.apply requires a ledger with transfer()');
    }
    const rankingPeriod = REWARD_PERIODS.includes(due.period) ? due.period : fallbackPeriod;
    const targetKey = typeof due.currentPeriodKey === 'string' && due.currentPeriodKey !== ''
      ? due.currentPeriodKey
      : periodKeyFor(settings.period, nowMs);

    // Idempotency: a due period is payable exactly once. apply() advances the anchor,
    // so a second call (or a retry after success) reports already_applied.
    if (state.lastPeriodKey !== null && state.lastPeriodKey !== due.periodKey) {
      return {
        applied: false,
        period: rankingPeriod,
        periodKey: due.periodKey,
        basis,
        budgetUsd: 0,
        eligibleCount: 0,
        winners: [],
        skipped: true,
        reason: 'already_applied',
      };
    }

    // --- resolve the completed period's leaderboard ---------------------------
    const snapshot = resolveSnapshot(rankings, rankingPeriod, due, nowMs);
    const rows = Array.isArray(snapshot?.periods?.[rankingPeriod]) ? snapshot.periods[rankingPeriod] : [];

    // --- budget: a share of the available treasury pool, capped ---------------
    const poolAvailableUsd = Math.max(0, numberOrNull(poolUsd) ?? 0);
    const allocationRaw = allocationCapRemainingUsd;
    const allocationAvailableUsd = allocationRaw === null || allocationRaw === undefined || allocationRaw === ''
      ? Infinity
      : Number.isFinite(Number(allocationRaw)) ? Math.max(0, Number(allocationRaw)) : Infinity;
    const maxPerPeriodUsd = settings.maxPerPeriodUsd === null ? Infinity : Math.max(0, settings.maxPerPeriodUsd);
    const budgetUsd = floorCents(Math.min(
      poolAvailableUsd * settings.rewardBudgetPctOfPool,
      poolAvailableUsd,
      allocationAvailableUsd,
      maxPerPeriodUsd,
    ));

    // --- eligibility + fair ordering -----------------------------------------
    const eligible = [];
    const rejections = [];
    for (const row of rows) {
      const verdict = evaluateRow(row, settings, riskByAgent);
      if (verdict.eligible) eligible.push(verdict);
      else rejections.push({ agentId: typeof row?.agentId === 'string' ? row.agentId : null, reason: verdict.reason ?? 'ineligible' });
    }
    eligible.sort(compareEligible);
    const rowCount = rows.length;

    /** Record the skipped period once (no transfer, no lifetime change) and advance. */
    async function skip(reason) {
      const entry = {
        period: rankingPeriod,
        periodKey: due.periodKey,
        at,
        basis,
        budgetUsd,
        winners: [],
        skipped: true,
        reason,
      };
      state.history.push(entry);
      if (state.history.length > REWARD_HISTORY_LIMIT) state.history = state.history.slice(-REWARD_HISTORY_LIMIT);
      state.lastPeriodKey = targetKey;
      state.lastRunAt = at;
      state.lastWinners = [];
      state.nextRunAt = isoAt(nextPeriodStartMs(settings.period, nowMs));
      state.updatedAt = at;
      await save();
      return {
        applied: true,
        period: rankingPeriod,
        periodKey: due.periodKey,
        at,
        basis,
        budgetUsd,
        eligibleCount: eligible.length,
        winners: [],
        skipped: true,
        reason,
        nextRunAt: state.nextRunAt,
      };
    }

    if (eligible.length === 0) {
      // Legacy equity-only rows have no measured trading baseline: report that distinctly
      // from rows that were measured but failed a threshold, so operators can see why a
      // payout was skipped right after the v3.3 upgrade.
      const reason = rowCount === 0
        ? 'no_candidates'
        : rejections.every((entry) => entry.reason === 'no_measured_trading_baseline')
          ? 'no_measured_trading_baseline'
          : 'no_eligible_agents';
      return skip(reason);
    }
    if (!(budgetUsd > 0)) return skip('no_budget');

    // --- allocate rank shares, scale to the budget, apply the per-agent cap ----
    const shares = settings.rankShares;
    const selected = eligible.slice(0, shares.length);
    const requested = selected.map((candidate, index) => {
      const share = Math.max(0, numberOrNull(shares[index]) ?? 0);
      return { candidate, share, requestedUsd: budgetUsd * share };
    });
    const totalRequestedUsd = requested.reduce((sum, entry) => sum + entry.requestedUsd, 0);
    const scale = totalRequestedUsd > budgetUsd && totalRequestedUsd > 0
      ? budgetUsd / totalRequestedUsd
      : 1;
    const planned = requested
      .map((entry, index) => {
        const row = entry.candidate.row;
        // Per-agent cap: a single reward ≤ pct of the agent's contributed capital.
        const capitalUsd = numberOrNull(row?.capitalUsd)
          ?? numberOrNull(row?.baselineCapitalUsd)
          ?? 0;
        const capUsd = Math.max(0, capitalUsd) * settings.maxRewardPerAgentPctOfCapital;
        const amountUsd = floorCents(Math.min(entry.requestedUsd * scale, capUsd));
        return winnerRecord({
          rank: index + 1,
          agentId: entry.candidate.agentId,
          name: entry.candidate.name,
          amountUsd,
          share: entry.share,
          metrics: entry.candidate.metrics,
        });
      })
      .filter((winner) => winner.amountUsd > 0);

    // --- pay: treasury -> agent, classified by the ledger as reward capital ---
    const paid = [];
    const errors = [];
    for (const winner of planned) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await ledger.transfer(TREASURY_ID, winner.agentId, winner.amountUsd, {
          reason: `reward:${due.periodKey}`,
          category: 'reward',
          at: nowMs,
        });
        paid.push(winner);
      } catch (error) {
        errors.push({
          agentId: winner.agentId,
          code: error?.code ?? 'ERROR',
          message: String(error?.message ?? error).slice(0, 160),
        });
      }
    }
    const skipped = paid.length === 0;
    const reason = skipped ? 'no_transfers' : undefined;

    // --- record history + lifetime + advance the period anchor ---------------
    /** @type {object} */
    const historyEntry = {
      period: rankingPeriod,
      periodKey: due.periodKey,
      at,
      basis,
      budgetUsd,
      winners: paid.map((winner) => ({ ...winner })),
    };
    if (skipped) {
      historyEntry.skipped = true;
      historyEntry.reason = reason;
    }
    if (errors.length > 0) historyEntry.errors = errors;
    state.history.push(historyEntry);
    if (state.history.length > REWARD_HISTORY_LIMIT) state.history = state.history.slice(-REWARD_HISTORY_LIMIT);
    for (const winner of paid) {
      state.lifetime[winner.agentId] = round2((state.lifetime[winner.agentId] ?? 0) + winner.amountUsd);
    }
    state.lastPeriodKey = targetKey;
    state.lastRunAt = at;
    state.lastWinners = paid.map((winner) => ({ ...winner, periodKey: due.periodKey, at }));
    state.nextRunAt = isoAt(nextPeriodStartMs(settings.period, nowMs));
    state.updatedAt = at;
    await save();

    /** @type {object} */
    const result = {
      applied: true,
      period: rankingPeriod,
      periodKey: due.periodKey,
      at,
      basis,
      budgetUsd,
      eligibleCount: eligible.length,
      winners: paid.map((winner) => ({ ...winner })),
      skipped,
      nextRunAt: state.nextRunAt,
    };
    if (reason) result.reason = reason;
    if (errors.length > 0) result.errors = errors;
    return result;
  }

  /**
   * Current scheduler settings + last payout, for the engine status payload.
   * @returns {object} flat resolved settings (new names), `rules` + `explain`, last
   *   payout, next run and lifetime total.
   */
  function status() {
    const nowMs = currentClock.now();
    const currentKey = periodKeyFor(settings.period, nowMs);
    const nextRunAt = state.lastPeriodKey === currentKey || state.nextRunAt === null
      ? isoAt(nextPeriodStartMs(settings.period, nowMs))
      : state.nextRunAt;
    const rules = rulesView(settings);
    return {
      enabled: settings.enabled,
      period: settings.period,
      basis: settings.basis,
      rankShares: [...settings.rankShares],
      // Deprecated v3.2 alias (kept so older clients do not break); v3.3 reads rankShares.
      rankPercents: [...settings.rankShares],
      rewardBudgetPctOfPool: settings.rewardBudgetPctOfPool,
      maxPerPeriodUsd: settings.maxPerPeriodUsd,
      maxRewardPerAgentPctOfCapital: settings.maxRewardPerAgentPctOfCapital,
      minTradingProfitUsd: settings.minTradingProfitUsd,
      minTrades: settings.minTrades,
      maxDrawdownPct: settings.maxDrawdownPct,
      rules,
      explain: rules.explain,
      lastRunAt: state.lastRunAt,
      nextRunAt,
      lastWinners: cloneState(state.lastWinners),
      historyCount: state.history.length,
      lastPeriodKey: state.lastPeriodKey,
      lifetimeTotalUsd: round2(Object.values(state.lifetime).reduce((sum, value) => sum + value, 0)),
    };
  }

  /** Cumulative lifetime reward capital recorded for one agent (ledger is authoritative). */
  function lifetimeForAgent(agentId) {
    const id = String(agentId ?? '').trim();
    if (!id) return 0;
    return round2(state.lifetime[id] ?? 0);
  }

  /**
   * One agent's reward history rows, flattened from the persisted periods and returned
   * chronologically (oldest first, so `rows.at(-1)` is the latest reward).
   * @param {string} agentId
   * @param {{limit?: number}} [options]
   * @returns {Array<{period:string|null, periodKey:string|null, at:string|null,
   *   rank:number|null, amountUsd:number, share:number|null,
   *   periodTradingPnlUsd:number|null, periodTradingPnlPct:number|null,
   *   capitalUsd:number|null, periodTrades:number|null}>}
   */
  function historyForAgent(agentId, { limit = REWARD_HISTORY_LIMIT } = {}) {
    const id = String(agentId ?? '').trim();
    if (!id) return [];
    const rows = [];
    for (const entry of state.history) {
      for (const winner of entry.winners) {
        if (winner.agentId !== id) continue;
        rows.push({
          period: entry.period ?? null,
          periodKey: entry.periodKey ?? null,
          at: entry.at ?? null,
          rank: winner.rank ?? null,
          amountUsd: round2(winner.amountUsd ?? 0),
          share: winner.share ?? null,
          periodTradingPnlUsd: winner.periodTradingPnlUsd ?? null,
          periodTradingPnlPct: winner.periodTradingPnlPct ?? null,
          capitalUsd: winner.capitalUsd ?? null,
          periodTrades: winner.periodTrades ?? null,
        });
      }
    }
    const bounded = Math.max(1, Math.min(REWARD_HISTORY_LIMIT, Math.trunc(numberOrNull(limit) ?? REWARD_HISTORY_LIMIT)));
    return rows.slice(-bounded);
  }

  /** Re-resolve settings from a new config (control-panel live update) and re-anchor. */
  function reconfigure(nextConfig) {
    settings = resolveRewardSettings(nextConfig ?? config);
    anchor(currentClock.now());
    state.updatedAt = isoAt(currentClock.now());
    return status();
  }

  return {
    load,
    save,
    duePeriod,
    apply,
    status,
    getState,
    hydrate,
    reconfigure,
    lifetimeForAgent,
    historyForAgent,
    describe() {
      const view = status();
      return {
        role: 'rewards',
        version: REWARDS_VERSION,
        ...view,
        history: state.history.slice(-5),
        lifetime: cloneState(state.lifetime),
        path: rewardsPath,
      };
    },
    get path() {
      return rewardsPath;
    },
  };
}

export default createRewards;
