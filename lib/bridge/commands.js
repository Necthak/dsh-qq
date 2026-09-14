/**
 * Session administration from QQ: workspace, session picking, and stopping.
 *
 * These commands exist because the phone is sometimes the only surface the
 * operator has. Everything here therefore has to work without the desktop UI,
 * and has to say plainly what it changed and when the change takes effect —
 * most of these commands only affect the NEXT session, and a bridge that
 * silently deferred an effect would look broken instead of deliberate.
 *
 * Two rules run through the module:
 *
 * - **Administration is owner-only.** Listing is not administration, so
 *   `/sessions` answers anyone admitted; `/workspace`, `/resume`, and `/stop`
 *   change where an agent runs or what it is doing, so they require the owner.
 * - **A command never guesses.** An unresolvable number, or an unwritable
 *   settings namespace, produces a refusal that names the reason — never a
 *   silent fallback that leaves the operator believing something changed.
 *
 * @module dsh-qq/bridge/commands
 */

import { isOwner } from './admission.js'
import { formatCreditReport } from './credit.js'
import { formatElapsed } from './progress.js'

/** How many sessions `/sessions` lists when asked for no particular count. */
const DEFAULT_LIST_SIZE = 10

/** Upper bound on one `/sessions` listing, so a long roster cannot flood QQ. */
const MAX_LIST_SIZE = 20

/**
 * Build the session-administration commands.
 *
 * @param options - wiring.
 * @param options.ctx - the plugin context.
 * @param options.sessions - the conversation table.
 * @param options.pending - the pending-interaction registry, closed when the
 *   conversation is rebound so an answer cannot land in the wrong session.
 * @param options.settingsScope - the bridge's settings namespace, or null when
 *   settings are unavailable and writes must be refused.
 * @param options.log - diagnostics sink.
 * @returns An async runner taking one parsed command, resolving whether it was
 *   one of these commands.
 */
