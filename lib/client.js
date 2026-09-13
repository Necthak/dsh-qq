/**
 * dsh-qq settings card (browser half).
 *
 * Hand-written in the shell's module-loader format, like the other local
 * plugins, so the plugin needs no bundler. It registers one card into the
 * General settings page and talks to the host half over the two console routes.
 *
 * @module dsh-qq/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-qq',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const react = require('react')

    const CSS = [
      '.dsh-qq-group { display: flex; flex-direction: column; gap: 12px; padding: 16px 0;',
      '  border-bottom: 1px solid var(--dsw-alias-border-l2); font-family: Inter, var(--dsw-font-family); }',
      '.dsh-qq-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }',
      '.dsh-qq-title { color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 500; line-height: 22px; }',
      '.dsh-qq-sub { color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; }',
      '.dsh-qq-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }',
      '.dsh-qq-rowtext { display: flex; flex-direction: column; min-width: 0; }',
      '.dsh-qq-mode { display: flex; gap: 6px; }',
      '.dsh-qq-mode button[data-active="true"] { background: var(--dsw-alias-state-business-primary); color: #fff; border-color: transparent; }',
      '.dsh-qq-label { color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; }',
      '.dsh-qq-field { display: flex; flex-direction: column; gap: 4px; }',
      '.dsh-qq-input { width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 6px;',
      '  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base);',
      '  color: var(--dsw-alias-label-primary); font-size: 13px; font-family: inherit; }',
      '.dsh-qq-switch { position: relative; flex: none; width: 38px; height: 22px; border-radius: 999px;',
      '  border: none; cursor: pointer; padding: 0; background: var(--dsw-alias-interactive-bg-hover); transition: background 0.15s; }',
      '.dsh-qq-switch[data-on="true"] { background: var(--dsw-alias-state-business-primary); }',
      '.dsh-qq-knob { position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%;',
      '  background: #fff; transition: transform 0.15s; box-shadow: 0 1px 2px rgba(0,0,0,0.3); }',
      '.dsh-qq-switch[data-on="true"] .dsh-qq-knob { transform: translateX(16px); }',
      '.dsh-qq-pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px;',
      '  color: var(--dsw-alias-label-secondary); }',
      '.dsh-qq-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); }',
      '.dsh-qq-dot[data-state="online"] { background: var(--dsw-alias-state-business-primary); }',
      '.dsh-qq-dot[data-state="connecting"], .dsh-qq-dot[data-state="reconnecting"] { background: #e8a33d; }',
      '.dsh-qq-actions { display: flex; gap: 8px; }',
      '.dsh-qq-btn { padding: 5px 12px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2);',
      '  background: transparent; color: var(--dsw-alias-label-primary); font-size: 13px; cursor: pointer; font-family: inherit; }',
      '.dsh-qq-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }',
      '.dsh-qq-note { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }',
      '.dsh-qq-warn { color: #e8a33d; font-size: 12px; line-height: 18px; }',
    ].join('\n')

    exports.name = 'dsh-qq'
    exports.inject = ['slots']

    exports.apply = function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-qq'
        style.textContent = CSS
        document.head.appendChild(style)
        return () => { style.remove() }
      }, 'dsh-qq: settings styles')

      function Switch(props) {
        return react.createElement('button', {
          className: 'dsh-qq-switch',
          'data-on': props.on === true ? 'true' : 'false',
          role: 'switch',
          'aria-checked': props.on === true,
          onClick: () => { if (typeof props.onToggle === 'function') props.onToggle(!props.on) },
        }, react.createElement('span', { className: 'dsh-qq-knob' }))
      }

      function Field(props) {
        return react.createElement('div', { className: 'dsh-qq-field' },
          react.createElement('div', { className: 'dsh-qq-label' }, props.label),
          react.createElement('input', {
            className: 'dsh-qq-input',
            type: props.secret === true ? 'password' : 'text',
            value: props.value ?? '',
            placeholder: props.placeholder ?? '',
            onChange: (event) => { props.onChange(event.target.value) },
          }),
        )
      }

      /**
       * QR pairing: obtain AppID/AppSecret by scanning with mobile QQ, the same
       * flow the platform's other third-party agents use. Preferred over typing
       * the secret, because the credentials then never pass through a clipboard.
       */
      function Pairing(props) {
        const [state, setState] = react.useState(null)
        const [busy, setBusy] = react.useState(false)

        react.useEffect(() => {
          let alive = true
          const poll = () => {
            fetch('/dsh-qq/pair')
              .then((r) => (r.ok ? r.json() : null))
              .then((j) => { if (alive && j !== null && typeof j === 'object') setState(j) })
              .catch(() => {})
          }
          poll()
          const id = setInterval(poll, 1500)
          return () => { alive = false; clearInterval(id) }
        }, [])

        const begin = () => {
          setBusy(true)
          fetch('/dsh-qq/pair', { method: 'POST' })
            .then((r) => r.json())
            .then((j) => { if (j !== null && typeof j === 'object') setState(j) })
            .catch(() => {})
            .finally(() => { setBusy(false) })
        }

        const cancel = () => {
          fetch('/dsh-qq/pair?action=cancel', { method: 'POST' })
            .then((r) => r.json())
            .then((j) => { if (j !== null && typeof j === 'object') setState(j) })
            .catch(() => {})
        }

        const waiting = state?.state === 'waiting'
        const succeeded = state?.state === 'success'

        return react.createElement('div', { className: 'dsh-qq-field' },
          react.createElement('div', { className: 'dsh-qq-row' },
            react.createElement('div', null,
              react.createElement('div', { className: 'dsh-qq-label' }, '扫码绑定机器人'),
              react.createElement('div', { className: 'dsh-qq-note' },
                props.hasCredentials
                  ? '已配置凭据；重新扫码会覆盖为所选机器人的凭据'
                  : '用手机 QQ 扫描二维码，自动获取 AppID 与 AppSecret'),
            ),
            react.createElement('div', { className: 'dsh-qq-actions' },
              waiting
                ? react.createElement('button', { className: 'dsh-qq-btn', onClick: cancel }, '取消')
                : react.createElement('button', { className: 'dsh-qq-btn', disabled: busy, onClick: begin },
                    busy ? '请求中…' : '扫码绑定'),
            ),
          ),

          waiting && state?.qrDataUrl
            ? react.createElement('img', {
                src: state.qrDataUrl,
                alt: 'QQ 绑定二维码',
                style: { width: 200, height: 200, alignSelf: 'center', background: '#fff', padding: 8, borderRadius: 8 },
              })
            : null,

          waiting && !state?.qrDataUrl
            ? react.createElement('div', { className: 'dsh-qq-note' }, '正在获取二维码…')
            : null,

          succeeded
            ? react.createElement('div', { className: 'dsh-qq-note' }, '✅ 绑定成功，凭据已保存。')
            : null,

          state?.state === 'failed' || state?.state === 'unavailable'
            ? react.createElement('div', { className: 'dsh-qq-warn' }, state.error || '扫码绑定失败')
            : null,
        )
      }

      function Card() {        const [cfg, setCfg] = react.useState(null)
        const [live, setLive] = react.useState(null)
        const [saving, setSaving] = react.useState(false)
        const [error, setError] = react.useState('')
        // The secret is write-only: the host never returns it, so a local draft
        // holds whatever the user typed and is cleared after a successful save.
        const [secretDraft, setSecretDraft] = react.useState('')

        react.useEffect(() => {
          let alive = true
          const loadConfig = () => {
            fetch('/dsh-qq/config')
              .then((r) => (r.ok ? r.json() : null))
              .then((j) => { if (alive && j !== null && typeof j === 'object') setCfg(j) })
              .catch(() => {})
          }
          const loadState = () => {
            fetch('/dsh-qq/state')
              .then((r) => (r.ok ? r.json() : null))
              .then((j) => { if (alive && j !== null && typeof j === 'object') setLive(j) })
              .catch(() => {})
          }
          loadConfig()
          loadState()
          const id = setInterval(loadState, 2000)
          return () => { alive = false; clearInterval(id) }
        }, [])

        const save = (patch) => {
          setSaving(true)
          setError('')
          fetch('/dsh-qq/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
          })
            .then(async (r) => {
              const body = await r.json().catch(() => null)
              if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`)
              if (body !== null && typeof body === 'object') setCfg(body)
              if (patch.appSecret !== undefined) setSecretDraft('')
            })
            .catch((e) => { setError(String(e && e.message !== undefined ? e.message : e)) })
            .finally(() => { setSaving(false) })
        }

        if (cfg === null) {
          return react.createElement('div', { className: 'dsh-qq-group' },
            react.createElement('div', { className: 'dsh-qq-title' }, 'QQ 机器人'),
            react.createElement('div', { className: 'dsh-qq-sub' }, '正在读取配置…'),
          )
        }

        const gatewayState = live?.gateway ?? 'stopped'
        const allowText = Array.isArray(cfg.allow) ? cfg.allow.join('\n') : ''
        const allowEmpty = allowText.trim() === ''

        return react.createElement('div', { className: 'dsh-qq-group' },
          react.createElement('div', { className: 'dsh-qq-head' },
            react.createElement('div', null,
              react.createElement('div', { className: 'dsh-qq-title' }, 'QQ 机器人'),
              react.createElement('div', { className: 'dsh-qq-sub' },
                '通过官方 QQ 机器人通道，在手机上直接操控本机 DSH'),
            ),
            react.createElement(Switch, {
              on: cfg.enabled === true,
              onToggle: (v) => save({ enabled: v }),
            }),
          ),

          react.createElement('div', { className: 'dsh-qq-pill' },
            react.createElement('span', { className: 'dsh-qq-dot', 'data-state': gatewayState }),
            `通道：${gatewayState}`,
            live?.conversations !== undefined ? `　会话：${live.conversations}` : '',
            live?.pending !== undefined ? `　待应答：${live.pending}` : '',
          ),

          react.createElement(Field, {
            label: 'AppID',
            value: cfg.appId ?? '',
            placeholder: 'QQ 开放平台的机器人 AppID',
            onChange: (v) => setCfg({ ...cfg, appId: v }),
          }),

          react.createElement(Field, {
            label: cfg.appSecretSet === true ? 'AppSecret（已设置，留空则不修改）' : 'AppSecret',
            secret: true,
            value: secretDraft,
            placeholder: cfg.appSecretSet === true ? '••••••••' : 'QQ 开放平台的机器人 AppSecret',
            onChange: (v) => setSecretDraft(v),
          }),

          react.createElement(Pairing, { hasCredentials: cfg.appSecretSet === true && (cfg.appId ?? '') !== '' }),

          react.createElement(Field, {
            label: 'owner OpenID（可执行 /reset 等管理命令）',
            value: cfg.ownerOpenId ?? '',
            placeholder: '留空时仅私聊可用管理命令',
            onChange: (v) => setCfg({ ...cfg, ownerOpenId: v }),
          }),

          react.createElement(Field, {
            label: '/restart 使用的启动器路径',
            value: cfg.restartCommand ?? '',
            placeholder: '留空 = 自动使用 Documents\\Start-DeepSeek-Harness.cmd（存在才生效）',
            onChange: (v) => setCfg({ ...cfg, restartCommand: v }),
          }),
          react.createElement('div', { className: 'dsh-qq-note' },
            '/restart 会让本进程退出，再由这个启动器拉起新进程；重启完成后插件会把本次进程的新地址发回群里 —— 旧链接一定 404，因为每次启动的 token 都不同。路径写错或文件不存在时命令会拒绝执行，不会把服务停在一个起不来的状态。'),

          react.createElement('div', { className: 'dsh-qq-field' },
            react.createElement('div', { className: 'dsh-qq-label' }, '白名单（每行一个 OpenID：用户或群）'),
            react.createElement('textarea', {
              className: 'dsh-qq-input',
              rows: 3,
              value: allowText,
              placeholder: '留空 = 不放行任何人（推荐先填入你自己的 OpenID）',
              onChange: (event) => setCfg({ ...cfg, allow: event.target.value.split('\n') }),
            }),
          ),

          allowEmpty
            ? react.createElement('div', { className: 'dsh-qq-warn' },
                cfg.allowAllWhenEmpty === true
                  ? '⚠️ 白名单为空且「放行全部」已开启：任何人都能驱动一个拥有 shell 权限的 agent。'
                  : '白名单为空：当前不会放行任何人。给机器人发一条消息后，可从 /dsh-qq/state 查到你的 OpenID。')
            : null,

          react.createElement('div', { className: 'dsh-qq-row' },
            react.createElement('div', { className: 'dsh-qq-label' }, '白名单为空时放行全部'),
            react.createElement(Switch, {
              on: cfg.allowAllWhenEmpty === true,
              onToggle: (v) => save({ allowAllWhenEmpty: v }),
            }),
          ),

          react.createElement('div', { className: 'dsh-qq-row' },
            react.createElement('div', { className: 'dsh-qq-label' }, '允许 agent 主动发 QQ 消息'),
            react.createElement(Switch, {
              on: cfg.allowAgentSend !== false,
              onToggle: (v) => save({ allowAgentSend: v }),
            }),
          ),

          react.createElement('div', { className: 'dsh-qq-field' },
            react.createElement('div', { className: 'dsh-qq-label' }, '长回合进度'),
            react.createElement('div', { className: 'dsh-qq-mode' },
              react.createElement('button', {
                className: 'dsh-qq-btn',
                'data-active': (cfg.progressIntervalMs ?? 0) === 0 ? 'true' : 'false',
                onClick: () => save({ progressIntervalMs: 0 }),
              }, '不推送'),
              react.createElement('button', {
                className: 'dsh-qq-btn',
                'data-active': (cfg.progressIntervalMs ?? 0) > 0 ? 'true' : 'false',
                onClick: () => save({ progressIntervalMs: 120000 }),
              }, '每 2 分钟报一次'),
            ),
            react.createElement('div', { className: 'dsh-qq-note' },
              '回合跑得久时主动推一条「仍在运行：6 分 12 秒 · 第 14 步 · 最近工具 bash」。每条都是一条真实消息，会占用被动窗口、之后占用主动额度，所以默认关闭。'),
          ),

          react.createElement('div', { className: 'dsh-qq-row' },
            react.createElement('div', { className: 'dsh-qq-label' }, '把工具审批转发到 QQ'),
            react.createElement(Switch, {
              on: cfg.forwardApprovals !== false,
              onToggle: (v) => save({ forwardApprovals: v }),
            }),
          ),

          react.createElement('div', { className: 'dsh-qq-row' },
            react.createElement('div', { className: 'dsh-qq-label' }, '把 agent 提问转发到 QQ'),
            react.createElement(Switch, {
              on: cfg.forwardQuestions !== false,
              onToggle: (v) => save({ forwardQuestions: v }),
            }),
          ),

          react.createElement('div', { className: 'dsh-qq-field' },
            react.createElement('div', { className: 'dsh-qq-label' }, '运行模式'),
            react.createElement('div', { className: 'dsh-qq-mode' },
              react.createElement('button', {
                className: 'dsh-qq-btn',
                'data-active': (cfg.mode ?? 'closed-agent') === 'closed-agent' ? 'true' : 'false',
                onClick: () => save({ mode: 'closed-agent' }),
              }, 'closed-agent（仅 owner 私聊，完整工具）'),
              react.createElement('button', {
                className: 'dsh-qq-btn',
                'data-active': cfg.mode === 'chat' ? 'true' : 'false',
                onClick: () => save({ mode: 'chat' }),
              }, 'chat（按白名单，可群聊）'),
            ),
          ),

          react.createElement('div', { className: 'dsh-qq-field' },
            react.createElement('div', { className: 'dsh-qq-label' }, '运行中收到消息'),
            react.createElement('div', { className: 'dsh-qq-mode' },
              react.createElement('button', {
                className: 'dsh-qq-btn',
                'data-active': (cfg.busyDelivery ?? 'steer') === 'steer' ? 'true' : 'false',
                onClick: () => save({ busyDelivery: 'steer' }),
              }, '插入当前回合（steer）'),
              react.createElement('button', {
                className: 'dsh-qq-btn',
                'data-active': cfg.busyDelivery === 'queue' ? 'true' : 'false',
                onClick: () => save({ busyDelivery: 'queue' }),
              }, '排队到下一回合（queue）'),
            ),
            react.createElement('div', { className: 'dsh-qq-note' },
              '插入不等于打断：它不会中止正在跑的那一步（比如一个长工具调用），而是在下一个步骤边界被读到；要立刻停下用 /stop。单条消息可用 /steer、/queue 前缀覆盖这个设置。'),
          ),

          (cfg.mode ?? 'closed-agent') === 'closed-agent' && (cfg.ownerOpenId ?? '') === ''
            ? react.createElement('div', { className: 'dsh-qq-warn' },
                '⚠️ 当前模式需要 owner：尚未设置 owner OpenID，因此不会放行任何人。给机器人发一条消息后，下面会出现你的 OpenID。')
            : null,

          Array.isArray(live?.rejected) && live.rejected.length > 0
            ? react.createElement('div', { className: 'dsh-qq-field' },
                react.createElement('div', { className: 'dsh-qq-label' }, '最近被拒绝的发送者'),
                ...live.rejected.slice(0, 5).map((entry) => react.createElement('div', { className: 'dsh-qq-row', key: entry.key },
                  react.createElement('div', { className: 'dsh-qq-rowtext' },
                    react.createElement('div', { className: 'dsh-qq-label' }, entry.userName || entry.peerId),
                    react.createElement('div', { className: 'dsh-qq-note' }, `${entry.key}　${entry.userId}`),
                  ),
                  react.createElement('div', { className: 'dsh-qq-actions' },
                    entry.userId
                      ? react.createElement('button', {
                          className: 'dsh-qq-btn',
                          onClick: () => save({ ownerOpenId: entry.userId }),
                        }, '设为 owner')
                      : null,
                    react.createElement('button', {
                      className: 'dsh-qq-btn',
                      onClick: () => save({
                        allow: [...new Set([...(cfg.allow ?? []), entry.peerId, entry.userId].filter(Boolean))],
                      }),
                    }, '加入白名单'),
                  ),
                )),
              )
            : null,

          error !== '' ? react.createElement('div', { className: 'dsh-qq-warn' }, `保存失败：${error}`) : null,

          react.createElement('div', { className: 'dsh-qq-actions' },
            react.createElement('button', {
              className: 'dsh-qq-btn',
              disabled: saving,
              onClick: () => {
                const patch = {
                  appId: cfg.appId ?? '',
                  ownerOpenId: cfg.ownerOpenId ?? '',
                  allow: (cfg.allow ?? []).map((s) => String(s).trim()).filter((s) => s !== ''),
                }
                if (secretDraft !== '') patch.appSecret = secretDraft
                save(patch)
              },
            }, saving ? '保存中…' : '保存'),
          ),

          react.createElement('div', { className: 'dsh-qq-note' },
            '官方通道只在群里被 @ 时收到消息，因此无法旁听群聊或读取群历史。'),
        )
      }

      ctx.slots.inject('settings.general.item', () => ctx.slots.register(
        { name: 'settings.general.item', id: 'dsh-qq', order: 60 },
        () => react.createElement(Card),
      ))
    }

    return module.exports
  },
})
