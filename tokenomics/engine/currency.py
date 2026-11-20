"""Display currency (USD, EUR or GBP) for every money figure tokenomics shows.

The block below is identical to the one in scripts/statusline.py, which must stay a single
self-contained file; tests/test_features.py checks they agree. All costs are computed in USD
(tokenomics.engine.pricing) and converted only for display or for comparing with a limit.
"""
from __future__ import annotations

import os
from typing import Mapping, Optional, Tuple

from .pricing import _cfg


# BEGIN CURRENCY
# Display currency: USD, EUR or GBP (default). Chosen by TOKENOMICS_CURRENCY, then "currency" in
# statusline.json; "$", "€", "£", "usd", "euro", "pounds" ... are accepted too. Prices are in USD
# and converted at the rate in TOKENOMICS_USD_EUR / TOKENOMICS_USD_GBP, then "usd_eur" /
# "usd_gbp" in statusline.json, then the defaults below (`statusline.py --update-rate` saves
# today's rates).
CURRENCIES = {"USD": ("$", None, 1.0), "EUR": ("€", "usd_eur", 0.86), "GBP": ("£", "usd_gbp", 0.76)}
DEFAULT_CURRENCY = "GBP"
CURRENCY_ALIASES = {"$": "USD", "US$": "USD", "DOLLAR": "USD", "DOLLARS": "USD", "€": "EUR", "EURO": "EUR",
                    "EUROS": "EUR", "£": "GBP", "POUND": "GBP", "POUNDS": "GBP", "STERLING": "GBP"}


def currency_code(value):
    """'eur', '€', 'Euro' ... -> 'EUR'; None if not a supported currency."""
    v = str(value or "").strip().upper()
    v = CURRENCY_ALIASES.get(v, v)
    return v if v in CURRENCIES else None


def currency(cfg):
    """-> (code, symbol, units of that currency per US dollar)."""
    cfg = cfg or {}
    code = (currency_code(os.environ.get("TOKENOMICS_CURRENCY")) or currency_code(cfg.get("currency"))
            or DEFAULT_CURRENCY)
    symbol, key, rate = CURRENCIES[code]
    if key:
        for v in (os.environ.get("TOKENOMICS_" + key.upper()), cfg.get(key)):
            try:
                if v not in (None, "") and float(v) > 0:
                    rate = float(v)
                    break
            except (TypeError, ValueError):
                pass
    return code, symbol, rate


def format_money(amount, symbol, whole_above=None):
    """'£1,234.50'; with whole_above=100, amounts from 100 up drop the pence/cents."""
    amount = float(amount or 0)
    sign = "-" if amount < 0 else ""
    if whole_above is not None and abs(amount) >= whole_above:
        return f"{sign}{symbol}{abs(amount):,.0f}"
    return f"{sign}{symbol}{abs(amount):,.2f}"
# END CURRENCY


def current(cfg: Optional[Mapping] = None) -> Tuple[str, str, float]:
    """(code, symbol, rate per USD) from the environment and ~/.tokenomics/statusline.json."""
    return currency(_cfg() if cfg is None else cfg)
