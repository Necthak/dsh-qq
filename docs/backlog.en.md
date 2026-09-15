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

- **The published commit history.** The batch behind `v0.2.0` still contains whole-file diffs from a line-ending conversion, and several commits that only fix the commit before them (line endings inside the repository are now uniformly LF, declared in `.gitattributes`). Tidying it would mean squashing that batch into a few commits grouped by feature, before the next release.
- **Live verification.** Verified so far: markdown rendering (the A2/B2 comparison, see the [design notes](design-notes.en.md)), table rewriting, a real `/find` search, duplicate-message suppression, and button-based questions. Not yet recorded as passing: the first `/doctor` run, `/todos`, and the Chinese shortcut words and the `/` dropdown panel in a group chat.
- **One publishing constraint (resolved, recorded here).** The repository's deploy key **cannot push** files under `.github/workflows/`; GitHub refuses with a missing `workflow` scope. The workaround is to add a key temporarily as an **account-level SSH key**, since a user identity may push them, and to remove it after the release. The device flow cannot be completed on this machine at all: `github.com:443` is unreachable here and only SSH gets through.

## Known issues

**An intermittent provider 400: `The reasoning_content in the thinking mode must be passed back to the API`** (on the Console Go route). An agent turn fails and the error text is forwarded to QQ. Later turns in the same session are unaffected, which points at a **rewritten history**: the session's context had been compacted, and compaction rewrites assistant turns and drops `reasoning_content`, which this provider requires to be returned verbatim in thinking mode.

When it recurs, the workaround is `/new` to start a fresh conversation, or `/model` to switch to a route that does not think. The real fix belongs to the adapter or the provider, not to this bridge. `agent/error` is now written to `/log` as well, so that the next occurrence can be located.

## Undecided

- **Subscription-window alerts.** Whether to warn once when the 5-hour, weekly or monthly allowance approaches its limit, in the same way as the balance warning. The data is already available and the cost is low.
- **The language of user-facing text.** Code comments are in English; the remaining gap is the text users see, and the plugin's replies are hard-coded Chinese. Options: (a) leave it as it is; (b) extract user-facing text into a replaceable language pack; (c) add English replies.
- **CI platforms.** CI currently runs only on `windows-latest`, against Node 22 and 24. Options: (a) stay on Windows alone, which matches the real environment exactly; (b) add an ubuntu matrix for better coverage, though ubuntu has not been verified locally.