export function createSessionCommands({ ctx, sessions, pending, settingsScope, restart, busy, credit, screenshot, readLog, doctor, todos, log }) {
  // The last listing per conversation, so `/resume 3` names a row the operator
  // actually saw. An out-of-range number is refused rather than guessed at,
  // because rebinding is not something a wrong number should do.
  const listings = new Map()

  /**
   * Search the conversations themselves.
   *
   * Wrapped rather than called inline so the command module never reaches into
   * the controller at a call site, and so a deployment without the session-query
   * package fails in one place with one message.
   *
   * @param query - literal message-content query.
   * @param signal - cancellation for the search.
   * @returns `{ items, hasMore }`.
   */
  async function searchSessions(query, signal) {
    const controller = ctx?.sessionController
    if (typeof controller?.search !== 'function') {
      throw new Error('当前 DSH 未提供会话搜索（缺少 sessionQuery 服务）')
    }
    return controller.search({ query }, signal ?? new AbortController().signal)
  }

  /**
   * The registry's project list and its archive set.
   *
   * Both live in the workspace package, which is optional: a profile without it
   * simply has no projects and no archive, and both callers fall back to the
   * behaviour they had before.
   *
   * @returns `{ projects, archived }`; `archived` is a Set of session ids.
   */
  function workspaceView() {
    const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
    if (registry === undefined || registry === null) return { projects: [], archived: new Set() }
    let projects = []
    let archived = new Set()
    try {
      projects = typeof registry.list === 'function' ? registry.list() : []
    } catch (error) {
      log(`workspace list failed: ${String(error?.message ?? error)}`)
    }
    try {
      archived = new Set(Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds : [])
    } catch (error) {
      log(`archived session set failed: ${String(error?.message ?? error)}`)
    }
    return { projects, archived }
  }

  /**
   * Read the ordinary-session roster.
   *
   * Archived sessions are filtered out: the operator archived them in the
   * desktop to stop seeing them, and a phone menu that lists them anyway makes
   * the archive useless. Subagents are filtered for the separate reason that
   * they were never resumable from QQ.
   *
   * @param signal - cancellation for the persistence read.
   * @returns Non-subagent, unarchived session summaries, most recently active first.
   */
  async function listSessions(signal) {
    const listed = await ctx.sessionController.list({}, signal ?? new AbortController().signal)
    const items = Array.isArray(listed?.items) ? listed.items : []
    const { archived } = workspaceView()
    return items.filter((item) => item?.origin !== 'subagent' && !archived.has(item?.sessionId))
  }

  /**
   * Turn one `/workspace` argument into a directory path.
   *
   * A bare number names a row of the listing this conversation just saw; a path
   * is taken verbatim (joined, so spaces need no quoting). An out-of-range
   * number is an error rather than a path, because a directory literally named
   * "3" is not what anyone means.
   *
   * @param target - the raw argument text.
   * @param key - the conversation asking.
   * @param projects - the registry's project list.
   * @returns `{ path }` or `{ error }`.
   */
  function resolveWorkspaceTarget(target, key, projects) {
    const raw = String(target ?? '').trim()
    if (raw === '') return { error: '没有指定工作区。' }
    if (!/^[0-9]+$/.test(raw)) return { path: raw }
    const wanted = Number.parseInt(raw, 10)
    const remembered = listings.get(`workspace:${key}`)
    const list = Array.isArray(remembered) ? remembered : projects.map((project) => String(project?.path ?? ''))
    if (!Number.isSafeInteger(wanted) || wanted < 1 || wanted > list.length) {
      return { error: `编号 ${raw} 不在上次列出的工作区范围内（共 ${String(list.length)} 个）。先发 /workspace 看列表。` }
    }
    return { path: list[wanted - 1] }
  }

  /**
   * Write the workspace setting for the next session.
   *
   * @param path - the directory.
   * @returns `{ ok: true }` or `{ error }`.
   */
  async function writeWorkspace(path) {
    if (settingsScope === null || settingsScope === undefined) {
      return { error: '设置命名空间不可用，无法修改工作区。' }
    }
    try {
      await settingsScope.update({ workspacePath: path })
      return { ok: true }
    } catch (error) {
      return { error: `工作区未修改：${String(error?.message ?? error)}` }
    }
  }

  return async function run({ name, args, message, key, settings, signal, reply }) {
    if (name === 'new' || name === 'reset') {
      // Handled here rather than in the inbound path because it is the only
      // place that can also switch the workspace: `/new 2` is one intent, and
      // making the operator send two commands for it is exactly the friction a
      // phone makes painful.
      if (!isOwner(message, settings)) {
        await reply('⛔ 只有 owner 可以开新对话。')
        return true
      }
      const { projects } = workspaceView()
      let opened = ''
      if (name === 'new' && args.length > 0) {
        const resolved = resolveWorkspaceTarget(args.join(' '), key, projects)
        if (resolved.error !== undefined) {
          await reply(`⚠️ 未开新对话：${resolved.error}`)
          return true
        }
        const written = await writeWorkspace(resolved.path)
        if (written.error !== undefined) {
          await reply(`⚠️ 未开新对话：${written.error}`)
          return true
        }
        opened = resolved.path
      }
      const existed = sessions.reset(key)
      log(`${key}: new conversation (${existed ? 'previous binding dropped' : 'nothing to drop'})${opened === '' ? '' : ` in ${opened}`}`)
      await reply([
        existed ? '🆕 已开新对话' : '🆕 已就绪（此前没有绑定会话）',
        existed ? '旧对话没有丢：/sessions 看列表，/resume 编号 可以回去。' : '',
        opened === '' ? '下一条消息开始新的上下文。' : `下一条消息会在 ${opened} 开始新的上下文。`,
      ].filter((line) => line !== '').join(String.fromCharCode(10)))
      return true
    }

    if (name === 'workspace') {
      await runWorkspace({ args, message, key, settings, settingsScope, sessions, listings, workspaceView, listSessions, signal, resolveWorkspaceTarget, writeWorkspace, reply, log })
      return true
    }

    if (name === 'sessions') {
      await runSessions({ args, key, sessions, listings, reply, log, signal, listSessions })
      return true
    }

    if (name === 'find') {
      await runFind({ args, key, listings, workspaceView, reply, log, signal, listSessions, searchSessions })
      return true
    }

    if (name === 'resume') {
      await runResume({ args, message, key, settings, sessions, pending, listings, reply, log, signal, listSessions })
      return true
    }

    if (name === 'stop') {
      await runStop({ message, key, settings, sessions, reply, log, ctx })
      return true
    }

    if (name === 'usage') {
      await runUsage({ key, credit, reply, log })
      return true
    }

    if (name === 'log') {
      await runLog({ args, message, key, settings, sessions, readLog, reply, log })
      return true
    }

    if (name === 'todos') {
      await runTodos({ key, sessions, todos, reply, log })
      return true
    }

    if (name === 'doctor') {
      await runDoctor({ message, settings, sessions, doctor, reply, log })
      return true
    }

    if (name === 'screen') {
      await runScreen({ args, message, key, settings, sessions, screenshot, reply, log })
      return true
    }

    if (name === 'restart') {
      await runRestart({ args, message, key, settings, sessions, busy, reply, log, restart })
      return true
    }

    return false
  }
}

