/**
 * What the model providers say this account has left, and what today cost.
 *
 * The figures are DSH's own: it polls each provider and keeps the answers in
 * `~/.dsh/dsh-usage/provider-snapshots.json` (balances and subscription
 * windows) and `~/.dsh/dsh-usage/usage-ledger.json` (per day, per provider, per
 * model token counts and cost). Reading them means the phone shows exactly what
 * the desktop shows, and the bridge never handles a credential of its own — it
 * does not call a provider, it reads the answer DSH already fetched.
 *
 * @module dsh-qq/bridge/credit
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Read both usage files.
 *
 * @param dir - the DSH home directory (the one holding `dsh-usage/`).
 * @returns `{ snapshots, ledger }`, each null when unreadable.
 */
export function readCredit(dir) {
  return {
    snapshots: readJson(join(dir, 'dsh-usage', 'provider-snapshots.json')),
    ledger: readJson(join(dir, 'dsh-usage', 'usage-ledger.json')),
  }
}

/**
 * Parse one JSON file, tolerating absence and corruption.
 *
 * A missing file is the normal state before DSH has polled anything, and a
 * half-written one is possible while DSH rewrites it; neither is worth an error
 * on a phone.
 *
 * @param path - the file.
 * @returns The parsed value, or null.
 */
function readJson(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * The ledger's day key for one instant.
 *
 * Local time, not UTC: the operator means "today where I am", and the ledger is
 * keyed by the same kind of date.
 *
 * @param date - the instant.
 * @returns `YYYY-MM-DD`.
 */
export function dayKey(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${String(year)}-${String(month)}-${String(day)}`
}

/**
 * Render a figure a person can read at a glance.
 *
 * @param value - a count.
 * @returns A short form such as `470M`, `24.8M`, `40.6K`, `812`.
 */
export function compactNumber(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return '0'
  if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(1)}B`
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`
  return String(Math.round(number))
}

/** How the plan windows are named on a phone. */
const WINDOW_LABELS = { '5h': '5 小时', day: '今日', week: '本周', month: '本月' }

/** Symbols for the currencies the providers report in. */
const CURRENCY_SIGNS = { CNY: '¥', USD: '$', EUR: '€' }

/**
 * Which provider balances have fallen below a threshold.
 *
 * Kept here, next to the parsing, because "what counts as low" is a fact about
 * the data, not about the message that reports it. Two provider rows can carry
 * the same balance (an alias and its canonical id), so an identical figure is
 * reported once.
 *
 * @param snapshots - the provider snapshots, or null.
 * @param threshold - the amount below which a balance is worth reporting.
 * @returns One entry per distinct balance that is below the threshold.
 */
export function lowBalances(snapshots, threshold) {
  const providers = snapshots?.providers
  if (!(threshold > 0) || providers === null || typeof providers !== 'object') return []
  const out = []
  const seen = new Set()
  for (const entry of Object.values(providers)) {
    const balance = entry?.balance
    if (balance === null || typeof balance !== 'object') continue
    const fingerprint = `${String(balance.currency)}:${String(balance.totalBalance)}`
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    const amount = Number.parseFloat(String(balance.totalBalance))
    if (!Number.isFinite(amount) || amount >= threshold) continue
    const name = typeof entry.displayName === 'string' && entry.displayName !== '' ? entry.displayName : String(entry.provider ?? '?')
    out.push({ name, amount, currency: String(balance.currency ?? ''), raw: String(balance.totalBalance) })
  }
  return out
}

/**
 * Which subscription windows have filled to a threshold.
 *
 * A subscription account is not stopped by its balance but by its windows, and
 * a window fills without any message of its own: the provider simply begins
 * refusing requests mid-task, which on a phone is indistinguishable from any
 * other failure. The percentage in the snapshot is already the figure the
 * desktop shows, so reporting it here cannot disagree with what the operator
 * sees there.
 *
 * @param snapshots - the provider snapshots, or null.
 * @param thresholdPercent - the fill percentage at or above which a window is reported; zero disables the check.
 * @returns One entry per window at or above the threshold, in provider order.
 */
export function windowAlerts(snapshots, thresholdPercent) {
  const providers = snapshots?.providers
  if (!(thresholdPercent > 0) || providers === null || typeof providers !== 'object') return []
  const out = []
  for (const entry of Object.values(providers)) {
    const windows = entry?.plan?.windows
    if (!Array.isArray(windows)) continue
    const name = typeof entry.displayName === 'string' && entry.displayName !== '' ? entry.displayName : String(entry.provider ?? '?')
    for (const window of windows) {
      const percent = Number(window?.percent)
      if (!Number.isFinite(percent) || percent < thresholdPercent) continue
      const raw = String(window?.key ?? '?')
      out.push({
        name,
        label: WINDOW_LABELS[raw] ?? raw,
        percent,
        // Not every provider reports a reset instant. An absent one stays absent
        // so the message can call it unknown instead of inventing a time the
        // operator would then plan around.
        resetsAt: typeof window?.resetsAt === 'string' ? window.resetsAt : '',
      })
    }
  }
  return out
}

/**
 * Build the once-a-day plan-window warning.
 *
 * @param alerts - the windows {@link windowAlerts} reported.
 * @returns The message body, or '' when there is nothing to report.
 */
export function formatWindowAlert(alerts) {
  if (!Array.isArray(alerts) || alerts.length === 0) return ''
  const lines = ['⚠️ 套餐额度告警']
  for (const alert of alerts) {
    const reset = shortReset(alert.resetsAt)
    lines.push(`· ${alert.name} ${alert.label} 已用 ${String(alert.percent)}%（${reset === '' ? '重置时间未知' : `${reset} 重置`}）`)
  }
  lines.push('套餐窗口用满后该 provider 会直接拒绝请求，agent 会在任务中途报错。')
  lines.push('/usage 可以看到全部套餐窗口与重置时间。')
  return lines.join(String.fromCharCode(10))
}

/**
 * The smallest distinct balance on record.
 *
 * Distinct because two provider rows can report the same account; the projection
 * is only as good as the smallest balance, since that is the one that runs out
 * first.
 *
 * @param snapshots - the provider snapshots, or null.
 * @returns `{ amount, currency }`, or null when no balance is known.
 */
export function lowestBalance(snapshots) {
  const providers = snapshots?.providers
  if (providers === null || typeof providers !== 'object') return null
  const seen = new Set()
  let best = null
  for (const entry of Object.values(providers)) {
    const balance = entry?.balance
    if (balance === null || typeof balance !== 'object') continue
    const fingerprint = `${String(balance.currency)}:${String(balance.totalBalance)}`
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    const amount = Number.parseFloat(String(balance.totalBalance))
    if (!Number.isFinite(amount)) continue
    if (best === null || amount < best.amount) best = { amount, currency: String(balance.currency ?? '') }
  }
  return best
}

/** The sign for a currency, for messages that show money. */
export function currencySign(currency) {
  return CURRENCY_SIGNS[currency] ?? ''
}

/**
 * Average daily spend over the recent past.
 *
 * Only the ledger's `cost` is counted, which is real money: a subscription
 * provider reports zero and therefore does not dilute the figure. Days with no
 * entry are skipped rather than counted as zero, so a quiet day does not make
 * the estimate look better than it is.
 *
 * @param ledger - the usage ledger, or null.
 * @param now - the day to measure back from.
 * @param days - how many days to consider, today included.
 * @returns `{ perDay, days }`; `perDay` is 0 when nothing was charged.
 */
export function burnRate(ledger, now, days = 3) {
  const table = ledger?.days
  if (table === null || typeof table !== 'object') return { perDay: 0, days: 0 }
  let total = 0
  let counted = 0
  for (let back = 0; back < days; back += 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)
    const day = table[dayKey(date)]
    if (day === null || typeof day !== 'object') continue
    let cost = 0
    for (const models of Object.values(day)) {
      if (models === null || typeof models !== 'object') continue
      for (const usage of Object.values(models)) {
        if (usage === null || typeof usage !== 'object') continue
        cost += Number(usage.cost ?? 0)
      }
    }
    total += cost
    counted += 1
  }
  return { perDay: counted === 0 ? 0 : total / counted, days: counted }
}

/**
 * How long a balance lasts at a given daily spend.
 *
 * @param amount - the remaining balance.
 * @param perDay - the average daily cost.
 * @returns Whole days, or null when no estimate is meaningful.
 */
export function daysRemaining(amount, perDay) {
  if (!Number.isFinite(amount) || !Number.isFinite(perDay) || perDay <= 0) return null
  return Math.floor(amount / perDay)
}

/**
 * Build the `/usage` message.
 *
 * Only providers that actually have something to say appear: a row with no
 * balance, no plan window and no usage today is noise, and every provider the
 * deployment knows about — several of which have no credential at all — would
 * otherwise be listed.
 *
 * @param options - the data.
 * @param options.snapshots - the provider snapshots, or null.
 * @param options.ledger - the usage ledger, or null.
 * @param options.now - the current instant.
 * @returns The message body.
 */
export function formatCreditReport({ snapshots = null, ledger = null, now = new Date() } = {}) {
  const lines = ['💰 额度与用量']
  const providers = snapshots?.providers !== null && typeof snapshots?.providers === 'object' ? snapshots.providers : {}

  let said = false
  // Two provider rows can be the same account under different names (an alias
  // and its canonical id both report the same balance). Showing the same number
  // twice reads as two accounts, so an identical figure is only printed once.
  const shownBalances = new Set()
  for (const entry of Object.values(providers)) {
    if (entry === null || typeof entry !== 'object') continue
    const name = typeof entry.displayName === 'string' && entry.displayName !== '' ? entry.displayName : String(entry.provider ?? '?')
    const balance = entry.balance
    if (balance !== null && typeof balance === 'object' && typeof balance.totalBalance === 'string') {
      const fingerprint = `${String(balance.currency)}:${balance.totalBalance}`
      // The balance is skipped when it is a repeat, but NOT the rest of the
      // entry: the same provider row can still carry plan windows of its own.
      if (!shownBalances.has(fingerprint)) {
        shownBalances.add(fingerprint)
        const sign = CURRENCY_SIGNS[balance.currency] ?? ''
        const age = typeof balance.updatedAt === 'number' ? now.getTime() - balance.updatedAt : 0
        // A stale balance is worth flagging; a fresh one is not worth a timestamp.
        const when = age > 60 * 60 * 1000 ? `（${String(Math.round(age / 3600000))} 小时前）` : ''
        lines.push(`${name} 余额：${sign}${balance.totalBalance}${when}`)
        said = true
      }
    }
    const windows = entry.plan?.windows
    if (Array.isArray(windows) && windows.length > 0) {
      const parts = windows.map((window) => {
        const raw = String(window?.key ?? '?')
        const key = WINDOW_LABELS[raw] ?? raw
        const percent = Number(window?.percent ?? 0)
        const resets = typeof window?.resetsAt === 'string' ? shortReset(window.resetsAt) : ''
        return `${key} ${String(percent)}%${resets === '' ? '' : `（${resets}重置）`}`
      })
      lines.push(`${name} 套餐：${parts.join(' · ')}`)
      said = true
    }
  }

  // Spend projection. Only shown when money is actually being charged: a
  // subscription-only history would otherwise produce "about 674 days left",
  // which is true and useless.
  if (shownBalances.size > 0) {
    const rate = burnRate(ledger, now)
    if (rate.perDay > 0) {
      const lowest = lowestBalance(snapshots)
      const left = lowest === null ? null : daysRemaining(lowest.amount, rate.perDay)
      const sign = currencySign(lowest?.currency ?? '')
      lines.push(
        `近 ${String(rate.days)} 天平均：${sign}${rate.perDay.toFixed(2)}/天`
        + (left === null ? '' : ` · 余额约可用 ${String(left)} 天`),
      )
      said = true
    }
  }

  const today = ledger?.days?.[dayKey(now)]
  if (today !== null && typeof today === 'object') {
    const rows = []
    for (const [provider, models] of Object.entries(today)) {
      if (models === null || typeof models !== 'object') continue
      let calls = 0
      let input = 0
      let output = 0
      let cached = 0
      let cost = 0
      for (const usage of Object.values(models)) {
        if (usage === null || typeof usage !== 'object') continue
        calls += Number(usage.calls ?? 0)
        input += Number(usage.inputTokens ?? 0)
        output += Number(usage.outputTokens ?? 0)
        cached += Number(usage.cacheReadTokens ?? 0)
        cost += Number(usage.cost ?? 0)
      }
      if (calls === 0) continue
      const money = cost > 0 ? ` · ¥${cost.toFixed(2)}` : ''
      rows.push(`· ${provider}：${String(calls)} 次 · 入 ${compactNumber(input)} · 出 ${compactNumber(output)} · 缓存 ${compactNumber(cached)}${money}`)
    }
    if (rows.length > 0) {
      lines.push('', `今日（${dayKey(now).slice(5)}）`, ...rows)
      said = true
    }
  }

  if (!said) lines.push('（读不到用量数据 —— DSH 尚未轮询过任何 provider）')
  return lines.join(String.fromCharCode(10))
}

/**
 * Render a reset instant as a short local marker.
 *
 * @param iso - the timestamp the window resets at.
 * @returns `MM-DD HH:MM`, or '' when it cannot be read.
 */
function shortReset(iso) {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const month = String(at.getMonth() + 1).padStart(2, '0')
  const day = String(at.getDate()).padStart(2, '0')
  const hours = String(at.getHours()).padStart(2, '0')
  const minutes = String(at.getMinutes()).padStart(2, '0')
  return `${month}-${day} ${hours}:${minutes}`
}
