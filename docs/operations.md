# 运维与排障

**简体中文** | [English](operations.en.md)

本文档面向部署与维护人员，说明日志位置、故障排查路径，以及若干在实现与运行过程中确认的约束。每项均标注对应的处理位置。

## 日志与状态文件

| 文件 | 内容 |
|---|---|
| `~/.dsh/web-launch.log` | 主日志。插件的每一行均带时间戳（形如 `[dsh-qq 21:39:04] …`） |
| `~/.dsh/dsh-qq-restart.log` | 重启器各步骤的进展：等待端口释放、启动启动器、端口重新监听 |
| `~/.dsh/dsh-qq-watchdog.log` | 看门狗日志：启动、检测到服务消失、现场信息、恢复与停机时长 |
| `~/.dsh/dsh-qq-watchdog.out.log` | 看门狗进程自身的输出，正常情况下为空 |
| `~/.dsh/dsh-qq-sessions.json` | QQ 会话与 DSH 会话的映射，含回复游标与最后一位被放行的发送者 |
| `~/.dsh/dsh-usage/*.json` | DSH 维护的余额与用量账本，`/usage` 的数据来源 |

时间戳为刻意保留：缺少时间基准时，日志中的多次网关重连无法区分是连接不稳定还是较长时间跨度内的正常会话到期。该误判曾实际发生。

## 故障排查

### 机器人无响应

1. 执行 `netstat -ano | findstr :3080`，确认端口是否有监听。
2. 若无监听，检查 `dsh-qq-watchdog.log` 是否出现新的 `server is DOWN` 记录。该记录包含发生时间、服务进程是残留还是已消失、以及服务最后的数行输出。
3. 若有监听，检查 `web-launch.log` 中的 `gateway` 相关记录：
   - 出现 `gateway discovery failed` 或 `reconnecting to the gateway in Nms`，属于网络问题，连接会自动恢复；
   - 记录停留在 `QQ channel starting …` 之后无任何输出，说明进程已终止，参照第 2 步。

### 重启后服务未恢复

1. 查看 `dsh-qq-restart.log` 的最后数行。重启通知中亦会附带同样内容。
2. 若启动器已执行但服务未恢复，检查 `web-launch.log` 中新进程的报错，通常为插件加载失败。
3. `/restart` 具备重启前自检：存在缺陷的改动会被拒绝，而不会使服务停留在无法启动的状态。

## 平台 API 的隐蔽字段

| 现象 | 原因 | 处理位置 |
|---|---|---|
| 按钮在部分客户端不渲染 | `action.unsupport_tips` 为必填字段 | `bridge/keyboard.js` |
| 按钮点击后客户端持续等待 | 点击必须通过 `PUT /interactions/{id}` 回应，仅发送消息不构成回应 | `qq/api.js` |
| 回应点击时报 `40034024` | 使用了互动 id 作为 `msg_id`；应使用帧的 event id | `qq/events.js`、`qq/gateway.js` |
| 报 `40034025 请求参数event_id无效` | 使用了 `d.id` 作为 `event_id`；该值取自事件最外层 id | 同上 |
| 键盘下发后不显示 | 键盘仅在 markdown 消息（`msg_type: 2`）上渲染 | `bridge/outbound.js` |
| 图片上传后报 `850019 富媒体文件格式不支持` | 分片偏移不可用 `index × block_size` 计算；线上返回的第一个分片 index 为 1，按该方式计算会切出空分片 | `qq/api.js` |
| 预签名 PUT 被存储端拒绝 | 不可携带 `Authorization` 与 JSON content-type | `qq/api.js` |
| HTTP 200 但消息未送达 | 响应必须包含 `id` 才视为送达 | `bridge/outbound.js` |
| 同一条消息被执行两次 | 平台可能重复推送相同的 `msg_id`；桥接按会话记录最近 50 个已处理 id 并丢弃重复项，判断位于准入之后、分发之前 | `bridge/inbound.js` |

