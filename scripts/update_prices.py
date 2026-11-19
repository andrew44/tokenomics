#!/usr/bin/env python3
"""tokenomics / update_prices: refresh data/model-prices.json from Claude's official pricing page.

Reads the "Model pricing" table on https://platform.claude.com/docs/en/about-claude/pricing (the
docs serve Markdown when the URL ends in .md), turns each row into a price entry keyed by API
model id, and merges it into data/model-prices.json:

  * models on the page get their latest prices (USD per million tokens);
  * models no longer on the page (retired, e.g. Claude Haiku 3.5) keep their last known prices
    and are marked "listed": false, so old transcripts can still be priced;
  * only models from Claude Haiku 3.5 onwards are kept (see MIN_VERSION).

Stdlib only. Run by .github/workflows/update-prices.yml on a schedule.

Usage
  update_prices.py                 fetch and update the JSON in place
  update_prices.py --check         exit 1 if the JSON is out of date (writes nothing)
  update_prices.py --source FILE   parse a saved copy of the page instead of fetching
"""
import argparse
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing.md"
ROOT = Path(__file__).resolve().parent.parent
PRICES_FILE = ROOT / "data" / "model-prices.json"

# Oldest model version tracked: Claude Haiku 3.5. Everything from 3.5 up to the newest is kept.
MIN_VERSION = (3, 5)

COLUMNS = {  # header text on the page -> key in the JSON
    "base input tokens": "input",
    "5m cache writes": "cache_write_5m",
    "1h cache writes": "cache_write_1h",
    "cache hits and refreshes": "cache_read",
    "output tokens": "output",
}
FAMILIES = ("fable", "mythos", "opus", "sonnet", "haiku")

# Retired models that have dropped off the pricing page: last published prices, so transcripts
# that used them can still be priced. Entries already in the JSON win over these.
LEGACY = {
    "claude-3-7-sonnet": {"name": "Claude Sonnet 3.7", "family": "sonnet", "version": "3.7", "input": 3.0,
                          "cache_write_5m": 3.75, "cache_write_1h": 6.0, "cache_read": 0.3, "output": 15.0},
    "claude-3-5-sonnet": {"name": "Claude Sonnet 3.5", "family": "sonnet", "version": "3.5", "input": 3.0,
                          "cache_write_5m": 3.75, "cache_write_1h": 6.0, "cache_read": 0.3, "output": 15.0},
    "claude-3-5-haiku": {"name": "Claude Haiku 3.5", "family": "haiku", "version": "3.5", "input": 0.8,
                         "cache_write_5m": 1.0, "cache_write_1h": 1.6, "cache_read": 0.08, "output": 4.0},
}

ROW_NAME = re.compile(r"^Claude\s+(Fable|Mythos|Opus|Sonnet|Haiku)\s+(\d+)(?:\.(\d+))?\b(.*)$", re.I)
PRICE = re.compile(r"\$\s*([0-9]+(?:\.[0-9]+)?)\s*/\s*MTok", re.I)
OVER = re.compile(r"over\s+([0-9][0-9,]*)\s+tokens", re.I)


def model_id(family, major, minor):
    """API id for a model, e.g. ('opus', 4, 8) -> claude-opus-4-8, ('haiku', 3, 5) -> claude-3-5-haiku."""
    ver = f"{major}-{minor}" if minor else f"{major}"
    if major < 4:  # Claude 3.x ids put the version before the family
        return f"claude-{ver}-{family}"
    return f"claude-{family}-{ver}"


def strip_md(cell):
    cell = re.sub(r"<sup>.*?</sup>", "", cell)
    cell = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", cell)  # [text](link) -> text
    return cell.strip()


def table_rows(markdown):
    """Yield (header, rows) for every Markdown table in the page."""
    lines = markdown.splitlines()
    i = 0
    while i < len(lines):
        if lines[i].lstrip().startswith("|") and i + 1 < len(lines) and re.match(r"^\s*\|[\s:|-]+\|\s*$", lines[i + 1]):
            header = [strip_md(c).lower() for c in lines[i].strip().strip("|").split("|")]
            rows = []
            i += 2
            while i < len(lines) and lines[i].lstrip().startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            yield header, rows
        else:
            i += 1


