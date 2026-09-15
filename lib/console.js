/**
 * Local console routes for the QQ bridge.
 *
 * These are registered on DSH's own web server rather than a private port. That
 * choice is deliberate: DSH already authenticates its surface with a signed,
 * authority-bound cookie behind a Host/Origin fence, so reusing it means the
 * bridge introduces no second credential to leak, rotate, or forget. A separate
 * console port with its own token — as the standalone reference bridge used —
 * would be a second, weaker front door to the same machine.
 *
 * Only `enabled`, the allow list, the owner, and pacing are writable here. The
 * AppSecret is never returned: the response carries a boolean saying whether one
 * is set, and a write only replaces it when a non-empty value arrives, so a
 * round-trip of the redacted document cannot erase it.
 *
 * @module dsh-qq/console
 */

/** Fields the console will accept from a client. */
const WRITABLE_BOOLEAN = ['enabled', 'allowAllWhenEmpty', 'allowAgentSend', 'forwardApprovals', 'forwardQuestions']
const WRITABLE_NUMBER = ['approvalTimeoutMs', 'questionTimeoutMs', 'maxBytes', 'longAnswerChunks', 'intervalMs', 'progressIntervalMs', 'lowBalanceThreshold', 'planAlertPercent']
const WRITABLE_STRING = ['mode', 'ownerOpenId', 'workspacePath', 'agentPreset', 'busyDelivery', 'restartCommand', 'markdownMode']

/**
 * Numeric settings whose zero value means "off".
 *
 * Without this list the card silently refuses the value the settings table
 * documents as the way to switch a warning off, so an operator who typed `0`
 * would be told the save succeeded while the old value stayed in place. Zero
 * stays invalid for the others, where it is not a disable but a broken value: a
 * byte budget of zero bytes, or a timeout that expires before it is armed.
 */
const ZERO_DISABLES = new Set(['progressIntervalMs', 'lowBalanceThreshold', 'longAnswerChunks', 'planAlertPercent'])

/**
 * Register the console routes.
 *
 * @param options - wiring.
 * @param options.ctx - the plugin context.
 * @param options.config - live settings accessor.
 * @param options.scope - the registered settings scope, or null.
 * @param options.sessions - the conversation table.
 * @param options.pending - the pending-interaction registry.
 * @param options.status - live bridge state.
 * @param options.pairing - the QR pairing session, when available.
 * @param options.log - diagnostics sink.
 * @returns A disposer removing every route.
 */
export function registerConsole({ ctx, config, scope, sessions, pending, status, pairing, log }) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined || typeof webServer.register !== 'function') {
    log('web server is unavailable; the bridge console will not be served')
    return () => {}
  }

  /**
   * Refuse a request that DSH's own trust fence rejects.
   *
   * `webServer.register` only files a route in a table: it applies neither the
   * loopback/trusted-host check nor the browser-session check that `/api`
   * gets. Without this guard any page the operator visits can reach these
   * routes — a DNS-rebinding host resolves to 127.0.0.1, the browser sends the
   * attacker's Host, and `/dsh-qq/config` happily rewrites the allow list. The
   * fence is the same one the first-party plugins call, so a real browser
   * session is unaffected.
   *
   * @param req - the HTTP request.
   * @param res - the HTTP response.
   * @returns Whether the request was refused (and answered).
   */
  function refuseUntrusted(req, res) {
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
    if (connection === undefined || typeof connection.requestRejection !== 'function') {
      // A composition without the connection plugin cannot be asked; refusing
      // everything would break the settings card, so this stays permissive and
      // the plugin self-check reports the missing fence.
      return false
    }
    const rejection = connection.requestRejection(req)
    if (rejection === undefined) return false
    respondText(res, rejection, rejection === 401 ? 'unauthorized' : 'forbidden')
    return true
  }

  const disposers = []

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-qq/state',
    handler: (req, res) => {
      if (refuseUntrusted(req, res)) return
      const settings = config() ?? {}
      respondJson(res, 200, {
        ...status(),
        enabled: settings.enabled === true,
        mode: settings.mode,
        hasCredentials: typeof settings.appId === 'string' && settings.appId !== ''
          && typeof settings.appSecret === 'string' && settings.appSecret !== '',
        conversations: sessions.entries(),
        pending: pending.entries(),
      })
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-qq/config',
    handler: async (req, res) => {
      if (refuseUntrusted(req, res)) return
      if (req.method === 'GET') {
        const settings = config() ?? {}
        respondJson(res, 200, redact(settings))
        return
      }
      if (req.method !== 'POST') {
        respondJson(res, 405, { error: 'method not allowed' })
        return
      }
      if (scope === null) {
        respondJson(res, 503, { error: 'settings namespace is unavailable' })
        return
      }

      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        respondJson(res, 400, { error: String(error?.message ?? error) })
        return
      }

      const patch = sanitizePatch(body)
      if (Object.keys(patch).length === 0) {
        respondJson(res, 400, { error: 'no writable field in the request' })
        return
      }

      try {
        await scope.update(patch)
      } catch (error) {
        respondJson(res, 400, { error: String(error?.message ?? error) })
        return
      }
      log(`console updated ${Object.keys(patch).join(', ')}`)
      respondJson(res, 200, redact(config() ?? {}))
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-qq/pair',
    handler: (req, res) => {
      if (refuseUntrusted(req, res)) return
      if (pairing === undefined || pairing === null) {
        respondJson(res, 503, { error: '扫码绑定不可用：connector SDK 未加载' })
        return
      }
      if (req.method === 'GET') {
        respondJson(res, 200, pairing.snapshot())
        return
      }
      if (req.method !== 'POST') {
        respondJson(res, 405, { error: 'method not allowed' })
        return
      }
      // The route is an exact path, so the action rides the query string.
      if (readAction(req) === 'cancel') {
        pairing.cancel()
        respondJson(res, 200, pairing.snapshot())
        return
      }
      respondJson(res, 200, pairing.start())
    },
  }))

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (error) {
        log(`console route disposer failed: ${String(error?.message ?? error)}`)
      }
    }
  }
}

