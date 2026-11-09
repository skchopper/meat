/**
 * INSTRUMENTS — strategy playbooks, option structures, permission resolution and contract-selection
 * helpers for the multi-instrument paper-trading population (v3.0).
 *
 * Contract: docs/INSTRUMENTS.md.
 *
 * Design: the bot's own agent may pick a structure via `policy.instrument`, but the deterministic
 * playbook below is the default so bots actively use the new tools (options, short stock, margin)
 * when their strategy direction and affordability allow it. Risk caps are enforced by brakes and the
 * broker, never here.
 */

export const ASSET_CLASSES = Object.freeze({ equity: 'us_equity', option: 'us_option' });

/** Option structures the app understands. Vertical spreads are submitted as one mleg order. */
export const OPTION_STRUCTURES = Object.freeze({
  long_call: {
    key: 'long_call', label: 'Long call', side: 'debit', direction: 'bullish', legs: 1,
    description: 'Buy a call for leveraged upside; risk limited to premium.',
  },
  long_put: {
    key: 'long_put', label: 'Long put', side: 'debit', direction: 'bearish', legs: 1,
    description: 'Buy a put for downside protection/leverage; risk limited to premium.',
  },
  covered_call: {
    key: 'covered_call', label: 'Covered call', side: 'credit', direction: 'neutral', legs: 1,
    description: 'Sell a call against 100+ owned shares for premium income; capped upside.',
  },
  bull_call_spread: {
    key: 'bull_call_spread', label: 'Bull call spread', side: 'debit', direction: 'bullish', legs: 2,
    description: 'Buy lower-strike call, sell higher-strike call; defined risk, cheaper than a long call.',
  },
  bear_put_spread: {
    key: 'bear_put_spread', label: 'Bear put spread', side: 'debit', direction: 'bearish', legs: 2,
    description: 'Buy higher-strike put, sell lower-strike put; defined risk bearish debit.',
  },
  call_credit_spread: {
    key: 'call_credit_spread', label: 'Bear call spread', side: 'credit', direction: 'bearish', legs: 2,
    description: 'Sell lower-strike call, buy higher-strike call; defined-risk premium selling.',
  },
  put_credit_spread: {
    key: 'put_credit_spread', label: 'Bull put spread', side: 'credit', direction: 'bullish', legs: 2,
    description: 'Sell higher-strike put, buy lower-strike put; defined-risk premium selling.',
  },
});

export const SHORT_OPTION_STRUCTURES = Object.freeze(['covered_call', 'call_credit_spread', 'put_credit_spread']);
export const SPREAD_STRUCTURES = Object.freeze(['bull_call_spread', 'bear_put_spread', 'call_credit_spread', 'put_credit_spread']);

export function isSpreadStructure(structure) {
  return SPREAD_STRUCTURES.includes(String(structure ?? ''));
}

export function isShortOptionStructure(structure) {
  return SHORT_OPTION_STRUCTURES.includes(String(structure ?? ''));
}

export function optionRightForStructure(structure) {
  const key = String(structure ?? '');
  if (key === 'long_call' || key === 'covered_call' || key === 'bull_call_spread' || key === 'call_credit_spread') return 'call';
  if (key === 'long_put' || key === 'bear_put_spread' || key === 'put_credit_spread') return 'put';
  return null;
}

/**
 * Default per-family playbook. Structures are ordered by preference; the executor picks the first
 * one that is permitted, market data supports and the bot can afford, falling back to stock/short.
 */
export const FAMILY_PLAYBOOKS = Object.freeze({
  momentum: {
    family: 'momentum', tier: 'swing',
    bullish: ['long_call', 'bull_call_spread', 'long_stock'],
    bearish: ['short_stock', 'long_put', 'call_credit_spread'],
    neutral: ['long_stock'],
    summary: 'Ride confirmed trend with stock or leveraged calls; shorts/puts on breakdowns.',
  },
  meanrev: {
    family: 'meanrev', tier: 'swing',
    bullish: ['long_stock', 'put_credit_spread', 'bull_call_spread'],
    bearish: ['short_stock', 'call_credit_spread', 'bear_put_spread'],
    neutral: [],
    summary: 'Fade stretched moves with stock or defined-risk credit spreads.',
  },
  breakout: {
    family: 'breakout', tier: 'day',
    bullish: ['long_call', 'bull_call_spread', 'long_stock'],
    bearish: ['long_put', 'short_stock', 'bear_put_spread'],
    neutral: [],
    summary: 'Intraday range breaks with calls/puts for leverage, stock as fallback.',
  },
  gapfade: {
    family: 'gapfade', tier: 'day',
    bullish: ['long_stock', 'put_credit_spread', 'long_call'],
    bearish: ['covered_call', 'short_stock', 'long_put', 'call_credit_spread'],
    neutral: ['covered_call'],
    summary: 'Fade the opening gap with stock, shorts or premium selling (covered calls when covered).',
  },
});