## 进程、控制台与重启

| 现象 | 原因 | 处理位置 |
|---|---|---|
| 每次重启后新增一个 404 页面 | 端口就绪不等于新进程已输出自身的 URL 行；过早读取会取到上一代进程的令牌 | `dsh-web-url.ps1`、启动脚本 |
| `/restart` 仅执行了停机 | Node 的 `detached: true` 在本机环境中静默失效（退出码 0、无副作用、不触发 `error` 事件） | `bridge/restart.js` |
| 重启器无法获得独立控制台 | `dsh web` 运行于本进程的控制台，进程退出会一并终止同控制台的进程 | 同上（改用 `start` 创建独立控制台） |
| 改动代码并重启后桥接失联 | 存在缺陷的改动会导致新进程无法加载插件，而 `/restart` 是唯一的加载通道 | `verifyPluginLoads` 重启前自检 |

### 服务进程不可挂载于可见的控制台窗口

本服务曾两次在夜间静默消失：日志中无任何错误，系统事件日志中无崩溃记录，也无任何输出。

原因是该进程挂载于启动器创建的最小化控制台窗口之下。关闭该窗口会触发 `CTRL_CLOSE_EVENT`，使进程正常退出且不留下任何记录。该窗口在任务栏中的标题为 cmd 自身的默认值 `C:\WINDOWS\system32\cmd.exe`（`start` 中设置的标题会被子 cmd 覆盖），外观上与一个多余的命令行窗口无异。

解决方案是令服务完全无窗口启动：`Start-DeepSeek-Harness.server.cmd` 保存命令行，`Start-DeepSeek-Harness.ps1` 负责无窗口启动，`Stop-DeepSeek-Harness.cmd` 负责主动停止（按端口定位 PID，再按 PID 终止，并先停止看门狗）。

**`Start-Process -WindowStyle Hidden` 对控制台程序无效**：子进程会继承调用者的控制台，其输出仍写入该控制台，并随其一同终止。正确做法是使用 `ProcessStartInfo` 并设置 `UseShellExecute = $false` 与 `CreateNoWindow = $true`。

## 崩溃取证

进程两次无声消失后，已部署四层取证手段：

- `process.on('exit')` 记录退出码，并标注退出是否由 `/restart` 触发（`restart.pending` 在 `go()` 中置位）。两种情形后续处理方式不同，日志是唯一的判据。
- `SIGINT`、`SIGTERM`、`SIGHUP`、`SIGBREAK` 先记录再重新抛出。Node 对无监听器的信号默认行为是退出，而仅添加监听器会静默取消该默认行为，使 Ctrl+C 变为空操作。
- 看门狗：服务消失后 60 秒内重新启动，并记录发生时间、进程是否残留、服务最后数行输出与停机时长。
- 日志时间戳：缺少时间基准时无法判断多次重连属于连接不稳定还是较长时间跨度内的正常到期。

> 进程被 `taskkill /F` 强制终止或控制台被关闭时，不会执行任何 JavaScript。因此取证日志存在覆盖盲区，这也是看门狗必须存在的原因。

## 网络请求超时

`fetch` 默认不设超时。`getGateway()` 一旦停滞，其 promise 永不结束：既不 reject（因此不会重试），也不产生日志（因此表现为「已启动」）。通道由此处于静默失效状态，直至下一次重启。这是「重启后机器人 15 分钟不响应」的根本原因。

解决方案是每个出站请求携带 `AbortSignal.timeout(...)`：OpenAPI 30 秒、预签名分片 PUT 120 秒、token 30 秒。请求停滞将转化为一次可见的失败，并进入既有的退避重连流程。

不应以包装掩盖失败：`gateway.start()` 曾返回 `undefined`，使 `Promise.resolve(start()).catch(...)` 未接入任何 promise。兜底逻辑必须挂载于真实的 promise。

