/**
 * ledger.js — the per-agent virtual USD ledger (v3.0 multi-instrument).
 *
 * Generic signed positions keyed by symbol (stock ticker or OCC option symbol):
 *   - stocks:  signed qty; selling beyond the long opens/increases a short, buying covers.
 *   - options: integer contracts, multiplier 100; buy = debit, sell = credit; selling
 *              beyond the long opens a short option position (the BRAKES wall decides
 *              whether that is a legal covered call / spread leg or a naked short).
 *   - margin:  cash may go negative only while margin is enabled AND the resulting debt
 *              stays within `instruments.maxMarginPctEquity * equity`; otherwise the fill
 *              is refused with MARGIN_LIMIT. Everything else (charge/transfer/pool) keeps
 *              the strict no-negative-cash invariant.
 *
 * Money enters only through `grant` (genesis), `credit` (one-time capital top-up) and
 * `transfer` (internal moves); `charge` removes costs.
 *
 * v3.3 fair P&L (docs/FAIR-PNL-REWARDS.md §2-§3): every record tracks the CAPITAL
 * CONTRIBUTED separately from equity, so reward payouts are capital, never trading profit:
 *   - `capitalContributionsUsd`: base endowment + top-ups + credits + treasury transfers in,
 *     minus capital withdrawals (treasury transfers out);
 *   - `rewardCapitalUsd`: the subset that came from reward payouts;
 *   - `capitalVersion`: 2 once v3.3 accounting is active (1 = legacy fallback on load);
 *   - `capitalPendingUsd`: internal aid — declared endowment not yet funded by cash, so the
 *     ensureAgent(endowment) + grant(endowment) genesis pair counts the basis once, not twice.
 * Trading P&L is `equity − capitalContributionsUsd`; fills and costs never touch capital.
 *
 * Persistence is backward compatible: legacy positions {qty, avgPriceUsd, openedAt} are
 * normalised on load (and OCC symbols are recognised as options), and legacy records get
 * `capitalContributionsUsd = declaredEndowmentUsd + creditsUsd`, reward 0, version 1.
 *
 * Owned by mortality-core. Contract: docs/INSTRUMENTS.md + docs/CONTRACTS.md +
 * docs/FAIR-PNL-REWARDS.md §3.
 */

import path from 'node:path';
import { AutomatonError, fail } from './contracts.js';
import { DAY_MS, readJsonSync, round2, round4, round8, SYSTEM_CLOCK, writeJsonAtomicSync } from './util.js';
import { statePaths } from './config.js';

/** Reserved synthetic account that holds unallocated treasury cash. */
export const TREASURY_ID = '__treasury__';

/** Standard US equity-option contract multiplier. */
export const OPTION_MULTIPLIER = 100;

/** Stable local error code for a fill that would exceed the margin budget. */
export const MARGIN_LIMIT = 'MARGIN_LIMIT';

const NET7D_MS = 7 * 24 * 60 * 60 * 1000;
const EPSILON = 1e-9;
const OCC_PATTERN = /^([A-Z][A-Z0-9]{0,5})(\d{6})([CP])(\d{8})$/;

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => (value === undefined ? undefined : structuredClone(value));

// ---------------------------------------------------------------------------
// instrument helpers (exported: brakes/treasurer/tests reuse them)
// ---------------------------------------------------------------------------

/** True when `symbol` looks like an OCC option contract symbol (e.g. AAPL260116C00150000). */
export function isOccOptionSymbol(symbol) {
  return typeof symbol === 'string' && OCC_PATTERN.test(symbol.toUpperCase());
}

/**
 * Parse an OCC option symbol into its contract metadata.
 * @param {string} symbol
 * @returns {{ underlying: string, expiration: string, type: 'call'|'put',
 *   strikeUsd: number, multiplier: number, symbol: string }|null}
 */
export function parseOccSymbol(symbol) {
  if (typeof symbol !== 'string') return null;
  const match = OCC_PATTERN.exec(symbol.toUpperCase());
  if (!match) return null;
  const [, root, yymmdd, cp, strikeDigits] = match;
  const year = 2000 + Number(yymmdd.slice(0, 2));
  const month = Number(yymmdd.slice(2, 4));
  const day = Number(yymmdd.slice(4, 6));
  const stamp = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(stamp) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return {
    symbol: symbol.toUpperCase(),
    underlying: root,
    expiration: new Date(stamp).toISOString().slice(0, 10),
    type: cp === 'C' ? 'call' : 'put',
    strikeUsd: round4(Number(strikeDigits) / 1000),
    multiplier: OPTION_MULTIPLIER,
  };
}

/** 'us_equity' | 'us_option' from an assetClass hint + symbol (OCC symbols are options). */
export function normaliseAssetClass(assetClass, symbol) {
  const raw = String(assetClass ?? '').trim().toLowerCase();
  if (['option', 'options', 'us_option', 'option_contract', 'us_option_contract'].includes(raw)) {
    return 'us_option';
  }
  if (raw !== '' && !['equity', 'stock', 'us_equity', 'us_stock'].includes(raw)) {
    // Unknown classes are treated as equity here; the BRAKES D2 gate refuses them.
    return 'us_equity';
  }
  return isOccOptionSymbol(symbol) ? 'us_option' : 'us_equity';
}

/**
 * Calendar-day distance to an option expiration date, standard date-based DTE.
 * @param {string} expiration ISO date ('YYYY-MM-DD') or ISO timestamp
 * @param {number} nowMs
 * @returns {number|null}
 */
export function optionDaysToExpiry(expiration, nowMs) {
  const ms = typeof expiration === 'number' ? expiration : Date.parse(String(expiration ?? ''));
  if (!Number.isFinite(ms)) return null;
  const nowValue = Number(nowMs);
  if (!Number.isFinite(nowValue)) return null;
  const expiry = new Date(ms);
  const now = new Date(nowValue);
  const expiryDay = Date.UTC(expiry.getUTCFullYear(), expiry.getUTCMonth(), expiry.getUTCDate());
  const nowDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.round((expiryDay - nowDay) / DAY_MS));
}

function positiveOrInfinity(value, fallback = Infinity) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeAt(at, clock) {
  if (typeof at === 'number' && Number.isFinite(at)) return at;
  if (typeof at === 'string') {
    const ms = Date.parse(at);
    if (Number.isFinite(ms)) return ms;
  }
  return clock.now();
}

function priceLookup(prices, symbol) {
  if (!prices) return undefined;
  if (typeof prices.get === 'function') return prices.get(symbol);
  return prices[symbol];
}

/**
 * True when a contribution is a reward payout: category 'reward' or a /reward/i reason
 * (the rewards scheduler pays `{reason:'reward:<periodKey>', category:'reward'}`).
 * @param {string|null|undefined} category
 * @param {string|null|undefined} reason
 * @returns {boolean}
 */
function isRewardContribution(category, reason) {
  return String(category ?? '').toLowerCase() === 'reward' || /reward/i.test(String(reason ?? ''));
}

/**
 * @param {{ paths?: object, config?: object, clock?: object }} [options]
 */
