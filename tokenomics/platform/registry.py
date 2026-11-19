"""Capability registry: which adapters exist and what each can do.

Adapters are imported lazily and independently, so a broken or missing adapter only
affects its own platform. The engine then falls back to GenericAdapter for that source.
"""
from __future__ import annotations

import importlib
from typing import Dict, Optional

from .adapter import GenericAdapter, PlatformAdapter

ADAPTERS = {
    "claude-code": "tokenomics.adapters.claude_code:ClaudeCodeAdapter",
    "copilot": "tokenomics.adapters.copilot:CopilotAdapter",
}
ALIASES = {"claude": "claude-code", "claudecode": "claude-code", "github-copilot": "copilot",
           "copilot-cli": "copilot", "vscode-copilot": "copilot"}

_cache: Dict[str, PlatformAdapter] = {}
load_errors: Dict[str, str] = {}


def canonical(name: Optional[str]) -> str:
    n = (name or "claude-code").strip().lower()
    return ALIASES.get(n, n)


def get_adapter(name: Optional[str]) -> PlatformAdapter:
    key = canonical(name)
    if key in _cache:
        return _cache[key]
    target = ADAPTERS.get(key)
    adapter: PlatformAdapter
    if not target:
        adapter = GenericAdapter(key)
    else:
        mod, _, cls = target.partition(":")
        try:
            adapter = getattr(importlib.import_module(mod), cls)()
        except Exception as e:                       # isolate: never break the other platform
            load_errors[key] = f"{type(e).__name__}: {e}"
            adapter = GenericAdapter(key)
    _cache[key] = adapter
    return adapter


def report() -> Dict[str, dict]:
    out = {}
    for key in ADAPTERS:
        a = get_adapter(key)
        out[key] = {"adapter": type(a).__name__, "billing_model": a.billing_model,
                    "load_error": load_errors.get(key), "capabilities": a.capability_report()}
    return out
