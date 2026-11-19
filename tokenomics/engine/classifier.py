"""Work classifier: is a session OPEX (running/observing the estate) or CAPEX (building)?

OPEX  = insights, logs, metrics, Grafana, incidents, troubleshooting live systems.
CAPEX = generating, changing, refactoring or testing code.

One implementation for every platform. Input is platform-neutral SessionEvidence.
Tune the pattern lists below to your estate.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from .evidence import TOOL_CODE_EDIT, TOOL_SHELL, TOOL_SKILL, Prompt, SessionEvidence, SkillUse, ToolCall

LABELS = ("opex", "capex", "mixed", "unknown")

# (regex, weight)
OPEX_PATTERNS = [
    (r"\bgrafana\b", 3), (r"\bloki\b", 3), (r"\bprometheus\b|\bpromql\b|\blogql\b", 3),
    (r"\bkibana\b|\bsplunk\b|\bdatadog\b|\bapp ?insights\b|\bkql\b|\bcloudwatch\b", 3),
    (r"\bdashboards?\b", 2), (r"\bmetrics?\b", 2), (r"\blogs?\b", 2), (r"\btraces?\b|\bspans?\b", 2),
    (r"\binsights?\b", 2), (r"\balerts?\b|\bincidents?\b|\bon-?call\b|\bpostmortem\b", 2),
    (r"\blatency\b|\bp9[59]\b|\berror rate\b|\bthroughput\b|\bslo\b|\bsli\b|\buptime\b", 2),
    (r"\bwhy (is|was|did|are)\b|\binvestigat\w+|\bdiagnos\w+|\btroubleshoot\w*", 1),
    (r"\bkubectl (logs|top|describe|get)\b", 2),
]
CAPEX_PATTERNS = [
    (r"\b(implement|build|create|write|generate|scaffold|add|develop)\b.{0,40}"
     r"\b(function|class|module|endpoint|api|component|service|script|feature|test|"
     r"migration|schema|cli|app|page|hook|library)\b", 4),
    (r"\brefactor\w*|\brewrite\b|\bport (this|to)\b|\bmigrate (this|the) code\b", 3),
    (r"\bfix (the |this )?(bug|failing test|compile|build error|type error)\b", 3),
    (r"\bunit tests?\b|\bintegration tests?\b|\bwrite tests\b", 3),
    (r"\bcode\b|\bcodebase\b|\bpull request\b|\bpr\b|\bcommit\b", 1),
    (r"```", 1),
    (r"\b(python|typescript|javascript|golang|rust|java|c#|terraform|dockerfile|yaml|sql)\b", 1),
]
TOOL_WEIGHT = 3                   # per code-edit call (CAPEX) or observability tool call (OPEX)
OPEX_TOOL_HINT = re.compile(r"grafana|loki|prometheus|datadog|kibana|splunk|cloudwatch|sentry", re.I)

SKILL_WEIGHT = 6                  # per distinct skill judged OPEX or CAPEX
SKILL_OPEX = re.compile(
    r"grafana|loki|prometheus|datadog|kibana|splunk|sentry|observab\w*|monitor\w*|telemetry|"
    r"\blogs?\b|\blogging\b|metrics?|insights?|incidents?|alerts?|traces?|tracing|dashboards?|"
    r"\bsre\b|on-?call|postmortem|usage|cost|finops|triage|diagnos\w*|troubleshoot\w*", re.I)
SKILL_CAPEX = re.compile(
    r"\bcode\b|coding|refactor\w*|\btests?\b|testing|frontend|backend|\bapi\b|scaffold\w*|"
    r"implement\w*|\bbuild\b|\bcommit\b|\bpr\b|pull-?request|\blint\w*|\bdebug\w*|migrat\w*|"
    r"feature|component|plugin-authoring|skill-creator|\bdesign\b|\bdocker\w*|terraform|"
    r"\bsdk\b|\bcli\b|generate|\bdev\b", re.I)
DESC_OPEX = re.compile(r"\banaly[sz]\w*|\binvestigat\w+|\bquer(y|ies)\b|\bmonitor\w*|\bdiagnos\w+|"
                       r"\bobservab\w+|\btelemetry\b|\bkql\b|\bpromql\b|\bsla\b|\bslo\b", re.I)
DESC_CAPEX = re.compile(r"\bnunit\b|\bxunit\b|\bmstest\b|\bjunit\b|\bpytest\b|\bjest\b|\bmocha\b|"
                        r"\bunit tests?\b|\bcreate|\bgenerat\w+|\bimplement\w*|\bscaffold\w*|\brefactor\w*|"
                        r"\bwrite (code|tests?)\b|\.net\b|\bc#|\bapi\b|\bcomponents?\b|\bsource code\b", re.I)


def score(text: str) -> Tuple[int, int]:
    t = (text or "").lower()
    o = sum(w for p, w in OPEX_PATTERNS if re.search(p, t))
    c = sum(w for p, w in CAPEX_PATTERNS if re.search(p, t))
    return o, c


def label_for(o: int, c: int) -> str:
    if o + c == 0:
        return "unknown"
    hi, lo = max(o, c), min(o, c)
    if lo and lo / hi >= 0.75:
        return "mixed"
    return "opex" if o > c else "capex"


def _skill_keys(name: str):
    n = (name or "").strip().lstrip("/").lower()
    return n, (n, n.split(":")[-1])


def skill_side(name: str, skill_map: Optional[Dict[str, str]] = None) -> Optional[str]:
    """'opex', 'capex' or None from the skill's name alone (user map wins)."""
    n, keys = _skill_keys(name)
    if not n:
        return None
    for key in keys:
        if (skill_map or {}).get(key) in ("opex", "capex"):
            return skill_map[key]
    o, c = bool(SKILL_OPEX.search(n)), bool(SKILL_CAPEX.search(n))
    if o and not c:
        return "opex"
    if c and not o:
        return "capex"
    return None


