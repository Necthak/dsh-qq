/**
 * dsh-qq: the official QQ bot channel for DeepSeek Harness.
 *
 * This plugin runs INSIDE the DSH process rather than beside it, which is the
 * central design decision. DSH's `/api` requires a signed, authority-bound
 * cookie minted from a per-process launch token, so an external bridge process
 * cannot authenticate at all; an in-process plugin needs no HTTP, no token, and
 * no credential of its own. It also means the bridge shares DSH's lifecycle —
 * no health probing, no reconnect queue, no single-instance lock.
 *
 * The plugin therefore talks to QQ directly (official OpenAPI + WebSocket
 * gateway) and reaches DSH through its own services:
 *
 * - `ctx.sessionController` — create sessions and deliver prompts
 * - `ctx.on('session/event')` — collect assistant output per turn
 * - `ctx.on('approval/request')` / `ctx.on('user-questions/request')` — answer
 *   the agent's questions from QQ
 * - `ctx.tools` — let the agent speak to QQ on its own initiative
 *
 * The bridge is off until `enabled` is set, because switching it on connects an
 * agent with shell access to a messaging network.
 *
 * @module dsh-qq
 */

import z from '@deepseek-ai/schemastery'
import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { QqApi } from './qq/api.js'
import { QqGateway } from './qq/gateway.js'
import { QqTokenProvider } from './qq/token.js'
import { normalizeInteraction, normalizeMessage } from './qq/events.js'

/** Group notice events the platform sends when the receive-all switch moves. */
const EVENT_GROUP_RECEIVE = 'GROUP_MSG_RECEIVE'
const EVENT_GROUP_REJECT = 'GROUP_MSG_REJECT'

import { SessionMap, splitConversationKey } from './bridge/sessions.js'
import { createSessionEnsurer } from './bridge/session-create.js'
import { DEFAULT_BUSY_DELIVERY } from './bridge/delivery.js'
import { createModelSwitcher } from './bridge/model.js'
import { createSessionCommands } from './bridge/commands.js'
import { createInteractionHandler } from './bridge/interactions.js'
import { Outbound, TurnCollector } from './bridge/outbound.js'
import { PendingInteractions } from './bridge/pending.js'
import { createInboundHandler } from './bridge/inbound.js'
import { registerApprovalAnswerer } from './bridge/approvals.js'
import { registerQuestionAnswerer } from './bridge/questions.js'
import { registerQqTools } from './bridge/tools.js'
import { authenticatedWebUrl, createRestartService, readRestarterTail, resolveLauncher, verifyPluginLoads } from './bridge/restart.js'
import { TurnProgress, dueHeartbeat, heartbeatLine } from './bridge/progress.js'
import { captureScreen } from './bridge/capture.js'
import { currencySign, lowBalances, readCredit } from './bridge/credit.js'
import { installPanels } from './bridge/panel.js'
import { registerConsole } from './console.js'

/** How often the long-turn heartbeat is evaluated, independent of its interval. */
const HEARTBEAT_TICK_MS = 15_000

/** How often the balance is read. Hourly: it moves slowly and the read is I/O. */
const BALANCE_CHECK_MS = 60 * 60 * 1000

/** How often the watchdog is checked for being alive. */
const WATCHDOG_CHECK_MS = 5 * 60 * 1000

/** Cordis plugin name. */
export const name = 'dsh-qq'

/**
 * Services this plugin cannot work without. `webServer` and
 * `workspaceRegistry` are optional and read through `ctx.get`, so the plugin
 * still loads on a profile that lacks them.
 */
export const inject = ['sessionController', 'tools', 'settings']

/** Settings namespace shown on the DSH settings page. */
export const SETTINGS_NS = 'dsh-qq'

/**
 * The bridge's user-editable surface. Defaults are deliberately conservative:
 * the bridge is off, it allows nobody, and the agent cannot send on its own.
 */
export const SETTINGS_SCHEMA = z.object({
  /** Whether the QQ channel connects at all. */
  enabled: z.boolean().default(false),
  /** Bot AppID from the QQ open platform. */
  appId: z.string().default(''),
  /** Bot AppSecret; marked secret so configuration surfaces redact it. */
  appSecret: z.string().role('secret').default(''),
  /** `chat` limits the agent; `closed-agent` grants the full tool set. */
  mode: z.string().default('closed-agent'),
  /** OpenID allowed to run `/reset` and other administration. */
  ownerOpenId: z.string().default(''),
  /** OpenIDs (users or groups) allowed to reach the agent. */
  allow: z.array(z.string()).default([]),
  /** OpenIDs always refused, checked before the allow list. */
  deny: z.array(z.string()).default([]),
  /** Whether an empty allow list admits everyone. Off by default. */
  allowAllWhenEmpty: z.boolean().default(false),
  /** Whether the agent may call `qq_send_message` / `qq_reply`. */
  allowAgentSend: z.boolean().default(true),
  /** Whether approval requests are forwarded to QQ. */
  forwardApprovals: z.boolean().default(true),
  /** Whether `ask_user_question` prompts are forwarded to QQ. */
  forwardQuestions: z.boolean().default(true),
  /**
   * Where a QQ message lands while a turn is already running: `steer` inserts it
   * into the current turn at the next step boundary, `queue` waits for the turn
   * to finish. `/steer` and `/queue` override it per message.
   */
  busyDelivery: z.string().default(DEFAULT_BUSY_DELIVERY),
  /** How long an approval waits for a QQ reply before delegating. */
  approvalTimeoutMs: z.number().default(300_000),
  /** How long a question waits for a QQ reply before delegating. */
  questionTimeoutMs: z.number().default(300_000),
  /** Byte budget per QQ message; longer answers are split. */
  maxBytes: z.number().default(3_500),
  /** Milliseconds between consecutive QQ messages. */
  intervalMs: z.number().default(1_200),
  /**
   * How an outbound message is encoded: `auto` (the default) sends markdown
   * whenever the platform can render the text faithfully, `always` forces it,
   * and `never` converts everything to plain text. A message carrying an inline
   * keyboard is always markdown, because buttons only render on a markdown body.
   */
  markdownMode: z.string().default('auto'),
  /** Directory QQ sessions work in; empty means the DSH process directory. */
  workspacePath: z.string().default(''),
  /** Agent preset for QQ sessions; empty uses the profile default. */
  agentPreset: z.string().default(''),
  /**
   * Warn once a day when a provider balance falls below this. Zero disables the
   * warning. A balance that runs out does not announce itself: the agent simply
   * starts failing mid-task, which on a phone is indistinguishable from any
   * other error.
   */
  lowBalanceThreshold: z.number().default(5),
  /**
   * Launcher `/restart` runs after this process exits; empty accepts the
   * `Documents/Start-DeepSeek-Harness.cmd` default when that file exists.
   */
  restartCommand: z.string().default(''),
  /**
   * How often a running turn narrates itself into QQ; 0 disables it. Each
   * heartbeat is a message, so this is off unless the operator asks for it.
   */
  progressIntervalMs: z.number().default(0),
})

