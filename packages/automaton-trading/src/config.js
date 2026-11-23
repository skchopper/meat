/**
 * Configuration: defaults, layered loading, validation, credential resolution, paths.
 * Owned by the Lead.
 *
 * Layer order (later wins):
 *   DEFAULT_CONFIG  <-  config file JSON  <-  plugin row overrides  <-  environment variables
 *
 * Secrets are never stored in the config object. They live in the .env file (or the
 * process environment) and are resolved on demand into a short-lived credentials object.
 */

import fs from 'node:fs';
import path from 'node:path';
import { AutomatonError, MODES, fail } from './contracts.js';
import {
  createLogger,
  fileExists,
  parseDotenv,
  readJsonSync,
  redactSecrets,
  safeJson,
} from './util.js';

const log = createLogger('config');

const WORKSPACE_DEFAULT = process.cwd();

/** @returns {object} a fresh mutable copy of the defaults */
export function defaultConfig() {
  return {
    mode: 'paper',
    allowLive: false,
    account: {
      allocationCapPct: 0.8,
      reconciliationTolerancePct: 0.02,
    },
    // Core liquid names plus affordable underlyings: cheap stocks make whole-share shorts, margin
    // and sub-$25 option contracts realistic for $50 bots (docs/INSTRUMENTS.md).
    symbols: ['AAPL', 'MSFT', 'NVDA', 'AMD', 'META', 'AMZN', 'GOOGL', 'TSLA', 'SPY', 'QQQ', 'F', 'SOFI', 'BAC', 'INTC'],
    timeZone: 'America/New_York',
    cycleIntervalSec: 300,
    reaperIntervalSec: 30,
    population: { initial: 3, cap: 10 },
    endowmentUsd: 5000,
    deathFloorUsd: 250,
    deathFloorPct: 0.05,
    maxDrawdownPct: 0.25,
    burn: {
      inferencePerCycleUsd: 0.03,
      dataPerCycleUsd: 0.005,
      hostingPerHourUsd: 0.001,
      committedMonthlyUsd: 0,
    },
    cycleBudget: { STABLE: 0.08, TIGHT: 0.03, CRITICAL: 0.01 },
    replication: {
      surplus7dUsd: 150,
      minRunwayHours: 72,
      childEndowmentUsd: 2500,
    },
    risk: {
      maxPositionPct: 0.25,
      maxOpenPositions: 3,
      maxDailyOrders: 6,
      maxDailyLossPct: 0.05,
      maxOrderPctOfEquity: 0.25,
      maxOrderNotionalUsd: 2500,
      minOrderNotionalUsd: 1,
      maxSpreadBps: 25,
      minPriceUsd: 5,
      maxSlippageBps: 30,
      allowShort: false,
      allowMargin: false,
      allowOptions: false,
      extendedHours: false,
      sessionWindow: ['09:35', '15:50'],
      maxOrdersPerCycle: 1,
      maxBuildSpendPct: 0.4,
    },
    data: {
      timeframe: '1Hour',
      // Market-data feed: 'iex' = IEX real-time (free tier, real-time during RTH);
      // 'sip' = consolidated SIP (15-min delayed on the free plan).
      feed: 'iex',
      lookbackBars: 120,
      maxHypothesesPerCycle: 60,
      maxProofAgeDays: 7,
    },
    research: {
      enabled: true,
      influence: true,
      intervalSec: 3600,
      staggerSec: 120,
      maxRunsPerCycle: 3,
      maxNewsPerAgent: 6,
      newsLookbackHours: 24,
      costPerRunUsd: 0.001,
      maxAgeSec: 7200,
      maxConcurrent: 1,
      maxInputChars: 12000,
      maxOutputTokens: 1200,
      logLimit: 120,
      // Advisory thresholds (live-tuned 2026-10-28): a veto needs an explicit AVOID/ALERT
      // verdict or a strongly negative sentiment; a long risk list only shrinks the order.
      vetoSentiment: -0.6,
      exitSentiment: -0.5,
      vetoMinRisks: 5,
      riskPenalty: 0.6,
      errorCooldownSec: 900,
      // Operator-selectable cadence (control panel): interval | pre-open | post-close | both.
      scheduleMode: 'interval',
      preMarketOffsetMin: 30,
      postCloseOffsetMin: 30,
      provider: null,
      model: null,
    },
    rewards: {
      enabled: true,
      period: 'weekly',
      // v3.3 performance rewards (docs/FAIR-PNL-REWARDS.md): pay CAPITAL from the treasury pool to
      // eligible agents ranked by period TRADING RETURN; reward capital is never counted as P&L.
      basis: 'trading-performance',
      rankShares: [0.5, 0.3, 0.2],
      rewardBudgetPctOfPool: 0.1,
      maxPerPeriodUsd: null,
      maxRewardPerAgentPctOfCapital: 0.5,
      minTradingProfitUsd: 0.05,
      minTrades: 3,
      maxDrawdownPct: 0.2,
      // Deprecated v3.2 fields; accepted on load only and ignored by the v3.3 scheduler.
      rankPercents: [0.05, 0.03, 0.02],
    },
    // Per-tier execution cadence (docs/CONTROL-PANEL.md / RUNBOOK §8b). A 'day' bot is analysed
    // on the intraday timeframe every `intervalSec`; a 'swing' bot on its slower timeframe.
    // null = derive from cycleIntervalSec + data.timeframe (backward compatible).
    cadence: null,
    // v3.2 strategy mix + multi-symbol portfolio (docs/PORTFOLIO-ANALYTICS.md).
    strategyMix: { dayPct: 0.5 },
    portfolio: {
      basketSizeDay: 4,
      basketSizeSwing: 3,
      maxOpenPositionsDay: 5,
      maxOpenPositionsSwing: 3,
      maxOrdersPerCycle: 2,
    },
    // v3.4 aggressive growth cohort (docs/AGGRESSIVE-GROWTH.md). Opt-in in code defaults so older
    // configs/tests retain the v3.3 balanced behavior; the live profile enables it explicitly.
    // When enabled, 40% of the population gets larger baskets/positions/orders, lower entry bars,
    // bigger sizing and a policy size floor; 45% balanced; the rest conservative.
    aggression: {
      enabled: false,
      aggressivePct: 0.4,
      balancedPct: 0.45,
      capitalMultiplier: 1.35,
      profiles: {
        aggressive: {
          basketSizeDay: 6,
          basketSizeSwing: 4,
          maxOpenPositionsDay: 8,
          maxOpenPositionsSwing: 5,
          maxOrdersPerCycle: 4,
          entryZMultiplier: 0.7,
          sizePctMultiplier: 1.35,
          stopPctMultiplier: 0.8,
          targetPctMultiplier: 1.2,
          maxHoldBarsMultiplier: 0.75,
          policySizeFloor: 0.8,
          respectStandDown: false,
        },
        balanced: {
          basketSizeDay: 4,
          basketSizeSwing: 3,
          maxOpenPositionsDay: 5,
          maxOpenPositionsSwing: 3,
          maxOrdersPerCycle: 2,
          entryZMultiplier: 1,
          sizePctMultiplier: 1,
          stopPctMultiplier: 1,
          targetPctMultiplier: 1,
          maxHoldBarsMultiplier: 1,
          policySizeFloor: 0,
          respectStandDown: true,
        },
        conservative: {
          basketSizeDay: 3,
          basketSizeSwing: 2,
          maxOpenPositionsDay: 3,
          maxOpenPositionsSwing: 2,
          maxOrdersPerCycle: 1,
          entryZMultiplier: 1.15,
          sizePctMultiplier: 0.8,
          stopPctMultiplier: 1,
          targetPctMultiplier: 0.9,
          maxHoldBarsMultiplier: 1,
          policySizeFloor: 0,
          respectStandDown: true,
        },
      },
    },
    // v3.4 return target (informational: displayed pace, never an order/risk override).
    targets: {
      enabled: true,
      annualReturnPct: 0.5,
    },
    // Per-bot agent brain (docs/BOT-AGENTS.md): each bot reviews its own strategy in an isolated
    // context on its cadence and writes a policy the executor consumes.
    agents: {
      enabled: true,
      reviewIntervalDaySec: 300,
      reviewIntervalSwingSec: 3600,
      maxReviewsPerCycle: 4,
      costPerReviewUsd: 0.001,
      maxAgeSec: 7200,
      logLimit: 120,
      maxInputChars: 8000,
      maxOutputTokens: 700,
      errorCooldownSec: 900,
    },
    // Multi-instrument paper trading (docs/INSTRUMENTS.md): margin, short stock, long options,
    // defined-risk vertical spreads and covered calls. Risk caps are enforced again by brakes.
    instruments: {
      enabled: true,
      allowMargin: true,
      maxMarginPctEquity: 1,
      allowShort: true,
      maxShortPctEquity: 1,
      maxShortNotionalUsd: 25,
      shortableOnly: true,
      allowOptions: true,
      allowCoveredCalls: true,
      allowSpreads: true,
      maxOptionPremiumPctEquity: 0.25,
      maxOptionPremiumUsd: 25,
      maxContracts: 3,
      minDTE: 2,
      maxDTE: 14,
      autoCloseDTE: 1,
      allowNakedShortOptions: false,
      optionDataFeed: 'indicative',
    },
    paths: {
      stateDir: path.join(WORKSPACE_DEFAULT, 'automaton-data'),
      envFile: path.join(WORKSPACE_DEFAULT, '.env'),
    },
    engine: {
      autoStart: false,
      traceLimit: 2000,
      // When true the loop only runs full price/market analysis while the broker clock says the
      // market is open; outside hours it wakes for a cheap maintenance pass (research + status).
      tradingHoursOnly: false,
      offHoursIntervalSec: 300,
    },
  };
}