/**
 * `/usage` — what the account has left, and what today cost.
 *
 * The figures come from DSH's own provider snapshots and usage ledger, so the
 * phone and the desktop cannot disagree, and the bridge never touches a
 * credential of its own — it reads the answer DSH already fetched. The earlier
 * version reported this session's rounds and steps, which was not an answer to
 * any question the operator actually had: "12 轮 86 步" says nothing about how
 * much is left.
 *
 * @param options - command context.
 */
async function runUsage({ key, credit, reply, log }) {
  if (typeof credit !== 'function') {
    await reply('⚠️ 用量读取未接线。')
    return
  }
  let data
  try {
    data = await credit()
  } catch (error) {
    log(`${key}: credit read failed: ${String(error?.message ?? error)}`)
    await reply(`⚠️ 读取额度失败：${String(error?.message ?? error)}`)
    return
  }
  await reply(formatCreditReport({ ...data, now: new Date() }))
}



/**
 * `/log [行数]` — read the bridge log from the phone.
 *
 * Diagnosis otherwise needs the desktop, which is the situation this bridge
 * exists to avoid. Owner-only: the log names conversations, session ids and
 * paths.
 *
 * @param options - command context.
 */
async function runLog({ args, message, key, settings, sessions, readLog, reply, log }) {
  if (!isOwner(message, settings)) {
    await reply('⛔ 只有 owner 可以查看日志。')
    return
  }
  if (sessions.get(key) === undefined && sessions.entries().length === 0) {
    // Not an error: the log is readable before any session exists.
  }
  if (typeof readLog !== 'function') {
    await reply('⚠️ 日志读取未接线。')
    return
  }
  const requested = Number.parseInt(String(args[0] ?? ''), 10)
  let result
  try {
    result = readLog({ limit: Number.isSafeInteger(requested) ? requested : 15 })
  } catch (error) {
    log(`${key}: log read failed: ${String(error?.message ?? error)}`)
    await reply(`⚠️ 读取日志失败：${String(error?.message ?? error)}`)
    return
  }
  if (result.error !== '') {
    await reply(`⚠️ ${result.error}`)
    return
  }
  if (result.lines.length === 0) {
    await reply('📜 日志里还没有本插件的记录。')
    return
  }
  const body = result.lines.map((line) => shorten(line, 78))
  await reply([`📜 最近 ${String(result.lines.length)} 条桥接日志（/log 40 可看更多）`, ...body].join(String.fromCharCode(10)))
}

/**
 * `/todos` — what the agent is working through right now.
 *
 * The list comes from DSH's own `todos` projection, so it is the same one the
 * desktop task panel shows, and it resets each turn: this answers "what is this
 * turn doing", not "what was ever planned". `/status` counts steps; this shows
 * the work.
 *
 * @param options - command context.
 */