def parse_pricing(markdown):
    """Return {model_id: entry} from the page's model pricing table."""
    for header, rows in table_rows(markdown):
        if not header or header[0] != "model" or not all(c in header for c in COLUMNS):
            continue
        idx = {COLUMNS[c]: header.index(c) for c in COLUMNS}
        models = {}
        for row in rows:
            m = ROW_NAME.match(strip_md(row[0]))
            if not m:
                continue
            family, major, minor, rest = m.group(1).lower(), int(m.group(2)), int(m.group(3) or 0), m.group(4)
            if (major, minor) < MIN_VERSION:
                continue
            prices = {}
            for key, col in idx.items():
                p = PRICE.search(row[col]) if col < len(row) else None
                if not p:
                    break
                prices[key] = float(p.group(1))
            if len(prices) != len(COLUMNS):
                continue
            mid = model_id(family, major, minor)
            over = OVER.search(rest)
            if over:  # long-prompt tier (e.g. Haiku 5.5 over 100,000 tokens)
                entry = models.setdefault(mid, {})
                entry["long_context"] = {"threshold": int(over.group(1).replace(",", "")), **prices}
                continue
            entry = models.setdefault(mid, {})
            entry.update({
                "name": f"Claude {family.capitalize()} {major}{'.' + str(minor) if minor else ''}",
                "family": family,
                "version": f"{major}.{minor}" if minor else str(major),
                **prices,
            })
            if "retired" in rest.lower():  # still sold on some clouds, retired on the API
                entry["retired"] = True
        if models:
            return models
    return {}


def version_key(entry):
    major, _, minor = entry.get("version", "0").partition(".")
    return (int(major), int(minor or 0), FAMILIES.index(entry.get("family", "haiku")) * -1)


def merge(current, fresh):
    """Merge freshly parsed prices into the existing file contents; keep unlisted models."""
    old = {mid: {**e, "retired": True} for mid, e in LEGACY.items()}
    old.update((current or {}).get("models", {}))
    merged = {}
    for mid, entry in old.items():
        if mid not in fresh:
            kept = dict(entry)
            kept["listed"] = False
            merged[mid] = kept
    for mid, entry in fresh.items():
        merged[mid] = {**entry, "listed": True}
    ordered = dict(sorted(merged.items(), key=lambda kv: version_key(kv[1]), reverse=True))
    return {
        "source": PRICING_URL[:-len(".md")] if PRICING_URL.endswith(".md") else PRICING_URL,
        "currency": "USD",
        "unit": "per million tokens",
        "updated": (current or {}).get("updated"),
        "models": ordered,
    }


def fetch(url=PRICING_URL):
    req = urllib.request.Request(url, headers={"User-Agent": "tokenomics-price-updater"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--source", help="parse this saved page instead of fetching")
    ap.add_argument("--check", action="store_true", help="exit 1 if the JSON is out of date")
    ap.add_argument("--out", default=str(PRICES_FILE))
    args = ap.parse_args(argv)

    page = Path(args.source).read_text(encoding="utf-8") if args.source else fetch()
    fresh = parse_pricing(page)
    if len(fresh) < 5:  # the page layout changed: refuse to wipe good data
        print(f"error: parsed only {len(fresh)} models from the pricing page", file=sys.stderr)
        return 2

    out = Path(args.out)
    try:
        current = json.loads(out.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        current = None
    data = merge(current, fresh)
    if current is not None and {**data, "updated": None} == {**current, "updated": None}:
        print(f"prices unchanged ({len(fresh)} models listed)")
        return 0
    if args.check:
        print("prices are out of date")
        return 1
    data["updated"] = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print(f"updated {out} ({len(fresh)} models listed, {len(data['models'])} total)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
