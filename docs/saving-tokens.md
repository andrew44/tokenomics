<p align="right"><a href="../README.md">← Back to README</a> · <a href="README.md">All docs</a></p>

# Saving tokens (and money)

Practical tips for spending fewer tokens with an AI coding assistant, without getting worse results.

This builds on [How tokens work](how-tokens-work.md). If terms like *input*, *output* or *prompt cache* are new to you, read Part 1 of that guide first (five minutes).

---

## The short version

1. **One task, one conversation.** Long chats re-send their whole history with every message.
2. **Don't paste masses of text.** Point the AI at what matters, or have a cheap model read the pile and summarise it.
3. **Ask for less output.** Writing costs about five times as much as reading.
4. **Work with the cache, not against it.** Keep going while it's warm; hand off cleanly when you stop.
5. **Pick the model for the job, not for the price tag.** A cheap model that needs five attempts can cost more than an expensive one that gets it right first time.
6. **Get the prompt right first time.** Every retry re-reads everything.
7. **Keep standing instructions lean.** Anything loaded at the start is paid for on every turn.

The rest of this page explains each one, with worked examples.

### Prices used in the examples

To keep the sums easy, the examples use three made-up models. Real prices vary, but the ratios here are typical:

| Model | Input (per million tokens) | Output (per million tokens) | Think of it as |
|-------|---------------------------:|----------------------------:|----------------|
| **Premium** | £4.00 | £20.00 | The senior expert |
| **Mid** | £2.00 | £10.00 | The capable all-rounder |
| **Small** | £0.40 | £2.00 | The fast, cheap assistant |

---

## 1. One task, one conversation

The AI has no memory between messages: **the whole conversation is sent again every time you reply**. Message 40 in a long chat carries the weight of messages 1 to 39, even if you only typed "ok".

**Tips**

- **Start a new conversation when you change task.** Fixing a bug and then "while you're here, can you also look at the login page" drags the whole bug-fix history into the login work. In Claude Code, `/clear` starts afresh.
- **Avoid side quests.** A quick unrelated question mid-task ("what's the syntax for X again?") gets re-sent for the rest of the session. Ask it in a separate window.
- **Summarise and restart long sessions.** If a session has grown huge but you're not finished, compact it (`/compact` in Claude Code) or let **doggybag** pack a short note and `/clear` to continue from it.
- **Watch the fuel gauge.** The tokenomics **statusline** shows how full the conversation is. When it is past halfway, consider wrapping up or restarting.

---

## 2. Don't paste masses of text

Pasting a huge log file, a whole codebase dump or a long document is one of the quickest ways to burn tokens. You pay for it once when you paste it, and then **again on every message for the rest of the conversation**, because it is now part of the history.

**Tips**

- **Point, don't paste.** Tell the assistant *which* file and roughly *where* ("the `parse_date` function in `utils/dates.py`") and let it open just that part.
- **Trim it yourself first.** For logs, `grep` for the error, or take the last 200 lines with `tail`. Free tools cost zero tokens.
- **Let a cheap model do the reading.** If you do need something big read, have a **small model read it and report back** what matters, then give that short report to the expensive model doing the real work. Many assistants do this for you with *subagents*: a helper that explores files in its own separate conversation and hands back only a summary.
- **Images cost too.** A full-screen screenshot can cost as much as a page or two of text. Crop to the part that matters.

### Worked example: a 200,000-token log file

You want the Premium model to fix a bug, and the clue is somewhere in a big log file. The session runs for 10 more messages after that.

**Option A: paste the log straight into the Premium conversation**

| Step | Tokens | Cost |
|------|-------:|-----:|
| Log goes into the cache (written once, at 1.25x input price) | 200,000 | £1.00 |
| Log is re-read from cache on each of the next 10 messages (at ~0.1x) | 10 x 200,000 | £0.80 |
| **Total for the log alone** | | **~£1.80** |

And that assumes the cache never goes cold. Take a break and the next message pays the £1.00 again.

**Option B: a Small model reads the log and writes a 2,000-token summary**

| Step | Tokens | Cost |
|------|-------:|-----:|
| Small model reads the log | 200,000 in | £0.08 |
| Small model writes the summary | 2,000 out | £0.004 |
| Summary goes into the Premium conversation, then is re-read 10 times | 2,000 + 10 x 2,000 | ~£0.02 |
| **Total** | | **~£0.10** |

**Roughly 18 times cheaper**, and the Premium model works with a tidy summary instead of wading through noise, which often gives better answers too.

**The catch:** a summary can miss things. Tell the small model exactly what to look for ("find every error mentioning `payment` after 14:00 and quote the full stack traces") rather than "summarise this".

---

## 3. Ask for less output

Output tokens typically cost **about five times** as much as input tokens, and every word the AI writes becomes input for every message after it. A long answer is paid for twice: once when written, and again each time it's re-read.

**Tips**

- **Say how long you want the answer.** "One paragraph", "just the command", "yes or no, then why in one sentence".
- **Ask for changes, not whole files.** "Show me only the lines you changed" instead of re-printing a 500-line file to alter three lines.
- **Skip the recap.** "Don't summarise what you did at the end" saves a surprising amount over a long session.
- **Turn down the thinking for easy jobs.** Many assistants let you set an *effort* or *reasoning* level. Reasoning is billed as output even when you don't see it, so use a low setting for simple, well-defined tasks and save high effort for hard problems.

---

## 4. Work with the cache, not against it

