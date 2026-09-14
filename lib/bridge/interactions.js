/**
 * Button callbacks: what happens when the operator taps a keyboard button.
 *
 * A tap is not a message, but it is treated as one. The platform delivers
 * `INTERACTION_CREATE` with an opaque payload, and this module turns that
 * payload back into exactly the action the equivalent typed command would have
 * performed — including feeding the pending-interaction registry the same text
 * a human would have typed. That reuse is deliberate: the approval and question
 * paths already handle parsing, re-prompting, expiry, and the race against the
 * desktop, and a second implementation for buttons would be a second place for
 * those rules to drift.
 *
 * Three properties matter:
 *
 * - **Admission is checked first.** A button is reachable by anyone who can see
 *   the message, so a tap from an unadmitted sender is dropped before it can
 *   change a model or answer an approval.
 * - **Every tap is acknowledged.** The platform keeps the tapped button loading
 *   until the bot answers the event, so the handler ends in exactly one
 *   `PUT /interactions/{id}` carrying the outcome; without it the client spins
 *   until its own timeout, which is what a tap used to do here.
 * - **The reply is passive, and typed as an event.** The click's `id` is a
 *   passive-reply target, so answering costs no active-message quota — but it
 *   must travel as `event_id`, never as `msg_id`.
 * - **An unknown payload is ignored, not guessed.** Payloads come from the
 *   network; anything this bridge did not encode is logged and dropped.
 *
 * @module dsh-qq/bridge/interactions
 */

import { isAllowed } from './admission.js'
import { conversationKey } from './sessions.js'
import { BUTTON, MODEL_PAGE_SIZE, buildEffortKeyboard, buildModelKeyboard, decodeButton } from './keyboard.js'
import { effortsFor, flattenCatalog, formatCatalog } from './model.js'

/** The text a button sends to the pending registry for an approval decision. */
const APPROVAL_TEXT = {
  [BUTTON.approve]: '通过',
  [BUTTON.deny]: '拒绝',
}

/**
 * Outcomes the interaction-response endpoint accepts.
 *
 * Sent with the acknowledgement so the QQ client can report the result itself;
 * `denied` exists because a refused tap is a permission answer, not a crash.
 */
const ACK = {
  ok: 0,
  failed: 1,
  denied: 4,
}

/**
 * Build the interaction handler.
 *
 * @param options - wiring.
 * @param options.sessions - the conversation table.
 * @param options.models - the model catalog and switch operations.
 * @param options.pending - the pending-interaction registry.
 * @param options.config - live settings accessor.
 * @param options.log - diagnostics sink.
 * @param options.outbound - the QQ sender.
 * @param options.onRejected - called with an unadmitted interaction, so the
 *   operator can discover the sender's OpenID.
 * @returns An async handler taking one normalized interaction.
 */
