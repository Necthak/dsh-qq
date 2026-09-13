/**
 * Approval answerer: the agent's permission question reaches QQ, and the
 * user's reply decides it.
 *
 * DSH dispatches `approval/request` down a waterfall. Returning a value claims
 * the request; calling `next()` delegates to the next answerer — normally the
 * desktop UI. Two properties matter here:
 *
 * - **The desktop surface stays live.** Rather than blocking the chain while
 *   QQ waits, this answerer starts `next()` immediately and races it against the
 *   QQ reply, so whichever surface answers first wins. A user who walked away
 *   from the phone can still approve at the keyboard.
 * - **An unanswered request delegates rather than denies.** On expiry this
 *   answerer awaits the already-started downstream result instead of
 *   re-invoking the chain, so the request resolves exactly once and a missing
 *   QQ answer cannot strand the turn.
 *
 * @module dsh-qq/bridge/approvals
 */

import { PENDING_KIND, parseApprovalReply } from './pending.js'
import { buildApprovalKeyboard } from './keyboard.js'
import { splitConversationKey } from './sessions.js'

/**
 * Register the QQ approval answerer on a context.
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
export function registerApprovalAnswerer({ ctx, sessions, outbound, pending, config, log }) {
  // See the question answerer: `prepend` is what puts this answerer in the
  // waterfall ahead of the Remote bridge that feeds the desktop, so the two
  // surfaces genuinely race instead of the desktop always winning by position.
  return ctx.on('approval/request', async (request, next) => {
    const sessionId = request?.agent?.session?.id
    const key = typeof sessionId === 'string' ? sessions.keyForSession(sessionId) : undefined
    if (key === undefined) {
      log(`approval for session ${String(sessionId)} is not bound to a QQ conversation; leaving it to the desktop`)
      return next()
    }

    const settings = config() ?? {}
    if (settings.forwardApprovals === false) {
      log(`${key}: approval forwarding is disabled; leaving it to the desktop`)
      return next()
    }

    const target = splitConversationKey(key)
    if (target === null) {
      log(`${key}: conversation key is malformed; leaving the approval to the desktop`)
      return next()
    }

    const toolName = typeof request?.toolName === 'string' ? request.toolName : '未知工具'
    const reason = typeof request?.reason === 'string' && request.reason !== '' ? `\n原因：${request.reason}` : ''
    const prompt = `🔐 工具审批请求\n工具：${toolName}${reason}\n\n回复「通过」允许本次，或「拒绝」驳回。`

    // Start the downstream chain first so the desktop UI shows the prompt too.
    const downstream = Promise.resolve()
      .then(() => next())
      .catch((error) => {
        log(`approval downstream answerer failed: ${String(error?.message ?? error)}`)
        return undefined
      })

    const timeoutMs = Number.isSafeInteger(settings.approvalTimeoutMs) ? settings.approvalTimeoutMs : 300_000

    // Open the slot BEFORE the send: the send is paced behind the turn's own
    // output, so an approval typed quickly must not be read as a new prompt.
    const answer = pending.open(key, {
      kind: PENDING_KIND.approval,
      timeoutMs,
      parse: parseApprovalReply,
      onReprompt: () => {
        outbound
          .deliver({ key, kind: target.kind, peerId: target.peerId, text: '请回复「通过」或「拒绝」。' })
          .catch(() => {})
      },
    })

    // `deliver` prefers the passive reply window and falls back to an active
    // message; an approval prompt must reach the phone even when the active
    // quota is spent, because a missed approval stalls the whole turn.
    let delivered = true
    try {
      await outbound.deliver({
        key,
        kind: target.kind,
        peerId: target.peerId,
        text: prompt,
        keyboard: buildApprovalKeyboard(),
      })
    } catch (error) {
      delivered = false
      log(`${key}: approval prompt could not be delivered: ${String(error?.message ?? error)}`)
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
      // The desktop decided; release the QQ slot so the next message is a prompt.
      pending.close(key)
      return winner.value
    }
    if (winner.value === undefined) {
      // Expired without a QQ answer: the desktop chain is still running.
      log(`${key}: no QQ answer for the approval of ${toolName}; leaving it to the desktop surface`)
      return downstream
    }
    log(`${key}: approval for ${toolName} answered from QQ as ${winner.value}`)
    return winner.value
  }, { prepend: true })
}
