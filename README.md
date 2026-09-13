# dsh-qq

通过**官方 QQ 机器人**在手机上直接操控本机的 DeepSeek Harness。

QQ 消息变成 DSH 会话里的用户消息；agent 的回复、工具审批请求、以及 `ask_user_question` 提问都会回到 QQ。出门在外用手机 QQ 就能继续驱动 PC 上的 agent。

```
iPhone QQ  ──►  QQ 开放平台  ──►  dsh-qq 插件  ──►  DSH agent
   ▲             (官方通道)         (进程内)          (本机 shell/文件)
   └──────────── 回复 / 审批 / 提问 ────────────────────┘
```

---

## 为什么是「进程内插件」而不是独立桥接进程

这不是实现偏好，而是被 DSH 的鉴权模型决定的：

DSH 的 `/api` 对**每一个请求**都强制校验一个签名 Cookie（`dsh-client-connection/lib/index.js` 中 `requestRejection` 先过 Host 围栏再 `browserAuth.isAuthenticated`），而该 Cookie 需要用**进程启动令牌**换取、且按 authority 绑定。**外部进程拿不到这个令牌**，因此任何「独立桥接进程通过 /api 连 DSH」的方案都要额外解决一个本不该存在的问题。

做成进程内插件后：

| 独立进程方案需要 | 插件方案 |
|---|---|
| 拿到并维护签名 Cookie | 不需要 —— 直接调 `ctx.sessionController` |
| 探活 DSH、断线补投队列 | 不需要 —— 与 DSH 同生命周期 |
| 单实例锁 | 不需要 |
| MCP 配置（给 agent 提供 QQ 工具） | 不需要 —— `ctx.tools.register` 原生工具 |
| 自建控制台端口 + 自管令牌 | 不需要 —— 复用 DSH 已有的令牌 Cookie 与 Host 围栏 |

它直接使用 DSH 自己的服务：

- `ctx.sessionController` —— 创建会话、投递 prompt
- `ctx.on('session/event')` —— 按 turn 收集 agent 输出
- `ctx.on('approval/request')` / `ctx.on('user-questions/request')` —— 从 QQ 应答 agent 的提问
- `ctx.tools` —— 让 agent 主动发 QQ 消息
- `ctx.settings` / `ctx.webServer` —— 设置卡片与控制台

---

## 安装

插件目录：`C:\Users\<你>\Documents\dsh-qq`

```bash
cd dsh-qq && npm install
```

挂到 web profile（与 `dsh-fat-fish-pet` 同样的方式）：

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
4. **重启 DSH web 服务**（改动需要重启才生效）。

> `dsh-qq` 不进 `dsh.profile.bundles`，只作为依赖 + `cordis.patch.yml` 的 insert —— 与 `dsh-fat-fish-pet` 一致。

---

## 配置

打开 DSH 设置页 → 通用 → **QQ 机器人** 卡片。

### 1. 扫码绑定（推荐）

点「扫码绑定」，用手机 QQ 扫描出现的二维码，选择你的机器人。插件会通过腾讯官方 `@tencent-connect/qqbot-connector` 拿到该机器人的 **AppID 与 AppSecret** 并自动保存。

这条路径比手工复制密钥更好：密钥不经过剪贴板，且拿到的一定是你在扫码页上选中的那个机器人的凭据。这也是官方文档里 WorkBuddy / QClaw / OpenClaw / Hermes 用的同一套流程。

也可以手工填入 AppID/AppSecret，或用环境变量 `DSH_QQ_APPID` / `DSH_QQ_APPSECRET`。

### 2. 设置 owner

**默认模式 `closed-agent` 需要 owner，未设置 owner 时不会放行任何人**（fail-closed）。

给机器人发一条消息 —— 它会被拒绝，但会出现在设置卡片下方的「最近被拒绝的发送者」列表里，点「设为 owner」即可。这个列表只记录在内存里、30 分钟过期、最多 20 条，**不会向陌生人回消息**。

### 3. 打开开关

设置卡片顶部的开关打开后，通道开始连接；卡片上会显示 `通道：online` 与已绑定会话数。

### 运行模式

| 模式 | 准入 | agent 能力 |
|---|---|---|
| `closed-agent`（默认） | 仅 owner 的**私聊**；群聊一律不放行 | 完整工具 |
| `chat` | 按白名单，私聊与群聊都可 | 用于受限聊天场景 |

`deny` 列表在两种模式下都优先于准入判断。

---

## 使用

在 QQ 里直接发消息即可。桥接内建命令：

| 命令 | 说明 |
|---|---|
| `/help` | 显示帮助 |
| `/status` | 通道状态、已绑定会话数、待应答交互数、当前模型、最近一次发送失败 |
| `/model` | 列出可用模型（按提供方分组、编号）；`←` 标记当前模型 |
| `/model <编号>` | 切换模型；`/model <编号> <强度>` 同时指定推理强度，也接受 `模型id` 或 `提供方/模型id`（仅 owner） |
| `/new`、`/reset` | 开新对话（仅 owner）。旧对话不丢：`/sessions` + `/resume` 可以回去 |
| `/new <编号>` | 一步到位：先切到该工作区，再开新对话（编号来自 `/workspace` 列表） |
| `/stop` | 中止正在运行的回合（仅 owner；收件箱里的消息会保留，之后继续） |
| `/steer <内容>` | 把内容**插入正在运行的回合**，不必等它跑完 |
| `/queue <内容>` | 反过来：排队到当前回合结束之后 |
| `/workspace` | 列出**已登记的项目**（带编号与路径）＋当前新会话目录＋当前会话目录 |
| `/workspace <编号>` | 切到列表里的第 N 个项目 —— 手机上不用敲路径（仅 owner） |
| `/workspace <路径>` | 直接给绝对路径（含空格不用引号）（仅 owner） |
| `/sessions [数量]` | 列出最近会话（**带标题**，与桌面侧栏一致；**已归档的不列出**），编号供 `/resume` 使用 |
| `/resume <编号\|会话ID>` | 把本对话切到某个已有会话，上下文随之切换（仅 owner） |
| `/usage` | **额度与用量**：各 provider 余额、套餐窗口（5 小时/本周/本月）、今日 tokens 与花费 |
| `/screen [进程名]` | 截图并发到本对话（仅 owner；不带参数截全屏） |
| `/restart` | 重启 DSH 进程（先自检插件能否加载），回来后把**本次进程的新地址**发到本对话（仅 owner） |
| `/restart force` | 回合正在运行时的确认形式；不加 `force` 会被拒绝 |

