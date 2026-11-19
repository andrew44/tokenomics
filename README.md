# tokenomics

**See where your AI tokens go, and get tips to stop wasting them.**

Works with **Claude Code** and **GitHub Copilot CLI**.

---

## What is this, in plain English?

When you use an AI coding assistant, every message you send and every reply you get uses up *tokens*. Tokens are the "units" you are charged for, a bit like minutes on a phone plan. Some conversations use a lot more than they need to.

> New to tokens? [How tokens work](docs/how-tokens-work.md) explains input, output, the prompt cache and tokenisers, first in plain English and then in technical depth. [Saving tokens](docs/saving-tokens.md) has practical tips for spending less.

**tokenomics** gives you four helpers:

| Helper | What it does | Think of it as... |
|--------|--------------|-------------------|
| **critical-friend** | Reads your conversation and tells you where tokens were wasted, with simple fixes. | A coach who reviews your prompts. |
| **spendlens** | Quietly labels each conversation as **OPEX** (running things) or **CAPEX** (building things) and saves it to a small file on your computer. | A timesheet that fills itself in. |
| **pennywise** | Checks each prompt before it runs. If a cheaper model would do the job (say, a hello-world app on the priciest model), it pauses the prompt and suggests the cheaper one. | A friend who stops you buying the premium option you don't need. |
| **statusbar** | Shows a live line at the bottom of your assistant: how full the conversation is, tokens used, what it has cost in pounds, and a countdown to when the AI's short-term memory (the "prompt cache") expires. | A fuel gauge and a meter for your session. |
| **handoff** | Just before the AI's short-term memory (the prompt cache) runs out, writes a short "where we got to" note. You can pick the work up in a new session for a fraction of the cost of reloading the old one. | Leaving a note on the desk before you step away. |

```mermaid
flowchart LR
    A["You chat with<br/>your AI assistant"] --> B["spendlens<br/>watches quietly<br/>in the background"]
    B --> C[("Small file on<br/>your computer")]
    A --> D["You ask:<br/>'critical friend,<br/>review my prompts'"]
    D --> E["critical-friend<br/>reads the conversation"]
    E --> F["Plain-English advice:<br/>what cost the most<br/>and how to fix it"]
```

### What do OPEX and CAPEX mean here?

These are finance words. In this tool they describe **what you were using the AI for**:

```mermaid
flowchart TD
    S["A conversation with the AI"] --> Q{"What was it mostly about?"}
    Q -->|"Looking at how things are running<br/>(logs, metrics, Grafana, incidents)"| O["OPEX<br/>Running things"]
    Q -->|"Writing or changing code<br/>(building something new)"| C["CAPEX<br/>Building things"]
    Q -->|"A bit of both, about equal"| M["mixed"]
    Q -->|"Nothing to go on"| U["unknown"]
```

This lets a team answer questions like *"How much of our AI spend goes on building, and how much on keeping things running?"*

---

## Get started (about a minute)

You only need to do this once.

```mermaid
flowchart LR
    A["1. Open a terminal"] --> B["2. Paste the<br/>install command"] --> C["3. Pick<br/>critical-friend"] --> D["4. Restart your<br/>assistant"] --> E["5. Say:<br/>'critical friend,<br/>review my prompts'"]
```

1. Open a terminal and paste this:

   ```
   npx skills@latest add andrew44/tokenomics
   ```

2. Pick **critical-friend** and the assistant(s) you use. (Arrow keys to move, space to tick, Enter to confirm.)
3. Restart your assistant and say: **"critical friend, review my prompts"**.

That's it. You now have a prompt coach.

<details>
<summary><b>"npx: command not found"?</b> You need Node.js first.</summary>

