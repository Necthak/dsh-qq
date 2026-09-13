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
