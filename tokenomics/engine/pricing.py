"""Cost calculation for token-billed platforms (Anthropic). Platform-independent.

Overrides come from the same place as the statusline's: "prices" in ~/.tokenomics/statusline.json
(or $TOKENOMICS_HOME/statusline.json; statusbar.json, its name before v1.4, until it is renamed). Converting to the display currency: engine/currency.py.

Copilot bills premium requests, not tokens: nothing here is ever applied to Copilot sessions.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Iterable, Mapping, Optional, Tuple

from .evidence import TokenUsage

def _cfg() -> dict:
    home = Path(os.environ.get("TOKENOMICS_HOME", str(Path.home() / ".tokenomics")))
    path = home / "statusline.json"
    if not path.exists():
        path = home / "statusbar.json"                    # before v1.4
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


# Per-model prices come from data/model-prices.json (refreshed weekly from Claude's pricing page
# by .github/workflows/update-prices.yml). The lookup below mirrors scripts/statusline.py, which
# must stay a single file and so has its own copy; tests/test_features.py checks they agree.
MODEL_PRICES_FILE = Path(__file__).resolve().parent.parent.parent / "data" / "model-prices.json"
FAST_MULTIPLIER = 2.0             # usage.speed == "fast": fast mode bills 2x the standard rates
CACHE_WRITE_5M, CACHE_WRITE_1H, CACHE_READ = 1.25, 2.0, 0.1   # x input, when a model has no listed rate
# Rough fallbacks (input, output) for models not in the file.
PRICES = {"opus": (5.0, 25.0), "sonnet": (3.0, 15.0), "haiku": (1.0, 5.0),
          "gpt": (2.5, 10.0), "gemini": (1.25, 10.0)}
DEFAULT_PRICE = (3.0, 15.0)
_FAMILIES = "fable|mythos|opus|sonnet|haiku"
_FAMILY_FIRST = re.compile(rf"({_FAMILIES})[\s_-]*(\d+)(?:[.-](\d)(?!\d))?")
_VERSION_FIRST = re.compile(rf"(\d+)[.-](\d)(?!\d)[\s_-]*({_FAMILIES})")
_cache: Optional[dict] = None


def model_prices() -> dict:
    global _cache
    if _cache is None:
        try:
            _cache = json.loads(MODEL_PRICES_FILE.read_text(encoding="utf-8")).get("models") or {}
        except (OSError, ValueError, AttributeError):
            _cache = {}
    return _cache


def claude_model_id(model: Optional[str]) -> Optional[str]:
    """'Opus 5.5' / 'claude-opus-5-5[1m]' -> 'claude-opus-5-5'; 'claude-3-5-haiku-2024..' -> 'claude-3-5-haiku'."""
    m = (model or "").lower()
    hit = _VERSION_FIRST.search(m)
    if hit:
        return f"claude-{hit.group(1)}-{hit.group(2)}-{hit.group(3)}"
    hit = _FAMILY_FIRST.search(m)
    if not hit:
        return None
    family, major, minor = hit.group(1), int(hit.group(2)), hit.group(3)
    ver = f"{major}-{minor}" if minor and minor != "0" else f"{major}"
    return f"claude-{ver}-{family}" if major < 4 else f"claude-{family}-{ver}"


def _flat(pin: float, pout: float, pread: Optional[float] = None) -> dict:
    return {"input": pin, "output": pout, "cache_write_5m": pin * CACHE_WRITE_5M,
            "cache_write_1h": pin * CACHE_WRITE_1H, "cache_read": pin * CACHE_READ if pread is None else pread}


def rates_for(model: Optional[str], cfg: Optional[Mapping] = None) -> dict:
    """Per-million-token USD rates: input, output, cache_write_5m, cache_write_1h, cache_read
    (and long_context when the model has a long-prompt tier). Order: user overrides in
    statusline.json ("prices", most specific key wins), then the data file, then family fallbacks."""
    cfg = _cfg() if cfg is None else cfg
    m = re.sub(r"[\s._]+", "-", (model or "").lower())
    best = None
    for k, v in (cfg.get("prices") or {}).items():
        try:
            key = re.sub(r"[\s._]+", "-", str(k).lower())
            if key and re.search(r"(?<![a-z0-9])" + re.escape(key) + r"(?![0-9])", m) \
                    and (best is None or len(key) > len(best[0])):
                best = (key, float(v[0]), float(v[1]), float(v[2]) if len(v) > 2 else None)
        except (TypeError, ValueError, IndexError):
            pass
    if best:
        return _flat(best[1], best[2], best[3])
    entry = model_prices().get(claude_model_id(model) or "")
    if entry:
        try:
            pin = float(entry["input"])
            rates = {"input": pin, "output": float(entry["output"]),
                     "cache_write_5m": float(entry.get("cache_write_5m", pin * CACHE_WRITE_5M)),
                     "cache_write_1h": float(entry.get("cache_write_1h", pin * CACHE_WRITE_1H)),
                     "cache_read": float(entry.get("cache_read", pin * CACHE_READ))}
            if isinstance(entry.get("long_context"), dict):
                rates["long_context"] = entry["long_context"]
            return rates
        except (KeyError, TypeError, ValueError):
            pass
    pin, pout = DEFAULT_PRICE
    for key, val in PRICES.items():
        if key in m:
            pin, pout = val
            break
    return _flat(pin, pout)


def usage_cost_usd(u: TokenUsage, model: Optional[str], cfg: Optional[Mapping] = None) -> float:
    """Cost in USD of one request's usage (same rules as scripts/statusline.py usage_cost_usd)."""
    r = rates_for(model, cfg)
    w1h = min(u.cache_creation_1h_tokens, u.cache_creation_tokens)
    w5m = u.cache_creation_tokens - w1h
    lc = r.get("long_context")
    if lc and u.input_tokens + u.cache_creation_tokens + u.cache_read_tokens > int(lc.get("threshold") or 0):
        r = {**r, **{k: float(v) for k, v in lc.items() if k != "threshold"}}
    usd = (u.input_tokens * r["input"] + u.output_tokens * r["output"] + w5m * r["cache_write_5m"]
           + w1h * r["cache_write_1h"] + u.cache_read_tokens * r["cache_read"]) / 1e6
    return usd * FAST_MULTIPLIER if u.fast else usd


def session_cost_usd(records: Iterable[Tuple[str, TokenUsage]], cfg: Optional[Mapping] = None) -> float:
    """Sum over (model, usage) per request: rates depend on the model and on the request size."""
    cfg = _cfg() if cfg is None else cfg
    return sum(usage_cost_usd(u, m, cfg) for m, u in records)
