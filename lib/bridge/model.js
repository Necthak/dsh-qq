/**
 * `/model` — read and switch the model behind one QQ conversation.
 *
 * The bridge owns no model state of its own: it asks the Host for the same
 * catalog the desktop selectors use (`sessionController.modelCatalog`) and
 * commits through the same command (`sessionController.selectModel`). A second
 * source of truth here would drift from the GUI the first time either moved.
 *
 * Three Host facts shape this surface:
 *
 * - `selectModel` also saves the choice as the deployment default for new
 *   Sessions, so a switch made from QQ is not merely conversation-local.
 * - The catalog reports only *routable* providers, so an adapter that is not
 *   serving right now is absent rather than listed as a dead option.
 * - Models are grouped by provider, but a phone cannot type a provider id
 *   comfortably, so the list is numbered and a bare model id is accepted when
 *   it is unambiguous within the conversation's current provider.
 *
 * Nothing here formats for a specific transport: `formatCatalog` returns text
 * and the inbound path hands it to the ordinary outbound sender, which owns
 * chunking and the passive/active reply decision.
 *
 * @module dsh-qq/bridge/model
 */

/** Digits only, so `1a` is reported as unknown instead of silently selecting row 1. */
const INDEX = /^\d+$/

/**
 * Flatten the provider groups into the exact order the number list renders.
 *
 * Numbering and lookup must walk the catalog the same way, otherwise `/model 3`
 * would select a different row than the one printed as `3`.
 *
 * @param catalog - the Host model catalog.
 * @returns One row per selectable model, in render order.
 */
export function flattenCatalog(catalog) {
  const rows = []
  for (const group of Array.isArray(catalog?.groups) ? catalog.groups : []) {
    for (const model of Array.isArray(group.models) ? group.models : []) {
      rows.push({ provider: group.id, providerName: group.name, model })
    }
  }
  return rows
}

/**
 * Render the numbered catalog, marking the conversation's current model.
 *
 * Passing a `pageSize` switches to the paged form used with inline keyboards:
 * numbering stays global across pages, so the number printed next to a model is
 * the same number `/model <n>` accepts and the same one its button carries.
 *
 * @param catalog - the Host model catalog.
 * @param current - the conversation's current selection, when it is readable.
 * @param options - paging.
 * @param options.page - zero-based page index; ignored without `pageSize`.
 * @param options.pageSize - models per page; zero renders every model.
 * @returns The message body sent to QQ.
 */
export function formatCatalog(catalog, current, options = {}) {
  const pageSize = Number.isSafeInteger(options.pageSize) && options.pageSize > 0 ? options.pageSize : 0
  if (pageSize > 0) return formatCatalogPage(catalog, current, options.page ?? 0, pageSize)

  const lines = []
  const here = current === undefined || current === null
    ? ''
    : `（当前：${current.provider}/${current.model}${effortSuffix(current)}）`
  lines.push(`🤖 可用模型${here}`)

  let index = 0
  for (const group of Array.isArray(catalog?.groups) ? catalog.groups : []) {
    const models = Array.isArray(group.models) ? group.models : []
    lines.push('')
    lines.push(group.name === undefined || group.name === '' || group.name === group.id ? group.id : `${group.id}（${group.name}）`)
    if (models.length === 0) {
      lines.push('  （无可用模型）')
      continue
    }
    for (const model of models) {
      index += 1
      const display = model.name === undefined || model.name === '' || model.name === model.id ? '' : `（${model.name}）`
      const mark = isCurrent(current, group.id, model.id) ? ' ←' : ''
      lines.push(`${index}. ${model.id}${display}${mark}`)
    }
  }

  if (index === 0) {
    lines.push('', '当前没有可路由的模型。请先在设置 → 模型里配置一个提供方。')
  }

  const failures = Array.isArray(catalog?.failures) ? catalog.failures : []
  if (failures.length > 0) {
    lines.push('', `⚠️ 读取失败的提供方：${failures.map((failure) => failure.id).join('、')}`)
  }

  lines.push('', '/model <编号> 切换，例如 /model 3')
  lines.push('可同时指定推理强度：/model 3 max')
  lines.push('切换会同时成为新会话的默认模型。')
  return lines.join('\n')
}

/**
 * Resolve one typed token to a catalog row.
 *
 * Accepted forms, in the order they are tried: a 1-based row number, an
 * explicit `provider/model`, then a bare model id or display name. A bare match
 * is only ambiguous when several providers publish it, and the conversation's
 * current provider breaks that tie — which is what makes the common case
 * (`/model deepseek-v4-pro`) require no provider knowledge.
 *
 * @param catalog - the Host model catalog.
 * @param token - the user-typed argument.
 * @param preferredProvider - provider to prefer when a bare id matches several.
 * @returns A tagged result: `row`, `missing`, `out-of-range`, `unknown`, or `ambiguous`.
 */