切换模型、切换会话、改工作区**都不需要重启 DSH**：模型与会话是运行时可变的，改完下一条消息即生效。

### 两个"保护本身也要可观测"的检查

额度用完不会有单独的提示：agent 只是**在任务中途开始报错**，而在手机上那和任何别的错误长得一样。看门狗死了也一样：保护链是「启动器 → 看门狗 → 服务」，**看门狗单独死掉时服务还活着**，于是你以为崩溃会被自动修复，实际上没人在看。

所以心跳 tick（每 15 秒，本来就是醒着的）顺带做两件节流后的家务：

| 检查 | 频率 | 行为 |
|---|---|---|
| 余额 | 每小时 | 低于 `lowBalanceThreshold`（默认 ¥5，0 = 关闭）时**每天提醒一次**；同一账户被两个 provider id 重复报告只提醒一次 |
| 看门狗 | 每 5 分钟 | PID 文件存在但进程已死 → 写日志 + 通知 + **用无窗口的 spawner 把它拉回来**；PID 文件不存在 = 这个部署本来就没装看门狗，不打扰 |

### `/usage` 读的是 DSH 自己的账本

不要重新去调 provider 的接口，也不要展示"本会话 12 轮 86 步"这类没人能据以行动的数字。DSH 已经把要的东西算好了：

| 文件 | 内容 |
|---|---|
| `~/.dsh/dsh-usage/provider-snapshots.json` | 各 provider 的**余额**与**套餐窗口**（百分比 + 重置时间） |
| `~/.dsh/dsh-usage/usage-ledger.json` | 按**天 / provider / 模型**的输入、输出、缓存命中 tokens 与花费 |

于是手机端与桌面端不可能出现两种说法，而桥接**自己不经手任何凭据** —— 它不调 provider，只是读 DSH 已经取回的答案。两个细节：**同一账户被两个 provider id 重复报告时只显示一次**（`deepseek` 与 `deepseek-official` 报的是同一个 ¥20.23，显示两遍会被读成两个账户）；**只有余额、没有额度也说不出来、今天也没用过的 provider 不出现**（部署里认得的 provider 有一堆，全列出来就是噪音）。

### 会话与工作区的手机端用法

`/sessions`、`/workspace` 都做成**编号菜单**，因为手机上敲绝对路径和认时间戳都不现实：

- `/sessions` 用**标题**标识每个对话（读的是桌面侧栏同一个 `title` 投影），**已归档的会话不列出** —— 归档的意义就是"别再给我看"，手机端列出来会让桌面上的归档白做；取不到标题时退回「短 id · 目录名」，不会空着也不会编一个
- `/workspace` 列出**已登记的项目**（`workspaceRegistry.list()`，与桌面侧栏同一份数据），标出当前设置的那一项，并额外显示**当前会话**的工作目录（来自会话列表的 `cwd`）
- `/new <编号>` = 切工作区 + 开新对话，一步。编号无效时**整条命令拒绝**：只做一半会让你以为两件都成了
- 开新对话（`/new`）不会丢旧的：桥接只解除绑定，`/sessions` + `/resume` 随时回去

### 从 QQ 重启（`/restart`）

改了插件代码、或者进程卡住了，以前必须回到桌面：关掉服务窗口 → 双击启动脚本 → 等就绪 → 再找那个带 token 的标签页。`/restart` 把这一串收成一条消息。

七个关键点：

1. **`detached: true` 在这台机器上是坏的 —— 这是它两次失败的真因。** 实测：`spawn('powershell.exe', ..., { detached: true })` **退出码 0、无输出、无副作用、连 `error` 事件都没有** —— 重启器压根没跑，`/restart` 于是变成了一次纯关机。改成 `cmd /c start "" /min powershell -File <脚本>`：脚本落到 `~/.dsh/dsh-qq-restart.ps1`（多行带引号的 PowerShell 塞进 `start` 的参数里迟早出解析事故，路径就一个参数、不会看错），而且 `start` 会给它**自己的控制台** —— 这点是必须的：`dsh web` 跑在本进程的控制台里，本进程一退出那个控制台就关闭，仍挂在上面的进程会被一起带走。
2. **必须先让端口空出来。** 启动脚本的判据是「3080 有人在听 → 认为服务已在运行 → 只开浏览器」。所以插件不是直接调启动器，而是先拉起一个 PowerShell，**由它轮询到端口不再接受连接之后**才去跑启动器 —— 否则重启会静默地变成"又开了一个标签页"。
3. **确认消息必须先发出去。** 进程马上就死了，还压在发送队列里的消息等于没发。所以顺序是：`prepare()` 判断能不能重启（不能就明确拒绝，**绝不把服务停在一个起不来的状态**）→ 发确认 → `go()` 写标记、spawn、延时 2 秒退出。
4. **地址必须主动推回来。** 每次启动的 token 都不同，所以旧链接**一定 404**（这不是坏了，是设计）——`connection.authenticatedUrl()` 是唯一能拿到「本次真正能认证的 URL」的接口。插件在进程死前把「谁问的」写进 `~/.dsh/dsh-qq-restart.json`，新进程在 QQ 通道回到 `online` 的那一刻把新地址发回那个对话。标记读完即删：**一次重启恰好一条通知**，普通启动一条都不发。
5. **每一步都要留证。** 重启发生在没人看着机器的时候，而它的两种失败方式 —— 启动器压根没跑、跑起来了但服务没回来 —— 从 QQ 上看完全一样。所以那个隐藏 PowerShell 把每一步（等端口释放 → 拉起启动器 → 等端口重新监听）都写进 `~/.dsh/dsh-qq-restart.log`，重启后的通知再把最后两行**原样带回群里**：是「启动器拉起的」还是「你自己手动开的」，一眼可辨。

