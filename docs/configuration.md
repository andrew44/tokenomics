<p align="right"><a href="../README.md">← Back to README</a> · <a href="README.md">All docs</a></p>

# Configuration

tokenomics works out of the box. Everything here is optional.

Settings are environment variables. Set them in your shell profile, or in Claude Code's `settings.json` under `"env"`:

```json
{
  "env": {
    "TOKENOMICS_CURRENCY": "USD",
    "TOKENOMICS_BUDGET_DAILY": "20",
    "TOKENOMICS_PENNYWISE": "warn"
  }
}
```

---

## All settings

### Guards

| Setting | Default | What it does |
|---|---|---|
| `TOKENOMICS_PENNYWISE` | `route` | `route` (hand simple prompts to a cheaper-model subagent), `block` (pause and suggest `/model`), `warn` (notice only) or `off`. |
| `TOKENOMICS_DIET` | `block` | `block`, `warn` (notice only, never stops a call) or `off` for diet. |
| `TOKENOMICS_DIET_MAX_KB` | `64` | diet never blocks a file smaller than this. |
| `TOKENOMICS_BUDGET_DAILY` | none | Daily spending limit in your currency, e.g. `20`. No limit = budget does nothing. |
| `TOKENOMICS_BUDGET_SESSION` | none | Per-session spending limit in your currency. |
| `TOKENOMICS_BUDGET_WARN` | `80` | Percent of a limit at which budget shows a notice. |
| `TOKENOMICS_BUDGET_MODE` | `block` | `block`, `warn` (notices only) or `off`. |

### handoff

| Setting | Default | What it does |
|---|---|---|
| `TOKENOMICS_HANDOFF` | `on` | `off` stops handoff from writing or watching. |
| `TOKENOMICS_HANDOFF_LEAD` | `60` | Seconds before the cache expires to write the handoff. |
| `TOKENOMICS_HANDOFF_DIR` | `~/.tokenomics/handoffs` | Where handoff files go. The newest 30 are kept (`TOKENOMICS_HANDOFF_KEEP`). |
| `TOKENOMICS_HANDOFF_INJECT` | off | Set to `1` to load the latest handoff into a new session automatically. |

### spendlens and data

| Setting | Default | What it does |
|---|---|---|
| `TOKENOMICS_DB` | `~/.tokenomics/spendlens.db` | Where the database file lives. Point it at a shared location to collect several machines' data. |
| `TOKENOMICS_STORE_PROMPT` | off | Set to `1` to keep a 200-character excerpt of each prompt. Off by default for privacy. |
| `TOKENOMICS_SKILL_MAP` | none | Path to a JSON file that tells spendlens which side a skill belongs to, e.g. `{"our-grafana-skill": "opex", "pdf": "capex"}`. This always wins over the built-in guessing. |

### AI classifier (optional)

| Setting | Default | What it does |
|---|---|---|
| `TOKENOMICS_LLM` | off | Set to `1` to have an AI model decide OPEX or CAPEX at session end (see [the reference](reference.md#optional-let-an-ai-model-decide)). Sends redacted prompt text to the endpoint. |
| `TOKENOMICS_LLM_URL` | `https://api.openai.com/v1/chat/completions` | Any OpenAI-compatible chat endpoint. A non-default URL needs no key, so local models work. |
| `TOKENOMICS_LLM_KEY` | `OPENAI_API_KEY` | API key for that endpoint. |
| `TOKENOMICS_LLM_MODEL` | `gpt-4o-mini` | Which model to ask. |
| `TOKENOMICS_LLM_TIMEOUT` | `12` | Seconds to wait before falling back to keywords (capped at 15 to fit the 20-second hook limit). |

### Display, currency and prices

| Setting | Default | What it does |
|---|---|---|
| `TOKENOMICS_THEME` | `system` | Status bar colours: `light`, `dark` or `system`. |
| `TOKENOMICS_CURRENCY` | `GBP` | Currency for every cost shown: `GBP` (£), `USD` ($) or `EUR` (€). Also saved by `statusbar.py --set-currency`. |
| `TOKENOMICS_USD_EUR` | `0.86` | Euros per dollar, when the currency is EUR. |
| `TOKENOMICS_USD_GBP` | `0.76` | Pounds per dollar, when the currency is GBP. |
| `TOKENOMICS_CACHE_TTL` | auto | Cache lifetime in seconds for the status bar's countdown. |

---

## Currency

Costs show in pounds (£) by default. To use US dollars ($) or euros (€) instead, run one of:

```bash
python3 ~/.tokenomics/statusbar.py --set-currency USD     # or EUR, or GBP
export TOKENOMICS_CURRENCY=EUR                            # or set it per shell / in Claude Code's "env"
```

The choice is saved as `"currency"` in `~/.tokenomics/statusbar.json`, and the status bar, budget, spend report and handoff notes all use it (`$`, `€` and `£` work too, e.g. `--set-currency €`). `TOKENOMICS_CURRENCY` wins over the saved choice, and `--currency USD` on a single status bar or report run wins over both.

Prices are in dollars, so dollars need no conversion; pounds and euros are converted at 0.76 and 0.86 per dollar unless you set the rate. Run `python3 ~/.tokenomics/statusbar.py --update-rate` to fetch today's rates, or set `"usd_gbp"` / `"usd_eur"` in the same file (or `TOKENOMICS_USD_GBP` / `TOKENOMICS_USD_EUR`).

---

## Prices

When the assistant doesn't report a cost itself (Copilot, older Claude Code), and always for budget and the spend report, tokenomics prices each request from `data/model-prices.json`: input, output, cache-write and cache-read prices for **every Claude model version**, from Haiku 3.5 to Fable 5.2.

For example, Fable 5.2 is $8/$40 per million input/output tokens, Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50 (or $0.50/$2.50 for prompts over 100K tokens). Each model's own cache rates are used (e.g. cache reads cost $0.20 on Fable 5.2 and $0.10 on Sonnet 5.5), fast mode counts double, and a model switch mid-session is priced message by message.

- **Kept fresh automatically.** A scheduled GitHub Action (`.github/workflows/update-prices.yml`) refreshes the file from Claude's pricing page every Monday and commits any change. Retired models that drop off the page keep their last known price.
- **Refresh it yourself** with `python3 scripts/update_prices.py`. The status bar's `--install` copies the current file next to the installed status bar.
- **Override a price** in `~/.tokenomics/statusbar.json`, by model version (input, output and optionally cache read, dollars per million tokens; the most specific key wins):

  ```json
  {"prices": {"opus-5-5": [4, 20], "sonnet-5-5": [2, 10, 0.1]}}
  ```

---

## Status bar file

`~/.tokenomics/statusbar.json` (or `$TOKENOMICS_HOME/statusbar.json`) holds the status bar's own options, all optional:

| Key | Example | What it does |
|---|---|---|
| `theme` | `"dark"` | Force `light` or `dark` (default follows your system). |
| `currency` | `"USD"` | Saved currency choice. |
| `usd_gbp`, `usd_eur` | `0.79` | Exchange rates. |
| `prices` | see above | Per-model price overrides. |
| `cache_ttl` | `3600` | Cache lifetime in seconds for the countdown. |

---

<p align="center"><a href="reference.md">← Helper reference</a> · <a href="README.md">All docs</a> · <a href="architecture.md">Architecture →</a></p>