export function resolveChoice(catalog, token, preferredProvider) {
  const rows = flattenCatalog(catalog)
  const raw = typeof token === 'string' ? token.trim() : ''
  if (raw === '') return { kind: 'missing' }

  if (INDEX.test(raw)) {
    const position = Number(raw)
    if (position < 1 || position > rows.length) return { kind: 'out-of-range', token: raw, size: rows.length }
    return { kind: 'row', row: rows[position - 1] }
  }

  const slash = raw.indexOf('/')
  if (slash > 0) {
    const provider = raw.slice(0, slash)
    const id = raw.slice(slash + 1)
    const hit = rows.find((row) => row.provider === provider && row.model.id === id)
    if (hit === undefined) return { kind: 'unknown', token: raw }
    return { kind: 'row', row: hit }
  }

  const needle = raw.toLowerCase()
  const matches = rows.filter((row) =>
    row.model.id.toLowerCase() === needle
    || (typeof row.model.name === 'string' && row.model.name.toLowerCase() === needle))
  if (matches.length === 0) return { kind: 'unknown', token: raw }
  if (matches.length === 1) return { kind: 'row', row: matches[0] }

  const preferred = matches.find((row) => row.provider === preferredProvider)
  if (preferred !== undefined) return { kind: 'row', row: preferred }
  return { kind: 'ambiguous', token: raw, rows: matches }
}

/**
 * Resolve an optional reasoning-effort argument against one model's metadata.
 *
 * A model that publishes no reasoning metadata rejects the argument instead of
 * forwarding an arbitrary string: the Host would fail the whole switch, and
 * "this model has no effort levels" is a better answer than a provider error.
 *
 * @param row - the selected catalog row.
 * @param token - the user-typed effort, or undefined when none was given.
 * @returns A tagged result: `default`, `effort`, or `unsupported`.
 */
export function resolveEffort(row, token) {
  if (token === undefined || token === null || String(token).trim() === '') return { kind: 'default' }
  const raw = String(token).trim()
  const efforts = Array.isArray(row?.model?.reasoning?.efforts) ? row.model.reasoning.efforts : []
  const needle = raw.toLowerCase()
  const hit = efforts.find((effort) =>
    effort.id.toLowerCase() === needle
    || (typeof effort.name === 'string' && effort.name.toLowerCase() === needle))
  if (hit !== undefined) return { kind: 'effort', id: hit.id }
  return { kind: 'unsupported', token: raw, available: efforts.map((effort) => effort.id) }
}

/**
 * Explain why a choice could not be resolved, in the user's own terms.
 *
 * @param choice - a non-`row` result from {@link resolveChoice}.
 * @returns The reply body.
 */
export function explainChoice(choice) {
  if (choice.kind === 'out-of-range') {
    return `❓ 编号 ${choice.token} 超出范围（共 ${choice.size} 个）。发 /model 查看列表。`
  }
  if (choice.kind === 'ambiguous') {
    const options = choice.rows.map((row) => `${row.provider}/${row.model.id}`).join('、')
    return `❓「${choice.token}」在多个提供方下都有：${options}。请用 /model 提供方/模型 指定。`
  }
  return `❓ 没有找到模型「${choice.token}」。发 /model 查看列表。`
}

/**
 * Explain why an effort argument was rejected.
 *
 * @param row - the selected catalog row.
 * @param effort - an `unsupported` result from {@link resolveEffort}.
 * @returns The reply body.
 */
export function explainEffort(row, effort) {
  if (effort.available.length === 0) {
    return `❓ ${row.model.id} 不接受推理强度设置。去掉参数即可切换，例如 /model ${row.model.id}`
  }
  return `❓ 推理强度「${effort.token}」不可用。${row.model.id} 支持：${effort.available.join('、')}`
}

/**
 * Build the Host-facing half of `/model`.
 *
 * Reads are best-effort: a deployment that cannot answer them still lists and
 * switches models, it just cannot mark the current row.
 *
 * @param options - wiring.
 * @param options.ctx - the plugin context.
 * @param options.log - diagnostics sink.
 * @returns Catalog, current-selection, and switch operations.
 */