export function createInteractionHandler({ sessions, models, pending, config, log, outbound, onRejected, runCommand }) {
  /**
   * Send a bridge-authored reply on the conversation.
   *
   * @param interaction - the interaction being answered.
   * @param key - the conversation key.
   * @param text - the reply body.
   * @param keyboard - optional inline keyboard.
   */
  async function reply(interaction, key, text, keyboard) {
    try {
      await outbound.deliver({
        key,
        kind: interaction.kind,
        peerId: interaction.peerId,
        text,
        ...(keyboard === undefined ? {} : { keyboard }),
      })
    } catch (error) {
      // A failed acknowledgement must not fail the callback itself.
      log(`${key}: interaction reply failed: ${String(error?.message ?? error)}`)
    }
  }

  /**
   * Re-render the model list at one page, with its keypad.
   *
   * @param interaction - the interaction being answered.
   * @param key - the conversation key.
   * @param sessionId - the bound session.
   * @param page - zero-based page index.
   */
  async function showCatalog(interaction, key, sessionId, page) {
    const catalog = await models.catalog()
    const current = await models.current(sessionId)
    const rows = flattenCatalog(catalog)
    await reply(
      interaction,
      key,
      formatCatalog(catalog, current, { page, pageSize: MODEL_PAGE_SIZE }),
      buildModelKeyboard(rows, page, MODEL_PAGE_SIZE),
    )
  }

  /**
   * Commit one model selection and offer its reasoning efforts.
   *
   * @param interaction - the interaction being answered.
   * @param key - the conversation key.
   * @param sessionId - the bound session.
   * @param selection - provider, model, and optional effort.
   */
  async function applySelection(interaction, key, sessionId, selection) {
    const result = await models.select(sessionId, selection)
    const selected = result?.selected ?? selection
    const catalog = await models.catalog()
    const efforts = effortsFor(catalog, selected.provider, selected.model)
    log(`${key}: model switched to ${selected.provider}/${selected.model} from a button`)
    await reply(
      interaction,
      key,
      [
        `✅ 已切换：${selected.provider}/${selected.model}${selected.reasoningEffort === undefined ? '' : ` · ${selected.reasoningEffort}`}`,
        efforts.length === 0 ? '下一条消息起生效；本会话上下文保留。' : '下一条消息起生效。可再选一个推理强度：',
      ].join('\n'),
      buildEffortKeyboard(selected.provider, selected.model, efforts),
    )
  }

  return async function handleInteraction(interaction) {
    // The platform holds the tapped button in a loading state until the bot
    // answers the event, and the client gives up on its own timeout — which is
    // exactly what a tapped button used to do here. Every path therefore ends
    // in one acknowledgement, including the ones that refuse the click, and the
    // code carries the outcome so QQ can report it in the client.
    let code = ACK.failed
    try {
      code = await dispatch(interaction)
    } catch (error) {
      log(`${conversationKey(interaction.kind, interaction.peerId)}: button handling failed: ${String(error?.message ?? error)}`)
    }
    try {
      await outbound.ackInteraction(interaction.interactionId, code)
    } catch (error) {
      log(`${conversationKey(interaction.kind, interaction.peerId)}: interaction acknowledgement failed: ${String(error?.message ?? error)}`)
    }
  }

  /**
   * Run one click and report its outcome.
   *
   * @param interaction - the normalized interaction.
   * @returns An {@link ACK} code for the interaction response.
   */
  async function dispatch(interaction) {
    const settings = config() ?? {}
    const key = conversationKey(interaction.kind, interaction.peerId)

    if (!isAllowed({ kind: interaction.kind, peerId: interaction.peerId, userId: interaction.userId }, settings)) {
      log(`${key}: button press dropped, the sender is not admitted by the current mode and allow list`)
      try {
        onRejected?.(interaction)
      } catch (error) {
        log(`${key}: rejection listener failed: ${String(error?.message ?? error)}`)
      }
      return ACK.denied
    }

    const decoded = decodeButton(interaction.buttonData)
    if (decoded === null) {
      log(`${key}: unrecognised button payload ignored`)
      return ACK.failed
    }

    // A click carries two ids and only one of them can be replied to. The
    // ENVELOPE id is the passive `event_id` target, so arming the cursor with
    // it is what makes the acknowledgement and the reply free; the payload's
    // own id is the interaction id, and the platform refuses it in that field
    // with `40034025 请求参数event_id无效`. When the frame carried no envelope
    // id there is no event target at all, so the cursor is left alone and the
    // reply falls back to the conversation's own reply window.
    //
    // Both ids are logged because they are opaque and only one is accepted: a
    // rejection in the log is otherwise impossible to attribute.
    log(`${key}: button click (interaction=${interaction.interactionId === '' ? 'none' : interaction.interactionId}, event=${interaction.eventId === '' ? 'none' : interaction.eventId})`)
    if (interaction.eventId !== '') sessions.setReplyTarget(key, interaction.eventId, 'event', interaction.userId)

    // Approvals and question options are answered by feeding the pending
    // registry the text a human would have typed, so parsing, re-prompting,
    // expiry, and the desktop race all keep working unchanged.
    if (decoded.kind === BUTTON.approve || decoded.kind === BUTTON.deny) {
      const text = APPROVAL_TEXT[decoded.kind]
      const consumed = pending.offer(key, text)
      await reply(interaction, key, consumed ? `✅ 已${text === '通过' ? '通过' : '拒绝'}` : '⚠️ 当前没有待审批的请求。')
      return consumed ? ACK.ok : ACK.failed
    }

    // A menu button runs a command exactly as if it had been typed: same
    // admission, same owner checks, same output. The click is therefore only a
    // different way to say `/status`, not a second implementation of it.
    if (decoded.kind === BUTTON.command) {
      const name = decoded.args[0]
      if (typeof runCommand !== 'function') {
        await reply(interaction, key, '⚠️ 菜单按钮未接线。')
        return ACK.failed
      }
      try {
        await runCommand({
          name,
          key,
          kind: interaction.kind,
          peerId: interaction.peerId,
          userId: interaction.userId,
        })
        return ACK.ok
      } catch (error) {
        log(`${key}: menu command ${name} failed: ${String(error?.message ?? error)}`)
        await reply(interaction, key, `⚠️ ${name} 执行失败：${String(error?.message ?? error)}`)
        return ACK.failed
      }
    }

    if (decoded.kind === BUTTON.option) {
      const number = decoded.args[0]
      const consumed = pending.offer(key, number)
      await reply(interaction, key, consumed ? `✅ 已选择 ${number}` : '⚠️ 当前没有待回答的问题。')
      return consumed ? ACK.ok : ACK.failed
    }

    const record = sessions.get(key)
    if (record === undefined) {
      await reply(interaction, key, '⚠️ 当前还没有 DSH 会话。先发一条消息建立会话。')
      return ACK.failed
    }

    // Everything below changes where or how the agent runs, so it is
    // owner-only — the same rule the typed commands apply.
    const owner = typeof settings.ownerOpenId === 'string' ? settings.ownerOpenId.trim() : ''
    const isOwner = owner === '' ? interaction.kind === 'private' : (interaction.userId === owner || interaction.peerId === owner)
    if (!isOwner) {
      await reply(interaction, key, '⛔ 只有 owner 可以切换模型。')
      return ACK.denied
    }

    try {
      if (decoded.kind === BUTTON.model) {
        const [provider, model] = decoded.args
        await applySelection(interaction, key, record.sessionId, { provider, model })
        return ACK.ok
      }
      if (decoded.kind === BUTTON.effort) {
        const [provider, model, reasoningEffort] = decoded.args
        await applySelection(interaction, key, record.sessionId, { provider, model, reasoningEffort })
        return ACK.ok
      }
      if (decoded.kind === BUTTON.page) {
        const page = Number.parseInt(decoded.args[0], 10)
        await showCatalog(interaction, key, record.sessionId, Number.isSafeInteger(page) && page >= 0 ? page : 0)
        return ACK.ok
      }
    } catch (error) {
      log(`${key}: button action failed: ${String(error?.message ?? error)}`)
      await reply(interaction, key, `⚠️ 操作失败：${String(error?.message ?? error)}`)
      return ACK.failed
    }
    return ACK.failed
  }
}
