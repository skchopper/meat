/**
 * registry.js — the population registry: who is alive, who is dead, and the one-way door.
 *
 * `markDead` is the only way an agent can die and there is deliberately no `markAlive`.
 * D14 (RESURRECTION_FORBIDDEN) is enforced by the absence of a revival path, by refusing
 * status changes through `update`, and by refusing `markDead` twice (AGENT_DEAD).
 *
 * v3.2 (docs/PORTFOLIO-ANALYTICS.md §2): a bot may manage a multi-symbol basket.
 * `agent.symbols` is a sanitized, unique, uppercase 1..8 symbol basket (primary = first),
 * derived for legacy records from `genome.symbols` or `genome.symbol`. `agent.specIds`
 * maps symbol → specId; the legacy single `agent.specId` remains the primary spec and is
 * preserved separately. Both fields are additive: old state files load unchanged.
 *
 * Owned by mortality-core. Contract: docs/CONTRACTS.md + docs/PORTFOLIO-ANALYTICS.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import { AGENT_STATUS, AutomatonError, DEATH_CAUSES, fail } from './contracts.js';
import { median, newId, readJsonSync, round2, round4, SYSTEM_CLOCK, writeJsonAtomicSync } from './util.js';
import { statePaths } from './config.js';

const HOUR_MS = 60 * 60 * 1000;

/** Maximum basket size (docs/PORTFOLIO-ANALYTICS.md): day bots default 4, swing 3. */
export const MAX_BASKET_SYMBOLS = 8;

/** Same ticker shape config.js validates for `config.symbols`. */
const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.]{0,9}$/;

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => (value === undefined ? undefined : structuredClone(value));
const toIso = (value, fallbackIso) => {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(Date.parse(value)).toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return fallbackIso;
};

/**
 * Sanitize a basket: uppercase tickers, unique, order-preserving, capped at
 * MAX_BASKET_SYMBOLS. Accepts an array or a single string; anything else is empty.
 * @param {unknown} value
 * @returns {string[]}
 */
export function sanitizeBasket(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const symbol = raw.trim().toUpperCase();
    if (symbol === '' || !SYMBOL_PATTERN.test(symbol) || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push(symbol);
    if (out.length >= MAX_BASKET_SYMBOLS) break;
  }
  return out;
}

/**
 * Sanitize a symbol → specId map (plain object, uppercase keys, non-empty string values).
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
export function sanitizeSpecIds(value) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!isPlainObject(value)) return out;
  for (const [rawSymbol, rawSpecId] of Object.entries(value)) {
    if (typeof rawSpecId !== 'string' || rawSpecId.trim() === '') continue;
    const symbol = String(rawSymbol ?? '').trim().toUpperCase();
    if (symbol === '' || !SYMBOL_PATTERN.test(symbol)) continue;
    out[symbol] = rawSpecId.trim();
  }
  return out;
}

/**
 * Resolve an agent's basket with v3.2 back-compat:
 * `agent.symbols ?? agent.genome.symbols ?? [agent.genome.symbol]`, sanitized.
 * @param {{ symbols?: unknown, genome?: { symbols?: unknown, symbol?: unknown } }} agent
 * @returns {string[]}
 */
export function basketOf(agent) {
  const direct = agent?.symbols;
  if (Array.isArray(direct) || typeof direct === 'string') return sanitizeBasket(direct);
  const genomeSymbols = agent?.genome?.symbols;
  if (Array.isArray(genomeSymbols) || typeof genomeSymbols === 'string') return sanitizeBasket(genomeSymbols);
  const primary = agent?.genome?.symbol;
  return typeof primary === 'string' ? sanitizeBasket([primary]) : [];
}

function emptyState(cap) {
  return { version: 1, cap, agents: {} };
}

/**
 * @param {{ id?: string, parentId?: string|null, generation?: number, bornAt?: string,
 *   status?: string, endowmentUsd?: number, genome?: object,
 *   mutation?: object|null, specId?: string|null, specIds?: object,
 *   symbols?: string[]|string, lastCycleAt?: string|null,
 *   tier?: string|null, diedAt?: string|null, cause?: string|null, notes?: string[], name?: string|null }} agent
 */
