/**
 * QQ Bot WebSocket gateway client: the event half of the official channel.
 *
 * The documented handshake is:
 *
 * 1. Resolve the `wss://` URL through the OpenAPI gateway endpoint.
 * 2. Connect and wait for `Op 10 Hello`, which carries `heartbeat_interval`.
 * 3. Send `Op 2 Identify` with `token: "QQBot <access_token>"`, the intent
 *    mask, and a shard.
 * 4. A `READY` dispatch answers with `session_id`; from then on the platform
 *    pushes dispatches and this client must send `Op 1 Heartbeat` on the
 *    advertised interval.
 *
 * A dropped connection is normally recoverable without re-identifying: `Op 6
 * Resume` replays the events missed since `seq`. `Op 9 Invalid Session` is the
 * opposite — the session is gone and only a fresh `Identify` recovers, so the
 * stored session is cleared first.
 *
 * The bot is "online" only while this socket is up, which the platform requires
 * before it will deliver messages, so reconnection is aggressive but backed off.
 *
 * @module dsh-qq/qq/gateway
 */

import { QqApiError } from './api.js'

/** Opcodes from the official gateway protocol. */
export const OP = {
  /** Server push of an event; `t` names it and `s` numbers it. */
  dispatch: 0,
  /** Client heartbeat; `d` is the newest seen `s`, or null before the first. */
  heartbeat: 1,
  /** Client authentication for a new session. */
  identify: 2,
  /** Client request to replay a previous session. */
  resume: 6,
  /** Server request that the client drop the socket and reconnect. */
  reconnect: 7,
  /** Server notice that the session is unusable and must be re-identified. */
  invalidSession: 9,
  /** Server greeting carrying `heartbeat_interval`. */
  hello: 10,
  /** Server acknowledgement of a heartbeat. */
  heartbeatAck: 11,
}

/**
 * The intent bit covering private (C2C) messages and group @-mentions:
 * `GROUP_AND_C2C_EVENT (1 << 25)`.
 */
export const INTENT_GROUP_AND_C2C = 1 << 25

/**
 * The intent bit covering button and menu callbacks: `INTERACTION (1 << 26)`.
 *
 * Required for the inline keyboards this bridge sends — without it the platform
 * accepts the keyboard on the way out and never delivers the click back, which
 * looks exactly like a broken button.
 */
export const INTENT_INTERACTION = 1 << 26

/** Every intent this bridge subscribes to. */
export const DEFAULT_INTENTS = INTENT_GROUP_AND_C2C | INTENT_INTERACTION

/** Delay before re-identifying after `Op 9 Invalid Session`, per the protocol. */
const INVALID_SESSION_DELAY_MS = 2_000

/** Reconnect backoff bounds. */
const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 60_000

/** Lifecycle states a caller may observe. */
export const GATEWAY_STATE = {
  stopped: 'stopped',
  connecting: 'connecting',
  online: 'online',
  reconnecting: 'reconnecting',
}

/**
 * One bot's gateway connection, with heartbeat, resume, and backoff.
 */
export class QqGateway {
  #tokens
  #api
  #intents
  #log
  #onEvent
  #onState
  #ws = null
  #state = GATEWAY_STATE.stopped
  #sessionId = null
  #lastSeq = null
  #heartbeatMs = 45_000
  #heartbeatTimer = null
  #ackTimer = null
  #reconnectTimer = null
  #attempts = 0
  #stopped = true

  /**
   * @param options - dependencies and callbacks.
   * @param options.tokens - the bot's token provider.
   * @param options.api - the OpenAPI client, used to resolve the gateway URL.
   * @param options.intents - intent mask; defaults to {@link INTENT_GROUP_AND_C2C}.
   * @param options.log - sink for lifecycle diagnostics.
   * @param options.onEvent - called with `(eventName, data, envelopeId)` for
   *   every dispatch; `envelopeId` is empty when the frame carries none.
   * @param options.onState - called with the new {@link GATEWAY_STATE} on change.
   */
  constructor({ tokens, api, intents, log, onEvent, onState }) {
    this.#tokens = tokens
    this.#api = api
    this.#intents = intents ?? DEFAULT_INTENTS
    this.#log = log ?? (() => {})
    this.#onEvent = onEvent ?? (() => {})
    this.#onState = onState ?? (() => {})
  }

