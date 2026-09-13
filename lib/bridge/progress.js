/**
 * What the running turn is doing, in one line.
 *
 * On a phone the bridge is a black box between "message sent" and "answer
 * arrived": a turn that uses tools runs for minutes, and the operator has no
 * way to tell "working" from "stuck". Steering solved being able to interrupt
 * it; this is about being able to *see* it.
 *
 * The facts come from the session log the bridge already subscribes to, so
 * nothing new is asked of the Host:
 *
 * - `turn/start` opens a turn, `turn/end` closes it;
 * - `step/start` counts the steps inside it;
 * - `tool/call` names what it is doing right now.
 *
 * Counts are per session and per turn, and a turn that this process did not see
 * begin (a plugin reload mid-turn) reports no step count rather than a wrong
 * one — the session controller's `running` status still says it is busy.
 *
 * @module dsh-qq/bridge/progress
 */

/**
 * Minutes and seconds, the unit an operator waiting on a phone thinks in.
 *
 * This is the package's only duration formatter: `/status`, the turn heartbeat
 * and `/usage` all print through it, so "4 分 12 秒" cannot mean two different
 * things depending on which surface produced it.
 *
 * The zero case is the one place the callers genuinely disagree, so it is an
 * option rather than a second implementation: a turn that just started really
 * has run for "0 秒", while a figure a session has not reported yet must print
 * as nothing at all rather than as a zero the operator would read as data.
 *
 * @param ms - milliseconds.
 * @param options - `zero` is what to print for a non-positive figure.
 * @returns A short human duration, or `options.zero`.
 */
export function formatElapsed(ms, { zero = '0 秒' } = {}) {
  if (!Number.isFinite(ms) || ms <= 0) return zero
  // Sub-second figures are named in milliseconds: rounding a first token to
  // "0 秒" reads as missing data instead of as "it was fast".
  if (ms < 1_000) return `${String(Math.round(ms))} 毫秒`
  const total = Math.round(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes === 0) return `${String(seconds)} 秒`
  if (minutes < 60) return `${String(minutes)} 分 ${String(seconds)} 秒`
  return `${String(Math.floor(minutes / 60))} 小时 ${String(minutes % 60)} 分`
}

/**
 * Track the live shape of every bound session's turn.
 */
export class TurnProgress {
  #bySession = new Map()

  /**
   * Fold one session event into the picture.
   *
   * @param sessionId - the session the event belongs to.
   * @param event - the raw `session/event` payload.
   */
  observe(sessionId, event) {
    const type = event?.type
    const data = event?.data ?? {}
    if (type === 'turn/start') {
      this.#bySession.set(sessionId, {
        running: true,
        startedAt: Date.now(),
        steps: 0,
        lastTool: '',
        turn: Number.isSafeInteger(data.turn) ? data.turn : null,
      })
      return
    }
    const current = this.#bySession.get(sessionId)
    if (current === undefined) return
    if (type === 'step/start') {
      // Step numbers restart every turn, so the count is the highest step
      // entered rather than an increment: a retried step must not read as two.
      const step = Number.isSafeInteger(data.step) ? data.step + 1 : current.steps + 1
      current.steps = Math.max(current.steps, step)
      return
    }
    if (type === 'tool/call') {
      current.lastTool = typeof data.name === 'string' ? data.name : current.lastTool
      return
    }
    if (type === 'turn/end') {
      current.running = false
      current.lastTool = ''
    }
  }

  /**
   * Read the current picture for one session.
   *
   * @param sessionId - the DSH session id.
   * @returns The snapshot, or null when this process never saw the session work.
   */
  snapshot(sessionId) {
    const current = this.#bySession.get(sessionId)
    if (current === undefined) return null
    return {
      running: current.running,
      steps: current.steps,
      lastTool: current.lastTool,
      elapsedMs: current.running ? Date.now() - current.startedAt : 0,
    }
  }

  /**
   * Describe one session's turn for a human.
   *
   * @param sessionId - the DSH session id.
   * @param busy - whether the Host says the agent is running, when it can say.
   * @returns A single line, never empty.
   */
  describe(sessionId, busy) {
    const snapshot = this.snapshot(sessionId)
    if (snapshot === null || !snapshot.running) {
      // The Host may still report a running agent this process never watched
      // start — after a plugin reload, say. Saying so beats claiming "空闲".
      if (busy === true) return '运行中（本进程接管前的步数未知）'
      return '空闲'
    }
    const parts = [`已运行 ${formatElapsed(snapshot.elapsedMs)}`]
    if (snapshot.steps > 0) parts.push(`第 ${String(snapshot.steps)} 步`)
    if (snapshot.lastTool !== '') parts.push(`最近工具 ${snapshot.lastTool}`)
    return parts.join(' · ')
  }

  /** Drop a session's history, e.g. when its conversation is reset. */
  forget(sessionId) {
    this.#bySession.delete(sessionId)
  }
}

/**
 * Whether a running turn is due for a progress line.
 *
 * Kept as a pure decision so the pacing rule — never faster than the configured
 * interval, and never before the turn has actually run that long — is pinned by
 * a test instead of by a timer nobody can reproduce.
 *
 * @param options - the decision inputs.
 * @param options.snapshot - the tracked turn, or null.
 * @param options.lastSentAt - when this conversation last heard a heartbeat, 0 if never.
 * @param options.now - the current clock.
 * @param options.intervalMs - the configured interval; 0 disables heartbeats.
 * @returns The line to send, or null when this tick owes nothing.
 */
export function dueHeartbeat({ snapshot, lastSentAt = 0, now = Date.now(), intervalMs = 0 }) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) return null
  if (snapshot === null || snapshot === undefined || snapshot.running !== true) return null
  if (snapshot.elapsedMs < intervalMs) return null
  if (lastSentAt > 0 && now - lastSentAt < intervalMs) return null
  return heartbeatLine(snapshot)
}

/**
 * Compose one progress line.
 *
 * @param snapshot - a running turn's snapshot.
 * @returns The message body.
 */
export function heartbeatLine(snapshot) {
  const parts = [`⏳ 仍在运行：${formatElapsed(snapshot.elapsedMs)}`]
  if (snapshot.steps > 0) parts.push(`第 ${String(snapshot.steps)} 步`)
  if (typeof snapshot.lastTool === 'string' && snapshot.lastTool !== '') parts.push(`最近工具 ${snapshot.lastTool}`)
  return parts.join(' · ')
}
