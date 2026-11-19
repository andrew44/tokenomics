"""Cost calculation for token-billed platforms (Anthropic). Platform-independent.

The price table block below is identical to the one in scripts/statusbar.py, which must stay a
single self-contained file and so keeps its own copy; tests/test_features.py checks they agree.
Overrides come from the same place as the status bar's: "prices" and "usd_gbp" in
~/.tokenomics/statusbar.json (or $TOKENOMICS_HOME/statusbar.json), then TOKENOMICS_USD_GBP.

Copilot bills premium requests, not tokens: nothing here is ever applied to Copilot sessions.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Iterable, Mapping, Optional, Tuple

from .evidence import TokenUsage

DEFAULT_USD_GBP = 0.76


def _cfg() -> dict:
    home = Path(os.environ.get("TOKENOMICS_HOME", str(Path.home() / ".tokenomics")))
    try:
        data = json.loads((home / "statusbar.json").read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


# BEGIN PRICE TABLE (identical to scripts/statusbar.py)
# Anthropic list prices, USD per million tokens: (input, output, cache read). Cache writes cost
# 1.25x input (5-minute) or 2x input (1-hour). Keys are model ids without "claude-", with dots
# and spaces turned into dashes, so ids, dated ids, Bedrock/Vertex ids and display names all
# match ("claude-opus-4-1-20250805", "us.anthropic.claude-sonnet-4-5-v1:0", "Opus 4.5"). The
# longest matching key wins; the bare family names are fallbacks for versions not listed and
# point at the current model. Source: Anthropic pricing as of 2026-11. Override any entry with
# {"prices": {"opus-5-5": [4, 20]}} in statusbar.json (a third value sets the cache-read price).
PRICES = {
    "fable-5-2": (8.0, 40.0, 0.20), "mythos-5-2": (8.0, 40.0, 0.20),
    "fable-5-1": (10.0, 50.0, 0.25), "mythos-5-1": (10.0, 50.0, 0.25),
    "fable-5": (10.0, 50.0, 1.00), "mythos-5": (10.0, 50.0, 1.00),
    "fable": (8.0, 40.0, 0.20), "mythos": (8.0, 40.0, 0.20),
    "opus-5-5": (4.0, 20.0, 0.20), "opus-5": (5.0, 25.0, 0.50),
    "opus-4-8": (5.0, 25.0, 0.50), "opus-4-7": (5.0, 25.0, 0.50), "opus-4-6": (5.0, 25.0, 0.50),
    "opus-4-5": (5.0, 25.0, 0.50), "opus-4-1": (15.0, 75.0, 1.50), "opus-4": (15.0, 75.0, 1.50),
    "3-opus": (15.0, 75.0, 1.50), "opus": (4.0, 20.0, 0.20),
    "sonnet-5-5": (2.0, 10.0, 0.10), "sonnet-5": (2.0, 10.0, 0.20),
    "sonnet-4-6": (3.0, 15.0, 0.30), "sonnet-4-5": (3.0, 15.0, 0.30), "sonnet-4": (3.0, 15.0, 0.30),
    "3-7-sonnet": (3.0, 15.0, 0.30), "3-5-sonnet": (3.0, 15.0, 0.30), "3-sonnet": (3.0, 15.0, 0.30),
    "sonnet": (2.0, 10.0, 0.10),
    "haiku-5-5": (0.10, 0.50, 0.01), "haiku-4-5": (1.0, 5.0, 0.10), "3-5-haiku": (0.80, 4.0, 0.08),
    "3-haiku": (0.25, 1.25, 0.03), "haiku": (0.10, 0.50, 0.01),
    "gpt": (2.5, 10.0, 0.25), "gemini": (1.25, 10.0, 0.125),     # rough, for Copilot's non-Claude models
}
DEFAULT_PRICE = (3.0, 15.0, 0.30)
# Above this many prompt tokens (input + cache) in one request, these rates apply instead.
LONG_PROMPT = {"haiku-5-5": (100_000, (0.50, 2.50, 0.05))}
FAST_MULTIPLIER = 2.0             # usage.speed == "fast": fast mode bills 2x the standard rates
CACHE_WRITE_5M, CACHE_WRITE_1H = 1.25, 2.0


def model_key(model):
    m = (model or "").lower().replace("[1m]", "")
    return re.sub(r"[\s._]+", "-", m)


def _match(table, model):
    m = model_key(model)
    hits = [k for k in table if k and re.search(r"(?<![a-z0-9])" + re.escape(k) + r"(?![0-9])", m)]
    return max(hits, key=len) if hits else None


def _overrides(cfg):
    out = {}
    for k, v in ((cfg or {}).get("prices") or {}).items():
        try:
            pin, pout = float(v[0]), float(v[1])
            out[model_key(k)] = (pin, pout, float(v[2]) if len(v) > 2 else pin * 0.1)
        except (TypeError, ValueError, IndexError):
            pass
    return out


def price_table(cfg):
    return {**PRICES, **_overrides(cfg)}


def price_for(model, cfg, prompt_tokens=0):
    """(input, output, cache read) USD per million tokens for this model and request size."""
    overrides = _overrides(cfg)
    table = {**PRICES, **overrides}
    key = _match(table, model)
    if key is None:
        return DEFAULT_PRICE
    long = LONG_PROMPT.get(key)
    if long and key not in overrides and prompt_tokens > long[0]:
        return long[1]
    return table[key]
# END PRICE TABLE


def usage_cost_usd(u: TokenUsage, model: Optional[str], cfg: Optional[Mapping] = None) -> float:
    """Cost in USD of one request's usage (see scripts/statusbar.py usage_cost_usd)."""
    cfg = _cfg() if cfg is None else cfg
    w1h = min(u.cache_creation_1h_tokens, u.cache_creation_tokens)
    w5m = u.cache_creation_tokens - w1h
    pin, pout, pcr = price_for(model, cfg, u.input_tokens + u.cache_creation_tokens + u.cache_read_tokens)
    usd = (u.input_tokens * pin + u.output_tokens * pout + w5m * pin * CACHE_WRITE_5M
           + w1h * pin * CACHE_WRITE_1H + u.cache_read_tokens * pcr) / 1e6
    return usd * FAST_MULTIPLIER if u.fast else usd


def session_cost_usd(records: Iterable[Tuple[str, TokenUsage]], cfg: Optional[Mapping] = None) -> float:
    """Sum over (model, usage) per request: rates depend on the model and on the request size."""
    cfg = _cfg() if cfg is None else cfg
    return sum(usage_cost_usd(u, m, cfg) for m, u in records)


def usd_gbp(cfg: Optional[Mapping] = None) -> float:
    cfg = _cfg() if cfg is None else cfg
    for v in (os.environ.get("TOKENOMICS_USD_GBP"), cfg.get("usd_gbp")):
        try:
            if v not in (None, ""):
                return float(v)
        except (TypeError, ValueError):
            pass
    return DEFAULT_USD_GBP
