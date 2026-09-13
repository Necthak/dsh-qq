# 运维、排障与踩坑记录

这一份记的是**运行这个桥接时会遇到的事**：日志在哪、出事怎么查、以及那些花过真实时间才搞明白的坑。每一条都指向真正处理它的代码位置。

## 日志与状态

| 文件 | 内容 |
|---|---|
| `~/.dsh/web-launch.log` | 主日志。插件的每一行都带时间戳（`[dsh-qq 21:39:04] …`） |
| `~/.dsh/dsh-qq-restart.log` | 重启器每一步的进展：等端口释放 → 拉起启动器 → 端口重新监听 |
| `~/.dsh/dsh-qq-watchdog.log` | 看门狗：启动、发现服务消失、**死亡现场**、恢复与停机时长 |
| `~/.dsh/dsh-qq-watchdog.out.log` | 看门狗进程自身的输出（正常情况下是空的） |
| `~/.dsh/dsh-qq-sessions.json` | QQ 会话 ↔ DSH 会话映射（含回复游标、最后一位被放行的发送者） |
| `~/.dsh/dsh-usage/*.json` | DSH 维护的余额与用量账本，`/usage` 读它 |

**时间戳是刻意的。** 没有它，日志里"六次网关重连"无法判断是抖动还是三小时里的正常会话到期 —— 这个误判真实发生过一次。

## 出事怎么查

### 机器人突然不理人

1. `netstat -ano | findstr :3080` —— 端口有没有人在听
2. 没有 → 看 `dsh-qq-watchdog.log` 有没有新的 `server is DOWN` 行：那里有**时间**、**进程是残留还是消失**、**服务最后写下的几行**
3. 有 → 看 `web-launch.log` 里 `gateway` 相关的行：
   - `gateway discovery failed` / `reconnecting to the gateway in Nms` → 网络问题，**会自愈**
   - 停在 `QQ channel starting …` 之后什么都没有 → 进程整个没了（看第 2 步）

### 重启之后没回来

1. `dsh-qq-restart.log` 的最后几行 —— 通知里也会原样带回群里
2. 启动器拉起过但服务没起来 → 看 `web-launch.log` 里新进程的报错（多半是插件加载失败）
3. `/restart` 有**重启前自检**：坏改动会被拒绝，而不是把服务停在一个起不来的状态

## 平台 API 的反直觉字段

| 症状 | 真相 | 位置 |
|---|---|---|
| 按钮在某些客户端不渲染 | `action.unsupport_tips` 是**必填**，漏了就是隐形 | `bridge/keyboard.js` |
| 按钮发出去没反应、客户端一直转圈 | 点击必须 `PUT /interactions/{id}` 回应；只发消息不算 | `qq/api.js` |
| 点击回执发不出、`40034024` | 点击的 id 是**帧的** event id，不是事件体的 `d.id` | `qq/events.js`、`qq/gateway.js` |
| `40034025 请求参数event_id无效` | 用 `d.id` 当 `event_id`；它取自**事件最外层** id | 同上 |
| 键盘挂上去不显示 | 键盘只在 **markdown** 消息（`msg_type: 2`）上渲染 | `bridge/outbound.js` |
| 图片上传后 `850019 不支持的文件格式` | 分片偏移**不能**用 `index × block_size` 算：线上第一片 index 是 **1**，按它切会切出空片 | `qq/api.js` |
| 预签名 PUT 被存储端拒 | 不能带 `Authorization` / JSON content-type | `qq/api.js` |
| HTTP 200 但消息没送到 | **响应必须带 `id` 才算送达** | `bridge/outbound.js` |

## 进程与重启

| 症状 | 真相 | 位置 |
|---|---|---|
| 每次重启多一个 404 标签页 | 端口就绪 ≠ 新进程打印了自己的 URL 行；早读会取到**上一代**的 token | `dsh-web-url.ps1`、启动脚本 |
| `/restart` 变成"纯关机" | Node 的 `detached: true` 在这台机器上**静默 no-op**（退出码 0、无副作用、无 error 事件） | `bridge/restart.js` |
| 重启器抢不到控制台 | `dsh web` 跑在本进程控制台里，进程退出会带走同控制台的进程 | 同上（`start` 给独立控制台） |
| 改了代码重启后桥接失联 | 坏改动会让新进程挂不上插件，而 `/restart` 是唯一加载通道 | `verifyPluginLoads` 重启前自检 |

