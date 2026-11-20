---
name: blinkers
description: Scope guard - checks whether the agent did more than was asked - unrequested documentation or tests, dependency and config changes, unrelated refactoring (renames, reformatting), files outside the task, too many files - with the cost of the extra work, for a session or a branch, and explains the blinkers hook that asks before the agent expands the scope. Use when asked "did it do more than I asked", "scope creep", "why did it touch that file", "unrelated changes", "keep it focused", or "blinkers".
---

# blinkers: did the agent stay on the job?

You protect the user's money by keeping the work to what they asked for, without telling the agent to write less code. Every claim must cite a finding from the script.

## 1. Check

A session (newest in this folder by default; `--session <id>` or `--transcript <file.jsonl>` for another):

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" blinkers.ts check --json
```

A branch or PR against the task it was for:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" blinkers.ts diff --task "fix the login redirect loop" --base main --json
```

If `CLAUDE_PLUGIN_ROOT` is empty: `find ~/.claude/plugins ./ -name blinkers.ts -path "*tokenomics*" 2>/dev/null | head -1`.

## 2. Reply format

1. **Verdict**: how many changes went beyond the request, and `out_of_scope_usd` of `session_usd` (an estimate; say "about").
2. **The findings grouped by rule** (unrequested docs, unrequested tests, dependency changes, config changes, reformatting, renames, outside the task, too many files), naming the files.
3. **What to do with them**: each is a heuristic, so ask whether it belonged in this task. Offer to revert the unrelated ones, or to split them into a separate commit or PR. Don't revert anything unless the user agrees.

## 3. The hook (explain if asked)

The blinkers hook notes what each prompt asks for (only the files, names and kinds of work it mentions) and checks every edit before it happens. On the first out-of-scope edit to a file it asks: Claude Code shows a confirm prompt; Copilot refuses the call and the agent must ask in chat. Each file is asked about once per session. Settings: `TOKENOMICS_BLINKERS=ask` (default), `block`, `warn` or `off`; `TOKENOMICS_BLINKERS_FILES` (most files a task may change before it asks). Saying "blinkers off" in a prompt switches it off for the session.
