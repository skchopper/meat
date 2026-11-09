/**
 * Client (browser) half of the MEAT bundle.
 *
 * ONE shared dashboard, registered in three slot surfaces:
 *  - `sidebar.panellist`  sidebar entry (glyph; label "Automaton") that selects the panel.
 *  - `main`               keyed central panel with key `automaton-trading`: the full
 *                         control dashboard opened from the sidebar (not a floating window).
 *  - `settings.plugins.tab` the same dashboard as a secondary full page.
 *
 * Dashboard: header stats, Start / Stop / Emergency controls, 3 s auto-refresh + pause,
 * kill-switch indicator, generation rollup, obituary feed, and a clickable 30-100-agent
 * table. Clicking an agent opens an inline detail pane (holdings + past activity +
 * genome/spec strategy parameters + role costs + death info). Agent names are the
 * strategy-derived labels from the engine ("Momentum AAPL"), with the short id secondary;
 * the inherited genome and the currently-traded compiled spec are shown separately
 * because the Builder can trade a different hypothesis than the inherited genome.
 *
 * Host routes (relative URLs only): `GET /automaton/state` (3 s poll) and
 * loopback-only `POST /automaton/control` for operator actions.
 *
 * Pure data mapping (`buildAgentRows`, `buildHoldingsRows`, `buildActivityRows`, …) is
 * exported under `helpers` so it can be unit-tested without a browser. Styling uses
 * Harness theme tokens (`--dsw-alias-*`) with fallbacks only; timers/listeners are
 * cleaned up on unmount.
 */

