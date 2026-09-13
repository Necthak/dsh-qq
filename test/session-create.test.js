import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionMap } from '../lib/bridge/sessions.js'
import { createSessionEnsurer, sessionLocation } from '../lib/bridge/session-create.js'

/**
 * Build a context whose `create` enforces the same rule the real Session
 * Controller enforces, so a request naming both location fields fails here the
 * way it fails in DSH.
 */
function mockContext({ withRegistry = true, registryFails = false, createFails = false } = {}) {
  const requests = []
  return {
    requests,
    ctx: {
      get: (service) => {
        if (service !== 'workspaceRegistry') return undefined
        if (!withRegistry) return undefined
        return {
          create: async (path, title) => {
            if (registryFails) throw new Error('registry unavailable')
            return { id: 'ws_1', path, title }
          },
        }
      },
      sessionController: {
        create: async (request) => {
          if (createFails) throw new Error('create refused')
          if (request.workspaceId !== undefined && request.cwd !== undefined) {
            throw new Error('session.create accepts workspaceId or cwd, not both')
          }
          requests.push(request)
          return { sessionId: `sess_${requests.length}` }
        },
      },
    },
  }
}

function harness(options = {}, settings = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-sess-'))
  const sessions = new SessionMap({ path: join(dir, 'sessions.json'), log: () => {} })
  const mock = mockContext(options)
  const ensureSession = createSessionEnsurer({
    ctx: mock.ctx,
    sessions,
    config: () => ({ workspacePath: '', agentPreset: '', ...settings }),
    log: () => {},
  })
  return {
    ensureSession,
    sessions,
    requests: mock.requests,
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('sessionLocation emits exactly one location field', () => {
  assert.deepEqual(sessionLocation({ workspaceId: 'ws_1', targetPath: '/x' }), { workspaceId: 'ws_1' })
  assert.deepEqual(sessionLocation({ workspaceId: undefined, targetPath: '/x' }), { cwd: '/x' })
  assert.deepEqual(sessionLocation({ workspaceId: '', targetPath: '/x' }), { cwd: '/x' })
})

test('a registered workspace is used alone, never together with a cwd', async () => {
  const h = harness()
  try {
    // The regression this locks down: passing both fields makes the real
    // controller reject the create outright, so no QQ session can ever start.
    const sessionId = await h.ensureSession('private:U1')
    assert.equal(sessionId, 'sess_1')
    assert.equal(h.requests.length, 1)
    assert.equal(h.requests[0].workspaceId, 'ws_1')
    assert.equal(h.requests[0].cwd, undefined)
  } finally {
    h.cleanup()
  }
})

test('without a workspace registry the request falls back to a plain cwd', async () => {
  const h = harness({ withRegistry: false })
  try {
    await h.ensureSession('private:U1')
    assert.equal(h.requests[0].workspaceId, undefined)
    assert.equal(typeof h.requests[0].cwd, 'string')
    assert.notEqual(h.requests[0].cwd, '')
  } finally {
    h.cleanup()
  }
})

test('a failing registry degrades to a cwd instead of failing the message', async () => {
  const h = harness({ registryFails: true })
  try {
    await h.ensureSession('private:U1')
    assert.equal(h.requests[0].workspaceId, undefined)
    assert.equal(typeof h.requests[0].cwd, 'string')
  } finally {
    h.cleanup()
  }
})

test('a configured workspace path is created and handed to the registry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-ws-'))
  const target = join(dir, 'nested', 'qq')
  const h = harness({}, { workspacePath: target })
  try {
    await h.ensureSession('private:U1')
    assert.ok(existsSync(target), 'the configured directory is created on demand')
    assert.equal(h.requests[0].workspaceId, 'ws_1')
  } finally {
    h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the agent preset is forwarded only when configured', async () => {
  const h = harness({}, { agentPreset: 'qq-chat' })
  try {
    await h.ensureSession('private:U1')
    assert.equal(h.requests[0].agentPreset, 'qq-chat')
  } finally {
    h.cleanup()
  }

  const plain = harness()
  try {
    await plain.ensureSession('private:U2')
    assert.equal(plain.requests[0].agentPreset, undefined)
  } finally {
    plain.cleanup()
  }
})

test('a bound conversation reuses its session without creating another', async () => {
  const h = harness()
  try {
    const first = await h.ensureSession('private:U1')
    const second = await h.ensureSession('private:U1')
    assert.equal(first, second)
    assert.equal(h.requests.length, 1, 'the second message must not mint a new session')
  } finally {
    h.cleanup()
  }
})

test('separate conversations get separate sessions', async () => {
  const h = harness()
  try {
    const a = await h.ensureSession('private:U1')
    const b = await h.ensureSession('group:G1')
    assert.notEqual(a, b)
    assert.equal(h.requests.length, 2)
  } finally {
    h.cleanup()
  }
})

test('a refused create propagates so the caller can tell the user', async () => {
  const h = harness({ createFails: true })
  try {
    await assert.rejects(() => h.ensureSession('private:U1'), /create refused/)
    assert.equal(h.sessions.get('private:U1'), undefined, 'a failed create must not leave a binding')
  } finally {
    h.cleanup()
  }
})
