<p align="right"><a href="../README.md">← Back to README</a> · <a href="README.md">All docs</a></p>

# Helper reference

The full detail on every tokenomics helper: what it does, how it decides, and what it records. For a shorter "which one do I need?" guide, see [Skills, tools and hooks](skills-tools-and-hooks.md).

| | Helper | Kind | Jump to |
|---|---|---|---|
| 🧑‍🏫 | **coach** | skill | [coach](#coach) |
| 📊 | **spend-report** | skill | [spend-report](#spend-report) |
| 🔍 | **spendlens** | hook | [spendlens](#spendlens) |
| 🪙 | **pennywise** | hook | [pennywise](#pennywise) |
| 🥗 | **diet** | hook | [diet](#diet) |
| 💳 | **budget** | hook | [budget](#budget) |
| 🥡 | **doggybag** | hook | [doggybag](#doggybag) |
| 📟 | **statusline** and **band** | tool | [statusline](#statusline) · [band](#band) |
| 📈 | **dashboard** | tool | [dashboard](#dashboard) |
| 🗄️ | **your data** | | [Looking at your data](#looking-at-your-data) |

> Every cost tokenomics shows is an estimate, not a bill. See the [disclaimer](../README.md#disclaimer).

---

## coach

Reads your conversation and tells you where tokens were wasted, with simple fixes. Read-only: it changes nothing.

Ask in Claude Code:

- *"coach, review my prompts"*
- *"why was that session expensive?"*
- or type `/tokenomics:coach`

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
|---|---|
| Low cache hit ratio / cache rebuilds | The AI keeps re-reading things it could have remembered cheaply. |
| Vague or correction-heavy prompts | Unclear asks lead to wrong answers and costly do-overs. |
| Oversized context | Too much material loaded into the conversation. |
| Repeated file reads | The same file is opened again and again. |
| Mixed topics | One long chat covering several unrelated jobs. |

The coach needs a Claude Code conversation record, so Copilot sessions can't be reviewed.

For raw numbers, run the analyser directly: `node scripts/coach.ts [--session ID] [--json]`

---

## spend-report

Say **"spend report"** (or "where did my tokens go this week?") and the skill runs `scripts/report.ts` and summarises it:

- money spent (in your currency) and the OPEX/CAPEX split of that spend
- top projects and models
- the costliest sessions
- what pennywise, doggybag, diet and budget did
- three suggestions tied to your own numbers

Ask for any period: "this month", "today", "all time".

Run it yourself:

```bash
node scripts/report.ts                       # last 7 days, as Markdown
node scripts/report.ts --days 30 --json
node scripts/report.ts --currency EUR        # GBP, USD or EUR for this run
```

---

## spendlens

Quietly labels each conversation as **OPEX** (running things) or **CAPEX** (building things) and saves it to a small database on your computer. It never blocks or slows your session, and it shows nothing on screen.

### What OPEX and CAPEX mean here

```mermaid
flowchart TD
    S["A conversation with the AI"] --> Q{"What was it mostly about?"}
    Q -->|"Looking at how things are running<br/>(logs, metrics, Grafana, incidents)"| O["OPEX<br/>Running things"]
    Q -->|"Writing or changing code<br/>(building something new)"| C["CAPEX<br/>Building things"]
    Q -->|"A bit of both, about equal"| M["mixed"]
    Q -->|"Nothing to go on"| U["unknown"]
```

This lets a team answer questions like *"How much of our AI spend goes on building, and how much on keeping things running?"*

### When it runs

```mermaid
flowchart LR
    P["Each prompt you send"] -->|"hook: UserPromptSubmit"| S["spendlens<br/>scores the wording"]
    E["Session ends"] -->|"hooks: Stop / SessionEnd"| S
    S --> DB[("~/.tokenomics/<br/>spendlens.db")]
    DB --> R["Your questions:<br/>OPEX vs CAPEX,<br/>tokens by label"]
```

### What gets recorded for each session

- The **session id** and which assistant it was (`source`)
- The **label**: `opex`, `capex`, `mixed` or `unknown`
- The **scores** behind that label and the **number of prompts**
- Which **skills** were used, and whether each looks like OPEX or CAPEX
- **Token counts**: input, output, and prompt-cache reads and writes

Your prompts' text is **not** stored unless you switch that on (`TOKENOMICS_STORE_PROMPT=1`).

### How it decides

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

- At session end, the whole transcript is re-scored and tool calls are counted.
- Each distinct skill that lands clearly on one side adds weight 6 to it, so one skill outweighs a few keyword hits. An ambiguous skill adds nothing.
- Example: "Analyses App Insights" → OPEX; "Create Unit Tests using NUnit" → CAPEX.
- A skill's description is read from its `SKILL.md` / command file on disk. Claude Code looks in the project's `.claude/`, `~/.claude/` and installed plugins, or otherwise in a skill listing found in the transcript. Copilot looks in the project's `.github/` and `.claude/` and in `~/.copilot/`.
- To adjust the scoring, edit `OPEX_PATTERNS` / `CAPEX_PATTERNS` in `tokenomics/engine/classifier.ts`, or use `TOKENOMICS_SKILL_MAP` (see [Configuration](configuration.md)). One change applies to Claude Code and Copilot alike.

### Optional: let an AI model decide

Keywords miss prompts that use none of your words. Set `TOKENOMICS_LLM=1` and a model reads the session and decides; if the call fails or times out, the keyword label is used instead, so nothing is ever lost.

- It runs **once per session**, not per prompt. `Stop` fires every turn, so it only classifies the first time there; at `SessionEnd` (or Copilot's `sessionEnd`) it re-classifies if the session has changed. Identical input is never classified twice.
- The model sees the first 5 prompts (300 characters each), the **names and counts** of tools used (never their arguments or file contents), and the skills used with their descriptions.
- Text is redacted first (API keys, tokens, emails, long opaque strings), but **it still leaves your machine**. Point it at a local model if your prompts are sensitive.
- It works with any OpenAI-compatible endpoint: OpenAI, OpenRouter, or a local server such as Ollama or LM Studio.

| Column (`sessions` table) | Meaning |
|---|---|
| `label` | The label to use: the model's if it succeeded, otherwise the keyword label |
| `label_source` | `llm` or `keywords` |
| `llm_label`, `llm_confidence`, `llm_reason`, `llm_model` | The model's verdict (`opex`, `capex`, `mixed` or `unknown`), a 0 to 1 confidence, a one-sentence reason, and which model said it |

The keyword scores are always stored too, so you can compare the two. Failures are written to `spendlens.db.err`; the hook still never blocks a session.

### Token columns

| Column (`sessions` table) | Meaning |
|---|---|
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

---

## pennywise

*Penny wise, pound foolish.* A model router (`scripts/pennywise.ts`): every prompt gets a complexity score and goes to the model that suits it, so a hello-world never runs on the priciest model and an architecture question never gets stuck on the cheapest.

**How it scores.** Weighted signals, in the style of auto-routers such as LiteLLM's complexity router: prompt length, code blocks, simple-task phrases (*typo*, *rename*, *commit message*, *convert JSON*), technical terms, complex work (*refactor*, *debug*, *across the codebase*), reasoning words (*architecture*, *trade-offs*, *root cause*, *prove*, *security*), multi-step structure and stacked questions. The total lands in one of four tiers, each mapped to a model:

| Tier | Default model | Typical prompt |
|---|---|---|
| `SIMPLE` | Haiku | "create a hello world console app", "fix the typo in README" |
| `MEDIUM` | Sonnet | "add a /health endpoint to the flask api" |
| `COMPLEX` | Opus | "refactor the auth module across all services" |
| `REASONING` | Opus | "design the architecture for a distributed queue and compare the trade-offs" |

See exactly why a prompt landed where it did:

```text
$ tokenomics router explain "create a hello world console app"
tier:    SIMPLE  (score -0.25)
model:   claude-haiku-5-5
signals: short -0.1, simple-task -0.35, build-verb +0.2
```

Change the map with `TOKENOMICS_ROUTER_TIERS="SIMPLE=haiku,MEDIUM=sonnet,COMPLEX=opus,REASONING=fable"` or `~/.tokenomics/router.json` (`{"tiers": {...}, "thresholds": {"MEDIUM": 0.15, "COMPLEX": 0.5, "REASONING": 0.95}}`). Aliases resolve to the newest listed model of that family in `data/model-prices.json`; full model ids work too.

### Two ways to route

**1. Hook (default, nothing to set up).** Claude Code doesn't let a hook switch the session's model, so pennywise has your session hand the prompt, word for word, to a subagent on the tier's model (the Agent tool's `model` parameter) and relay the answer. The tool calls, file reads and output, most of a task's tokens, are billed at that model.

```text
pennywise: routing down to Haiku (SIMPLE, score -0.25) instead of Opus.
Start a prompt with 'keep-model:' to keep it on Opus.
```

It routes **down** to save money and **up** when a prompt is harder than your session's model (`TOKENOMICS_PENNYWISE_UP=off` to only ever route down). Because a subagent starts with a blank slate, the hook only hands over prompts that stand on their own: follow-ups like "yes, do it" or "fix that error" stay with your session.

**2. Proxy (a true per-request router).** Run a local Anthropic-API proxy and point Claude Code at it; every new turn is scored and the request goes upstream on the chosen model, with the whole conversation, no subagent needed:

```bash
tokenomics router serve                       # http://127.0.0.1:8787 -> https://api.anthropic.com
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_MODEL=pennywise claude
```

- **Only `pennywise` (or `auto`) is routed.** Requests for any other model pass through untouched, including Claude Code's own small background calls. `TOKENOMICS_ROUTER_MODELS="*"` routes every main-model request instead.
- **Cache-aware.** Inside a tool loop the model never changes. A new turn can always move **up**; it only moves **down** when the prompt cache has gone cold or the context is small (`TOKENOMICS_ROUTER_STICKY_TOKENS`, default 20,000), because switching models means re-writing the context into the new model's cache.
- **Fallback.** If a routed request fails (overloaded, rate-limited, model not found), it is retried once on the fallback model (`TOKENOMICS_ROUTER_FALLBACK`, default the `COMPLEX` tier).
- Your API key or login passes straight through; the proxy listens on `127.0.0.1` only. `TOKENOMICS_ROUTER_UPSTREAM` points it at another Anthropic-compatible endpoint (a gateway, Bedrock/Vertex proxy).
- While `ANTHROPIC_BASE_URL` points at the proxy, the hook steps aside so prompts aren't routed twice.

### Overrides and settings

- Start a prompt with `keep-model:` to keep it on your model, or `haiku:`, `sonnet:`, `opus:`, `fable:` to force one. Works in both modes.
- Slash commands are never routed.
- `TOKENOMICS_PENNYWISE=block` pauses a down-route instead and suggests `/model haiku` (send the same prompt again to run it anyway). `warn` shows that suggestion without pausing. `proxy` turns the hook off in favour of the proxy. `off` disables pennywise.
- Each decision is logged to the `pennywise_events` table (`routed`, `routed-up`, `proxy-routed`, `proxy-fallback`, `blocked`, `warned`, `overridden`), and shows up in the spend report.
- Signals and weights live in `SIGNALS` at the top of the script.
- The hook is Claude Code only (Copilot CLI ignores hook output on prompt submit).

---

## diet

Every token pulled into the conversation is paid for again on every later turn. **diet** (`scripts/diet.ts`) is a pre-tool hook (`PreToolUse` on `Read|Bash` in Claude Code, `preToolUse` in Copilot CLI) that refuses a small set of calls known to flood the context, and tells the AI how to ask for less. The AI then retries with a narrower call by itself:

| Stopped | Suggested instead |
|---|---|
| Reading a generated file whole: lockfiles, `*.min.js`, source maps, snapshots (over 64 KB) | `grep` for what you need, or read a range |
| `kubectl logs`, `docker logs`, `journalctl` with no limit | `--tail=200`, `--since=15m` |
| `git log` with no limit | `-n 20 --oneline` |
| `find /` or `find ~` with no `-maxdepth`; `ls -R`; `tree` with no `-L` | start from the project, `git ls-files`, `-L 2` |
| `cat` of a file over 64 KB | `grep -n`, `head`, `sed -n 'A,Bp'` |

- A command that already pipes (`| grep`, `| head`), redirects to a file, or limits itself is never touched, and a file that can't be found is never blocked.
- To let one command through, append `# diet-ok`.
- Each block is logged to `diet_events` with an estimate of the tokens kept out, which shows up in the spend report.
- Rules live in `tokenomics/engine/diet.ts`, shared by both assistants.

---

## budget

Set a limit and **budget** (`scripts/budget.ts`, a `UserPromptSubmit` hook) keeps an eye on it. Limits are in your chosen [currency](configuration.md#currency) (pounds by default), so `20` means £20, $20 or €20:

```bash
export TOKENOMICS_BUDGET_DAILY=20      # per day, all sessions together
export TOKENOMICS_BUDGET_SESSION=5     # per session
```

- At **80%** of a limit you get one notice.
- At **100%**, your next prompt is paused with what you've spent and some cheaper ways on (`/compact`, a smaller model, a fresh session).
- To carry on anyway, send the same prompt again or start it with `over-budget:`; you won't be paused again for that limit that day.
- `TOKENOMICS_BUDGET_MODE=warn` only ever shows notices.
- Check where you are with `node scripts/budget.ts status`.

Spend is worked out from the token counts spendlens records at the end of each turn, priced per model like the statusline (so it is at most one turn behind, and an estimate, not your invoice). Each increase is stored with its date, so a session that runs past midnight counts towards the right day. Copilot bills premium requests, which hooks can't see, so Copilot sessions never count towards a budget. Copilot also ignores prompt-hook output, so budget is Claude Code only.

---

## doggybag

*Pack up the leftovers.* When the prompt cache goes cold, carrying on in the old session means paying to re-write the whole conversation into the cache again. **doggybag** (`scripts/doggybag.ts`) packs a small digest first, so you can carry on from that instead.

**Where it goes.** Into the project: `<project>/.doggybag/<session id>.md`, plus `.doggybag/latest.md` (always the newest). The folder carries its own `.gitignore` (`*`), so it is never committed whatever your repo's rules are. The newest 10 per project are kept. Set `TOKENOMICS_DOGGYBAG_DIR` to an absolute path to keep them all in one place instead.

**How it times it.** Hooks cannot run on a timer, so on every `Stop` (Claude Code) or `userPromptSubmitted` (Copilot) it starts a small background watcher. The watcher reads the cache clock from the transcript (5 minutes, or 1 hour if the session uses the 1-hour cache) and packs the doggybag 60 seconds before expiry. If you carry on working, the clock moves and the watcher waits for the new deadline. `SessionEnd` stops the watcher and packs one if there is not already a current one.

**Ready on your next prompt.** Come back after the cache has expired and type your next prompt: the `UserPromptSubmit` hook makes sure the doggybag is packed (even if the watcher died with a sleeping laptop) and tells you what the cold prompt will cost:

```text
doggybag: the prompt cache went cold 42 min ago, so this prompt re-writes about 180,000 tokens (about £0.71).
Cheaper: /clear and your doggybag (1,450 tokens, .doggybag/latest.md) loads automatically.
```

Type `/clear` (or start a new session in the folder) and the `SessionStart` hook loads the latest doggybag into the conversation for you; nothing to paste. `TOKENOMICS_DOGGYBAG_COLD=block` pauses that first cold prompt once (send it again to carry on anyway); `off` stays quiet. Small sessions (under 20,000 tokens of context) are never interrupted.

**What's in it.** Git branch and changes, tasks, your last few requests, the last reply, files edited, recent commands, an estimate of a full resume against the size of the note, and how to carry on. It is built from the transcript by plain code; **no model is called, so it costs no tokens**.

- `tokenomics doggybag` (or `node scripts/doggybag.ts write`) packs one on demand for the folder's latest session.
- `TOKENOMICS_DOGGYBAG_INJECT=0` only tells you a doggybag exists instead of loading it.
- Each one is logged to the `handoff_events` table (the old name, kept so your history carries over).
- The old `TOKENOMICS_HANDOFF_*` settings still work.
- Copilot CLI support is best effort: its hook payload and transcript format are less documented, so the digest may be thinner.

---

## statusline

One live line: model, how full the conversation is, tokens, cost and a countdown to when the prompt cache goes cold. It shows in two places:

| | Where | What it is | Manage it |
|---|---|---|---|
| **statusline** | The bottom of Claude Code or GitHub Copilot CLI **in a terminal** | The CLI's own status line: a `statusLine` entry in its `settings.json` | `/tokenomics:statusline` installs or removes it, per CLI |
| **[band](#band)** | The **Claude desktop app**, above the prompt box | A row the plugin draws in the app's band (the app doesn't draw a status line) | On with the plugin; `/tokenomics:statusline band off` hides it |

Both show the same line, worked out by the same script (`scripts/statusline.ts`).

<p align="center"><img src="assets/statusline.svg" alt="The tokenomics statusline at 8%, 76% and 92% context" width="720"></p>

| Part | What it tells you |
|---|---|
| `ctx ████▒▒ 76%` | How full the conversation is. The bar goes **green**, turns **yellow at 75%** and **red at 90%**. A `▲` appears from 90%. When it is nearly full, start a fresh conversation. |
| `Σ 8.5M` | Total tokens used so far, in short form (`950`, `12.3K`, `8.5M`). |
| `£1.37` | What the session has cost, in your currency. A `~` in front (`~£1.37`) means it is an estimate. |
| `⧗ 04:12` | A countdown to when the prompt cache expires. While it runs, repeated context is cheap. The egg timer starts **full (green)**, is **half-empty (amber)** at about half time and **empty (red)** when it is running out. `00:00` means the cache has gone cold, and `--:--` means nothing has been cached yet. |

### Install the statusline

Node.js 22.18+, nothing else. With the plugin, in Claude Code:

```text
/tokenomics:statusline                 # or: /tokenomics:statusline both   (Claude Code + Copilot CLI)
/tokenomics:statusline uninstall       # to remove
```

The plugin switches it on for you at the start of your next session (so does the [one-line installer](installation.md#the-one-line-installer)), as long as no other status line is set (`TOKENOMICS_STATUSLINE=ask` makes it ask first, `off` leaves it off). The plugin keeps the installed copy up to date at each session start. From a terminal:

```bash
tokenomics statusline --install claude     # or: copilot, both
tokenomics statusline --uninstall claude   # to remove
tokenomics statusline --status             # where is it installed, and is the band on?
```

**Light or dark.** The statusline follows your computer's setting by default. To force one, put `{"theme": "dark"}` (or `"light"`) in `~/.tokenomics/statusline.json`. Preview every state with `tokenomics statusline --demo --theme light`. For very plain terminals use `--ascii` or set `NO_COLOR=1`.

**Currency and prices:** see [Configuration](configuration.md#currency).

<details>
<summary><b>Good to know about the statusline's countdown</b></summary>

- It counts from the last request that used the cache. The cache lasts 5 minutes, or 1 hour if your session uses the 1-hour cache. Override with `"cache_ttl"` (seconds).
- Claude Code redraws the statusline every second (this needs a recent version; on older ones it updates after each message).
- Copilot CLI doesn't say how often it redraws or when its cache expires, so there the countdown is approximate and may only move when Copilot redraws.
- For a smoothly ticking countdown in any assistant, run `node scripts/statusline.ts --watch` in a spare terminal pane.
</details>

### band

The same line in the **Claude desktop app** (and the mobile app), in the **band above the prompt box**, with the same colours. The app doesn't draw the CLI's status line, so the plugin draws this row itself (`hooks/band.tsx`, a [mod](https://code.claude.com/docs/en/plugins/mods/interface)).

- **On with the plugin.** It doesn't depend on the statusline: the band shows even if your terminal has another status line, or none.
- **Exact.** It uses the same figures Claude Code gives the terminal's status line, so the cost has no `~`. The countdown ticks every second, and the numbers update as replies and tool results land.
- **VS Code** has no band, so the line shows there as the plugin's status line above the prompt box.
- **Where mods can't run** (an older Claude Code, or mods turned off), the desktop app and VS Code get the line as a short message after each reply instead, e.g. `◆ claude-opus-5-5 │ ctx ███████▋▒▒▒▒ 64% │ Σ 1.7M │ ~£0.81 │ ⧗ 04:58 (cold at 12:37)`. It's a snapshot, so the countdown also tells you the clock time the cache goes cold.

```text
/tokenomics:statusline band off       # hide it (or: tokenomics statusline --band-off)
/tokenomics:statusline band on        # show it again
```

`TOKENOMICS_BAND=off` (or `on`) overrides the saved choice. The band turns on or off at the next reply.

---

## dashboard

A local web UI over the spendlens database: a headline **% OPEX vs % CAPEX** split bar, daily usage trend, per-project split, skills used and recent sessions. Switch the measure between tokens, sessions and prompts, and the range between 7d, 30d, 90d and all time. Light and dark mode follow your system.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/dashboard-dark.png">
  <img src="assets/dashboard-light.png" alt="The tokenomics dashboard showing the OPEX vs CAPEX split and daily token usage">
</picture>

```bash
tokenomics dashboard                      # opens http://127.0.0.1:8765 (runs in the background)
tokenomics dashboard --demo               # preview with seeded fake data
tokenomics dashboard --stop               # stop it
tokenomics dashboard --foreground --db /path/to/spendlens.db --port 9000
```

Inside Claude Code, `/tokenomics:dashboard` (or *"open the dashboard"*) does the same.

It reads the database read-only, listens on 127.0.0.1 only, and needs nothing beyond Node.js 22.18+. It uses `TOKENOMICS_DB` if set.

---

## Looking at your data

Everything lives in one SQLite file, `~/.tokenomics/spendlens.db`. Open it with any SQLite tool.

Your 10 most recent sessions:

```bash
sqlite3 ~/.tokenomics/spendlens.db \
  "select session_id, source, label, opex_score, capex_score, prompt_count from sessions order by updated_at desc limit 10;"
```

How many sessions of each label:

```bash
sqlite3 ~/.tokenomics/spendlens.db "select label, count(*) from sessions group by label;"
```

Tokens used by each label:

```bash
sqlite3 ~/.tokenomics/spendlens.db "select label, count(*) sessions, sum(input_tokens+output_tokens) tokens from sessions group by label;"
```

| Table | What's in it |
|---|---|
| `sessions` | One row per session, including `cost_usd` and `model` for Claude Code |
| `prompt_events` | One row per prompt, with its scores |
| `tool_events` | Copilot tool calls (name and kind only) |
| `cost_events` | Dated spend increases |
| `pennywise_events`, `handoff_events`, `diet_events`, `budget_events` | What each helper did |

---

<p align="center"><a href="installation.md">← Installation</a> · <a href="README.md">All docs</a> · <a href="configuration.md">Configuration →</a></p>
