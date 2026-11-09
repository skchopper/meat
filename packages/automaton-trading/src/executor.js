/**
 * EXECUTOR — the only role that presses the button.
 *
 * Stopline (architecture §2): the Executor never reads account equity or cash (that is
 * the Treasurer's alone) and never decides its own budget: it receives a mandate from
 * the Treasurer, a StrategySpec from the Builder, and quotes. Every order it intends to
 * place passes `brakes.checkOrder()` FIRST; a denial is recorded, never retried blind.
 *
 * It reads only: its own ledger position book (`ledger.book(agentId)`), the broker's
 * public market data, `submitOrder`/`cancelOrder`/`getOrders`. It never calls
 * `broker.getAccount()`.
 *
 * Exits are risk-reducing and run before entries: stop-loss, take-profit, max-hold
 * bars, family exit signal. Entries are long-only, sized from
 * `sizePct * mandate.sizeBudgetUsd` and capped by absolute notional caps, rounded to
 * 4 decimal fractional shares, stamped `atm:<agentId>:<specId>:<seq>`.
 *
 * Optional advisory inputs: `research` (an isolated per-agent briefing) and `policy` (the
 * bot's own agent-brain policy from docs/BOT-AGENTS.md). When enabled and fresh, each can
 * only veto/skip an entry, shrink an entry, or force an exit. Neither ever creates an
 * order, widens a size, or bypasses the brake wall.
 *
 * Contract: docs/CONTRACTS.md § "Data feeder / market helpers" (executor.js).
 * Owner: market teammate.
 *
 * @module executor
 */

import { fail } from './contracts.js';
import { clamp, mean, round2, round4, SYSTEM_CLOCK, timeframeToMs } from './util.js';
import { parseOccSymbol, formatOccSymbol, daysToExpiration } from './broker-alpaca.js';
import {
  normalizeInstrumentPolicy,
  optionRightForStructure,
  playbookForFamily,
  resolveInstrumentPermissions,
  spreadWidthPct,
  strikeOffsetPct,
  structuresForDirection,
  targetDTE,
} from './instruments.js';

const MAX_BARS_FETCH = 240;
const OPTION_MULTIPLIER = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const OPTION_DATA_FEED = 'indicative';

/** Instrument structure catalog (falls back to local names if instruments.js changes). */
const STRUCTURE_KEYS = Object.freeze([
  'long_call', 'long_put', 'covered_call', 'bull_call_spread', 'bear_put_spread',
  'call_credit_spread', 'put_credit_spread',
]);
const SPREAD_KEYS = Object.freeze(['bull_call_spread', 'bear_put_spread', 'call_credit_spread', 'put_credit_spread']);

/** Local playbook fallback (docs/INSTRUMENTS.md table) — used if the helper returns nothing. */
const LOCAL_PLAYBOOKS = Object.freeze({
  momentum: { bullish: ['long_call', 'bull_call_spread', 'long_stock'], bearish: ['short_stock', 'long_put', 'call_credit_spread'], neutral: ['long_stock'] },
  meanrev: { bullish: ['long_stock', 'put_credit_spread', 'bull_call_spread'], bearish: ['short_stock', 'call_credit_spread', 'bear_put_spread'], neutral: [] },
  breakout: { bullish: ['long_call', 'bull_call_spread', 'long_stock'], bearish: ['long_put', 'short_stock', 'bear_put_spread'], neutral: [] },
  gapfade: { bullish: ['long_stock', 'put_credit_spread', 'long_call'], bearish: ['covered_call', 'short_stock', 'long_put', 'call_credit_spread'], neutral: ['covered_call'] },
});

function isSpread(structure) {
  return SPREAD_KEYS.includes(String(structure ?? ''));
}

function isOptionStructure(structure) {
  return STRUCTURE_KEYS.includes(String(structure ?? ''));
}

function isDayFamily(family) {
  return family === 'breakout' || family === 'gapfade';
}

/** Playbook structures for one family/direction, with a local fallback. */
function playbookStructures(family, direction) {
  try {
    const listed = structuresForDirection(family, direction);
    if (Array.isArray(listed) && listed.length > 0) {
      return listed.filter((entry) => entry === 'long_stock' || entry === 'short_stock' || isOptionStructure(entry));
    }
  } catch {
    /* fall through to the local table */
  }
  const book = LOCAL_PLAYBOOKS[String(family ?? '').toLowerCase()] ?? LOCAL_PLAYBOOKS.momentum;
  return [...(book[direction] ?? book.neutral ?? [])];
}

/** Vertical width as a fraction of spot (day families use tighter spreads). */
function spreadWidthFraction(family) {
  let width = 0.05;
  try {
    const raw = Number(spreadWidthPct(family));
    if (Number.isFinite(raw) && raw > 0) width = raw;
  } catch {
    /* keep the default */
  }
  if (isDayFamily(family)) width = Math.min(width, 0.03);
  return width;
}

/** Target DTE for a structure. */
function structureTargetDTE(family, structure, minDTE, maxDTE) {
  try {
    const target = targetDTE({ family: isDayFamily(family) ? 'day' : family, structure, minDTE, maxDTE });
    if (Number.isFinite(Number(target))) return clamp(Number(target), minDTE, maxDTE);
  } catch {
    /* fall through */
  }
  return Math.min(maxDTE, Math.max(minDTE, minDTE + 3));
}

/** Strike offset fraction for one structure (docs/INSTRUMENTS.md strike rules). */
function structureStrikeOffset(family, structure) {
  try {
    const raw = Number(strikeOffsetPct(family, structure));
    if (Number.isFinite(raw) && raw >= 0) return raw;
  } catch {
    /* fall through */
  }
  if (structure === 'covered_call') return 0.04;
  if (structure === 'call_credit_spread' || structure === 'put_credit_spread') return 0.03;
  return 0.035;
}

/** Which direction a structure expresses. */
function structureDirection(structure) {
  switch (structure) {
    case 'long_call':
    case 'bull_call_spread':
    case 'put_credit_spread':
    case 'long_stock':
      return 'bullish';
    case 'long_put':
    case 'bear_put_spread':
    case 'call_credit_spread':
    case 'short_stock':
      return 'bearish';
    case 'covered_call':
      return 'neutral';
    default:
      return null;
  }
}

/** Resolve per-agent instrument permissions (defensive: falls back to local rules). */
export function resolveExecutorPermissions(config, agent) {
  let base = null;
  try {
    base = resolveInstrumentPermissions(config);
  } catch {
    base = null;
  }
  if (!base) {
    const cfg = config?.instruments ?? {};
    const enabled = cfg.enabled !== false;
    const allowOptions = enabled && cfg.allowOptions !== false;
    const allowSpreads = allowOptions && cfg.allowSpreads !== false;
    const allowCoveredCalls = allowOptions && cfg.allowCoveredCalls !== false;
    const allowShort = enabled && cfg.allowShort !== false;
    base = {
      enabled,
      longStock: enabled,
      shortStock: allowShort,
      longOptions: allowOptions,
      shortOptions: allowOptions && (allowCoveredCalls || allowSpreads),
      coveredCalls: allowCoveredCalls,
      spreads: allowSpreads,
      margin: enabled && cfg.allowMargin !== false,
      allowedStructures: allowOptions
        ? ['long_call', 'long_put', ...(allowCoveredCalls ? ['covered_call'] : []), ...(allowSpreads ? SPREAD_KEYS : [])]
        : [],
    };
  }
  void agent;
  return { ...base, allowedStructures: [...(base.allowedStructures ?? [])] };
}

/** True when a structure is permitted by a permission view. */
export function structureAllowed(structure, permissions) {
  if (!permissions || permissions.enabled === false) return false;
  if (structure === 'long_stock') return permissions.longStock !== false;
  if (structure === 'short_stock') return permissions.shortStock === true;
  if (!isOptionStructure(structure)) return false;
  if (permissions.longOptions !== true && structure.startsWith('long_')) return false;
  if (structure === 'covered_call') return permissions.coveredCalls === true;
  if (isSpread(structure)) return permissions.spreads === true;
  return (permissions.allowedStructures ?? []).includes(structure);
}

// ---------------------------------------------------------------------------
// small normalization helpers
// ---------------------------------------------------------------------------

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Accept epoch ms, Date, or ISO string; fall back to the injected clock. */
export function normalizeNow(value, clock = SYSTEM_CLOCK) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return clock.now();
}

/** Parse a ledger timestamp (epoch ms or ISO) to epoch ms. */
function timestampOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** Research verdicts the executor understands; anything else behaves as HOLD. */
export const RESEARCH_VERDICTS = Object.freeze(['HOLD', 'AVOID', 'ALERT']);

/** Stances a bot agent's own policy may declare (docs/BOT-AGENTS.md). */
export const AGENT_STANCES = Object.freeze(['trade', 'cautious', 'stand_down']);

/**
 * Resolve whether a per-bot agent policy may influence this execution cycle.
 *
 * Policy is advisory *for execution* but authoritative for that bot's own stance: it is
 * gated on `config.agents.enabled === true`, must be fresh within `config.agents.maxAgeSec`
 * (default 2 h), and malformed/deprecated/missing policies resolve to null — which means
 * "exactly the behaviour before bot agents existed". It can only reduce exposure
 * (stand down, shrink size, exit); it can never create an order, increase a size, or
 * bypass a brake.
 *
 * @param {{
 *   policy?: object|null,
 *   config?: object,
 *   atMs: number,
 * }} input
 * @returns {{stance:'trade'|'cautious'|'stand_down', sizeMultiplier:number,
 *            exitPressure:'none'|'exit', confidence:number, at:number}|null}
 */
export function resolveAgentPolicy({ policy, config, atMs }) {
  const cfg = config && typeof config === 'object' && config.agents && typeof config.agents === 'object'
    ? config.agents
    : null;
  if (!cfg || cfg.enabled !== true) return null;
  if (!policy || typeof policy !== 'object') return null;
  // bot-agent.policy() already marks stale against the bot's own cadence; trust it.
  if (policy.stale === true) return null;
  const observedAtMs = timestampOf(policy.atMs ?? policy.at ?? policy.observedAt);
  if (observedAtMs === null) return null; // malformed: no decision date, no influence
  const maxAgeSec = numberOrNull(cfg.maxAgeSec);
  const maxAgeMs = (maxAgeSec !== null && maxAgeSec > 0 ? maxAgeSec : 7200) * 1000;
  const ageMs = atMs - observedAtMs;
  if (ageMs > maxAgeMs) return null; // stale: ignored by the executor, still shown in the UI
  const rawStance = typeof policy.stance === 'string' ? policy.stance.trim().toLowerCase() : '';
  if (!AGENT_STANCES.includes(rawStance)) return null; // malformed stance: ignore entirely
  const rawSize = numberOrNull(policy.sizeMultiplier);
  // v1: sizing can only shrink; out-of-range values are clamped into [0.2, 1].
  const sizeMultiplier = rawSize === null ? 1 : clamp(rawSize, 0.2, 1);
  const exitPressure = policy.exitPressure === 'exit' ? 'exit' : 'none';
  // Optional bot-chosen instrument plan (docs/INSTRUMENTS.md § Bot agent); validated and
  // clamped by the Lead-owned instruments helper, with a safe local fallback.
  let instrument = null;
  if (policy.instrument && typeof policy.instrument === 'object') {
    try {
      instrument = normalizeInstrumentPolicy(policy.instrument, { config });
    } catch {
      instrument = null;
    }
  }
  return {
    stance: rawStance,
    sizeMultiplier,
    exitPressure,
    confidence: clamp(numberOrNull(policy.confidence) ?? 0, 0, 1),
    at: observedAtMs,
    instrument,
  };
}

/**
 * Resolve whether a research briefing may influence this execution cycle.
 *
 * Research is advisory and double-gated: `config.research.enabled` (sidecar on) and
 * `config.research.influence` (not shadow mode), plus freshness within `maxAgeSec`.
 * Malformed/missing/stale briefings resolve to null, which means "exactly today's
 * behaviour" — research can never widen a size, bypass a brake, or create an order.
 *
 * @param {{
 *   research?: object|null,
 *   config?: object,
 *   atMs: number,
 * }} input
 * @returns {{verdict:string, sentiment:number, confidence:number, risks:string[], at:number}|null}
 */