/** Defaults applied below the user layer. */
const SETTINGS_DEFAULTS = {
  enabled: false,
  appId: '',
  appSecret: '',
  mode: 'closed-agent',
  ownerOpenId: '',
  allow: [],
  deny: [],
  allowAllWhenEmpty: false,
  allowAgentSend: true,
  forwardApprovals: true,
  forwardQuestions: true,
  busyDelivery: DEFAULT_BUSY_DELIVERY,
  approvalTimeoutMs: 300_000,
  questionTimeoutMs: 300_000,
  maxBytes: 3_500,
  intervalMs: 1_200,
  markdownMode: 'auto',
  workspacePath: '',
  agentPreset: '',
  restartCommand: '',
  progressIntervalMs: 0,
}

/**
 * Wire the bridge into a DSH context.
 *
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  // Every line carries a wall-clock time. This file is the only witness for
  // things like "did the gateway flap, or was that six reconnects spread over
  // three hours?" - a question that cannot be answered without a clock, and one
  // that produced a false alarm the first time it was asked.
  const log = (message) => {
    const at = new Date()
    const hh = String(at.getHours()).padStart(2, '0')
    const mm = String(at.getMinutes()).padStart(2, '0')
    const ss = String(at.getSeconds()).padStart(2, '0')
    console.log(`[dsh-qq ${hh}:${mm}:${ss}] ${message}`)
  }

  let scope = null
  try {
    scope = ctx.settings.register(SETTINGS_NS, SETTINGS_SCHEMA, { base: SETTINGS_DEFAULTS })
  } catch (error) {
    console.error(`[dsh-qq] settings registration failed: ${String(error?.message ?? error)}`)
  }

  let current = { ...SETTINGS_DEFAULTS }
  const config = () => current

  const sessions = new SessionMap({ path: sessionTablePath(), log })
  const pending = new PendingInteractions({ log })

  // Live state reported by `/status` and `qq_get_status`.
  const state = { gateway: 'stopped', pending: 0 }
  const rejected = createRejectionLog()
  const status = () => ({
    gateway: state.gateway,
    conversations: sessions.size,
    pending: pending.size,
    rejected: rejected.entries(),
    // Read through the live sender: the channel is rebuilt on every settings
    // change, so the last failure must not be captured from a dead instance.
    lastFailure: outbound?.lastFailure ?? null,
  })

  /** The model catalog and switch operations behind `/model`. */
  const models = createModelSwitcher({ ctx, log })

  /** Whether a session's agent is mid-turn, for the delivery decision. */
  const busy = createBusyProbe({ ctx, log })

  /**
   * `/restart` — hand this process over to the launcher and come back.
   *
   * The launcher is resolved when the command runs rather than at load, so
   * editing the setting or moving the file takes effect on the next use.
   */
  const restarts = createRestartService({
    markerPath: restartMarkerPath(),
    logPath: restartLogPath(),
    log,
    resolve: () => ({ launcher: resolveLauncher(config().restartCommand), port: webPort(ctx) }),
    // The import graph is exercised before the process hands itself over: a
    // broken edit must not be able to take the bridge down through the one
    // channel that could otherwise report it.
    preflight: () => verifyPluginLoads({ entryPath: pluginEntryPath() }),
  })

  /**
   * Read the provider balances and today's usage.
   *
   * Both files are DSH's own (`~/.dsh/dsh-usage/`), refreshed by its usage
   * plugin: the bridge reads them rather than calling a provider, so it needs no
   * credential of its own and cannot disagree with the desktop about what is
   * left.
   *
   * @returns `{ snapshots, ledger }`, each null when unreadable.
   */
  function credit() {
    return readCredit(dshHome())
  }

  /** What each bound session's live turn is doing, folded from its events. */
  const progress = new TurnProgress()

  /** When each conversation last heard a progress heartbeat. */
  const heartbeats = new Map()

  /**
   * Narrate a long turn, when the operator asked for it.
   *
   * A phone cannot poll: `/status` answers "what is it doing" only if you think
   * to ask, and a turn that runs for ten minutes is exactly when you stop
   * thinking to ask. The pacing rule lives in `dueHeartbeat` so it is testable;
   * this only supplies the live inputs.
   *
   * Off by default because every heartbeat is a real message: it spends the
   * passive window, and then the active quota the operator may have switched
   * off entirely.
   */
  /** Last balance reading and warning, so neither repeats needlessly. */
  let balanceCheckedAt = 0
  let balanceWarnedOn = ''

  /** Last watchdog liveness check, and whether its absence was already reported. */
  let watchdogCheckedAt = 0
  let watchdogReported = false

  /**
   * Tell every bound conversation something.
   *
   * Used only for rare, self-inflicted events (a balance about to run out, the
   * watchdog having died). Not for progress: that has its own interval and its
   * own switch, because every message here spends a real quota.
   *
   * @param text - the message body.
   */
  function notifyAll(text) {
    if (outbound === null) return
    for (const entry of sessions.entries()) {
      const target = splitConversationKey(entry.key)
      if (target === null) continue
      outbound
        .deliver({ key: entry.key, kind: target.kind, peerId: target.peerId, text })
        .catch((error) => { log(`${entry.key}: notice failed: ${String(error?.message ?? error)}`) })
    }
  }

  /**
   * Warn once a day when a provider balance is nearly gone.
   *
   * Reading DSH's own snapshot means no credential is handled here, and the
   * figure is the one the desktop shows.
   */
  function checkBalance() {
    const threshold = Number.isFinite(current.lowBalanceThreshold) ? current.lowBalanceThreshold : 0
    if (threshold <= 0) return
    const low = lowBalances(credit().snapshots, threshold)
    if (low.length === 0) return
    const today = new Date().toISOString().slice(0, 10)
    if (balanceWarnedOn === today) return
    balanceWarnedOn = today
    const worst = low[0]
    log(`${worst.name} balance ${worst.raw} is below ${String(threshold)}; warning the owner`)
    notifyAll([
      `⚠️ ${worst.name} 余额只剩 ${currencySign(worst.currency)}${worst.raw}（阈值 ${currencySign(worst.currency)}${String(threshold)}）`,
      '额度用完时不会有单独的提示，agent 会在任务中途开始报错。',
      '充值后这条提醒自动停止；/usage 随时可看。',
    ].join(String.fromCharCode(10)))
  }


  /**
   * Notice when the watchdog is gone, and put it back.
   *
   * The protection chain is launcher → watchdog → server, so a watchdog that
   * dies while the server lives removes the protection silently — the operator
   * keeps believing a crash will be repaired within a minute when nothing is
   * watching at all. A PID file that exists but names a dead process is that
   * exact situation; a missing file just means this deployment was started
   * without one, which is not worth a message.
   */
  function checkWatchdog() {
    const pidPath = `${dshHome()}/dsh-qq-watchdog.pid`
    let raw = ''
    try {
      raw = readFileSync(pidPath, 'utf8').trim()
    } catch {
      return
    }
    const pid = Number.parseInt(raw, 10)
    if (!Number.isSafeInteger(pid) || pid <= 0) return
    if (isProcessAlive(pid)) {
      watchdogReported = false
      return
    }
    if (!watchdogReported) {
      watchdogReported = true
      log(`watchdog pid ${String(pid)} is gone; restarting it`)
      notifyAll('⚠️ 看门狗进程已消失（服务本身还在跑，但崩溃自动恢复的保护已经失效）—— 正在重新拉起。')
    }
    startWatchdog()
  }

  /**
   * Put the watchdog back, windowless.
   *
   * Uses the deployment's own spawner, which is the only launcher path measured
   * to start a process that survives its parent AND has no window. A visible
   * window would be the very thing this whole arrangement exists to avoid.
   */
  function startWatchdog() {
    const launcher = resolveLauncher(current.restartCommand)
    if (launcher === null) {
      log('watchdog could not be restarted: no launcher was found')
      return
    }
    const dir = dirname(launcher)
    const spawner = join(dir, 'Start-DeepSeek-Harness.ps1')
    const watchdog = join(dir, 'Start-DeepSeek-Harness.watchdog.cmd')
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', spawner, '-Server', watchdog], {
        stdio: 'ignore',
        windowsHide: true,
      })
      child.unref?.()
      log('watchdog restarted')
    } catch (error) {
      log(`watchdog could not be restarted: ${String(error?.message ?? error)}`)
    }
  }

  /**
   * Run the periodic housekeeping that is not about progress.
   *
   * Both checks are throttled here rather than given their own timers: this
   * process already wakes every fifteen seconds, and a second timer would be
   * another thing to dispose.
   */
  function housekeepingTick() {
    const now = Date.now()
    if (now - balanceCheckedAt >= BALANCE_CHECK_MS) {
      balanceCheckedAt = now
      try {
        checkBalance()
      } catch (error) {
        log(`balance check failed: ${String(error?.message ?? error)}`)
      }
    }
    if (now - watchdogCheckedAt >= WATCHDOG_CHECK_MS) {
      watchdogCheckedAt = now
      try {
        checkWatchdog()
      } catch (error) {
        log(`watchdog check failed: ${String(error?.message ?? error)}`)
      }
    }
  }

  function heartbeatTick() {
    const intervalMs = Number.isSafeInteger(current.progressIntervalMs) ? current.progressIntervalMs : 0
    if (intervalMs <= 0 || outbound === null) return
    const now = Date.now()
    for (const entry of sessions.entries()) {
      const target = splitConversationKey(entry.key)
      if (target === null) continue
      const line = dueHeartbeat({
        snapshot: progress.snapshot(entry.sessionId),
        lastSentAt: heartbeats.get(entry.key) ?? 0,
        now,
        intervalMs,
      })
      if (line === null) continue
      heartbeats.set(entry.key, now)
      outbound
        .deliver({ key: entry.key, kind: target.kind, peerId: target.peerId, text: line })
        .catch((error) => { log(`${entry.key}: progress heartbeat failed: ${String(error?.message ?? error)}`) })
    }
  }

  const heartbeatTimer = setInterval(() => {
    heartbeatTick()
    housekeepingTick()
  }, HEARTBEAT_TICK_MS)
  heartbeatTimer.unref?.()

  /**
   * Capture the screen (or one window) and put it in the asking conversation.
   *
   * Owned here rather than in the command module because it needs both the
   * capture helper and the live sender, and the command module has neither.
   *
   * @param options - target and what to capture.
   * @returns The capture's shape, for logging.
   */
  async function screenshot({ key, process: processName }) {
    const target = splitConversationKey(key)
    if (target === null || outbound === null) throw new Error('QQ 通道当前未连接')
    const shot = await captureScreen({ process: processName, log })
    await outbound.sendImage({ key, kind: target.kind, peerId: target.peerId, data: shot.data, fileName: `screen-${String(Date.now())}.png` })
    return shot
  }

  /**
   * Read the tail of the bridge log.
   *
   * Only the plugin's own lines are returned: the file is shared with DSH, and
   * what an operator wants from a phone is what this bridge has been doing.
   *
   * @param options - how many lines.
   * @param options.limit - maximum lines to return.
   * @returns `{ lines, error }`; `lines` are oldest first.
   */
  function readBridgeLog({ limit = 15 } = {}) {
    const path = join(dshHome(), 'web-launch.log')
    let raw = ''
    try {
      // Only the tail is read. The log grows for as long as the deployment runs,
      // and a diagnostic command should not pull a hundred megabytes into memory
      // to show fifteen lines.
      const TAIL_BYTES = 256 * 1024
      const size = statSync(path).size
      const start = size > TAIL_BYTES ? size - TAIL_BYTES : 0
      const handle = openSync(path, 'r')
      try {
        const buffer = Buffer.alloc(size - start)
        readSync(handle, buffer, 0, buffer.length, start)
        raw = buffer.toString('utf8')
      } finally {
        closeSync(handle)
      }
    } catch (error) {
      return { lines: [], error: `读取日志失败：${String(error?.message ?? error)}` }
    }
    const all = raw.split(String.fromCharCode(10))
    const mine = []
    for (const line of all) {
      if (!line.startsWith('[dsh-qq')) continue
      mine.push(line.replace(/^\[dsh-qq ([0-9:]+)\] /, '$1  '))
    }
    const capped = Math.max(1, Math.min(40, Number.isSafeInteger(limit) ? limit : 15))
    return { lines: mine.slice(-capped), error: '' }
  }

  /**
   * Run the checks behind `/doctor`.
   *
   * `/status` reports what the bridge knows; this one actively looks. The
   * distinction matters on a phone, where the operator cannot open Task Manager
   * to see whether the watchdog is still there or whether the port is bound.
   *
   * @returns One finding per check: `{ level, label, detail }`.
   */
  async function doctor() {
    const findings = []
    const settings = current
    const port = webPort(ctx)

    findings.push(settings.enabled === true
      ? { level: 'ok', label: '通道已启用', detail: `AppID ${String(settings.appId ?? '')}` }
      : { level: 'bad', label: '通道未启用', detail: '设置卡片顶部的开关是关闭的' })

    const online = gateway?.online === true
    findings.push(online
      ? { level: 'ok', label: 'QQ 网关在线', detail: '事件通道已连接' }
      : { level: 'bad', label: 'QQ 网关离线', detail: '正在按退避重连；若持续离线请查看 /log' })

    const pidPath = join(dshHome(), 'dsh-qq-watchdog.pid')
    let watchdogPid = 0
    try {
      const parsed = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10)
      if (Number.isSafeInteger(parsed) && parsed > 0) watchdogPid = parsed
    } catch { /* no pid file: the deployment may not install one */ }
    if (watchdogPid === 0) {
      findings.push({ level: 'warn', label: '看门狗未安装', detail: '服务消失后不会自动恢复' })
    } else {
      findings.push(isProcessAlive(watchdogPid)
        ? { level: 'ok', label: '看门狗存活', detail: `pid ${String(watchdogPid)}` }
        : { level: 'bad', label: '看门狗已消失', detail: '自动恢复失效，桥接会在下一次心跳尝试拉起它' })
    }

    const ownerOpenId = typeof settings.ownerOpenId === 'string' ? settings.ownerOpenId.trim() : ''
    const credential = typeof settings.appId === 'string' && settings.appId !== ''
      && typeof settings.appSecret === 'string' && settings.appSecret !== ''
    findings.push(ownerOpenId === ''
      ? { level: 'bad', label: '未设置 owner', detail: 'closed-agent 模式下任何人都不会被放行' }
      : { level: 'ok', label: 'owner 已设置', detail: `模式 ${String(settings.mode ?? '')}` })
    findings.push(credential
      ? { level: 'ok', label: '凭据齐全', detail: 'AppID 与 AppSecret 均已配置' }
      : { level: 'bad', label: '凭据缺失', detail: '请扫码绑定或手工填写' })

    try {
      const low = lowBalances(credit().snapshots, Number.isFinite(settings.lowBalanceThreshold) ? settings.lowBalanceThreshold : 0)
      if (low.length === 0) {
        findings.push({ level: 'ok', label: '余额正常', detail: '高于告警阈值' })
      } else {
        findings.push({ level: 'warn', label: '余额偏低', detail: `${low[0].name} ${low[0].raw}（阈值 ${String(settings.lowBalanceThreshold)}）` })
      }
    } catch (error) {
      findings.push({ level: 'warn', label: '余额不可读', detail: String(error?.message ?? error) })
    }

    const bound = sessions.entries().length
    const waiting = pending.entries().length
    findings.push({
      level: waiting === 0 ? 'ok' : 'warn',
      label: '会话与交互',
      detail: `${String(bound)} 个已绑定会话 · ${String(waiting)} 个待应答交互`,
    })

    const failure = outbound?.lastFailure ?? null
    findings.push(failure === null
      ? { level: 'ok', label: '最近一次发送', detail: '无失败记录' }
      : { level: 'warn', label: '最近一次发送失败', detail: String(failure) })

    const rejectedCount = rejected.entries().length
    if (rejectedCount > 0) {
      findings.push({ level: 'warn', label: '有被拒绝的发送者', detail: `${String(rejectedCount)} 个（可在设置卡片里设为 owner）` })
    }
    findings.push(port > 0 && port !== null
      ? { level: 'ok', label: '控制台端口', detail: String(port) }
      : { level: 'warn', label: '控制台端口未知', detail: '不在 web 部署下运行时无法推出' })
    return findings
  }

  /**
   * Read the agent's task list for the current turn.
   *
   * `todos` is a projection registered by DSH's todo tool: the same list the
   * desktop task panel renders, and it resets at every `turn/start`, so it
   * answers "what is this turn doing" rather than "what has ever been planned".
   * Reading it costs no turn and no tokens, which is the point of a command.
   *
   * @param sessionId - the DSH session behind the conversation.
   * @returns The list, or null when the session is unknown.
   */
  function todos(sessionId) {
    try {
      const resolved = ctx.sessionController?.resolveAgent?.(sessionId)
      if (resolved === null || typeof resolved?.then !== 'function') return null
      return resolved.then((settled) => {
        const agent = settled?.agent
        if (agent === undefined) return null
        const projections = typeof ctx.get === 'function' ? ctx.get('sessionProjections') : undefined
        const value = projections?.stateOf?.(agent.session, 'todos')
        return Array.isArray(value) ? value : null
      })
    } catch (error) {
      log(`todos could not be read (${String(error?.message ?? error)})`)
      return null
    }
  }

  /**
   * Install the platform's instruction panel wherever this bridge is used.
   *
   * One panel per scope, covering the conversations that are actually bound:
   * `group` for the groups this bot was admitted to and `c2c` for the direct
   * chats, with `target_type: specific` so nothing is changed for anyone else
   * who might ever talk to the bot. The panel is found again by its remark, so
   * running this twice updates rather than duplicates.
   *
   * @returns One result per scope.
   */
  function panelTargets() {
    const groups = []
    const users = []
    for (const entry of sessions.entries()) {
      const target = splitConversationKey(entry.key)
      if (target === null) continue
      if (target.kind === 'group') groups.push(target.peerId)
      else users.push(target.peerId)
    }
    return [
      { scope: 'group', ids: [...new Set(groups)].slice(0, 20) },
      { scope: 'c2c', ids: [...new Set(users)].slice(0, 20) },
    ]
  }

  async function installMenu() {
    if (api === null) throw new Error('QQ 通道尚未连接')
    return installPanels({ api, targets: panelTargets(), log })
  }

  /** Workspace, session picking, and cancellation behind their own commands. */
  const commands = createSessionCommands({ ctx, sessions, pending, settingsScope: scope, restart: restarts, busy, credit, screenshot, readLog: readBridgeLog, doctor, todos, installMenu, log })

  /** Button callbacks from the inline keyboards this bridge sends. */
  const interactions = createInteractionHandler({
    sessions,
    models,
    pending,
    config,
    log,
    outbound: liveOutbound(() => outbound, log),
    // A menu button runs the command the operator would otherwise have typed.
    // Synthesising the message keeps every rule in one place: the same
    // admission, the same owner checks, the same output, and no second
    // implementation that could drift from the typed path.
    runCommand: async ({ name, key, kind, peerId, userId }) => {
      const sender = liveOutbound(() => outbound, log)
      await commands({
        name,
        args: [],
        message: { kind, peerId, userId, text: '', attachments: [], ark: '' },
        key,
        settings: current,
        signal: prompts.signal,
        reply: (text) => sender.deliver({ key, kind, peerId, text }),
      })
    },
    onRejected: (interaction) => {
      const fresh = rejected.record(interaction)
      if (fresh) log(`refused button from ${interaction.kind}:${interaction.peerId} (user ${interaction.userId})`)
    },
  })

  let tokenProvider = null
  let api = null
  let gateway = null
  let outbound = null
  let collector = null
  let inbound = null
  let pairing = null

  // The Session Controller requires a cancellation signal on prompt admission
  // (`prompt(request, signal)` dereferences it immediately). One controller for
  // the plugin's lifetime is the right scope: unloading the bridge aborts any
  // admission still in flight instead of leaving it dangling.
  const prompts = new AbortController()

  /** Sessions whose current turn already sent a QQ message through a tool. */
  const toolSent = new Set()

  /**
   * Resolve the DSH session for a QQ conversation, creating it on first contact.
   *
   * @param key - the conversation key.
   * @returns The DSH session id.
   */
  const ensureSession = createSessionEnsurer({ ctx, sessions, config, log })

  /**
   * Rebuild the QQ channel whenever the credentials or the on/off switch move.
   *
   * Rebuilding wholesale rather than patching keeps the token cache, the socket,
   * and the heartbeat consistent with one set of credentials.
   */
  async function reconcileChannel() {
    const wanted = current.enabled === true
      && typeof current.appId === 'string' && current.appId.trim() !== ''
      && typeof current.appSecret === 'string' && current.appSecret.trim() !== ''

    if (gateway !== null) {
      await gateway.stop()
      gateway = null
      state.gateway = 'stopped'
    }
    if (!wanted) {
      if (current.enabled === true) log('QQ channel is enabled but AppID/AppSecret are incomplete; staying offline')
      return
    }

    tokenProvider = new QqTokenProvider({
      appId: current.appId.trim(),
      clientSecret: current.appSecret.trim(),
      log: (message) => log(message),
    })
    api = new QqApi({ tokens: tokenProvider, log: (message) => log(message) })

    // A panel is a copy of this build's command list, so it becomes a lie the
    // moment the list changes - which is exactly what happened: the operator
    // kept opening a picker that offered ten commands while the bridge answered
    // seventeen. Refreshing at start-up keeps the copy honest. Only panels that
    // already exist are touched: an operator who deleted theirs meant it, and
    // creating one here would quietly undo that.
    installPanels({ api, targets: panelTargets(), log, existingOnly: true }).catch((error) => {
      log(`panel refresh failed: ${String(error?.message ?? error)}`)
    })
    outbound = new Outbound({ api, sessions, log, config })
    gateway = new QqGateway({
      tokens: tokenProvider,
      api,
      log: (message) => log(message),
      onState: (next) => {
        state.gateway = next
        // A restart's whole point is coming back, and the address of the new
        // process is the one thing an operator cannot guess. Announcing on the
        // online transition — rather than at load — is what guarantees the
        // sender exists by the time the message is handed to it.
        if (next === 'online') announceRestart()
      },
      onEvent: (eventName, data, envelopeId) => {
        const message = normalizeMessage(eventName, data)
        if (message !== null) {
          if (inbound === null) return
          inbound(message).catch((error) => {
            log(`inbound handling failed: ${String(error?.message ?? error)}`)
          })
          return
        }
        // A button press is routed like a message but never becomes a prompt:
        // it replays the action the equivalent typed command would have run.
        const interaction = normalizeInteraction(eventName, data, envelopeId)
        if (interaction !== null) {
          interactions(interaction).catch((error) => {
            log(`interaction handling failed: ${String(error?.message ?? error)}`)
          })
          return
        }
        // Flipping a group into full mode is otherwise invisible: the event
        // carries no message and nothing else reports it, so an operator who
        // just changed the setting has no way to tell it took effect.
        if (eventName === EVENT_GROUP_RECEIVE || eventName === EVENT_GROUP_REJECT) {
          const group = typeof data?.group_openid === 'string' ? data.group_openid : 'unknown'
          log(eventName === EVENT_GROUP_RECEIVE
            ? `group ${group} enabled receive-all-messages; messages there no longer need to @ the bot`
            : `group ${group} disabled receive-all-messages; messages there must @ the bot again`)
        }
      },
    })
    // `start` now hands back the connect promise, so this catch is attached to
    // something real. `#connect` guards its own awaits, but a rejection that
    // escaped it would otherwise be unhandled AND invisible — the channel would
    // simply go quiet, which is the worst possible failure for a remote control.
    gateway.start().catch((error) => {
      log(`QQ channel connect failed unexpectedly: ${String(error?.message ?? error)}`)
    })
    log(`QQ channel starting for AppID ${current.appId.trim()}`)
  }

  /** Apply a settings change and rebuild anything that depends on it. */
  function syncSettings() {
    if (scope !== null) {
      try {
        const value = scope.get()
        current = { ...SETTINGS_DEFAULTS, ...(value !== null && typeof value === 'object' ? value : {}) }
      } catch (error) {
        log(`settings could not be read: ${String(error?.message ?? error)}`)
      }
    }
    // An AppSecret supplied through the environment wins when settings are
    // empty, so a deployment can keep the secret out of the stored document.
    if (current.appSecret === '' && typeof process.env.DSH_QQ_APPSECRET === 'string') {
      current = { ...current, appSecret: process.env.DSH_QQ_APPSECRET }
    }
    if (current.appId === '' && typeof process.env.DSH_QQ_APPID === 'string') {
      current = { ...current, appId: process.env.DSH_QQ_APPID }
    }
    reconcileChannel().catch((error) => {
      log(`channel reconciliation failed: ${String(error?.message ?? error)}`)
    })
  }

  syncSettings()
  if (scope !== null) scope.watch(syncSettings)

  // ── outbound: turn output becomes QQ messages ────────────────────────────

  collector = new TurnCollector({
    log,
    onTurnEnd: (sessionId, text) => {
      const key = sessions.keyForSession(sessionId)
      if (key === undefined) return
      if (toolSent.has(sessionId)) {
        // The agent already spoke through a tool this turn; forwarding again
        // would duplicate its message.
        toolSent.delete(sessionId)
        log(`${key}: skipping the automatic forward, the turn sent its own QQ message`)
        return
      }
      if (outbound === null) return
      const target = splitConversationKey(key)
      if (target === null) return
      outbound.deliver({ key, kind: target.kind, peerId: target.peerId, text }).catch((error) => {
        log(`${key}: delivery failed: ${String(error?.message ?? error)}`)
      })
    },
  })

  const offSessionEvent = ctx.on('session/event', (session, event) => {
    const sessionId = session?.header?.id
    if (typeof sessionId !== 'string') return
    if (sessions.keyForSession(sessionId) === undefined) return
    collector.observe(sessionId, event)
    progress.observe(sessionId, event)
  })

  const offAgentError = ctx.on('agent/error', ({ agent, error }) => {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string') return
    const key = sessions.keyForSession(sessionId)
    if (key === undefined) return
    const target = splitConversationKey(key)
    if (target === null || outbound === null) return
    const detail = String(error?.message ?? error ?? '未知错误')
    // Forwarding the error to the operator is not enough to diagnose it: the
    // one time this mattered, the message reached QQ and the log said nothing,
    // so the only record of a provider rejection was a chat message that could
    // be scrolled away. The session id is what makes a recurrence traceable.
    log(`${key}: agent error (session ${sessionId}): ${detail}`)
    outbound
      .sendActive({ key, kind: target.kind, peerId: target.peerId, text: `⚠️ agent 出错：${detail}` })
      .catch(() => {})
  })

  // ── inbound ──────────────────────────────────────────────────────────────

  // Every consumer is registered once at load, but the channel is rebuilt
  // whenever settings change, so each one sends through a proxy that resolves
  // the live sender at call time instead of capturing a stale one.
  inbound = createInboundHandler({
    ctx,
    sessions,
    outbound: liveOutbound(() => outbound, log),
    pending,
    models,
    commands,
    config,
    log,
    ensureSession,
    status,
    busy,
    progress: (sessionId, running) => progress.describe(sessionId, running),
    signal: prompts.signal,
    onRejected: (message) => {
      const fresh = rejected.record(message)
      // Logging the OpenID is what lets an operator admit themselves; without
      // it a fail-closed default would be impossible to escape.
      if (fresh) log(`refused ${message.kind}:${message.peerId} (user ${message.userId}); add that OpenID to the allow list to admit it`)
    },
  })

  /**
   * Tell the conversation that asked for a restart that the server is back.
   *
   * The one thing the operator cannot know is which URL authenticates now: each
   * process mints its own launch token, so a saved link answers 404 after every
   * restart. Pushing the fresh one is the difference between "restarted from
   * QQ" and "restarted from QQ and then hunted for the right tab".
   *
   * Runs once: the marker is consumed as it is read, so a restart produces
   * exactly one notice and an ordinary start produces none.
   */
  function announceRestart() {
    const marker = restarts.takeMarker()
    if (marker === null) return
    const key = typeof marker.key === 'string' ? marker.key : ''
    const target = splitConversationKey(key)
    if (target === null || outbound === null) {
      log('restart notice could not be sent: the asking conversation is unknown')
      return
    }
    const url = authenticatedWebUrl(ctx)
    const took = Number.isSafeInteger(marker.at) ? Math.max(0, Math.round((Date.now() - marker.at) / 1000)) : null
    // The restarter's own record, so the notice distinguishes "the launcher
    // brought it back" from "somebody started it by hand" without guessing.
    const trail = readRestarterTail(restartLogPath(), 2)
    const lines = [
      `✅ DSH 已重启${took === null ? '' : `（用时 ${String(took)} 秒）`}`,
      ...trail,
      url === '' ? '当前 profile 没有 Web 界面，或地址暂不可用。' : `本次进程的界面地址：${url}`,
      url === '' ? '' : '（旧链接会 404 —— 每次启动的 token 都不同，用这条。）',
    ].filter((line) => line !== '')
    outbound
      .deliver({ key, kind: target.kind, peerId: target.peerId, text: lines.join('\n') })
      .then(() => { log(`restart notice delivered to ${key}`) })
      .catch((error) => { log(`restart notice failed: ${String(error?.message ?? error)}`) })
  }

  // ── answerers ────────────────────────────────────────────────────────────

  const disposeApprovals = registerApprovalAnswerer({
    ctx,
    sessions,
    outbound: liveOutbound(() => outbound, log),
    pending,
    config,
    log,
  })

  const disposeQuestions = registerQuestionAnswerer({
    ctx,
    sessions,
    outbound: liveOutbound(() => outbound, log),
    pending,
    config,
    log,
  })

  const disposeTools = registerQqTools({
    ctx,
    sessions,
    outbound: liveOutbound(() => outbound, log),
    config,
    log,
    status,
    markToolSend: (exec) => {
      const sessionId = exec?.agent?.session?.id
      if (typeof sessionId === 'string') toolSent.add(sessionId)
    },
  })

  // The connector SDK is optional: if it cannot be loaded the bridge still
  // works, only QR pairing is unavailable.
  const pairingProxy = {
    snapshot: () => pairing?.snapshot() ?? unavailablePairing('扫码绑定尚未就绪'),
    start: () => pairing?.start() ?? unavailablePairing('扫码绑定不可用：connector SDK 未加载'),
    cancel: () => { pairing?.cancel() },
  }
  import('./pairing.js')
    .then(({ PairingSession }) => {
      pairing = new PairingSession({
        source: 'DeepSeek Harness',
        log,
        onCredentials: (credentials) => {
          if (scope === null) {
            log('paired credentials could not be stored: the settings namespace is unavailable')
            return
          }
          scope.update({ appId: credentials.appId, appSecret: credentials.appSecret })
            .then(() => { log('paired credentials stored; the channel will reconnect') })
            .catch((error) => { log(`storing paired credentials failed: ${String(error?.message ?? error)}`) })
        },
      })
      log('QR pairing is available from the QQ settings card')
    })
    .catch((error) => {
      log(`QR pairing unavailable: ${String(error?.message ?? error)}`)
    })

  const disposeConsole = registerConsole({ ctx, config, scope, sessions, pending, status, pairing: pairingProxy, log })

  // ── lifecycle ────────────────────────────────────────────────────────────

  /**
   * Say something on the way out.
   *
   * This deployment has lost the process twice overnight with no trace at all:
   * nothing in this log, nothing in the Windows event log, no crash record.
   * Whatever end the process meets, it should name it — an exit code, a signal,
   * or the fact that a restart asked for it. Diagnostics are cheap; a silent
   * death costs a night of the bridge being unreachable.
   *
   * The signal listeners RE-RAISE rather than trap: Node's default for an
   * unhandled signal is to exit, and merely ADDING a listener suppresses that,
   * which would quietly turn Ctrl+C into a no-op.
   */
  const exitNote = (detail) => {
    try {
      console.log(`[dsh-qq] process exit: ${detail}`)
    } catch { /* the log is best effort at this point */ }
  }
  const restartInFlight = () => restarts?.pending === true
  const onProcessExit = (code) => {
    exitNote(`code ${String(code)}${restartInFlight() ? ' (restart in progress)' : ''}`)
  }
  const signalHandlers = new Map()
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    const handler = () => {
      exitNote(`signal ${signal}`)
      process.removeListener(signal, handler)
      signalHandlers.delete(signal)
      try {
        process.kill(process.pid, signal)
      } catch {
        process.exit(1)
      }
    }
    signalHandlers.set(signal, handler)
    process.on(signal, handler)
  }
  process.on('exit', onProcessExit)

  ctx.effect(() => () => {
    clearInterval(heartbeatTimer)
    offSessionEvent()
    offAgentError()
    disposeApprovals()
    disposeQuestions()
    disposeTools()
    disposeConsole()
    pairing?.cancel()
    prompts.abort()
    pending.closeAll()
    sessions.flush()
    process.removeListener('exit', onProcessExit)
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler)
    if (gateway !== null) {
      gateway.stop().catch(() => {})
      gateway = null
    }
    log('bridge unloaded')
  }, 'dsh-qq: bridge lifecycle')

  log(`loaded (enabled=${String(current.enabled)}, mode=${String(current.mode)})`)
}