6. **重启前先自检。** `/restart` 现在是加载代码改动的**唯一通道**，这让一个坏改动变得不可恢复：新进程挂不上插件，桥接再也回不来，而你只能回到这个命令本来要帮你避开的桌面。所以真正交接之前，先在**子进程**里把 `lib/index.js` 的整条依赖图 `import()` 一遍（实测健康时 107ms，坏改动时给出 `ERR_MODULE_NOT_FOUND` 原文），失败就**拒绝重启**，让还能说话的桥接把错误发给你。用子进程而不是进程内 `import()`：模块是带缓存的，而值得抓的那几类失败（语法错、缺导出、顶层 await 卡住）恰好是能把加载器一起带走的。
7. **回合运行中要二次确认。** 重启会连同收件箱丢掉正在跑的回合，且没有 undo。运行中发 `/restart` 会得到一条说明 + `/restart force` 的提示 —— 手机上太容易手滑，而代价是几分钟的工作。

启动器路径由设置卡片里的「重启命令」决定，留空时只在 `Documents\Start-DeepSeek-Harness.cmd` **确实存在**时才采用 —— 路径写错就拒绝，不猜。

> `/restart` 本身就是「重新加载插件代码」：新进程会重新从磁盘 import。所以改完 `dsh-qq` 之后直接发一条 `/restart` 就行，不必再回桌面。

> 切换模型同时会把该模型写回 `agent-default-model`，因此它也会成为**新会话**的默认模型 —— 这是 DSH `selectModel` 的既定行为，桌面 `/model` 弹窗完全一致。

- agent 请求**工具审批**时，QQ 收到提示，**点「通过 / 拒绝」按钮**即可（也可以回复文字）。回复其它内容会重新提示，不会误判。
- agent 调 **`ask_user_question`** 时，问题与编号选项会转发到 QQ；**单选题直接给按钮**，多选题保留「序号. 答案」文字协议（只有文字能指明答案属于哪个问题）。回复编号、选项文字或自由文本都可以。
- **长回合可见**：`/status` 的「当前回合」会给出「已运行 6 分 12 秒 · 第 14 步 · 最近工具 bash」（事实来自 `turn/start`、`step/start`、`tool/call`、`turn/end`，不需要 Host 多提供任何东西）。插件重载后才接管的回合**不报步数**（「本进程接管前的步数未知」）—— 报一个错的步数比不报更糟。设置卡片里还能开「长回合进度」，每 2 分钟主动推一条同样的信息（默认关：每条都是真实消息，先花被动窗口，再花主动额度）。
- `/model` 的列表带**数字键盘**，点数字即切换；切换后如果该模型有推理强度，会再给一排强度按钮。
- 审批与提问同时**保留桌面端入口**：插件不会独占瀑布链，而是把下游应答者一并启动，哪边先答哪边生效；QQ 侧超时未答则交回桌面端。

### agent 正在跑的时候发消息

一次带工具调用、思考强度 `max` 的回合可以跑好几分钟。这期间发来的 QQ 消息有两种去处，由**设置卡片的「运行中收到消息」**决定，单条消息可以用 `/steer`、`/queue` 前缀覆盖：

| 投递 | DSH 内部 | 落点 | 什么时候被读到 |
|---|---|---|---|
| `steer`（默认） | `agent.steer()` | `next-step` 收件箱 | **当前回合的下一个步骤边界** |
| `queue` | `agent.followup()` | `next-turn` 收件箱 | 当前回合**整轮结束之后** |

三条边界值得先知道，免得把 `steer` 当成「打断」：

1. **`steer` 不中止正在跑的那一步。** 它不 abort 当前步骤的模型请求：如果此刻卡在一个五分钟的 bash 工具调用里，消息要等那个调用返回。要立刻停下是 `/stop`。
2. **`steer` 也不结束回合。** `agent/turn-stopping` 只在 `next-step` 收件箱为空时才收尾，所以插进去的消息会让当前回合继续（DSH README 原话：工具调用或 steering 会让当前回合继续）。
3. **`/stop` 不会丢掉插进去的消息。** Session Controller 的取消带 `keepInbox: true`，收件箱保留，等取消静默后按 FIFO 继续。

实现上的两个细节：

- **只有「确实在跑」才 `steer`。** 判忙读 `ctx.agents.get(sessionId)?.status`（经 `ctx.get` 懒读，缺服务时返回 `null` = 不知道）。空闲、冷会话、注册表不可读一律退回 `queue` —— 排队最多是慢，不会错。反方向的竞态（判忙之后回合刚好结束）由 driver 兜底：`send()` 发现 phase 已 abort 就把 `steer` 降级成下一回合，不会失败。
- **带前缀的消息不喂给挂起交互。** `/steer 通过` 的意思是「把这三个字插进去」，如果被当成审批的答案就正好反了。命令 → 挂起交互 → prompt 的顺序里，前缀消息跳过第二步。

群聊与私聊**走同一条路径**（`conversationKey(kind, peerId)`），投递模式不看会话类型；差别只在准入：`closed-agent` 模式下群聊根本不放行，`chat` 模式 + 白名单才放行群聊。被放行的人在群里也能插入当前回合 —— 与排队消息相比只是生效更早，话语权本身没有变化；不接受这一点就把设置改回 `queue`。

