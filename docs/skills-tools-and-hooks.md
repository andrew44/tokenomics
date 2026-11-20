<p align="right"><a href="../README.md">← Back to README</a> · <a href="README.md">All docs</a></p>

# Skills, tools and hooks: what each one does and when to reach for it

tokenomics is made of three kinds of helper. This page lists every one, says what it does, and, most usefully, **when to reach for it**.

| Kind | How it runs | You... |
|------|-------------|--------|
| **Skills** | The assistant runs them when you ask in plain words (or type the slash command). | ask for them. |
| **Hooks** | The assistant runs them automatically at set moments (a prompt is sent, a tool is about to run, a session ends). | do nothing. Tune or switch them off with settings. |
| **Tools** | Scripts you run yourself from a terminal. | run them when you want a number, a view or a change of setup. |

New to tokens, the prompt cache or why context costs money? Read [How tokens work](how-tokens-work.md) first, then [Saving tokens](saving-tokens.md) for habits that pair well with these helpers.

---

## At a glance: "I want to..."

| I want to... | Reach for | Kind |
|--------------|-----------|------|
| Know why a session was expensive, or get better at prompting | [coach](#coach) | Skill |
| See what I spent this week / month, and where | [spend-report](#spend-report) | Skill |
| Know how full the conversation is and what it has cost, right now | [statusline](#statusline) | Tool |
| Know how long until the prompt cache goes cold | [statusline](#statusline) | Tool |
| See OPEX vs CAPEX and usage trends as charts | [dashboard](#dashboard) | Tool |
| Check where I am against my spending limit | [budget status](#budget-1) | Tool |
| Stop myself overspending | [budget](#budget) | Hook |
| Send each prompt to the right model (cheap for trivial, strong for hard) | [pennywise](#pennywise) | Hook (or the [router proxy](#tokenomics-router)) |
| Stop the AI pulling huge files or logs into the conversation | [diet](#diet) | Hook |
| Pick up after a break where I left off, cheaply | [doggybag](#doggybag) | Hook (plus `tokenomics doggybag`) |
| Know how much AI time went on building vs running things | [spendlens](#spendlens) + [dashboard](#dashboard) / [spend-report](#spend-report) | Hook + Tool / Skill |
| Get raw numbers for a script or spreadsheet | [coach.ts --json](#coachts), [report.ts --json](#reportts), or [sqlite3](reference.md#looking-at-your-data) | Tool |
| Refresh model prices | [update_prices.ts](#update_pricests) | Tool |
| Know whether the AI is delivering value for the money (cost per feature, bug fixed, passing suite) | [bangforbuck](#bangforbuck) | Skill (hook records it) |
| Know whether a task is worth £2 before it starts, and hold the agent to a price | [haggle](#haggle) | Skill + Hook |
| Find where the money is disappearing inside a session | [sherlock](#sherlock) | Skill |
| Know whether I'm getting worse value than last month, or fail CI on cost creep | [waistline](#waistline) | Skill + Tool |
| Prove an optimisation (cheaper model, trimmed instructions) hasn't damaged quality | [tastetest](#tastetest) | Skill + Tool |
| Clean up CLAUDE.md / AGENTS.md: duplicates, stale paths, contradictions | [springclean](#springclean) | Skill + Tool |
| Stop the AI going round in circles | [groundhog](#groundhog) | Hook (plus a skill to check a session) |

```mermaid
flowchart TD
    Q{"What do you need?"} -->|"Advice on how I'm working"| CF["coach<br/>(skill)"]
    Q -->|"A summary of spend over time"| SR["spend-report<br/>(skill)"]
    Q -->|"A live view while I work"| SB["statusline<br/>(tool)"]
    Q -->|"Charts"| DB["dashboard<br/>(tool)"]
    Q -->|"Guard rails that act on their own"| H["Hooks:<br/>pennywise, diet, budget, doggybag,<br/>haggle, groundhog"]
    Q -->|"Value, waste and quality"| V["bangforbuck, sherlock, waistline,<br/>tastetest, springclean (skills)"]
    Q -->|"Data collected in the background"| SL["spendlens<br/>(hook)"]
```

---

## Skills

Skills are instructions the assistant follows when you ask. They only run when you ask for them, so they cost tokens only then.

### coach

**What it does.** Reads the current conversation's transcript (read-only) and tells you, with numbers, where tokens were wasted: low cache hit ratio, cache rebuilds, oversized context, vague or correction-heavy prompts, repeated file reads, huge tool results, model switches, mixed topics. It rewrites your weakest prompt and points out what you are doing well.

**Reach for it when:**

- A session felt slow or expensive and you want to know why.
- The statusline shows a big cost or a nearly full context and you're not sure what caused it.
- spend-report names one session as the costliest and you want the detail (give it the session id).
- You want to improve your prompting habits generally. Running it at the end of a long session is a good routine.

**Don't reach for it when:** you want spend across many sessions (use [spend-report](#spend-report)), or you're on Copilot CLI (there is no transcript to read).

**How:** say *"coach, review my prompts"*, *"why was that session expensive?"*, or type `/tokenomics:coach`. Script behind it: [`coach.ts`](#coachts).

### spend-report

**What it does.** Turns the spendlens database into a short report for a period (default the last 7 days): money spent in your currency, the OPEX/CAPEX split, top projects and models, the costliest sessions, what pennywise, doggybag, diet and budget did, and three ways to spend less tied to your own numbers.

**Reach for it when:**

- It's the end of the week (or month) and you want to know where the money went.
- Someone asks how much AI time goes on building vs running things.
- You want to check whether the guard-rail hooks are actually saving anything.
- You've hit a budget pause and want context ("am I always this high?").

**Don't reach for it when:** you want to look inside one session (use [coach](#coach)) or want charts (use the [dashboard](#dashboard)).

**How:** say *"spend report"*, *"where did my tokens go this week?"*, or name a period: *"spend report for this month in dollars"*. Script behind it: [`report.ts`](#reportts). Needs the plugin installed so spendlens has been recording.

### bangforbuck

**What it does.** Answers *"is the AI actually delivering value for the money?"* with the cost of useful work rather than tokens: cost per completed feature, bug fixed, passing test suite, commit, PR and successful agent task, each against the previous period, plus, per model, cost per session next to **cost per success** (the cheapest model is often not the best value). A hook fills the ledger at the end of every turn.

**Reach for it when:** someone asks whether the AI is worth it; you're choosing a default model; or you want a value number to track month to month rather than a spend number.

**How:** *"is the AI worth the money?"*, *"cost per feature this month"*, *"which model is best value?"*. Tool: `tokenomics bangforbuck`. Details: [bangforbuck](reference.md#bangforbuck).

### haggle

**What it does.** Answers *"is this task worth spending £2 on?"* before the work starts: a quote with input, output and tool costs from your own history, and a verdict against your price. Substantial prompts get a quote automatically; start a prompt with `haggle £2:` and the agent must stop and ask before going over.

**Reach for it when:** you're about to hand over a big task, a refactor or a migration, and want to know the bill first, or want a hard ceiling on it.

**How:** *"how much would it cost to migrate the auth module?"*, *"is this worth £2?"*. Tool: `tokenomics haggle quote "..." --price 2`. Details: [haggle](reference.md#haggle).

### sherlock

**What it does.** Answers *"where is the money disappearing?"* with a forensic audit of what the agent did: files read twice, calls repeated for the same answer, searches rephrased into the same results, big outputs never used, subagents doing overlapping or one-step jobs. Each with its cost, why it was waste, and the fix.

**Reach for it when:** coach says a session was expensive and you want to know which *steps* were wasted, or bangforbuck shows a costly session with nothing to show.

**How:** *"where did the money go in that session?"*, *"sherlock"*. Tool: `tokenomics sherlock`. Details: [sherlock](reference.md#sherlock).

### waistline

**What it does.** Answers *"am I getting worse value than last month?"*: compares equivalent work across periods (cost per session, per result and per kind of task, context per request, tool calls, new tools, model changes) and names the cause of any creep. Also runs in CI against a committed baseline.

**Reach for it when:** the bill feels higher but nothing obvious changed; after adding an MCP server, a bigger CLAUDE.md or a new model; or to stop cost creep in an automated agent pipeline.

**How:** *"am I getting worse value than last month?"*. Tool: `tokenomics waistline --days 30`; CI: `--baseline file --ci`. Details: [waistline](reference.md#waistline).

### tastetest

**What it does.** Answers *"can I prove the optimisation hasn't damaged quality?"*: compares two runs of the same task on cost and on evidence of quality (your tests, linter and type checker in each working copy, plus each transcript's signals) and gives a quality-adjusted saving with a verdict: safe saving, cheaper but worse, or false economy.

**Reach for it when:** trialling a cheaper model, a trimmed CLAUDE.md or a new prompt, before making it the default.

**How:** *"did the Haiku run do as well as the Opus one?"*. Tool: `tokenomics tastetest --a <id> --a-dir ../a --b <id> --b-dir ../b`. Details: [tastetest](reference.md#tastetest).

### springclean

**What it does.** Audits the instructions that load with every session for duplicates across files, outdated paths and commands, oversized files, changelogs and long examples, contradictions and heavy startup context, and proposes a cleanup with what it saves per request and per month. Applies only the edits you approve.

**Reach for it when:** CLAUDE.md has grown for months, several tools each have their own instruction file, or waistline says context per request is creeping up.

**How:** *"springclean my CLAUDE.md"*. Tool: `tokenomics springclean`. Details: [springclean](reference.md#springclean).

### groundhog

**What it does.** Checks a finished session for loops (the same call again, a command failing over and over, edits made and undone, tokens climbing with no progress) and what they cost. The [groundhog hook](#groundhog-1) catches them live.

**How:** *"is it going round in circles?"*. Tool: `tokenomics groundhog`.

---


## Hooks

Hooks run automatically once the plugin is installed. You don't call them; you decide whether to keep them on and how strict they are. Each guard-rail hook has a `block` / `warn` / `off` setting (see [Configuration](configuration.md)).

Where each hook fires:

| Moment | Claude Code event | Copilot CLI event | Hooks |
|--------|-------------------|-------------------|-------|
| Session starts (or `/clear`) | `SessionStart` | (none) | doggybag, waistline\* |
| You send a prompt | `UserPromptSubmit` | `userPromptSubmitted` | spendlens, pennywise\*, budget\*, doggybag, haggle\* |
| A tool is about to run | `PreToolUse` (diet: `Read`, `Bash`; the rest: every tool) | `preToolUse` | diet, groundhog, haggle\* |
| A tool has run | (none) | `postToolUse` | spendlens |
| The assistant finishes a turn | `Stop` | (none) | spendlens, doggybag, bangforbuck, haggle |
| Session ends | `SessionEnd` | `sessionEnd` | spendlens, doggybag, bangforbuck\*, sherlock\*, haggle\* |

\* Claude Code only: Copilot ignores prompt-hook output, so it can't pause a prompt, and it has no transcript or token counts for the value and waste helpers to read.

```mermaid
sequenceDiagram
    participant You
    participant Hooks
    participant AI as Assistant
    You->>Hooks: send prompt
    Note over Hooks: spendlens scores it<br/>pennywise: which model suits it?<br/>budget: over limit?
    Hooks->>AI: prompt (unless paused)
    AI->>Hooks: wants to Read / run Bash
    Note over Hooks: diet: will this flood the context?
    Hooks->>AI: allowed, or "ask for less"
    AI->>You: reply (turn ends)
    Note over Hooks: spendlens records tokens<br/>doggybag arms its watcher
```

### spendlens

**What it does.** Labels each session **OPEX** (running things: logs, metrics, incidents), **CAPEX** (building things: writing or changing code), `mixed` or `unknown`, and saves one row per session to `~/.tokenomics/spendlens.db` with token counts and cost. It never blocks or shows anything. Every other reporting helper reads its data.

**Reach for it when:** you want any history at all. Keep it on; spend-report, the dashboard and budget rely on it. Reach for its settings when:

- Labels look wrong: map your own skills with `TOKENOMICS_SKILL_MAP`, or edit the keyword lists in `tokenomics/engine/classifier.ts`.
- Keywords keep missing: set `TOKENOMICS_LLM=1` to let a model decide once per session (prompts leave your machine, redacted; point it at a local model if sensitive).
- A team wants one shared view: point `TOKENOMICS_DB` at a shared location.

**Script:** `scripts/spendlens.ts` (`prompt`, `tool`, `finalize`, and `capabilities` to see what each assistant supports). Details: [What spendlens saves](reference.md#spendlens).

### pennywise

**What it does.** A model router. Scores each prompt from weighted signals (length, code, simple-task phrases, technical terms, complex work, reasoning words, multi-step structure) into one of four tiers, `SIMPLE` → Haiku, `MEDIUM` → Sonnet, `COMPLEX` → Opus, `REASONING` → Opus (you choose the map). As a hook it hands the prompt to a subagent on that model, routing down to save money and up when your model is out of its depth. As a local proxy (`tokenomics router serve`) it rewrites the model of every request, cache-aware, with fallback.

**Reach for it (keep it on) when:** you tend to leave one model selected all day, or a team is new to choosing models. Run the proxy when you want every turn routed with full context rather than handed to a subagent. Set it to `block` if you'd rather be asked to switch with `/model`, or `off` if you always pick models deliberately.

**To steer one prompt:** start it with `keep-model:`, or `haiku:` / `sonnet:` / `opus:` / `fable:` to force a model. Curious why a prompt went where it did? `tokenomics router explain "<prompt>"`. Claude Code only. Details: [Using pennywise](reference.md#pennywise).

### diet

**What it does.** Before a `Read` or `Bash` call runs, refuses a small set of calls known to flood the context (whole lockfiles or minified files, unbounded `kubectl logs` / `git log` / `find /`, `cat` of a huge file) and tells the AI how to ask for less. The AI retries with a narrower call on its own. Each block is logged with an estimate of tokens kept out.

**Reach for it (keep it on) when:** you do a lot of ops or debugging work (logs, big repos), since one unbounded log dump is paid for again on every later turn. Raise `TOKENOMICS_DIET_MAX_KB` if it blocks files you genuinely need whole.

**When you need the whole thing:** append `# diet-ok` to the command. Works in Claude Code and Copilot CLI. Details: [Using diet](reference.md#diet).

### budget

**What it does.** Tracks spend against a daily and/or per-session limit in your currency. One notice at 80%; at 100% your next prompt is paused with cheaper ways forward (`/compact`, a smaller model, a fresh session).

**Reach for it when:** you're paying out of your own pocket, you have a monthly allowance to stretch, or you're trialling a new, pricier model. It does nothing until you set `TOKENOMICS_BUDGET_DAILY` and/or `TOKENOMICS_BUDGET_SESSION`.

**When it pauses you:** send the same prompt again, or start it with `over-budget:`; you won't be paused again for that limit that day. Use `TOKENOMICS_BUDGET_MODE=warn` for notices only. Claude Code only (Copilot bills premium requests, which hooks can't see). Details: [Using budget](reference.md#budget).

### doggybag

**What it does.** Just before the prompt cache expires, packs a short "where we got to" note into your project at `.doggybag/latest.md` (the folder ignores itself in git): branch and changes, tasks, your last requests, files edited, recent commands, and how to carry on. No model is called, so it costs nothing. If you come back after the cache went cold, your next prompt makes sure it's packed and tells you what carrying on cold would cost; `/clear` (or a new session in the folder) loads it automatically.

**Reach for it when:** you step away from a session for more than a few minutes and plan to come back. Instead of carrying on in the cold session (which re-writes the whole conversation into the cache), type `/clear` and keep going. Need one now? `tokenomics doggybag`.

**Turn it off** (`TOKENOMICS_DOGGYBAG=off`) if you never resume work across breaks. Copilot support is best effort. Details: [Using doggybag](reference.md#doggybag).

---

### groundhog

**What it does.** Before every tool call, checks whether the agent is going round in circles: the same call with the same input again with nothing changed, a command that keeps failing, an edit made and undone, or 20 calls of mostly errors with the context still growing. The first time, it refuses the call with the evidence and tells the agent to change strategy; by default it refuses at most twice and then lets it through and tells you (`interrupt` ends the turn instead).

**Reach for it (keep it on) when:** you let the agent work unattended, or on long debugging sessions where a stuck agent burns money fastest.

**When it's wrong:** append `# groundhog-ok` to a command; `TOKENOMICS_GROUNDHOG=warn` for notices only. In Copilot CLI it catches identical calls in a row. Details: [groundhog](reference.md#groundhog).

### haggle (hook)

**What it does.** Quotes each substantial prompt as you send it and tracks the task's spend as it runs; tells you once it passes its estimate and its cap; if you set the price (`haggle £2: ...`, or `TOKENOMICS_HAGGLE=strict`) it stops the agent at the cap and has it ask you to approve more (`haggle +£1`). Claude Code only. Details: [haggle](reference.md#haggle).

### bangforbuck, sherlock and waistline (hooks)

Quiet record-keepers for the skills above. **bangforbuck** writes each session's cost and outcomes to the ledger at every turn end; **sherlock** logs each session's estimated waste at session end (shown in the spend report); **waistline** checks once a day at session start and shows one line if last week cost noticeably more per session or per result than the week before. Each has an `=off` switch (see [Configuration](configuration.md#value-waste-and-quality)).

---

## Tools

Scripts you run yourself. All need only Node.js 22.18+ (they're TypeScript, run directly) and live in `scripts/`. Run them from the repo (or plugin) folder.

### statusline

`scripts/statusline.ts`: a live line at the bottom of Claude Code or Copilot CLI in a terminal, showing model, context fill, total tokens, cost and the cache countdown. In the Claude desktop app the same line is the **band** above the prompt box (`hooks/band.tsx`).

**Reach for it when:** you want to *see* cost as you go rather than find out afterwards. It's the best everyday early warning: start a fresh conversation when the context bar goes red, and finish your thought (or let doggybag pack a note) before the cache timer runs out.

| Command | Use it to |
|---------|-----------|
| `/tokenomics:statusline` (plugin) or `tokenomics statusline --install claude` (or `copilot`, `both`) | Install it (backs up your settings first). `--uninstall` removes it, `--status` says where it is. |
| `tokenomics statusline --band-off` (`--band-on`) | Hide (or show) the band in the desktop app. |
| `tokenomics statusline --set-currency USD` | Choose £, $ or € for every cost tokenomics shows. |
| `tokenomics statusline --update-rate` | Fetch today's exchange rates. |
| `tokenomics statusline --watch` | A smoothly ticking countdown in a spare terminal pane. |
| `tokenomics statusline --demo --theme light` | Preview every state and colour. |

Details: [statusline](reference.md#statusline) and [band](reference.md#band) reference.

### dashboard

`scripts/dashboard.ts`: a local web page over the spendlens database with a % OPEX vs % CAPEX bar, daily trend, per-project split, skills used and recent sessions.

**Reach for it when:** you want trends or a picture to share (a team review, a finance question), rather than a written summary. `--demo` shows it with fake data before you have any of your own.

```
tokenomics dashboard              # http://127.0.0.1:8765
tokenomics dashboard --demo
```

Read-only, local only. Details: [dashboard reference](reference.md#dashboard).

### report.ts

`scripts/report.ts`: the engine behind [spend-report](#spend-report).

**Reach for it directly when:** you want the report without asking the assistant (no tokens spent), or want JSON for a script or spreadsheet.

```
node scripts/report.ts                     # last 7 days, Markdown
node scripts/report.ts --days 30 --json    # --days 0 for all time
node scripts/report.ts --currency EUR
```

### budget

`node scripts/budget.ts status` shows today's and this session's spend against your limits. **Reach for it** before a big piece of work, or after a budget notice, to see how much headroom is left.

### coach.ts

`scripts/coach.ts`: the analyser behind the [coach](#coach) skill.

**Reach for it directly when:** you want the raw flags and numbers without spending tokens on the assistant's write-up, or want to analyse an older session.

```
node scripts/coach.ts                     # newest transcript for this folder
node scripts/coach.ts --session <id> --json
node scripts/coach.ts --transcript path/to/file.jsonl
```

### tokenomics router

`tokenomics router serve` runs pennywise as a local routing proxy; `tokenomics router explain "<prompt>"` shows the tier, score and signals for a prompt. **Reach for it** when you want every request routed with full context, or to tune the tiers.

### tokenomics doggybag

`tokenomics doggybag` (or `node scripts/doggybag.ts write`) packs a doggybag on demand. **Reach for it** when you're about to stop and want the note now rather than waiting for the cache timer.

### spendlens.ts capabilities

`node scripts/spendlens.ts capabilities` lists what each assistant can report (transcript, token counts, tool events, billing). **Reach for it** when a column is empty and you want to know whether that's expected for that assistant.

### Value, waste and quality tools

The scripts behind the seven value skills; run them directly for no-token answers or JSON (`--json` on each):

```
tokenomics bangforbuck --days 30                 # cost per outcome; also: session, mark <kind>, ingest <dir>
tokenomics haggle quote "migrate auth" --price 2 # is it worth £2?   haggle status: quoted vs actual
tokenomics sherlock --session <id>               # hidden waste in a session
tokenomics waistline --days 30                   # cost regression; --save-baseline / --baseline F --ci
tokenomics tastetest --a <id> --b <id> --a-dir ../a --b-dir ../b
tokenomics springclean --dir .                   # context hygiene audit
tokenomics groundhog --session <id>              # loops in a finished session
```

### update_prices.ts

`scripts/update_prices.ts`: refreshes `data/model-prices.json` from Claude's pricing page. A GitHub Action already runs it every Monday.

**Reach for it when:** a new model has launched or prices changed and you don't want to wait for Monday, or (`--check`) to confirm the file is current. To override a single price instead, use `"prices"` in `~/.tokenomics/statusline.json` (see [Prices](configuration.md#prices)).

```
node scripts/update_prices.ts            # fetch and update
node scripts/update_prices.ts --check    # exit 1 if out of date
```

---

## A sensible setup

- **Everyone:** install the plugin (spendlens, diet, doggybag and pennywise run by default) and the [statusline](#statusline).
- **Paying personally or on an allowance:** also set a [budget](#budget).
- **Weekly:** ask for a [spend-report](#spend-report).
- **After any session that surprised you:** ask the [coach](#coach), then [sherlock](#sherlock) for the wasted steps.
- **Monthly:** ask [bangforbuck](#bangforbuck) whether value is improving and [waistline](#waistline) whether costs are creeping; [springclean](#springclean) your instruction files.
- **Before a big task:** ask [haggle](#haggle) for a quote, or start the prompt with `haggle £X:`.
- **Before switching to a cheaper model or trimmed instructions for good:** run a [tastetest](#tastetest).
- **Teams:** share a database with `TOKENOMICS_DB` and look at the [dashboard](#dashboard) together.

See [Installation](installation.md) to get set up, [Configuration](configuration.md) for every setting, and [Installation → Troubleshooting](installation.md#troubleshooting) if something looks wrong.

---

<p align="center"><a href="saving-tokens.md">← Saving tokens</a> · <a href="README.md">All docs</a> · <a href="reference.md">Helper reference →</a></p>
