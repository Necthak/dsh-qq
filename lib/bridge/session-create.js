/**
 * Resolve (and on first contact create) the DSH session behind one QQ
 * conversation.
 *
 * The one subtle rule here is the location argument. `sessionController.create`
 * names a session's working location in exactly one of two ways — a registered
 * `workspaceId`, or a raw `cwd` — and refuses a request that supplies both
 * (`session.create accepts workspaceId or cwd, not both`). A workspace already
 * carries its canonical path, so a registered workspace is the whole answer and
 * the raw path is only the fallback for a profile with no workspace registry.
 *
 * @module dsh-qq/bridge/session-create
 */

import { mkdirSync } from 'node:fs'

/**
 * Choose the mutually exclusive location field for a create request.
 *
 * @param options - the resolved location.
 * @param options.workspaceId - a registered workspace id, when one was resolved.
 * @param options.targetPath - the directory to fall back to.
 * @returns A request fragment carrying exactly one of the two fields.
 */
export function sessionLocation({ workspaceId, targetPath }) {
  if (typeof workspaceId === 'string' && workspaceId !== '') return { workspaceId }
  return { cwd: targetPath }
}

/**
 * Build the session resolver for one bridge instance.
 *
 * @param options - wiring.
 * @param options.ctx - the plugin context.
 * @param options.sessions - the conversation table.
 * @param options.config - live settings accessor.
 * @param options.log - diagnostics sink.
 * @returns An async function taking a conversation key and returning a session id.
 */
export function createSessionEnsurer({ ctx, sessions, config, log }) {
  return async function ensureSession(key) {
    const existing = sessions.get(key)
    if (existing !== undefined) return existing.sessionId

    const settings = config() ?? {}
    const configured = typeof settings.workspacePath === 'string' ? settings.workspacePath.trim() : ''
    const targetPath = configured === '' ? process.cwd() : configured

    if (configured !== '') {
      try {
        mkdirSync(configured, { recursive: true })
      } catch (error) {
        log(`workspace path ${configured} could not be created: ${String(error?.message ?? error)}`)
      }
    }

    let workspaceId
    const registry = ctx.get('workspaceRegistry')
    if (registry !== undefined && typeof registry.create === 'function') {
      try {
        const workspace = await registry.create(targetPath, 'QQ 聊天')
        workspaceId = workspace?.id
      } catch (error) {
        log(`workspace could not be registered (${String(error?.message ?? error)}); falling back to a plain cwd`)
      }
    }

    const request = sessionLocation({ workspaceId, targetPath })
    const preset = typeof settings.agentPreset === 'string' ? settings.agentPreset.trim() : ''
    if (preset !== '') request.agentPreset = preset

    const created = await ctx.sessionController.create(request)
    sessions.bind(key, created.sessionId)
    log(`new QQ session ${created.sessionId} for ${key}`)
    return created.sessionId
  }
}
