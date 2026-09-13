/**
 * `/restart` — restart the DSH process from QQ.
 *
 * The launcher (`Start-DeepSeek-Harness.cmd`) already does the hard part: it
 * starts the server when nothing is listening, and it opens the URL carrying
 * the *current* process's launch token — which is why the address changes on
 * every restart and a bookmark of an old one answers 404. What it cannot do is
 * run itself while the server still holds the port, and it cannot tell anyone
 * over QQ that the server came back.
 *
 * So this module owns the three pieces the bridge needs to make a restart a
 * one-message operation:
 *
 * 1. **A detached restarter.** The bridge spawns a hidden PowerShell that waits
 *    for the port to stop answering and only then runs the launcher. Spawning
 *    the launcher first would find the port still held, decide the server was
 *    already running, and just open a browser tab — the restart would quietly
 *    not happen.
 * 2. **A marker on disk.** The asking conversation and the moment it asked are
 *    written before the process dies, because the process that comes back has
 *    no memory of the request.
 * 3. **An announcement.** On the next start, once the QQ channel is back
 *    online, the marker's conversation receives the fresh authenticated URL.
 *    That is the part that removes the "which tab was the right one" problem
 *    entirely: the correct address is pushed to the phone.
 *
 * All three are best-effort. A failed announcement must never take the plugin
 * down, and a missing launcher must produce a refusal the operator can read
 * rather than an exit that leaves the server down.
 *
 * @module dsh-qq/bridge/restart
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The launcher this deployment uses when settings name none.
 *
 * A default that only applies when the file is actually there: an absent
 * launcher must refuse the command, not spawn a shell that fails invisibly on
 * the machine while the operator is told a restart is under way.
 *
 * @returns The candidate launcher path.
 */
export function defaultLauncherPath() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  return home === '' ? '' : join(home, 'Documents', 'Start-DeepSeek-Harness.cmd')
}

/**
 * Resolve the launcher to run.
 *
 * @param configured - the `restartCommand` setting.
 * @returns The path to launch, or null when none is usable.
 */
export function resolveLauncher(configured) {
  const explicit = typeof configured === 'string' ? configured.trim() : ''
  if (explicit !== '') return existsSync(explicit) ? explicit : null
  const fallback = defaultLauncherPath()
  return fallback !== '' && existsSync(fallback) ? fallback : null
}

/**
 * Compose the detached restarter script.
 *
 * The loop is deliberately a *wait for the port to close*, not a fixed sleep:
 * the old process may take seconds to release the socket, and the launcher
 * treats "something is listening" as "already running".
 *
 * Every step is timestamped into `logPath`. A restart happens while nobody is
 * watching the machine, and its two failure modes — the launcher never ran, and
 * the launcher ran but the server never came back — look identical from QQ.
 * Each one is a line in this file, which is also what the returning process
 * quotes back in its notice.
 *
 * @param options - launcher, port, and where to narrate.
 * @param options.launcher - path to the launcher script.
 * @param options.port - the port the old process is holding.
 * @param options.logPath - progress log, one timestamped line per step.
 * @param options.timeoutSeconds - how long to wait for the port to close.
 * @param options.readySeconds - how long to wait for the server to come back.
 * @returns A PowerShell program.
 */