export function resolveResearchBriefing({ research, config, atMs }) {
  const cfg = config && typeof config === 'object' && config.research && typeof config.research === 'object'
    ? config.research
    : null;
  if (!cfg || cfg.enabled !== true || cfg.influence !== true) return null;
  if (!research || typeof research !== 'object') return null;
  const maxAgeSec = numberOrNull(cfg.maxAgeSec);
  if (maxAgeSec === null || maxAgeSec <= 0) return null;
  const observedAtMs = timestampOf(research.atMs ?? research.at ?? research.observedAt ?? research.createdAt);
  if (observedAtMs === null) return null;
  const ageMs = atMs - observedAtMs;
  if (ageMs > maxAgeSec * 1000) return null; // stale: ignored entirely
  const rawSentiment = numberOrNull(research.sentiment);
  if (rawSentiment === null) return null; // malformed briefing: ignored
  const rawVerdict = typeof research.verdict === 'string' ? research.verdict.trim().toUpperCase() : 'HOLD';
  const verdict = RESEARCH_VERDICTS.includes(rawVerdict) ? rawVerdict : 'HOLD';
  const confidence = clamp(numberOrNull(research.confidence) ?? 0, 0, 1);
  const risks = Array.isArray(research.risks)
    ? research.risks.filter((risk) => typeof risk === 'string' && risk.trim() !== '')
    : [];
  return {
    verdict,
    sentiment: clamp(rawSentiment, -1, 1),
    confidence,
    risks,
    at: observedAtMs,
  };
}

/** Normalize one quote to { symbol, bid, ask, last, ts }. */
export function normalizeQuote(raw, symbol) {
  if (!raw || typeof raw !== 'object') return null;
  const bid = numberOrNull(raw.bid ?? raw.bidPriceUsd);
  const ask = numberOrNull(raw.ask ?? raw.askPriceUsd);
  const last = numberOrNull(raw.last ?? raw.lastPriceUsd ?? raw.priceUsd);
  const mid = bid !== null && ask !== null ? (bid + ask) / 2 : last ?? bid ?? ask;
  if (!(mid > 0)) return null;
  return {
    symbol: String(raw.symbol ?? symbol ?? '').toUpperCase(),
    bid: bid ?? mid,
    ask: ask ?? mid,
    last: last ?? mid,
    ts: raw.ts ?? null,
  };
}

/** Normalize a bars array (ascending) dropping invalid rows. */
export function normalizeBars(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const c = numberOrNull(raw.c);
    const o = numberOrNull(raw.o);
    if (!(c > 0) || !(o > 0)) continue;
    const t = timestampOf(raw.t);
    out.push({
      t,
      o,
      h: numberOrNull(raw.h) ?? Math.max(o, c),
      l: numberOrNull(raw.l) ?? Math.min(o, c),
      c,
      v: numberOrNull(raw.v) ?? 0,
    });
  }
  out.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  return out;
}

function meanStd(values) {
  if (!Array.isArray(values) || values.length === 0) return { mean: 0, std: 0 };
  const avg = mean(values);
  let variance = 0;
  for (const value of values) variance += (value - avg) ** 2;
  return { mean: avg, std: Math.sqrt(variance / values.length) };
}

/** Spread in bps from a normalized quote (0 when bid/ask are not both present). */
export function spreadBpsOf(quote) {
  if (!quote || !(quote.bid > 0) || !(quote.ask > 0)) return 0;
  const mid = (quote.bid + quote.ask) / 2;
  if (!(mid > 0)) return 0;
  return round2(((quote.ask - quote.bid) / mid) * 10_000);
}

/**
 * Evaluate a spec's family signal on the bar history.
 *
 * Multi-instrument: exposes both directions. `longEntry`/`shortEntry` are the entry
 * triggers and `longExit`/`shortExit` the signal-based closes. `enter`/`exit` are kept
 * as aliases of the long side for backward compatibility with older callers/tests.
 *
 * @param {string} family
 * @param {Array<{t:number|null,o:number,h:number,l:number,c:number,v:number}>} bars ascending
 * @param {object} params spec params
 * @returns {{enter:boolean, exit:boolean, longEntry:boolean, shortEntry:boolean,
 *            longExit:boolean, shortExit:boolean, z:number|null, lastClose:number|null,
 *            reason:string}}
 */
export function computeSignal(family, bars, params = {}) {
  const n = bars.length;
  const empty = {
    enter: false,
    exit: false,
    longEntry: false,
    shortEntry: false,
    longExit: false,
    shortExit: false,
    z: null,
    lastClose: n > 0 ? bars[n - 1].c : null,
    reason: 'insufficient_bars',
  };
  if (n < 30) return empty;
  const last = bars[n - 1];
  const entryZ = Number.isFinite(params.entryZ) ? params.entryZ : 1;
  const exitZ = Number.isFinite(params.exitZ) ? params.exitZ : 0.5;
  if (family === 'momentum') {
    const window = 5;
    const momentum = [];
    for (let i = window; i < n; i += 1) momentum.push(bars[i].c / bars[i - window].c - 1);
    const latest = momentum[momentum.length - 1];
    const history = momentum.slice(0, -1);
    const { mean: avg, std } = meanStd(history);
    const z = std > 0 ? (latest - avg) / std : 0;
    const longEntry = z >= entryZ;
    const shortEntry = z <= -entryZ;
    const longExit = z <= exitZ;
    const shortExit = z >= -exitZ;
    return {
      enter: longEntry,
      exit: longExit,
      longEntry,
      shortEntry,
      longExit,
      shortExit,
      z: round4(z),
      lastClose: last.c,
      reason: `momentum z=${round2(z)}`,
    };
  }
  if (family === 'meanrev') {
    const window = 10;
    const slice = bars.slice(-window).map((bar) => bar.c);
    const { mean: avg, std } = meanStd(slice);
    const z = std > 0 ? (last.c - avg) / std : 0;
    const longEntry = z <= -entryZ;
    const shortEntry = z >= entryZ;
    const longExit = z >= -exitZ;
    const shortExit = z <= exitZ;
    return {
      enter: longEntry,
      exit: longExit,
      longEntry,
      shortEntry,
      longExit,
      shortExit,
      z: round4(z),
      lastClose: last.c,
      reason: `meanrev z=${round2(z)}`,
    };
  }
  if (family === 'breakout') {
    const window = Math.min(20, n - 1);
    let priorHigh = -Infinity;
    let priorLow = Infinity;
    for (let i = n - 1 - window; i < n - 1; i += 1) {
      priorHigh = Math.max(priorHigh, bars[i].h);
      priorLow = Math.min(priorLow, bars[i].l);
    }
    const sma10 = mean(bars.slice(-10).map((bar) => bar.c));
    const longEntry = last.c > priorHigh;
    const shortEntry = last.c < priorLow;
    const longExit = last.c < sma10;
    const shortExit = last.c > sma10;
    return {
      enter: longEntry,
      exit: longExit,
      longEntry,
      shortEntry,
      longExit,
      shortExit,
      z: priorHigh > 0 ? round4(((last.c - priorHigh) / priorHigh) * 10_000) : null,
      lastClose: last.c,
      reason: longEntry ? 'breakout' : shortEntry ? 'breakdown' : 'inside_range',
    };
  }
  if (family === 'gapfade') {
    const prev = bars[n - 2];
    const gap = (last.o - prev.c) / prev.c;
    const longEntry = gap <= -0.002;
    const shortEntry = gap >= 0.002;
    const longExit = last.c >= prev.c;
    const shortExit = last.c <= prev.c;
    return {
      enter: longEntry,
      exit: longExit,
      longEntry,
      shortEntry,
      longExit,
      shortExit,
      z: round4(gap * 10_000),
      lastClose: last.c,
      reason: `gap ${round2(gap * 10_000)}bps`,
    };
  }
  return { ...empty, lastClose: last.c, reason: 'unknown_family' };
}

/**
 * Normalize one ledger position into the executor's multi-instrument position shape.
 * Legacy stock-only books (`{qty, avgPriceUsd, openedAt}`) keep working.
 * @param {string} rawSymbol
 * @param {object} raw
 */
export function normalizeLedgerPosition(rawSymbol, raw) {
  const symbol = String(rawSymbol ?? '').trim().toUpperCase();
  const option = raw && typeof raw.option === 'object' ? raw.option : parseOccSymbol(symbol);
  const assetClass = raw?.assetClass === 'us_option' || option ? 'us_option' : 'us_equity';
  const qtySigned = numberOrNull(raw?.qtySigned) ?? numberOrNull(raw?.qty) ?? 0;
  const multiplier = numberOrNull(raw?.multiplier) ?? (assetClass === 'us_option' ? OPTION_MULTIPLIER : 1);
  return {
    symbol,
    assetClass,
    option: option ?? null,
    qtySigned,
    qty: qtySigned,
    absQty: Math.abs(qtySigned),
    avgPriceUsd: numberOrNull(raw?.avgPriceUsd ?? raw?.avgEntryPriceUsd) ?? 0,
    multiplier,
    groupId: raw?.groupId ?? null,
    structure: raw?.structure ?? null,
    openedAt: raw?.openedAt ?? null,
  };
}

