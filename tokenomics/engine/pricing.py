"""Cost calculation for token-billed platforms (Anthropic). Platform-independent.

The price table and cache multipliers match scripts/statusbar.py (which must stay a single
self-contained file, so it keeps its own copy; tests/test_features.py checks they agree).
Overrides come from the same place as the status bar's: "prices" and "usd_gbp" in
~/.tokenomics/statusbar.json (or $TOKENOMICS_HOME/statusbar.json), then TOKENOMICS_USD_GBP.

Copilot bills premium requests, not tokens: nothing here is ever applied to Copilot sessions.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Dict, Mapping, Optional, Tuple

from .evidence import TokenUsage

# USD per million tokens: (input, output)
PRICES: Dict[str, Tuple[float, float]] = {
    "opus": (5.0, 25.0), "sonnet": (3.0, 15.0), "haiku": (1.0, 5.0),
    "gpt": (2.5, 10.0), "gemini": (1.25, 10.0),
}
DEFAULT_PRICE = (3.0, 15.0)
DEFAULT_USD_GBP = 0.76
CACHE_WRITE_5M = 1.25          # x input price
CACHE_WRITE_1H = 2.0
CACHE_READ = 0.1


def _cfg() -> dict:
    home = Path(os.environ.get("TOKENOMICS_HOME", str(Path.home() / ".tokenomics")))
    try:
        data = json.loads((home / "statusbar.json").read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def price_table(cfg: Optional[Mapping] = None) -> Dict[str, Tuple[float, float]]:
    cfg = _cfg() if cfg is None else cfg
    table = dict(PRICES)
    for k, v in (cfg.get("prices") or {}).items():
        try:
            table[str(k).lower()] = (float(v[0]), float(v[1]))
        except (TypeError, ValueError, IndexError):
            pass
    return table


def price_for(model: Optional[str], table: Optional[Mapping] = None) -> Tuple[float, float]:
    """Most specific matching key wins ("claude-opus-4-1" beats "opus")."""
    table = price_table() if table is None else table
    m = (model or "").lower()
    hits = [k for k in table if k and k in m]
    return table[max(hits, key=len)] if hits else DEFAULT_PRICE


def usage_cost_usd(u: TokenUsage, model: Optional[str], table: Optional[Mapping] = None) -> float:
    pin, pout = price_for(model, table)
    w1h = min(u.cache_creation_1h_tokens, u.cache_creation_tokens)
    w5m = u.cache_creation_tokens - w1h
    return (u.input_tokens * pin + u.output_tokens * pout + w5m * pin * CACHE_WRITE_5M
            + w1h * pin * CACHE_WRITE_1H + u.cache_read_tokens * pin * CACHE_READ) / 1e6


def session_cost_usd(by_model: Mapping[str, TokenUsage], table: Optional[Mapping] = None) -> float:
    table = price_table() if table is None else table
    return sum(usage_cost_usd(u, m, table) for m, u in by_model.items())


def usd_gbp(cfg: Optional[Mapping] = None) -> float:
    cfg = _cfg() if cfg is None else cfg
    for v in (os.environ.get("TOKENOMICS_USD_GBP"), cfg.get("usd_gbp")):
        try:
            if v not in (None, ""):
                return float(v)
        except (TypeError, ValueError):
            pass
    return DEFAULT_USD_GBP
