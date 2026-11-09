/**
 * Alpaca broker client (market side) — dependency-free REST over global `fetch`.
 *
 * Safety surface (brake D1): this file deliberately implements ONLY market/account
 * READS plus order submission/cancellation. There is no transfer, withdrawal, ACH,
 * wire, crypto, account-configuration, or margin-enablement method here, and no way
 * to add one from config. Their absence is the wall.
 *
 * Data reads include the advisory news feed (`getNews`) used by the isolated research
 * sidecar — read-only, never a trading capability.
 *
 * The client never logs or returns key material. All timestamps are normalized to
 * epoch milliseconds and all broker numbers to JavaScript floats.
 *
 * Contract: docs/CONTRACTS.md § "Broker interface".
 * Owner: market teammate. Do not edit from other modules.
 *
 * @module broker-alpaca
 */

import { fail } from './contracts.js';
import { resolveCredentials, DATA_BASE_URL } from './config.js';
import { sleep } from './util.js';

/** Request timeout enforced with AbortSignal.timeout(ms). */
export const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 2_000;
const BODY_SNIPPET_LIMIT = 280;

// ---------------------------------------------------------------------------
// parsing helpers (Alpaca returns numbers as JSON strings and timestamps as ISO)
// ---------------------------------------------------------------------------

/**
 * Parse a broker numeric field into a float. Returns `fallback` for null/invalid.
 * @param {unknown} value
 * @param {number|null} [fallback]
 * @returns {number|null}
 */
export function parseNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Parse an ISO-8601 timestamp (or epoch seconds / milliseconds) to epoch ms.
 * @param {unknown} value
 * @returns {number|null}
 */
export function parseTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // Alpaca always returns ISO strings; tolerate epoch seconds if a test feeds them.
    return Math.round(value < 1e12 ? value * 1000 : value);
  }
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {string|string[]} symbols
 * @returns {string[]} deduped upper-case tickers
 */
export function normalizeSymbols(symbols) {
  const list = Array.isArray(symbols) ? symbols : String(symbols ?? '').split(',');
  const out = [];
  for (const raw of list) {
    const symbol = String(raw ?? '').trim().toUpperCase();
    if (symbol && !out.includes(symbol)) out.push(symbol);
  }
  return out;
}

/** Milliseconds for one Alpaca timeframe string ("1Hour", "5Min", "1Day", ...). */
export function timeframeToMs(timeframe) {
  const match = /^(\d+)(Min|Hour|Day|Week|Month)$/.exec(String(timeframe ?? '').trim());
  if (!match) return 60 * 60 * 1000;
  const count = Number(match[1]);
  const unitMs = {
    Min: 60 * 1000,
    Hour: 60 * 60 * 1000,
    Day: 24 * 60 * 60 * 1000,
    Week: 7 * 24 * 60 * 60 * 1000,
    Month: 30 * 24 * 60 * 60 * 1000,
  }[match[2]];
  return count * unitMs;
}

/** Round an option premium/mark to a sane 4dp grid (avoid float dust from mid prices). */
function roundQuotePrice(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 10_000) / 10_000 : null;
}

/** Truncate a response body to something safe for error details/traces. */
export function bodySnippet(text) {
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > BODY_SNIPPET_LIMIT ? `${clean.slice(0, BODY_SNIPPET_LIMIT)}...` : clean;
}