/**
 * Build the "is this session's agent mid-turn" probe.
 *
 * Read through `ctx.get` rather than a hard `inject`, like the console's
 * `webServer`: a profile without the agent registry still loads, and every
 * message then queues — the pre-steering behaviour — instead of failing.
 *
 * The answer is deliberately three-valued. `null` means "cannot tell", which
 * `/status` reports as unknown and the delivery decision reads as idle, because
 * queueing is the option that cannot be wrong, only slow. Only a proven `true`
 * steers.
 *
 * `agents.get()` returns undefined for a session that is not attached, and that
 * is exactly the idle case: the next prompt resumes it.
 *
 * @param options - wiring.
 * @param options.ctx - the plugin context.
 * @param options.log - diagnostics sink.
 * @returns A probe taking a session id: true, false, or null.
 */
export function createBusyProbe({ ctx, log }) {
  return (sessionId) => {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    if (agents === undefined || agents === null || typeof agents.get !== 'function') return null
    try {
      return agents.get(sessionId)?.status === 'running'
    } catch (error) {
      log(`agent status unreadable for ${sessionId}: ${String(error?.message ?? error)}`)
      return null
    }
  }
}

/**
 * The port this process serves the Web GUI on, or 0 when it serves none.
 *
 * @param ctx - the plugin context.
 * @returns A positive port number, or 0.
 */
