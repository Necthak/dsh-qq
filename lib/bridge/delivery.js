/**
 * How one QQ message enters the DSH session it belongs to.
 *
 * DSH accepts two delivery modes on `sessionController.prompt`, and the
 * difference is exactly the one that matters on a phone:
 *
 * - `queue` calls `agent.followup()`: the message lands in the `next-turn`
 *   inbox and is read only after the running turn has finished. A long agentic
 *   turn — `max` reasoning plus a dozen tool calls — runs for minutes, so an
 *   operator watching it go wrong has no way to say so until it is over.
 * - `steer` calls `agent.steer()`: the message lands in the `next-step` inbox
 *   and is read at the next step boundary, inside the turn already running.
 *
 * Steering is not an interruption. It does not abort the step in flight, so a
 * message sent while a five-minute tool call is running is read when that call
 * returns; `/stop` is what aborts, and the Session Controller cancels with
 * `keepInbox`, so steered work survives it and resumes afterwards. Steering
 * also does not end the turn: `agent/turn-stopping` only closes a turn whose
 * `next-step` inbox is empty, so inserted input keeps the current turn open.
 *
 * The deployment default lives in settings; a `/steer` or `/queue` prefix
 * overrides it for one message without moving the default.
 *
 * @module dsh-qq/bridge/delivery
 */

/** The `queue` delivery mode: `agent.followup()`, read after the current turn. */
export const DELIVERY_QUEUE = 'queue'

/** The `steer` delivery mode: `agent.steer()`, read inside the current turn. */
export const DELIVERY_STEER = 'steer'

/**
 * The default when settings say nothing.
 *
 * Insertion is what makes the bridge usable while a turn is running, and it is
 * the friendlier default to explain: a queued message is not lost, but an
 * operator who cannot see that it is waiting reads the silence as a bug.
 */
export const DEFAULT_BUSY_DELIVERY = DELIVERY_STEER

/** `/steer <text>` / `/queue <text>`, case-insensitive, text may span lines. */
const OVERRIDE = /^\/(steer|queue)(?:\s+([\s\S]*))?$/i

/**
 * Normalize a stored setting to one of the two modes.
 *
 * Anything unrecognized reads as the default, so a hand-edited settings file
 * cannot leave the bridge without a delivery decision.
 *
 * @param value - the raw `busyDelivery` setting.
 * @returns `'queue'` or `'steer'`.
 */
export function normalizeBusyDelivery(value) {
  return value === DELIVERY_QUEUE ? DELIVERY_QUEUE : DELIVERY_STEER
}

/**
 * Split a delivery override off the front of a message.
 *
 * The remainder is the prompt text, so `/steer 用另一种写法` inserts those five
 * characters and nothing else. A leading token that merely starts with the same
 * letters (`/steerer`) is not an override and stays an ordinary command, which
 * is what keeps the match from swallowing a future command's name.
 *
 * @param text - the trimmed inbound message text.
 * @returns `{ mode, text }`, or null when this is not an override.
 */
export function parseDeliveryOverride(text) {
  const match = OVERRIDE.exec(String(text ?? '').trim())
  if (match === null) return null
  return {
    mode: match[1].toLowerCase() === DELIVERY_QUEUE ? DELIVERY_QUEUE : DELIVERY_STEER,
    text: (match[2] ?? '').trim(),
  }
}

/**
 * Decide how one message is delivered.
 *
 * An explicit override always wins, even when the agent is idle: `steer` on an
 * idle agent is not an error — the driver starts a turn and claims the
 * `next-step` inbox as its first input — so honoring the operator's word costs
 * nothing and refusing it would be surprising.
 *
 * Otherwise the configured policy decides, and only a *proven* running turn
 * selects `steer`: an unknown busy state reads as idle, because queueing is the
 * behaviour that cannot be wrong, only slow.
 *
 * @param options - the decision inputs.
 * @param options.policy - the `busyDelivery` setting.
 * @param options.forced - the mode named by an override, when there was one.
 * @param options.busy - true only when the session's agent is provably running.
 * @returns `'queue'` or `'steer'`.
 */
export function resolveDeliveryMode({ policy, forced = null, busy = false }) {
  if (forced === DELIVERY_QUEUE || forced === DELIVERY_STEER) return forced
  if (normalizeBusyDelivery(policy) === DELIVERY_QUEUE) return DELIVERY_QUEUE
  return busy === true ? DELIVERY_STEER : DELIVERY_QUEUE
}
