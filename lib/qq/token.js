/**
 * QQ Bot OpenAPI access-token provider.
 *
 * The official platform issues one bearer credential per bot: `POST
 * /app/getAppAccessToken` with `{ appId, clientSecret }` answers
 * `{ access_token, expires_in }`, and every OpenAPI call carries it as
 * `Authorization: QQBot <access_token>`.
 *
 * Two documented behaviours shape this class:
 *
 * - Re-requesting inside the validity window returns the SAME token, so a
 *   refresh is cheap but must not be issued per call.
 * - Inside the last 60 seconds of the window the platform issues a NEW token
 *   while the old one keeps working for those 60 seconds. That overlap is what
 *   makes a proactive refresh safe: callers never see a gap.
 *
 * `get()` therefore refreshes when the remaining lifetime drops to
 * {@link REFRESH_MARGIN_MS} (60s, the documented overlap) and coalesces
 * concurrent refreshes into one request.
 *
 * @module dsh-qq/qq/token
 */

/**
 * How long the token request may take before it is abandoned.
 *
 * Every other call needs a token, so a request that never settles blocks the
 * whole channel: no send, no retry, and nothing in the log to say why.
 */
export const TOKEN_TIMEOUT_MS = 30 * 1000

/** Official token endpoint. */
export const TOKEN_URL = 'https://api.bot.qq.com/app/getAppAccessToken'

/**
 * The documented overlap window: inside this margin the platform serves a new
 * token while the previous one is still accepted, so refreshing here cannot
 * strand an in-flight request.
 */
export const REFRESH_MARGIN_MS = 60_000

/** Fallback lifetime when the platform omits or mangles `expires_in`. */
const DEFAULT_LIFETIME_MS = 7_200_000

/**
 * Normalize the platform's `expires_in`, which is documented as a number but
 * observed as a numeric string.
 *
 * @param value - the raw field.
 * @returns Lifetime in milliseconds, or the documented default when unusable.
 */
export function parseExpiresIn(value) {
  const seconds = typeof value === 'string' ? Number(value) : value
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return DEFAULT_LIFETIME_MS
  return seconds * 1000
}

/** Raised when the platform refuses a token request. */
export class QqTokenError extends Error {
  /**
   * @param message - human-readable failure summary.
   * @param options - optional cause and the platform's own error code.
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'QqTokenError'
    /** Platform error code when the response carried one. */
    this.code = options.code
  }
}

/**
 * Caches one bot's access token and refreshes it ahead of expiry.
 */
export class QqTokenProvider {
  #appId
  #clientSecret
  #fetch
  #now
  #log
  #token = null
  #expiresAt = 0
  #pending = null

  /**
   * @param options - app credentials, transport, and clock.
   * @param options.appId - the bot's AppID.
   * @param options.clientSecret - the bot's AppSecret.
   * @param options.fetchImpl - fetch implementation; defaults to the global.
   * @param options.now - clock returning epoch milliseconds.
   * @param options.log - sink for refresh diagnostics.
   */
  constructor({ appId, clientSecret, fetchImpl, now, log }) {
    this.#appId = appId
    this.#clientSecret = clientSecret
    this.#fetch = fetchImpl ?? globalThis.fetch
    this.#now = now ?? Date.now
    this.#log = log ?? (() => {})
  }

  /** Whether both credentials are present. */
  get configured() {
    return typeof this.#appId === 'string' && this.#appId !== ''
      && typeof this.#clientSecret === 'string' && this.#clientSecret !== ''
  }

  /**
   * Return a usable access token, refreshing when the cached one is absent,
   * expired, or within the documented refresh margin.
   *
   * @returns The token string.
   * @throws {QqTokenError} when credentials are missing or the platform refuses.
   */
  async get() {
    if (!this.configured) throw new QqTokenError('QQ AppID/AppSecret are not configured')
    if (this.#token !== null && this.#now() < this.#expiresAt - REFRESH_MARGIN_MS) return this.#token
    if (this.#pending !== null) return this.#pending
    this.#pending = this.#refresh().finally(() => { this.#pending = null })
    return this.#pending
  }

  /**
   * Drop the cached token so the next {@link get} refreshes. Called when an
   * OpenAPI call reports an authentication failure.
   */
  invalidate() {
    this.#token = null
    this.#expiresAt = 0
  }

  /**
   * Ask the platform for a token and record its lifetime.
   *
   * @returns The freshly issued token.
   * @throws {QqTokenError} on transport failure or a non-zero platform code.
   */
  async #refresh() {
    let response
    try {
      response = await this.#fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: this.#appId, clientSecret: this.#clientSecret }),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      })
    } catch (error) {
      throw new QqTokenError(`QQ access-token request failed: ${String(error?.message ?? error)}`, { cause: error })
    }

    let body = null
    try {
      body = await response.json()
    } catch (error) {
      throw new QqTokenError(`QQ access-token response was not JSON (HTTP ${response.status})`, { cause: error })
    }

    // The platform answers 200 with a numeric `code` on refusal, so the body is
    // authoritative and the HTTP status alone is not.
    const code = body?.code
    const token = body?.access_token
    if (typeof token !== 'string' || token === '') {
      const detail = body?.message ?? body?.msg ?? 'no access_token in response'
      throw new QqTokenError(`QQ refused the access token: ${String(detail)}`, { code })
    }

    const lifetime = parseExpiresIn(body?.expires_in)
    this.#token = token
    this.#expiresAt = this.#now() + lifetime
    this.#log(`access token refreshed, valid ${Math.round(lifetime / 1000)}s`)
    return token
  }
}
