# Design and implementation notes

[简体中文](design-notes.md) | **English**

This document is intended for developers modifying the plugin. It explains the reasoning behind each design decision, and the constraints that cannot be derived from reading the code. Every platform and DSH behaviour described here was verified in practice.

## Form factor: an in-process plugin

The plugin runs inside the DSH process rather than as a separate bridge process. This is not a matter of preference; it follows from the DSH authentication model.

Every request to DSH's `/api` is checked against a signed cookie (`requestRejection` in `dsh-client-connection`: the Host fence first, then `browserAuth.isAuthenticated`). That cookie is obtained by exchanging a process launch token and is bound to an authority, so an external process cannot obtain one. Any design that connects to DSH over `/api` from a separate process therefore has to solve a problem that need not exist.

Running in-process removes the following:

| What a separate process needs | The plugin |
|---|---|
| Obtain and maintain a signed cookie | Calls `ctx.sessionController` directly |
| Probe DSH liveness, queue redeliveries after a disconnect | Shares the DSH lifecycle |
| A single-instance lock | None needed |
| MCP configuration to expose QQ tools to the agent | Registers native tools with `ctx.tools.register` |
| Its own console port and token handling | Reuses the DSH token cookie and Host fence |

The cost is that plugin changes take effect only after a restart. `/restart` exists to remove that cost.

## Delivery into a running turn: steer and queue

A turn containing tool calls at `max` reasoning effort can run for minutes. A QQ message arriving during that period has two destinations:

| Delivery | DSH interface | Landing place | Read at |
|---|---|---|---|
| `steer` (default) | `agent.steer()` | `next-step` inbox | The next step boundary of the current turn |
| `queue` | `agent.followup()` | `next-turn` inbox | After the current turn has finished |

Three boundaries matter, so that `steer` is not mistaken for an interrupt:

1. **`steer` does not abort the step in progress.** It does not abort the model request already issued by that step. If the step is a five-minute tool call, the message waits for the call to return. Use `/stop` to stop immediately.
2. **`steer` does not end the turn.** `agent/turn-stopping` closes a turn only when the `next-step` inbox is empty, so an inserted message causes the current turn to continue.
3. **`/stop` does not discard inserted messages.** The Session Controller cancels with `keepInbox: true`; the inbox is preserved and processed in FIFO order once the cancellation settles.

Two implementation constraints:

- **`steer` is used only when the turn is genuinely running.** The state is read through `ctx.agents.get(sessionId)?.status` (lazily via `ctx.get`; a missing service returns `null`, meaning unknown). An idle session, a cold session, or an unreadable registry all fall back to `queue`, because queueing costs only latency while a misjudgement delivers to the wrong place. The opposite race — the turn ends just after the check — is handled by the driver: when `send()` finds the phase already aborted, it downgrades `steer` to the next turn.
- **Prefixed messages are not offered to pending interactions.** `/steer 通过` means "insert this text"; parsing it as an approval answer inverts the intent. The order is command, pending interaction, prompt, and prefixed messages skip the second stage.

One side effect: an arriving `steer` advances the reply cursor to the newest message, which refreshes the five-minute passive window in group chats.

## Inline keyboards

The `keyboard` field is the only interactive surface the platform attaches to a message. It carries three kinds of choice here: models, approvals, and single-choice question options. A tap returns to the plugin as an `INTERACTION_CREATE` event (`type=11`), with the button's `action.data` in `data.resolved.button_data`.

Six constraints apply:

- **`action.unsupport_tips` is required.** The official button documentation marks it required (the message shown to older clients). Omitting it does not merely omit a hint; on some clients the buttons do not render at all.
- **`render_data.label` is limited to 10 characters**, and model ids routinely exceed that (`deepseek-v4.1-flash` is 19). Buttons therefore show a number that is stable within the page, the real identity lives in the unlimited `action.data`, and the message body carries the number-to-model correspondence.
- **Button payloads are absolute, not positional.** `model|<provider>|<model>` rather than `model|#<index>`. The catalogue is live: if a provider disappears, positional identifiers shift and the user switches to a model they did not choose.
- **Button taps require a separate Intent subscription.** The gateway subscribes to `GROUP_AND_C2C_EVENT (1<<25)` by default and cannot receive `INTERACTION_CREATE` without `INTERACTION (1<<26)`. Without it the keyboard reaches the client but taps never return.
- **Keyboards attach only to markdown messages.** The same keyboard on a plain `msg_type: 0` message is accepted by the platform but not rendered; on `msg_type: 2` it appears immediately. Messages carrying a keyboard are therefore forced to markdown, and the `useMarkdown` setting applies only to messages without buttons.
- **A tap must be acknowledged.** After receiving `INTERACTION_CREATE`, the plugin calls `PUT /interactions/{interaction_id}` with `{code}`: 0 for success, 1 for failure, 4 for no permission. An id can be acknowledged once and never after a timeout. Sending a message is not an acknowledgement. The code is displayed in the QQ client, so a missing permission returns 4 rather than 0.