async function runTodos({ key, sessions, todos, reply, log }) {
  const record = sessions.get(key)
  if (record === undefined) {
    await reply('⚠️ 当前还没有 DSH 会话。先发一条消息建立会话，再用 /todos。')
    return
  }
  if (typeof todos !== 'function') {
    await reply('⚠️ 任务清单读取未接线。')
    return
  }
  let list
  try {
    list = await todos(record.sessionId)
  } catch (error) {
    log(`${key}: todos read failed: ${String(error?.message ?? error)}`)
    await reply(`⚠️ 读取任务清单失败：${String(error?.message ?? error)}`)
    return
  }
  await reply(formatTodos(list))
}

/**
 * Render the task list for QQ.
 *
 * @param list - the projection value: an array of `{ content, status }`, or null.
 * @returns The message body.
 */
export function formatTodos(list) {
  if (!Array.isArray(list) || list.length === 0) {
    // Not an error: a turn that plans nothing, or one that has not started,
    // both legitimately have no list, and a hedge beats an invented one.
    return '📋 本轮没有任务清单（agent 尚未拆分任务，或本轮已结束）。'
  }
  const marks = { completed: '✅', in_progress: '🔄', pending: '⬜' }
  const lines = ['📋 本轮任务']
  for (const item of list) {
    const mark = marks[item?.status] ?? '•'
    lines.push(`${mark} ${String(item?.content ?? '')}`)
  }
  const done = list.filter((item) => item?.status === 'completed').length
  const doing = list.find((item) => item?.status === 'in_progress')
  lines.push('')
  lines.push(`进度：${String(done)}/${String(list.length)}${doing === undefined ? '' : ` · 正在进行：${String(doing.content ?? '')}`}`)
  return lines.join(String.fromCharCode(10))
}

/**
 * `/doctor` — look, do not merely report.
 *
 * `/status` says what the bridge knows; this runs the checks an operator
 * cannot run from a phone, and ends with a verdict rather than a table.
 *
 * @param options - command context.
 */
async function runDoctor({ message, settings, doctor, reply, log }) {
  if (!isOwner(message, settings)) {
    await reply('⛔ 只有 owner 可以执行自检。')
    return
  }
  if (typeof doctor !== 'function') {
    await reply('⚠️ 自检未接线。')
    return
  }
  let findings
  try {
    findings = await doctor()
  } catch (error) {
    log(`doctor failed: ${String(error?.message ?? error)}`)
    await reply(`⚠️ 自检失败：${String(error?.message ?? error)}`)
    return
  }
  await reply(formatDoctor(findings))
}

/**
 * Render the health check for QQ.
 *
 * @param findings - one `{ level, label, detail }` per check.
 * @returns The message body.
 */
export function formatDoctor(findings) {
  const marks = { ok: '✅', warn: '⚠️', bad: '❌' }
  const list = Array.isArray(findings) ? findings : []
  const lines = ['🩺 自检']
  for (const finding of list) {
    const mark = marks[finding?.level] ?? '•'
    lines.push(`${mark} ${String(finding?.label ?? '')}：${String(finding?.detail ?? '')}`)
  }
  const bad = list.filter((item) => item?.level === 'bad').length
  const warn = list.filter((item) => item?.level === 'warn').length
  lines.push(bad > 0
    ? `结论：${String(bad)} 项异常，${String(warn)} 项需留意 —— 先看 /log`
    : warn > 0 ? `结论：无异常，${String(warn)} 项需留意` : '结论：全部正常')
  return lines.join(String.fromCharCode(10))
}

/**
 * Trim one log line to a phone-sized width.
 *
 * @param line - the raw line.
 * @param width - maximum characters.
 * @returns The line, truncated with an ellipsis when necessary.
 */
function shorten(line, width) {
  const text = String(line ?? '')
  return text.length > width ? `${text.slice(0, width - 1)}…` : text
}

/**
 * `/screen` — put a picture of this machine into the chat.
 *
 * Owner-only: it shows whatever is on screen, which is not a capability a group
 * member should be able to invoke. With no argument it captures the whole
 * screen; with one, the largest window of that process.
 *
 * @param options - command context.
 */
