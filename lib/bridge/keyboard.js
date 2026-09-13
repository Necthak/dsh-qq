/**
 * Inline keyboards: the buttons the bridge attaches to its own messages.
 *
 * A keyboard is the only interactive surface the platform offers per message,
 * and it is strictly better than the numbered-text convention it replaces for
 * one reason: the operator taps instead of typing. That matters most for the
 * two prompts where a mistyped answer is expensive — an approval and a model
 * switch.
 *
 * Two platform rules shape everything here:
 *
 * - **`render_data.label` is capped at 10 characters.** Model ids routinely
 *   exceed that (`deepseek-v4.1-flash`), so buttons carry a short label and the
 *   authoritative identity travels in `action.data`, which has no such cap.
 *   Labels are therefore page-stable numbers, and the message body above the
 *   keyboard is what maps a number to a model.
 * - **A click comes back as `INTERACTION_CREATE`, not as a message.** The
 *   payload in `action.data` is the entire contract, so it is encoded as a
 *   self-describing `kind|arg|arg` string rather than an index into state that
 *   may have moved on by the time the button is tapped.
 *
 * @module dsh-qq/bridge/keyboard
 */

/** Button styles the platform documents. */
const STYLE = {
  /** Grey outline — the neutral default. */
  grey: 0,
  /** Blue outline — the affirmative choice. */
  blue: 1,
  /** White background, red text — the destructive choice. */
  danger: 3,
}

/** Callback buttons ask the platform to deliver the click back to the bot. */
const ACTION_CALLBACK = 1

/** Everyone in the conversation may press the button. */
const PERMISSION_EVERYONE = 2

/**
 * What a client too old to run the action shows the user.
 *
 * The button schema marks this field REQUIRED, and it is the only thing standing
 * between an old client and a button that silently does nothing. Omitting it is
 * not cosmetic: a keyboard sent from this bridge without it and an otherwise
 * identical one sent from a probe with it behaved differently on the operator's
 * phone.
 */
const UNSUPPORTED_TIPS = '当前 QQ 版本不支持按钮，请直接回复文字'

/** Payload kinds a button may carry. */
export const BUTTON = {
  /** `model|<provider>|<model>` — switch this conversation's model. */
  model: 'model',
  /** `effort|<provider>|<model>|<effort>` — set the reasoning effort. */
  effort: 'effort',
  /** `page|<n>` — re-render the model list at page `n`. */
  page: 'page',
  /** `approve` — answer the open approval affirmatively. */
  approve: 'approve',
  /** `deny` — answer the open approval negatively. */
  deny: 'deny',
  /** `opt|<n>` — answer the open question with option `n` (1-based). */
  option: 'opt',
}

/** How many model buttons one page holds. */
export const MODEL_PAGE_SIZE = 8

/** Buttons per row, chosen so a phone shows a compact grid. */
const MODEL_BUTTONS_PER_ROW = 4

/**
 * Encode a model switch.
 *
 * @param provider - provider route id.
 * @param model - model id within that route.
 * @returns The button payload.
 */
export function encodeModel(provider, model) {
  return `${BUTTON.model}|${provider}|${model}`
}

/**
 * Encode a reasoning-effort change.
 *
 * The provider and model travel with the effort so a tap is unambiguous even if
 * the conversation switched models between rendering and pressing.
 *
 * @param provider - provider route id.
 * @param model - model id within that route.
 * @param effort - reasoning effort id.
 * @returns The button payload.
 */
export function encodeEffort(provider, model, effort) {
  return `${BUTTON.effort}|${provider}|${model}|${effort}`
}

/**
 * Encode a page change.
 *
 * @param page - zero-based page index.
 * @returns The button payload.
 */
export function encodePage(page) {
  return `${BUTTON.page}|${page}`
}

/**
 * Encode a numbered answer to an open question.
 *
 * @param index - one-based option number, matching the rendered list.
 * @returns The button payload.
 */
export function encodeOption(index) {
  return `${BUTTON.option}|${index}`
}

/**
 * Take one button payload apart.
 *
 * @param data - the payload from `action.data`.
 * @returns `{ kind, args }`, or null when the payload is not one of ours.
 */