> 附带好处：`steer` 到达时回复游标会推进到最新那条消息，群聊 5 分钟的被动窗口因此被刷新 —— 长回合最容易踩的「msgid 已经过期」正是这么来的。

agent 可主动使用的工具：

| 工具 | 说明 |
|---|---|
| `qq_send_message` | 发消息（默认发给本会话所属的 QQ 会话） |
| `qq_reply` | 引用某条消息回复 |
| `qq_send_image` | 发图（png / jpeg）到 QQ：截图、图表、diff 这类「看一眼就够」的结论（已对真实平台验证：上传 884ms、图片确认送达） |
| `qq_send_file` | 发**任意文件**（报告、日志、diff，软限 200MB）：长回答不该刷屏成十几条消息 |
| `qq_send_screenshot` | 截当前屏幕或指定窗口并发送（默认全屏；`process`/`title` 可只截某个窗口） |
| `qq_get_status` | 只读状态 |

**入站附件也会落盘。** 以前非图片附件到达 agent 时只是**一行文字**（`[附件：报告.pdf 230KB]`），内容读不到；现在会下载到 `%TEMP%\dsh-qq-files\`，并把**路径**写进提示，agent 就能真的打开它。同样保留一天，每次入站顺手清理。语音不用管：平台已把转写文本内联进提示。

发图/发文件走的是**分片上传**：本地文件没有第二条路 —— 直传形式只接受一个公网 `url`（平台自己去下载），而接口**根本没有 base64 字段**。所以流程是：算 `md5`/`sha1`/`md5_10m` → `upload_prepare` 拿分片预签名 URL → 逐片 HTTP PUT（**不带** `Authorization`，预签名 URL 自带授权，多一个头就会被存储端拒）→ `upload_part_finish` → 带 `upload_id` 调 `files` 合并拿 `file_info` → `msg_type: 7` 发出去。三个容易踩的点已经处理：**分片位置按列表顺序累加，不能用 `index × block_size` 算** —— 文档写「index 从 0 开始」，而**线上返回的第一片 index 是 1**，按它算偏移会从文件尾之后开始切，于是每一片都是空的、合并出来的文件是 0 字节，平台只会回一句 `850019 富媒体文件格式不支持`（这个 bug 是拿真机跑探针才炸出来的，单测当时按文档用了 0 基所以全绿）；**每片按自己声明的 `block_size` 切**（最后一片是余数，按块大小切会丢掉文件尾巴）；以及分片必须**按序**上传（位置即语义，错位就是坏图）。平台只渲染 png/jpeg，其它格式在上传前就拒绝 —— 否则要等整包传完才拿到 `850019 不支持的文件格式`。

截图走的是随插件附带的 `tools/capture-window.ps1`（一条命令、可单独调试），它把三个坑一次性处理掉：**DPI 感知**（不声明的话窗口尺寸会被按缩放比读小，位图建得太小 → 静默截掉右边和下边三分之一）、**窗口选择**（在候选里挑「**能自己画出内容**」的最大窗口，而不是单纯最大的 —— 否则会抓到遗留的空白大框，再退化成"抓它背后屏幕上的东西"）、以及**平坦色检测**（隐藏窗口/未渲染的远程会话截图是纯色，这时直接报错说明原因，而不是把一张灰图当成截图发出去）。抓不到就返回一句人话，例如 `no matching window has rendered content`。

发送类工具**强制白名单**：目标必须是已存在的会话且当前仍被准入，agent 无法指定任意接收者。通过工具发出的消息会抑制该回合的自动转发，避免重复。

**出站用的准入判断与入站是同一个函数**（`isAllowed`），而且要用「当初把这条会话放进来的人」的身份去算 —— 这条曾经写错过：工具拿**目标自己**当发送者（`userId: peerId`），于是在最常见的 `chat` 模式下必然拒绝 —— 白名单里写的是人的 OpenID，群会话是靠 `userId` 才放行的，只认 `peerId` 的判断永远复现不出来。结果就是**入站收得进、出站发不出**。会话表现在记住最后一位被放行的发送者（`lastUserId`，由 `setReplyTarget` 顺带写入，且**只被真实身份覆盖**，按钮点击携带空身份时不会把它抹掉）；旧存档没有这个字段时退回「按 peer 自身是否在白名单」这一保守读法，下一条消息到达即自动恢复。

---

## 官方通道的能力边界

### 群聊里能不能不 @ 机器人

**可以。** 平台有两个群消息事件，**共用同一个 Intent**（`GROUP_AND_C2C_EVENT (1<<25)`，本插件已订阅）：

| 事件 | 触发条件 |
|---|---|
| `GROUP_AT_MESSAGE_CREATE` | 用户在群里 @ 了机器人 |
| `GROUP_MESSAGE_CREATE`（全量模式） | **群管理员**在该群「机器人资料页」里开启通知后，群里**每条**消息都推送 |

官方文档明确写了全量模式的事件体与 @ 事件**完全一致**（`content` 同样已去除 @ 前缀），所以本插件把两者归一化成同一种消息 —— 差别只在「是否需要 @ 才送达」。

开启方式是**群管理员在群里的机器人资料页操作**，不是开放平台后台的开关；开启/关闭会分别推送 `GROUP_MSG_RECEIVE` / `GROUP_MSG_REJECT` 事件。

⚠️ **全量模式下机器人会收到群里所有消息。** 安全性由准入规则兜底：白名单之外的发送者一律静默丢弃，不会到达 agent。但要注意白名单里如果填的是**群 OpenID**，那就等于放行全群（见「运行模式」）。

### 以下能力官方 API 确实做不到

- **群历史读取** —— 没有对应接口（全量模式只给「开启之后」的消息，不含历史）
- **仿真群友 / 社交状态机** —— 全量模式能旁听，但拿不到更早的上下文，也发不出「像人」的社交行为
- **频道（文字子频道 / 频道私信）** —— 未实现

这些都需要 OneBot/SnowLuma 那类个人号协议（有封号风险）。代码里 `lib/qq/` 已按通道隔离，将来要加后端不必动 `lib/bridge/`。

其它平台约束（实现已处理）：

- 被动回复窗口：**单聊 60 分钟 / 4 次**，**群聊 5 分钟 / 5 次**；超出后自动降级为主动消息
- 主动消息受频控（10/qps、20/qpm、1000 条/天/关系），**且用户可在 QQ 客户端关闭「允许主动发送」——关闭后主动消息一律发送失败**
- `msg_id + msg_seq` 重复发送会失败，因此 `msg_seq` 逐条递增
- 相同 `msg_id` 可能重复推送
- **发送响应必须带 `id` 才算送达** —— 平台出现过 HTTP 200 但消息未送达的情况，本插件把「无 `id`」判为失败，避免回复被静默丢弃

### 内嵌键盘：为什么按钮比编号文字好

平台唯一能随消息下发的交互面就是 `keyboard` 字段，本插件用它承载三类选择：模型、审批、单选题选项。点击会以 `INTERACTION_CREATE`（`type=11`）回到插件，`data.resolved.button_data` 带回按钮的 `action.data`。

三条实现约束：

- **`action.unsupport_tips` 是必填的。** 官方按钮文档把它标为必填（「版本过低时提示文案」），而本插件一开始漏了它 —— 于是同一个键盘，探针带着这个字段发出去在手机上能显示，插件不带就显示不出来。少这一个字段不是"少个提示"，是按钮在某些客户端上直接不渲染。
- **`render_data.label` 上限 10 个字符**，而模型 id 经常超（`deepseek-v4.1-flash` 有 19 个）。所以按钮只显示**页码内稳定的编号**，真正的身份放在没有长度限制的 `action.data` 里，消息正文负责「编号 → 模型」的对照。
- **按钮 payload 是绝对的，不是位置。** `model|<provider>|<model>` 而不是 `model|#<索引>` —— 目录是活的，若某个提供方中途消失，位置型编号会整体错位，用户会切到一个自己没选的模型。
- **按钮点击必须单独订阅 Intent。** 网关默认只订 `GROUP_AND_C2C_EVENT (1<<25)`，收不到 `INTERACTION_CREATE`，需要 `INTERACTION (1<<26)`（见 `lib/qq/gateway.js` 的 `DEFAULT_INTENTS`）。少了它，键盘发得出去、点击永远不回来，表现得和按钮坏掉一模一样。
- **键盘只能挂在 markdown 消息上。** 官方「消息按钮」文档写的是「在 markdown 消息的基础上挂载按钮」，实测也一致：同一个键盘放在 `msg_type: 0` 的纯文本上，平台**照收不报错但按钮不渲染**；换成 `msg_type: 2` 立刻出现。所以**带键盘的消息强制走 markdown**（`Outbound#body`），`useMarkdown` 设置只决定不带按钮的那些消息 —— 否则默认配置下所有按钮都是隐形的。
- **点击必须被「回应」，否则客户端一直转圈。** 收到 `INTERACTION_CREATE` 后要调 `PUT /interactions/{interaction_id}`（body `{code}`：0 成功 / 1 失败 / 4 没有权限），同一个 id 只能回应一次，超时不补。**只发消息不算回应** —— 这正是「点按钮转圈到超时」的原因。回应码会**显示在 QQ 客户端上**（`0` → 操作成功，非 0 → 操作失败），所以权限不足时回 4 而不是 0，用户才知道是权限问题而非失灵。
- **一次点击上有两个 id，不能混用。** 事件体里的 `d.id` 是**互动 id**，只用于 `PUT /interactions/{id}`；被动回消息要用的 `event_id` 取自**事件最外层的 id**（WebSocket 帧自己的 `id`，形如 `INTERACTION_CREATE:<uuid>`）。把 `d.id` 当 `event_id` 发，平台回 `40034025 请求参数event_id无效` —— 这两个字段我们**实测都踩过**（`40034024` 是 msg_id 那条，`40034025` 是 event_id 这条，都是在线上打出来的）。帧 id 只有传输层看得到，所以 `Gateway` 把它当第三个参数一路传到 `normalizeInteraction`，交互对象上同时带 `interactionId` 与 `eventId`。
- **被动目标必须带类型，且死 target 必须兜底。** 游标是共用的：一个死 target 留在里面，会让该会话后续**每一次正常回复**都拿它去发、然后一起失败。所以游标存 `replyTargetKind: 'message' | 'event'`（旧存档按 message 读），并且「已过期」「无效」一律视为死 target —— 先清掉、再用**主动消息重发一次**。这条兜底是独立的：即便某个 id 判断错了，那条回复也不会丢，只是多花一条主动额度。

