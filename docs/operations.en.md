# Operations and troubleshooting

[简体中文](operations.md) | **English**

This document is intended for deployment and maintenance. It describes where the logs are, how to investigate a fault, and a number of constraints confirmed during implementation and operation. Each item names where it is handled.

## Logs and state files

| File | Contents |
|---|---|
| `~/.dsh/web-launch.log` | Main log. Every plugin line carries a wall-clock time (`[dsh-qq 21:39:04] …`) |
| `~/.dsh/dsh-qq-restart.log` | Restarter progress: waiting for the port, running the launcher, port listening again |
| `~/.dsh/dsh-qq-watchdog.log` | Watchdog: start-up, the server being found gone, the circumstances, recovery and downtime |
| `~/.dsh/dsh-qq-watchdog.out.log` | The watchdog process's own output; empty under normal operation |
| `~/.dsh/dsh-qq-sessions.json` | QQ-to-DSH conversation mapping, including the reply cursor and the last admitted sender |
| `~/.dsh/dsh-usage/*.json` | The balance and usage ledger DSH maintains, and the source for `/usage` |

The timestamps are deliberate. Without a clock, repeated gateway reconnects in the log cannot be distinguished from normal session expiry spread over hours, and that misreading has occurred.

## Troubleshooting

### The bot stops responding

1. Run `netstat -ano | findstr :3080` to check whether anything is listening.
2. If nothing is, check `dsh-qq-watchdog.log` for a new `server is DOWN` entry. It records the time, whether the server process lingered or had vanished, and the last lines the server wrote.
3. If something is listening, check the `gateway` lines in `web-launch.log`:
   - `gateway discovery failed` or `reconnecting to the gateway in Nms` means a network problem; the connection recovers on its own;
   - output stopping after `QQ channel starting …` means the process is gone; see step 2.

### The service does not come back after a restart

1. Read the last lines of `dsh-qq-restart.log`; the restart notification carries the same content.
2. If the launcher ran but the service did not come back, look for the new process's error in `web-launch.log`, which is usually a plugin load failure.
3. `/restart` performs a pre-flight self-check: a broken change is refused rather than leaving the service in a state it cannot start from.

## Counter-intuitive platform fields

| Symptom | Cause | Handled in |
|---|---|---|
| Buttons do not render on some clients | `action.unsupport_tips` is required | `bridge/keyboard.js` |
| The client waits forever after a tap | The tap must be acknowledged with `PUT /interactions/{id}`; sending a message is not an acknowledgement | `qq/api.js` |
| `40034024` when acknowledging a tap | The interaction id was used as a `msg_id`; the frame's event id is the correct value | `qq/events.js`, `qq/gateway.js` |
| `40034025 请求参数event_id无效` | `d.id` was used as an `event_id`; it is taken from the outermost event id | same |
| A keyboard does not appear | Keyboards render only on markdown messages (`msg_type: 2`) | `bridge/outbound.js` |
| `850019 富媒体文件格式不支持` after an image upload | Part offsets must not be computed as `index × block_size`: the live API returns the first part with index **1**, so that formula slices past the end and every part is empty | `qq/api.js` |
| A presigned PUT is refused | It must not carry `Authorization` or a JSON content-type | `qq/api.js` |
| HTTP 200 but the message never arrived | The response must carry an `id` to count as delivered | `bridge/outbound.js` |
| The same message is executed twice | The platform may push the same `msg_id` more than once; the bridge records the last 50 handled ids per conversation and drops repeats, checking after admission and before any dispatch | `bridge/inbound.js` |

## Processes, consoles and restarts

| Symptom | Cause | Handled in |
|---|---|---|
| Every restart adds a 404 page | A listening port does not mean the new process has printed its own URL line; reading too early picks up the previous process's token | `dsh-web-url.ps1`, launcher |
| `/restart` only shuts down | Node's `detached: true` is silently a no-op in this environment (exit code 0, no side effect, no `error` event) | `bridge/restart.js` |
| The restarter has no console of its own | `dsh web` runs in this process's console, and exiting closes it, terminating every process still attached | same (`start` gives it a separate console) |
| The bridge disappears after a code change and restart | A broken change prevents the new process from loading the plugin, and `/restart` is the only loading channel | `verifyPluginLoads` pre-flight |

