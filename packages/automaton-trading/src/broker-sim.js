/**
 * Deterministic synthetic broker + market (market side) — the accelerated, network-free
 * twin of `broker-alpaca.js`. Same interface, same return shapes, zero I/O.
 *
 * The market is generated with `mulberry32(seed)` so the same seed and the same call
 * sequence always produce the same bars, quotes, fills and account: the population
 * simulation is reproducible. Each symbol walks through repeating regimes
 * (trend up / choppy / mean-reverting / trend down) so momentum, mean-reversion,
 * breakout and gap-fade signals all have something real to find.
 *
 * Order fills are immediate for market orders at the current quote plus configured
 * slippage/commission; resting limit orders fill when a later bar trades through the
 * limit. Cash and positions are accounted exactly, with no shorting and no negative cash.
 *
 * Multi-instrument: signed stock positions (long/short), deterministic option chains and
 * quotes (synthetic premiums, two expiries), integer-contract option fills, and
 * defined-risk multi-leg (mleg) orders — so every market-side test runs offline.
 *
 * Includes a deterministic synthetic news feed (`getNews`) so the isolated research
 * sidecar can be exercised offline: same seed + same simulated hour => same headlines.
 *
 * Contract: docs/CONTRACTS.md § "Broker interface". Owner: market teammate.
 *
 * @module broker-sim
 */

import { fail } from './contracts.js';
import { HOUR_MS, mulberry32, round2, round4 } from './util.js';

/** Fixed simulated session start so bars/timestamps are deterministic. */
export const SIM_MARKET_EPOCH_MS = Date.UTC(2024, 0, 8, 14, 30, 0);

const DEFAULT_SEED = 42;
const DEFAULT_ACCOUNT_EQUITY_USD = 100_000;
const DEFAULT_HISTORY_BARS = 400;
const REGIME_BARS = 48;
const MIN_PRICE_USD = 1;

/** Deterministic synthetic-news templates consumed by the research sidecar. */
const NEWS_TEMPLATES = Object.freeze([
  { headline: '{symbol} beats quarterly expectations', summary: 'Quarterly results for {symbol} came in above consensus, with management raising guidance.' },
  { headline: 'Analysts lift {symbol} price target', summary: 'A sell-side note raised its target on {symbol}, citing improving end-market demand.' },
  { headline: '{symbol} warns on margin pressure', summary: '{symbol} flagged input-cost pressure that could weigh on margins next quarter.' },
  { headline: '{symbol} downgraded after soft guidance', summary: 'An analyst downgraded {symbol} following cautious forward guidance.' },
  { headline: '{symbol} announces routine product update', summary: '{symbol} shipped a routine product refresh; no financial detail was disclosed.' },
  { headline: '{symbol} schedules investor day', summary: '{symbol} will host an investor day to discuss its medium-term capital plan.' },
  { headline: 'Regulators open review into {symbol} disclosures', summary: 'A regulatory review into {symbol} disclosures adds near-term uncertainty.' },
  { headline: '{symbol} expands share repurchase program', summary: '{symbol} enlarged its share repurchase authorization, a modest capital-return signal.' },
]);

