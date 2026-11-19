# tokenomics

Understand where your AI tokens go. Works with **Claude Code** and **GitHub Copilot CLI**.

## Components

| Component | Type  | What it does |
|-----------|-------|--------------|
| **spendlens** | hooks | Tags each session **OPEX** (run: insights, logs, metrics, Grafana, incidents) or **CAPEX** (build: code generation), or `mixed` / `unknown`, and logs it with the session id to SQLite. |

| **critical-friend** | skill | Reviews your prompts and prompt-cache usage for the current session and suggests improvements (cache hit ratio, cache rebuilds, vague or correction-heavy prompts, oversized context, repeated file reads, mixed topics). Ask: "critical friend", "review my prompts", "why was that session expensive?". |

More hooks, tools and skills will be added here.

## Requirements

- Python 3.8+ on your PATH (`python3` on macOS/Linux, `python` on Windows). No packages needed.
- Claude Code and/or GitHub Copilot CLI.
- Somewhere to host the plugin: a Git repo (recommended) or a local folder.

## Install: Claude Code

### Option A: from a Git repo (recommended for teams)
1. Push this folder to a Git repo, e.g. `your-org/tokenomics`.
2. In Claude Code:
   ```
   /plugin marketplace add your-org/tokenomics
   /plugin install tokenomics@tokenomics
   ```
3. Restart Claude Code (or run `/reload-plugins`) so the hooks load.

The repo doubles as a marketplace (`.claude-plugin/marketplace.json`), so teammates use the same two commands.

### Option B: from a local folder
```
/plugin marketplace add ./path/to/tokenomics
/plugin install tokenomics@tokenomics
```

### Option C: try it for one session, no install
```
claude --plugin-dir ./path/to/tokenomics
```

### Verify
- Run `/plugin` and check `tokenomics` is listed and enabled.
- Run `/hooks` and look for `UserPromptSubmit`, `Stop` and `SessionEnd` entries.
- Send any prompt, then run the query under "Check the data".

### Update / remove
```
/plugin marketplace update tokenomics
/plugin uninstall tokenomics
```

## Install: GitHub Copilot CLI

```
copilot plugin install your-org/tokenomics          # from a GitHub repo
copilot plugin install ./path/to/tokenomics         # from a local folder
```
Then start `copilot`, check `/plugin list` shows `tokenomics`, and send a prompt.

Notes:
- Copilot reads `plugin.json` and `copilot-hooks.json` at the plugin root (`userPromptSubmitted` and `sessionEnd` hooks).
- Copilot's hook payload may not include a session id. If it doesn't, spendlens falls back to an id built from the working directory and date.
- Copilot sessions are scored from per-prompt keywords only (no Claude-style transcript file).
- Hook commands use the relative path `scripts/spendlens.py`. If Copilot runs hooks from a different directory and you see "file not found" in `<db>.err`, change the path in `copilot-hooks.json` to an absolute one or to Copilot's plugin-root variable.
- Plugin and hook formats for Copilot CLI are still evolving; check the current Copilot plugin docs if install fails.

## critical-friend

Invoke it in Claude Code with `/tokenomics:critical-friend` or just ask "critical friend, review this session". It runs `scripts/critical_friend.py` (read-only) on the newest transcript for the current directory, then gives a verdict, the top three costs with fixes, a rewrite of your weakest prompt, and what is working. Run the script directly for the raw numbers: `python3 scripts/critical_friend.py [--session ID] [--json]`. It needs a Claude Code transcript, so Copilot sessions are not analysed.

## Configuration (environment variables)

| Variable | Default | Purpose |
|----------|---------|---------|
| `TOKENOMICS_DB` | `~/.tokenomics/spendlens.db` | SQLite database path. Point it at a shared location to collect several machines' data. |
| `TOKENOMICS_STORE_PROMPT` | off | Set to `1` to keep a 200-character excerpt of each prompt. Off by default for privacy. |
| `TOKENOMICS_SKILL_MAP` | none | Path to a JSON file mapping skill names to a side, e.g. `{"our-grafana-skill": "opex", "pdf": "capex"}`. Overrides the built-in name matching. |

