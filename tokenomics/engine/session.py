"""Engine entry points called by the hook runner. Platform-agnostic.

record_prompt  - every user prompt (all platforms)
record_tool    - every tool call, for platforms that expose tool events but no transcript
finalize       - turn end / session end: classify the whole session and log it by session id

The engine asks the adapter what the platform supports and degrades gracefully:
  transcript available  -> full replay, scores replace the running totals
  transcript expected but missing -> keep running totals, refresh the label
  no transcript at all  -> rebuild from the prompt and tool events stored for the session
"""
from __future__ import annotations

from typing import List

from ..config import Settings
from ..platform.adapter import PlatformAdapter
from ..platform.capabilities import Capability
from ..util import log_err
from . import llm, store
from .classifier import classify, classify_prompt, label_for, score_tool
from .evidence import Prompt, SessionEvidence, SkillUse, ToolCall


def record_prompt(adapter: PlatformAdapter, payload: dict, s: Settings) -> SessionEvidence:
    ev = adapter.prompt_evidence(payload)
    prompts = ev.prompts or [Prompt("")]
    db = store.connect(s.db_path)
    try:
        for p in prompts:
            o, c, lab = classify_prompt(p)
            store.add_prompt_event(db, ev.session_id, o, c, lab, p.text[:200] if s.store_prompt else None)
            store.upsert(db, ev.session_id, adapter.name, ev.cwd, o, c, 1, False, label_for)
        store.set_billing(db, ev.session_id, adapter.billing_model)
        db.commit()
    finally:
        db.close()
    return ev


def record_tool(adapter: PlatformAdapter, payload: dict, s: Settings) -> None:
    if not adapter.supports(Capability.TOOL_EVENTS):
        return
    call = adapter.tool_call(payload)
    if call is None:
        return
    sid = adapter.session_id(payload)
    o, c = score_tool(call)
    db = store.connect(s.db_path)
    try:
        store.add_tool_event(db, sid, call.name, call.kind, call.skill, o, c)
        store.upsert(db, sid, adapter.name, payload.get("cwd"), o, c, 0, False, label_for)
        store.set_billing(db, sid, adapter.billing_model)
        db.commit()
    finally:
        db.close()


def finalize(adapter: PlatformAdapter, payload: dict, s: Settings) -> None:
    ev = adapter.session_evidence(payload) if adapter.supports(Capability.TRANSCRIPT) else None
    db = store.connect(s.db_path)
    try:
        if ev is not None:
            _finalize_replay(db, adapter, ev, s)
        elif adapter.supports(Capability.TRANSCRIPT):
            base = adapter.base_evidence(payload, "finalize")
            store.refresh_label(db, base.session_id, label_for)
            store.set_billing(db, base.session_id, adapter.billing_model)
        else:
            _finalize_events(db, adapter, adapter.base_evidence(payload, "finalize"), s)
        db.commit()
    finally:
        db.close()


def _finalize_replay(db, adapter: PlatformAdapter, ev: SessionEvidence, s: Settings) -> None:
    cls = classify(ev, s.skill_map)
    usage = ev.usage if adapter.supports(Capability.TOKEN_USAGE) else None
    store.upsert(db, ev.session_id, adapter.name, ev.cwd, cls.opex_score, cls.capex_score,
                 cls.prompt_count, True, label_for)
    store.write_details(db, ev.session_id, cls, usage, adapter.billing_model, "transcript")
    db.commit()                                   # keyword result is safe before any network call
    prompts = [p.llm_text for p in ev.prompts if p.llm_text][:5]
    _llm_step(db, ev.session_id, ev.event, prompts, [t.name for t in ev.tool_calls], cls.skill_detail, s)


def _finalize_events(db, adapter: PlatformAdapter, base: SessionEvidence, s: Settings) -> None:
    sid = base.session_id
    po, pc, n = store.prompt_totals(db, sid)
    rows = store.tool_rows(db, sid)
    to = sum(r[3] or 0 for r in rows)
    tc = sum(r[4] or 0 for r in rows)
    for name in dict.fromkeys(r[2] for r in rows if r[2]):
        base.skills.append(SkillUse(name, adapter.skill_description(name, base.cwd)))
    cls = classify(base, s.skill_map, prompt_scores=(po + to, pc + tc, n))
    store.upsert(db, sid, adapter.name, base.cwd, cls.opex_score, cls.capex_score, n, True, label_for)
    store.write_details(db, sid, cls, None, adapter.billing_model, "hook-events")
    db.commit()
    prompts = store.prompt_excerpts(db, sid) if s.store_prompt else []
    _llm_step(db, sid, base.event, prompts, [r[0] for r in rows], cls.skill_detail, s)


def _llm_step(db, sid: str, event: str, prompts: List[str], tool_names: List[str],
              skill_detail: List[dict], s: Settings) -> None:
    """At most one LLM call per distinct input; on any failure the keyword label stands."""
    if not (s.llm_usable and prompts):
        return
    payload = llm.build_input(prompts, tool_names, skill_detail)
    h = llm.input_hash(payload)
    row = store.llm_state(db, sid)
    if row and row[0] == h:
        return                                    # nothing new since the last classification
    if event == "turn_end" and row and row[1]:
        return                                    # turn end fires every turn: classify early once
    try:
        res = llm.call(payload, s)
    except Exception as e:
        log_err(s.db_path, f"llm classify failed ({type(e).__name__}: {e})")
        return
    store.write_llm(db, sid, res, h)
    db.commit()


__all__ = ["record_prompt", "record_tool", "finalize", "ToolCall"]
