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
- **Keyboards attach only to markdown messages.** The same keyboard on a plain `msg_type: 0` message is accepted by the platform but not rendered; on `msg_type: 2` it appears immediately. Messages carrying a keyboard are therefore forced to markdown, and the `markdownMode` setting applies only to messages without buttons.
- **A tap must be acknowledged.** After receiving `INTERACTION_CREATE`, the plugin calls `PUT /interactions/{interaction_id}` with `{code}`: 0 for success, 1 for failure, 4 for no permission. An id can be acknowledged once and never after a timeout. Sending a message is not an acknowledgement. The code is displayed in the QQ client, so a missing permission returns 4 rather than 0.

**One tap carries two ids, and they are not interchangeable.** `d.id` in the event body is the interaction id, used only for `PUT /interactions/{id}`. The `event_id` used for a passive reply is the id of the outermost event (the WebSocket frame's own `id`, shaped `INTERACTION_CREATE:<uuid>`). Sending the interaction id as a `msg_id` returns `40034024 请求参数msg_id无效或越权`; sending `d.id` as an `event_id` returns `40034025 请求参数event_id无效`. The frame id is visible only at the transport layer, so `Gateway` passes it as a third argument through to `normalizeInteraction`, and the interaction object carries both `interactionId` and `eventId`.

**A passive target must be typed, and a dead target must be handled.** The reply cursor is shared by the conversation: a dead target left in it makes every subsequent ordinary reply attempt that target and fail with it. The cursor therefore stores `replyTargetKind: 'message' | 'event'` (older saved tables are read as message), and an "expired" or "invalid" response is always treated as a dead target: clear it, then resend once as an active message.

A button tap is handled as an ordinary message: it passes admission, then reaches the pending-interaction registry as exactly the same text a human would have typed. Parsing, re-prompting, timeouts, and the race against the desktop therefore share one path. The frame's `event_id` is itself a passive reply target, so answering a tap does not consume active-message quota.

## The platform's instruction panel

The bridge once sent a shortcut menu of its own buttons; the platform's instruction panel has replaced it. Three properties decided the choice:

1. **The panel exists in group chats as well.** The platform's older "custom menu" is direct-chat only, and this deployment is driven mainly from a group, so an entry point confined to direct chats is of limited use.
2. **A panel can be scoped to specific conversations.** It is installed with `target_type: specific` and an accompanying `group_openids` / `user_openids` list, so it covers only the conversations this bridge has bound (at most twenty per scope) and leaves every other user's interface untouched.
3. **A panel survives restarts.** It carries a `remark`, which the platform stores but never displays, so a later install finds the same panel and updates it in place instead of accumulating new ones.

The panel also costs no messages: a tap only **fills the input box with the item's name**, and the send button still has to be pressed. The items are therefore written as the commands themselves, which leaves one press between a tap and a correct command. `/steer` and `/queue` are excluded because they carry text, and a tap that filled the input box with them would leave the operator to finish the sentence.

The panel is a **copy of this build's command list**, and it starts to lie the moment that list changes. That happened: the operator's picker kept offering ten commands while the bridge already answered seventeen. Every start-up therefore refreshes panels that exist, but **refreshes only and never creates**: deleting a panel is an explicit act, and rebuilding it at start-up would quietly undo that decision. Installing a panel is itself always an explicit act (`/menu install`, owner only), because it writes to the bot's own configuration rather than to the conversation.

## Shortcut words and whole-message matching

A command may be written without its slash, and Chinese has a further seventeen words, one per command and with no synonyms; a match requires the whole message and ignores case.

**The shortcut words are the only command entry point that works by voice.** The platform transcribes a voice message into text, so the Chinese words and the command names can both be spoken, while a dropdown cannot be opened by voice - which is the main difference between the two, and the reason the shortcut words were kept. They also avoid a second table to maintain: English reuses the command name itself (`status` is `/status`) and only Chinese needs a lookup table, and **a table of synonyms is harder to remember than the commands it replaces**, so each command gets exactly one word.

Because the match is on the whole message, 「任务完成了」 stays a sentence; and because it ignores case, `status`, `Status` and `STATUS` are equivalent.

## Commands behind a leading mention

The platform writes a mention into the message body itself: in a group, `@bot /usage` arrives as `<@ABC> /usage`. Command detection therefore saw a message beginning with a mention and `/usage` stopped being a command - a failure that actually occurred.

Detection now strips one or more leading mentions, and **detection only**. The body handed to the agent is unchanged, because the mention is something the user wrote.

The stripped copy must serve both the shortcut lookup and the slash test that follows it. The first fix used it for the shortcut lookup alone and fell back to the original text whenever the word was not a shortcut - which is every slash command - so the mention came straight back and `/usage` stayed broken. The tests in place at the time asserted only that something had been sent, and a failure path sends something too, so they passed while the feature was broken; they now assert the command's own output, and that the mention does not appear in it.

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

## Outbound encoding: one decision per message

Whether an answer goes out as markdown or as plain text is **decided once, before it is split**, and the decision then travels with every chunk of that message. It used to be taken again for each chunk, which let the two disagree: the plain-text conversion removes the very feature the decision was based on (a table), so a body that had already been converted could be sent as markdown (`msg_type: 2`).

Under `auto` the rule is: markdown whenever the platform renders the text faithfully. The platform supports bold, italics, lists, quotes and rules but does not render tables, so a table is the one case where plain text reads better - and that rule only holds because the plain-text path rewrites a table as `· header: value` lines. (An earlier version already claimed the fallback, but the converter had no table handling at all: a table arrived as a row of pipes in both encodings, and falling back to plain text merely cost the rest of the message its formatting.)

A message carrying a keyboard is always markdown, because buttons render only on a markdown body. The `markdownMode` setting therefore decides only the messages that carry no buttons.

The decision leaves a trace: every send records the encoding it used, and a fallback to plain text records its reason as well. Without that, "why did that one arrive flat" cannot be answered after the fact.

## Long answers become a file

A measurement on the live deployment decides this rule: a long answer exhausts the passive reply window partway through (`passive reply window spent` recurs in the log), after which every chunk consumes the active-message quota instead. If the operator has switched active messages off in the QQ client, the remaining chunks cannot be sent at all - the second half of the answer is lost, and nothing on the QQ side records that it happened.

An answer that would be split into **more than** `longAnswerChunks` chunks (4 by default, `0` disables) is therefore sent as **its opening chunk plus the complete text as one `.md` file**, and nothing else. The trigger counts chunks rather than bytes because the cost is counted in messages: the passive window expires by count and by time, and the active quota is charged per message.

Five implementation details:

1. **The file goes first, the message second.** The message carrying the opening says "the complete content has been sent as a file", and that is true only once the file card is already there.
2. **The opening must give up room for the notice.** The notice follows the first chunk. Splitting to `maxBytes` first and appending afterwards would produce exactly the over-long message the split exists to prevent, so the file path re-splits at `maxBytes` minus the notice's byte length and takes only the first piece.
3. **The file is written under the OS temp directory and removed on every path.** The temp directory is the one location that can be assumed writable; a file leaked per long answer would fill it on a deployment that runs for months.
4. **A failed upload falls back to sending every chunk.** Because the file goes first, an upload failure means nothing has been sent yet, which is what makes the fallback safe: more messages are better than a lost answer. A send endpoint that fails after a successful upload belongs to the same case - the file card never arrived, so the fallback cannot duplicate anything, and the message carrying the opening never claims a file that is not there.
5. **A keyboarded message is no exception.** The single message is the opening chunk, so the buttons ride on it; a keyboard already forces markdown, which is independent of the file's extension.

The file's body is exactly the prepared body the chunks were cut from: even when `markdownMode: never`, or a table, sends the messages as plain text, the file holds the same content, so the file and the messages cannot contradict each other. The extension stays `.md` regardless of that encoding decision.

`sendQuoted` (the `qq_reply` tool's quoted reply) does not take this path: it quotes a specific inbound message by `msg_id`, which is a different route. It used to prepare its text with `this.#prepare(text, keyboard, key)`, where `keyboard` does not exist in that scope - every call threw a `ReferenceError` before sending anything. The tool tests could not see it, because the sender they inject is a double.

## When a line of text is a table

A table exists only where **a delimiter row sits directly beneath a row of cells**, and both lines must carry a pipe. `readTable` requires the candidate header row to start and end with `|`, the next line to be a delimiter row, and at least one body row after it; `canRenderAsMarkdown` applies the same condition to decide whether a piece of text contains a table.

The earlier rule matched a delimiter on a single line, so `---` - an ordinary horizontal rule - matched too: every message containing a rule, which describes most reports, was classified as a table and converted to plain text, and the markdown path the rule exists to select was never taken at all. What exposed it was the live A/B test: the two messages under comparison rendered identically, and "identically" is precisely the sign that both had taken the same path.

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
