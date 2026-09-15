import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Point the plugin's state file at a scratch directory before importing it, so
// these tests never read or write the operator's real conversation table.
const SANDBOX = mkdtempSync(join(tmpdir(), 'dsh-qq-plugin-'))
process.env.DSH_HOME = SANDBOX
process.on('exit', () => { rmSync(SANDBOX, { recursive: true, force: true }) })

const { apply, name, inject, SETTINGS_NS, activeReminders, createBusyProbe, createProjectionReader } = await import('../lib/index.js')

/**
 * A stand-in DSH context exposing only the seams the plugin injects.
 *
 * Loading the plugin against this catches wiring mistakes — a service read at
 * the wrong time, a disposer that was never registered, a handler that throws
 * during setup — without needing a DSH restart to find them.
 */
function mockContext({ settings = {}, withWebServer = true, connection = undefined } = {}) {
  const listeners = new Map()
  const tools = []
  const routes = []
  const effects = []
  let stored = { ...settings }
  const prompts = []
  const created = []

  const scope = {
    get: () => ({ ...stored }),
    watch: () => () => {},
    update: async (patch) => { stored = { ...stored, ...patch } },
    replace: async (next) => { stored = { ...next } },
  }

  const ctx = {
    settings: { register: (ns, schema, options) => { assert.equal(ns, SETTINGS_NS); void schema; void options; return scope } },
    tools: { register: (definition) => { tools.push(definition); return () => { tools.splice(tools.indexOf(definition), 1) } } },
    sessionController: {
      create: async (request) => {
        if (request.workspaceId !== undefined && request.cwd !== undefined) {
          throw new Error('session.create accepts workspaceId or cwd, not both')
        }
        created.push(request)
        return { sessionId: `sess_${created.length}` }
      },
      prompt: async (request, signal) => {
        // The real controller dereferences the signal immediately.
        signal.throwIfAborted()
        prompts.push(request)
        return { accepted: true }
      },
    },
    on: (event, handler) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => { listeners.get(event).splice(listeners.get(event).indexOf(handler), 1) }
    },
    get: (service) => {
      if (service === 'webServer' && withWebServer) {
        return { register: (route) => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } } }
      }
      if (service === 'connection') return connection
      if (service === 'workspaceRegistry') {
        return { create: async (path, title) => ({ id: 'ws_1', path, title }) }
      }
      return undefined
    },
    effect: (factory, label) => { effects.push({ dispose: factory(), label }) },
  }

  return { ctx, listeners, tools, routes, effects, prompts, created, getSettings: () => stored }
}

test('the plugin declares the services it cannot work without', () => {
  assert.equal(name, 'dsh-qq')
  assert.ok(inject.includes('sessionController'))
  assert.ok(inject.includes('tools'))
  assert.ok(inject.includes('settings'))
})

test('the busy probe answers true, false, and null for the three distinct cases', () => {
  const running = createBusyProbe({ ctx: { get: () => ({ get: (id) => ({ id, status: id === 'a' ? 'running' : 'idle' }) }) }, log: () => {} })
  assert.equal(running('a'), true)
  assert.equal(running('b'), false)
  // A session that is not attached is idle, not unknown: the next prompt
  // resumes it, so queueing is correct there.
  assert.equal(createBusyProbe({ ctx: { get: () => ({ get: () => undefined }) }, log: () => {} })('c'), false)
})

test('an unreachable agent registry reads as unknown rather than idle', () => {
  const cases = [
    { get: () => undefined },
    { get: () => null },
    { get: () => ({}) },
    {},
  ]
  for (const ctx of cases) {
    assert.equal(createBusyProbe({ ctx, log: () => {} })('a'), null, 'only a proven running turn may steer')
  }
})

test('a throwing agent registry is reported, not propagated', () => {
  const logged = []
  const probe = createBusyProbe({
    ctx: { get: () => ({ get: () => { throw new Error('registry exploded') } }) },
    log: (message) => logged.push(message),
  })
  assert.equal(probe('a'), null)
  assert.match(logged.join('\n'), /registry exploded/)
})

test('loading registers tools, console routes, answerers, and a lifecycle effect', () => {
  const h = mockContext()
  apply(h.ctx)

  const toolNames = h.tools.map((tool) => tool.name).sort()
  assert.deepEqual(toolNames, ['qq_get_status', 'qq_reply', 'qq_send_file', 'qq_send_image', 'qq_send_message', 'qq_send_screenshot'])

  const paths = h.routes.map((route) => route.path).sort()
  assert.deepEqual(paths, ['/dsh-qq/config', '/dsh-qq/pair', '/dsh-qq/state'])

  assert.ok(h.listeners.has('session/event'))
  assert.ok(h.listeners.has('approval/request'))
  assert.ok(h.listeners.has('user-questions/request'))
  assert.ok(h.listeners.has('agent/error'))

  assert.equal(h.effects.length, 1)
  assert.match(h.effects[0].label, /dsh-qq/)
})

