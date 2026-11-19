"""GitHub Copilot adapter (Copilot CLI / cloud agent hooks; VS Code-compatible payloads too).

Translation only. Scoring, labelling and storage live in tokenomics.engine.

What Copilot gives hooks (docs.github.com, CLI hooks reference):
  userPromptSubmitted  sessionId, timestamp, cwd, prompt
  postToolUse          sessionId, timestamp, cwd, toolName, toolArgs, toolResult
  sessionEnd           sessionId, timestamp, cwd, reason
  (PascalCase event names deliver snake_case: session_id, tool_name, tool_input ...)
No hook payload carries token usage, model or premium-request counts, and the transcript
format is undocumented, so the engine classifies Copilot sessions from prompt and tool
events and records usage as unavailable. Copilot bills premium requests, not tokens:
no money or token figure is invented for it.
"""
from __future__ import annotations

from pathlib import Path
from typing import List, Optional

from ..engine.evidence import TOOL_CODE_EDIT, TOOL_OTHER, TOOL_SHELL, TOOL_SKILL, ToolCall
from ..platform.adapter import PlatformAdapter
from ..platform.capabilities import (BILLING_COPILOT_PREMIUM_REQUESTS, NATIVE, NONE, PARTIAL,
                                     Capability, Support)
from ..util import as_dict, first, frontmatter_description

EDIT_TOOLS = {"edit", "create", "write", "str_replace", "apply_patch", "multi_edit",
              "edit_file", "create_file", "replace_string_in_file", "insert_edit_into_file",
              "multi_replace_string_in_file", "editfiles", "createfile"}
SHELL_TOOLS = {"bash", "shell", "powershell", "run_in_terminal", "runinterminal", "terminal"}
SKILL_TOOLS = {"skill", "use_skill"}


class CopilotAdapter(PlatformAdapter):
    name = "copilot"
    billing_model = BILLING_COPILOT_PREMIUM_REQUESTS
    capabilities = {
        Capability.HOOKS: Support(NATIVE, "userPromptSubmitted, preToolUse, postToolUse, sessionStart, sessionEnd"),
        Capability.SESSION_INFO: Support(NATIVE, "sessionId / session_id in every hook payload"),
        Capability.TOOL_EVENTS: Support(NATIVE, "postToolUse: toolName + toolArgs"),
        Capability.SKILL_TRACKING: Support(PARTIAL, "only if skill use surfaces as a tool call"),
        Capability.TRANSCRIPT: Support(NONE, "sessionEnd has no transcript; format undocumented"),
        Capability.TOKEN_USAGE: Support(NONE, "not exposed to hooks"),
        Capability.CACHE_INFO: Support(NONE, "not exposed to hooks"),
        Capability.BILLING_INFO: Support(NONE, "premium requests; not exposed to hooks"),
        Capability.MODEL_SELECTION: Support(NONE, "no model field in hook payloads"),
        Capability.CONTEXT_INFO: Support(NONE, ""),
        Capability.CONTEXT_INJECTION: Support(NONE, "userPromptSubmitted output is ignored"),
        Capability.TOOL_OUTPUT_INTERCEPTION: Support(PARTIAL, "postToolUse sees results, cannot rewrite them"),
        Capability.AVAILABLE_MODELS: Support(NONE, ""),
    }

    def tool_call(self, payload: dict) -> Optional[ToolCall]:
        name = str(first(payload, "toolName", "tool_name", default="") or "")
        if not name:
            return None
        args = as_dict(first(payload, "toolArgs", "tool_input", "toolInput", default={}))
        key = name.strip().lower().split(".")[-1].split("/")[-1]
        if key in SKILL_TOOLS:
            return ToolCall(name, TOOL_SKILL, skill=str(args.get("skill") or args.get("name") or ""))
        if key == "str_replace_editor":
            sub = str(args.get("command") or "").lower()
            return ToolCall(name, TOOL_OTHER if sub == "view" else TOOL_CODE_EDIT)
        if key in EDIT_TOOLS:
            return ToolCall(name, TOOL_CODE_EDIT)
        if key in SHELL_TOOLS:
            return ToolCall(name, TOOL_SHELL, command=str(args.get("command") or args.get("cmd") or ""))
        return ToolCall(name, TOOL_OTHER)

    def skill_roots(self, cwd: Optional[str]) -> List[Path]:
        roots = [Path(cwd) / ".github", Path(cwd) / ".claude"] if cwd else []
        return roots + [Path.home() / ".copilot"]

    def skill_description(self, name: str, cwd: Optional[str]) -> Optional[str]:
        leaf = name.strip().lstrip("/").split(":")[-1]
        for r in self.skill_roots(cwd):
            for p in (r / "skills" / leaf / "SKILL.md", r / "prompts" / f"{leaf}.prompt.md"):
                if p.is_file():
                    d = frontmatter_description(p)
                    if d:
                        return d
        return None