/**
 * Read the `action` query parameter from a request.
 *
 * @param req - the Node request.
 * @returns The action name, or an empty string.
 */
function readAction(req) {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    return url.searchParams.get('action') ?? ''
  } catch {
    return ''
  }
}

/**
 * Strip the secret before a settings document leaves the process.
 *
 * @param settings - the resolved settings.
 * @returns A copy with `appSecret` replaced by a presence flag.
 */
function redact(settings) {
  const { appSecret, ...rest } = settings
  return { ...rest, appSecretSet: typeof appSecret === 'string' && appSecret !== '' }
}

/**
 * Keep only writable, well-typed fields from a client payload.
 *
 * @param body - the parsed request body.
 * @returns A patch safe to hand to the settings scope.
 */
function sanitizePatch(body) {
  const patch = {}
  if (body === null || typeof body !== 'object') return patch

  for (const key of WRITABLE_BOOLEAN) {
    if (typeof body[key] === 'boolean') patch[key] = body[key]
  }
  for (const key of WRITABLE_NUMBER) {
    const value = body[key]
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) continue
    if (value > 0 || (value === 0 && ZERO_DISABLES.has(key))) patch[key] = value
  }
  for (const key of WRITABLE_STRING) {
    if (typeof body[key] === 'string') patch[key] = body[key]
  }
  for (const key of ['allow', 'deny']) {
    if (Array.isArray(body[key])) {
      patch[key] = body[key].filter((entry) => typeof entry === 'string' && entry !== '')
    }
  }
  // Credentials are writable but never readable: an empty value means "leave it
  // alone", so echoing the redacted document back cannot clear the secret.
  if (typeof body.appId === 'string') patch.appId = body.appId
  if (typeof body.appSecret === 'string' && body.appSecret !== '') patch.appSecret = body.appSecret
  return patch
}

/**
 * Send a JSON response.
 *
 * @param res - the Node response.
 * @param status - HTTP status.
 * @param payload - the body.
 */
/**
 * Answer with a bare text body.
 *
 * The fence answers are the two words DSH's own routes use ("unauthorized",
 * "forbidden"); matching them keeps the two surfaces indistinguishable to a
 * caller probing both.
 *
 * @param res - the HTTP response.
 * @param status - HTTP status.
 * @param body - text to write.
 */
function respondText(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function respondJson(res, status, payload) {
  try {
    const text = JSON.stringify(payload)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(text)
  } catch (error) {
    try {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(String(error?.message ?? error))
    } catch {
      // The response is already gone.
    }
  }
}

/**
 * Read and parse a JSON request body with a size ceiling.
 *
 * @param req - the Node request.
 * @returns The parsed body.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 256 * 1024) {
        reject(new Error('request body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(new Error(`request body is not JSON: ${String(error?.message ?? error)}`))
      }
    })
    req.on('error', (error) => { reject(error) })
  })
}