### The server must not be hosted by a visible console window

The service was twice found to have disappeared overnight with no trace: nothing in the log, no crash record in the Windows event log, and no output at all.

The cause was that the process was hosted by the minimised console window the launcher creates. Closing that window raises `CTRL_CLOSE_EVENT`, which exits the process cleanly and leaves no record. The window's taskbar title is cmd's own default, `C:\WINDOWS\system32\cmd.exe` (a title set in `start` is overwritten by the child cmd), so it looks like a stray command prompt.

The solution is to start the server with no window at all: `Start-DeepSeek-Harness.server.cmd` holds the command line, `Start-DeepSeek-Harness.ps1` starts it windowless, and `Stop-DeepSeek-Harness.cmd` stops it deliberately (finding the PID by port, killing by PID, and stopping the watchdog first).

**`Start-Process -WindowStyle Hidden` does not work for a console program**: the child inherits the caller's console, keeps writing to it, and dies with it. The working form is `ProcessStartInfo` with `UseShellExecute = $false` and `CreateNoWindow = $true`.

## Crash forensics

After the process disappeared twice without trace, four layers of evidence were put in place:

- `process.on('exit')` records the exit code and marks whether the exit was requested by `/restart` (`restart.pending` is set in `go()`). The two cases have entirely different follow-ups, and the log is the only witness.
- `SIGINT`, `SIGTERM`, `SIGHUP` and `SIGBREAK` are recorded and then re-raised. Node's default for an unhandled signal is to exit, and merely adding a listener suppresses that default, quietly turning Ctrl+C into a no-op.
- A watchdog restarts the server within 60 seconds of it disappearing, and records the time, whether the process lingered, the last lines it wrote, and the downtime.
- Timestamps on every log line: without a clock, repeated reconnects cannot be distinguished from normal expiry spread over hours.

> A process killed with `taskkill /F`, or terminated by a console close, executes no JavaScript at all. The forensic log therefore has a blind spot, which is precisely why the watchdog has to exist.

## Network request deadlines

`fetch` has no default timeout. Once `getGateway()` stalls, its promise never settles: it never rejects (so nothing retries) and never logs (so it looks like a successful start). The channel is silently dead until the next restart. This was the root cause of a restart leaving the bot unresponsive for fifteen minutes.

The fix is an `AbortSignal.timeout(...)` on every outbound request: 30 seconds for OpenAPI, 120 seconds for presigned part uploads, 30 seconds for the token. A stall becomes a visible failure and enters the existing backoff-and-reconnect path.

Do not paper over a failure with a wrapper: `gateway.start()` once returned `undefined`, so `Promise.resolve(start()).catch(...)` was attached to nothing at all. A fallback must be attached to a real promise.

## Route authorisation

`webServer.register` only files a route in a table. It applies neither the trusted-host check nor the browser-session check, both of which live on the `/api` chain. The consequence is DNS rebinding: any page can resolve a hostname to 127.0.0.1, and the browser then sends the attacker's Host to `/dsh-qq/config`, which handles it normally.

The correct form is to call `ctx.get('connection')?.requestRejection?.(req)` at the top of each handler and end the response with `writeHead(r)` when the result is not `undefined`. Every first-party DSH plugin does this.

To check it:

```bash
curl -H "Host: evil.example.com" http://127.0.0.1:3080/dsh-qq/state   # expect 403
curl http://127.0.0.1:3080/dsh-qq/state                               # expect 401
```

## Data operations