## 服务进程不能挂在可见的控制台窗口上

服务曾在夜里**两次静默消失**：日志没有任何错误、系统事件日志也没有崩溃记录、连一行输出都没有。

原因是它挂在启动器开的那个**最小化控制台窗口**下 —— 关闭窗口 = `CTRL_CLOSE_EVENT` = 优雅退出 = **不留任何痕迹**。而那个窗口在任务栏上的标题是 cmd 自己的默认 `C:\WINDOWS\system32\cmd.exe`（`start` 里设的标题会被子 cmd 覆盖），看着就像个多余的命令行。

修法：服务**完全无窗口**启动 —— `Start-DeepSeek-Harness.server.cmd` 存命令、`Start-DeepSeek-Harness.ps1` 负责无窗口拉起、`Stop-DeepSeek-Harness.cmd` 负责**故意**停止（按端口找 PID、按 PID 杀，并**先停看门狗**）。

**`Start-Process -WindowStyle Hidden` 对控制台程序无效** —— 子进程继承调用者的控制台，照样往里写、照样跟着一起死。要 `ProcessStartInfo` 配 `UseShellExecute=$false` + `CreateNoWindow=$true`。

## 死因不明时，先让它自己开口

进程两次无声消失后，装了四层取证：

- `process.on('exit')` 记录退出码，并标明"这次是 `/restart` 要求退出的"（`restart.pending` 在 `go()` 里置位）—— 两者后续处理完全不同，日志是唯一的证人
- `SIGINT/SIGTERM/SIGHUP/SIGBREAK` **先记录再重新抛出**：Node 对无监听器的信号默认就是退出，而"只是加监听器"会把这个默认行为静默取消，等于把 Ctrl+C 变成空操作
- **看门狗**：服务消失 ≤60 秒拉起，并记录死亡时间、进程是否残留、服务最后几行、停机时长
- **日志时间戳**：没有时钟就无法判断"六次重连"是抖动还是三小时里的正常到期

> 被 `taskkill /F` 强杀或控制台关闭时**不会执行任何 JS** —— 法医日志有盲区，这也是看门狗必须存在的原因。

## 网络请求必须有截止时间

`fetch` **默认没有超时**。`getGateway()` 一旦卡住，promise 永不完结：不会 reject（所以没有重试）、不会打日志（所以看起来像"启动了"）。通道就这么哑着，直到下一次重启 —— 这正是"重启后机器人 15 分钟不响应"的真凶。

修法：每个出站请求带 `AbortSignal.timeout(...)` —— OpenAPI 30 秒、预签名分片 PUT 120 秒、token 30 秒。卡住 → 变成一次**可见的失败** → 走既有的退避重连。

**别用"包一层"假装兜底。** `gateway.start()` 曾经返回 `undefined`，于是 `Promise.resolve(start()).catch(...)` 接的是空气。兜底必须挂在真正的 promise 上。

## 路由与鉴权（本地插件最容易漏的一条）

`webServer.register` **只是把路由放进表里**：既不做 trusted-host 检查，也不做浏览器会话检查（那两样挂在 `/api` 那条链上）。后果是 DNS rebinding：任意网页把域名解析到 127.0.0.1，浏览器带着攻击者的 Host 发请求，`/dsh-qq/config` 就会照单全收。

正确写法：每个 handler 开头 `const r = ctx.get('connection')?.requestRejection?.(req)`，返回非 undefined 就 `writeHead(r)` 并结束（第一方插件都这么做）。

自检方式：

```bash
curl -H "Host: evil.example.com" http://127.0.0.1:3080/dsh-qq/state   # 该被拒（403）
curl http://127.0.0.1:3080/dsh-qq/state                               # 该是 401
```

## 数据操作（差点造成不可逆损失的那一类）

