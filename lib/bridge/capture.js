/**
 * Screen and window capture for this machine.
 *
 * Split out of the tool registrations because two very different callers need
 * it — the `qq_send_screenshot` tool and the `/screen` command — and because the
 * inbound path needs the temp-file housekeeping that goes with it. A module that
 * registers agent tools should not be the place other modules import file
 * helpers from.
 *
 * @module dsh-qq/bridge/capture
 */

import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Where the window-capture helper lives.
 *
 * Shipped with the plugin rather than inlined here: it is PowerShell, it is the
 * part of this feature that needs care (DPI awareness, window selection,
 * detecting a window that never painted), and keeping it in a file means it can
 * be run and debugged on its own.
 *
 * @returns An absolute path.
 */
function captureScriptPath() {
  return fileURLToPath(new URL('../../tools/capture-window.ps1', import.meta.url))
}

/**
 * Compose the capture command.
 *
 * @param options - what to capture and where to put it.
 * @param options.scriptPath - the PowerShell helper.
 * @param options.out - output PNG path.
 * @param options.process - process name filter, as a regular expression.
 * @param options.title - window title filter, as a regular expression.
 * @param options.screen - capture the whole screen instead of one window.
 * @returns The argv for `powershell.exe`.
 */
export function buildCaptureArgs({ scriptPath, out, process = '', title = '', screen = false, method = 'auto' }) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Out', out]
  if (screen === true) args.push('-Screen')
  if (typeof process === 'string' && process.trim() !== '') args.push('-Process', process.trim())
  if (typeof title === 'string' && title.trim() !== '') args.push('-Title', title.trim())
  // Only sent when it is not the default, so the common command line stays
  // exactly as documented in the helper's examples.
  if (method === 'screen' || method === 'printwindow') args.push('-Method', method)
  return args
}

/**
 * Read the helper's one-line JSON result.
 *
 * The helper reports WHY it failed in the same shape it reports success — a
 * window that never painted, a desktop that is not rendering — so a capture
 * failure reaches the operator as a sentence instead of an empty file.
 *
 * @param stdout - everything the helper printed.
 * @param code - its exit code.
 * @returns The parsed result.
 * @throws {Error} when no usable result is present.
 */
export function parseCaptureResult(stdout, code) {
  const lines = String(stdout ?? '')
    .split(String.fromCharCode(10))
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
  const last = lines.at(-1)
  if (last === undefined) throw new Error(`截图脚本没有返回结果（退出码 ${String(code)}）`)
  let parsed
  try {
    parsed = JSON.parse(last)
  } catch (error) {
    throw new Error(`截图结果无法解析：${String(error?.message ?? error)}`)
  }
  if (parsed?.ok !== true) {
    throw new Error(String(parsed?.error ?? '截图失败，且脚本没有说明原因'))
  }
  return parsed
}

/**
 * Capture a screenshot and read the bytes.
 *
 * Shared by the `qq_send_screenshot` tool and the `/screen` command: both mean
 * the same thing — put a picture of this machine into the chat — and neither
 * should own a second copy of the capture recipe.
 *
 * @param options - what to capture.
 * @param options.process - process name filter, as a regular expression.
 * @param options.title - window title filter, as a regular expression.
 * @param options.screen - capture the whole screen.
 * @param options.method - `auto` (default), `screen`, or `printwindow`.
 * @param options.log - diagnostics sink.
 * @returns The PNG bytes plus how it was obtained.
 * @throws {Error} with the helper's own reason when nothing usable was captured.
 */
export async function captureScreen({ process = undefined, title = undefined, screen = false, method = 'auto', log = () => {} } = {}) {
  if (globalThis.process.platform !== 'win32') throw new Error('截图目前只在 Windows 上实现')

  const out = join(tmpdir(), `dsh-qq-screenshot-${String(Date.now())}.png`)
  // Housekeeping first: captures accumulate in the temp directory and nothing
  // else removes them. A failure here must not fail the capture.
  try {
    const pruned = pruneCaptures({ dir: tmpdir() })
    if (pruned > 0) log(`removed ${String(pruned)} screenshot(s) older than a day`)
  } catch { /* best effort */ }

  const argv = buildCaptureArgs({
    scriptPath: captureScriptPath(),
    out,
    process,
    title,
    method,
    // No window named and no filter: the operator means "what is on screen".
    screen: screen === true || (process === undefined && title === undefined),
  })

  const captured = await new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      fn(value)
    }
    const child = spawn('powershell.exe', argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { if (stderr.length < 2_000) stderr += String(chunk) })
    child.on('error', (error) => finish(reject, new Error(`截图进程启动失败：${String(error?.message ?? error)}`)))
    child.on('close', (code) => finish(resolve, { stdout, stderr, code }))
    // A capture that hangs is a failure too: the operator is waiting on a
    // phone, and a clear error beats a screenshot nobody ever receives.
    timer = setTimeout(() => {
      try { child.kill() } catch { /* best effort */ }
      finish(reject, new Error('截图超时（30 秒）：可能是桌面没有响应'))
    }, 30_000)
    timer.unref?.()
  })

  const result = parseCaptureResult(captured.stdout, captured.code)
  let data
  try {
    data = readFileSync(result.path)
  } catch (error) {
    throw new Error(`读取截图失败：${String(error?.message ?? error)}`)
  }
  return { ...result, data }
}

/**
 * Delete captures older than a day.
 *
 * The screenshots land in the system temp directory and nothing else removes
 * them, so a few days of use leaves a pile. Recent ones are kept on purpose:
 * the caller checks the picture it just sent, and a failure is worth looking at
 * afterwards.
 *
 * @param options - where and how old.
 * @param options.dir - directory to sweep.
 * @param options.prefix - file name prefix that identifies our files.
 * @param options.suffix - file name suffix; '' sweeps every name with that prefix.
 * @param options.maxAgeMs - age beyond which a capture is removed.
 * @param options.now - the current clock, injectable for tests.
 * @returns How many files were removed.
 */
export function pruneCaptures({ dir, prefix = 'dsh-qq-screenshot-', suffix = '.png', maxAgeMs = 24 * 60 * 60 * 1000, now = Date.now() }) {
  let removed = 0
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) continue
    const full = join(dir, entry)
    try {
      if (now - statSync(full).mtimeMs < maxAgeMs) continue
      rmSync(full, { force: true })
      removed += 1
    } catch {
      // A file another process is holding is not worth failing a capture over.
    }
  }
  return removed
}