export function playbookForFamily(family) {
  return FAMILY_PLAYBOOKS[String(family ?? '').toLowerCase()] ?? FAMILY_PLAYBOOKS.momentum;
}

/** Compact permission view derived from the config instruments block. */
export function resolveInstrumentPermissions(config) {
  const cfg = config?.instruments ?? {};
  const enabled = cfg.enabled !== false;
  const allowOptions = enabled && cfg.allowOptions !== false;
  const allowSpreads = allowOptions && cfg.allowSpreads !== false;
  const allowCoveredCalls = allowOptions && cfg.allowCoveredCalls !== false;
  const allowShort = enabled && cfg.allowShort !== false;
  const allowMargin = enabled && cfg.allowMargin !== false;
  const allowedStructures = [];
  if (allowOptions) {
    allowedStructures.push('long_call', 'long_put');
    if (allowCoveredCalls) allowedStructures.push('covered_call');
    if (allowSpreads) allowedStructures.push('bull_call_spread', 'bear_put_spread', 'call_credit_spread', 'put_credit_spread');
  }
  return {
    enabled,
    // `instruments.enabled:false` restores v2 long-stock-only behaviour: long stock is ALWAYS
    // allowed (it is the baseline instrument); only short/options/margin are disabled.
    longStock: true,
    shortStock: allowShort,
    longOptions: allowOptions,
    shortOptions: allowOptions && (allowCoveredCalls || allowSpreads),
    coveredCalls: allowCoveredCalls,
    spreads: allowSpreads,
    margin: allowMargin,
    allowedStructures,
  };
}

/** Per-agent permission view (same global gates today; hook for per-genome restrictions). */
export function agentInstrumentPermissions(config, agent) {
  const base = resolveInstrumentPermissions(config);
  if (!agent) return base;
  return { ...base, allowedStructures: [...base.allowedStructures] };
}

/** Structures permitted for one direction inside a family playbook. */
export function structuresForDirection(family, direction) {
  const book = playbookForFamily(family);
  return (book[direction] ?? book.neutral ?? []).filter((entry) => OPTION_STRUCTURES[entry] || entry === 'long_stock' || entry === 'short_stock');
}

/** Strike offset as a fraction of the underlying mark (positive = OTM for the chosen side). */
export function strikeOffsetPct(family, structure) {
  const key = String(structure ?? '');
  if (key === 'covered_call') return 0.04;
  if (key === 'short_stock') return 0;
  if (key === 'long_call' || key === 'bull_call_spread') return family === 'breakout' ? 0.02 : 0.035;
  if (key === 'long_put' || key === 'bear_put_spread') return 0.035;
  if (key === 'call_credit_spread') return 0.03;
  if (key === 'put_credit_spread') return 0.03;
  return 0.03;
}

/** Vertical spread width as a fraction of the underlying mark. */
export function spreadWidthPct(family) {
  return family === 'day' ? 0.03 : 0.05;
}

/** Target DTE for a structure given the configured window. */
export function targetDTE({ family, structure, minDTE = 2, maxDTE = 14 } = {}) {
  const lo = Math.max(1, Number(minDTE) || 2);
  const hi = Math.max(lo, Number(maxDTE) || 14);
  const preferred = family === 'day' || structure === 'breakout' ? lo + 2 : lo + 7;
  return Math.min(hi, Math.max(lo, preferred));
}