function normalizeAgent(agent) {
  const notes = Array.isArray(agent.notes) ? agent.notes.filter((note) => typeof note === 'string') : [];
  const tier = agent.tier === 'swing' || agent.tier === 'day' ? agent.tier : null;
  return {
    id: agent.id,
    // Operator-facing, strategy-derived label ("Momentum AAPL"). The id stays the stable key.
    name: typeof agent.name === 'string' && agent.name.trim() !== '' ? agent.name.trim() : null,
    parentId: agent.parentId ?? null,
    generation: Number.isFinite(agent.generation) ? Math.trunc(agent.generation) : 1,
    bornAt: agent.bornAt,
    status: agent.status ?? 'alive',
    endowmentUsd: Number.isFinite(agent.endowmentUsd) ? round2(agent.endowmentUsd) : 0,
    genome: isPlainObject(agent.genome) ? clone(agent.genome) : {},
    mutation: agent.mutation ?? null,
    // Legacy primary spec (the symbol selected by the Prospector/Builder) stays first-class.
    specId: typeof agent.specId === 'string' ? agent.specId.trim() || null : null,
    // v3.2: multi-symbol basket (primary = symbols[0]) + per-symbol spec map.
    symbols: basketOf(agent),
    specIds: sanitizeSpecIds(agent.specIds),
    lastCycleAt: agent.lastCycleAt ?? null,
    // Execution tier (docs/CONTROL-PANEL.md): 'day' = short-term/day-trading cadence,
    // 'swing' = mid/long-term cadence. Null until the orchestrator backfills it.
    tier,
    diedAt: agent.diedAt ?? null,
    cause: agent.cause ?? null,
    notes,
  };
}

/**
 * Create the population registry.
 *
 * @param {{ paths?: object, config?: object, clock?: { now: () => number, iso: () => string } }} options
 */