test('loading without a web server still succeeds, minus the console', () => {
  const h = mockContext({ withWebServer: false })
  apply(h.ctx)
  assert.deepEqual(h.routes, [])
  assert.equal(h.tools.length, 6, 'tools do not depend on the web server')
})

test('loading the plugin performs no network I/O while disabled', () => {
  const h = mockContext()
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = (...args) => { calls.push(args); return Promise.reject(new Error('network use is not expected')) }
  try {
    apply(h.ctx)
  } finally {
    globalThis.fetch = original
  }
  // The bridge ships disabled with no credentials, so a freshly loaded plugin
  // must not reach for the network on its own.
  assert.deepEqual(calls, [])
})

test('the approval answerer ignores requests that belong to other sessions', async () => {
  const h = mockContext()
  apply(h.ctx)

  const handler = h.listeners.get('approval/request')[0]
  let delegated = false
  const outcome = await handler(
    { agent: { session: { id: 'sess_not_qq' } }, toolName: 'bash' },
    async () => { delegated = true; return 'allowed-once' },
  )

  assert.equal(delegated, true, 'a non-QQ session must fall through to the desktop answerer')
  assert.equal(outcome, 'allowed-once')
})

test('the question answerer ignores requests that belong to other sessions', async () => {
  const h = mockContext()
  apply(h.ctx)

  const handler = h.listeners.get('user-questions/request')[0]
  let delegated = false
  const answer = { answers: [{ id: 'q1', selected: ['A'] }] }
  const outcome = await handler(
    { questions: [{ id: 'q1', question: '?' }], agent: { session: { id: 'sess_not_qq' } } },
    async () => { delegated = true; return answer },
  )

  assert.equal(delegated, true)
  assert.deepEqual(outcome, answer)
})

test('an approval for a session with no QQ binding still delegates', async () => {
  const h = mockContext()
  apply(h.ctx)
  const handler = h.listeners.get('approval/request')[0]
  const outcome = await handler({ toolName: 'bash' }, async () => 'rejected')
  assert.equal(outcome, 'rejected')
})

test('the console state route answers with JSON', async () => {
  const h = mockContext()
  apply(h.ctx)

  const route = h.routes.find((entry) => entry.path === '/dsh-qq/state')
  const response = captureResponse()
  await route.handler({ method: 'GET', url: '/dsh-qq/state' }, response.res)

  assert.equal(response.status, 200)
  const body = JSON.parse(response.body)
  assert.equal(body.enabled, false)
  assert.equal(body.gateway, 'stopped')
  assert.equal(body.hasCredentials, false)
  assert.deepEqual(body.conversations, [], 'the state route must see only this sandbox home')
})

test('the config route redacts the secret and refuses unknown methods', async () => {
  const h = mockContext({ settings: { appId: 'APP', appSecret: 'SECRET' } })
  apply(h.ctx)
  const route = h.routes.find((entry) => entry.path === '/dsh-qq/config')

  const get = captureResponse()
  await route.handler({ method: 'GET', url: '/dsh-qq/config' }, get.res)
  const body = JSON.parse(get.body)
  assert.equal(body.appId, 'APP')
  assert.equal(body.appSecret, undefined, 'the secret must never leave the process')
  assert.equal(body.appSecretSet, true)

  const put = captureResponse()
  await route.handler({ method: 'PUT', url: '/dsh-qq/config' }, put.res)
  assert.equal(put.status, 405)
})

test('a config write accepts only writable, well-typed fields', async () => {
  // Start with a stored secret so "leave it alone" is observable.
  const h = mockContext({ settings: { appSecret: 'EXISTING' } })
  apply(h.ctx)
  const route = h.routes.find((entry) => entry.path === '/dsh-qq/config')

  const response = captureResponse()
  await route.handler(
    { method: 'POST', url: '/dsh-qq/config', ...fakeRequest('{"enabled":true,"allow":["U1",""],"maxBytes":-5,"bogus":1,"appSecret":"","busyDelivery":"queue"}') },
    response.res,
  )

  assert.equal(response.status, 200)
  const stored = h.getSettings()
  assert.equal(stored.enabled, true)
  assert.deepEqual(stored.allow, ['U1'], 'empty allow entries are dropped')
  assert.equal(stored.maxBytes, undefined, 'a negative number is refused')
  assert.equal(stored.bogus, undefined, 'an unknown field is refused')
  assert.equal(stored.busyDelivery, 'queue', 'the delivery setting must survive the writable-key allowlist')
  assert.equal(stored.appSecret, 'EXISTING', 'an empty secret must not clear the stored one')
})

