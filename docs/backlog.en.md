# Planned and undecided work

[简体中文](backlog.md) | **English**

This document records work that has been agreed but not carried out, parts known to be unfinished, and questions that remain undecided. Completed entries are removed from it, and their conclusions move into the [README](../README.md) or the [design and implementation notes](design-notes.en.md). What follows is planning, not a commitment.

## Planned work

No feature is currently agreed and unimplemented. The two sections below are what has been built but not yet verified on the wire, and what is known to be wrong.

## Known unfinished

- **The published commit history.** The batch behind `v0.2.0` still contains whole-file diffs from a line-ending conversion, and several commits that only fix the commit before them (line endings inside the repository are now uniformly LF, declared in `.gitattributes`). Tidying it would mean squashing that batch into a few commits grouped by feature, before the next release.
- **Live verification.** Verified so far: markdown rendering (the A2/B2 comparison, see the [design notes](design-notes.en.md)), table rewriting, a real `/find` search, duplicate-message suppression, and button-based questions.

  Not yet recorded as passing: the first `/doctor` run, `/todos`, the Chinese shortcut words and the `/` dropdown panel in a group chat, and the three added in this change - the plan-window alert, a long answer sent as a file, and the reminders in `/status`. All three are covered by unit tests and one forced smoke run only; no real send, no real file card, and no real Schedule projection has been exercised.
- **One publishing constraint (resolved, recorded here).** The repository's deploy key **cannot push** files under `.github/workflows/`; GitHub refuses with a missing `workflow` scope. The workaround is to add a key temporarily as an **account-level SSH key**, since a user identity may push them, and to remove it after the release. The device flow cannot be completed on this machine at all: `github.com:443` is unreachable here and only SSH gets through.

## Known issues

**An intermittent provider 400: `The reasoning_content in the thinking mode must be passed back to the API`** (on the Console Go route). An agent turn fails and the error text is forwarded to QQ. Later turns in the same session are unaffected, which points at a **rewritten history**: the session's context had been compacted, and compaction rewrites assistant turns and drops `reasoning_content`, which this provider requires to be returned verbatim in thinking mode.

When it recurs, the workaround is `/new` to start a fresh conversation, or `/model` to switch to a route that does not think. The real fix belongs to the adapter or the provider, not to this bridge. `agent/error` is now written to `/log` as well, so that the next occurrence can be located.
