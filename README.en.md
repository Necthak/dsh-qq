# dsh-qq

A DSH plugin that drives a local DeepSeek Harness session from an official QQ bot, so an agent running on a desktop machine can be operated from a phone.

QQ messages are delivered as user messages in a DSH session. Agent replies, tool approval requests and `ask_user_question` prompts are routed back to QQ. The purpose is to remove the desktop from the loop for remote work.

```
Phone QQ  ──►  QQ Open Platform  ──►  dsh-qq plugin  ──►  DSH agent
   ▲              (official API)        (in-process)       (local shell / files)
   └──────────  replies · approvals · questions · images · files  ──────────┘
```

---

## Features

| Capability | Notes |
|---|---|
| Two-way conversation | Direct and group chats share one delivery path; group chats support the receive-all mode (no @ mention required) |
| Delivery into a running turn | Insert a message into the current turn (`steer`) or queue it for after the turn (`queue`) |
| Approvals and questions | Tool approvals arrive as Approve / Deny buttons; single-choice `ask_user_question` prompts arrive as buttons |
| Images, both directions | Inbound images are inlined for the model; outbound supports screenshots and images |
| Files, both directions | Inbound attachments are written to disk and their path is given to the agent; outbound supports arbitrary files (reports, logs, diffs) |
| Session and workspace management | `/sessions` shows titles and hides archived sessions; `/workspace` is a numbered menu; `/new <n>` switches project and opens a conversation in one step |
| Balance and usage | `/usage` shows provider balances, subscription windows, and today's tokens and cost |
| Screenshots | `/screen` captures the full screen or one window; a `qq_send_screenshot` tool is available to the agent |
| Remote restart | `/restart` restarts the process from a chat message and sends the new address of the replacement process back to the conversation |
| Crash recovery | A watchdog installed beside the launcher brings the server back within 60 seconds and records the time and circumstances of the failure |

## Requirements

- **Windows** — screenshots and the watchdog depend on PowerShell
- **Node.js 22+** and **DSH** (`dsh web`, or `--profile web`)
- An **official QQ bot** (QQ Open Platform); group notifications must be enabled on the bot's profile page if group messages are wanted

## Installation

The plugin is assumed to live in `C:\Users\<user>\Documents\dsh-qq`:

```bash
git clone https://github.com/Necthak/dsh-qq.git
cd dsh-qq && npm install
```

Mount it on the web profile:

1. Add to `dependencies` in `~/.dsh/profiles/web/package.json`:
   ```json
   "dsh-qq": "link:C:/Users/<user>/Documents/dsh-qq"
   ```
2. Append to `~/.dsh/profiles/web/cordis.patch.yml`:
   ```yaml
   - insert:
       - id: dsh-qq
         name: dsh-qq
   ```
3. Install and verify:
   ```bash
   cd ~/.dsh/profiles/web && npx pnpm install
   dsh --profile web --dump-config | grep dsh-qq
   ```
4. Restart the DSH web service. Plugin changes take effect only after a restart; afterwards `/restart` can be used instead.

## Configuration

Open the DSH settings page → General → **QQ 机器人** (QQ bot) card.

1. **Pair by QR code (recommended)** — select "扫码绑定" (pair by QR code) and scan the code with mobile QQ, then choose the bot. The plugin obtains that bot's AppID and AppSecret through Tencent's official `@tencent-connect/qqbot-connector` and stores them; the secret never passes through the clipboard. Manual entry is also supported, as are the `DSH_QQ_APPID` and `DSH_QQ_APPSECRET` environment variables.
2. **Set the owner** — in the default `closed-agent` mode, no sender is admitted until an owner is set (fail-closed). Send the bot a message; it is rejected, but the sender appears under "最近被拒绝的发送者" (recently rejected senders) on the settings card, where "设为 owner" (set as owner) admits them. That list lives only in memory, expires after 30 minutes, holds at most 20 entries, and never replies to strangers.
3. **Enable the channel** — the switch at the top of the settings card starts the connection; the card then shows `通道：online` and the number of bound conversations.

### Modes

| Mode | Admission | Agent capability |
|---|---|---|
| `closed-agent` (default) | Owner's direct messages only; group chats are never admitted | Full tool set |
| `chat` | By allow list, in direct and group chats | Intended for restricted chat scenarios |

The `deny` list takes precedence over admission in both modes.

### Main settings

| Setting | Default | Meaning |
|---|---|---|
| `busyDelivery` | `steer` | How a message arriving mid-turn is delivered; `/steer` and `/queue` override it per message |
| `progressIntervalMs` | `0` (off) | Interval for long-turn progress updates. Every update is a real message and spends send quota |
| `lowBalanceThreshold` | `5` | Warn once a day below this balance; `0` disables the warning |
| `workspacePath` | empty | Working directory for new QQ sessions; empty uses the DSH process directory |
| `agentPreset` | empty | Agent preset used by QQ sessions |
| `allowAgentSend` | `true` | Whether the agent may send QQ messages on its own |
| `forwardApprovals` / `forwardQuestions` | `true` | Whether approvals and questions are forwarded to QQ |
| `restartCommand` | empty | Launcher used by `/restart`; empty adopts `Documents\Start-DeepSeek-Harness.cmd` when that file exists |

