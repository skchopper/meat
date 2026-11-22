/**
 * RANKINGS — deterministic, persisted daily / weekly / monthly leaderboards.
 *
 * Pure bookkeeping for the operator control panel: it observes per-agent equity and
 * TRADING P&L and computes period performance against the values observed at the start
 * of the period. It never trades, never moves money, and never reads the broker.
 *
 * v3.3 fair P&L (docs/FAIR-PNL-REWARDS.md §4): reward payouts are CAPITAL contributions,
 * not profit. An observation therefore carries, besides `equityUsd`/`trades`, the
 * agent's lifetime trading P&L (`tradingPlUsd = equity − contributed capital`) and its
 * contributed capital (`capitalUsd`). Period ranking uses the change in trading P&L
 * (period trading return), so a reward payout can never lift an agent's rank.
 *
 * Baseline semantics (docs/CONTROL-PANEL.md § "Rankings module"):
 *   - the FIRST observation of an agent in a period sets that period's baseline;
 *   - when a new period starts, the PREVIOUS period's last observation is carried
 *     forward as the new baseline (equity, trades and the trading/capital marks), so a
 *     period's performance is measured from the start of the period even though
 *     observations are sampled every tick;
 *   - without a baseline (or without a trading-P&L reading at the baseline) the entry
 *     is ranked last and its trading P&L / return / period trades are `null` — never a
 *     fabricated number, and the rewards scheduler will not pay it.
 *
 * Legacy compatibility: observations may omit `tradingPlUsd`/`capitalUsd` and persisted
 * v3.2 state (no trading fields) loads cleanly; the equity-delta `pnlUsd`/`pnlPct`
 * fields are still computed for compatibility, but only the trading fields are used for
 * fair rewards.
 *
 * Determinism: time comes from the injected clock (or explicit `atMs`); there is no
 * `Date.now()`, no `Math.random()`, and no locale-dependent comparison. Persistence is
 * an atomic JSON write to `stateDir/rankings.json`.
 *
 * Contract: docs/FAIR-PNL-REWARDS.md §4 + docs/CONTROL-PANEL.md § "Rankings module".
 * Owner: market teammate.
 *
 * @module rankings
 */

import path from 'node:path';
import { fail } from './contracts.js';
import { statePaths } from './config.js';
import { readJson, round, round2, SYSTEM_CLOCK, writeJsonAtomic } from './util.js';

/** Periods the control panel exposes. */
export const PERIODS = Object.freeze(['daily', 'weekly', 'monthly']);

/** v3.3: observations/baselines carry trading P&L + contributed capital. */
export const RANKINGS_VERSION = 2;

/** Keep percent fractions exact enough for stable tie-breaking. */
const PCT_DECIMALS = 6;

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

/** Finite number from a persisted/observed value ('' / null / NaN / Infinity -> null). */
function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Trading P&L reading: round2, or null when it was never measured. */
function normalizeTradingPl(value) {
  const n = finiteNumber(value);
  return n === null ? null : round2(n);
}

/** Contributed capital reading: round2, or null when absent/negative (never fabricated). */
function normalizeCapital(value) {
  const n = finiteNumber(value);
  return n === null || n < 0 ? null : round2(n);
}

// ---------------------------------------------------------------------------
// period key helpers (exported for rewards.js and for tests)
// ---------------------------------------------------------------------------

function utcParts(atMs) {
  const date = new Date(atMs);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth(), day: date.getUTCDate() };
}