export function createModelSwitcher({ ctx, log }) {
  return {
    /**
     * Read every currently routable provider and its models.
     *
     * @returns The Host model catalog.
     */
    async catalog() {
      return ctx.sessionController.modelCatalog()
    },

    /**
     * Read the selection the next request for one Session will use.
     *
     * `pending` is a selection made but not yet consumed by a request, so it
     * wins over `lastUsed` — exactly the fold the desktop selectors display.
     *
     * @param sessionId - the DSH session behind the conversation.
     * @returns The current selection, or undefined when it cannot be read.
     */
    async current(sessionId) {
      try {
        const resolved = await ctx.sessionController.resolveAgent(sessionId)
        const agent = resolved?.agent
        if (agent === undefined) return undefined
        const projections = typeof ctx.get === 'function' ? ctx.get('sessionProjections') : undefined
        const state = projections?.stateOf?.(agent.session, 'modelSelection')
        return state?.pending ?? state?.lastUsed ?? undefined
      } catch (error) {
        log(`current model could not be read (${String(error?.message ?? error)})`)
        return undefined
      }
    },

    /**
     * Commit one selection for a Session.
     *
     * @param sessionId - the DSH session behind the conversation.
     * @param selection - provider, model, and optional reasoning effort.
     * @returns The normalized selection the Host installed.
     */
    async select(sessionId, selection) {
      return ctx.sessionController.selectModel({
        sessionId,
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
      })
    },
  }
}

/**
 * Render the reasoning-effort suffix for one selection.
 *
 * @param selection - a model selection.
 * @returns ` · <effort>`, or an empty string when none is set.
 */
function effortSuffix(selection) {
  return selection.reasoningEffort === undefined ? '' : ` · ${selection.reasoningEffort}`
}

/**
 * Whether one catalog entry is the conversation's current model.
 *
 * @param current - the current selection, possibly undefined.
 * @param provider - the catalog row's provider.
 * @param model - the catalog row's model id.
 * @returns Whether the row should be marked.
 */
function isCurrent(current, provider, model) {
  if (current === undefined || current === null) return false
  return current.provider === provider && current.model === model
}


/**
 * Render one page of the catalog for the button keyboard.
 *
 * Providers are annotated only where they change, because a page can straddle
 * two of them and repeating the route on every line would crowd out the model
 * ids the operator is actually choosing between.
 *
 * @param catalog - the Host model catalog.
 * @param current - the conversation's current selection.
 * @param page - zero-based page index.
 * @param pageSize - models per page.
 * @returns The message body sent to QQ.
 */
function formatCatalogPage(catalog, current, page, pageSize) {
  const rows = flattenCatalog(catalog)
  const lines = []
  const here = current === undefined || current === null
    ? ''
    : `（当前：${current.provider}/${current.model}${effortSuffix(current)}）`
  lines.push(`🤖 选择模型${here}`)

  if (rows.length === 0) {
    lines.push('', '当前没有可路由的模型。请先在设置 → 模型里配置一个提供方。')
    return lines.join('\n')
  }

  const pages = Math.max(1, Math.ceil(rows.length / pageSize))
  const at = Math.min(Math.max(page, 0), pages - 1)
  const first = at * pageSize

  lines.push('')
  let previousProvider = null
  for (let offset = 0; offset < pageSize; offset += 1) {
    const row = rows[first + offset]
    if (row === undefined) break
    const display = row.model.name === undefined || row.model.name === '' || row.model.name === row.model.id ? '' : `（${row.model.name}）`
    const provider = row.provider === previousProvider ? '' : ` · ${row.provider}`
    previousProvider = row.provider
    const mark = isCurrent(current, row.provider, row.model.id) ? ' ←' : ''
    lines.push(`${first + offset + 1}. ${row.model.id}${display}${provider}${mark}`)
  }

  lines.push('')
  if (pages > 1) lines.push(`第 ${at + 1}/${pages} 页 · 点下方数字按钮切换，或直接发 /model <编号>`)
  else lines.push('点下方数字按钮切换，或直接发 /model <编号>')
  lines.push('切换会同时成为新会话的默认模型。')
  return lines.join('\n')
}

/**
 * Describe the reasoning efforts one catalog row publishes.
 *
 * @param catalog - the Host model catalog.
 * @param provider - provider route id.
 * @param model - model id.
 * @returns The published effort ids, or an empty list.
 */
export function effortsFor(catalog, provider, model) {
  const row = flattenCatalog(catalog).find((entry) => entry.provider === provider && entry.model.id === model)
  const efforts = row?.model?.reasoning?.efforts
  return Array.isArray(efforts) ? efforts.map((effort) => String(effort.id)) : []
}