function positionsToMap(raw) {
  const map = new Map();
  if (!raw) return map;
  if (Array.isArray(raw)) {
    for (const position of raw) {
      if (!position || !position.symbol) continue;
      const normalized = normalizeLedgerPosition(position.symbol, position);
      if (Math.abs(normalized.qtySigned) > 1e-9) map.set(normalized.symbol, normalized);
    }
    return map;
  }
  if (typeof raw === 'object') {
    for (const [symbol, position] of Object.entries(raw)) {
      if (!position || typeof position !== 'object') continue;
      const normalized = normalizeLedgerPosition(symbol, position);
      if (Math.abs(normalized.qtySigned) > 1e-9) map.set(normalized.symbol, normalized);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   broker: object,
 *   brakes: { checkOrder: (input: object) => object },
 *   ledger: object,
 *   config: object,
 *   clock?: { now: () => number },
 * }} deps
 * @returns {{ run: (args: object) => Promise<object>, describe: () => object }}
 */
export function createExecutor({ broker, brakes, ledger, config, clock } = {}) {
  if (!broker || typeof broker.submitOrder !== 'function') {
    fail('CONFIG_INVALID', 'createExecutor requires a broker with submitOrder()');
  }
  if (!brakes || typeof brakes.checkOrder !== 'function') {
    fail('CONFIG_INVALID', 'createExecutor requires brakes.checkOrder()');
  }
  if (!ledger || typeof ledger.book !== 'function') {
    fail('CONFIG_INVALID', 'createExecutor requires ledger.book()');
  }
  if (!config || typeof config !== 'object') {
    fail('CONFIG_INVALID', 'createExecutor requires config');
  }
  const now = clock ?? SYSTEM_CLOCK;
  const risk = config.risk ?? {};
  const maxOrdersPerCycle = Math.max(1, risk.maxOrdersPerCycle ?? 1);
  const minOrderNotionalUsd = Number.isFinite(risk.minOrderNotionalUsd) ? risk.minOrderNotionalUsd : 1;
  const hardMaxNotionalUsd = Number.isFinite(risk.maxOrderNotionalUsd) ? risk.maxOrderNotionalUsd : Infinity;
  const maxOrderPctOfEquity = Number.isFinite(risk.maxOrderPctOfEquity) ? risk.maxOrderPctOfEquity : 0.25;
  const defaultTimeframe = config.data?.timeframe ?? '1Hour';
  // Research influence is opt-in and gated by config.research (shadow mode = influence:false).
  const researchConfig = config.research && typeof config.research === 'object' ? config.research : {};
  const researchInfluenceEnabled = researchConfig.enabled === true && researchConfig.influence === true;
  // Per-bot agent policy consumption is opt-in and gated by config.agents (docs/BOT-AGENTS.md).
  const agentsConfig = config.agents && typeof config.agents === 'object' ? config.agents : {};
  const agentsEnabled = agentsConfig.enabled === true;
  // Multi-instrument trading (docs/INSTRUMENTS.md): margin, short stock, long options,
  // defined-risk verticals and covered calls. Brakes remain the authoritative gate.
  const instrumentsConfig = config.instruments && typeof config.instruments === 'object' ? config.instruments : {};
  const instrumentsEnabled = instrumentsConfig.enabled !== false;
  const globalPermissions = resolveExecutorPermissions(config);
  const minDTE = Math.max(1, Math.trunc(Number(instrumentsConfig.minDTE) || 2));
  const maxDTE = Math.max(minDTE, Math.trunc(Number(instrumentsConfig.maxDTE) || 14));
  const autoCloseDTE = Math.max(0, Math.trunc(Number(instrumentsConfig.autoCloseDTE) || 1));
  const configMaxContracts = Math.max(1, Math.trunc(Number(instrumentsConfig.maxContracts) || 3));
  const configMaxOptionPremiumUsd = Number.isFinite(Number(instrumentsConfig.maxOptionPremiumUsd))
    ? Number(instrumentsConfig.maxOptionPremiumUsd)
    : 25;
  const maxOptionPremiumPctEquity = Number.isFinite(Number(instrumentsConfig.maxOptionPremiumPctEquity))
    ? Number(instrumentsConfig.maxOptionPremiumPctEquity)
    : 0.25;
  const optionDataFeed = instrumentsConfig.optionDataFeed ?? OPTION_DATA_FEED;
  const maxShortNotionalUsd = Number.isFinite(Number(instrumentsConfig.maxShortNotionalUsd))
    ? Number(instrumentsConfig.maxShortNotionalUsd)
    : 25;

  /** Monotonic per-agent order sequence, so client_order_id never repeats. */
  const orderSeq = new Map();

  function nextSeq(agentId) {
    const seq = (orderSeq.get(agentId) ?? 0) + 1;
    orderSeq.set(agentId, seq);
    return seq;
  }

  return {
    /**
     * Run one execution cycle for one agent.
     *
     * Accepts BOTH the legacy single `spec` and (v3.2 multi-symbol portfolio) a `specs`
     * basket array plus `portfolio` caps:
     *   - legacy `spec` only  -> byte-for-byte the old single-symbol behaviour;
     *   - `specs` array       -> exits manage ALL held positions using the spec whose
     *                            symbol matches the position's underlying (fallback
     *                            primary), entries iterate the basket with per-symbol
     *                            signals, one order per symbol per run, capped by
     *                            `portfolio.maxOpenPositions` / `maxOrdersPerCycle`.
     *
     * @param {{
     *   agent: object, spec?: object, specs?: Array<object>, mandate: object,
     *   portfolio?: {maxOpenPositions?: number, maxOrdersPerCycle?: number},
     *   quotes?: Record<string, {bid?:number, ask?:number, last?:number, ts?:number}>,
     *   bars?: Record<string, Array<object>>|Array<object>,
     *   dayStats?: object, now?: number|string|Date,
     *   research?: object|null,   // research.latest(agentId); advisory, fresh-only
     *   policy?: object|null,     // botAgents.policy(agentId); own-bot stance, fresh-only
     *   marketOpen?: boolean, marketClock?: object,
     * }} args
     * @returns {Promise<{agentId:string, actions:Array<object>, orders:Array<object>,
     *           denied:Array<{code:string, reason:string}>, spentUsd:number}>}
     */
    async run({ agent, spec: specInput, specs, portfolio, mandate, quotes, bars: providedBars, dayStats, now: nowInput, research, policy, marketOpen, marketClock, timeframe: runTimeframe, riskOnly = false } = {}) {
      const atMs = normalizeNow(nowInput, now);
      const at = new Date(atMs).toISOString();
      // --- spec normalization: legacy single spec OR multi-symbol basket ---------
      const basketSpecs = Array.isArray(specs)
        ? specs.filter((entry) => entry && typeof entry === 'object' && typeof entry.symbol === 'string' && entry.symbol.trim() !== '')
        : [];
      const primarySpec = specInput && typeof specInput === 'object'
        ? specInput
        : basketSpecs[0] ?? null;
      /** Primary/legacy spec; the rest of the function keeps using `spec` for it. */
      const spec = primarySpec;
      const specsBySymbol = new Map();
      for (const entrySpec of basketSpecs) {
        const key = String(entrySpec.symbol).toUpperCase();
        if (!specsBySymbol.has(key)) specsBySymbol.set(key, entrySpec);
      }
      const specForSymbol = (symbol) => {
        const key = String(symbol ?? '').toUpperCase();
        return specsBySymbol.get(key) ?? spec;
      };
      const agentId = String(agent?.id ?? agent?.agentId ?? spec?.agentId ?? '');
      // Per-tier cadence: a bot's tier timeframe overrides the global data timeframe so bar
      // windows and hold rules are evaluated on the cadence the operator assigned to it.
      const timeframe = runTimeframe ?? defaultTimeframe;
      // v3.2 portfolio caps (caller supplies them from config.portfolio; absent = legacy).
      const portfolioOrderCap = numberOrNull(portfolio?.maxOrdersPerCycle);
      const runMaxOrders = portfolioOrderCap !== null && portfolioOrderCap > 0
        ? Math.trunc(portfolioOrderCap)
        : maxOrdersPerCycle;
      const portfolioOpenCap = numberOrNull(portfolio?.maxOpenPositions);
      const maxOpenPositions = portfolioOpenCap !== null && portfolioOpenCap > 0
        ? Math.trunc(portfolioOpenCap)
        : Infinity;
      /** @type {{agentId:string, actions:Array<object>, orders:Array<object>, denied:Array<object>, spentUsd:number}} */
      const result = { agentId, actions: [], orders: [], denied: [], spentUsd: 0 };
      /** One order per symbol per run (an exited symbol is not re-entered in the same cycle). */
      const runOrderedUnderlyings = new Set();

      const deny = (code, reason, extra = {}) => {
        result.denied.push({ code, reason, ...extra });
      };
      const skip = (symbol, reason, extra = {}) => {
        result.actions.push({ type: 'skip', symbol, reason, ...extra });
      };

      // --- broker-fill reconciliation (paper/live market orders are async) ---------
      // Alpaca returns a market order as `accepted` before it fills. Booking that response
      // would mean a 0-qty fill (and the real fill would never reach the virtual ledger), so:
      //   - we track how much of each order id is already booked,
      //   - we reconcile recent broker orders for THIS agent at the start of every cycle,
      //   - and after submitting we briefly poll for the fill before booking.
      /** @type {Map<string, number>} `${orderId}:${symbol}:${side}` -> booked qty */
      const bookedQtyByOrder = new Map();
      if (typeof ledger.history === 'function') {
        try {
          for (const fill of ledger.history(agentId, { limit: 250 })) {
            if (!fill?.orderId) continue;
            const key = `${fill.orderId}:${String(fill.symbol ?? '').toUpperCase()}:${fill.side ?? ''}`;
            bookedQtyByOrder.set(key, (bookedQtyByOrder.get(key) ?? 0) + Number(fill.qty || 0));
          }
        } catch {
          /* history is optional for reconciliation */
        }
      }

      /** Book one not-yet-booked fill unit (stock, option contract or mleg leg). */
      async function bookFillUnit({ orderId, symbol, side, qty, priceUsd, assetClass, option, groupId, structure, multiplier }) {
        const ticker = String(symbol ?? '').toUpperCase();
        if (!ticker || !(Number(qty) > 0) || !(Number(priceUsd) > 0)) return 0;
        const key = `${orderId ?? 'noorder'}:${ticker}:${side ?? ''}`;
        const already = orderId ? (bookedQtyByOrder.get(key) ?? 0) : 0;
        const delta = round4(Number(qty) - already);
        if (!(delta > 0)) return 0;
        await ledger.applyFill(agentId, {
          symbol: ticker,
          assetClass: assetClass ?? 'us_equity',
          side,
          qty: delta,
          priceUsd: Number(priceUsd),
          multiplier: multiplier ?? (assetClass === 'us_option' ? OPTION_MULTIPLIER : 1),
          option: option ?? null,
          groupId: groupId ?? null,
          structure: structure ?? null,
          at,
          orderId: orderId ?? null,
        });
        bookedQtyByOrder.set(key, already + delta);
        return delta;
      }

      /** Book the not-yet-booked part of a broker order fill (incl. mleg leg fills). */
      async function bookFilledOrder(order) {
        const orderId = order?.id ?? null;
        const legs = Array.isArray(order?.legs) ? order.legs.filter((leg) => leg && leg.symbol) : [];
        if (legs.length >= 2) {
          const groupId = order.groupId ?? null;
          const structure = order.structure ?? null;
          let bookedLegs = 0;
          for (const leg of legs) {
            const filledLegQty = numberOrNull(leg.filledQty) ?? numberOrNull(leg.qty) ?? numberOrNull(leg.ratioQty) ?? 0;
            const legPrice = numberOrNull(leg.avgFillPriceUsd) ?? numberOrNull(leg.filledAvgPriceUsd) ?? 0;
            if (!(filledLegQty > 0) || !(legPrice > 0)) continue;
            const parsed = parseOccSymbol(leg.symbol);
            const booked = await bookFillUnit({
              orderId,
              symbol: leg.symbol,
              side: leg.side,
              qty: filledLegQty,
              priceUsd: legPrice,
              assetClass: 'us_option',
              option: parsed
                ? {
                    underlying: parsed.underlying,
                    type: parsed.type,
                    strikeUsd: parsed.strikeUsd,
                    expiration: parsed.expiration,
                    multiplier: OPTION_MULTIPLIER,
                    groupId,
                    structure,
                  }
                : null,
              groupId,
              structure,
              multiplier: OPTION_MULTIPLIER,
            });
            bookedLegs += booked;
          }
          return { bookedQty: bookedLegs, multiLeg: true, symbol: String(order.symbol ?? '').toUpperCase(), side: null, price: 0 };
        }
        const filledQty = numberOrNull(order?.filledQty) ?? 0;
        const price = numberOrNull(order?.avgFillPriceUsd) ?? numberOrNull(order?.filledAvgPriceUsd) ?? 0;
        const symbol = String(order?.symbol ?? '').toUpperCase();
        if (!(filledQty > 0) || !(price > 0) || symbol === '') return { bookedQty: 0, reason: 'not_filled' };
        const parsed = parseOccSymbol(symbol);
        const assetClass = order.assetClass === 'us_option' || parsed ? 'us_option' : 'us_equity';
        const booked = await bookFillUnit({
          orderId,
          symbol,
          side: order.side,
          qty: filledQty,
          priceUsd: price,
          assetClass,
          option: parsed
            ? {
                underlying: parsed.underlying,
                type: parsed.type,
                strikeUsd: parsed.strikeUsd,
                expiration: parsed.expiration,
                multiplier: OPTION_MULTIPLIER,
                groupId: order.groupId ?? null,
                structure: order.structure ?? null,
              }
            : null,
          groupId: order.groupId ?? null,
          structure: order.structure ?? null,
          multiplier: order.multiplier ?? (assetClass === 'us_option' ? OPTION_MULTIPLIER : 1),
        });
        return booked > 0
          ? { bookedQty: booked, price, side: order.side, symbol }
          : { bookedQty: 0, reason: 'already_booked' };
      }

      /** Book any filled orders the broker has for this agent that the ledger has not seen. */
      async function reconcileBrokerFills() {
        if (typeof broker.getOrders !== 'function' || typeof ledger.applyFill !== 'function') return;
        try {
          const recent = await broker.getOrders({ status: 'all', limit: 100, direction: 'desc' });
          for (const order of Array.isArray(recent) ? recent : []) {
            if (!String(order?.clientOrderId ?? '').startsWith(`atm:${agentId}:`)) continue;
            if (!['filled', 'partially_filled'].includes(String(order?.status))) continue;
            const booked = await bookFilledOrder(order);
            if (booked.bookedQty > 0) {
              result.actions.push({
                type: 'reconcile_fill',
                symbol: booked.symbol,
                side: booked.side,
                qty: booked.bookedQty,
                priceUsd: round2(booked.price),
                orderId: order.id ?? null,
              });
            }
          }
        } catch (error) {
          result.actions.push({ type: 'reconcile_skipped', reason: String(error?.message ?? error).slice(0, 140) });
        }
      }

      function orderHasFill(candidate) {
        if (!candidate) return false;
        if ((numberOrNull(candidate.filledQty) ?? 0) > 0) return true;
        return Array.isArray(candidate.legs)
          && candidate.legs.some((leg) => (numberOrNull(leg?.filledQty) ?? 0) > 0);
      }

      /** Poll briefly for a just-submitted order to fill; returns the freshest order record. */
      async function waitForFill(order) {
        if (!order || orderHasFill(order)) return order;
        if (typeof broker.getOrders !== 'function' && typeof broker.getOrder !== 'function') return order;
        for (let attempt = 0; attempt < 6; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          try {
            let match = null;
            if (typeof broker.getOrder === 'function' && order.id) {
              match = await broker.getOrder(order.id);
            }
            if (!match && typeof broker.getOrders === 'function') {
              const recent = await broker.getOrders({ status: 'all', limit: 100, direction: 'desc' });
              match = (Array.isArray(recent) ? recent : []).find(
                (candidate) => candidate?.id === order.id
                  || (order.clientOrderId && candidate?.clientOrderId === order.clientOrderId),
              );
            }
            if (match) {
              order = { ...order, ...match };
              if (orderHasFill(order)) return order;
            }
          } catch {
            /* retry until the short poll window ends */
          }
        }
        return order;
      }

      // --- identity and life-state ------------------------------------------------
      if (!agent || !agentId) {
        deny('UNKNOWN_AGENT', 'executor.run requires an agent record');
        return result;
      }
      if (agent.status === 'dead') {
        deny('AGENT_DEAD', `agent ${agentId} is dead and may not trade`);
        return result;
      }
      if (!spec || typeof spec !== 'object') {
        deny('SPEC_INVALID', 'executor.run requires a compiled StrategySpec');
        return result;
      }
      /** D9: a spec is usable only with its proof link (string URL ref). */
      const specHasProof = (candidate) => {
        if (!candidate || typeof candidate !== 'object') return false;
        const url = typeof candidate.proofRef === 'string'
          ? candidate.proofRef
          : candidate.proofRef?.url ?? (typeof candidate.proof?.url === 'string' ? candidate.proof.url : null);
        return typeof url === 'string' && url.trim().length > 0;
      };
      const proofUrl = specHasProof(spec)
        ? (typeof spec.proofRef === 'string' ? spec.proofRef : spec.proofRef?.url ?? spec.proof?.url)
        : null;
      if (!proofUrl && !basketSpecs.some(specHasProof)) {
        deny('NO_PROOF', 'spec carries no dated proof reference (D9)');
        return result;
      }
      /** Basket entries are only attempted on specs that carry their proof. */
      const entrySpecs = basketSpecs.length > 0
        ? basketSpecs.filter(specHasProof)
        : (specHasProof(spec) ? [spec] : []);
      if (!mandate || typeof mandate !== 'object') {
        deny('BRAKE_DENIED', 'no Treasurer mandate for this agent');
        return result;
      }
      const sizeBudgetUsd = numberOrNull(mandate.sizeBudgetUsd);
      if (sizeBudgetUsd === null || sizeBudgetUsd <= 0) {
        deny('BRAKE_DENIED', 'mandate carries no positive sizeBudgetUsd');
        return result;
      }

      // --- mandate gates (entries only; exits remain permitted) -------------------
      let entriesBlocked = false;
      let entriesBlockedReason = '';
      const mandateExpiresMs = timestampOf(mandate.expiresAt);
      if (mandateExpiresMs !== null && atMs > mandateExpiresMs) {
        entriesBlocked = true;
        entriesBlockedReason = 'mandate expired';
        deny('MANDATE_EXPIRED', `Treasurer mandate expired at ${new Date(mandateExpiresMs).toISOString()}`);
      }
      if (mandate.allowExitOnly === true) {
        entriesBlocked = true;
        entriesBlockedReason = 'treasury halted: exit-only';
        deny('BRAKE_DENIED', 'treasury halt: mandate is exit-only');
      }
      const allowedSymbols = Array.isArray(mandate.allowedSymbols)
        ? mandate.allowedSymbols.map((s) => String(s).toUpperCase())
        : null;

      // --- research influence (advisory, fresh-only, config-gated) -----------------
      // `research` is research.latest(agentId). Research can only veto, shrink, or
      // exit: it never increases a size, creates an order, or bypasses a brake.
      //
      // Live finding (2026-10-28): the analyst schema encourages listing risks, so the
      // average briefing carries 3.7 risks and a `risks >= 2` veto blocked 100% of entries.
      // Vetoes now need an explicit model recommendation (AVOID/ALERT) or a strongly negative
      // sentiment; a long risk list only shrinks the order. Thresholds are configurable.
      const researchCfg = config && typeof config === 'object' && config.research && typeof config.research === 'object'
        ? config.research
        : {};
      const researchVetoSentiment = numberOrNull(researchCfg.vetoSentiment) ?? -0.6;
      const researchExitSentiment = numberOrNull(researchCfg.exitSentiment) ?? -0.5;
      const researchVetoMinRisks = numberOrNull(researchCfg.vetoMinRisks) ?? 5;
      const researchRiskPenalty = clamp(numberOrNull(researchCfg.riskPenalty) ?? 0.6, 0.2, 1);
      const researchBriefing = researchInfluenceEnabled
        ? resolveResearchBriefing({ research, config, atMs })
        : null;
      const researchEffect = researchBriefing
        ? { verdict: researchBriefing.verdict, sentiment: researchBriefing.sentiment }
        : null;
      const researchVeto = Boolean(
        researchBriefing
        && (researchBriefing.verdict === 'AVOID'
          || researchBriefing.verdict === 'ALERT'
          || researchBriefing.sentiment <= researchVetoSentiment
          || researchBriefing.risks.length >= researchVetoMinRisks),
      );
      const researchExitAlert = Boolean(
        researchBriefing
        && (researchBriefing.verdict === 'ALERT' || researchBriefing.sentiment <= researchExitSentiment),
      );
      const researchBaseFactor = researchBriefing
        ? researchBriefing.sentiment > 0
          ? clamp(0.5 + researchBriefing.confidence * 0.5, 0.4, 1.0)
          : 0.6
        : 1;
      const researchRiskFactor = researchBriefing && researchBriefing.risks.length >= 2 ? researchRiskPenalty : 1;
      const researchSizeFactor = clamp(researchBaseFactor * researchRiskFactor, 0.3, 1.0);

      // --- per-bot agent policy (own brain, fresh-only, config-gated) --------------
      // `policy` is botAgents.policy(agentId). The bot's own stance can only reduce
      // exposure: stand down (no entries), shrink the entry size, or force an exit.
      // It never creates an order, never grows a size, and never bypasses a brake.
      const policyState = agentsEnabled
        ? resolveAgentPolicy({ policy, config, atMs })
        : null;
      const policyStandDown = Boolean(policyState && policyState.stance === 'stand_down');
      const policyExitPressure = Boolean(policyState && policyState.exitPressure === 'exit');
      const policySizeFactor = policyState ? policyState.sizeMultiplier : 1;
      const policyEffect = policyState
        ? { stance: policyState.stance, sizeMultiplier: policyState.sizeMultiplier }
        : null;

      // --- own position book (never broker.getAccount) ----------------------------
      // Reconcile pending fills BEFORE reading the book so today's fills become positions.
      await reconcileBrokerFills();
      const book = ledger.book(agentId);
      const positions = positionsToMap(book?.positions);
      const openOrders = Array.isArray(book?.openOrders) ? book.openOrders : [];

      // --- quotes + prices --------------------------------------------------------
      const quoteMap = quotes && typeof quotes === 'object' ? quotes : {};
      const priceMap = {};
      for (const [symbol, rawQuote] of Object.entries(quoteMap)) {
        const quote = normalizeQuote(rawQuote, symbol);
        if (quote) priceMap[quote.symbol] = quote.last;
      }

      async function getQuote(symbol) {
        const fromArgs = normalizeQuote(quoteMap[symbol], symbol);
        if (fromArgs) {
          priceMap[symbol] = fromArgs.last;
          return fromArgs;
        }
        if (typeof broker.getLatestQuote === 'function') {
          try {
            const fetched = normalizeQuote(await broker.getLatestQuote(symbol), symbol);
            if (fetched) {
              priceMap[symbol] = fetched.last;
              return fetched;
            }
          } catch (error) {
            deny(error?.code ?? 'DATA_MISSING', `quote unavailable for ${symbol}: ${error?.message ?? error}`);
          }
        }
        return null;
      }

      const barCache = new Map();
      async function getBars(symbol) {
        const ticker = String(symbol).toUpperCase();
        if (barCache.has(ticker)) return barCache.get(ticker);
        let rows = null;
        if (Array.isArray(providedBars)) rows = providedBars;
        else if (providedBars && typeof providedBars === 'object') rows = providedBars[ticker];
        if (!rows && typeof broker.getBars === 'function') {
          try {
            const fetched = await broker.getBars({
              symbols: [ticker],
              timeframe,
              feed: config.data?.feed ?? 'iex',
              limit: MAX_BARS_FETCH,
            });
            rows = Array.isArray(fetched) ? fetched : fetched?.[ticker];
          } catch {
            rows = null;
          }
        }
        const normalized = normalizeBars(rows);
        barCache.set(ticker, normalized);
        return normalized;
      }

      // --- multi-instrument helpers (docs/INSTRUMENTS.md) -------------------------
      // Per-agent permissions are the intersection of the global config gates and the
      // Treasurer mandate's instrument block (mandate is authoritative when present).
      const mandatePermissions = (() => {
        const raw = mandate && typeof mandate.instruments === 'object' && mandate.instruments ? mandate.instruments : null;
        const base = globalPermissions;
        if (!raw) return base;
        const allowedStructuresBase = Array.isArray(base.allowedStructures) ? base.allowedStructures : [];
        const allowed = (Array.isArray(raw.allowedStructures) ? raw.allowedStructures : allowedStructuresBase)
          .filter((structure) => !isOptionStructure(structure) || allowedStructuresBase.includes(structure));
        return {
          ...base,
          longStock: raw.longStock !== false && base.longStock !== false,
          shortStock: raw.shortStock === true && base.shortStock === true,
          longOptions: raw.longOptions === true && base.longOptions === true,
          shortOptions: raw.shortOptions === true && base.shortOptions === true,
          coveredCalls: raw.coveredCalls === true && base.coveredCalls === true,
          spreads: raw.spreads === true && base.spreads === true,
          margin: raw.margin === true && base.margin === true,
          allowedStructures: allowed,
          maxShortNotionalUsd: numberOrNull(raw.maxShortNotionalUsd) ?? maxShortNotionalUsd,
          maxOptionPremiumUsd: numberOrNull(raw.maxOptionPremiumUsd) ?? configMaxOptionPremiumUsd,
          maxContracts: Math.max(1, Math.trunc(numberOrNull(raw.maxContracts) ?? configMaxContracts)),
          maxMarginUsd: numberOrNull(raw.maxMarginUsd),
        };
      })();
      const policyInstrument = policyState?.instrument ?? null;
      const assetCache = new Map();
      const chainCache = new Map();

      async function getAssetInfo(symbol) {
        const ticker = String(symbol ?? '').toUpperCase();
        if (assetCache.has(ticker)) return assetCache.get(ticker);
        let asset = null;
        if (typeof broker.getAsset === 'function') {
          try {
            asset = await broker.getAsset(ticker);
          } catch {
            asset = null;
          }
        }
        assetCache.set(ticker, asset);
        return asset;
      }

      /** Whole shares held long in one underlying (covered-call guard). */
      function longSharesOf(underlying) {
        const position = positions.get(String(underlying ?? '').toUpperCase());
        if (!position || position.assetClass !== 'us_equity' || position.qtySigned <= 0) return 0;
        return position.qtySigned;
      }

      /** Premium already committed to open option positions (USD notional). */
      function openOptionPremiumUsd() {
        let total = 0;
        for (const position of positions.values()) {
          if (position.assetClass !== 'us_option') continue;
          total += position.absQty * position.avgPriceUsd * (position.multiplier || OPTION_MULTIPLIER);
        }
        return round2(total);
      }

      async function loadOptionChain(underlying, right) {
        const ticker = String(underlying ?? '').toUpperCase();
        const key = `${ticker}:${right}`;
        if (chainCache.has(key)) return chainCache.get(key);
        let chain = [];
        if (instrumentsEnabled && typeof broker.getOptionChain === 'function') {
          try {
            const fetched = await broker.getOptionChain({ underlying: ticker, type: right, limit: 250 }, { nowMs: atMs });
            chain = Array.isArray(fetched) ? fetched : [];
          } catch {
            chain = [];
          }
        }
        chain = chain
          .filter((contract) => contract && contract.symbol && contract.tradable !== false)
          .map((contract) => ({
            ...contract,
            strikeUsd: numberOrNull(contract.strikeUsd) ?? 0,
            dte: numberOrNull(contract.dte) ?? daysToExpiration(contract.expiration, atMs),
          }))
          .filter((contract) => contract.strikeUsd > 0 && Number.isFinite(contract.dte) && contract.dte >= 0);
        chainCache.set(key, chain);
        return chain;
      }

      /** Resolve a contract's live synthetic/market price (mark/bid/ask + dte). */
      async function contractQuote(contract) {
        if (!contract) return null;
        const parsed = parseOccSymbol(contract.symbol);
        let quote = null;
        if (typeof broker.getOptionQuote === 'function' && parsed) {
          try {
            quote = await broker.getOptionQuote(contract.symbol, { nowMs: atMs, feed: optionDataFeed });
          } catch {
            quote = null;
          }
        }
        const fallback = numberOrNull(contract.closePriceUsd);
        const mark = numberOrNull(quote?.mark) ?? numberOrNull(quote?.last) ?? fallback;
        if (!(mark > 0)) return null;
        const bid = numberOrNull(quote?.bid);
        const ask = numberOrNull(quote?.ask);
        return {
          symbol: contract.symbol,
          parsed,
          contract,
          mark,
          bid: bid !== null && bid > 0 ? bid : mark,
          ask: ask !== null && ask > 0 ? ask : mark,
          dte: numberOrNull(quote?.dte) ?? contract.dte,
          ts: quote?.ts ?? null,
        };
      }

      function nearestContract(chain, { right, expiration, targetStrike }) {
        let best = null;
        for (const contract of chain) {
          if (String(contract.type ?? '').toLowerCase() !== right) continue;
          if (expiration && contract.expiration !== expiration) continue;
          const distance = Math.abs(Number(contract.strikeUsd) - targetStrike);
          if (!best || distance < best.distance || (distance === best.distance && contract.strikeUsd < best.contract.strikeUsd)) {
            best = { distance, contract };
          }
        }
        return best?.contract ?? null;
      }

      function pickExpiration(chain, target, dteMin, dteMax) {
        const inWindow = chain.filter((contract) => contract.dte >= dteMin && contract.dte <= dteMax);
        const pool = inWindow.length > 0 ? inWindow : chain.filter((contract) => contract.dte > 0);
        if (pool.length === 0) return null;
        let best = null;
        for (const contract of pool) {
          const distance = Math.abs(Number(contract.dte) - target);
          if (!best || distance < best.distance || (distance === best.distance && contract.dte < best.contract.dte)) {
            best = { distance, contract };
          }
        }
        return best?.contract?.expiration ?? null;
      }

      /** The premium/contracts budget for one option order (only shrinks with research/policy). */
      function optionBudgetUsd(permissions) {
        const pct = Number.isFinite(maxOptionPremiumPctEquity) ? maxOptionPremiumPctEquity : 0.25;
        const pctBudget = Number.isFinite(equityUsd) ? Math.max(0, equityUsd) * pct : 0;
        const perOrder = Number.isFinite(permissions.maxOptionPremiumUsd)
          ? permissions.maxOptionPremiumUsd
          : configMaxOptionPremiumUsd;
        const policyCap = numberOrNull(policyInstrument?.maxPremiumUsd);
        const caps = [pctBudget, perOrder, Number.isFinite(policyCap) ? policyCap : Infinity];
        const remaining = Math.max(0, Math.min(...caps) - openOptionPremiumUsd());
        return round2(remaining * researchSizeFactor * policySizeFactor);
      }

      function optionMaxContracts(permissions) {
        const policyCap = numberOrNull(policyInstrument?.maxContracts);
        const caps = [permissions.maxContracts ?? configMaxContracts, configMaxContracts];
        if (policyCap !== null) caps.push(Math.trunc(policyCap));
        return Math.max(1, Math.trunc(Math.min(...caps.filter((value) => Number.isFinite(value) && value > 0))));
      }

      /**
       * Build a defined-risk option plan for one structure: select expiry (DTE window),
       * strikes (2–5% OTM / spread width), price the legs and size the contracts.
       * Returns null when the structure cannot be built/afforded (caller falls back to
       * stock), or {blocked} for a covered call without 100 long shares.
       */
      async function buildOptionPlan({ structure, family, underlying, direction }) {
        const ticker = String(underlying ?? '').toUpperCase();
        const spot = numberOrNull(priceMap[ticker]);
        if (!(spot > 0)) return null;
        const right = optionRightForStructure(structure) ?? (structure.includes('put') ? 'put' : 'call');
        const chain = await loadOptionChain(ticker, right);
        if (chain.length === 0) return null;
        const dteMin = Math.max(1, Math.trunc(numberOrNull(policyInstrument?.dteMin) ?? minDTE));
        const dteMax = Math.max(dteMin, Math.trunc(numberOrNull(policyInstrument?.dteMax) ?? maxDTE));
        const targetDte = structureTargetDTE(family, structure, dteMin, dteMax);
        const expiration = pickExpiration(chain, targetDte, dteMin, dteMax);
        if (!expiration) return null;
        const offset = structureStrikeOffset(family, structure);
        const widthStep = spot >= 100 ? 5 : spot >= 25 ? 1 : 0.5;
        const width = Math.max(widthStep, Math.round((spot * spreadWidthFraction(family)) / widthStep) * widthStep);
        const permissions = mandatePermissions;
        const maxContracts = optionMaxContracts(permissions);
        const budgetUsd = optionBudgetUsd(permissions);

        const legSpecs = [];
        if (structure === 'long_call' || structure === 'long_put') {
          if (!(budgetUsd > 0)) return null;
          const target = structure === 'long_call' ? spot * (1 + offset) : spot * (1 - offset);
          const contract = nearestContract(chain, { right, expiration, targetStrike: target });
          if (!contract) return null;
          const quote = await contractQuote(contract);
          if (!quote) return null;
          legSpecs.push({ contract, quote, side: 'buy', positionIntent: 'buy_to_open', ratioQty: 1 });
          const perContract = quote.ask * OPTION_MULTIPLIER;
          const contracts = Math.min(maxContracts, Math.floor(budgetUsd / perContract));
          if (!(contracts > 0)) return null;
          return {
            structure,
            orderClass: 'simple',
            underlying: ticker,
            side: 'buy',
            contracts,
            expiration,
            perContractCostUsd: round2(perContract),
            premiumUsd: round2(contracts * perContract),
            maxRiskUsd: round2(contracts * perContract),
            limitPrice: quote.ask,
            legs: [{ ...legSpecs[0], contract, quote }],
          };
        }
        if (structure === 'covered_call') {
          const shares = longSharesOf(ticker);
          const coveredContracts = Math.min(Math.floor(shares / 100), maxContracts);
          if (coveredContracts < 1) return { blocked: 'covered_call_requires_100_shares', structure };
          const target = spot * (1 + offset);
          const contract = nearestContract(chain, { right: 'call', expiration, targetStrike: target });
          if (!contract) return null;
          const quote = await contractQuote(contract);
          if (!quote) return null;
          return {
            structure,
            orderClass: 'simple',
            underlying: ticker,
            side: 'sell',
            contracts: coveredContracts,
            expiration,
            perContractCostUsd: 0,
            premiumUsd: round2(coveredContracts * quote.bid * OPTION_MULTIPLIER),
            maxRiskUsd: 0,
            limitPrice: quote.bid,
            legs: [{ contract, quote, side: 'sell', positionIntent: 'sell_to_open', ratioQty: 1 }],
          };
        }
        // --- vertical spreads (one mleg order, two legs, defined risk) ----------
        if (!(budgetUsd > 0)) return null;
        let primaryStrike;
        let secondaryStrike;
        let primarySide;
        let secondarySide;
        let rightSide;
        let structureSide;
        if (structure === 'call_credit_spread') {
          structureSide = 'credit';
          rightSide = 'call';
          primaryStrike = spot * (1 + offset); // short call
          secondaryStrike = primaryStrike + width; // long call further OTM
          primarySide = 'sell';
          secondarySide = 'buy';
        } else if (structure === 'put_credit_spread') {
          structureSide = 'credit';
          rightSide = 'put';
          primaryStrike = spot * (1 - offset); // short put
          secondaryStrike = primaryStrike - width; // long put further OTM
          primarySide = 'sell';
          secondarySide = 'buy';
        } else if (structure === 'bull_call_spread') {
          structureSide = 'debit';
          rightSide = 'call';
          primaryStrike = spot * (1 + 0.005); // long call near the money
          secondaryStrike = primaryStrike + width; // short call above
          primarySide = 'buy';
          secondarySide = 'sell';
        } else if (structure === 'bear_put_spread') {
          structureSide = 'debit';
          rightSide = 'put';
          primaryStrike = spot * (1 - 0.005); // long put near the money
          secondaryStrike = primaryStrike - width; // short put below
          primarySide = 'buy';
          secondarySide = 'sell';
        } else {
          return null;
        }
        const primaryContract = nearestContract(chain, { right: rightSide, expiration, targetStrike: primaryStrike });
        const secondaryContract = nearestContract(chain, { right: rightSide, expiration, targetStrike: secondaryStrike });
        if (!primaryContract || !secondaryContract || primaryContract.symbol === secondaryContract.symbol) return null;
        const primaryQuote = await contractQuote(primaryContract);
        const secondaryQuote = await contractQuote(secondaryContract);
        if (!primaryQuote || !secondaryQuote) return null;
        const strikeWidth = Math.abs(primaryContract.strikeUsd - secondaryContract.strikeUsd);
        if (!(strikeWidth > 0)) return null;
        const longQuote = primarySide === 'buy' ? primaryQuote : secondaryQuote;
        const shortQuote = primarySide === 'sell' ? primaryQuote : secondaryQuote;
        const netDebit = round2(longQuote.ask - shortQuote.bid);
        const netCredit = round2(shortQuote.bid - longQuote.ask);
        let perContractCostUsd;
        if (structureSide === 'debit') {
          if (!(netDebit > 0.01)) return null; // no sensible debit
          perContractCostUsd = netDebit * OPTION_MULTIPLIER;
        } else {
          if (!(netCredit > 0.01)) return null; // no sensible credit
          perContractCostUsd = Math.max(1, (strikeWidth - netCredit) * OPTION_MULTIPLIER); // defined max risk
        }
        const contracts = Math.min(maxContracts, Math.floor(budgetUsd / perContractCostUsd));
        if (!(contracts > 0)) return null;
        const legs = [
          { contract: primaryContract, quote: primaryQuote, side: primarySide, positionIntent: primarySide === 'buy' ? 'buy_to_open' : 'sell_to_open', ratioQty: 1 },
          { contract: secondaryContract, quote: secondaryQuote, side: secondarySide, positionIntent: secondarySide === 'buy' ? 'buy_to_open' : 'sell_to_open', ratioQty: 1 },
        ];
        return {
          structure,
          orderClass: 'mleg',
          underlying: ticker,
          side: structureSide === 'credit' ? 'sell' : 'buy',
          contracts,
          expiration,
          perContractCostUsd: round2(perContractCostUsd),
          premiumUsd: round2(contracts * (structureSide === 'debit' ? netDebit : -netCredit) * OPTION_MULTIPLIER),
          maxRiskUsd: round2(contracts * (structureSide === 'debit' ? netDebit * OPTION_MULTIPLIER : (strikeWidth - netCredit) * OPTION_MULTIPLIER)),
          limitPrice: structureSide === 'debit' ? netDebit : netCredit,
          legs,
        };
      }

      // --- equity proxy used only for the absolute sizing cap ---------------------
      let equityUsd = null;
      if (Number.isFinite(mandate.equityUsd)) equityUsd = mandate.equityUsd;
      else if (Number.isFinite(agent.equityUsd)) equityUsd = agent.equityUsd;
      else if (typeof ledger.equity === 'function') {
        try {
          const view = ledger.equity(agentId, priceMap);
          if (Number.isFinite(view?.equityUsd)) equityUsd = view.equityUsd;
        } catch {
          /* fall through to a conservative proxy below */
        }
      }
      // Conservative last resort so the absolute cap can still be computed.
      if (!Number.isFinite(equityUsd)) equityUsd = sizeBudgetUsd;

      let snapshot = null;
      if (typeof ledger.snapshot === 'function') {
        try {
          snapshot = ledger.snapshot(agentId);
        } catch {
          snapshot = null;
        }
      }

      const ordersPlaced = () => result.orders.length;
      // One shared order budget for the whole run (exits + entries), portfolio-aware.
      const cycleBudgetLeft = () => runMaxOrders - ordersPlaced();

      /**
       * Check the brakes, submit, and book the fill for one intended order.
       * Handles long/short stock, single-leg options and multi-leg (mleg) option
       * spreads; every path passes `brakes.checkOrder()` first (no bypass).
       * @returns {Promise<object|null>} submitted order or null when denied/skipped
       */
      async function submitChecked({
        symbol,
        side,
        qty,
        priceUsd,
        reason,
        kind,
        quote,
        positionsSnapshot,
        research: actionResearch = null,
        policy: actionPolicy = null,
        assetClass = 'us_equity',
        asset = null,
        option = null,
        structure = null,
        groupId = null,
        legs = null,
        orderClass = 'simple',
        limitPrice = null,
        positionIntent = null,
        marginRequiredUsd = 0,
        underlying = null,
        orderType = null,
        closing = false,
        orderSpec = spec,
      }) {
        const isMultiLeg = orderClass === 'mleg' && Array.isArray(legs) && legs.length >= 2;
        const isOptionOrder = assetClass === 'us_option' || isMultiLeg;
        const ticker = String(symbol).toUpperCase();
        const displaySymbol = underlying ? String(underlying).toUpperCase() : ticker;
        // D9: each order's spec must carry its proof; a basket spec without proof is not
        // tradable (the run-level gate already rejected the all-missing case).
        const activeProofUrl = typeof orderSpec?.proofRef === 'string'
          ? orderSpec.proofRef
          : orderSpec?.proofRef?.url ?? (typeof orderSpec?.proof?.url === 'string' ? orderSpec.proof.url : null);
        if (typeof activeProofUrl !== 'string' || activeProofUrl.trim().length === 0) {
          deny('NO_PROOF', `spec for ${displaySymbol} carries no dated proof reference (D9)`, { symbol: displaySymbol });
          skip(displaySymbol, 'no_proof');
          return null;
        }
        const orderQty = isMultiLeg ? Math.max(1, Math.trunc(qty)) : round4(qty);
        if (!(orderQty > 0)) {
          skip(displaySymbol, 'qty_rounds_to_zero');
          return null;
        }
        const premiumNotionalUsd = isOptionOrder
          ? round2(orderQty * priceUsd * OPTION_MULTIPLIER)
          : round2(orderQty * priceUsd);
        const notionalUsd = premiumNotionalUsd;
        const cashRequiredUsd = side === 'buy' && !closing
          ? (isMultiLeg ? round2(orderQty * priceUsd * OPTION_MULTIPLIER) : premiumNotionalUsd)
          : 0;
        const marginRequiredForOrder = round2(Number(marginRequiredUsd) || 0);
        const spreadBps = spreadBpsOf(quote);
        const optionMeta = isOptionOrder
          ? {
              underlying: displaySymbol,
              expiration: option?.expiration ?? null,
              type: option?.type ?? (ticker ? parseOccSymbol(ticker)?.type : null) ?? null,
              strikeUsd: numberOrNull(option?.strikeUsd) ?? (parseOccSymbol(ticker)?.strikeUsd ?? null),
              multiplier: OPTION_MULTIPLIER,
              dte: numberOrNull(option?.dte) ?? daysToExpiration(option?.expiration ?? parseOccSymbol(ticker)?.expiration, atMs),
              structure: structure ?? null,
              groupId: groupId ?? null,
            }
          : null;
        const mappedLegs = isMultiLeg
          ? legs.map((leg) => ({
              symbol: String(leg.contract?.symbol ?? leg.symbol ?? '').toUpperCase(),
              side: leg.side,
              ratioQty: Number(leg.ratioQty) || 1,
              positionIntent: leg.positionIntent ?? null,
            }))
          : undefined;
        /** @type {object} */
        const orderInput = {
          // Single-leg option orders must carry the OCC contract symbol: the D16 brake validates
          // order.symbol as an option contract and the broker submits it directly. Display/whitelist
          // logic still uses the underlying (displaySymbol). Multi-leg orders are validated by legs.
          symbol: isMultiLeg ? displaySymbol : isOptionOrder ? ticker : displaySymbol,
          side,
          qty: orderQty,
          priceUsd,
          notionalUsd,
          netPremiumUsd: premiumNotionalUsd,
          assetClass: isOptionOrder ? 'us_option' : 'us_equity',
          asset,
          option: optionMeta,
          structure: structure ?? null,
          groupId: groupId ?? null,
          legs: mappedLegs,
          marginRequiredUsd: marginRequiredForOrder,
          premiumUsd: premiumNotionalUsd,
          positionIntent: positionIntent ?? null,
          limitPrice: limitPrice ?? null,
          orderClass: isMultiLeg ? 'mleg' : 'simple',
        };
        /** @type {object} */
        const brakeInput = {
          mode: config.mode,
          now: atMs,
          agentId,
          dayStats: dayStats ?? { dayKey: null, ordersCount: 0, startEquityUsd: equityUsd, pnlUsd: 0 },
          quote,
          order: orderInput,
          assetClass: isOptionOrder ? 'us_option' : 'us_equity',
          asset,
          option: optionMeta,
          structure: structure ?? null,
          groupId: groupId ?? null,
          legs: mappedLegs,
          marginRequiredUsd: marginRequiredForOrder,
          closing,
          equityUsd,
          // D17 margin inputs: current virtual debt + any mandate buying-power figure.
          marginDebtUsd: numberOrNull(snapshot?.marginDebtUsd) ?? 0,
          buyingPowerUsd: numberOrNull(mandate?.buyingPowerUsd) ?? numberOrNull(mandate?.equityUsd) ?? null,
          positions: positionsSnapshot,
          mandate,
          // D9 per-order proof context: the spec that owns THIS symbol's parameters.
          spec: orderSpec,
          ...(Array.isArray(basketSpecs) && basketSpecs.length > 1 ? { basketSpecs: basketSpecs.map((entry) => entry.specId ?? entry.symbol) } : {}),
          // D13 is enforced by the Treasurer (the only role allowed to read account
          // equity). The Executor must never obtain account equity, so it forwards a
          // mandate-provided figure when present and otherwise leaves the check to the
          // Treasurer; brakes skips D13 when these are not finite numbers.
          accountEquityUsd: Number.isFinite(mandate.accountEquityUsd) ? mandate.accountEquityUsd : null,
          allocatedEquityUsd: Number.isFinite(mandate.allocatedEquityUsd) ? mandate.allocatedEquityUsd : null,
          spreadBps,
          // D3 needs the broker's authoritative session state, not just a clock window: a
          // weekday window check would happily trade on a Saturday. The orchestrator reads
          // `/v2/clock` once per cycle and forwards it here.
          marketOpen,
          marketClock,
        };

        let decision;
        try {
          decision = await brakes.checkOrder(brakeInput);
        } catch (error) {
          deny(error?.code ?? 'BRAKE_DENIED', `brakes threw: ${error?.message ?? error}`, { symbol: displaySymbol, side });
          skip(displaySymbol, `brake_denied:${error?.code ?? 'BRAKE_DENIED'}`, { reason: error?.message ?? String(error) });
          return null;
        }
        if (!decision || decision.decision !== 'ALLOW') {
          deny(decision?.code ?? 'BRAKE_DENIED', decision?.reason ?? 'brakes denied the order', {
            symbol: displaySymbol,
            side,
            rule: decision?.rule ?? null,
            structure: structure ?? null,
          });
          skip(displaySymbol, `brake_denied:${decision?.code ?? 'BRAKE_DENIED'}`, { rule: decision?.rule ?? null });
          return null;
        }

        // Our own virtual book must be able to pay for a debit (no broker account read).
        if (cashRequiredUsd > 0 && snapshot && Number.isFinite(snapshot.cashUsd) && snapshot.cashUsd < cashRequiredUsd) {
          deny('INSUFFICIENT_CASH', `virtual cash ${snapshot.cashUsd} < required ${cashRequiredUsd}`, { symbol: displaySymbol });
          skip(displaySymbol, 'insufficient_cash');
          return null;
        }

        const seq = nextSeq(agentId);
        const orderSpecId = String(orderSpec?.specId ?? spec.specId ?? 'spec');
        const clientOrderId = `atm:${agentId}:${orderSpecId}:${seq}`;
        // Every option order gets a durable internal group link for the ledger (spread legs
        // are opened/closed together); single-leg orders use their own group as well.
        const effectiveGroupId = isOptionOrder
          ? String(groupId ?? `grp:${agentId}:${orderSpecId}:${seq}`)
          : null;
        if (isOptionOrder) {
          orderInput.groupId = effectiveGroupId;
          brakeInput.groupId = effectiveGroupId;
          brakeInput.order.groupId = effectiveGroupId;
          if (optionMeta) optionMeta.groupId = effectiveGroupId;
        }
        let order;
        try {
          if (isMultiLeg) {
            order = await broker.submitOrder({
              orderClass: 'mleg',
              type: 'limit',
              limitPrice,
              legs: legs.map((leg) => ({
                symbol: leg.contract?.symbol ?? leg.symbol,
                side: leg.side,
                ratioQty: leg.ratioQty ?? 1,
                positionIntent: leg.positionIntent,
              })),
              qty: orderQty,
              clientOrderId,
              timeInForce: 'day',
              groupId: effectiveGroupId,
              structure,
            });
          } else if (isOptionOrder) {
            order = await broker.submitOrder({
              symbol: ticker,
              assetClass: 'us_option',
              side,
              qty: Math.trunc(orderQty),
              type: orderType ?? 'limit',
              limitPrice,
              positionIntent,
              clientOrderId,
              timeInForce: 'day',
              groupId: effectiveGroupId,
              structure,
            });
          } else {
            order = await broker.submitOrder({
              symbol: ticker,
              assetClass: 'us_equity',
              side,
              qty: orderQty,
              type: orderType ?? 'market',
              limitPrice: limitPrice ?? undefined,
              positionIntent: positionIntent ?? undefined,
              clientOrderId,
              timeInForce: 'day',
            });
          }
        } catch (error) {
          deny(error?.code ?? 'BROKER_ERROR', `broker rejected order: ${error?.message ?? error}`, {
            symbol: displaySymbol,
            side,
            clientOrderId,
          });
          skip(displaySymbol, `broker_error:${error?.code ?? 'BROKER_ERROR'}`);
          return null;
        }

        const resolvedOrder = await waitForFill(order);
        const bookableOrder = isOptionOrder
          ? {
              ...resolvedOrder,
              groupId: effectiveGroupId,
              structure: structure ?? null,
              legs: Array.isArray(resolvedOrder?.legs) && resolvedOrder.legs.length > 0
                ? resolvedOrder.legs.map((leg) => ({
                    ...leg,
                    side: leg.side ?? (leg.positionIntent?.startsWith('sell') ? 'sell' : 'buy'),
                  }))
                : resolvedOrder?.legs,
            }
          : resolvedOrder;
        result.orders.push(resolvedOrder);
        runOrderedUnderlyings.add(displaySymbol);
        let booked = { bookedQty: 0 };
        try {
          booked = await bookFilledOrder(bookableOrder);
        } catch (error) {
          deny(error?.code ?? 'LEDGER_REJECTED', `fill could not be booked: ${error?.message ?? error}`, {
            symbol: displaySymbol,
            orderId: resolvedOrder?.id ?? null,
          });
        }
        const bookedQty = booked.bookedQty ?? 0;
        result.actions.push({
          type: kind,
          symbol: displaySymbol,
          side,
          qty: isMultiLeg ? orderQty : bookedQty,
          // A market order that is still `accepted` is not a denial: the next cycle's
          // reconciliation books the fill once the broker reports it as filled.
          reason: bookedQty > 0 || isMultiLeg ? reason : `${reason} (awaiting fill)`,
          orderId: resolvedOrder?.id ?? null,
          fillPriceUsd: isMultiLeg ? round2(limitPrice) : bookedQty > 0 ? round2(booked.price) : null,
          pending: bookedQty === 0 && !isMultiLeg,
          ...(isOptionOrder
            ? {
                instrument: structure ?? (option?.type === 'put' ? 'long_put' : 'long_call'),
                assetClass: 'us_option',
                structure: structure ?? null,
                groupId: groupId ?? null,
                option: option ?? null,
                contractSymbol: isMultiLeg ? null : ticker,
                contracts: orderQty,
                legs: mappedLegs ?? null,
              }
            : { assetClass: 'us_equity' }),
          ...(actionResearch ? { research: actionResearch } : {}),
          ...(actionPolicy ? { policy: actionPolicy } : {}),
        });
        // Position book changed; keep the local map current for the rest of the cycle.
        if (bookedQty > 0 && !isOptionOrder) {
          if (side === 'buy') {
            const existing = positions.get(ticker);
            positions.set(ticker, {
              qtySigned: round4((existing?.qtySigned ?? 0) + bookedQty),
              qty: round4((existing?.qtySigned ?? 0) + bookedQty),
              avgPriceUsd: existing?.avgPriceUsd ?? booked.price,
              openedAt: existing?.openedAt ?? at,
              assetClass: 'us_equity',
              multiplier: 1,
            });
          } else {
            positions.delete(ticker);
          }
        }
        return resolvedOrder;
      }

      // --- shared exit/entry helpers (multi-instrument) ---------------------------
      const signalCache = new Map();
      async function getSignalFor(underlying, activeSpec = spec) {
        const ticker = String(underlying ?? '').toUpperCase();
        const specKey = activeSpec?.specId ?? activeSpec?.symbol ?? 'primary';
        const cacheKey = `${ticker}:${specKey}`;
        if (signalCache.has(cacheKey)) return signalCache.get(cacheKey);
        const bars = await getBars(ticker);
        const signal = computeSignal(activeSpec?.family ?? spec.family, bars, activeSpec?.params ?? spec.params);
        signalCache.set(cacheKey, signal);
        return signal;
      }

      /** Order candidates: bot-chosen preference first, then family playbook, stock fallback last. */
      function candidateStructures(family, direction) {
        const preferred = policyInstrument?.prefer;
        const stockFallback = direction === 'bearish' ? 'short_stock' : 'long_stock';
        const candidates = [];
        if (preferred && preferred !== 'auto') {
          if (preferred === 'stock') candidates.push('long_stock');
          else if (preferred === 'short_stock') {
            if (direction === 'bearish') candidates.push('short_stock');
          } else if (isOptionStructure(preferred)) {
            const preferredDirection = structureDirection(preferred);
            if (preferredDirection === direction || preferredDirection === 'neutral') candidates.push(preferred);
          }
        }
        for (const entry of playbookStructures(family, direction)) {
          if (!candidates.includes(entry)) candidates.push(entry);
        }
        if (!candidates.includes(stockFallback)) candidates.push(stockFallback);
        if (!instrumentsEnabled) return [stockFallback];
        return candidates;
      }

      async function enterLongStockEntry({ symbol, quote, signal, reason, activeSpec = spec }) {
        const price = round4(quote.ask ?? quote.last);
        const caps = [(activeSpec.params?.sizePct ?? 0.2) * sizeBudgetUsd * researchSizeFactor * policySizeFactor];
        if (Number.isFinite(mandate.maxOrderNotionalUsd)) caps.push(mandate.maxOrderNotionalUsd);
        if (Number.isFinite(hardMaxNotionalUsd)) caps.push(hardMaxNotionalUsd);
        if (Number.isFinite(equityUsd)) caps.push(maxOrderPctOfEquity * equityUsd);
        if (snapshot && Number.isFinite(snapshot.cashUsd) && snapshot.cashUsd > 0) caps.push(snapshot.cashUsd);
        const capValue = Math.min(...caps.filter((cap) => Number.isFinite(cap) && cap > 0));
        let qty = round4(capValue / price);
        let notionalUsd = round2(qty * price);
        if (notionalUsd < minOrderNotionalUsd || qty <= 0) {
          const minQty = round4(minOrderNotionalUsd / price);
          if (minQty > 0 && round2(minQty * price) <= capValue + 0.01) {
            qty = minQty;
            notionalUsd = round2(qty * price);
          } else {
            skip(symbol, 'below_min_notional', { attemptedNotionalUsd: notionalUsd, minOrderNotionalUsd });
            return false;
          }
        }
        const order = await submitChecked({
          symbol,
          side: 'buy',
          qty,
          priceUsd: price,
          reason,
          kind: 'entry',
          quote,
          positionsSnapshot: Object.fromEntries(positions),
          orderSpec: activeSpec,
          research: researchEffect ? { ...researchEffect, applied: 'size' } : null,
          policy: policyEffect ? { ...policyEffect, applied: 'size' } : null,
        });
        return Boolean(order);
      }

      async function enterShortStockEntry({ symbol, quote, signal, activeSpec = spec }) {
        const asset = await getAssetInfo(symbol);
        if (instrumentsConfig.shortableOnly !== false && asset && (asset.shortable === false || asset.marginable === false)) {
          skip(symbol, 'asset_not_shortable');
          return false;
        }
        const price = round4(quote.bid ?? quote.last);
        const caps = [(activeSpec.params?.sizePct ?? 0.2) * sizeBudgetUsd * researchSizeFactor * policySizeFactor];
        if (Number.isFinite(mandate.maxOrderNotionalUsd)) caps.push(mandate.maxOrderNotionalUsd);
        if (Number.isFinite(hardMaxNotionalUsd)) caps.push(hardMaxNotionalUsd);
        if (Number.isFinite(equityUsd)) caps.push(maxOrderPctOfEquity * equityUsd);
        if (Number.isFinite(mandatePermissions.maxShortNotionalUsd)) caps.push(mandatePermissions.maxShortNotionalUsd);
        const capValue = Math.min(...caps.filter((cap) => Number.isFinite(cap) && cap > 0));
        const qty = Math.trunc(capValue / price);
        if (!(qty >= 1)) {
          skip(symbol, 'short_notional_too_small', { capUsd: round2(capValue) });
          return false;
        }
        const order = await submitChecked({
          symbol,
          side: 'sell',
          qty,
          priceUsd: price,
          reason: signal?.reason ?? 'short_signal',
          kind: 'entry',
          quote,
          asset,
          positionsSnapshot: Object.fromEntries(positions),
          orderSpec: activeSpec,
          research: researchEffect ? { ...researchEffect, applied: 'size' } : null,
          policy: policyEffect ? { ...policyEffect, applied: 'size' } : null,
        });
        return Boolean(order);
      }

      async function enterOptionEntry({ plan, quote, signal, direction, activeSpec = spec }) {
        const right = optionRightForStructure(plan.structure) ?? (plan.structure.includes('put') ? 'put' : 'call');
        const primary = plan.legs[0];
        const creditStructure = plan.structure === 'covered_call'
          || plan.structure === 'call_credit_spread'
          || plan.structure === 'put_credit_spread';
        return Boolean(await submitChecked({
          symbol: plan.orderClass === 'simple' ? primary.contract.symbol : plan.underlying,
          underlying: plan.underlying,
          side: plan.side,
          qty: plan.contracts,
          priceUsd: plan.limitPrice,
          reason: signal?.reason ?? direction,
          kind: 'entry',
          quote,
          assetClass: 'us_option',
          asset: await getAssetInfo(plan.underlying),
          option: {
            underlying: plan.underlying,
            expiration: plan.expiration,
            type: right,
            strikeUsd: primary.contract?.strikeUsd ?? null,
            dte: primary.quote?.dte ?? primary.contract?.dte ?? null,
            multiplier: OPTION_MULTIPLIER,
          },
          structure: plan.structure,
          orderClass: plan.orderClass,
          legs: plan.legs,
          limitPrice: plan.limitPrice,
          orderType: 'limit',
          positionIntent: plan.orderClass === 'simple' ? primary.positionIntent : null,
          marginRequiredUsd: creditStructure && plan.orderClass === 'mleg' ? plan.maxRiskUsd : 0,
          closing: false,
          positionsSnapshot: Object.fromEntries(positions),
          orderSpec: activeSpec,
          research: researchEffect ? { ...researchEffect, applied: 'size' } : null,
          policy: policyEffect ? { ...policyEffect, applied: 'size' } : null,
        }));
      }

      // =========================================================================
      // 1) EXITS FIRST (risk-reducing orders have priority over new entries)
      // =========================================================================
      const barMs = timeframeToMs(timeframe);
      // v3.2: each held position is managed with the spec of ITS underlying symbol
      // (fallback: the primary spec) so a basket bot keeps per-symbol stop/target/hold rules.
      const primaryParams = spec.params ?? {};
      const fallbackStopPct = numberOrNull(primaryParams.stopPct) ?? 0.02;
      const fallbackTargetPct = numberOrNull(primaryParams.targetPct) ?? 0.04;
      const fallbackMaxHoldBars = numberOrNull(primaryParams.maxHoldBars) ?? 12;
      const exitParamsFor = (underlying) => {
        const activeSpec = specForSymbol(underlying) ?? spec;
        const params = activeSpec?.params ?? primaryParams;
        return {
          activeSpec,
          stopPct: numberOrNull(params.stopPct) ?? fallbackStopPct,
          targetPct: numberOrNull(params.targetPct) ?? fallbackTargetPct,
          maxHoldBars: numberOrNull(params.maxHoldBars) ?? fallbackMaxHoldBars,
        };
      };
      const exitResearch = researchExitAlert ? { ...researchEffect, applied: 'exit' } : null;
      const exitPolicy = !researchExitAlert && policyExitPressure ? { ...policyEffect, applied: 'exit' } : null;
      const optionsSnapshot = () => Object.fromEntries(positions);
      const handledSymbols = new Set();

      // --- spread groups are opened together, so they close together (one mleg) ----
      const spreadGroups = new Map();
      for (const position of positions.values()) {
        if (position.assetClass === 'us_option' && position.groupId) {
          const key = String(position.groupId);
          if (!spreadGroups.has(key)) spreadGroups.set(key, []);
          spreadGroups.get(key).push(position);
        }
      }
      for (const [groupId, legs] of spreadGroups) {
        if (legs.length < 2) continue;
        legs.forEach((leg) => handledSymbols.add(leg.symbol));
        if (cycleBudgetLeft() <= 0) {
          skip(legs[0].option?.underlying ?? legs[0].symbol, 'max_orders_per_cycle');
          continue;
        }
        const marked = [];
        let markFailed = false;
        for (const leg of legs) {
          const quote = await contractQuote({
            symbol: leg.symbol,
            expiration: leg.option?.expiration,
            dte: leg.option?.dte,
            closePriceUsd: null,
          });
          if (!quote) {
            markFailed = true;
            break;
          }
          marked.push({ leg, quote });
        }
        if (markFailed) {
          deny('DATA_MISSING', `no option marks for spread group ${groupId}`);
          continue;
        }
        const contracts = Math.max(1, Math.trunc(Math.min(...legs.map((leg) => Math.abs(leg.qtySigned)))));
        const openValue = round2(legs.reduce((sum, leg) => sum + leg.qtySigned * leg.avgPriceUsd * OPTION_MULTIPLIER, 0));
        const currentValue = round2(marked.reduce((sum, entry) => sum + entry.leg.qtySigned * entry.quote.mark * OPTION_MULTIPLIER, 0));
        const pnlUsd = round2(currentValue - openValue);
        const dte = Math.min(...legs.map((leg) => numberOrNull(leg.option?.dte) ?? daysToExpiration(leg.option?.expiration, atMs) ?? 999));
        const strikes = legs.map((leg) => numberOrNull(leg.option?.strikeUsd)).filter((value) => value !== null);
        const widthUsd = strikes.length >= 2
          ? round2(Math.abs(Math.max(...strikes) - Math.min(...strikes)) * OPTION_MULTIPLIER * contracts)
          : 0;
        const maxRiskUsd = round2(openValue > 0 ? openValue : Math.max(1, widthUsd + openValue));
        const groupUnderlying = legs[0].option?.underlying ?? parseOccSymbol(legs[0].symbol)?.underlying ?? legs[0].symbol;
        const groupExitParams = exitParamsFor(groupUnderlying);
        let exitReason = null;
        let legResearch = null;
        let legPolicy = null;
        if (researchExitAlert) {
          exitReason = 'research_alert';
          legResearch = exitResearch;
        } else if (policyExitPressure) {
          exitReason = 'agent_exit_pressure';
          legPolicy = exitPolicy;
        } else if (dte <= autoCloseDTE) {
          exitReason = 'dte_auto_close';
        } else if (maxRiskUsd > 0 && pnlUsd >= groupExitParams.targetPct * maxRiskUsd) {
          exitReason = 'target';
        } else if (maxRiskUsd > 0 && pnlUsd <= -groupExitParams.stopPct * maxRiskUsd) {
          exitReason = 'stop';
        }
        if (!exitReason) {
          result.actions.push({
            type: 'hold',
            symbol: groupUnderlying,
            reason: 'spread_within_bounds',
            groupId,
            structure: legs[0].structure ?? null,
            pnlUsd,
            dte,
          });
          continue;
        }
        const closeLegs = marked.map(({ leg, quote }) => {
          const side = leg.qtySigned > 0 ? 'sell' : 'buy';
          const price = side === 'sell' ? quote.bid : quote.ask;
          return {
            contract: { symbol: leg.symbol },
            quote,
            side,
            positionIntent: side === 'sell' ? 'sell_to_close' : 'buy_to_close',
            ratioQty: 1,
            cashPerShare: side === 'sell' ? price : -price,
          };
        });
        const netCashPerSpread = closeLegs.reduce((sum, leg) => sum + leg.cashPerShare, 0);
        await submitChecked({
          symbol: groupUnderlying,
          underlying: groupUnderlying,
          side: netCashPerSpread >= 0 ? 'sell' : 'buy',
          qty: contracts,
          priceUsd: Math.max(0.01, round2(Math.abs(netCashPerSpread))),
          reason: exitReason,
          kind: 'exit',
          quote: null,
          assetClass: 'us_option',
          option: {
            underlying: groupUnderlying,
            expiration: legs[0].option?.expiration ?? null,
            type: legs[0].option?.type ?? 'call',
            strikeUsd: legs[0].option?.strikeUsd ?? null,
            dte,
            multiplier: OPTION_MULTIPLIER,
          },
          structure: legs[0].structure ?? null,
          groupId,
          legs: closeLegs,
          orderClass: 'mleg',
          limitPrice: Math.max(0.01, round2(Math.abs(netCashPerSpread))),
          closing: true,
          marginRequiredUsd: 0,
          research: legResearch,
          policy: legPolicy,
          orderSpec: groupExitParams.activeSpec,
        });
      }

      // --- single stock/option positions -----------------------------------------
      for (const [positionSymbol, position] of [...positions.entries()]) {
        if (handledSymbols.has(positionSymbol)) continue;
        if (cycleBudgetLeft() <= 0) {
          skip(positionSymbol, 'max_orders_per_cycle');
          continue;
        }
        const isOption = position.assetClass === 'us_option';
        const underlying = position.option?.underlying
          ?? parseOccSymbol(positionSymbol)?.underlying
          ?? positionSymbol;
        const { stopPct, targetPct, maxHoldBars, activeSpec: positionSpec } = exitParamsFor(underlying);
        const signal = await getSignalFor(underlying, positionSpec);
        let mark = null;
        let bid = null;
        let ask = null;
        let dte = null;
        let stockQuote = null;
        if (isOption) {
          const quote = await contractQuote({
            symbol: positionSymbol,
            expiration: position.option?.expiration,
            dte: position.option?.dte,
            closePriceUsd: null,
          });
          if (!quote) {
            deny('DATA_MISSING', `no option quote for held position ${positionSymbol}`);
            continue;
          }
          mark = quote.mark;
          bid = quote.bid;
          ask = quote.ask;
          dte = numberOrNull(quote.dte) ?? daysToExpiration(position.option?.expiration, atMs);
        } else {
          stockQuote = await getQuote(underlying);
          if (!stockQuote) {
            deny('DATA_MISSING', `no quote for held position ${underlying}`);
            continue;
          }
          mark = stockQuote.last;
          bid = stockQuote.bid ?? stockQuote.last;
          ask = stockQuote.ask ?? stockQuote.last;
        }
        const openedAtMs = timestampOf(position.openedAt);
        const barsHeld = openedAtMs === null ? 0 : Math.floor((atMs - openedAtMs) / barMs);
        const isLong = position.qtySigned > 0;
        let exitReason = null;
        let positionResearch = null;
        let positionPolicy = null;
        if (researchExitAlert) {
          exitReason = 'research_alert';
          positionResearch = exitResearch;
        } else if (policyExitPressure) {
          exitReason = 'agent_exit_pressure';
          positionPolicy = exitPolicy;
        } else if (isOption && isLong) {
          if (dte !== null && dte <= autoCloseDTE) exitReason = 'dte_auto_close';
          else if (position.avgPriceUsd > 0 && mark <= position.avgPriceUsd * (1 - stopPct)) exitReason = 'stop';
          else if (position.avgPriceUsd > 0 && mark >= position.avgPriceUsd * (1 + targetPct)) exitReason = 'target';
        } else if (isOption && !isLong) {
          if (dte !== null && dte <= autoCloseDTE) exitReason = 'dte_auto_close';
          else if (position.avgPriceUsd > 0 && mark <= position.avgPriceUsd * 0.5) exitReason = 'covered_call_profit';
          else if (position.avgPriceUsd > 0 && mark >= position.avgPriceUsd * (1 + stopPct * 2)) exitReason = 'stop';
        } else if (!isOption && isLong) {
          if (position.avgPriceUsd > 0 && mark <= position.avgPriceUsd * (1 - stopPct)) exitReason = 'stop';
          else if (position.avgPriceUsd > 0 && mark >= position.avgPriceUsd * (1 + targetPct)) exitReason = 'target';
          else if (barsHeld >= maxHoldBars) exitReason = 'max_hold';
          else if (signal.longExit) exitReason = 'signal';
        } else if (!isOption && !isLong) {
          if (position.avgPriceUsd > 0 && mark >= position.avgPriceUsd * (1 + stopPct)) exitReason = 'stop';
          else if (position.avgPriceUsd > 0 && mark <= position.avgPriceUsd * (1 - targetPct)) exitReason = 'target';
          else if (barsHeld >= maxHoldBars) exitReason = 'max_hold';
          else if (signal.shortExit) exitReason = 'signal';
        }
        if (!exitReason) {
          result.actions.push({
            type: 'hold',
            symbol: underlying,
            reason: isOption ? `option_mark ${round2(mark)}` : signal.reason ?? 'within_bounds',
            barsHeld,
            z: signal.z,
            dte: isOption ? dte : undefined,
            groupId: position.groupId ?? null,
          });
          continue;
        }
        if (isOption) {
          const side = isLong ? 'sell' : 'buy';
          await submitChecked({
            symbol: positionSymbol,
            underlying,
            side,
            qty: Math.abs(position.qtySigned),
            priceUsd: round4(isLong ? bid : ask),
            reason: exitReason,
            kind: 'exit',
            quote: { symbol: underlying, bid, ask, last: mark, ts: atMs },
            assetClass: 'us_option',
            asset: await getAssetInfo(underlying),
            option: {
              underlying,
              expiration: position.option?.expiration ?? null,
              type: position.option?.type ?? (parseOccSymbol(positionSymbol)?.type ?? 'call'),
              strikeUsd: position.option?.strikeUsd ?? parseOccSymbol(positionSymbol)?.strikeUsd ?? null,
              dte,
              multiplier: OPTION_MULTIPLIER,
            },
            structure: position.structure ?? null,
            groupId: position.groupId ?? null,
            orderClass: 'simple',
            limitPrice: round4(isLong ? bid : ask),
            orderType: 'limit',
            positionIntent: isLong ? 'sell_to_close' : 'buy_to_close',
            closing: true,
            marginRequiredUsd: 0,
            research: positionResearch,
            policy: positionPolicy,
            orderSpec: positionSpec,
          });
        } else {
          const side = isLong ? 'sell' : 'buy';
          const exitPrice = isLong ? bid : ask;
          await submitChecked({
            symbol: underlying,
            side,
            qty: Math.abs(position.qtySigned),
            priceUsd: round4(exitPrice),
            reason: exitReason,
            kind: 'exit',
            quote: stockQuote,
            asset: !isLong ? await getAssetInfo(underlying) : null,
            positionsSnapshot: optionsSnapshot(),
            closing: true,
            research: positionResearch,
            policy: positionPolicy,
            orderSpec: positionSpec,
          });
        }
      }

      // =========================================================================
      // 2) ENTRIES (multi-instrument: stock, short stock, options, spreads)
      // =========================================================================
      // Risk-only passes (non-due swing bots with open positions) stop here: exits above are
      // evaluated every cycle for safety, but no new position is opened outside the bot's cadence.
      if (riskOnly) {
        result.actions.push({
          type: 'risk_only',
          symbol: String(spec.symbol ?? '').toUpperCase(),
          reason: 'exit_pass_only',
        });
        return result;
      }
      // v3.2: iterate the basket (or the single legacy spec) — one order per symbol/run.
      // Underlyings already held count toward the tier position cap (a spread counts once,
      // by its underlying). Held symbols are skipped for entries (the exit pass owns them).
      const entryUniverse = entrySpecs.length > 0 ? entrySpecs : [];
      const heldUnderlyings = new Set(
        [...positions.values()].map((position) => String(position.option?.underlying ?? position.symbol).toUpperCase()),
      );
      for (const entrySpec of entryUniverse) {
        const symbol = String(entrySpec.symbol ?? '').toUpperCase();
        if (!symbol) continue;
        const openOrderForSymbol = openOrders.some((order) => {
          const orderSymbol = String(order?.symbol ?? '').toUpperCase();
          if (orderSymbol === symbol) return true;
          const parsed = parseOccSymbol(orderSymbol);
          return Boolean(parsed && parsed.underlying === symbol);
        });
        // A long stock book can still sell covered calls against its shares (an entry order).
        const heldUnderlying = positions.get(symbol);
        const heldShares = heldUnderlying && heldUnderlying.assetClass === 'us_equity' && heldUnderlying.qtySigned > 0
          ? heldUnderlying.qtySigned
          : 0;
        const coverEligible = instrumentsEnabled
          && mandatePermissions.coveredCalls === true
          && heldShares >= OPTION_MULTIPLIER;
        if (heldUnderlyings.has(symbol) && !coverEligible) {
          if (!result.actions.some((action) => action.symbol === symbol)) {
            result.actions.push({ type: 'hold', symbol, reason: 'in_position' });
          }
          continue;
        }
        if (openOrderForSymbol) {
          result.actions.push({ type: 'hold', symbol, reason: 'open_order_pending' });
          continue;
        }
        if (runOrderedUnderlyings.has(symbol)) {
          // One order per symbol per run: an exited symbol is not re-entered in the same cycle.
          result.actions.push({ type: 'hold', symbol, reason: 'ordered_this_run' });
          continue;
        }
        if (cycleBudgetLeft() <= 0) {
          skip(symbol, 'max_orders_per_cycle');
          break; // the order cap is shared by exits + entries for the whole run
        }
        if (entriesBlocked) {
          skip(symbol, `entries_blocked:${entriesBlockedReason}`);
          continue;
        }
        if (allowedSymbols && !allowedSymbols.includes(symbol)) {
          deny('INSTRUMENT_FORBIDDEN', `symbol ${symbol} is outside the mandate allowlist`, { symbol });
          skip(symbol, 'symbol_not_in_mandate');
          continue;
        }
        if (!coverEligible && heldUnderlyings.size >= maxOpenPositions) {
          skip(symbol, 'max_open_positions', {
            maxOpenPositions,
            openPositions: heldUnderlyings.size,
          });
          continue;
        }
        const quote = await getQuote(symbol);
        if (!quote) {
          deny('DATA_MISSING', `no quote for ${symbol}`);
          continue;
        }
        const signal = await getSignalFor(symbol, entrySpec);
        const wantLong = signal.longEntry === true || signal.enter === true;
        const wantShort = signal.shortEntry === true && mandatePermissions.shortStock === true;
        const coveredCallOnly = coverEligible; // shares already held: only sell calls against them
        if (!coveredCallOnly && !wantLong && !wantShort) {
          result.actions.push({
            type: 'hold',
            symbol,
            reason: signal.reason ?? 'no_signal',
            z: signal.z,
            specId: entrySpec.specId ?? null,
          });
          continue;
        }
        if (policyStandDown) {
          // The bot's own brain said stand down: no new exposure. This is a stance
          // skip, not a brake denial; the exit pass above still ran for held positions.
          result.actions.push({
            type: 'skip',
            symbol,
            reason: 'agent_stand_down',
            policy: { stance: policyState.stance },
          });
          continue;
        }
        if (researchVeto) {
          // The isolated analyst vetoed the entry that the signal would otherwise take.
          // This is an advisory skip, not a brake denial: no order ever reaches the wall.
          result.actions.push({
            type: 'skip',
            symbol,
            reason: 'research_veto',
            research: { ...researchEffect, applied: 'veto' },
          });
          continue;
        }
        const direction = wantLong ? 'bullish' : wantShort ? 'bearish' : 'neutral';
        const structures = coveredCallOnly ? ['covered_call'] : candidateStructures(entrySpec.family, direction);
        let placed = false;
        let lastSkipReason = 'no_instrument_available';
        let lastBlocked = null;
        for (const structure of structures) {
          if (cycleBudgetLeft() <= 0) break;
          if (!structureAllowed(structure, mandatePermissions)) {
            lastSkipReason = 'instrument_not_permitted';
            continue;
          }
          if (structure === 'long_stock') {
            if (instrumentsEnabled && !mandatePermissions.longStock) continue;
            placed = await enterLongStockEntry({
              symbol,
              quote,
              signal,
              reason: signal.reason ?? 'signal',
              activeSpec: entrySpec,
            });
            break;
          }
          if (structure === 'short_stock') {
            placed = await enterShortStockEntry({ symbol, quote, signal, activeSpec: entrySpec });
            break;
          }
          const plan = await buildOptionPlan({ structure, family: entrySpec.family, underlying: symbol, direction });
          if (!plan) {
            lastSkipReason = 'option_plan_unavailable';
            continue;
          }
          if (plan.blocked === 'covered_call_requires_100_shares') {
            lastBlocked = 'covered_call_requires_100_shares';
            lastSkipReason = lastBlocked;
            result.actions.push({
              type: 'skip',
              symbol,
              reason: 'covered_call_requires_100_shares',
              structure,
            });
            continue;
          }
          placed = await enterOptionEntry({ plan, quote, signal, direction, activeSpec: entrySpec });
          break;
        }
        if (placed) {
          heldUnderlyings.add(symbol);
        } else if (!result.actions.some((action) => action.type === 'skip' && action.symbol === symbol)) {
          skip(symbol, lastBlocked ?? lastSkipReason);
        }
      }
      if (entryUniverse.length === 0) {
        skip(String(spec.symbol ?? '').toUpperCase(), 'no_proven_specs');
      }

      return result;
    },

    describe() {
      return {
        role: 'executor',
        maxOrdersPerCycle,
        minOrderNotionalUsd,
        maxOrderNotionalUsd: hardMaxNotionalUsd,
        maxOrderPctOfEquity,
        timeframe: defaultTimeframe,
        readsAccountEquity: false,
        portfolio: {
          supported: true,
          maxOpenPositionsFallback: Number.isFinite(risk.maxOpenPositions) ? risk.maxOpenPositions : Infinity,
          maxOrdersPerCycleFallback: maxOrdersPerCycle,
          perSymbolSpecs: true,
        },
        research: {
          enabled: researchConfig.enabled === true,
          influence: researchConfig.influence === true,
          influenceActive: researchInfluenceEnabled,
          maxAgeSec: Number.isFinite(Number(researchConfig.maxAgeSec)) ? Number(researchConfig.maxAgeSec) : null,
        },
        agents: {
          enabled: agentsEnabled,
          policyActive: agentsEnabled,
          maxAgeSec: Number.isFinite(Number(agentsConfig.maxAgeSec)) ? Number(agentsConfig.maxAgeSec) : 7200,
          effects: ['stand_down', 'size_multiplier', 'exit_pressure'],
        },
        instruments: {
          enabled: instrumentsEnabled,
          margin: globalPermissions.margin === true,
          shortStock: globalPermissions.shortStock === true,
          options: globalPermissions.longOptions === true,
          coveredCalls: globalPermissions.coveredCalls === true,
          spreads: globalPermissions.spreads === true,
          allowedStructures: [...(globalPermissions.allowedStructures ?? [])],
          minDTE,
          maxDTE,
          autoCloseDTE,
          maxContracts: configMaxContracts,
          maxOptionPremiumUsd: configMaxOptionPremiumUsd,
          maxOptionPremiumPctEquity,
          maxShortNotionalUsd,
          optionDataFeed,
        },
      };
    },
  };
}

export default createExecutor;

