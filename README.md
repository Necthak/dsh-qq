# dsh-qq

**用手机 QQ 操控本机的 DeepSeek Harness。**

QQ 消息变成 DSH 会话里的用户消息；agent 的回复、工具审批请求、`ask_user_question` 提问都会回到 QQ。出门在外，一部手机就能继续驱动 PC 上的 agent。

```
手机 QQ  ──►  QQ 开放平台  ──►  dsh-qq 插件  ──►  DSH agent
   ▲            (官方通道)        (进程内插件)      (本机 shell / 文件)
   └──────────  回复 · 审批 · 提问 · 图片 · 文件  ──────────┘
```

---

## 它能做什么

| 能力 | 说明 |
|---|---|
| **双向对话** | 私聊与群聊走同一条路径；群聊可用全量模式（不必 @ 机器人） |
| **运行中插入消息** | 回合跑着也能把新消息插进当前回合（`steer`），或排到回合结束后（`queue`） |
| **审批与提问回 QQ** | 工具审批给「通过 / 拒绝」按钮；`ask_user_question` 的单选题直接给按钮，点一下就能继续 |
| **图片双向** | 你发的图 agent 看得懂；agent 能截图、发图给你 |
| **文件双向** | 你发的 PDF/zip 会落盘并把路径交给 agent；agent 能把报告、日志、diff 作为文件发回手机 |
| **会话与工作区管理** | `/sessions` 带标题、过滤已归档；`/workspace` 编号菜单；`/new 编号` 一步切项目并开新对话 |
| **额度与用量** | `/usage` 显示各 provider 余额、套餐窗口、今日 tokens 与花费 |
| **截图** | `/screen` 截全屏或指定窗口；agent 也有 `qq_send_screenshot` 工具 |
| **远程重启** | `/restart` 一条消息重启 DSH，并把**本次进程的新地址**发回群里 |
| **崩溃自恢复** | 启动器带一个无窗口看门狗：服务消失 ≤60 秒拉起，并记下死亡时间与现场 |

## 前置条件

- **Windows** —— 截图与看门狗依赖 PowerShell
- **Node 22+** 与 **DSH**（`dsh web` / `--profile web`）
- 一个**官方 QQ 机器人**（QQ 开放平台），并在机器人资料页按需开启群聊通知

## 安装

插件目录：`C:\Users\<你>\Documents\dsh-qq`

```bash
git clone https://github.com/Necthak/dsh-qq.git
cd dsh-qq && npm install
```

挂到 web profile：

1. `~/.dsh/profiles/web/package.json` 的 `dependencies` 加：
   ```json
   "dsh-qq": "link:C:/Users/<你>/Documents/dsh-qq"
   ```
2. `~/.dsh/profiles/web/cordis.patch.yml` 追加：
   ```yaml
   - insert:
       - id: dsh-qq
         name: dsh-qq
   ```
3. 安装并验证：
   ```bash
   cd ~/.dsh/profiles/web && npx pnpm install
   dsh --profile web --dump-config | grep dsh-qq
   ```
4. **重启 DSH web 服务** —— 插件改动需要重启才生效（之后可以直接用 `/restart`）。

## 配置

打开 DSH 设置页 → 通用 → **QQ 机器人** 卡片。

1. **扫码绑定（推荐）** —— 点「扫码绑定」，用手机 QQ 扫码并选择你的机器人。插件通过腾讯官方 `@tencent-connect/qqbot-connector` 拿到该机器人的 **AppID 与 AppSecret** 并自动保存；密钥不经过剪贴板。也可以手工填入，或用环境变量 `DSH_QQ_APPID` / `DSH_QQ_APPSECRET`。
2. **设置 owner** —— 默认模式 `closed-agent` **未设置 owner 时不会放行任何人**（fail-closed）。给机器人发一条消息，它会被拒绝，但会出现在设置卡片的「最近被拒绝的发送者」里，点「设为 owner」即可。该列表只在内存中、30 分钟过期、最多 20 条，**不会向陌生人回消息**。
3. **打开开关** —— 卡片顶部开关打开后通道开始连接，并显示 `通道：online` 与已绑定会话数。

### 运行模式

| 模式 | 准入 | agent 能力 |
|---|---|---|
| `closed-agent`（默认） | 仅 owner 的**私聊**；群聊一律不放行 | 完整工具 |
| `chat` | 按白名单，私聊与群聊都可 | 用于受限聊天场景 |

`deny` 列表在两种模式下都优先于准入判断。

### 其它设置

| 设置 | 默认 | 说明 |
|---|---|---|
| `busyDelivery` | `steer` | 运行中收到消息的去处；单条可用 `/steer`、`/queue` 覆盖 |
| `progressIntervalMs` | `0`（关） | 长回合进度推送间隔；每条都是真实消息，会消耗额度 |
| `lowBalanceThreshold` | `5` | 余额低于此值每天提醒一次；`0` 关闭 |
| `workspacePath` | 空 | QQ 新会话的工作目录；空 = DSH 进程目录 |
| `agentPreset` | 空 | QQ 会话使用的 agent preset |
| `allowAgentSend` | `true` | 是否允许 agent 主动发 QQ 消息 |
| `forwardApprovals` / `forwardQuestions` | `true` | 是否把审批 / 提问转发到 QQ |
| `restartCommand` | 空 | `/restart` 使用的启动器路径；空则只在 `Documents\Start-DeepSeek-Harness.cmd` 存在时采用 |

