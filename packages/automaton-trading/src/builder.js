/**
 * BUILDER — compiles a dated-proof hypothesis into an executable StrategySpec.
 *
 * Stopline (architecture §2): the Builder never picks the symbol or family (the
 * hypothesis owns those and the Builder may not change them), never sets notional or
 * a price, and never "repairs" upstream work — a hypothesis without fresh dated proof
 * is rejected, not patched. It also may not spend more than `maxBuildSpendPct` of the
 * cycle budget.
 *
 * The spec carries a `proofRef` back to the Prospector's measured evidence, which is
 * the D9 wall: no trade without a spec that carries dated proof.
 *
 * Contract: docs/CONTRACTS.md § "Data feed / market helpers" (builder.js).
 * Owner: market teammate.
 *
 * @module builder
 */

import { fail, HYPOTHESIS_FAMILIES } from './contracts.js';
import { DAY_MS, MINUTE_MS, round4, SYSTEM_CLOCK } from './util.js';

/** Hard parameter bounds. Values from a genome/hint are clamped into these. */
export const PARAM_BOUNDS = Object.freeze({
  lookback: { min: 10, max: 120, integer: true },
  entryZ: { min: 0.5, max: 3, integer: false },
  exitZ: { min: 0, max: 2, integer: false },
  stopPct: { min: 0.005, max: 0.06, integer: false },
  targetPct: { min: 0.005, max: 0.12, integer: false },
  maxHoldBars: { min: 1, max: 48, integer: true },
  sizePct: { min: 0.05, max: 0.4, integer: false },
});

/** Allowed session filters. */
export const SESSION_FILTERS = Object.freeze(['any', 'morning', 'afternoon']);

/** Family-specific starting parameters (then hint, then genome, then clamp). */
export const FAMILY_DEFAULTS = Object.freeze({
  momentum: { lookback: 60, entryZ: 1.0, exitZ: 0.5, stopPct: 0.02, targetPct: 0.04, maxHoldBars: 12, sizePct: 0.2, sessionFilter: 'any' },
  meanrev: { lookback: 40, entryZ: 1.2, exitZ: 0.3, stopPct: 0.025, targetPct: 0.03, maxHoldBars: 8, sizePct: 0.2, sessionFilter: 'any' },
  breakout: { lookback: 80, entryZ: 1.5, exitZ: 0.5, stopPct: 0.03, targetPct: 0.06, maxHoldBars: 16, sizePct: 0.2, sessionFilter: 'any' },
  gapfade: { lookback: 30, entryZ: 1.0, exitZ: 0.5, stopPct: 0.015, targetPct: 0.025, maxHoldBars: 6, sizePct: 0.15, sessionFilter: 'any' },
});

/** Estimated Builder inference cost attributed per compile (USD). Capped by policy. */
export const ESTIMATED_BUILD_COST_USD = 0.01;

/**
 * v3.4 aggression profile multipliers (docs/AGGRESSIVE-GROWTH.md §1-§2).
 *
 * `config.aggression.profiles[<name>]` overrides these per key; the contract values below are the
 * safe defaults used when the config layer is missing or partial. Balanced multipliers are 1, so a
 * balanced genome (and every legacy genome without `aggression`) compiles byte-identically to v3.3.
 */
export const AGGRESSION_PROFILE_DEFAULTS = Object.freeze({
  aggressive: Object.freeze({
    entryZMultiplier: 0.70,
    sizePctMultiplier: 1.35,
    stopPctMultiplier: 0.80,
    targetPctMultiplier: 1.20,
    maxHoldBarsMultiplier: 0.75,
  }),
  balanced: Object.freeze({
    entryZMultiplier: 1,
    sizePctMultiplier: 1,
    stopPctMultiplier: 1,
    targetPctMultiplier: 1,
    maxHoldBarsMultiplier: 1,
  }),
  conservative: Object.freeze({
    entryZMultiplier: 1.15,
    sizePctMultiplier: 0.80,
    stopPctMultiplier: 1.00,
    targetPctMultiplier: 0.90,
    maxHoldBarsMultiplier: 1.00,
  }),
});

/** Known aggression profiles (most → least aggressive). Anything else means "no multipliers". */
export const AGGRESSION_PROFILES = Object.freeze(Object.keys(AGGRESSION_PROFILE_DEFAULTS));

/** Parameter name → profile multiplier name (the only params a profile scales). */
const PARAM_MULTIPLIER_KEYS = Object.freeze({
  entryZ: 'entryZMultiplier',
  sizePct: 'sizePctMultiplier',
  stopPct: 'stopPctMultiplier',
  targetPct: 'targetPctMultiplier',
  maxHoldBars: 'maxHoldBarsMultiplier',
});

const MULTIPLIER_KEYS = Object.freeze(Object.values(PARAM_MULTIPLIER_KEYS));