1. Go to [nodejs.org](https://nodejs.org), download the version marked **LTS**, and run the installer.
2. **Close and reopen** your terminal, then paste the command from step 1 again.

How to open a terminal: on a **Mac** press `Cmd + Space`, type `Terminal`, press Enter. On **Windows** click Start, type `PowerShell`, press Enter.
</details>

> **Heads up:** this quick start installs the **critical-friend coach only**. For the automatic OPEX/CAPEX tracking (**spendlens**) and the full token numbers, install the plugin as described next.

---

## Want the automatic tracking too? Install the plugin

The plugin gives you **everything**: the coach *and* the background tracking.

Not sure which steps are yours? Follow the arrows:

```mermaid
flowchart TD
    Start{"Where do you use<br/>Claude Code?"} -->|"Terminal<br/>(the 'claude' command)"| T["Follow the Terminal steps"]
    Start -->|"Claude desktop app<br/>(the Code tab)"| D["Do the Terminal steps once,<br/>then follow the Desktop app steps"]
    Start -->|"In the browser<br/>(claude.ai/code)"| W["The plugin can't be installed here.<br/>See the Web options"]
    Start -->|"GitHub Copilot CLI"| G["Follow the Copilot steps"]
```

### Terminal

1. Start Claude Code: type `claude` and press Enter.
2. Paste these two lines, one at a time, pressing Enter after each:

   ```
   /plugin marketplace add andrew44/tokenomics
   /plugin install tokenomics@tokenomics
   ```

3. A panel opens. Choose **Install for you (user scope)** so it works in every project.
4. Check it worked: type `/` and look for `/tokenomics:critical-friend`.

If Claude says `Run /reload-plugins to apply`, it does that for you. You need Python 3.8 or newer on your computer (nothing else to install).

### Desktop app

Works in **local** and **SSH** sessions (not cloud sessions).

1. Do the **Terminal** steps above once. The terminal and the desktop app share the same settings on your computer, so the plugin shows up in both.
2. Open the desktop app, go to the **Code** tab and start a local session.
3. Click **+** next to the prompt box, then **Add plugins** (or **Plugins**, then **Manage plugins**) to see **tokenomics** and switch it on or off.

Just want the coach in the desktop app? Run the quick start command with `-g` on the end: `npx skills@latest add andrew44/tokenomics -g`.

### Web (claude.ai/code)

Plugins **can't be installed** in Claude Code on the web. You have two options:

- **Use the terminal or desktop app** for the full plugin and tracking.
- **Add just the coach to your repo.** In your repo folder, run the command below, then commit the new `critical-friend` folder it adds:

  ```
  npx skills@latest add andrew44/tokenomics --copy
  ```

  (`--copy` makes real files instead of shortcuts, which is what you want when committing.) On the web the coach may only be able to review the prompts it can see in the conversation.

Tracking on the web isn't useful: the data would be saved on a temporary cloud machine, not your computer.

### GitHub Copilot CLI

```
copilot plugin install your-org/tokenomics          # from a GitHub repo
copilot plugin install ./path/to/tokenomics         # from a local folder
```

Then start `copilot`, check that `/plugin list` shows `tokenomics`, and send a prompt.

<details>
<summary><b>Copilot notes and known limits</b></summary>

- Copilot reads `plugin.json` and `copilot-hooks.json` at the plugin root (`userPromptSubmitted`, `postToolUse` and `sessionEnd` hooks).
- Copilot sends a session id with every hook, and spendlens logs each session under it. If one is ever missing, spendlens builds one from the working directory and date.
- Copilot sessions are labelled from the words in each prompt **and** the tools Copilot used (file edits lean CAPEX, observability tools and commands like `kubectl logs` lean OPEX). Same scoring as Claude Code.
- Copilot doesn't tell hooks how many tokens or premium requests a session used, so those columns stay empty (`usage_status = unavailable`). spendlens never guesses a number for them. The critical-friend coach doesn't work for Copilot either, because there's no conversation file to read.
- The hook commands use the relative path `scripts/spendlens.py`. If Copilot runs them from a different folder and you see "file not found" in `<db>.err`, change the path in `copilot-hooks.json` to an absolute one.
- Copilot's plugin format is still changing; check the current Copilot docs if the install fails.
</details>

### Requirements at a glance

| You want... | You need |
|-------------|----------|
| Just the coach (quick start) | Node.js |
| The full plugin | Python 3.8+ (`python3` on Mac/Linux, `python` on Windows). No extra packages. |
| Either | Claude Code and/or GitHub Copilot CLI |

<details>
<summary><b>Update, remove, or check the plugin</b></summary>

| I want to... | Do this |
|--------------|---------|
| Check it's installed | In Claude Code, run `/plugin` and open the **Installed** tab. Or run `claude plugin list` in a terminal. Run `/hooks` to see the three spendlens hooks (`UserPromptSubmit`, `Stop`, `SessionEnd`). |
| Update it | `/plugin marketplace update tokenomics`, then `claude plugin update tokenomics@tokenomics` in a terminal. (Third-party marketplaces don't update on their own.) |
| Remove it | `/plugin uninstall tokenomics@tokenomics` (or `claude plugin uninstall tokenomics@tokenomics` in a terminal) |
| Update or remove the **coach** (from the quick start) | `npx skills update` or `npx skills remove critical-friend`. `npx skills list` shows what's installed. |
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

Choosing what gets installed: `npx skills@latest add andrew44/tokenomics --list` previews the skills without installing, and `--skill critical-friend` installs one by name.
</details>

---

## Using critical-friend (the coach)

Just ask in Claude Code:

- *"critical friend, review my prompts"*
- *"why was that session expensive?"*
- or type `/tokenomics:critical-friend`

```mermaid
flowchart LR
    A["Your conversation"] --> B["Coach reads it<br/>(read-only, changes nothing)"]
    B --> C["Verdict"]
    B --> D["Top 3 costs<br/>and how to fix them"]
    B --> E["A better version of<br/>your weakest prompt"]
    B --> F["What you're<br/>already doing well"]
```

**What it looks for:**

| Common problem | In everyday words |
|----------------|-------------------|
| Low cache hit ratio / cache rebuilds | The AI keeps re-reading things it could have remembered cheaply. |
| Vague or correction-heavy prompts | Unclear asks lead to wrong answers and costly do-overs. |
| Oversized context | Too much material loaded into the conversation. |
| Repeated file reads | The same file is opened again and again. |
| Mixed topics | One long chat covering several unrelated jobs. |

> The coach needs a Claude Code conversation record, so Copilot sessions can't be reviewed.

Developers can run the script directly for raw numbers: `python3 scripts/critical_friend.py [--session ID] [--json]`

---

## What spendlens saves

At the end of each session spendlens writes one row to a small database file (SQLite) on your computer. It never blocks or slows your session, and it shows nothing on screen.

```mermaid
flowchart LR
    P["Each prompt you send"] -->|"hook: UserPromptSubmit"| S["spendlens<br/>scores the wording"]
    E["Session ends"] -->|"hooks: Stop / SessionEnd"| S
    S --> DB[("~/.tokenomics/<br/>spendlens.db")]
    DB --> R["Your questions:<br/>OPEX vs CAPEX,<br/>tokens by label"]
```

**What gets recorded for each session:**

- The **session id** and which assistant it was (`source`)
- The **label**: `opex`, `capex`, `mixed` or `unknown`
- The **scores** behind that label and the **number of prompts**
- Which **skills** were used, and whether each looks like OPEX or CAPEX
- **Token counts**: input, output, and prompt-cache reads and writes

Your prompts' text is **not** stored unless you switch that on (see Settings below).

### How does it decide OPEX or CAPEX?

It scores the conversation by looking for telltale words and actions:

```mermaid
flowchart LR
    W["Words in your prompts<br/>(e.g. 'logs', 'metrics' vs<br/>'implement', 'refactor')"] --> SC["Score both sides"]
    T["Tools the AI used<br/>(editing files leans CAPEX,<br/>observability tools lean OPEX)"] --> SC
    K["Skills used<br/>(judged by name and<br/>description)"] --> SC
    SC --> L{"Compare scores"}
    L -->|"OPEX clearly higher"| O["opex"]
    L -->|"CAPEX clearly higher"| C["capex"]
    L -->|"Within 25% of each other"| M["mixed"]
    L -->|"No clues found"| U["unknown"]
```

<details>
<summary><b>More detail on the scoring</b></summary>

- At session end, the whole transcript is re-scored and tool calls are counted.
- Each distinct skill that lands clearly on one side adds weight 6 to it, so one skill outweighs a few keyword hits. An ambiguous skill adds nothing.
- Example: "Analyses App Insights" → OPEX; "Create Unit Tests using NUnit" → CAPEX.
- A skill's description is read from its `SKILL.md` / command file on disk. Claude Code looks in the project's `.claude/`, `~/.claude/` and installed plugins, or otherwise in a skill listing found in the transcript. Copilot looks in the project's `.github/` and `.claude/` and in `~/.copilot/`.
- To adjust the scoring, edit `OPEX_PATTERNS` / `CAPEX_PATTERNS` in `tokenomics/engine/classifier.py`, or use `TOKENOMICS_SKILL_MAP` (below). One change applies to Claude Code and Copilot alike.
</details>

<details>
<summary><b>Optional: let an AI model decide instead of keywords</b></summary>

Keywords miss prompts that use none of your words. Set `TOKENOMICS_LLM=1` and a model reads the session and decides; if the call fails or times out, the keyword label is used instead, so nothing is ever lost.

- It runs **once per session**, not per prompt. `Stop` fires every turn, so it only classifies the first time there; at `SessionEnd` (or Copilot's `sessionEnd`) it re-classifies if the session has changed. Identical input is never classified twice.
- The model sees the first 5 prompts (300 characters each), the **names and counts** of tools used (never their arguments or file contents), and the skills used with their descriptions.
- Text is redacted first (API keys, tokens, emails, long opaque strings), but **it still leaves your machine**. Point it at a local model if your prompts are sensitive.
- It works with any OpenAI-compatible endpoint: OpenAI, OpenRouter, or a local server such as Ollama or LM Studio.

| Column (`sessions` table) | Meaning |
|---------------------------|---------|
| `label` | The label to use: the model's if it succeeded, otherwise the keyword label |
| `label_source` | `llm` or `keywords` |
| `llm_label`, `llm_confidence`, `llm_reason`, `llm_model` | The model's verdict (`opex`, `capex`, `mixed` or `unknown`), a 0 to 1 confidence, a one-sentence reason, and which model said it |

The keyword scores are always stored too, so you can compare the two. Failures are written to `spendlens.db.err`; the hook still never blocks a session.
</details>

<details>
<summary><b>Token columns explained</b></summary>

| Column (`sessions` table) | Meaning |
|---------------------------|---------|
| `skills` | List of distinct skills used (Skill tool calls and `/slash` commands) |
| `skill_opex`, `skill_capex` | How many of those skills were judged OPEX / CAPEX |
| `skill_detail` | Per skill: `name`, judged `side`, `basis` (`map`, `name`, `description`, `name+description`, `none`) and the description used |
| `input_tokens`, `output_tokens` | Fresh input and generated tokens |
| `cache_creation_tokens`, `cache_read_tokens` | Prompt-cache writes and reads |
| `total_tokens` | Sum of the four above. Cache reads usually dominate, so use `input_tokens + output_tokens` for a leaner figure. |
| `billing_model` | What the assistant charges for: `anthropic_tokens` (Claude Code) or `copilot_premium_requests` (Copilot). Don't add the two together. |
| `usage_status` | `reported` when the assistant gave token counts, `unavailable` when it didn't (always the case for Copilot). Empty token columns mean "not known", not zero. |
| `evidence` | What the label is based on: `transcript` (the whole conversation) or `hook-events` (prompts and tool calls seen one at a time) |

Tokens are counted once per message. Work done by sub-agents in separate transcript files is not included. For Copilot, tool calls are also kept one row each in the `tool_events` table (tool name and kind only, never arguments).
</details>

---

## Using the status bar

A live line that sits at the bottom of Claude Code or GitHub Copilot CLI:

```
◆ Sonnet 5.5 │ ctx █████████▏▒▒ 76% │ Σ 8.5M │ £1.37 │ ⏳︎ 02:29
```

| Part | What it tells you |
|------|-------------------|
| `ctx ████▒▒ 76%` | How full the conversation is. The bar goes **green**, turns **yellow at 75%** and **red at 90%**. A `▲` appears from 90%. When it is nearly full, start a fresh conversation. |
| `Σ 8.5M` | Total tokens used so far, in short form (`950`, `12.3K`, `8.5M`). |
| `£1.37` | What the session has cost, in pounds. A `~` in front (`~£1.37`) means it is an estimate. |
| `⧗ 04:12` | A countdown to when the prompt cache expires. While it runs, repeated context is cheap. The egg timer starts **full (green)**, is **half-empty (amber)** at about half time and **empty (red)** when it is running out. `00:00` means the cache has gone cold, and `--:--` means nothing has been cached yet. |

**To install it** (needs Python 3.8 or newer, nothing else). From the repo folder:

```
python3 scripts/statusbar.py --install claude     # or: copilot, both
```

This adds the status line to your Claude Code and/or Copilot settings (a backup of the old settings is saved first), then restart the assistant. To remove it, run the same command with `--uninstall`.

**Light or dark.** It follows your computer's setting by default. To force one, put `{"theme": "dark"}` (or `"light"`) in `~/.tokenomics/statusbar.json`. To preview all the states, run `python3 scripts/statusbar.py --demo --theme light`. For very plain terminals use `--ascii` or set `NO_COLOR=1`.

**Pounds.** Claude Code reports the cost in dollars and the bar converts it at 0.76 pounds per dollar. Run `python3 scripts/statusbar.py --update-rate` to fetch today's rate, or set `"usd_gbp"` in the same file.

<details>
<summary><b>Good to know about the countdown</b></summary>

- It counts from the last request that used the cache. The cache lasts 5 minutes, or 1 hour if your session uses the 1-hour cache. Override with `"cache_ttl"` (seconds).
- Claude Code redraws the line every second (this needs a recent version; on older ones it updates after each message).
- Copilot CLI doesn't say how often it redraws or when its cache expires, so there the countdown is approximate and may only move when Copilot redraws.
- For a smoothly ticking countdown in any assistant, run `python3 scripts/statusbar.py --watch` in a spare terminal pane.
</details>

---

## Using pennywise (the money-saver)

*Penny wise, pound foolish.* pennywise is a `UserPromptSubmit` hook (`scripts/pennywise.py`). It rates the prompt (small and self-contained, short and routine, or complex/unclear), finds the session's model (hook payload, then transcript, `ANTHROPIC_MODEL`, `settings.json`), and if a cheaper tier would cope it blocks with a suggestion such as `/model haiku`. Complex or ambiguous prompts are never blocked.

To run the prompt anyway, send the same prompt again or start it with `keep-model:`. Each decision (`blocked`, `warned`, `overridden`) is logged to the `pennywise_events` table in the spendlens database. The checks are keyword-based; tune `SIMPLE` / `HARD` in the script. Copilot CLI ignores hook output on prompt submit, so pennywise is Claude Code only.

---

## Using handoff (the bookmark)

When the prompt cache goes cold, resuming the old session means paying to re-write the whole conversation into the cache again. **handoff** (`scripts/handoff.py`) writes a small digest first, so a fresh session can carry on from that instead.

Hooks cannot run on a timer, so on every `Stop` (Claude Code) or `userPromptSubmitted` (Copilot) it starts a small background watcher. The watcher reads the cache clock from the transcript (5 minutes, or 1 hour if the session uses the 1-hour cache), and writes the file 60 seconds before expiry. If you carry on working, the clock moves and the watcher simply waits for the new deadline. `SessionEnd` stops the watcher and writes a handoff if there is not already a current one.

The file lands in `~/.tokenomics/handoffs/<session id>.md`: git branch and changes, tasks, your last few requests, the last reply, files edited, recent commands, an estimate of what a full resume would cost against the size of the note, and how to resume. It is built from the transcript by plain code; no model is called, so it costs no tokens.

To resume cheaply, start a new session in the same folder and say `Continue from @<that file>`. A `SessionStart` hook tells you when a handoff from the last 24 hours exists for the folder (set `TOKENOMICS_HANDOFF_INJECT=1` to load it automatically instead). `python3 scripts/handoff.py write` makes one on demand. Each one is logged to the `handoff_events` table in the spendlens database. Copilot CLI support is best effort: its hook payload and transcript format are less documented, so the digest may be thinner.

---

## Settings (optional)

Most people never need these. They are "environment variables", set in your shell profile or in Claude Code's `settings.json` under `"env"`.

| Setting | Default | What it does |
|---------|---------|--------------|
| `TOKENOMICS_PENNYWISE` | `block` | `block`, `warn` (notice only) or `off` for pennywise. |
| `TOKENOMICS_HANDOFF` | `on` | `off` stops handoff from writing or watching. |
| `TOKENOMICS_HANDOFF_LEAD` | `60` | Seconds before the cache expires to write the handoff. |
| `TOKENOMICS_HANDOFF_DIR` | `~/.tokenomics/handoffs` | Where handoff files go. The newest 30 are kept (`TOKENOMICS_HANDOFF_KEEP`). |
| `TOKENOMICS_HANDOFF_INJECT` | off | Set to `1` to load the latest handoff into a new session automatically. |
| `TOKENOMICS_DB` | `~/.tokenomics/spendlens.db` | Where the database file lives. Point it at a shared location to collect several machines' data. |
| `TOKENOMICS_STORE_PROMPT` | off | Set to `1` to keep a 200-character excerpt of each prompt. Off by default for privacy. |
| `TOKENOMICS_SKILL_MAP` | none | Path to a JSON file that tells spendlens which side a skill belongs to, e.g. `{"our-grafana-skill": "opex", "pdf": "capex"}`. This always wins over the built-in guessing. |
| `TOKENOMICS_LLM` | off | Set to `1` to have an AI model decide OPEX or CAPEX at session end (see "How does it decide" above). Sends redacted prompt text to the endpoint. |
| `TOKENOMICS_LLM_URL` | `https://api.openai.com/v1/chat/completions` | Any OpenAI-compatible chat endpoint. A non-default URL needs no key, so local models work. |
| `TOKENOMICS_LLM_KEY` | `OPENAI_API_KEY` | API key for that endpoint. |
| `TOKENOMICS_LLM_MODEL` | `gpt-4o-mini` | Which model to ask. |
| `TOKENOMICS_LLM_TIMEOUT` | `12` | Seconds to wait before falling back to keywords (capped at 15 to fit the 20-second hook limit). |
| `TOKENOMICS_THEME` | `system` | Status bar colours: `light`, `dark` or `system`. |
| `TOKENOMICS_USD_GBP` | `0.76` | Pounds per dollar, used for the status bar's cost. |
| `TOKENOMICS_CACHE_TTL` | auto | Cache lifetime in seconds for the status bar's countdown. |

---

## Dashboard

A local web UI over the spendlens database: a headline **% OPEX vs % CAPEX** split bar, daily usage trend, per-project split, skills used and recent sessions. Switch the measure between tokens, sessions and prompts, and the range between 7d, 30d, 90d and all time. Light and dark mode follow your system.

```
python3 scripts/dashboard.py              # opens http://127.0.0.1:8765
python3 scripts/dashboard.py --demo       # preview with seeded fake data
python3 scripts/dashboard.py --db /path/to/spendlens.db --port 9000
```

It reads the database read-only, listens on 127.0.0.1 only, and needs nothing beyond Python 3.8+. It uses `TOKENOMICS_DB` if set.

## Looking at your data

You can open the database with any SQLite tool. These examples use the `sqlite3` command.

Your 10 most recent sessions:
```
sqlite3 ~/.tokenomics/spendlens.db \
  "select session_id, source, label, opex_score, capex_score, prompt_count from sessions order by updated_at desc limit 10;"
```

How many sessions of each label:
```
sqlite3 ~/.tokenomics/spendlens.db "select label, count(*) from sessions group by label;"
```

Tokens used by each label:
```
sqlite3 ~/.tokenomics/spendlens.db "select label, count(*) sessions, sum(input_tokens+output_tokens) tokens from sessions group by label;"
```

The database has two tables: `sessions` (one row per session) and `prompt_events` (one row per prompt, with its scores).

---

## Troubleshooting

| What you see | Try this |
|--------------|----------|
| No database file appears | Check Python is installed: run `python3 --version`. On Windows, change the hook to use `python`. |
| Hooks don't seem to run (Claude Code) | Restart Claude Code, then run `/hooks`. Make sure the plugin is switched on in `/plugin`. |
| Sessions are missing, or labelled `unknown` | Look for a file called `spendlens.db.err` next to the database. Errors go there, never on screen. |
| *Everything* is labelled `unknown` | Your prompts didn't match any keywords. Add terms to the pattern lists in `tokenomics/engine/classifier.py`. |

---

## For contributors: how it's built

The OPEX/CAPEX logic is written **once**, in a shared engine. Claude Code and Copilot each have a small **adapter** that turns that assistant's hook messages into a common format and says what the assistant can and can't report. The engine never assumes a feature exists: it asks the adapter first, then does the best it can with what's there.

```mermaid
flowchart LR
    CC["Claude Code hooks<br/>+ transcript"] --> A1["Claude Code adapter"]
    GH["Copilot hooks<br/>(prompts, tool calls)"] --> A2["Copilot adapter"]
    A1 --> CAP{"Capability<br/>registry"}
    A2 --> CAP
    CAP --> E["Shared engine<br/>classifier + LLM step"]
    E --> DB[("spendlens.db<br/>one row per session id")]
```

- **Shared engine** (`tokenomics/engine/`): the scoring rules, the optional AI-model check, and the database. Both assistants go through exactly the same code.
- **Adapters** (`tokenomics/adapters/`): translation only, no scoring. Each one lists its capabilities (transcript, token counts, tool events, billing and so on) as `native`, `partial` or `none`.
- **If something is missing**, the engine copes: no transcript means it uses the prompt and tool events it stored; an unknown assistant, or an adapter that fails to load, still gets its prompts logged by session id, and the other assistant is unaffected.
- **Billing stays separate**: Claude Code tokens and Copilot premium requests are never converted into each other or into money.
- See what each assistant supports: `python3 scripts/spendlens.py capabilities`
- Run the tests (no installs needed): `cd tests && python3 -m unittest`

The other tools (status bar, pennywise, handoff, critical-friend) are still standalone scripts and will move onto the engine next.

### What's in the repo

```mermaid
flowchart TD
    R["tokenomics/"] --> CP[".claude-plugin/<br/>Claude Code manifest + marketplace"]
    R --> H["hooks/hooks.json<br/>Claude Code hooks"]
    R --> PJ["plugin.json<br/>Copilot CLI manifest"]
    R --> CH["copilot-hooks.json<br/>Copilot CLI hooks"]
    R --> SK["skills/critical-friend/SKILL.md<br/>the coach"]
    R --> EN["tokenomics/<br/>shared engine + adapters"]
    R --> TS["tests/<br/>automated tests"]
    R --> SC["scripts/"]
    SC --> S1["spendlens.py<br/>OPEX/CAPEX hook runner"]
    SC --> S2["critical_friend.py<br/>conversation analyser"]
    SC --> S3["statusbar.py<br/>live status line"]
    SC --> S4["pennywise.py<br/>cheaper-model suggester"]
    SC --> S5["dashboard.py<br/>local usage dashboard"]
    SC --> S6["handoff.py<br/>cache-expiry handoff writer"]
    R --> D["dashboard/index.html<br/>dashboard page"]
```

```
tokenomics/
├── .claude-plugin/
│   ├── plugin.json         Claude Code manifest
│   └── marketplace.json    lets the repo be added as a marketplace
├── hooks/hooks.json        Claude Code hooks
├── plugin.json             Copilot CLI manifest
├── copilot-hooks.json      Copilot CLI hooks
├── skills/critical-friend/SKILL.md   prompt and cache review skill
├── tokenomics/
│   ├── engine/             shared logic: classifier.py, llm.py, store.py, session.py, evidence.py
│   ├── platform/           common adapter interface + capability registry
│   ├── adapters/           claude_code.py, copilot.py (translation only)
│   ├── config.py           shared settings
│   └── util.py             shared helpers
├── tests/                  unittest suite (python3 -m unittest, from tests/)
├── scripts/spendlens.py       the opex/capex hook runner (calls the engine)
├── scripts/pennywise.py       cheaper-model suggester (blocks over-spec'd prompts)
├── scripts/handoff.py         writes a resume note before the cache expires
├── scripts/critical_friend.py transcript analyser used by the skill
├── scripts/statusbar.py       status line for Claude Code and Copilot CLI
├── scripts/dashboard.py       local web server over the spendlens database
├── dashboard/index.html       the dashboard page
└── README.md
```

More hooks, tools and skills will be added over time.
