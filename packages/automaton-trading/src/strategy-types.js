/**
 * STRATEGY TAXONOMY — one place that maps a bot's genome family to its trading class, cadence and
 * human-readable labels. Used by genesis (population mix), replication (tier inheritance), the
 * orchestrator status payload and the control panel columns (type + estimated trading interval).
 *
 * Contract: docs/BOT-AGENTS.md.
 */

export const STRATEGY_CATEGORIES = Object.freeze({
  swing: {
    key: 'swing',
    label: 'Swing · mid-long',
    shortLabel: 'Swing',
    description: 'Holds positions for hours; decides on 1-hour bars, reviewed hourly.',
  },
  day: {
    key: 'day',
    label: 'Day · intraday',
    shortLabel: 'Day',
    description: 'Intraday entries/exits on 1-minute bars, reviewed every few minutes.',
  },
});

/** family -> strategy type definition */
export const STRATEGY_TYPES = Object.freeze({
  momentum: {
    family: 'momentum',
    category: 'swing',
    typeLabel: 'Momentum swing',
    className: 'momentum',
    description: 'Buys confirmed strength on 1-hour bars and rides momentum until it fades.',
  },
  meanrev: {
    family: 'meanrev',
    category: 'swing',
    typeLabel: 'Mean-reversion swing',
    className: 'meanrev',
    description: 'Buys statistically stretched pullbacks on 1-hour bars and exits on reversion.',
  },
  breakout: {
    family: 'breakout',
    category: 'day',
    typeLabel: 'Intraday breakout',
    className: 'breakout',
    description: 'Buys intraday range breakouts on 1-minute bars, quick exits and tight stops.',
  },
  gapfade: {
    family: 'gapfade',
    category: 'day',
    typeLabel: 'Day-trade gap fade',
    className: 'gapfade',
    description: 'Fades the opening gap on 1-minute bars and exits when the gap closes.',
  },
});

const GAPFADE_FALLBACK = STRATEGY_TYPES.gapfade;

/** Resolve the strategy type for a family (unknown families fall back to the swing default). */
export function strategyTypeForFamily(family) {
  return STRATEGY_TYPES[String(family ?? '').toLowerCase()] ?? {
    family: String(family ?? 'unknown'),
    category: 'swing',
    typeLabel: 'Custom swing',
    className: 'custom',
    description: 'Custom strategy family; treated as a swing bot.',
  };
}

/** Tier implied by the strategy family ('day' | 'swing'). */
export function tierForFamily(family) {
  return strategyTypeForFamily(family).category;
}

/** Full per-agent strategy view for status/UI (family + resolved type + cadence estimates). */
export function resolveStrategyType({ family, tier, cadence } = {}) {
  const type = strategyTypeForFamily(family);
  const effectiveTier = tier === 'day' || tier === 'swing' ? tier : type.category;
  const lane = cadence?.[effectiveTier === 'day' ? 'day' : 'swing'] ?? null;
  const timeframe = lane?.timeframe ?? (effectiveTier === 'day' ? '1Min' : '1Hour');
  const reviewSec = lane?.intervalSec ?? null;
  const categoryMeta = STRATEGY_CATEGORIES[effectiveTier];
  const estimatedIntervalSec = estimatedTradingIntervalSec({ category: effectiveTier, reviewSec, timeframe });
  return {
    family: type.family,
    category: effectiveTier,
    tier: effectiveTier,
    typeLabel: type.typeLabel,
    className: type.className,
    description: type.description,
    categoryLabel: categoryMeta?.label ?? effectiveTier,
    estimatedIntervalSec,
    timeframe,
    reviewSec,
  };
}

/**
 * Estimated reaction/decision interval in seconds: day bots react within a few minutes (1-minute
 * bars, reviewed every few minutes), swing bots on their hourly decision cadence.
 */
export function estimatedTradingIntervalSec({ category, reviewSec, timeframe } = {}) {
  if (category === 'day') return Math.max(60, Number(reviewSec) || 300);
  if (category === 'swing') return Math.max(3600, Number(reviewSec) || 3600);
  if (timeframe === '1Min' || timeframe === '5Min') return 300;
  return 3600;
}

/**
 * Deterministic balanced mix for genesis/backfill: roughly half the population is swing
 * (momentum/meanrev alternating blocks) and half is day (breakout/gapfade alternating blocks).
 * Blocks are sized so every (symbol, family) pair stays unique for populations up to
 * symbols × 4 families (e.g. 30 bots over 10 symbols → 8/7/8/7).
 */
export function targetFamilyForIndex(index, count = 30, dayPct = 0.5) {
  const i = Math.max(0, Math.trunc(Number(index) || 0));
  const total = Math.max(1, Math.trunc(Number(count) || 30));
  const targetDayPct = Math.min(0.9, Math.max(0.1, Number(dayPct) || 0.5));
  // Swing gets the ceil share so the historical 50/50 behaviour for odd populations is unchanged;
  // at 70% day this yields 9 swing / 21 day for a 30-bot population.
  const swingCount = Math.ceil(Number((total * (1 - targetDayPct)).toFixed(6)));
  const dayCount = total - swingCount;
  const momentumCount = Math.ceil(swingCount / 2);
  const breakoutCount = Math.ceil(dayCount / 2);
  if (i < momentumCount) return 'momentum';
  if (i < swingCount) return 'meanrev';
  if (i < swingCount + breakoutCount) return 'breakout';
  return 'gapfade';
}

/** Category counts for the status payload / panel tabs. */
export function strategyMix(agents = []) {
  const mix = {
    swing: { count: 0, families: {} },
    day: { count: 0, families: {} },
  };
  for (const agent of Array.isArray(agents) ? agents : []) {
    const family = String(agent?.genome?.family ?? agent?.strategy?.family ?? 'unknown');
    const category = agent?.strategy?.category === 'day' || agent?.strategy?.category === 'swing'
      ? agent.strategy.category
      : tierForFamily(family);
    mix[category].count += 1;
    mix[category].families[family] = (mix[category].families[family] ?? 0) + 1;
  }
  return {
    swing: { ...STRATEGY_CATEGORIES.swing, ...mix.swing },
    day: { ...STRATEGY_CATEGORIES.day, ...mix.day },
    total: mix.swing.count + mix.day.count,
  };
}

export { GAPFADE_FALLBACK };
