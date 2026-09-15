# Planned and undecided work

[简体中文](backlog.md) | **English**

This document records work that has been agreed but not carried out, parts known to be unfinished, and questions that remain undecided. Completed entries are removed from it, and their conclusions move into the [README](../README.md) or the [design and implementation notes](design-notes.en.md). What follows is planning, not a commitment.

## Planned work

| Item | Notes | Feasibility |
|---|---|---|
| Approval memory | Within one turn, reuse the previous decision for an identical approval request (same tool, same arguments), so that repeated taps become unnecessary | Implementable in the bridge. DSH's approval granularity is only `allowed-once` and `rejected`, so this amounts to making a security decision on the user's behalf: it must be opt-in and narrowly scoped |
| Long answers as files | Beyond N chunks, send the first part plus the complete file, so that an answer does not flood the conversation | Implementable in the bridge, low cost |
| Screenshot window menu | `/screen` lists capturable windows by number and `/screen <n>` captures one, removing the need to type a process name | Requires a listing mode in `tools/capture-window.ps1` |
| Todo reminders in `/status` | Show the current session's scheduled reminders, read from the session's `schedule/change` events | DSH exposes no schedule service, only agent tools, so reminders can be read but not created by a command |

## Known unfinished

- **Push and release.** The current batch of commits (including `.github/workflows/test.yml`) has not been pushed, and pushing it requires a token with the `workflow` scope. The `v0.1.0` tag exists locally and points at a commit inside the batch; it and its commit are both unpushed. Once the batch is pushed, the tag should be moved to the release commit and given proper release notes.
- **The public commit history.** The batch history still contains whole-file diffs left behind by a line-ending conversion (line endings in the repository are now LF throughout). If the public history should be as clean, the batch can be squashed into a few commits, one per feature.
- **Live verification.** The following have no recorded complete pass on real hardware: markdown rendering (the earlier A/B was invalidated by a horizontal rule being read as a table; see the [design and implementation notes](design-notes.en.md)), an actual `/find` search, and the first real run of `/doctor`.

## Known issues

**An intermittent provider 400: `The reasoning_content in the thinking mode must be passed back to the API`** (on the Console Go route). An agent turn fails and the error text is forwarded to QQ. Later turns in the same session are unaffected, which points at a **rewritten history**: the session's context had been compacted, and compaction rewrites assistant turns and drops `reasoning_content`, which this provider requires to be returned verbatim in thinking mode.

When it recurs, the workaround is `/new` to start a fresh conversation, or `/model` to switch to a route that does not think. The real fix belongs to the adapter or the provider, not to this bridge. `agent/error` is now written to `/log` as well, so that the next occurrence can be located.

## Undecided

- **Subscription-window alerts.** Whether to warn once when the 5-hour, weekly or monthly allowance approaches its limit, in the same way as the balance warning. The data is already available and the cost is low.
- **The language of user-facing text.** Code comments are in English; the remaining gap is the text users see, and the plugin's replies are hard-coded Chinese. Options: (a) leave it as it is; (b) extract user-facing text into a replaceable language pack; (c) add English replies.
- **CI platforms.** CI currently runs only on `windows-latest`, against Node 22 and 24. Options: (a) stay on Windows alone, which matches the real environment exactly; (b) add an ubuntu matrix for better coverage, though ubuntu has not been verified locally.