按钮点击被当作**一条消息**处理：先过准入、再喂给挂起交互注册表**和人工输入完全相同的文本**，因此解析、重提示、超时、与桌面端的竞争全部复用同一条路径。另外帧的 `event_id` 本身就是一个被动回复目标，所以**回复点击不消耗主动消息额度**（帧没带 id 时退回会话自己的窗口）。

> 尚未实现：官方还有 [自定义菜单](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_menu.put.html)（单聊窗口底部，≤10 项）与 [指令面板](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_panels.post.html)（≤20 面板 × 20 元素）。两者都是**机器人级静态配置**，且点击后只是把文本填进输入框，因此适合放固定入口（`/model`、`/status`…），不适合放动态模型列表 —— 动态列表正是内嵌键盘的职责。

### 为什么提示类消息必须优先走被动回复

官方文档把两条通道的区别写得很清楚（见[消息收发概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)与[发送单聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)）：

| | 主动消息 | 被动消息（携带 `msg_id`） |
|---|---|---|
| 前提 | 无，但**用户可关闭接收** | 用户刚发过消息（单聊 60 分钟 / 4 次） |
| 失败方式 | 关闭开关后**一律失败** | 窗口内稳定送达 |
| 频控 | 20/qpm、1000 条/天/关系 | 不占用主动额度 |

