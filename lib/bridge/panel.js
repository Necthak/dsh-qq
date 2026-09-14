/**
 * The platform's instruction panel: a list of commands that sits in the chat
 * window, so nothing has to be remembered or typed.
 *
 * Two facts from the platform documentation shape this module:
 *
 * - The panel exists in **both** direct and group chats, while the older
 *   "custom menu" is direct-chat only. This deployment is used from a group, so
 *   the panel is the surface worth installing.
 * - A tap **fills the input box** with the item's name; it does not send. The
 *   names are therefore written as the commands themselves, so a tap leaves the
 *   operator one press away from a correct command rather than guessing at one.
 *
 * A panel is identified across restarts by its `remark`, which the platform
 * stores but never shows, so reinstalling updates the existing panel instead of
 * accumulating duplicates.
 *
 * @module dsh-qq/bridge/panel
 */

/** Marks panels this bridge owns, so a reinstall finds rather than duplicates. */
export const PANEL_REMARK = 'dsh-qq'

/** The platform's limit on one panel's elements. */
export const PANEL_ITEM_LIMIT = 20

/**
 * The commands the panel offers.
 *
 * Ten of the ones that are awkward on a phone, in the order they are usually
 * wanted. The `name` is the text a tap puts in the input box and the `desc` is
 * what the panel shows beside it, so the name is the command and the description
 * is what it does.
 *
 * @returns Panel items, ready for the API.
 */
export function panelItems() {
  return [
    { type: 'command', name: '/status', desc: '通道、回合与最近失败' },
    { type: 'command', name: '/usage', desc: '余额、套餐与今日花费' },
    { type: 'command', name: '/todos', desc: '本轮任务清单与进度' },
    { type: 'command', name: '/sessions', desc: '最近会话，可切换' },
    { type: 'command', name: '/find', desc: '在会话内容里搜索' },
    { type: 'command', name: '/doctor', desc: '主动自检' },
    { type: 'command', name: '/screen', desc: '截图发到本对话' },
    { type: 'command', name: '/log', desc: '最近的桥接日志' },
    { type: 'command', name: '/new', desc: '开新对话' },
    { type: 'command', name: '/help', desc: '全部命令' },
  ]
}

/**
 * Install or refresh the panel for every target.
 *
 * The update path is used whenever a panel with our remark already exists for
 * that scope, because the platform caps a bot at twenty panels and creating a
 * second one on every install would reach that cap in a week.
 *
 * @param options - what to install and where.
 * @param options.api - the OpenAPI client.
 * @param options.targets - one entry per scope: `{ scope, ids }`, where `ids`
 *   are the conversation OpenIDs that should see the panel.
 * @param options.log - diagnostics sink.
 * @returns One result per target: `{ scope, action, panelId }` or
 *   `{ scope, action: 'skipped', reason }`.
 */
export async function installPanels({ api, targets, log = () => {} }) {
  const items = panelItems()
  const results = []
  for (const target of targets) {
    const scope = target.scope
    const ids = Array.isArray(target.ids) ? target.ids.filter((id) => typeof id === 'string' && id !== '') : []
    if (ids.length === 0) {
      results.push({ scope, action: 'skipped', reason: '还没有可用于该场景的会话' })
      continue
    }
    let existing = null
    try {
      existing = await findPanel(api, scope)
    } catch (error) {
      log(`panel lookup for ${scope} failed: ${String(error?.message ?? error)}`)
    }
    const payload = { items, remark: PANEL_REMARK }
    try {
      if (existing === null) {
        const created = await api.createPanel({
          scope,
          target_type: 'specific',
          ...(scope === 'group' ? { group_openids: ids } : { user_openids: ids }),
          panel: payload,
        })
        results.push({ scope, action: 'created', panelId: String(created?.panel_id ?? '') })
      } else {
        await api.updatePanel(existing, payload)
        results.push({ scope, action: 'updated', panelId: existing })
      }
    } catch (error) {
      log(`panel install for ${scope} failed: ${String(error?.message ?? error)}`)
      results.push({ scope, action: 'failed', reason: String(error?.message ?? error) })
    }
  }
  return results
}

/**
 * Find this bridge's panel for one scope, if it has one.
 *
 * @param api - the OpenAPI client.
 * @param scope - `'c2c'` or `'group'`.
 * @returns The panel id, or null.
 */
async function findPanel(api, scope) {
  const listed = await api.listPanels()
  const records = Array.isArray(listed?.records) ? listed.records : []
  const mine = records.find((record) => record?.scope === scope && record?.panel?.remark === PANEL_REMARK)
  return typeof mine?.panel_id === 'string' && mine.panel_id !== '' ? mine.panel_id : null
}