async function runScreen({ args, message, key, settings, sessions, screenshot, reply, log }) {
  if (!isOwner(message, settings)) {
    await reply('⛔ 只有 owner 可以截图。')
    return
  }
  if (typeof screenshot !== 'function') {
    await reply('⚠️ 截图功能未接线。')
    return
  }
  const wanted = String(args[0] ?? '').trim()
  await reply(wanted === '' ? '📸 正在截取整个屏幕…' : `📸 正在截取窗口：${wanted}…`)
  try {
    const shot = await screenshot({ key, process: wanted === '' ? undefined : wanted })
    log(`${key}: screenshot (${String(shot.width)}x${String(shot.height)}, ${String(shot.method)}) sent by owner`)
  } catch (error) {
    log(`${key}: screenshot failed: ${String(error?.message ?? error)}`)
    await reply(`⚠️ 截图失败：${String(error?.message ?? error)}`)
  }
}

/**
 * `/restart` — hand the process over to the launcher and come back with a URL.
 *
 * Owner-only, like every command that changes where or how the agent runs: it
 * terminates whatever is in flight, and it decides which machine state the next
 * process starts from.
 *
 * Two guards sit in front of it, and both exist because this command is easy to
 * fire from a phone and impossible to undo:
 *
 * - a **running turn** turns the command into a refusal naming the elapsed
 *   time, with `/restart force` as the deliberate second step. Restarting
 *   silently discards minutes of work, and a message that does that without
 *   asking is a trap.
 * - the plugin's **import graph is exercised in a child process** first. A
 *   broken edit would otherwise take the bridge down with no way back through
 *   the channel that broke it.
 *
 * @param options - command context.
 */
async function runRestart({ args, message, key, settings, sessions, busy, reply, log, restart }) {
  if (!isOwner(message, settings)) {
    await reply('⛔ 只有 owner 可以重启 DSH。')
    return
  }
  if (restart === undefined || restart === null) {
    await reply('⚠️ 重启功能未接线（插件未注册重启服务）。')
    return
  }

  const force = String(args[0] ?? '').trim().toLowerCase() === 'force'
  const record = sessions.get(key)
  if (!force && record !== undefined && typeof busy === 'function' && busy(record.sessionId) === true) {
    await reply([
      '⚠️ 当前有回合正在运行，重启会把它连同收件箱一起丢掉。',
      '确认要重启就回 `/restart force`。',
    ].join('\n'))
    return
  }

  const prepared = restart.prepare()
  if (prepared.error !== undefined) {
    await reply(`⚠️ 无法重启：${prepared.error}`)
    return
  }

  if (typeof restart.preflight === 'function') {
    await reply('🔍 重启前自检：正在检查插件能否正常加载…')
    const check = await restart.preflight()
    if (check.ok !== true) {
      await reply([
        '⛔ 自检没通过，已取消重启（服务仍在运行）。',
        '修好下面这个再试：',
        check.error,
      ].join('\n'))
      log(`${key}: restart refused by preflight: ${String(check.error).slice(0, 200)}`)
      return
    }
  }

  // The reply goes out BEFORE the process dies: it is the only confirmation the
  // operator gets, and the exit is scheduled only after it has been sent.
  await reply([
    '🔄 正在重启 DSH…',
    `启动器：${prepared.launcher}`,
    '大约 20–40 秒后回来。重启完成后我会把本次进程的新地址发到这里 —— 旧链接会 404，因为每次启动的 token 都不一样。',
  ].join('\n'))

  restart.go({ key, launcher: prepared.launcher, port: prepared.port })
  log(`${key}: restart requested by owner`)
}

/**
 * `/workspace` — read or set the directory the next session is created in.
 *
 * The setting is the same one the settings card edits, so the two surfaces
 * cannot disagree about where the next session starts.
 *
 * @param options - command context.
 */