## Commands

Send these in QQ. Anything not starting with `/` is delivered to the agent as ordinary input.

| Command | Purpose |
|---|---|
| `/help` | Show help |
| `/status` | Channel state, bound conversations, open interactions, current model, last send failure, current turn progress |
| `/model` | List available models by provider, numbered; `←` marks the current one |
| `/model <n> [effort]` | Switch model (owner only) |
| `/new`, `/reset` | Start a new conversation (owner only). The previous one is kept and can be reached with `/sessions` and `/resume` |
| `/new <n>` | Switch to that workspace and start a new conversation |
| `/stop` | Cancel the running turn (owner only; queued messages are kept) |
| `/steer <text>` | Insert text into the running turn |
| `/queue <text>` | Queue text for after the current turn |
| `/workspace` | List registered projects with numbers, and the current directories |
| `/workspace <n\|path>` | Switch the working directory for new sessions (owner only) |
| `/sessions [count]` | List recent sessions with titles, excluding archived ones |
| `/resume <n\|session id>` | Rebind this conversation to an existing session (owner only) |
| `/usage` | Balances, subscription windows, and today's tokens and cost |
| `/screen [process]` | Capture the screen and send it here (owner only) |
| `/restart`, `/restart force` | Restart the DSH process (owner only; `force` is required while a turn is running) |

## Agent tools

| Tool | Purpose |
|---|---|
| `qq_send_message` | Send a message to the current QQ conversation |
| `qq_reply` | Reply quoting a specific message |
| `qq_send_image` | Send an image (png / jpeg) |
| `qq_send_file` | Send an arbitrary file (report, log, diff; 200MB soft limit) |
| `qq_send_screenshot` | Capture the screen or one window and send it |
| `qq_get_status` | Read-only status |

Sending tools are bound by the same **allow list** as inbound admission: the target must be an existing conversation that is still admitted, so the agent cannot address arbitrary recipients. A message sent through a tool suppresses the automatic forwarding of that turn, which avoids duplicates.

## Architecture

The plugin runs **inside the DSH process** and uses DSH's own services, so it maintains no session cookie, no liveness probe, no single-instance lock and no MCP configuration:

| DSH service | Used for |
|---|---|
| `ctx.sessionController` | Creating sessions, delivering prompts, switching models, cancelling turns |
| `ctx.on('session/event')` | Collecting agent output per turn |
| `ctx.on('approval/request')` / `user-questions/request` | Answering agent requests from QQ |
| `ctx.tools` | Registering QQ tools for the agent |
| `ctx.sessionProjections` | Reading model selection, session titles, usage |
| `ctx.settings` / `ctx.webServer` | Settings card and console routes |
| `ctx.workspaceRegistry` | Project list and the archived-session set |

Module layout (`lib/`):

```
index.js        Plugin entry: settings, lifecycle, wiring
client.js       Settings card (browser side, no build step)
console.js      /dsh-qq/{state,config,pair} routes
pairing.js      QR-code pairing
md-to-plain.js  Markdown to plain text, byte-budgeted chunking
qq/             token · OpenAPI · WebSocket gateway · event normalisation
bridge/         admission · delivery · session table · outbound queue · pending
                interactions · commands · tools · capture · credit · restart
```

Design notes: **[docs/design-notes.md](docs/design-notes.md)**. Operations and troubleshooting: **[docs/operations.md](docs/operations.md)** (both in Chinese).

## Known limitations

Not supported by the official API:

- **Group history** — no such endpoint; the receive-all mode only delivers messages sent after it was enabled
- **Simulated group members / social state machines** — earlier context is unavailable
- **Channels (text sub-channels, channel direct messages)** — not implemented

These require a personal-account protocol such as OneBot or SnowLuma, which carries a risk of account suspension. `lib/qq/` is isolated per transport, so adding a backend does not require touching `lib/bridge/`.

Platform constraints, all handled by the implementation:

- Passive reply windows: 60 minutes / 4 replies in direct chat, 5 minutes / 5 replies in groups; beyond that, sending falls back to an active message
- Active messages are rate limited (20/qpm, 1000 per day per relationship) and can be disabled entirely by the user in the QQ client, in which case they always fail
- Only png and jpeg images are rendered; other formats are rejected before upload
- The same `msg_id` may be pushed more than once, and a repeated `msg_id` / `msg_seq` pair is rejected

## Development

```bash
npm test          # 295 unit tests
```

- The test suite is offline: HTTP, WebSocket and DSH services are injected as doubles
- After changing plugin code, send `/restart` in QQ to reload it (the replacement process imports from disk)
- Please make sure `npm test` passes before committing

## Licence

[MIT](LICENSE)
