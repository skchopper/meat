/**
 * PER-BOT AGENT BRAIN — every population bot gets its own isolated agent review.
 *
 * Contract: docs/BOT-AGENTS.md.
 *
 * A population bot is no longer only a deterministic rule set driven by a shared cycle: on its own
 * cadence it gets a private LLM review whose context contains ONLY its own identity, genome/spec,
 * virtual book, the market snapshot for its symbol and its own prior reviews. The review returns a
 * durable policy (stance, size multiplier, exit pressure, thesis, plan) that the Executor consumes.
 * No other bot's data, no operator context, no shared conversation.
 *
 * This is the Harness-backed "agent" of a bot: isolated prompt + isolated journal + isolated policy,
 * on the same LLM seam (Harness llm bridge / CLI DeepSeek fallback). The engine keeps execution and
 * the 18 hard brakes deterministic so fast reactions never wait on a model turn.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { statePaths } from './config.js';
import { extractJsonObject } from './research.js';
import { strategyTypeForFamily } from './strategy-types.js';
import {
  agentInstrumentPermissions,
  normalizeInstrumentPolicy,
  optionPremiumBudget,
  playbookForFamily,
  resolveInstrumentPermissions,
} from './instruments.js';
import {
  appendJsonl,
  createLogger,
  ensureDir,
  readJson,
  readJsonl,
  round2,
  round4,
  SYSTEM_CLOCK,
  writeJsonAtomic,
} from './util.js';

const log = createLogger('bot-agent');

const STANCES = ['trade', 'cautious', 'stand_down'];
const MAX_PLAN = 4;
const MAX_WATCH = 4;
const MAX_THESIS = 300;
const MAX_PRIOR_REVIEWS = 5;
const ATTEMPTS = 2;

const SYSTEM_PROMPT = [
  'You are the private trading agent for exactly ONE automated bot in a mortality-engineered population.',
  'You manage a BASKET of company stocks (not just one): the deterministic executor evaluates every',
  'basket symbol and your policy applies to the whole basket, so size/risk decisions must work for',
  'multiple simultaneous positions. You see only your own bot: its strategy genome, basket, virtual',
  'book, market data, research briefing and your own previous reviews. You know nothing about other',
  'bots and must not mention them. You do not place orders and cannot change your budget; a',
  'deterministic executor applies your policy inside a hard brake wall. Human capital is at risk: be',
  'conservative when the evidence is weak.',
  'You may choose HOW this bot expresses its edge: long or short stock, a long call/put, a covered',
  'call (only if the bot owns 100+ shares), or a defined-risk vertical spread. Use the instrument',
  'that best fits the setup and is affordable in the provided INSTRUMENT CONTEXT; prefer options or',
  'short stock when they materially improve the risk/reward, otherwise stock or "auto".',
  'Return ONE strict JSON object and nothing else:',
  '{"stance":"trade"|"cautious"|"stand_down",',
  ' "sizeMultiplier": number 0.2..1 (fraction of normal entry size; never above 1),',
  ' "riskMultiplier": number 0.5..1.5 (reserved for risk context),',
  ' "exitPressure":"none"|"exit" (exit means: close any open position now),',
  ' "confidence": number 0..1,',
  ' "thesis": string <=300 characters explaining your read of this bot\'s setup,',
  ' "plan": [up to 4 short strings: what you intend over the next review window],',
  ' "watch": [up to 4 symbols from the provided context you want to watch],',
  ' "instrument": {"prefer": "auto"|"long_stock"|"short_stock"|one of the provided structures,',
  '   "maxPremiumUsd": number<=cap or null, "maxContracts": integer<=cap or null,',
  '   "dteMin": integer within provided window or null, "dteMax": integer within window or null}}',
  'Rules: stand_down = do not open new positions (exits still allowed); cautious = reduce size but',
  'stay willing to trade when the edge is real; trade = normal execution.',
  'CRITICAL: LONG STOCK CAN BE FRACTIONAL. A high share price is NEVER a reason to stand_down: the',
  'executor sizes entries from sizeBudgetUsd, so a $500 stock can be bought with $5. If no option',
  'contract fits the premium budget, the executor falls back to fractional long stock — do not block',
  'that fallback. Use stand_down ONLY for weak/conflicting evidence or unacceptable risk, never',
  'because one whole share/contract is unaffordable, because a quote is stale, or because the market',
  'is closed (the engine already pauses off-session).',
  'Use "auto" to let the deterministic family playbook choose. Never invent structures that were',
  'not offered.',
].join(' ');

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function numberOrNull(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function stringArray(value, max, maxLength = 200) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim().slice(0, maxLength))
    .filter(Boolean)
    .slice(0, max);
}

export function normalizePolicy(raw, { nowMs, reviewSec, config, permissions, agent } = {}) {
  if (!isPlainObject(raw)) throw new Error('policy is not an object');
  const stance = String(raw.stance ?? '').trim().toLowerCase();
  if (!STANCES.includes(stance)) throw new Error(`policy stance must be one of ${STANCES.join('|')}`);
  const confidence = numberOrNull(raw.confidence);
  if (confidence === null) throw new Error('policy requires numeric confidence');
  const sizeRaw = numberOrNull(raw.sizeMultiplier);
  const exitPressure = String(raw.exitPressure ?? 'none').trim().toLowerCase() === 'exit' ? 'exit' : 'none';
  const resolvedPermissions = permissions ?? (config ? agentInstrumentPermissions(config, agent) : resolveInstrumentPermissions({}));
  return {
    stance,
    sizeMultiplier: round4(clamp(sizeRaw === null ? 1 : sizeRaw, 0.2, 1)),
    riskMultiplier: round4(clamp(numberOrNull(raw.riskMultiplier) ?? 1, 0.5, 1.5)),
    exitPressure,
    confidence: round4(clamp(confidence, 0, 1)),
    thesis: String(raw.thesis ?? '').trim().slice(0, MAX_THESIS),
    plan: stringArray(raw.plan, MAX_PLAN),
    watch: stringArray(raw.watch, MAX_WATCH, 12).map((symbol) => symbol.toUpperCase()),
    instrument: normalizeInstrumentPolicy(raw.instrument, { config: config ?? { instruments: {} }, permissions: resolvedPermissions }),
    atMs: nowMs,
    at: new Date(nowMs).toISOString(),
    reviewSec: Math.max(60, Number(reviewSec) || 300),
  };
}

/**
 * @param {{config: object, paths?: object, clock?: object, registry: object, ledger: object,
 *          broker?: object, researcher?: object, generate?: Function, logger?: object}} options
 */
