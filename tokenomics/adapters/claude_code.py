"""Claude Code adapter: hook payloads + JSONL transcript -> engine evidence.

Translation only. Scoring, labelling and storage live in tokenomics.engine.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Dict, List, Optional

from ..engine.evidence import (TOOL_CODE_EDIT, TOOL_OTHER, TOOL_READ, TOOL_SHELL, TOOL_SKILL, Prompt,
                               SessionEvidence, SkillUse, TokenUsage, ToolCall)
from ..platform.adapter import PlatformAdapter
from ..platform.capabilities import (BILLING_ANTHROPIC_TOKENS, NATIVE, NONE, PARTIAL, Capability,
                                     Support)
from ..util import first, frontmatter_description, walk_strings

EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
CMD_RE = re.compile(r"<command-name>\s*/?([^<\s]+)\s*</command-name>")
LISTING_RE = re.compile(r"^- ([A-Za-z0-9_.:\-]+): (.{12,})$", re.M)


def _user_text(msg: dict) -> str:
    content = (msg or {}).get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
    return ""


def _token_usage(u: dict) -> TokenUsage:
    cc = u.get("cache_creation") if isinstance(u.get("cache_creation"), dict) else {}
    return TokenUsage(
        input_tokens=int(u.get("input_tokens") or 0),
        output_tokens=int(u.get("output_tokens") or 0),
        cache_creation_tokens=int(u.get("cache_creation_input_tokens") or 0),
        cache_read_tokens=int(u.get("cache_read_input_tokens") or 0),
        cache_creation_1h_tokens=int(cc.get("ephemeral_1h_input_tokens") or 0),
        fast=u.get("speed") == "fast",
    )


class ClaudeCodeAdapter(PlatformAdapter):
    name = "claude-code"
    billing_model = BILLING_ANTHROPIC_TOKENS
    capabilities = {
        Capability.HOOKS: Support(NATIVE, "UserPromptSubmit, Stop, SessionStart, SessionEnd, Pre/PostToolUse"),
        Capability.SESSION_INFO: Support(NATIVE, "session_id in every hook payload"),
        Capability.TRANSCRIPT: Support(NATIVE, "transcript_path JSONL"),
        Capability.TOKEN_USAGE: Support(NATIVE, "usage on assistant messages in the transcript"),
        Capability.CACHE_INFO: Support(NATIVE, "cache_creation/cache_read_input_tokens"),
        Capability.SKILL_TRACKING: Support(NATIVE, "Skill tool calls and slash commands"),
        Capability.MODEL_SELECTION: Support(PARTIAL, "model visible in transcript and statusline payload"),
        Capability.CONTEXT_INFO: Support(PARTIAL, "derivable from transcript usage"),
        Capability.CONTEXT_INJECTION: Support(NATIVE, "UserPromptSubmit / SessionStart stdout"),
        Capability.TOOL_OUTPUT_INTERCEPTION: Support(NATIVE, "PostToolUse"),
        Capability.TOOL_EVENTS: Support(NATIVE, "not needed: the transcript has every tool call"),
        Capability.BILLING_INFO: Support(PARTIAL, "tokens only; prices come from a price table"),
        Capability.AVAILABLE_MODELS: Support(NONE, ""),
    }

    def event(self, payload: dict, mode: str) -> str:
        if mode in ("prompt", "tool"):
            return mode
        name = first(payload, "hook_event_name", "hookEventName", default="")
        return "turn_end" if name == "Stop" else "session_end"

    # ---- transcript replay -------------------------------------------------------------
    def session_evidence(self, payload: dict) -> Optional[SessionEvidence]:
        path = first(payload, "transcript_path", "transcriptPath")
        if not (path and Path(path).is_file()):
            return None
        ev = self.base_evidence(payload, "finalize")
        ev.complete = True
        listed: Dict[str, str] = {}
        skill_names: List[str] = []
        usage: Dict[object, tuple] = {}           # message id -> (model, last usage); streamed entries repeat ids
        parsed = False
        llm_count = 0
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(rec, dict):
                    continue
                parsed = True
                if "skill" in line.lower():       # skill listings: "- name: description" lines
                    for s in walk_strings(rec):
                        for m in LISTING_RE.finditer(s):
                            listed.setdefault(m.group(1).lower(), m.group(2).strip())
                kind, msg = rec.get("type"), rec.get("message") or {}
                if kind == "user" and not rec.get("isMeta"):
                    txt = _user_text(msg)
                    if txt:
                        m = CMD_RE.search(txt)    # slash-command skill, e.g. /grafana-triage
                        if m and m.group(1) not in skill_names:
                            skill_names.append(m.group(1))
                        llm_text = None
                        if llm_count < 5 and not txt.lstrip().startswith("<"):
                            llm_text = txt
                        elif llm_count < 5 and m:
                            llm_text = f"/{m.group(1)}"
                        if llm_text:
                            llm_count += 1
                        ev.prompts.append(Prompt(txt, llm_text, bool(m)))
                elif kind == "assistant":
                    u = msg.get("usage")
                    model = msg.get("model")
                    if model and not str(model).startswith("<"):
                        ev.model = str(model)
                    if isinstance(u, dict):
                        key = msg.get("id") or rec.get("uuid") or len(usage)
                        usage[key] = (str(model or ev.model or ""), u)
                if kind == "assistant" and isinstance(msg.get("content"), list):
                    for part in msg["content"]:
                        if isinstance(part, dict) and part.get("type") == "tool_use":
                            call = self._tool(part.get("name", ""), part.get("input") or {})
                            ev.tool_calls.append(call)
                            if call.kind == TOOL_SKILL and call.skill and call.skill not in skill_names:
                                skill_names.append(call.skill)
        if not parsed:
            return None
        for sk in skill_names:
            leaf = sk.lstrip("/").split(":")[-1].lower()
            desc = (self.skill_description(sk, ev.cwd)
                    or listed.get(sk.lstrip("/").lower()) or listed.get(leaf))
            ev.skills.append(SkillUse(sk, desc))
        ev.usage = TokenUsage()
        for model, u in usage.values():
            tu = _token_usage(u)
            ev.usage.add(tu)
            ev.usage_records.append((model, tu))
        return ev

    def _tool(self, name: str, inp: dict) -> ToolCall:
        if name == "Skill":
            return ToolCall(name, TOOL_SKILL, skill=str(inp.get("skill") or inp.get("name") or ""))
        if name in EDIT_TOOLS:
            return ToolCall(name, TOOL_CODE_EDIT)
        if name == "Bash":
            return ToolCall(name, TOOL_SHELL, command=str(inp.get("command", "")))
        if name == "Read":
            return ToolCall(name, TOOL_READ, path=str(inp.get("file_path") or ""),
                            ranged=inp.get("offset") is not None or inp.get("limit") is not None)
        return ToolCall(name, TOOL_OTHER)

    def tool_call(self, payload: dict) -> Optional[ToolCall]:
        name = first(payload, "tool_name", default="")
        return self._tool(name, payload.get("tool_input") or {}) if name else None

    # ---- hook output ---------------------------------------------------------------------
    def deny_tool(self, reason: str) -> Optional[dict]:
        return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                       "permissionDecisionReason": reason}}

    def block_prompt(self, reason: str) -> Optional[dict]:
        return {"decision": "block", "reason": reason}

    def notify(self, message: str) -> Optional[dict]:
        return {"systemMessage": message}

    # ---- skills on disk ----------------------------------------------------------------
    def skill_roots(self, cwd: Optional[str]) -> List[Path]:
        roots = [Path(cwd) / ".claude"] if cwd else []
        return roots + [Path.home() / ".claude"]

    def skill_description(self, name: str, cwd: Optional[str]) -> Optional[str]:
        n = name.strip().lstrip("/")
        plugin, _, leaf = n.rpartition(":")
        for r in self.skill_roots(cwd):
            for p in (r / "skills" / leaf / "SKILL.md", r / "commands" / f"{leaf}.md"):
                if p.is_file():
                    d = frontmatter_description(p)
                    if d:
                        return d
        base = Path.home() / ".claude" / "plugins"
        if base.is_dir():
            hits = list(base.rglob(f"skills/{leaf}/SKILL.md"))[:20] + list(base.rglob(f"commands/{leaf}.md"))[:20]
            hits.sort(key=lambda p: plugin not in str(p) if plugin else 0)   # prefer matching plugin
            for p in hits:
                d = frontmatter_description(p)
                if d:
                    return d
        return None