export function restarterScript({ launcher, port, logPath, timeoutSeconds = 120, readySeconds = 180 }) {
  // Single-quoted PowerShell strings escape an embedded quote by doubling it.
  const target = String(launcher).replace(/'/g, "''")
  const log = String(logPath ?? '').replace(/'/g, "''")
  const listen = String(port)
  return [
    `$log = '${log}'`,
    `function Note($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Add-Content -Path $log }`,
    `function Test-Port { $c = New-Object Net.Sockets.TcpClient; try { $c.Connect('127.0.0.1', ${listen}); $c.Close(); return $true } catch { return $false } }`,
    "Note 'restarter started; waiting for the old server to release the port'",
    `$deadline = (Get-Date).AddSeconds(${String(timeoutSeconds)})`,
    'while ((Get-Date) -lt $deadline -and (Test-Port)) { Start-Sleep -Milliseconds 400 }',
    `Note 'port released; launching ${target}'`,
    // `--no-open`: this restart is driven from a phone. The bridge pushes the
    // new address into the chat, and a tab that is already open keeps working
    // across the restart because its cookie outlives the process — so opening
    // another one only adds clutter (and used to add a dead page each time).
    `Start-Process -FilePath '${target}' -ArgumentList '--no-open'`,
    `$deadline = (Get-Date).AddSeconds(${String(readySeconds)})`,
    'while ((Get-Date) -lt $deadline -and -not (Test-Port)) { Start-Sleep -Seconds 1 }',
    "if (Test-Port) { Note 'server is back; the port is accepting connections' } else { Note 'the server did NOT come back; start it by hand' }",
  ].join('\n')
}

/**
 * Build the restart service.
 *
 * Two phases on purpose. `prepare` only decides whether a restart is possible,
 * so the caller can refuse with a readable reason; `go` then performs it. The
 * reply must be *sent* in between: this process is about to die, and a message
 * still sitting in the send queue when it does is a message the operator never
 * sees.
 *
 * @param options - wiring.
 * @param options.markerPath - where the pending-restart marker lives.
 * @param options.log - diagnostics sink.
 * @param options.spawnImpl - process spawner, injectable for tests.
 * @param options.exit - process exit, injectable for tests.
 * @param options.resolve - reads the launcher path and served port when the
 *   command runs, not when the plugin loads: the setting can change and the Web
 *   server may not have bound its port yet at load time.
 * @returns The service: prepare a restart, perform it, and read the marker.
 */
export function createRestartService({
  markerPath,
  logPath,
  log,
  spawnImpl = spawn,
  exit = (code) => process.exit(code),
  resolve = () => ({ launcher: null, port: 0 }),
}) {
  /**
   * Decide whether a restart can happen.
   *
   * @returns Either `{ launcher, port }` or `{ error }` with a readable reason.
   */
  function prepare() {
    const { launcher, port } = resolve()
    if (typeof launcher !== 'string' || launcher === '') {
      return {
        error: '没有可用的启动器。请在设置卡片里填「重启命令」，或把 Start-DeepSeek-Harness.cmd 放回 Documents。',
      }
    }
    if (!Number.isSafeInteger(port) || port <= 0) {
      return { error: '当前进程没有在监听端口，无法判断何时可以安全拉起新进程。' }
    }
    return { launcher, port }
  }

  /**
   * Spawn the detached restarter and terminate this process.
   *
   * @param options - what to restart with.
   * @param options.launcher - launcher path.
   * @param options.port - the port to wait on.
   * @param options.key - the conversation to announce to after the restart.
   * @param options.delayMs - grace period before this process exits.
   */
  /** Set once `go` has committed this process to exiting. */
  let inFlight = false

  function go({ launcher: target, port: listenPort, key, delayMs = 2_000 }) {
    // Recorded so the exit note can tell 'a restart asked for this' apart
    // from 'something ended the process'. The two have very different
    // follow-ups, and the log is the only witness.
    inFlight = true
    writeMarker({ key, at: Date.now(), launcher: target })
    const script = restarterScript({ launcher: target, port: listenPort, logPath })
    let scriptPath
    try {
      scriptPath = writeScript(script)
    } catch (error) {
      log(`restart script could not be written: ${String(error?.message ?? error)}`)
      return
    }

    // Detachment is done by `cmd /c start`, NOT by Node's `detached: true`.
    // Measured on this platform: a `detached: true` spawn of powershell.exe
    // exits 0 having done nothing whatsoever — no output, no side effect, no
    // error event — so the restart silently became "the server went down and
    // stayed down". `start` also gives the restarter its OWN console, which is
    // the part that matters here: `dsh web` runs in this process's console, and
    // when this process exits that console closes, taking every process still
    // attached to it. A restarter sharing it would be killed mid-wait.
    const child = spawnImpl('cmd.exe', [
      '/c', 'start', '', '/min',
      'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
    ], { stdio: 'ignore', windowsHide: true })
    child.unref?.()
    log(`restart requested; waiting for port ${String(listenPort)} then launching ${target}`)

    // The reply is queued behind the conversation's send chain, so the exit
    // waits long enough for it to leave: a process that dies first would leave
    // the operator staring at a message that never arrived.
    const timer = setTimeout(() => {
      log('restart: exiting for the launcher to take over')
      exit(0)
    }, delayMs)
    timer.unref?.()
  }

  /**
   * Write the restarter program next to the marker.
   *
   * A file rather than `-Command`: the program is multi-line PowerShell full of
   * quotes, and smuggling that through `cmd /c start` invites a parsing bug
   * that only shows up on somebody else's machine. A path is one argument and
   * cannot be misread.
   *
   * @param script - the PowerShell program.
   * @returns The path it was written to.
   */
  function writeScript(script) {
    const target = `${markerPath}.ps1`
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, script, 'utf8')
    return target
  }

  /**
   * Write the pending-restart marker.
   *
   * @param marker - what to remember across the restart.
   */
  function writeMarker(marker) {
    try {
      mkdirSync(dirname(markerPath), { recursive: true })
      const temp = `${markerPath}.tmp`
      writeFileSync(temp, JSON.stringify(marker, null, 2))
      // Rename, so a process killed mid-write cannot leave half a marker that
      // the next start would read as a request.
      renameSync(temp, markerPath)
    } catch (error) {
      // Losing the marker costs the announcement, not the restart.
      log(`restart marker could not be written: ${String(error?.message ?? error)}`)
    }
  }

  /**
   * Read and clear the marker, so one restart produces exactly one notice.
   *
   * @returns The marker, or null when this start was not a `/restart`.
   */
  function takeMarker() {
    let raw
    try {
      raw = readFileSync(markerPath, 'utf8')
    } catch {
      return null
    }
    try {
      rmSync(markerPath, { force: true })
    } catch (error) {
      log(`restart marker could not be cleared: ${String(error?.message ?? error)}`)
    }
    try {
      const parsed = JSON.parse(raw)
      return parsed !== null && typeof parsed === 'object' ? parsed : null
    } catch (error) {
      log(`restart marker was unreadable: ${String(error?.message ?? error)}`)
      return null
    }
  }

  return {
    prepare,
    go,
    takeMarker,
    /** Whether this process is on its way out for a restart. */
    get pending() { return inFlight },
  }
}

/**
 * Read the tail of the restarter's progress log.
 *
 * Quoted back in the restart notice: a restart nobody watched is only as
 * trustworthy as its record, and "the launcher ran" versus "I started it by
 * hand" is exactly the question the operator cannot otherwise answer.
 *
 * @param logPath - the restarter log.
 * @param maxLines - how many trailing lines to return.
 * @returns The trailing lines, oldest first; empty when there is no log.
 */
export function readRestarterTail(logPath, maxLines = 2) {
  let raw
  try {
    raw = readFileSync(logPath, 'utf8')
  } catch {
    return []
  }
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(-maxLines)
    // The date prefix is noise on a phone; the clock time is enough to line the
    // steps up against the moment the operator sent the command.
    .map((line) => line.replace(/^\d{4}-\d{2}-\d{2}\s+/, ''))
}

/**
 * Prove the plugin still imports before handing the process over.
 *
 * `/restart` is the only way to load a code change from QQ, which makes a
 * broken change unrecoverable through that same channel: the new process fails
 * to mount the plugin, the bridge never comes back, and the only way out is the
 * desktop this command exists to avoid. So the import graph is exercised in a
 * throwaway child FIRST, and a failure refuses the restart while a working
 * bridge is still there to say why.
 *
 * A child process rather than an in-process `import()`: module loading is
 * cached, and the failures worth catching — a syntax error, a missing export, a
 * bad top-level await — are exactly the ones that can take the loader down with
 * them.
 *
 * @param options - what to check and how.
 * @param options.entryPath - absolute path of the plugin entry module.
 * @param options.spawnImpl - process spawner, injectable for tests.
 * @param options.timeoutMs - how long the import may take.
 * @returns `{ ok: true }`, or `{ ok: false, error }` with the child's message.
 */
export function verifyPluginLoads({ entryPath, spawnImpl = spawn, timeoutMs = 30_000 }) {
  return new Promise((resolve) => {
    let url
    try {
      url = pathToFileURL(entryPath).href
    } catch (error) {
      resolve({ ok: false, error: `插件入口路径无效：${String(error?.message ?? error)}` })
      return
    }

    let settled = false
    let timer = null
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolve(result)
    }

    let child
    try {
      child = spawnImpl(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(url)})`], {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      finish({ ok: false, error: `无法启动自检进程：${String(error?.message ?? error)}` })
      return
    }

    timer = setTimeout(() => {
      // An import that hangs is itself a reason to refuse: a plugin that cannot
      // finish loading in half a minute will not serve QQ either.
      try {
        child.kill()
      } catch {
        // Best effort; the refusal below is what matters.
      }
      finish({ ok: false, error: `自检超时（超过 ${String(Math.round(timeoutMs / 1000))} 秒）：插件加载可能卡住了` })
    }, timeoutMs)
    timer.unref?.()

    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 4_000) stderr += String(chunk)
    })
    child.on('error', (error) => {
      finish({ ok: false, error: `自检进程失败：${String(error?.message ?? error)}` })
    })
    child.on('close', (code) => {
      if (code === 0) {
        finish({ ok: true })
        return
      }
      finish({ ok: false, error: condenseImportError(stderr, code) })
    })
  })
}

/**
 * Reduce a module-loading failure to something readable on a phone.
 *
 * The stack is noise: the first `Error:`/`SyntaxError:` line and the file it
 * happened in are the whole diagnosis, and QQ is not the place for forty lines
 * of frames.
 *
 * @param stderr - everything the child wrote.
 * @param code - the child's exit code.
 * @returns One short paragraph.
 */
export function condenseImportError(stderr, code) {
  const lines = String(stderr ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const interesting = lines.filter((line) => /error|cannot|failed|unexpected|not found/i.test(line))
  const picked = (interesting.length > 0 ? interesting : lines).slice(0, 4).join('\n')
  return picked === '' ? `自检失败（退出码 ${String(code)}），且没有任何输出` : picked.slice(0, 600)
}

/**
 * The authenticated URL of the running Web GUI.
 *
 * `authenticatedUrl` is the only way to obtain the URL that actually
 * authenticates: the launch token is minted per process and carried in the
 * query string, which is why a saved link from an earlier run answers 404.
 *
 * @param ctx - the plugin context.
 * @returns The URL, or '' when this profile serves no Web GUI.
 */
export function authenticatedWebUrl(ctx) {
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  const port = webServer?.port
  if (connection === undefined || connection === null || typeof connection.authenticatedUrl !== 'function') return ''
  if (!Number.isSafeInteger(port) || port <= 0) return ''
  try {
    return String(connection.authenticatedUrl(`http://127.0.0.1:${String(port)}`))
  } catch {
    return ''
  }
}