/**
 * Resolve the multipliers for one genome aggression profile.
 *
 * Config values win per key when they are finite and positive; contract defaults fill the rest.
 * An unknown/missing aggression resolves to null, which means "no multipliers" — the v3.3
 * behaviour. The Builder never reads executor fields (policySizeFloor/respectStandDown) and never
 * lets a profile change symbol/family/notional.
 *
 * @param {object} config
 * @param {string|undefined|null} aggression
 * @returns {{aggression:string, entryZMultiplier:number, sizePctMultiplier:number,
 *            stopPctMultiplier:number, targetPctMultiplier:number, maxHoldBarsMultiplier:number}|null}
 */
export function resolveAggressionMultipliers(config, aggression) {
  const name = typeof aggression === 'string' && AGGRESSION_PROFILES.includes(aggression) ? aggression : null;
  if (!name) return null;
  const defaults = AGGRESSION_PROFILE_DEFAULTS[name];
  const configured = config?.aggression?.profiles?.[name];
  /** @type {Record<string, any>} */
  const resolved = { aggression: name };
  for (const key of MULTIPLIER_KEYS) {
    const raw = Number(configured?.[key]);
    resolved[key] = Number.isFinite(raw) && raw > 0 ? raw : defaults[key];
  }
  return resolved;
}

const PARAM_KEYS = Object.freeze([
  'lookback',
  'entryZ',
  'exitZ',
  'stopPct',
  'targetPct',
  'maxHoldBars',
  'sizePct',
]);

