/**
 * token-speed — live token generation speed + session up/down totals.
 *
 * Statusbar chip:  ⚡ 38.4 t/s  ↑12.4k ↓3.2k
 * Click it for the full dashboard (sparkline, per-turn, cache, context, cost).
 *
 * Plain ESM, loaded uncompiled — UI is jsx() calls, not JSX syntax.
 * Only @hermes/plugin-sdk, react and react/jsx-runtime resolve.
 */

import { atom, Codicon, cn, compactNumber, haptic, host, PALETTE_AREA, Popover, PopoverContent, PopoverTrigger, usePluginI18n, useValue } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'token-speed'

/** 250ms sampling, 2s measurement window, 60s of history. */
const TICK_MS = 250
const WINDOW_MS = 2000
const HISTORY_MS = 60_000

// ---------------------------------------------------------------- state ----

/** Estimated tokens/second right now (0 when idle). */
const $speed = atom(0)
/** [{ t, v }] samples for the sparkline. */
const $series = atom([])
/** Last UsageStats seen for the focused session. */
const $usage = atom(null)
/** Tokens produced during the current turn (output counter delta). */
const $turnTokens = atom(0)
/** True while assistant text is arriving. */
const $streaming = atom(false)

// Non-reactive accumulators (module-scoped: a reload starts a fresh module).
let charTimes = [] // [{ t, n }] within WINDOW_MS
let pendingChars = 0 // chars since the last usage snapshot (calibration)
let prevOutput = null // output tokens at the last usage snapshot
let calib = 3.2 // chars per token, learned per session
let lastSpeed = 0
let turnBase = null // { output, total } at message.start
let lastUsageKey = ''

function charsPerToken() {
  return calib
}

/** Feed one delta frame into the estimator. */
function noteChars(n, at) {
  if (!n) {
    return
  }

  charTimes.push({ t: at, n })
  pendingChars += n

  // Hard cap so a runaway turn can't grow this array without bound.
  if (charTimes.length > 8000) {
    charTimes.splice(0, charTimes.length - 4000)
  }
}

/** Relearn chars-per-token from authoritative usage ticks. */
function recalibrate(usage) {
  if (prevOutput !== null && usage.output > prevOutput && pendingChars > 24) {
    const ratio = pendingChars / (usage.output - prevOutput)

    // 0.7–12 chars/token covers CJK-heavy (≈1.2) through English code (≈4.5);
    // anything outside is a miscount (spinner frames, aborted calls).
    if (ratio > 0.7 && ratio < 12) {
      calib = calib * 0.65 + ratio * 0.35
    }
  }

  prevOutput = usage.output
  pendingChars = 0
}

function tick() {
  const now = Date.now()
  const usage = host.state.focusedUsage.get()

  if (usage) {
    const key = `${usage.calls}:${usage.output}:${usage.input}`

    if (key !== lastUsageKey) {
      lastUsageKey = key
      recalibrate(usage)
      $usage.set(usage)

      if (turnBase) {
        $turnTokens.set(Math.max(0, usage.output - turnBase.output))
      }
    }
  }

  // Drop samples that fell out of the window, then measure.
  const cut = now - WINDOW_MS

  while (charTimes.length && charTimes[0].t < cut) {
    charTimes.shift()
  }

  let chars = 0

  for (const sample of charTimes) {
    chars += sample.n
  }

  let speed = 0

  if (chars > 0) {
    const first = charTimes[0].t
    const span = Math.max(400, now - Math.max(cut, first))
    speed = (chars / span) * 1000 / charsPerToken()
  } else {
    // No arrivals: decay instead of snapping to zero mid-sentence.
    speed = lastSpeed * 0.55

    if (speed < 0.05) {
      speed = 0
    }
  }

  lastSpeed = speed
  $speed.set(speed)
  $streaming.set(chars > 0)

  const series = $series.get()
  const next = series.length && now - series[series.length - 1].t < TICK_MS / 2 ? series.slice(0, -1) : series.slice()

  next.push({ t: now, v: speed })

  while (next.length && now - next[0].t > HISTORY_MS) {
    next.shift()
  }

  $series.set(next)
}

// ------------------------------------------------------------ formatting ----

function fmtTps(value) {
  if (!value || value < 0.05) {
    return '0'
  }

  return value >= 100 ? String(Math.round(value)) : value.toFixed(1)
}

function fmtNum(value) {
  return compactNumber(Number(value) || 0)
}

// ---------------------------------------------------------------- pieces ----

