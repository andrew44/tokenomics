"""The common platform interface every adapter implements.

Adapters translate. They turn a platform's hook payloads, transcripts and file layout into
the engine's platform-neutral evidence (tokenomics.engine.evidence) and declare what the
platform can do. They must not score, classify or price anything themselves.
"""
from __future__ import annotations

from typing import Dict, List, Optional

from ..engine.evidence import Prompt, SessionEvidence, SkillUse, ToolCall
from ..util import anon_session_id, first
from .capabilities import BILLING_UNKNOWN, NONE, Capability, Level, Support


class PlatformAdapter:
    name = "generic"
    billing_model = BILLING_UNKNOWN
    capabilities: Dict[Capability, Support] = {}

    # ---- capability queries (used by the engine) --------------------------------------
    def support(self, cap: Capability) -> Support:
        return self.capabilities.get(cap, Support(NONE, "not declared"))

    def supports(self, cap: Capability) -> bool:
        return self.support(cap).available

    def capability_report(self) -> Dict[str, Dict[str, str]]:
        return {c.value: {"level": self.support(c).level.value, "note": self.support(c).note}
                for c in Capability}

    # ---- translation (overridden per platform) ----------------------------------------
    def session_id(self, payload: dict) -> str:
        sid = first(payload, "session_id", "sessionId")
        if not sid and isinstance(payload.get("session"), dict):
            sid = payload["session"].get("id")
        return str(sid) if sid else anon_session_id(payload.get("cwd"))

    def event(self, payload: dict, mode: str) -> str:
        """Normalised event: 'prompt', 'tool', 'turn_end' or 'session_end'."""
        return {"prompt": "prompt", "tool": "tool"}.get(mode, "session_end")

    def base_evidence(self, payload: dict, mode: str) -> SessionEvidence:
        return SessionEvidence(session_id=self.session_id(payload), platform=self.name,
                               cwd=payload.get("cwd"), event=self.event(payload, mode),
                               billing_model=self.billing_model)

    def prompt_evidence(self, payload: dict) -> SessionEvidence:
        ev = self.base_evidence(payload, "prompt")
        text = first(payload, "prompt", "userPrompt", default="")
        if text:
            ev.prompts.append(Prompt(str(text)))
        return ev

    def tool_call(self, payload: dict) -> Optional[ToolCall]:
        """One tool-call event -> a normalised ToolCall (None if not applicable)."""
        return None

    def session_evidence(self, payload: dict) -> Optional[SessionEvidence]:
        """Full replay of the session (from a transcript), or None when the platform has none."""
        return None

    def skill_description(self, name: str, cwd: Optional[str]) -> Optional[str]:
        return None

    # ---- hook output (each platform has its own JSON shape; None = cannot express it) -----
    def deny_tool(self, reason: str) -> Optional[dict]:
        """Pre-tool hook output that refuses the call and tells the model why."""
        return None

    def block_prompt(self, reason: str) -> Optional[dict]:
        """Prompt hook output that stops the prompt and shows the user why."""
        return None

    def notify(self, message: str) -> Optional[dict]:
        """Hook output that shows the user a notice without blocking anything."""
        return None

    def skill_roots(self, cwd: Optional[str]) -> List:
        return []


class GenericAdapter(PlatformAdapter):
    """Used for an unknown source, or when a platform adapter fails to load.

    Declares nothing, so the engine records prompts by session id and nothing else.
    """

    def __init__(self, name: str = "generic"):
        self.name = name
        self.capabilities = {Capability.HOOKS: Support(Level.PARTIAL, "unknown platform")}
