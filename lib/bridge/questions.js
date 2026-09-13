/**
 * User-question answerer: the agent's `ask_user_question` call reaches QQ.
 *
 * This is the counterpart to the approval answerer and shares its two
 * properties: the downstream (desktop) answerer is started immediately so both
 * surfaces are live, and an unanswered request delegates rather than inventing
 * an answer. Inventing one would be worse here than for an approval — the agent
 * would act on a fabricated decision instead of simply waiting.
 *
 * A question carries options, and QQ has no form UI, so the prompt renders them
 * as a numbered list and the reply parser accepts either the number or the
 * label. Unmatched text becomes the protocol's free-form `custom` answer rather
 * than being rejected, because the agent may legitimately want prose.
 *
 * @module dsh-qq/bridge/questions
 */

import { PENDING_KIND, formatQuestions, parseQuestionReply } from './pending.js'
import { buildQuestionKeyboard } from './keyboard.js'
import { splitConversationKey } from './sessions.js'

/**
 * Register the QQ user-question answerer on a context.
 *
 * @param options - wiring.
 * @param options.ctx - the plugin context.
 * @param options.sessions - the conversation table.
 * @param options.outbound - the QQ sender.
 * @param options.pending - the pending-interaction registry.
 * @param options.config - live settings accessor.
 * @param options.log - diagnostics sink.
 * @returns The disposer that unregisters the answerer.
 */
export function registerQuestionAnswerer({ ctx, sessions, outbound, pending, config, log }) {
  // `prepend` is load-bearing. The waterfall runs listeners in registration
  // order, and the Remote bridge that feeds the desktop UI is registered by a
  // bundle that loads BEFORE this plugin, so it would otherwise claim the
  // request first and only hand it on if the browser declined. Racing the
  // desktop is the whole design here, and racing requires being in the chain at
  // all — so the QQ answerer goes to the front and starts `next()` itself.
  return ctx.on('user-questions/request', async (request, next) => {
    const questions = Array.isArray(request?.questions) ? request.questions : []
    if (questions.length === 0) return next()

    const sessionId = request?.agent?.session?.id
    const key = typeof sessionId === 'string' ? sessions.keyForSession(sessionId) : undefined
    if (key === undefined) {
      // Every early return is logged. A silent one here is exactly what made
      // "the question never appeared on QQ" undiagnosable: the handler had run
      // and declined, and nothing said so.
      log(`question for session ${String(sessionId)} is not bound to a QQ conversation; leaving it to the desktop`)
      return next()
    }

    const settings = config() ?? {}
    if (settings.forwardQuestions === false) {
      log(`${key}: question forwarding is disabled; leaving it to the desktop`)
      return next()
    }

    const target = splitConversationKey(key)
    if (target === null) {
      log(`${key}: conversation key is malformed; leaving the question to the desktop`)
      return next()
    }

    const downstream = Promise.resolve()
      .then(() => next())
      .catch((error) => {
        log(`question downstream answerer failed: ${String(error?.message ?? error)}`)
        return undefined
      })

    const timeoutMs = Number.isSafeInteger(settings.questionTimeoutMs) ? settings.questionTimeoutMs : 300_000

    // Open the slot BEFORE the send. The send is paced behind the same
    // per-conversation chain the turn's own output uses, so a fast reply can
    // arrive while the prompt is still queued; with the slot already open that
    // reply is the answer, not a brand-new prompt.
    const answer = pending.open(key, {
      kind: PENDING_KIND.question,
      timeoutMs,
      parse: (text) => parseQuestionReply(questions, text),
      onReprompt: () => {
        outbound
          .deliver({ key, kind: target.kind, peerId: target.peerId, text: '没看懂这条回复，请按上面的格式再回一次。' })
          .catch(() => {})
      },
    })

    // `deliver` prefers the passive reply window, which is free and exempt from
    // the active-message quota, and falls back to an active message on its own.
    // A prompt is exactly the message that must not be lost to a spent active
    // quota the operator cannot see from QQ.
    let delivered = true
    try {
      await outbound.deliver({
        key,
        kind: target.kind,
        peerId: target.peerId,
        text: formatQuestions(questions),
        // A single question with options becomes buttons; a multi-question
        // request keeps the numbered-text protocol, which is the only encoding
        // that can say which question an answer belongs to.
        keyboard: buildQuestionKeyboard(questions),
      })
    } catch (error) {
      delivered = false
      log(`${key}: question prompt could not be delivered: ${String(error?.message ?? error)}`)
    }
    if (!delivered) {
      pending.close(key)
      return downstream
    }

    const winner = await Promise.race([
      answer.then((value) => ({ from: 'qq', value })),
      downstream.then((value) => ({ from: 'desktop', value })),
    ])

    if (winner.from === 'desktop') {
      pending.close(key)
      return winner.value
    }
    if (winner.value === undefined) {
      log(`${key}: no QQ answer for ${questions.length} question(s); leaving it to the desktop surface`)
      return downstream
    }
    log(`${key}: ${questions.length} question(s) answered from QQ`)
    return winner.value
  }, { prepend: true })
}