async function runWorkspace({ args, message, key, settings, settingsScope, sessions, listings, workspaceView, listSessions, signal, resolveWorkspaceTarget, writeWorkspace, reply, log }) {
  const configured = typeof settings.workspacePath === 'string' ? settings.workspacePath.trim() : ''
  const { projects } = workspaceView()
  const record = sessions.get(key)

  if (args.length === 0) {
    // A phone cannot type an absolute path comfortably, and it should not have
    // to: the desktop already knows this machine's projects, so they are offered
    // as a numbered menu exactly like `/model` and `/sessions`.
    const lines = ['📁 工作区']
    if (projects.length === 0) {
      lines.push('（没有已登记的项目；可直接给一个绝对路径）')
    } else {
      lines.push('新会话目录（/workspace 编号 或 /new 编号 切换）：')
      projects.forEach((project, index) => {
        const path = String(project?.path ?? '')
        const title = String(project?.title ?? '').trim()
        const mark = path !== '' && configured !== '' && sameDirectory(path, configured) ? ' ←' : ''
        lines.push(`${index + 1}. ${title === '' ? path : title} · ${path}${mark}`)
      })
    }
    // Remember the exact order this conversation was shown, so `/workspace 2`
    // names a row the operator actually saw (same contract as `/resume`).
    listings.set(`workspace:${key}`, projects.map((project) => String(project?.path ?? '')))
    if (configured === '') lines.push('当前设置：未设置（使用 DSH 进程启动目录）')
    if (record !== undefined) {
      // The bridge's own table holds no directory, so the bound session's cwd
      // comes from the roster — the same source `/sessions` prints.
      let cwd = ''
      try {
        const items = await listSessions(signal)
        cwd = String(items.find((item) => item?.sessionId === record.sessionId)?.cwd ?? '')
      } catch (error) {
        log(`${key}: workspace cwd lookup failed: ${String(error?.message ?? error)}`)
      }
      lines.push(`当前会话目录：${cwd === '' ? '未知' : cwd}`)
    }
    lines.push('（切换只影响**新**会话：/workspace 2 或 /new 2）')
    await reply(lines.join(String.fromCharCode(10)))
    return
  }

  if (!isOwner(message, settings)) {
    await reply('⛔ 只有 owner 可以修改工作区。')
    return
  }
  if (settingsScope === null || settingsScope === undefined) {
    await reply('⚠️ 设置命名空间不可用，无法修改工作区。')
    return
  }

  const resolved = resolveWorkspaceTarget(args.join(' '), key, projects)
  if (resolved.error !== undefined) {
    await reply(`⚠️ ${resolved.error}`)
    return
  }
  const written = await writeWorkspace(resolved.path)
  if (written.error !== undefined) {
    log(`${key}: workspace update rejected: ${written.error}`)
    await reply(`⚠️ ${written.error}`)
    return
  }
  const path = resolved.path
  log(`${key}: workspace path set to ${path}`)
  await reply([
    `✅ 新会话工作区已设为：${path}`,
    '接着发 /new 立刻开新对话（或直接 /new ' + String(args.join(' ')).trim() + ' 一步到位）。',
    '当前会话的工作目录不变。',
  ].join(String.fromCharCode(10)))
}

/**
 * Whether two paths name the same directory, ignoring case and trailing slashes.
 *
 * Windows paths are compared case-insensitively and with either separator, which
 * is what makes the "←" marker in the listing reliable.
 *
 * @param left - one path.
 * @param right - the other path.
 * @returns Whether they name the same directory.
 */
function sameDirectory(left, right) {
  const normalize = (value) => String(value ?? '')
    .trim()
    // Separators are unified through char codes so this comparison never has to
    // carry an escaped backslash of its own.
    .split(String.fromCharCode(92)).join('/')
    .split('/').filter((part) => part !== '').join('/')
    .toLowerCase()
  return normalize(left) === normalize(right)
}

/**
 * `/sessions` — list recent sessions so one can be named by number.
 *
 * @param options - command context.
 */
