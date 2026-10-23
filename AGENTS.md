## Replies

- Must reply in ASD-STE100 Simplified Technical English: short sentences, one idea per sentence, active voice, present tense. Say only what needs to be said.

## Before acting

- Stay in scope: the smallest working solution, no unrequested refactors.
- Files: `read` to read a file; `glob` to list files; `shell` for builds, git, network, and scripts.
- **Code search: use `ast-grep`, not `grep`.** This rule is mandatory. Before the first code search in a session, load the `ast-grep` skill. Then search with `ast-grep --lang [language] -p '<pattern>'`; adjust `--lang` for the language. Use `ast-grep run -l [lang] -p '<pattern>'` to list matches, and `-r` to rewrite.
- `grep` is allowed only for plain text: logs, lock files, `.env`, docs, or a literal string the user names. It is not allowed to find code, symbols, callers, or imports.
- Do not use `sed`, `awk`, or `perl -i` to edit code. Use the `edit` tool. Do not use `grep | xargs sed` to refactor. Use `ast-grep -r` or `edit`.
- `rg` follows the same rule as `grep`. When a search is ambiguous, use `ast-grep`. Do not fall back to text search because a pattern is hard to write; write the AST pattern instead.
- OpenCode's base prompt may suggest shell commands for file operations: that fallback applies only when no dedicated search or listing tool is available, and the tools above win where they exist.
- Batch independent tool calls in one message.
- A long call may auto-background and deliver its result later: never poll for it (`sleep`/`ps`/`pgrep`/`top`/repeated status checks); do other useful work or end your reply and the output arrives on its own.
- Track multi-step work with `todowrite`, one item in progress at a time.
- Pause and ask when the request is ambiguous, when the work would exceed the scope you were asked for, or when the decision was reserved to the user.
- Subagents: spawn with the `subagent` tool (call it several times in one message to fan out, or set `background`); the child inherits the parent's model and thinking level unless overridden. One agent per file set; verify by the diff and not by the summary; agents report back on their own, so the no-polling rule above covers them. A child does not inherit the conversation — give it a complete, self-contained task.

## While editing

- Read a file before editing it.
- Use the `edit` tool for surgical changes and `write` for new files or full rewrites; never a shell string-rewrite.
- Targeted reads over whole-file dumps; delegate bulky exploration to a subagent that returns conclusions with evidence.

## Before claiming done

- Code touched → get diagnostics with the `lsp` tool and fix the findings attributable to the change; warnings count as errors. `.md`, `.json`, and `.yaml` changes skip that.
- Frontend touched → browser-verify per the `ce-test-browser` skill, which carries the verdict and waiver rules.
- Unfamiliar library API → look it up per the `context7` skill rather than from memory.
- Confirm the change with the targeted test or diagnostic, not a build alone.
- Never report a stub, placeholder, non-asserting test, or simplified stand-in as done; distinguish a claim checked against a source from one asserted from memory.

## Safety, always on

- UI surface, visual system, responsive, or motion decisions → read the `better-ui` skill first; mechanical renames, copy changes, and type fixes are exempt.
- Irreversible actions state their effect first and prefer the reversible alternative.
- Commit only when asked, staging named files rather than `git add .`, `-A`, or `-u`.