## 路由鉴权

`webServer.register` 仅将路由登记入表，既不执行 trusted-host 检查，也不执行浏览器会话检查（这两项校验位于 `/api` 处理链上）。其后果是 DNS rebinding：任意网页可将域名解析至 127.0.0.1，浏览器随后携带攻击者的 Host 发出请求，`/dsh-qq/config` 将照常处理。

正确做法是在每个 handler 开头调用 `ctx.get('connection')?.requestRejection?.(req)`，返回值非 `undefined` 时以 `writeHead(r)` 结束响应。DSH 第一方插件均采用该做法。

自检方法：

```bash
curl -H "Host: evil.example.com" http://127.0.0.1:3080/dsh-qq/state   # 预期 403
curl http://127.0.0.1:3080/dsh-qq/state                               # 预期 401
```

## 数据操作

| 现象 | 原因 |
|---|---|
| 扫描会话日志得到空结果 | `zlib.zstdDecompressSync` 与 `createZstdDecompress` 均只解压第一帧，而会话日志是按帧追加写入的（一个 3.8MB 的日志包含 2383 帧）。仅解压第一帧等于只读取了 208 字节，由此得出「没有任何附件被引用」的错误结论 |
| 正确的读取方式 | 按 zstd 魔数 `28 b5 2f fd` 切分帧并逐帧解压；解压完成后须校验每一帧均成功。存在失败帧即说明切分有误，此时不可将该结果用于判断 |
| 将空集合作为结论 | 扫描输出「引用 0 个哈希」本身即为异常信号，而非事实。空结果必须先验证再行动：一次误判将永久删除仍被引用的数据，`fs.rmSync` 不经过回收站 |
| 持久化表「保存整个对象、仅恢复白名单字段」 | 新增字段会在每次重启时静默消失，随后的一次保存还会将其从磁盘清除。`#load` 必须归一化已知字段并保留未知字段 |

## 截图

| 现象 | 原因 |
|---|---|
| 图像缺少右侧或下侧部分 | 截图进程未声明 DPI 感知，窗口尺寸按缩放比读取偏小。须先调用 `SetProcessDPIAware()` |
| 截到空白大框，内容为其后方画面 | 窗口选取不能仅依据面积，须选择能够自行绘制内容的窗口 |
| 浏览器截图内容是切换标签页之前的画面 | `PrintWindow` 对 GPU 合成窗口返回旧帧，既不报错也非纯色。应使用 `-Method screen`，并先调用 `SetForegroundWindow` |
| 标签页切换未生效 | UIA `Select()` 返回成功不等于切换生效，须读回 `IsSelected` 确认 |
| 将灰色图像作为截图发出 | 未渲染的会话或隐藏窗口的截图为纯色，平坦色检测会报错而非发送 |

## shell 使用约束

**阻塞机制**：与 Job 对象无关。根本原因是子进程继承了调用者的 stdout 管道。只要该子进程仍在运行，管道便不会关闭，任何读取方（`tail`、命令替换）都无法收到 EOF。因此，在一条命令中启动不会退出的进程，该命令必然阻塞。

| 约束 | 原因 |
|---|---|
| 每条命令均加 `timeout N` | 出现失误时最多损失 N 秒，而非阻塞整个回合 |
| 不在 shell 中启动长期存活的进程 | 该类进程会占用 stdout 管道。服务与看门狗由启动器启动 |
| 守护进程须在自身的 `.cmd` 中重定向输出（`>> log 2>&1`） | 使其不持有调用者的管道 |
| 验证守护进程使用下一条独立命令（读取 PID、端口或日志） | 在启动命令中等待即会导致阻塞 |
| 启动长期进程时同时丢弃本命令的输出 | 作为第二重保障 |
| 不在同一条命令中既启动又终止进程 | 后台子进程会触发 runner 的 job 相关错误 |
| 按 PID 终止，不按进程名过滤 | 过滤字符串会匹配到当前命令行自身 |
| 一个测试应能一次执行完成 | 否则属于测试设计缺陷 |