## 命令

在 QQ 里直接发消息即可，以下为桥接内建命令：

| 命令 | 说明 |
|---|---|
| `/help` | 显示帮助 |
| `/status` | 通道状态、已绑定会话数、待应答交互数、当前模型、最近一次发送失败、当前回合进度 |
| `/model` | 列出可用模型（按提供方分组、编号）；`←` 标记当前 |
| `/model <编号> [强度]` | 切换模型（仅 owner） |
| `/new`、`/reset` | 开新对话（仅 owner）。旧对话不丢：`/sessions` + `/resume` 可回去 |
| `/new <编号>` | 切到该工作区并开新对话，一步到位 |
| `/stop` | 中止正在运行的回合（仅 owner；收件箱消息保留） |
| `/steer <内容>` | 把内容插入**正在运行**的回合 |
| `/queue <内容>` | 排队到当前回合结束之后 |
| `/workspace` | 列出已登记项目（带编号）+ 当前目录 |
| `/workspace <编号\|路径>` | 切换新会话的工作目录（仅 owner） |
| `/sessions [数量]` | 列出最近会话（带标题、已归档的不列出） |
| `/resume <编号\|会话ID>` | 把本对话切到某个已有会话（仅 owner） |
| `/usage` | 额度与用量：余额、套餐窗口、今日 tokens 与花费 |
| `/screen [进程名]` | 截图并发到本对话（仅 owner） |
| `/restart`、`/restart force` | 重启 DSH 进程（仅 owner；回合运行中需 `force`） |

## agent 可用的工具

| 工具 | 说明 |
|---|---|
| `qq_send_message` | 发消息到当前 QQ 会话 |
| `qq_reply` | 引用某条消息回复 |
| `qq_send_image` | 发图（png / jpeg） |
| `qq_send_file` | 发任意文件（报告、日志、diff；软限 200MB） |
| `qq_send_screenshot` | 截屏或截指定窗口并发送 |
| `qq_get_status` | 只读状态 |

发送类工具**强制白名单**：目标必须是已存在的会话且当前仍被准入，agent 无法指定任意接收者。通过工具发出的消息会抑制该回合的自动转发，避免重复。

## 它是怎么工作的

插件跑在 **DSH 进程内**，直接用 DSH 自己的服务，因此不需要维护 Cookie、探活、单实例锁或 MCP 配置：

| 用到的 DSH 服务 | 用途 |
|---|---|
| `ctx.sessionController` | 创建会话、投递 prompt、切换模型、取消回合 |
| `ctx.on('session/event')` | 按 turn 收集 agent 输出 |
| `ctx.on('approval/request')` / `user-questions/request` | 从 QQ 应答 agent 的提问 |
| `ctx.tools` | 给 agent 注册 QQ 工具 |
| `ctx.sessionProjections` | 读模型选择、权限、会话标题、用量等投影 |
| `ctx.settings` / `ctx.webServer` | 设置卡片与控制台路由 |
| `ctx.workspaceRegistry` | 项目列表与归档会话集合 |

模块划分（`lib/`）：

```
index.js        插件入口：settings、生命周期、接线
client.js       设置卡片（浏览器半，手写免构建）
console.js      /dsh-qq/{state,config,pair} 路由
pairing.js      扫码绑定
md-to-plain.js  Markdown → 纯文本、按字节分条
qq/             token · OpenAPI · WebSocket 网关 · 事件归一化
bridge/         准入 · 投递 · 会话表 · 出站队列 · 挂起交互 · 命令 · 工具 · 截图 · 额度 · 重启
```

设计与实现细节见 **[docs/design-notes.md](docs/design-notes.md)**；运维、排障与踩坑记录见 **[docs/operations.md](docs/operations.md)**。

## 已知边界

官方 API 确实做不到的：

- **群历史读取** —— 没有对应接口（全量模式只给开启之后的消息）
- **仿真群友 / 社交状态机** —— 拿不到更早的上下文
- **频道（文字子频道 / 频道私信）** —— 未实现

这些需要 OneBot / SnowLuma 那类个人号协议（有封号风险）。代码里 `lib/qq/` 已按通道隔离，将来加后端不必动 `lib/bridge/`。

平台约束（实现已处理）：

- 被动回复窗口：单聊 60 分钟 / 4 次，群聊 5 分钟 / 5 次；超出后自动降级为主动消息
- 主动消息受频控（20/qpm、1000 条/天/关系），且**用户可在 QQ 客户端关闭「允许主动发送」** —— 关闭后主动消息一律失败
- 平台只渲染 png / jpeg 图片；其它格式在上传前就拒绝
- 相同 `msg_id` 可能重复推送；`msg_id + msg_seq` 重复发送会失败

## 开发

```bash
npm test          # 295 个单元测试
npm run lint      # 若已配置
```

- 测试全部离线：HTTP、WebSocket、DSH 服务都是注入的替身
- 改动插件代码后，在 QQ 里发 `/restart` 即可重新加载（新进程从磁盘 import）
- 提交前请确保 `npm test` 全绿

## 许可

尚未指定。要开源请先加一个 `LICENSE`（例如 MIT）—— 没有许可默认是「保留所有权利」。