export function decodeButton(data) {
  if (typeof data !== 'string' || data === '') return null
  const parts = data.split('|')
  const kind = parts[0]
  if (kind === BUTTON.approve || kind === BUTTON.deny) return { kind, args: [] }
  if (kind === BUTTON.model) return parts.length === 3 ? { kind, args: parts.slice(1) } : null
  if (kind === BUTTON.effort) return parts.length === 4 ? { kind, args: parts.slice(1) } : null
  if (kind === BUTTON.page) return parts.length === 2 ? { kind, args: parts.slice(1) } : null
  if (kind === BUTTON.option) return parts.length === 2 ? { kind, args: parts.slice(1) } : null
  return null
}

/**
 * Build one callback button.
 *
 * @param label - button text, at most 10 characters.
 * @param data - the payload returned when it is pressed.
 * @param style - a {@link STYLE} value.
 * @returns A platform button object.
 */
export function button(label, data, style = STYLE.grey) {
  const text = String(label).slice(0, 10)
  return {
    id: text,
    render_data: { label: text, visited_label: text, style },
    action: {
      type: ACTION_CALLBACK,
      data,
      permission: { type: PERMISSION_EVERYONE },
      unsupport_tips: UNSUPPORTED_TIPS,
    },
  }
}

/**
 * Wrap rows of buttons as a keyboard.
 *
 * @param rows - arrays of buttons.
 * @returns A keyboard body, or undefined when there is nothing to show.
 */
export function keyboard(rows) {
  const kept = rows.filter((row) => Array.isArray(row) && row.length > 0)
  if (kept.length === 0) return undefined
  return { content: { rows: kept.map((row) => ({ buttons: row })) } }
}

/**
 * Build the model list as a numbered keypad.
 *
 * Buttons carry the provider and model id outright rather than a position in
 * the list. A position would be shorter, but the catalog is live: a provider
 * that goes away between rendering and tapping would silently shift every
 * number onto a different model, and the operator would get a model they did
 * not choose. Numbers stay a display convention only.
 *
 * @param rows - the flattened catalog, in render order.
 * @param page - zero-based page index.
 * @param pageSize - models per page.
 * @returns A keyboard, or undefined when there is nothing to press.
 */
export function buildModelKeyboard(rows, page, pageSize = MODEL_PAGE_SIZE) {
  const list = Array.isArray(rows) ? rows : []
  if (list.length === 0) return undefined

  const pages = Math.max(1, Math.ceil(list.length / pageSize))
  const current = Math.min(Math.max(page, 0), pages - 1)
  const first = current * pageSize
  const last = Math.min(first + pageSize, list.length)

  const out = []
  for (let start = first; start < last; start += MODEL_BUTTONS_PER_ROW) {
    const row = []
    for (let index = start; index < Math.min(start + MODEL_BUTTONS_PER_ROW, last); index += 1) {
      const entry = list[index]
      row.push(button(String(index + 1), encodeModel(entry.provider, entry.model.id)))
    }
    out.push(row)
  }

  if (pages > 1) {
    const nav = []
    if (current > 0) nav.push(button('上一页', encodePage(current - 1)))
    nav.push(button(`${current + 1}/${pages}`, encodePage(current)))
    if (current + 1 < pages) nav.push(button('下一页', encodePage(current + 1)))
    out.push(nav)
  }
  return keyboard(out)
}

/**
 * Build the reasoning-effort picker for one model.
 *
 * @param provider - provider route id.
 * @param model - model id.
 * @param efforts - effort ids the adapter publishes.
 * @returns A keyboard, or undefined when the model has no effort levels.
 */
export function buildEffortKeyboard(provider, model, efforts) {
  if (!Array.isArray(efforts) || efforts.length === 0) return undefined
  return keyboard([efforts.map((effort) => button(String(effort), encodeEffort(provider, model, String(effort))))])
}

/**
 * Build the approval decision buttons.
 *
 * @returns The keyboard.
 */
export function buildApprovalKeyboard() {
  return keyboard([[
    button('通过', BUTTON.approve, STYLE.blue),
    button('拒绝', BUTTON.deny, STYLE.danger),
  ]])
}

/**
 * Build the option buttons for one question set.
 *
 * Only single-question requests get buttons: a multi-question request has no
 * way to say which question a bare option number belongs to, and the numbered
 * text protocol already covers that case.
 *
 * @param questions - the requested questions.
 * @returns A keyboard, or undefined when buttons would be ambiguous.
 */
export function buildQuestionKeyboard(questions) {
  if (!Array.isArray(questions) || questions.length !== 1) return undefined
  const options = Array.isArray(questions[0]?.options) ? questions[0].options : []
  if (options.length === 0) return undefined
  return keyboard([options.map((option, index) => button(String(index + 1), encodeOption(index + 1)))])
}