function webPort(ctx) {
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  const port = webServer?.port
  return Number.isSafeInteger(port) && port > 0 ? port : 0
}

/**
 * Location of the pending-restart marker.
 *
 * Beside the conversation table, because it is the same kind of fact: state one
 * process leaves for the next one.
 *
 * @returns An absolute path below the DSH home.
 */
function restartMarkerPath() {
  return join(dirname(sessionTablePath()), 'dsh-qq-restart.json')
}

/**
 * Absolute path of the plugin's entry module.
 *
 * Used by the restart preflight, which imports exactly the file a new process
 * would mount — checking anything else would prove the wrong thing.
 *
 * @returns An absolute path.
 */
function pluginEntryPath() {
  return fileURLToPath(new URL('./index.js', import.meta.url))
}

/**
 * Where the detached restarter narrates what it did.
 *
 * The restart happens with nobody watching the machine, so this file is the
 * only witness to which step failed when the server does not come back.
 *
 * @returns An absolute path below the DSH home.
 */
function restartLogPath() {
  return join(dirname(sessionTablePath()), 'dsh-qq-restart.log')
}

/**
 * A bounded, de-duplicated record of senders that admission refused.
 *
 * This exists to solve a real deadlock: the default posture admits nobody, and
 * the operator cannot allow themselves without knowing their own OpenID, which
 * the platform only reveals in the events of messages that were just refused.
 * Remembering the refusal — rather than replying to the stranger — keeps the
 * information available without turning the bot into a responder for anyone who
 * finds it.
 *
 * @returns A recorder with `record` and `entries`.
 */
