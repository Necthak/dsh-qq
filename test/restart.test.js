import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  condenseImportError,
  createRestartService,
  defaultLauncherPath,
  readRestarterTail,
  resolveLauncher,
  restarterScript,
  verifyPluginLoads,
} from '../lib/bridge/restart.js'

function tempMarker() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-restart-'))
  return { path: join(dir, 'dsh-qq-restart.json'), dir }
}

/** A spawn stand-in that records the command and returns an unref-able child. */
function fakeSpawn() {
  const calls = []
  const impl = (command, args, options) => {
    calls.push({ command, args, options })
    return { unref: () => { calls.at(-1).unref = true } }
  }
  impl.calls = calls
  return impl
}

test('the restarter waits for the port to close before launching', () => {
  const script = restarterScript({ launcher: 'C:/launcher.cmd', port: 3080 })
  // Launching into a held port makes the launcher think the server is already
  // up: it would open a tab and never restart anything.
  assert.match(script, /Connect\('127\.0\.0\.1', 3080\)/)
  assert.ok(script.indexOf('catch { break }') < script.indexOf('Start-Process'))
  assert.match(script, /Start-Process -FilePath 'C:\/launcher\.cmd' -ArgumentList '--no-open'/,
    'an automatic restart must not open a browser tab: the address goes to the phone')
})

test('an apostrophe in the launcher path cannot break out of the script', () => {
  const script = restarterScript({ launcher: "C:/Bob's Tools/start.cmd", port: 1 })
  assert.match(script, /'C:\/Bob''s Tools\/start\.cmd'/)
})

