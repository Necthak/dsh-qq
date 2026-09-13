/**
 * QR pairing: obtain the bot's AppID and AppSecret by scanning, instead of
 * asking the operator to copy them out of the QQ open platform console.
 *
 * This uses Tencent's own connector SDK (`@tencent-connect/qqbot-connector`),
 * the same flow every other third-party agent product on the platform uses. It
 * matters for more than convenience: the secret never passes through a human's
 * clipboard, and the credentials the platform hands back are the ones bound to
 * the bot the user actually picked on the scan page.
 *
 * The SDK renders a QR into a terminal by default. That is useless here — the
 * DSH server usually runs in a minimised console — so this module drives the
 * callback form with console printing off and turns the QR *content* into an
 * image the settings card can display.
 *
 * @module dsh-qq/pairing
 */

import { startQrConnect } from '@tencent-connect/qqbot-connector'
import QRCode from 'qrcode'

/** Pairing lifecycle states. */
export const PAIRING_STATE = {
  idle: 'idle',
  waiting: 'waiting',
  success: 'success',
  failed: 'failed',
}

/**
 * One pairing attempt.
 */
export class PairingSession {
  #source
  #log
  #onCredentials
  #stop = null
  #state = PAIRING_STATE.idle
  #qrContent = ''
  #qrDataUrl = ''
  #error = ''
  #startedAt = 0

  /**
   * @param options - wiring.
   * @param options.source - platform identifier shown on the scan page.
   * @param options.log - diagnostics sink.
   * @param options.onCredentials - called with `{ appId, appSecret }` on success.
   */
  constructor({ source, log, onCredentials }) {
    this.#source = typeof source === 'string' && source !== '' ? source : 'DeepSeek Harness'
    this.#log = log ?? (() => {})
    this.#onCredentials = onCredentials
  }

  /** Current attempt state, safe to serialize to the browser. */
  snapshot() {
    return {
      state: this.#state,
      qrDataUrl: this.#qrDataUrl,
      error: this.#error,
      startedAt: this.#startedAt,
    }
  }

  /**
   * Begin a pairing attempt, replacing any attempt already running.
   *
   * @returns The state immediately after starting.
   */
  start() {
    this.cancel()
    this.#state = PAIRING_STATE.waiting
    this.#error = ''
    this.#qrContent = ''
    this.#qrDataUrl = ''
    this.#startedAt = Date.now()

    this.#log('starting QQ QR pairing; scan the code shown in the DSH settings page with mobile QQ')

    this.#stop = startQrConnect(
      {
        onSuccess: (credentials) => {
          this.#stop = null
          const first = Array.isArray(credentials) ? credentials[0] : undefined
          if (first === undefined || typeof first.appId !== 'string' || first.appId === '') {
            this.#state = PAIRING_STATE.failed
            this.#error = '平台返回的凭据为空'
            this.#log(this.#error)
            return
          }
          // The SDK documents an array because a future version may bind several
          // bots at once; only the first is used today.
          if (Array.isArray(credentials) && credentials.length > 1) {
            this.#log(`platform returned ${credentials.length} bots; binding the first`)
          }
          this.#state = PAIRING_STATE.success
          this.#qrDataUrl = ''
          this.#log(`QQ pairing succeeded for AppID ${first.appId}`)
          try {
            this.#onCredentials({ appId: first.appId, appSecret: String(first.appSecret ?? '') })
          } catch (error) {
            this.#log(`storing paired credentials failed: ${String(error?.message ?? error)}`)
          }
        },
        onFailure: (error) => {
          this.#stop = null
          this.#state = PAIRING_STATE.failed
          this.#error = String(error?.message ?? error)
          this.#log(`QQ pairing failed: ${this.#error}`)
        },
        onQrDisplayed: (url) => {
          this.#qrContent = String(url ?? '')
          this.#renderQr().catch((error) => {
            this.#log(`QR image rendering failed: ${String(error?.message ?? error)}`)
          })
        },
        onQrExpired: () => {
          this.#log('QQ pairing QR expired; the SDK is refreshing it')
        },
      },
      {
        displayQrCodeToConsole: false,
        source: this.#source,
      },
    )

    return this.snapshot()
  }

  /** Stop a running attempt. Safe to call when idle. */
  cancel() {
    const stop = this.#stop
    this.#stop = null
    if (stop !== null) {
      try {
        stop()
      } catch (error) {
        this.#log(`cancelling pairing failed: ${String(error?.message ?? error)}`)
      }
    }
    if (this.#state === PAIRING_STATE.waiting) this.#state = PAIRING_STATE.idle
  }

  /** The raw QR content, exposed for tests and diagnostics. */
  get qrContent() {
    return this.#qrContent
  }

  /**
   * Turn the QR content into a data URL the settings card can render.
   *
   * @returns A promise resolving once the image is ready.
   */
  async #renderQr() {
    if (this.#qrContent === '') return
    const dataUrl = await QRCode.toDataURL(this.#qrContent, { margin: 1, width: 240, errorCorrectionLevel: 'M' })
    // A newer QR may have arrived while this one rendered; keep the latest.
    if (this.#qrContent !== '') this.#qrDataUrl = dataUrl
  }
}