function headerNumber(headers, name) {
  if (!headers || typeof headers.get !== 'function') return null;
  const value = headers.get(name);
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function retryDelayMs(response) {
  const retryAfter = headerNumber(response?.headers, 'retry-after');
  if (retryAfter !== null) {
    // Alpaca sends seconds; a cap keeps a bad header from stalling a cycle.
    return Math.min(MAX_RETRY_DELAY_MS, Math.max(RETRY_DELAY_MS, Math.round(retryAfter * 1000)));
  }
  return RETRY_DELAY_MS;
}

/** Milliseconds in one day (option DTE math). */
const DAY_MS = 24 * 60 * 60 * 1000;
/** Options multiplier: one contract covers 100 shares. */
export const OPTION_MULTIPLIER = 100;

/** True when a symbol looks like an OCC option symbol (e.g. F260116C00013000). */
export function isOptionSymbol(symbol) {
  return /^[A-Z]{1,6}\d{6}[CP]\d{8}$/.test(String(symbol ?? '').toUpperCase());
}

/**
 * Parse an OCC option symbol into its parts.
 * `F260116C00013000` -> { underlying:'F', expiration:'2026-01-16', type:'call', strikeUsd:13 }
 * @param {string} symbol
 * @returns {{underlying:string, expiration:string, type:'call'|'put', strikeUsd:number, symbol:string}|null}
 */
export function parseOccSymbol(symbol) {
  const text = String(symbol ?? '').trim().toUpperCase();
  const match = /^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(text);
  if (!match) return null;
  const year = 2000 + Number(match[2]);
  const month = Number(match[3]);
  const day = Number(match[4]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  const strikeUsd = Number(match[6]) / 1000;
  if (!Number.isFinite(strikeUsd) || strikeUsd <= 0) return null;
  return {
    symbol: text,
    underlying: match[1],
    expiration: `${year}-${mm}-${dd}`,
    type: match[5] === 'C' ? 'call' : 'put',
    strikeUsd: Math.round(strikeUsd * 1000) / 1000,
  };
}

/**
 * Build an OCC option symbol from normalized parts.
 * @param {{underlying:string, expiration:string, type:'call'|'put', strikeUsd:number}} contract
 * @returns {string}
 */
export function formatOccSymbol({ underlying, expiration, type, strikeUsd }) {
  const symbol = String(underlying ?? '').trim().toUpperCase();
  const fullDate = String(expiration ?? '').slice(0, 10).replace(/-/g, '');
  const date = fullDate.slice(2); // OCC uses YYMMDD
  if (!/^[A-Z]{1,6}$/.test(symbol) || !/^\d{6}$/.test(date)) return '';
  const suffix = String(type ?? '').toLowerCase() === 'put' ? 'P' : 'C';
  const strike = Math.round(Number(strikeUsd) * 1000);
  if (!Number.isFinite(strike) || strike <= 0) return '';
  return `${symbol}${date}${suffix}${String(strike).padStart(8, '0')}`;
}

/** Whole days from `nowMs` until an option expiration date (`YYYY-MM-DD`, UTC). */
export function daysToExpiration(expiration, nowMs = Date.now()) {
  const expiryMs = Date.parse(`${String(expiration ?? '').slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(expiryMs) || !Number.isFinite(Number(nowMs))) return null;
  return Math.max(0, Math.ceil((expiryMs - Number(nowMs)) / DAY_MS));
}

/** Derive a UI/reconciliation side label from an asset class + signed quantity. */
export function sideLabelFor({ assetClass, qtySigned, symbol }) {
  if (String(assetClass ?? '').toLowerCase() === 'us_option' || isOptionSymbol(symbol)) {
    const parsed = parseOccSymbol(symbol);
    return parsed?.type === 'put' ? 'PUT' : 'CALL';
  }
  return Number(qtySigned) < 0 ? 'SHORT' : 'LONG';
}

/** Snapshot prices older than this are flagged `stale` for the market tape. */
export const SNAPSHOT_STALE_MS = 10 * 60 * 1000;

/**
 * Map one raw Alpaca stock snapshot to the analytics shape used by the market tape.
 *
 * Alpaca fields used: `latestTrade.p` (price), `latestQuote.bp/ap` (NBBO),
 * `minuteBar`/`dailyBar` for o/h/l/v, `prevDailyBar.c` for the previous close.
 * Unknown/missing parts become null; the item is never dropped.
 *
 * @param {unknown} raw one entry of GET /v2/stocks/snapshots
 * @param {number} nowMs used for the `stale` flag
 * @param {string} [symbol]
 * @returns {{symbol:string, priceUsd:number|null, bid:number|null, ask:number|null,
 *            changeUsd:number|null, changePct:number|null, openUsd:number|null,
 *            highUsd:number|null, lowUsd:number|null, prevCloseUsd:number|null,
 *            volume:number|null, ts:number|null, stale:boolean}}
 */
export function mapSnapshot(raw, nowMs = Date.now(), symbol = '') {
  const snapshot = raw && typeof raw === 'object' ? raw : {};
  const trade = snapshot.latestTrade && typeof snapshot.latestTrade === 'object' ? snapshot.latestTrade : {};
  const quote = snapshot.latestQuote && typeof snapshot.latestQuote === 'object' ? snapshot.latestQuote : {};
  const minute = snapshot.minuteBar && typeof snapshot.minuteBar === 'object' ? snapshot.minuteBar : {};
  const daily = snapshot.dailyBar && typeof snapshot.dailyBar === 'object' ? snapshot.dailyBar : {};
  const prevDaily = snapshot.prevDailyBar && typeof snapshot.prevDailyBar === 'object' ? snapshot.prevDailyBar : {};
  const priceUsd = parseNumber(trade.p, parseNumber(minute.c, parseNumber(daily.c, null)));
  const bid = parseNumber(quote.bp, null);
  const ask = parseNumber(quote.ap, null);
  const prevCloseUsd = parseNumber(prevDaily.c, null);
  const changeUsd = priceUsd !== null && prevCloseUsd !== null
    ? Math.round((priceUsd - prevCloseUsd) * 10_000) / 10_000
    : null;
  const changePct = changeUsd !== null && prevCloseUsd !== null && prevCloseUsd > 0
    ? changeUsd / prevCloseUsd
    : null;
  const ts = parseTimestamp(trade.t)
    ?? parseTimestamp(quote.t)
    ?? parseTimestamp(minute.t)
    ?? parseTimestamp(daily.t)
    ?? null;
  const stale = ts === null || (Number.isFinite(Number(nowMs)) && Number(nowMs) - ts > SNAPSHOT_STALE_MS);
  return {
    symbol: String(symbol ?? snapshot.symbol ?? '').trim().toUpperCase(),
    priceUsd,
    bid,
    ask,
    changeUsd,
    changePct,
    openUsd: parseNumber(daily.o, parseNumber(minute.o, null)),
    highUsd: parseNumber(daily.h, parseNumber(minute.h, null)),
    lowUsd: parseNumber(daily.l, parseNumber(minute.l, null)),
    prevCloseUsd,
    volume: parseNumber(daily.v, parseNumber(minute.v, null)),
    ts,
    stale,
  };
}

/** Map one raw Alpaca mleg leg to the contract leg shape. */
export function mapLeg(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    symbol: String(raw.symbol ?? '').toUpperCase(),
    side: raw.side ?? null,
    ratioQty: parseNumber(raw.ratio_qty, 1),
    qty: parseNumber(raw.qty, 0),
    filledQty: parseNumber(raw.filled_qty ?? raw.ratio_qty, 0),
    avgFillPriceUsd: parseNumber(raw.filled_avg_price, null),
    positionIntent: raw.position_intent ?? null,
    status: raw.status ?? null,
  };
}

/** Map a raw Alpaca order to the contract order shape. */
export function mapOrder(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const symbol = String(raw.symbol ?? '').toUpperCase();
  const assetClass = String(raw.asset_class ?? raw.assetClass ?? (isOptionSymbol(symbol) ? 'us_option' : 'us_equity')).toLowerCase();
  const legs = Array.isArray(raw.legs) ? raw.legs.map(mapLeg).filter(Boolean) : [];
  return {
    id: raw.id ?? null,
    clientOrderId: raw.client_order_id ?? null,
    symbol,
    side: raw.side ?? null,
    qty: parseNumber(raw.qty, 0),
    filledQty: parseNumber(raw.filled_qty, 0),
    avgFillPriceUsd: parseNumber(raw.filled_avg_price, null),
    filledAvgPriceUsd: parseNumber(raw.filled_avg_price, null),
    status: raw.status ?? null,
    submittedAt: parseTimestamp(raw.submitted_at),
    filledAt: parseTimestamp(raw.filled_at),
    type: raw.type ?? null,
    notionalUsd: parseNumber(raw.notional, null),
    assetClass,
    orderClass: raw.order_class ?? raw.orderClass ?? 'simple',
    positionIntent: raw.position_intent ?? null,
    timeInForce: raw.time_in_force ?? null,
    legs,
    limitPrice: parseNumber(raw.limit_price, null),
  };
}

/** Map a raw Alpaca bar to the contract bar shape (t = epoch ms). */
export function mapBar(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const t = parseTimestamp(raw.t);
  if (t === null) return null;
  return {
    t,
    o: parseNumber(raw.o, 0),
    h: parseNumber(raw.h, 0),
    l: parseNumber(raw.l, 0),
    c: parseNumber(raw.c, 0),
    v: parseNumber(raw.v, 0),
  };
}

/** Map a raw Alpaca position to the multi-instrument position shape. */
export function mapPosition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const symbol = String(raw.symbol ?? '').toUpperCase();
  const assetClass = String(raw.asset_class ?? raw.assetClass ?? (isOptionSymbol(symbol) ? 'us_option' : 'us_equity')).toLowerCase();
  const option = isOptionSymbol(symbol) ? parseOccSymbol(symbol) : null;
  const isOption = assetClass === 'us_option' || Boolean(option);
  // Alpaca reports signed qty for short stock and contract counts for options.
  const qtySigned = parseNumber(raw.qty, 0);
  const multiplier = isOption ? parseNumber(raw.multiplier, OPTION_MULTIPLIER) ?? OPTION_MULTIPLIER : 1;
  return {
    symbol,
    assetClass,
    qty: qtySigned,
    qtySigned,
    contracts: isOption ? Math.abs(qtySigned) : undefined,
    avgEntryPriceUsd: parseNumber(raw.avg_entry_price, null),
    avgPriceUsd: parseNumber(raw.avg_entry_price, null),
    marketValueUsd: parseNumber(raw.market_value, null),
    unrealizedPlUsd: parseNumber(raw.unrealized_pl, null),
    side: sideLabelFor({ assetClass, qtySigned, symbol }),
    multiplier,
    option,
  };
}

/** Map a raw Alpaca asset to the permissions shape the instruments layer needs. */
export function mapAsset(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const maintenance = parseNumber(raw.maintenance_margin_requirement, null);
  return {
    symbol: String(raw.symbol ?? '').toUpperCase(),
    assetClass: String(raw.class ?? raw.asset_class ?? 'us_equity').toLowerCase(),
    tradable: raw.tradable === true,
    shortable: raw.shortable === true,
    marginable: raw.marginable === true,
    fractionable: raw.fractionable === true,
    easyToBorrow: raw.easy_to_borrow === true,
    maintenanceMarginPct: maintenance === null ? null : maintenance > 1 ? maintenance / 100 : maintenance,
  };
}

/**
 * Map one raw Alpaca option contract to the normalized chain shape.
 * @param {unknown} raw
 * @param {number} nowMs used for deterministic DTE
 */
export function mapOptionContract(raw, nowMs = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const symbol = String(raw.symbol ?? '').toUpperCase();
  const parsed = parseOccSymbol(symbol);
  const expiration = String(raw.expiration_date ?? parsed?.expiration ?? '').slice(0, 10);
  if (!expiration) return null;
  const type = String(raw.type ?? parsed?.type ?? '').toLowerCase() === 'put' ? 'put' : 'call';
  const strikeUsd = parseNumber(raw.strike_price, parsed?.strikeUsd ?? null);
  if (!Number.isFinite(strikeUsd)) return null;
  return {
    symbol,
    id: raw.id ?? null,
    underlying: String(raw.underlying_symbol ?? parsed?.underlying ?? '').toUpperCase(),
    type,
    strikeUsd,
    expiration,
    dte: daysToExpiration(expiration, nowMs),
    multiplier: parseNumber(raw.multiplier, OPTION_MULTIPLIER) ?? OPTION_MULTIPLIER,
    tradable: raw.tradable !== false,
    closePriceUsd: parseNumber(raw.close_price, null),
    openInterest: parseNumber(raw.open_interest, null),
  };
}

/**
 * Map one raw Alpaca news item to the research-sidecar news shape.
 * Returns null for an unusable item (empty headline / unparseable timestamp); a single
 * bad item must never break the feed.
 * @param {unknown} raw
 * @returns {{id:string, headline:string, summary:string, source:string, url:string|null,
 *            symbols:string[], createdAt:number}|null}
 */
export function mapNewsItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const headline = typeof raw.headline === 'string' ? raw.headline.trim() : '';
  if (headline === '') return null; // empty headlines are not news
  const createdAt = parseTimestamp(raw.created_at ?? raw.createdAt);
  if (createdAt === null) return null;
  const rawSymbols = Array.isArray(raw.symbols)
    ? raw.symbols
    : typeof raw.symbols === 'string'
      ? raw.symbols.split(',')
      : [];
  const symbols = rawSymbols
    .map((item) => String(item ?? '').trim().toUpperCase())
    .filter((item) => item !== '');
  return {
    id: raw.id !== null && raw.id !== undefined && String(raw.id).trim() !== ''
      ? String(raw.id)
      : `${createdAt}:${headline.slice(0, 48)}`,
    headline,
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    source: typeof raw.source === 'string' ? raw.source : '',
    url: typeof raw.url === 'string' && raw.url.trim() !== '' ? raw.url : null,
    symbols,
    createdAt,
  };
}

/** Normalize a news start/end filter (epoch ms or ISO string) to a request ISO string. */
function isoParam(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const ms = parseTimestamp(value);
  return ms === null ? String(value) : new Date(ms).toISOString();
}

/** Normalize a news start/end filter to epoch ms for client-side filtering. */
function filterMs(value) {
  if (value === undefined || value === null || value === '') return null;
  return parseTimestamp(value);
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

/**
 * Create an Alpaca REST broker.
 *
 * Credentials resolve lazily from `resolveCredentials(config, secrets)` so that
 * constructing the client never throws before the engine is ready; the first real
 * request surfaces CONFIG_INVALID / LIVE_NOT_ARMED / BROKER_AUTH as appropriate.
 *
 * @param {object} config AUTOMATON config (mode must be 'paper' or 'live')
 * @param {{
 *   secrets?: Record<string,string>,
 *   credentials?: { keyId: string, secretKey: string, baseUrl: string, dataBaseUrl?: string },
 *   fetchImpl?: typeof fetch,
 *   sleepImpl?: (ms: number) => Promise<void>,
 * }} [options]
 * @returns {object} broker with kind 'alpaca'
 */
export function createBroker(config, options = {}) {
  if (!config || typeof config !== 'object') {
    fail('CONFIG_INVALID', 'broker-alpaca requires a config object');
  }
  if (config.mode === 'sim') {
    fail('CONFIG_INVALID', 'mode=sim uses broker-sim.js, not broker-alpaca.js');
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    fail('CONFIG_INVALID', 'broker-alpaca requires global fetch (Node >= 22) or a fetchImpl');
  }
  const sleepImpl = options.sleepImpl ?? sleep;
  const mode = config.mode;
  /** @type {ReturnType<typeof resolveCredentials>|null} */
  let credentials = options.credentials ?? null;
  /** Brief per-underlying chain-snapshot cache (one snapshot feed per cycle, not per leg). */
  const optionSnapshotCache = new Map();
  /** Brief per-symbol-set stock snapshot cache (2 s) so cycles share one market read. */
  const stockSnapshotCache = new Map();
  const STOCK_SNAPSHOT_TTL_MS = 2_000;

  function creds() {
    if (!credentials) {
      credentials = resolveCredentials(config, options.secrets ?? {});
    }
    return credentials;
  }

  /**
   * One HTTP round-trip with the contract's retry + error mapping.
   * Retries idempotent requests once on 429/5xx and POSTs once on 429 only
   * (a blind POST retry on 5xx could duplicate an order that was already accepted).
   */
  async function request(pathname, { method = 'GET', query = null, body, dataHost = false, attempt = 0 } = {}) {
    const resolved = creds();
    const base = dataHost ? resolved.dataBaseUrl || DATA_BASE_URL : resolved.baseUrl;
    if (!base) {
      fail('CONFIG_INVALID', `no ${dataHost ? 'data' : 'broker'} endpoint for mode=${mode}`);
    }
    const url = new URL(pathname, base);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(key, String(value));
      }
    }
    const headers = {
      'APCA-API-KEY-ID': resolved.keyId,
      'APCA-API-SECRET-KEY': resolved.secretKey,
      accept: 'application/json',
    };
    /** @type {RequestInit} */
    const init = { method, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetchImpl(url.toString(), init);
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      fail(
        'BROKER_ERROR',
        timedOut
          ? `Alpaca ${method} ${url.pathname} timed out after ${REQUEST_TIMEOUT_MS}ms`
          : `Alpaca ${method} ${url.pathname} failed: ${error?.message ?? String(error)}`,
        { method, path: url.pathname, cause: error?.name ?? 'network', mode },
      );
    }

    const status = Number(response.status);
    const text = typeof response.text === 'function' ? await response.text() : '';
    if (status >= 200 && status < 300) {
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        fail('BROKER_ERROR', `Alpaca ${method} ${url.pathname} returned invalid JSON`, {
          status,
          method,
          path: url.pathname,
        });
      }
    }

    const retryable = status === 429 || (status >= 500 && status <= 599);
    const idempotent = method === 'GET' || method === 'DELETE';
    if (retryable && attempt === 0 && (status === 429 || idempotent)) {
      await sleepImpl(status === 429 ? retryDelayMs(response) : RETRY_DELAY_MS);
      return request(pathname, { method, query, body, dataHost, attempt: attempt + 1 });
    }

    const detail = { status, method, path: url.pathname, body: bodySnippet(text), mode };
    if (status === 401 || status === 403) {
      fail('BROKER_AUTH', `Alpaca rejected credentials (${status})`, detail);
    }
    if (status === 429) {
      fail('BROKER_RATE_LIMIT', 'Alpaca rate limit exceeded', {
        ...detail,
        retryAfterSec: headerNumber(response.headers, 'retry-after'),
      });
    }
    fail('BROKER_ERROR', `Alpaca ${method} ${url.pathname} failed (${status})`, detail);
  }

  const broker = {
    kind: 'alpaca',
    mode,

    /** @returns {Promise<{isOpen:boolean, timestamp:number|null, nextOpen:number|null, nextClose:number|null}>} */
    async getClock() {
      const raw = await request('/v2/clock');
      return {
        isOpen: raw?.is_open === true,
        timestamp: parseTimestamp(raw?.timestamp),
        nextOpen: parseTimestamp(raw?.next_open),
        nextClose: parseTimestamp(raw?.next_close),
      };
    },

    /**
     * Account snapshot including margin/short/options capability fields.
     * @returns {Promise<{equityUsd:number, cashUsd:number, buyingPowerUsd:number,
     *   optionsBuyingPowerUsd:number, marginMultiplier:number, shortingEnabled:boolean,
     *   optionsTradingLevel:number, longMarketValueUsd:number, shortMarketValueUsd:number,
     *   maintenanceMarginUsd:number, status:string, currency:string, mode:string}>}
     */
    async getAccount() {
      const raw = await request('/v2/account');
      const buyingPowerUsd = parseNumber(raw?.buying_power, 0);
      return {
        equityUsd: parseNumber(raw?.equity, 0),
        cashUsd: parseNumber(raw?.cash, 0),
        buyingPowerUsd,
        optionsBuyingPowerUsd: parseNumber(raw?.options_buying_power, buyingPowerUsd),
        marginMultiplier: parseNumber(raw?.multiplier ?? raw?.margin_multiplier, 1),
        shortingEnabled: raw?.shorting_enabled === true,
        optionsTradingLevel: parseNumber(raw?.options_trading_level, 0),
        longMarketValueUsd: parseNumber(raw?.long_market_value, null),
        shortMarketValueUsd: parseNumber(raw?.short_market_value, null),
        maintenanceMarginUsd: parseNumber(raw?.maintenance_margin, null),
        status: raw?.status ?? 'UNKNOWN',
        currency: raw?.currency ?? 'USD',
        mode,
      };
    },

    /**
     * Normalized positions for stocks (long/short) and options.
     * @returns {Promise<Array<object>>}
     */
    async getPositions() {
      const raw = await request('/v2/positions');
      const rows = Array.isArray(raw) ? raw : [];
      return rows.map(mapPosition).filter(Boolean);
    },

    /**
     * Asset permissions for the instrument gates (tradable/shortable/marginable).
     * @param {string} symbol
     * @returns {Promise<object>}
     */
    async getAsset(symbol) {
      const ticker = String(symbol ?? '').trim().toUpperCase();
      if (!ticker) fail('DATA_MISSING', 'getAsset requires a symbol');
      const raw = await request(`/v2/assets/${encodeURIComponent(ticker)}`);
      const asset = mapAsset(raw);
      if (!asset) fail('DATA_MISSING', `Alpaca returned no asset for ${ticker}`, { symbol: ticker });
      return asset;
    },

    /**
     * @param {{status?: string, limit?: number, after?: string, direction?: 'asc'|'desc', symbols?: string}} [query]
     * @returns {Promise<Array<object>>}
     */
    async getOrders({ status = 'all', limit = 100, after, direction = 'desc', symbols } = {}) {
      const raw = await request('/v2/orders', {
        query: { status, limit: Math.max(1, Math.min(500, Number(limit) || 100)), after, direction, symbols },
      });
      const rows = Array.isArray(raw) ? raw : [];
      return rows.map(mapOrder).filter(Boolean);
    },

    /**
     * One order by id (fill reconciliation; includes mleg legs).
     * @param {string} id
     * @returns {Promise<object|null>}
     */
    async getOrder(id) {
      if (!id) fail('SPEC_INVALID', 'getOrder requires an order id');
      const raw = await request(`/v2/orders/${encodeURIComponent(String(id))}`);
      return mapOrder(raw);
    },

    /**
     * Option contract chain (contracts endpoint on the trading host).
     * @param {{underlying: string, type?: 'call'|'put'|'both', expirationGte?: string,
     *          expirationLte?: string, strikeGte?: number, strikeLte?: number, limit?: number}} params
     * @param {{nowMs?: number}} [opts] deterministic DTE injection point for tests
     * @returns {Promise<Array<object>>} normalized contracts sorted by expiration, strike
     */
    async getOptionChain({ underlying, type = 'call', expirationGte, expirationLte, strikeGte, strikeLte, limit = 100 } = {}, { nowMs } = {}) {
      const symbol = String(underlying ?? '').trim().toUpperCase();
      if (!symbol) fail('DATA_MISSING', 'getOptionChain requires an underlying');
      const optionType = String(type ?? '').toLowerCase();
      const query = {
        underlying_symbols: symbol,
        status: 'active',
        limit: Math.max(1, Math.min(10_000, Number(limit) || 100)),
        expiration_date_gte: expirationGte,
        expiration_date_lte: expirationLte,
        strike_price_gte: strikeGte,
        strike_price_lte: strikeLte,
      };
      if (optionType === 'call' || optionType === 'put') query.type = optionType;
      const raw = await request('/v2/options/contracts', { query });
      const rows = Array.isArray(raw?.option_contracts) ? raw.option_contracts : Array.isArray(raw) ? raw : [];
      const effectiveNow = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
      return rows
        .map((row) => mapOptionContract(row, effectiveNow))
        .filter(Boolean)
        .sort((left, right) => left.expiration.localeCompare(right.expiration) || left.strikeUsd - right.strikeUsd);
    },

    /**
     * Latest option quote from the chain snapshot endpoint (indicative by default).
     * The underlying chain snapshot is cached briefly so one execution cycle makes one
     * request instead of one per contract/leg.
     * @param {string} contractSymbol OCC symbol
     * @param {{feed?: string, nowMs?: number, forceRefresh?: boolean}} [opts]
     * @returns {Promise<object|null>} {symbol, underlying, type, strikeUsd, expiration, dte, multiplier, bid, ask, last, mark, ts}
     */
    async getOptionQuote(contractSymbol, { feed, nowMs, forceRefresh = false } = {}) {
      const parsed = parseOccSymbol(contractSymbol);
      if (!parsed) fail('DATA_MISSING', `not an OCC option symbol: ${contractSymbol}`, { symbol: contractSymbol });
      const effectiveFeed = feed ?? config.instruments?.optionDataFeed ?? 'indicative';
      const effectiveNow = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
      const cacheKey = `${parsed.underlying}:${effectiveFeed}`;
      const cached = optionSnapshotCache.get(cacheKey);
      const TTL_MS = 5_000;
      let snapshot = null;
      if (!forceRefresh && cached && Math.abs(effectiveNow - cached.at) < TTL_MS) {
        snapshot = cached.snapshot;
      } else {
        const raw = await request(`/v1beta1/options/snapshots/${encodeURIComponent(parsed.underlying)}`, {
          dataHost: true,
          query: { limit: 1000, feed: effectiveFeed },
        });
        snapshot = raw?.snapshots && typeof raw.snapshots === 'object' ? raw.snapshots : {};
        optionSnapshotCache.set(cacheKey, { at: effectiveNow, snapshot });
      }
      const entry = snapshot?.[parsed.symbol] ?? snapshot?.[String(contractSymbol).toUpperCase()] ?? null;
      const quote = entry?.latestQuote && typeof entry.latestQuote === 'object' ? entry.latestQuote : {};
      const trade = entry?.latestTrade && typeof entry.latestTrade === 'object' ? entry.latestTrade : {};
      const daily = entry?.dailyBar && typeof entry.dailyBar === 'object' ? entry.dailyBar : {};
      const bid = parseNumber(quote.bp, null);
      const ask = parseNumber(quote.ap, null);
      const last = parseNumber(trade.p, parseNumber(daily.c, null));
      const mark = bid !== null && ask !== null ? roundQuotePrice((bid + ask) / 2) : last;
      return {
        symbol: parsed.symbol,
        underlying: parsed.underlying,
        type: parsed.type,
        strikeUsd: parsed.strikeUsd,
        expiration: parsed.expiration,
        dte: daysToExpiration(parsed.expiration, effectiveNow),
        multiplier: OPTION_MULTIPLIER,
        bid,
        ask,
        last,
        mark,
        ts: parseTimestamp(quote.t ?? trade.t),
        simulated: false,
      };
    },

    /**
     * Submit an order for stocks (long or short) or options (single leg or mleg).
     *
     * - stocks: fractional qty supported; a short sale is a plain `sell` (no intent field).
     * - options: `qty` = integer contracts, `limitPrice` = premium per share; a
     *   `positionIntent` (buy_to_open|sell_to_open|buy_to_close|sell_to_close) is sent.
     * - multi-leg: `orderClass:'mleg'` + `legs:[{symbol, side, ratioQty, positionIntent}]`,
     *   submitted as one limit order with a net `limitPrice` (no top-level symbol/qty).
     *
     * @param {{symbol?:string, assetClass?:string, side?:'buy'|'sell', qty?:number,
     *   notional?:number, type?:string, limitPrice?:number, clientOrderId?:string,
     *   timeInForce?:string, positionIntent?:string, orderClass?:'simple'|'mleg',
     *   legs?:Array<{symbol:string, side:string, ratioQty?:number, positionIntent?:string,
     *   limitPrice?:number}>, extendedHours?:boolean}} order
     * @returns {Promise<object>} mapped order
     */
    async submitOrder(order = {}) {
      const isMleg = order.orderClass === 'mleg' || order.orderClass === 'multi_leg';
      const isOption = String(order.assetClass ?? '').toLowerCase() === 'us_option'
        || isOptionSymbol(order.symbol)
        || isMleg;
      const side = String(order.side ?? '').toLowerCase();
      const type = order.type ?? (isOption || isMleg ? 'limit' : 'market');
      const payload = { type, time_in_force: order.timeInForce ?? (isOption || isMleg ? 'day' : 'day') };
      const limitPrice = parseNumber(order.limitPrice);
      if (limitPrice !== null) payload.limit_price = String(limitPrice);
      if (order.clientOrderId) payload.client_order_id = String(order.clientOrderId);

      if (isMleg) {
        const legs = Array.isArray(order.legs) ? order.legs : [];
        if (legs.length < 2) fail('SPEC_INVALID', 'mleg order requires at least 2 legs', { legs: legs.length });
        payload.order_class = 'mleg';
        payload.legs = legs.map((leg) => {
          const legSymbol = String(leg?.symbol ?? '').trim().toUpperCase();
          if (!legSymbol) fail('SPEC_INVALID', 'mleg leg requires a symbol');
          const legSide = String(leg?.side ?? '').toLowerCase();
          if (legSide !== 'buy' && legSide !== 'sell') fail('SPEC_INVALID', 'mleg leg side must be buy or sell', { leg });
          const ratioQty = Number.isFinite(Number(leg.ratioQty)) && Number(leg.ratioQty) > 0 ? Number(leg.ratioQty) : 1;
          const mapped = { symbol: legSymbol, side: legSide, ratio_qty: String(ratioQty) };
          if (leg.positionIntent) mapped.position_intent = String(leg.positionIntent);
          return mapped;
        });
        // Alpaca requires a net limit price for mleg orders.
        if (limitPrice === null) fail('SPEC_INVALID', 'mleg order requires limitPrice (net debit/credit)');
        const raw = await request('/v2/orders', { method: 'POST', body: payload });
        return mapOrder(raw);
      }

      const symbol = String(order.symbol ?? '').trim().toUpperCase();
      if (!symbol) fail('SPEC_INVALID', 'submitOrder requires symbol');
      if (side !== 'buy' && side !== 'sell') {
        fail('SPEC_INVALID', 'submitOrder side must be buy or sell', { side: order.side });
      }
      const qty = parseNumber(order.qty);
      const notional = parseNumber(order.notional);
      if (qty === null && notional === null) {
        fail('SPEC_INVALID', 'submitOrder requires qty or notional', { symbol });
      }
      if (isOption && qty === null) fail('SPEC_INVALID', 'option orders require integer qty (contracts)', { symbol });
      if (isOption && (!Number.isInteger(Number(qty)) || Number(qty) < 1)) {
        fail('SPEC_INVALID', 'option qty must be a positive integer number of contracts', { symbol, qty });
      }
      const mappedAssetClass = isOption ? 'us_option' : String(order.assetClass ?? 'us_equity').toLowerCase();
      payload.symbol = symbol;
      payload.side = side;
      payload.asset_class = mappedAssetClass;
      if (qty !== null) payload.qty = String(isOption ? Math.trunc(Number(qty)) : qty);
      else payload.notional = String(notional);
      if (isOption && order.positionIntent) payload.position_intent = String(order.positionIntent);
      if (!isOption && order.positionIntent) payload.position_intent = String(order.positionIntent);
      if (order.extendedHours === true) payload.extended_hours = true;
      const raw = await request('/v2/orders', { method: 'POST', body: payload });
      return mapOrder(raw);
    },

    /**
     * @param {string} id
     * @returns {Promise<{id:string, status:string}>}
     */
    async cancelOrder(id) {
      if (!id) fail('SPEC_INVALID', 'cancelOrder requires an order id');
      const raw = await request(`/v2/orders/${encodeURIComponent(String(id))}`, { method: 'DELETE' });
      if (raw && typeof raw === 'object') {
        const mapped = mapOrder(raw);
        return { id: mapped?.id ?? String(id), status: mapped?.status ?? 'canceled' };
      }
      return { id: String(id), status: 'canceled' };
    },

    /**
     * Multi-symbol hourly bars. Returns every requested symbol (empty array when the
     * vendor has none), bars ascending with `t` in epoch ms.
     * @param {{symbols: string|string[], timeframe?: string, limit?: number,
     *          adjustment?: string, feed?: string, start?: string, end?: string}} params
     * @returns {Promise<Record<string, Array<{t:number,o:number,h:number,l:number,c:number,v:number}>>>}
     */
    async getBars({ symbols, timeframe = '1Hour', limit = 120, adjustment = 'raw', feed = 'iex', start, end } = {}) {
      const list = normalizeSymbols(symbols);
      if (list.length === 0) fail('DATA_MISSING', 'getBars requires at least one symbol');
      const effectiveLimit = Math.max(1, Math.min(10_000, Number(limit) || 120));
      // Verified against the paper data API:
      //  - omitting the window returns NO bars;
      //  - with a window, default pagination returns the OLDEST bars;
      //  - multi-symbol requests page one symbol at a time (next_page_token), so they cannot
      //    be relied on to return every symbol.
      // Therefore: one request per symbol, window ending now, sort=desc, then restore ascending.
      const intervalMs = timeframeToMs(timeframe);
      const windowMs = Math.max(intervalMs * effectiveLimit * 4, 3 * 24 * 60 * 60 * 1000);
      const nowMs = Date.now();
      const effectiveEnd = end ?? new Date(nowMs).toISOString();
      const effectiveStart = start
        ?? new Date(nowMs - Math.min(windowMs, 400 * 24 * 60 * 60 * 1000)).toISOString();
      /** @type {Record<string, Array<object>>} */
      const out = {};
      await Promise.all(
        list.map(async (symbol) => {
          try {
            const raw = await request('/v2/stocks/bars', {
              dataHost: true,
              query: {
                symbols: symbol,
                timeframe,
                limit: effectiveLimit,
                adjustment,
                feed,
                start: effectiveStart,
                end: effectiveEnd,
                sort: 'desc',
              },
            });
            const rows = Array.isArray(raw?.bars?.[symbol])
              ? raw.bars[symbol]
              : raw?.bars && typeof raw.bars === 'object'
                ? Object.values(raw.bars).find((value) => Array.isArray(value)) ?? []
                : [];
            // Sort ascending by timestamp instead of assuming the page direction: the live
            // API honors sort=desc, but a stub/proxy may return ascending rows anyway.
            out[symbol] = rows
              .map(mapBar)
              .filter(Boolean)
              .sort((left, right) => left.t - right.t);
          } catch (error) {
            // One unavailable symbol must not blank the whole cycle; the prospector treats
            // an empty series as "no data" and skips it.
            if (error?.code === 'BROKER_AUTH' || error?.code === 'BROKER_RATE_LIMIT') throw error;
            out[symbol] = [];
          }
        }),
      );
      return out;
    },

    /**
     * Latest NBBO quote for one symbol.
     * @param {string} symbol
     * @param {{feed?: string}} [opts]
     * @returns {Promise<{symbol:string, bid:number|null, ask:number|null, ts:number|null}>}
     */
    async getLatestQuote(symbol, { feed = 'iex' } = {}) {
      const ticker = String(symbol ?? '').trim().toUpperCase();
      if (!ticker) fail('DATA_MISSING', 'getLatestQuote requires a symbol');
      const raw = await request(`/v2/stocks/${encodeURIComponent(ticker)}/quotes/latest`, {
        dataHost: true,
        query: { feed },
      });
      const quote = raw?.quote && typeof raw.quote === 'object' ? raw.quote : raw ?? {};
      return {
        symbol: ticker,
        bid: parseNumber(quote.bp, null),
        ask: parseNumber(quote.ap, null),
        ts: parseTimestamp(quote.t),
      };
    },

    /**
     * Advisory company/market news for a set of symbols (research sidecar only).
     *
     * Read-only data: news never places orders and is never a trading capability. The
     * feed is mapped defensively — one unusable item is dropped, never fatal — and the
     * list is returned newest-first. A news outage is treated as "no news" (except for
     * auth/rate-limit/config failures, which are surfaced so the operator can see them).
     *
     * @param {{symbols: string|string[], limit?: number, start?: string|number,
     *          end?: string|number}} params
     * @returns {Promise<Array<{id:string, headline:string, summary:string, source:string,
     *           url:string|null, symbols:string[], createdAt:number}>>}
     */
    async getNews({ symbols, limit = 6, start, end } = {}) {
      const list = normalizeSymbols(symbols);
      if (list.length === 0) return [];
      const effectiveLimit = Math.max(1, Math.min(50, Number(limit) || 6));
      const startMs = filterMs(start);
      const endMs = filterMs(end);
      let raw;
      try {
        raw = await request('/v1beta1/news', {
          dataHost: true,
          query: {
            symbols: list.join(','),
            limit: effectiveLimit,
            start: isoParam(start),
            end: isoParam(end),
          },
        });
      } catch (error) {
        if (error?.code === 'BROKER_AUTH' || error?.code === 'BROKER_RATE_LIMIT' || error?.code === 'CONFIG_INVALID') {
          throw error;
        }
        // Research is advisory: a flaky/absent news endpoint must not stop trading.
        return [];
      }
      const rows = Array.isArray(raw?.news) ? raw.news : Array.isArray(raw) ? raw : [];
      const items = [];
      for (const row of rows) {
        try {
          const item = mapNewsItem(row);
          if (!item) continue;
          if (startMs !== null && item.createdAt < startMs) continue;
          if (endMs !== null && item.createdAt > endMs) continue;
          items.push(item);
        } catch {
          /* tolerate a single malformed item */
        }
      }
      items.sort((left, right) => right.createdAt - left.createdAt);
      return items.slice(0, effectiveLimit);
    },

    /**
     * Real-time stock snapshots for a symbol set (analytics market tape).
     *
     * `GET /v2/stocks/snapshots?symbols=A,B&feed=iex` normalized per symbol:
     * `{symbol, priceUsd, bid, ask, changeUsd, changePct, openUsd, highUsd, lowUsd,
     *   prevCloseUsd, volume, ts, stale}`. `changePct` is a fraction (0.0123 = +1.23%).
     * The result is cached ~2 s per (feed, symbol set); missing vendor fields become null
     * and a symbol is never dropped from the result.
     *
     * @param {string|string[]} symbols
     * @param {{feed?: string, nowMs?: number}} [opts]
     * @returns {Promise<Record<string, object>>}
     */
    async getSnapshots(symbols, { feed = 'iex', nowMs } = {}) {
      const list = normalizeSymbols(symbols);
      if (list.length === 0) return {};
      const effectiveNow = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
      const cacheKey = `${feed}:${[...list].sort().join(',')}`;
      const cached = stockSnapshotCache.get(cacheKey);
      if (cached && effectiveNow - cached.at < STOCK_SNAPSHOT_TTL_MS) {
        const out = {};
        for (const symbol of list) out[symbol] = cached.data[symbol] ?? mapSnapshot({}, effectiveNow, symbol);
        return out;
      }
      const raw = await request('/v2/stocks/snapshots', {
        dataHost: true,
        query: { symbols: list.join(','), feed },
      });
      const rows = raw?.snapshots && typeof raw.snapshots === 'object'
        ? raw.snapshots
        : raw && typeof raw === 'object' && !Array.isArray(raw)
          ? raw
          : {};
      const out = {};
      for (const symbol of list) out[symbol] = mapSnapshot(rows[symbol] ?? {}, effectiveNow, symbol);
      stockSnapshotCache.set(cacheKey, { at: effectiveNow, data: out });
      return out;
    },

    /**
     * Optional helper: bars for one symbol in the configured timeframe.
     * @param {string} symbol
     * @param {{limit?: number}} [opts]
     */
    async getDayBars(symbol, { limit = 120 } = {}) {
      const timeframe = config.data?.timeframe ?? '1Hour';
      return broker.getBars({ symbols: [symbol], timeframe, limit });
    },

    /**
     * The real data request URL a hypothesis proof points at. Used by the Prospector
     * so every claim carries the exact query it was measured from.
     * @param {{symbols: string|string[], timeframe?: string, limit?: number, adjustment?: string, feed?: string}} params
     * @returns {string}
     */
    getDataUrl({ symbols, timeframe = '1Hour', limit = 120, adjustment = 'raw', feed = 'iex' } = {}) {
      const list = normalizeSymbols(symbols);
      const base = creds().dataBaseUrl || DATA_BASE_URL;
      const url = new URL('/v2/stocks/bars', base);
      url.searchParams.set('symbols', list.join(','));
      url.searchParams.set('timeframe', String(timeframe));
      url.searchParams.set('limit', String(limit));
      url.searchParams.set('adjustment', String(adjustment));
      url.searchParams.set('feed', String(feed));
      return url.toString();
    },

    /** Readonly endpoint summary for status/debug output (no key material). */
    describe() {
      const resolved = creds();
      return {
        kind: 'alpaca',
        mode,
        baseUrl: resolved.baseUrl,
        dataBaseUrl: resolved.dataBaseUrl,
        instruments: {
          options: true,
          shortStock: true,
          margin: true,
          optionDataFeed: config.instruments?.optionDataFeed ?? 'indicative',
        },
      };
    },
  };

  return broker;
}

export default createBroker;