**被动窗口是「次数 + 时间」两条规则，而时间那条本地计数器看不见。** 群聊的 `msg_id` **5 分钟**就失效（单聊 60 分钟），而一次带工具调用、思考强度为 `max` 的回合轻易超过 5 分钟 —— 于是回复生成时目标已经死了，平台回 `msgid已经过期,不能回复`。

因此本插件做两件事：

1. **记录回复目标被武装的时刻**（`replyTargetAt`），超过窗口就不再尝试被动，直接走主动消息 —— 不发那注定失败的请求，也不浪费一个回复额度。
2. **兜底**：万一仍被平台以「已过期」拒绝，就**清掉死目标并用主动消息重试一次**。这条重试是安全的 —— 目标过期**证明**消息没有送达，所以不会造成重复。

因此**审批与提问提示走 `deliver`（被动优先、自动降级主动），而不是 `sendActive`**。这两类消息是整个桥接里最不能丢的：一条没送到的审批会让整个回合一动不动地卡住，而操作者在 QQ 侧看不到任何异常。同理，所有发送失败都会：① 抛出而不是静默返回；② 记录到 `/status` 的「最近一次发送失败」，让手机端能自查。

---

## 三个非显然的 DSH API 约束

这三条都只在运行时暴露，写在这里以免再踩：

1. **`sessionController.create` 的 `workspaceId` 与 `cwd` 互斥。**
   两者都在描述「会话在哪工作」，同时传会直接抛
   `session.create accepts workspaceId or cwd, not both`。workspace 本身带规范化路径，注册了 workspace 就不要再传 `cwd`。
   见 `lib/bridge/session-create.js`。

2. **`sessionController.prompt(request, signal)` 的 `signal` 是必填的。**
   实现第一行就是 `signal.throwIfAborted()`，漏传会得到
   `Cannot read properties of undefined (reading 'throwIfAborted')`。
   插件用一个随生命周期存活的 `AbortController`，卸载时 `abort()`，顺带取消仍在途的投递。
   见 `lib/index.js` 与 `lib/bridge/inbound.js`。

3. **瀑布链按「注册顺序」执行，`insert:` 进来的插件排在最后。**
   `approval/request` 与 `user-questions/request` 是 Cordis waterfall：监听器依次拿到 `next`，
   谁先返回结果谁就认领请求，**后面的人再也看不到它**。而把桌面 UI 接进来的
   `@deepseek-ai/dsh-api-remotes` 属于内置 bundle，注册**早于**通过
   `cordis.patch.yml` 的 `insert:` 追加的 `dsh-qq`；它拿到请求后会转发给浏览器并等浏览器回答，
   只有在浏览器**拒绝**时才调用 `next()`。

   后果：本插件曾经**一次都没被调用过** —— 问题转发、审批转发全部静默失效，
   而日志里连一行记录都没有（当时那四个早退分支都不打日志，这正是它难以定位的原因）。

   修法是注册时加 `{ prepend: true }`（`EventService.register` 里 `options.prepend ? 'unshift' : 'push'`），
   把 QQ 侧插到链首，然后自己立刻启动 `next()` 与桌面**并行竞争** —— 这才是本模块文档一直声称的设计。
   见 `lib/bridge/questions.js`、`lib/bridge/approvals.js`，`test/commands.test.js` 断言了 `prepend`。

三条约束都已在 mock context 里复刻（`test/plugin.test.js`、`test/inbound.test.js`、`test/session-create.test.js`、`test/commands.test.js`），任何再触发它们的改动都会在 `npm test` 阶段就失败。

> 另外：**每个早退分支都必须打日志**。上面第 3 条能藏这么久，就是因为「处理器跑过了但拒绝了」和「处理器压根没跑」在日志里长得一模一样。

---

## 存储占用与管理

三类东西会占地方，只有前两类是本插件管的：

| 内容 | 位置 | 现状（本机实测） | 谁清理 |
|---|---|---|---|
| 你发来的图片 | `~/.dsh/attachments/v1/`（objects 按内容哈希去重 + request-images 每请求规范化版本） | **6.9MB / 14 个文件** | **DSH 目前没有保留策略**（官方原话：未引用对象"留待将来的保留策略回收"）—— 只增不减，除非删掉对应会话 |
| 你发来的其它附件 | `%TEMP%\dsh-qq-filestt-*` | 随用随清 | **本插件**：每次入站清理一天前的 |
| 我发给你的截图 | `%TEMP%\dsh-qq-screenshot-*.png` | 3 个 | **本插件**：每次截图清理一天前的 |

出站图片/文件上传后存在腾讯 CDN，**不占本机磁盘**，也不进 DSH 附件库。

**真正会长的是会话日志**（`~/.dsh/sessions`，本机实测 **48MB**，zstd 压缩的 JSONL），不是图片。想回收空间的顺序应该是：清会话 > 清附件，而不是反过来。

## 今天踩过的坑（给未来的自己）

这一节只做索引：每条都指向真正处理它的地方，因为**其中一半是重复踩的** —— 症状看着像新问题，其实是同一个坑换了张脸。

### 平台 API 的反直觉字段

