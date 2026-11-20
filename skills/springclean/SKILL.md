---
name: springclean
description: Audits context hygiene - CLAUDE.md, AGENTS.md, copilot-instructions.md, imports, nested instruction files and MCP servers - for duplicated instructions, outdated paths and commands, oversized files, changelogs and long examples, and contradictions, then proposes a cleanup with estimated token and money savings. Use when asked to clean up CLAUDE.md, "context debt", "why is my context so big", "are my instructions duplicated or out of date", or "springclean".
---

# springclean: context hygiene audit

Instruction files ride along with every request of every session, so a stale line is paid for again and again. Treat context as a maintained asset.

## 1. Audit

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" springclean.ts --json
```

- Runs on the current folder; `--dir <path>` for another. Read-only.
- If `CLAUDE_PLUGIN_ROOT` is empty: `find ~/.claude/plugins ./ -name springclean.ts -path "*tokenomics*" 2>/dev/null | head -1`.

## 2. Reply format

1. **Headline**: `startup_tokens` loaded with every session and which files; the proposed saving (`savings.tokens` per request, `savings.per_month`, and its `basis`).
2. **Proposed cleanup**, grouped and biggest first. For each finding: file and line, what is wrong, the `action`.
   - **contradiction**: always list these first, whatever their size: the agent may follow either rule. Ask the user which one is right.
   - **duplicate**: keep one copy; link or `@import` it from the other file.
   - **outdated**: fix or delete; an agent following a dead command wastes a turn.
   - **bloat / oversized**: move to docs the agent can open on demand; keep a one-line pointer.
   - **startup**: move folder-specific rules into nested CLAUDE.md files (loaded only when working there); trim MCP servers most sessions don't use.
3. **Offer to apply it**: show the exact edits as a diff and apply only what the user approves. Never delete a contradiction's side without asking which is right.

Don't edit CLAUDE.md mid-session without warning: it changes the prompt prefix, so the next request rebuilds the cache once. Suggest doing the cleanup at the end of a session.