function createRejectionLog({ limit = 20, ttlMs = 30 * 60_000 } = {}) {
  const byKey = new Map()
  return {
    record(message) {
      const key = `${message.kind}:${message.peerId}`
      const existing = byKey.get(key)
      const now = Date.now()
      if (existing !== undefined && now - existing.at < ttlMs) {
        existing.at = now
        return false
      }
      byKey.set(key, { kind: message.kind, peerId: message.peerId, userId: message.userId, userName: message.userName, at: now })
      while (byKey.size > limit) byKey.delete(byKey.keys().next().value)
      return true
    },
    entries() {
      const now = Date.now()
      const out = []
      for (const [key, entry] of byKey) {
        if (now - entry.at > ttlMs) {
          byKey.delete(key)
          continue
        }
        out.push({ ...entry, key })
      }
      return out.sort((a, b) => b.at - a.at)
    },
  }
}

/**
 * Describe an unavailable pairing session in the shape the console returns.
 *
 * @param message - why pairing cannot run.
 * @returns A pairing snapshot.
 */
function unavailablePairing(message) {
  return { state: 'unavailable', qrDataUrl: '', error: message, startedAt: 0 }
}

/**
 * Build a sender proxy that resolves the live channel at call time.
 *
 * The answerers and tools are registered once at load, but the QQ channel is
 * rebuilt whenever settings change, so they must not capture a stale sender.
 *
 * @param resolve - returns the current sender, or null when offline.
 * @param log - diagnostics sink.
 * @returns A stand-in exposing the sender's methods.
 */