function Spark({ series }) {
  const values = series.map(point => point.v)

  // Bucket the 60s history into 48 bars so the shape reads at a glance.
  const buckets = 48
  const size = Math.max(1, Math.ceil(values.length / buckets))
  const bars = []

  for (let i = 0; i < values.length; i += size) {
    let peak = 0

    for (let j = i; j < Math.min(i + size, values.length); j += 1) {
      peak = Math.max(peak, values[j])
    }

    bars.push(peak)
  }

  while (bars.length < buckets) {
    bars.unshift(0)
  }

  const max = Math.max(...bars, 1)

  return jsx('div', {
    className: 'flex h-12 items-end gap-px overflow-hidden rounded-sm',
    children: bars.slice(-buckets).map((value, index) =>
      jsx('span', {
        className: value > 0 ? 'min-w-px flex-1 bg-[color:var(--dt-primary)]/70' : 'min-w-px flex-1 bg-(--ui-stroke-tertiary)',
        style: { height: `${Math.max(2, (value / max) * 100)}%` },
        key: index
      })
    )
  })
}

function Stat({ label, value, hint }) {
  return jsxs('div', {
    className: 'flex flex-col gap-0.5',
    children: [
      jsx('span', { className: 'text-[0.625rem] uppercase tracking-wide text-(--ui-text-tertiary)', children: label }),
      jsx('span', { className: 'text-[0.8125rem] font-medium tabular-nums text-foreground', children: value }),
      hint ? jsx('span', { className: 'text-[0.625rem] text-(--ui-text-tertiary)', children: hint }) : null
    ]
  })
}

function Dashboard() {
  const t = usePluginI18n(ID)
  const speed = useValue($speed)
  const series = useValue($series)
  const usage = useValue($usage)
  const turnTokens = useValue($turnTokens)
  const streaming = useValue($streaming)
  const model = useValue(host.state.model)

  const input = usage?.input ?? 0
  const output = usage?.output ?? 0
  const total = usage?.total ?? input + output
  const calls = usage?.calls ?? 0
  const avg = usage?.avg_tps
  const cache = usage?.cache_hit_pct
  const ctxPct = usage?.context_percent
  const cost = usage?.cost_usd

  return jsxs('div', {
    className: 'flex w-80 flex-col gap-3 text-[0.75rem]',
    children: [
      jsxs('div', {
        className: 'flex items-baseline justify-between gap-2',
        children: [
          jsx('span', { className: 'font-medium text-foreground', children: t('title') }),
          jsx('span', { className: 'truncate text-[0.6875rem] text-(--ui-text-tertiary)', children: model || '—' })
        ]
      }),
      jsxs('div', {
        className: 'flex items-end gap-2',
        children: [
          jsx('span', {
            className: cn('text-2xl leading-none font-semibold tabular-nums', streaming ? 'text-primary' : 'text-foreground'),
            children: fmtTps(speed)
          }),
          jsx('span', { className: 'pb-0.5 text-[0.6875rem] text-(--ui-text-tertiary)', children: t('tpsUnit') }),
          streaming
            ? jsx('span', { className: 'pb-0.5 text-[0.6875rem] text-primary', children: t('streaming') })
            : null
        ]
      }),
      jsx(Spark, { series }),
      jsxs('div', {
        className: 'grid grid-cols-3 gap-2 border-t border-(--ui-stroke-tertiary) pt-2',
        children: [
          jsx(Stat, { label: t('up'), value: fmtNum(input) }),
          jsx(Stat, { label: t('down'), value: fmtNum(output) }),
          jsx(Stat, { label: t('total'), value: fmtNum(total) })
        ]
      }),
      jsxs('div', {
        className: 'grid grid-cols-3 gap-2',
        children: [
          jsx(Stat, { label: t('calls'), value: String(calls) }),
          jsx(Stat, { label: t('avg'), value: avg ? `${avg.toFixed(1)}` : '—', hint: avg ? t('tpsUnit') : undefined }),
          jsx(Stat, { label: t('cache'), value: typeof cache === 'number' ? `${Math.round(cache)}%` : '—' })
        ]
      }),
      jsxs('div', {
        className: 'grid grid-cols-3 gap-2',
        children: [
          jsx(Stat, { label: t('context'), value: typeof ctxPct === 'number' ? `${Math.round(ctxPct)}%` : '—' }),
          jsx(Stat, { label: t('cost'), value: typeof cost === 'number' ? `$${cost.toFixed(cost < 1 ? 3 : 2)}` : '—' }),
          jsx(Stat, { label: t('turn'), value: fmtNum(turnTokens) })
        ]
      })
    ]
  })
}