test('the two new numeric settings are writable from the settings card', async () => {
  // The card is the surface an operator actually edits; a setting the schema
  // knows but the writable list omits silently refuses to save.
  const h = mockContext()
  apply(h.ctx)
  const route = h.routes.find((entry) => entry.path === '/dsh-qq/config')

  const response = captureResponse()
  await route.handler(
    { method: 'POST', url: '/dsh-qq/config', ...fakeRequest('{"planAlertPercent":85,"longAnswerChunks":2}') },
    response.res,
  )

  assert.equal(response.status, 200)
  const stored = h.getSettings()
  assert.equal(stored.planAlertPercent, 85)
  assert.equal(stored.longAnswerChunks, 2)
})

test('zero switches a warning off from the card, but stays invalid where it is not a disable', async () => {
  // The settings table documents `0` as the way to switch these off. Refusing it
  // silently kept the old value while the save reported success, which is the
  // one outcome an operator cannot detect.
  const h = mockContext()
  apply(h.ctx)
  const route = h.routes.find((entry) => entry.path === '/dsh-qq/config')

  const response = captureResponse()
  await route.handler(
    { method: 'POST', url: '/dsh-qq/config', ...fakeRequest('{"planAlertPercent":0,"longAnswerChunks":0,"lowBalanceThreshold":0,"maxBytes":0,"approvalTimeoutMs":-1}') },
    response.res,
  )

  assert.equal(response.status, 200)
  const stored = h.getSettings()
  assert.equal(stored.planAlertPercent, 0)
  assert.equal(stored.longAnswerChunks, 0)
  assert.equal(stored.lowBalanceThreshold, 0)
  assert.equal(stored.maxBytes, undefined, 'a byte budget of zero bytes is not a disable')
  assert.equal(stored.approvalTimeoutMs, undefined, 'nor is a timeout that expires before it is armed')
})

test('the schedule projection yields its active reminders, or nothing to read', () => {
  // DSH's schedule plugin folds reminders into the `schedule` projection; a
  // profile without that plugin reports no such state, and `/status` then says
  // nothing rather than reporting a missing feature as an error.
  assert.deepEqual(activeReminders({ inheritedEventCount: 3, active: [{ id: 'schedule-1' }], seenIds: [] }), [{ id: 'schedule-1' }])
  assert.deepEqual(activeReminders({ active: [] }), [], 'a mounted plugin with no reminders is an answer, not an absence')
  assert.equal(activeReminders(undefined), null)
  assert.equal(activeReminders(null), null)
  assert.equal(activeReminders({}), null)
  assert.equal(activeReminders({ active: 'nonsense' }), null)
})

test('the projection reader resolves the session and survives a deployment that cannot answer', async () => {
  const asked = []
  const readable = createProjectionReader({
    ctx: {
      sessionController: { resolveAgent: async (id) => ({ agent: { session: { id } } }) },
      get: (service) => (service === 'sessionProjections'
        ? { stateOf: (session, key) => { asked.push(`${session.id}/${key}`); return { inheritedEventCount: 0, active: [], seenIds: [] } } }
        : undefined),
    },
    log: () => {},
  })
  assert.deepEqual(await readable('sess_1', 'schedule'), { inheritedEventCount: 0, active: [], seenIds: [] })
  assert.deepEqual(asked, ['sess_1/schedule'], 'the projection is read for the session that was asked about')

  // No projection registry: the plugin that registers `schedule` is not mounted.
  const noRegistry = createProjectionReader({
    ctx: { sessionController: { resolveAgent: async () => ({ agent: { session: {} } }) }, get: () => undefined },
    log: () => {},
  })
  assert.equal(await noRegistry('sess_1', 'schedule'), undefined)

  // No agent resolver at all, and a resolver that is not thenable: both are
  // "cannot read", never a guess.
  assert.equal(createProjectionReader({ ctx: {}, log: () => {} })('sess_1', 'schedule'), null)
  const synchronous = createProjectionReader({ ctx: { sessionController: { resolveAgent: () => ({ agent: { session: {} } }) } }, log: () => {} })
  assert.equal(synchronous('sess_1', 'schedule'), null)

  const logged = []
  const throwing = createProjectionReader({
    ctx: { sessionController: { resolveAgent: () => { throw new Error('registry exploded') } } },
    log: (message) => logged.push(message),
  })
  assert.equal(throwing('sess_1', 'schedule'), null)
  assert.match(logged.join('\n'), /schedule projection could not be read.*registry exploded/)
})

