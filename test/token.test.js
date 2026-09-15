import { test } from 'node:test'

/**
 * Hold the event loop open while a test waits on a deadline.
 *
 * `AbortSignal.timeout` uses an unref'd timer, so on its own it does not keep
 * the process alive. A CI matrix job runs one file per process, and on Node 22
 * the process exited before the deadline fired, so the runner reported the test
 * and every test after it in that file as cancelled. Nothing had failed; the run
 * was simply over. A referenced timer removes the dependence on whatever else
 * happens to be running.
 *
 * @param ms - how long to hold it, comfortably longer than the deadline.
 * @returns A function that releases the loop.
 */
function holdLoop(ms = 2_000) {
  const handle = setTimeout(() => {}, ms)
  return () => clearTimeout(handle)
}

import assert from 'node:assert/strict'

import { QqTokenProvider, QqTokenError, parseExpiresIn, REFRESH_MARGIN_MS } from '../lib/qq/token.js'

/** Build a fetch stub that answers the token endpoint with a scripted sequence. */
function stubFetch(responses) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    const next = responses.shift()
    if (next === undefined) throw new Error('unexpected extra token request')
    if (next.throw !== undefined) throw next.throw
    return {
      status: next.status ?? 200,
      json: async () => next.body,
    }
  }
  impl.calls = calls
  return impl
}

test('parseExpiresIn accepts the numeric string the platform sends', () => {
  assert.equal(parseExpiresIn('7200'), 7_200_000)
  assert.equal(parseExpiresIn(7200), 7_200_000)
})

test('parseExpiresIn falls back on unusable values', () => {
  assert.equal(parseExpiresIn(undefined), 7_200_000)
  assert.equal(parseExpiresIn('not-a-number'), 7_200_000)
  assert.equal(parseExpiresIn(0), 7_200_000)
  assert.equal(parseExpiresIn(-5), 7_200_000)
})

test('get() caches the token while it is comfortably valid', async () => {
  let now = 1_000_000
  const fetchImpl = stubFetch([{ body: { access_token: 'T1', expires_in: '7200' } }])
  const tokens = new QqTokenProvider({
    appId: 'app',
    clientSecret: 'secret',
    fetchImpl,
    now: () => now,
  })

  assert.equal(await tokens.get(), 'T1')
  now += 3_600_000
  assert.equal(await tokens.get(), 'T1')
  assert.equal(fetchImpl.calls.length, 1, 'a still-valid token must not be re-requested')
})

test('get() refreshes inside the documented 60-second overlap', async () => {
  let now = 1_000_000
  const fetchImpl = stubFetch([
    { body: { access_token: 'T1', expires_in: '7200' } },
    { body: { access_token: 'T2', expires_in: '7200' } },
  ])
  const tokens = new QqTokenProvider({ appId: 'a', clientSecret: 's', fetchImpl, now: () => now })

  assert.equal(await tokens.get(), 'T1')
  // Land just inside the margin: the platform still honours T1, so refreshing
  // here cannot strand an in-flight request.
  now += 7_200_000 - REFRESH_MARGIN_MS + 1
  assert.equal(await tokens.get(), 'T2')
  assert.equal(fetchImpl.calls.length, 2)
})

test('concurrent get() calls coalesce into one refresh', async () => {
  let resolveResponse
  const gate = new Promise((resolve) => { resolveResponse = resolve })
  const fetchImpl = async () => {
    await gate
    return { status: 200, json: async () => ({ access_token: 'T1', expires_in: '7200' }) }
  }
  const tokens = new QqTokenProvider({ appId: 'a', clientSecret: 's', fetchImpl, now: () => 0 })

  const all = Promise.all([tokens.get(), tokens.get(), tokens.get()])
  resolveResponse()
  assert.deepEqual(await all, ['T1', 'T1', 'T1'])
})

test('a refusal raises QqTokenError carrying the platform code', async () => {
  const fetchImpl = stubFetch([{ body: { code: 100016, message: 'invalid appid or secret' } }])
  const tokens = new QqTokenProvider({ appId: 'a', clientSecret: 's', fetchImpl, now: () => 0 })

  await assert.rejects(
    () => tokens.get(),
    (error) => {
      assert.ok(error instanceof QqTokenError)
      assert.equal(error.code, 100016)
      assert.match(error.message, /invalid appid or secret/)
      return true
    },
  )
})

test('invalidate() forces the next get() to refresh', async () => {
  const fetchImpl = stubFetch([
    { body: { access_token: 'T1', expires_in: '7200' } },
    { body: { access_token: 'T2', expires_in: '7200' } },
  ])
  const tokens = new QqTokenProvider({ appId: 'a', clientSecret: 's', fetchImpl, now: () => 0 })

  assert.equal(await tokens.get(), 'T1')
  tokens.invalidate()
  assert.equal(await tokens.get(), 'T2')
})

test('missing credentials fail before any request is made', async () => {
  const fetchImpl = stubFetch([])
  const tokens = new QqTokenProvider({ appId: '', clientSecret: '', fetchImpl, now: () => 0 })

  assert.equal(tokens.configured, false)
  await assert.rejects(() => tokens.get(), QqTokenError)
  assert.equal(fetchImpl.calls.length, 0)
})

test('a stalled token request is abandoned rather than blocking everything', async () => {
  // Nothing can be sent without a token, so a request that never settles stops
  // the whole channel — no send, no retry, and no log line explaining it.
  const fetchImpl = (url, options = {}) => new Promise((resolve, reject) => {
    const signal = options.signal
    if (signal === undefined) return
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
  const tokens = new QqTokenProvider({ appId: '1', clientSecret: 's', fetchImpl, log: () => {} })
  const release = holdLoop()
  try {
    await assert.rejects(() => tokens.get(), /failed|abort/i)
  } finally {
    release()
  }
})