def classify_skill(name: str, desc: Optional[str],
                   skill_map: Optional[Dict[str, str]] = None) -> Tuple[Optional[str], str]:
    """-> (side or None, basis). Priority: user map > name + description evidence."""
    _, keys = _skill_keys(name)
    for key in keys:
        if (skill_map or {}).get(key) in ("opex", "capex"):
            return skill_map[key], "map"
    o = c = 0
    ns = skill_side(name, skill_map)
    if ns == "opex":
        o += 3
    elif ns == "capex":
        c += 3
    basis = "name" if ns else ""
    if desc:
        do, dc = score(desc)
        do += 2 * len(DESC_OPEX.findall(desc))
        dc += 1 * len(DESC_CAPEX.findall(desc))
        o, c = o + min(do, 8), c + min(dc, 8)
        basis = "name+description" if ns else "description"
    lab = label_for(o, c)
    return (lab if lab in ("opex", "capex") else None), basis


def score_tool(call: ToolCall) -> Tuple[int, int]:
    """Evidence from what the session actually did. Arguments are never stored."""
    if call.kind == TOOL_SKILL:
        return 0, 0                                   # skills are scored once per distinct skill
    if call.kind == TOOL_CODE_EDIT:
        return 0, TOOL_WEIGHT
    if OPEX_TOOL_HINT.search(call.name or ""):
        return TOOL_WEIGHT, 0
    if call.kind == TOOL_SHELL:
        return score(call.command)[0], 0             # only OPEX-side signal from shell commands
    return 0, 0


@dataclass
class Classification:
    label: str
    opex_score: int
    capex_score: int
    prompt_count: int
    skills: List[str] = field(default_factory=list)
    skill_detail: List[dict] = field(default_factory=list)
    skill_opex: int = 0
    skill_capex: int = 0


def classify(ev: SessionEvidence, skill_map: Optional[Dict[str, str]] = None,
             prompt_scores: Optional[Tuple[int, int, int]] = None) -> Classification:
    """Score a session. prompt_scores=(opex, capex, count) replaces scoring ev.prompts
    (used when prompts were scored one at a time and only their scores were kept)."""
    if prompt_scores is not None:
        o, c, n = prompt_scores
    else:
        o = c = n = 0
        for p in ev.prompts:
            po, pc = score(p.text)
            o, c, n = o + po, c + pc, n + 1
    for call in ev.tool_calls:
        to, tc = score_tool(call)
        o, c = o + to, c + tc
    so = sc = 0
    names, detail = [], []
    for sk in ev.skills:
        if sk.name in names:
            continue
        names.append(sk.name)
        side, basis = classify_skill(sk.name, sk.description, skill_map)
        if side == "opex":
            so += 1
        elif side == "capex":
            sc += 1
        detail.append({"name": sk.name, "side": side, "basis": basis or "none",
                       "description": (sk.description or "")[:200]})
    o, c = o + so * SKILL_WEIGHT, c + sc * SKILL_WEIGHT
    return Classification(label_for(o, c), o, c, n, names, detail, so, sc)


def classify_prompt(p: Prompt) -> Tuple[int, int, str]:
    o, c = score(p.text)
    return o, c, label_for(o, c)