export function createRegistry({ paths, config, clock } = {}) {
  if (!paths?.registry && !config) {
    throw new AutomatonError('CONFIG_INVALID', 'createRegistry requires { paths } or { config }', {});
  }
  const resolved = { ...(config ? statePaths(config) : {}), ...(paths ?? {}) };
  if (!resolved.registry) {
    throw new AutomatonError('CONFIG_INVALID', 'registry path is required', {});
  }
  const registryPath = path.resolve(resolved.registry);
  const currentClock = clock ?? SYSTEM_CLOCK;
  const cap = Math.max(1, Math.trunc(config?.population?.cap ?? 10));

  /** @type {{ version: number, cap: number, agents: Record<string, object> }} */
  let state = emptyState(cap);

  function load() {
    const raw = readJsonSync(registryPath, null);
    state = emptyState(cap);
    if (!raw) return;
    const agents = Array.isArray(raw) ? raw : Object.values(raw.agents ?? {});
    for (const agent of agents) {
      if (!agent || typeof agent.id !== 'string' || agent.id === '') continue;
      state.agents[agent.id] = normalizeAgent({
        ...agent,
        bornAt: toIso(agent.bornAt, currentClock.iso()),
        status: AGENT_STATUS.includes(agent.status) ? agent.status : 'alive',
      });
    }
  }

  function save() {
    writeJsonAtomicSync(registryPath, { version: 1, cap, agents: state.agents });
  }

  function all() {
    return Object.values(state.agents).map((agent) => clone(agent));
  }

  function alive() {
    return all().filter((agent) => agent.status === 'alive');
  }

  function dead() {
    return all().filter((agent) => agent.status === 'dead');
  }

  /** @param {string} id */
  function get(id) {
    const agent = state.agents[id];
    return agent ? clone(agent) : null;
  }

  /** Current living population. The cap applies to the living, not to the graveyard. */
  function population() {
    return Object.values(state.agents).filter((agent) => agent.status === 'alive').length;
  }

  /** Register one living agent. Throws POPULATION_CAP when the living population is full. */
  function register(agent) {
    if (!isPlainObject(agent)) fail('CONFIG_INVALID', 'register(agent) requires an agent record object', {});
    const id = typeof agent.id === 'string' && agent.id.trim() !== '' ? agent.id : nextId();
    if (state.agents[id]) fail('CONFIG_INVALID', `duplicate agent id "${id}"`, { agentId: id });
    const status = agent.status ?? 'alive';
    if (!AGENT_STATUS.includes(status)) fail('CONFIG_INVALID', `status must be one of ${AGENT_STATUS.join('|')}`, { status });
    if (status === 'alive' && population() >= cap) {
      fail('POPULATION_CAP', `population cap reached (${cap}); no new agents may be registered`, {
        cap,
        population: population(),
      });
    }
    const record = normalizeAgent({
      ...agent,
      id,
      status,
      bornAt: toIso(agent.bornAt, currentClock.iso()),
    });
    state.agents[id] = record;
    return clone(record);
  }

  /**
   * Patch a living agent. Never a death, never a revival: `status` cannot be changed
   * here (markDead is the only death door), and a dead agent is immutable.
   */
  function update(id, patch) {
    const record = state.agents[id];
    if (!record) fail('UNKNOWN_AGENT', `unknown agent "${id}"`, { agentId: id });
    if (record.status === 'dead') {
      fail('AGENT_DEAD', `agent "${id}" is dead and cannot be updated (dead is one-way)`, { agentId: id });
    }
    if (!isPlainObject(patch)) fail('CONFIG_INVALID', 'update(id, patch) requires a patch object', { agentId: id });
    if (Object.prototype.hasOwnProperty.call(patch, 'status') && patch.status !== record.status) {
      fail('CONFIG_INVALID', 'status changes require markDead; dead is one-way', {
        agentId: id,
        status: patch.status,
      });
    }
    const allowed = { ...patch };
    delete allowed.id;
    delete allowed.status;
    const merged = normalizeAgent({ ...record, ...allowed });
    merged.id = record.id;
    merged.status = record.status;
    merged.bornAt = record.bornAt;
    state.agents[id] = merged;
    return clone(merged);
  }

  /**
   * One-way death. Throws AGENT_DEAD if the agent is already dead.
   * @param {string} id
   * @param {{ cause?: string, at?: string|number, finalEquityUsd?: number }} [options]
   */
  function markDead(id, { cause, at, finalEquityUsd } = {}) {
    const record = state.agents[id];
    if (!record) fail('UNKNOWN_AGENT', `unknown agent "${id}"`, { agentId: id });
    if (record.status === 'dead') {
      fail('AGENT_DEAD', `agent "${id}" is already dead (dead is one-way)`, { agentId: id });
    }
    if (!DEATH_CAUSES.includes(cause)) {
      fail('CONFIG_INVALID', `markDead cause must be one of ${DEATH_CAUSES.join('|')}`, { agentId: id, cause });
    }
    record.status = 'dead';
    record.diedAt = toIso(at, currentClock.iso());
    record.cause = cause;
    record.finalEquityUsd = Number.isFinite(finalEquityUsd) ? round2(finalEquityUsd) : null;
    return clone(record);
  }

  /** Per-generation birth/death/survival statistics. */
  function generationStats() {
    /** @type {Record<string, object>} */
    const out = {};
    for (const agent of Object.values(state.agents)) {
      const generation = agent.generation;
      if (!out[generation]) {
        out[generation] = { born: 0, alive: 0, dead: 0, survivalRate: 0, medianLifespanHours: 0, _lifespans: [] };
      }
      const row = out[generation];
      row.born += 1;
      if (agent.status === 'dead') {
        row.dead += 1;
        const bornMs = Date.parse(agent.bornAt);
        const diedMs = Date.parse(agent.diedAt);
        if (Number.isFinite(bornMs) && Number.isFinite(diedMs)) {
          row._lifespans.push(Math.max(0, (diedMs - bornMs) / HOUR_MS));
        }
      } else {
        row.alive += 1;
      }
    }
    for (const row of Object.values(out)) {
      row.survivalRate = row.born === 0 ? 0 : round4(row.alive / row.born);
      row.medianLifespanHours = row._lifespans.length === 0 ? 0 : round2(median(row._lifespans));
      delete row._lifespans;
    }
    return out;
  }

  /** `atm-<8 hex>`, guaranteed unique against the current registry. */
  function nextId() {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const id = newId('atm');
      if (!state.agents[id]) return id;
    }
    fail('CONFIG_INVALID', 'could not allocate a unique agent id');
    return null;
  }

  return {
    load,
    save,
    all,
    alive,
    dead,
    get,
    population,
    register,
    update,
    markDead,
    generationStats,
    nextId,
    /** @returns {number} configured population cap (living agents) */
    get cap() {
      return cap;
    },
    /** Absolute path of the persisted registry file (diagnostics only). */
    get path() {
      return registryPath;
    },
  };
}