  /** Current lifecycle state. */
  get state() {
    return this.#state
  }

  /** Whether a live session is established. */
  get online() {
    return this.#state === GATEWAY_STATE.online
  }

  /**
   * Begin connecting and keep the connection alive until {@link stop}.
   *
   * The connect promise is RETURNED rather than dropped: `#connect` handles its
   * own failures, but a caller that wants to notice an unexpected one cannot do
   * it from a promise it never received. An earlier `start()` returned nothing,
   * so the caller's `.catch` was attached to `undefined` and silently useless.
   *
   * @returns A promise resolving when this connect attempt has been set up.
   */
  start() {
    if (!this.#stopped) return Promise.resolve()
    this.#stopped = false
    this.#attempts = 0
    return this.#connect()
  }

  /**
   * Close the socket, cancel every timer, and stop reconnecting.
   *
   * @returns A promise resolving once the socket is closed.
   */
  async stop() {
    this.#stopped = true
    this.#clearTimers()
    this.#setState(GATEWAY_STATE.stopped)
    const ws = this.#ws
    this.#ws = null
    if (ws === null) return
    try {
      ws.close(1000, 'bridge stopping')
    } catch {
      // A socket already torn down needs no further action.
    }
  }

  /**
   * Publish a state change to the caller.
   *
   * @param state - the new state.
   */
  #setState(state) {
    if (this.#state === state) return
    this.#state = state
    try {
      this.#onState(state)
    } catch (error) {
      this.#log(`gateway state listener failed: ${String(error?.message ?? error)}`)
    }
  }

  /** Cancel every scheduled timer. */
  #clearTimers() {
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer)
      this.#heartbeatTimer = null
    }
    if (this.#ackTimer !== null) {
      clearTimeout(this.#ackTimer)
      this.#ackTimer = null
    }
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
  }

  /**
   * Resolve the gateway URL and open one socket.
   *
   * A failure here is a normal outcome of a flaky network or a bad token, so it
   * schedules a retry rather than throwing at the caller.
   */
  async #connect() {
    if (this.#stopped) return
    this.#setState(this.#attempts === 0 ? GATEWAY_STATE.connecting : GATEWAY_STATE.reconnecting)

    let url
    try {
      url = await this.#api.getGateway()
    } catch (error) {
      const detail = error instanceof QqApiError ? error.message : String(error?.message ?? error)
      this.#log(`gateway discovery failed: ${detail}`)
      this.#scheduleReconnect()
      return
    }
    if (this.#stopped) return

    let ws
    try {
      ws = new WebSocket(url)
    } catch (error) {
      this.#log(`gateway socket could not be created: ${String(error?.message ?? error)}`)
      this.#scheduleReconnect()
      return
    }

    this.#ws = ws

    ws.addEventListener('open', () => {
      this.#log('gateway socket open; awaiting Hello')
    })

    ws.addEventListener('message', (message) => {
      this.#onMessage(message.data)
    })

    ws.addEventListener('error', (event) => {
      const detail = event?.message ?? event?.error?.message ?? 'socket error'
      this.#log(`gateway socket error: ${String(detail)}`)
    })

    ws.addEventListener('close', (event) => {
      if (this.#ws === ws) this.#ws = null
      this.#clearTimers()
      if (this.#stopped) return
      this.#log(`gateway socket closed (code ${String(event?.code)}); reconnecting`)
      this.#scheduleReconnect()
    })
  }

  /**
   * Handle one inbound frame.
   *
   * @param raw - the frame payload as delivered by the socket.
   */
  #onMessage(raw) {
    let frame
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    } catch {
      this.#log('gateway frame was not JSON; ignored')
      return
    }
    const op = frame?.op

    if (op === OP.hello) {
      const interval = frame?.d?.heartbeat_interval
      if (typeof interval === 'number' && interval > 0) this.#heartbeatMs = interval
      this.#authenticate()
      return
    }

    if (op === OP.dispatch) {
      const seq = frame?.s
      if (typeof seq === 'number') this.#lastSeq = seq
      const name = frame?.t
      if (name === 'READY' || name === 'RESUMED') {
        const sessionId = frame?.d?.session_id
        if (typeof sessionId === 'string' && sessionId !== '') this.#sessionId = sessionId
        this.#attempts = 0
        this.#setState(GATEWAY_STATE.online)
        const username = frame?.d?.user?.username
        this.#log(name === 'READY'
          ? `gateway online as ${String(username ?? 'bot')}`
          : 'gateway session resumed')
      }
      if (typeof name === 'string') {
        try {
          // The envelope id travels with the payload: the platform's passive
          // "event_id" target is documented as the id of the OUTERMOST event,
          // while `d.id` is the payload's own id (a click's interaction id).
          // They are different values and only one of them can be replied to.
          this.#onEvent(name, frame?.d, typeof frame?.id === 'string' ? frame.id : '')
        } catch (error) {
          this.#log(`event handler failed for ${name}: ${String(error?.message ?? error)}`)
        }
      }
      return
    }

    if (op === OP.heartbeatAck) {
      if (this.#ackTimer !== null) {
        clearTimeout(this.#ackTimer)
        this.#ackTimer = null
      }
      return
    }

    if (op === OP.reconnect) {
      this.#log('gateway asked for a reconnect')
      this.#dropSocket()
      this.#scheduleReconnect()
      return
    }

    if (op === OP.invalidSession) {
      this.#log('gateway session is invalid; re-identifying')
      this.#sessionId = null
      this.#lastSeq = null
      this.#dropSocket()
      this.#reconnectTimer = setTimeout(() => {
        this.#reconnectTimer = null
        this.#connect()
      }, INVALID_SESSION_DELAY_MS)
    }
  }

  /**
   * Send `Identify` for a fresh session, or `Resume` when a session can be
   * replayed. Resume is preferred because it recovers missed dispatches.
   */
  async #authenticate() {
    let token
    try {
      token = await this.#tokens.get()
    } catch (error) {
      this.#log(`gateway authentication could not obtain a token: ${String(error?.message ?? error)}`)
      this.#dropSocket()
      this.#scheduleReconnect()
      return
    }
    if (this.#stopped || this.#ws === null) return

    if (this.#sessionId !== null && this.#lastSeq !== null) {
      this.#send({
        op: OP.resume,
        d: { token: `QQBot ${token}`, session_id: this.#sessionId, seq: this.#lastSeq },
      })
    } else {
      this.#send({
        op: OP.identify,
        d: {
          token: `QQBot ${token}`,
          intents: this.#intents,
          shard: [0, 1],
          properties: {},
        },
      })
    }
    this.#startHeartbeat()
  }

  /** Begin the heartbeat loop advertised by `Hello`. */
  #startHeartbeat() {
    if (this.#heartbeatTimer !== null) clearInterval(this.#heartbeatTimer)
    this.#heartbeatTimer = setInterval(() => {
      // A missing acknowledgement for the previous beat means the socket is a
      // zombie: the peer is gone but the close event never arrived.
      if (this.#ackTimer !== null) {
        this.#log('gateway heartbeat was not acknowledged; treating the socket as dead')
        this.#dropSocket()
        this.#scheduleReconnect()
        return
      }
      this.#send({ op: OP.heartbeat, d: this.#lastSeq })
      this.#ackTimer = setTimeout(() => {
        this.#ackTimer = null
      }, this.#heartbeatMs)
    }, this.#heartbeatMs)
  }

  /**
   * Serialize and send one frame.
   *
   * @param frame - the frame object.
   */
  #send(frame) {
    const ws = this.#ws
    if (ws === null) return
    try {
      ws.send(JSON.stringify(frame))
    } catch (error) {
      this.#log(`gateway send failed: ${String(error?.message ?? error)}`)
    }
  }

  /** Close the current socket without triggering the reconnect path twice. */
  #dropSocket() {
    this.#clearTimers()
    const ws = this.#ws
    this.#ws = null
    if (ws === null) return
    try {
      ws.close()
    } catch {
      // Already closed.
    }
  }

  /** Schedule the next connection attempt with exponential backoff. */
  #scheduleReconnect() {
    if (this.#stopped || this.#reconnectTimer !== null) return
    this.#setState(GATEWAY_STATE.reconnecting)
    const delay = Math.min(BACKOFF_MIN_MS * 2 ** this.#attempts, BACKOFF_MAX_MS)
    this.#attempts += 1
    this.#log(`reconnecting to the gateway in ${delay}ms`)
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      this.#connect()
    }, delay)
  }
}