/** Option premium budget in USD for one order (capped by config and equity percentage). */
export function optionPremiumBudget({ config, equityUsd, openPremiumUsd = 0, mandateMaxUsd = null } = {}) {
  const cfg = config?.instruments ?? {};
  const pct = Number(cfg.maxOptionPremiumPctEquity);
  const pctBudget = Number.isFinite(equityUsd) ? Math.max(0, equityUsd) * (Number.isFinite(pct) ? pct : 0.25) : 0;
  const perOrder = Number(cfg.maxOptionPremiumUsd);
  const caps = [pctBudget, Number.isFinite(perOrder) ? perOrder : Infinity];
  if (Number.isFinite(mandateMaxUsd) && mandateMaxUsd >= 0) caps.push(mandateMaxUsd);
  const remaining = Math.max(0, Math.min(...caps) - Math.max(0, Number(openPremiumUsd) || 0));
  return Math.round(remaining * 100) / 100;
}

/** Contracts affordable for a given per-share premium and budget (integer, cap enforced). */
export function contractsForBudget({ premiumUsd, budgetUsd, maxContracts = 3 } = {}) {
  const premium = Number(premiumUsd);
  const budget = Number(budgetUsd);
  if (!(premium > 0) || !(budget > 0)) return 0;
  const affordable = Math.floor(budget / (premium * 100));
  return Math.max(0, Math.min(Math.max(1, Math.trunc(Number(maxContracts) || 1)), affordable));
}

/** Normalize/validate an agent-chosen instrument plan against permissions and caps. */
export function normalizeInstrumentPolicy(raw, { config, permissions } = {}) {
  const allowed = (permissions ?? resolveInstrumentPermissions(config)).allowedStructures;
  const cfg = config?.instruments ?? {};
  if (!raw || typeof raw !== 'object') return { prefer: 'auto', maxPremiumUsd: null, maxContracts: null, dteMin: null, dteMax: null };
  const prefer = String(raw.prefer ?? 'auto');
  const validPrefer = new Set(['auto', 'stock', 'short_stock', 'long_stock', ...allowed]);
  const chosen = validPrefer.has(prefer) ? prefer : 'auto';
  const num = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null);
  const maxPremiumUsd = num(raw.maxPremiumUsd);
  const maxContracts = num(raw.maxContracts);
  const dteMin = num(raw.dteMin);
  const dteMax = num(raw.dteMax);
  const minDTE = Math.max(1, Number(cfg.minDTE) || 2);
  const maxDTE = Math.max(minDTE, Number(cfg.maxDTE) || 14);
  return {
    prefer: chosen,
    maxPremiumUsd: maxPremiumUsd === null ? null : Math.min(maxPremiumUsd, Number(cfg.maxOptionPremiumUsd) || maxPremiumUsd),
    maxContracts: maxContracts === null ? null : Math.max(1, Math.min(Math.trunc(maxContracts), Number(cfg.maxContracts) || 3)),
    dteMin: dteMin === null ? minDTE : Math.round(Math.min(Math.max(dteMin, minDTE), maxDTE)),
    dteMax: dteMax === null ? maxDTE : Math.round(Math.min(Math.max(dteMax, minDTE), maxDTE)),
  };
}

/** Options structures the panel should show for an agent's family. */
export function playbookView(family, permissions) {
  const book = playbookForFamily(family);
  const allowed = new Set((permissions ?? resolveInstrumentPermissions({})).allowedStructures);
  const clean = (list) => (list ?? []).filter((entry) => !OPTION_STRUCTURES[entry] || allowed.has(entry));
  return {
    family: book.family,
    tier: book.tier,
    summary: book.summary,
    bullish: clean(book.bullish),
    bearish: clean(book.bearish),
    neutral: clean(book.neutral),
    structures: [...allowed],
  };
}

export default {
  ASSET_CLASSES,
  OPTION_STRUCTURES,
  FAMILY_PLAYBOOKS,
  SHORT_OPTION_STRUCTURES,
  SPREAD_STRUCTURES,
  isSpreadStructure,
  isShortOptionStructure,
  optionRightForStructure,
  playbookForFamily,
  resolveInstrumentPermissions,
  agentInstrumentPermissions,
  structuresForDirection,
  strikeOffsetPct,
  spreadWidthPct,
  targetDTE,
  optionPremiumBudget,
  contractsForBudget,
  normalizeInstrumentPolicy,
  playbookView,
};