test('preparing refuses without a launcher, and never guesses a missing one', () => {
  const { path, dir } = tempMarker()
  try {
    const service = createRestartService({ markerPath: path, log: () => {}, resolve: () => ({ launcher: null, port: 3080 }) })
    assert.match(service.prepare().error, /启动器/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('preparing refuses when the process serves no port', () => {
  const { path, dir } = tempMarker()
  try {
    const service = createRestartService({ markerPath: path, log: () => {}, resolve: () => ({ launcher: 'C:/launcher.cmd', port: 0 }) })
    assert.match(service.prepare().error, /端口/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an explicit launcher is used only when it exists', () => {
  const { dir } = tempMarker()
  try {
    const real = join(dir, 'launcher.cmd')
    // A typo must refuse rather than spawn a shell that fails invisibly on the
    // machine while the operator is told the restart is under way.
    assert.equal(resolveLauncher(join(dir, 'missing.cmd')), null)
    // The default is machine-dependent, so the contract is what is asserted:
    // whatever it returns must be a file that is actually there.
    const fallback = resolveLauncher('')
    assert.ok(fallback === null || existsSync(fallback), 'the default is accepted only when the file exists')
    writeFileSync(real, '@echo off\r\n')
    assert.equal(resolveLauncher(real), real)
    assert.equal(resolveLauncher(`  ${real}  `), real, 'surrounding whitespace is not part of the path')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('going writes the marker and the program, launches through start, and exits after the grace period', async () => {
  const { path, dir } = tempMarker()
  try {
    const spawnImpl = fakeSpawn()
    const exited = []
    const service = createRestartService({
      markerPath: path,
      log: () => {},
      spawnImpl,
      exit: (code) => exited.push(code),
      resolve: () => ({ launcher: 'C:/launcher.cmd', port: 3080 }),
    })

    const prepared = service.prepare()
    assert.deepEqual(prepared, { launcher: 'C:/launcher.cmd', port: 3080 })
    service.go({ key: 'group:G1', launcher: prepared.launcher, port: prepared.port, delayMs: 20 })

    // The marker is the only memory the next process has of this request.
    const marker = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(marker.key, 'group:G1')
    assert.equal(marker.launcher, 'C:/launcher.cmd')
    assert.ok(Number.isSafeInteger(marker.at))

    // The program travels as a FILE: multi-line PowerShell full of quotes does
    // not survive being smuggled through `cmd /c start` as an argument.
    const scriptPath = `${path}.ps1`
    assert.ok(existsSync(scriptPath), 'the restarter program is written beside the marker')
    assert.match(readFileSync(scriptPath, 'utf8'), /Test-Port/)

    assert.equal(spawnImpl.calls.length, 1)
    assert.equal(spawnImpl.calls[0].command, 'cmd.exe')
    assert.deepEqual(spawnImpl.calls[0].args.slice(0, 3), ['/c', 'start', ''])
    assert.ok(spawnImpl.calls[0].args.includes(scriptPath))
    // Node's `detached: true` is deliberately NOT used: measured on this
    // platform it exits 0 having done nothing at all, which turned a restart
    // into a plain shutdown.
    assert.equal(spawnImpl.calls[0].options.detached, undefined)
    assert.equal(spawnImpl.calls[0].unref, true)
    assert.equal(exited.length, 0, 'the reply must leave before the process does')

    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.deepEqual(exited, [0])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the marker is consumed exactly once', () => {
  const { path, dir } = tempMarker()
  try {
    const service = createRestartService({
      markerPath: path,
      log: () => {},
      spawnImpl: fakeSpawn(),
      exit: () => {},
      resolve: () => ({ launcher: 'C:/launcher.cmd', port: 3080 }),
    })
    assert.equal(service.takeMarker(), null, 'an ordinary start announces nothing')
    service.go({ key: 'private:U1', launcher: 'C:/launcher.cmd', port: 3080, delayMs: 10_000 })
    assert.equal(service.takeMarker().key, 'private:U1')
    assert.equal(service.takeMarker(), null, 'a restart produces one notice, not one per state transition')
    assert.equal(existsSync(path), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt marker is dropped rather than trusted', () => {
  const { path, dir } = tempMarker()
  try {
    writeFileSync(path, '{ this is not json')
    const service = createRestartService({ markerPath: path, log: () => {}, resolve: () => ({ launcher: null, port: 0 }) })
    assert.equal(service.takeMarker(), null)
    assert.equal(existsSync(path), false, 'a half-written marker must not be retried forever')
    // And the next start is an ordinary one.
    assert.equal(service.takeMarker(), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the default launcher path points at the documented location', () => {
  const path = defaultLauncherPath()
  assert.ok(path === '' || /Documents[\\/]Start-DeepSeek-Harness\.cmd$/.test(path))
})

test('the restarter narrates every step, including a failed comeback', () => {
  const script = restarterScript({ launcher: 'C:/launcher.cmd', port: 3080, logPath: 'C:/logs/restart.log' })
  // A restart happens with nobody watching, so each step is a line somebody can
  // read afterwards: did the launcher even run, and did the server return?
  assert.match(script, /\$log = 'C:\/logs\/restart\.log'/)
  assert.match(script, /waiting for the old server to release the port/)
  assert.match(script, /port released; launching/)
  assert.match(script, /server is back; the port is accepting connections/)
  assert.match(script, /did NOT come back; start it by hand/)
  // Waiting for the port to OPEN is what turns "launched" into "actually back".
  assert.ok(script.indexOf('Test-Port') < script.indexOf('Start-Process'), 'the wait loop is defined first')
})

test('the restart notice quotes the restarter tail without the date prefix', () => {
  const { path, dir } = tempMarker()
  try {
    const logPath = join(dir, 'restart.log')
    writeFileSync(logPath, [
      '2026-09-12 18:23:04 restarter started; waiting for the old server to release the port',
      '2026-09-12 18:23:06 port released; launching C:/launcher.cmd',
      '2026-09-12 18:23:18 server is back; the port is accepting connections',
      '',
    ].join('\n'))
    assert.deepEqual(readRestarterTail(logPath, 2), [
      '18:23:06 port released; launching C:/launcher.cmd',
      '18:23:18 server is back; the port is accepting connections',
    ])
    assert.equal(readRestarterTail(join(dir, 'absent.log')).length, 0, 'no log is not an error')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('detachment is never delegated to Node, which was measured to no-op here', () => {
  // A regression guard for the bug that made /restart a plain shutdown: on this
  // platform `spawn(..., { detached: true })` for powershell.exe exits 0 having
  // performed nothing — no side effect, no output, no error. The restarter is
  // therefore launched through `cmd /c start`, which also gives it its own
  // console so it survives the one this process closes when it exits.
  const { path, dir } = tempMarker()
  try {
    const spawnImpl = fakeSpawn()
    const service = createRestartService({
      markerPath: path,
      logPath: join(dir, 'restarter.log'),
      log: () => {},
      spawnImpl,
      exit: () => {},
      resolve: () => ({ launcher: 'C:/launcher.cmd', port: 3080 }),
    })
    service.go({ key: 'private:U1', launcher: 'C:/launcher.cmd', port: 3080, delayMs: 10_000 })
    const call = spawnImpl.calls[0]
    assert.equal(call.command, 'cmd.exe')
    assert.ok(call.args.includes('start'), 'start is what detaches it')
    assert.notEqual(call.options.detached, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── the restart preflight ───────────────────────────────────────────────────

test('the preflight imports the real entry module in a child process', async () => {
  const calls = []
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options })
    const listeners = {}
    const child = {
      stderr: { on: (name, handler) => { listeners[`err:${name}`] = handler } },
      on: (name, handler) => { listeners[name] = handler },
      kill: () => {},
    }
    // Answer as a healthy import would, on the next tick.
    setTimeout(() => listeners.close?.(0), 0)
    return child
  }
  const result = await verifyPluginLoads({ entryPath: 'C:/plugin/lib/index.js', spawnImpl })
  assert.deepEqual(result, { ok: true })
  assert.equal(calls[0].command, process.execPath)
  assert.ok(calls[0].args.includes('--input-type=module'))
  assert.match(calls[0].args.at(-1), /import\("file:\/\/\/C:\/plugin\/lib\/index\.js"\)/)
})

test('a broken edit refuses the restart and keeps the error readable', async () => {
  const spawnImpl = () => {
    const listeners = {}
    const child = {
      stderr: { on: (name, handler) => { listeners[`err:${name}`] = handler } },
      on: (name, handler) => { listeners[name] = handler },
      kill: () => {},
    }
    setTimeout(() => {
      listeners['err:data']?.('file:///C:/plugin/lib/index.js:12\nSyntaxError: Unexpected token }\nat Module._compile\n    at wrapSafe\n')
      listeners.close?.(1)
    }, 0)
    return child
  }
  const result = await verifyPluginLoads({ entryPath: 'C:/plugin/lib/index.js', spawnImpl })
  assert.equal(result.ok, false)
  // A phone gets the diagnosis, not forty frames of stack.
  assert.match(result.error, /SyntaxError/)
  assert.doesNotMatch(result.error, /at Module\._compile/)
})

test('a preflight that cannot finish is refused rather than waited on forever', async () => {
  const spawnImpl = () => ({
    stderr: { on: () => {} },
    on: () => {},
    kill: () => {},
  })
  const result = await verifyPluginLoads({ entryPath: 'C:/plugin/lib/index.js', spawnImpl, timeoutMs: 30 })
  assert.equal(result.ok, false)
  assert.match(result.error, /自检超时/)
})

test('condensing keeps the first meaningful lines and bounds the length', () => {
  const huge = Array.from({ length: 200 }, (_, i) => `    at frame ${String(i)}`).join('\n')
  const text = condenseImportError(`Error: Cannot find module 'x'\n${huge}`, 1)
  assert.match(text, /Cannot find module/)
  assert.ok(text.length <= 600)
  assert.equal(condenseImportError('', 7), '自检失败（退出码 7），且没有任何输出')
})