async function runSessions({ args, key, sessions, listings, reply, log, signal, listSessions }) {
  const wanted = Number.parseInt(String(args[0] ?? ''), 10)
  const size = Number.isSafeInteger(wanted) && wanted > 0 ? Math.min(wanted, MAX_LIST_SIZE) : DEFAULT_LIST_SIZE

  let items
  try {
    items = await listSessions(signal)
  } catch (error) {
    log(`${key}: session list failed: ${String(error?.message ?? error)}`)
    await reply(`⚠️ 读取会话列表失败：${String(error?.message ?? error)}`)
    return
  }

  if (items.length === 0) {
    await reply('当前没有可列出的会话。')
    return
  }

  const page = items.slice(0, size)
  listings.set(key, page.map((item) => item.sessionId))

  const current = sessions.get(key)?.sessionId
  const lines = ['🗂 最近会话（/resume 编号 可切换）']
  page.forEach((item, index) => {
    const mark = item.sessionId === current ? ' ←' : ''
    const running = item.running === true ? ' · 运行中' : ''
    // A number and a timestamp cannot tell two conversations apart; the title
    // can. It comes from the `title` projection the GUI also renders, and is
    // simply absent when no cache row was available — hence the fallback.
    const label = sessionLabel(item)
    lines.push(`${index + 1}. ${label} · ${formatTime(item.updatedAt)}${running}${mark}`)
  })
  if (items.length > page.length) lines.push(`（还有 ${items.length - page.length} 个，用 /sessions <数量> 看更多）`)
  await reply(lines.join('\n'))
}

/**
 * Name one session for the `/sessions` listing.
 *
 * The title projection is what the desktop sidebar shows, so a phone listing
 * that agrees with it is one the operator can actually act on. Long titles are
 * cut rather than wrapped: the listing is a numbered menu, one line per row.
 *
 * @param item - one `SessionSummary` from the Host list.
 * @returns A short label: the title when known, otherwise a stable id fragment.
 */
export function sessionLabel(item) {
  const raw = item?.projections?.values?.title
  const title = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
  if (title !== '') return title.length > 28 ? `${title.slice(0, 27)}…` : title
  const directory = baseName(item?.cwd)
  const id = shortId(item?.sessionId)
  return directory === '' ? id : `${id} · ${directory}`
}

/**
 * `/find` — search the conversations themselves.
 *
 * Reviewing a decision made days ago is a phone task, and scrolling an
 * unbounded list is not how anyone finds it. The search runs through DSH's own
 * `sessionController.search`, so the results are the ones the desktop search
 * box produces, and the hits become the current `/resume` listing: find, then
 * switch, without a second command.
 *
 * @param options - command context.
 */
async function runFind({ args, key, listings, workspaceView, reply, log, signal, listSessions, searchSessions }) {
  const query = args.join(' ').trim()
  if (query === '') {
    await reply('用法：/find <关键词>（在会话内容里搜索，结果可用 /resume 编号 直接切过去）')
    return
  }
  let found
  try {
    found = await searchSessions(query, signal)
  } catch (error) {
    // A deployment without @deepseek-ai/dsh-session-query fails here by design;
    // saying so is more useful than an empty result that looks like "no match".
    log(`${key}: session search failed: ${String(error?.message ?? error)}`)
    await reply(`⚠️ 会话搜索不可用：${String(error?.message ?? error)}`)
    return
  }

  const items = Array.isArray(found?.items) ? found.items : []
  if (items.length === 0) {
    await reply(`🔍 没有找到包含「${query}」的会话。`)
    return
  }

  // Titles and the archived set come from the same roster `/sessions` prints, so
  // a hit is identified exactly as it would be in that listing, and a session
  // the operator archived does not come back through search either.
  let roster = []
  try {
    roster = await listSessions(signal)
  } catch (error) {
    log(`${key}: roster read failed during search: ${String(error?.message ?? error)}`)
  }
  const byId = new Map(roster.map((item) => [item.sessionId, item]))
  const { archived } = workspaceView()
  const usable = items.filter((item) => !archived.has(item?.sessionId))
  if (usable.length === 0) {
    await reply(`🔍 「${query}」只出现在已归档的会话里。`)
    return
  }

  const page = usable.slice(0, DEFAULT_LIST_SIZE)
  const lines = [`🔍 「${query}」找到 ${String(usable.length)} 个会话（/resume 编号 切过去）`]
  page.forEach((item, index) => {
    const summary = byId.get(item.sessionId)
    const label = summary === undefined ? shortId(item.sessionId) : sessionLabel(summary)
    lines.push(`${index + 1}. ${label}`)
    lines.push(`   ${excerpt(item.snippet)}`)
  })
  // The hits BECOME the current listing, so `/resume 2` works immediately after
  // a search without a second listing command in between.
  listings.set(key, page.map((item) => item.sessionId))
  await reply(lines.join(String.fromCharCode(10)))
}

