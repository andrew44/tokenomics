"""Shared utilities used by the engine and by both adapters."""
from __future__ import annotations

import hashlib
import json
import re
import time
from pathlib import Path
from typing import Any, Iterator, Optional


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def today() -> str:
    """Local calendar day, YYYY-MM-DD (budgets reset at local midnight)."""
    return time.strftime("%Y-%m-%d")


def log_err(db_path: str, msg: str) -> None:
    """Errors go to <db>.err, never to the screen: hooks must stay silent."""
    try:
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        with open(db_path + ".err", "a") as f:
            f.write(f"{now()} {msg}\n")
    except Exception:
        pass


def first(d: dict, *keys: str, default: Any = None) -> Any:
    """First present, non-empty value among several key spellings (camelCase / snake_case)."""
    for k in keys:
        v = d.get(k)
        if v not in (None, ""):
            return v
    return default


def anon_session_id(cwd: Optional[str]) -> str:
    """Fallback when a platform sends no session id: stable per folder per day."""
    return "anon-" + hashlib.sha1(f"{cwd or ''}{time.strftime('%Y%m%d')}".encode()).hexdigest()[:16]


def as_dict(value: Any) -> dict:
    """Tool arguments arrive as a dict or as a JSON string depending on the platform."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip().startswith("{"):
        try:
            v = json.loads(value)
            return v if isinstance(v, dict) else {}
        except ValueError:
            return {}
    return {}


def walk_strings(obj: Any, depth: int = 0) -> Iterator[str]:
    if depth > 6:
        return
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from walk_strings(v, depth + 1)
    elif isinstance(obj, list):
        for v in obj:
            yield from walk_strings(v, depth + 1)


def frontmatter_description(path: Path) -> Optional[str]:
    """`description:` from a SKILL.md / command .md YAML front matter (folded blocks supported)."""
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")[:6000]
    except OSError:
        return None
    m = re.match(r"^---\s*\n(.*?)\n---", text, re.S)
    if not m:
        return None
    lines = m.group(1).split("\n")
    for i, ln in enumerate(lines):
        mm = re.match(r"^description:\s*(.*)$", ln)
        if not mm:
            continue
        val = mm.group(1).strip()
        if val in (">", "|", ">-", "|-", ">+", "|+", ""):
            block = []
            for nxt in lines[i + 1:]:
                if nxt.startswith((" ", "\t")):
                    block.append(nxt.strip())
                else:
                    break
            val = " ".join(block)
        return val.strip("\"'") or None
    return None
