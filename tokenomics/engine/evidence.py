"""The engine's platform-neutral session schema.

Every adapter produces these objects; the engine only ever reads these, never raw
platform payloads. Usage is None when the platform does not report it (never zero-filled).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

# Billing models. Kept distinct on purpose: Anthropic bills tokens, Copilot bills premium
# requests. The engine never converts one into the other or invents a money value.
# Defined here (not in tokenomics.platform) so the engine imports without the platform layer;
# tokenomics.platform.capabilities re-exports them.
BILLING_ANTHROPIC_TOKENS = "anthropic_tokens"
BILLING_COPILOT_PREMIUM_REQUESTS = "copilot_premium_requests"
BILLING_UNKNOWN = "unknown"

# Normalised tool kinds. Adapters map their platform's tool names onto these.
TOOL_CODE_EDIT = "code_edit"      # writes or edits files
TOOL_SHELL = "shell"              # runs a command (command text is scored, never stored)
TOOL_SKILL = "skill"              # invokes a skill
TOOL_OTHER = "other"              # anything else (MCP tools etc.; the name is still checked)


@dataclass
class ToolCall:
    name: str
    kind: str = TOOL_OTHER
    command: str = ""             # shell only
    skill: str = ""               # skill only


@dataclass
class SkillUse:
    name: str
    description: Optional[str] = None


@dataclass
class Prompt:
    text: str                     # used for keyword scoring
    llm_text: Optional[str] = ""  # what may be sent to the LLM classifier; None = never send
    is_command: bool = False      # slash-command invocation (counts as a prompt, not as prose)

    def __post_init__(self):
        if self.llm_text == "":
            self.llm_text = self.text


@dataclass
class TokenUsage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_tokens: int = 0
    cache_read_tokens: int = 0

    @property
    def total(self) -> int:
        return self.input_tokens + self.output_tokens + self.cache_creation_tokens + self.cache_read_tokens


@dataclass
class SessionEvidence:
    session_id: str
    platform: str
    cwd: Optional[str] = None
    event: str = "prompt"         # prompt | tool | turn_end | session_end
    complete: bool = False        # True = full replay of the session (scores replace stored ones)
    prompts: List[Prompt] = field(default_factory=list)
    tool_calls: List[ToolCall] = field(default_factory=list)
    skills: List[SkillUse] = field(default_factory=list)
    usage: Optional[TokenUsage] = None
    billing_model: str = BILLING_UNKNOWN
