# tokenomics

Understand where your AI tokens go. Works with **Claude Code** and **GitHub Copilot CLI**.

## Quickstart (about a minute)

1. Open a terminal and paste this:

   ```
   npx skills@latest add andrew44/tokenomics
   ```

2. Pick **critical-friend** and the assistant(s) you use. (Arrow keys to move, space to tick, Enter to confirm.)
3. Restart your assistant and say: **"critical friend, review my prompts"**.

That's it. You now have a prompt coach that shows where your session is wasting tokens, and how to fix it.

<details>
<summary><b>"npx: command not found"?</b> You need Node.js first.</summary>

1. Go to [nodejs.org](https://nodejs.org), download the version marked **LTS**, and run the installer.
2. **Close and reopen** your terminal, then paste the command from step 1 again.

How to open a terminal: on a **Mac** press `Cmd + Space`, type `Terminal`, press Enter. On **Windows** click Start, type `PowerShell`, press Enter.
</details>

> **Heads up:** `npx skills` installs the **skill** only. For the automatic OPEX/CAPEX tracking (**spendlens**) and the full cache numbers, add the plugin: see [Want the automatic tracking too?](#want-the-automatic-tracking-too-install-the-plugin) below.

## Components

| Component | Type  | What it does |
|-----------|-------|--------------|
| **spendlens** | hooks | Tags each session **OPEX** (run: insights, logs, metrics, Grafana, incidents) or **CAPEX** (build: code generation), or `mixed` / `unknown`, and logs it with the session id to SQLite. |
| **critical-friend** | skill | Reviews your prompts and prompt-cache usage for the current session and suggests improvements (cache hit ratio, cache rebuilds, vague or correction-heavy prompts, oversized context, repeated file reads, mixed topics). Ask: "critical friend", "review my prompts", "why was that session expensive?". |

More hooks, tools and skills will be added here.

## Want the automatic tracking too? Install the plugin

The plugin gives you **everything**: the `critical-friend` skill *and* spendlens tracking in the background. Pick where you use Claude Code.

| I use Claude Code in... | Jump to |
|-------------------------|---------|
| The terminal (the `claude` command) | [Terminal](#terminal) |
| The Claude desktop app (**Code** tab) | [Desktop app](#desktop-app) |
| The browser (claude.ai/code) | [Web](#web-claudeaicode) |

### Terminal

1. Start Claude Code: type `claude` and press Enter.
2. Paste these two lines, one at a time, pressing Enter after each:

   ```
   /plugin marketplace add andrew44/tokenomics
   /plugin install tokenomics@tokenomics
   ```

3. A panel opens. Choose **Install for you (user scope)** so it works in every project.
4. Check it worked: type `/` and look for `/tokenomics:critical-friend`.

If Claude says `Run /reload-plugins to apply`, it does that for you. Needs Python 3.8+ on your computer (nothing else to install).

### Desktop app

Works in **local** and **SSH** sessions (not cloud sessions).

1. Do the **Terminal** steps above once. The terminal and the desktop app share the same settings on your computer, so the plugin shows up in both.
2. Open the desktop app, go to the **Code** tab and start a local session.
3. Click **+** next to the prompt box, then **Add plugins** (or **Plugins**, then **Manage plugins**) to see **tokenomics** and switch it on or off.

Just want the skill in the desktop app? Run the [Quickstart](#quickstart-about-a-minute) command with `-g` on the end: `npx skills@latest add andrew44/tokenomics -g`.

### Web (claude.ai/code)

Plugins **can't be installed** in Claude Code on the web. Cloud sessions have no plugin browser and don't load plugins from your computer or from a repo's settings. You have two options:

- **Use the terminal or desktop app** for the full plugin and spendlens tracking.
- **Add just the skill to your repo.** Files in a repo's `.claude/skills/` folder do load on the web. In your repo folder, run the command below, then commit the new `critical-friend` skill folder it adds:

  ```
  npx skills@latest add andrew44/tokenomics --copy
  ```

  (`--copy` makes real files instead of shortcuts, which is what you want when committing.) The skill's helper script isn't part of the skill folder, so on the web it may only be able to review the prompts it can see in the conversation.

On the web, spendlens would save its data on a temporary cloud machine rather than your computer, so tracking there isn't useful.

<details>
<summary><b>Update, remove, or check the plugin</b></summary>

| I want to... | Do this |
|--------------|---------|
| Check it's installed | In Claude Code, run `/plugin` and open the **Installed** tab. Or run `claude plugin list` in a terminal. Run `/hooks` to see the three spendlens hooks (`UserPromptSubmit`, `Stop`, `SessionEnd`). |
| Update it | `/plugin marketplace update tokenomics`, then `claude plugin update tokenomics@tokenomics` in a terminal. (Third-party marketplaces don't update on their own.) |
| Remove it | `/plugin uninstall tokenomics@tokenomics` (or `claude plugin uninstall tokenomics@tokenomics` in a terminal) |
| Update or remove the **skill** (from the Quickstart) | `npx skills update` or `npx skills remove critical-friend`. `npx skills list` shows what's installed. |
| Install for a whole team | Choose **project scope** at the install panel, or run `claude plugin install tokenomics@tokenomics --scope project`. Each teammate also runs that command once. |

</details>

<details>
<summary><b>For developers: other ways to install</b></summary>

One command from a normal terminal (no Claude session needed). The plugin switches on next time you start Claude Code:
```
claude plugin marketplace add andrew44/tokenomics
claude plugin install tokenomics@tokenomics
```
Add and install in one step (recent Claude Code; v2.1.275+ in a session, v2.1.292+ from a shell):
```
/plugin install tokenomics --marketplace andrew44/tokenomics
```
From a local folder:
```
/plugin marketplace add ./path/to/tokenomics
/plugin install tokenomics@tokenomics
```
Try it for one session without installing:
```
claude --plugin-dir ./path/to/tokenomics
```
To host your own copy for a team, push the folder to your own Git repo and use `your-org/tokenomics` in place of `andrew44/tokenomics`. The repo doubles as a marketplace (`.claude-plugin/marketplace.json`).

Choosing what the skill can see: `npx skills@latest add andrew44/tokenomics --list` previews the skills without installing, and `--skill critical-friend` installs one by name.
</details>

## Requirements

- **Quickstart (skill only):** Node.js (gives you `npx`). Nothing else.
- **Full plugin:** Python 3.8+ on your PATH (`python3` on macOS/Linux, `python` on Windows). No packages needed.
- Claude Code and/or GitHub Copilot CLI.

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

## Dashboard

A local web UI over the spendlens database: a headline **% OPEX vs % CAPEX** split bar, daily usage trend, per-project split, skills used and recent sessions. Switch the measure between tokens, sessions and prompts, and the range between 7d, 30d, 90d and all time. Light and dark mode follow your system.

```
python3 scripts/dashboard.py              # opens http://127.0.0.1:8765
python3 scripts/dashboard.py --demo       # preview with seeded fake data
python3 scripts/dashboard.py --db /path/to/spendlens.db --port 9000
```

It reads the database read-only, listens on 127.0.0.1 only, and needs nothing beyond Python 3.8+. It uses `TOKENOMICS_DB` if set.

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
