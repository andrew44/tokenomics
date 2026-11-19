"""Shared configuration. Read once per hook run from environment variables.

Everything here applies to every platform. Platform-specific settings live in the adapter
that needs them, so changing one platform's settings cannot affect the other.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict

DEFAULT_LLM_URL = "https://api.openai.com/v1/chat/completions"


def _float_env(name: str, default: float, cap: float) -> float:
    try:
        return min(float(os.environ.get(name, str(default))), cap)
    except ValueError:
        return default


def _load_skill_map(path: str) -> Dict[str, str]:
    try:
        if path and Path(path).is_file():
            with open(path, encoding="utf-8") as f:
                return {str(k).lower(): str(v).lower() for k, v in json.load(f).items()}
    except Exception:
        pass
    return {}


@dataclass
class Settings:
    db_path: str
    store_prompt: bool = False
    skill_map: Dict[str, str] = field(default_factory=dict)
    llm_enabled: bool = False
    llm_url: str = DEFAULT_LLM_URL
    llm_key: str = ""
    llm_model: str = "gpt-4o-mini"
    llm_timeout: float = 12.0

    @property
    def llm_usable(self) -> bool:
        if not self.llm_enabled:
            return False
        return bool(self.llm_key) or self.llm_url != DEFAULT_LLM_URL   # local endpoints need no key


def load_settings() -> Settings:
    e = os.environ
    return Settings(
        db_path=e.get("TOKENOMICS_DB", str(Path.home() / ".tokenomics" / "spendlens.db")),
        store_prompt=e.get("TOKENOMICS_STORE_PROMPT") == "1",
        skill_map=_load_skill_map(e.get("TOKENOMICS_SKILL_MAP", "")),
        llm_enabled=e.get("TOKENOMICS_LLM") == "1",
        llm_url=e.get("TOKENOMICS_LLM_URL", DEFAULT_LLM_URL),
        llm_key=e.get("TOKENOMICS_LLM_KEY") or e.get("OPENAI_API_KEY") or "",
        llm_model=e.get("TOKENOMICS_LLM_MODEL", "gpt-4o-mini"),
        llm_timeout=_float_env("TOKENOMICS_LLM_TIMEOUT", 12.0, 15.0),
    )
