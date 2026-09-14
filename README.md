# dsh-qq

**简体中文** | [English](README.en.md)

[![test](https://github.com/Necthak/dsh-qq/actions/workflows/test.yml/badge.svg)](https://github.com/Necthak/dsh-qq/actions/workflows/test.yml) [![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![node](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen.svg)](https://nodejs.org)

通过官方 QQ 机器人在移动端操控本机 DeepSeek Harness 的 DSH 插件。

QQ 消息被投递为 DSH 会话中的用户消息；agent 的回复、工具审批请求与 `ask_user_question` 提问均回传至 QQ。其目的是使远程场景下的 agent 驱动不必依赖桌面环境。

```
手机 QQ  ──►  QQ 开放平台  ──►  dsh-qq 插件  ──►  DSH agent
   ▲            (官方通道)        (进程内插件)      (本机 shell / 文件)
   └──────────  回复 · 审批 · 提问 · 图片 · 文件  ──────────┘
```

---

## 功能

| 能力 | 说明 |
|---|---|
| 双向对话 | 私聊与群聊共用同一投递路径；群聊支持全量消息模式（无需 @ 机器人） |
| 运行中投递 | 回合执行期间可插入消息（`steer`），或排队至回合结束后（`queue`） |
| 审批与提问回传 | 工具审批下发「通过 / 拒绝」按钮；`ask_user_question` 单选题以按钮呈现 |
| 图片双向传输 | 入站图片内联为模型可见内容；出站支持截图与图片发送 |
| 文件双向传输 | 入站附件落盘并将路径交由 agent；出站支持任意文件（报告、日志、diff） |
| 会话与工作区管理 | `/sessions` 展示标题并过滤已归档会话；`/workspace` 为编号菜单；`/new <编号>` 一步切换项目并新建会话 |
| 额度与用量 | `/usage` 展示各 provider 余额、套餐窗口、近期日均花费与余额可用天数、当日 tokens 及花费 |
| 截图 | `/screen` 截取全屏或指定窗口；agent 侧提供 `qq_send_screenshot` 工具 |
| 远程重启 | `/restart` 一条消息完成进程重启，并将本次进程的新地址回传至原对话 |
| 崩溃自恢复 | 启动器附带的看门狗在服务消失后 60 秒内将其重新启动，并记录发生时间与现场信息 |

## 前置条件

- **Windows**：截图与看门狗依赖 PowerShell
- **Node.js 22+** 与 **DSH**（`dsh web` 或 `--profile web`）
- 一个**官方 QQ 机器人**（QQ 开放平台），并按需在机器人资料页开启群聊通知

## 安装

假设插件目录为 `C:\Users\<用户名>\Documents\dsh-qq`：

```bash
git clone https://github.com/Necthak/dsh-qq.git
cd dsh-qq && npm install
```

挂载至 web profile：

1. 在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 中加入：
   ```json
   "dsh-qq": "link:C:/Users/<用户名>/Documents/dsh-qq"
   ```
2. 在 `~/.dsh/profiles/web/cordis.patch.yml` 中追加：
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
4. 重启 DSH web 服务。插件代码的改动需要重启方能生效；此后可使用 `/restart` 完成。

## 配置

打开 DSH 设置页 → 通用 → **QQ 机器人** 卡片。

1. **扫码绑定（推荐）**：点击「扫码绑定」，使用手机 QQ 扫描二维码并选择机器人。插件通过腾讯官方 `@tencent-connect/qqbot-connector` 获取该机器人的 AppID 与 AppSecret 并自动保存，密钥不经过剪贴板。亦支持手工填写，或使用环境变量 `DSH_QQ_APPID` / `DSH_QQ_APPSECRET`。
2. **设置 owner**：默认模式 `closed-agent` 在未设置 owner 时**不放行任何发送者**（fail-closed）。向机器人发送一条消息，该消息会被拒绝，但发送者会出现在设置卡片的「最近被拒绝的发送者」列表中，点击「设为 owner」即可。该列表仅存于内存、30 分钟过期、最多 20 条，且不向陌生人回复。
3. **启用通道**：打开设置卡片顶部开关后通道开始连接，卡片显示 `通道：online` 与已绑定会话数。

### 运行模式

| 模式 | 准入范围 | agent 能力 |
|---|---|---|
| `closed-agent`（默认） | 仅 owner 的私聊；群聊一律不放行 | 完整工具集 |
| `chat` | 依白名单，私聊与群聊均可 | 适用于受限聊天场景 |

`deny` 列表在两种模式下均优先于准入判断。

### 主要设置项

| 设置 | 默认值 | 说明 |
|---|---|---|
| `busyDelivery` | `steer` | 运行中收到消息的投递方式；单条消息可用 `/steer`、`/queue` 覆盖 |
| `markdownMode` | `auto` | 消息编码：`auto` 在平台能忠实渲染时使用 markdown（表格除外，QQ 不渲染表格，会退回纯文本），`always` 强制，`never` 全部转纯文本 |
| `progressIntervalMs` | `0`（关闭） | 长回合进度推送间隔。每条推送均为真实消息，会消耗发送额度 |
| `lowBalanceThreshold` | `5` | 余额低于此值时每日提醒一次；`0` 表示关闭 |
| `workspacePath` | 空 | QQ 新建会话的工作目录；为空时使用 DSH 进程目录 |
| `agentPreset` | 空 | QQ 会话使用的 agent preset |
| `allowAgentSend` | `true` | 是否允许 agent 主动发送 QQ 消息 |
| `forwardApprovals` / `forwardQuestions` | `true` | 是否将审批与提问转发至 QQ |
| `restartCommand` | 空 | `/restart` 使用的启动器路径；为空时仅在 `Documents\Start-DeepSeek-Harness.cmd` 存在时采用 |

## 命令

在 QQ 中直接发送以下命令。未以 `/` 开头的消息将作为普通输入投递给 agent。

**不打斜杠也可以。** 整条消息恰为命令名本身时即为该命令，**大小写不敏感**：`status`、`usage`、`todos`、`sessions`、`doctor`、`screen`、`log`、`menu`、`help`、`new`、`find`、`model`、`workspace`、`resume`、`stop`、`restart`。中文各有一个对应词，**一词一命令、不设同义词**（同义词表比命令本身更难记）：`状态`、`额度`、`任务`、`会话`、`继续`、`模型`、`搜索`、`诊断`、`截图`、`日志`、`重启`、`停止`、`新对话`、`重置`、`工作区`、`菜单`、`帮助`。匹配要求**整条消息完全相同**，所以「任务完成了」不会被当成命令；这些词也可以**用语音说**，平台会转写成同样的文本（下拉面板点不了语音，这是它俩的主要区别）。**消息开头的 @ 提及会被忽略**，所以群里 `@机器人 /usage` 与「@机器人 状态」同样有效。

| 命令 | 说明 |
|---|---|
| `/help` | 显示帮助 |
| `/menu install` | 安装或更新 `/` 下拉选择器里的**平台指令面板**（仅 owner）：点一项会把命令填进输入框，再按发送；每次启动会自动刷新已有面板 |
| `/status` | 通道状态、已绑定会话数、待应答交互数、当前模型、最近一次发送失败、当前回合进度 |
| `/model` | 列出可用模型（按提供方分组并编号），`←` 标记当前模型 |
| `/model <编号> [强度]` | 切换模型（仅 owner） |
| `/new`、`/reset` | 新建对话（仅 owner）。原对话保留，可通过 `/sessions` 与 `/resume` 返回 |
| `/new <编号>` | 切换至该工作区并新建对话 |
| `/stop` | 中止正在运行的回合（仅 owner；收件箱中的消息保留） |
| `/steer <内容>` | 将内容插入正在运行的回合 |
| `/queue <内容>` | 将内容排队至当前回合结束后 |
| `/workspace` | 列出已登记项目（含编号）与当前工作目录 |
| `/workspace <编号\|路径>` | 切换新建会话的工作目录（仅 owner） |
| `/sessions [数量]` | 列出最近会话（含标题，不含已归档会话） |
| `/find <关键词>` | 在会话内容中搜索；结果即为当前 `/resume` 列表，可直接切换 |
| `/resume <编号\|会话ID>` | 将本对话切换至指定会话（仅 owner） |
| `/usage` | 额度与用量：余额、套餐窗口、近期日均花费与余额可用天数、当日 tokens 与花费 |
| `/screen [进程名]` | 截图并发送至本对话（仅 owner） |
| `/log [行数]` | 查看最近的本插件日志（仅 owner，默认 15 条，最多 40） |
| `/doctor` | 主动自检：通道、看门狗、凭据、owner、余额、会话与发送失败（仅 owner） |
| `/todos` | 查看 agent 本轮的任务清单与进度（读取 DSH 的任务投影） |
| `/restart`、`/restart force` | 重启 DSH 进程（仅 owner；回合运行中需 `force`） |

## agent 工具

| 工具 | 说明 |
|---|---|
| `qq_send_message` | 发送消息至当前 QQ 会话 |
| `qq_reply` | 引用指定消息回复 |
| `qq_send_image` | 发送图片（png / jpeg） |
| `qq_send_file` | 发送任意文件（报告、日志、diff；软限 200MB） |
| `qq_send_screenshot` | 截取屏幕或指定窗口并发送 |
| `qq_get_status` | 只读状态 |

发送类工具受**强制白名单**约束：目标必须是已存在且当前仍被准入的会话，agent 无法指定任意接收者。经由工具发送的消息会抑制该回合的自动转发，以避免重复。

## 实现架构

插件运行于 **DSH 进程内**，直接使用 DSH 自身的服务，因此无需维护会话 Cookie、探活、单实例锁或 MCP 配置：

| DSH 服务 | 用途 |
|---|---|
| `ctx.sessionController` | 创建会话、投递 prompt、切换模型、取消回合 |
| `ctx.on('session/event')` | 按 turn 收集 agent 输出 |
| `ctx.on('approval/request')` / `user-questions/request` | 从 QQ 应答 agent 的提问 |
| `ctx.tools` | 为 agent 注册 QQ 工具 |
| `ctx.sessionProjections` | 读取模型选择、会话标题、用量等投影 |
| `ctx.settings` / `ctx.webServer` | 设置卡片与控制台路由 |
| `ctx.workspaceRegistry` | 项目列表与归档会话集合 |

模块划分（`lib/`）：

```
index.js        插件入口：settings、生命周期、接线
client.js       设置卡片（浏览器侧，免构建）
console.js      /dsh-qq/{state,config,pair} 路由
pairing.js      扫码绑定
md-to-plain.js  Markdown → 纯文本转换、按字节分条
qq/             token · OpenAPI · WebSocket 网关 · 事件归一化
bridge/         准入 · 投递 · 会话表 · 出站队列 · 挂起交互 · 命令 · 工具 · 截图 · 额度 · 重启
```

设计说明见 **[docs/design-notes.md](docs/design-notes.md)**；运维与排障见 **[docs/operations.md](docs/operations.md)**。两份文档的英文版分别为 [design-notes.en.md](docs/design-notes.en.md) 与 [operations.en.md](docs/operations.en.md)。

## 已知限制

官方 API 不支持的能力：

- **群历史读取**：无对应接口；全量模式仅提供开启之后的消息
- **仿真群友 / 社交状态机**：无法获取更早的上下文
- **频道（文字子频道 / 频道私信）**：未实现

上述能力需要 OneBot / SnowLuma 等个人号协议，存在账号风险。代码中 `lib/qq/` 已按通道隔离，新增后端无需改动 `lib/bridge/`。

平台约束（实现中已处理）：

- 被动回复窗口：单聊 60 分钟 / 4 次，群聊 5 分钟 / 5 次；超限后自动降级为主动消息
- 主动消息受频控（20/qpm、1000 条/天/关系），且用户可在 QQ 客户端关闭「允许主动发送」，关闭后主动消息一律失败
- 平台仅渲染 png / jpeg 图片，其它格式在上传前即被拒绝
- 相同 `msg_id` 可能重复推送；`msg_id` 与 `msg_seq` 组合重复发送会失败

## 开发

```bash
npm test          # 309 个单元测试
```

- 测试全程离线：HTTP、WebSocket 与 DSH 服务均以替身注入
- 插件代码改动后，可在 QQ 中发送 `/restart` 重新加载（新进程自磁盘导入）
- 提交前请确保 `npm test` 全部通过；CI（`.github/workflows/test.yml`）会在 Windows 上以 Node 22 与 24 各跑一遍

## 许可

本项目采用 [MIT 许可证](LICENSE)。