test('unloading disposes every registration', () => {
  const h = mockContext()
  apply(h.ctx)
  assert.equal(h.tools.length, 6)

  h.effects[0].dispose()

  assert.equal(h.tools.length, 0, 'tools are unregistered')
  assert.equal(h.routes.length, 0, 'console routes are removed')
  for (const handlers of h.listeners.values()) {
    assert.equal(handlers.length, 0, 'listeners are removed')
  }
})

/**
 * Build a Node-response stand-in that records what the handler wrote.
 *
 * @returns The response object plus getters for the captured status and body.
 */
function captureResponse() {
  const capture = { status: 0, body: '' }
  capture.res = {
    writeHead(status) { capture.status = status },
    end(text) { capture.body = text ?? '' },
  }
  return capture
}

/**
 * Build a request stand-in that emits one body chunk.
 *
 * @param body - the JSON text to emit.
 * @returns A minimal EventEmitter-like request.
 */
function fakeRequest(body) {
  const request = {
    on(event, handler) {
      if (event === 'data') queueMicrotask(() => handler(Buffer.from(body, 'utf8')))
      if (event === 'end') queueMicrotask(() => handler())
      return request
    },
    destroy() {},
  }
  return request
}

// ── the console routes are fenced ───────────────────────────────────────────

/** A response double that records what a route handler wrote. */
function response() {
  const out = { status: 0, body: '', ended: false }
  return {
    writeHead(status) { out.status = status },
    end(body) { out.body = body ?? ''; out.ended = true },
    get result() { return out },
  }
}

test('a console route refuses an untrusted host before reading anything', () => {
  // `webServer.register` applies neither the trusted-host check nor the browser
  // session check that `/api` gets. Without the guard these routes are reachable
  // from any page the operator has open — a rebinding host resolves to
  // 127.0.0.1 and the settings endpoint rewrites the allow list.
  const h = mockContext({ connection: { requestRejection: () => 403 } })
  apply(h.ctx)
  const route = h.routes.find((entry) => entry.path === '/dsh-qq/config')
  const res = response()
  route.handler({ method: 'GET', headers: { host: 'evil.example.com' } }, res)
  assert.equal(res.result.status, 403)
  assert.equal(res.result.body, 'forbidden')
  assert.doesNotMatch(res.result.body, /ownerOpenId|appSecret/, 'nothing about the settings leaks')
})

test('a console route refuses an unauthenticated browser', () => {
  const h = mockContext({ connection: { requestRejection: () => 401 } })
  apply(h.ctx)
  const res = response()
  h.routes.find((entry) => entry.path === '/dsh-qq/state').handler({ method: 'GET', headers: {} }, res)
  assert.equal(res.result.status, 401)
  assert.equal(res.result.body, 'unauthorized')
})

test('a trusted, authenticated request still reads the state', () => {
  const h = mockContext({ connection: { requestRejection: () => undefined } })
  apply(h.ctx)
  const res = response()
  h.routes.find((entry) => entry.path === '/dsh-qq/state').handler({ method: 'GET', headers: {} }, res)
  assert.equal(res.result.status, 200, 'the settings card keeps working')
})

test('the plugin says how the process ended', () => {
  // This deployment lost the process twice overnight with no trace: no log line,
  // no Windows event, no crash record. The exit note is the forensic floor.
  const listeners = new Map()
  const originalOn = process.on.bind(process)
  const originalRemove = process.removeListener.bind(process)
  const added = []
  process.on = (event, handler) => { added.push(event); if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(handler); return process }
  process.removeListener = (event, handler) => { const list = listeners.get(event); if (list) list.splice(list.indexOf(handler), 1); return process }
  const logged = []
  const originalLog = console.log
  console.log = (line) => { logged.push(String(line)) }
  try {
    const h = mockContext()
    apply(h.ctx)
    assert.ok(added.includes('exit'), 'an exit listener is installed')
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
      assert.ok(added.includes(signal), `${signal} is recorded before it is re-raised`)
    }
    for (const handler of listeners.get('exit') ?? []) handler(0)
    assert.match(logged.join('\n'), /process exit: code 0/)
  } finally {
    console.log = originalLog
    process.on = originalOn
    process.removeListener = originalRemove
  }
})