window.__ModuleLoader__.load({
  id: '@local/automaton-trading',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'automaton-trading';
    const STATE_URL = '/automaton/state';
    const MARKET_URL = '/automaton/market';
    const CONTROL_URL = '/automaton/control';
    const STATE_POLL_MS = 5000;
    const MARKET_POLL_MS = 2000;
    /** Back-compat alias: the state poller interval (older exports/tests). */
    const POLL_MS = STATE_POLL_MS;
    const PANEL_ID = 'automaton-trading';
    const SIDEBAR_SLOT = 'sidebar.panellist';
    const MAIN_SLOT = 'main';
    const SETTINGS_SLOT = 'settings.plugins.tab';
    const DASHBOARD_TABS = ['overview', 'agents', 'markets', 'research', 'rewards', 'settings'];
    const MAX_OBITUARIES = 8;
    const MODE_LABEL = { sim: 'SIM', paper: 'PAPER', live: 'LIVE' };
    const STATUS_FILTERS = ['all', 'alive', 'dead', 'condemned'];
    const SORTABLE_KEYS = new Set(['name', 'generation', 'equityUsd', 'pnlUsd', 'runwayHours', 'dayPnlPct', 'status']);
    const FAMILY_LABELS = { momentum: 'Momentum', meanrev: 'MeanRev', breakout: 'Breakout', gapfade: 'GapFade' };

    // -----------------------------------------------------------------------
    // locale (inline dictionaries; EN is the fallback)
    // -----------------------------------------------------------------------

    const EN = {
      tab: 'MEAT — Mortality Engineered Auto-Trading',
      sidebarLabel: 'Automaton',
      title: 'MEAT — Mortality Engineered Auto-Trading',
      subtitle: 'Mortality-engineered strategies: the unprofitable die, the profitable reproduce, every death leaves a record.',
      loading: 'Loading automaton state…',
      connecting: 'connecting…',
      offline: 'Automaton offline',
      running: 'running',
      stopped: 'stopped',
      killOn: 'KILL SWITCH ARMED',
      killOff: 'kill switch clear',
      killSwitch: 'Kill switch',
      armed: 'ARMED',
      clear: 'clear',
      reaper: 'Reaper',
      reaperAlive: 'alive',
      reaperNotRunning: 'not running',
      reaperStale: 'no heartbeat (stale generation)',
      reaperHealthy: 'heartbeat',
      reaperVersion: 'heartbeat v',
      reaperSweeps: 'sweeps',
      reaperStop: 'Operator: stop Reaper',
      reaperConfirm: 'CONFIRM STOP REAPER',
      reaperHint: 'Agents cannot stop the Reaper — this is an operator control.',
      reaperStaleWarning: 'stale generation — operator stop required; the engine refuses to start until it is stopped.',
      reaperHealthyNote: 'fresh generation (heartbeat v2) — operator stop not required',
      reaperStopped: 'Reaper stopped',
      reaperStopFailed: 'Reaper stop failed',
      research: 'Research',
      researchTitle: 'Research — isolated hourly analyst',
      researchEmpty: 'no briefing yet (first hourly run pending)',
      researchDisabled: 'research disabled: no LLM bridge / key',
      researchDisabledConfig: 'research disabled in config — briefings not collected',
      researchShadow: 'shadow — briefings logged, not applied to orders',
      researchInfluence: 'influence — briefings can veto / resize / force exits',
      researchUnknown: 'research status unknown',
      researchVerdict: 'Verdict',
      researchSentiment: 'Sentiment',
      researchConfidence: 'Confidence',
      researchSummary: 'Summary',
      researchCatalysts: 'Catalysts',
      researchRisks: 'Risks',
      researchSources: 'Sources',
      researchNoSources: 'no sources',
      researchNoCatalysts: '—',
      researchNoRisks: '—',
      researchStale: 'stale',
      researchAge: 'age',
      researchRuns: 'runs',
      researchErrors: 'errors',
      researchInterval: 'interval',
      researchLastRun: 'last run',
      researchNextDue: 'next due',
      researchModel: 'model',
      researchProvider: 'provider',
      researchHourly: 'hourly',
      researchBadgeHint: 'isolated hourly news analyst',
      researchNone: '—',
      cadence: 'Research cadence',
      cadenceMode: 'Schedule',
      cadenceInterval: 'Interval',
      cadence1h: 'Every 1h',
      cadence3h: 'Every 3h',
      cadence6h: 'Every 6h',
      cadence24h: 'Every 24h',
      cadencePreOpen: 'Before open',
      cadencePostClose: 'After close',
      cadencePreOpenPostClose: 'Before open + after close',
      cadenceApply: 'Apply cadence',
      cadenceCurrent: 'Current',
      cadenceNextDue: 'Next due',
      cadenceCustom: 'custom interval',
      rewards: 'Rewards',
      rewardsEnabled: 'Rewards enabled',
      rewardsPeriod: 'Period',
      rewardsDaily: 'Daily',
      rewardsWeekly: 'Weekly',
      rewardsMonthly: 'Monthly',
      rewardsFirst: '1st',
      rewardsSecond: '2nd',
      rewardsThird: '3rd',
      rewardsMax: 'Max / period',
      rewardsNoMax: '(no cap)',
      rewardsPreview: 'Preview',
      rewardsCash: 'account cash',
      rewardsPool: 'pool available',
      rewardsCapRemaining: 'allocation cap remaining',
      rewardsApply: 'Apply rewards',
      rewardsLastRun: 'Last payout',
      rewardsNextRun: 'Next boundary',
      rewardsLastWinners: 'Last winners',
      rewardsHistory: 'Payout history',
      rewardsNoHistory: 'no payouts yet',
      rewardsPayBoundary: 'payouts happen only at period boundaries — no pay-now',
      rewardsTotal: 'total',
      rewardsCappedBy: 'capped by',
      rewardsPoolCap: 'pool',
      rewardsAllocationCap: 'allocation cap',
      rewardsMaxCap: 'max/period',
      rewardsDisabledNote: 'rewards are disabled',
      leaderboards: 'Leaderboards',
      lbDaily: 'Daily',
      lbWeekly: 'Weekly',
      lbMonthly: 'Monthly',
      lbRank: 'Rank',
      lbName: 'Agent',
      lbPnlPct: 'P&L %',
      lbPnlUsd: 'P&L $',
      lbEquity: 'Equity',
      lbTrades: 'Trades',
      lbEmpty: 'no leaderboard data yet',
      lbAsOf: 'as of',
      plan: 'Strategy & plan',
      planSummary: 'Summary',
      planEntry: 'Entry rule',
      planExit: 'Exit rules',
      planRisk: 'Risk rule',
      planNext: 'Next step',
      planTriggers: 'Triggers',
      planPosition: 'Position plan',
      planNoPosition: 'no open position',
      planNextResearch: 'Next research',
      planEmpty: 'no strategy plan yet',
      tx: 'Transactions',
      txEmpty: 'no transactions yet',
      txOrderId: 'Order',
      rankDay: 'D',
      rankWeek: 'W',
      rankMonth: 'M',
      rankBadge: 'Rank',
      operatorControls: 'Operator controls',
      cadenceEnabled: 'Collection',
      cadenceInfluence: 'Influence trades',
      strategyType: 'Strategy type',
      estInterval: 'Est. interval',
      categoryAll: 'All',
      categorySwing: 'Swing · mid-long',
      categoryDay: 'Day · intraday',
      botAgent: 'Bot agent',
      botAgentEmpty: 'bot agent has not reviewed yet (first review pending)',
      botAgentBridge: 'Bot agents',
      botAgentBridgeOff: 'bot-agent bridge not configured yet',
      botAgentStale: 'policy is stale — the executor falls back to the last valid policy or baseline',
      stance: 'Stance',
      stanceTrade: 'TRADE',
      stanceCautious: 'CAUTIOUS',
      stanceStandDown: 'STAND DOWN',
      stanceUnknown: '—',
      sizeMultiplier: 'Size ×',
      riskMultiplier: 'Risk ×',
      confidence: 'Confidence',
      exitPressure: 'Exit pressure',
      reviewCount: 'Reviews',
      lastReview: 'Last review',
      nextReview: 'Next review',
      watchlist: 'Watch',
      thesis: 'Thesis',
      reviewInterval: 'Review interval',
      instruments: 'Instruments',
      instrumentsOff: 'multi-instrument paper disabled',
      instrumentsUnavailable: 'instrument status not reported yet',
      badgeStock: 'Stk',
      badgeShort: 'Short',
      badgeOptions: 'Opt',
      badgeSpreads: 'Spreads',
      badgeMargin: 'Margin',
      optionsLevel: 'Options',
      shortEnabled: 'Short',
      marginEnabled: 'Margin',
      caps: 'caps',
      capOptionsPct: 'options ≤',
      capShortPct: 'short ≤',
      dteRange: 'DTE',
      optionsBP: 'Options BP',
      buyingPower: 'Buying power',
      marginDebt: 'Margin debt',
      grossExposure: 'Gross exposure',
      netExposure: 'Net exposure',
      instrumentPlaybook: 'Instrument playbook',
      playbookFamily: 'Family',
      playbookBullish: 'Bullish',
      playbookBearish: 'Bearish',
      playbookNeutral: 'Neutral',
      playbookStructures: 'Structures',
      playbookEmpty: 'no instrument playbook for this strategy yet',
      instrumentPlan: 'Instrument plan',
      prefer: 'Prefer',
      maxPremium: 'Max premium',
      maxContracts: 'Max contracts',
      dteWindow: 'DTE window',
      autoSelect: 'Auto',
      permissions: 'Permissions',
      allowedStructures: 'Allowed structures',
      instrumentsEmpty: 'no instrument permissions yet',
      sideLabel: 'Side',
      contracts: 'Contracts',
      strike: 'Strike',
      expiry: 'Expiry',
      dte: 'DTE',
      group: 'Group',
      spreadGroup: 'Spread group',
      positionTotals: 'Totals',
      longPos: 'LONG',
      shortPos: 'SHORT',
      callPos: 'CALL',
      putPos: 'PUT',
      lastCycle: 'Last cycle',
      lastCycleEmpty: 'no cycle data yet',
      marketOpen: 'market open',
      marketClosed: 'market closed',
      marketUnknown: 'market state unknown',
      tradingSkipped: 'trading skipped',
      executions: 'executions',
      orders: 'orders',
      denied: 'denied',
      topSkipReasons: 'top skips',
      botReviews: 'bot reviews',
      reviewed: 'reviewed',
      deferred: 'deferred',
      paused: 'paused',
      brokerRestricted: 'Broker account restricted',
      brokerRestrictedUnavailable: 'unavailable (paper equity below margin minimum)',
      brokerRestrictedRemain: 'long stock and long options remain available',
      accountFacts: 'account',
      onLabel: 'on',
      offLabel: 'off',
      tabOverview: 'Overview',
      tabAgents: 'Agents',
      tabMarkets: 'Markets',
      tabResearch: 'Research',
      tabRewards: 'Rewards',
      tabSettings: 'Settings',
      brand: 'MEAT',
      brandSub: 'Mortality Engineered Auto-Trading',
      kpiEquity: 'Account equity',
      kpiEquityDetail: 'mode',
      kpiDayPnl: 'Day P&L',
      kpiCashBp: 'Cash / Buying power',
      kpiExposure: 'Gross exposure',
      kpiNetExposure: 'net',
      kpiPopulation: 'Population',
      kpiDead: 'dead',
      kpiTradesToday: 'Trades today',
      kpiWinRate: 'Win rate',
      kpiTreasury: 'Treasury runway',
      kpiNoData: '—',
      liveFeed: 'Live feed',
      feedLive: 'LIVE',
      feedClosed: 'CLOSED',
      feedUnavailable: 'live feed unavailable — state-only',
      feedRefreshing: 'refreshing…',
      manualRefresh: 'Refresh',
      marketClock: 'Market clock',
      marketWatch: 'Market watch',
      equityChart: 'Portfolio equity',
      strategyMixTitle: 'Strategy mix',
      dayVsSwing: 'Day vs Swing',
      target: 'target',
      actual: 'actual',
      tape: 'Live market tape',
      lastPrice: 'Last',
      change: 'Change',
      bidAsk: 'Bid / Ask',
      trend: 'Trend',
      closedLastClose: 'market closed · last close',
      live: 'live',
      up: 'up',
      down: 'down',
      flat: 'flat',
      noMarketData: 'no market data yet',
      chartEmpty: 'not enough data yet',
      basket: 'Basket',
      stance: 'Stance',
      agentSearch: 'Search agents…',
      researchSummary: 'Research coverage',
      researchVerdicts: 'verdicts',
      tierAll: 'All tiers',
      feedStatus: 'feed',
      marketSectionHint: 'prices, P&L and charts update live when the engine is running',
      paperDefault: 'paper trading is the default; live is gated',
      mode: 'Mode',
      loop: 'Loop',
      account: 'Account equity',
      cash: 'Cash',
      treasury: 'Treasury / runway',
      population: 'Population',
      alive: 'alive',
      dead: 'dead',
      condemned: 'condemned',
      total: 'total',
      cap: 'cap',
      burn: 'Burn rate',
      allocated: 'Allocated / cap',
      lastTick: 'Last tick',
      obituaries: 'Obituaries',
      generations: 'Generations',
      agents: 'Agents',
      agent: 'Agent',
      gen: 'Gen',
      strategy: 'Strategy',
      genome: 'Genome',
      trading: 'Trading (spec)',
      params: 'Params',
      equity: 'Equity',
      pnl: 'P&L',
      dayPnl: 'Day %',
      net7d: 'Net 7d',
      runway: 'Runway',
      treasuryState: 'Treasury',
      statusLabel: 'Status',
      cause: 'Cause',
      positions: 'Pos.',
      parent: 'Parent',
      mutation: 'Mutation',
      search: 'Search name, id, symbol, family…',
      filterAll: 'All',
      filterAlive: 'Alive',
      filterDead: 'Dead',
      filterCondemned: 'Condemned',
      rows: 'rows',
      clickHint: 'Click an agent for holdings & activity',
      noAgents: 'No agents yet. Start the engine below or run a tick.',
      noObits: 'No deaths recorded yet.',
      noGenerations: 'No generation data yet.',
      start: 'Start',
      stop: 'Stop',
      emergency: 'Emergency Stop',
      confirmStop: 'CONFIRM STOP',
      cancel: 'Cancel',
      pause: 'Pause',
      resume: 'Resume',
      refreshing: 'refreshing…',
      autoRefresh: 'auto-refresh 3 s',
      pausedLabel: 'paused',
      halted: 'HALTED — new orders are blocked',
      brakes: '14 hard brakes enforced in code',
      externalReaper: 'External Reaper runs as a separate process; it cannot be stopped from the engine.',
      lastError: 'Last error',
      neverProfited: 'never profitable',
      firstProfit: 'First profit',
      lifespan: 'lifespan',
      updated: 'updated',
      controlOk: '{action} accepted',
      controlFailed: 'Control action failed',
      close: 'Close',
      detailTitle: 'Agent detail',
      selectAgent: 'Select an agent to inspect its holdings and past activity.',
      holdings: 'Current holdings',
      noPositions: 'No open positions.',
      activity: 'Past activity',
      noTrades: 'No trades yet · market closed.',
      side: 'Side',
      buy: 'BUY',
      sell: 'SELL',
      symbol: 'Symbol',
      qty: 'Qty',
      avgPrice: 'Avg price',
      lastPrice: 'Last price',
      marketValue: 'Market value',
      unrealized: 'Unrealized',
      openedAt: 'Opened',
      time: 'Time',
      price: 'Price',
      notional: 'Notional',
      realized: 'Realized',
      cost: 'Cost',
      costs: 'Role costs',
      strategyParams: 'Strategy parameters',
      genomeParams: 'Genome (inherited)',
      specParams: 'Trading (compiled spec)',
      specCreated: 'Compiled',
      noSpec: 'No compiled spec yet — trading the inherited genome.',
      specDiffers: 'compiled spec differs from inherited genome',
      genomeOnly: 'genome only',
      born: 'Born',
      died: 'Died',
      drawdown: 'Drawdown',
      endowment: 'Endowment',
      positionsValue: 'Positions value',
      tradingState: 'Alive / dead',
      dayPnlTitle: 'Day P&L',
      net7dTitle: 'Net 7 d',
      role: 'Role',
      amount: 'Amount',
      tradesCount: 'Trades',
      positionsCount: 'Positions',
      mutationFrom: 'from',
      mutationTo: 'to',
      noParent: 'genesis',
      none: '—',
    };

    const ZH = {
      tab: 'MEAT — 死亡率工程自动交易',
      sidebarLabel: '自动交易',
      title: 'MEAT — 死亡率工程自动交易',
      subtitle: '死亡机制驱动的策略种群：不赚钱的死去，赚钱的复制，每一次死亡都留下记录。',
      loading: '正在读取自动交易状态…',
      connecting: '连接中…',
      offline: '自动交易离线',
      running: '运行中',
      stopped: '已停止',
      killOn: '熔断开关已触发',
      killOff: '熔断开关未触发',
      killSwitch: '熔断开关',
      armed: '已触发',
      clear: '未触发',
      reaper: 'Reaper',
      reaperAlive: '存活',
      reaperNotRunning: '未运行',
      reaperStale: '无心跳（过期世代）',
      reaperHealthy: '心跳',
      reaperVersion: '心跳版本 v',
      reaperSweeps: '次清扫',
      reaperStop: '操作员：停止 Reaper',
      reaperConfirm: '确认停止 Reaper',
      reaperHint: '智能体无法停止 Reaper —— 这是操作员控制。',
      reaperStaleWarning: '世代过期 — 需要操作员停止；在停止前引擎将拒绝启动。',
      reaperHealthyNote: '世代正常（心跳 v2）— 无需操作员停止',
      reaperStopped: 'Reaper 已停止',
      reaperStopFailed: '停止 Reaper 失败',
      research: '研究',
      researchTitle: '研究 —— 隔离的每小时分析师',
      researchEmpty: '暂无简报（首次每小时运行尚未发生）',
      researchDisabled: '研究已禁用：没有 LLM 桥接 / 密钥',
      researchDisabledConfig: '配置已禁用研究 —— 不会收集简报',
      researchShadow: '影子模式 —— 只记录简报，不影响订单',
      researchInfluence: '影响模式 —— 简报可否决 / 调整仓位 / 强制退出',
      researchUnknown: '研究状态未知',
      researchVerdict: '结论',
      researchSentiment: '情绪',
      researchConfidence: '置信度',
      researchSummary: '摘要',
      researchCatalysts: '催化剂',
      researchRisks: '风险',
      researchSources: '来源',
      researchNoSources: '暂无来源',
      researchNoCatalysts: '—',
      researchNoRisks: '—',
      researchStale: '过期',
      researchAge: '时长',
      researchRuns: '运行',
      researchErrors: '错误',
      researchInterval: '间隔',
      researchLastRun: '最近运行',
      researchNextDue: '下次到期',
      researchModel: '模型',
      researchProvider: '提供者',
      researchHourly: '每小时',
      researchBadgeHint: '隔离的每小时新闻分析',
      researchNone: '—',
      cadence: '研究频率',
      cadenceMode: '计划',
      cadenceInterval: '间隔',
      cadence1h: '每 1 小时',
      cadence3h: '每 3 小时',
      cadence6h: '每 6 小时',
      cadence24h: '每 24 小时',
      cadencePreOpen: '开盘前',
      cadencePostClose: '收盘后',
      cadencePreOpenPostClose: '开盘前 + 收盘后',
      cadenceApply: '应用频率',
      cadenceCurrent: '当前',
      cadenceNextDue: '下次到期',
      cadenceCustom: '自定义间隔',
      rewards: '奖励',
      rewardsEnabled: '启用奖励',
      rewardsPeriod: '周期',
      rewardsDaily: '每日',
      rewardsWeekly: '每周',
      rewardsMonthly: '每月',
      rewardsFirst: '第 1 名',
      rewardsSecond: '第 2 名',
      rewardsThird: '第 3 名',
      rewardsMax: '每周期上限',
      rewardsNoMax: '（无上限）',
      rewardsPreview: '预览',
      rewardsCash: '账户现金',
      rewardsPool: '可分配池',
      rewardsCapRemaining: '剩余分配上限',
      rewardsApply: '应用奖励设置',
      rewardsLastRun: '上次发放',
      rewardsNextRun: '下个周期边界',
      rewardsLastWinners: '上次获奖者',
      rewardsHistory: '发放历史',
      rewardsNoHistory: '暂无发放记录',
      rewardsPayBoundary: '仅在周期边界发放 —— 不提供“立即发放”',
      rewardsTotal: '合计',
      rewardsCappedBy: '受限于',
      rewardsPoolCap: '可分配池',
      rewardsAllocationCap: '分配上限',
      rewardsMaxCap: '每周期上限',
      rewardsDisabledNote: '奖励已禁用',
      leaderboards: '排行榜',
      lbDaily: '每日',
      lbWeekly: '每周',
      lbMonthly: '每月',
      lbRank: '排名',
      lbName: '个体',
      lbPnlPct: '盈亏 %',
      lbPnlUsd: '盈亏 $',
      lbEquity: '权益',
      lbTrades: '成交',
      lbEmpty: '暂无排行榜数据',
      lbAsOf: '截至',
      plan: '策略与计划',
      planSummary: '摘要',
      planEntry: '入场规则',
      planExit: '离场规则',
      planRisk: '风险规则',
      planNext: '下一步',
      planTriggers: '触发条件',
      planPosition: '持仓计划',
      planNoPosition: '暂无持仓',
      planNextResearch: '下次研究',
      planEmpty: '暂无策略计划',
      tx: '交易记录',
      txEmpty: '暂无交易记录',
      txOrderId: '订单',
      rankDay: '日',
      rankWeek: '周',
      rankMonth: '月',
      rankBadge: '排名',
      operatorControls: '操作员控制',
      cadenceEnabled: '收集简报',
      cadenceInfluence: '影响交易',
      strategyType: '策略类型',
      estInterval: '预计间隔',
      categoryAll: '全部',
      categorySwing: '波段 · 中长线',
      categoryDay: '日内 · 短线',
      botAgent: '机器人代理',
      botAgentEmpty: '机器人代理尚未复盘（首次复盘待执行）',
      botAgentBridge: '机器人代理',
      botAgentBridgeOff: '机器人代理桥接尚未配置',
      botAgentStale: '策略已过期 —— 执行层回退到最近的可用策略或基线',
      stance: '姿态',
      stanceTrade: '交易',
      stanceCautious: '谨慎',
      stanceStandDown: '观望',
      stanceUnknown: '—',
      sizeMultiplier: '仓位 ×',
      riskMultiplier: '风险 ×',
      confidence: '置信度',
      exitPressure: '离场压力',
      reviewCount: '复盘次数',
      lastReview: '上次复盘',
      nextReview: '下次复盘',
      watchlist: '关注',
      thesis: '观点',
      reviewInterval: '复盘间隔',
      instruments: '交易品种',
      instrumentsOff: '多品种纸面交易已关闭',
      instrumentsUnavailable: '暂无交易品种状态',
      badgeStock: '股票',
      badgeShort: '做空',
      badgeOptions: '期权',
      badgeSpreads: '价差',
      badgeMargin: '保证金',
      optionsLevel: '期权',
      shortEnabled: '做空',
      marginEnabled: '保证金',
      caps: '上限',
      capOptionsPct: '期权 ≤',
      capShortPct: '做空 ≤',
      dteRange: 'DTE',
      optionsBP: '期权购买力',
      buyingPower: '购买力',
      marginDebt: '保证金负债',
      grossExposure: '总敞口',
      netExposure: '净敞口',
      instrumentPlaybook: '品种策略',
      playbookFamily: '族',
      playbookBullish: '看涨',
      playbookBearish: '看跌',
      playbookNeutral: '中性',
      playbookStructures: '结构',
      playbookEmpty: '该策略暂无品种策略',
      instrumentPlan: '品种计划',
      prefer: '偏好',
      maxPremium: '最大权利金',
      maxContracts: '最大合约数',
      dteWindow: 'DTE 窗口',
      autoSelect: '自动',
      permissions: '权限',
      allowedStructures: '允许结构',
      instrumentsEmpty: '暂无品种权限',
      sideLabel: '方向',
      contracts: '合约数',
      strike: '行权价',
      expiry: '到期日',
      dte: 'DTE',
      group: '组',
      spreadGroup: '价差组',
      positionTotals: '合计',
      longPos: '多头',
      shortPos: '空头',
      callPos: '看涨',
      putPos: '看跌',
      lastCycle: '上一周期',
      lastCycleEmpty: '暂无周期数据',
      marketOpen: '市场开盘',
      marketClosed: '市场收盘',
      marketUnknown: '市场状态未知',
      tradingSkipped: '跳过交易',
      executions: '执行',
      orders: '订单',
      denied: '拒绝',
      topSkipReasons: '主要跳过原因',
      botReviews: '机器人复盘',
      reviewed: '已复盘',
      deferred: '延后',
      paused: '已暂停',
      brokerRestricted: '券商账户受限',
      brokerRestrictedUnavailable: '不可用（纸面权益低于保证金最低要求）',
      brokerRestrictedRemain: '多头股票与多头期权仍可用',
      accountFacts: '账户',
      onLabel: '开启',
      offLabel: '关闭',
      tabOverview: '概览',
      tabAgents: '个体',
      tabMarkets: '市场',
      tabResearch: '研究',
      tabRewards: '奖励',
      tabSettings: '设置',
      brand: 'MEAT',
      brandSub: '死亡工程化自动交易',
      kpiEquity: '账户权益',
      kpiEquityDetail: '模式',
      kpiDayPnl: '当日盈亏',
      kpiCashBp: '现金 / 购买力',
      kpiExposure: '总敞口',
      kpiNetExposure: '净敞口',
      kpiPopulation: '种群',
      kpiDead: '死亡',
      kpiTradesToday: '今日成交',
      kpiWinRate: '胜率',
      kpiTreasury: '资金跑道',
      kpiNoData: '—',
      liveFeed: '实时行情',
      feedLive: '实时',
      feedClosed: '休市',
      feedUnavailable: '实时行情不可用 —— 仅状态数据',
      feedRefreshing: '刷新中…',
      manualRefresh: '刷新',
      marketClock: '市场时钟',
      marketWatch: '市场观察',
      equityChart: '组合权益',
      strategyMixTitle: '策略配比',
      dayVsSwing: '日内 vs 波段',
      target: '目标',
      actual: '实际',
      tape: '实时行情',
      lastPrice: '最新',
      change: '涨跌',
      bidAsk: '买 / 卖',
      trend: '走势',
      closedLastClose: '休市 —— 最后收盘价',
      live: '实时',
      up: '涨',
      down: '跌',
      flat: '平',
      noMarketData: '暂无行情数据',
      chartEmpty: '数据不足',
      basket: '股票池',
      stance: '姿态',
      agentSearch: '搜索个体…',
      researchSummary: '研究覆盖',
      researchVerdicts: '结论',
      tierAll: '全部层级',
      feedStatus: '行情',
      marketSectionHint: '引擎运行时价格、盈亏与图表实时更新',
      paperDefault: '默认纸面交易；实盘需多重门禁',
      mode: '模式',
      loop: '循环',
      account: '账户权益',
      cash: '现金',
      treasury: '金库 / 续航',
      population: '种群',
      alive: '存活',
      dead: '死亡',
      condemned: '待处决',
      total: '总数',
      cap: '上限',
      burn: '燃烧速率',
      allocated: '已分配 / 上限',
      lastTick: '最近周期',
      obituaries: '死亡记录',
      generations: '世代',
      agents: '个体',
      agent: '个体',
      gen: '世代',
      strategy: '策略',
      genome: '基因组',
      trading: '交易（规格）',
      params: '参数',
      equity: '权益',
      pnl: '盈亏',
      dayPnl: '当日 %',
      net7d: '7日净额',
      runway: '续航',
      treasuryState: '金库',
      statusLabel: '状态',
      cause: '死因',
      positions: '持仓',
      parent: '父代',
      mutation: '变异',
      search: '搜索名称、id、代码、策略族…',
      filterAll: '全部',
      filterAlive: '存活',
      filterDead: '死亡',
      filterCondemned: '待处决',
      rows: '行',
      clickHint: '点击个体查看持仓与历史活动',
      noAgents: '暂无个体。启动下方引擎或运行一个周期。',
      noObits: '暂无死亡记录。',
      noGenerations: '暂无世代数据。',
      start: '启动',
      stop: '停止',
      emergency: '紧急停止',
      confirmStop: '确认停止',
      cancel: '取消',
      pause: '暂停',
      resume: '继续',
      refreshing: '刷新中…',
      autoRefresh: '每 3 秒自动刷新',
      pausedLabel: '已暂停',
      halted: '已暂停 — 新订单被阻止',
      brakes: '14 条硬熔断由代码强制执行',
      externalReaper: '外部 Reaper 是独立进程，无法从引擎中停止。',
      lastError: '最近错误',
      neverProfited: '从未盈利',
      firstProfit: '首次盈利',
      lifespan: '存活时长',
      updated: '更新于',
      controlOk: '{action} 已受理',
      controlFailed: '控制操作失败',
      close: '关闭',
      detailTitle: '个体详情',
      selectAgent: '选择一个个体，查看其持仓与历史活动。',
      holdings: '当前持仓',
      noPositions: '暂无持仓。',
      activity: '历史活动',
      noTrades: '暂无成交记录 · 市场休市。',
      side: '方向',
      buy: '买入',
      sell: '卖出',
      symbol: '代码',
      qty: '数量',
      avgPrice: '均价',
      lastPrice: '现价',
      marketValue: '市值',
      unrealized: '未实现',
      openedAt: '开仓',
      time: '时间',
      price: '价格',
      notional: '名义金额',
      realized: '已实现',
      cost: '成本',
      costs: '角色成本',
      strategyParams: '策略参数',
      genomeParams: '基因组（继承）',
      specParams: '交易（编译规格）',
      specCreated: '编译于',
      noSpec: '暂无编译规格 — 按继承基因组交易。',
      specDiffers: '编译规格与继承基因组不同',
      genomeOnly: '仅基因组',
      born: '出生',
      died: '死亡',
      drawdown: '回撤',
      endowment: '初始资金',
      positionsValue: '持仓市值',
      tradingState: '存活 / 死亡',
      dayPnlTitle: '当日盈亏',
      net7dTitle: '7日净额',
      role: '角色',
      amount: '金额',
      tradesCount: '成交',
      positionsCount: '持仓',
      mutationFrom: '从',
      mutationTo: '到',
      noParent: '创世',
      none: '—',
    };

    /** Bind the Client locale service; fall back to the bundled English dictionary. */
    function createTranslator(ctx) {
      try {
        const locale = ctx && ctx.locale;
        if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
          ctx.effect(
            () => locale.register(NS, { en: EN, zh: ZH }),
            'automaton-trading: locale dictionaries',
          );
          const bound = locale.bind(NS);
          if (typeof bound === 'function') {
            return (key) => {
              const value = bound(key);
              return typeof value === 'string' && value.length > 0 ? value : (EN[key] ?? key);
            };
          }
        }
      } catch {
        /* locale is optional for rendering; never blank the panel because of it */
      }
      return (key) => EN[key] ?? key;
    }

    // -----------------------------------------------------------------------
    // formatting helpers (pure)
    // -----------------------------------------------------------------------

    function toNumber(value) {
      if (value === null || value === undefined || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    }

    function round2(value) {
      return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
    }

    function fmtUsd(value) {
      const number = toNumber(value);
      if (number === null) return '—';
      return `$${number.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }

    function fmtSignedUsd(value) {
      const number = toNumber(value);
      if (number === null) return '—';
      const sign = number > 0 ? '+' : number < 0 ? '−' : '';
      return `${sign}$${Math.abs(number).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }

    /** Accept a fraction (0.023) or points (2.3) and render percent points. */
    function pctPoints(value) {
      const number = toNumber(value);
      if (number === null) return null;
      return Math.abs(number) <= 1 ? number * 100 : number;
    }

    function fmtPct(value) {
      const points = pctPoints(value);
      if (points === null) return '—';
      const sign = points > 0 ? '+' : points < 0 ? '−' : '';
      return `${sign}${Math.abs(points).toFixed(1)}%`;
    }

    function fmtPercentPoints(points) {
      const number = toNumber(points);
      if (number === null) return '—';
      const sign = number > 0 ? '+' : number < 0 ? '−' : '';
      return `${sign}${Math.abs(number).toFixed(1)}%`;
    }

    function fmtPctPlain(value) {
      const points = pctPoints(value);
      if (points === null) return '—';
      return `${Math.abs(points).toFixed(0)}%`;
    }

    function fmtNum(value) {
      const number = toNumber(value);
      if (number === null) return '—';
      return Math.trunc(number).toLocaleString('en-US');
    }

    function fmtQty(value) {
      const number = toNumber(value);
      if (number === null) return '—';
      const fixed = Math.abs(number) >= 1 ? number.toFixed(2) : number.toFixed(4);
      return fixed.replace(/\.?0+$/, '');
    }

    function fmtHours(value) {
      const number = toNumber(value);
      if (number === null) return '—';
      if (number >= 100) return `${Math.round(number)} h`;
      return `${number.toFixed(1)} h`;
    }

    function fmtAgo(iso) {
      if (!iso) return '—';
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) return '—';
      const deltaSec = Math.max(0, Math.round((Date.now() - ms) / 1000));
      if (deltaSec < 60) return `${deltaSec}s`;
      if (deltaSec < 3600) return `${Math.round(deltaSec / 60)}m`;
      if (deltaSec < 86400) return `${Math.round(deltaSec / 3600)}h`;
      return new Date(ms).toLocaleDateString();
    }

    function fmtDateTime(iso) {
      if (!iso) return '—';
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) return '—';
      return new Date(ms).toLocaleString();
    }

    function shortId(value) {
      const text = String(value ?? '');
      return text.startsWith('atm-') ? text.slice(4) : text;
    }

    function errorText(error) {
      if (!error) return '';
      if (typeof error === 'string') return error;
      return String(error.message ?? error.code ?? JSON.stringify(error));
    }

    function modeOf(data) {
      const mode = String(data?.mode ?? data?.config?.mode ?? 'unknown').toLowerCase();
      return MODE_LABEL[mode] ? mode : 'unknown';
    }

    function lifespanHours(bornAt, diedAt) {
      if (!bornAt || !diedAt) return null;
      const born = Date.parse(bornAt);
      const died = Date.parse(diedAt);
      if (!Number.isFinite(born) || !Number.isFinite(died) || died < born) return null;
      return round2((died - born) / (60 * 60 * 1000));
    }

    // -----------------------------------------------------------------------
    // strategy labels (pure; names are strategy-derived, engine-provided)
    // -----------------------------------------------------------------------

    function familyLabel(family) {
      const key = String(family ?? '').trim().toLowerCase();
      if (key.length === 0) return '';
      return FAMILY_LABELS[key] ?? `${key.charAt(0).toUpperCase()}${key.slice(1)}`;
    }

    /** "Momentum AAPL" from a genome/spec; '' when neither field is present. */
    function strategyLabel(strategy) {
      if (!strategy || typeof strategy !== 'object') return '';
      const family = familyLabel(strategy.family);
      const symbol = typeof strategy.symbol === 'string' && strategy.symbol.length > 0 ? strategy.symbol : '';
      return [family, symbol].filter(Boolean).join(' ').trim();
    }

    /** Primary agent label: engine name, else strategy label, else short id. */
    function agentDisplayName(agent) {
      if (agent && typeof agent.name === 'string' && agent.name.trim().length > 0) return agent.name.trim();
      const strategy = strategyLabel(agent?.genome);
      if (strategy.length > 0) return strategy;
      return shortId(agent?.id);
    }

    /** Strategy parameter summary for one genome/spec params object. */
    function strategyParamsText(params) {
      if (!params || typeof params !== 'object') return '—';
      const parts = [];
      if (params.lookback !== undefined) parts.push(`lb${params.lookback}`);
      if (params.entryZ !== undefined || params.exitZ !== undefined) parts.push(`z${params.entryZ ?? '?'}/${params.exitZ ?? '?'}`);
      if (params.stopPct !== undefined || params.targetPct !== undefined) {
        parts.push(`s${fmtPctPlain(params.stopPct)}/t${fmtPctPlain(params.targetPct)}`);
      }
      if (params.maxHoldBars !== undefined) parts.push(`h${params.maxHoldBars}`);
      if (params.sizePct !== undefined) parts.push(fmtPctPlain(params.sizePct));
      if (params.sessionFilter !== undefined) parts.push(String(params.sessionFilter));
      return parts.length > 0 ? parts.join(' · ') : '—';
    }

    /** Structured parameter chips for the detail pane. */
    function strategyParamItems(params) {
      if (!params || typeof params !== 'object') return [];
      const items = [];
      const push = (key, label, format) => {
        if (params[key] === undefined || params[key] === null) return;
        const value = format ? format(params[key]) : String(params[key]);
        items.push({ key, label, value });
      };
      push('lookback', 'lookback');
      push('entryZ', 'entryZ');
      push('exitZ', 'exitZ');
      push('stopPct', 'stop', fmtPctPlain);
      push('targetPct', 'target', fmtPctPlain);
      push('maxHoldBars', 'maxHold');
      push('sizePct', 'size', fmtPctPlain);
      push('sessionFilter', 'session');
      return items;
    }

    // -----------------------------------------------------------------------
    // pure data mapping (exported for tests under `helpers`)
    // -----------------------------------------------------------------------

    const plainObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

    /**
     * Human description of the engine's Reaper telemetry, read fresh from disk by
     * `engine.status()`: `{pid, alive, startedAt, heartbeatAt, heartbeatVersion, sweeps,
     * note, error?, hint?}`. Older engine builds reported only `{pid, alive, error, note}`.
     * A Reaper that is alive without a version-2 heartbeat belongs to a stale generation
     * and must be stopped by the operator before the engine will start.
     * @param {object|null} reaper engine.status().engine.reaper
     * @returns {{kind:'stopped'|'stale'|'healthy', pid:number|null, alive:boolean,
     *   heartbeatAt:string|null, heartbeatVersion:number|null, startedAt:string|null,
     *   sweeps:number|null, stale:boolean, error:string|null, hint:string|null, note:string|null}}
     */
    function describeReaper(reaper) {
      const info = plainObject(reaper);
      const rawPid = toNumber(info.pid);
      const pid = rawPid !== null && rawPid > 0 ? rawPid : null;
      const alive = info.alive === true;
      const heartbeatAt = typeof info.heartbeatAt === 'string' && info.heartbeatAt.length > 0 ? info.heartbeatAt : null;
      const heartbeatVersion = toNumber(info.heartbeatVersion);
      // A fresh Reaper writes heartbeat version 2 every sweep; an alive process without
      // that heartbeat belongs to a stale/legacy generation and must be operator-stopped.
      const freshHeartbeat = heartbeatAt !== null && heartbeatVersion !== null && heartbeatVersion >= 2;
      const stale = Boolean(alive && !freshHeartbeat);
      let kind = 'healthy';
      if (!alive || pid === null) kind = 'stopped';
      else if (stale) kind = 'stale';
      return {
        kind,
        pid,
        alive,
        heartbeatAt,
        heartbeatVersion,
        startedAt: typeof info.startedAt === 'string' ? info.startedAt : null,
        sweeps: toNumber(info.sweeps),
        stale,
        error: info.error ? String(info.error) : null,
        hint: info.hint ? String(info.hint) : null,
        note: info.note ? String(info.note) : null,
      };
    }

    /** Current holdings rows from an agent's `positions`. */
    function buildHoldingsRows(positions) {
      const list = Array.isArray(positions) ? positions : [];
      return list.filter((position) => position && typeof position === 'object').map((position, index) => {
        const qty = toNumber(position.qty);
        const avgPrice = toNumber(position.avgPriceUsd);
        const lastPrice = toNumber(position.lastPriceUsd);
        const marketValue = toNumber(position.marketValueUsd)
          ?? (qty !== null && lastPrice !== null ? round2(qty * lastPrice) : null);
        const unrealized = toNumber(position.unrealizedPlUsd)
          ?? (qty !== null && avgPrice !== null && lastPrice !== null ? round2((lastPrice - avgPrice) * qty) : null);
        return {
          key: `${position.symbol ?? 'position'}-${index}`,
          symbol: position.symbol ?? '—',
          qty,
          qtyText: fmtQty(qty),
          avgPriceUsd: avgPrice,
          lastPriceUsd: lastPrice,
          marketValueUsd: marketValue,
          unrealizedPlUsd: unrealized,
          openedAt: position.openedAt ?? null,
        };
      });
    }

    /** Past-activity rows from an agent's `recentTrades` (newest first, as provided). */
    function buildActivityRows(trades) {
      const list = Array.isArray(trades) ? trades : [];
      return list.filter((trade) => trade && typeof trade === 'object').map((trade, index) => {
        const sideRaw = String(trade.side ?? '').toLowerCase();
        const qty = toNumber(trade.qty);
        const price = toNumber(trade.priceUsd);
        return {
          key: `${trade.orderId ?? trade.id ?? 'trade'}-${index}`,
          symbol: trade.symbol ?? '—',
          side: sideRaw === 'sell' ? 'sell' : sideRaw === 'buy' ? 'buy' : '—',
          qty,
          qtyText: fmtQty(qty),
          priceUsd: price,
          notionalUsd: toNumber(trade.notionalUsd) ?? (qty !== null && price !== null ? round2(qty * price) : null),
          realizedPlUsd: toNumber(trade.realizedPlUsd),
          at: trade.at ?? null,
          orderId: trade.orderId ?? null,
        };
      });
    }

    /** Role-cost pairs (stable ascending by role name for a predictable rendering). */
    function roleCostRows(roleCosts) {
      const costs = plainObject(roleCosts);
      return Object.keys(costs)
        .sort()
        .map((role) => ({ role, amountUsd: toNumber(costs[role]) ?? 0 }));
    }

    // -----------------------------------------------------------------------
    // research sidecar mapping (pure)
    // -----------------------------------------------------------------------

    const RESEARCH_VERDICTS = Object.freeze(['HOLD', 'AVOID', 'ALERT']);
    const RESEARCH_SOURCE_URL = /^https?:\/\//i;

    function clampRange(value, min, max) {
      const number = toNumber(value);
      if (number === null) return null;
      return Math.max(min, Math.min(max, number));
    }

    function researchStringList(value, limit = 4) {
      if (!Array.isArray(value)) return [];
      return value
        .filter((item) => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim())
        .slice(0, limit);
    }

    function mapResearchSource(raw, index) {
      const source = plainObject(raw);
      const title = typeof source.title === 'string' && source.title.trim().length > 0
        ? source.title.trim()
        : (typeof source.source === 'string' && source.source.trim().length > 0 ? source.source.trim() : 'source');
      const url = typeof source.url === 'string' && RESEARCH_SOURCE_URL.test(source.url.trim())
        ? source.url.trim()
        : null;
      return {
        key: `research-source-${index}`,
        title,
        source: typeof source.source === 'string' ? source.source : null,
        url,
        at: source.at ?? null,
      };
    }

    /**
     * Normalize one agent's `research` briefing. Returns null when absent/malformed.
     * Pure helper shared by the table badge, the detail section and the tests.
     * @param {object|null} raw status.agents[*].research
     * @returns {object|null}
     */
    function mapResearchBriefing(raw) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const rawVerdict = typeof raw.verdict === 'string' ? raw.verdict.trim().toUpperCase() : '';
      const verdict = RESEARCH_VERDICTS.includes(rawVerdict) ? rawVerdict : null;
      const summary = typeof raw.summary === 'string' && raw.summary.trim().length > 0 ? raw.summary.trim() : null;
      const at = typeof raw.at === 'string' && raw.at.length > 0 ? raw.at : null;
      const catalysts = researchStringList(raw.catalysts, 4);
      const risks = researchStringList(raw.risks, 4);
      const sources = (Array.isArray(raw.sources) ? raw.sources : []).slice(0, 6).map(mapResearchSource);
      if (verdict === null && summary === null && at === null && catalysts.length === 0 && risks.length === 0 && sources.length === 0) {
        return null;
      }
      return {
        at,
        ageSec: toNumber(raw.ageSec),
        verdict,
        sentiment: clampRange(raw.sentiment, -1, 1),
        confidence: clampRange(raw.confidence, 0, 1),
        summary,
        catalysts,
        risks,
        sources,
        stale: raw.stale === true,
      };
    }

    /**
     * Table badge projection: `HOLD +0.2` / `AVOID -0.6` / `ALERT +0.1`, `—` when none.
     * @param {object|null} research status.agents[*].research
     */
    function researchBadge(research) {
      const briefing = mapResearchBriefing(research);
      if (!briefing) {
        return { hasResearch: false, label: '—', tone: 'none', stale: false, verdict: null, sentiment: null, title: '' };
      }
      const verdict = briefing.verdict ?? '—';
      const sentimentText = briefing.sentiment === null
        ? ''
        : ` ${briefing.sentiment > 0 ? '+' : ''}${briefing.sentiment.toFixed(1)}`;
      return {
        hasResearch: true,
        label: `${verdict}${sentimentText}`,
        tone: verdict === 'AVOID' ? 'avoid' : verdict === 'ALERT' ? 'alert' : verdict === 'HOLD' ? 'hold' : 'none',
        stale: briefing.stale,
        verdict: briefing.verdict,
        sentiment: briefing.sentiment,
        title: briefing.summary ?? '',
      };
    }

    /**
     * `status.engine.research` projection (schedule + configured/shadow state).
     * @param {object} status the GET /automaton/state payload
     */
    function researchStatusSummary(status) {
      const raw = plainObject(status?.engine?.research ?? status?.research);
      if (Object.keys(raw).length === 0) {
        return {
          available: false,
          enabled: null,
          configured: null,
          influence: null,
          shadow: false,
          disabledReason: null,
          scheduleMode: null,
          configurable: { scheduleModes: null, intervalOptionsSec: null },
          note: null,
          pausedReason: null,
          intervalSec: null,
          lastRunAt: null,
          nextDueAt: null,
          provider: null,
          model: null,
          runs: null,
          errors: null,
        };
      }
      const configured = raw.configured === true ? true : raw.configured === false ? false : null;
      const enabled = raw.enabled === true ? true : raw.enabled === false ? false : null;
      const influence = raw.influence === true ? true : raw.influence === false ? false : null;
      const disabledReason = configured === false ? 'unconfigured' : enabled === false ? 'disabled' : null;
      const configurable = plainObject(raw.configurable);
      return {
        available: true,
        enabled,
        configured,
        influence,
        shadow: influence === false,
        disabledReason,
        scheduleMode: typeof raw.scheduleMode === 'string' ? raw.scheduleMode : null,
        configurable: {
          scheduleModes: Array.isArray(configurable.scheduleModes) ? configurable.scheduleModes : null,
          intervalOptionsSec: Array.isArray(configurable.intervalOptionsSec) ? configurable.intervalOptionsSec.map((value) => toNumber(value)).filter((value) => value !== null) : null,
        },
        note: typeof raw.note === 'string' ? raw.note : null,
        pausedReason: raw.pausedReason ?? raw.note ?? null,
        intervalSec: toNumber(raw.intervalSec),
        lastRunAt: raw.lastRunAt ?? null,
        nextDueAt: raw.nextDueAt ?? null,
        provider: raw.provider ?? null,
        model: raw.model ?? null,
        runs: toNumber(raw.runs),
        errors: toNumber(raw.errors),
      };
    }

    /** i18n key describing the current influence mode (shadow vs influence). */
    function researchModeKey(statusResearch) {
      if (!statusResearch || statusResearch.available !== true) return 'researchUnknown';
      if (statusResearch.influence === true) return 'researchInfluence';
      if (statusResearch.influence === false) return 'researchShadow';
      return 'researchUnknown';
    }

    // -----------------------------------------------------------------------
    // operator controls mapping: research cadence, rewards, leaderboards
    // -----------------------------------------------------------------------

    /** Cadence options (docs/CONTROL-PANEL.md): keys double as UI values. */
    const RESEARCH_CADENCE_OPTIONS = Object.freeze([
      { key: 'interval:3600', mode: 'interval', intervalSec: 3600, labelKey: 'cadence1h' },
      { key: 'interval:10800', mode: 'interval', intervalSec: 10800, labelKey: 'cadence3h' },
      { key: 'interval:21600', mode: 'interval', intervalSec: 21600, labelKey: 'cadence6h' },
      { key: 'interval:86400', mode: 'interval', intervalSec: 86400, labelKey: 'cadence24h' },
      { key: 'pre-open', mode: 'pre-open', intervalSec: null, labelKey: 'cadencePreOpen' },
      { key: 'post-close', mode: 'post-close', intervalSec: null, labelKey: 'cadencePostClose' },
      { key: 'pre-open+post-close', mode: 'pre-open+post-close', intervalSec: null, labelKey: 'cadencePreOpenPostClose' },
    ]);

    /** Current cadence selection key for one research-status projection. */
    function researchCadenceKey(statusResearch) {
      if (!statusResearch || statusResearch.available !== true) return null;
      const mode = typeof statusResearch.scheduleMode === 'string' ? statusResearch.scheduleMode : null;
      if (mode !== null && mode !== 'interval') return mode;
      const interval = toNumber(statusResearch.intervalSec);
      if (mode === 'interval' || interval !== null) {
        const option = RESEARCH_CADENCE_OPTIONS.find((candidate) => candidate.mode === 'interval' && candidate.intervalSec === interval);
        return option ? option.key : `interval:${interval ?? 3600}`;
      }
      return null;
    }

    /** Build the `set-research-settings` patch from a cadence key + toggles. */
    function researchSettingsFromCadence(cadenceKey, { enabled, influence } = {}) {
      const option = RESEARCH_CADENCE_OPTIONS.find((candidate) => candidate.key === cadenceKey);
      if (!option) return null;
      const patch = { mode: option.mode };
      if (option.mode === 'interval' && option.intervalSec !== null) patch.intervalSec = option.intervalSec;
      if (typeof enabled === 'boolean') patch.enabled = enabled;
      if (typeof influence === 'boolean') patch.influence = influence;
      return patch;
    }

    /** Normalized `engine.rewards` view for the operator rewards card. */
    function rewardsControlState(statusRewards) {
      const raw = plainObject(statusRewards);
      const percents = Array.isArray(raw.rankPercents) && raw.rankPercents.length === 3
        ? raw.rankPercents.map((value) => toNumber(value) ?? 0)
        : [0.05, 0.03, 0.02];
      return {
        available: Object.keys(raw).length > 0,
        enabled: raw.enabled !== false,
        period: ['daily', 'weekly', 'monthly'].includes(raw.period) ? raw.period : 'daily',
        rankPercents: percents,
        basis: typeof raw.basis === 'string' ? raw.basis : 'account-cash',
        maxPerPeriodUsd: raw.maxPerPeriodUsd === null || raw.maxPerPeriodUsd === undefined ? null : toNumber(raw.maxPerPeriodUsd),
        accountCashUsd: toNumber(raw.accountCashUsd),
        poolUsd: toNumber(raw.poolUsd),
        allocationCapRemainingUsd: toNumber(raw.allocationCapRemainingUsd),
        lastRunAt: raw.lastRunAt ?? null,
        nextRunAt: raw.nextRunAt ?? null,
        lastWinners: Array.isArray(raw.lastWinners) ? raw.lastWinners : [],
      };
    }

    /**
     * Money preview for the configured rank percentages, capped exactly like the rewards
     * module: proportional scaling when pool / allocation-cap / max-per-period are short.
     */
    function rewardsPreview(stateRewards, rankPercents) {
      const state = rewardsControlState(stateRewards);
      const percents = Array.isArray(rankPercents) && rankPercents.length === 3
        ? rankPercents.map((value) => toNumber(value) ?? 0)
        : state.rankPercents;
      const cash = state.accountCashUsd;
      const rawAmounts = percents.map((percent) => (cash === null ? null : round2(percent * cash)));
      const rawTotal = rawAmounts.reduce((total, amount) => total + (amount ?? 0), 0);
      const caps = [];
      if (state.poolUsd !== null) caps.push({ key: 'pool', availableUsd: state.poolUsd });
      if (state.allocationCapRemainingUsd !== null) caps.push({ key: 'allocation', availableUsd: state.allocationCapRemainingUsd });
      if (state.maxPerPeriodUsd !== null) caps.push({ key: 'max', availableUsd: state.maxPerPeriodUsd });
      let scale = 1;
      let cappedBy = null;
      for (const cap of caps) {
        if (rawTotal <= 0) break;
        if (cap.availableUsd < rawTotal * scale) {
          scale = Math.max(0, cap.availableUsd / rawTotal);
          cappedBy = cap.key;
        }
      }
      const amounts = rawAmounts.map((amount) => (amount === null ? null : round2(amount * scale)));
      const totalUsd = round2(amounts.reduce((total, amount) => total + (amount ?? 0), 0));
      return {
        period: state.period,
        basis: state.basis,
        accountCashUsd: cash,
        poolUsd: state.poolUsd,
        allocationCapRemainingUsd: state.allocationCapRemainingUsd,
        maxPerPeriodUsd: state.maxPerPeriodUsd,
        rankPercents: percents,
        rawAmounts,
        rawTotalUsd: round2(rawTotal),
        amounts,
        totalUsd,
        scale,
        cappedBy,
        capped: cappedBy !== null,
      };
    }

    /** History rows for the rewards card (newest first, last 8). */
    function rewardHistoryRows(status) {
      const history = Array.isArray(status?.rewards?.history) ? status.rewards.history : [];
      return history.slice(0, 8).map((entry, index) => {
        const winners = Array.isArray(entry?.winners) ? entry.winners : [];
        return {
          key: `${entry?.periodKey ?? 'period'}-${index}`,
          periodKey: entry?.periodKey ?? null,
          period: entry?.period ?? null,
          at: entry?.at ?? null,
          totalUsd: round2(winners.reduce((total, winner) => total + (toNumber(winner?.amountUsd) ?? 0), 0)),
          winners: winners.map((winner, winnerIndex) => ({
            key: `${winner?.agentId ?? 'winner'}-${winnerIndex}`,
            rank: toNumber(winner?.rank),
            agentId: winner?.agentId ?? null,
            name: winner?.name ?? winner?.agentId ?? '—',
            percent: toNumber(winner?.percent),
            amountUsd: toNumber(winner?.amountUsd),
          })),
        };
      });
    }

    /** Last-winners rows from engine.rewards.lastWinners. */
    function lastWinnerRows(statusRewards) {
      const state = rewardsControlState(statusRewards);
      return state.lastWinners.map((winner, index) => ({
        key: `${winner?.agentId ?? 'winner'}-${index}`,
        rank: toNumber(winner?.rank),
        agentId: winner?.agentId ?? null,
        name: winner?.name ?? winner?.agentId ?? '—',
        percent: toNumber(winner?.percent),
        amountUsd: toNumber(winner?.amountUsd),
      }));
    }

    const MEDALS = Object.freeze({ 1: '🥇', 2: '🥈', 3: '🥉' });

    function mapLeaderboardRows(entries) {
      const list = Array.isArray(entries) ? entries : [];
      return list.map((entry, index) => {
        const rank = toNumber(entry?.rank) ?? index + 1;
        return {
          key: `${entry?.agentId ?? 'row'}-${index}`,
          rank,
          medal: MEDALS[rank] ?? null,
          agentId: entry?.agentId ?? null,
          name: entry?.name ?? entry?.agentId ?? '—',
          pnlUsd: toNumber(entry?.pnlUsd),
          pnlPct: toNumber(entry?.pnlPct),
          equityUsd: toNumber(entry?.equityUsd),
          baselineEquityUsd: toNumber(entry?.baselineEquityUsd),
          trades: toNumber(entry?.trades),
          history: entry?.history ?? null,
        };
      });
    }

    /** Leaderboards projection from `status.rankings` (daily/weekly/monthly). */
    function leaderboardPeriods(status) {
      const periods = plainObject(status?.rankings?.periods);
      return {
        asOf: status?.rankings?.asOf ?? null,
        daily: mapLeaderboardRows(periods.daily),
        weekly: mapLeaderboardRows(periods.weekly),
        monthly: mapLeaderboardRows(periods.monthly),
      };
    }

    /** Strategy explanation / plan / next-step mapping for the agent detail pane. */
    function agentPlanMapping(plan) {
      const raw = plainObject(plan);
      if (Object.keys(raw).length === 0) return null;
      const triggers = plainObject(raw.triggers);
      const triggerItems = [];
      const pushTrigger = (key, label, format) => {
        if (triggers[key] === undefined || triggers[key] === null) return;
        triggerItems.push({ key, label, value: format ? format(triggers[key]) : String(triggers[key]) });
      };
      pushTrigger('family', 'family', familyLabel);
      pushTrigger('symbol', 'symbol');
      pushTrigger('entryZ', 'entryZ');
      pushTrigger('exitZ', 'exitZ');
      pushTrigger('stopPct', 'stop', fmtPctPlain);
      pushTrigger('targetPct', 'target', fmtPctPlain);
      pushTrigger('maxHoldBars', 'maxHold');
      pushTrigger('sizePct', 'size', fmtPctPlain);
      pushTrigger('sessionFilter', 'session');
      const position = plainObject(raw.position);
      const hasPosition = Object.keys(position).length > 0;
      return {
        summary: typeof raw.summary === 'string' ? raw.summary : null,
        entryRule: typeof raw.entryRule === 'string' ? raw.entryRule : null,
        exitRules: Array.isArray(raw.exitRules) ? raw.exitRules.filter((rule) => typeof rule === 'string' && rule.trim().length > 0) : [],
        riskRule: typeof raw.riskRule === 'string' ? raw.riskRule : null,
        nextStep: typeof raw.nextStep === 'string' ? raw.nextStep : null,
        triggers: triggerItems,
        position: hasPosition ? {
          symbol: position.symbol ?? null,
          qty: toNumber(position.qty),
          qtyText: fmtQty(position.qty),
          avgPriceUsd: toNumber(position.avgPriceUsd),
          stopPriceUsd: toNumber(position.stopPriceUsd),
          targetPriceUsd: toNumber(position.targetPriceUsd),
          barsHeld: toNumber(position.barsHeld),
          maxHoldBars: toNumber(position.maxHoldBars),
        } : null,
        nextResearchAt: raw.nextResearchAt ?? null,
        hasContent: Boolean(raw.summary || raw.entryRule || raw.nextStep || raw.exitRules?.length || raw.riskRule || triggerItems.length || hasPosition),
      };
    }

    /** Full order/fill history rows for the agent detail "Transactions" table. */
    function agentTransactionRows(orders) {
      const list = Array.isArray(orders) ? orders : [];
      return list.map((order, index) => {
        const sideRaw = String(order?.side ?? '').toLowerCase();
        const qty = toNumber(order?.qty);
        const price = toNumber(order?.priceUsd);
        return {
          key: `${order?.orderId ?? order?.id ?? 'order'}-${index}`,
          symbol: order?.symbol ?? '—',
          side: sideRaw === 'sell' ? 'sell' : sideRaw === 'buy' ? 'buy' : '—',
          qty,
          qtyText: fmtQty(qty),
          priceUsd: price,
          notionalUsd: toNumber(order?.notionalUsd) ?? (qty !== null && price !== null ? round2(qty * price) : null),
          realizedPlUsd: toNumber(order?.realizedPlUsd),
          at: order?.at ?? null,
          orderId: order?.orderId ?? null,
        };
      });
    }

    /** Ranking badges (`dayRank/weekRank/monthRank`) for the detail header. */
    function agentRankingBadges(rankings) {
      const raw = plainObject(rankings);
      if (Object.keys(raw).length === 0) return [];
      const badges = [];
      const push = (key, labelKey, rankKey, pctKey) => {
        const rank = toNumber(raw[rankKey]);
        if (rank === null) return;
        badges.push({ key, labelKey, rank, pct: toNumber(raw[pctKey]), medal: MEDALS[rank] ?? null });
      };
      push('day', 'rankDay', 'dayRank', 'dayPct');
      push('week', 'rankWeek', 'weekRank', 'weekPct');
      push('month', 'rankMonth', 'monthRank', 'monthPct');
      return badges;
    }

    /** P&L view used by the detail summary (`agent.pnl`, optional). */
    function agentPnlMapping(pnl) {
      const raw = plainObject(pnl);
      if (Object.keys(raw).length === 0) return null;
      return {
        realizedUsd: toNumber(raw.realizedUsd),
        unrealizedUsd: toNumber(raw.unrealizedUsd),
        netUsd: toNumber(raw.netUsd),
        dayPct: toNumber(raw.dayPct),
        weekPct: toNumber(raw.weekPct),
        monthPct: toNumber(raw.monthPct),
      };
    }

    // -----------------------------------------------------------------------
    // strategy taxonomy + per-bot agent brain (docs/BOT-AGENTS.md)
    // -----------------------------------------------------------------------

    const STRATEGY_CATEGORY_LABELS = Object.freeze({ swing: 'Swing · mid-long', day: 'Day · intraday' });
    const STRATEGY_CATEGORY_SHORT = Object.freeze({ swing: 'Swing', day: 'Day' });
    const STRATEGY_CATEGORY_KEYS = Object.freeze({ swing: 'categorySwing', day: 'categoryDay' });
    /** Client-side taxonomy fallback when the engine has not added `agent.strategy` yet. */
    const STRATEGY_TYPE_FALLBACK = Object.freeze({
      momentum: { category: 'swing', typeLabel: 'Momentum swing', className: 'momentum', estimatedIntervalSec: 3600, timeframe: '1Hour' },
      meanrev: { category: 'swing', typeLabel: 'Mean-reversion swing', className: 'meanrev', estimatedIntervalSec: 3600, timeframe: '1Hour' },
      breakout: { category: 'day', typeLabel: 'Intraday breakout', className: 'breakout', estimatedIntervalSec: 300, timeframe: '1Min' },
      gapfade: { category: 'day', typeLabel: 'Day-trade gap fade', className: 'gapfade', estimatedIntervalSec: 300, timeframe: '1Min' },
    });

    /** Format an estimated decision interval in seconds ("~30s" / "~5m" / "~1h"). */
    function estimatedIntervalLabel(seconds) {
      const value = toNumber(seconds);
      if (value === null || value <= 0) return '—';
      if (value < 120) return `~${Math.round(value)}s`;
      if (value < 3600) return `~${Math.round(value / 60)}m`;
      return `~${Math.round((value / 3600) * 10) / 10}h`;
    }

    /** Category label ("Swing · mid-long" / "Day · intraday") from a strategy mapping. */
    function strategyCategoryLabel(category) {
      return STRATEGY_CATEGORY_LABELS[category] ?? null;
    }

    /**
     * Per-agent strategy taxonomy projection. Uses `agent.strategy` when the engine
     * provides it, otherwise falls back to the genome family (same mapping as the engine).
     * @param {object} agent raw status agent
     * @returns {object} always available (unknown families fall back to swing)
     */
    function agentStrategyMapping(agent) {
      const safeAgent = plainObject(agent);
      const raw = plainObject(safeAgent.strategy);
      const genome = plainObject(safeAgent.genome);
      const family = String(raw.family ?? genome.family ?? 'unknown').toLowerCase();
      const fallback = STRATEGY_TYPE_FALLBACK[family] ?? {
        category: 'swing',
        typeLabel: 'Custom swing',
        className: 'custom',
        estimatedIntervalSec: 3600,
        timeframe: '1Hour',
      };
      const category = raw.category === 'day' || raw.category === 'swing' ? raw.category : fallback.category;
      const cadence = plainObject(safeAgent.cadence);
      const lane = plainObject(cadence[category]);
      const timeframe = raw.timeframe ?? lane.timeframe ?? fallback.timeframe;
      let estimatedIntervalSec = toNumber(raw.estimatedIntervalSec);
      if (estimatedIntervalSec === null) estimatedIntervalSec = toNumber(lane.intervalSec);
      if (estimatedIntervalSec === null) estimatedIntervalSec = fallback.estimatedIntervalSec;
      const typeLabel = typeof raw.typeLabel === 'string' && raw.typeLabel.length > 0 ? raw.typeLabel : fallback.typeLabel;
      const categoryLabel = typeof raw.categoryLabel === 'string' && raw.categoryLabel.length > 0
        ? raw.categoryLabel
        : (STRATEGY_CATEGORY_LABELS[category] ?? category);
      return {
        hasEngineStrategy: Object.keys(raw).length > 0,
        family,
        category,
        tier: raw.tier ?? category,
        typeLabel,
        className: typeof raw.className === 'string' ? raw.className : fallback.className,
        description: typeof raw.description === 'string' ? raw.description : '',
        categoryLabel,
        categoryShortLabel: STRATEGY_CATEGORY_SHORT[category] ?? category,
        categoryKey: STRATEGY_CATEGORY_KEYS[category] ?? 'categoryAll',
        estimatedIntervalSec,
        estimatedIntervalLabel: estimatedIntervalLabel(estimatedIntervalSec),
        timeframe,
        reviewSec: toNumber(raw.reviewSec) ?? toNumber(lane.intervalSec) ?? null,
      };
    }

    /** Stance badge projection for a bot-agent policy. */
    function stanceBadge(stance) {
      const key = String(stance ?? '').toLowerCase();
      if (key === 'stand_down') return { stance: 'stand_down', labelKey: 'stanceStandDown', tone: 'stand_down', label: 'STAND DOWN' };
      if (key === 'cautious') return { stance: 'cautious', labelKey: 'stanceCautious', tone: 'cautious', label: 'CAUTIOUS' };
      if (key === 'trade') return { stance: 'trade', labelKey: 'stanceTrade', tone: 'trade', label: 'TRADE' };
      return { stance: 'unknown', labelKey: 'stanceUnknown', tone: 'unknown', label: '—' };
    }

    /**
     * Per-bot agent brain policy projection (`agent.policy`).
     * @param {object|null} policy {at, atMs, stance, sizeMultiplier, riskMultiplier, exitPressure,
     *   confidence, thesis, plan[], watch[], reviewSec, stale, reviewCount, nextReviewAt}
     * @returns {object|null} null when the bot agent has not reviewed yet
     */
    function botAgentPolicyMapping(policy) {
      const raw = plainObject(policy);
      if (Object.keys(raw).length === 0) return null;
      const stance = stanceBadge(raw.stance);
      const plan = Array.isArray(raw.plan) ? raw.plan.filter((item) => typeof item === 'string' && item.trim().length > 0).slice(0, 8) : [];
      const watch = Array.isArray(raw.watch)
        ? raw.watch.map((symbol) => (typeof symbol === 'string' ? symbol : symbol?.symbol)).filter((symbol) => typeof symbol === 'string' && symbol.length > 0).slice(0, 12)
        : [];
      return {
        available: true,
        at: raw.at ?? null,
        atMs: toNumber(raw.atMs),
        stance: stance.stance,
        stanceBadge: stance,
        sizeMultiplier: toNumber(raw.sizeMultiplier),
        riskMultiplier: toNumber(raw.riskMultiplier),
        exitPressure: typeof raw.exitPressure === 'string' ? raw.exitPressure : null,
        confidence: toNumber(raw.confidence),
        thesis: typeof raw.thesis === 'string' ? raw.thesis : null,
        plan,
        watch,
        reviewSec: toNumber(raw.reviewSec),
        stale: raw.stale === true,
        reviewCount: toNumber(raw.reviewCount),
        nextReviewAt: raw.nextReviewAt ?? null,
        instrument: instrumentPolicyMapping(raw.instrument),
      };
    }

    /** Engine-level bot-agent bridge status line (`status.engine.agents`). */
    function botAgentEngineStatus(engineAgents) {
      const raw = plainObject(engineAgents);
      if (Object.keys(raw).length === 0) {
        return { available: false, enabled: null, configured: null, provider: null, model: null, intervalDaySec: null, intervalSwingSec: null, lastReviewAt: null, nextDueAt: null, runs: null, errors: null, note: null, dayLabel: '—', swingLabel: '—' };
      }
      const intervalDaySec = toNumber(raw.intervalDaySec);
      const intervalSwingSec = toNumber(raw.intervalSwingSec);
      return {
        available: true,
        enabled: raw.enabled === true ? true : raw.enabled === false ? false : null,
        configured: raw.configured === true ? true : raw.configured === false ? false : null,
        provider: raw.provider ?? null,
        model: raw.model ?? null,
        intervalDaySec,
        intervalSwingSec,
        dayLabel: estimatedIntervalLabel(intervalDaySec),
        swingLabel: estimatedIntervalLabel(intervalSwingSec),
        lastReviewAt: raw.lastReviewAt ?? null,
        nextDueAt: raw.nextDueAt ?? null,
        runs: toNumber(raw.runs),
        errors: toNumber(raw.errors),
        note: typeof raw.note === 'string' ? raw.note : null,
      };
    }

    /**
     * Category tabs for the agent table: All / Swing · mid-long / Day · intraday with counts.
     * Prefers `status.strategyMix`; falls back to counting the mapped agent rows.
     */
    function categoryTabs(status, agents) {
      const list = Array.isArray(agents) ? agents : [];
      const mix = plainObject(status?.strategyMix);
      const derive = (category) => list.filter((agent) => {
        const strategy = agent?.strategy && typeof agent.strategy === 'object' ? agent.strategy : agentStrategyMapping(agent);
        return strategy.category === category;
      }).length;
      const swingCount = toNumber(mix.swing?.count) ?? derive('swing');
      const dayCount = toNumber(mix.day?.count) ?? derive('day');
      const total = toNumber(mix.total) ?? list.length;
      return [
        { key: 'all', labelKey: 'categoryAll', label: 'All', count: total },
        { key: 'swing', labelKey: 'categorySwing', label: STRATEGY_CATEGORY_LABELS.swing, count: swingCount },
        { key: 'day', labelKey: 'categoryDay', label: STRATEGY_CATEGORY_LABELS.day, count: dayCount },
      ];
    }

    /** Filter agent rows by strategy category ('all' | 'swing' | 'day'). */
    function filterRowsByCategory(rows, category) {
      const list = Array.isArray(rows) ? rows : [];
      if (category !== 'swing' && category !== 'day') return list;
      return list.filter((row) => row?.strategy?.category === category);
    }

    // -----------------------------------------------------------------------
    // multi-instrument mapping (v3.0: margin / short selling / options)
    // -----------------------------------------------------------------------

    /** Human labels for the v1 option structures (unknown keys are rendered raw). */
    const INSTRUMENT_STRUCTURE_LABELS = Object.freeze({
      long_stock: 'Long stock',
      short_stock: 'Short stock',
      long_call: 'Long call',
      long_put: 'Long put',
      covered_call: 'Covered call',
      call_credit_spread: 'Call credit spread',
      put_credit_spread: 'Put credit spread',
      bull_call_spread: 'Bull call spread',
      bear_put_spread: 'Bear put spread',
      hold: 'Hold',
      auto: 'Auto',
    });

    function instrumentStructureLabel(key) {
      const text = String(key ?? '');
      if (text === '') return '—';
      return INSTRUMENT_STRUCTURE_LABELS[text] ?? text;
    }

    /** Normalize a structure field (string | string[] | {key}[] | {structure:true}) to [{key,label}]. */
    function structureList(value) {
      const out = [];
      const push = (item) => {
        if (item === null || item === undefined || item === '') return;
        const key = typeof item === 'string'
          ? item
          : typeof item?.key === 'string'
            ? item.key
            : typeof item?.structure === 'string'
              ? item.structure
              : typeof item?.name === 'string'
                ? item.name
                : null;
        if (!key || out.some((entry) => entry.key === key)) return;
        out.push({ key, label: instrumentStructureLabel(key) });
      };
      if (Array.isArray(value)) value.forEach(push);
      else if (typeof value === 'string') push(value);
      else if (value && typeof value === 'object') {
        for (const [key, flag] of Object.entries(value)) if (flag === true) push(key);
        if (Array.isArray(value.structures)) value.structures.forEach(push);
        push(value.structure);
      }
      return out;
    }

    /** Per-agent instrument permissions (`instrumentPermissions` or `instruments`). */
    function instrumentPermissionsMapping(permissions) {
      const raw = plainObject(permissions);
      if (Object.keys(raw).length === 0) {
        return {
          available: false,
          longStock: null,
          shortStock: null,
          longOptions: null,
          shortOptions: null,
          coveredCalls: null,
          spreads: null,
          margin: null,
          allowedStructures: [],
          badges: [],
          tooltip: '',
        };
      }
      const structures = structureList(raw.allowedStructures);
      const flag = (name) => (raw[name] === true ? true : raw[name] === false ? false : null);
      const flags = {
        longStock: flag('longStock'),
        shortStock: flag('shortStock'),
        longOptions: flag('longOptions'),
        shortOptions: flag('shortOptions'),
        coveredCalls: flag('coveredCalls'),
        spreads: flag('spreads'),
        margin: flag('margin'),
      };
      if (structures.length > 0) {
        const has = (pattern) => structures.some((structure) => pattern.test(structure.key));
        const derived = {
          longStock: has(/long_stock/),
          shortStock: has(/short_stock/),
          longOptions: has(/long_call|long_put/),
          shortOptions: has(/covered_call|credit_spread/),
          coveredCalls: has(/covered_call/),
          spreads: has(/spread/),
          margin: flags.margin,
        };
        for (const key of Object.keys(flags)) {
          if (flags[key] === null && derived[key] !== null) flags[key] = derived[key];
        }
      }
      const badges = [];
      if (flags.longStock !== false) badges.push({ key: 'stock', labelKey: 'badgeStock', label: 'Stk' });
      if (flags.shortStock === true) badges.push({ key: 'short', labelKey: 'badgeShort', label: 'Short' });
      if (flags.longOptions === true || flags.coveredCalls === true || flags.spreads === true) {
        badges.push({ key: 'options', labelKey: 'badgeOptions', label: 'Opt' });
      }
      if (flags.spreads === true) badges.push({ key: 'spreads', labelKey: 'badgeSpreads', label: 'Spreads' });
      if (flags.margin === true) badges.push({ key: 'margin', labelKey: 'badgeMargin', label: 'Margin' });
      return {
        available: true,
        ...flags,
        allowedStructures: structures,
        badges,
        tooltip: structures.map((structure) => structure.label).join(' · '),
      };
    }

    /** Compact instruments badge projection for the agent table (accepts permissions or an agent). */
    function instrumentBadges(source) {
      const candidate = plainObject(source);
      const looksLikeAgent = Boolean(
        candidate.id !== undefined
        || candidate.name !== undefined
        || candidate.genome !== undefined
        || candidate.strategy !== undefined
        || candidate.status !== undefined,
      );
      const permissionsSource = Object.keys(plainObject(candidate.instrumentPermissions)).length > 0
        ? candidate.instrumentPermissions
        : Object.keys(plainObject(candidate.instruments)).length > 0
          ? candidate.instruments
          : looksLikeAgent
            ? {}
            : candidate;
      const permissions = effectiveInstrumentBadges(permissionsSource);
      const playbook = playbookMapping(candidate.playbook);
      const playbookHint = playbook.available
        ? structureList(playbook.bullish).map((structure) => `↑ ${structure.label}`).join(', ')
        : null;
      return {
        available: permissions.available,
        badges: permissions.badges,
        tooltip: permissions.tooltip,
        disabled: permissions.disabled,
        allowedStructures: permissions.permissions?.allowedStructures ?? [],
        permissions: permissions.permissions,
        playbookHint,
      };
    }

    /** Underlying ticker parsed from an OCC option symbol (or null). */
    function occUnderlying(symbol) {
      const match = /^([A-Z]{1,6})\d{6}[CP]\d{8}$/.exec(String(symbol ?? ''));
      return match ? match[1] : null;
    }

    /** Normalize position rows: long/short stock and CALL/PUT options with DTE + group tags. */
    function positionRows(positions) {
      const list = Array.isArray(positions) ? positions : [];
      return list.filter((position) => position && typeof position === 'object').map((position, index) => {
        const option = plainObject(position.option);
        const assetClass = typeof position.assetClass === 'string'
          ? position.assetClass
          : Object.keys(option).length > 0
            ? 'us_option'
            : 'us_equity';
        const isOption = assetClass === 'us_option';
        const qtySigned = toNumber(position.qtySigned) ?? toNumber(position.qty) ?? toNumber(position.qtyText);
        const avgPrice = toNumber(position.avgPriceUsd) ?? toNumber(position.avgEntryPriceUsd);
        const lastPrice = toNumber(position.lastPriceUsd) ?? toNumber(position.markPriceUsd);
        const multiplier = toNumber(position.multiplier) ?? toNumber(option.multiplier) ?? (isOption ? 100 : 1);
        const sideRaw = String(position.side ?? '').toUpperCase();
        let side;
        if (isOption) {
          const type = String(option.type ?? sideRaw).toUpperCase();
          side = type === 'CALL' || type === 'PUT' ? type : (qtySigned !== null && qtySigned < 0 ? 'SHORT' : 'LONG');
        } else {
          side = sideRaw === 'SHORT' || (qtySigned !== null && qtySigned < 0) ? 'SHORT' : 'LONG';
        }
        const contracts = isOption && qtySigned !== null ? Math.abs(qtySigned) : null;
        const marketValue = toNumber(position.marketValueUsd)
          ?? (qtySigned !== null && lastPrice !== null ? round2(qtySigned * lastPrice * multiplier) : null);
        const unrealized = toNumber(position.unrealizedPlUsd)
          ?? (qtySigned !== null && avgPrice !== null && lastPrice !== null ? round2((lastPrice - avgPrice) * qtySigned * multiplier) : null);
        const expiration = option.expiration ?? position.expiration ?? null;
        const dte = toNumber(option.dte) ?? toNumber(position.dte);
        const strikeUsd = toNumber(option.strikeUsd) ?? toNumber(position.strikeUsd);
        const groupId = position.groupId ?? option.groupId ?? null;
        const underlying = option.underlying ?? position.underlying ?? (isOption ? occUnderlying(position.symbol) : null);
        return {
          key: `${position.symbol ?? 'position'}-${index}`,
          symbol: position.symbol ?? '—',
          assetClass,
          isOption,
          isStock: !isOption,
          isShort: side === 'SHORT' || ((side === 'CALL' || side === 'PUT') && qtySigned !== null && qtySigned < 0),
          side,
          typeLabel: isOption ? side : side === 'SHORT' ? 'SHORT' : 'LONG',
          qtySigned,
          qtyText: isOption ? `${fmtNum(contracts ?? 0)} ct` : fmtQty(qtySigned),
          contracts,
          avgPriceUsd: avgPrice,
          lastPriceUsd: lastPrice,
          marketValueUsd: marketValue,
          unrealizedPlUsd: unrealized,
          multiplier,
          openedAt: position.openedAt ?? null,
          option: isOption
            ? {
              underlying,
              strikeUsd,
              expiration,
              dte,
              type: side === 'CALL' || side === 'PUT' ? side : (option.type ?? null),
              expiryLabel: typeof expiration === 'string' ? expiration.slice(0, 10) : null,
              dteLabel: dte === null ? null : `${dte}d`,
              multiplier,
            }
            : null,
          groupId,
          groupShort: groupId ? shortId(groupId) : null,
          structure: position.structure ?? option.structure ?? null,
        };
      });
    }

    /** Aggregate a set of normalized position rows (counts + exposure). */
    function positionSummary(rows, agent) {
      const list = Array.isArray(rows) ? rows : [];
      const safeAgent = plainObject(agent);
      const groups = new Set();
      const summary = {
        count: list.length,
        stock: { long: 0, short: 0 },
        options: { calls: 0, puts: 0, long: 0, short: 0 },
        spreadGroups: 0,
        grossExposureUsd: 0,
        netExposureUsd: 0,
        marginDebtUsd: toNumber(safeAgent.marginDebtUsd),
        hasExposure: false,
      };
      for (const row of list) {
        if (row.isOption) {
          if (row.side === 'CALL') summary.options.calls += 1;
          if (row.side === 'PUT') summary.options.puts += 1;
          if (row.isShort) summary.options.short += 1;
          else summary.options.long += 1;
        } else if (row.isShort) summary.stock.short += 1;
        else summary.stock.long += 1;
        if (row.groupId) groups.add(String(row.groupId));
        if (row.marketValueUsd !== null) {
          summary.hasExposure = true;
          summary.grossExposureUsd += Math.abs(row.marketValueUsd);
          summary.netExposureUsd += row.marketValueUsd;
        }
      }
      summary.spreadGroups = groups.size;
      summary.grossExposureUsd = toNumber(safeAgent.grossExposureUsd) ?? round2(summary.grossExposureUsd);
      summary.netExposureUsd = toNumber(safeAgent.netExposureUsd) ?? round2(summary.netExposureUsd);
      return summary;
    }

    /** Family strategy instrument playbook (`agent.playbook` / status.instruments.playbooks). */
    function playbookMapping(playbook) {
      const raw = plainObject(playbook);
      const bullish = structureList(raw.bullish);
      const bearish = structureList(raw.bearish);
      const neutral = structureList(raw.neutral);
      const structures = structureList(raw.structures);
      const family = typeof raw.family === 'string' ? raw.family : (structures.length > 0 ? null : null);
      const hasContent = bullish.length + bearish.length + neutral.length + structures.length > 0;
      return {
        available: Object.keys(raw).length > 0 && hasContent,
        family,
        familyLabel: family ? familyLabel(family) : null,
        bullish,
        bearish,
        neutral,
        structures,
        tier: typeof raw.tier === 'string' ? raw.tier : null,
        hasContent,
      };
    }

    /** Bot-agent policy instrument plan (`policy.instrument`). */
    function instrumentPolicyMapping(instrument) {
      const raw = plainObject(instrument);
      if (Object.keys(raw).length === 0) return null;
      const prefer = typeof raw.prefer === 'string' ? raw.prefer : null;
      const maxPremiumUsd = toNumber(raw.maxPremiumUsd);
      const maxContracts = toNumber(raw.maxContracts);
      const dteMin = toNumber(raw.dteMin);
      const dteMax = toNumber(raw.dteMax);
      return {
        available: true,
        prefer,
        preferLabel: prefer ? instrumentStructureLabel(prefer) : null,
        maxPremiumUsd,
        maxContracts,
        dteMin,
        dteMax,
        hasCaps: maxPremiumUsd !== null || maxContracts !== null || dteMin !== null || dteMax !== null,
        auto: prefer === null || prefer === 'auto',
      };
    }

    /** Engine-header instruments projection (`status.instruments` + account exposure fields). */
    function instrumentsHeader(instruments, account) {
      const raw = plainObject(instruments);
      const nestedAccount = plainObject(raw.account);
      const accountRaw = { ...nestedAccount, ...plainObject(account) };
      const accountFields = {
        buyingPowerUsd: toNumber(accountRaw.buyingPowerUsd),
        optionsBuyingPowerUsd: toNumber(accountRaw.optionsBuyingPowerUsd),
        marginMultiplier: toNumber(accountRaw.marginMultiplier),
        shortingEnabled: accountRaw.shortingEnabled === true ? true : accountRaw.shortingEnabled === false ? false : null,
        optionsTradingLevel: toNumber(accountRaw.optionsTradingLevel),
        marginDebtUsd: toNumber(accountRaw.marginDebtUsd),
        grossExposureUsd: toNumber(accountRaw.grossExposureUsd),
        netExposureUsd: toNumber(accountRaw.netExposureUsd),
      };
      const hasAccount = Object.values(accountFields).some((value) => value !== null);
      if (Object.keys(raw).length === 0 && !hasAccount) {
        return {
          available: false,
          enabled: null,
          allowMargin: null,
          allowShort: null,
          allowOptions: null,
          allowCoveredCalls: null,
          allowSpreads: null,
          caps: { maxOptionPremiumPctEquity: null, maxShortPctEquity: null, maxMarginPctEquity: null, maxContracts: null, minDTE: null, maxDTE: null, autoCloseDTE: null },
          optionDataFeed: null,
          account: accountFields,
          hasAccount: false,
          effective: { available: false, longStock: null, shortStock: null, margin: null, creditOptions: null, structures: [] },
          playbookCount: 0,
          playbooks: {},
        };
      }
      const booleanOrNull = (value) => (value === true ? true : value === false ? false : null);
      const playbooks = plainObject(raw.playbooks);
      const effectiveRaw = plainObject(raw.effective);
      return {
        available: true,
        enabled: booleanOrNull(raw.enabled),
        allowMargin: booleanOrNull(raw.allowMargin),
        allowShort: booleanOrNull(raw.allowShort),
        allowOptions: booleanOrNull(raw.allowOptions),
        allowCoveredCalls: booleanOrNull(raw.allowCoveredCalls),
        allowSpreads: booleanOrNull(raw.allowSpreads),
        caps: {
          maxOptionPremiumPctEquity: toNumber(raw.maxOptionPremiumPctEquity),
          maxShortPctEquity: toNumber(raw.maxShortPctEquity),
          maxMarginPctEquity: toNumber(raw.maxMarginPctEquity),
          maxContracts: toNumber(raw.maxContracts),
          minDTE: toNumber(raw.minDTE),
          maxDTE: toNumber(raw.maxDTE),
          autoCloseDTE: toNumber(raw.autoCloseDTE),
        },
        optionDataFeed: typeof raw.optionDataFeed === 'string' ? raw.optionDataFeed : null,
        account: accountFields,
        hasAccount,
        effective: {
          available: Object.keys(effectiveRaw).length > 0,
          longStock: booleanOrNull(effectiveRaw.longStock),
          shortStock: booleanOrNull(effectiveRaw.shortStock),
          margin: booleanOrNull(effectiveRaw.margin),
          creditOptions: booleanOrNull(effectiveRaw.creditOptions),
          structures: structureList(effectiveRaw.structures),
        },
        playbookCount: Object.keys(playbooks).length,
        playbooks,
      };
    }

    /**
     * "Last cycle" diagnostics projection (`status.engine.lastCycle`): market state,
     * executions/orders/errors and the top-3 skip reasons that explain why bots did not trade.
     * @param {object|null} lastCycle engine.lastCycle
     */
    function lastCycleMapping(lastCycle) {
      const raw = plainObject(lastCycle);
      const empty = {
        available: false,
        at: null,
        marketOpen: null,
        tradingSkipped: null,
        executions: null,
        orders: null,
        denied: null,
        errors: null,
        topSkipReasons: [],
        topSkipText: '',
        botReviews: null,
        research: null,
        hasActivity: false,
        marketStateKey: 'lastCycleEmpty',
      };
      if (Object.keys(raw).length === 0) return empty;
      const reasons = [];
      const reasonsRaw = raw.topSkipReasons;
      if (Array.isArray(reasonsRaw)) {
        for (const item of reasonsRaw) {
          const reason = typeof item === 'string'
            ? item
            : typeof item?.reason === 'string'
              ? item.reason
              : typeof item?.key === 'string'
                ? item.key
                : null;
          if (!reason) continue;
          reasons.push({ reason, count: toNumber(item?.count) ?? 0 });
        }
      } else {
        for (const [reason, count] of Object.entries(plainObject(reasonsRaw))) {
          reasons.push({ reason, count: toNumber(count) ?? 0 });
        }
      }
      const topSkipReasons = reasons
        .filter((entry) => entry.count > 0)
        .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason))
        .slice(0, 3);
      const booleanOrNull = (value) => (value === true ? true : value === false ? false : null);
      const botRaw = plainObject(raw.botReviews);
      const botReviews = Object.keys(botRaw).length === 0
        ? null
        : {
          available: true,
          enabled: booleanOrNull(botRaw.enabled),
          configured: booleanOrNull(botRaw.configured),
          due: toNumber(botRaw.due),
          reviewed: toNumber(botRaw.reviewed),
          deferred: toNumber(botRaw.deferred),
          skipped: toNumber(botRaw.skipped),
          errors: toNumber(botRaw.errors),
          budgetUsd: toNumber(botRaw.budgetUsd),
          note: typeof botRaw.note === 'string' ? botRaw.note : null,
          paused: botRaw.paused === true,
        };
      const executions = toNumber(raw.executions);
      const orders = toNumber(raw.orders);
      return {
        available: true,
        at: raw.at ?? null,
        marketOpen: booleanOrNull(raw.marketOpen),
        tradingSkipped: booleanOrNull(raw.tradingSkipped),
        executions,
        orders,
        denied: toNumber(raw.denied),
        errors: toNumber(raw.errors),
        topSkipReasons,
        topSkipText: topSkipReasons.map((entry) => `${entry.reason} ${entry.count}`).join(' · '),
        botReviews,
        research: plainObject(raw.research).available === undefined ? (raw.research ?? null) : raw.research,
        hasActivity: (executions ?? 0) > 0 || (orders ?? 0) > 0,
        marketStateKey: raw.marketOpen === true ? 'marketOpen' : raw.marketOpen === false ? 'marketClosed' : 'marketUnknown',
      };
    }

    /**
     * Broker capability warning from `engine.instruments.effective`: the paper account can
     * restrict shorting/margin (below the $2k margin minimum) while long stock/options work.
     * Accepts the raw instruments object or an `instrumentsHeader()` projection.
     */
    function instrumentsCapabilityWarning(instruments) {
      const raw = plainObject(instruments);
      const effective = plainObject(raw.effective);
      const account = plainObject(raw.account);
      const booleanOrNull = (value) => (value === true ? true : value === false ? false : null);
      if (Object.keys(effective).length === 0) {
        return {
          show: false,
          restricted: false,
          shortStockDisabled: false,
          marginDisabled: false,
          creditOptionsDisabled: false,
          disabled: [],
          longStockAvailable: null,
          optionsAvailable: null,
          account: { shortingEnabled: null, marginMultiplier: null, optionsTradingLevel: null },
          unknown: true,
        };
      }
      const shortStockDisabled = effective.shortStock === false;
      const marginDisabled = effective.margin === false;
      const creditOptionsDisabled = effective.creditOptions === false;
      const disabled = [];
      if (shortStockDisabled) disabled.push('shortStock');
      if (marginDisabled) disabled.push('margin');
      if (creditOptionsDisabled) disabled.push('creditOptions');
      return {
        show: disabled.length > 0,
        restricted: disabled.length > 0,
        shortStockDisabled,
        marginDisabled,
        creditOptionsDisabled,
        disabled,
        longStockAvailable: effective.longStock !== false,
        optionsAvailable: creditOptionsDisabled !== true,
        account: {
          shortingEnabled: booleanOrNull(account.shortingEnabled),
          marginMultiplier: toNumber(account.marginMultiplier),
          optionsTradingLevel: toNumber(account.optionsTradingLevel),
        },
        unknown: false,
      };
    }

    /**
     * Instruments badges honoring per-agent permissions: disabled short/margin capabilities
     * omit their badge and are spelled out in the tooltip ("disabled by broker account").
     */
    function effectiveInstrumentBadges(permissions) {
      const mapped = instrumentPermissionsMapping(permissions);
      if (mapped.available !== true) {
        return { available: false, badges: [], disabled: [], tooltip: '', permissions: mapped };
      }
      const disabled = [];
      if (mapped.shortStock === false) disabled.push({ key: 'short', labelKey: 'badgeShort', label: 'Short' });
      if (mapped.margin === false) disabled.push({ key: 'margin', labelKey: 'badgeMargin', label: 'Margin' });
      const disabledText = disabled.length > 0
        ? `${disabled.map((entry) => entry.label).join('/')} disabled by broker account`
        : '';
      return {
        available: true,
        badges: mapped.badges,
        disabled,
        tooltip: [mapped.tooltip, disabledText].filter((part) => part.length > 0).join(' · '),
        permissions: mapped,
      };
    }


    /**
     * Turn one status payload into table/detail rows. Pure: no DOM, no fetch, no mutation
     * of `status`, safe with missing fields and with 0-100 agents.
     * @param {object} status the GET /automaton/state payload
     * @returns {Array<object>} one flat row per agent
     */
    function buildAgentRows(status) {
      const agents = Array.isArray(status?.agents) ? status.agents : [];
      /** Population-level endowment fallback: agent rows may omit their own endowment. */
      const populationEndowment = toNumber(status?.limits?.endowmentUsd) ?? toNumber(status?.config?.endowmentUsd);
      const nameById = new Map();
      for (const agent of agents) {
        if (agent && agent.id !== undefined) nameById.set(String(agent.id), agentDisplayName(agent));
      }
      return agents.map((agent, index) => {
        const safeAgent = plainObject(agent);
        const id = String(safeAgent.id ?? '');
        const genome = plainObject(safeAgent.genome);
        const spec = plainObject(safeAgent.spec);
        const rawStatus = String(safeAgent.status ?? (safeAgent.cause ? 'dead' : 'alive')).toLowerCase();
        const agentStatus = rawStatus === 'dead' || rawStatus === 'condemned' ? rawStatus : 'alive';
        const endowment = toNumber(safeAgent.endowmentUsd) ?? populationEndowment;
        const equity = toNumber(safeAgent.equityUsd);
        const pnlUsd = equity !== null && endowment !== null
          ? round2(equity - endowment)
          : toNumber(safeAgent.netPlUsd);
        const pnlPct = pnlUsd !== null && endowment !== null && endowment > 0 ? (pnlUsd / endowment) * 100 : null;
        const positions = buildHoldingsRows(safeAgent.positions);
        const instrumentPositions = positionRows(safeAgent.positions);
        const exposure = positionSummary(instrumentPositions, safeAgent);
        const instrumentPermissions = instrumentPermissionsMapping(safeAgent.instrumentPermissions ?? safeAgent.instruments);
        const instrumentBadgeInfo = instrumentBadges(safeAgent);
        const playbook = playbookMapping(safeAgent.playbook);
        const instrumentPolicy = instrumentPolicyMapping(plainObject(safeAgent.policy).instrument);
        const activity = buildActivityRows(safeAgent.recentTrades);
        const roleCosts = roleCostRows(safeAgent.roleCosts);
        const roleCostsTotal = round2(roleCosts.reduce((total, entry) => total + entry.amountUsd, 0));
        const research = mapResearchBriefing(safeAgent.research);
        const transactions = agentTransactionRows(safeAgent.orders);
        const plan = agentPlanMapping(safeAgent.plan);
        const pnl = agentPnlMapping(safeAgent.pnl);
        const rankBadges = agentRankingBadges(safeAgent.rankings);
        const strategy = agentStrategyMapping(safeAgent);
        const policy = botAgentPolicyMapping(safeAgent.policy);
        const parentId = safeAgent.parentId ? String(safeAgent.parentId) : null;
        const mutation = plainObject(safeAgent.mutation);
        const hasMutation = Object.keys(mutation).length > 0;
        const genomeText = strategyLabel(genome);
        const specText = strategyLabel(spec);
        const bornAt = safeAgent.bornAt ?? null;
        const diedAt = safeAgent.diedAt ?? null;
        return {
          index: index + 1,
          id,
          shortId: shortId(id),
          name: agentDisplayName(safeAgent),
          generation: toNumber(safeAgent.generation),
          parentId,
          parentName: parentId ? (nameById.get(parentId) ?? shortId(parentId)) : null,
          status: agentStatus,
          cause: safeAgent.cause ?? null,
          note: safeAgent.note ?? null,
          bornAt,
          diedAt,
          lifespanHours: lifespanHours(bornAt, diedAt),
          firstProfitAt: safeAgent.firstProfitAt ?? null,
          genome,
          genomeText: genomeText.length > 0 ? genomeText : '—',
          genomeParamsText: strategyParamsText(genome),
          spec: Object.keys(spec).length > 0 ? spec : null,
          specId: safeAgent.specId ?? spec.specId ?? null,
          specText: specText.length > 0 ? specText : null,
          specParamsText: Object.keys(plainObject(spec.params)).length > 0 ? strategyParamsText(spec.params) : '—',
          specCreatedAt: spec.createdAt ?? null,
          tradingDiffers: Boolean(specText.length > 0 && genomeText.length > 0 && specText !== genomeText),
          mutation: hasMutation ? mutation : null,
          mutationText: hasMutation
            ? `${mutation.field ?? '?'}: ${String(mutation.from ?? '?')} → ${String(mutation.to ?? '?')}`
            : null,
          equityUsd: equity,
          cashUsd: toNumber(safeAgent.cashUsd),
          positionsValueUsd: toNumber(safeAgent.positionsValueUsd),
          endowmentUsd: endowment,
          pnlUsd,
          pnlPct,
          realizedPlUsd: toNumber(safeAgent.realizedPlUsd),
          unrealizedPlUsd: toNumber(safeAgent.unrealizedPlUsd),
          dayPnlPct: toNumber(safeAgent.dayPnlPct),
          net7dUsd: toNumber(safeAgent.net7dUsd),
          drawdownPct: toNumber(safeAgent.drawdownPct),
          runwayHours: toNumber(safeAgent.runwayHours),
          treasuryState: safeAgent.treasuryState ?? null,
          positions,
          positionRows: instrumentPositions,
          positionCount: positions.length,
          positionSummary: exposure,
          grossExposureUsd: exposure.grossExposureUsd,
          netExposureUsd: exposure.netExposureUsd,
          marginDebtUsd: exposure.marginDebtUsd,
          instrumentPermissions,
          instrumentBadges: instrumentBadgeInfo.badges,
          instrumentTooltip: instrumentBadgeInfo.tooltip || instrumentBadgeInfo.playbookHint || '',
          playbook,
          instrumentPolicy,
          activity,
          tradesCount: toNumber(safeAgent.tradesCount) ?? activity.length,
          research,
          researchBadge: researchBadge(research),
          transactions,
          transactionCount: transactions.length,
          pnl,
          plan,
          rankBadges,
          strategy,
          strategyTypeLabel: strategy.typeLabel,
          category: strategy.category,
          categoryLabel: strategy.categoryLabel,
          categoryShortLabel: strategy.categoryShortLabel,
          intervalLabel: strategy.estimatedIntervalLabel,
          policy,
          roleCosts,
          roleCostsTotal,
        };
      });
    }

    /** Look up a built row by agent id (detail selection survives polling). */
    function findAgentRow(rows, id) {
      if (!id) return null;
      return rows.find((row) => row.id === id) ?? null;
    }

    /** Header/statistics projection of one status payload. */
    function summarize(status) {
      const account = status?.account ?? null;
      const treasury = status?.treasury ?? null;
      const population = status?.population ?? null;
      const engine = status?.engine ?? {};
      const limits = status?.limits ?? {};
      const agents = Array.isArray(status?.agents) ? status.agents : [];
      const count = (wanted) => agents.filter((agent) => {
        const raw = String(agent?.status ?? (agent?.cause ? 'dead' : 'alive')).toLowerCase();
        return raw === wanted;
      }).length;
      return {
        mode: modeOf(status),
        running: Boolean(engine.running),
        killSwitch: Boolean(engine.killSwitch ?? status?.brakes?.killSwitch),
        halted: Boolean(status?.halted),
        haltReasons: Array.isArray(status?.haltReasons) ? status.haltReasons : [],
        equityUsd: toNumber(account?.equityUsd),
        cashUsd: toNumber(account?.cashUsd),
        buyingPowerUsd: toNumber(account?.buyingPowerUsd),
        accountStatus: account?.status ?? null,
        population: {
          total: toNumber(population?.total) ?? agents.length,
          alive: toNumber(population?.alive) ?? count('alive'),
          dead: toNumber(population?.dead) ?? count('dead'),
          condemned: toNumber(population?.condemned) ?? count('condemned'),
          cap: toNumber(population?.cap) ?? toNumber(limits.populationCap),
        },
        treasury: {
          state: treasury?.state ?? null,
          runwayHours: toNumber(treasury?.runwayHours),
          burnPerHourUsd: toNumber(treasury?.burnPerHourUsd),
          allocatedUsd: toNumber(treasury?.allocatedUsd),
          poolUsd: toNumber(treasury?.poolUsd),
          surplus7dUsd: toNumber(treasury?.surplus7dUsd),
          mayReplicate: treasury?.mayReplicate === true,
          reconciliation: treasury?.reconciliation ?? null,
        },
        allocationCapUsd: toNumber(limits.allocationCapUsd),
        allocationCapPct: toNumber(limits.allocationCapPct),
        endowmentUsd: toNumber(limits.endowmentUsd),
        deathFloorUsd: toNumber(limits.deathFloorUsd),
        cycleIntervalSec: toNumber(limits.cycleIntervalSec) ?? toNumber(status?.config?.cycleIntervalSec),
        lastTickAt: engine.lastTickAt ?? null,
        lastError: engine.lastError ?? null,
        ticks: toNumber(engine.ticks),
        reaper: engine.reaper ?? null,
        brakesCount: toNumber(status?.brakes?.count) ?? 18,
        obituaryStats: status?.obituaries?.stats ?? null,
        at: status?.at ?? null,
        research: researchStatusSummary(status),
        rewards: engine.rewards ?? null,
        rankings: status?.rankings ?? null,
        strategyMix: status?.strategyMix ?? null,
        engineAgents: botAgentEngineStatus(engine.agents ?? status?.engine?.agents),
        lastCycle: lastCycleMapping(engine.lastCycle),
        instruments: instrumentsHeader(
          engine.instruments ?? status?.instruments ?? null,
          status?.account ?? engine.instruments?.account ?? status?.instruments?.account ?? null,
        ),
        brokerCapability: instrumentsCapabilityWarning(engine.instruments ?? status?.instruments ?? null),
        control: status?.control ?? null,
      };
    }

    /** Generation rollup sorted by generation number (from byGeneration or the rows). */
    function generationRows(status) {
      const byGeneration = status?.population?.byGeneration;
      if (byGeneration && typeof byGeneration === 'object' && !Array.isArray(byGeneration)) {
        return Object.entries(byGeneration)
          .map(([key, value]) => {
            const stats = value && typeof value === 'object' ? value : {};
            return {
              generation: toNumber(key) ?? 0,
              born: toNumber(stats.born) ?? 0,
              alive: toNumber(stats.alive) ?? 0,
              dead: toNumber(stats.dead) ?? 0,
              survivalRate: toNumber(stats.survivalRate),
              medianLifespanHours: toNumber(stats.medianLifespanHours),
            };
          })
          .sort((a, b) => a.generation - b.generation);
      }
      const groups = new Map();
      for (const agent of Array.isArray(status?.agents) ? status.agents : []) {
        const generation = toNumber(agent?.generation) ?? 0;
        if (!groups.has(generation)) groups.set(generation, { generation, born: 0, alive: 0, dead: 0 });
        const group = groups.get(generation);
        group.born += 1;
        const raw = String(agent?.status ?? 'alive').toLowerCase();
        if (raw === 'dead' || raw === 'condemned') group.dead += 1;
        else group.alive += 1;
      }
      return [...groups.values()].sort((a, b) => a.generation - b.generation);
    }

    /** Obituary feed rows (newest-first as the journal returns them), name-first. */
    function obituaryRows(status) {
      const recent = Array.isArray(status?.obituaries?.recent) ? status.obituaries.recent : [];
      return recent.slice(0, MAX_OBITUARIES).map((item, index) => ({
        key: `${item?.agentId ?? item?.id ?? 'obit'}-${index}`,
        agentId: item?.agentId ?? item?.id ?? null,
        name: (typeof item?.name === 'string' && item.name.trim().length > 0)
          ? item.name.trim()
          : strategyLabel(item?.genome) || shortId(item?.agentId ?? item?.id),
        shortId: shortId(item?.agentId ?? item?.id),
        generation: toNumber(item?.generation),
        cause: item?.cause ?? null,
        lifespanHours: toNumber(item?.lifespanHours) ?? lifespanHours(item?.bornAt, item?.diedAt),
        netPlUsd: toNumber(item?.netPlUsd),
        firstProfitAt: item?.firstProfitAt ?? null,
        diedAt: item?.diedAt ?? null,
      }));
    }

    /** Stable client-side sort on one whitelisted key. Nulls sort last. */
    function sortAgentRows(rows, sortKey = 'equityUsd', direction = 'desc') {
      const key = SORTABLE_KEYS.has(sortKey) ? sortKey : 'equityUsd';
      const sign = direction === 'asc' ? 1 : -1;
      const valueOf = (row) => {
        if (key === 'name') return String(row.name ?? '');
        if (key === 'status') return String(row.status ?? '');
        if (key === 'generation') return row.generation;
        return row[key];
      };
      return [...rows].sort((a, b) => {
        const left = valueOf(a);
        const right = valueOf(b);
        const leftEmpty = left === null || left === undefined || left === '';
        const rightEmpty = right === null || right === undefined || right === '';
        if (leftEmpty && rightEmpty) return a.index - b.index;
        if (leftEmpty) return 1;
        if (rightEmpty) return -1;
        if (typeof left === 'string' || typeof right === 'string') {
          return String(left).localeCompare(String(right)) * sign;
        }
        return (Number(left) - Number(right)) * sign;
      });
    }

    /** Status filter + text search over the built rows (names and ids both searchable). */
    function filterAgentRows(rows, filter = 'all', query = '') {
      const wanted = STATUS_FILTERS.includes(filter) ? filter : 'all';
      const text = String(query ?? '').trim().toLowerCase();
      return rows.filter((row) => {
        if (wanted !== 'all' && row.status !== wanted) return false;
        if (text.length === 0) return true;
        const haystack = [
          row.name,
          row.id,
          row.shortId,
          row.parentId,
          row.parentName,
          row.genomeText,
          row.specText,
          row.genome?.symbol,
          row.genome?.family,
          row.spec?.symbol,
          row.spec?.family,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(text);
      });
    }

    // -----------------------------------------------------------------------
    // v3.2 live analytics mapping (market feed, KPIs, charts, agent table)
    // -----------------------------------------------------------------------

    /** up / down / flat from a signed number (null → flat). */
    function changeDirection(value) {
      const number = toNumber(value);
      if (number === null || number === 0) return 'flat';
      return number > 0 ? 'up' : 'down';
    }

    /** Market change percent text: accepts a fraction (≤0.2) or percent points. */
    function marketChangePctText(value) {
      const number = toNumber(value);
      if (number === null) return '—';
      const pct = Math.abs(number) <= 0.2 ? number * 100 : number;
      return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
    }

    /** Inline-SVG polyline path for a list of numeric closes ('' when empty). */
    function sparklinePath(values, { width = 96, height = 24, pad = 2 } = {}) {
      const series = (Array.isArray(values) ? values : []).map((value) => toNumber(value)).filter((value) => value !== null);
      if (series.length === 0) return '';
      const min = Math.min(...series);
      const max = Math.max(...series);
      const span = max - min || 1;
      const innerWidth = Math.max(1, width - pad * 2);
      const innerHeight = Math.max(1, height - pad * 2);
      const step = series.length > 1 ? innerWidth / (series.length - 1) : 0;
      return series
        .map((value, index) => {
          const x = Math.round((pad + index * step) * 10) / 10;
          const y = Math.round((height - pad - ((value - min) / span) * innerHeight) * 10) / 10;
          return `${index === 0 ? 'M' : 'L'}${x} ${y}`;
        })
        .join(' ');
    }

    /** Live market tape rows from a marketView payload (quotes map or array). */
    function marketTapeRows(market, { limit = null } = {}) {
      const raw = plainObject(market);
      const quotesRaw = raw.quotes;
      let list = [];
      if (Array.isArray(quotesRaw)) {
        list = quotesRaw;
      } else if (quotesRaw && typeof quotesRaw === 'object') {
        list = Object.entries(quotesRaw).map(([symbol, quote]) => ({ symbol, ...(quote && typeof quote === 'object' ? quote : {}) }));
      }
      const sparklines = plainObject(raw.sparklines);
      const sessionOpen = raw.marketOpen === true ? true : raw.marketOpen === false ? false : null;
      const rows = list.map((quote, index) => {
        const symbol = String(quote.symbol ?? quote.ticker ?? '').toUpperCase();
        const priceUsd = toNumber(quote.priceUsd ?? quote.price);
        const changeUsd = toNumber(quote.changeUsd);
        const changePct = toNumber(quote.changePct);
        const direction = changeDirection(changeUsd ?? changePct);
        const sparkline = (Array.isArray(sparklines[symbol]) ? sparklines[symbol] : Array.isArray(quote.sparkline) ? quote.sparkline : [])
          .map((value) => toNumber(value))
          .filter((value) => value !== null);
        return {
          key: `${symbol || 'symbol'}-${index}`,
          symbol: symbol || '—',
          priceUsd,
          priceText: fmtUsd(priceUsd),
          bidUsd: toNumber(quote.bidUsd ?? quote.bid),
          askUsd: toNumber(quote.askUsd ?? quote.ask),
          bidText: fmtUsd(toNumber(quote.bidUsd ?? quote.bid)),
          askText: fmtUsd(toNumber(quote.askUsd ?? quote.ask)),
          changeUsd,
          changePct,
          direction,
          changeUsdText: changeUsd === null ? '—' : `${changeUsd > 0 ? '+' : changeUsd < 0 ? '-' : ''}${fmtUsd(Math.abs(changeUsd))}`,
          changePctText: marketChangePctText(changePct),
          sparkline,
          sparklinePath: sparklinePath(sparkline),
          stale: quote.stale === true,
          closed: sessionOpen === false,
        };
      });
      return limit !== null ? rows.slice(0, limit) : rows;
    }

    /** Equity area-chart geometry from the portfolio equity history ring. */
    function equityChartPoints(history, { width = 640, height = 160, pad = 8 } = {}) {
      const series = (Array.isArray(history) ? history : [])
        .filter((point) => point && typeof point === 'object' && toNumber(point.equityUsd) !== null)
        .map((point) => ({
          at: point.at ?? null,
          equityUsd: toNumber(point.equityUsd),
          cashUsd: toNumber(point.cashUsd),
        }));
      if (series.length === 0) {
        return { points: [], path: '', area: '', min: null, max: null, first: null, last: null, deltaUsd: null, deltaPct: null, hasData: false };
      }
      const values = series.map((point) => point.equityUsd);
      const min = Math.min(...values);
      const max = Math.max(...values);
      const span = max - min || 1;
      const innerWidth = Math.max(1, width - pad * 2);
      const innerHeight = Math.max(1, height - pad * 2);
      const step = series.length > 1 ? innerWidth / (series.length - 1) : 0;
      const points = series.map((point, index) => ({
        ...point,
        x: Math.round((pad + index * step) * 10) / 10,
        y: Math.round((height - pad - ((point.equityUsd - min) / span) * innerHeight) * 10) / 10,
      }));
      const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`).join(' ');
      const last = points[points.length - 1];
      const first = points[0];
      const area = `${path} L${last.x} ${height - pad} L${first.x} ${height - pad} Z`;
      const deltaUsd = round2(last.equityUsd - first.equityUsd);
      return {
        points,
        path,
        area,
        min,
        max,
        first,
        last,
        deltaUsd,
        deltaPct: first.equityUsd > 0 ? (deltaUsd / first.equityUsd) * 100 : null,
        hasData: true,
      };
    }

    /** KPI cards for the analytics overview (state + optional live market view). */
    function kpiCards(stateStatus, marketView) {
      const status = plainObject(stateStatus);
      if (Object.keys(status).length === 0) return [];
      const summary = summarize(status);
      const market = plainObject(marketView);
      const portfolio = plainObject(market.portfolio);
      const liveEquity = toNumber(portfolio.equityUsd);
      const equity = liveEquity ?? summary.equityUsd;
      const dayPnlUsd = toNumber(portfolio.dayPnlUsd);
      const dayPnlPct = toNumber(portfolio.dayPnlPct);
      const cashUsd = toNumber(portfolio.cashUsd) ?? summary.cashUsd;
      const buyingPowerUsd = toNumber(portfolio.buyingPowerUsd) ?? summary.buyingPowerUsd;
      const grossExposureUsd = toNumber(portfolio.grossExposureUsd);
      const netExposureUsd = toNumber(portfolio.netExposureUsd);
      const population = summary.population ?? {};
      const lastCycle = summary.lastCycle ?? null;
      const agents = Array.isArray(status.agents) ? status.agents : [];
      const aliveAgents = agents.filter((agent) => String(agent?.status ?? 'alive').toLowerCase() === 'alive');
      const winners = aliveAgents.filter((agent) => {
        const pnl = toNumber(agent?.dayPnlPct) ?? toNumber(agent?.pnlPct);
        return pnl !== null && pnl > 0;
      }).length;
      const winRatePct = aliveAgents.length > 0 ? (winners / aliveAgents.length) * 100 : null;
      const tradesToday = toNumber(lastCycle?.orders) ?? agents.reduce((total, agent) => total + (toNumber(agent?.tradesCount) ?? 0), 0);
      const treasury = summary.treasury ?? {};
      return [
        {
          key: 'equity',
          labelKey: 'kpiEquity',
          value: fmtUsd(equity),
          deltaUsd: dayPnlUsd,
          deltaPct: dayPnlPct,
          direction: changeDirection(dayPnlUsd ?? dayPnlPct),
          detailKey: 'kpiEquityDetail',
          detail: summary.mode,
          live: liveEquity !== null,
        },
        {
          key: 'dayPnl',
          labelKey: 'kpiDayPnl',
          value: `${dayPnlUsd === null ? '—' : fmtSignedUsd(dayPnlUsd)}${dayPnlPct === null ? '' : ` (${fmtPct(dayPnlPct)})`}`,
          deltaPct: dayPnlPct,
          direction: changeDirection(dayPnlUsd ?? dayPnlPct),
        },
        {
          key: 'cashBp',
          labelKey: 'kpiCashBp',
          value: `${fmtUsd(cashUsd)} / ${fmtUsd(buyingPowerUsd)}`,
          direction: 'flat',
        },
        {
          key: 'exposure',
          labelKey: 'kpiExposure',
          value: fmtUsd(grossExposureUsd),
          detail: netExposureUsd === null ? null : fmtUsd(netExposureUsd),
          detailKey: 'kpiNetExposure',
          direction: 'flat',
        },
        {
          key: 'population',
          labelKey: 'kpiPopulation',
          value: `${fmtNum(population.alive ?? 0)} / ${fmtNum(population.total ?? 0)}`,
          detail: fmtNum(population.dead ?? 0),
          detailKey: 'kpiDead',
          direction: 'flat',
        },
        {
          key: 'tradesToday',
          labelKey: 'kpiTradesToday',
          value: fmtNum(tradesToday ?? 0),
          detail: lastCycle?.available === true ? (lastCycle.topSkipText || null) : null,
          direction: 'flat',
        },
        {
          key: 'winRate',
          labelKey: 'kpiWinRate',
          value: winRatePct === null ? '—' : `${winRatePct.toFixed(0)}%`,
          detail: `${fmtNum(winners)}/${fmtNum(aliveAgents.length)}`,
          direction: 'flat',
        },
        {
          key: 'treasury',
          labelKey: 'kpiTreasury',
          value: fmtHours(treasury.runwayHours),
          detail: treasury.state ?? null,
          direction: 'flat',
        },
      ];
    }

    /** 70/30 day-vs-swing strategy mix projection for the overview chart. */
    function strategyMixBreakdown(stateStatus) {
      const status = plainObject(stateStatus);
      const mix = plainObject(status.strategyMix);
      const dayCount = toNumber(mix.day?.count) ?? 0;
      const swingCount = toNumber(mix.swing?.count) ?? 0;
      const total = toNumber(mix.total) ?? dayCount + swingCount;
      const targetDayPct = toNumber(mix.targetDayPct) ?? toNumber(status.config?.strategyMix?.dayPct) ?? 0.7;
      const dayPct = total > 0 ? dayCount / total : null;
      const swingPct = total > 0 ? swingCount / total : null;
      const bar = (key, labelKey, count, pct, targetPct) => ({
        key,
        labelKey,
        count,
        pct,
        pctText: pct === null ? '—' : fmtPct(pct),
        targetPct,
        targetText: fmtPct(targetPct),
        deltaPct: pct === null ? null : (pct - targetPct) * 100,
      });
      return {
        available: Object.keys(mix).length > 0,
        total,
        targetDayPct,
        day: bar('day', 'categoryDay', dayCount, dayPct, targetDayPct),
        swing: bar('swing', 'categorySwing', swingCount, swingPct, 1 - targetDayPct),
        bars: [
          bar('day', 'categoryDay', dayCount, dayPct, targetDayPct),
          bar('swing', 'categorySwing', swingCount, swingPct, 1 - targetDayPct),
        ],
      };
    }

    /** Agent table rows merged with live market data (equity/P&L/stance/basket/sparkline). */
    function agentTableRows(stateStatus, marketView) {
      const status = plainObject(stateStatus);
      if (Object.keys(status).length === 0) return [];
      const baseRows = buildAgentRows(status);
      const market = plainObject(marketView);
      const marketAgents = Array.isArray(market.agents) ? market.agents : [];
      const byId = new Map();
      for (const agent of marketAgents) {
        if (agent && agent.id !== undefined) byId.set(String(agent.id), agent);
      }
      const sparklines = plainObject(market.sparklines);
      return baseRows.map((row) => {
        const live = byId.get(row.id) ?? null;
        const symbols = (Array.isArray(row.genome?.symbols) ? row.genome.symbols : row.genome?.symbol ? [row.genome.symbol] : [])
          .map((symbol) => String(symbol))
          .filter((symbol) => symbol.length > 0);
        const primary = symbols[0] ?? null;
        const livePositions = Array.isArray(live?.positions) ? live.positions.length : null;
        const liveEquityUsd = toNumber(live?.equityUsd);
        const liveDayPnlPct = toNumber(live?.dayPnlPct);
        const stance = typeof live?.stance === 'string' ? live.stance : row.policy?.stance ?? null;
        return {
          ...row,
          live: live !== null,
          liveEquityUsd,
          liveDayPnlPct,
          livePositions,
          stance,
          stanceBadge: stance ? stanceBadge(stance) : null,
          basket: symbols,
          basketText: symbols.length === 0 ? '—' : symbols.slice(0, 4).join(', '),
          sparkline: primary && Array.isArray(sparklines[primary]) ? sparklines[primary] : [],
          sparklinePath: primary && Array.isArray(sparklines[primary]) ? sparklinePath(sparklines[primary]) : '',
          liveDirection: changeDirection(liveDayPnlPct ?? row.dayPnlPct),
        };
      });
    }

    /** Market session label projection (open/closed/unknown). */
    function marketSession(marketView) {
      const market = plainObject(marketView);
      if (Object.keys(market).length === 0 || market.ok === false) return { open: null, labelKey: 'marketUnknown', available: false };
      if (market.marketOpen === true) return { open: true, labelKey: 'marketOpen', available: true };
      if (market.marketOpen === false) return { open: false, labelKey: 'marketClosed', available: true };
      return { open: null, labelKey: 'marketUnknown', available: true };
    }

    /**
     * One dashboard view: state + live market feed with graceful fallback. The tape/KPIs are
     * state-only when the market endpoint is missing (old Host), never throwing.
     */
    function liveViewMapping(stateStatus, marketView) {
      const status = plainObject(stateStatus);
      const market = plainObject(marketView);
      const hasState = Object.keys(status).length > 0;
      const available = Object.keys(market).length > 0 && market.ok !== false;
      const summary = hasState ? summarize(status) : null;
      const session = marketSession(market);
      const tape = available ? marketTapeRows(market) : [];
      const feedStatus = !available ? 'unavailable' : session.open === false ? 'closed' : 'live';
      return {
        available,
        hasState,
        feedStatus,
        marketOpen: session.open,
        sessionLabelKey: session.labelKey,
        tape,
        quotesCount: tape.length,
        kpis: hasState ? kpiCards(status, available ? market : null) : [],
        equity: equityChartPoints(available ? market.equityHistory : []),
        mix: hasState ? strategyMixBreakdown(status) : null,
        agents: hasState ? agentTableRows(status, available ? market : null) : [],
        summary,
        lastUpdatedAt: available ? market.at ?? null : null,
        error: available ? null : market.error ?? null,
        market,
      };
    }

    // -----------------------------------------------------------------------
    // shared data store: one poller for every mounted dashboard surface
    // -----------------------------------------------------------------------

    function createStateStore() {
      /** @type {{loading:boolean,data:object|null,error:object|null,fetchedAt:number,paused:boolean,refreshing:boolean}} */
      let snapshot = { loading: true, data: null, error: null, fetchedAt: 0, paused: false, refreshing: false };
      const listeners = new Set();
      let timer = null;
      let inFlight = false;
      let disposed = false;
      let visibilityHandler = null;

      function publish(patch) {
        snapshot = { ...snapshot, ...patch };
        for (const listener of [...listeners]) {
          try {
            listener(snapshot);
          } catch {
            /* a crashing subscriber must not stop polling for the others */
          }
        }
      }

      function schedule() {
        clearTimeout(timer);
        timer = null;
        const hidden = typeof document !== 'undefined' && document.hidden === true;
        if (disposed || snapshot.paused || listeners.size === 0 || hidden) return;
        timer = setTimeout(() => {
          timer = null;
          void load();
        }, POLL_MS);
      }

      async function load() {
        if (inFlight || disposed) return; // ignore while a request is in flight
        inFlight = true;
        publish({ refreshing: true });
        try {
          const response = await fetch(STATE_URL, {
            method: 'GET',
            headers: { accept: 'application/json' },
            cache: 'no-store',
          });
          let body = null;
          try {
            body = await response.json();
          } catch {
            body = null;
          }
          if (!response.ok || !body || body.ok === false) {
            publish({
              loading: false,
              refreshing: false,
              error: body?.error ?? { code: `HTTP_${response.status}`, message: response.statusText || 'state route failed' },
            });
          } else {
            publish({ loading: false, refreshing: false, error: null, data: body, fetchedAt: Date.now() });
          }
        } catch (error) {
          publish({ loading: false, refreshing: false, error: { code: 'FETCH_FAILED', message: errorText(error) } });
        } finally {
          inFlight = false;
          schedule();
        }
      }

      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener);
          if (listeners.size === 1) {
            schedule();
            if (typeof document !== 'undefined') {
              visibilityHandler = () => {
                if (document.hidden) {
                  clearTimeout(timer);
                  timer = null;
                } else {
                  schedule();
                }
              };
              document.addEventListener('visibilitychange', visibilityHandler);
            }
          }
          return () => {
            listeners.delete(listener);
            if (listeners.size === 0) {
              clearTimeout(timer);
              timer = null;
              if (visibilityHandler && typeof document !== 'undefined') {
                document.removeEventListener('visibilitychange', visibilityHandler);
                visibilityHandler = null;
              }
            }
          };
        },
        refreshNow() {
          if (!inFlight && !disposed) void load();
        },
        setPaused(paused) {
          publish({ paused: Boolean(paused) });
          if (!snapshot.paused) schedule();
          else {
            clearTimeout(timer);
            timer = null;
            publish({ refreshing: false });
          }
        },
        togglePaused() {
          this.setPaused(!snapshot.paused);
        },
      };
    }

    const store = createStateStore();

    /**
     * Live market feed store: GET /automaton/market every 2 s (paused when the tab is
     * hidden or auto-refresh is off). A missing endpoint is not an error state for the
     * dashboard: the feed reports `unavailable` and the UI falls back to state-only data.
     */
    function createMarketStore() {
      let snapshot = { loading: true, data: null, error: null, fetchedAt: 0, paused: false, refreshing: false, unavailable: false };
      const listeners = new Set();
      let timer = null;
      let inFlight = false;
      let disposed = false;
      let visibilityHandler = null;

      function publish(patch) {
        snapshot = { ...snapshot, ...patch };
        for (const listener of [...listeners]) {
          try {
            listener(snapshot);
          } catch {
            /* one bad subscriber must not stop the live feed */
          }
        }
      }

      function schedule() {
        clearTimeout(timer);
        timer = null;
        const hidden = typeof document !== 'undefined' && document.hidden === true;
        if (disposed || snapshot.paused || listeners.size === 0 || hidden) return;
        timer = setTimeout(() => {
          timer = null;
          void load();
        }, MARKET_POLL_MS);
      }

      async function load() {
        if (inFlight || disposed) return;
        inFlight = true;
        publish({ refreshing: true });
        try {
          const response = await fetch(MARKET_URL, {
            method: 'GET',
            headers: { accept: 'application/json' },
            cache: 'no-store',
          });
          let body = null;
          try {
            body = await response.json();
          } catch {
            body = null;
          }
          if (!response.ok || !body || body.ok === false) {
            publish({
              loading: false,
              refreshing: false,
              unavailable: true,
              error: body?.error ?? { code: `HTTP_${response.status}`, message: response.statusText || 'market route unavailable' },
            });
          } else {
            publish({ loading: false, refreshing: false, error: null, unavailable: false, data: body, fetchedAt: Date.now() });
          }
        } catch (error) {
          publish({ loading: false, refreshing: false, unavailable: true, error: { code: 'FETCH_FAILED', message: errorText(error) } });
        } finally {
          inFlight = false;
          schedule();
        }
      }

      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener);
          if (listeners.size === 1) {
            schedule();
            if (typeof document !== 'undefined') {
              visibilityHandler = () => {
                if (document.hidden) {
                  clearTimeout(timer);
                  timer = null;
                } else {
                  schedule();
                }
              };
              document.addEventListener('visibilitychange', visibilityHandler);
            }
          }
          return () => {
            listeners.delete(listener);
            if (listeners.size === 0) {
              clearTimeout(timer);
              timer = null;
              if (visibilityHandler && typeof document !== 'undefined') {
                document.removeEventListener('visibilitychange', visibilityHandler);
                visibilityHandler = null;
              }
            }
          };
        },
        refreshNow() {
          if (!inFlight && !disposed) void load();
        },
        setPaused(paused) {
          publish({ paused: Boolean(paused) });
          if (!snapshot.paused) schedule();
          else {
            clearTimeout(timer);
            timer = null;
            publish({ refreshing: false });
          }
        },
      };
    }

    const marketStore = createMarketStore();

    /** Subscribe one component to the shared live market feed; syncs the pause toggle. */
    function useMarketFeed(paused) {
      const [snapshot, setSnapshot] = React.useState(marketStore.getSnapshot());
      React.useEffect(() => marketStore.subscribe(setSnapshot), []);
      React.useEffect(() => {
        marketStore.setPaused(Boolean(paused));
      }, [paused]);
      return snapshot;
    }

    /** Manual refresh: pull both the state snapshot and the live market feed now. */
    function refreshAll() {
      store.refreshNow();
      marketStore.refreshNow();
    }

    /** Subscribe one component to the shared poll snapshot. */
    function useDashboardState() {
      const [snapshot, setSnapshot] = React.useState(store.getSnapshot());
      React.useEffect(() => store.subscribe(setSnapshot), []);
      return snapshot;
    }

    function useControlActions() {
      const [state, setState] = React.useState({ pending: null, action: null, error: null, message: null, hint: null, result: null });
      const run = React.useCallback(async (payload) => {
        if (!payload || typeof payload.action !== 'string') return;
        setState({ pending: payload.action, action: payload.action, error: null, message: null, hint: null, result: null });
        try {
          const response = await fetch(CONTROL_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(payload),
          });
          let body = null;
          try {
            body = await response.json();
          } catch {
            body = null;
          }
          if (!response.ok || !body || body.ok === false) {
            setState({
              pending: null,
              action: payload.action,
              error: body?.error ?? { code: `HTTP_${response.status}`, message: response.statusText || 'control request failed' },
              hint: typeof body?.hint === 'string' ? body.hint : null,
              message: null,
              result: null,
            });
          } else {
            setState({ pending: null, action: payload.action, error: null, hint: null, message: payload.action, result: body.result ?? null });
            store.refreshNow();
          }
        } catch (error) {
          setState({ pending: null, action: payload.action, error: { code: 'CONTROL_FAILED', message: errorText(error) }, hint: null, message: null, result: null });
        }
      }, []);
      return { controlState: state, runControl: run };
    }

    // -----------------------------------------------------------------------
    // styles (theme tokens with fallbacks; class names shared by all slots)
    // -----------------------------------------------------------------------

    const APP_CSS = `
.atm-root{display:flex;flex-direction:column;gap:12px;min-width:0;color:var(--dsw-alias-label-primary,inherit);font-size:13px;line-height:20px}
.atm-main{height:100%;box-sizing:border-box;overflow:auto;padding:16px 20px 28px}
.atm-settings{max-width:1180px}
.atm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap}
.atm-head-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.atm-title{margin:0;font-size:18px;font-weight:600;line-height:26px;color:var(--dsw-alias-label-primary,inherit)}
.atm-sub{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,inherit);max-width:660px}
.atm-head-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.atm-badge{display:inline-flex;align-items:center;gap:4px;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:999px;padding:1px 8px;font-size:11px;line-height:18px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap}
.atm-badge[data-mode="paper"]{color:var(--dsw-alias-state-business-primary,inherit)}
.atm-badge[data-mode="live"]{color:var(--dsw-alias-state-error-primary,inherit);border-color:currentColor}
.atm-badge[data-running="true"]{color:var(--dsw-alias-label-primary,inherit)}
.atm-kill{display:inline-flex;align-items:center;gap:4px;border:.5px solid currentColor;border-radius:999px;padding:1px 8px;font-size:11px;line-height:18px;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;color:var(--dsw-alias-state-error-primary,inherit)}
.atm-kill[data-on="false"]{color:var(--dsw-alias-label-tertiary,inherit);border-color:var(--dsw-alias-border-l2,currentColor)}
.atm-dot{width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block}
.atm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:8px}
.atm-card{display:flex;flex-direction:column;gap:1px;min-width:0;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:8px;padding:6px 9px;background:var(--dsw-alias-bg-l2,transparent)}
.atm-card-k{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.atm-card-v{font-size:14px;font-weight:600;line-height:21px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.atm-card-sub{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.atm-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.atm-spacer{flex:1 1 auto}
.atm-btn{font:inherit;font-size:12px;line-height:18px;border:.5px solid var(--dsw-alias-border-l2,currentColor);background:var(--dsw-alias-bg-l2,transparent);color:var(--dsw-alias-label-primary,inherit);border-radius:7px;padding:2px 10px;cursor:pointer;white-space:nowrap}
.atm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,transparent)}
.atm-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,currentColor));outline-offset:1px}
.atm-btn:disabled{opacity:.45;cursor:default}
.atm-btn[data-variant="primary"]{color:var(--dsw-alias-state-business-primary,inherit);border-color:currentColor}
.atm-btn[data-variant="danger"]{color:var(--dsw-alias-state-error-primary,inherit);border-color:currentColor}
.atm-btn[data-variant="active"]{color:var(--dsw-alias-label-primary,inherit);border-color:var(--dsw-alias-label-primary,currentColor)}
.atm-chip{font:inherit;font-size:11.5px;line-height:18px;border:.5px solid var(--dsw-alias-border-l2,currentColor);background:transparent;color:var(--dsw-alias-label-tertiary,inherit);border-radius:999px;padding:1px 9px;cursor:pointer}
.atm-chip[data-active="true"]{color:var(--dsw-alias-label-primary,inherit);border-color:var(--dsw-alias-label-primary,currentColor);background:var(--dsw-alias-bg-l2,transparent)}
.atm-input{font:inherit;font-size:12px;line-height:18px;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,inherit);padding:2px 8px;min-width:180px}
.atm-input:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,currentColor));outline-offset:1px}
.atm-section{display:flex;flex-direction:column;gap:6px;min-width:0}
.atm-section-title{margin:0;font-size:12.5px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary,inherit);display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.atm-table-wrap{overflow:auto;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:8px;max-height:420px}
.atm-table{width:100%;border-collapse:separate;border-spacing:0;font-size:11.5px;line-height:16px;white-space:nowrap}
.atm-table th{position:sticky;top:0;z-index:1;text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary,inherit);background:var(--dsw-alias-bg-l2,var(--dsw-alias-bg-base,Canvas));border-bottom:.5px solid var(--dsw-alias-border-l2,currentColor);padding:3px 6px;white-space:nowrap}
.atm-table th.atm-sortable{cursor:pointer;user-select:none}
.atm-table th.atm-sortable:hover{color:var(--dsw-alias-label-primary,inherit)}
.atm-table th[data-sorted="true"]{color:var(--dsw-alias-label-primary,inherit)}
.atm-table td{border-bottom:.5px solid var(--dsw-alias-border-l2,currentColor);padding:3px 6px;max-width:230px;overflow:hidden;text-overflow:ellipsis;vertical-align:middle}
.atm-table tbody tr:last-child td{border-bottom:0}
.atm-table tbody tr[data-clickable="true"]{cursor:pointer}
.atm-table tbody tr[data-clickable="true"]:hover{background:var(--dsw-alias-interactive-bg-hover,transparent)}
.atm-table tbody tr:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,currentColor));outline-offset:-1px}
.atm-table tbody tr[data-selected="true"]{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-l2,transparent));box-shadow:inset 2px 0 0 var(--dsw-alias-state-business-primary,currentColor)}
.atm-table tr[data-status="dead"]{opacity:.62}
.atm-table tr[data-status="condemned"] td:first-child{box-shadow:inset 2px 0 0 var(--dsw-alias-state-error-primary,currentColor)}
.atm-name{display:flex;flex-direction:column;gap:0;min-width:0;line-height:15px}
.atm-name-main{font-weight:600;color:var(--dsw-alias-label-primary,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.atm-name-sub{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.atm-mono{font-variant-numeric:tabular-nums}
.atm-pos{color:var(--dsw-alias-state-business-primary,inherit)}
.atm-neg{color:var(--dsw-alias-state-error-primary,inherit)}
.atm-muted{color:var(--dsw-alias-label-tertiary,inherit);margin:0;font-size:12px}
.atm-err{color:var(--dsw-alias-state-error-primary,inherit);margin:0;font-size:12px;line-height:18px;overflow-wrap:anywhere}
.atm-note{color:var(--dsw-alias-label-tertiary,inherit);margin:0;font-size:11px;line-height:16px}
.atm-halt{border:.5px solid var(--dsw-alias-state-error-primary,currentColor);color:var(--dsw-alias-state-error-primary,inherit);border-radius:6px;padding:4px 10px;font-size:12px;margin:0}
.atm-two{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.atm-list{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}
.atm-list li{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:11.5px;line-height:17px;border-left:2px solid var(--dsw-alias-border-l2,currentColor);padding-left:8px}
.atm-list li[data-cause="death"]{border-left-color:var(--dsw-alias-state-error-primary,currentColor)}
.atm-runway-cell{display:inline-flex;align-items:center;gap:6px}
.atm-runway{display:inline-block;width:56px;height:5px;border-radius:3px;background:var(--dsw-alias-fill-l2,var(--dsw-alias-border-l2,transparent));overflow:hidden;vertical-align:middle}
.atm-runway > i{display:block;height:100%;border-radius:3px;background:var(--dsw-alias-state-business-primary,currentColor)}
.atm-runway[data-level="warn"] > i{background:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-primary,currentColor))}
.atm-runway[data-level="crit"] > i{background:var(--dsw-alias-state-error-primary,currentColor)}
.atm-status{display:inline-flex;align-items:center;gap:4px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2,currentColor);padding:0 7px;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-tertiary,inherit);max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.atm-status[data-status="alive"]{color:var(--dsw-alias-state-business-primary,inherit)}
.atm-status[data-status="dead"]{color:var(--dsw-alias-state-error-primary,inherit)}
.atm-status[data-status="condemned"]{color:var(--dsw-alias-state-error-primary,inherit);border-color:currentColor}
.atm-workspace{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;align-items:start}
.atm-workspace[data-detail="true"]{grid-template-columns:minmax(0,1fr) minmax(320px,380px)}
@media (max-width:1080px){.atm-workspace[data-detail="true"]{grid-template-columns:minmax(0,1fr)}}
.atm-main-col{display:flex;flex-direction:column;gap:12px;min-width:0}
.atm-detail{display:flex;flex-direction:column;gap:10px;min-width:0;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-l2,transparent);position:sticky;top:8px;max-height:calc(100vh - 220px);overflow:auto}
.atm-detail-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;flex-wrap:wrap}
.atm-detail-name{margin:0;font-size:15px;font-weight:600;line-height:21px;color:var(--dsw-alias-label-primary,inherit);overflow-wrap:anywhere}
.atm-detail-id{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary,inherit)}
.atm-detail-title{margin:6px 0 0;font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary,inherit);display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.atm-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:4px 8px}
.atm-kv-item{display:flex;flex-direction:column;gap:0;min-width:0;line-height:15px}
.atm-kv-k{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.atm-kv-v{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-primary,inherit);overflow-wrap:anywhere}
.atm-detail-table{width:100%;border-collapse:separate;border-spacing:0;font-size:11px;line-height:15px;white-space:nowrap;font-variant-numeric:tabular-nums}
.atm-detail-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary,inherit);border-bottom:.5px solid var(--dsw-alias-border-l2,currentColor);padding:2px 4px}
.atm-detail-table td{border-bottom:.5px solid var(--dsw-alias-border-l2,currentColor);padding:2px 4px}
.atm-detail-table tr:last-child td{border-bottom:0}
.atm-activity{display:flex;flex-direction:column;gap:3px;margin:0;padding:0;list-style:none}
.atm-activity li{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;font-size:11px;line-height:16px;border-left:2px solid var(--dsw-alias-border-l2,currentColor);padding-left:6px}
.atm-activity li[data-side="buy"]{border-left-color:var(--dsw-alias-state-business-primary,currentColor)}
.atm-activity li[data-side="sell"]{border-left-color:var(--dsw-alias-state-error-primary,currentColor)}
.atm-side{font-weight:600;text-transform:uppercase;font-size:10px}
.atm-side[data-side="buy"]{color:var(--dsw-alias-state-business-primary,inherit)}
.atm-side[data-side="sell"]{color:var(--dsw-alias-state-error-primary,inherit)}
.atm-chips{display:flex;flex-wrap:wrap;gap:4px}
.atm-param{display:inline-flex;align-items:baseline;gap:4px;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:5px;padding:0 5px;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap}
.atm-param b{font-weight:600;color:var(--dsw-alias-label-primary,inherit)}
.atm-empty{margin:0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary,inherit)}
.atm-warn{color:var(--dsw-alias-state-error-primary,inherit);font-size:11px;line-height:16px;margin:0}
.atm-pill{display:inline-flex;align-items:center;gap:4px;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:999px;padding:0 7px;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap}
.atm-pill[data-emphasis="true"]{color:var(--dsw-alias-state-business-primary,inherit);border-color:currentColor}
.atm-reaper{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:8px;padding:5px 10px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary,inherit);background:transparent}
.atm-reaper[data-kind="stale"]{border-color:var(--dsw-alias-state-error-primary,currentColor);color:var(--dsw-alias-label-primary,inherit)}
.atm-reaper[data-kind="healthy"]{border-color:var(--dsw-alias-state-business-primary,currentColor)}
.atm-reaper-label{font-weight:600;color:var(--dsw-alias-label-primary,inherit);white-space:nowrap}
.atm-reaper-detail{white-space:nowrap}
.atm-reaper-stale{color:var(--dsw-alias-state-error-primary,inherit);font-weight:600}
.atm-research{display:inline-flex;align-items:center;gap:3px;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:999px;padding:0 6px;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap}
.atm-research[data-tone="hold"]{color:var(--dsw-alias-state-business-primary,inherit)}
.atm-research[data-tone="avoid"]{color:var(--dsw-alias-state-error-primary,inherit)}
.atm-research[data-tone="alert"]{color:var(--dsw-alias-state-error-primary,inherit);border-color:currentColor;font-weight:600}
.atm-research[data-stale="true"]{opacity:.55;font-style:italic}
.atm-research-section{display:flex;flex-direction:column;gap:5px;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:8px;padding:6px 8px}
.atm-research-head{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.atm-research-meta{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary,inherit)}
.atm-research-block{display:flex;flex-direction:column;gap:2px}
.atm-research-block > b{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary,inherit);font-weight:600}
.atm-research-list{margin:0;padding-left:15px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-primary,inherit)}
.atm-research-list li{margin:0}
.atm-source-link{color:var(--dsw-alias-state-business-primary,inherit);text-decoration:underline;overflow-wrap:anywhere}
.atm-research-summary{margin:0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-primary,inherit);overflow-wrap:anywhere}
.atm-instr-badges{display:inline-flex;gap:3px;flex-wrap:nowrap;align-items:baseline}
.atm-instr-badge{display:inline-flex;align-items:baseline;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:999px;padding:0 5px;font-size:9.5px;line-height:15px;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap}
.atm-instr-badge[data-kind="short"],.atm-instr-badge[data-kind="margin"]{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-primary,inherit));border-color:currentColor}
.atm-instr-badge[data-kind="options"],.atm-instr-badge[data-kind="spreads"]{color:var(--dsw-alias-state-business-primary,inherit);border-color:currentColor}
.atm-instr-empty{font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-tertiary,inherit)}
.atm-side-chip{display:inline-flex;align-items:center;border-radius:4px;padding:0 5px;font-size:10px;line-height:16px;font-weight:600;letter-spacing:.02em;border:.5px solid var(--dsw-alias-border-l2,currentColor);color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap}
.atm-side-chip[data-side="LONG"]{color:var(--dsw-alias-state-business-primary,inherit);border-color:currentColor}
.atm-side-chip[data-side="SHORT"],.atm-side-chip[data-side="PUT"]{color:var(--dsw-alias-state-error-primary,inherit);border-color:currentColor}
.atm-side-chip[data-side="CALL"]{color:var(--dsw-alias-state-business-primary,inherit);border-color:currentColor}
.atm-option-meta{display:flex;flex-direction:column;gap:1px;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap;font-variant-numeric:tabular-nums}
.atm-option-meta b{color:var(--dsw-alias-label-primary,inherit);font-weight:600}
.atm-group-tag{display:inline-flex;align-items:center;border:.5px dashed var(--dsw-alias-border-l2,currentColor);border-radius:4px;padding:0 4px;font-size:9.5px;line-height:14px;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap}
.atm-exposure-line{display:flex;gap:8px;flex-wrap:wrap;align-items:baseline;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-tertiary,inherit)}
.atm-exposure-line b{color:var(--dsw-alias-label-primary,inherit);font-weight:600;font-variant-numeric:tabular-nums}
.atm-playbook-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px}
.atm-playbook-card{display:flex;flex-direction:column;gap:3px;min-width:0;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:8px;padding:6px 8px}
.atm-playbook-card[data-side="bullish"]{border-left:3px solid var(--dsw-alias-state-business-primary,currentColor)}
.atm-playbook-card[data-side="bearish"]{border-left:3px solid var(--dsw-alias-state-error-primary,currentColor)}
.atm-playbook-card[data-side="neutral"]{border-left:3px solid var(--dsw-alias-label-tertiary,currentColor)}
.atm-cap-list{display:flex;gap:6px;flex-wrap:wrap;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-tertiary,inherit)}
.atm-type-chip{display:inline-flex;align-items:baseline;gap:3px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-left-width:3px;border-radius:999px;padding:0 7px;font-size:10.5px;line-height:17px;color:var(--dsw-alias-label-primary,inherit)}
.atm-type-chip[data-category="swing"]{border-left-color:var(--dsw-alias-state-business-primary,currentColor)}
.atm-type-chip[data-category="day"]{border-left-color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-tertiary,currentColor))}
.atm-interval{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,inherit);font-size:11px;line-height:16px;white-space:nowrap}
.atm-cat-tabs{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.atm-cat-tab{font:inherit;font-size:11px;line-height:17px;border:.5px solid var(--dsw-alias-border-l2,currentColor);background:transparent;color:var(--dsw-alias-label-tertiary,inherit);border-radius:999px;padding:1px 9px;cursor:pointer;white-space:nowrap}
.atm-cat-tab:hover{background:var(--dsw-alias-interactive-bg-hover,transparent)}
.atm-cat-tab[data-active="true"]{color:var(--dsw-alias-label-primary,inherit);border-color:var(--dsw-alias-label-primary,currentColor);background:var(--dsw-alias-bg-l2,transparent)}
.atm-cat-tab .atm-count{color:var(--dsw-alias-label-tertiary,inherit);font-variant-numeric:tabular-nums}
.atm-stance{display:inline-flex;align-items:center;gap:4px;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:999px;padding:0 8px;font-size:10.5px;line-height:17px;font-weight:600;letter-spacing:.02em;white-space:nowrap;color:var(--dsw-alias-label-tertiary,inherit)}
.atm-stance[data-tone="trade"]{color:var(--dsw-alias-state-business-primary,inherit);border-color:currentColor}
.atm-stance[data-tone="cautious"]{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-primary,inherit));border-color:currentColor}
.atm-stance[data-tone="stand_down"]{color:var(--dsw-alias-state-error-primary,inherit);border-color:currentColor}
.atm-botagent{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px}
.atm-botagent-card{display:flex;flex-direction:column;gap:4px;min-width:0;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:8px;padding:7px 9px}
.atm-botagent-metrics{display:flex;gap:8px;flex-wrap:wrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,inherit)}
.atm-botagent-metric b{color:var(--dsw-alias-label-primary,inherit);font-variant-numeric:tabular-nums;font-weight:600}
.atm-cap-warning{display:flex;gap:5px;flex-wrap:wrap;align-items:baseline;margin:0;font-size:10.5px;line-height:17px;color:var(--dsw-alias-label-primary,inherit);border:.5px solid var(--dsw-alias-state-warning-primary,var(--dsw-alias-border-l2,currentColor));border-left-width:3px;border-radius:8px;padding:4px 9px;background:var(--dsw-alias-bg-l2,transparent)}
.atm-cap-warning b{font-weight:600;color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-primary,inherit))}
.atm-bridge-line{font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-tertiary,inherit);display:flex;gap:6px;flex-wrap:wrap;align-items:baseline}
.atm-bridge-line b{color:var(--dsw-alias-label-primary,inherit);font-weight:600}
.atm-operator-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:10px}
.atm-card-block{display:flex;flex-direction:column;gap:8px;min-width:0;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:10px;padding:9px 11px}
.atm-block-title{margin:0;font-size:12.5px;font-weight:600;line-height:18px;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.atm-seg{display:flex;flex-wrap:wrap;gap:4px}
.atm-seg button{font:inherit;font-size:11px;line-height:16px;border:.5px solid var(--dsw-alias-border-l2,currentColor);background:transparent;color:var(--dsw-alias-label-tertiary,inherit);border-radius:999px;padding:1px 8px;cursor:pointer;white-space:nowrap}
.atm-seg button:hover{background:var(--dsw-alias-interactive-bg-hover,transparent)}
.atm-seg button[data-active="true"]{color:var(--dsw-alias-label-primary,inherit);border-color:var(--dsw-alias-label-primary,currentColor);background:var(--dsw-alias-bg-l2,transparent)}
.atm-form-row{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end}
.atm-field{display:flex;flex-direction:column;gap:1px;font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary,inherit);min-width:0}
.atm-num{font:inherit;font-size:12px;line-height:18px;width:82px;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,inherit);padding:1px 6px}
.atm-num:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,currentColor));outline-offset:1px}
.atm-switch{font:inherit;font-size:11px;line-height:18px;display:inline-flex;align-items:center;gap:5px;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:999px;padding:1px 9px;cursor:pointer;background:transparent;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap}
.atm-switch[data-on="true"]{color:var(--dsw-alias-state-business-primary,inherit);border-color:currentColor}
.atm-switch[data-on="false"]{color:var(--dsw-alias-label-tertiary,inherit)}
.atm-switch .atm-dot{opacity:.5}
.atm-switch[data-on="true"] .atm-dot{opacity:1}
.atm-preview{display:flex;flex-direction:column;gap:2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,inherit)}
.atm-preview-row{display:flex;gap:6px;flex-wrap:wrap;align-items:baseline}
.atm-pill-amount{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,inherit);font-weight:600}
.atm-rank-badges{display:flex;gap:4px;flex-wrap:wrap}
.atm-rank-badge{display:inline-flex;align-items:baseline;gap:3px;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:999px;padding:0 6px;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap}
.atm-rank-badge[data-medal="true"]{color:var(--dsw-alias-label-primary,inherit)}
.atm-medal{font-size:11px}
.atm-lb-wrap{overflow:auto;max-height:260px;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:8px}
.atm-lb-table{width:100%;border-collapse:separate;border-spacing:0;font-size:11px;line-height:16px;white-space:nowrap;font-variant-numeric:tabular-nums}
.atm-lb-table th{position:sticky;top:0;z-index:1;text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary,inherit);background:var(--dsw-alias-bg-l2,var(--dsw-alias-bg-base,Canvas));border-bottom:.5px solid var(--dsw-alias-border-l2,currentColor);padding:2px 6px}
.atm-lb-table td{border-bottom:.5px solid var(--dsw-alias-border-l2,currentColor);padding:2px 6px;max-width:180px;overflow:hidden;text-overflow:ellipsis}
.atm-lb-table tbody tr{cursor:pointer}
.atm-lb-table tbody tr:hover{background:var(--dsw-alias-interactive-bg-hover,transparent)}
.atm-lb-table tbody tr[data-top="true"]{background:var(--dsw-alias-bg-l2,transparent)}
.atm-lb-table tbody tr:last-child td{border-bottom:0}
.atm-plan-block{display:flex;flex-direction:column;gap:2px;min-width:0}
.atm-plan-label{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary,inherit);font-weight:600}
.atm-plan-text{margin:0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-primary,inherit);overflow-wrap:anywhere}
.atm-plan-list{margin:0;padding-left:15px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-primary,inherit)}
.atm-plan-list li{margin:0}
.atm-topbar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:12px;padding:8px 12px;background:var(--dsw-alias-bg-l2,transparent)}
.atm-brand{display:flex;align-items:center;gap:9px;min-width:0}
.atm-brand-mark{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:9px;border:.5px solid var(--dsw-alias-state-business-primary,currentColor);color:var(--dsw-alias-state-business-primary,inherit);font-weight:700;font-size:12px;letter-spacing:.04em;flex:0 0 auto}
.atm-brand-text{display:flex;flex-direction:column;min-width:0}
.atm-brand-title{font-size:15px;font-weight:700;line-height:20px;letter-spacing:.04em}
.atm-brand-sub{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.atm-topbar-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.atm-clock{display:inline-flex;align-items:baseline;gap:5px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,inherit);font-variant-numeric:tabular-nums;white-space:nowrap}
.atm-clock b{color:var(--dsw-alias-label-primary,inherit);font-weight:600}
.atm-feed-pill{display:inline-flex;align-items:center;gap:4px;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:999px;padding:1px 8px;font-size:10px;line-height:17px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap}
.atm-feed-pill[data-status="live"]{color:var(--dsw-alias-state-business-primary,inherit);border-color:currentColor}
.atm-feed-pill[data-status="closed"]{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-tertiary,inherit));border-color:currentColor}
.atm-feed-pill[data-status="unavailable"]{color:var(--dsw-alias-label-tertiary,inherit);border-style:dashed}
.atm-feed-pill .atm-dot{width:5px;height:5px}
.atm-feed-pill[data-status="live"] .atm-dot{animation:atm-pulse 1.6s ease-in-out infinite}
@keyframes atm-pulse{0%,100%{opacity:1}50%{opacity:.25}}
.atm-tabs{display:flex;gap:3px;flex-wrap:wrap;border-bottom:.5px solid var(--dsw-alias-border-l2,currentColor);padding-bottom:4px}
.atm-tab{font:inherit;font-size:12px;line-height:18px;border:.5px solid transparent;background:transparent;color:var(--dsw-alias-label-tertiary,inherit);border-radius:7px;padding:2px 10px;cursor:pointer;white-space:nowrap}
.atm-tab:hover{background:var(--dsw-alias-interactive-bg-hover,transparent)}
.atm-tab[data-active="true"]{color:var(--dsw-alias-label-primary,inherit);border-color:var(--dsw-alias-border-l2,currentColor);background:var(--dsw-alias-bg-l2,transparent);font-weight:600}
.atm-tab-panel{display:flex;flex-direction:column;gap:10px;min-width:0}
.atm-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:8px}
.atm-kpi{display:flex;flex-direction:column;gap:1px;min-width:0;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:10px;padding:7px 10px;background:var(--dsw-alias-bg-l2,transparent)}
.atm-kpi-label{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.atm-kpi-value{font-size:16px;font-weight:600;line-height:23px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:baseline;gap:5px}
.atm-kpi-delta{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.atm-kpi[data-direction="up"] .atm-kpi-value{color:var(--dsw-alias-state-business-primary,inherit)}
.atm-kpi[data-direction="down"] .atm-kpi-value{color:var(--dsw-alias-state-error-primary,inherit)}
.atm-arrow-up{color:var(--dsw-alias-state-business-primary,inherit)}
.atm-arrow-down{color:var(--dsw-alias-state-error-primary,inherit)}
.atm-chart-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px}
.atm-chart{border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:4px;min-width:0;background:var(--dsw-alias-bg-l2,transparent)}
.atm-chart-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap}
.atm-chart-title{font-size:11.5px;font-weight:600;line-height:17px}
.atm-chart-meta{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary,inherit);font-variant-numeric:tabular-nums}
.atm-chart svg{width:100%;height:auto;display:block;overflow:visible}
.atm-chart-empty{font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-tertiary,inherit);padding:18px 0;text-align:center;border:.5px dashed var(--dsw-alias-border-l2,currentColor);border-radius:8px}
.atm-spark{display:inline-block;vertical-align:middle}
.atm-spark path{fill:none;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}
.atm-spark[data-direction="up"] path{stroke:var(--dsw-alias-state-business-primary,currentColor)}
.atm-spark[data-direction="down"] path{stroke:var(--dsw-alias-state-error-primary,currentColor)}
.atm-spark[data-direction="flat"] path{stroke:var(--dsw-alias-label-tertiary,currentColor)}
.atm-mix-bars{display:flex;flex-direction:column;gap:5px}
.atm-mix-row{display:flex;flex-direction:column;gap:1px}
.atm-mix-head{display:flex;align-items:baseline;justify-content:space-between;gap:6px;font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap}
.atm-mix-track{position:relative;height:8px;border-radius:999px;background:var(--dsw-alias-fill-l2,var(--dsw-alias-border-l2,currentColor));overflow:hidden}
.atm-mix-fill{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:var(--dsw-alias-state-business-primary,currentColor)}
.atm-mix-row[data-side="swing"] .atm-mix-fill{background:var(--dsw-alias-label-tertiary,currentColor)}
.atm-mix-target{position:absolute;top:-2px;bottom:-2px;width:1.5px;background:var(--dsw-alias-label-primary,currentColor);opacity:.7}
.atm-tape-wrap{overflow:auto;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:8px;max-height:360px}
.atm-tape{width:100%;border-collapse:separate;border-spacing:0;font-size:11.5px;line-height:16px;white-space:nowrap;font-variant-numeric:tabular-nums}
.atm-tape th{position:sticky;top:0;z-index:1;text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary,inherit);background:var(--dsw-alias-bg-l2,var(--dsw-alias-bg-base,Canvas));border-bottom:.5px solid var(--dsw-alias-border-l2,currentColor);padding:3px 8px}
.atm-tape td{border-bottom:.5px solid var(--dsw-alias-border-l2,currentColor);padding:3px 8px;vertical-align:middle}
.atm-tape tbody tr:last-child td{border-bottom:0}
.atm-tape tbody tr:hover{background:var(--dsw-alias-interactive-bg-hover,transparent)}
.atm-tape .atm-sym{font-weight:600;letter-spacing:.02em}
.atm-tape .atm-chg-up{color:var(--dsw-alias-state-business-primary,inherit)}
.atm-tape .atm-chg-down{color:var(--dsw-alias-state-error-primary,inherit)}
.atm-tape .atm-chg-flat{color:var(--dsw-alias-label-tertiary,inherit)}
@keyframes atm-flash-up{0%{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,currentColor) 26%,transparent)}100%{background:transparent}}
@keyframes atm-flash-down{0%{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,currentColor) 26%,transparent)}100%{background:transparent}}
.atm-flash-up{animation:atm-flash-up 1.1s ease-out}
.atm-flash-down{animation:atm-flash-down 1.1s ease-out}
.atm-closed-label{font-size:10.5px;line-height:15px;color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-tertiary,inherit));white-space:nowrap}
.atm-stance-chip{display:inline-flex;align-items:center;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:999px;padding:0 6px;font-size:9.5px;line-height:15px;font-weight:600;letter-spacing:.03em;white-space:nowrap;color:var(--dsw-alias-label-tertiary,inherit)}
.atm-stance-chip[data-tone="trade"]{color:var(--dsw-alias-state-business-primary,inherit);border-color:currentColor}
.atm-stance-chip[data-tone="cautious"]{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-primary,inherit));border-color:currentColor}
.atm-stance-chip[data-tone="stand_down"]{color:var(--dsw-alias-state-error-primary,inherit);border-color:currentColor}
.atm-research-summary{display:flex;gap:6px;flex-wrap:wrap;font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,inherit)}
@media (max-width:820px){
  .atm-topbar{align-items:flex-start}
  .atm-chart-grid{grid-template-columns:1fr}
  .atm-kpis{grid-template-columns:repeat(auto-fit,minmax(132px,1fr))}
}
.atm-close{font:inherit;font-size:13px;line-height:18px;border:.5px solid var(--dsw-alias-border-l2,currentColor);background:transparent;color:var(--dsw-alias-label-tertiary,inherit);border-radius:6px;padding:0 7px;cursor:pointer}
.atm-close:hover{color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-interactive-bg-hover,transparent)}
.atm-icon{display:block}
`;

    // -----------------------------------------------------------------------
    // small presentational components
    // -----------------------------------------------------------------------

    function ModeBadge({ t, mode }) {
      const label = MODE_LABEL[mode] ?? String(mode ?? '—').toUpperCase();
      return h('span', { className: 'atm-badge', 'data-mode': mode, title: `${t('mode')}: ${mode}` }, label);
    }

    function KillBadge({ t, on }) {
      return h('span', {
        className: 'atm-kill',
        'data-on': on ? 'true' : 'false',
        title: on ? t('killOn') : t('killOff'),
      }, h('span', { className: 'atm-dot', 'aria-hidden': true }), on ? t('killOn') : t('killOff'));
    }

    function StatCard({ label, value, sub }) {
      return h('div', { className: 'atm-card' }, [
        h('span', { className: 'atm-card-k', key: 'k' }, label),
        h('span', { className: 'atm-card-v', key: 'v', title: String(value) }, value),
        sub ? h('span', { className: 'atm-card-sub', key: 's', title: String(sub) }, sub) : null,
      ]);
    }

    function HeaderStats({ t, summary }) {
      const population = summary.population;
      const treasury = summary.treasury;
      const allocatedText = treasury.allocatedUsd === null && summary.allocationCapUsd === null
        ? '—'
        : `${fmtUsd(treasury.allocatedUsd)}${summary.allocationCapUsd === null ? '' : ` / ${fmtUsd(summary.allocationCapUsd)}`}`;
      return h('div', { className: 'atm-grid' }, [
        h(StatCard, { key: 'mode', label: t('mode'), value: MODE_LABEL[summary.mode] ?? String(summary.mode).toUpperCase(), sub: summary.accountStatus ?? null }),
        h(StatCard, { key: 'loop', label: t('loop'), value: summary.running ? t('running') : t('stopped'), sub: summary.cycleIntervalSec ? `${summary.cycleIntervalSec}s` : null }),
        h(StatCard, { key: 'equity', label: t('account'), value: fmtUsd(summary.equityUsd), sub: `${t('cash')} ${fmtUsd(summary.cashUsd)}` }),
        h(StatCard, {
          key: 'pop',
          label: t('population'),
          value: `${fmtNum(population.alive)} / ${fmtNum(population.total)}`,
          sub: `${t('dead')} ${fmtNum(population.dead)} · ${t('condemned')} ${fmtNum(population.condemned)} · ${t('cap')} ${fmtNum(population.cap)}`,
        }),
        h(StatCard, {
          key: 'treasury',
          label: t('treasury'),
          value: `${treasury.state ?? '—'} · ${fmtHours(treasury.runwayHours)}`,
          sub: `${t('burn')} ${fmtUsd(treasury.burnPerHourUsd)}/h`,
        }),
        h(StatCard, {
          key: 'allocated',
          label: t('allocated'),
          value: allocatedText,
          sub: summary.allocationCapPct === null ? null : `${Math.round((summary.allocationCapPct ?? 0) * 100)}%`,
        }),
        h(StatCard, { key: 'tick', label: t('lastTick'), value: fmtAgo(summary.lastTickAt), sub: summary.ticks === null ? null : `${summary.ticks} ticks` }),
        h(StatCard, {
          key: 'kill',
          label: t('killSwitch'),
          value: summary.killSwitch ? t('armed') : t('clear'),
          sub: summary.halted ? t('halted') : null,
        }),
        h(StatCard, {
          key: 'obits',
          label: t('obituaries'),
          value: fmtNum(summary.obituaryStats?.total ?? 0),
          sub: summary.obituaryStats?.mostCommonCause ?? null,
        }),
      ]);
    }

    function PauseToggle({ t }) {
      const snapshot = useDashboardState();
      return h('button', {
        type: 'button',
        className: 'atm-btn',
        'data-variant': snapshot.paused ? 'active' : undefined,
        title: t('autoRefresh'),
        onClick: () => store.togglePaused(),
      }, snapshot.paused ? t('resume') : t('pause'));
    }

    function ControlBar({ t, summary, controlState, runControl }) {
      const [armed, setArmed] = React.useState(false);
      const pending = controlState.pending;
      const disabled = pending !== null;
      return h('div', { className: 'atm-section' }, [
        h('div', { className: 'atm-toolbar', key: 'buttons' }, [
          h('button', {
            key: 'start',
            type: 'button',
            className: 'atm-btn',
            'data-variant': 'primary',
            disabled: disabled || summary.running || summary.killSwitch,
            title: summary.killSwitch ? t('killOn') : t('start'),
            onClick: () => runControl({ action: 'start' }),
          }, `${t('start')}${pending === 'start' ? '…' : ''}`),
          h('button', {
            key: 'stop',
            type: 'button',
            className: 'atm-btn',
            disabled: disabled || !summary.running,
            onClick: () => runControl({ action: 'stop' }),
          }, `${t('stop')}${pending === 'stop' ? '…' : ''}`),
          armed
            ? h('button', {
              key: 'confirm',
              type: 'button',
              className: 'atm-btn',
              'data-variant': 'danger',
              disabled,
              onClick: () => {
                setArmed(false);
                runControl({ action: 'emergency-stop', confirm: 'STOP' });
              },
            }, `${t('confirmStop')}${pending === 'emergency-stop' ? '…' : ''}`)
            : h('button', {
              key: 'emergency',
              type: 'button',
              className: 'atm-btn',
              'data-variant': 'danger',
              disabled: disabled || summary.killSwitch,
              onClick: () => setArmed(true),
            }, t('emergency')),
          armed
            ? h('button', {
              key: 'cancel',
              type: 'button',
              className: 'atm-btn',
              onClick: () => setArmed(false),
            }, t('cancel'))
            : null,
          h('span', { className: 'atm-spacer', key: 'spacer' }),
          h(PauseToggle, { key: 'pause', t }),
          h('span', { className: 'atm-muted', key: 'auto', title: t('autoRefresh') }, summary.paused ? t('pausedLabel') : t('autoRefresh')),
        ]),
        controlState.error
          ? h('p', { className: 'atm-err', key: 'err' }, `${t('controlFailed')}: ${errorText(controlState.error)}`)
          : null,
        controlState.message
          ? h('p', { className: 'atm-muted', key: 'msg' }, t('controlOk').replace('{action}', controlState.message))
          : null,
      ]);
    }

    /**
     * Operator-only Reaper row: shows the external death process read fresh from disk by
     * the engine (`engine.reaper`) and lets the operator stop a stale-generation orphan.
     * Agents/tools cannot stop the Reaper — this is a deliberate operator surface.
     */
    function ReaperRow({ t, summary, controlState, runControl }) {
      const [armed, setArmed] = React.useState(false);
      const reaper = describeReaper(summary.reaper);
      const pending = controlState.pending === 'reaper-stop';
      const disabled = controlState.pending !== null;
      const stale = reaper.kind === 'stale';
      const stopped = reaper.kind === 'stopped';
      // Safety: only a STALE-generation Reaper may be stopped from the panel. A fresh
      // (heartbeat v2) Reaper is the mortality enforcer for the running population.
      const canStopReaper = stale;
      const isReaperAction = controlState.action === 'reaper-stop';
      const lastResult = isReaperAction && controlState.message === 'reaper-stop' ? controlState.result : null;
      const reaperError = isReaperAction ? controlState.error : null;

      const detailParts = [];
      if (stopped) {
        detailParts.push(t('reaperNotRunning'));
      } else {
        detailParts.push(`pid ${reaper.pid} · ${t('reaperAlive')}`);
        if (reaper.heartbeatAt) {
          detailParts.push(`${t('reaperHealthy')} ${fmtAgo(reaper.heartbeatAt)}${reaper.heartbeatVersion !== null ? ` (v${reaper.heartbeatVersion})` : ''}`);
        } else {
          detailParts.push(t('reaperStale'));
        }
        if (reaper.sweeps !== null) detailParts.push(`${reaper.sweeps} ${t('reaperSweeps')}`);
      }
      if (reaper.error) detailParts.push(reaper.error);

      return h('div', { className: 'atm-reaper', 'data-kind': reaper.kind }, [
        h('span', { className: 'atm-reaper-label', key: 'label' }, `${t('reaper')} —`),
        h('span', { className: 'atm-reaper-detail', key: 'detail', title: reaper.hint ?? reaper.note ?? '' }, detailParts.join(' · ')),
        stale ? h('span', { className: 'atm-reaper-stale', key: 'stale' }, `⚠ ${t('reaperStale')}`) : null,
        h('span', { className: 'atm-spacer', key: 'spacer' }),
        stopped
          ? null
          : canStopReaper
            ? (armed
              ? h('span', { className: 'atm-toolbar', key: 'armed' }, [
                h('button', {
                  key: 'confirm',
                  type: 'button',
                  className: 'atm-btn',
                  'data-variant': 'danger',
                  disabled,
                  onClick: () => {
                    setArmed(false);
                    runControl({ action: 'reaper-stop', confirm: 'STOP' });
                  },
                }, `${t('reaperConfirm')}${pending ? '…' : ''}`),
                h('button', {
                  key: 'cancel',
                  type: 'button',
                  className: 'atm-btn',
                  disabled,
                  onClick: () => setArmed(false),
                }, t('cancel')),
              ])
              : h('button', {
                key: 'stop-reaper',
                type: 'button',
                className: 'atm-btn',
                'data-variant': 'danger',
                disabled,
                title: t('reaperHint'),
                onClick: () => setArmed(true),
              }, t('reaperStop')))
            : h('span', { className: 'atm-note', key: 'healthy' }, t('reaperHealthyNote')),
        h('span', { className: 'atm-note', key: 'note' }, t('reaperHint')),
        stale ? h('p', { className: 'atm-warn', key: 'stale-warning' }, t('reaperStaleWarning')) : null,
        lastResult
          ? h('p', { className: lastResult.stopped ? 'atm-muted' : 'atm-warn', key: 'result' },
            lastResult.stopped
              ? `${t('reaperStopped')} (pid ${lastResult.pid ?? '—'})`
              : `${t('reaperStopFailed')}: ${lastResult.reason ?? t('none')}`)
          : null,
        controlState.error
          ? h('p', { className: 'atm-err', key: 'error' }, `${t('reaperStopFailed')}: ${errorText(reaperError ?? controlState.error)}${controlState.hint ? ` — ${controlState.hint}` : ''}`)
          : null,
      ]);
    }

    function RunwayCell({ row }) {
      return h('span', { className: 'atm-runway-cell' }, [
        h('span', { className: 'atm-runway', 'data-level': runwayLevel(row.runwayHours), key: 'bar' },
          h('i', { style: { width: `${runwayPercent(row.runwayHours)}%` } })),
        h('span', { className: 'atm-mono', key: 'text' }, fmtHours(row.runwayHours)),
      ]);
    }

    function StatusCell({ t, row }) {
      const label = row.status === 'condemned' ? t('condemned') : row.status === 'dead' ? t('dead') : t('alive');
      return h('span', { className: 'atm-status', 'data-status': row.status, title: row.cause ?? row.status },
        h('span', { className: 'atm-dot', 'aria-hidden': true }),
        label,
        row.cause ? h('span', { key: 'cause' }, ` · ${row.cause}`) : null);
    }

    /** Compact research badge for the agent table (`HOLD +0.2` / `AVOID -0.6` / `—`). */
    function ResearchBadge({ t, row }) {
      const badge = row.researchBadge ?? researchBadge(row.research);
      if (!badge.hasResearch) {
        return h('span', { className: 'atm-muted', title: t('researchBadgeHint') }, '—');
      }
      return h('span', {
        className: 'atm-research',
        'data-tone': badge.tone,
        'data-stale': badge.stale ? 'true' : undefined,
        title: `${t('researchBadgeHint')}${badge.title ? ` — ${badge.title}` : ''}`,
      }, badge.label);
    }

    function ResearchListBlock({ t, labelKey, items, emptyKey }) {
      return h('div', { className: 'atm-research-block' }, [
        h('b', { key: 'label' }, t(labelKey)),
        items.length === 0
          ? h('span', { className: 'atm-muted', key: 'empty' }, t(emptyKey))
          : h('ul', { className: 'atm-research-list', key: 'list' }, items.map((item, index) => h('li', { key: `${labelKey}-${index}` }, item))),
      ]);
    }

    /**
     * Detail-pane "Research — isolated hourly analyst" section: latest briefing,
     * catalysts/risks/sources, and the shadow-vs-influence mode from the engine status.
     */
    function ResearchSection({ t, research, researchStatus }) {
      const briefing = mapResearchBriefing(research);
      const modeKey = researchModeKey(researchStatus);
      const meta = [];
      if (researchStatus?.available) {
        meta.push(`${t('researchProvider')} ${researchStatus.provider ?? '—'} / ${t('researchModel')} ${researchStatus.model ?? '—'}`);
        if (researchStatus.intervalSec !== null) meta.push(`${t('researchInterval')} ${Math.round(researchStatus.intervalSec / 60)}m`);
        if (researchStatus.lastRunAt) meta.push(`${t('researchLastRun')} ${fmtAgo(researchStatus.lastRunAt)}`);
        if (researchStatus.runs !== null) meta.push(`${t('researchRuns')} ${fmtNum(researchStatus.runs)}`);
        if (researchStatus.errors !== null && researchStatus.errors > 0) meta.push(`${t('researchErrors')} ${fmtNum(researchStatus.errors)}`);
      }
      const children = [
        h('h4', { className: 'atm-detail-title', key: 'title' }, t('researchTitle')),
        h('p', { className: 'atm-note', key: 'mode' }, t(modeKey)),
      ];
      if (meta.length > 0) {
        children.push(h('div', { className: 'atm-research-meta', key: 'meta' }, meta.map((text, index) => h('span', { key: `meta-${index}` }, text))));
      }
      if (researchStatus?.disabledReason) {
        children.push(h('p', {
          className: 'atm-warn',
          key: 'disabled',
        }, t(researchStatus.disabledReason === 'disabled' ? 'researchDisabledConfig' : 'researchDisabled')));
      }
      if (!briefing) {
        children.push(h('p', { className: 'atm-empty', key: 'empty' }, t('researchEmpty')));
        return h('div', { className: 'atm-research-section', key: 'research' }, children);
      }
      const badge = researchBadge(briefing);
      const ageText = briefing.ageSec === null
        ? fmtAgo(briefing.at)
        : `${fmtAgo(briefing.at)} (${Math.round(briefing.ageSec)}s)`;
      children.push(h('div', { className: 'atm-research-head', key: 'head' }, [
        h('span', {
          className: 'atm-research',
          'data-tone': badge.tone,
          'data-stale': briefing.stale ? 'true' : undefined,
          key: 'verdict',
        }, badge.label),
        h('span', { className: 'atm-muted', key: 'age' }, `${t('researchAge')} ${ageText}`),
        briefing.stale ? h('span', { className: 'atm-warn', key: 'stale' }, `⚠ ${t('researchStale')}`) : null,
      ]));
      if (briefing.summary) {
        children.push(h('p', { className: 'atm-research-summary', key: 'summary' }, briefing.summary));
      }
      children.push(h('div', { className: 'atm-research-meta', key: 'metrics' }, [
        h('span', { key: 'verdict' }, `${t('researchVerdict')} ${briefing.verdict ?? '—'}`),
        h('span', { key: 'sentiment' }, `${t('researchSentiment')} ${briefing.sentiment === null ? '—' : briefing.sentiment.toFixed(2)}`),
        h('span', { key: 'confidence' }, `${t('researchConfidence')} ${briefing.confidence === null ? '—' : briefing.confidence.toFixed(2)}`),
      ]));
      children.push(h(ResearchListBlock, {
        key: 'catalysts',
        t,
        labelKey: 'researchCatalysts',
        items: briefing.catalysts,
        emptyKey: 'researchNoCatalysts',
      }));
      children.push(h(ResearchListBlock, {
        key: 'risks',
        t,
        labelKey: 'researchRisks',
        items: briefing.risks,
        emptyKey: 'researchNoRisks',
      }));
      children.push(h('div', { className: 'atm-research-block', key: 'sources' }, [
        h('b', { key: 'label' }, t('researchSources')),
        briefing.sources.length === 0
          ? h('span', { className: 'atm-muted', key: 'empty' }, t('researchNoSources'))
          : h('ul', { className: 'atm-research-list', key: 'list' }, briefing.sources.map((source) => h('li', { key: source.key }, [
            source.url
              ? h('a', {
                key: 'link',
                className: 'atm-source-link',
                href: source.url,
                target: '_blank',
                rel: 'noopener noreferrer',
              }, source.title)
              : h('span', { key: 'title' }, source.title),
            source.source ? h('span', { key: 'source', className: 'atm-muted' }, ` — ${source.source}`) : null,
            source.at ? h('span', { key: 'at', className: 'atm-muted' }, ` (${fmtAgo(source.at)})`) : null,
          ]))),
      ]));
      return h('div', { className: 'atm-research-section', key: 'research' }, children);
    }

    // -----------------------------------------------------------------------
    // operator controls: research cadence, rewards, leaderboards
    // -----------------------------------------------------------------------

    function SwitchButton({ on, label, onClick, title }) {
      return h('button', {
        type: 'button',
        className: 'atm-switch',
        'data-on': on ? 'true' : 'false',
        title: title ?? label,
        onClick,
      }, h('span', { className: 'atm-dot', 'aria-hidden': true }), label);
    }

    function CadenceOptionLabel({ t, option }) {
      return t(option.labelKey);
    }

    /** Research cadence segmented control (interval / pre-open / post-close / both). */
    function ResearchCadenceControl({ t, research, controlState, runControl }) {
      const currentKey = researchCadenceKey(research);
      const [cadence, setCadence] = React.useState(currentKey ?? 'interval:3600');
      const [enabled, setEnabled] = React.useState(research?.enabled !== false);
      const [influence, setInfluence] = React.useState(research?.influence !== false);
      React.useEffect(() => {
        if (currentKey) setCadence(currentKey);
        setEnabled(research?.enabled !== false);
        setInfluence(research?.influence !== false);
      }, [currentKey, research?.enabled, research?.influence]);

      const pending = controlState.pending === 'set-research-settings';
      const related = controlState.action === 'set-research-settings';
      const currentOption = RESEARCH_CADENCE_OPTIONS.find((option) => option.key === currentKey);
      const apply = () => {
        const settings = researchSettingsFromCadence(cadence, { enabled, influence });
        if (settings) runControl({ action: 'set-research-settings', settings });
      };

      return h('div', { className: 'atm-card-block' }, [
        h('h4', { className: 'atm-block-title', key: 'title' }, t('cadence')),
        research?.configured === false
          ? h('p', { className: 'atm-warn', key: 'disabled' }, t('researchDisabled'))
          : null,
        h('div', { className: 'atm-seg', key: 'seg' }, RESEARCH_CADENCE_OPTIONS.map((option) => h('button', {
          key: option.key,
          type: 'button',
          'data-active': cadence === option.key ? 'true' : 'false',
          onClick: () => setCadence(option.key),
        }, h(CadenceOptionLabel, { t, option })))),
        h('div', { className: 'atm-form-row', key: 'toggles' }, [
          h(SwitchButton, {
            key: 'enabled',
            label: t('cadenceEnabled'),
            on: enabled,
            onClick: () => setEnabled((value) => !value),
          }),
          h(SwitchButton, {
            key: 'influence',
            label: t('cadenceInfluence'),
            on: influence,
            title: t(influence ? 'researchInfluence' : 'researchShadow'),
            onClick: () => setInfluence((value) => !value),
          }),
        ]),
        h('div', { className: 'atm-preview', key: 'current' }, [
          h('span', { key: 'mode', className: 'atm-preview-row' },
            `${t('cadenceCurrent')}: ${currentOption ? t(currentOption.labelKey) : t('none')} · ${t('researchProvider')} ${research?.provider ?? '—'}/${t('researchModel')} ${research?.model ?? '—'}`),
          h('span', { key: 'next', className: 'atm-preview-row' },
            `${t('cadenceNextDue')} ${fmtAgo(research?.nextDueAt)} ${research?.nextDueAt ? `(${fmtDateTime(research.nextDueAt)})` : ''}`),
          research?.pausedReason ? h('span', { key: 'paused', className: 'atm-warn' }, research.pausedReason) : null,
        ]),
        h('div', { className: 'atm-form-row', key: 'actions' }, [
          h('button', {
            key: 'apply',
            type: 'button',
            className: 'atm-btn',
            'data-variant': 'primary',
            disabled: pending,
            onClick: apply,
          }, pending ? `${t('cadenceApply')}…` : t('cadenceApply')),
          related && controlState.error
            ? h('span', { key: 'err', className: 'atm-err' }, errorText(controlState.error))
            : null,
          related && controlState.message
            ? h('span', { key: 'ok', className: 'atm-muted' }, t('controlOk').replace('{action}', controlState.message))
            : null,
        ]),
      ]);
    }

    /** Rewards settings + live payout preview + last winners/history. */
    function RewardsControl({ t, rewards, history, controlState, runControl }) {
      const state = rewardsControlState(rewards);
      const [enabled, setEnabled] = React.useState(state.enabled);
      const [period, setPeriod] = React.useState(state.period);
      const [first, setFirst] = React.useState(String(Math.round(state.rankPercents[0] * 100)));
      const [second, setSecond] = React.useState(String(Math.round(state.rankPercents[1] * 100)));
      const [third, setThird] = React.useState(String(Math.round(state.rankPercents[2] * 100)));
      const [maxPerPeriod, setMaxPerPeriod] = React.useState(state.maxPerPeriodUsd === null ? '' : String(state.maxPerPeriodUsd));
      React.useEffect(() => {
        setEnabled(state.enabled);
        setPeriod(state.period);
        setFirst(String(Math.round(state.rankPercents[0] * 100)));
        setSecond(String(Math.round(state.rankPercents[1] * 100)));
        setThird(String(Math.round(state.rankPercents[2] * 100)));
        setMaxPerPeriod(state.maxPerPeriodUsd === null ? '' : String(state.maxPerPeriodUsd));
      }, [state.enabled, state.period, state.rankPercents.join(','), state.maxPerPeriodUsd]);

      const parsePercent = (value) => {
        const number = toNumber(value);
        return number === null ? 0 : number / 100;
      };
      const percents = [parsePercent(first), parsePercent(second), parsePercent(third)];
      const preview = rewardsPreview(rewards, percents);
      const pending = controlState.pending === 'set-reward-settings';
      const related = controlState.action === 'set-reward-settings';
      const winners = lastWinnerRows(rewards);
      const historyRows = rewardHistoryRows({ rewards: { history } });
      const apply = () => {
        const maxValue = maxPerPeriod.trim() === '' ? null : Number(maxPerPeriod);
        runControl({
          action: 'set-reward-settings',
          settings: { enabled, period, rankPercents: percents, maxPerPeriodUsd: maxValue },
        });
      };
      const capLabel = (key) => t(key === 'pool' ? 'rewardsPoolCap' : key === 'allocation' ? 'rewardsAllocationCap' : 'rewardsMaxCap');

      return h('div', { className: 'atm-card-block' }, [
        h('h4', { className: 'atm-block-title', key: 'title' }, t('rewards')),
        h('div', { className: 'atm-form-row', key: 'row1' }, [
          h(SwitchButton, {
            key: 'enabled',
            label: t('rewardsEnabled'),
            on: enabled,
            onClick: () => setEnabled((value) => !value),
          }),
          h('div', { className: 'atm-seg', key: 'period' }, ['daily', 'weekly', 'monthly'].map((value) => h('button', {
            key: value,
            type: 'button',
            'data-active': period === value ? 'true' : 'false',
            onClick: () => setPeriod(value),
          }, value === 'daily' ? t('rewardsDaily') : value === 'weekly' ? t('rewardsWeekly') : t('rewardsMonthly')))),
        ]),
        h('div', { className: 'atm-form-row', key: 'percents' }, [
          h('label', { className: 'atm-field', key: 'p1' }, `${t('rewardsFirst')} %`,
            h('input', { className: 'atm-num', type: 'number', min: 0, max: 50, step: 1, value: first, onChange: (event) => setFirst(event.target.value) })),
          h('label', { className: 'atm-field', key: 'p2' }, `${t('rewardsSecond')} %`,
            h('input', { className: 'atm-num', type: 'number', min: 0, max: 50, step: 1, value: second, onChange: (event) => setSecond(event.target.value) })),
          h('label', { className: 'atm-field', key: 'p3' }, `${t('rewardsThird')} %`,
            h('input', { className: 'atm-num', type: 'number', min: 0, max: 50, step: 1, value: third, onChange: (event) => setThird(event.target.value) })),
          h('label', { className: 'atm-field', key: 'max' }, t('rewardsMax'),
            h('input', {
              className: 'atm-num',
              type: 'number',
              min: 0,
              step: '0.01',
              placeholder: t('rewardsNoMax'),
              value: maxPerPeriod,
              onChange: (event) => setMaxPerPeriod(event.target.value),
            })),
        ]),
        h('div', { className: 'atm-preview', key: 'preview' }, [
          h('span', { key: 'bases', className: 'atm-preview-row' },
            `${t('rewardsCash')} ${fmtUsd(preview.accountCashUsd)} · ${t('rewardsPool')} ${fmtUsd(preview.poolUsd)} · ${t('rewardsCapRemaining')} ${fmtUsd(preview.allocationCapRemainingUsd)}`),
          h('span', { key: 'amounts', className: 'atm-preview-row' },
            preview.rankPercents.map((percent, index) => {
              const amount = preview.amounts[index];
              return h('span', { key: `amount-${index}` }, `${t(index === 0 ? 'rewardsFirst' : index === 1 ? 'rewardsSecond' : 'rewardsThird')} ${Math.round(percent * 100)}% ≈ `, h('span', { className: 'atm-pill-amount' }, fmtUsd(amount)), '  ');
            })),
          h('span', { key: 'total', className: 'atm-preview-row' },
            `${t('rewardsTotal')} ${fmtUsd(preview.totalUsd)}`,
            preview.capped ? ` · ${t('rewardsCappedBy')} ${capLabel(preview.cappedBy)}` : ''),
          h('span', { key: 'boundary', className: 'atm-muted' }, t('rewardsPayBoundary')),
        ]),
        h('div', { className: 'atm-form-row', key: 'status' }, [
          h('span', { key: 'last', className: 'atm-muted' }, `${t('rewardsLastRun')} ${fmtAgo(state.lastRunAt)}`),
          h('span', { key: 'next', className: 'atm-muted' }, `${t('rewardsNextRun')} ${fmtAgo(state.nextRunAt)}`),
        ]),
        h('div', { className: 'atm-form-row', key: 'actions' }, [
          h('button', {
            key: 'apply',
            type: 'button',
            className: 'atm-btn',
            'data-variant': 'primary',
            disabled: pending,
            onClick: apply,
          }, pending ? `${t('rewardsApply')}…` : t('rewardsApply')),
          related && controlState.error
            ? h('span', { key: 'err', className: 'atm-err' }, errorText(controlState.error))
            : null,
          related && controlState.message
            ? h('span', { key: 'ok', className: 'atm-muted' }, t('controlOk').replace('{action}', controlState.message))
            : null,
        ]),
        winners.length > 0
          ? h('div', { className: 'atm-plan-block', key: 'winners' }, [
            h('span', { className: 'atm-plan-label', key: 'label' }, t('rewardsLastWinners')),
            h('ul', { className: 'atm-plan-list', key: 'list' }, winners.map((winner) => h('li', { key: winner.key },
              `${MEDALS[winner.rank] ?? `#${winner.rank ?? '—'}`} ${winner.name} · ${fmtUsd(winner.amountUsd)}`))),
          ])
          : null,
        historyRows.length > 0
          ? h('div', { className: 'atm-plan-block', key: 'history' }, [
            h('span', { className: 'atm-plan-label', key: 'label' }, t('rewardsHistory')),
            h('div', { className: 'atm-lb-wrap', key: 'wrap' }, h('table', { className: 'atm-lb-table' }, [
              h('thead', { key: 'head' }, h('tr', null, [
                h('th', { key: 'period' }, t('rewardsPeriod')),
                h('th', { key: 'key' }, 'key'),
                h('th', { key: 'at' }, t('time')),
                h('th', { key: 'total' }, t('rewardsTotal')),
                h('th', { key: 'winners' }, t('rewardsLastWinners')),
              ])),
              h('tbody', { key: 'body' }, historyRows.map((entry) => h('tr', { key: entry.key }, [
                h('td', { key: 'period' }, entry.period ?? '—'),
                h('td', { key: 'key', className: 'atm-mono' }, entry.periodKey ?? '—'),
                h('td', { key: 'at', className: 'atm-muted' }, fmtAgo(entry.at)),
                h('td', { key: 'total', className: 'atm-mono' }, fmtUsd(entry.totalUsd)),
                h('td', { key: 'winners' }, entry.winners.map((winner) => `${MEDALS[winner.rank] ?? ''}${winner.name}:${fmtUsd(winner.amountUsd)}`).join(' · ')),
              ]))),
            ])),
          ])
          : h('p', { className: 'atm-empty', key: 'no-history' }, t('rewardsNoHistory')),
      ]);
    }

    /** Daily / weekly / monthly leaderboards from status.rankings. */
    function Leaderboards({ t, rankings, onSelect }) {
      const periods = leaderboardPeriods({ rankings });
      const [tab, setTab] = React.useState('daily');
      const rows = periods[tab] ?? [];
      return h('div', { className: 'atm-card-block' }, [
        h('h4', { className: 'atm-block-title', key: 'title' }, t('leaderboards'),
          h('span', { key: 'asof', className: 'atm-muted' }, `${t('lbAsOf')} ${fmtAgo(periods.asOf)}`)),
        h('div', { className: 'atm-seg', key: 'tabs' }, ['daily', 'weekly', 'monthly'].map((value) => h('button', {
          key: value,
          type: 'button',
          'data-active': tab === value ? 'true' : 'false',
          onClick: () => setTab(value),
        }, value === 'daily' ? t('lbDaily') : value === 'weekly' ? t('lbWeekly') : t('lbMonthly')))),
        rows.length === 0
          ? h('p', { className: 'atm-empty', key: 'empty' }, t('lbEmpty'))
          : h('div', { className: 'atm-lb-wrap', key: 'wrap' }, h('table', { className: 'atm-lb-table' }, [
            h('thead', { key: 'head' }, h('tr', null, [
              h('th', { key: 'rank' }, t('lbRank')),
              h('th', { key: 'name' }, t('lbName')),
              h('th', { key: 'pnlpct' }, t('lbPnlPct')),
              h('th', { key: 'pnlusd' }, t('lbPnlUsd')),
              h('th', { key: 'equity' }, t('lbEquity')),
              h('th', { key: 'trades' }, t('lbTrades')),
            ])),
            h('tbody', { key: 'body' }, rows.map((row) => h('tr', {
              key: row.key,
              'data-rank': row.rank,
              'data-top': row.rank <= 3 ? 'true' : 'false',
              onClick: () => {
                if (row.agentId) onSelect(row.agentId);
              },
            }, [
              h('td', { key: 'rank', className: 'atm-mono', title: `#${row.rank}` }, `${row.medal ?? ''}${row.medal ? ' ' : ''}#${row.rank}`),
              h('td', { key: 'name', title: row.name }, row.name),
              h('td', { key: 'pnlpct', className: `atm-mono ${(row.pnlPct ?? 0) > 0 ? 'atm-pos' : (row.pnlPct ?? 0) < 0 ? 'atm-neg' : ''}` }, fmtPct(row.pnlPct)),
              h('td', { key: 'pnlusd', className: `atm-mono ${(row.pnlUsd ?? 0) > 0 ? 'atm-pos' : (row.pnlUsd ?? 0) < 0 ? 'atm-neg' : ''}` }, fmtSignedUsd(row.pnlUsd)),
              h('td', { key: 'equity', className: 'atm-mono' }, fmtUsd(row.equityUsd)),
              h('td', { key: 'trades', className: 'atm-mono' }, fmtNum(row.trades)),
            ]))),
          ])),
      ]);
    }

    /** Operator controls section: research cadence, rewards, leaderboards. */
    function OperatorPanel({ t, snapshot, summary, controlState, runControl, onSelect }) {
      const data = snapshot.data ?? {};
      return h('div', { className: 'atm-section', key: 'operator' }, [
        h('h3', { className: 'atm-section-title', key: 'title' }, t('operatorControls')),
        h('div', { className: 'atm-operator-grid', key: 'grid' }, [
          h(ResearchCadenceControl, {
            key: 'cadence',
            t,
            research: summary.research,
            controlState,
            runControl,
          }),
          h(RewardsControl, {
            key: 'rewards',
            t,
            rewards: data.engine?.rewards ?? null,
            history: Array.isArray(data.rewards?.history) ? data.rewards.history : [],
            controlState,
            runControl,
          }),
          h(Leaderboards, {
            key: 'leaderboards',
            t,
            rankings: data.rankings ?? null,
            onSelect,
          }),
        ]),
      ]);
    }

    /** Compact ranking badges for the detail header (day/week/month). */
    function RankingBadges({ t, row }) {
      const badges = Array.isArray(row.rankBadges) ? row.rankBadges : [];
      if (badges.length === 0) return null;
      return h('div', { className: 'atm-rank-badges' }, badges.map((badge) => h('span', {
        key: badge.key,
        className: 'atm-rank-badge',
        'data-medal': badge.medal ? 'true' : 'false',
        title: badge.pct === null ? `#${badge.rank}` : `#${badge.rank} · ${fmtPct(badge.pct)}`,
      }, `${badge.medal ?? ''}${badge.medal ? ' ' : ''}${t(badge.labelKey)} #${badge.rank}`)));
    }

    /** Category-coloured strategy type chip (table + detail header). */
    function StrategyTypeChip({ t, strategy }) {
      if (!strategy) return null;
      return h('span', {
        className: 'atm-type-chip',
        'data-category': strategy.category,
        title: strategy.description || strategy.typeLabel,
      }, strategy.typeLabel);
    }

    /** Small engine-level bot-agent bridge status line (header). */
    function BotAgentBridgeLine({ t, engineAgents }) {
      if (!engineAgents || engineAgents.available !== true) {
        return h('p', { className: 'atm-bridge-line' }, t('botAgentBridgeOff'));
      }
      const parts = [];
      parts.push(h('b', { key: 'title' }, t('botAgentBridge')));
      if (engineAgents.enabled === false) parts.push(h('span', { key: 'enabled' }, t('disabled')));
      else if (engineAgents.configured === false) parts.push(h('span', { key: 'configured' }, t('researchDisabled')));
      else parts.push(h('span', { key: 'configured' }, 'configured'));
      parts.push(h('span', { key: 'model' }, `${engineAgents.provider ?? '—'}/${engineAgents.model ?? '—'}`));
      parts.push(h('span', { key: 'cadence' }, `${t('categoryDay')} ${engineAgents.dayLabel} · ${t('categorySwing')} ${engineAgents.swingLabel}`));
      parts.push(h('span', { key: 'runs' }, `${t('runs')} ${fmtNum(engineAgents.runs)} · ${t('errors')} ${fmtNum(engineAgents.errors)}`));
      parts.push(h('span', { key: 'next' }, `${t('nextReview')} ${fmtAgo(engineAgents.nextDueAt)}`));
      if (engineAgents.note) parts.push(h('span', { key: 'note', className: 'atm-muted' }, engineAgents.note));
      return h('p', { className: 'atm-bridge-line' }, parts);
    }

    /** Compact instruments badges (table row + detail header). */
    function InstrumentBadgeList({ t, badges, tooltip, emptyLabel }) {
      const list = Array.isArray(badges) ? badges : [];
      if (list.length === 0) {
        return h('span', { className: 'atm-instr-empty', title: tooltip ?? '' }, emptyLabel ?? t('instrumentsEmpty'));
      }
      const titles = tooltip && tooltip.length > 0 ? [t('allowedStructures'), tooltip] : [t('instruments')];
      return h('span', { className: 'atm-instr-badges', title: titles.join(' — ') }, list.map((badge) => h('span', {
        key: badge.key,
        className: 'atm-instr-badge',
        'data-kind': badge.key,
      }, t(badge.labelKey) ?? badge.label)));
    }

    /** Engine-header instruments / exposure line (`status.instruments` + account fields). */
    function InstrumentsLine({ t, instruments }) {
      if (!instruments || instruments.available !== true) {
        return h('p', { className: 'atm-bridge-line' }, t('instrumentsUnavailable'));
      }
      if (instruments.enabled === false) {
        return h('p', { className: 'atm-bridge-line' }, [h('b', { key: 'title' }, t('instruments')), h('span', { key: 'off' }, t('instrumentsOff'))]);
      }
      const caps = instruments.caps ?? {};
      const parts = [h('b', { key: 'title' }, t('instruments'))];
      if (instruments.account.optionsTradingLevel !== null) parts.push(h('span', { key: 'level' }, `${t('optionsLevel')} L${fmtNum(instruments.account.optionsTradingLevel)}`));
      if (instruments.allowShort === true) parts.push(h('span', { key: 'short' }, t('shortEnabled')));
      if (instruments.account.marginMultiplier !== null) parts.push(h('span', { key: 'margin' }, `${t('marginEnabled')} ${fmtNum(instruments.account.marginMultiplier)}x`));
      const capParts = [];
      if (caps.maxOptionPremiumPctEquity !== null) capParts.push(`${t('capOptionsPct')}${fmtPercentPoints(caps.maxOptionPremiumPctEquity * 100)} eq`);
      if (caps.maxShortPctEquity !== null) capParts.push(`${t('capShortPct')}${fmtPercentPoints(caps.maxShortPctEquity * 100)} eq`);
      if (caps.maxContracts !== null) capParts.push(`${t('maxContracts')} ${fmtNum(caps.maxContracts)}`);
      if (caps.minDTE !== null && caps.maxDTE !== null) capParts.push(`${t('dteRange')} ${fmtNum(caps.minDTE)}–${fmtNum(caps.maxDTE)}`);
      if (capParts.length > 0) parts.push(h('span', { key: 'caps' }, `${t('caps')}: ${capParts.join(' · ')}`));
      if (instruments.optionDataFeed) parts.push(h('span', { key: 'feed', className: 'atm-muted' }, instruments.optionDataFeed));
      const exposure = [];
      if (instruments.account.optionsBuyingPowerUsd !== null) exposure.push(`${t('optionsBP')} ${fmtUsd(instruments.account.optionsBuyingPowerUsd)}`);
      if (instruments.account.marginDebtUsd !== null) exposure.push(`${t('marginDebt')} ${fmtUsd(instruments.account.marginDebtUsd)}`);
      if (instruments.account.grossExposureUsd !== null) exposure.push(`${t('grossExposure')} ${fmtUsd(instruments.account.grossExposureUsd)}`);
      if (instruments.account.netExposureUsd !== null) exposure.push(`${t('netExposure')} ${fmtUsd(instruments.account.netExposureUsd)}`);
      if (exposure.length > 0) parts.push(h('span', { key: 'exposure', className: 'atm-exposure-line' }, exposure.join(' · ')));
      return h('p', { className: 'atm-bridge-line' }, parts);
    }

    /** "Last cycle" diagnostic line: why the bots did or did not trade this cycle. */
    function LastCycleLine({ t, lastCycle }) {
      if (!lastCycle || lastCycle.available !== true) {
        return h('p', { className: 'atm-bridge-line atm-muted' }, t('lastCycleEmpty'));
      }
      const parts = [h('b', { key: 'title' }, t('lastCycle'))];
      parts.push(h('span', { key: 'market' }, t(lastCycle.marketStateKey)));
      if (lastCycle.at) parts.push(h('span', { key: 'at', className: 'atm-muted' }, fmtAgo(lastCycle.at)));
      if (lastCycle.tradingSkipped === true && (lastCycle.orders ?? 0) === 0) {
        parts.push(h('span', { key: 'skip', className: 'atm-warn' }, t('tradingSkipped')));
      }
      parts.push(h('span', { key: 'exec' }, `${t('executions')} ${fmtNum(lastCycle.executions ?? 0)}`));
      parts.push(h('span', { key: 'orders' }, `${t('orders')} ${fmtNum(lastCycle.orders ?? 0)}`));
      if ((lastCycle.denied ?? 0) > 0) parts.push(h('span', { key: 'denied' }, `${t('denied')} ${fmtNum(lastCycle.denied)}`));
      if ((lastCycle.errors ?? 0) > 0) {
        parts.push(h('span', { key: 'errors', className: 'atm-warn' }, `${t('errors')} ${fmtNum(lastCycle.errors)}`));
      }
      if (lastCycle.topSkipText) {
        parts.push(h('span', { key: 'skips' }, `${t('topSkipReasons')}: ${lastCycle.topSkipText}`));
      }
      if (lastCycle.botReviews) {
        const reviews = lastCycle.botReviews;
        const reviewParts = [];
        if (reviews.due !== null) reviewParts.push(`${fmtNum(reviews.reviewed ?? 0)}/${fmtNum(reviews.due)}`);
        if (reviews.deferred !== null) reviewParts.push(`${t('deferred')} ${fmtNum(reviews.deferred)}`);
        if (reviews.errors !== null && reviews.errors > 0) reviewParts.push(`${t('errors')} ${fmtNum(reviews.errors)}`);
        if (reviews.paused) reviewParts.push(t('paused'));
        if (reviewParts.length > 0) parts.push(h('span', { key: 'reviews' }, `${t('botReviews')}: ${reviewParts.join(' · ')}`));
        if (reviews.note) parts.push(h('span', { key: 'note', className: 'atm-muted' }, reviews.note));
      }
      return h('p', { className: 'atm-bridge-line' }, parts);
    }

    /** Informational broker capability warning (shorting/margin restricted on the paper account). */
    function CapabilityWarningLine({ t, capability }) {
      if (!capability || capability.show !== true) return null;
      const disabled = [];
      if (capability.shortStockDisabled) disabled.push(t('shortEnabled'));
      if (capability.marginDisabled) disabled.push(t('marginEnabled'));
      if (capability.creditOptionsDisabled) disabled.push(t('badgeOptions'));
      const accountParts = [];
      if (capability.account.shortingEnabled !== null) {
        accountParts.push(`${t('shortEnabled')} ${capability.account.shortingEnabled ? t('onLabel') : t('offLabel')}`);
      }
      if (capability.account.marginMultiplier !== null) accountParts.push(`${t('marginEnabled')} ${fmtNum(capability.account.marginMultiplier)}x`);
      if (capability.account.optionsTradingLevel !== null) accountParts.push(`${t('optionsLevel')} L${fmtNum(capability.account.optionsTradingLevel)}`);
      return h('p', { className: 'atm-cap-warning' }, [
        h('span', { key: 'icon', 'aria-hidden': true }, '⚠ '),
        h('b', { key: 'title' }, t('brokerRestricted')),
        h('span', { key: 'detail' }, `: ${disabled.join('/')} ${t('brokerRestrictedUnavailable')} — ${t('brokerRestrictedRemain')}`),
        accountParts.length > 0
          ? h('span', { key: 'account', className: 'atm-muted' }, ` · ${t('accountFacts')}: ${accountParts.join(' · ')}`)
          : null,
      ]);
    }

    /** "Instrument playbook" block: family + bullish/bearish/neutral structures. */
    function InstrumentPlaybookSection({ t, playbook }) {
      if (!playbook || playbook.available !== true) {
        return h('div', { className: 'atm-section' }, [
          h('h4', { className: 'atm-detail-title', key: 'title' }, t('instrumentPlaybook')),
          h('p', { className: 'atm-empty', key: 'empty' }, t('playbookEmpty')),
        ]);
      }
      const cards = [
        { key: 'bullish', labelKey: 'playbookBullish', items: playbook.bullish },
        { key: 'bearish', labelKey: 'playbookBearish', items: playbook.bearish },
        { key: 'neutral', labelKey: 'playbookNeutral', items: playbook.neutral },
      ].filter((card) => card.items.length > 0);
      if (playbook.structures.length > 0) {
        cards.push({ key: 'structures', labelKey: 'playbookStructures', items: playbook.structures });
      }
      return h('div', { className: 'atm-section' }, [
        h('h4', { className: 'atm-detail-title', key: 'title' }, t('instrumentPlaybook'),
          playbook.familyLabel ? h('span', { key: 'family', className: 'atm-muted' }, ` · ${t('playbookFamily')} ${playbook.familyLabel}`) : null),
        h('div', { className: 'atm-playbook-grid', key: 'grid' }, cards.map((card) => h('div', {
          key: card.key,
          className: 'atm-playbook-card',
          'data-side': card.key,
        }, [
          h('span', { className: 'atm-plan-label', key: 'label' }, t(card.labelKey)),
          h('div', { className: 'atm-chips', key: 'items' }, card.items.map((item) => h('span', { className: 'atm-param', key: item.key }, item.label))),
        ]))),
      ]);
    }

    /** "Bot agent" policy section: the bot's own isolated brain decision. */
    function BotAgentSection({ t, policy }) {
      if (!policy || policy.available !== true) {
        return h('div', { className: 'atm-section' }, [
          h('h4', { className: 'atm-detail-title', key: 'title' }, t('botAgent')),
          h('p', { className: 'atm-empty', key: 'empty' }, t('botAgentEmpty')),
        ]);
      }
      const stance = policy.stanceBadge;
      const metrics = [];
      if (policy.sizeMultiplier !== null) metrics.push(h('span', { className: 'atm-botagent-metric', key: 'size' }, `${t('sizeMultiplier')} `, h('b', null, `${policy.sizeMultiplier.toFixed(2)}`)));
      if (policy.riskMultiplier !== null) metrics.push(h('span', { className: 'atm-botagent-metric', key: 'risk' }, `${t('riskMultiplier')} `, h('b', null, `${policy.riskMultiplier.toFixed(2)}`)));
      if (policy.confidence !== null) metrics.push(h('span', { className: 'atm-botagent-metric', key: 'conf' }, `${t('confidence')} `, h('b', null, `${Math.round(policy.confidence * 100)}%`)));
      if (policy.exitPressure && policy.exitPressure !== 'none') metrics.push(h('span', { className: 'atm-botagent-metric', key: 'exit' }, `${t('exitPressure')} `, h('b', null, policy.exitPressure)));
      if (policy.reviewCount !== null) metrics.push(h('span', { className: 'atm-botagent-metric', key: 'count' }, `${t('reviewCount')} `, h('b', null, fmtNum(policy.reviewCount))));
      metrics.push(h('span', { className: 'atm-botagent-metric', key: 'last' }, `${t('lastReview')} `, h('b', null, policy.at ? fmtAgo(policy.at) : '—')));
      metrics.push(h('span', { className: 'atm-botagent-metric', key: 'next' }, `${t('nextReview')} `, h('b', null, policy.nextReviewAt ? fmtAgo(policy.nextReviewAt) : '—')));
      if (policy.reviewSec !== null) metrics.push(h('span', { className: 'atm-botagent-metric', key: 'interval' }, `${t('reviewInterval')} `, h('b', null, estimatedIntervalLabel(policy.reviewSec))));
      return h('div', { className: 'atm-section' }, [
        h('div', { className: 'atm-toolbar', key: 'title' }, [
          h('h4', { className: 'atm-detail-title', key: 'title', style: { margin: 0 } }, t('botAgent')),
          h('span', {
            key: 'stance',
            className: 'atm-stance',
            'data-tone': stance.tone,
            title: policy.thesis ?? '',
          }, `${t('stance')}: ${t(stance.labelKey)}`),
          policy.stale ? h('span', { key: 'stale', className: 'atm-warn' }, t('botAgentStale')) : null,
        ]),
        h('div', { className: 'atm-botagent', key: 'metrics' }, [
          h('div', { className: 'atm-botagent-card', key: 'metrics' }, [
            h('span', { className: 'atm-plan-label', key: 'label' }, t('botAgent')),
            h('div', { className: 'atm-botagent-metrics', key: 'values' }, metrics),
          ]),
          policy.thesis
            ? h('div', { className: 'atm-botagent-card', key: 'thesis' }, [
              h('span', { className: 'atm-plan-label', key: 'label' }, t('thesis')),
              h('p', { className: 'atm-plan-text', key: 'text' }, policy.thesis),
            ])
            : null,
          policy.plan.length > 0
            ? h('div', { className: 'atm-botagent-card', key: 'plan' }, [
              h('span', { className: 'atm-plan-label', key: 'label' }, t('planNext')),
              h('ul', { className: 'atm-plan-list', key: 'list' }, policy.plan.map((item, index) => h('li', { key: `plan-${index}` }, item))),
            ])
            : null,
          policy.watch.length > 0
            ? h('div', { className: 'atm-botagent-card', key: 'watch' }, [
              h('span', { className: 'atm-plan-label', key: 'label' }, t('watchlist')),
              h('div', { className: 'atm-chips', key: 'chips' }, policy.watch.map((symbol) => h('span', { className: 'atm-param', key: symbol }, symbol))),
            ])
            : null,
          policy.instrument
            ? h('div', { className: 'atm-botagent-card', key: 'instrument' }, [
              h('span', { className: 'atm-plan-label', key: 'label' }, t('instrumentPlan')),
              h('div', { className: 'atm-botagent-metrics', key: 'values' }, [
                h('span', { className: 'atm-botagent-metric', key: 'prefer' }, `${t('prefer')} `, h('b', null, policy.instrument.auto ? t('autoSelect') : policy.instrument.preferLabel ?? '—')),
                policy.instrument.maxPremiumUsd !== null
                  ? h('span', { className: 'atm-botagent-metric', key: 'premium' }, `${t('maxPremium')} `, h('b', null, fmtUsd(policy.instrument.maxPremiumUsd)))
                  : null,
                policy.instrument.maxContracts !== null
                  ? h('span', { className: 'atm-botagent-metric', key: 'contracts' }, `${t('maxContracts')} `, h('b', null, fmtNum(policy.instrument.maxContracts)))
                  : null,
                policy.instrument.dteMin !== null || policy.instrument.dteMax !== null
                  ? h('span', { className: 'atm-botagent-metric', key: 'dte' }, `${t('dteWindow')} `, h('b', null, `${fmtNum(policy.instrument.dteMin)}–${fmtNum(policy.instrument.dteMax)}`))
                  : null,
              ]),
            ])
            : null,
        ]),
      ]);
    }

    function StrategyPlanSection({ t, plan }) {
      if (!plan || !plan.hasContent) {
        return h('div', { className: 'atm-section' }, [
          h('h4', { className: 'atm-detail-title', key: 'title' }, t('plan')),
          h('p', { className: 'atm-empty', key: 'empty' }, t('planEmpty')),
        ]);
      }
      const blocks = [];
      if (plan.summary) blocks.push(h('div', { className: 'atm-plan-block', key: 'summary' }, [
        h('span', { className: 'atm-plan-label', key: 'label' }, t('planSummary')),
        h('p', { className: 'atm-plan-text', key: 'text' }, plan.summary),
      ]));
      if (plan.entryRule) blocks.push(h('div', { className: 'atm-plan-block', key: 'entry' }, [
        h('span', { className: 'atm-plan-label', key: 'label' }, t('planEntry')),
        h('p', { className: 'atm-plan-text', key: 'text' }, plan.entryRule),
      ]));
      if (plan.exitRules.length > 0) blocks.push(h('div', { className: 'atm-plan-block', key: 'exit' }, [
        h('span', { className: 'atm-plan-label', key: 'label' }, t('planExit')),
        h('ul', { className: 'atm-plan-list', key: 'list' }, plan.exitRules.map((rule, index) => h('li', { key: `exit-${index}` }, rule))),
      ]));
      if (plan.riskRule) blocks.push(h('div', { className: 'atm-plan-block', key: 'risk' }, [
        h('span', { className: 'atm-plan-label', key: 'label' }, t('planRisk')),
        h('p', { className: 'atm-plan-text', key: 'text' }, plan.riskRule),
      ]));
      if (plan.nextStep) blocks.push(h('div', { className: 'atm-plan-block', key: 'next' }, [
        h('span', { className: 'atm-plan-label', key: 'label' }, t('planNext')),
        h('p', { className: 'atm-plan-text', key: 'text' }, plan.nextStep),
      ]));
      if (plan.triggers.length > 0) blocks.push(h('div', { className: 'atm-plan-block', key: 'triggers' }, [
        h('span', { className: 'atm-plan-label', key: 'label' }, t('planTriggers')),
        h('div', { className: 'atm-chips', key: 'chips' }, plan.triggers.map((trigger) => h('span', { className: 'atm-param', key: trigger.key }, [
          h('b', { key: 'l' }, trigger.label),
          h('span', { key: 'v' }, trigger.value),
        ]))),
      ]));
      blocks.push(h('div', { className: 'atm-plan-block', key: 'position' }, [
        h('span', { className: 'atm-plan-label', key: 'label' }, t('planPosition')),
        plan.position
          ? h('div', { className: 'atm-chips', key: 'chips' }, [
            h('span', { className: 'atm-param', key: 'symbol' }, h('b', null, t('symbol')), plan.position.symbol ?? '—'),
            h('span', { className: 'atm-param', key: 'qty' }, h('b', null, t('qty')), plan.position.qtyText),
            h('span', { className: 'atm-param', key: 'avg' }, h('b', null, t('avgPrice')), fmtUsd(plan.position.avgPriceUsd)),
            h('span', { className: 'atm-param', key: 'stop' }, h('b', null, t('planStop')), fmtUsd(plan.position.stopPriceUsd)),
            h('span', { className: 'atm-param', key: 'target' }, h('b', null, t('planTarget')), fmtUsd(plan.position.targetPriceUsd)),
            h('span', { className: 'atm-param', key: 'bars' }, h('b', null, t('planBars')), `${fmtNum(plan.position.barsHeld)}/${fmtNum(plan.position.maxHoldBars)}`),
          ])
          : h('p', { className: 'atm-empty', key: 'empty' }, t('planNoPosition')),
      ]));
      if (plan.nextResearchAt) blocks.push(h('div', { className: 'atm-plan-block', key: 'research' }, [
        h('span', { className: 'atm-plan-label', key: 'label' }, t('planNextResearch')),
        h('p', { className: 'atm-plan-text', key: 'text' }, `${fmtAgo(plan.nextResearchAt)} (${fmtDateTime(plan.nextResearchAt)})`),
      ]));
      return h('div', { className: 'atm-section' }, [
        h('h4', { className: 'atm-detail-title', key: 'title' }, t('plan')),
        ...blocks,
      ]);
    }

    /** Full order/fill history table ("Transactions"). */
    function TransactionsSection({ t, row }) {
      const rows = Array.isArray(row.transactions) ? row.transactions : [];
      return h('div', { className: 'atm-section' }, [
        h('h4', { className: 'atm-detail-title', key: 'title' }, `${t('tx')} · ${fmtNum(rows.length)}`),
        rows.length === 0
          ? h('p', { className: 'atm-empty', key: 'empty' }, t('txEmpty'))
          : h('div', { className: 'atm-lb-wrap', key: 'wrap' }, h('table', { className: 'atm-lb-table' }, [
            h('thead', { key: 'head' }, h('tr', null, [
              h('th', { key: 'time' }, t('time')),
              h('th', { key: 'side' }, t('side')),
              h('th', { key: 'symbol' }, t('symbol')),
              h('th', { key: 'qty' }, t('qty')),
              h('th', { key: 'price' }, t('price')),
              h('th', { key: 'notional' }, t('notional')),
              h('th', { key: 'realized' }, t('realized')),
              h('th', { key: 'order' }, t('txOrderId')),
            ])),
            h('tbody', { key: 'body' }, rows.map((order) => h('tr', { key: order.key }, [
              h('td', { key: 'time', className: 'atm-muted', title: fmtDateTime(order.at) }, fmtAgo(order.at)),
              h('td', { key: 'side', className: `atm-side ${order.side === 'buy' ? 'atm-pos' : order.side === 'sell' ? 'atm-neg' : ''}`, 'data-side': order.side },
                order.side === 'sell' ? t('sell') : order.side === 'buy' ? t('buy') : '—'),
              h('td', { key: 'symbol', className: 'atm-mono' }, order.symbol),
              h('td', { key: 'qty', className: 'atm-mono' }, order.qtyText),
              h('td', { key: 'price', className: 'atm-mono' }, fmtUsd(order.priceUsd)),
              h('td', { key: 'notional', className: 'atm-mono' }, fmtUsd(order.notionalUsd)),
              h('td', { key: 'realized', className: `atm-mono ${(order.realizedPlUsd ?? 0) > 0 ? 'atm-pos' : (order.realizedPlUsd ?? 0) < 0 ? 'atm-neg' : ''}` }, fmtSignedUsd(order.realizedPlUsd)),
              h('td', { key: 'order', className: 'atm-muted atm-mono', title: order.orderId ?? '' }, order.orderId ?? '—'),
            ]))),
          ])),
      ]);
    }

    /** Runway bar fill percent: 72 h = healthy full bar; unknown/dead = 0. */
    const RUNWAY_FULL_HOURS = 72;
    function runwayPercent(hours) {
      const number = toNumber(hours);
      if (number === null) return 0;
      return Math.max(0, Math.min(100, (number / RUNWAY_FULL_HOURS) * 100));
    }

    /** 'ok' | 'warn' | 'crit' — a colour level derived from runway only. */
    function runwayLevel(hours) {
      const number = toNumber(hours);
      if (number === null) return 'crit';
      if (number < 6) return 'crit';
      if (number < 24) return 'warn';
      return 'ok';
    }

    // -----------------------------------------------------------------------
    // agent table
    // -----------------------------------------------------------------------

    const TABLE_COLUMNS = [
      { key: 'index', label: '#', sortable: false, width: '30px' },
      { key: 'name', labelKey: 'agent', sortable: true },
      { key: 'basket', labelKey: 'basket', sortable: false },
      { key: 'generation', labelKey: 'gen', sortable: true },
      { key: 'strategyType', labelKey: 'strategyType', sortable: false },
      { key: 'estInterval', labelKey: 'estInterval', sortable: false },
      { key: 'instruments', labelKey: 'instruments', sortable: false },
      { key: 'stance', labelKey: 'stance', sortable: false },
      { key: 'genome', labelKey: 'genome', sortable: false },
      { key: 'trading', labelKey: 'trading', sortable: false },
      { key: 'research', labelKey: 'research', sortable: false },
      { key: 'equityUsd', labelKey: 'equity', sortable: true },
      { key: 'pnlUsd', labelKey: 'pnl', sortable: true },
      { key: 'dayPnlPct', labelKey: 'dayPnl', sortable: true },
      { key: 'trend', labelKey: 'trend', sortable: false },
      { key: 'runwayHours', labelKey: 'runway', sortable: true },
      { key: 'status', labelKey: 'statusLabel', sortable: true },
      { key: 'positions', labelKey: 'positions', sortable: false },
    ];

    function AgentTable({ t, rows, selectedId, onSelect, strategyMix }) {
      const [sortKey, setSortKey] = React.useState('pnlUsd');
      const [direction, setDirection] = React.useState('desc');
      const [filter, setFilter] = React.useState('all');
      const [category, setCategory] = React.useState('all');
      const [query, setQuery] = React.useState('');

      const visible = React.useMemo(
        () => sortAgentRows(filterAgentRows(filterRowsByCategory(rows, category), filter, query), sortKey, direction),
        [rows, category, filter, query, sortKey, direction],
      );
      const categoryOptions = React.useMemo(
        () => categoryTabs(strategyMix ? { strategyMix } : null, rows),
        [strategyMix, rows],
      );

      const onSort = (key) => {
        if (!SORTABLE_KEYS.has(key)) return;
        if (sortKey === key) setDirection(direction === 'asc' ? 'desc' : 'asc');
        else {
          setSortKey(key);
          setDirection(key === 'name' || key === 'generation' || key === 'status' ? 'asc' : 'desc');
        }
      };

      const showCondemned = rows.some((row) => row.status === 'condemned');
      const filters = STATUS_FILTERS.filter((value) => value !== 'condemned' || showCondemned);

      return h('div', { className: 'atm-section' }, [
        h('div', { className: 'atm-cat-tabs', key: 'categories' }, categoryOptions.map((option) => h('button', {
          key: option.key,
          type: 'button',
          className: 'atm-cat-tab',
          'data-active': category === option.key ? 'true' : 'false',
          'data-category': option.key,
          onClick: () => setCategory(option.key),
          title: option.label,
        }, `${t(option.labelKey)} (${fmtNum(option.count)})`))),
        h('div', { className: 'atm-toolbar', key: 'toolbar' }, [
          h('h3', { className: 'atm-section-title', key: 'title' }, `${t('agents')} · ${fmtNum(visible.length)} ${t('rows')}`),
          h('span', { className: 'atm-muted', key: 'hint' }, t('clickHint')),
          h('span', { className: 'atm-spacer', key: 'spacer' }),
          filters.map((value) => h('button', {
            key: value,
            type: 'button',
            className: 'atm-chip',
            'data-active': filter === value ? 'true' : 'false',
            onClick: () => setFilter(value),
          }, value === 'all' ? t('filterAll') : value === 'alive' ? t('filterAlive') : value === 'dead' ? t('filterDead') : t('filterCondemned'))),
          h('input', {
            key: 'search',
            className: 'atm-input',
            type: 'search',
            placeholder: t('search'),
            value: query,
            onChange: (event) => setQuery(event.target.value),
            'aria-label': t('search'),
          }),
        ]),
        rows.length === 0
          ? h('p', { className: 'atm-muted', key: 'empty' }, t('noAgents'))
          : h('div', { className: 'atm-table-wrap', key: 'wrap' },
            h('table', { className: 'atm-table' }, [
              h('thead', { key: 'head' }, h('tr', null, TABLE_COLUMNS.map((column) => h('th', {
                key: column.key,
                className: column.sortable ? 'atm-sortable' : undefined,
                'data-sorted': column.sortable && sortKey === column.key ? 'true' : undefined,
                style: column.width ? { width: column.width } : undefined,
                title: column.sortable ? 'sort' : undefined,
                onClick: column.sortable ? () => onSort(column.key) : undefined,
              }, `${column.labelKey ? t(column.labelKey) : column.label}${column.sortable && sortKey === column.key ? (direction === 'asc' ? ' ↑' : ' ↓') : ''}`)))),
              h('tbody', { key: 'body' }, visible.map((row) => h('tr', {
                key: row.id,
                'data-status': row.status,
                'data-clickable': 'true',
                'data-selected': row.id === selectedId ? 'true' : undefined,
                tabIndex: 0,
                'aria-selected': row.id === selectedId,
                onClick: () => onSelect(row.id),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
                    event.preventDefault();
                    onSelect(row.id);
                  }
                },
              }, [
                h('td', { key: 'i', className: 'atm-muted atm-mono' }, row.index),
                h('td', { key: 'name' }, h('span', { className: 'atm-name' }, [
                  h('span', { className: 'atm-name-main', key: 'n', title: row.name }, row.name),
                  h('span', { className: 'atm-name-sub atm-mono', key: 'id', title: row.id }, row.shortId),
                ])),
                h('td', { key: 'basket', className: 'atm-muted', title: row.basket.length > 0 ? row.basket.join(', ') : '' }, row.basketText ?? '—'),
                h('td', { key: 'gen', className: 'atm-mono' }, fmtNum(row.generation)),
                h('td', { key: 'strategyType' }, h(StrategyTypeChip, { t, strategy: row.strategy })),
                h('td', { key: 'estInterval', className: 'atm-interval', title: row.strategy?.timeframe ?? '' }, row.intervalLabel),
                h('td', { key: 'instruments', title: row.instrumentTooltip ?? '' }, h(InstrumentBadgeList, {
                  t,
                  badges: row.instrumentBadges,
                  tooltip: row.instrumentTooltip,
                  emptyLabel: t('instrumentsEmpty'),
                })),
                h('td', { key: 'stance' }, row.stanceBadge
                  ? h('span', { className: 'atm-stance-chip', 'data-tone': row.stanceBadge.tone, title: row.policy?.thesis ?? '' }, t(row.stanceBadge.labelKey))
                  : h('span', { className: 'atm-muted' }, '—')),
                h('td', { key: 'genome', title: row.genomeParamsText }, row.genomeText),
                h('td', { key: 'trading', title: row.specParamsText }, [
                  h('span', { key: 'spec' }, row.specText ?? t('none')),
                  row.tradingDiffers ? h('span', { key: 'diff', className: 'atm-warn', title: t('specDiffers') }, ' ≠') : null,
                ]),
                h('td', { key: 'research', title: row.research?.summary ?? '' }, h(ResearchBadge, { t, row })),
                h('td', { key: 'equity', className: 'atm-mono' }, fmtUsd(row.liveEquityUsd ?? row.equityUsd)),
                h('td', {
                  key: 'pnl',
                  className: `atm-mono ${row.pnlUsd === null ? '' : row.pnlUsd > 0 ? 'atm-pos' : row.pnlUsd < 0 ? 'atm-neg' : ''}`,
                }, `${fmtSignedUsd(row.pnlUsd)}${row.pnlPct === null ? '' : ` (${fmtPercentPoints(row.pnlPct)})`}`),
                h('td', {
                  key: 'day',
                  className: `atm-mono ${((row.liveDayPnlPct ?? row.dayPnlPct) ?? 0) > 0 ? 'atm-pos' : ((row.liveDayPnlPct ?? row.dayPnlPct) ?? 0) < 0 ? 'atm-neg' : ''}`,
                }, fmtPct(row.liveDayPnlPct ?? row.dayPnlPct)),
                h('td', { key: 'trend' }, h(Sparkline, { values: row.sparkline, direction: row.liveDirection ?? 'flat', width: 64, height: 18 })),
                h('td', { key: 'runway' }, h(RunwayCell, { row })),
                h('td', { key: 'status' }, h(StatusCell, { t, row })),
                h('td', {
                  key: 'positions',
                  className: 'atm-mono',
                  title: `${t('positionsCount')} ${row.livePositions ?? row.positionCount} · ${t('tradesCount')} ${row.tradesCount}`,
                }, `${row.livePositions ?? row.positionCount} / ${row.tradesCount}`),
              ]))),
            ])),
      ]);
    }

    // -----------------------------------------------------------------------
    // agent detail (holdings + activity + strategy + costs + death)
    // -----------------------------------------------------------------------

    function DetailKv({ items }) {
      return h('div', { className: 'atm-kv' }, items
        .filter((item) => item && item.value !== undefined && item.value !== null)
        .map((item) => h('div', { className: 'atm-kv-item', key: item.key }, [
          h('span', { className: 'atm-kv-k', key: 'k' }, item.label),
          h('span', { className: 'atm-kv-v', key: 'v', title: typeof item.value === 'string' ? item.value : undefined }, item.value),
        ])));
    }

    function HoldingsTable({ t, row }) {
      const positions = Array.isArray(row.positionRows) ? row.positionRows : [];
      if (positions.length === 0) return h('p', { className: 'atm-empty' }, t('noPositions'));
      const summary = row.positionSummary ?? {};
      const totals = [];
      if (summary.stock) totals.push(`${t('badgeStock')} ${fmtNum(summary.stock.long)} ${t('longPos')} / ${fmtNum(summary.stock.short)} ${t('shortPos')}`);
      if (summary.options) totals.push(`${t('badgeOptions')} ${fmtNum(summary.options.calls + summary.options.puts)} (${fmtNum(summary.options.calls)} ${t('callPos')} / ${fmtNum(summary.options.puts)} ${t('putPos')})`);
      if (summary.spreadGroups > 0) totals.push(`${t('badgeSpreads')} ${fmtNum(summary.spreadGroups)}`);
      if (row.grossExposureUsd !== null && row.grossExposureUsd !== undefined) totals.push(`${t('grossExposure')} ${fmtUsd(row.grossExposureUsd)}`);
      if (row.netExposureUsd !== null && row.netExposureUsd !== undefined) totals.push(`${t('netExposure')} ${fmtUsd(row.netExposureUsd)}`);
      if (row.marginDebtUsd !== null && row.marginDebtUsd !== undefined) totals.push(`${t('marginDebt')} ${fmtUsd(row.marginDebtUsd)}`);
      return h('div', { className: 'atm-table-wrap' }, h('table', { className: 'atm-detail-table' }, [
        h('thead', { key: 'head' }, h('tr', null, [
          h('th', { key: 'symbol' }, t('symbol')),
          h('th', { key: 'side' }, t('sideLabel')),
          h('th', { key: 'qty' }, t('qty')),
          h('th', { key: 'avg' }, t('avgPrice')),
          h('th', { key: 'mv' }, t('marketValue')),
          h('th', { key: 'unrl' }, t('unrealized')),
          h('th', { key: 'opened' }, t('openedAt')),
        ])),
        h('tbody', { key: 'body' }, positions.map((position) => h('tr', {
          key: position.key,
          'data-side': position.side,
        }, [
          h('td', { key: 'symbol' }, [
            h('div', { key: 'sym', className: 'atm-mono', title: position.symbol }, position.isOption ? (position.option?.underlying ?? position.symbol) : position.symbol),
            position.isOption
              ? h('div', { key: 'opt', className: 'atm-option-meta' }, [
                h('span', { key: 's' }, `${t('strike')} `, h('b', null, fmtUsd(position.option.strikeUsd))),
                h('span', { key: 'exp' }, `${t('expiry')} `, h('b', null, position.option.expiryLabel ?? '—'), ` · ${t('dte')} `, h('b', null, position.option.dteLabel ?? '—')),
                position.groupShort ? h('span', { key: 'grp', className: 'atm-group-tag', title: position.groupId }, `${t('spreadGroup')} ${position.groupShort}`) : null,
              ])
              : null,
          ]),
          h('td', { key: 'side' }, h('span', {
            key: 'chip',
            className: 'atm-side-chip',
            'data-side': position.side,
            title: position.structure ? instrumentStructureLabel(position.structure) : position.side,
          }, position.side)),
          h('td', { key: 'qty', className: 'atm-mono' }, position.qtyText),
          h('td', { key: 'avg', className: 'atm-mono' }, fmtUsd(position.avgPriceUsd)),
          h('td', { key: 'mv', className: 'atm-mono' }, fmtUsd(position.marketValueUsd)),
          h('td', {
            key: 'unrl',
            className: `atm-mono ${(position.unrealizedPlUsd ?? 0) > 0 ? 'atm-pos' : (position.unrealizedPlUsd ?? 0) < 0 ? 'atm-neg' : ''}`,
          }, fmtSignedUsd(position.unrealizedPlUsd)),
          h('td', { key: 'opened', className: 'atm-muted', title: fmtDateTime(position.openedAt) }, fmtAgo(position.openedAt)),
        ]))),
        totals.length > 0
          ? h('tfoot', { key: 'foot' }, h('tr', null, h('td', { colSpan: 7, className: 'atm-exposure-line' }, `${t('positionTotals')}: ${totals.join(' · ')}`)))
          : null,
      ]));
    }

    function ActivityFeed({ t, row }) {
      if (row.activity.length === 0) return h('p', { className: 'atm-empty' }, t('noTrades'));
      return h('ul', { className: 'atm-activity' }, row.activity.map((trade) => h('li', {
        key: trade.key,
        'data-side': trade.side,
        title: fmtDateTime(trade.at),
      }, [
        h('span', { key: 'time', className: 'atm-muted' }, fmtAgo(trade.at)),
        h('span', { key: 'side', className: 'atm-side', 'data-side': trade.side }, trade.side === 'sell' ? t('sell') : trade.side === 'buy' ? t('buy') : '—'),
        h('span', { key: 'symbol', className: 'atm-mono' }, trade.symbol),
        h('span', { key: 'qty', className: 'atm-mono' }, trade.qtyText),
        h('span', { key: 'price', className: 'atm-mono' }, `@ ${fmtUsd(trade.priceUsd)}`),
        h('span', { key: 'notional', className: 'atm-muted atm-mono' }, fmtUsd(trade.notionalUsd)),
        trade.realizedPlUsd === null
          ? null
          : h('span', {
            key: 'realized',
            className: `atm-mono ${trade.realizedPlUsd > 0 ? 'atm-pos' : trade.realizedPlUsd < 0 ? 'atm-neg' : ''}`,
          }, `${t('realized')} ${fmtSignedUsd(trade.realizedPlUsd)}`),
      ])));
    }

    function ParamChips({ t, params, emptyLabel }) {
      const items = strategyParamItems(params);
      if (items.length === 0) return h('p', { className: 'atm-empty' }, emptyLabel ?? t('none'));
      return h('div', { className: 'atm-chips' }, items.map((item) => h('span', { className: 'atm-param', key: item.key }, [
        h('b', { key: 'l' }, item.label),
        h('span', { key: 'v' }, item.value),
      ])));
    }

    function AgentDetail({ t, row, researchStatus, onClose }) {
      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
      }, [onClose]);

      const deathInfo = [];
      if (row.status === 'dead' || row.status === 'condemned') {
        if (row.cause) deathInfo.push({ key: 'cause', label: t('cause'), value: row.cause });
        if (row.diedAt) deathInfo.push({ key: 'died', label: t('died'), value: fmtDateTime(row.diedAt) });
        if (row.lifespanHours !== null) deathInfo.push({ key: 'life', label: t('lifespan'), value: fmtHours(row.lifespanHours) });
      }
      if (row.note) deathInfo.push({ key: 'note', label: 'note', value: row.note });

      const metaItems = [
        { key: 'gen', label: t('gen'), value: fmtNum(row.generation) },
        { key: 'born', label: t('born'), value: fmtAgo(row.bornAt), title: fmtDateTime(row.bornAt) },
        { key: 'parent', label: t('parent'), value: row.parentName ?? t('noParent') },
        { key: 'mutation', label: t('mutation'), value: row.mutationText ?? t('none') },
        { key: 'endowment', label: t('endowment'), value: fmtUsd(row.endowmentUsd) },
        { key: 'cash', label: t('cash'), value: fmtUsd(row.cashUsd) },
        { key: 'posval', label: t('positionsValue'), value: fmtUsd(row.positionsValueUsd) },
        { key: 'equity', label: t('equity'), value: fmtUsd(row.equityUsd) },
        { key: 'day', label: t('dayPnlTitle'), value: fmtPct(row.dayPnlPct) },
        { key: 'net7d', label: t('net7dTitle'), value: fmtSignedUsd(row.net7dUsd) },
        { key: 'realized', label: t('realized'), value: fmtSignedUsd(row.realizedPlUsd) },
        { key: 'unrealized', label: t('unrealized'), value: fmtSignedUsd(row.unrealizedPlUsd) },
        { key: 'runway', label: t('runway'), value: fmtHours(row.runwayHours) },
        { key: 'drawdown', label: t('drawdown'), value: fmtPct(row.drawdownPct) },
        { key: 'firstProfit', label: t('firstProfit'), value: row.firstProfitAt ? fmtAgo(row.firstProfitAt) : t('neverProfited') },
        ...(row.pnl
          ? [
            { key: 'weekPct', label: t('rankWeek'), value: fmtPct(row.pnl.weekPct) },
            { key: 'monthPct', label: t('rankMonth'), value: fmtPct(row.pnl.monthPct) },
            { key: 'netPnl', label: t('pnl'), value: fmtSignedUsd(row.pnl.netUsd) },
          ]
          : []),
        ...(row.grossExposureUsd !== null && row.grossExposureUsd !== undefined
          ? [{ key: 'gross', label: t('grossExposure'), value: fmtUsd(row.grossExposureUsd) }]
          : []),
        ...(row.netExposureUsd !== null && row.netExposureUsd !== undefined
          ? [{ key: 'net', label: t('netExposure'), value: fmtUsd(row.netExposureUsd) }]
          : []),
        ...(row.marginDebtUsd !== null && row.marginDebtUsd !== undefined
          ? [{ key: 'debt', label: t('marginDebt'), value: fmtUsd(row.marginDebtUsd) }]
          : []),
      ];

      return h('aside', { className: 'atm-detail', 'aria-label': `${t('detailTitle')}: ${row.name}` }, [
        h('div', { className: 'atm-detail-head', key: 'head' }, [
          h('div', { key: 'titles' }, [
            h('h3', { className: 'atm-detail-name', key: 'name' }, row.name),
            h('span', { className: 'atm-detail-id atm-mono', key: 'id', title: row.id }, row.id),
            h('div', { className: 'atm-toolbar', key: 'badges', style: { marginTop: 2 } }, [
              h(StatusCell, { key: 'status', t, row }),
              h('span', { className: 'atm-muted', key: 'gen' }, `gen ${fmtNum(row.generation)}`),
              row.strategy ? h('span', { key: 'category', className: 'atm-muted', title: row.strategy.description }, row.categoryLabel) : null,
              h(StrategyTypeChip, { key: 'type', t, strategy: row.strategy }),
              h('span', { className: 'atm-muted', key: 'interval' }, `${t('estInterval')} ${row.intervalLabel}`),
              h(InstrumentBadgeList, { key: 'instruments', t, badges: row.instrumentBadges, tooltip: row.instrumentTooltip, emptyLabel: t('instrumentsEmpty') }),
              h(RankingBadges, { key: 'ranks', t, row }),
            ]),
          ]),
          h('button', {
            key: 'close',
            type: 'button',
            className: 'atm-close',
            'aria-label': t('close'),
            title: `${t('close')} (Esc)`,
            onClick: onClose,
          }, '×'),
        ]),
        h(DetailKv, { key: 'meta', items: metaItems }),
        deathInfo.length > 0 ? h('div', { key: 'death' }, [
          h('h4', { className: 'atm-detail-title', key: 'title' }, t('tradingState')),
          h(DetailKv, { key: 'kv', items: deathInfo }),
        ]) : null,
        h(StrategyPlanSection, { key: 'plan', t, plan: row.plan }),
        h(BotAgentSection, { key: 'bot-agent', t, policy: row.policy }),
        h(InstrumentPlaybookSection, { key: 'instrument-playbook', t, playbook: row.playbook }),
        h('div', { key: 'holdings' }, [
          h('h4', { className: 'atm-detail-title', key: 'title' }, `${t('holdings')} · ${fmtNum(row.positionCount)}`),
          h(HoldingsTable, { key: 'table', t, row }),
        ]),
        h('div', { key: 'activity' }, [
          h('h4', { className: 'atm-detail-title', key: 'title' }, `${t('activity')} · ${fmtNum(row.tradesCount)}`),
          h(ActivityFeed, { key: 'feed', t, row }),
        ]),
        h(ResearchSection, { key: 'research', t, research: row.research, researchStatus }),
        h(TransactionsSection, { key: 'transactions', t, row }),
        h('div', { key: 'strategy' }, [
          h('h4', { className: 'atm-detail-title', key: 'title' }, t('strategyParams')),
          h('p', { className: 'atm-note', key: 'genome-label' }, `${t('genomeParams')} · ${row.genomeText}`),
          h(ParamChips, { key: 'genome-params', t, params: row.genome }),
          h('p', { className: 'atm-note', key: 'spec-label' }, [
            `${t('specParams')} · ${row.specText ?? t('none')}`,
            row.specCreatedAt ? ` · ${t('specCreated')} ${fmtAgo(row.specCreatedAt)}` : '',
          ].join('')),
          row.spec
            ? h(ParamChips, { key: 'spec-params', t, params: row.spec.params })
            : h('p', { className: 'atm-empty', key: 'no-spec' }, t('noSpec')),
          row.tradingDiffers
            ? h('p', { className: 'atm-warn', key: 'diff' }, `⚠ ${t('specDiffers')}`)
            : null,
        ]),
        h('div', { key: 'costs' }, [
          h('h4', { className: 'atm-detail-title', key: 'title' }, `${t('costs')} · ${fmtUsd(row.roleCostsTotal)}`),
          row.roleCosts.length === 0
            ? h('p', { className: 'atm-empty', key: 'empty' }, t('none'))
            : h('table', { className: 'atm-detail-table', key: 'table' }, [
              h('thead', { key: 'head' }, h('tr', null, [
                h('th', { key: 'role' }, t('role')),
                h('th', { key: 'amount' }, t('amount')),
              ])),
              h('tbody', { key: 'body' }, row.roleCosts.map((cost) => h('tr', { key: cost.role }, [
                h('td', { key: 'role', className: 'atm-mono' }, cost.role),
                h('td', { key: 'amount', className: 'atm-mono' }, fmtUsd(cost.amountUsd)),
              ]))),
            ]),
        ]),
      ]);
    }

    // -----------------------------------------------------------------------
    // feed sections
    // -----------------------------------------------------------------------

    function Generations({ t, summaryData }) {
      const rows = React.useMemo(() => generationRows(summaryData), [summaryData]);
      const population = summaryData?.population ?? null;
      return h('div', { className: 'atm-section' }, [
        h('h3', { className: 'atm-section-title', key: 'title' }, t('generations')),
        population
          ? h('p', { className: 'atm-note', key: 'pop' },
            `${t('alive')} ${fmtNum(population.alive)} · ${t('dead')} ${fmtNum(population.dead)} · ${t('condemned')} ${fmtNum(population.condemned)} · ${t('total')} ${fmtNum(population.total)} · ${t('cap')} ${fmtNum(population.cap)}`)
          : null,
        rows.length === 0
          ? h('p', { className: 'atm-muted', key: 'empty' }, t('noGenerations'))
          : h('ul', { className: 'atm-list', key: 'list' }, rows.map((row) => h('li', { key: row.generation }, [
            h('span', { className: 'atm-mono', key: 'gen' }, `gen ${row.generation}`),
            h('span', { key: 'alive', className: 'atm-pos' }, `${row.alive} ${t('alive')}`),
            h('span', { key: 'dead', className: 'atm-neg' }, `${row.dead} ${t('dead')}`),
            row.survivalRate === null
              ? null
              : h('span', { key: 'rate', className: 'atm-muted' }, `${Math.round(row.survivalRate * 100)}%`),
          ]))),
      ]);
    }

    function Obituaries({ t, summaryData }) {
      const rows = React.useMemo(() => obituaryRows(summaryData), [summaryData]);
      return h('div', { className: 'atm-section' }, [
        h('h3', { className: 'atm-section-title', key: 'title' }, t('obituaries')),
        rows.length === 0
          ? h('p', { className: 'atm-muted', key: 'empty' }, t('noObits'))
          : h('ul', { className: 'atm-list', key: 'list' }, rows.map((row) => h('li', {
            key: row.key,
            'data-cause': 'death',
            title: row.diedAt ? fmtDateTime(row.diedAt) : '',
          }, [
            h('span', { key: 'name', className: 'atm-name-main', title: row.name }, row.name),
            h('span', { key: 'id', className: 'atm-muted atm-mono' }, row.shortId),
            row.generation === null ? null : h('span', { key: 'gen', className: 'atm-muted' }, `gen ${row.generation}`),
            h('span', { key: 'cause', className: 'atm-neg' }, row.cause ?? '—'),
            h('span', { key: 'life', className: 'atm-muted' }, `${t('lifespan')} ${fmtHours(row.lifespanHours)}`),
            h('span', {
              key: 'pl',
              className: `atm-mono ${row.netPlUsd === null ? '' : row.netPlUsd < 0 ? 'atm-neg' : 'atm-pos'}`,
            }, fmtSignedUsd(row.netPlUsd)),
            h('span', { key: 'fp', className: 'atm-muted' }, row.firstProfitAt ? `first profit ${fmtAgo(row.firstProfitAt)}` : t('neverProfited')),
          ]))),
      ]);
    }

    // -----------------------------------------------------------------------
    // v3.2 analytics components (live dashboard)
    // -----------------------------------------------------------------------

    function Sparkline({ values, direction = 'flat', width = 96, height = 24 }) {
      const path = sparklinePath(values, { width, height });
      if (!path) return null;
      return h('svg', {
        className: 'atm-spark',
        'data-direction': direction,
        width,
        height,
        viewBox: `0 0 ${width} ${height}`,
        'aria-hidden': true,
        focusable: 'false',
      }, h('path', { d: path }));
    }

    function EquityChart({ t, equity }) {
      const chart = equity ?? equityChartPoints([]);
      const head = h('div', { className: 'atm-chart-head', key: 'head' }, [
        h('span', { className: 'atm-chart-title', key: 'title' }, t('equityChart')),
        h('span', { className: 'atm-chart-meta', key: 'meta' }, chart.hasData
          ? `${fmtUsd(chart.last.equityUsd)} · Δ ${fmtSignedUsd(chart.deltaUsd)} (${fmtPct(chart.deltaPct)})`
          : ''),
      ]);
      if (!chart.hasData) {
        return h('div', { className: 'atm-chart' }, [head, h('div', { className: 'atm-chart-empty', key: 'empty' }, t('chartEmpty'))]);
      }
      const width = 640;
      const height = 170;
      const step = Math.max(1, Math.ceil(chart.points.length / 24));
      return h('div', { className: 'atm-chart' }, [
        head,
        h('svg', { key: 'svg', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': t('equityChart') }, [
          h('path', { key: 'area', d: chart.area, fill: 'var(--dsw-alias-state-business-primary,currentColor)', opacity: 0.12, stroke: 'none' }),
          h('path', { key: 'line', d: chart.path, fill: 'none', stroke: 'var(--dsw-alias-state-business-primary,currentColor)', strokeWidth: 1.6 }),
          chart.points.filter((__, index) => index % step === 0).map((point) => h('circle', {
            key: `${point.x}-${point.y}`,
            cx: point.x,
            cy: point.y,
            r: 2,
            fill: 'var(--dsw-alias-state-business-primary,currentColor)',
          }, h('title', null, `${fmtUsd(point.equityUsd)} · ${fmtDateTime(point.at)}`))),
        ]),
        h('div', { className: 'atm-chart-meta', key: 'range' }, `${fmtUsd(chart.min)} — ${fmtUsd(chart.max)}`),
      ]);
    }

    function KpiCards({ t, cards }) {
      const list = Array.isArray(cards) ? cards : [];
      if (list.length === 0) return null;
      return h('div', { className: 'atm-kpis' }, list.map((card) => {
        const deltaParts = [];
        if (card.deltaPct !== null && card.deltaPct !== undefined) deltaParts.push(fmtPct(card.deltaPct));
        if (card.deltaUsd !== null && card.deltaUsd !== undefined) deltaParts.push(fmtSignedUsd(card.deltaUsd));
        if (card.detailKey) deltaParts.push(`${t(card.detailKey)} ${card.detail ?? '—'}`);
        else if (card.detail) deltaParts.push(String(card.detail));
        return h('div', { key: card.key, className: 'atm-kpi', 'data-direction': card.direction ?? 'flat' }, [
          h('span', { className: 'atm-kpi-label', key: 'label' }, t(card.labelKey)),
          h('span', { className: 'atm-kpi-value', key: 'value' }, [
            card.direction === 'up' ? h('span', { key: 'arrow', className: 'atm-arrow-up', 'aria-hidden': true }, '▲') : null,
            card.direction === 'down' ? h('span', { key: 'arrow', className: 'atm-arrow-down', 'aria-hidden': true }, '▼') : null,
            h('span', { key: 'text' }, card.value),
          ]),
          deltaParts.length > 0
            ? h('span', { key: 'delta', className: 'atm-kpi-delta', title: card.deltaTitle ?? '' }, deltaParts.join(' · '))
            : null,
        ]);
      }));
    }

    function MarketTape({ t, live, limit = null, titleKey = 'tape' }) {
      const rows = Array.isArray(live?.tape) ? (limit === null ? live.tape : live.tape.slice(0, limit)) : [];
      const feedStatus = live?.feedStatus ?? 'unavailable';
      const open = live?.marketOpen;
      const head = h('div', { className: 'atm-chart-head', key: 'head' }, [
        h('span', { className: 'atm-chart-title', key: 'title' }, t(titleKey)),
        h('span', { className: 'atm-chart-meta', key: 'meta' }, [
          h('span', { key: 'feed', className: 'atm-feed-pill', 'data-status': feedStatus }, [
            h('span', { key: 'dot', className: 'atm-dot', 'aria-hidden': true }),
            feedStatus === 'live' ? t('feedLive') : feedStatus === 'closed' ? t('feedClosed') : t('feedUnavailable'),
          ]),
          open === false ? h('span', { key: 'closed', className: 'atm-closed-label' }, ` ${t('closedLastClose')}`) : null,
          live?.lastUpdatedAt ? h('span', { key: 'updated', className: 'atm-muted' }, ` ${fmtAgo(live.lastUpdatedAt)}`) : null,
        ]),
      ]);
      if (rows.length === 0) {
        return h('div', { className: 'atm-chart' }, [head, h('div', { className: 'atm-chart-empty', key: 'empty' }, t('noMarketData'))]);
      }
      return h('div', { className: 'atm-chart' }, [
        head,
        h('div', { className: 'atm-tape-wrap', key: 'wrap' }, h('table', { className: 'atm-tape' }, [
          h('thead', { key: 'thead' }, h('tr', null, [
            h('th', { key: 'symbol' }, t('symbol')),
            h('th', { key: 'last' }, t('lastPrice')),
            h('th', { key: 'change' }, t('change')),
            h('th', { key: 'bidask' }, t('bidAsk')),
            h('th', { key: 'trend' }, t('trend')),
          ])),
          h('tbody', { key: 'tbody' }, rows.map((row) => h('tr', { key: row.key }, [
            h('td', { key: 'symbol', className: 'atm-sym' }, row.symbol),
            h('td', { key: 'last', className: 'atm-mono', title: row.stale ? 'stale quote' : '' }, [
              row.priceText,
              row.stale ? h('span', { key: 'stale', className: 'atm-muted' }, ' *') : null,
            ]),
            h('td', {
              key: 'change',
              className: `atm-mono ${row.direction === 'up' ? 'atm-chg-up' : row.direction === 'down' ? 'atm-chg-down' : 'atm-chg-flat'} ${row.direction === 'up' ? 'atm-flash-up' : row.direction === 'down' ? 'atm-flash-down' : ''}`,
            }, h('span', { key: `${row.key}-${row.priceUsd}-${row.changeUsd}` }, `${row.changeUsdText} (${row.changePctText})`)),
            h('td', { key: 'bidask', className: 'atm-mono atm-muted' }, `${row.bidText} / ${row.askText}`),
            h('td', { key: 'trend' }, h(Sparkline, { values: row.sparkline, direction: row.direction, width: 72, height: 20 })),
          ]))),
        ])),
      ]);
    }

    function StrategyMixChart({ t, mix }) {
      if (!mix || mix.available !== true) {
        return h('div', { className: 'atm-chart' }, [
          h('div', { className: 'atm-chart-head', key: 'head' }, h('span', { className: 'atm-chart-title', key: 't' }, t('strategyMixTitle'))),
          h('div', { className: 'atm-chart-empty', key: 'empty' }, t('chartEmpty')),
        ]);
      }
      return h('div', { className: 'atm-chart' }, [
        h('div', { className: 'atm-chart-head', key: 'head' }, [
          h('span', { className: 'atm-chart-title', key: 't' }, t('strategyMixTitle')),
          h('span', { className: 'atm-chart-meta', key: 'm' }, `${t('dayVsSwing')} · ${t('target')} ${fmtPct(mix.targetDayPct)} / ${fmtPct(1 - mix.targetDayPct)}`),
        ]),
        h('div', { className: 'atm-mix-bars', key: 'bars' }, mix.bars.map((bar) => h('div', {
          key: bar.key,
          className: 'atm-mix-row',
          'data-side': bar.key,
        }, [
          h('div', { className: 'atm-mix-head', key: 'head' }, [
            h('span', { key: 'label' }, `${t(bar.labelKey)} · ${fmtNum(bar.count)}`),
            h('span', { key: 'pct' }, `${t('actual')} ${bar.pctText} · ${t('target')} ${bar.targetText}`),
          ]),
          h('div', { className: 'atm-mix-track', key: 'track' }, [
            h('div', {
              key: 'fill',
              className: 'atm-mix-fill',
              style: { width: `${Math.max(0, Math.min(100, (bar.pct ?? 0) * 100))}%` },
            }),
            h('div', {
              key: 'target',
              className: 'atm-mix-target',
              style: { left: `${Math.max(0, Math.min(100, bar.targetPct * 100))}%` },
              title: `${t('target')} ${bar.targetText}`,
            }),
          ]),
        ]))),
      ]);
    }

    function TabBar({ t, active, onChange }) {
      const labels = {
        overview: 'tabOverview',
        agents: 'tabAgents',
        markets: 'tabMarkets',
        research: 'tabResearch',
        rewards: 'tabRewards',
        settings: 'tabSettings',
      };
      return h('div', { className: 'atm-tabs', role: 'tablist' }, DASHBOARD_TABS.map((tab) => h('button', {
        key: tab,
        type: 'button',
        role: 'tab',
        className: 'atm-tab',
        'data-active': active === tab ? 'true' : 'false',
        'aria-selected': active === tab,
        onClick: () => onChange(tab),
      }, t(labels[tab]))));
    }

    function TopBar({ t, summary, live, paused, refreshing, onTogglePause, onRefresh }) {
      const [now, setNow] = React.useState(() => new Date());
      React.useEffect(() => {
        const timer = setInterval(() => setNow(new Date()), 1000);
        return () => clearInterval(timer);
      }, []);
      const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
      const sessionLabel = t(live?.sessionLabelKey ?? 'marketUnknown');
      return h('div', { className: 'atm-topbar' }, [
        h('div', { className: 'atm-brand', key: 'brand' }, [
          h('span', { className: 'atm-brand-mark', key: 'mark', 'aria-hidden': true }, 'M'),
          h('div', { className: 'atm-brand-text', key: 'text' }, [
            h('span', { className: 'atm-brand-title', key: 'title' }, t('brand')),
            h('span', { className: 'atm-brand-sub', key: 'sub' }, t('brandSub')),
          ]),
        ]),
        h('div', { className: 'atm-topbar-actions', key: 'actions' }, [
          summary ? h(ModeBadge, { key: 'mode', t, mode: summary.mode }) : null,
          summary ? h('span', { className: 'atm-badge', key: 'running', 'data-running': summary.running ? 'true' : 'false' }, summary.running ? t('running') : t('stopped')) : null,
          summary?.halted ? h('span', { key: 'halted', className: 'atm-badge' }, t('halted')) : null,
          summary ? h(KillBadge, { key: 'kill', t, on: summary.killSwitch }) : null,
          h('span', {
            key: 'feed',
            className: 'atm-feed-pill',
            'data-status': live?.feedStatus ?? 'unavailable',
            title: live?.error ? errorText(live.error) : t('liveFeed'),
          }, [
            h('span', { key: 'dot', className: 'atm-dot', 'aria-hidden': true }),
            live?.feedStatus === 'live' ? t('feedLive') : live?.feedStatus === 'closed' ? t('feedClosed') : t('feedUnavailable'),
          ]),
          h('span', { className: 'atm-clock', key: 'clock', title: t('marketClock') }, [
            h('b', { key: 'session' }, sessionLabel),
            ' · ',
            h('span', { key: 'time', className: 'atm-mono' }, clock),
          ]),
          h('button', {
            key: 'refresh',
            type: 'button',
            className: 'atm-btn',
            title: t('manualRefresh'),
            disabled: refreshing === true,
            onClick: onRefresh,
          }, refreshing ? t('feedRefreshing') : t('manualRefresh')),
          h('button', {
            key: 'pause',
            type: 'button',
            className: 'atm-btn',
            'data-variant': paused ? 'active' : undefined,
            onClick: onTogglePause,
          }, paused ? t('resume') : t('pause')),
        ]),
      ]);
    }

    function ResearchSummaryPanel({ t, live, summary, controlState, runControl }) {
      const rows = Array.isArray(live?.agents) ? live.agents : [];
      const counts = { HOLD: 0, AVOID: 0, ALERT: 0, none: 0 };
      for (const row of rows) {
        const verdict = row.research?.verdict;
        if (verdict === 'HOLD' || verdict === 'AVOID' || verdict === 'ALERT') counts[verdict] += 1;
        else counts.none += 1;
      }
      return h('div', { className: 'atm-tab-panel' }, [
        h('div', { className: 'atm-chart', key: 'status' }, [
          h('div', { className: 'atm-chart-head', key: 'head' }, h('span', { className: 'atm-chart-title', key: 't' }, t('researchSummary'))),
          h('div', { className: 'atm-research-summary', key: 'counts' }, [
            h('span', { key: 'hold' }, `HOLD ${counts.HOLD}`),
            h('span', { key: 'avoid' }, `AVOID ${counts.AVOID}`),
            h('span', { key: 'alert' }, `ALERT ${counts.ALERT}`),
            h('span', { key: 'none' }, `${t('none')} ${counts.none}`),
          ]),
          summary.research?.disabledReason
            ? h('p', { className: 'atm-warn', key: 'disabled' }, t(summary.research.disabledReason === 'disabled' ? 'researchDisabledConfig' : 'researchDisabled'))
            : null,
        ]),
        h(ResearchCadenceControl, {
          key: 'cadence',
          t,
          research: summary.research,
          controlState,
          runControl,
        }),
      ]);
    }

    // -----------------------------------------------------------------------
    // dashboard (shared by the main panel and the settings tab)
    // -----------------------------------------------------------------------

    function DashboardBody({ t, snapshot, market, live, rows, selectedRow, onSelect, onCloseDetail }) {
      const { controlState, runControl } = useControlActions();
      const [tab, setTab] = React.useState('overview');
      const summary = live.summary ?? summarize(snapshot.data);
      const paused = snapshot.paused === true;
      const selectAgent = (id) => {
        onSelect(id);
        setTab('agents');
      };
      const diagnostics = [
        h(BotAgentBridgeLine, { key: 'bot-agents', t, engineAgents: summary.engineAgents }),
        h(InstrumentsLine, { key: 'instruments', t, instruments: summary.instruments }),
        h(CapabilityWarningLine, { key: 'capability', t, capability: summary.brokerCapability }),
        h(LastCycleLine, { key: 'last-cycle', t, lastCycle: summary.lastCycle }),
      ];
      const workspace = h('div', { className: 'atm-workspace', key: 'workspace', 'data-detail': selectedRow ? 'true' : 'false' }, [
        h('div', { className: 'atm-main-col', key: 'left' }, [
          h(AgentTable, {
            key: 'table',
            t,
            rows,
            selectedId: selectedRow ? selectedRow.id : null,
            onSelect: selectAgent,
            strategyMix: summary.strategyMix,
          }),
        ]),
        selectedRow
          ? h(AgentDetail, { key: 'detail', t, row: selectedRow, researchStatus: summary.research, onClose: onCloseDetail })
          : null,
      ]);
      const banners = [
        summary.halted ? h('p', { className: 'atm-halt', key: 'halted' }, t('halted')) : null,
        snapshot.error ? h('p', { className: 'atm-err', key: 'fetch-error' }, `${t('lastError')}: ${errorText(snapshot.error)}`) : null,
        summary.research?.disabledReason
          ? h('p', { className: 'atm-warn', key: 'research-note' }, t(summary.research.disabledReason === 'disabled' ? 'researchDisabledConfig' : 'researchDisabled'))
          : null,
      ].filter(Boolean);
      const overview = h('div', { className: 'atm-tab-panel', key: 'overview' }, [
        h(KpiCards, { key: 'kpis', t, cards: live.kpis }),
        h('div', { className: 'atm-chart-grid', key: 'charts' }, [
          h(EquityChart, { key: 'equity', t, equity: live.equity }),
          h(StrategyMixChart, { key: 'mix', t, mix: live.mix }),
          h(MarketTape, { key: 'watch', t, live, limit: 6, titleKey: 'marketWatch' }),
        ]),
        workspace,
        h('div', { className: 'atm-two', key: 'bottom' }, [
          h(Generations, { key: 'gens', t, summaryData: snapshot.data }),
          h(Obituaries, { key: 'obits', t, summaryData: snapshot.data }),
        ]),
      ]);
      const agentsTab = h('div', { className: 'atm-tab-panel', key: 'agents' }, [workspace]);
      const marketsTab = h('div', { className: 'atm-tab-panel', key: 'markets' }, [
        h(MarketTape, { key: 'tape', t, live }),
        ...diagnostics,
      ]);
      const researchRows = rows.filter((row) => row.research).slice(0, 16);
      const researchTab = h('div', { className: 'atm-tab-panel', key: 'research' }, [
        h(ResearchSummaryPanel, { key: 'summary', t, live, summary, controlState, runControl }),
        h('div', { className: 'atm-chart', key: 'briefings' }, [
          h('div', { className: 'atm-chart-head', key: 'head' }, [
            h('span', { className: 'atm-chart-title', key: 't' }, t('research')),
            h('span', { className: 'atm-chart-meta', key: 'm' }, `${fmtNum(researchRows.length)} / ${fmtNum(rows.length)}`),
          ]),
          researchRows.length === 0
            ? h('div', { className: 'atm-chart-empty', key: 'empty' }, t('researchEmpty'))
            : h('div', { className: 'atm-tape-wrap', key: 'wrap' }, h('table', { className: 'atm-tape' }, [
              h('thead', { key: 'thead' }, h('tr', null, [
                h('th', { key: 'agent' }, t('agent')),
                h('th', { key: 'verdict' }, t('research')),
                h('th', { key: 'sent' }, t('researchSentiment')),
                h('th', { key: 'conf' }, t('confidence')),
                h('th', { key: 'age' }, t('time')),
              ])),
              h('tbody', { key: 'tbody' }, researchRows.map((row) => h('tr', {
                key: row.id,
                'data-clickable': 'true',
                onClick: () => selectAgent(row.id),
              }, [
                h('td', { key: 'agent' }, h('span', { className: 'atm-sym' }, row.name)),
                h('td', { key: 'verdict' }, h(ResearchBadge, { t, row })),
                h('td', { key: 'sent', className: 'atm-mono' }, row.research?.sentiment === null || row.research?.sentiment === undefined ? '—' : row.research.sentiment.toFixed(2)),
                h('td', { key: 'conf', className: 'atm-mono' }, row.research?.confidence === null || row.research?.confidence === undefined ? '—' : `${Math.round(row.research.confidence * 100)}%`),
                h('td', { key: 'age', className: 'atm-muted' }, fmtAgo(row.research?.at)),
              ]))),
            ])),
        ]),
      ]);
      const data = snapshot.data ?? {};
      const rewardsTab = h('div', { className: 'atm-tab-panel', key: 'rewards' }, [
        h(RewardsControl, {
          key: 'rewards',
          t,
          rewards: data.engine?.rewards ?? null,
          history: Array.isArray(data.rewards?.history) ? data.rewards.history : [],
          controlState,
          runControl,
        }),
        h(Leaderboards, { key: 'leaderboards', t, rankings: data.rankings ?? null, onSelect: selectAgent }),
      ]);
      const settingsTab = h('div', { className: 'atm-tab-panel', key: 'settings' }, [
        h(ReaperRow, { key: 'reaper', t, summary, controlState, runControl }),
        h(OperatorPanel, {
          key: 'operator',
          t,
          snapshot,
          summary,
          controlState,
          runControl,
          onSelect: selectAgent,
        }),
        h(HeaderStats, { key: 'stats', t, summary }),
        h('p', { className: 'atm-note', key: 'paper-note' }, `${t('paperDefault')} · ${t('externalReaper')}`),
      ]);
      const tabContent = tab === 'agents'
        ? agentsTab
        : tab === 'markets'
          ? marketsTab
          : tab === 'research'
            ? researchTab
            : tab === 'rewards'
              ? rewardsTab
              : tab === 'settings'
                ? settingsTab
                : overview;
      return h('div', { className: 'atm-root' }, [
        h(TopBar, {
          key: 'top',
          t,
          summary,
          live,
          paused,
          refreshing: snapshot.refreshing === true || market?.refreshing === true,
          onTogglePause: () => store.togglePaused(),
          onRefresh: refreshAll,
        }),
        ...banners,
        h(ControlBar, {
          key: 'controls',
          t,
          summary: { ...summary, paused },
          controlState,
          runControl,
        }),
        h(TabBar, { key: 'tabs', t, active: tab, onChange: setTab }),
        tabContent,
        summary.lastError ? h('p', { className: 'atm-err', key: 'last-error' }, `${t('lastError')}: ${errorText(summary.lastError)}`) : null,
        h('p', { className: 'atm-note', key: 'note' },
          `${t('brakes')} · ${t('externalReaper')} · ${t('updated')} ${fmtAgo(snapshot.data.at)}`),
      ]);
    }

    /**
     * Shared dashboard page: used for the sidebar-opened `main` panel and the
     * `settings.plugins.tab` page. The live market feed (2 s) and the state snapshot (5 s)
     * share the pause toggle; selection is component-local and persisted across polling by
     * re-looking agents up by id.
     */
    function AutomatonDashboard({ t, variant }) {
      const snapshot = useDashboardState();
      const market = useMarketFeed(snapshot.paused);
      const summaryData = snapshot.data;
      const live = React.useMemo(() => liveViewMapping(summaryData, market.data), [summaryData, market.data]);
      const rows = live.hasState ? live.agents : [];
      const [selectedId, setSelectedId] = React.useState(null);
      const selectedRow = React.useMemo(() => findAgentRow(rows, selectedId), [rows, selectedId]);
      React.useEffect(() => {
        if (selectedId !== null && summaryData && rows.length > 0 && !rows.some((row) => row.id === selectedId)) {
          setSelectedId(null);
        }
      }, [rows, selectedId, summaryData]);

      const isSettings = variant === 'settings';
      return h('div', { className: isSettings ? 'atm-root atm-settings' : 'atm-root atm-main' }, [
        h('style', { key: 'css' }, APP_CSS),
        !summaryData
          ? h('div', { className: 'atm-topbar', key: 'loading-bar' }, [
            h('div', { className: 'atm-brand', key: 'brand' }, [
              h('span', { className: 'atm-brand-mark', key: 'mark', 'aria-hidden': true }, 'M'),
              h('div', { className: 'atm-brand-text', key: 'text' }, [
                h('span', { className: 'atm-brand-title', key: 'title' }, t('brand')),
                h('span', { className: 'atm-brand-sub', key: 'sub' }, t('brandSub')),
              ]),
            ]),
            h('span', { className: 'atm-muted', key: 'status' }, snapshot.error ? `${t('offline')}: ${errorText(snapshot.error)}` : t('loading')),
          ])
          : h(DashboardBody, {
            key: 'body',
            t,
            snapshot,
            market,
            live,
            rows,
            selectedRow,
            onSelect: (id) => setSelectedId((previous) => (previous === id ? null : id)),
            onCloseDetail: () => setSelectedId(null),
          }),
      ]);
    }

    // -----------------------------------------------------------------------
    // sidebar entry glyph (rendered inside the sidebar panel row)
    // -----------------------------------------------------------------------

    function SidebarPanelIcon({ size = 16, active }) {
      const px = Number.isFinite(Number(size)) ? Number(size) : 16;
      return h('svg', {
        className: 'atm-icon',
        width: px,
        height: px,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': true,
        focusable: 'false',
      }, [
        h('path', {
          key: 'pulse',
          d: 'M2.6 15h3.8l1.6-4.6 2.3 8.3 2-5.5 1.4 1.8h2',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('circle', { key: 'skull', cx: 19, cy: 8.2, r: 3, stroke: 'currentColor', strokeWidth: 1.5 }),
        h('circle', { key: 'eyeL', cx: 18, cy: 7.9, r: 0.7, fill: 'currentColor' }),
        h('circle', { key: 'eyeR', cx: 20, cy: 7.9, r: 0.7, fill: 'currentColor' }),
        active ? h('circle', { key: 'live', cx: 19, cy: 19.6, r: 1.3, fill: 'var(--dsw-alias-state-business-primary,currentColor)' }) : null,
      ]);
    }

    // -----------------------------------------------------------------------
    // module
    // -----------------------------------------------------------------------

    /** React context carrying the locale translator into slot components. */
    const LocaleContext = React.createContext((key) => EN[key] ?? key);

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        if (!ctx || !ctx.slots || typeof ctx.slots.register !== 'function') return;
        const t = createTranslator(ctx);
        const providerFor = (Component, extra) => (props) => h(
          LocaleContext.Provider,
          { value: t },
          h(Component, { ...props, ...(extra ?? {}), t }),
        );

        /**
         * Inject a contribution into `slotName` without letting one unavailable slot
         * (e.g. a deployment without the Settings page composed in) break the others.
         */
        const contribute = (slotName, options, Component, extra) => {
          try {
            ctx.slots.inject(slotName, () => {
              try {
                return ctx.slots.register({ name: slotName, ...options }, providerFor(Component, extra));
              } catch (error) {
                try {
                  console.warn(`[automaton-trading] could not register into ${slotName}:`, error?.message ?? error);
                } catch {
                  /* console is optional */
                }
                return () => {};
              }
            });
          } catch (error) {
            try {
              console.warn(`[automaton-trading] slot ${slotName} is unavailable:`, error?.message ?? error);
            } catch {
              /* console is optional */
            }
          }
        };

        // Sidebar entry: the glyph + label in the sidebar's global panel list.
        contribute(SIDEBAR_SLOT, {
          id: PANEL_ID,
          order: 30,
          label: () => t('sidebarLabel'),
          locale: NS,
        }, SidebarPanelIcon);

        // Central panel opened by selecting the sidebar entry (keyed `main` slot).
        contribute(MAIN_SLOT, {
          key: PANEL_ID,
          locale: NS,
        }, AutomatonDashboard, { variant: 'main' });

        // Secondary full-page entry inside Settings -> Built-in plugins.
        contribute(SETTINGS_SLOT, {
          id: PANEL_ID,
          order: 20,
          label: () => t('tab'),
          locale: NS,
        }, AutomatonDashboard, { variant: 'settings' });
      },
      /** Pure data helpers, exposed for the host test suite (no React rendering needed). */
      helpers: {
        buildAgentRows,
        buildHoldingsRows,
        buildActivityRows,
        agentStrategyMapping,
        estimatedIntervalLabel,
        strategyCategoryLabel,
        categoryTabs,
        filterRowsByCategory,
        botAgentPolicyMapping,
        stanceBadge,
        botAgentEngineStatus,
        instrumentBadges,
        instrumentPermissionsMapping,
        instrumentStructureLabel,
        positionRows,
        positionSummary,
        playbookMapping,
        instrumentPolicyMapping,
        instrumentsHeader,
        lastCycleMapping,
        instrumentsCapabilityWarning,
        effectiveInstrumentBadges,
        describeReaper,
        mapResearchBriefing,
        researchBadge,
        researchStatusSummary,
        researchModeKey,
        RESEARCH_CADENCE_OPTIONS,
        researchCadenceKey,
        researchSettingsFromCadence,
        rewardsControlState,
        rewardsPreview,
        rewardHistoryRows,
        lastWinnerRows,
        leaderboardPeriods,
        leaderboardRows: (status, period) => leaderboardPeriods(status)[['daily', 'weekly', 'monthly'].includes(period) ? period : 'daily'],
        agentPlanMapping,
        agentTransactionRows,
        agentRankingBadges,
        agentPnlMapping,
        MEDALS,
        changeDirection,
        marketChangePctText,
        sparklinePath,
        marketTapeRows,
        equityChartPoints,
        kpiCards,
        strategyMixBreakdown,
        agentTableRows,
        marketSession,
        liveViewMapping,
        summarize,
        generationRows,
        obituaryRows,
        sortAgentRows,
        filterAgentRows,
        findAgentRow,
        strategyParamItems,
        strategyParamsText,
        agentDisplayName,
        strategyLabel,
        familyLabel,
        roleCostRows,
        fmtUsd,
        fmtSignedUsd,
        fmtHours,
        fmtPct,
        fmtPercentPoints,
        fmtAgo,
        fmtDateTime,
        lifespanHours,
        runwayPercent,
        runwayLevel,
        shortId,
        modeOf,
        STATE_URL,
        MARKET_URL,
        CONTROL_URL,
        POLL_MS,
        STATE_POLL_MS,
        MARKET_POLL_MS,
        DASHBOARD_TABS,
        PANEL_ID,
        SIDEBAR_SLOT,
        MAIN_SLOT,
        SETTINGS_SLOT,
        SORTABLE_KEYS,
      },
    };
  },
});