Set them in your shell profile, or in Claude Code's `settings.json` under `"env"`.

## Check the data

```
sqlite3 ~/.tokenomics/spendlens.db \
  "select session_id, source, label, opex_score, capex_score, prompt_count from sessions order by updated_at desc limit 10;"
```

Tables:
- `sessions`: one row per session (`session_id`, `source`, `label`, scores, `prompt_count`, timestamps).
- `prompt_events`: one row per prompt with its scores.

Spend split by label:
```
sqlite3 ~/.tokenomics/spendlens.db "select label, count(*) from sessions group by label;"
```

## Skills and tokens (recorded when the session finishes)

At `Stop` / `SessionEnd`, spendlens reads the transcript and records:

| Column (`sessions`) | Meaning |
|---------------------|---------|
| `skills` | JSON list of distinct skills used (Skill tool calls and `/slash` commands) |
| `skill_opex`, `skill_capex` | How many of those skills were inferred as opex / capex (from name and description) |
| `skill_detail` | JSON per skill: `name`, inferred `side`, `basis` (`map`, `name`, `description`, `name+description`, `none`) and the description used |
| `input_tokens`, `output_tokens` | Fresh input and generated tokens |
| `cache_creation_tokens`, `cache_read_tokens` | Prompt-cache writes and reads |
| `total_tokens` | Sum of the four above (cache reads usually dominate; use `input_tokens + output_tokens` for a leaner figure) |

Each skill is judged from its **name and its description**, e.g. "Analyses App Insights" → opex, "Create Unit Tests using NUnit" → capex. The description is found by:
1. the skill's `SKILL.md` / command file on disk (project `.claude/` or `.github/`, user `~/.claude/`, installed plugins), reading the `description:` front-matter;
2. otherwise a `- name: description` skill listing found in the transcript.

Each distinct skill that lands clearly on one side adds weight 6 to it, so one skill outweighs a few keyword hits. A skill that is ambiguous or has no usable name/description adds nothing; map it with `TOKENOMICS_SKILL_MAP` (the map always wins). Review `skill_detail` to see why each skill was classified.
Tokens are de-duplicated per message id. Subagent token usage stored in separate transcript files is not included. Copilot sessions have no transcript, so skills and tokens stay empty there.

Tokens by label:
```
sqlite3 ~/.tokenomics/spendlens.db "select label, count(*) sessions, sum(input_tokens+output_tokens) tokens from sessions group by label;"
```

## How spendlens classifies

Keyword scoring, weighted. At session end it re-scores the whole transcript and also counts tool calls (file edits push toward CAPEX, observability tools toward OPEX). Labels: `opex`, `capex`, `mixed` (scores within 25%), `unknown`. Tune `OPEX_PATTERNS` / `CAPEX_PATTERNS` in `scripts/spendlens.py`.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| No database created | Is `python3` on PATH? Run `python3 --version`. On Windows, change the hook to `python`. |
| Hooks not firing (Claude Code) | Restart Claude Code, then `/hooks`. Confirm the plugin is enabled in `/plugin`. |
| Rows missing or labels `unknown` | Look for `spendlens.db.err` next to the database; errors are written there, never shown in the session. |
| Everything labelled `unknown` | Prompts matched no keywords; add terms to the pattern lists. |

The hook never blocks a session: it always exits 0 and prints nothing to stdout.

## Layout

```
tokenomics/
├── .claude-plugin/
│   ├── plugin.json         Claude Code manifest
│   └── marketplace.json    lets the repo be added as a marketplace
├── hooks/hooks.json        Claude Code hooks
├── plugin.json             Copilot CLI manifest
├── copilot-hooks.json      Copilot CLI hooks
├── skills/critical-friend/SKILL.md   prompt and cache review skill
├── scripts/spendlens.py       the opex/capex classifier
├── scripts/critical_friend.py transcript analyser used by the skill
└── README.md
```