export function createLedger({ paths, config, clock } = {}) {
  if (!paths?.ledger && !config) {
    throw new AutomatonError('CONFIG_INVALID', 'createLedger requires { paths } or { config }', {});
  }
  const resolved = { ...(config ? statePaths(config) : {}), ...(paths ?? {}) };
  if (!resolved.ledger) {
    throw new AutomatonError('CONFIG_INVALID', 'ledger path is required', {});
  }
  const ledgerPath = path.resolve(resolved.ledger);
  const currentClock = clock ?? SYSTEM_CLOCK;
  const instruments = config?.instruments ?? {};
  const allowMargin = instruments.allowMargin === true;
  const maxMarginPctEquity = Number.isFinite(Number(instruments.maxMarginPctEquity))
    ? Number(instruments.maxMarginPctEquity)
    : 1;

  /** @type {{ version: number, anchored: boolean, anchoredAt: string|null, agents: Record<string, object> }} */
  let state = emptyState();

  function emptyState() {
    return { version: 3, anchored: false, anchoredAt: null, agents: {} };
  }

  function newRecord(agentId, { endowmentUsd = 0, at } = {}) {
    const atIso = new Date(normalizeAt(at, currentClock)).toISOString();
    const declaredEndowmentUsd = round2(Math.max(0, Number(endowmentUsd) || 0));
    return {
      agentId,
      cashUsd: 0,
      positions: {},
      realizedPlUsd: 0,
      costsUsd: 0,
      costsByRole: {},
      grossSpendUsd: 0,
      grossRevenueUsd: 0,
      creditsUsd: 0,
      trades: 0,
      firstProfitAt: null,
      declaredEndowmentUsd,
      // v3.3 fair capital accounting (docs/FAIR-PNL-REWARDS.md §3). A new/empty record is
      // created capital-aware (version 2) with the declared endowment as its capital basis;
      // `capitalPendingUsd` tracks that declared basis until the genesis grant/credit funds it,
      // so ensureAgent(endowment) + grant(endowment) counts the same $ basis once.
      capitalContributionsUsd: declaredEndowmentUsd,
      rewardCapitalUsd: 0,
      capitalVersion: 2,
      capitalPendingUsd: declaredEndowmentUsd,
      startedAt: atIso,
      fills: [],
      events: [{ atMs: Date.parse(atIso), kind: 'endowment-declared', amountUsd: declaredEndowmentUsd }],
      markPrices: {},
      lastUnrealizedUsd: 0,
      lastMarginDebtUsd: 0,
      lastGrossExposureUsd: 0,
      lastNetExposureUsd: 0,
      updatedAt: atIso,
    };
  }

  /** Normalise an option metadata object; OCC symbol data fills any gaps. */
  function buildOptionMetadata(fill, symbol, prior) {
    const source = isPlainObject(fill.option) ? fill.option : {};
    const parsed = parseOccSymbol(symbol) ?? {};
    const underlyingRaw = source.underlying ?? source.root ?? parsed.underlying ?? prior?.option?.underlying ?? null;
    const underlying = underlyingRaw === null || underlyingRaw === undefined ? null : String(underlyingRaw).toUpperCase();
    const expiration = source.expiration ?? source.expirationDate ?? parsed.expiration ?? prior?.option?.expiration ?? null;
    const typeRaw = String(source.type ?? source.right ?? parsed.type ?? prior?.option?.type ?? '').toLowerCase();
    const type = typeRaw === 'c' ? 'call' : typeRaw === 'p' ? 'put' : typeRaw;
    const strikeUsdRaw = source.strikeUsd ?? source.strike ?? parsed.strikeUsd ?? prior?.option?.strikeUsd;
    const strikeUsd = Number(strikeUsdRaw);
    const multiplierRaw = Number(source.multiplier ?? fill.multiplier ?? parsed.multiplier ?? prior?.option?.multiplier ?? OPTION_MULTIPLIER);
    const multiplier = Number.isFinite(multiplierRaw) && multiplierRaw > 0 ? multiplierRaw : OPTION_MULTIPLIER;
    const groupId = fill.groupId ?? source.groupId ?? prior?.option?.groupId ?? prior?.groupId ?? null;
    const structure = fill.structure ?? source.structure ?? prior?.option?.structure ?? prior?.structure ?? null;
    if (underlying === null || underlying === '') {
      fail('CONFIG_INVALID', 'option fills require the underlying symbol', { symbol, assetClass: 'us_option' });
    }
    if (!['call', 'put'].includes(type)) {
      fail('CONFIG_INVALID', 'option fills require option.type "call" or "put"', { symbol, type: typeRaw });
    }
    if (!Number.isFinite(strikeUsd) || strikeUsd <= 0) {
      fail('CONFIG_INVALID', 'option fills require a positive strikeUsd', { symbol, strikeUsd: strikeUsdRaw });
    }
    if (typeof expiration !== 'string' || !Number.isFinite(Date.parse(expiration))) {
      fail('CONFIG_INVALID', 'option fills require an expiration date', { symbol, expiration });
    }
    return {
      underlying,
      expiration: new Date(Date.parse(expiration)).toISOString().slice(0, 10),
      type,
      strikeUsd: round4(strikeUsd),
      multiplier,
      groupId: groupId ?? null,
      structure: structure ?? null,
    };
  }

  function normalisePosition(symbol, raw) {
    const sym = String(symbol ?? '').toUpperCase();
    const assetClass = normaliseAssetClass(raw?.assetClass, sym);
    const isOption = assetClass === 'us_option';
    const parsed = isOption ? parseOccSymbol(sym) : null;
    const multiplier = isOption
      ? positiveOrInfinity(raw?.multiplier ?? raw?.option?.multiplier ?? parsed?.multiplier, OPTION_MULTIPLIER)
      : 1;
    let option = null;
    if (isOption) {
      const base = raw?.option && isPlainObject(raw.option) ? raw.option : {};
      option = {
        underlying: String(base.underlying ?? base.root ?? parsed?.underlying ?? '').toUpperCase() || null,
        expiration: base.expiration ?? parsed?.expiration ?? null,
        type: String(base.type ?? base.right ?? parsed?.type ?? '').toLowerCase() || null,
        strikeUsd: Number(base.strikeUsd ?? base.strike ?? parsed?.strikeUsd ?? 0) || null,
        multiplier,
        groupId: base.groupId ?? raw?.groupId ?? null,
        structure: base.structure ?? raw?.structure ?? null,
      };
    }
    return {
      symbol: sym,
      assetClass,
      qty: Number(raw?.qty ?? raw?.qtySigned ?? 0) || 0,
      avgPriceUsd: round4(Number(raw?.avgPriceUsd ?? raw?.avgEntryPriceUsd ?? 0) || 0),
      openedAt: typeof raw?.openedAt === 'string' ? raw.openedAt : null,
      multiplier,
      option,
      groupId: raw?.groupId ?? option?.groupId ?? null,
      structure: raw?.structure ?? option?.structure ?? null,
    };
  }

  function normaliseRecord(raw) {
    const atIso = typeof raw?.startedAt === 'string' ? raw.startedAt : currentClock.iso();
    const record = {
      ...newRecord(raw?.agentId, { endowmentUsd: raw?.declaredEndowmentUsd ?? 0, at: atIso }),
      ...raw,
    };
    const positions = isPlainObject(record.positions) ? record.positions : {};
    record.positions = {};
    for (const [symbol, position] of Object.entries(positions)) {
      const normalised = normalisePosition(symbol, position);
      if (normalised.qty === 0) continue;
      normalised.openedAt = normalised.openedAt ?? atIso;
      record.positions[normalised.symbol] = normalised;
    }
    // Sub-cent precision matters here: the metabolism charges fractions of a cent per
    // role per cycle, and rounding the accumulator at 2dp on every reload silently
    // changes the configured burn rate (measured: +14% on short runs).
    record.cashUsd = round8(Number(record.cashUsd) || 0);
    record.realizedPlUsd = round8(Number(record.realizedPlUsd) || 0);
    record.costsUsd = round8(Number(record.costsUsd) || 0);
    record.costsByRole = isPlainObject(record.costsByRole) ? record.costsByRole : {};
    for (const [role, value] of Object.entries(record.costsByRole)) {
      record.costsByRole[role] = round8(Number(value) || 0);
    }
    record.grossSpendUsd = round8(Number(record.grossSpendUsd) || 0);
    record.grossRevenueUsd = round8(Number(record.grossRevenueUsd) || 0);
    record.creditsUsd = round8(Number(record.creditsUsd) || 0);
    record.trades = Number(record.trades) || 0;
    record.fills = Array.isArray(record.fills) ? record.fills : [];
    record.events = Array.isArray(record.events) ? record.events : [];
    record.markPrices = isPlainObject(record.markPrices) ? record.markPrices : {};
    record.declaredEndowmentUsd = round2(Number(record.declaredEndowmentUsd) || 0);
    record.lastMarginDebtUsd = round2(Number(record.lastMarginDebtUsd) || 0);
    record.lastGrossExposureUsd = round2(Number(record.lastGrossExposureUsd) || 0);
    record.lastNetExposureUsd = round2(Number(record.lastNetExposureUsd) || 0);
    normaliseCapital(record, raw);
    return record;
  }

  /**
   * Normalise the v3.3 capital fields (docs/FAIR-PNL-REWARDS.md §3).
   *
   * Legacy records (no capital fields) get the documented fallback:
   *   capitalContributionsUsd = declaredEndowmentUsd + creditsUsd, rewardCapitalUsd = 0,
   *   capitalVersion = 1, capitalPendingUsd = 0.
   * Records already carrying the fields (v3.3 saves) keep them, clamped to finite/≥0/round2;
   * `capitalPendingUsd` is only the internal declared-basis funding aid and defaults to 0, so
   * migrated records never swallow a later grant.
   */
  function normaliseCapital(record, raw) {
    const hasCapitalFields = isPlainObject(raw) && (
      Object.prototype.hasOwnProperty.call(raw, 'capitalContributionsUsd')
      || Object.prototype.hasOwnProperty.call(raw, 'rewardCapitalUsd')
      || Object.prototype.hasOwnProperty.call(raw, 'capitalVersion')
    );
    if (!hasCapitalFields) {
      record.capitalContributionsUsd = round2(record.declaredEndowmentUsd + record.creditsUsd);
      record.rewardCapitalUsd = 0;
      record.capitalVersion = 1;
      record.capitalPendingUsd = 0;
      return;
    }
    record.capitalContributionsUsd = round2(Math.max(0, Number(record.capitalContributionsUsd) || 0));
    record.rewardCapitalUsd = round2(Math.min(
      record.capitalContributionsUsd,
      Math.max(0, Number(record.rewardCapitalUsd) || 0),
    ));
    record.capitalVersion = Number(record.capitalVersion) >= 2 ? 2 : 1;
    record.capitalPendingUsd = round2(Math.max(0, Number(record.capitalPendingUsd) || 0));
    record.capitalPendingUsd = Math.min(record.capitalPendingUsd, record.declaredEndowmentUsd);
  }

  function pruneEvents(record) {
    const cutoff = currentClock.now() - NET7D_MS;
    record.events = record.events.filter((event) => Number(event?.atMs) >= cutoff);
    if (record.fills.length > 5000) record.fills = record.fills.slice(-5000);
  }

  function requireRecord(agentId) {
    if (typeof agentId !== 'string' || agentId === '') {
      fail('CONFIG_INVALID', 'agentId must be a non-empty string', { agentId });
    }
    const record = state.agents[agentId];
    if (!record) fail('UNKNOWN_AGENT', `unknown ledger agent "${agentId}"`, { agentId });
    return record;
  }

  function ensureRecord(agentId, options = {}) {
    const existing = state.agents[agentId];
    if (existing) return existing;
    const record = newRecord(agentId, options);
    state.agents[agentId] = record;
    return record;
  }

  /** Create the ledger record for an agent with cashUsd = 0. Returns a copy. */
  function ensureAgent(agentId, { endowmentUsd = 0, at } = {}) {
    if (typeof agentId !== 'string' || agentId === '') {
      fail('CONFIG_INVALID', 'ensureAgent(agentId) requires a non-empty string id', { agentId });
    }
    const record = ensureRecord(agentId, { endowmentUsd, at });
    if (Number.isFinite(endowmentUsd) && Number(endowmentUsd) > 0 && record.declaredEndowmentUsd === 0) {
      record.declaredEndowmentUsd = round2(Number(endowmentUsd));
      record.events.push({
        atMs: normalizeAt(at, currentClock),
        kind: 'endowment-declared',
        amountUsd: record.declaredEndowmentUsd,
      });
      // A brand-new/empty record gets the declared endowment as its v3.3 capital basis, held as
      // "pending" until the genesis grant/credit actually funds it (so it is counted once).
      const empty = record.cashUsd === 0
        && Object.keys(record.positions).length === 0
        && record.fills.length === 0
        && round2(Number(record.capitalContributionsUsd) || 0) === 0;
      if (empty) {
        record.capitalContributionsUsd = record.declaredEndowmentUsd;
        record.rewardCapitalUsd = 0;
        record.capitalVersion = 2;
        record.capitalPendingUsd = record.declaredEndowmentUsd;
      }
    }
    return clone(record);
  }

  function get(agentId) {
    return clone(requireRecord(agentId));
  }

  function has(agentId) {
    return typeof agentId === 'string' && Boolean(state.agents[agentId]);
  }

  function ids() {
    return Object.keys(state.agents);
  }

  // -------------------------------------------------------------------------
  // position valuation
  // -------------------------------------------------------------------------

  function markFor(record, symbol, prices, fallbackPrice) {
    const candidate = priceLookup(prices, symbol);
    if (Number.isFinite(Number(candidate)) && Number(candidate) > 0) return Number(candidate);
    if (Number.isFinite(Number(fallbackPrice)) && Number(fallbackPrice) > 0) return Number(fallbackPrice);
    const stored = Number(record.markPrices?.[symbol]);
    if (Number.isFinite(stored) && stored > 0) return stored;
    return null;
  }

  function positionMarketValue(position, mark) {
    const multiplier = Number(position.multiplier) || 1;
    return round2((Number(position.qty) || 0) * (Number(mark) || 0) * multiplier);
  }

  /**
   * Enrich one stored position for the operator/UI: signed qty, side, asset class,
   * option metadata with live DTE, mark and unrealized P&L.
   */
  function viewPosition(record, position) {
    const symbol = position.symbol;
    const mark = markFor(record, symbol, {}, null) ?? (Number(position.avgPriceUsd) || 0);
    const multiplier = Number(position.multiplier) || 1;
    const qty = Number(position.qty) || 0;
    const isOption = position.assetClass === 'us_option';
    const marketValueUsd = positionMarketValue(position, mark);
    const costBasisUsd = round2(qty * (Number(position.avgPriceUsd) || 0) * multiplier);
    const option = isOption && position.option
      ? {
          underlying: position.option.underlying ?? null,
          expiration: position.option.expiration ?? null,
          type: position.option.type ?? null,
          strikeUsd: Number(position.option.strikeUsd) || null,
          multiplier,
          groupId: position.option.groupId ?? position.groupId ?? null,
          structure: position.option.structure ?? position.structure ?? null,
          dte: optionDaysToExpiry(position.option.expiration, currentClock.now()),
        }
      : null;
    return {
      symbol,
      assetClass: position.assetClass ?? 'us_equity',
      qty,
      qtySigned: qty,
      avgPriceUsd: Number(position.avgPriceUsd) || 0,
      lastPriceUsd: mark,
      marketValueUsd,
      unrealizedPlUsd: round2(marketValueUsd - costBasisUsd),
      openedAt: position.openedAt ?? null,
      side: isOption ? String(position.option?.type ?? 'option').toUpperCase() : qty < 0 ? 'SHORT' : 'LONG',
      direction: qty < 0 ? 'SHORT' : 'LONG',
      multiplier,
      groupId: position.groupId ?? position.option?.groupId ?? null,
      structure: position.structure ?? position.option?.structure ?? null,
      option,
      dte: option?.dte ?? null,
    };
  }

  /** Position book handed to the EXECUTOR (never account equity/cash). */
  function book(agentId) {
    const record = requireRecord(agentId);
    const positions = {};
    for (const [symbol, position] of Object.entries(record.positions)) {
      positions[symbol] = viewPosition(record, position);
    }
    return { agentId, positions: clone(positions), openOrders: [] };
  }

  /** Long (positive) share count for an equity symbol; used by covered-call checks. */
  function longSharesOf(agentId, symbol) {
    const record = requireRecord(agentId);
    const position = record.positions[String(symbol ?? '').toUpperCase()];
    if (!position || position.assetClass !== 'us_equity') return 0;
    return Math.max(0, round4(Number(position.qty) || 0));
  }

  /** Signed contract count of an option position (negative = short). */
  function optionContractsOf(agentId, symbol) {
    const record = requireRecord(agentId);
    const position = record.positions[String(symbol ?? '').toUpperCase()];
    if (!position || position.assetClass !== 'us_option') return 0;
    return Number(position.qty) || 0;
  }

  /** True when the agent holds at least `shares` long shares of `symbol`. */
  function hasCoveredShares(agentId, symbol, shares = 100) {
    return longSharesOf(agentId, symbol) + EPSILON >= Number(shares);
  }

  // -------------------------------------------------------------------------
  // fills
  // -------------------------------------------------------------------------

  /**
   * Apply a broker fill to the virtual book.
   *
   * @param {string} agentId
   * @param {{ symbol: string, assetClass?: string, side: 'buy'|'sell', qty: number,
   *   priceUsd: number, multiplier?: number, option?: object|null, groupId?: string|null,
   *   structure?: string|null, orderId?: string|null, at?: number|string }} fill
   * @returns {{ realizedPlUsd: number, position: object|null, cashUsd: number, marginDebtUsd: number }}
   */
  function applyFill(agentId, fill = {}) {
    const record = requireRecord(agentId);
    const symbol = String(fill.symbol ?? '').toUpperCase();
    if (symbol === '') fail('CONFIG_INVALID', 'applyFill requires a symbol', { agentId });
    const direction = String(fill.side ?? '').toLowerCase();
    if (!['buy', 'sell'].includes(direction)) {
      fail('CONFIG_INVALID', 'applyFill side must be "buy" or "sell"', { agentId, side: fill.side });
    }
    const assetClass = normaliseAssetClass(fill.assetClass, symbol);
    const isOption = assetClass === 'us_option';
    const price = round4(Number(fill.priceUsd));
    const rawQty = Number(fill.qty);
    if (!Number.isFinite(rawQty) || rawQty <= 0) {
      fail('CONFIG_INVALID', 'fill qty must be > 0', { agentId, qty: fill.qty });
    }
    if (isOption && Math.abs(rawQty - Math.round(rawQty)) > 1e-6) {
      fail('CONFIG_INVALID', 'option fills must be whole contracts', { agentId, qty: rawQty });
    }
    const quantity = isOption ? Math.round(rawQty) : round4(rawQty);
    if (!(quantity > 0)) fail('CONFIG_INVALID', 'fill qty must be > 0', { agentId, qty: quantity });
    if (!Number.isFinite(price) || price <= 0) {
      fail('CONFIG_INVALID', 'fill priceUsd must be > 0', { agentId, priceUsd: fill.priceUsd });
    }
    const atMs = normalizeAt(fill.at, currentClock);
    const atIso = new Date(atMs).toISOString();

    const prior = record.positions[symbol] ?? null;
    const priorQty = prior ? Number(prior.qty) || 0 : 0;
    const delta = direction === 'buy' ? quantity : -quantity;
    const multiplier = isOption
      ? positiveOrInfinity(fill.multiplier ?? fill.option?.multiplier ?? prior?.multiplier, OPTION_MULTIPLIER)
      : 1;
    const optionMetadata = isOption ? buildOptionMetadata(fill, symbol, prior) : null;
    const notionalUsd = round2(quantity * price * multiplier);

    // Whole-share rule for stock shorts (a fractional long is fine; a fractional short is not).
    const resultingQty = round4(priorQty + delta);
    if (!isOption && resultingQty < 0 && Math.abs(resultingQty - Math.round(resultingQty)) > 1e-6) {
      fail('CONFIG_INVALID', 'short stock positions require whole shares', {
        agentId,
        symbol,
        qty: resultingQty,
      });
    }

    // ---- position math (signed, average cost) -------------------------------
    let newQty;
    let newAvgPriceUsd;
    let realizedPlUsd = 0;
    let openedAt = prior?.openedAt ?? atIso;
    let option = optionMetadata ?? prior?.option ?? null;
    let groupId = fill.groupId ?? fill.option?.groupId ?? prior?.groupId ?? prior?.option?.groupId ?? null;
    let structure = fill.structure ?? fill.option?.structure ?? prior?.structure ?? prior?.option?.structure ?? null;

    if (priorQty === 0 || Math.sign(delta) === Math.sign(priorQty)) {
      // open or add in the same direction: weighted average cost
      const added = Math.abs(delta);
      const held = Math.abs(priorQty);
      const priorAvg = Number(prior?.avgPriceUsd) || price;
      newQty = round4(priorQty + delta);
      newAvgPriceUsd = round4((held * priorAvg + added * price) / (held + added));
      if (priorQty === 0) openedAt = atIso;
    } else {
      // opposite direction: close (fully or partially) then possibly reverse
      const closingQty = Math.min(Math.abs(priorQty), Math.abs(delta));
      const priorAvg = Number(prior?.avgPriceUsd) || 0;
      realizedPlUsd = round2((price - priorAvg) * closingQty * multiplier * Math.sign(priorQty));
      const remainder = round4(priorQty + delta);
      if (remainder === 0) {
        newQty = 0;
        newAvgPriceUsd = 0;
      } else if (Math.sign(remainder) === Math.sign(priorQty)) {
        newQty = remainder;
        newAvgPriceUsd = priorAvg;
        openedAt = prior?.openedAt ?? atIso;
      } else {
        // reversed through zero: the leftover opens a new position at this fill price
        newQty = remainder;
        newAvgPriceUsd = price;
        openedAt = atIso;
        option = isOption ? optionMetadata : null;
        groupId = option?.groupId ?? groupId;
      }
    }

    // ---- cash + margin ------------------------------------------------------
    let cashUsd = round8(record.cashUsd + (direction === 'buy' ? -notionalUsd : notionalUsd));

    // Build the tentative position map so margin can be measured on post-fill equity.
    const tentativePositions = { ...record.positions };
    if (newQty === 0) delete tentativePositions[symbol];
    else {
      tentativePositions[symbol] = {
        symbol,
        assetClass,
        qty: newQty,
        avgPriceUsd: newAvgPriceUsd,
        openedAt,
        multiplier,
        option,
        groupId,
        structure,
      };
    }
    let marginDebtUsd = round2(Math.max(0, -cashUsd));
    if (marginDebtUsd > EPSILON) {
      let positionsValue = 0;
      for (const [sym, position] of Object.entries(tentativePositions)) {
        const mark = sym === symbol ? price : (markFor(record, sym, {}, null) ?? (Number(position.avgPriceUsd) || 0));
        positionsValue += (Number(position.qty) || 0) * mark * (Number(position.multiplier) || 1);
      }
      const equityUsd = round2(cashUsd + positionsValue);
      const debt = round2(-cashUsd);
      if (!allowMargin) {
        fail(MARGIN_LIMIT, `agent "${agentId}" has no margin permission: fill would borrow ${debt.toFixed(2)} USD`, {
          agentId,
          symbol,
          marginDebtUsd: debt,
        });
      }
      if (!(equityUsd > 0) || debt > round2(maxMarginPctEquity * equityUsd) + 0.005) {
        fail(MARGIN_LIMIT, `margin limit exceeded: debt ${debt.toFixed(2)} > ${round2(maxMarginPctEquity * equityUsd).toFixed(2)} (${maxMarginPctEquity} of equity ${equityUsd.toFixed(2)})`, {
          agentId,
          symbol,
          marginDebtUsd: debt,
          equityUsd,
        });
      }
      marginDebtUsd = debt;
    }

    // ---- commit -------------------------------------------------------------
    record.cashUsd = cashUsd;
    record.positions = tentativePositions;
    record.markPrices = { ...record.markPrices, [symbol]: price };
    record.realizedPlUsd = round8(record.realizedPlUsd + realizedPlUsd);
    record.trades += 1;
    if (direction === 'buy') record.grossSpendUsd = round8(record.grossSpendUsd + notionalUsd);
    else record.grossRevenueUsd = round8(record.grossRevenueUsd + notionalUsd);
    const fillRecord = {
      symbol,
      assetClass,
      side: direction,
      qty: quantity,
      qtySigned: delta,
      priceUsd: price,
      multiplier,
      notionalUsd,
      realizedPlUsd,
      option,
      groupId,
      structure,
      atMs,
      at: atIso,
      orderId: fill.orderId ?? null,
    };
    record.fills.push(fillRecord);
    record.events.push({
      atMs,
      kind: 'fill',
      side: direction,
      amountUsd: direction === 'buy' ? -notionalUsd : notionalUsd,
      symbol,
      qty: quantity,
      realizedPlUsd,
      assetClass,
    });
    if (record.firstProfitAt === null && round2(record.realizedPlUsd - record.costsUsd) > 0) {
      record.firstProfitAt = atIso;
    }
    record.updatedAt = atIso;
    pruneEvents(record);
    return {
      realizedPlUsd,
      position: record.positions[symbol] ? viewPosition(record, record.positions[symbol]) : null,
      cashUsd: record.cashUsd,
      marginDebtUsd,
    };
  }

  // -------------------------------------------------------------------------
  // costs / transfers / capital
  // -------------------------------------------------------------------------

  /** Clamped capital contributions of a record (finite, ≥0, 2dp). */
  function capitalTotal(record) {
    return round2(Math.max(0, Number(record?.capitalContributionsUsd) || 0));
  }

  /** Clamped reward-capital subset of a record (≤ capital, ≥0, 2dp). */
  function rewardCapitalTotal(record) {
    return round2(Math.min(capitalTotal(record), Math.max(0, Number(record?.rewardCapitalUsd) || 0)));
  }

  /** v3.3 capital decomposition at the record's stored marks (no mutation). */
  function capitalDecomposition(record) {
    const capitalContributionsUsd = capitalTotal(record);
    const rewardCapitalUsd = rewardCapitalTotal(record);
    const baseCapitalUsd = round2(Math.max(0, capitalContributionsUsd - rewardCapitalUsd));
    const tradingPnlUsd = round2(equityAtStoredMarks(record) - capitalContributionsUsd);
    const tradingPnlPct = capitalContributionsUsd > 0 ? round4(tradingPnlUsd / capitalContributionsUsd) : null;
    return {
      capitalContributionsUsd,
      rewardCapitalUsd,
      baseCapitalUsd,
      tradingPnlUsd,
      tradingPlUsd: tradingPnlUsd,
      tradingPnlPct,
      capitalVersion: Number(record?.capitalVersion) >= 2 ? 2 : 1,
    };
  }

  /**
   * Record a capital contribution (cash comes in elsewhere): raise capital contributions and,
   * for reward payouts, the reward-capital subset. Never touches realized/unrealized P&L.
   *
   * `fundDeclaredBasis` is the internal genesis aid: the declared endowment is already counted
   * by `ensureAgent`, so the first plain (non-reward) grant/credit consumes that pending basis
   * instead of adding it a second time. A reward payout NEVER consumes the basis — reward money
   * must always raise capital or it would look like trading profit.
   *
   * @param {object} record
   * @param {number} amountUsd
   * @param {{ reward?: boolean, fundDeclaredBasis?: boolean }} [options]
   * @returns {{ addedUsd:number, rewardAddedUsd:number, capitalContributionsUsd:number }}
   */
  function addCapitalContribution(record, amountUsd, { reward = false, fundDeclaredBasis = false } = {}) {
    const amount = round2(Math.max(0, Number(amountUsd) || 0));
    const capitalBefore = capitalTotal(record);
    let addedUsd = amount;
    if (fundDeclaredBasis && !reward) {
      const pendingBefore = round2(Math.max(0, Number(record.capitalPendingUsd) || 0));
      const consumed = Math.min(pendingBefore, addedUsd);
      if (consumed > 0) {
        record.capitalPendingUsd = round2(pendingBefore - consumed);
        addedUsd = round2(addedUsd - consumed);
      }
    }
    const rewardAddedUsd = reward ? addedUsd : 0;
    record.capitalContributionsUsd = round2(capitalBefore + addedUsd);
    if (rewardAddedUsd > 0) {
      record.rewardCapitalUsd = round2(Math.min(
        record.capitalContributionsUsd,
        rewardCapitalTotal(record) + rewardAddedUsd,
      ));
    }
    return {
      addedUsd,
      rewardAddedUsd,
      capitalContributionsUsd: record.capitalContributionsUsd,
    };
  }

  /**
   * Capital withdrawal (agent → treasury): reduce capital contributions, and reduce reward
   * capital only for the part of the withdrawal that exceeds the non-reward capital. Never P&L.
   * @returns {{ withdrawnCapitalUsd:number, capitalContributionsUsd:number }}
   */
  function withdrawCapital(record, amountUsd) {
    const amount = round2(Math.max(0, Number(amountUsd) || 0));
    const capitalBefore = capitalTotal(record);
    const rewardBefore = rewardCapitalTotal(record);
    const nonRewardCapital = round2(Math.max(0, capitalBefore - rewardBefore));
    const capitalAfter = round2(Math.max(0, capitalBefore - amount));
    const excess = round2(Math.max(0, amount - nonRewardCapital));
    const rewardAfter = round2(Math.max(0, rewardBefore - Math.min(rewardBefore, excess)));
    record.capitalContributionsUsd = capitalAfter;
    record.rewardCapitalUsd = round2(Math.min(capitalAfter, rewardAfter));
    record.capitalPendingUsd = round2(Math.min(
      Math.max(0, Number(record.capitalPendingUsd) || 0),
      record.capitalContributionsUsd,
    ));
    return { withdrawnCapitalUsd: round2(capitalBefore - capitalAfter), capitalContributionsUsd: capitalAfter };
  }

  /** Attribute a cost (inference, data, hosting) to an agent and a role. */
  function charge(agentId, amountUsd, { category = 'inference', role = 'executor', ref = null, at } = {}) {
    const record = requireRecord(agentId);
    // Costs are sub-cent (a fraction of a cent per role per cycle): round at 8dp while
    // accumulating, or the metabolism silently charges more than the configured burn.
    const amount = round8(Number(amountUsd));
    if (!Number.isFinite(amount) || amount < 0) {
      fail('CONFIG_INVALID', 'charge amount must be a non-negative finite number', { agentId, amountUsd });
    }
    if (amount > record.cashUsd + EPSILON) {
      fail('INSUFFICIENT_CASH', `agent "${agentId}" cannot pay ${amount.toFixed(2)}: cash is ${record.cashUsd.toFixed(2)}`, {
        agentId,
        amountUsd: amount,
        cashUsd: record.cashUsd,
      });
    }
    const atMs = normalizeAt(at, currentClock);
    record.cashUsd = round8(record.cashUsd - amount);
    record.costsUsd = round8(record.costsUsd + amount);
    record.costsByRole[role] = round8((Number(record.costsByRole[role]) || 0) + amount);
    record.events.push({ atMs, kind: 'cost', amountUsd: amount, category, role, ref });
    record.updatedAt = new Date(atMs).toISOString();
    pruneEvents(record);
    return { balanceUsd: record.cashUsd, record: clone(record) };
  }

  /**
   * Move existing cash between accounts. Both sides auto-create records so init order
   * does not matter; the source must have the cash (never go negative).
   *
   * v3.3 capital classification (docs/FAIR-PNL-REWARDS.md §3):
   *   - treasury → agent: capital contribution (plus reward capital when category is
   *     'reward' or the reason matches /reward/i) — this is the reward-payout path;
   *   - agent → treasury: capital withdrawal (reduces capital, never P&L);
   *   - any other direction: cash only (not capital), as before.
   */
  function transfer(fromId, toId, amountUsd, { reason = 'transfer', category = null, at } = {}) {
    if (typeof fromId !== 'string' || fromId === '' || typeof toId !== 'string' || toId === '') {
      fail('CONFIG_INVALID', 'transfer requires non-empty fromId and toId', { fromId, toId });
    }
    if (fromId === toId) fail('CONFIG_INVALID', 'transfer source and target must differ', { fromId, toId });
    // 8dp: cash accumulates sub-cent charges, and a death sweep must move the exact
    // residual (rounding it to 2dp can make the estate half a cent short and block the kill).
    const amount = round8(Number(amountUsd));
    if (!Number.isFinite(amount) || amount <= 0) {
      fail('CONFIG_INVALID', 'transfer amount must be a positive finite number', { amountUsd });
    }
    const atMs = normalizeAt(at, currentClock);
    const from = ensureRecord(fromId, { endowmentUsd: 0, at: atMs });
    if (amount > from.cashUsd + EPSILON) {
      fail('INSUFFICIENT_CASH', `account "${fromId}" cannot transfer ${amount.toFixed(8)}: cash is ${from.cashUsd.toFixed(8)}`, {
        fromId,
        toId,
        amountUsd: amount,
        cashUsd: from.cashUsd,
      });
    }
    const to = ensureRecord(toId, { endowmentUsd: 0, at: atMs });
    from.cashUsd = round8(from.cashUsd - amount);
    to.cashUsd = round8(to.cashUsd + amount);
    const fromEvent = { atMs, kind: 'transfer-out', amountUsd: amount, toId, reason };
    const toEvent = { atMs, kind: 'transfer-in', amountUsd: amount, fromId, reason };
    if (category !== null && category !== undefined) {
      fromEvent.category = category;
      toEvent.category = category;
    }
    if (fromId === TREASURY_ID) {
      // treasury → agent: capital contribution; reward payouts become reward capital.
      const reward = isRewardContribution(category, reason);
      const contribution = addCapitalContribution(to, amount, { reward });
      toEvent.capitalUsd = contribution.addedUsd;
      if (contribution.rewardAddedUsd > 0) toEvent.rewardUsd = contribution.rewardAddedUsd;
    } else if (toId === TREASURY_ID) {
      // agent → treasury: capital withdrawal, never trading P&L.
      const withdrawal = withdrawCapital(from, amount);
      fromEvent.capitalUsd = -withdrawal.withdrawnCapitalUsd;
    } else {
      // cash only (not capital): a parent-funded child has now received the declared basis
      // that ensureAgent counted up front, so clear that internal pending marker.
      const pending = round2(Math.max(0, Number(to.capitalPendingUsd) || 0));
      if (pending > 0) to.capitalPendingUsd = round2(Math.max(0, pending - amount));
    }
    from.events.push(fromEvent);
    to.events.push(toEvent);
    from.updatedAt = new Date(atMs).toISOString();
    to.updatedAt = from.updatedAt;
    pruneEvents(from);
    pruneEvents(to);
    return {
      fromCapitalUsd: capitalTotal(from),
      toCapitalUsd: capitalTotal(to),
      toRewardCapitalUsd: rewardCapitalTotal(to),
    };
  }

  /**
   * Genesis funding: creates virtual cash for an agent (the orchestrator seeds once).
   * The cash is a capital contribution (trading P&L is never inflated by it); a reward
   * reason/category marks reward capital. The declared endowment that `ensureAgent` already
   * counted is funded by the first plain grant instead of being added again.
   */
  function grant(agentId, amountUsd, { reason = 'grant', category = 'capital', at } = {}) {
    if (typeof agentId !== 'string' || agentId === '') {
      fail('CONFIG_INVALID', 'grant requires a non-empty agentId', { agentId });
    }
    const amount = round2(Number(amountUsd));
    if (!Number.isFinite(amount) || amount <= 0) {
      fail('CONFIG_INVALID', 'grant amount must be a positive finite number', { amountUsd });
    }
    const atMs = normalizeAt(at, currentClock);
    const record = ensureRecord(agentId, { endowmentUsd: 0, at: atMs });
    record.cashUsd = round8(record.cashUsd + amount);
    const reward = isRewardContribution(category, reason);
    const contribution = addCapitalContribution(record, amount, { reward, fundDeclaredBasis: true });
    record.events.push({
      atMs,
      kind: 'grant',
      amountUsd: amount,
      reason,
      category,
      capitalUsd: contribution.addedUsd,
      ...(contribution.rewardAddedUsd > 0 ? { rewardUsd: contribution.rewardAddedUsd } : {}),
    });
    record.updatedAt = new Date(atMs).toISOString();
    pruneEvents(record);
    return {
      balanceUsd: record.cashUsd,
      capitalContributionsUsd: capitalTotal(record),
      rewardCapitalUsd: rewardCapitalTotal(record),
    };
  }

  /**
   * One-time capital top-up (the v3 $20 → $50 migration): creates cash like a genesis
   * grant but is recorded as configured capital, never as trading P&L.
   */
  function credit(agentId, amountUsd, { category = 'capital', reason = 'capital-topup', at } = {}) {
    if (typeof agentId !== 'string' || agentId === '') {
      fail('CONFIG_INVALID', 'credit requires a non-empty agentId', { agentId });
    }
    const amount = round2(Number(amountUsd));
    if (!Number.isFinite(amount) || amount <= 0) {
      fail('CONFIG_INVALID', 'credit amount must be a positive finite number', { amountUsd });
    }
    const atMs = normalizeAt(at, currentClock);
    const record = ensureRecord(agentId, { endowmentUsd: 0, at: atMs });
    record.cashUsd = round8(record.cashUsd + amount);
    record.creditsUsd = round8((Number(record.creditsUsd) || 0) + amount);
    const reward = isRewardContribution(category, reason);
    const contribution = addCapitalContribution(record, amount, { reward, fundDeclaredBasis: true });
    record.events.push({
      atMs,
      kind: 'credit',
      amountUsd: amount,
      category,
      reason,
      capitalUsd: contribution.addedUsd,
      ...(contribution.rewardAddedUsd > 0 ? { rewardUsd: contribution.rewardAddedUsd } : {}),
    });
    record.updatedAt = new Date(atMs).toISOString();
    pruneEvents(record);
    return {
      balanceUsd: record.cashUsd,
      creditsUsd: record.creditsUsd,
      capitalContributionsUsd: capitalTotal(record),
      rewardCapitalUsd: rewardCapitalTotal(record),
    };
  }

  /** Public capital decomposition ({capitalVersion, trading P&L} without the pct helper field). */
  function capitalView(record) {
    const decomposition = capitalDecomposition(record);
    return {
      capitalContributionsUsd: decomposition.capitalContributionsUsd,
      rewardCapitalUsd: decomposition.rewardCapitalUsd,
      baseCapitalUsd: decomposition.baseCapitalUsd,
      tradingPnlUsd: decomposition.tradingPnlUsd,
      tradingPlUsd: decomposition.tradingPlUsd,
      capitalVersion: decomposition.capitalVersion,
    };
  }

  /**
   * v3.3 migration-only setter (docs/FAIR-PNL-REWARDS.md §3/§7): replace the capital basis with
   * the exact fair decomposition (registry base endowment + lifetime reward payouts). This is a
   * RECLASSIFICATION, not a cash movement and never P&L: the `capital-basis` event carries no
   * cash effect. Idempotent — applying the same basis twice yields the same state.
   *
   * @param {string} agentId
   * @param {{ baseCapitalUsd?: number, rewardCapitalUsd?: number, reason?: string,
   *   at?: number|string }} [options]
   * @returns {{ capitalContributionsUsd:number, rewardCapitalUsd:number, baseCapitalUsd:number,
   *   tradingPnlUsd:number, tradingPlUsd:number, capitalVersion:number }}
   */
  function setCapitalBasis(agentId, { baseCapitalUsd = 0, rewardCapitalUsd = 0, reason = 'capital-basis', at } = {}) {
    const record = requireRecord(agentId);
    const base = round2(Math.max(0, Number(baseCapitalUsd) || 0));
    const reward = round2(Math.max(0, Number(rewardCapitalUsd) || 0));
    const capital = round2(base + reward);
    const atMs = normalizeAt(at, currentClock);
    record.capitalContributionsUsd = capital;
    record.rewardCapitalUsd = round2(Math.min(capital, reward));
    record.capitalVersion = 2;
    record.capitalPendingUsd = 0;
    record.events.push({
      atMs,
      kind: 'capital-basis',
      amountUsd: capital,
      rewardUsd: record.rewardCapitalUsd,
      reason,
    });
    record.updatedAt = new Date(atMs).toISOString();
    pruneEvents(record);
    return capitalView(record);
  }

  /**
   * Capital decomposition for status/UI, measured at the record's stored marks (like snapshot).
   * @param {string} agentId
   * @returns {{ capitalContributionsUsd:number, rewardCapitalUsd:number, baseCapitalUsd:number,
   *   tradingPnlUsd:number, tradingPlUsd:number, capitalVersion:number }}
   */
  function capitalOf(agentId) {
    return capitalView(requireRecord(agentId));
  }

  /** True when an agent's ledger record uses v3.3 capital accounting (capitalVersion ≥ 2). */
  function hasCapitalAccounting(agentId) {
    const record = typeof agentId === 'string' ? state.agents[agentId] : null;
    return Boolean(record) && Number(record.capitalVersion) >= 2;
  }

  // -------------------------------------------------------------------------
  // valuation
  // -------------------------------------------------------------------------
  /**
   * Mark an agent at current prices and return the equity decomposition.
   * Stocks: qty * price. Options: contracts * premium * multiplier. Signed positions
   * contribute signed market value; unrealized P&L uses the signed cost basis.
   */
  function equity(agentId, prices = {}) {
    const record = requireRecord(agentId);
    let positionsValueUsd = 0;
    let costBasisUsd = 0;
    let unrealizedPlUsd = 0;
    let grossExposureUsd = 0;
    let netExposureUsd = 0;
    const marks = {};
    for (const [symbol, position] of Object.entries(record.positions)) {
      const qty = Number(position.qty) || 0;
      if (qty === 0) continue;
      const multiplier = Number(position.multiplier) || 1;
      const mark = markFor(record, symbol, prices, null) ?? (Number(position.avgPriceUsd) || 0);
      marks[symbol] = mark;
      const marketValue = qty * mark * multiplier;
      positionsValueUsd += marketValue;
      netExposureUsd += marketValue;
      grossExposureUsd += Math.abs(marketValue);
      costBasisUsd += qty * (Number(position.avgPriceUsd) || 0) * multiplier;
      unrealizedPlUsd += (mark - (Number(position.avgPriceUsd) || 0)) * qty * multiplier;
    }
    const roundedPositionsValue = round2(positionsValueUsd);
    const roundedUnrealized = round2(unrealizedPlUsd);
    const equityUsd = round2(record.cashUsd + roundedPositionsValue);
    const marginDebtUsd = round2(Math.max(0, -record.cashUsd));
    record.markPrices = { ...record.markPrices, ...marks };
    record.lastUnrealizedUsd = roundedUnrealized;
    record.lastMarginDebtUsd = marginDebtUsd;
    record.lastGrossExposureUsd = round2(grossExposureUsd);
    record.lastNetExposureUsd = round2(netExposureUsd);
    record.updatedAt = currentClock.iso();
    const netPlUsd = round2(record.realizedPlUsd - record.costsUsd + roundedUnrealized);
    if (record.firstProfitAt === null && netPlUsd > 0) record.firstProfitAt = currentClock.iso();
    // v3.3 fair P&L (docs/FAIR-PNL-REWARDS.md §3): reward payouts are capital, not profit.
    const capitalContributionsUsd = capitalTotal(record);
    const rewardCapitalUsd = rewardCapitalTotal(record);
    const baseCapitalUsd = round2(Math.max(0, capitalContributionsUsd - rewardCapitalUsd));
    const tradingPnlUsd = round2(equityUsd - capitalContributionsUsd);
    const tradingPnlPct = capitalContributionsUsd > 0
      ? round4(tradingPnlUsd / capitalContributionsUsd)
      : null;
    return {
      equityUsd,
      cashUsd: record.cashUsd,
      positionsValueUsd: roundedPositionsValue,
      unrealizedPlUsd: roundedUnrealized,
      marginDebtUsd,
      grossExposureUsd: round2(grossExposureUsd),
      netExposureUsd: round2(netExposureUsd),
      longExposureUsd: round2(Math.max(0, netExposureUsd)),
      shortExposureUsd: round2(Math.max(0, -netExposureUsd)),
      // v3.3 capital decomposition: trading P&L = equity − ALL contributed capital.
      capitalContributionsUsd,
      baseCapitalUsd,
      rewardCapitalUsd,
      tradingPnlUsd,
      // Alias kept for the orchestrator/status wiring (uses the `Pl` spelling).
      tradingPlUsd: tradingPnlUsd,
      tradingPnlPct,
      capitalVersion: Number(record.capitalVersion) >= 2 ? 2 : 1,
    };
  }

  /** Grouped (spread) P&L view: leg symbols, open contracts and realized P&L per groupId. */
  function groups(agentId) {
    const record = requireRecord(agentId);
    /** @type {Record<string, object>} */
    const out = {};
    for (const fill of record.fills) {
      if (!fill.groupId) continue;
      const group = (out[fill.groupId] ??= {
        groupId: fill.groupId,
        structure: fill.structure ?? null,
        legs: [],
        realizedPlUsd: 0,
        trades: 0,
        openContracts: 0,
      });
      if (fill.structure) group.structure = fill.structure;
      if (!group.legs.includes(fill.symbol)) group.legs.push(fill.symbol);
      group.realizedPlUsd = round2(group.realizedPlUsd + (Number(fill.realizedPlUsd) || 0));
      group.trades += 1;
    }
    for (const position of Object.values(record.positions)) {
      if (!position.groupId) continue;
      const group = (out[position.groupId] ??= {
        groupId: position.groupId,
        structure: position.structure ?? null,
        legs: [],
        realizedPlUsd: 0,
        trades: 0,
        openContracts: 0,
      });
      if (!group.legs.includes(position.symbol)) group.legs.push(position.symbol);
      if (position.structure) group.structure = position.structure;
      group.openContracts += Math.abs(Number(position.qty) || 0);
    }
    return Object.values(out);
  }

  /** Trailing 7-day net: realized P&L (window) + current unrealized − costs (window). */
  function net7d(agentId) {
    const record = requireRecord(agentId);
    const cutoff = currentClock.now() - NET7D_MS;
    let realized = 0;
    let costs = 0;
    for (const event of record.events) {
      if (!(Number(event.atMs) >= cutoff)) continue;
      if (event.kind === 'fill' && (event.realizedPlUsd ?? 0) !== 0) realized += Number(event.realizedPlUsd) || 0;
      if (event.kind === 'cost') costs += Number(event.amountUsd) || 0;
    }
    return round2(realized - costs + (Number(record.lastUnrealizedUsd) || 0));
  }

  /** Snapshot used for obituaries, status views and the operator UI (no broker reads). */
  function snapshot(agentId) {
    const record = requireRecord(agentId);
    const positions = clone(record.positions);
    /** @type {object[]} */
    const positionsList = [];
    let positionsValueUsd = 0;
    let grossExposureUsd = 0;
    let netExposureUsd = 0;
    for (const position of Object.values(record.positions)) {
      const view = viewPosition(record, position);
      positionsList.push(view);
      positionsValueUsd += view.marketValueUsd;
      grossExposureUsd += Math.abs(view.marketValueUsd);
      netExposureUsd += view.marketValueUsd;
    }
    const marginDebtUsd = round2(Math.max(0, -record.cashUsd));
    // v3.3 fair P&L decomposition at the record's stored marks (safe with no positions).
    const capitalContributionsUsd = capitalTotal(record);
    const rewardCapitalUsd = rewardCapitalTotal(record);
    const baseCapitalUsd = round2(Math.max(0, capitalContributionsUsd - rewardCapitalUsd));
    const tradingPnlUsd = round2(equityAtStoredMarks(record) - capitalContributionsUsd);
    const tradingPnlPct = capitalContributionsUsd > 0
      ? round4(tradingPnlUsd / capitalContributionsUsd)
      : null;
    return {
      cashUsd: record.cashUsd,
      positions,
      positionsList,
      positionsValueUsd: round2(positionsValueUsd),
      realizedPlUsd: record.realizedPlUsd,
      unrealizedPlUsd: round2(Number(record.lastUnrealizedUsd) || 0),
      costsUsd: record.costsUsd,
      grossSpendUsd: record.grossSpendUsd,
      grossRevenueUsd: record.grossRevenueUsd,
      creditsUsd: round2(Number(record.creditsUsd) || 0),
      trades: record.trades,
      net7dUsd: net7d(agentId),
      firstProfitAt: record.firstProfitAt,
      endowmentUsd: record.declaredEndowmentUsd,
      startedAt: record.startedAt,
      marginDebtUsd,
      grossExposureUsd: round2(grossExposureUsd),
      netExposureUsd: round2(netExposureUsd),
      // v3.3 capital decomposition (reward capital is contributed capital, never P&L).
      capitalContributionsUsd,
      baseCapitalUsd,
      rewardCapitalUsd,
      tradingPnlUsd,
      // Alias kept for the orchestrator/status wiring (uses the `Pl` spelling).
      tradingPlUsd: tradingPnlUsd,
      tradingPnlPct,
      capitalVersion: Number(record.capitalVersion) >= 2 ? 2 : 1,
      longShares: Object.fromEntries(
        Object.entries(record.positions)
          .filter(([, position]) => position.assetClass === 'us_equity')
          .map(([symbol, position]) => [symbol, round4(Math.max(0, Number(position.qty) || 0))]),
      ),
      groups: groups(agentId),
    };
  }

  function roleCosts(agentId) {
    const record = requireRecord(agentId);
    return clone(record.costsByRole);
  }

  /**
   * Recent fills for the operator/UI: newest first, bounded, with everything needed to show
   * "past activity" (side, qty, price, notional, realized P&L, timestamp, order id,
   * assetClass/option metadata for v3).
   * @param {string} agentId
   * @param {{ limit?: number }} [options]
   */
  function history(agentId, { limit = 20 } = {}) {
    const record = requireRecord(agentId);
    const size = Math.max(1, Math.min(200, Number(limit) || 20));
    return clone(record.fills.slice(-size)).reverse();
  }

  /** Equity of a record at its stored marks (the synthetic treasury has no positions). */
  function equityAtStoredMarks(record) {
    let positionsValueUsd = 0;
    for (const [symbol, position] of Object.entries(record.positions)) {
      const mark = Number(record.markPrices?.[symbol]) > 0
        ? Number(record.markPrices[symbol])
        : Number(position.avgPriceUsd) || 0;
      positionsValueUsd += (Number(position.qty) || 0) * mark * (Number(position.multiplier) || 1);
    }
    return round2(record.cashUsd + positionsValueUsd);
  }

  /**
   * Treasury pool: unallocated cash held by `'__treasury__'` plus allocated agent equity.
   * @param {{ aliveIds?: string[] }} [options] restrict allocated equity to living agents
   */
  function pool({ aliveIds = null } = {}) {
    const treasury = state.agents[TREASURY_ID];
    const poolUsd = treasury ? equityAtStoredMarks(treasury) : 0;
    const filter = Array.isArray(aliveIds) ? new Set(aliveIds) : null;
    let allocatedUsd = 0;
    for (const [agentId, record] of Object.entries(state.agents)) {
      if (agentId === TREASURY_ID) continue;
      if (filter && !filter.has(agentId)) continue;
      allocatedUsd += equityAtStoredMarks(record);
    }
    return { poolUsd: round2(poolUsd), allocatedUsd: round2(allocatedUsd), totalUsd: round2(poolUsd + allocatedUsd) };
  }

  function isAnchored() {
    return state.anchored === true;
  }

  /**
   * One-time reconciliation anchor: credit `'__treasury__'` with the broker capital that
   * is not yet allocated, so sum(agent equity) + treasury equity = broker account equity
   * at the anchor point. Later drift is what `treasurer.tick()` reports as mismatch.
   */
  function anchorToBrokerEquity(accountEquityUsd) {
    const accountEquity = round2(Number(accountEquityUsd));
    if (!Number.isFinite(accountEquity)) {
      fail('CONFIG_INVALID', 'anchorToBrokerEquity requires a finite account equity', { accountEquityUsd });
    }
    if (state.anchored) return { anchored: false, seededUsd: 0, poolUsd: pool().poolUsd };
    const allocated = pool().allocatedUsd;
    const seed = round2(accountEquity - allocated);
    if (seed > 0) {
      grant(TREASURY_ID, seed, { reason: 'genesis-pool-anchor' });
    }
    state.anchored = true;
    state.anchoredAt = currentClock.iso();
    return { anchored: true, seededUsd: Math.max(0, seed), poolUsd: pool().poolUsd };
  }

  function save() {
    writeJsonAtomicSync(ledgerPath, state);
  }

  function load() {
    const raw = readJsonSync(ledgerPath, null);
    state = emptyState();
    if (!raw) return;
    state.anchored = raw.anchored === true;
    state.anchoredAt = typeof raw.anchoredAt === 'string' ? raw.anchoredAt : null;
    const agents = isPlainObject(raw.agents) ? raw.agents : {};
    for (const [agentId, record] of Object.entries(agents)) {
      if (!isPlainObject(record)) continue;
      state.agents[agentId] = normaliseRecord({ ...record, agentId });
    }
  }

  return {
    ensureAgent,
    get,
    has,
    ids,
    book,
    longSharesOf,
    optionContractsOf,
    hasCoveredShares,
    charge,
    applyFill,
    transfer,
    grant,
    credit,
    equity,
    net7d,
    snapshot,
    // v3.3 fair capital accounting (docs/FAIR-PNL-REWARDS.md §3).
    capitalOf,
    setCapitalBasis,
    hasCapitalAccounting,
    roleCosts,
    history,
    groups,
    pool,
    isAnchored,
    anchorToBrokerEquity,
    save,
    load,
    /** @returns {string} absolute path of the persisted ledger file (diagnostics only). */
    get path() {
      return ledgerPath;
    },
  };
}