/**
 * Shorten a search snippet to one phone-sized line.
 *
 * @param snippet - the matched text.
 * @returns A single trimmed line.
 */
function excerpt(snippet) {
  const flat = String(snippet ?? '').replace(/\s+/g, ' ').trim()
  if (flat === '') return '（无片段）'
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat
}

/**
 * `/resume` — bind this conversation to an existing session.
 *
 * @param options - command context.
 */
async function runResume({ args, message, key, settings, sessions, pending, listings, reply, log, signal, listSessions }) {
  if (!isOwner(message, settings)) {
    await reply('⛔ 只有 owner 可以切换会话。')
    return
  }

  const token = String(args[0] ?? '').trim()
  if (token === '') {
    await reply('用法：/resume <编号|会话ID>。先发 /sessions 看编号。')
    return
  }

  let sessionId = token
  if (/^\d+$/.test(token)) {
    const picked = listings.get(key)?.[Number(token) - 1]
    if (picked === undefined) {
      await reply('❓ 这个编号不在你最近一次 /sessions 列表里。请先发 /sessions 再挑编号。')
      return
    }
    sessionId = picked
  }

  let known = false
  try {
    known = (await listSessions(signal)).some((item) => item.sessionId === sessionId)
  } catch (error) {
    log(`${key}: session list failed while resuming: ${String(error?.message ?? error)}`)
  }

  // Rebinding replaces where the next message goes, so an interaction still
  // waiting on this conversation is released rather than answered into the
  // wrong session.
  pending.close(key)
  sessions.bind(key, sessionId)
  log(`${key}: resumed session ${sessionId}`)

  await reply([
    `✅ 已切换到会话 ${shortId(sessionId)}`,
    known ? '' : '⚠️ 该 ID 不在最近的会话列表里；若不是笔误，下一条消息会报错。',
    '下一条消息起生效，上下文是该会话原有的。',
  ].filter((line) => line !== '').join('\n'))
}

/**
 * `/stop` — cancel the running turn.
 *
 * Cancelling drops the active turn but not the pending inbox, so a message sent
 * while the agent was working still gets answered afterwards.
 *
 * @param options - command context.
 */
async function runStop({ message, key, settings, sessions, reply, log, ctx }) {
  if (!isOwner(message, settings)) {
    await reply('⛔ 只有 owner 可以中止回合。')
    return
  }

  const record = sessions.get(key)
  if (record === undefined) {
    await reply('当前没有已绑定的会话。')
    return
  }

  try {
    const result = await ctx.sessionController.cancel({ sessionId: record.sessionId })
    log(`${key}: cancel requested for ${record.sessionId}`)
    await reply(result?.accepted === true ? '⏹ 已请求取消当前回合。' : '⚠️ 取消未被接受。')
  } catch (error) {
    log(`${key}: cancel failed: ${String(error?.message ?? error)}`)
    await reply(`⚠️ 取消失败：${String(error?.message ?? error)}`)
  }
}

/**
 * Shorten a session id for display.
 *
 * @param sessionId - the full identity.
 * @returns The display form.
 */
export function shortId(sessionId) {
  const raw = String(sessionId ?? '')
  const stripped = raw.startsWith('session-') ? raw.slice('session-'.length) : raw
  return stripped.length <= 8 ? stripped : `${stripped.slice(0, 8)}…`
}

/**
 * Format one timestamp for a phone screen.
 *
 * @param at - epoch milliseconds.
 * @returns `MM-DD HH:mm`, or `未知` when the value is unusable.
 */
export function formatTime(at) {
  if (!Number.isSafeInteger(at) || at <= 0) return '未知'
  const date = new Date(at)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Show the last path segment of a working directory.
 *
 * @param cwd - an absolute path, possibly absent.
 * @returns The final segment, or `未指定`.
 */
export function baseName(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return '未指定'
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || cwd
}