function liveOutbound(resolve, log) {
  const fail = () => {
    const message = 'QQ 通道当前未连接，无法发送消息'
    log(message)
    return Promise.reject(new Error(message))
  }
  return {
    deliver: (...args) => resolve()?.deliver(...args) ?? fail(),
    sendActive: (...args) => resolve()?.sendActive(...args) ?? fail(),
    sendQuoted: (...args) => resolve()?.sendQuoted(...args) ?? fail(),
    sendImage: (...args) => resolve()?.sendImage(...args) ?? fail(),
    sendFile: (...args) => resolve()?.sendFile(...args) ?? fail(),
    // Acknowledging a click still has to reach the live client, which is
    // rebuilt with the channel: capturing one here would answer clicks through
    // a dead connection after any settings change.
    ackInteraction: (...args) => resolve()?.ackInteraction(...args) ?? fail(),
    // Read-through rather than a captured value: the channel is rebuilt on
    // every settings change, and a failure recorded on the previous instance
    // would otherwise be reported as if it were current.
    get lastFailure() {
      return resolve()?.lastFailure ?? null
    },
  }
}

/**
 * Location of the persisted conversation table.
 *
 * @returns An absolute path below the DSH home when one is resolvable.
 */
/**
 * Whether a process id names a live process.
 *
 * `process.kill(pid, 0)` sends nothing and reports existence; EPERM means it
 * exists but belongs to someone else, which still counts as alive.
 *
 * @param pid - the process id.
 * @returns Whether something is running under that id.
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function dshHome() {
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') return home
  const userProfile = process.env.USERPROFILE ?? process.env.HOME ?? '.'
  return `${userProfile}/.dsh`
}

/**
 * Where the conversation table lives.
 *
 * @returns An absolute path below the DSH home.
 */
function sessionTablePath() {
  return `${dshHome()}/dsh-qq-sessions.json`
}