**One tap carries two ids, and they are not interchangeable.** `d.id` in the event body is the interaction id, used only for `PUT /interactions/{id}`. The `event_id` used for a passive reply is the id of the outermost event (the WebSocket frame's own `id`, shaped `INTERACTION_CREATE:<uuid>`). Sending the interaction id as a `msg_id` returns `40034024 请求参数msg_id无效或越权`; sending `d.id` as an `event_id` returns `40034025 请求参数event_id无效`. The frame id is visible only at the transport layer, so `Gateway` passes it as a third argument through to `normalizeInteraction`, and the interaction object carries both `interactionId` and `eventId`.

**A passive target must be typed, and a dead target must be handled.** The reply cursor is shared by the conversation: a dead target left in it makes every subsequent ordinary reply attempt that target and fail with it. The cursor therefore stores `replyTargetKind: 'message' | 'event'` (older saved tables are read as message), and an "expired" or "invalid" response is always treated as a dead target: clear it, then resend once as an active message.

A button tap is handled as an ordinary message: it passes admission, then reaches the pending-interaction registry as exactly the same text a human would have typed. Parsing, re-prompting, timeouts, and the race against the desktop therefore share one path. The frame's `event_id` is itself a passive reply target, so answering a tap does not consume active-message quota.

## Passive replies first

|  | Active message | Passive message (carrying `msg_id`) |
|---|---|---|
| Precondition | None, but the user may disable receipt | The user has just sent a message (60 minutes / 4 replies in direct chat) |
| Failure mode | Always fails once the user disables it | Delivered reliably within the window |
| Rate limit | 20/qpm, 1000 per day per relationship | Does not consume active quota |

**The passive window is governed by both a count and a time, and the time rule is invisible to any local counter.** A group `msg_id` expires after five minutes (60 in direct chat), and a long turn with tool calls easily exceeds five minutes, so the target is already dead when the reply is produced and the platform answers `msgid已经过期,不能回复`.

The plugin therefore does two things:

1. **Records when the reply target was armed** (`replyTargetAt`). Beyond the window it stops attempting passive delivery and uses an active message, avoiding a request that is certain to fail and the loss of a reply allowance.
2. **Retries once on rejection.** If the platform still rejects with "expired", the dead target is cleared and the message is resent once as an active message. That retry is safe: an expired target proves the message was not delivered, so no duplicate is possible.

For this reason **approval and question prompts use `deliver` (passive first, falling back to active) rather than `sendActive`**. These are the two message classes the bridge can least afford to lose: an approval that never arrives leaves the turn stalled while the operator sees nothing unusual. By the same reasoning, every send failure throws rather than returning silently, and is recorded under "last send failure" in `/status`.

## `/restart` implementation notes

`/restart` removes the need for desktop access when updating plugin code or recovering the process. The implementation addresses the following:

1. **`detached: true` does not work in this environment.** Measured: `spawn('powershell.exe', ..., { detached: true })` exits with code 0, produces no output and no side effect, and does not even emit `error`; the restarter never ran and `/restart` was merely a shutdown. The launcher is now started through `cmd /c start "" /min powershell -File <script>`: the script is written to `~/.dsh/dsh-qq-restart.ps1` (embedding multi-line quoted PowerShell in `start`'s arguments eventually produces a parsing failure, and only one path argument is needed here), and `start` gives it a console of its own. That separate console is necessary: `dsh web` runs in this process's console, which closes when this process exits, taking every process still attached to it.
2. **The port must be released first.** The launcher's criterion is "something is listening on 3080, so the service is running, just open a browser". The plugin therefore does not call the launcher directly; it starts a PowerShell that polls until the port stops accepting connections, and only then runs the launcher.
3. **The confirmation must be sent before the process exits.** A message still sitting in the send queue when the process dies has not been sent. The order is therefore: `prepare()` decides whether a restart is possible (refusing outright when it is not, never leaving the service in a state it cannot start from) → send the confirmation → `go()` writes the marker, spawns, and exits after a two-second delay.
4. **The new address must be pushed back.** Each launch mints a different token, so the previous link necessarily returns 404; that is by design. `connection.authenticatedUrl()` is the only interface that yields the address which authenticates for this process. Before exiting, the plugin records who asked in `~/.dsh/dsh-qq-restart.json`; the replacement process sends the new address to that conversation as soon as the QQ channel returns to `online`. The marker is deleted once read, so one restart produces exactly one notification.
5. **Every step must be recorded.** A restart happens unattended, and its two failure modes — the launcher never ran, or it ran but the service did not come back — look identical from QQ. The hidden PowerShell therefore writes each step to `~/.dsh/dsh-qq-restart.log`, and the notification afterwards carries the last two lines back to the conversation.
6. **A self-check precedes the restart.** `/restart` is the only channel for loading code changes, which makes a broken change potentially unrecoverable. Before handing over, the plugin imports the whole dependency graph of `lib/index.js` in a **child process** (about 107ms when healthy; the original `ERR_MODULE_NOT_FOUND` when broken) and refuses to restart if that fails. A child process is used rather than an in-process `import()` because modules are cached, and the failures worth catching — syntax errors, missing exports, a blocking top-level await — are exactly the ones that take the loader down with them.
7. **A running turn requires confirmation.** A restart discards the running turn along with the inbox, and there is no undo. Issuing `/restart` while a turn runs returns an explanation and the `/restart force` hint.

## `/usage` data sources

`/usage` reads data DSH already maintains. It does not call any provider API, and it does not report session statistics that no one can act on (such as "12 turns, 86 steps").

| File | Contents |
|---|---|
| `~/.dsh/dsh-usage/provider-snapshots.json` | Provider balances and subscription windows (percentages and reset times) |
| `~/.dsh/dsh-usage/usage-ledger.json` | Input, output and cache-read tokens and cost, per day, provider and model |

This keeps the phone and the desktop in agreement, and means the bridge never handles a credential. Two details: a balance reported under two provider ids is shown once (`deepseek` and `deepseek-official` report the same balance, and showing it twice reads as two accounts), and a provider with no balance, no subscription window and no usage today is not listed at all.

## Session and workspace commands

`/sessions` and `/workspace` are both numbered menus, because typing absolute paths and deciphering timestamps are not practical on a phone.

- `/sessions` identifies a conversation by its title (read from the same `title` projection the desktop sidebar uses) and hides archived sessions, since archiving means "stop showing me this". When no title is available it falls back to a short id and directory name, rather than showing an empty value or inventing one.
- `/workspace` lists registered projects (`workspaceRegistry.list()`, the same data as the desktop sidebar), marks the configured one, and shows the current session's working directory.
- `/new <n>` switches workspace and opens a conversation in one step. An invalid number rejects the whole command, because a half-applied command leaves the operator believing both parts happened.
- `/new` does not delete the previous conversation: the bridge only drops the binding, and the conversation is reachable again through `/sessions` and `/resume`.

## Three DSH API constraints

1. **`sessionController.create` accepts `workspaceId` or `cwd`, not both.** Passing both throws `session.create accepts workspaceId or cwd, not both`. A workspace already carries a canonical path, so `cwd` must not be passed once a workspace is registered. See `lib/bridge/session-create.js`.
2. **`sessionController.prompt(request, signal)` requires `signal`.** The implementation calls `signal.throwIfAborted()` on its first line; omitting it yields `Cannot read properties of undefined (reading 'throwIfAborted')`. The plugin uses one `AbortController` for its whole lifetime, aborting on unload, which also cancels deliveries still in flight.
3. **The waterfall runs in registration order, and plugins added through `insert:` come last.** `approval/request` and `user-questions/request` are Cordis waterfalls: each listener receives `next`, the first to return a result claims the request, and later listeners never see it. The built-in bundle that wires the desktop UI registers **before** a `dsh-qq` added through `cordis.patch.yml`; it forwards the request to the browser and waits for an answer, calling `next()` only when the browser declines. The consequence was that this plugin was never invoked at all — question and approval forwarding failed silently, with nothing in the log (the four early-return branches recorded nothing at the time, which is why it was hard to locate). The fix is to register with `{ prepend: true }`, putting the QQ side first in the chain and immediately starting `next()` to race the desktop in parallel. See `lib/bridge/questions.js` and `lib/bridge/approvals.js`.

> Every early-return branch must log. Constraint 3 above survived so long because "the handler ran and declined" and "the handler never ran" are identical in the log.

All three constraints are reproduced in the mock context, so any change that reintroduces them fails during `npm test`.