/** @type {ReturnType<typeof defaultConfig>} */
export const DEFAULT_CONFIG = defaultConfig();

// ---------------------------------------------------------------------------
// merge / load
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Deep merge plain objects; arrays and scalars from `source` replace the target. */
export function mergeDeep(target, source) {
  if (!isPlainObject(source)) return target;
  const out = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = mergeDeep(out[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function parseNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

/** Map environment variables onto config paths. */
function applyEnvOverrides(config, env) {
  const out = mergeDeep(config, {});
  if (env.AUTOMATON_MODE) out.mode = env.AUTOMATON_MODE;
  if (env.AUTOMATON_STATE_DIR) out.paths.stateDir = env.AUTOMATON_STATE_DIR;
  if (env.AUTOMATON_ENV_FILE) out.paths.envFile = env.AUTOMATON_ENV_FILE;
  if (env.AUTOMATON_AUTO_START !== undefined) out.engine.autoStart = parseBool(env.AUTOMATON_AUTO_START, out.engine.autoStart);
  if (env.AUTOMATON_CYCLE_SEC !== undefined) out.cycleIntervalSec = parseNumber(env.AUTOMATON_CYCLE_SEC, out.cycleIntervalSec);
  if (env.AUTOMATON_REAPER_SEC !== undefined) out.reaperIntervalSec = parseNumber(env.AUTOMATON_REAPER_SEC, out.reaperIntervalSec);
  if (env.AUTOMATON_POPULATION_CAP !== undefined) out.population.cap = parseNumber(env.AUTOMATON_POPULATION_CAP, out.population.cap);
  if (env.AUTOMATON_POPULATION_INITIAL !== undefined) out.population.initial = parseNumber(env.AUTOMATON_POPULATION_INITIAL, out.population.initial);
  if (env.AUTOMATON_ENDOWMENT_USD !== undefined) out.endowmentUsd = parseNumber(env.AUTOMATON_ENDOWMENT_USD, out.endowmentUsd);
  if (env.AUTOMATON_SYMBOLS !== undefined) {
    out.symbols = String(env.AUTOMATON_SYMBOLS)
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
  }
  if (env.AUTOMATON_ALLOW_LIVE !== undefined) out.allowLive = parseBool(env.AUTOMATON_ALLOW_LIVE, out.allowLive);
  return out;
}

/**
 * Layered config load.
 * @param {{
 *   configFile?: string,
 *   envFile?: string,
 *   overrides?: object,
 *   env?: Record<string, string|undefined>,
 *   cwd?: string,
 * }} [options]
 * @returns {{ config: ReturnType<typeof defaultConfig>, secrets: Record<string,string>, sources: string[] }}
 */
export function loadConfig(options = {}) {
  const env = options.env ?? process.env;
  const sources = ['defaults'];
  let config = defaultConfig();

  const configFile = options.configFile
    ?? env.AUTOMATON_CONFIG_FILE
    ?? path.join(options.cwd ?? WORKSPACE_DEFAULT, 'automaton.config.json');
  if (fileExists(configFile)) {
    const fileConfig = readJsonSync(configFile, null);
    if (fileConfig && typeof fileConfig === 'object') {
      config = mergeDeep(config, fileConfig);
      sources.push(`file:${configFile}`);
    }
  }

  if (options.overrides && typeof options.overrides === 'object') {
    config = mergeDeep(config, options.overrides);
    sources.push('overrides');
  }

  config = applyEnvOverrides(config, env);
  sources.push('env');

  // Paths: resolve relative to the workspace when relative, and keep them absolute.
  const cwd = options.cwd ?? WORKSPACE_DEFAULT;
  config.paths.stateDir = path.resolve(cwd, config.paths.stateDir ?? 'automaton-data');
  config.paths.envFile = path.resolve(
    cwd,
    options.envFile ?? config.paths.envFile ?? '.env',
  );

  // Operator settings overlay written by the control panel (stateDir/settings.json). It is
  // applied AFTER the config file/env so a UI change survives restarts, but only the two
  // operator-owned sections are merged; everything else stays code/file controlled.
  const settingsFile = path.join(config.paths.stateDir, 'settings.json');
  if (fileExists(settingsFile)) {
    const settings = readJsonSync(settingsFile, null);
    if (settings && typeof settings === 'object') {
      if (settings.research && typeof settings.research === 'object') {
        config = mergeDeep(config, { research: settings.research });
        sources.push(`settings:research:${settingsFile}`);
      }
      if (settings.rewards && typeof settings.rewards === 'object') {
        config = mergeDeep(config, { rewards: settings.rewards });
        sources.push(`settings:rewards:${settingsFile}`);
      }
    }
  }

  validateConfig(config);
  config = freezeConfig(config);

  // Secrets: .env file first, then process env overrides it.
  let secrets = {};
  const envFile = config.paths.envFile;
  if (fileExists(envFile)) {
    try {
      secrets = { ...parseDotenv(fs.readFileSync(envFile, 'utf8')) };
      sources.push(`envfile:${envFile}`);
    } catch (error) {
      log.warn('could not read env file', { envFile, error: error?.message });
    }
  }
  for (const key of Object.keys(env)) {
    if (/^(ALPACA|AUTOMATON)_/.test(key) && typeof env[key] === 'string') {
      secrets[key] = env[key];
    }
  }

  return { config, secrets, sources };
}

function freezeConfig(config) {
  const deepFreeze = (value) => {
    if (Array.isArray(value)) return Object.freeze(value.map(deepFreeze));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, item] of Object.entries(value)) out[key] = deepFreeze(item);
      return Object.freeze(out);
    }
    return value;
  };
  return deepFreeze(config);
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

function assertNumber(value, name, { min = -Infinity, max = Infinity } = {}) {
  if (!Number.isFinite(value)) fail('CONFIG_INVALID', `${name} must be a finite number`, { name, value });
  if (value < min || value > max) fail('CONFIG_INVALID', `${name} must be between ${min} and ${max}`, { name, value });
}

function assertPct(value, name) {
  assertNumber(value, name, { min: 0, max: 1 });
}

/**
 * Validate the merged config. Throws AutomatonError(CONFIG_INVALID) with a precise message.
 * @param {object} config
 * @returns {object} the same config
 */
export function validateConfig(config) {
  if (!config || typeof config !== 'object') fail('CONFIG_INVALID', 'config must be an object');
  if (!MODES.includes(config.mode)) fail('CONFIG_INVALID', `mode must be one of ${MODES.join('|')}`, { mode: config.mode });

  if (!Array.isArray(config.symbols) || config.symbols.length === 0) fail('CONFIG_INVALID', 'symbols must be a non-empty array');
  config.symbols.forEach((symbol, index) => {
    if (typeof symbol !== 'string' || !/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) {
      fail('CONFIG_INVALID', `symbols[${index}] must be an uppercase ticker`, { symbol });
    }
  });

  assertNumber(config.cycleIntervalSec, 'cycleIntervalSec', { min: 5 });
  assertNumber(config.reaperIntervalSec, 'reaperIntervalSec', { min: 1 });
  assertNumber(config.population.initial, 'population.initial', { min: 0, max: 1000 });
  assertNumber(config.population.cap, 'population.cap', { min: 1, max: 1000 });
  if (config.population.initial > config.population.cap) fail('CONFIG_INVALID', 'population.initial must be <= population.cap');
  assertNumber(config.endowmentUsd, 'endowmentUsd', { min: 1 });
  assertNumber(config.deathFloorUsd, 'deathFloorUsd', { min: 0 });
  assertPct(config.deathFloorPct, 'deathFloorPct');
  assertPct(config.maxDrawdownPct, 'maxDrawdownPct');
  assertPct(config.account.allocationCapPct, 'account.allocationCapPct');
  assertPct(config.account.reconciliationTolerancePct, 'account.reconciliationTolerancePct');

  for (const key of ['inferencePerCycleUsd', 'dataPerCycleUsd', 'hostingPerHourUsd', 'committedMonthlyUsd']) {
    assertNumber(config.burn[key], `burn.${key}`, { min: 0 });
  }
  for (const state of ['STABLE', 'TIGHT', 'CRITICAL']) {
    assertNumber(config.cycleBudget[state], `cycleBudget.${state}`, { min: 0 });
  }
  if (!(config.cycleBudget.STABLE > config.cycleBudget.TIGHT && config.cycleBudget.TIGHT > config.cycleBudget.CRITICAL && config.cycleBudget.CRITICAL > 0)) {
    fail('CONFIG_INVALID', 'cycleBudget must decrease STABLE > TIGHT > CRITICAL > 0');
  }

  const replication = config.replication;
  assertNumber(replication.surplus7dUsd, 'replication.surplus7dUsd', { min: 0 });
  assertNumber(replication.minRunwayHours, 'replication.minRunwayHours', { min: 0 });
  assertNumber(replication.childEndowmentUsd, 'replication.childEndowmentUsd', { min: 0 });
  if (replication.childEndowmentUsd >= config.endowmentUsd * 2) {
    fail('CONFIG_INVALID', 'replication.childEndowmentUsd must be smaller than 2x endowmentUsd');
  }

  const risk = config.risk;
  assertPct(risk.maxPositionPct, 'risk.maxPositionPct');
  assertPct(risk.maxOrderPctOfEquity, 'risk.maxOrderPctOfEquity');
  assertPct(risk.maxDailyLossPct, 'risk.maxDailyLossPct');
  assertPct(risk.maxBuildSpendPct, 'risk.maxBuildSpendPct');
  assertNumber(risk.maxOpenPositions, 'risk.maxOpenPositions', { min: 1, max: 100 });
  assertNumber(risk.maxDailyOrders, 'risk.maxDailyOrders', { min: 1, max: 1000 });
  assertNumber(risk.maxOrderNotionalUsd, 'risk.maxOrderNotionalUsd', { min: 0 });
  assertNumber(risk.minOrderNotionalUsd, 'risk.minOrderNotionalUsd', { min: 0 });
  assertNumber(risk.maxSpreadBps, 'risk.maxSpreadBps', { min: 0 });
  assertNumber(risk.minPriceUsd, 'risk.minPriceUsd', { min: 0 });
  assertNumber(risk.maxSlippageBps, 'risk.maxSlippageBps', { min: 0 });
  assertNumber(risk.maxOrdersPerCycle, 'risk.maxOrdersPerCycle', { min: 1, max: 100 });
  if (!Array.isArray(risk.sessionWindow) || risk.sessionWindow.length !== 2) {
    fail('CONFIG_INVALID', 'risk.sessionWindow must be [open, close] as "HH:MM"');
  }
  for (const value of risk.sessionWindow) {
    if (!/^\d{1,2}:\d{2}$/.test(String(value))) fail('CONFIG_INVALID', 'risk.sessionWindow entries must be "HH:MM"', { value });
  }
  if (risk.allowShort && !risk.allowMargin) {
    fail('CONFIG_INVALID', 'risk.allowShort requires risk.allowMargin (shorting is leverage)');
  }

  const data = config.data;
  assertNumber(data.lookbackBars, 'data.lookbackBars', { min: 20, max: 1000 });
  assertNumber(data.maxHypothesesPerCycle, 'data.maxHypothesesPerCycle', { min: 1, max: 200 });
  assertNumber(data.maxProofAgeDays, 'data.maxProofAgeDays', { min: 0, max: 365 });
  if (typeof data.timeframe !== 'string' || data.timeframe.length === 0) fail('CONFIG_INVALID', 'data.timeframe is required');
  const DATA_TIMEFRAMES = ['1Min', '5Min', '15Min', '30Min', '1Hour', '2Hour', '4Hour', '1Day'];
  if (!DATA_TIMEFRAMES.includes(data.timeframe)) {
    fail('CONFIG_INVALID', `data.timeframe must be one of ${DATA_TIMEFRAMES.join('|')}`);
  }
  const DATA_FEEDS = ['iex', 'sip'];
  if (!DATA_FEEDS.includes(data.feed ?? 'iex')) {
    fail('CONFIG_INVALID', `data.feed must be one of ${DATA_FEEDS.join('|')}`);
  }

  const research = config.research;
  if (!research || typeof research !== 'object') fail('CONFIG_INVALID', 'research config object is required');
  if (typeof research.enabled !== 'boolean') fail('CONFIG_INVALID', 'research.enabled must be boolean');
  if (typeof research.influence !== 'boolean') fail('CONFIG_INVALID', 'research.influence must be boolean');
  assertNumber(research.intervalSec, 'research.intervalSec', { min: 60, max: 86_400 });
  assertNumber(research.staggerSec, 'research.staggerSec', { min: 0, max: 3600 });
  assertNumber(research.maxRunsPerCycle, 'research.maxRunsPerCycle', { min: 1, max: 10 });
  assertNumber(research.maxNewsPerAgent, 'research.maxNewsPerAgent', { min: 1, max: 20 });
  assertNumber(research.newsLookbackHours, 'research.newsLookbackHours', { min: 1, max: 168 });
  assertNumber(research.costPerRunUsd, 'research.costPerRunUsd', { min: 0, max: 1 });
  assertNumber(research.maxAgeSec, 'research.maxAgeSec', { min: 300, max: 86_400 });
  assertNumber(research.maxConcurrent, 'research.maxConcurrent', { min: 1, max: 8 });
  assertNumber(research.maxInputChars, 'research.maxInputChars', { min: 1000, max: 60_000 });
  assertNumber(research.maxOutputTokens, 'research.maxOutputTokens', { min: 128, max: 4000 });
  assertNumber(research.logLimit, 'research.logLimit', { min: 20, max: 1000 });
  assertNumber(research.vetoSentiment, 'research.vetoSentiment', { min: -1, max: 0 });
  assertNumber(research.exitSentiment, 'research.exitSentiment', { min: -1, max: 0 });
  assertNumber(research.vetoMinRisks, 'research.vetoMinRisks', { min: 2, max: 5 });
  assertNumber(research.riskPenalty, 'research.riskPenalty', { min: 0.2, max: 1 });
  assertNumber(research.errorCooldownSec, 'research.errorCooldownSec', { min: 60, max: 86_400 });
  const RESEARCH_SCHEDULE_MODES = ['interval', 'pre-open', 'post-close', 'pre-open+post-close'];
  if (!RESEARCH_SCHEDULE_MODES.includes(research.scheduleMode)) {
    fail('CONFIG_INVALID', `research.scheduleMode must be one of ${RESEARCH_SCHEDULE_MODES.join('|')}`);
  }
  assertNumber(research.preMarketOffsetMin, 'research.preMarketOffsetMin', { min: 0, max: 180 });
  assertNumber(research.postCloseOffsetMin, 'research.postCloseOffsetMin', { min: 0, max: 180 });
  if (research.provider !== null && typeof research.provider !== 'string') {
    fail('CONFIG_INVALID', 'research.provider must be a string or null');
  }
  if (research.model !== null && typeof research.model !== 'string') {
    fail('CONFIG_INVALID', 'research.model must be a string or null');
  }

  const rewards = config.rewards;
  if (!rewards || typeof rewards !== 'object') fail('CONFIG_INVALID', 'rewards config object is required');
  if (typeof rewards.enabled !== 'boolean') fail('CONFIG_INVALID', 'rewards.enabled must be boolean');
  if (!['daily', 'weekly', 'monthly'].includes(rewards.period)) {
    fail('CONFIG_INVALID', 'rewards.period must be daily|weekly|monthly');
  }
  // v3.3: new settings win; the old account-cash/rankPercents fields are accepted only as legacy.
  if (!['trading-performance', 'account-cash'].includes(rewards.basis)) {
    fail('CONFIG_INVALID', 'rewards.basis must be "trading-performance" (or deprecated "account-cash")');
  }
  if (!Array.isArray(rewards.rankShares) || rewards.rankShares.length !== 3) {
    fail('CONFIG_INVALID', 'rewards.rankShares must be exactly 3 numbers');
  }
  const rankSharesSum = rewards.rankShares.reduce((sum, share) => sum + Number(share), 0);
  for (const share of rewards.rankShares) {
    assertNumber(share, 'rewards.rankShares[i]', { min: 0, max: 1 });
  }
  if (rankSharesSum > 1.000001) fail('CONFIG_INVALID', 'rewards.rankShares must sum to at most 1');
  assertNumber(rewards.rewardBudgetPctOfPool, 'rewards.rewardBudgetPctOfPool', { min: 0, max: 1 });
  assertNumber(rewards.maxRewardPerAgentPctOfCapital, 'rewards.maxRewardPerAgentPctOfCapital', { min: 0, max: 1 });
  assertNumber(rewards.minTradingProfitUsd, 'rewards.minTradingProfitUsd', { min: 0, max: 1_000_000 });
  assertNumber(rewards.minTrades, 'rewards.minTrades', { min: 0, max: 100_000 });
  if (!Number.isInteger(Number(rewards.minTrades))) fail('CONFIG_INVALID', 'rewards.minTrades must be an integer');
  assertNumber(rewards.maxDrawdownPct, 'rewards.maxDrawdownPct', { min: 0, max: 1 });
  if (rewards.rankPercents !== undefined && rewards.rankPercents !== null) {
    if (!Array.isArray(rewards.rankPercents) || rewards.rankPercents.length !== 3) {
      fail('CONFIG_INVALID', 'rewards.rankPercents (deprecated) must be exactly 3 numbers when present');
    }
    for (const percent of rewards.rankPercents) {
      assertNumber(percent, 'rewards.rankPercents[i]', { min: 0, max: 0.5 });
    }
  }
  if (rewards.maxPerPeriodUsd !== null) {
    assertNumber(rewards.maxPerPeriodUsd, 'rewards.maxPerPeriodUsd', { min: 0, max: 1_000_000 });
  }

  // v3.4 aggressive growth profiles: percentages are population shares, profile values are
  // execution ceilings/ceilings only and are re-checked by the brakes.
  const aggression = config.aggression;
  if (!aggression || typeof aggression !== 'object') fail('CONFIG_INVALID', 'aggression config object is required');
  if (typeof aggression.enabled !== 'boolean') fail('CONFIG_INVALID', 'aggression.enabled must be boolean');
  assertPct(aggression.aggressivePct, 'aggression.aggressivePct');
  assertPct(aggression.balancedPct, 'aggression.balancedPct');
  if (Number(aggression.aggressivePct) + Number(aggression.balancedPct) > 1.000001) {
    fail('CONFIG_INVALID', 'aggression.aggressivePct + balancedPct must be at most 1');
  }
  assertNumber(aggression.capitalMultiplier, 'aggression.capitalMultiplier', { min: 0.5, max: 5 });
  const AGGRESSION_PROFILES = ['aggressive', 'balanced', 'conservative'];
  if (!aggression.profiles || typeof aggression.profiles !== 'object') {
    fail('CONFIG_INVALID', 'aggression.profiles is required');
  }
  for (const name of AGGRESSION_PROFILES) {
    const profile = aggression.profiles[name];
    if (!profile || typeof profile !== 'object') fail('CONFIG_INVALID', `aggression.profiles.${name} is required`);
    for (const key of ['basketSizeDay', 'basketSizeSwing', 'maxOpenPositionsDay', 'maxOpenPositionsSwing', 'maxOrdersPerCycle']) {
      assertNumber(profile[key], `aggression.profiles.${name}.${key}`, { min: 1, max: 100 });
      if (!Number.isInteger(Number(profile[key]))) fail('CONFIG_INVALID', `aggression.profiles.${name}.${key} must be an integer`);
    }
    for (const key of ['entryZMultiplier', 'sizePctMultiplier', 'stopPctMultiplier', 'targetPctMultiplier', 'maxHoldBarsMultiplier']) {
      assertNumber(profile[key], `aggression.profiles.${name}.${key}`, { min: 0.1, max: 5 });
    }
    assertPct(profile.policySizeFloor, `aggression.profiles.${name}.policySizeFloor`);
    if (typeof profile.respectStandDown !== 'boolean') {
      fail('CONFIG_INVALID', `aggression.profiles.${name}.respectStandDown must be boolean`);
    }
  }

  const targets = config.targets;
  if (!targets || typeof targets !== 'object') fail('CONFIG_INVALID', 'targets config object is required');
  if (typeof targets.enabled !== 'boolean') fail('CONFIG_INVALID', 'targets.enabled must be boolean');
  assertNumber(targets.annualReturnPct, 'targets.annualReturnPct', { min: 0, max: 5 });

  // Per-tier execution cadence (optional; null keeps the single-cycle legacy behaviour).
  if (config.cadence !== null && config.cadence !== undefined) {
    if (typeof config.cadence !== 'object') fail('CONFIG_INVALID', 'cadence must be an object or null');
    const DATA_TIMEFRAMES_CADENCE = ['1Min', '5Min', '15Min', '30Min', '1Hour', '2Hour', '4Hour', '1Day'];
    for (const tier of ['day', 'swing']) {
      const entry = config.cadence[tier];
      if (!entry || typeof entry !== 'object') fail('CONFIG_INVALID', `cadence.${tier} is required`);
      assertNumber(entry.intervalSec, `cadence.${tier}.intervalSec`, { min: 5, max: 86_400 });
      if (!DATA_TIMEFRAMES_CADENCE.includes(entry.timeframe)) {
        fail('CONFIG_INVALID', `cadence.${tier}.timeframe must be one of ${DATA_TIMEFRAMES_CADENCE.join('|')}`);
      }
    }
  }
  // v3.2: 70/30 strategy mix + multi-symbol portfolio limits.
  const mixCfg = config.strategyMix;
  if (!mixCfg || typeof mixCfg !== 'object') fail('CONFIG_INVALID', 'strategyMix config object is required');
  assertNumber(mixCfg.dayPct, 'strategyMix.dayPct', { min: 0.1, max: 0.9 });
  const portfolioCfg = config.portfolio;
  if (!portfolioCfg || typeof portfolioCfg !== 'object') fail('CONFIG_INVALID', 'portfolio config object is required');
  assertNumber(portfolioCfg.basketSizeDay, 'portfolio.basketSizeDay', { min: 1, max: 8 });
  assertNumber(portfolioCfg.basketSizeSwing, 'portfolio.basketSizeSwing', { min: 1, max: 8 });
  assertNumber(portfolioCfg.maxOpenPositionsDay, 'portfolio.maxOpenPositionsDay', { min: 1, max: 12 });
  assertNumber(portfolioCfg.maxOpenPositionsSwing, 'portfolio.maxOpenPositionsSwing', { min: 1, max: 12 });
  assertNumber(portfolioCfg.maxOrdersPerCycle, 'portfolio.maxOrdersPerCycle', { min: 1, max: 8 });
  for (const key of ['basketSizeDay', 'basketSizeSwing', 'maxOpenPositionsDay', 'maxOpenPositionsSwing', 'maxOrdersPerCycle']) {
    if (!Number.isInteger(portfolioCfg[key])) fail('CONFIG_INVALID', `portfolio.${key} must be an integer`);
  }
  const engineCfg = config.engine;
  if (!engineCfg || typeof engineCfg !== 'object') fail('CONFIG_INVALID', 'engine config object is required');
  if (typeof engineCfg.tradingHoursOnly !== 'boolean') fail('CONFIG_INVALID', 'engine.tradingHoursOnly must be boolean');
  assertNumber(engineCfg.offHoursIntervalSec, 'engine.offHoursIntervalSec', { min: 30, max: 3600 });

  // Per-bot agent brain (optional block; absent = brain disabled / neutral).
  const agentsCfg = config.agents;
  if (!agentsCfg || typeof agentsCfg !== 'object') fail('CONFIG_INVALID', 'agents config object is required');
  if (typeof agentsCfg.enabled !== 'boolean') fail('CONFIG_INVALID', 'agents.enabled must be boolean');
  assertNumber(agentsCfg.reviewIntervalDaySec, 'agents.reviewIntervalDaySec', { min: 60, max: 86_400 });
  assertNumber(agentsCfg.reviewIntervalSwingSec, 'agents.reviewIntervalSwingSec', { min: 300, max: 86_400 });
  assertNumber(agentsCfg.maxReviewsPerCycle, 'agents.maxReviewsPerCycle', { min: 1, max: 30 });
  assertNumber(agentsCfg.costPerReviewUsd, 'agents.costPerReviewUsd', { min: 0, max: 1 });
  assertNumber(agentsCfg.maxAgeSec, 'agents.maxAgeSec', { min: 300, max: 86_400 });
  assertNumber(agentsCfg.logLimit, 'agents.logLimit', { min: 10, max: 1000 });
  assertNumber(agentsCfg.maxInputChars, 'agents.maxInputChars', { min: 1000, max: 60_000 });
  assertNumber(agentsCfg.maxOutputTokens, 'agents.maxOutputTokens', { min: 128, max: 4000 });
  assertNumber(agentsCfg.errorCooldownSec, 'agents.errorCooldownSec', { min: 60, max: 86_400 });

  // Multi-instrument paper trading (docs/INSTRUMENTS.md). Naked short options are never allowed.
  const inst = config.instruments;
  if (!inst || typeof inst !== 'object') fail('CONFIG_INVALID', 'instruments config object is required');
  for (const key of ['enabled', 'allowMargin', 'allowShort', 'allowOptions', 'allowCoveredCalls', 'allowSpreads', 'shortableOnly']) {
    if (typeof inst[key] !== 'boolean') fail('CONFIG_INVALID', `instruments.${key} must be boolean`);
  }
  assertNumber(inst.maxMarginPctEquity, 'instruments.maxMarginPctEquity', { min: 0, max: 3 });
  assertNumber(inst.maxShortPctEquity, 'instruments.maxShortPctEquity', { min: 0, max: 3 });
  assertNumber(inst.maxShortNotionalUsd, 'instruments.maxShortNotionalUsd', { min: 0, max: 1_000_000 });
  assertNumber(inst.maxOptionPremiumPctEquity, 'instruments.maxOptionPremiumPctEquity', { min: 0, max: 1 });
  assertNumber(inst.maxOptionPremiumUsd, 'instruments.maxOptionPremiumUsd', { min: 0, max: 1_000_000 });
  assertNumber(inst.maxContracts, 'instruments.maxContracts', { min: 1, max: 100 });
  assertNumber(inst.minDTE, 'instruments.minDTE', { min: 1, max: 90 });
  assertNumber(inst.maxDTE, 'instruments.maxDTE', { min: 1, max: 365 });
  assertNumber(inst.autoCloseDTE, 'instruments.autoCloseDTE', { min: 0, max: 30 });
  if (inst.maxDTE < inst.minDTE) fail('CONFIG_INVALID', 'instruments.maxDTE must be >= instruments.minDTE');
  if (inst.autoCloseDTE > inst.minDTE) {
    fail('CONFIG_INVALID', 'instruments.autoCloseDTE must be <= instruments.minDTE');
  }
  if (inst.allowNakedShortOptions === true) {
    fail('CONFIG_INVALID', 'naked short options are not supported; use covered calls or defined-risk spreads');
  }
  if (!['indicative', 'opra'].includes(inst.optionDataFeed)) {
    fail('CONFIG_INVALID', 'instruments.optionDataFeed must be indicative|opra');
  }

  if (typeof config.paths.stateDir !== 'string' || config.paths.stateDir.length === 0) {
    fail('CONFIG_INVALID', 'paths.stateDir is required');
  }
  if (config.allowLive && config.mode !== 'live') {
    // allowed (a paper run can be "ready" for live) but worth surfacing
    log.debug('allowLive is true while mode is not live; live stays off until mode=live');
  }
  return config;
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

/**
 * Absolute filesystem paths for durable engine state.
 * @param {object} config
 */
export function statePaths(config) {
  const stateDir = path.resolve(config.paths.stateDir);
  return {
    stateDir,
    registry: path.join(stateDir, 'registry.json'),
    ledger: path.join(stateDir, 'ledger.json'),
    journal: path.join(stateDir, 'obituaries.jsonl'),
    hypothesesQueue: path.join(stateDir, 'hypotheses.json'),
    hypothesesLog: path.join(stateDir, 'hypotheses.jsonl'),
    specsDir: path.join(stateDir, 'specs'),
    traces: path.join(stateDir, 'traces.jsonl'),
    stateFile: path.join(stateDir, 'state.json'),
    deaths: path.join(stateDir, 'deaths.json'),
    dayStats: path.join(stateDir, 'day-stats.json'),
    killSwitch: path.join(stateDir, 'KILL_SWITCH'),
    liveArmed: path.join(stateDir, 'LIVE_ARMED'),
    configFile: path.join(stateDir, 'config.json'),
    envFile: path.resolve(config.paths.envFile),
    reaperLog: path.join(stateDir, 'reaper.log'),
    reaperPid: path.join(stateDir, 'reaper.pid'),
    reaperHeartbeat: path.join(stateDir, 'reaper.heartbeat.json'),
    engineLog: path.join(stateDir, 'engine.log'),
    treasuryState: path.join(stateDir, 'treasury.json'),
    researchDir: path.join(stateDir, 'research'),
    researchState: path.join(stateDir, 'research', 'state.json'),
    rankings: path.join(stateDir, 'rankings.json'),
    rewardsFile: path.join(stateDir, 'rewards.json'),
    settingsFile: path.join(stateDir, 'settings.json'),
  };
}

/** Live trading needs all three: mode=live, allowLive=true, and the operator marker file. */
export function liveArmed(config) {
  return Boolean(
    config
      && config.mode === 'live'
      && config.allowLive === true
      && fileExists(statePaths(config).liveArmed),
  );
}

// ---------------------------------------------------------------------------
// credentials
// ---------------------------------------------------------------------------

export const PAPER_BASE_URL = 'https://paper-api.alpaca.markets';
export const LIVE_BASE_URL = 'https://api.alpaca.markets';
export const DATA_BASE_URL = 'https://data.alpaca.markets';

function pickSecret(secrets, names) {
  for (const name of names) {
    const value = secrets?.[name];
    if (typeof value === 'string' && value.trim().length > 0) return { value: value.trim(), source: name };
  }
  return null;
}

export function hasCredentials(secrets, mode = 'paper') {
  if (mode === 'sim') return true;
  const [keyNames, secretNames] = mode === 'live'
    ? [['ALPACA_LIVE_API_KEY_ID', 'ALPACA_API_KEY_ID'], ['ALPACA_LIVE_API_SECRET_KEY', 'ALPACA_API_SECRET_KEY']]
    : [['ALPACA_PAPER_API_KEY_ID', 'ALPACA_API_KEY_ID'], ['ALPACA_PAPER_API_SECRET_KEY', 'ALPACA_API_SECRET_KEY']];
  return Boolean(pickSecret(secrets, keyNames) && pickSecret(secrets, secretNames));
}

/**
 * Resolve the credentials + endpoint for the configured mode.
 * Live mode is refused unless mode=live, allowLive=true, and LIVE_ARMED exists.
 * @param {object} config
 * @param {Record<string,string>} secrets
 * @returns {{ mode: string, keyId: string|null, secretKey: string|null, baseUrl: string|null,
 *             dataBaseUrl: string, source: string }}
 */
export function resolveCredentials(config, secrets = {}) {
  const mode = config.mode;
  if (mode === 'sim') {
    return {
      mode,
      keyId: null,
      secretKey: null,
      baseUrl: null,
      dataBaseUrl: DATA_BASE_URL,
      source: 'sim',
    };
  }

  const live = mode === 'live';
  if (live) {
    if (!liveArmed(config)) {
      fail('LIVE_NOT_ARMED', 'live mode requires mode=live, allowLive=true, and the LIVE_ARMED marker file');
    }
  }

  const keyNames = live
    ? ['ALPACA_LIVE_API_KEY_ID', 'ALPACA_API_KEY_ID']
    : ['ALPACA_PAPER_API_KEY_ID', 'ALPACA_API_KEY_ID'];
  const secretNames = live
    ? ['ALPACA_LIVE_API_SECRET_KEY', 'ALPACA_API_SECRET_KEY']
    : ['ALPACA_PAPER_API_SECRET_KEY', 'ALPACA_API_SECRET_KEY'];

  const key = pickSecret(secrets, keyNames);
  const secret = pickSecret(secrets, secretNames);
  if (!key || !secret) {
    fail(
      'CONFIG_INVALID',
      `missing Alpaca credentials for ${mode} mode. Set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY in ${statePaths(config).envFile}`,
      { mode, envFile: statePaths(config).envFile },
    );
  }
  return {
    mode,
    keyId: key.value,
    secretKey: secret.value,
    baseUrl: live ? LIVE_BASE_URL : PAPER_BASE_URL,
    dataBaseUrl: DATA_BASE_URL,
    source: `${key.source}+${secret.source}`,
  };
}

// ---------------------------------------------------------------------------
// public view
// ---------------------------------------------------------------------------

/** Config safe to show in the UI, tool output, and logs (no secrets by construction). */
export function publicConfig(config) {
  const out = redactSecrets(config);
  out.derived = {
    liveArmed: liveArmed(config),
    mode: config.mode,
  };
  return out;
}

export function configSummary(config) {
  return {
    mode: config.mode,
    allowLive: config.allowLive,
    symbols: config.symbols,
    cycleIntervalSec: config.cycleIntervalSec,
    population: config.population,
    endowmentUsd: config.endowmentUsd,
    deathFloorUsd: Math.max(config.deathFloorUsd, config.deathFloorPct * config.endowmentUsd),
    replication: config.replication,
    research: {
      enabled: config.research.enabled,
      influence: config.research.influence,
      scheduleMode: config.research.scheduleMode,
      intervalSec: config.research.intervalSec,
      preMarketOffsetMin: config.research.preMarketOffsetMin,
      postCloseOffsetMin: config.research.postCloseOffsetMin,
    },
    rewards: {
      enabled: config.rewards.enabled,
      period: config.rewards.period,
      basis: config.rewards.basis,
      rankShares: config.rewards.rankShares,
      rewardBudgetPctOfPool: config.rewards.rewardBudgetPctOfPool,
      maxPerPeriodUsd: config.rewards.maxPerPeriodUsd,
      maxRewardPerAgentPctOfCapital: config.rewards.maxRewardPerAgentPctOfCapital,
      minTradingProfitUsd: config.rewards.minTradingProfitUsd,
      minTrades: config.rewards.minTrades,
      maxDrawdownPct: config.rewards.maxDrawdownPct,
    },
    agents: {
      enabled: config.agents.enabled,
      reviewIntervalDaySec: config.agents.reviewIntervalDaySec,
      reviewIntervalSwingSec: config.agents.reviewIntervalSwingSec,
      maxReviewsPerCycle: config.agents.maxReviewsPerCycle,
      costPerReviewUsd: config.agents.costPerReviewUsd,
      maxAgeSec: config.agents.maxAgeSec,
    },
    cadence: config.cadence,
    strategyMix: config.strategyMix,
    portfolio: config.portfolio,
    aggression: config.aggression,
    targets: config.targets,
    instruments: {
      enabled: config.instruments.enabled,
      allowMargin: config.instruments.allowMargin,
      allowShort: config.instruments.allowShort,
      allowOptions: config.instruments.allowOptions,
      allowCoveredCalls: config.instruments.allowCoveredCalls,
      allowSpreads: config.instruments.allowSpreads,
      maxMarginPctEquity: config.instruments.maxMarginPctEquity,
      maxShortPctEquity: config.instruments.maxShortPctEquity,
      maxShortNotionalUsd: config.instruments.maxShortNotionalUsd,
      maxOptionPremiumPctEquity: config.instruments.maxOptionPremiumPctEquity,
      maxOptionPremiumUsd: config.instruments.maxOptionPremiumUsd,
      maxContracts: config.instruments.maxContracts,
      minDTE: config.instruments.minDTE,
      maxDTE: config.instruments.maxDTE,
      autoCloseDTE: config.instruments.autoCloseDTE,
      optionDataFeed: config.instruments.optionDataFeed,
    },
    tradingHoursOnly: config.engine?.tradingHoursOnly === true,
    stateDir: config.paths.stateDir,
    envFile: config.paths.envFile,
  };
}

export { safeJson };