function Chip() {
  const t = usePluginI18n(ID)
  const speed = useValue($speed)
  const usage = useValue($usage)
  const streaming = useValue($streaming)

  const live = streaming && speed >= 0.05
  const input = usage?.input ?? 0
  const output = usage?.output ?? 0

  return jsxs(Popover, {
    children: [
      jsx(PopoverTrigger, {
        asChild: true,
        children: jsx('button', {
          className: cn(
            'inline-flex h-full items-center gap-1.5 px-1.5 text-[0.6875rem] tabular-nums transition-colors',
            'hover:bg-(--chrome-action-hover) hover:text-foreground',
            live ? 'text-(--ui-text-secondary)' : 'text-(--ui-text-tertiary)'
          ),
          onClick: () => haptic('tap'),
          title: t('chipTip'),
          type: 'button',
          children: [
            jsx(Codicon, { className: live ? 'text-primary' : '', name: 'zap', size: '0.6875rem' }),
            jsx('span', { children: `${fmtTps(speed)} t/s` }),
            jsx('span', { className: 'inline-flex items-center gap-0.5', children: [
              jsx('span', { className: 'text-(--ui-text-tertiary)', children: '↑' }),
              jsx('span', { children: fmtNum(input) })
            ] }),
            jsx('span', { className: 'inline-flex items-center gap-0.5', children: [
              jsx('span', { className: 'text-(--ui-text-tertiary)', children: '↓' }),
              jsx('span', { children: fmtNum(output) })
            ] })
          ]
        })
      }),
      jsx(PopoverContent, { align: 'end', className: 'w-auto p-3', children: jsx(Dashboard, {}) })
    ]
  })
}

// ------------------------------------------------------------------ init ----

export default {
  id: ID,
  name: 'Token Speed',
  register(ctx) {
    ctx.i18n.register({
      en: {
        title: 'Token throughput',
        tpsUnit: 'tok/s',
        streaming: 'streaming',
        up: 'up',
        down: 'down',
        total: 'total',
        calls: 'calls',
        avg: 'avg',
        cache: 'cache',
        context: 'context',
        cost: 'cost',
        turn: 'this turn',
        chipTip: 'Token speed — click for details',
        resetLabel: 'Token Speed: reset samples',
        resetDone: 'Token speed samples cleared'
      },
      zh: {
        title: 'Token 吞吐',
        tpsUnit: 'tok/s',
        streaming: '生成中',
        up: '上行',
        down: '下行',
        total: '合计',
        calls: '调用',
        avg: '均速',
        cache: '缓存',
        context: '上下文',
        cost: '成本',
        turn: '本轮',
        chipTip: 'Token 生成速度 — 点击查看详情',
        resetLabel: 'Token 计量: 清空采样',
        resetDone: 'Token 速度采样已清空'
      }
    })

    // Every assistant/reasoning text frame feeds the estimator. thinking.delta
    // is excluded: the core rewrites it with spinner frames, not real output.
    for (const type of ['message.delta', 'reasoning.delta']) {
      ctx.onEvent(type, event => {
        const text = event?.payload?.text

        if (typeof text !== 'string' || text.length === 0) {
          return
        }

        // Unscoped frames belong to the focused turn; scoped ones must match it.
        const sid = event.session_id
        const focused = host.state.focusedSessionId.get()

        if (sid && focused && sid !== focused) {
          return
        }

        noteChars(text.length, Date.now())
      })
    }

    ctx.onEvent('message.start', () => {
      charTimes = []
      lastSpeed = 0
      const usage = host.state.focusedUsage.get()

      turnBase = usage ? { output: usage.output } : null
      $turnTokens.set(0)
    })

    ctx.onEvent('message.complete', () => {
      turnBase = null
      $streaming.set(false)
    })

    ctx.setInterval(tick, TICK_MS)

    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 118,
      render: () => jsx(Chip, {})
    })

    ctx.register({
      id: 'reset',
      area: PALETTE_AREA,
      data: {
        id: 'token-speed.reset',
        keywords: ['token', 'speed', 'tps', 'reset', 'throughput'],
        label: 'Token Speed: reset samples',
        run: () => {
          charTimes = []
          lastSpeed = 0
          pendingChars = 0
          $series.set([])
          $speed.set(0)
          host.notify({ kind: 'info', message: 'Token speed samples cleared' })
        }
      }
    })
  }
}