/** Parse a news start/end filter (epoch ms or ISO string) to epoch ms. */
function newsFilterMs(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

// ---------------------------------------------------------------------------
// deterministic options primitives (offline twin of the Alpaca chain/snapshot)
// ---------------------------------------------------------------------------

const DAY_MS = 24 * HOUR_MS;
/** One option contract covers 100 shares. */
export const SIM_OPTION_MULTIPLIER = 100;
/** Default synthetic expiries (days ahead), as the contract requires (5 and 12). */
export const DEFAULT_OPTION_EXPIRY_DAYS = Object.freeze([5, 12]);

/** True when a symbol looks like an OCC option symbol (e.g. F260116C00013000). */
export function isSimOptionSymbol(symbol) {
  return /^[A-Z]{1,6}\d{6}[CP]\d{8}$/.test(String(symbol ?? '').toUpperCase());
}

/**
 * Parse an OCC option symbol (kept local so the sim broker stays a standalone,
 * network-free module; mirrors broker-alpaca.parseOccSymbol).
 * @param {string} symbol
 * @returns {{symbol:string, underlying:string, expiration:string, type:'call'|'put', strikeUsd:number}|null}
 */
export function parseSimOccSymbol(symbol) {
  const text = String(symbol ?? '').trim().toUpperCase();
  const match = /^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(text);
  if (!match) return null;
  const month = Number(match[3]);
  const day = Number(match[4]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const strikeUsd = Number(match[6]) / 1000;
  if (!Number.isFinite(strikeUsd) || strikeUsd <= 0) return null;
  return {
    symbol: text,
    underlying: match[1],
    expiration: `${2000 + Number(match[2])}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    type: match[5] === 'C' ? 'call' : 'put',
    strikeUsd: Math.round(strikeUsd * 1000) / 1000,
  };
}

/** Build an OCC symbol from normalized parts (mirrors broker-alpaca.formatOccSymbol). */
export function formatSimOccSymbol({ underlying, expiration, type, strikeUsd }) {
  const symbol = String(underlying ?? '').trim().toUpperCase();
  const fullDate = String(expiration ?? '').slice(0, 10).replace(/-/g, '');
  const date = fullDate.slice(2); // OCC uses YYMMDD
  if (!/^[A-Z]{1,6}$/.test(symbol) || !/^\d{6}$/.test(date)) return '';
  const suffix = String(type ?? '').toLowerCase() === 'put' ? 'P' : 'C';
  const strike = Math.round(Number(strikeUsd) * 1000);
  if (!Number.isFinite(strike) || strike <= 0) return '';
  return `${symbol}${date}${suffix}${String(strike).padStart(8, '0')}`;
}

/** UTC date key `YYYY-MM-DD`. */
function simDateKey(atMs) {
  const date = new Date(atMs);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/** Whole days from `nowMs` to an expiration date (`YYYY-MM-DD`, UTC). */
function simDte(expiration, nowMs) {
  const expiryMs = Date.parse(`${String(expiration ?? '').slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(expiryMs)) return null;
  return Math.max(0, Math.ceil((expiryMs - nowMs) / DAY_MS));
}

/** Strike grid step: $0.5 under $25, $1 under $100, $5 above (deterministic). */
function optionStrikeStep(spot) {
  if (spot >= 100) return 5;
  if (spot >= 25) return 1;
  return 0.5;
}

function roundToStep(value, step) {
  return Math.round(value / step) * step;
}

/**
 * Deterministic synthetic option premium (USD per share): intrinsic value plus a decaying
 * time-value proxy. Time value decays with OTM distance so chains are monotonic in strike
 * (further-OTM calls/puts are cheaper), which keeps vertical spreads priced correctly.
 */
function optionPremiumUsd({ spot, strike, type, dte }) {
  const intrinsic = type === 'call' ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  const otmDistance = type === 'call'
    ? Math.max(0, strike - spot) / Math.max(spot, 0.01)
    : Math.max(0, spot - strike) / Math.max(spot, 0.01);
  const atmTimeValue = spot * 0.02 * Math.sqrt(Math.max(1, Number(dte) || 1) / 30);
  const timeValue = atmTimeValue * Math.exp(-4 * otmDistance);
  return Math.max(0.01, round2(intrinsic + timeValue));
}

/** Synthetic relative spread on option prices (bid below, ask above the premium). */
const OPTION_SPREAD_FRACTION = 0.02;

// ---------------------------------------------------------------------------
// deterministic helpers
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit string hash (stable across runs/platforms). */
export function fnv1a(text) {
  let hash = 0x811c9dc5;
  const value = String(text);
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Per-symbol seeded PRNG so symbols are independent but deterministic. */
function symbolRng(seed, symbol) {
  return mulberry32((fnv1a(symbol) ^ Math.imul(seed >>> 0, 0x9e3779b9)) >>> 0);
}

/** Standard normal from a uniform rng (Box-Muller, deterministic). */
function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function num(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Generate one hourly OHLCV bar for a symbol state.
 * Regimes: 0 = trend up, 1 = choppy, 2 = mean-reverting, 3 = trend down.
 * @param {object} state symbol state
 * @returns {{t:number,o:number,h:number,l:number,c:number,v:number}}
 */
function nextBar(state) {
  const rng = state.rng;
  const index = state.bars.length;
  const regime = Math.floor(index / REGIME_BARS) % 4;
  const sigma = 0.0022 + rng() * 0.0038; // 0.22% - 0.6% hourly vol
  const prevClose = state.lastClose;
  let drift = 0;
  if (regime === 0) drift = 0.0007 + rng() * 0.0008; // persistent uptrend
  else if (regime === 3) drift = -(0.0007 + rng() * 0.0008); // persistent downtrend
  else if (regime === 2) drift = ((state.mean - prevClose) / prevClose) * 0.12; // reversion pull
  // regime 1 (choppy) has ~zero drift and slightly higher vol
  const vol = regime === 1 ? sigma * 1.35 : sigma;

  // Gaps exist so the gap-fade family has something to measure.
  const gapChance = rng();
  let gap = 0;
  if (gapChance < 0.12) gap = gaussian(rng) * 0.0018;
  if (gapChance < 0.02) gap = Math.sign(gaussian(rng) || 1) * (0.004 + rng() * 0.004);

  let open = prevClose * (1 + gap);
  let close = open * (1 + drift + vol * gaussian(rng));
  open = Math.max(MIN_PRICE_USD, open);
  close = Math.max(MIN_PRICE_USD, close);
  const wickUp = Math.abs(gaussian(rng)) * vol * 0.55;
  const wickDown = Math.abs(gaussian(rng)) * vol * 0.55;
  const high = Math.max(open, close) * (1 + wickUp);
  const low = Math.max(MIN_PRICE_USD, Math.min(open, close) * (1 - wickDown));
  const volume = Math.round(250_000 + rng() * 3_000_000);

  const bar = {
    t: SIM_MARKET_EPOCH_MS + index * HOUR_MS,
    o: round4(open),
    h: round4(high),
    l: round4(low),
    c: round4(close),
    v: volume,
  };
  state.lastClose = bar.c;
  state.mean = state.mean + (bar.c - state.mean) * 0.08;
  state.bars.push(bar);
  return bar;
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

/**
 * Create a simulated broker + market with the same interface as broker-alpaca.
 *
 * @param {object} config AUTOMATON config (mode is reported as 'sim')
 * @param {{
 *   seed?: number,
 *   accountEquityUsd?: number,
 *   clock?: { now: () => number },
 *   spreadBps?: number,
 *   slippageBps?: number,
 *   commissionUsd?: number,
 *   fetchImpl?: typeof fetch,
 *   secrets?: Record<string,string>,
 *   historyBars?: number,
 * }} [options]
 * @param {{ seed?: number, accountEquityUsd?: number }} [simOptions] Lead-passed third arg
 * @returns {object} broker with kind 'sim' plus market helpers
 */
export function createBroker(config, options = {}, simOptions = {}) {
  if (!config || typeof config !== 'object') {
    fail('CONFIG_INVALID', 'broker-sim requires a config object');
  }
  const symbols = Array.isArray(config.symbols) ? [...config.symbols] : [];
  if (symbols.length === 0) fail('CONFIG_INVALID', 'broker-sim needs at least one configured symbol');

  const clock = options.clock ?? null;
  const spreadBps = num(options.spreadBps ?? config.sim?.spreadBps, 4);
  const slippageBps = num(options.slippageBps ?? config.sim?.slippageBps, 5);
  const commissionUsd = num(options.commissionUsd ?? config.sim?.commissionUsd, 0);
  const baseSeed = num(simOptions.seed ?? options.seed ?? config.sim?.seed, DEFAULT_SEED);
  const baseEquity = num(
    simOptions.accountEquityUsd ?? options.accountEquityUsd ?? config.sim?.accountEquityUsd,
    DEFAULT_ACCOUNT_EQUITY_USD,
  );
  const historyBars = Math.max(
    DEFAULT_HISTORY_BARS,
    num(options.historyBars, 0),
    num(config.data?.lookbackBars, 120) + 60,
  );
  // Multi-instrument capability of the synthetic account (paper-parity defaults).
  const allowMargin = config.instruments?.allowMargin === undefined ? true : config.instruments.allowMargin === true;
  const allowShort = config.instruments?.allowShort === undefined ? true : config.instruments.allowShort === true;
  const maxMarginPctEquity = num(config.instruments?.maxMarginPctEquity, 1);
  const optionExpiryDays = Array.isArray(options.optionExpiryDays) && options.optionExpiryDays.length > 0
    ? options.optionExpiryDays.map(Number).filter((days) => Number.isFinite(days) && days > 0)
    : [...DEFAULT_OPTION_EXPIRY_DAYS];
  const optionFeed = options.optionFeed ?? config.instruments?.optionDataFeed ?? 'indicative';

  /** @type {ReturnType<typeof createBroker>} */
  const broker = {
    kind: 'sim',
    mode: 'sim',
    seed: baseSeed,
    symbols,
  };

  // -------------------------------------------------------------------------
  // state
  // -------------------------------------------------------------------------
  let market = null; // { nowMs, symbolStates: Map }
  let account = null; // { cashUsd, positions: Map, orders: [], seq }
  let quoteOverrides = new Map();

  /** @returns {void} */
  function initMarket(seed) {
    const symbolStates = new Map();
    for (const symbol of symbols) {
      const rng = symbolRng(seed, symbol);
      const basePrice = 25 + (fnv1a(`${symbol}:${seed}`) % 400); // $25 - $425
      /** @type {object} */
      const state = {
        symbol,
        rng,
        bars: [],
        lastClose: basePrice,
        mean: basePrice,
      };
      for (let i = 0; i < historyBars; i += 1) nextBar(state);
      symbolStates.set(symbol, state);
    }
    market = { nowMs: SIM_MARKET_EPOCH_MS + historyBars * HOUR_MS, symbolStates, seed };
  }

  /** @returns {void} */
  function initAccount() {
    account = { cashUsd: baseEquity, positions: new Map(), orders: [], seq: 0 };
  }

  initMarket(baseSeed);
  initAccount();

  /** Current reference price (last close), independent of overrides. */
  function lastClose(symbol) {
    const state = market.symbolStates.get(symbol);
    if (!state || state.bars.length === 0) return null;
    return state.bars[state.bars.length - 1].c;
  }

  /** Current quote including deterministic test overrides. */
  function currentQuote(symbol) {
    const ticker = String(symbol ?? '').trim().toUpperCase();
    const override = quoteOverrides.get(ticker);
    if (override) {
      const last = num(override.last, num(override.bid, num(override.ask, lastClose(ticker))));
      return {
        symbol: ticker,
        bid: num(override.bid, last),
        ask: num(override.ask, last),
        last,
        ts: num(override.ts, broker.marketNow()),
      };
    }
    const close = lastClose(ticker);
    if (close === null) {
      fail('DATA_MISSING', `sim broker has no market for symbol ${ticker}`, { symbol: ticker });
    }
    const half = spreadBps / 20_000; // spreadBps -> half-spread as fraction
    return {
      symbol: ticker,
      bid: round4(close * (1 - half)),
      ask: round4(close * (1 + half)),
      last: close,
      ts: broker.marketNow(),
    };
  }

  /** Market clock in simulated milliseconds (or the injected clock's time). */
  function marketNow() {
    if (clock && typeof clock.now === 'function') return Math.round(clock.now());
    return market.nowMs;
  }

  function execPrice(side, quote) {
    const slip = slippageBps / 10_000;
    return round4(side === 'buy' ? quote.ask * (1 + slip) : quote.bid * (1 - slip));
  }

  // -------------------------------------------------------------------------
  // options: deterministic synthetic chains (no network, same shapes as Alpaca)
  // -------------------------------------------------------------------------

  /** Synthetic expiry dates (UTC) offset in days from the current simulated day. */
  function optionExpiries(nowMs = marketNow()) {
    const date = new Date(nowMs);
    const baseUtc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    return optionExpiryDays.map((days) => simDateKey(baseUtc + days * DAY_MS));
  }

  /** Strike grid around the current underlying mark. */
  function optionStrikeGrid(spot) {
    const step = optionStrikeStep(spot);
    const center = roundToStep(spot, step);
    const strikes = [];
    for (let offset = -4; offset <= 4; offset += 1) {
      const strike = round2(center + offset * step);
      if (strike > 0) strikes.push(strike);
    }
    return [...new Set(strikes)].sort((left, right) => left - right);
  }

  /** Deterministic chain for one underlying (both synthetic expiries, strike grid). */
  function optionContractsFor(underlying, type = 'call') {
    const ticker = String(underlying ?? '').trim().toUpperCase();
    const spot = lastClose(ticker);
    if (spot === null) return [];
    const nowMs = marketNow();
    const normalizedType = String(type ?? '').toLowerCase() === 'put' ? 'put' : 'call';
    const contracts = [];
    for (const expiration of optionExpiries(nowMs)) {
      const dte = simDte(expiration, nowMs);
      for (const strikeUsd of optionStrikeGrid(spot)) {
        const symbol = formatSimOccSymbol({ underlying: ticker, expiration, type: normalizedType, strikeUsd });
        if (!symbol) continue;
        contracts.push({
          symbol,
          underlying: ticker,
          type: normalizedType,
          strikeUsd,
          expiration,
          dte,
          multiplier: SIM_OPTION_MULTIPLIER,
          tradable: true,
          closePriceUsd: optionPremiumUsd({ spot, strike: strikeUsd, type: normalizedType, dte }),
        });
      }
    }
    return contracts;
  }

  /** Current synthetic mark (premium per share) for one OCC contract. */
  function optionMark(occSymbol) {
    const parsed = parseSimOccSymbol(occSymbol);
    if (!parsed) return null;
    const spot = lastClose(parsed.underlying);
    if (spot === null) return null;
    return optionPremiumUsd({
      spot,
      strike: parsed.strikeUsd,
      type: parsed.type,
      dte: simDte(parsed.expiration, marketNow()),
    });
  }

  /** Synthetic quote for one OCC contract (bid/ask around the deterministic mark). */
  function optionQuoteFor(occSymbol) {
    const parsed = parseSimOccSymbol(occSymbol);
    if (!parsed) return null;
    const mark = optionMark(occSymbol);
    if (mark === null) return null;
    const bid = Math.max(0.01, round2(mark * (1 - OPTION_SPREAD_FRACTION)));
    const ask = Math.max(round2(bid + 0.01), round2(mark * (1 + OPTION_SPREAD_FRACTION)));
    return {
      symbol: parsed.symbol,
      underlying: parsed.underlying,
      type: parsed.type,
      strikeUsd: parsed.strikeUsd,
      expiration: parsed.expiration,
      dte: simDte(parsed.expiration, marketNow()),
      multiplier: SIM_OPTION_MULTIPLIER,
      bid,
      ask,
      last: mark,
      mark: round2((bid + ask) / 2),
      ts: marketNow(),
      simulated: true,
      feed: optionFeed,
    };
  }

  function optionQuoteOrFail(occSymbol) {
    const quote = optionQuoteFor(occSymbol);
    if (!quote) fail('DATA_MISSING', `sim broker has no option market for ${occSymbol}`, { symbol: occSymbol });
    return quote;
  }

  function normalizeOrder(raw) {
    return {
      id: raw.id,
      clientOrderId: raw.clientOrderId ?? null,
      symbol: raw.symbol ?? null,
      side: raw.side ?? null,
      qty: raw.qty ?? null,
      filledQty: raw.filledQty ?? 0,
      avgFillPriceUsd: raw.avgFillPriceUsd ?? null,
      filledAvgPriceUsd: raw.avgFillPriceUsd ?? raw.filledAvgPriceUsd ?? null,
      status: raw.status,
      submittedAt: raw.submittedAt,
      filledAt: raw.filledAt ?? null,
      type: raw.type ?? 'market',
      notionalUsd: round2(raw.notionalUsd ?? 0),
      assetClass: raw.assetClass ?? 'us_equity',
      orderClass: raw.orderClass ?? 'simple',
      positionIntent: raw.positionIntent ?? null,
      limitPrice: raw.limitPrice ?? null,
      limitPriceUsd: raw.limitPrice ?? null,
      multiplier: raw.multiplier ?? 1,
      option: raw.option ?? null,
      groupId: raw.groupId ?? null,
      structure: raw.structure ?? null,
      legs: Array.isArray(raw.legs) ? raw.legs : [],
    };
  }

  // -------------------------------------------------------------------------
  // accounting (generic signed positions: long/short stock, long/short options)
  // -------------------------------------------------------------------------

  /** Mark-to-market equity with stocks at last close and options at synthetic premiums. */
  function accountEquityEstimate() {
    let positionsValue = 0;
    for (const [symbol, position] of account.positions) {
      const mark = position.assetClass === 'us_option' ? optionMark(symbol) : lastClose(symbol);
      if (mark === null || mark === undefined) continue;
      positionsValue += position.qty * mark * (position.multiplier || 1);
    }
    return round2(account.cashUsd + positionsValue);
  }

  /** Apply one signed fill to the position book (avg entry; flip through zero supported). */
  function applyPositionDelta({ symbol, delta, price, assetClass, multiplier, option, groupId, structure, orderId }) {
    const existing = account.positions.get(symbol);
    const currentQty = existing?.qty ?? 0;
    if (Math.abs(delta) < 1e-9) return;
    if (Math.abs(currentQty) < 1e-9 || Math.sign(currentQty) === Math.sign(delta)) {
      const totalAbs = Math.abs(currentQty) + Math.abs(delta);
      const average = (Math.abs(currentQty) * (existing?.avgPriceUsd ?? price) + Math.abs(delta) * price) / Math.max(totalAbs, 1e-9);
      account.positions.set(symbol, {
        symbol,
        qty: round4(currentQty + delta),
        avgPriceUsd: round4(average),
        openedAt: existing?.openedAt ?? marketNow(),
        assetClass: assetClass ?? existing?.assetClass ?? 'us_equity',
        multiplier: multiplier ?? existing?.multiplier ?? 1,
        option: option ?? existing?.option ?? null,
        groupId: groupId ?? existing?.groupId ?? null,
        structure: structure ?? existing?.structure ?? null,
        orderId: orderId ?? existing?.orderId ?? null,
      });
      return;
    }
    const remaining = round4(currentQty + delta);
    if (Math.abs(remaining) < 1e-9) {
      account.positions.delete(symbol);
      return;
    }
    if (Math.abs(delta) <= Math.abs(currentQty) + 1e-9) {
      // Partial close: entry basis unchanged.
      existing.qty = remaining;
      return;
    }
    // Flip through zero: the old side is closed, the new side opens at the fill.
    account.positions.set(symbol, {
      symbol,
      qty: remaining,
      avgPriceUsd: price,
      openedAt: marketNow(),
      assetClass: assetClass ?? 'us_equity',
      multiplier: multiplier ?? 1,
      option: option ?? null,
      groupId: groupId ?? null,
      structure: structure ?? null,
      orderId: orderId ?? null,
    });
  }

  /**
   * One fill: cash, margin guard, signed position update.
   * @returns {{cashDelta:number, notionalUsd:number}}
   */
  function fillOne({ symbol, side, qty, priceUsd, assetClass = 'us_equity', multiplier = 1, option = null, groupId = null, structure = null, orderId = null }) {
    const units = Math.abs(Number(qty));
    const price = Number(priceUsd);
    if (!(units > 0) || !(price > 0)) fail('SPEC_INVALID', 'fill requires positive qty and price', { symbol, qty, priceUsd });
    const isOption = assetClass === 'us_option';
    if (isOption && !Number.isInteger(units)) {
      fail('SPEC_INVALID', 'option fills require whole contracts', { symbol, qty });
    }
    const existingQty = account.positions.get(symbol)?.qty ?? 0;
    const resultingQty = existingQty + (side === 'buy' ? units : -units);
    if (!isOption && resultingQty < 0 && !Number.isInteger(Math.abs(resultingQty)) && !Number.isInteger(units)) {
      fail('SPEC_INVALID', 'short stock requires whole shares', { symbol, qty });
    }
    if (!isOption && resultingQty < 0 && allowShort !== true) {
      fail('BRAKE_DENIED', 'sim broker has shorting disabled for this account', { symbol, qty });
    }
    const gross = round2(units * price * (multiplier || 1));
    const cashDelta = side === 'buy' ? round2(-(gross + commissionUsd)) : round2(gross - commissionUsd);
    const nextCash = round2(account.cashUsd + cashDelta);
    if (nextCash < 0 && allowMargin !== true) {
      fail('INSUFFICIENT_CASH', 'sim broker has insufficient cash for fill', {
        cashUsd: round2(account.cashUsd),
        costUsd: round2(-cashDelta),
      });
    }
    if (nextCash < 0) {
      const equity = accountEquityEstimate();
      const maxDebt = round2(maxMarginPctEquity * Math.max(0, equity));
      if (round2(-nextCash) > maxDebt + 1e-6) {
        fail('MARGIN_LIMIT', `sim broker margin debt ${round2(-nextCash)} exceeds cap ${maxDebt}`, {
          cashUsd: nextCash,
          equityUsd: equity,
          maxDebtUsd: maxDebt,
        });
      }
    }
    account.cashUsd = nextCash;
    applyPositionDelta({
      symbol,
      delta: side === 'buy' ? units : -units,
      price,
      assetClass,
      multiplier: multiplier || 1,
      option,
      groupId,
      structure,
      orderId,
    });
    return { cashDelta, notionalUsd: gross };
  }

  /** Apply one fill to cash/positions and mutate the order record. */
  function fill(order, price) {
    const result = fillOne({
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      priceUsd: price,
      assetClass: order.assetClass,
      multiplier: order.multiplier,
      option: order.option,
      groupId: order.groupId,
      structure: order.structure,
      orderId: order.id,
    });
    order.status = 'filled';
    order.filledQty = order.qty;
    order.avgFillPriceUsd = price;
    order.filledAvgPriceUsd = price;
    order.notionalUsd = result.notionalUsd;
    order.filledAt = marketNow();
    return order;
  }

  /** Submit one option order (integer contracts, limit premium per share). */
  function submitOption(input, symbol) {
    const parsed = parseSimOccSymbol(symbol);
    if (!parsed) fail('SPEC_INVALID', `not an OCC option symbol: ${symbol}`, { symbol });
    const side = String(input.side ?? '').trim().toLowerCase();
    if (side !== 'buy' && side !== 'sell') fail('SPEC_INVALID', 'sim option order side must be buy or sell', { symbol });
    const qty = num(input.qty, null);
    if (!Number.isInteger(qty) || qty < 1) fail('SPEC_INVALID', 'sim option order requires integer qty >= 1', { symbol, qty });
    const quote = optionQuoteOrFail(symbol);
    const type = input.type ?? 'limit';
    const limitPrice = num(input.limitPrice, null);
    const price = limitPrice ?? (side === 'buy' ? quote.ask : quote.bid);
    if (!(price > 0)) fail('SPEC_INVALID', 'sim option order requires a positive premium', { symbol, price });
    account.seq += 1;
    const order = normalizeOrder({
      id: `sim-opt-${String(account.seq).padStart(6, '0')}`,
      clientOrderId: input.clientOrderId ? String(input.clientOrderId) : null,
      symbol,
      side,
      qty,
      status: 'new',
      submittedAt: marketNow(),
      type,
      assetClass: 'us_option',
      positionIntent: input.positionIntent ?? null,
      multiplier: SIM_OPTION_MULTIPLIER,
      option: { ...parsed, multiplier: SIM_OPTION_MULTIPLIER },
      groupId: input.groupId ?? null,
      structure: input.structure ?? null,
      limitPrice,
      orderClass: 'simple',
    });
    fill(order, price);
    account.orders.push(order);
    return { ...order };
  }

  /** Submit a multi-leg option order as one order (mleg); legs fill at mark/limit. */
  function submitMleg(input) {
    const legs = Array.isArray(input.legs) ? input.legs : [];
    if (legs.length < 2) fail('SPEC_INVALID', 'sim mleg order requires at least 2 legs', { legs: legs.length });
    const spreads = Math.max(1, Math.trunc(num(input.qty, 1)));
    account.seq += 1;
    const orderId = `sim-mleg-${String(account.seq).padStart(6, '0')}`;
    const groupId = input.groupId ? String(input.groupId) : orderId;
    const plan = legs.map((leg) => {
      const legSymbol = String(leg?.symbol ?? '').trim().toUpperCase();
      const parsed = parseSimOccSymbol(legSymbol);
      if (!parsed) fail('SPEC_INVALID', `sim mleg leg is not an OCC symbol: ${legSymbol}`, { leg });
      const side = String(leg?.side ?? '').toLowerCase();
      if (side !== 'buy' && side !== 'sell') fail('SPEC_INVALID', 'sim mleg leg side must be buy or sell', { leg });
      const ratioQty = Number.isFinite(Number(leg?.ratioQty)) && Number(leg.ratioQty) > 0 ? Number(leg.ratioQty) : 1;
      const units = Math.trunc(ratioQty * spreads);
      const quote = optionQuoteOrFail(legSymbol);
      const price = num(leg?.limitPrice, null) ?? (side === 'buy' ? quote.ask : quote.bid);
      return {
        symbol: legSymbol,
        side,
        units,
        price,
        positionIntent: leg?.positionIntent ?? null,
        option: { ...parsed, multiplier: SIM_OPTION_MULTIPLIER },
      };
    });
    // Validate the net cash up front so a multi-leg fill is all-or-nothing.
    const netCashDelta = plan.reduce(
      (sum, leg) => sum + (leg.side === 'buy' ? -1 : 1) * leg.price * leg.units * SIM_OPTION_MULTIPLIER,
      0,
    );
    if (round2(account.cashUsd + netCashDelta) < 0 && allowMargin !== true) {
      fail('INSUFFICIENT_CASH', 'sim broker has insufficient cash for mleg fill', {
        cashUsd: round2(account.cashUsd),
        costUsd: round2(-netCashDelta),
      });
    }
    const filledLegs = [];
    for (const leg of plan) {
      fillOne({
        symbol: leg.symbol,
        side: leg.side,
        qty: leg.units,
        priceUsd: leg.price,
        assetClass: 'us_option',
        multiplier: SIM_OPTION_MULTIPLIER,
        option: leg.option,
        groupId,
        structure: input.structure ?? null,
        orderId,
      });
      filledLegs.push({
        symbol: leg.symbol,
        side: leg.side,
        ratioQty: leg.units / spreads,
        qty: leg.units,
        filledQty: leg.units,
        avgFillPriceUsd: leg.price,
        positionIntent: leg.positionIntent,
        status: 'filled',
      });
    }
    const order = normalizeOrder({
      id: orderId,
      clientOrderId: input.clientOrderId ? String(input.clientOrderId) : null,
      symbol: filledLegs[0].symbol,
      side: input.side ?? null,
      qty: spreads,
      filledQty: spreads,
      avgFillPriceUsd: num(input.limitPrice, null),
      status: 'filled',
      submittedAt: marketNow(),
      filledAt: marketNow(),
      type: input.type ?? 'limit',
      assetClass: 'us_option',
      orderClass: 'mleg',
      positionIntent: null,
      limitPrice: num(input.limitPrice, null),
      multiplier: SIM_OPTION_MULTIPLIER,
      groupId,
      structure: input.structure ?? null,
      legs: filledLegs,
      notionalUsd: round2(Math.abs(netCashDelta)),
    });
    account.orders.push(order);
    return { ...order, legs: filledLegs.map((leg) => ({ ...leg })) };
  }

  /**
   * Submit a stock or option order. Stocks support long/short/fractional-long and
   * resting limit orders; options require integer contracts and fill immediately at
   * the limit premium (or the mark for market orders); `orderClass:'mleg'` submits a
   * defined-risk multi-leg option order.
   * @param {{symbol?:string, assetClass?:string, side?:'buy'|'sell', qty?:number,
   *          notional?:number, type?:string, limitPrice?:number, clientOrderId?:string,
   *          timeInForce?:string, positionIntent?:string, orderClass?:string,
   *          legs?:Array<object>, qty?:number, groupId?:string, structure?:string}} input
   * @returns {object}
   */
  function submitOrder(input = {}) {
    if (input.orderClass === 'mleg' || input.orderClass === 'multi_leg') return submitMleg(input);
    const symbol = String(input.symbol ?? '').trim().toUpperCase();
    const isOption = input.assetClass === 'us_option' || isSimOptionSymbol(symbol);
    if (isOption) return submitOption(input, symbol);
    if (!market.symbolStates.has(symbol)) {
      fail('BRAKE_DENIED', `sim broker symbol not whitelisted: ${symbol}`, { symbol });
    }
    const side = String(input.side ?? '').trim().toLowerCase();
    if (side !== 'buy' && side !== 'sell') {
      fail('SPEC_INVALID', 'sim submitOrder side must be buy or sell', { side: input.side });
    }
    const type = input.type ?? 'market';
    const quote = currentQuote(symbol);
    const price = execPrice(side, quote);

    let qty = num(input.qty, null);
    const notional = num(input.notional, null);
    if (qty === null && notional === null) {
      fail('SPEC_INVALID', 'sim submitOrder requires qty or notional', { symbol });
    }
    if (qty === null) qty = round4(notional / price);
    qty = round4(qty);
    if (!(qty > 0)) fail('SPEC_INVALID', 'sim submitOrder qty must be positive', { symbol, qty });

    account.seq += 1;
    const order = normalizeOrder({
      id: `sim-ord-${String(account.seq).padStart(6, '0')}`,
      clientOrderId: input.clientOrderId ? String(input.clientOrderId) : null,
      symbol,
      side,
      qty,
      filledQty: 0,
      avgFillPriceUsd: null,
      status: 'new',
      submittedAt: marketNow(),
      type,
      notionalUsd: 0,
      assetClass: 'us_equity',
      positionIntent: input.positionIntent ?? null,
    });

    if (type === 'market') {
      fill(order, price);
      account.orders.push(order);
      return { ...order };
    }

    if (type !== 'limit') {
      fail('SPEC_INVALID', `sim broker only supports market and limit orders, got ${type}`, { type });
    }
    const limitPrice = num(input.limitPrice, null);
    if (limitPrice === null) fail('SPEC_INVALID', 'sim limit order requires limitPrice', { symbol });
    order.limitPrice = limitPrice;
    order.limitPriceUsd = limitPrice;
    const executable = side === 'buy'
      ? quote.ask <= limitPrice + 1e-9
      : quote.bid >= limitPrice - 1e-9;
    if (executable) fill(order, round4(Math.min(limitPrice, price)));
    account.orders.push({ ...order });
    return { ...order };
  }

  /** Try to fill resting limit orders against the latest bar. */
  function matchRestingOrders() {
    for (const order of account.orders) {
      if (order.status !== 'new' || order.type !== 'limit' || order.limitPriceUsd === undefined) continue;
      const state = market.symbolStates.get(order.symbol);
      if (!state || state.bars.length === 0) continue;
      const bar = state.bars[state.bars.length - 1];
      const crossed = order.side === 'buy' ? bar.l <= order.limitPriceUsd : bar.h >= order.limitPriceUsd;
      if (!crossed) continue;
      try {
        fill(order, order.limitPriceUsd);
      } catch {
        order.status = 'rejected';
      }
    }
  }

  function openStatuses() {
    return new Set(['new', 'accepted', 'pending_new', 'partially_filled']);
  }

  // -------------------------------------------------------------------------
  // contract surface (mirrors broker-alpaca.js exactly)
  // -------------------------------------------------------------------------

  Object.assign(broker, {
    /** @returns {{isOpen:boolean, timestamp:number, nextOpen:number, nextClose:number}} */
    getClock() {
      const now = marketNow();
      return {
        isOpen: true, // sim market is always open; the window brake is separate
        timestamp: now,
        nextOpen: now,
        nextClose: now + 6.5 * HOUR_MS,
      };
    },

    /**
     * Synthetic account with paper-parity capability fields (margin/short/options).
     * @returns {object}
     */
    getAccount() {
      const equity = accountEquityEstimate();
      const cash = round2(account.cashUsd);
      return {
        equityUsd: equity,
        cashUsd: cash,
        buyingPowerUsd: round2(Math.max(0, cash)),
        optionsBuyingPowerUsd: round2(Math.max(0, cash)),
        marginMultiplier: 4,
        shortingEnabled: allowShort,
        optionsTradingLevel: 3,
        longMarketValueUsd: round2(
          [...account.positions.values()].filter((position) => position.qty > 0).reduce((sum, position) => {
            const mark = position.assetClass === 'us_option' ? optionMark(position.symbol) : lastClose(position.symbol);
            return sum + (mark === null ? 0 : position.qty * mark * (position.multiplier || 1));
          }, 0),
        ),
        shortMarketValueUsd: round2(
          [...account.positions.values()].filter((position) => position.qty < 0).reduce((sum, position) => {
            const mark = position.assetClass === 'us_option' ? optionMark(position.symbol) : lastClose(position.symbol);
            return sum + Math.abs(position.qty) * (mark === null ? 0 : mark) * (position.multiplier || 1);
          }, 0),
        ),
        maintenanceMarginUsd: round2(Math.max(0, -cash)),
        status: 'ACTIVE',
        currency: 'USD',
        mode: 'sim',
      };
    },

    /**
     * Normalized positions for stocks (long/short) and options.
     * @returns {Array<object>}
     */
    getPositions() {
      const rows = [];
      for (const [symbol, position] of account.positions) {
        const isOption = position.assetClass === 'us_option';
        const mark = isOption ? optionMark(symbol) : lastClose(symbol);
        const multiplier = position.multiplier || 1;
        const qtySigned = round4(position.qty);
        const marketValue = mark === null ? 0 : round2(qtySigned * mark * multiplier);
        const parsed = isOption ? parseSimOccSymbol(symbol) : null;
        rows.push({
          symbol,
          assetClass: isOption ? 'us_option' : 'us_equity',
          qty: qtySigned,
          qtySigned,
          contracts: isOption ? Math.abs(qtySigned) : undefined,
          avgEntryPriceUsd: position.avgPriceUsd,
          avgPriceUsd: position.avgPriceUsd,
          marketValueUsd: marketValue,
          unrealizedPlUsd: mark === null ? 0 : round2((mark - position.avgPriceUsd) * qtySigned * multiplier),
          side: isOption
            ? (parsed?.type === 'put' ? 'PUT' : 'CALL')
            : qtySigned < 0 ? 'SHORT' : 'LONG',
          multiplier,
          option: parsed
            ? {
                underlying: parsed.underlying,
                type: parsed.type,
                strikeUsd: parsed.strikeUsd,
                expiration: parsed.expiration,
                dte: simDte(parsed.expiration, marketNow()),
              }
            : null,
          groupId: position.groupId ?? null,
          structure: position.structure ?? null,
          openedAt: position.openedAt ?? null,
        });
      }
      return rows;
    },

    /**
     * @param {{status?: string, limit?: number, after?: number|string}} [query]
     * @returns {Array<object>} newest first
     */
    getOrders({ status = 'all', limit = 100, after } = {}) {
      const open = openStatuses();
      let rows = account.orders.filter((order) => {
        if (status === 'open') return open.has(order.status);
        if (status === 'closed') return !open.has(order.status);
        return true;
      });
      if (after !== undefined && after !== null) {
        const afterMs = typeof after === 'number' ? after : Date.parse(String(after));
        if (Number.isFinite(afterMs)) rows = rows.filter((order) => order.submittedAt > afterMs);
      }
      return rows
        .slice(-Math.max(1, Math.min(500, Number(limit) || 100)))
        .reverse()
        .map((order) => ({ ...order, legs: (order.legs ?? []).map((leg) => ({ ...leg })) }));
    },

    /**
     * One order by id (fill reconciliation; includes mleg legs).
     * @param {string} id
     * @returns {object|null}
     */
    getOrder(id) {
      const order = account.orders.find((row) => row.id === String(id ?? ''));
      if (!order) return null;
      return { ...order, legs: (order.legs ?? []).map((leg) => ({ ...leg })) };
    },

    /**
     * Asset permissions (the synthetic account trades every configured symbol).
     * @param {string} symbol
     * @returns {object}
     */
    getAsset(symbol) {
      const ticker = String(symbol ?? '').trim().toUpperCase();
      if (!symbols.includes(ticker)) fail('DATA_MISSING', `sim broker has no asset ${ticker}`, { symbol: ticker });
      return {
        symbol: ticker,
        assetClass: 'us_equity',
        tradable: true,
        shortable: allowShort,
        marginable: allowMargin,
        fractionable: true,
        easyToBorrow: true,
        maintenanceMarginPct: 0.25,
      };
    },

    /**
     * Deterministic option chain for an underlying (contracts offline twin).
     * @param {{underlying: string, type?: 'call'|'put'|'both', expirationGte?: string,
     *   expirationLte?: string, strikeGte?: number, strikeLte?: number, limit?: number}} params
     * @returns {Array<object>}
     */
    getOptionChain({ underlying, type = 'call', expirationGte, expirationLte, strikeGte, strikeLte, limit = 100 } = {}) {
      const ticker = String(underlying ?? '').trim().toUpperCase();
      if (!ticker) fail('DATA_MISSING', 'getOptionChain requires an underlying');
      const normalizedType = String(type ?? '').toLowerCase();
      const types = normalizedType === 'put' ? ['put'] : normalizedType === 'both' ? ['call', 'put'] : ['call'];
      const contracts = [];
      for (const optionType of types) contracts.push(...optionContractsFor(ticker, optionType));
      const gte = expirationGte ? String(expirationGte).slice(0, 10) : null;
      const lte = expirationLte ? String(expirationLte).slice(0, 10) : null;
      const strikeMin = Number.isFinite(Number(strikeGte)) ? Number(strikeGte) : null;
      const strikeMax = Number.isFinite(Number(strikeLte)) ? Number(strikeLte) : null;
      return contracts
        .filter((contract) => (gte === null || contract.expiration >= gte)
          && (lte === null || contract.expiration <= lte)
          && (strikeMin === null || contract.strikeUsd >= strikeMin)
          && (strikeMax === null || contract.strikeUsd <= strikeMax))
        .sort((left, right) => left.expiration.localeCompare(right.expiration) || left.strikeUsd - right.strikeUsd)
        .slice(0, Math.max(1, Math.min(10_000, Number(limit) || 100)));
    },

    /**
     * Synthetic option quote for one OCC contract.
     * @param {string} contractSymbol
     * @returns {object|null}
     */
    getOptionQuote(contractSymbol) {
      return optionQuoteFor(contractSymbol);
    },

    submitOrder,

    /** @param {string} id @returns {{id:string, status:string}} */
    cancelOrder(id) {
      const order = account.orders.find((row) => row.id === String(id ?? ''));
      if (!order) fail('BROKER_ERROR', `sim broker has no order ${id}`, { id });
      if (openStatuses().has(order.status)) order.status = 'canceled';
      return { id: order.id, status: order.status };
    },

    /**
     * @param {{symbols?: string|string[], timeframe?: string, limit?: number}} params
     * @returns {Record<string, Array<{t:number,o:number,h:number,l:number,c:number,v:number}>>}
     */
    getBars({ symbols: wanted, timeframe = '1Hour', limit = 120 } = {}) {
      const list = (Array.isArray(wanted) ? wanted : String(wanted ?? '').split(','))
        .map((s) => String(s ?? '').trim().toUpperCase())
        .filter(Boolean);
      const tickers = list.length > 0 ? [...new Set(list)] : symbols;
      const max = Math.max(1, Math.min(10_000, Number(limit) || 120));
      const out = {};
      for (const symbol of tickers) {
        const state = market.symbolStates.get(symbol);
        // Expose exactly the contract bar shape { t, o, h, l, c, v } (no extras).
        out[symbol] = state
          ? state.bars.slice(-max).map((bar) => ({ t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v }))
          : [];
      }
      return out;
    },

    /**
     * @param {string} symbol
     * @returns {{symbol:string, bid:number, ask:number, last:number, ts:number}}
     */
    getLatestQuote(symbol) {
      return currentQuote(symbol);
    },

    /**
     * Deterministic stock snapshots for the analytics market tape (offline twin of
     * broker-alpaca.getSnapshots). Derived from the simulated quote + the last 24 hourly
     * bars (one synthetic trading day): open/high/low/volume of that window, previous
     * close from the bar before it. Same shape as Alpaca, plus `simulated: true`.
     *
     * @param {string|string[]} [symbols] omitted => the broker's configured universe
     * @param {{feed?: string}} [opts]
     * @returns {Record<string, object>}
     */
    getSnapshots(symbols, { feed = 'iex' } = {}) {
      const requested = (Array.isArray(symbols) ? symbols : typeof symbols === 'string' ? symbols.split(',') : [])
        .map((item) => String(item ?? '').trim().toUpperCase())
        .filter(Boolean);
      const tickers = [...new Set(symbols === undefined ? broker.symbols : requested)];
      const now = marketNow();
      const out = {};
      for (const ticker of tickers) {
        const state = market.symbolStates.get(ticker);
        let quote = null;
        try {
          quote = state ? currentQuote(ticker) : null;
        } catch {
          quote = null;
        }
        if (!state || !quote || state.bars.length === 0) {
          out[ticker] = {
            symbol: ticker, priceUsd: null, bid: null, ask: null, changeUsd: null, changePct: null,
            openUsd: null, highUsd: null, lowUsd: null, prevCloseUsd: null, volume: null,
            ts: null, stale: true, simulated: true, feed,
          };
          continue;
        }
        const dayBars = state.bars.slice(-24);
        const prevBar = state.bars.length > dayBars.length
          ? state.bars[state.bars.length - dayBars.length - 1]
          : null;
        const priceUsd = round4(quote.last);
        const prevCloseUsd = round4(prevBar ? prevBar.c : dayBars[0].o);
        const changeUsd = round4(priceUsd - prevCloseUsd);
        out[ticker] = {
          symbol: ticker,
          priceUsd,
          bid: round4(quote.bid),
          ask: round4(quote.ask),
          changeUsd,
          changePct: prevCloseUsd > 0 ? changeUsd / prevCloseUsd : null,
          openUsd: round4(dayBars[0].o),
          highUsd: round4(Math.max(...dayBars.map((bar) => bar.h))),
          lowUsd: round4(Math.min(...dayBars.map((bar) => bar.l))),
          prevCloseUsd,
          volume: Math.round(dayBars.reduce((total, bar) => total + (Number(bar.v) || 0), 0)),
          ts: now,
          stale: false,
          simulated: true,
          feed,
        };
      }
      return out;
    },

    /**
     * Deterministic synthetic news for the research sidecar (offline twin of
     * broker-alpaca.getNews). Headlines are seeded by market seed + symbol + the
     * simulated hour, so the same seed and simulated time produce identical items.
     *
     * @param {{symbols?: string|string[], limit?: number, start?: string|number,
     *          end?: string|number}} params
     * @returns {Promise<Array<{id:string, headline:string, summary:string, source:string,
     *           url:string|null, symbols:string[], createdAt:number}>>}
     */
    async getNews({ symbols: wanted, limit = 6, start, end } = {}) {
      const requested = (Array.isArray(wanted) ? wanted : typeof wanted === 'string' ? wanted.split(',') : [])
        .map((item) => String(item ?? '').trim().toUpperCase())
        .filter(Boolean);
      // Explicit empty list => no news; omitted list => the broker's configured universe.
      const tickers = [...new Set(wanted === undefined ? symbols : requested)]
        .filter((ticker) => market.symbolStates.has(ticker));
      if (tickers.length === 0) return [];
      const effectiveLimit = Math.max(1, Math.min(20, Number(limit) || 6));
      const startMs = newsFilterMs(start);
      const endMs = newsFilterMs(end);
      const now = marketNow();
      const bucket = Math.floor(now / HOUR_MS);
      const items = [];
      for (const ticker of tickers) {
        // Fresh PRNG per symbol+bucket: deterministic, and independent of call order.
        const rng = mulberry32(fnv1a(`${market.seed}:${ticker}:${bucket}`));
        for (let index = 0; index < effectiveLimit; index += 1) {
          const template = NEWS_TEMPLATES[Math.floor(rng() * NEWS_TEMPLATES.length) % NEWS_TEMPLATES.length];
          const minutesAgo = 3 + index * 17 + Math.floor(rng() * 9);
          const createdAt = now - minutesAgo * 60 * 1000;
          if (startMs !== null && createdAt < startMs) continue;
          if (endMs !== null && createdAt > endMs) continue;
          items.push({
            id: `sim-news-${ticker}-${bucket}-${index}`,
            headline: template.headline.replace('{symbol}', ticker),
            summary: template.summary.replace('{symbol}', ticker),
            source: 'Simulated Wire',
            url: null,
            symbols: [ticker],
            createdAt,
          });
        }
      }
      items.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
      return items.slice(0, effectiveLimit);
    },

    /** Optional helper mirroring broker-alpaca. */
    getDayBars(symbol, { limit = 120 } = {}) {
      const timeframe = config.data?.timeframe ?? '1Hour';
      return broker.getBars({ symbols: [symbol], timeframe, limit });
    },

    /**
     * The sim data URL recorded as hypothesis proof (clearly non-networked).
     * @param {{symbols: string|string[], timeframe?: string, limit?: number}} params
     * @returns {string}
     */
    getDataUrl({ symbols: wanted, timeframe = '1Hour', limit = 120 } = {}) {
      const list = (Array.isArray(wanted) ? wanted : String(wanted ?? '').split(','))
        .map((s) => String(s ?? '').trim().toUpperCase())
        .filter(Boolean);
      const url = new URL('/v2/stocks/bars', 'sim://data.alpaca.markets');
      url.searchParams.set('symbols', list.join(','));
      url.searchParams.set('timeframe', String(timeframe));
      url.searchParams.set('limit', String(limit));
      url.searchParams.set('adjustment', 'raw');
      url.searchParams.set('feed', 'iex');
      url.searchParams.set('sim', '1');
      url.searchParams.set('seed', String(market.seed));
      return url.toString();
    },

    // ---------------------------------------------------------------------
    // market helpers (sim-only; used by tests + simulate.js)
    // ---------------------------------------------------------------------

    /** Readonly capability summary for status/debug output. */
    describe() {
      return {
        kind: 'sim',
        mode: 'sim',
        seed: market.seed,
        instruments: {
          options: true,
          shortStock: allowShort,
          margin: allowMargin,
          maxMarginPctEquity,
          optionExpiryDays: [...optionExpiryDays],
          optionDataFeed: optionFeed,
          structures: ['long_call', 'long_put', 'covered_call', 'call_credit_spread', 'put_credit_spread', 'bull_call_spread', 'bear_put_spread'],
        },
      };
    },

    /** Advance the synthetic market by `bars` hourly bars; fills resting limits. */
    advanceBar(bars = 1) {
      const steps = Math.max(1, Math.floor(Number(bars) || 1));
      for (let step = 0; step < steps; step += 1) {
        for (const state of market.symbolStates.values()) nextBar(state);
        market.nowMs += HOUR_MS;
        matchRestingOrders();
      }
      return broker;
    },

    /** Alias used by simulate.js: advance exactly one bar. */
    advanceBars(bars = 1) {
      return broker.advanceBar(bars);
    },

    /** Simulated market clock in epoch ms. */
    marketNow,

    /** Current bar index (0-based) for the generated series. */
    barIndex() {
      const state = market.symbolStates.get(symbols[0]);
      return state ? state.bars.length - 1 : -1;
    },

    /**
     * Deterministic quote overrides for tests/executor scenarios.
     * `setQuoteOverrides({ AAPL: { bid, ask, last } })`; entries set to null clear.
     * @param {Record<string, {bid?:number, ask?:number, last?:number, ts?:number}|null>} overrides
     */
    setQuoteOverrides(overrides = {}) {
      for (const [symbol, value] of Object.entries(overrides ?? {})) {
        const ticker = String(symbol).toUpperCase();
        if (value === null || value === undefined) quoteOverrides.delete(ticker);
        else quoteOverrides.set(ticker, { ...value });
      }
      return broker;
    },

    /** Remove all quote overrides. */
    clearQuoteOverrides() {
      quoteOverrides = new Map();
      return broker;
    },

    /** The state the sim broker is currently quoting (for debugging/tests). */
    snapshot() {
      return {
        seed: market.seed,
        barIndex: broker.barIndex(),
        now: marketNow(),
        account: broker.getAccount(),
        positions: broker.getPositions(),
        orders: account.orders.map((order) => ({ ...order })),
        quoteOverrides: Object.fromEntries(quoteOverrides),
      };
    },

    /**
     * Re-seed just the market (account/orders untouched). Test helper.
     * @param {number|{seed?: number}} seed
     */
    setMarket(seed) {
      const nextSeed = num(typeof seed === 'object' ? seed?.seed : seed, baseSeed);
      initMarket(nextSeed);
      return broker;
    },

    /** Full reset: original seed, fresh account, no orders, no overrides. */
    reset() {
      market = null;
      account = null;
      quoteOverrides = new Map();
      initMarket(baseSeed);
      initAccount();
      return broker;
    },
  });

  return broker;
}

export default createBroker;