## 脚本与编码约束

- **`.ps1` 文件必须为纯 ASCII。** Windows PowerShell 在文件不含 BOM 时按 ANSI 解码，非 ASCII 字符会截断字符串并造成语法错误（`The string is missing the terminator`）。说明文字应置于 `.cmd` 或文档中。
- **`$Home` 是只读内置变量。** 以其作为参数名会得到 `VariableNotWritable`。
- **PowerShell 变量名不区分大小写。** 局部变量 `$method` 会与参数 `$Method` 冲突。
- **用 Python 编辑仓库文件时必须显式指定 `newline=''`。** 默认的文本模式读取会把 CRLF 归一为 LF，写回后整个文件在 diff 里显示为全文件改动 —— 本仓库的 `test/outbound.test.js` 就是这样产生了 540 行虚假改动。
- **不使用 Python 字符串书写含反斜杠的路径。** `\a`、`\t`、`\b` 会被解释为控制字符，在文件中留下不可见污染。书写后应检查是否存在控制字符。

## 会话搜索（`/find`）在本部署上的三个前提

`/find` 走 DSH 自己的 `sessionController.search`，而它在本部署上默认不可用。三个前提缺一不可：

1. **索引必须被允许打开。** bundle 层把 `session-query-sqlite` 配成 `openAt: never`，搜索因此直接报 `session search is disabled`。patch 层覆盖为 **`first-search`**：启动零开销，第一次搜索时才建索引。覆盖时**必须重复 `path`** —— id 定向的覆盖是**替换**该行的 config，不是合并。
2. **旧的 v0 会话不能含有它不认识的描述符。** 迁移器 `dsh-session-format-v0-to-v1` 要求 `subagent/descriptor` 为版本 3；本机有 3 个 08 月的裸 UUID 会话是版本 2，迁移器**刻意拒绝**（"即使可忽略也拒绝未知的历史事件"）并让整次索引构建失败。它们已移出会话目录，存放于 `~/.dsh/sessions-quarantine/`，**随时可移回**。
3. **改 profile 配置时服务必须是停的。** 编辑 `cordis.patch.yml` 会触发文件监听与热重载；实测那次重载把服务拆掉却没有重建，进程变成"端口仍被占用、服务已不可用"的半死状态 —— 表现是 GUI 报 `sessionController is unavailable`、启动器判定"已在运行"而拒绝启动，**只有重启电脑能恢复**。正确做法是先停服务再改，或改完立即完整重启。

## 扫描结果为空时，先验证再下结论

排查上面第 2 条时，我写了个脚本遍历所有会话日志、搜索 `subagent/descriptor`，结果是"没有匹配"。那是**假的**：脚本把每一帧的解压失败 `except: pass` 掉了，而那三个旧文件**一帧都解不开**（0/178、0/362、0/510）。空结果本身就是要先验证的断言 —— 这条规则在附件误删那次已经付过一次代价。

## 存储占用

| 内容 | 位置 | 清理方 |
|---|---|---|
| 入站图片 | `~/.dsh/attachments/v1/`（objects 按内容哈希去重，request-images 为每请求的规范化版本） | DSH 目前没有保留策略，只增不减，除非删除对应会话 |
| 入站其它附件 | `%TEMP%\dsh-qq-files\att-*` | 本插件：每次入站时清理一天前的文件 |
| 出站截图 | `%TEMP%\dsh-qq-screenshot-*.png` | 本插件：每次截图时清理一天前的文件 |

出站图片与文件上传后存储于腾讯 CDN，不占用本机磁盘，也不进入 DSH 附件库。

实际增长主要来自会话日志（`~/.dsh/sessions`，zstd 压缩的 JSONL）。回收空间的优先顺序应为：清理会话，其次清理附件。