/** UTC day key `YYYY-MM-DD` (e.g. `2026-10-29`). */
export function utcDateKey(atMs) {
  const { year, month, day } = utcParts(atMs);
  const mm = String(month + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/** ISO-8601 week key `YYYY-Www`, weeks starting Monday (e.g. `2026-W44`). */
export function isoWeekKey(atMs) {
  const date = new Date(atMs);
  // ISO week = the week containing the Thursday; move to that Thursday first.
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const isoDay = thursday.getUTCDay() || 7; // Mon=1 .. Sun=7
  thursday.setUTCDate(thursday.getUTCDate() + 4 - isoDay);
  const weekYear = thursday.getUTCFullYear();
  const yearStart = Date.UTC(weekYear, 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${weekYear}-W${String(week).padStart(2, '0')}`;
}

/** UTC month key `YYYY-MM` (e.g. `2026-10`). */
export function utcMonthKey(atMs) {
  const { year, month } = utcParts(atMs);
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}

/**
 * The current key of every period at one instant.
 * @param {number} atMs epoch ms
 * @returns {{daily:string, weekly:string, monthly:string}}
 */
export function periodKeys(atMs) {
  return {
    daily: utcDateKey(atMs),
    weekly: isoWeekKey(atMs),
    monthly: utcMonthKey(atMs),
  };
}

/**
 * The key of one named period at one instant.
 * @param {'daily'|'weekly'|'monthly'} period
 * @param {number} atMs epoch ms
 * @returns {string}
 */
export function periodKeyFor(period, atMs) {
  if (period === 'daily') return utcDateKey(atMs);
  if (period === 'weekly') return isoWeekKey(atMs);
  if (period === 'monthly') return utcMonthKey(atMs);
  fail('CONFIG_INVALID', `unknown rankings period "${period}"`, { period });
  return '';
}

/**
 * First boundary strictly after `atMs` for the given period (UTC).
 * Used by the rewards scheduler for `nextRunAt`.
 * @param {'daily'|'weekly'|'monthly'} period
 * @param {number} atMs epoch ms
 * @returns {number} epoch ms of the next boundary
 */
export function nextPeriodStartMs(period, atMs) {
  const { year, month, day } = utcParts(atMs);
  if (period === 'daily') return Date.UTC(year, month, day + 1);
  if (period === 'monthly') return Date.UTC(year, month + 1, 1);
  if (period === 'weekly') {
    const isoDay = new Date(Date.UTC(year, month, day)).getUTCDay() || 7; // Mon=1 .. Sun=7
    const addDays = (8 - isoDay) % 7 || 7; // next Monday, never today
    return Date.UTC(year, month, day + addDays);
  }
  fail('CONFIG_INVALID', `unknown rankings period "${period}"`, { period });
  return atMs;
}

/**
 * Start (UTC epoch ms) of the period containing `atMs`.
 * @param {'daily'|'weekly'|'monthly'} period
 * @param {number} atMs epoch ms
 * @returns {number}
 */
export function periodStartMs(period, atMs) {
  const { year, month, day } = utcParts(atMs);
  if (period === 'daily') return Date.UTC(year, month, day);
  if (period === 'monthly') return Date.UTC(year, month, 1);
  if (period === 'weekly') {
    const isoDay = new Date(Date.UTC(year, month, day)).getUTCDay() || 7; // Mon=1 .. Sun=7
    return Date.UTC(year, month, day - (isoDay - 1));
  }
  fail('CONFIG_INVALID', `unknown rankings period "${period}"`, { period });
  return atMs;
}

/**
 * Exclusive end (the next period's start) of a period key, or null when the key is
 * malformed. Used by rewards to rank a *completed* period after its boundary passed.
 * @param {'daily'|'weekly'|'monthly'} period
 * @param {string} key
 * @returns {number|null}
 */
export function periodKeyEndMs(period, key) {
  const text = String(key ?? '');
  if (period === 'daily') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!match) return null;
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1);
  }
  if (period === 'monthly') {
    const match = /^(\d{4})-(\d{2})$/.exec(text);
    if (!match) return null;
    const monthIndex = Number(match[2]) - 1;
    if (monthIndex < 0 || monthIndex > 11) return null;
    return Date.UTC(Number(match[1]), monthIndex + 1, 1);
  }
  if (period === 'weekly') {
    const match = /^(\d{4})-W(\d{2})$/.exec(text);
    if (!match) return null;
    const year = Number(match[1]);
    const week = Number(match[2]);
    if (week < 1 || week > 53) return null;
    const jan4 = Date.UTC(year, 0, 4);
    const jan4IsoDay = new Date(jan4).getUTCDay() || 7;
    const week1Monday = jan4 - (jan4IsoDay - 1) * 86_400_000;
    return week1Monday + week * 7 * 86_400_000;
  }
  return null;
}

// ---------------------------------------------------------------------------
// persisted-point normalization (v3.3 fields + v3.2 back-compat)
// ---------------------------------------------------------------------------

/**
 * A `last` observation: key + equity required (v3.2 always stored it), trading/capital
 * marks are null until they were measured.
 * @returns {{key:string, equityUsd:number, trades:number, tradingPlUsd:number|null,
 *            capitalUsd:number|null, atMs:number|null}|null}
 */
function normalizeLastPoint(raw) {
  if (!isPlainObject(raw) || typeof raw.key !== 'string') return null;
  const equityUsd = finiteNumber(raw.equityUsd);
  if (equityUsd === null) return null;
  const trades = finiteNumber(raw.trades);
  const atMs = finiteNumber(raw.atMs);
  return {
    key: raw.key,
    equityUsd: round2(equityUsd),
    trades: trades === null ? 0 : Math.max(0, Math.trunc(trades)),
    tradingPlUsd: normalizeTradingPl(raw.tradingPlUsd),
    capitalUsd: normalizeCapital(raw.capitalUsd),
    atMs: atMs === null ? null : Math.round(atMs),
  };
}

/**
 * A period baseline: key + equity required; v3.2 baselines had no trades/trading
 * fields, so they normalize to null (an unmeasured baseline is never fabricated).
 * @returns {{key:string, equityUsd:number, trades:number|null, tradingPlUsd:number|null,
 *            capitalUsd:number|null}|null}
 */
function normalizeBaselinePoint(raw) {
  if (!isPlainObject(raw) || typeof raw.key !== 'string') return null;
  const equityUsd = finiteNumber(raw.equityUsd);
  if (equityUsd === null) return null;
  const trades = finiteNumber(raw.trades);
  return {
    key: raw.key,
    equityUsd: round2(equityUsd),
    trades: trades === null ? null : Math.max(0, Math.trunc(trades)),
    tradingPlUsd: normalizeTradingPl(raw.tradingPlUsd),
    capitalUsd: normalizeCapital(raw.capitalUsd),
  };
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

/** @returns {{version:number, updatedAt:string|null, agents:Record<string, object>}} */
function emptyState() {
  return { version: RANKINGS_VERSION, updatedAt: null, agents: {} };
}

/** Tolerantly rebuild persisted state; a corrupt file simply means "no history yet". */
function normalizeState(raw) {
  const state = emptyState();
  if (!isPlainObject(raw)) return state;
  state.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;
  const agents = isPlainObject(raw.agents) ? raw.agents : {};
  for (const [rawId, rawAgent] of Object.entries(agents)) {
    const agentId = String(rawId ?? '').trim();
    if (!agentId || !isPlainObject(rawAgent)) continue;
    /**
     * baseline/last describe the CURRENT period; previousBaseline/previousLast archive
     * the last completed period so a payout can rank it after the boundary rolled over.
     * @type {{name:string, baseline:Record<string, object>, last:Record<string, object>,
     *         previousBaseline:Record<string, object>, previousLast:Record<string, object>}}
     */
    const agent = {
      name: typeof rawAgent.name === 'string' ? rawAgent.name : agentId,
      baseline: {},
      last: {},
      previousBaseline: {},
      previousLast: {},
    };
    for (const period of PERIODS) {
      const baseline = normalizeBaselinePoint(rawAgent.baseline?.[period]);
      if (baseline) agent.baseline[period] = baseline;
      const last = normalizeLastPoint(rawAgent.last?.[period]);
      if (last) agent.last[period] = last;
      const previousBaseline = normalizeBaselinePoint(rawAgent.previousBaseline?.[period]);
      if (previousBaseline) agent.previousBaseline[period] = previousBaseline;
      const previousLast = normalizeLastPoint(rawAgent.previousLast?.[period]);
      if (previousLast) agent.previousLast[period] = previousLast;
    }
    state.agents[agentId] = agent;
  }
  return state;
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

/**
 * Leaderboard ordering: measured entries first by equity pnlPct desc, then pnlUsd desc,
 * then name asc. Entries without a baseline (pnlPct null) always sort last (name asc).
 *
 * The displayed leaderboard keeps the legacy equity-delta ordering for compatibility;
 * the fair REWARD ordering lives in rewards.js (period trading return).
 */
export function compareRankedEntries(a, b) {
  const aMissing = a.pnlPct === null || a.pnlPct === undefined;
  const bMissing = b.pnlPct === null || b.pnlPct === undefined;
  if (aMissing !== bMissing) return aMissing ? 1 : -1;
  if (!aMissing && b.pnlPct !== a.pnlPct) return b.pnlPct - a.pnlPct;
  const aPnl = Number.isFinite(a.pnlUsd) ? a.pnlUsd : -Infinity;
  const bPnl = Number.isFinite(b.pnlUsd) ? b.pnlUsd : -Infinity;
  if (aPnl !== bPnl) return bPnl - aPnl;
  return compareText(a.name, b.name) || compareText(a.agentId, b.agentId);
}

/**
 * Normalize one observation `{name, equityUsd, trades, tradingPlUsd, capitalUsd}`.
 * `tradingPlUsd`/`capitalUsd` are optional (legacy observations still work).
 * @returns {{name:string|null, equityUsd:number, trades:number,
 *            tradingPlUsd:number|null, capitalUsd:number|null}|null}
 */
function normalizeObservation(raw) {
  if (!isPlainObject(raw)) return null;
  const equityUsd = finiteNumber(raw.equityUsd);
  if (equityUsd === null) return null;
  const trades = finiteNumber(raw.trades);
  return {
    name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : null,
    equityUsd: round2(equityUsd),
    trades: trades === null ? 0 : Math.max(0, Math.trunc(trades)),
    tradingPlUsd: normalizeTradingPl(raw.tradingPlUsd),
    capitalUsd: normalizeCapital(raw.capitalUsd),
  };
}

/**
 * Baseline for a new period: carried forward from the completed period's last
 * observation when one exists, else this first observation. Carried legacy points keep
 * their null trading marks — a period is then "unmeasured" instead of being rewarded on
 * a fabricated start value.
 * @param {{equityUsd:number, trades:number, tradingPlUsd:number|null, capitalUsd:number|null}} observation
 * @param {string} key
 * @param {{equityUsd:number, trades:number, tradingPlUsd:number|null, capitalUsd:number|null}|undefined} carried
 * @returns {{key:string, equityUsd:number, trades:number|null, tradingPlUsd:number|null,
 *            capitalUsd:number|null}}
 */
function baselineFor(observation, key, carried) {
  const trades = finiteNumber(carried?.trades);
  const carriedTradingPl = normalizeTradingPl(carried?.tradingPlUsd);
  const carriedCapital = normalizeCapital(carried?.capitalUsd);
  return {
    key,
    equityUsd: round2(carried && Number.isFinite(Number(carried.equityUsd))
      ? Number(carried.equityUsd)
      : observation.equityUsd),
    trades: carried ? (trades === null ? null : Math.max(0, Math.trunc(trades))) : observation.trades,
    tradingPlUsd: carried ? carriedTradingPl : observation.tradingPlUsd,
    capitalUsd: carried ? carriedCapital : observation.capitalUsd,
  };
}

/** The computed period performance of one point against one baseline. */
function measurePeriod({ lastTrades, lastTradingPl, lastCapital, baseline }) {
  const baselineTrades = baseline ? finiteNumber(baseline.trades) : null;
  const baselineTradingPl = baseline ? normalizeTradingPl(baseline.tradingPlUsd) : null;
  const baselineCapital = baseline ? normalizeCapital(baseline.capitalUsd) : null;
  const tradingPl = normalizeTradingPl(lastTradingPl);
  const tradingPnlUsd = tradingPl !== null && baselineTradingPl !== null
    ? round2(tradingPl - baselineTradingPl)
    : null;
  const tradingPnlPct = tradingPnlUsd !== null && baselineCapital !== null && baselineCapital > 0
    ? round(tradingPnlUsd / baselineCapital, PCT_DECIMALS)
    : null;
  const periodTrades = baselineTrades !== null && Number.isFinite(Number(lastTrades))
    ? Math.max(0, Math.trunc(Number(lastTrades)) - baselineTrades)
    : null;
  return {
    tradingPlUsd: tradingPl,
    capitalUsd: normalizeCapital(lastCapital),
    baselineTradingPlUsd: baselineTradingPl,
    baselineCapitalUsd: baselineCapital,
    tradingPnlUsd,
    tradingPnlPct,
    periodTrades,
  };
}

/**
 * Create the persisted rankings book.
 *
 * @param {{
 *   paths?: { rankings?: string },
 *   config?: object,
 *   clock?: { now: () => number, iso: () => string },
 * }} deps `paths` is the object from `statePaths(config)`; `config` is only a fallback.
 * @returns {{
 *   load: () => Promise<object>,
 *   save: () => Promise<string>,
 *   record: (input: {atMs?: number|string|Date, equityByAgent?: Record<string, object>}) => Promise<object>,
 *   compute: (input: {atMs?: number|string|Date, equityByAgent?: Record<string, object>,
 *             stored?: boolean}) => object,
 *   getState: () => object,
 *   describe: () => object,
 *   path: string,
 * }}
 */
export function createRankings({ paths, config, clock } = {}) {
  const currentClock = clock ?? SYSTEM_CLOCK;
  const resolvedPaths = paths ?? (config ? statePaths(config) : null);
  const file = resolvedPaths?.rankings
    ?? (config?.paths?.stateDir ? path.join(String(config.paths.stateDir), 'rankings.json') : null);
  if (!file) {
    fail('CONFIG_INVALID', 'createRankings requires paths.rankings (from statePaths(config))');
  }
  const rankingsPath = String(file);

  /** @type {ReturnType<typeof emptyState>} */
  let state = emptyState();

  async function load() {
    const raw = await readJson(rankingsPath, null);
    state = normalizeState(raw);
    return cloneState(state);
  }

  async function save() {
    await writeJsonAtomic(rankingsPath, state);
    return rankingsPath;
  }

  function getState() {
    return cloneState(state);
  }

  /**
   * Store this tick's observations: set the period baseline on the first observation of
   * a period (carrying the previous period's last observation forward) and refresh the
   * last observed values for the current period. Persists immediately.
   *
   * Synchronous mutation + async persist: the in-memory state is ready for an immediate
   * `compute()` even if the caller does not await the returned promise.
   *
   * @param {{atMs?: number|string|Date, equityByAgent?: Record<string, object>}} [input]
   * @returns {Promise<object>} the updated persisted state
   */
  async function record({ atMs, equityByAgent } = {}) {
    const nowMs = normalizeAt(atMs, currentClock);
    const at = new Date(nowMs).toISOString();
    const keys = periodKeys(nowMs);
    const observations = isPlainObject(equityByAgent) ? equityByAgent : {};
    let changed = false;
    for (const [rawId, rawObs] of Object.entries(observations)) {
      const agentId = String(rawId ?? '').trim();
      if (!agentId) continue;
      const observation = normalizeObservation(rawObs);
      if (!observation) continue;
      const existing = state.agents[agentId];
      /**
       * @type {{name:string, baseline:Record<string, object>, last:Record<string, object>,
       *         previousBaseline:Record<string, object>, previousLast:Record<string, object>}}
       */
      const agent = existing ?? {
        name: agentId,
        baseline: {},
        last: {},
        previousBaseline: {},
        previousLast: {},
      };
      agent.baseline = agent.baseline ?? {};
      agent.last = agent.last ?? {};
      agent.previousBaseline = agent.previousBaseline ?? {};
      agent.previousLast = agent.previousLast ?? {};
      if (observation.name) agent.name = observation.name;
      for (const period of PERIODS) {
        const key = keys[period];
        const baseline = agent.baseline[period];
        if (!baseline || baseline.key !== key) {
          // A new period (or the first ever observation): archive the completed period
          // for late ranking, then carry the previous period's last observation forward
          // so this period is measured from its start.
          const priorLast = agent.last[period];
          if (baseline) {
            agent.previousBaseline[period] = {
              key: baseline.key,
              equityUsd: round2(baseline.equityUsd),
              trades: finiteNumber(baseline.trades),
              tradingPlUsd: normalizeTradingPl(baseline.tradingPlUsd),
              capitalUsd: normalizeCapital(baseline.capitalUsd),
            };
          }
          if (priorLast) {
            agent.previousLast[period] = {
              key: priorLast.key,
              equityUsd: round2(priorLast.equityUsd),
              trades: Number.isFinite(Number(priorLast.trades)) ? Math.max(0, Math.trunc(Number(priorLast.trades))) : 0,
              tradingPlUsd: normalizeTradingPl(priorLast.tradingPlUsd),
              capitalUsd: normalizeCapital(priorLast.capitalUsd),
              atMs: Number.isFinite(Number(priorLast.atMs)) ? Math.round(Number(priorLast.atMs)) : null,
            };
          }
          agent.baseline[period] = baselineFor(observation, key, priorLast);
        }
        agent.last[period] = {
          key,
          equityUsd: observation.equityUsd,
          trades: observation.trades,
          tradingPlUsd: observation.tradingPlUsd,
          capitalUsd: observation.capitalUsd,
          atMs: nowMs,
        };
      }
      state.agents[agentId] = agent;
      changed = true;
    }
    if (changed) state.updatedAt = at;
    await save();
    return getState();
  }

  /**
   * Rank agents in every period.
   *
   * - With `equityByAgent` (normal use: the orchestrator passes the living population),
   *   only those agents are listed; a missing current-period baseline means null P&L
   *   and last place.
   * - `stored: true` (used by the rewards scheduler) ranks from the stored observations
   *   instead, including the archived close of the just-completed period, so a payout
   *   can rank the period that just ended even after the boundary rolled a baseline over.
   *
   * Rows carry BOTH the legacy equity delta (`pnlUsd`/`pnlPct`) and the v3.3 fair
   * trading fields (`tradingPnlUsd`/`tradingPnlPct`, baselines, `periodTrades`). Rewards
   * rank exclusively on the trading fields.
   *
   * @param {{atMs?: number|string|Date, equityByAgent?: Record<string, object>,
   *          stored?: boolean}} [input]
   * @returns {{asOf:string, periodKeys:{daily:string,weekly:string,monthly:string},
   *            periods:{daily:Array<object>, weekly:Array<object>, monthly:Array<object>}}}
   */
  function compute({ atMs, equityByAgent, stored = false } = {}) {
    const nowMs = normalizeAt(atMs, currentClock);
    const keys = periodKeys(nowMs);
    const hasObservations = isPlainObject(equityByAgent);
    const observations = hasObservations ? equityByAgent : {};
    const agentIds = hasObservations ? Object.keys(observations) : stored ? Object.keys(state.agents) : [];
    /** @type {Record<string, Array<object>>} */
    const periods = { daily: [], weekly: [], monthly: [] };
    for (const period of PERIODS) {
      const currentKey = keys[period];
      const rows = [];
      for (const rawId of agentIds) {
        const agentId = String(rawId ?? '').trim();
        if (!agentId) continue;
        const observation = hasObservations ? normalizeObservation(observations[rawId]) : null;
        if (hasObservations && !observation) continue;
        const agentState = state.agents[agentId];
        const baseline = agentState?.baseline?.[period];
        const last = agentState?.last?.[period];
        const archivedBaseline = agentState?.previousBaseline?.[period];
        const archivedLast = agentState?.previousLast?.[period];
        const archivedView = Boolean(
          archivedBaseline
          && archivedLast
          && archivedBaseline.key === currentKey
          && archivedLast.key === currentKey,
        );
        const currentView = Boolean(
          baseline
          && baseline.key === currentKey
          && Number.isFinite(Number(baseline.equityUsd)),
        );
        if (!hasObservations && !archivedView && !currentView) continue; // never observed in this period
        let equityUsd;
        let trades;
        let baselinePoint = null;
        let lastPoint = null;
        let baselineEquityUsd = null;
        if (archivedView) {
          // The period just completed: its archived close is authoritative, so the
          // ranking cannot drift with observations made after the boundary.
          lastPoint = archivedLast;
          baselinePoint = archivedBaseline;
          equityUsd = archivedLast.equityUsd;
          trades = archivedLast.trades;
          baselineEquityUsd = round2(archivedBaseline.equityUsd);
        } else if (currentView) {
          equityUsd = observation?.equityUsd ?? last?.equityUsd;
          trades = observation?.trades ?? last?.trades ?? 0;
          baselinePoint = baseline;
          baselineEquityUsd = round2(baseline.equityUsd);
          lastPoint = {
            trades,
            tradingPlUsd: observation?.tradingPlUsd ?? last?.tradingPlUsd ?? null,
            capitalUsd: observation?.capitalUsd ?? last?.capitalUsd ?? null,
          };
        } else {
          equityUsd = observation?.equityUsd ?? last?.equityUsd;
          trades = observation?.trades ?? last?.trades ?? 0;
          lastPoint = {
            trades,
            tradingPlUsd: observation?.tradingPlUsd ?? last?.tradingPlUsd ?? null,
            capitalUsd: observation?.capitalUsd ?? last?.capitalUsd ?? null,
          };
        }
        if (!Number.isFinite(Number(equityUsd))) continue;
        const measured = measurePeriod({
          lastTrades: trades,
          lastTradingPl: lastPoint?.tradingPlUsd ?? null,
          lastCapital: lastPoint?.capitalUsd ?? null,
          baseline: baselinePoint,
        });
        const pnlUsd = baselineEquityUsd === null ? null : round2(Number(equityUsd) - baselineEquityUsd);
        const pnlPct = baselineEquityUsd !== null && baselineEquityUsd > 0
          ? round((Number(equityUsd) - baselineEquityUsd) / baselineEquityUsd, PCT_DECIMALS)
          : null;
        rows.push({
          agentId,
          name: observation?.name ?? agentState?.name ?? agentId,
          equityUsd: round2(Number(equityUsd)),
          baselineEquityUsd,
          pnlUsd,
          pnlPct,
          trades,
          tradingPlUsd: measured.tradingPlUsd,
          capitalUsd: measured.capitalUsd,
          baselineTradingPlUsd: measured.baselineTradingPlUsd,
          baselineCapitalUsd: measured.baselineCapitalUsd,
          tradingPnlUsd: measured.tradingPnlUsd,
          tradingPnlPct: measured.tradingPnlPct,
          periodTrades: measured.periodTrades,
        });
      }
      rows.sort(compareRankedEntries);
      periods[period] = rows.map((row, index) => ({ rank: index + 1, ...row }));
    }
    return { asOf: new Date(nowMs).toISOString(), periodKeys: keys, periods };
  }

  return {
    load,
    save,
    record,
    compute,
    getState,
    describe() {
      return {
        role: 'rankings',
        version: RANKINGS_VERSION,
        periods: [...PERIODS],
        asOf: state.updatedAt,
        agents: Object.keys(state.agents).length,
        fields: [
          'pnlUsd/pnlPct (legacy equity delta)',
          'tradingPnlUsd/tradingPnlPct (v3.3 fair period performance)',
          'baselineTradingPlUsd/baselineCapitalUsd/periodTrades',
        ],
        path: rankingsPath,
      };
    },
    get path() {
      return rankingsPath;
    },
  };
}

export default createRankings;