export function createBotAgents({ config, paths, clock, registry, ledger, broker, researcher, generate, specFor } = {}) {
  if (!config || !registry || !ledger) throw new Error('createBotAgents requires { config, registry, ledger }');
  const cfg = config.agents ?? {};
  const currentClock = clock && typeof clock.now === 'function' ? clock : SYSTEM_CLOCK;
  const resolved = { ...statePaths(config), ...(paths ?? {}) };
  const stateDir = resolved.stateDir;
  const agentsDir = path.join(stateDir, 'agents');
  const stateFile = path.join(agentsDir, 'state.json');
  const enabled = cfg.enabled !== false;
  const configured = typeof generate === 'function';
  const reviewIntervalDayMs = Math.max(60, Number(cfg.reviewIntervalDaySec) || 300) * 1000;
  const reviewIntervalSwingMs = Math.max(300, Number(cfg.reviewIntervalSwingSec) || 3600) * 1000;
  const maxReviewsPerCycle = Math.max(1, Math.min(30, Number(cfg.maxReviewsPerCycle) || 4));
  const costPerReviewUsd = Math.max(0, numberOrNull(cfg.costPerReviewUsd) ?? 0);
  const maxAgeMs = Math.max(300, Number(cfg.maxAgeSec) || 7200) * 1000;
  const logLimit = Math.max(10, Math.min(1000, Number(cfg.logLimit) || 120));
  const maxInputChars = Math.max(1000, Number(cfg.maxInputChars) || 8000);
  const maxOutputTokens = Math.max(128, Math.min(4000, Number(cfg.maxOutputTokens) || 700));
  const errorCooldownMs = Math.max(60, Math.min(86_400, Number(cfg.errorCooldownSec) || 900)) * 1000;

  let initialized = false;
  let runs = 0;
  let errors = 0;
  let lastError = null;
  let lastReviewAt = null;
  let pausedUntilMs = 0;
  let pauseReason = null;
  let lastProvider = null;
  let lastModel = null;
  /** @type {Map<string, {lastReviewAt:number, policy:object|null, reviewCount:number}>} */
  const perAgent = new Map();

  function ensureAgent(agentId) {
    if (!perAgent.has(agentId)) perAgent.set(agentId, { lastReviewAt: 0, policy: null, reviewCount: 0 });
    return perAgent.get(agentId);
  }

  function logFile(agentId) {
    return path.join(agentsDir, `${agentId}.jsonl`);
  }

  function reviewSecFor(agent) {
    const type = strategyTypeForFamily(agent?.genome?.family);
    return type.category === 'day' ? Math.round(reviewIntervalDayMs / 1000) : Math.round(reviewIntervalSwingMs / 1000);
  }

  function reviewIntervalMsFor(agent) {
    return reviewSecFor(agent) * 1000;
  }

  function pauseAfterProviderError(message, nowMs) {
    const fatal = /insufficient balance|insufficient_quota|invalid api key|unauthorized|401|payment|billing/i.test(String(message));
    const cooldown = fatal ? Math.max(errorCooldownMs, 60 * 60 * 1000) : errorCooldownMs;
    pausedUntilMs = Math.max(pausedUntilMs, nowMs + cooldown);
    pauseReason = String(message ?? 'provider error').slice(0, 200);
  }

  async function init() {
    if (initialized) return;
    await ensureDir(agentsDir);
    const saved = await readJson(stateFile, null);
    if (isPlainObject(saved?.agents)) {
      for (const [agentId, entry] of Object.entries(saved.agents)) {
        perAgent.set(agentId, {
          // Policies survive for the dashboard, but every process start re-reviews the population:
          // an old stand_down decision must not silently block entries for up to an hour after a
          // restart while the market has moved on. Reviews are cheap and capped per cycle.
          lastReviewAt: 0,
          policy: isPlainObject(entry?.policy) ? entry.policy : null,
          reviewCount: Math.max(0, Math.trunc(numberOrNull(entry?.reviewCount) ?? 0)),
        });
      }
    }
    pausedUntilMs = numberOrNull(saved?.pausedUntilMs) ?? 0;
    pauseReason = typeof saved?.pauseReason === 'string' ? saved.pauseReason : null;
    initialized = true;
  }

  async function saveState() {
    const agents = {};
    for (const [agentId, entry] of perAgent.entries()) agents[agentId] = entry;
    await writeJsonAtomic(stateFile, {
      version: 1,
      runs,
      errors,
      lastError,
      lastReviewAt,
      pausedUntilMs,
      pauseReason,
      provider: lastProvider,
      model: lastModel,
      agents,
    });
  }

  async function readOwnPrior(agentId) {
    try {
      const rows = await readJsonl(logFile(agentId));
      return rows.slice(-MAX_PRIOR_REVIEWS);
    } catch {
      return [];
    }
  }

  async function trimLog(agentId) {
    try {
      const rows = await readJsonl(logFile(agentId));
      if (rows.length <= logLimit) return;
      const kept = rows.slice(-logLimit);
      await fsp.writeFile(logFile(agentId), `${kept.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    } catch {
      /* best effort */
    }
  }

  function buildUserPrompt({ agent, snapshot, spec, prior, market, researchBriefing, account }) {
    const type = strategyTypeForFamily(agent?.genome?.family);
    const symbol = String(spec?.symbol ?? agent?.genome?.symbol ?? '').toUpperCase();
    const marketView = isPlainObject(market) ? market : {};
    const quote = marketView.quotes?.[symbol] ?? null;
    const price = numberOrNull(marketView.prices?.[symbol]);
    const permissions = agentInstrumentPermissions(config, agent);
    const playbook = playbookForFamily(agent?.genome?.family);
    const equityUsd = numberOrNull(snapshot?.equityUsd);
    const premiumBudget = optionPremiumBudget({ config, equityUsd, mandateMaxUsd: null });
    const risk = config?.risk ?? {};
    const maxOrderCap = Number.isFinite(Number(risk.maxOrderNotionalUsd)) ? Number(risk.maxOrderNotionalUsd) : null;
    const pctCap = Number(risk.maxOrderPctOfEquity ?? 0.5) * (equityUsd ?? 0);
    const sizeBudgetUsd = round2(Math.max(0, Math.min(maxOrderCap ?? pctCap, pctCap)));
    const accountCaps = isPlainObject(account) ? account : {};
    const brokerMarginUnavailable = Number.isFinite(Number(accountCaps.marginMultiplier))
      && Number(accountCaps.marginMultiplier) <= 1;
    const creditStructures = ['covered_call', 'call_credit_spread', 'put_credit_spread'];
    const allowedStructures = (permissions.allowedStructures ?? []).filter((structure) => (
      !brokerMarginUnavailable || !creditStructures.includes(structure)
    ));
    const tradingRules = {
      fractionalLongStock: true,
      minOrderNotionalUsd: Number(risk.minOrderNotionalUsd) || 1,
      sizeBudgetUsd,
      maxOrderNotionalUsd: maxOrderCap,
      shortStockWholeSharesOnly: true,
      shortingEnabledByBroker: accountCaps.shortingEnabled ?? null,
      marginMultiplier: accountCaps.marginMultiplier ?? null,
      optionsBuyingPowerUsd: accountCaps.optionsBuyingPowerUsd ?? null,
      optionsTradingLevel: accountCaps.optionsTradingLevel ?? null,
      marketOpen: marketView.marketOpen ?? null,
    };
    const instrumentContext = {
      enabled: permissions.enabled,
      allowedStructures,
      shortStock: permissions.shortStock && accountCaps.shortingEnabled !== false,
      margin: permissions.margin && !brokerMarginUnavailable,
      coveredCalls: permissions.coveredCalls && !brokerMarginUnavailable,
      spreads: permissions.spreads && allowedStructures.some((structure) => structure.endsWith('_spread')),
      optionBudgetUsd: premiumBudget,
      optionContractCostHint: '1 contract costs premium x 100',
      maxContracts: config?.instruments?.maxContracts ?? null,
      dteWindow: [config?.instruments?.minDTE ?? 2, config?.instruments?.maxDTE ?? 14],
      playbook: { bullish: playbook.bullish, bearish: playbook.bearish, neutral: playbook.neutral, summary: playbook.summary },
    };
    const basket = (() => {
      const raw = Array.isArray(agent?.symbols) && agent.symbols.length > 0
        ? agent.symbols
        : Array.isArray(agent?.genome?.symbols) && agent.genome.symbols.length > 0
          ? agent.genome.symbols
          : [symbol].filter(Boolean);
      const out = [];
      for (const item of raw) {
        const value = String(item ?? '').trim().toUpperCase();
        if (value && !out.includes(value)) out.push(value);
      }
      return out;
    })();
    const sections = [
      `BOT: ${agent.name ?? agent.id} (id ${agent.id}, generation ${agent.generation ?? 0}, tier ${agent.tier ?? type.category})`,
      `BASKET: ${JSON.stringify(basket)} (the executor trades every symbol in this basket where its signal fires; you set the policy for the whole basket)`,
      `STRATEGY: ${type.typeLabel} managing ${basket.join(', ') || 'n/a'} (family ${agent?.genome?.family ?? 'unknown'})`,
      `GENOME: ${JSON.stringify(agent?.genome ?? {})}`,
      spec ? `ACTIVE_SPEC: ${JSON.stringify({ symbol: spec.symbol, family: spec.family, params: spec.params ?? {} })}` : 'ACTIVE_SPEC: none compiled yet',
      `TRADING_RULES: ${JSON.stringify(tradingRules)}`,
      `INSTRUMENT_CONTEXT: ${JSON.stringify(instrumentContext)}`,
      `BOOK: ${JSON.stringify({
        cashUsd: snapshot ? round2(snapshot.cashUsd) : null,
        positions: snapshot?.positions ?? {},
        trades: snapshot?.trades ?? 0,
        realizedPlUsd: snapshot ? round2(snapshot.realizedPlUsd) : 0,
        unrealizedPlUsd: snapshot ? round2(snapshot.unrealizedPlUsd ?? 0) : 0,
        equityUsd: snapshot?.equityUsd ?? null,
        marginDebtUsd: snapshot?.marginDebtUsd ?? 0,
      })}`,
      `MARKET: ${JSON.stringify({
        marketOpen: marketView.marketOpen ?? null,
        timeframe: type.category === 'day' ? '1Min' : '1Hour',
        symbol,
        lastPriceUsd: price,
        bidUsd: quote?.bid ?? null,
        askUsd: quote?.ask ?? null,
        quoteAgeSec: quote?.ts ? Math.round((currentClock.now() - Number(quote.ts)) / 1000) : null,
      })}`,
      `RESEARCH_BRIEFING: ${JSON.stringify(researchBriefing ?? null)}`,
      `YOUR PREVIOUS REVIEWS (oldest first, ≤${MAX_PRIOR_REVIEWS}): ${JSON.stringify(prior)}`,
      'Return ONLY the JSON policy object described in the system prompt.',
    ];
    let user = sections.join('\n');
    if (user.length > maxInputChars) user = `${user.slice(0, maxInputChars)}\n[truncated]`;
    return user;
  }

  /**
   * Review one bot. Returns a compact outcome for the trace; never throws.
   * @param {object} agent
   * @param {number} nowMs
   * @param {{market?: object}} context
   */
  async function reviewOne(agent, nowMs, { market, account } = {}) {
    const outcome = { agentId: agent.id, stance: null, sizeMultiplier: null, confidence: null, costUsd: 0, error: null };
    const type = strategyTypeForFamily(agent?.genome?.family);
    const reviewSec = reviewSecFor(agent);
    let snapshot = null;
    try {
      snapshot = ledger.snapshot(agent.id);
      if (snapshot && typeof ledger.equity === 'function') {
        const marked = ledger.equity(agent.id, isPlainObject(market) && isPlainObject(market.prices) ? market.prices : {});
        if (marked && Number.isFinite(marked.equityUsd)) snapshot.equityUsd = round2(marked.equityUsd);
      }
    } catch {
      snapshot = null;
    }
    const spec = typeof specFor === 'function' ? specFor(agent.id) ?? null : null;
    let researchBriefing = null;
    try {
      researchBriefing = researcher?.latestAny?.(agent.id) ?? null;
    } catch {
      researchBriefing = null;
    }
    const prior = await readOwnPrior(agent.id);
    const baseUser = buildUserPrompt({ agent, snapshot, spec, prior, market, researchBriefing, account });
    let policy = null;
    let lastFailure = null;
    let usage = null;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      const user = attempt === 1
        ? baseUser
        : `${baseUser}\n\nIMPORTANT: your previous reply was rejected as invalid JSON (${String(lastFailure?.message ?? lastFailure).slice(0, 160)}). Reply now with ONLY one compact valid JSON object matching the schema.`;
      try {
        const generated = await generate({ system: SYSTEM_PROMPT, user, maxTokens: maxOutputTokens, temperature: 0.2 });
        const text = typeof generated === 'string' ? generated : generated?.text;
        usage = generated?.usage ?? null;
        lastProvider = generated?.provider ?? lastProvider;
        lastModel = generated?.model ?? lastModel;
        policy = normalizePolicy(extractJsonObject(text), {
          nowMs,
          reviewSec,
          config,
          permissions: agentInstrumentPermissions(config, agent),
          agent,
        });
        lastFailure = null;
        break;
      } catch (error) {
        lastFailure = error;
        const retriable = /JSON|policy|stance|confidence/i.test(String(error?.message ?? error));
        if (!retriable || attempt >= ATTEMPTS) break;
      }
    }
    if (lastFailure) {
      outcome.error = `llm: ${String(lastFailure?.message ?? lastFailure).slice(0, 180)}`;
      lastError = outcome.error;
      errors += 1;
      pauseAfterProviderError(outcome.error, nowMs);
      return outcome;
    }
    const record = {
      agentId: agent.id,
      name: agent.name ?? agent.id,
      ...policy,
      usage,
      provider: lastProvider,
      model: lastModel,
      costUsd: 0,
    };
    try {
      await appendJsonl(logFile(agent.id), record);
      await trimLog(agent.id);
    } catch (error) {
      log.warn('could not persist bot-agent review', { agentId: agent.id, error: String(error?.message ?? error) });
    }
    let costUsd = 0;
    if (costPerReviewUsd > 0) {
      try {
        await ledger.charge(agent.id, costPerReviewUsd, {
          category: 'agent',
          role: 'executor',
          ref: `agent-review:${policy.at}`,
          at: nowMs,
        });
        costUsd = round4(costPerReviewUsd);
        record.costUsd = costUsd;
      } catch (error) {
        outcome.error = `charge: ${String(error?.message ?? error).slice(0, 120)}`;
        lastError = outcome.error;
        errors += 1;
      }
    }
    const entry = ensureAgent(agent.id);
    entry.lastReviewAt = nowMs;
    entry.policy = record;
    entry.reviewCount += 1;
    pausedUntilMs = 0;
    pauseReason = null;
    runs += 1;
    lastReviewAt = nowMs;
    outcome.stance = record.stance;
    outcome.sizeMultiplier = record.sizeMultiplier;
    outcome.confidence = record.confidence;
    outcome.costUsd = costUsd;
    return outcome;
  }

  /** Agents whose own review is due, oldest first, capped for this cycle. */
  function dueAgents(nowMs) {
    const alive = registry.alive();
    const due = [];
    for (const agent of alive) {
      const state = ensureAgent(agent.id);
      const intervalMs = reviewIntervalMsFor(agent);
      if (state.lastReviewAt === 0 || nowMs - state.lastReviewAt >= intervalMs) due.push(agent);
    }
    due.sort((a, b) => (ensureAgent(a.id).lastReviewAt ?? 0) - (ensureAgent(b.id).lastReviewAt ?? 0));
    return due;
  }

  /** One review pass (called once per engine cycle; only due bots are reviewed). */
  async function tick({ market, account } = {}) {
    await init();
    const nowMs = currentClock.now();
    if (!enabled || !configured) {
      return {
        enabled,
        configured,
        due: 0,
        reviewed: [],
        skipped: registry.alive().length,
        note: !enabled ? 'agent brain disabled by config' : 'no LLM generator configured',
      };
    }
    const due = dueAgents(nowMs);
    if (nowMs < pausedUntilMs) {
      return {
        enabled,
        configured,
        due: due.length,
        reviewed: [],
        skipped: Math.max(0, registry.alive().length - due.length),
        paused: true,
        pausedUntil: new Date(pausedUntilMs).toISOString(),
        note: `paused after provider error: ${pauseReason ?? 'unknown'}`,
      };
    }
    const batch = due.slice(0, maxReviewsPerCycle);
    const reviewed = [];
    for (const agent of batch) {
      // eslint-disable-next-line no-await-in-loop
      reviewed.push(await reviewOne(agent, currentClock.now(), { market, account }));
    }
    await saveState();
    return {
      enabled,
      configured,
      due: due.length,
      reviewed,
      deferred: Math.max(0, due.length - batch.length),
      skipped: Math.max(0, registry.alive().length - due.length),
    };
  }

  /** Fresh policy for the executor (null when missing/stale/disabled/unconfigured/malformed). */
  function policy(agentId) {
    if (!enabled || !configured) return null;
    const entry = perAgent.get(agentId);
    if (!entry?.policy) return null;
    const ageMs = currentClock.now() - entry.policy.atMs;
    if (!(ageMs <= maxAgeMs)) return null;
    return {
      stance: entry.policy.stance,
      sizeMultiplier: entry.policy.sizeMultiplier,
      riskMultiplier: entry.policy.riskMultiplier,
      exitPressure: entry.policy.exitPressure,
      confidence: entry.policy.confidence,
      thesis: entry.policy.thesis,
      plan: entry.policy.plan,
      watch: entry.policy.watch,
      instrument: entry.policy.instrument ?? null,
      atMs: entry.policy.atMs,
      at: entry.policy.at,
      reviewSec: entry.policy.reviewSec,
      stale: false,
    };
  }

  /** Dashboard view (includes stale policies and scheduling info). */
  function status(agentId) {
    const entry = perAgent.get(agentId);
    if (!entry?.policy) {
      const agent = registry.get(agentId);
      const intervalMs = agent ? reviewIntervalMsFor(agent) : reviewIntervalDayMs;
      return {
        reviewCount: entry?.reviewCount ?? 0,
        lastReviewAt: entry?.lastReviewAt ? new Date(entry.lastReviewAt).toISOString() : null,
        nextReviewAt: new Date((entry?.lastReviewAt ?? 0) > 0 ? entry.lastReviewAt + intervalMs : currentClock.now()).toISOString(),
        policy: null,
      };
    }
    const ageMs = currentClock.now() - entry.policy.atMs;
    return {
      ...entry.policy,
      reviewCount: entry.reviewCount,
      stale: !(ageMs <= maxAgeMs),
      nextReviewAt: new Date(entry.lastReviewAt + entry.policy.reviewSec * 1000).toISOString(),
    };
  }

  function schedule() {
    const nowMs = currentClock.now();
    const alive = registry.alive();
    let nextDueAt = null;
    for (const agent of alive) {
      const entry = ensureAgent(agent.id);
      const due = entry.lastReviewAt > 0 ? entry.lastReviewAt + reviewIntervalMsFor(agent) : nowMs;
      if (nextDueAt === null || due < nextDueAt) nextDueAt = due;
    }
    return {
      enabled,
      configured,
      provider: lastProvider,
      model: lastModel,
      intervalDaySec: Math.round(reviewIntervalDayMs / 1000),
      intervalSwingSec: Math.round(reviewIntervalSwingMs / 1000),
      maxReviewsPerCycle,
      lastReviewAt: lastReviewAt === null ? null : new Date(lastReviewAt).toISOString(),
      nextDueAt: nextDueAt === null ? null : new Date(nextDueAt).toISOString(),
      pausedUntil: pausedUntilMs > nowMs ? new Date(pausedUntilMs).toISOString() : null,
      pauseReason,
      runs,
      errors,
      lastError,
      agents: alive.length,
    };
  }

  return {
    init,
    tick,
    policy,
    status,
    schedule,
    _internals: { reviewOne, dueAgents, buildUserPrompt, SYSTEM_PROMPT, normalizePolicy },
  };
}

export default createBotAgents;