| 症状 | 真相 |
|---|---|
| 扫描会话日志得到**空结果** | `zlib.zstdDecompressSync` 和 `createZstdDecompress` **都只解第一帧**，而会话日志是**一帧一帧追加**的（一个 3.8MB 的日志里有 2383 帧）。只解第一帧 = 读了 208 字节，于是"没有任何附件被引用" |
| 正确读法 | 按 zstd 魔数 `28 b5 2f fd` 切帧逐帧解压；解完**校验每帧都成功** —— 有坏帧就说明切分错了，此时**不能**拿结果做判断 |
| 空集合当作结论 | 扫描输出"引用 0 个哈希"本身就是警报，不是事实。**空结果要先验证再行动**：一次误判就会永久删掉被引用的数据（`fs.rmSync` 不进回收站） |
| 表"存整个对象、只恢复白名单字段" | 新加的字段会在**每次重启时静默消失**，紧接着的那次保存还会把它从磁盘抹掉。`#load` 必须"归一化已知字段 + 保留未知字段" |

## 截图（`tools/capture-window.ps1`）

| 症状 | 真相 |
|---|---|
| 图少一块（右边/下边被切） | 抓图进程 DPI 不感知 → 窗口尺寸按缩放比读小。**先 `SetProcessDPIAware()`** |
| 抓到了空白大框，内容是"它背后的东西" | 选窗口不能只挑最大的，要挑**能自己画出内容**的 |
| 浏览器截图是切换标签页**之前**的画面 | `PrintWindow` 对 GPU 合成窗口返回**旧帧**（不报错、不纯色）→ 用 `-Method screen`，并先 `SetForegroundWindow` |
| 标签页切了却没生效 | UIA `Select()` 返回成功 ≠ 真的切了，要读回 `IsSelected` |
| 灰图当成截图发出去 | 未渲染的会话/隐藏窗口是纯色 → 平坦色检测后**报错**而不是发送 |

## 在 bash 里干活

**卡住的机制**：不是 Job 对象的问题 —— 是**子进程继承了调用者的 stdout 管道**。只要那个子进程还活着，管道就不关闭，任何读它的人（`tail`、命令替换）就永远等不到 EOF。所以**一条命令启动了永不退出的进程 = 这条命令必然挂死**。

| 规矩 | 原因 |
|---|---|
| **每条命令都套 `timeout N`** | 犯错时最多损失 N 秒，而不是一个卡死的回合 |
| **绝不在 bash 里启动长期存活的进程** | 它会占住 stdout 管道。服务器/看门狗由**启动器**拉起 |
| **守护进程必须在自己的 `.cmd` 里重定向输出**（`>> log 2>&1`） | 这样它不持有调用者的管道 |
| **验证守护进程用下一条独立命令**（读 PID / 端口 / 日志） | 在启动它的那条命令里等 = 挂死写法 |
| **启动长命进程时，把本条命令自己的输出也丢弃** | 双保险 |
| **不要在一条命令里既起进程又杀进程** | 后台子进程会让 runner 报 job 相关错误 |
| **按 PID 杀，不要按名字过滤** | 过滤字符串会命中你自己这条命令行 |
| **一个测试要能一次跑完** | 否则是测试设计错了 |

## 脚本与编码

- **`.ps1` 文件必须纯 ASCII**：Windows PowerShell 在**没有 BOM** 时按 ANSI 读 `.ps1`，中文会把字符串截断成语法错误（`The string is missing the terminator`）。说明放在 `.cmd` 或文档里。
- **`$Home` 是只读内置变量**：用它当参数名会得到 `VariableNotWritable`。
- **PowerShell 变量名大小写不敏感**：局部 `$method` 会和参数 `$Method` 撞名。
- **别用 Python 字符串写含反斜杠的路径**：`\a`、`\t`、`\b` 会被解释成控制字符，文件里留下**不可见**的污染。写完 grep 一遍。

## 存储占用与管理

| 内容 | 位置 | 谁清理 |
|---|---|---|
| 你发来的图片 | `~/.dsh/attachments/v1/`（objects 按内容哈希去重 + request-images 每请求规范化版本） | **DSH 目前没有保留策略** —— 只增不减，除非删掉对应会话 |
| 你发来的其它附件 | `%TEMP%\dsh-qq-files\att-*` | **本插件**：每次入站清理一天前的 |
| 出站截图 | `%TEMP%\dsh-qq-screenshot-*.png` | **本插件**：每次截图清理一天前的 |

出站图片/文件上传后存在腾讯 CDN，**不占本机磁盘**，也不进 DSH 附件库。

**真正会长的是会话日志**（`~/.dsh/sessions`，zstd 压缩的 JSONL）。想回收空间的顺序应该是：清会话 > 清附件。