/** FNV-1a 32-bit hash (deterministic spec ids). */
export function hashString(text) {
  let hash = 0x811c9dc5;
  const value = String(text);
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Clamp one parameter into its contract bound. */
export function clampParam(name, value, fallback) {
  const bound = PARAM_BOUNDS[name];
  if (!bound) return value;
  let n = Number(value);
  if (!Number.isFinite(n)) n = Number(fallback);
  if (!Number.isFinite(n)) n = bound.min;
  n = Math.min(bound.max, Math.max(bound.min, n));
  if (bound.integer) n = Math.round(n);
  return n;
}

function isValidProof(proof) {
  return Boolean(
    proof
    && typeof proof === 'object'
    && typeof proof.url === 'string'
    && proof.url.trim().length > 0
    && proof.observedAt !== undefined
    && proof.observedAt !== null
    && Number.isFinite(proof.stats?.meanBps)
    && Number(proof.sampleSize) > 0,
  );
}

function resolveObservedAtMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

/**
 * @param {{ config: object, brakes?: object, clock?: { now: () => number } }} deps
 * @returns {{ compile: (args: {hypothesis: object, agentId: string, cycleBudgetUsd: number,
 *            genome?: object}) => {spec: object, spentUsd: number},
 *            describe: () => object }}
 */
export function createBuilder({ config, brakes, clock } = {}) {
  if (!config || typeof config !== 'object') {
    fail('CONFIG_INVALID', 'createBuilder requires config');
  }
  const now = clock ?? SYSTEM_CLOCK;
  const maxBuildSpendPct = config.risk?.maxBuildSpendPct ?? 0.4;
  const configuredSymbols = Array.isArray(config.symbols) ? config.symbols.map((s) => String(s).toUpperCase()) : null;
  const maxProofAgeDays = Number.isFinite(config.data?.maxProofAgeDays) ? config.data.maxProofAgeDays : 7;
  const maxProofAgeMs = maxProofAgeDays * DAY_MS;

  /**
   * Compile a hypothesis into a StrategySpec.
   * @param {{hypothesis: object, agentId: string, cycleBudgetUsd: number, genome?: object}} args
   * @returns {{spec: object, spentUsd: number}}
   */
  function compile({ hypothesis, agentId, cycleBudgetUsd, genome } = {}) {
    if (!hypothesis || typeof hypothesis !== 'object') {
      fail('SPEC_INVALID', 'builder.compile requires a hypothesis object');
    }

    // --- D9: proof presence then freshness (a present-but-stale link is not proof) ---
    if (!isValidProof(hypothesis.proof)) {
      fail('NO_PROOF', 'hypothesis has no dated proof (url + observedAt + measured stats + samples)', {
        hypothesisId: hypothesis.id ?? null,
        symbol: hypothesis.symbol ?? null,
        family: hypothesis.family ?? null,
      });
    }
    const observedAtMs = resolveObservedAtMs(hypothesis.proof.observedAt);
    if (observedAtMs === null) {
      fail('NO_PROOF', 'hypothesis proof.observedAt is not a parseable timestamp', {
        hypothesisId: hypothesis.id ?? null,
        observedAt: hypothesis.proof.observedAt,
      });
    }
    const atMs = now.now();
    const ageMs = atMs - observedAtMs;
    if (ageMs > maxProofAgeMs) {
      fail('PROOF_STALE', `hypothesis proof is ${(ageMs / DAY_MS).toFixed(2)} days old; max ${maxProofAgeDays}`, {
        hypothesisId: hypothesis.id ?? null,
        observedAt: hypothesis.proof.observedAt,
        ageDays: round4(ageMs / DAY_MS),
        maxProofAgeDays,
      });
    }
    if (ageMs < -5 * MINUTE_MS) {
      fail('PROOF_STALE', 'hypothesis proof is dated in the future', {
        hypothesisId: hypothesis.id ?? null,
        observedAt: hypothesis.proof.observedAt,
      });
    }

    // --- identity: symbol and family belong to the hypothesis, never to the Builder ---
    const symbol = String(hypothesis.symbol ?? '').trim().toUpperCase();
    if (!symbol) fail('SPEC_INVALID', 'hypothesis.symbol is required');
    if (configuredSymbols && !configuredSymbols.includes(symbol)) {
      fail('SPEC_INVALID', `hypothesis.symbol ${symbol} is outside the configured universe`, { symbol });
    }
    const family = String(hypothesis.family ?? '').trim();
    if (!HYPOTHESIS_FAMILIES.includes(family)) {
      fail('SPEC_INVALID', `hypothesis.family must be one of ${HYPOTHESIS_FAMILIES.join('|')}`, { family });
    }
    if (typeof agentId !== 'string' || agentId.trim().length === 0) {
      fail('SPEC_INVALID', 'builder.compile requires a non-empty agentId');
    }

    // --- budget: a compile costs money; it may not exceed the policy cap ---
    const budget = Number(cycleBudgetUsd);
    if (!Number.isFinite(budget) || budget <= 0) {
      fail('BUDGET_EXCEEDED', 'cycleBudgetUsd must be a positive number to compile a spec', {
        cycleBudgetUsd,
      });
    }
    const spendCap = round4(maxBuildSpendPct * budget);
    if (!(spendCap > 0)) {
      fail('BUDGET_EXCEEDED', 'maxBuildSpendPct * cycleBudgetUsd rounds to zero', {
        cycleBudgetUsd: budget,
        maxBuildSpendPct,
      });
    }
    const spentUsd = round4(Math.min(ESTIMATED_BUILD_COST_USD, spendCap));

    // --- params: family defaults -> hypothesis.specsHint -> inherited genome -> profile
    // multipliers -> bounds ------------------------------------------------------
    const base = FAMILY_DEFAULTS[family];
    const hinted = hypothesis.specsHint && typeof hypothesis.specsHint === 'object' ? hypothesis.specsHint : {};
    const inherited = genome && typeof genome === 'object' ? genome : {};
    // v3.4: the genome's aggression profile scales sizing/exit parameters AFTER hint/genome values
    // and BEFORE the hard bounds clamp (docs/AGGRESSIVE-GROWTH.md §2). Unknown/missing = null.
    const profileMultipliers = resolveAggressionMultipliers(config, inherited.aggression);
    /** @type {Record<string, any>} */
    const params = {};
    for (const key of PARAM_KEYS) {
      const fallback = base[key];
      let value = fallback;
      if (hinted[key] !== undefined) value = hinted[key];
      if (inherited[key] !== undefined) value = inherited[key];
      const multiplier = profileMultipliers?.[PARAM_MULTIPLIER_KEYS[key]];
      if (Number.isFinite(multiplier) && multiplier !== 1) {
        // A malformed hint/genome value falls back to the family default, which the profile
        // still scales; the clamp below remains the hard bound.
        const numeric = Number(value);
        const scaled = (Number.isFinite(numeric) ? numeric : Number(fallback)) * multiplier;
        params[key] = clampParam(key, scaled, fallback);
      } else {
        params[key] = clampParam(key, value, fallback);
      }
    }
    const sessionFilter = SESSION_FILTERS.includes(inherited.sessionFilter)
      ? inherited.sessionFilter
      : SESSION_FILTERS.includes(hinted.sessionFilter)
        ? hinted.sessionFilter
        : base.sessionFilter;
    params.sessionFilter = sessionFilter;

    const specId = `spec-${hashString(
      `${hypothesis.id ?? `${symbol}:${family}`}|${agentId}|${symbol}|${family}|${JSON.stringify(params)}`,
    )}`;

    // `proofRef` is the URL string the brake wall (D9) checks before every order;
    // `proof` keeps the dated evidence alongside it. Both point at the same measurement.
    /** @type {object} */
    const spec = {
      specId,
      hypothesisId: hypothesis.id ?? null,
      agentId,
      symbol,
      family,
      createdAt: new Date(atMs).toISOString(),
      proofRef: hypothesis.proof.url,
      proof: {
        vendor: hypothesis.proof.vendor ?? 'alpaca',
        url: hypothesis.proof.url,
        observedAt: hypothesis.proof.observedAt,
        metric: hypothesis.proof.metric ?? null,
        sampleSize: Number(hypothesis.proof.sampleSize),
      },
      params,
      // v3.4: the resolved aggression profile that scaled `params` (omitted for legacy genomes).
      // Informational only: the deterministic params above are what the executor trades.
      ...(profileMultipliers ? { profile: { ...profileMultipliers } } : {}),
      budgetUsedUsd: spentUsd,
    };

    return { spec, spentUsd };
  }

  return {
    compile,
    describe() {
      return {
        role: 'builder',
        maxBuildSpendPct,
        maxProofAgeDays,
        paramBounds: PARAM_BOUNDS,
        sessionFilters: SESSION_FILTERS,
      };
    },
  };
}

export default createBuilder;
