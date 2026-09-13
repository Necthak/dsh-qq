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
import { readCredit } from './bridge/credit.js'
import { registerConsole } from './console.js'

/** How often the long-turn heartbeat is evaluated, independent of its interval. */
const HEARTBEAT_TICK_MS = 15_000

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
  /** Send markdown (`msg_type: 2`) instead of converted plain text. */
  useMarkdown: z.boolean().default(false),
  /** Directory QQ sessions work in; empty means the DSH process directory. */
  workspacePath: z.string().default(''),
  /** Agent preset for QQ sessions; empty uses the profile default. */
  agentPreset: z.string().default(''),
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
  useMarkdown: false,
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

  const heartbeatTimer = setInterval(heartbeatTick, HEARTBEAT_TICK_MS)
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

  /** Workspace, session picking, and cancellation behind their own commands. */
  const commands = createSessionCommands({ ctx, sessions, pending, settingsScope: scope, restart: restarts, busy, credit, screenshot, log })

  /** Button callbacks from the inline keyboards this bridge sends. */
  const interactions = createInteractionHandler({
    sessions,
    models,
    pending,
    config,
    log,
    outbound: liveOutbound(() => outbound, log),
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
