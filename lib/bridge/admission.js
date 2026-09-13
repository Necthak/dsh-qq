/**
 * Admission and administration rules for one inbound QQ message.
 *
 * These two predicates are the bridge's whole authorization surface, so they
 * live in their own module rather than beside one caller: the inbound path, the
 * agent's own outbound tools, and the administration commands all have to agree
 * on who is allowed and who is the owner, and three copies of that rule would
 * eventually disagree.
 *
 * @module dsh-qq/bridge/admission
 */

/**
 * Decide whether a sender may reach the agent.
 *
 * An empty allow list means "allow everyone", which the console warns about:
 * connecting an agent with shell access to QQ is equivalent to handing over the
 * machine, so the safe configuration names its senders.
 *
 * Two modes, and the difference is what the agent can reach:
 *
 * - `closed-agent` (the default) grants the full toolset, so admission requires
 *   a NAMED owner in a private conversation. With no owner configured it admits
 *   nobody: failing closed is the only defensible choice when the alternative is
 *   handing shell access to whoever finds the bot.
 * - `chat` is the looser surface, governed by the allow list and open to groups.
 *
 * A `deny` entry always wins, in either mode.
 *
 * @param message - the normalized message.
 * @param settings - live settings.
 * @returns Whether the message may proceed.
 */
export function isAllowed(message, settings) {
  const allow = Array.isArray(settings.allow) ? settings.allow.filter((entry) => typeof entry === 'string' && entry !== '') : []
  const deny = Array.isArray(settings.deny) ? settings.deny.filter((entry) => typeof entry === 'string' && entry !== '') : []

  const identities = [message.peerId, message.userId].filter((value) => value !== '')
  if (identities.some((identity) => deny.includes(identity))) return false

  const openWhenEmpty = settings.allowAllWhenEmpty === true
  if (settings.mode !== 'chat') {
    if (message.kind !== 'private') return false
    const owner = typeof settings.ownerOpenId === 'string' ? settings.ownerOpenId.trim() : ''
    if (owner === '') return openWhenEmpty
    return identities.includes(owner)
  }

  if (allow.length === 0) return openWhenEmpty
  return identities.some((identity) => allow.includes(identity))
}

/**
 * Whether the sender may run bridge administration commands.
 *
 * Listing is deliberately not administration and does not consult this; only
 * commands that change where an agent runs, what it is doing, or which model it
 * uses do.
 *
 * @param message - the normalized message.
 * @param settings - live settings.
 * @returns Whether the sender is the configured owner.
 */
export function isOwner(message, settings) {
  const owner = typeof settings.ownerOpenId === 'string' ? settings.ownerOpenId.trim() : ''
  if (owner === '') return message.kind === 'private'
  return message.userId === owner || message.peerId === owner
}