The prompt cache lets the AI re-read recent conversation at roughly a tenth of the normal price, but it only lasts a short while (usually 5 minutes, sometimes an hour). See [How tokens work](how-tokens-work.md#25-the-prompt-cache) for the details.

**Tips**

- **Keep momentum on big sessions.** Each reply within the cache window keeps it warm. The **statusline** egg timer shows how long you've got.
- **Stop cleanly instead of drifting off.** Coming back to a large, cold session means paying to load the whole thing again. Let **doggybag** pack a short note before the cache runs out, then `/clear` and carry on from it.
- **Don't switch models mid-session.** Each model has its own cache, so switching starts cold. If you want a different model for a different job, do it in a new session.
- **Don't change the start of the conversation.** Editing the instructions file (for example `CLAUDE.md`) or adding tools mid-session changes the beginning of the prompt, and everything after it misses the cache. Make those changes between sessions.

---

## 5. Pick the model for the job, not for the price tag

Cheaper models are a great way to save money **on the right tasks**: renaming things, writing simple tests, boilerplate, reading and summarising (see tip 2). **pennywise** routes simple prompts to them automatically for exactly that reason.

But **the cheapest model per token is not always the cheapest model per finished job.** If a cheaper model needs several attempts at something a stronger model would get right first time, every retry re-sends the growing conversation, and the savings evaporate.

### Worked example: a tricky bug fix

The task starts with 50,000 tokens of context (code, instructions, the error). Each answer is about 5,000 tokens, and each time you reply "that didn't work, here's the new error" adds about 2,000 more.

**Premium, gets it right first time**

| Attempt | Input | Output | Cost |
|---------|------:|-------:|-----:|
| 1 | 50,000 | 5,000 | £0.20 + £0.10 = **£0.30** |

**Mid (half the price), needs five attempts**

| Attempt | Input | Output | Cost |
|---------|------:|-------:|-----:|
| 1 | 50,000 | 5,000 | £0.15 |
| 2 | 57,000 | 5,000 | £0.16 |
| 3 | 64,000 | 5,000 | £0.18 |
| 4 | 71,000 | 5,000 | £0.19 |
| 5 | 78,000 | 5,000 | £0.21 |
| **Total** | 320,000 | 25,000 | **~£0.89** |

The model that is **half the price per token cost three times as much** for the job, and took five round trips of your time and attention. (Caching narrows the gap a little, but doesn't close it: every retry still adds new output and new input.)

### Rules of thumb

| The task is... | Best choice |
|----------------|-------------|
| Simple, well-defined, easy to check (rename, format, boilerplate, simple tests) | **Small** model. It will usually get it right first time. |
| Reading, searching or summarising lots of material | **Small** model, handing its findings to a stronger one. |
| Everyday coding with a clear spec | **Mid** model is often the sweet spot. |
| Hard, ambiguous, or needs careful reasoning (tricky bugs, design, unfamiliar code) | **Premium** model, aiming to one-shot it. |
| A big job with a hard part and a lot of routine work | Plan with **Premium**, then let a cheaper model carry out the routine steps. |

**A useful test:** if you've told a cheaper model "that's still wrong" twice, switch up. Start a new session on a stronger model with a short summary of what has been tried, rather than continuing the long failed thread.

---

## 6. Get the prompt right first time

Every retry costs a full re-read of the conversation, so a minute spent on the first message often saves several rounds.

**Tips**

- **Say what "done" looks like.** "The tests in `test_dates.py` pass and no other files change" beats "fix the date bug".
- **Give the error, not your theory.** Paste the exact error message and the command that produced it (just those, not the whole terminal history).
- **Mention constraints up front.** Library versions, "don't add dependencies", "keep the public API the same". Finding these out on attempt three is expensive.
- **Plan before building, for big changes.** Ask for a short plan first and check it before any code is written. Correcting a plan is cheap; correcting 400 lines of the wrong code is not. (Claude Code has a *plan mode* for this.)
- **Batch related asks.** "Fix X, Y and Z" in one message is cheaper than three separate rounds, as long as they're part of the same task.

---

## 7. Keep standing instructions lean

Anything loaded at the start of every conversation is paid for on **every message**: project instruction files (such as `CLAUDE.md`), the descriptions of every tool and plug-in the assistant can use, and any files you always attach.

**Tips**

- **Trim your instructions file.** Keep it to rules the AI actually needs. Remove outdated notes, long examples and anything it would work out by reading the code.
- **Switch off tools you don't use.** Each connected tool or integration adds its description to every request.
- **Don't auto-attach big files.** Reference them so they're read only when needed.

These costs are mostly cached and cheap per message, but they add up over hundreds of messages, and they also use up room in the conversation that could hold your actual work.

---

## Measure, don't guess

Habits are easier to change when you can see the effect.

- **statusline** shows tokens used, cost so far and the cache timer as you work.
- **coach** reviews a finished conversation and points out the biggest wastes, such as large pastes, cache rebuilds and long outputs.
- **spendlens** records every session so you can compare before and after.
- In Claude Code, `/cost` and `/context` show what the current session has used and what is taking up room.

---

## Cheat sheet

| Instead of... | Try... |
|---------------|--------|
| One long chat for the whole day | A new conversation per task |
| Pasting a 5,000-line log | `grep` / `tail` first, or have a small model summarise it |
| "Summarise this" | "Find X and quote it exactly" |
| "Rewrite the file with the fix" | "Show only the changed lines" |
| Coming back to a cold, huge session | `/clear` and carry on from the doggybag |
| Switching models halfway through | Switching between sessions |
| Retrying a cheap model for the fourth time | A fresh session on a stronger model with a short summary |
| "Fix the bug" | The exact error, the command, and what "done" looks like |
| Premium model for renaming variables | Small model for simple, checkable jobs |

---

<p align="center"><a href="how-tokens-work.md">← How tokens work</a> · <a href="README.md">All docs</a> · <a href="skills-tools-and-hooks.md">Skills, tools and hooks →</a></p>