| Symptom | Cause |
|---|---|
| Scanning session logs returns nothing | `zlib.zstdDecompressSync` and `createZstdDecompress` both decode only the **first frame**, while session logs are appended frame by frame (a 3.8MB log holds 2383 frames). Decoding one frame reads 208 bytes, from which "no attachment is referenced" was wrongly concluded |
| The correct way to read them | Split on the zstd magic `28 b5 2f fd` and decode frame by frame; then verify that **every** frame succeeded. A failed frame means the split was wrong, and the result must not be used for a decision |
| Treating an empty set as a conclusion | A scan reporting "0 referenced hashes" is itself an alarm, not a fact. An empty result must be verified before it is acted on: one misjudgement permanently deletes data that is still referenced, and `fs.rmSync` does not use the Recycle Bin |
| A persisted table that "saves the whole object but restores an allow-list of fields" | A newly added field silently disappears on every restart, and the next save erases it from disk as well. `#load` must normalise the known fields and preserve the unknown ones |

## Screenshots

| Symptom | Cause |
|---|---|
| The image is missing its right or bottom edge | The capturing process does not declare DPI awareness, so window dimensions are read smaller than they are. `SetProcessDPIAware()` must be called first |
| A large blank frame is captured, containing whatever is behind it | Window selection cannot be based on area alone; the chosen window must be one that draws its own content |
| A browser screenshot shows the state before the tab was switched | `PrintWindow` returns a stale frame for GPU-composited windows: neither an error nor a flat colour. Use `-Method screen`, after `SetForegroundWindow` |
| A tab switch does not take effect | UIA `Select()` returning success does not mean the switch happened; read `IsSelected` back to confirm |
| A grey image is sent as a screenshot | An unrendered session or a hidden window captures as a flat colour, and the flat-colour check reports an error instead of sending it |

## Shell constraints

**The blocking mechanism** is not the Job object. The root cause is that a child process inherits the caller's stdout pipe. For as long as that child runs, the pipe stays open and any reader (`tail`, command substitution) waits for an EOF that never comes. Starting a process that never exits inside one command therefore blocks that command indefinitely.

| Constraint | Reason |
|---|---|
| Wrap every command in `timeout N` | A mistake then costs N seconds rather than a blocked turn |
| Never start a long-lived process from the shell | It holds the stdout pipe. The server and the watchdog are started by the launcher |
| A daemon must redirect its own output in its `.cmd` (`>> log 2>&1`) | So that it does not hold the caller's pipe |
| Verify a daemon from a separate, later command (PID, port, log) | Waiting inside the command that started it is the blocking pattern |
| Discard the command's own output when starting a long-lived process | A second line of defence |
| Never start and kill processes in the same command | A background child triggers the runner's job errors |
| Kill by PID, never by process-name filter | A name filter also matches the command line doing the filtering |
| A test must complete in a single run | Otherwise the test design is at fault |

## Script and encoding constraints

- **A `.ps1` file must be pure ASCII.** Windows PowerShell decodes a file without a BOM as ANSI, and non-ASCII text truncates strings into syntax errors (`The string is missing the terminator`). Explanations belong in the `.cmd` file or the documentation.
- **`$Home` is a read-only automatic variable.** Using it as a parameter name yields `VariableNotWritable`.
- **PowerShell variable names are case-insensitive.** A local `$method` collides with a `$Method` parameter.
- **When editing a repository file from Python, pass `newline=''` explicitly.** The default text mode normalises CRLF to LF, so writing the file back turns every line into a change: that is how `test/outbound.test.js` acquired 540 phantom changed lines.
- **Do not write Windows paths through Python string literals.** `\a`, `\t` and `\b` become control characters and leave invisible corruption in the file. Check for control characters after writing.

## Storage

| Content | Location | Cleaned by |
|---|---|---|
| Inbound images | `~/.dsh/attachments/v1/` (objects deduplicated by content hash; request-images holds the per-request normalised version) | DSH has no retention policy today; the store only grows unless the owning session is deleted |
| Other inbound attachments | `%TEMP%\dsh-qq-files\att-*` | This plugin: anything older than a day is removed on each inbound file |
| Outbound screenshots | `%TEMP%\dsh-qq-screenshot-*.png` | This plugin: anything older than a day is removed on each capture |

Outbound images and files are stored on Tencent's CDN after upload; they use no local disk and do not enter the DSH attachment store.

The real growth is in session logs (`~/.dsh/sessions`, zstd-compressed JSONL). Space is best reclaimed by deleting sessions first and attachments second.