| 症状 | 真相 | 处理位置 |
|---|---|---|
| 按钮在某些客户端不渲染 | `action.unsupport_tips` 是**必填**，漏了就是隐形 | `bridge/keyboard.js` |
| 按钮发出去没反应、客户端一直转圈 | 点击必须 `PUT /interactions/{id}` 回应；只发消息不算 | `qq/api.js` `ackInteraction` |
| 点击回执发不出、`40034024` | 点击的 id 是**帧的** event id，不是事件体的 `d.id` | `qq/events.js` + `qq/gateway.js` |
| `40034025 请求参数event_id无效` | 用 `d.id` 当 `event_id`；`event_id` 取自**事件最外层** id | 同上 |
| 键盘挂上去不显示 | 键盘只在 **markdown** 消息（`msg_type: 2`）上渲染 | `bridge/outbound.js` `#body` |
| 图片上传后 `850019 不支持的文件格式` | 分片偏移**不能**用 `index × block_size` 算：线上第一片 index 是 **1**，按它切会切出空片 | `qq/api.js` `uploadImage` |
| 预签名 PUT 被存储端拒 | 不能带 `Authorization` / JSON content-type | `qq/api.js` `#putBinary` |

### 进程与重启

| 症状 | 真相 | 处理位置 |
|---|---|---|
| 每次重启多一个 404 标签页 | 端口就绪 ≠ 新进程打印了自己的 URL 行；早读会取到**上一代**的 token | `dsh-web-url.ps1` + 启动脚本 `:opennew` |
| `/restart` 变成"纯关机" | Node 的 `detached: true` 在这台机器上**静默 no-op**（退出码 0、无副作用、无 error 事件） | `bridge/restart.js`（改用 `cmd /c start`） |
| 重启器抢不到控制台 | `dsh web` 跑在本进程控制台里，进程退出会带走同控制台的进程 | 同上（`start` 给独立控制台） |
| 改了代码重启后桥接失联 | 坏改动会让新进程挂不上插件，而 `/restart` 是唯一加载通道 | `verifyPluginLoads` 重启前自检 |

### 截图（`tools/capture-window.ps1`）

| 症状 | 真相 |
|---|---|
| 图少一块（右边/下边被切） | 抓图进程 DPI 不感知 → 窗口尺寸按缩放比读小。**先 `SetProcessDPIAware()`** |
| 抓到了空白大框，内容是"它背后的东西" | 选窗口不能只挑最大的，要挑**能自己画出内容**的 |
| 浏览器截图是切换标签页**之前**的画面 | `PrintWindow` 对 GPU 合成窗口返回**旧帧**（不报错、不纯色）→ 用 `-Method screen`，并先 `SetForegroundWindow` |
| 标签页切了却没生效 | UIA `Select()` 返回成功 ≠ 真的切了，要读回 `IsSelected` |
| 灰图当成截图发出去 | 未渲染的会话/隐藏窗口是纯色 → 平坦色检测后**报错**而不是发送 |

### 死因不明时，先让它自己开口

进程两次在夜里无声消失：日志没有错误、Windows 事件日志没有崩溃记录、没有睡眠/重启/内存耗尽/杀软拦截。**查不出死因时，最该做的不是继续猜，而是让下一次死亡留下证词**：

- `process.on('exit')` 记录退出码，并标明"这次是 `/restart` 要求退出的"（`restart.pending` 由 restart 服务在 `go()` 里置位）——两者后续处理完全不同，日志是唯一的证人
- `SIGINT/SIGTERM/SIGHUP/SIGBREAK` 先记录**再重新抛出**：Node 对无监听器的信号默认就是退出，只是"加监听器"会把这个默认行为静默取消，等于把 Ctrl+C 变成空操作

### 服务进程不能挂在可见的控制台窗口上

| 症状 | 真相 |
|---|---|
| 服务**两次在夜里静默消失**：日志没有任何错误、系统事件日志也没有崩溃记录、连一行输出都没有 | 它挂在启动器开的那个**最小化控制台窗口**下。关闭窗口 = `CTRL_CLOSE_EVENT` = 优雅退出 = **不留任何痕迹**。而那个窗口在任务栏上的标题是 cmd 自己的默认 `C:\WINDOWS\system32\cmd.exe`（`start` 里设的标题会被子 cmd 覆盖），看着就像个多余的命令行，正是顺手会关掉的东西 |
| 修法 | 服务**完全无窗口**启动：`Start-DeepSeek-Harness.server.cmd` 存命令、`Start-DeepSeek-Harness.ps1` 负责无窗口拉起、`Stop-DeepSeek-Harness.cmd` 负责**故意**停止（按端口找 PID、按 PID 杀） |
| `Start-Process -WindowStyle Hidden` 为什么不行 | 对**控制台程序**它不隔离任何东西：子进程继承调用者的控制台，照样往里写、照样跟着一起死。要 `ProcessStartInfo` 配 `UseShellExecute=$false` + `CreateNoWindow=$true` |
| `.ps1` 文件必须是纯 ASCII | Windows PowerShell 在**没有 BOM** 时按 ANSI 读 `.ps1`，中文会把字符串截断成语法错误（`The string is missing the terminator`）——写脚本时把说明放在 `.cmd` 或 README 里 |

### 网络请求必须有截止时间（"重启后机器人不响应"的真凶）

| 症状 | 真相 |
|---|---|
| 重启后一切正常，日志停在 `QQ channel starting for AppID …` 就没了 —— 没有 `access token refreshed`、没有 `gateway socket open`，也没有任何报错 | `fetch` **默认没有超时**。`getGateway()` 一旦卡住，promise 永不完结：不会 reject（所以没有重试）、不会打日志（所以看起来像"启动了"）。通道就这么哑着，直到下一次重启 |
| 修法 | 每个出站请求带 `AbortSignal.timeout(...)`：OpenAPI 30 秒、预签名分片 PUT 120 秒、token 30 秒。卡住 → 变成一次**可见的失败** → 走既有的退避重连 |
| 别用"包一层"假装兜底 | `gateway.start()` 曾经返回 `undefined`，于是 `Promise.resolve(start()).catch(...)` 接的是空气。**兜底必须挂在真正的 promise 上**（`start()` 现在返回 `#connect()`） |

### 路由与鉴权（本地插件最容易漏的一条）

| 症状 | 真相 |
|---|---|
| 插件自己的 HTTP 路由**谁都能读能写** | `webServer.register` 只是把路由放进表里：**既不做 trusted-host 检查，也不做浏览器会话检查**（那两样挂在 `/api` 那条链上）。后果是 DNS rebinding：任意网页把域名解析到 127.0.0.1，浏览器带着攻击者的 Host 发请求，`/dsh-qq/config` 就会照单全收 |
| 正确写法 | 每个 handler 开头 `const r = ctx.get('connection')?.requestRejection?.(req)`，返回非 undefined 就 `writeHead(r)` 并结束（第一方插件都这么做） |
| 自检方式 | `curl -H "Host: evil.example.com" http://127.0.0.1:3080/<你的路由>` —— 该被拒；对照 `curl /api/...` 应当是 401 |

### 数据操作（差点造成不可逆损失的那一类）

| 症状 | 真相 |
|---|---|
| 扫描会话日志得到**空结果** | `zlib.zstdDecompressSync` 和 `createZstdDecompress` **都只解第一帧**，而会话日志是**一帧一帧追加**的（一个 3.8MB 的日志里有 2383 帧）。只解第一帧 = 读了 208 字节，于是"没有任何附件被引用" |
| 正确读法 | 按 zstd 魔数 `28 b5 2f fd` 切帧逐帧解压；解完**校验每帧都成功** —— 有坏帧就说明切分错了，此时**不能**拿结果做判断 |
| 表"存整个对象、只恢复白名单字段" | 新加的字段会在**每次重启时静默消失**，紧接着的那次保存还会把它从磁盘抹掉（`lastUserId`/`replyTargetKind` 就这么丢过）。`#load` 必须"归一化已知字段 + 保留未知字段" |
| 空集合当作结论 | 扫描输出"引用 0 个哈希"本身就是警报，不是事实。**空结果要先验证再行动**：一次误判就会永久删掉被引用的数据（`fs.rmSync` 不进回收站） |

### 在 bash 里干活（DSH 工具行为）

**卡住的机制（含我自己的误判修正）**：不是 Job 对象的锅。真相是**子进程继承了调用者的 stdout 管道** —— 只要那个子进程还活着，管道就不关闭，任何读它的人（`tail`、命令替换）就永远等不到 EOF。所以**一条命令启动了永不退出的进程 = 这条命令必然挂死**。

| 规矩 | 原因 |
|---|---|
| **每条命令都套 `timeout N`** | 犯错时最多损失 N 秒，而不是一个卡死的回合。已经吃过三次亏 |
| **绝不在 bash 里启动长期存活的进程** | 它会占住 stdout 管道（见上）。服务器/看门狗这类进程由**启动器**拉起，不经过 bash |
| **守护进程必须在自己的 `.cmd` 里重定向输出**（`>> log 2>&1`） | 这样它不持有调用者的管道。`Start-DeepSeek-Harness.watchdog.cmd` 因此从"挂死数分钟"变成"0 秒返回" |
| **验证守护进程用下一条独立命令**（读 PID 文件 / 端口 / 日志） | 不要在启动它的那条命令里等它 —— 那正是挂死的写法 |
| **启动长命进程时，把本条命令自己的输出也丢弃**（`> /dev/null 2>&1`） | 双保险：即使子进程没重定向，读端也不会被挂住 |
| **不要在一条命令里后台起进程**（`&`、`start`） | 后台子进程会让 runner 报 `Windows Job runner exited ... before proving its managed range empty` |
| **不要在一条命令里既起进程又杀进程** | 同上 |
| **按 PID 杀，不要按名字过滤** | 过滤字符串会命中你自己这条命令行，于是"发现残留进程"其实是发现你自己 |
| **一个测试要能一次跑完** | 否则是测试设计错了：为验一个非关键分支搭替身副本、再修副本的引号问题，代价远大于收益 |

## 开发

```bash
npm test        # 295 个单元测试，不需要网络与真实 QQ
```

测试覆盖：token 刷新语义、事件归一化与引用解析、Markdown 转换与分条、`msg_seq` 与被动窗口降级、审批/提问解析、准入模式、以及插件加载/卸载的接线（用 mock context 跑，能在重启 DSH 前抓出接线错误）。

```
lib/
├── index.js            # 插件入口：settings、生命周期、接线
├── client.js           # 设置卡片（浏览器半，手写免构建）
├── console.js          # /dsh-qq/{state,config,pair} 路由
├── pairing.js          # 扫码绑定
├── md-to-plain.js      # Markdown → 纯文本、按字节分条
├── qq/
│   ├── token.js        # access_token 获取与提前刷新
│   ├── api.js          # OpenAPI（发送、网关发现、送达校验）
│   ├── gateway.js      # WebSocket：identify / 心跳 / resume / 退避重连
│   └── events.js       # 事件归一化、引用、附件、prompt 组装
└── bridge/
    ├── sessions.js     # QQ 会话 ↔ DSH 会话映射、回复游标
    ├── inbound.js      # 准入 → 命令 → 挂起交互 → prompt
    ├── capture.js      # 截屏/抓窗口、临时文件清理（工具与 /screen 命令共用）
    ├── delivery.js     # queue / steer 的判定与前缀解析
    ├── progress.js     # 当前回合的可见性：/status 那一行与长回合心跳
    ├── restart.js      # /restart：拉起启动器、跨进程标记与新地址通知
    ├── outbound.js     # turn 收集、分条、频控队列、主被动降级
    ├── pending.js      # 挂起交互注册表与应答解析
    ├── approvals.js    # 审批应答者
    ├── questions.js    # 提问应答者
    └── tools.js        # agent 主动 QQ 工具
```

状态文件：`~/.dsh/dsh-qq-sessions.json`（会话映射与回复游标，原子写入）。
